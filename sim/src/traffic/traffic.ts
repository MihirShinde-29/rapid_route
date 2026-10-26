import type { Link, Network } from '../network/network';
import type { Trip } from '../demand/trips';
import { compatible, Connector, LaneGeom, type Pose } from './geometry';
import { VEHICLE_SPECS } from './vehicleTypes';
import { SignalPlans } from './signals';

// Intelligent Driver Model parameters (uncalibrated defaults; calibration is post-MVP).
export const IDM = { a: 1.5, b: 2.0, T: 1.2, s0: 2.0, delta: 4, bMax: 9 };
export const VEHICLE_LENGTH = 4.5; // m, for trips without a vehicle type
const TURN_SPEED = 7; // m/s through a turning connector
const STARVE_S = 8; // after this wait an approach overrides arterial priority
const STOP_LINE_ZONE = 4; // m; a car this close to the line at walking pace counts as stopped
// Driveways are mid-block: cars join their first street and leave their last one part way
// along it, beside the buildings, not at the junctions.
export const DEPART_FRAC = 0.35;
export const ARRIVE_FRAC = 0.65;
const ARRIVE_SPEED = 5; // m/s, slowing to turn into the driveway
const TRAVEL_TIME_ALPHA = 0.2; // smoothing for measured link travel times
const GRIDLOCK_S = 180; // a car stopped this long is treated as gridlocked, removed and counted

export interface Vehicle {
  id: number;
  trip: Trip;
  route: number[]; // link ids
  ri: number; // index of the current link in route (the in-link while on a connector)
  conn: Connector | null; // set while crossing a junction
  pos: number; // front bumper, m along current lane or connector
  v: number;
  acc: number;
  granted: boolean; // holds right-of-way at the junction ahead
  requestSince: number; // sim time it started requesting, -1 if not
  stoppedFor: number;
  departTime: number;
  enteredLane: number; // sim time it entered its current lane
  len: number; // m, bumper to bumper
  accel: number; // IDM maximum acceleration
}

interface Lane {
  link: Link;
  geom: LaneGeom;
  vehicles: Vehicle[]; // front first
  lastExited: Vehicle | null; // most recent car to enter a connector from this lane
  reserved: number; // m promised to cars granted into this lane
  travelTime: number; // smoothed measured time to cross this lane, incl. junction wait (s)
}

// Junction box: cars holding right-of-way; their movements are pairwise compatible.
interface Box {
  holders: Set<Vehicle>;
}

export class TrafficModel {
  readonly lanes: Lane[];
  readonly boxes: Box[];
  readonly vehicles = new Set<Vehicle>();
  private connectors = new Map<number, Connector>();
  private onConnector = new Map<Connector, Vehicle[]>();
  // Only lanes and connectors with cars on them are visited each step; most of a big
  // network is empty at any moment. Entries are added on entry and pruned once empty.
  private activeLanes = new Set<Lane>();
  private activeConns = new Set<Connector>();
  private backlog: { trip: Trip; route: number[] }[] = [];
  private forcedSpeeds = new Map<number, number>();
  // Incidents placed by the user: a speed cap (accident, lane closure) or a closed street.
  private incidentCaps = new Map<number, number>();
  private closedLinks = new Set<number>();
  private nextId = 0;
  private now = 0;
  // Timed signals at arterial junctions and all-way stops at local ones; null keeps plain give-way
  // rules everywhere (used by the junction tests).
  readonly signals: SignalPlans | null;
  // Approaches that must stop at the line: every approach to an all-way stop, and at a
  // T-junction only the street that ends there (the through street has priority).
  private stopApproach: Uint8Array;

  arrived = 0;
  removedGridlock = 0;
  private travelTimeSum = 0;

