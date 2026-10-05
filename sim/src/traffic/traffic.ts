import type { Link, Network } from '../network/network';
import type { Trip } from '../demand/trips';
import { compatible, Connector, LaneGeom, type Pose } from './geometry';

// Intelligent Driver Model parameters (uncalibrated defaults; calibration is post-MVP).
export const IDM = { a: 1.5, b: 2.0, T: 1.2, s0: 2.0, delta: 4, bMax: 9 };
export const VEHICLE_LENGTH = 4.5; // m
const SLOT = VEHICLE_LENGTH + IDM.s0; // space reserved on an exit lane per granted car
const TURN_SPEED = 7; // m/s through a turning connector
const STARVE_S = 8; // after this wait an approach overrides arterial priority
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
}

interface Lane {
  link: Link;
  geom: LaneGeom;
  vehicles: Vehicle[]; // front first
  lastExited: Vehicle | null; // most recent car to enter a connector from this lane
  reserved: number; // m promised to cars granted into this lane
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
  private backlog: { trip: Trip; route: number[] }[] = [];
  private nextId = 0;

  arrived = 0;
  removedGridlock = 0;
  private travelTimeSum = 0;

  constructor(private net: Network) {
    this.lanes = net.links.map((link) => ({
      link,
      geom: new LaneGeom(net, link),
      vehicles: [],
      lastExited: null,
      reserved: 0,
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

  // Interface for routing: mean speed on a link, free-flow if empty.
  linkMeanSpeed(linkId: number): number {
    const lane = this.lanes[linkId];
    if (lane.vehicles.length === 0) return lane.link.speedLimit;
    let sum = 0;
    for (const v of lane.vehicles) sum += v.v;
    return sum / lane.vehicles.length;
  }

  step(t: number, dt: number): void {
    this.insertBacklog(t);
    this.grantRightOfWay(t);
    this.computeAccelerations();
    this.integrate(dt);
    this.advanceSegments(t);
    this.gridlockGuard(dt);
  }

  // Cars enter at the start of their first lane once there is room.
  private insertBacklog(t: number): void {
    const still: { trip: Trip; route: number[] }[] = [];
    for (const item of this.backlog) {
      const lane = this.lanes[item.route[0]];
      const tail = lane.vehicles[lane.vehicles.length - 1];
      const room = tail ? tail.pos - VEHICLE_LENGTH : lane.geom.length;
      // Cars arriving from the junction also land at the lane start, so wait for them.
      if (lane.reserved > 0 || room < VEHICLE_LENGTH + IDM.s0 + 1) {
        still.push(item);
        continue;
      }
      const v: Vehicle = {
        id: this.nextId++,
        trip: item.trip,
        route: item.route,
        ri: 0,
        conn: null,
        pos: VEHICLE_LENGTH,
        v: Math.min(0.5 * lane.link.speedLimit, Math.max(0, (room - VEHICLE_LENGTH - IDM.s0) / IDM.T)),
        acc: 0,
        granted: false,
        requestSince: -1,
        stoppedFor: 0,
        departTime: t,
      };
      lane.vehicles.push(v);
      this.vehicles.add(v);
    }
    this.backlog = still;
  }

  // Right-of-way: a car may enter the junction only if (1) its movement is compatible with
  // every movement already in the box, and (2) its exit lane has room for it ("don't block the box").
  // Priority: any approach waiting > STARVE_S, then arterials, then longest wait.
  private grantRightOfWay(t: number): void {
    const requests = new Map<number, Vehicle[]>();
    for (const lane of this.lanes) {
      const f = lane.vehicles[0];
      if (!f || f.granted || f.ri === f.route.length - 1) continue;
      const dist = lane.geom.length - f.pos;
      if (dist > Math.max(25, (f.v * f.v) / (2 * IDM.b) + 10)) continue;
      if (f.requestSince < 0) f.requestSince = t;
      const node = lane.link.to;
      if (!requests.has(node)) requests.set(node, []);
      requests.get(node)!.push(f);
    }

    for (const [node, reqs] of requests) {
      const box = this.boxes[node];
      const starving = (v: Vehicle) => t - v.requestSince > STARVE_S;
      const inLink = (v: Vehicle) => v.route[v.ri];
      reqs.sort((a, b) => {
        const sa = starving(a) ? 0 : 1;
        const sb = starving(b) ? 0 : 1;
        if (sa !== sb) return sa - sb;
        const aa = this.net.links[inLink(a)].arterial ? 0 : 1;
        const ab = this.net.links[inLink(b)].arterial ? 0 : 1;
        if (sa === 1 && aa !== ab) return aa - ab;
        return a.requestSince - b.requestSince;
      });
      for (const f of reqs) {
        const m = this.movement(f);
        let ok = true;
        for (const h of box.holders) if (!compatible(m, this.movement(h))) ok = false;
        if (!ok) continue;
        // Let the box drain if a conflicting approach has waited too long.
        if (reqs.some((r) => r !== f && !r.granted && starving(r) && !starving(f) && !compatible(m, this.movement(r)))) continue;
        const out = this.lanes[f.route[f.ri + 1]];
        const tail = out.vehicles[out.vehicles.length - 1];
        const free = (tail ? tail.pos - VEHICLE_LENGTH : out.geom.length) - out.reserved;
        if (free < SLOT) continue;
        f.granted = true;
        f.requestSince = -1;
        box.holders.add(f);
        out.reserved += SLOT;
      }
    }
  }

  private idm(v: number, v0: number, gap: number, dv: number): number {
    if (gap <= 0.05) return -IDM.bMax;
    const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
    const acc = IDM.a * (1 - (v / v0) ** IDM.delta - (sStar / gap) ** 2);
    return Math.max(-IDM.bMax, acc);
  }

  private computeAccelerations(): void {
    for (const lane of this.lanes) {
      const vs = lane.vehicles;
      for (let k = 0; k < vs.length; k++) {
        const veh = vs[k];
        let v0 = lane.link.speedLimit;
        let gap = Infinity;
        let dv = 0;
        if (k > 0) {
          const lead = vs[k - 1];
          gap = lead.pos - VEHICLE_LENGTH - veh.pos;
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
              const g = remain + le.pos - VEHICLE_LENGTH;
              if (g < gap) [gap, dv] = [g, veh.v - le.v];
            }
          }
        }
        veh.acc = this.idm(veh.v, v0, gap, dv);
      }
    }
    for (const [conn, vs] of this.onConnector) {
      const v0 = conn.turn ? TURN_SPEED : this.net.links[conn.outLink].speedLimit;
      for (let k = 0; k < vs.length; k++) {
        const veh = vs[k];
        let gap = Infinity;
        let dv = 0;
        if (k > 0) {
          gap = vs[k - 1].pos - VEHICLE_LENGTH - veh.pos;
          dv = veh.v - vs[k - 1].v;
        } else {
          const out = this.lanes[conn.outLink];
          const tail = out.vehicles[out.vehicles.length - 1];
          if (tail) {
            gap = conn.length - veh.pos + tail.pos - VEHICLE_LENGTH;
            dv = veh.v - tail.v;
          }
        }
        veh.acc = this.idm(veh.v, v0, gap, dv);
      }
    }
  }

  // Gap from a granted front car to whatever is ahead through its connector.
  private gapAhead(veh: Vehicle, remain: number, conn: Connector): [number, number] {
    const onConn = this.onConnector.get(conn)!;
    const cTail = onConn[onConn.length - 1];
    if (cTail) return [remain + cTail.pos - VEHICLE_LENGTH, veh.v - cTail.v];
    const out = this.lanes[conn.outLink];
    const tail = out.vehicles[out.vehicles.length - 1];
    if (tail) return [remain + conn.length + tail.pos - VEHICLE_LENGTH, veh.v - tail.v];
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
    for (const lane of this.lanes) {
      const vs = lane.vehicles;
      if (vs.length === 0) continue;
      const f = vs[0];
      if (!f.granted && f.ri < f.route.length - 1 && f.pos > lane.geom.length) {
        f.pos = lane.geom.length;
        f.v = 0;
      }
      this.clampFollowers(vs);
    }
    for (const vs of this.onConnector.values()) this.clampFollowers(vs);
  }

  private clampFollowers(vs: Vehicle[]): void {
    for (let k = 1; k < vs.length; k++) {
      const maxPos = vs[k - 1].pos - VEHICLE_LENGTH;
      if (vs[k].pos > maxPos) {
        vs[k].pos = maxPos;
        vs[k].v = Math.min(vs[k].v, vs[k - 1].v);
      }
    }
  }

  private advanceSegments(t: number): void {
    for (const lane of this.lanes) {
      const vs = lane.vehicles;
      while (vs.length > 0 && vs[0].pos >= lane.geom.length) {
        const veh = vs.shift()!;
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
        lane.lastExited = veh;
      }
    }
    for (const [conn, vs] of this.onConnector) {
      while (vs.length > 0 && vs[0].pos >= conn.length) {
        const veh = vs.shift()!;
        const out = this.lanes[conn.outLink];
        veh.pos -= conn.length;
        veh.conn = null;
        veh.ri++;
        out.vehicles.push(veh);
        this.release(veh, out);
      }
    }
  }

  // Give back the junction slot and the exit-lane reservation.
  private release(veh: Vehicle, out: Lane): void {
    if (!veh.granted) return;
    veh.granted = false;
    out.reserved -= SLOT;
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
    const centre = veh.pos - VEHICLE_LENGTH / 2;
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
        const gap = vs[k - 1].pos - VEHICLE_LENGTH - vs[k].pos;
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
