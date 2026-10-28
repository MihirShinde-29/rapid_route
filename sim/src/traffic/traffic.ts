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
const SPILLBACK_S = 75; // at a signal, a car kept waiting this long by a full exit gets the next space in it
const STOP_LINE_ZONE = 4; // m; a car this close to the line at walking pace counts as stopped
// Driveways are mid-block: cars join their first street and leave their last one part way
// along it, beside the buildings, not at the junctions.
export const DEPART_FRAC = 0.35;
export const ARRIVE_FRAC = 0.65;
const ARRIVE_SPEED = 5; // m/s, slowing to turn into the driveway
const TRAVEL_TIME_ALPHA = 0.2; // smoothing for measured link travel times
const GRIDLOCK_S = 180; // a car stopped this long is treated as gridlocked, removed and counted
// Gap acceptance for crossing the other lane into or out of a driveway: no car on that lane may
// reach the crossing point within this many seconds.
const LEFT_IN_GAP_S = 4.5;
const LEFT_OUT_GAP_S = 5.5;
const LEFT_IN_DECIDE_M = 12; // a car turning left in looks for its gap from this far out
// After waiting a while drivers take a shorter gap, down to this, losing a second every 20 s.
const LEFT_MIN_GAP_S = 2.5;
const LEFT_IMPATIENCE = 1 / 20;
// Yielding to sirens, boids-style separation in a one-lane model: cars up to YIELD_RANGE_M ahead
// of a unit on its path pull onto the shoulder and stop, the unit drives past them, and they
// merge back once it is MERGE_CLEAR_M ahead. Junctions on its path hold their other approaches.
const YIELD_RANGE_M = 120;
const MERGE_CLEAR_M = 20;
const PULL_OVER_S = 1.5; // to move fully onto the shoulder, and back
const ON_SHOULDER = 0.8; // shift at which a unit can pass the car
const HELD = 0.3; // a car shifted more than this stays stopped
const PREEMPT_M = 100; // a junction is held for a unit this close to its stop line (or its braking distance)
const SIREN_SPEED = 1.3; // units drive up to this times the speed limit
// A blocked stretch of one lane (accident, lane closure) is run like a one-lane bridge: the stretch
// plus ZONE_MARGIN_M either side is a zone covering both lanes. Oncoming traffic has priority; a
// blocked car waits at the zone for a gap and passes in the oncoming lane, which then holds at the
// zone. After FLAGGER_S of waiting the blocked side gets a turn of up to TURN_S.
const ZONE_MARGIN_M = 5;
const PASS_MARGIN_S = 2;
const FLAGGER_S = 10;
const TURN_S = 15;
const QUEUE_M = 40; // a blocked car this close to the zone counts as waiting
// When the oncoming lane's zone starts this close to its junction, oncoming cars are held at the
// junction instead, since cars coming off it could not stop in time.
const ENTRY_HOLD_M = 40;

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
  arrivePos: number; // m along the last lane where it turns into its destination driveway
  arriveLeft: boolean; // turns in across the other lane, so it waits for a gap there
  turnIn: boolean; // has its gap and is turning in
  siren: boolean; // emergency vehicle on a call (yielding and pre-emption key off this)
  yielding: boolean; // a unit is coming: pull over and stop
  shift: number; // 0 in the lane, 1 on the shoulder
  pass: number; // 0 in the lane, 1 out in the oncoming lane passing a blocked stretch
}

// A stretch of one lane that cars cannot use, `from` to `to` m along it.
export interface Blockage {
  id: number;
  lane: number;
  from: number;
  to: number;
  passSpeed: number; // m/s through the zone
}