  constructor(
    private net: Network,
    opts: { signals?: boolean; downtown?: (node: number) => boolean } = {},
  ) {
    this.signals = opts.signals === false ? null : new SignalPlans(net, opts.downtown);
    this.lanes = net.links.map((link) => ({
      link,
      geom: new LaneGeom(net, link),
      vehicles: [],
      lastExited: null,
      reserved: 0,
      travelTime: link.length / link.speedLimit,
    }));
    this.boxes = net.nodes.map(() => ({ holders: new Set<Vehicle>() }));
    for (const inLane of this.lanes) {
      for (const outId of net.outLinks[inLane.link.to]) {
        const out = this.lanes[outId];
        if (out.link.to === inLane.link.from) continue; // no U-turns
        const c = new Connector(inLane.link.id, outId, inLane.geom, out.geom);
        this.connectors.set(this.key(inLane.link.id, outId), c);
        this.onConnector.set(c, []);
      }
    }
    this.stopApproach = new Uint8Array(net.links.length);
    if (this.signals) {
      for (const link of net.links) {
        const node = link.to;
        const ins = net.inLinks[node].length;
        if (this.signals.isSignalised(node) || ins < 3) continue;
        const through = net.outLinks[node].some((o) => this.connectors.get(this.key(link.id, o))?.kind === 'through');
        this.stopApproach[link.id] = ins >= 4 || !through ? 1 : 0;
      }
    }
  }

  private key(inLink: number, outLink: number): number {
    return inLink * this.net.links.length + outLink;
  }

  connector(inLink: number, outLink: number): Connector {
    return this.connectors.get(this.key(inLink, outLink))!;
  }

  // The junction movement a vehicle is waiting for or making.
  private movement(v: Vehicle): Connector {
    return this.connector(v.route[v.ri], v.route[v.ri + 1]);
  }

  enqueue(trip: Trip, route: number[]): void {
    if (route.length > 0) this.backlog.push({ trip, route });
  }

  get waitingToDepart(): number {
    return this.backlog.length;
  }

  get meanTravelTime(): number {
    return this.arrived > 0 ? this.travelTimeSum / this.arrived : 0;
  }

  // Interface for routing: effective speed = link length / expected travel time.
  // Travel time is measured from cars that crossed the link (smoothed), so one car
  // pausing at a stop line does not make a link look jammed. If the front car has
  // already been on the link longer than that, its wait counts, so a growing jam
  // shows up before anyone gets through.
  linkMeanSpeed(linkId: number): number {
    const lane = this.lanes[linkId];
    const freeFlow = lane.link.length / lane.link.speedLimit;
    const front = lane.vehicles[0];
    const expected = Math.max(freeFlow, lane.travelTime, front ? this.now - front.enteredLane : 0);
    return Math.min(lane.link.length / expected, this.capOf(linkId));
  }

  // Speed limit, or the incident cap if one is set, so a jammed link really slows cars.
  private desiredSpeed(link: Link): number {
    return Math.min(link.speedLimit, this.capOf(link.id));
  }

  private capOf(linkId: number): number {
    return Math.min(this.forcedSpeeds.get(linkId) ?? Infinity, this.incidentCaps.get(linkId) ?? Infinity);
  }

  // Cap speed on a link (accident, lane closure); null removes the cap.
  setIncidentCap(linkId: number, speed: number | null): void {
    if (speed === null) this.incidentCaps.delete(linkId);
    else this.incidentCaps.set(linkId, Math.max(0.5, speed));
  }

  // A closed link takes no new cars; cars already on it drive out. Routing keeps traffic off it.
  setClosed(linkId: number, closed: boolean): void {
    if (closed) this.closedLinks.add(linkId);
    else this.closedLinks.delete(linkId);
  }

  isClosed(linkId: number): boolean {
    return this.closedLinks.has(linkId);
  }

  // Gives each car and waiting trip whose remaining route uses one of `links` a new route from
  // its next junction. `plan(node, lastLink, skip)` returns links from `node` ending with the
  // trip's last link (where its driveway is), not using `skip`, or null if there is none.
  // The part of a route a car is committed to (its lane, and the next one once it holds the
  // junction) never changes. Returns how many routes changed.
  reroute(links: Set<number>, plan: (node: number, lastLink: number, skip: number[]) => number[] | null): number {
    const revised = (route: number[], keep: number): number[] | null => {
      if (keep >= route.length - 1 || !route.slice(keep + 1).some((id) => links.has(id))) return null;
      const kept = this.net.links[route[keep]];
      // No U-turns: never straight back down the kept link.
      const back = this.net.outLinks[kept.to].find((id) => this.net.links[id].to === kept.from);
      const tail = plan(kept.to, route[route.length - 1], back === undefined ? [] : [back]);
      const same = tail !== null && tail.length === route.length - keep - 1 && tail.every((id, i) => id === route[keep + 1 + i]);
      if (!tail || same) return null;
      return [...route.slice(0, keep + 1), ...tail];
    };
    let changed = 0;
    for (const veh of this.vehicles) {
      const next = revised(veh.route, veh.conn || veh.granted ? veh.ri + 1 : veh.ri);
      if (!next) continue;
      veh.route = next;
      changed++;
    }
    for (const item of this.backlog) {
      const next = revised(item.route, 0);
      if (!next) continue;
      item.route = next;
      changed++;
    }
    return changed;
  }

