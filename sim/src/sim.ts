import { mulberry32 } from './core/rng';
import { HOUR } from './core/time';
import { buildGrid, DEFAULT_GRID, nearestJunction, type Grid, type GridOptions } from './network/grid';
import { generateZones, type Zone } from './demand/zones';
import { zoneCostMatrix } from './demand/od';
import { TripGenerator, type Trip } from './demand/trips';
import { Router, type RouteResult } from './routing/router';
import { TrafficModel } from './traffic/traffic';
import { blockDistricts, DISTRICTS } from './demand/districts';

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
  peakTripsPerHour: 13000, // ~715 mixed vehicles at the AM peak, no gridlock removals (see traffic.test.ts)
  beta: 0.02,
};

export const FIXED_DT = 0.1; // s; IDM step

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

  constructor(readonly config: SimConfig = DEFAULT_CONFIG) {
    const rng = mulberry32(config.seed);
    this.grid = buildGrid(config.grid);
    // Default probe: across the middle of the map, from the west suburbs to the east ones.
    const mid = this.grid.net.nodes[this.grid.nodeAt(Math.floor(this.grid.opts.rows / 2), 1)].y;
    this.probeFrom = nearestJunction(this.grid.net, this.grid.net.nodes[this.grid.nodeAt(0, 1)].x, mid);
    this.probeTo = nearestJunction(this.grid.net, this.grid.net.nodes[this.grid.nodeAt(0, this.grid.opts.cols - 2)].x, mid);
    this.zones = generateZones(this.grid, rng);
    this.cost = zoneCostMatrix(this.grid.net, this.zones);
    this.trips = new TripGenerator(this.zones, this.cost, rng, {
      peakTripsPerHour: config.peakTripsPerHour,
      beta: config.beta,
    });
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
      const decision = this.assignTrip(trip, 'generated');
      this.routeLog.unshift(decision);
      if (!this.proofRoute && this.isLongerFaster(decision)) this.proofRoute = decision;
      if (this.routeLog.length > 20) this.routeLog.pop();
      this.traffic.enqueue(trip, decision.chosen.links);
    }
    for (const inc of this.incidents.filter((i) => i.until !== null && this.time >= i.until)) this.removeIncident(inc.id);
    this.traffic.step(this.time, dt);
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
    return {
      tripId: trip.id, from: trip.originNode, to: trip.destNode, chosen, shorter,
      chosenDistance: this.router.pathDistance(chosen.links),
      shorterDistance: this.distanceRouter.pathDistance(shorter.links),
      shorterLiveCost: this.router.pathCost(shorter.links), time: this.time, kind,
    };
  }

  private isLongerFaster(decision: RouteDecision): boolean {
    return decision.chosen.links.length > decision.shorter.links.length && decision.chosen.cost < decision.shorterLiveCost;
  }
}
