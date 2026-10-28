import { mulberry32 } from './core/rng';
import { HOUR } from './core/time';
import { buildGrid, DEFAULT_GRID, nearestJunction, type Grid, type GridOptions } from './network/grid';
import { generateZones, type Zone } from './demand/zones';
import { zoneCostMatrix } from './demand/od';
import { TripGenerator, type Trip } from './demand/trips';
import { Router, type RouteResult } from './routing/router';
import { TrafficModel, type Vehicle } from './traffic/traffic';
import { blockDistricts, DISTRICTS } from './demand/districts';
import { buildCity, siteAccess, type Access, type CityLayout, type Site } from './city/sites';
import type { EmergencyKind } from './traffic/vehicleTypes';

// Perturbations the user can place on a street (both directions).
export type IncidentKind = 'accident' | 'lane' | 'closure';
export interface Incident {
  id: number;
  kind: IncidentKind;
  links: number[]; // the street's directed links
  placedAt: number; // sim time
  until: number | null; // sim time it clears by itself, or null until removed
  rerouted: number; // cars and waiting trips given a new route when it was placed
}
const ACCIDENT_SPEED = 2.5; // m/s, cars edge past the wreck
const ACCIDENT_CLEARS_S = 20 * 60;
const LANE_CLOSURE_FACTOR = 0.4; // of the speed limit, traffic merging into the open lane
const CLOSED_COST = 1e5; // s, so routes avoid a closed street unless there is no other way
// Routing cost of crossing the other lane at a driveway (s), standing for the wait for a gap;
// four times that across an arterial. Cars still turn left when going round is much longer.
const LEFT_TURN_S = 15;
const ARTERIAL_LEFT_FACTOR = 4;

export interface RouteDecision {
  tripId: number;
  from: number;
  to: number;
  chosen: RouteResult;
  shorter: RouteResult;
  chosenDistance: number;
  shorterDistance: number;
  shorterLiveCost: number;
  time: number;
  kind?: 'generated' | 'probe';
}

export interface SimConfig {
  seed: number;
  grid: GridOptions;
  startHour: number;
  peakTripsPerHour: number;
  beta: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 549,
  grid: DEFAULT_GRID,
  startHour: 6,
  peakTripsPerHour: 11500, // ~700 mixed vehicles at the AM peak, no gridlock removals (see traffic.test.ts)
  beta: 0.02,
};

export const FIXED_DT = 0.1; // s; IDM step

// A route between entrances. `route` starts with the link the trip leaves from; for a car on
// the road that is its current link (plus the next one if it is committed to that junction).
// A site can be left or reached from either lane of its street; `departLeft` and `arriveLeft`
// mean the car crosses the other lane to do it.
export interface TripPlan {
  route: number[];
  departPos: number; // m along route[0]
  arrivePos: number; // m along the last link
  departLeft: boolean;
  arriveLeft: boolean;
  eta: number; // s on live link costs; Infinity if unreachable
}

// Owns all sim state. No DOM access, so it runs headless in tests.
export class Simulation {
  readonly grid: Grid;
  readonly zones: Zone[];
  readonly cost: Float64Array;
  readonly trips: TripGenerator;
  readonly router: Router;
  readonly distanceRouter: Router;
  readonly traffic: TrafficModel;
  readonly routeLog: RouteDecision[] = [];
  proofRoute: RouteDecision | null = null;
  probeDecision: RouteDecision | null = null;
  probeJammed = false;
  private probeId = 1000000;
  time: number;

  readonly produced: Int32Array;
  readonly attracted: Int32Array;
  totalTrips = 0;
  private recent: number[] = []; // departure times within the last hour
  private recentPairs: number[] = []; // origin * 9 + destination district, same order as `recent`
  readonly district: Int8Array; // per zone
  readonly incidents: Incident[] = [];
  private incidentId = 1;
  readonly layout: CityLayout;
  readonly sites: Site[];
  private unitTripId = 2000000; // emergency trips, clear of generated and probe ids
  // Stepped every tick after traffic (the dispatch centre plugs in here).
  dispatch: { step(t: number): void } | null = null;