  setForcedSpeed(linkId: number, speed: number): void {
    this.forcedSpeeds.set(linkId, Math.max(0.5, speed));
  }

  clearForcedSpeeds(): void {
    this.forcedSpeeds.clear();
  }

  isForcedJammed(linkId: number): boolean {
    return this.forcedSpeeds.has(linkId) || this.incidentCaps.has(linkId) || this.closedLinks.has(linkId);
  }

  step(t: number, dt: number): void {
    this.now = t;
    this.insertBacklog(t);
    this.grantRightOfWay(t);
    this.computeAccelerations();
    this.integrate(dt);
    this.advanceSegments(t);
    this.gridlockGuard(dt);
  }

  // Cars pull out of a driveway part way along their first lane once there is a gap: room
  // ahead, and enough room behind for the next car to slow down for them.
  private insertBacklog(t: number): void {
    const still: { trip: Trip; route: number[] }[] = [];
    for (const item of this.backlog) {
      const lane = this.lanes[item.route[0]];
      const spec = item.trip.kind ? VEHICLE_SPECS[item.trip.kind] : { length: VEHICLE_LENGTH, accel: IDM.a };
      const vs = lane.vehicles;
      const pos = Math.max(spec.length, DEPART_FRAC * lane.geom.length);
      let k = 0;
      while (k < vs.length && vs[k].pos >= pos) k++;
      const lead = vs[k - 1];
      const follow = vs[k];
      const aheadOk = !lead || lead.pos - lead.len - pos >= IDM.s0 + 2;
      // With nobody behind, still leave room for cars already granted into this lane.
      const behindOk = follow
        ? pos - spec.length - follow.pos >= IDM.s0 + 3 + 1.5 * follow.v * IDM.T
        : pos - spec.length >= lane.reserved + IDM.s0;
      if (!aheadOk || !behindOk) {
        still.push(item);
        continue;
      }
      const v: Vehicle = {
        id: this.nextId++,
        trip: item.trip,
        route: item.route,
        ri: 0,
        conn: null,
        pos,
        v: 0,
        acc: 0,
        granted: false,
        requestSince: -1,
        stoppedFor: 0,
        departTime: t,
        enteredLane: t,
        len: spec.length,
        accel: spec.accel,
      };
      vs.splice(k, 0, v);
      this.activeLanes.add(lane);
      this.vehicles.add(v);
    }
    this.backlog = still;
  }

  // Right-of-way: a car may enter the junction only if (1) its movement is compatible with
  // every movement already in the box, and (2) its exit lane has room for it ("don't block the box").
  // Priority: any approach waiting > STARVE_S, then arterials, then longest wait.
  private grantRightOfWay(t: number): void {
    const requests = new Map<number, Vehicle[]>();
    for (const lane of this.activeLanes) {
      const f = lane.vehicles[0];
      if (!f || f.granted || f.ri === f.route.length - 1) continue;
      const dist = lane.geom.length - f.pos;
      if (dist > Math.max(25, (f.v * f.v) / (2 * IDM.b) + 10)) continue;
      const node = lane.link.to;
      // Stop sign: come to a halt at the line before asking to go.
      if (this.stopApproach[lane.link.id] && !(dist < STOP_LINE_ZONE && f.v < 0.5)) continue;
      if (f.requestSince < 0) f.requestSince = t;
      if (!requests.has(node)) requests.set(node, []);
      requests.get(node)!.push(f);
    }

    for (const [node, reqs] of requests) {
      const box = this.boxes[node];
      if (this.signals?.isSignalised(node)) {
        this.grantSignalised(t, box, reqs);
        continue;
      }
      const starving = (v: Vehicle) => t - v.requestSince > STARVE_S;
      const inLink = (v: Vehicle) => v.route[v.ri];
      reqs.sort((a, b) => {
        const sa = starving(a) ? 0 : 1;
        const sb = starving(b) ? 0 : 1;
        if (sa !== sb) return sa - sb;
        // Arterials first, then streets without a stop sign, then stop-sign approaches.
        const rank = (v: Vehicle) => (this.net.links[inLink(v)].arterial ? 0 : this.stopApproach[inLink(v)] ? 2 : 1);
        const aa = rank(a);
        const ab = rank(b);
        if (sa === 1 && aa !== ab) return aa - ab;
        return a.requestSince - b.requestSince;
      });
      for (const f of reqs) {
        const m = this.movement(f);
        let ok = true;
        for (const h of box.holders) if (!compatible(m, this.movement(h))) ok = false;
        if (!ok) continue;
        // Let the box drain if a conflicting approach has waited too long, but only for a car
        // that could actually go: one stuck behind a full exit must not hold up cross traffic.
        const blocker = (r: Vehicle) =>
          r !== f && !r.granted && starving(r) && !starving(f) && this.exitHasRoom(r) && !compatible(m, this.movement(r));
        if (reqs.some(blocker)) continue;
        if (!this.exitHasRoom(f)) continue;
        const out = this.lanes[f.route[f.ri + 1]];
        f.granted = true;
        f.requestSince = -1;
        box.holders.add(f);
        out.reserved += this.slot(f);
      }
    }
  }