// One-lane-bridge control for a blockage. The zone runs start..end on the blocked lane and
// oStart..oEnd on the oncoming one (same stretch of road, measured the other way).
interface Zone extends Blockage {
  other: number; // oncoming lane, -1 on a one-way street
  start: number;
  end: number;
  oStart: number;
  oEnd: number;
  passing: Set<Vehicle>; // blocked-side cars allowed through, until they are clear of the zone
  inside: Set<Vehicle>; // oncoming cars in the zone at the last update
  held: Set<Vehicle>; // oncoming cars that must stop at the zone this step
  turn: boolean; // the blocked side's turn: oncoming cars hold
  turnSince: number; // first car in on this turn, -1 before
  waitSince: number; // the first blocked car started waiting, -1 if none
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
  // Streets closed by the user (accidents and lane closures are blockages, below).
  private closedLinks = new Set<number>();
  private nextId = 0;
  private now = 0;
  private connsInto: Connector[][]; // by out-link
  private sirens = new Set<number>(); // trip ids, so the flag also covers trips not yet on the road
  private byTrip = new Map<number, Vehicle>();
  private shifted = new Set<Vehicle>(); // cars yielding, on the shoulder or merging back
  private sirenLanes = new Set<Lane>(); // lanes with a unit on them, where cars can be passed
  private preempted = new Set<number>(); // junctions held for a unit this step
  private zones = new Map<number, Zone>(); // by id
  private blockedZone = new Map<number, Zone>(); // by blocked lane
  private oncomingZone = new Map<number, Zone>(); // by oncoming lane
  private zoneId = 1;
  // Timed signals at arterial junctions and all-way stops at local ones; null keeps plain give-way
  // rules everywhere (used by the junction tests).
  readonly signals: SignalPlans | null;
  // Approaches that must stop at the line: every approach to an all-way stop, and at a
  // T-junction only the street that ends there (the through street has priority).
  private stopApproach: Uint8Array;