  constructor(readonly config: SimConfig = DEFAULT_CONFIG) {
    const rng = mulberry32(config.seed);
    this.grid = buildGrid(config.grid);
    // Default probe: across the middle of the map, from the west suburbs to the east ones.
    const mid = this.grid.net.nodes[this.grid.nodeAt(Math.floor(this.grid.opts.rows / 2), 1)].y;
    this.probeFrom = nearestJunction(this.grid.net, this.grid.net.nodes[this.grid.nodeAt(0, 1)].x, mid);
    this.probeTo = nearestJunction(this.grid.net, this.grid.net.nodes[this.grid.nodeAt(0, this.grid.opts.cols - 2)].x, mid);
    this.zones = generateZones(this.grid, rng);
    this.cost = zoneCostMatrix(this.grid.net, this.zones);
    this.layout = buildCity(this.grid, this.zones, config.seed ^ 0x5173);
    this.sites = this.layout.sites;
    this.trips = new TripGenerator(
      this.zones,
      this.cost,
      rng,
      { peakTripsPerHour: config.peakTripsPerHour, beta: config.beta },
      this.sites,
    );
    // Downtown (the commercial centre and the blocks around it) has signals at every junction.
    const { rows, cols, suburbRing: ring } = this.grid.opts;
    const downtown = (node: number) => {
      const r = Math.floor(node / cols);
      const c = node % cols;
      return r >= ring && r <= rows - 1 - ring && c >= ring && c <= cols - 1 - ring;
    };
    this.traffic = new TrafficModel(this.grid.net, { downtown });
    // Route at departure using current mean link speed. Empty links naturally
    // fall back to their speed limit through TrafficModel.linkMeanSpeed().
    this.router = new Router(
      this.grid.net,
      (link) => link.length / Math.max(1, this.traffic.linkMeanSpeed(link.id)) + (this.traffic.isClosed(link.id) ? CLOSED_COST : 0),
    );
    this.distanceRouter = new Router(this.grid.net, (link) => link.length);
    this.time = config.startHour * HOUR;
    this.produced = new Int32Array(this.zones.length);
    this.attracted = new Int32Array(this.zones.length);
    this.district = blockDistricts(this.grid);
  }

  step(dt: number = FIXED_DT): Trip[] {
    const spawned = this.trips.step(this.time, dt);
    for (const trip of spawned) {
      this.produced[trip.originZone]++;
      this.attracted[trip.destZone]++;
      this.recent.push(trip.departTime);
      this.recentPairs.push(this.district[trip.originZone] * DISTRICTS.length + this.district[trip.destZone]);
      const decision = trip.originSite !== undefined ? this.assignSiteTrip(trip) : this.assignTrip(trip, 'generated');
      this.routeLog.unshift(decision);
      if (!this.proofRoute && this.isLongerFaster(decision)) this.proofRoute = decision;
      if (this.routeLog.length > 20) this.routeLog.pop();
      this.traffic.enqueue(trip, decision.chosen.links);
    }
    for (const inc of this.incidents.filter((i) => i.until !== null && this.time >= i.until)) this.removeIncident(inc.id);
    this.traffic.step(this.time, dt);
    this.dispatch?.step(this.time);
    this.totalTrips += spawned.length;
    this.time += dt;
    let drop = 0;
    while (drop < this.recent.length && this.recent[drop] < this.time - HOUR) drop++;
    if (drop > 0) {
      this.recent.splice(0, drop);
      this.recentPairs.splice(0, drop);
    }
    return spawned;
  }

  // Trips that reached their destination in the last step (and those removed by the gridlock guard).
  get arrivals(): Trip[] {
    return this.traffic.arrivals;
  }

  get removals(): Trip[] {
    return this.traffic.removals;
  }