  // True if any approach to this junction has a stop sign.
  isStopSign(node: number): boolean {
    return this.net.inLinks[node].some((id) => this.stopApproach[id] === 1);
  }

  mustStop(linkId: number): boolean {
    return this.stopApproach[linkId] === 1;
  }

  // At a signal: go on green if the car reaches the line before the light turns red; on yellow
  // only if it is too close to stop comfortably; on red, right turns only, after stopping, and
  // only when no car with a green or yellow light wants a conflicting movement.
  private grantSignalised(t: number, box: Box, reqs: Vehicle[]): void {
    const signals = this.signals!;
    const go: Vehicle[] = [];
    const rightOnRed: Vehicle[] = [];
    for (const f of reqs) {
      const lane = this.lanes[f.route[f.ri]];
      const dist = lane.geom.length - f.pos;
      const light = signals.light(lane.link.id, t);
      if (light === 'green') {
        if (dist / Math.max(f.v, 3) <= signals.timeLeft(lane.link.id, t)) go.push(f);
      } else if (light === 'yellow') {
        if (f.v > 2 && (f.v * f.v) / (2 * IDM.b) > dist - 1) go.push(f); // a moving car past the point of stopping
      } else if (this.movement(f).kind === 'right' && dist < STOP_LINE_ZONE && f.v < 0.5) {
        rightOnRed.push(f);
      }
    }
    go.sort((a, b) => a.requestSince - b.requestSince);
    const grant = (f: Vehicle) => {
      const m = this.movement(f);
      for (const h of box.holders) if (!compatible(m, this.movement(h))) return;
      if (!this.exitHasRoom(f)) return;
      f.granted = true;
      f.requestSince = -1;
      box.holders.add(f);
      this.lanes[f.route[f.ri + 1]].reserved += this.slot(f);
    };
    for (const f of go) grant(f);
    for (const f of rightOnRed) {
      const m = this.movement(f);
      if (go.some((g) => !g.granted && !compatible(m, this.movement(g)))) continue;
      grant(f);
    }
  }

  // Room for one more car on the lane after the junction, counting cars already granted into it.
  private exitHasRoom(v: Vehicle): boolean {
    const out = this.lanes[v.route[v.ri + 1]];
    const tail = out.vehicles[out.vehicles.length - 1];
    return (tail ? tail.pos - tail.len : out.geom.length) - out.reserved >= this.slot(v);
  }

  // Space reserved on an exit lane for a granted vehicle.
  private slot(v: Vehicle): number {
    return v.len + IDM.s0;
  }