  arrived = 0;
  removedGridlock = 0;
  // Trips that reached their destination, and trips removed by the gridlock guard, during the
  // last step. Both are cleared at the start of each step.
  arrivals: Trip[] = [];
  removals: Trip[] = [];
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
    this.connsInto = net.links.map(() => []);
    for (const inLane of this.lanes) {
      for (const outId of net.outLinks[inLane.link.to]) {
        const out = this.lanes[outId];
        if (out.link.to === inLane.link.from) continue; // no U-turns
        const c = new Connector(inLane.link.id, outId, inLane.geom, out.geom);
        this.connectors.set(this.key(inLane.link.id, outId), c);
        this.onConnector.set(c, []);
        this.connsInto[outId].push(c);
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

  // `siren`: an emergency vehicle on a call. For now it drives like any other car.
  enqueue(trip: Trip, route: number[], opts: { siren?: boolean } = {}): void {
    if (route.length === 0) return;
    this.backlog.push({ trip, route });
    if (opts.siren) this.sirens.add(trip.id);
  }

  setSiren(tripId: number, on: boolean): void {
    if (on) this.sirens.add(tripId);
    else this.sirens.delete(tripId);
    const veh = this.byTrip.get(tripId);
    if (veh) veh.siren = on;
  }

  // The car driving this trip; undefined while it waits to pull out, or once it has arrived.
  vehicleOf(tripId: number): Vehicle | undefined {
    return this.byTrip.get(tripId);
  }

  // Send a car already on the road somewhere else. `route` starts with its current link (and its
  // next one if it is committed to that junction); see Simulation.planTrip.
  redirect(tripId: number, route: number[], arrivePos: number, arriveLeft = false): boolean {
    const veh = this.byTrip.get(tripId);
    if (!veh || route[0] !== veh.route[veh.ri]) return false;
    if ((veh.conn || veh.granted) && route[1] !== veh.route[veh.ri + 1]) return false;
    veh.route = [...veh.route.slice(0, veh.ri), ...route];
    veh.arrivePos = arrivePos;
    veh.arriveLeft = arriveLeft;
    veh.turnIn = false;
    veh.trip.arriveLeft = arriveLeft;
    veh.trip.destNode = this.net.links[route[route.length - 1]].to;
    veh.trip.arrivePos = arrivePos;
    return true;
  }

  private finish(veh: Vehicle, t: number): void {
    this.arrived++;
    this.travelTimeSum += t - veh.departTime;
    this.vehicles.delete(veh);
    this.byTrip.delete(veh.trip.id);
    this.sirens.delete(veh.trip.id);
    this.arrivals.push(veh.trip);
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

  // Speed limit, or the forced cap if one is set, so a jammed link really slows cars.
  private desiredSpeed(link: Link): number {
    return Math.min(link.speedLimit, this.capOf(link.id));
  }

  private capOf(linkId: number): number {
    return this.forcedSpeeds.get(linkId) ?? Infinity;
  }

  // Block `from`..`to` m of a lane (an accident or a lane closure); cars get past it through the
  // oncoming lane, one side at a time. Cars already in the zone carry on through. Returns its id.
  addBlockage(lane: number, from: number, to: number, passSpeed: number): number {
    const len = this.lanes[lane].geom.length;
    const start = Math.max(0, from - ZONE_MARGIN_M);
    const end = Math.min(len, to + ZONE_MARGIN_M);
    const z: Zone = {
      id: this.zoneId++, lane, from, to, passSpeed,
      other: this.net.reverse(lane) ?? -1,
      start, end, oStart: len - end, oEnd: len - start,
      passing: new Set(), inside: new Set(), held: new Set(), turn: false, turnSince: 0, waitSince: -1,
    };
    for (const v of this.lanes[lane].vehicles) if (v.pos > start && v.pos - v.len < end) z.passing.add(v);
    this.zones.set(z.id, z);
    this.blockedZone.set(lane, z);
    if (z.other >= 0) this.oncomingZone.set(z.other, z);
    return z.id;
  }

  removeBlockage(id: number): void {
    const z = this.zones.get(id);
    if (!z) return;
    this.zones.delete(id);
    this.blockedZone.delete(z.lane);
    this.oncomingZone.delete(z.other);
    for (const v of this.lanes[z.lane].vehicles) v.pass = 0;
  }

  get blockages(): Blockage[] {
    return [...this.zones.values()];
  }

  // Expected extra time (s) a blockage adds to driving this link, for routing: the slow pass and
  // a typical wait on the blocked lane, a few seconds of holding on the oncoming one.
  blockDelay(linkId: number): number {
    const z = this.blockedZone.get(linkId);
    if (z) return (z.end - z.start) / z.passSpeed + FLAGGER_S;
    return this.oncomingZone.has(linkId) ? 5 : 0;
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
    return this.forcedSpeeds.has(linkId) || this.blockedZone.has(linkId) || this.closedLinks.has(linkId);
  }

  step(t: number, dt: number): void {
    this.now = t;
    this.arrivals = [];
    this.removals = [];
    this.insertBacklog(t);
    this.updateYielding(dt);
    this.updateZones(t);
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
      let pos = Math.max(spec.length, item.trip.departPos ?? DEPART_FRAC * lane.geom.length);
      // A driveway inside a blocked stretch: pull out past it. Beside one, on the oncoming lane:
      // wait while blocked-side cars are passing.
      const bz = this.blockedZone.get(lane.link.id);
      if (bz && pos > bz.start && pos - spec.length < bz.end) pos = Math.min(lane.geom.length, bz.end + spec.length);
      const oz = this.oncomingZone.get(lane.link.id);
      if (oz && (oz.turn || oz.passing.size > 0) && pos > oz.oStart && pos - spec.length < oz.oEnd) {
        still.push(item);
        continue;
      }
      let k = 0;
      while (k < vs.length && vs[k].pos >= pos) k++;
      const lead = vs[k - 1];
      const follow = vs[k];
      const aheadOk = !lead || lead.pos - lead.len - pos >= IDM.s0 + 2;
      // With nobody behind, still leave room for cars already granted into this lane.
      const behindOk = follow
        ? pos - spec.length - follow.pos >= IDM.s0 + 3 + 1.5 * follow.v * IDM.T
        : pos - spec.length >= lane.reserved + IDM.s0;
      // Pulling out to the left also needs a gap on the near lane, which it crosses first.
      const gap = Math.max(LEFT_MIN_GAP_S, LEFT_OUT_GAP_S - (t - item.trip.departTime) * LEFT_IMPATIENCE);
      const crossOk = !item.trip.departLeft || this.crossingClear(this.net.reverse(lane.link.id)!, lane.geom.length - pos, gap);
      if (!aheadOk || !behindOk || !crossOk) {
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
        arrivePos: item.trip.arrivePos ?? ARRIVE_FRAC * this.lanes[item.route[item.route.length - 1]].geom.length,
        arriveLeft: item.trip.arriveLeft ?? false,
        turnIn: false,
        siren: this.sirens.has(item.trip.id),
        yielding: false,
        shift: 0,
        pass: 0,
      };
      vs.splice(k, 0, v);
      this.activeLanes.add(lane);
      this.vehicles.add(v);
      this.byTrip.set(v.trip.id, v);
    }
    this.backlog = still;
  }

  // Right-of-way: a car may enter the junction only if (1) its movement is compatible with
  // every movement already in the box, and (2) its exit lane has room for it ("don't block the box").
  // Priority: any approach waiting > STARVE_S, then arterials, then longest wait.
  private grantRightOfWay(t: number): void {
    const requests = new Map<number, Vehicle[]>();
    for (const lane of this.activeLanes) {
      const f = this.requester(lane);
      if (!f || f.granted || f.ri === f.route.length - 1) continue;
      const dist = lane.geom.length - f.pos;
      if (dist > Math.max(25, (f.v * f.v) / (2 * IDM.b) + 10)) continue;
      const node = lane.link.to;
      // Stop sign: come to a halt at the line before asking to go (a unit only slows).
      if (this.stopApproach[lane.link.id] && !f.siren && !(dist < STOP_LINE_ZONE && f.v < 0.5)) continue;
      if (f.requestSince < 0) f.requestSince = t;
      if (!requests.has(node)) requests.set(node, []);
      requests.get(node)!.push(f);
    }

    for (const [node, reqs] of requests) {
      const box = this.boxes[node];
      if (this.preempted.has(node)) {
        // Held for a unit: only units get right-of-way here, whatever the lights show.
        for (const f of reqs.filter((r) => r.siren).sort((a, b) => a.requestSince - b.requestSince)) this.tryGrant(f, box);
        continue;
      }
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
        this.toFront(f);
      }
    }
  }

  // Grants right-of-way if the movement fits the box and the exit has room.
  private tryGrant(f: Vehicle, box: Box): boolean {
    const m = this.movement(f);
    for (const h of box.holders) if (!compatible(m, this.movement(h))) return false;
    if (!this.exitHasRoom(f)) return false;
    f.granted = true;
    f.requestSince = -1;
    box.holders.add(f);
    this.lanes[f.route[f.ri + 1]].reserved += this.slot(f);
    this.toFront(f);
    return true;
  }

  // The car on a lane that would cross the junction next: the front car, unless it is pulling
  // over, in which case a unit behind cars on the shoulder.
  private requester(lane: Lane): Vehicle | undefined {
    const vs = lane.vehicles;
    const f = vs[0];
    if (!f) return undefined;
    if (!f.yielding && f.shift <= HELD) return f;
    if (!this.sirenLanes.has(lane)) return undefined;
    for (let k = 1; k < vs.length; k++) if (vs[k].siren) return this.leaderIndex(vs, k) < 0 ? vs[k] : undefined;
    return undefined;
  }

  // A unit granted the junction from behind cars on the shoulder goes to the head of the lane.
  private toFront(f: Vehicle): void {
    const vs = this.lanes[f.route[f.ri]].vehicles;
    const k = vs.indexOf(f);
    if (k > 0) {
      vs.splice(k, 1);
      vs.unshift(f);
    }
  }

  // A unit and a car on the shoulder ignore each other: the unit drives past.
  private passable(a: Vehicle, b: Vehicle): boolean {
    return (a.siren && b.shift >= ON_SHOULDER) || (b.siren && a.shift >= ON_SHOULDER);
  }

  // Index of the car that vehicle k follows: the nearest one ahead it cannot pass; -1 if none.
  private leaderIndex(vs: Vehicle[], k: number): number {
    let best = -1;
    for (let j = k - 1; j >= 0; j--) {
      if (this.passable(vs[k], vs[j])) continue;
      if (best < 0 || vs[j].pos - vs[j].len < vs[best].pos - vs[best].len) best = j;
    }
    return best;
  }

  // The last car on a lane that `v` cannot pass.
  private tailFor(lane: Lane, v: Vehicle): Vehicle | undefined {
    const vs = lane.vehicles;
    for (let k = vs.length - 1; k >= 0; k--) if (!this.passable(v, vs[k])) return vs[k];
    return undefined;
  }

  // Marks the cars ahead of each unit on its path, moves them onto the shoulder (and back once
  // it has gone), lets units overtake cars on the shoulder, and holds the junctions they approach.
  private updateYielding(dt: number): void {
    this.sirenLanes.clear();
    this.preempted.clear();
    const units: Vehicle[] = [];
    for (const id of this.sirens) {
      const u = this.byTrip.get(id);
      if (u) units.push(u);
    }
    const marked = new Set<Vehicle>();
    for (const u of units) {
      let ri = u.ri;
      let from = u.pos;
      let budget = YIELD_RANGE_M;
      if (u.conn) {
        ri++;
        budget -= u.conn.length - u.pos;
        from = 0;
      } else {
        const lane = this.lanes[u.route[ri]];
        this.sirenLanes.add(lane);
        const toLine = lane.geom.length - u.pos;
        if (ri < u.route.length - 1 && toLine <= Math.max(PREEMPT_M, (u.v * u.v) / (2 * IDM.b) + 20)) this.preempted.add(lane.link.to);
      }
      while (budget > 0 && ri < u.route.length) {
        const lane = this.lanes[u.route[ri]];
        for (const o of lane.vehicles) {
          if (o === u || o.siren || o.granted) continue;
          if (o.pos >= from && o.pos - from <= budget) marked.add(o);
        }
        budget -= lane.geom.length - from;
        from = 0;
        ri++;
        if (ri < u.route.length) budget -= this.connector(u.route[ri - 1], u.route[ri]).length;
      }
    }
    for (const v of marked) {
      v.yielding = true;
      v.shift = Math.min(1, v.shift + dt / PULL_OVER_S);
      this.shifted.add(v);
    }
    for (const v of this.shifted) {
      if (!this.vehicles.has(v)) {
        this.shifted.delete(v);
        continue;
      }
      if (marked.has(v)) continue;
      v.yielding = false;
      // Stay on the shoulder until the unit that just passed is clear ahead.
      const lane = v.conn ? null : v.route[v.ri];
      if (units.some((u) => !u.conn && u.route[u.ri] === lane && u.pos > v.pos && u.pos - u.len - v.pos < MERGE_CLEAR_M)) continue;
      v.shift = Math.max(0, v.shift - dt / PULL_OVER_S);
      if (v.shift === 0) this.shifted.delete(v);
    }
    // Units overtake the cars on the shoulder: keep each lane's list in order of position.
    for (const lane of this.sirenLanes) {
      const vs = lane.vehicles;
      for (let k = 1; k < vs.length; k++) {
        for (let j = k; j > 0 && this.passable(vs[j], vs[j - 1]) && vs[j].siren && vs[j].pos > vs[j - 1].pos; j--) {
          [vs[j - 1], vs[j]] = [vs[j], vs[j - 1]];
        }
      }
    }
  }

  // True while the junction holds its other approaches for a unit.
  isPreempted(node: number): boolean {
    return this.preempted.has(node);
  }

  // One-lane-bridge control at each blockage: which blocked car may pass next, whose turn it is,
  // and which oncoming cars hold at the zone.
  private updateZones(t: number): void {
    for (const z of this.zones.values()) {
      const lane = this.lanes[z.lane];
      const other = z.other >= 0 ? this.lanes[z.other] : null;
      for (const v of z.passing) {
        if (!this.vehicles.has(v) || v.conn || v.route[v.ri] !== z.lane || v.pos - v.len >= z.end) z.passing.delete(v);
      }
      // Out into the oncoming lane over the margin before the blocked stretch, back over the one after.
      for (const v of lane.vehicles) {
        if (!z.passing.has(v) && v.pass === 0) continue;
        const m = ZONE_MARGIN_M;
        v.pass = Math.max(0, Math.min(1, (v.pos - z.from + m) / m, (z.to + m - (v.pos - v.len)) / m));
      }
      // The next blocked car to go: the front one not yet passing, unless it has pulled over for a unit.
      let next: Vehicle | undefined;
      for (const v of lane.vehicles) {
        if (z.passing.has(v) || v.pos > z.start + 0.5 || v.shift > HELD) continue;
        if (!next || v.pos > next.pos) next = v;
      }
      // The wait for a turn counts from when the zone is clear, so the oncoming side gets to go
      // between the blocked side's turns.
      const waiting = next !== undefined && z.start - next.pos < QUEUE_M;
      if (!waiting || (!z.turn && z.passing.size > 0)) z.waitSince = -1;
      else if (z.waitSince < 0) z.waitSince = t;
      const unitOncoming = other?.vehicles.some((o) => o.siren && o.pos < z.oEnd) ?? false;
      if (z.turn) {
        if (!waiting || (z.turnSince >= 0 && t - z.turnSince > TURN_S)) {
          z.turn = false;
          z.waitSince = -1;
        }
      } else if (waiting && !unitOncoming && (next!.siren || (z.waitSince >= 0 && t - z.waitSince > FLAGGER_S))) {
        z.turn = true;
        z.turnSince = -1; // the turn's time runs from its first car in
      }
      // Oncoming cars in the zone carry on; the rest hold while blocked cars pass, and during the
      // blocked side's turn if they can still stop.
      z.inside.clear();
      z.held.clear();
      if (other) {
        for (const o of other.vehicles) {
          if (o.pos > z.oStart && o.pos - o.len < z.oEnd) z.inside.add(o);
          else if (o.pos <= z.oStart + 0.5 && (z.passing.size > 0 || (z.turn && this.canStop(o, z.oStart - o.pos)))) z.held.add(o);
        }
      }
      if (next && waiting && (!unitOncoming || next.siren) && this.passClear(z, next, lane, other)) {
        z.passing.add(next);
        z.waitSince = -1;
        if (z.turn && z.turnSince < 0) z.turnSince = t;
      }
    }
  }

  private canStop(o: Vehicle, dist: number): boolean {
    return o.v < 0.5 || (o.v * o.v) / (2 * IDM.b) < dist + 0.5;
  }

  // May blocked car `v` start through the zone? Nobody oncoming is in it, none reaches it before
  // `v` is through (or, on the blocked side's turn, all can stop), and there is room beyond it.
  private passClear(z: Zone, v: Vehicle, lane: Lane, other: Lane | null): boolean {
    if (z.inside.size > 0) return false;
    // Room to stop past the zone if the queue beyond it has not moved on.
    let rear = lane.geom.length;
    for (const o of lane.vehicles) if (!z.passing.has(o) && o.pos - o.len >= z.end) rear = Math.min(rear, o.pos - o.len);
    if (rear - z.end < v.len + IDM.s0 && !(v.ri === v.route.length - 1 && v.arrivePos < z.end)) return false;
    if (!other) return true;
    const window = Math.max(0, z.start - v.pos) / Math.max(v.v, z.passSpeed) + (z.end - z.start + v.len) / z.passSpeed + PASS_MARGIN_S;
    const clear = (o: Vehicle, dist: number) => (z.turn ? this.canStop(o, dist) : dist / Math.max(o.v, 2) >= window);
    for (const o of other.vehicles) if (o.pos <= z.oStart && !clear(o, z.oStart - o.pos)) return false;
    for (const c of this.connsInto[other.link.id]) {
      for (const o of this.onConnector.get(c)!) if (!clear(o, c.length - o.pos + z.oStart)) return false;
      // Cars given the junction into the oncoming lane, and (oncoming traffic having priority)
      // cars waiting at it to go there.
      const into = this.lanes[c.inLink];
      const front = this.requester(into);
      for (const o of into.vehicles) {
        if (o.route[o.ri + 1] !== other.link.id || !(o.granted || o === front)) continue;
        const dist = into.geom.length - o.pos;
        if (!o.granted && !z.turn && dist < QUEUE_M) return false;
        if (!clear(o, dist + c.length + z.oStart)) return false;
      }
    }
    return true;
  }

  // Blocked cars stop at the zone without a pass; held oncoming cars stop at its other end.
  private clampAtZone(lane: Lane): void {
    const z = this.blockedZone.get(lane.link.id);
    if (z) {
      for (const v of lane.vehicles) {
        if (!z.passing.has(v) && v.pos > z.start && v.pos < z.start + 3) {
          v.pos = z.start;
          v.v = 0;
        }
      }
    }
    const oz = this.oncomingZone.get(lane.link.id);
    if (oz) {
      for (const o of oz.held) {
        if (o.pos > oz.oStart && !o.conn && o.route[o.ri] === lane.link.id) {
          o.pos = oz.oStart;
          o.v = 0;
        }
      }
    }
  }

  // For tests: a blocked car passing and an oncoming car are never in the zone together.
  zoneConflicts(): string[] {
    const errors: string[] = [];
    for (const z of this.zones.values()) {
      if (z.other < 0) continue;
      const passing = this.lanes[z.lane].vehicles.filter((v) => v.pos > z.start && v.pos - v.len < z.end);
      const oncoming = this.lanes[z.other].vehicles.filter((o) => o.pos > z.oStart && o.pos - o.len < z.oEnd);
      if (passing.length > 0 && oncoming.length > 0) errors.push(`zone ${z.id}: passing and oncoming cars inside together`);
    }
    return errors;
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
    // When a street ahead stays full, the approaches with a green would otherwise take every space
    // that frees up in it. Keep it for the car that has waited longest, once that is over a cycle.
    const held = new Map<number, Vehicle>();
    for (const f of reqs) {
      if (t - f.requestSince < SPILLBACK_S) continue;
      const out = f.route[f.ri + 1];
      const h = held.get(out);
      if (!h || f.requestSince < h.requestSince) held.set(out, f);
    }
    const grant = (f: Vehicle) => {
      const keeper = held.get(f.route[f.ri + 1]);
      if (keeper && keeper !== f) return;
      const m = this.movement(f);
      for (const h of box.holders) if (!compatible(m, this.movement(h))) return;
      if (!this.exitHasRoom(f)) return;
      f.granted = true;
      f.requestSince = -1;
      box.holders.add(f);
      this.lanes[f.route[f.ri + 1]].reserved += this.slot(f);
      this.toFront(f);
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
    const oz = this.oncomingZone.get(out.link.id);
    if (oz && (oz.turn || oz.passing.size > 0) && oz.oStart < ENTRY_HOLD_M) return false;
    const tail = this.tailFor(out, v);
    let end = tail ? tail.pos - tail.len : out.geom.length;
    const bz = this.blockedZone.get(out.link.id);
    if (bz) end = Math.min(end, bz.start); // room only up to a blocked stretch
    return end - out.reserved >= this.slot(v);
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
      const passing = this.sirenLanes.has(lane);
      for (let k = 0; k < vs.length; k++) {
        const veh = vs[k];
        let v0 = this.desiredSpeed(lane.link) * (veh.siren ? SIREN_SPEED : 1);
        let gap = Infinity;
        let dv = 0;
        if (veh.ri === veh.route.length - 1) {
          // Slow down to turn into the destination driveway.
          const toDrive = Math.max(0, veh.arrivePos - veh.pos);
          v0 = Math.min(v0, Math.sqrt(ARRIVE_SPEED ** 2 + 2 * IDM.b * toDrive));
          if (veh.arriveLeft && !veh.turnIn && toDrive < LEFT_IN_DECIDE_M) {
            const gap = veh.siren ? LEFT_MIN_GAP_S : Math.max(LEFT_MIN_GAP_S, LEFT_IN_GAP_S - veh.stoppedFor * LEFT_IMPATIENCE);
            veh.turnIn = this.crossingClear(this.net.reverse(lane.link.id)!, lane.geom.length - veh.arrivePos, gap + toDrive / Math.max(veh.v, 2));
          }
        }
        const j = passing ? this.leaderIndex(vs, k) : k - 1;
        if (j >= 0) {
          const lead = vs[j];
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
        // A blocked stretch: stop at the zone until allowed through, then pass it slowly. Held
        // oncoming cars stop at the other end of the zone.
        const bz = this.blockedZone.get(lane.link.id);
        if (bz?.passing.has(veh)) v0 = Math.min(v0, Math.sqrt(bz.passSpeed ** 2 + 2 * IDM.b * Math.max(0, bz.start - veh.pos)));
        else if (bz && veh.pos <= bz.start + 0.5) {
          const g = bz.start - veh.pos + IDM.s0 - 0.5;
          if (g < gap) [gap, dv] = [g, veh.v];
        }
        const oz = this.oncomingZone.get(lane.link.id);
        if (oz?.held.has(veh)) {
          const g = oz.oStart - veh.pos + IDM.s0 - 0.5;
          if (g < gap) [gap, dv] = [g, veh.v];
        }
        if (veh.ri === veh.route.length - 1 && veh.arriveLeft && !veh.turnIn) {
          // Waits beside its driveway for a gap in the oncoming lane; the cars behind queue.
          const g = veh.arrivePos - veh.pos + 1;
          if (g < gap) [gap, dv] = [g, veh.v];
        }
        veh.acc = this.idm(veh.v, v0, gap, dv, veh.accel);
        // Pulling over: brake gently to a stop and wait there until the unit has gone.
        if (veh.yielding || veh.shift > HELD) veh.acc = Math.min(veh.acc, veh.v > 0 ? -IDM.b : 0);
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
          const tail = this.tailFor(this.lanes[conn.outLink], veh);
          if (tail) {
            gap = conn.length - veh.pos + tail.pos - tail.len;
            dv = veh.v - tail.v;
          }
        }
        veh.acc = this.idm(veh.v, veh.siren ? v0 * SIREN_SPEED : v0, gap, dv, veh.accel);
      }
    }
  }

  // True if no car on lane `laneId` is over the point `at` (m along it) or reaches it within
  // `window` seconds: the gap a car needs to cross that lane into or out of a driveway. A car
  // waiting there to turn left across our lane is no obstacle (both turn), and a queue that has
  // stopped across the driveway lets the car through.
  private crossingClear(laneId: number, at: number, window: number): boolean {
    const eta = (dist: number, v: number) => dist / Math.max(v, 2);
    for (const o of this.lanes[laneId].vehicles) {
      if (o.pos - o.len - 2 > at) continue; // already past
      if (o.pos + 2 >= at) {
        if (o.arriveLeft && !o.turnIn && o.ri === o.route.length - 1) continue;
        if (o.v < 0.5 && o.stoppedFor > 2) continue;
        return false;
      }
      if (eta(at - o.pos, o.v) < window) return false;
    }
    for (const c of this.connsInto[laneId]) {
      for (const o of this.onConnector.get(c)!) if (eta(c.length - o.pos + at, o.v) < window) return false;
    }
    return true;
  }

  // Gap from a granted front car to whatever is ahead through its connector.
  private gapAhead(veh: Vehicle, remain: number, conn: Connector): [number, number] {
    const onConn = this.onConnector.get(conn)!;
    const cTail = onConn[onConn.length - 1];
    if (cTail) return [remain + cTail.pos - cTail.len, veh.v - cTail.v];
    const tail = this.tailFor(this.lanes[conn.outLink], veh);
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
      this.clampAtZone(lane);
      if (!this.sirenLanes.has(lane)) {
        this.clampAtLine(vs[0], lane);
        this.clampFollowers(vs);
        continue;
      }
      // A unit passes cars on the shoulder, so each car is held behind the nearest car it can't pass.
      for (let k = 0; k < vs.length; k++) {
        const j = this.leaderIndex(vs, k);
        if (j < 0) this.clampAtLine(vs[k], lane);
        else if (vs[k].pos > vs[j].pos - vs[j].len) {
          vs[k].pos = vs[j].pos - vs[j].len;
          vs[k].v = Math.min(vs[k].v, vs[j].v);
        }
      }
    }
    for (const conn of this.activeConns) this.clampFollowers(this.onConnector.get(conn)!);
  }