  // Route from a site, or from a car where it is now, to a site's entrance, on live link costs
  // (or on `router`'s). Tries both lanes at each end and keeps the cheapest, counting a wait for
  // each left turn across the other lane.
  planTrip(from: Site | Vehicle, to: Site, router: Router = this.router): TripPlan {
    const net = this.grid.net;
    const len = (id: number) => this.traffic.lanes[id].geom.length;
    const cost = (id: number) => router.pathCost([id]);
    const leftWait = (id: number, left: boolean) =>
      !left || router !== this.router ? 0 : LEFT_TURN_S * (net.links[id].arterial ? ARTERIAL_LEFT_FACTOR : 1);
    type Start = { prefix: number[]; pos: number; left: boolean };
    let starts: Start[];
    if ('entrance' in from) {
      starts = siteAccess(net, from.entrance, len).out.map((a) => ({ prefix: [a.link], pos: a.pos, left: a.left }));
    } else {
      const here = from.route[from.ri];
      const committed = from.conn || from.granted;
      starts = [{ prefix: committed ? [here, from.route[from.ri + 1]] : [here], pos: from.conn ? len(here) : from.pos, left: false }];
    }
    const ends = siteAccess(net, to.entrance, len).in;
    const lastOf = (s: Start) => s.prefix[s.prefix.length - 1];
    // What is left to drive of a start's links, and the part of an end's link driven to arrive.
    const startCost = (s: Start) =>
      router.pathCost(s.prefix) - cost(s.prefix[0]) * Math.min(1, s.pos / len(s.prefix[0])) + leftWait(s.prefix[0], s.left);
    const endCost = (e: Access) => cost(e.link) * (e.pos / len(e.link)) + leftWait(e.link, e.left);

    let best: { route: number[]; start: Start; end: Access; eta: number } | null = null;
    // Arriving further along the lane it leaves on.
    for (const s of starts) {
      const posOnLast = s.prefix.length === 1 ? s.pos : 0;
      for (const e of ends) {
        if (e.link !== lastOf(s) || e.pos <= posOnLast + 5) continue;
        const eta = startCost(s) - cost(e.link) * (1 - e.pos / len(e.link)) + leftWait(e.link, e.left);
        if (!best || eta < best.eta) best = { route: s.prefix, start: s, end: e, eta };
      }
    }
    const found = router.routeLinks(
      starts.map((s) => ({ link: lastOf(s), cost: startCost(s) })),
      ends.map((e) => ({ link: e.link, cost: endCost(e) })),
    );
    if (found.links.length > 0 && (!best || found.cost < best.eta)) {
      const s = starts.find((x) => lastOf(x) === found.links[0])!;
      const e = ends.find((x) => x.link === found.links[found.links.length - 1])!;
      best = { route: [...s.prefix.slice(0, -1), ...found.links], start: s, end: e, eta: found.cost };
    }
    if (!best) {
      return { route: [], departPos: starts[0]?.pos ?? 0, arrivePos: to.entrance.pos, departLeft: false, arriveLeft: false, eta: Infinity };
    }
    return {
      route: best.route,
      departPos: best.start.pos,
      arrivePos: best.end.pos,
      departLeft: best.start.left,
      arriveLeft: best.end.left,
      eta: Math.max(0, best.eta),
    };
  }

  // Send an emergency unit from a site (its station, or a call it just finished) or from where it
  // is on the road, to a site. Returns its trip, or null if there is no route.
  sendUnit(kind: EmergencyKind, from: Site | Vehicle, to: Site, opts: { siren?: boolean } = {}): Trip | null {
    const plan = this.planTrip(from, to);
    if (plan.route.length === 0) return null;
    const siren = opts.siren ?? true;
    if (!('entrance' in from)) {
      if (!this.traffic.redirect(from.trip.id, plan.route, plan.arrivePos, plan.arriveLeft)) return null;
      from.trip.destZone = to.zone;
      this.traffic.setSiren(from.trip.id, siren);
      return from.trip;
    }
    const net = this.grid.net;
    const trip: Trip = {
      id: this.unitTripId++,
      originZone: from.zone,
      destZone: to.zone,
      originNode: net.links[plan.route[0]].from,
      destNode: net.links[plan.route[plan.route.length - 1]].to,
      departTime: this.time,
      kind,
      departPos: plan.departPos,
      arrivePos: plan.arrivePos,
      departLeft: plan.departLeft,
      arriveLeft: plan.arriveLeft,
    };
    this.traffic.enqueue(trip, plan.route, { siren });
    return trip;
  }

  // Seconds from the nearest of `sources` (junctions) to every junction, on live link costs.
  coverageTimes(sources: number[]): Float64Array {
    return this.router.costsFrom(sources);
  }

  // Trips generated between each pair of districts over the trailing sim hour (row-major, 9 x 9).
  observedDistrictOd(): Int32Array {
    const out = new Int32Array(DISTRICTS.length * DISTRICTS.length);
    for (const pair of this.recentPairs) out[pair]++;
    return out;
  }

  // Place an incident on the street that `linkId` belongs to. Cars whose route uses the street
  // are rerouted at their next junction if there is a faster way round.
  addIncident(kind: IncidentKind, linkId: number): Incident {
    const net = this.grid.net;
    const link = net.links[linkId];
    const back = net.outLinks[link.to].find((id) => net.links[id].to === link.from);
    const links = back === undefined ? [linkId] : [linkId, back];
    for (const id of links) this.removeIncidentOn(id);
    for (const id of links) {
      if (kind === 'closure') this.traffic.setClosed(id, true);
      else this.traffic.setIncidentCap(id, kind === 'accident' ? ACCIDENT_SPEED : net.links[id].speedLimit * LANE_CLOSURE_FACTOR);
    }
    const rerouted = this.traffic.reroute(new Set(links), (node, last, skip) => {
      const lastLink = net.links[last];
      // The new route must end on the same last link; never arrive at it from its reverse (a U-turn).
      const reverse = net.outLinks[lastLink.to].find((id) => net.links[id].to === lastLink.from);
      const toLast = node === lastLink.from ? { links: [], cost: 0 } : this.router.routeWithCost(node, lastLink.from, reverse === undefined ? skip : [...skip, reverse]);
      if (toLast.cost >= CLOSED_COST) return null;
      if (node === lastLink.from && skip.includes(last)) return null;
      return [...toLast.links, last];
    });
    const inc: Incident = {
      id: this.incidentId++, kind, links, placedAt: this.time,
      until: kind === 'accident' ? this.time + ACCIDENT_CLEARS_S : null, rerouted,
    };
    this.incidents.push(inc);
    return inc;
  }