  private idm(v: number, v0: number, gap: number, dv: number, a: number): number {
    if (gap <= 0.05) return -IDM.bMax;
    const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(a * IDM.b)));
    const acc = a * (1 - (v / v0) ** IDM.delta - (sStar / gap) ** 2);
    return Math.max(-IDM.bMax, acc);
  }

  private computeAccelerations(): void {
    for (const lane of this.activeLanes) {
      const vs = lane.vehicles;
      for (let k = 0; k < vs.length; k++) {
        const veh = vs[k];
        let v0 = this.desiredSpeed(lane.link);
        let gap = Infinity;
        let dv = 0;
        if (veh.ri === veh.route.length - 1) {
          // Slow down to turn into the destination driveway.
          const toDrive = Math.max(0, ARRIVE_FRAC * lane.geom.length - veh.pos);
          v0 = Math.min(v0, Math.sqrt(ARRIVE_SPEED ** 2 + 2 * IDM.b * toDrive));
        }
        if (k > 0) {
          const lead = vs[k - 1];
          gap = lead.pos - lead.len - veh.pos;
          dv = veh.v - lead.v;
        } else if (veh.ri < veh.route.length - 1) {
          const remain = lane.geom.length - veh.pos;
          if (!veh.granted) {
            gap = remain + 1; // stop ~1 m before the line
            dv = veh.v;
          } else {
            const conn = this.connector(lane.link.id, veh.route[veh.ri + 1]);
            if (conn.turn) v0 = Math.min(v0, Math.sqrt(TURN_SPEED ** 2 + 2 * IDM.b * remain));
            [gap, dv] = this.gapAhead(veh, remain, conn);
            const le = lane.lastExited;
            if (le && le !== veh && le.conn && le.conn !== conn && le.conn.inLink === lane.link.id) {
              const g = remain + le.pos - le.len;
              if (g < gap) [gap, dv] = [g, veh.v - le.v];
            }
          }
        }
        veh.acc = this.idm(veh.v, v0, gap, dv, veh.accel);
      }
    }
    for (const conn of this.activeConns) {
      const vs = this.onConnector.get(conn)!;
      // Junctions are crossed at normal speed; an incident cap applies once on the next street,
      // so slow traffic never sits inside the box.
      const v0 = conn.turn ? TURN_SPEED : this.net.links[conn.outLink].speedLimit;
      for (let k = 0; k < vs.length; k++) {
        const veh = vs[k];
        let gap = Infinity;
        let dv = 0;
        if (k > 0) {
          gap = vs[k - 1].pos - vs[k - 1].len - veh.pos;
          dv = veh.v - vs[k - 1].v;
        } else {
          const out = this.lanes[conn.outLink];
          const tail = out.vehicles[out.vehicles.length - 1];
          if (tail) {
            gap = conn.length - veh.pos + tail.pos - tail.len;
            dv = veh.v - tail.v;
          }
        }
        veh.acc = this.idm(veh.v, v0, gap, dv, veh.accel);
      }
    }
  }

  // Gap from a granted front car to whatever is ahead through its connector.
  private gapAhead(veh: Vehicle, remain: number, conn: Connector): [number, number] {
    const onConn = this.onConnector.get(conn)!;
    const cTail = onConn[onConn.length - 1];
    if (cTail) return [remain + cTail.pos - cTail.len, veh.v - cTail.v];
    const out = this.lanes[conn.outLink];
    const tail = out.vehicles[out.vehicles.length - 1];
    if (tail) return [remain + conn.length + tail.pos - tail.len, veh.v - tail.v];
    return [Infinity, 0];
  }

  private integrate(dt: number): void {
    for (const veh of this.vehicles) {
      const vNew = veh.v + veh.acc * dt;
      if (vNew < 0) {
        veh.pos += veh.acc < 0 ? (veh.v * veh.v) / (-2 * veh.acc) : 0;
        veh.v = 0;
      } else {
        veh.pos += veh.v * dt + 0.5 * veh.acc * dt * dt;
        veh.v = vNew;
      }
    }
    // Hard guarantees: no car passes the one ahead or an uncleared stop line.
    for (const lane of this.activeLanes) {
      const vs = lane.vehicles;
      if (vs.length === 0) continue;
      const f = vs[0];
      if (!f.granted && f.ri < f.route.length - 1 && f.pos > lane.geom.length) {
        f.pos = lane.geom.length;
        f.v = 0;
      }
      this.clampFollowers(vs);
    }
    for (const conn of this.activeConns) this.clampFollowers(this.onConnector.get(conn)!);
  }

  private clampFollowers(vs: Vehicle[]): void {
    for (let k = 1; k < vs.length; k++) {
      const maxPos = vs[k - 1].pos - vs[k - 1].len;
      if (vs[k].pos > maxPos) {
        vs[k].pos = maxPos;
        vs[k].v = Math.min(vs[k].v, vs[k - 1].v);
      }
    }
  }

  private advanceSegments(t: number): void {
    for (const lane of this.activeLanes) {
      const vs = lane.vehicles;
      // Arrivals turn off into their driveway part way along the last street.
      for (let k = vs.length - 1; k >= 0; k--) {
        const veh = vs[k];
        if (veh.ri !== veh.route.length - 1 || veh.pos < ARRIVE_FRAC * lane.geom.length) continue;
        vs.splice(k, 1);
        this.arrived++;
        this.travelTimeSum += t - veh.departTime;
        this.vehicles.delete(veh);
      }
      while (vs.length > 0 && vs[0].pos >= lane.geom.length) {
        const veh = vs.shift()!;
        lane.travelTime += TRAVEL_TIME_ALPHA * (t - veh.enteredLane - lane.travelTime);
        if (veh.ri === veh.route.length - 1) {
          this.arrived++;
          this.travelTimeSum += t - veh.departTime;
          this.vehicles.delete(veh);
          continue;
        }
        const conn = this.connector(lane.link.id, veh.route[veh.ri + 1]);
        veh.pos -= lane.geom.length;
        veh.conn = conn;
        this.onConnector.get(conn)!.push(veh);
        this.activeConns.add(conn);
        lane.lastExited = veh;
      }
      if (vs.length === 0) this.activeLanes.delete(lane);
    }
    for (const conn of this.activeConns) {
      const vs = this.onConnector.get(conn)!;
      while (vs.length > 0 && vs[0].pos >= conn.length) {
        const veh = vs.shift()!;
        const out = this.lanes[conn.outLink];
        veh.pos -= conn.length;
        veh.conn = null;
        veh.ri++;
        veh.enteredLane = t;
        out.vehicles.push(veh);
        this.activeLanes.add(out);
        this.release(veh, out);
      }
      if (vs.length === 0) this.activeConns.delete(conn);
    }
  }

  // Give back the junction slot and the exit-lane reservation.
  private release(veh: Vehicle, out: Lane): void {
    if (!veh.granted) return;
    veh.granted = false;
    out.reserved -= this.slot(veh);
    if (out.reserved < 1e-6) out.reserved = 0; // mixed vehicle lengths leave float residue
    const box = this.boxes[out.link.from];
    box.holders.delete(veh);
  }

  // Last resort against gridlock: remove a car stopped too long and count it.
  private gridlockGuard(dt: number): void {
    for (const veh of this.vehicles) {
      veh.stoppedFor = veh.v < 0.1 ? veh.stoppedFor + dt : 0;
      if (veh.stoppedFor < GRIDLOCK_S) continue;
      const list = veh.conn ? this.onConnector.get(veh.conn)! : this.lanes[veh.route[veh.ri]].vehicles;
      list.splice(list.indexOf(veh), 1);
      if (veh.granted) this.release(veh, this.lanes[veh.route[veh.ri + 1]]);
      this.vehicles.delete(veh);
      this.removedGridlock++;
    }
  }

  // Centre-of-car pose for rendering.
  pose(veh: Vehicle): Pose {
    const centre = veh.pos - veh.len / 2;
    if (veh.conn) {
      if (centre >= 0) return veh.conn.pose(centre);
      return this.lanes[veh.conn.inLink].geom.pose(this.lanes[veh.conn.inLink].geom.length + centre);
    }
    return this.lanes[veh.route[veh.ri]].geom.pose(centre);
  }

  // For tests: spacing and junction invariants. Returns a list of violations.
  checkInvariants(): string[] {
    const errors: string[] = [];
    const checkOrder = (vs: Vehicle[], where: string) => {
      for (let k = 1; k < vs.length; k++) {
        const gap = vs[k - 1].pos - vs[k - 1].len - vs[k].pos;
        if (gap < -1e-6) errors.push(`overlap on ${where}: gap ${gap.toFixed(2)} m`);
      }
    };
    for (const lane of this.lanes) checkOrder(lane.vehicles, `link ${lane.link.id}`);
    for (const [conn, vs] of this.onConnector) checkOrder(vs, `connector ${conn.inLink}->${conn.outLink}`);
    this.boxes.forEach((box, node) => {
      const hs = [...box.holders];
      for (let i = 0; i < hs.length; i++)
        for (let j = i + 1; j < hs.length; j++)
          if (!compatible(this.movement(hs[i]), this.movement(hs[j])))
            errors.push(`junction ${node}: conflicting movements inside`);
    });
    for (const vs of this.onConnector.values()) {
      for (const veh of vs) if (!veh.granted) errors.push(`vehicle ${veh.id} in junction without right-of-way`);
    }
    return errors;
  }
}