  private clampAtLine(f: Vehicle, lane: Lane): void {
    if (!f.granted && f.ri < f.route.length - 1 && f.pos > lane.geom.length) {
      f.pos = lane.geom.length;
      f.v = 0;
    }
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
        if (veh.ri !== veh.route.length - 1 || veh.pos < veh.arrivePos || (veh.arriveLeft && !veh.turnIn)) continue;
        vs.splice(k, 1);
        this.finish(veh, t);
      }
      while (vs.length > 0 && vs[0].pos >= lane.geom.length) {
        const veh = vs.shift()!;
        lane.travelTime += TRAVEL_TIME_ALPHA * (t - veh.enteredLane - lane.travelTime);
        if (veh.ri === veh.route.length - 1) {
          this.finish(veh, t);
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
        if (veh.siren) this.sirenLanes.add(out);
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
      this.byTrip.delete(veh.trip.id);
      this.sirens.delete(veh.trip.id);
      this.removals.push(veh.trip);
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
        for (let j = k - 1; j >= 0; j--) {
          if (this.passable(vs[j], vs[k])) continue;
          const gap = vs[j].pos - vs[j].len - vs[k].pos;
          if (gap < -1e-6) errors.push(`overlap on ${where}: gap ${gap.toFixed(2)} m`);
          if (!vs.some((x) => x.siren)) break; // ordinary lanes: the car ahead is enough
        }
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