  removeIncident(id: number): void {
    const k = this.incidents.findIndex((inc) => inc.id === id);
    if (k < 0) return;
    for (const linkId of this.incidents[k].links) {
      this.traffic.setClosed(linkId, false);
      this.traffic.setIncidentCap(linkId, null);
    }
    this.incidents.splice(k, 1);
  }

  incidentOn(linkId: number): Incident | undefined {
    return this.incidents.find((inc) => inc.links.includes(linkId));
  }

  private removeIncidentOn(linkId: number): void {
    const inc = this.incidentOn(linkId);
    if (inc) this.removeIncident(inc.id);
  }

  // Observed departures over the trailing sim hour.
  observedTripsPerHour(): number {
    return this.recent.length;
  }

  // Probe start and end nodes. Default: across the middle of the map; the UI can pick others.
  probeFrom: number;
  probeTo: number;

  spawnProbeTrip(from = this.probeFrom, to = this.probeTo): RouteDecision {
    this.probeFrom = from;
    this.probeTo = to;
    const trip: Trip = {
      id: this.probeId++, originZone: 0, destZone: 1, originNode: from, destNode: to, departTime: this.time, kind: 'sedan',
    };
    const decision = this.assignTrip(trip, 'probe');
    this.probeDecision = decision;
    this.routeLog.unshift(decision);
    if (this.isLongerFaster(decision)) this.proofRoute = decision;
    this.traffic.enqueue(trip, decision.chosen.links);
    return decision;
  }

  // Jams the shortest path between the current probe start and end.
  toggleProbeJam(): boolean {
    const shorter = this.distanceRouter.routeWithCost(this.probeFrom, this.probeTo);
    this.probeJammed = !this.probeJammed;
    this.traffic.clearForcedSpeeds();
    if (this.probeJammed) for (const id of shorter.links) this.traffic.setForcedSpeed(id, this.grid.net.links[id].speedLimit * 0.12);
    return this.probeJammed;
  }

  private assignTrip(trip: Trip, kind: 'generated' | 'probe'): RouteDecision {
    const chosen = this.router.routeWithCost(trip.originNode, trip.destNode);
    const shorter = this.distanceRouter.routeWithCost(trip.originNode, trip.destNode);
    return this.decision(trip, chosen.links, shorter.links, kind);
  }

  // A generated trip between two sites' entrances; fills in where it leaves and arrives.
  private assignSiteTrip(trip: Trip): RouteDecision {
    const from = this.sites[trip.originSite!];
    const to = this.sites[trip.destSite!];
    const plan = this.planTrip(from, to);
    const links = this.grid.net.links;
    trip.departPos = plan.departPos;
    trip.arrivePos = plan.arrivePos;
    trip.departLeft = plan.departLeft;
    trip.arriveLeft = plan.arriveLeft;
    if (plan.route.length > 0) {
      trip.originNode = links[plan.route[0]].from;
      trip.destNode = links[plan.route[plan.route.length - 1]].to;
    }
    const shorter = this.planTrip(from, to, this.distanceRouter);
    return this.decision(trip, plan.route, shorter.route, 'generated');
  }

  private decision(trip: Trip, chosen: number[], shorter: number[], kind: 'generated' | 'probe'): RouteDecision {
    return {
      tripId: trip.id, from: trip.originNode, to: trip.destNode,
      chosen: { links: chosen, cost: this.router.pathCost(chosen) },
      shorter: { links: shorter, cost: this.distanceRouter.pathCost(shorter) },
      chosenDistance: this.router.pathDistance(chosen),
      shorterDistance: this.distanceRouter.pathDistance(shorter),
      shorterLiveCost: this.router.pathCost(shorter), time: this.time, kind,
    };
  }

  private isLongerFaster(decision: RouteDecision): boolean {
    return decision.chosen.links.length > decision.shorter.links.length && decision.chosen.cost < decision.shorterLiveCost;
  }
}
