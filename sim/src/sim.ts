import { mulberry32 } from './core/rng';
import { HOUR } from './core/time';
import { buildGrid, DEFAULT_GRID, type Grid, type GridOptions } from './network/grid';
import { generateZones, type Zone } from './demand/zones';
import { zoneCostMatrix } from './demand/od';
import { TripGenerator, type Trip } from './demand/trips';
import { Router, type RouteResult } from './routing/router';
import { TrafficModel } from './traffic/traffic';

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
  peakTripsPerHour: 9000, // ~200 cars at peak in the MVP stress test
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
  time: number;

  readonly produced: Int32Array;
  readonly attracted: Int32Array;
  totalTrips = 0;
  private recent: number[] = []; // departure times within the last hour

  constructor(readonly config: SimConfig = DEFAULT_CONFIG) {
    const rng = mulberry32(config.seed);
    this.grid = buildGrid(config.grid);
    this.zones = generateZones(this.grid, rng);
    this.cost = zoneCostMatrix(this.grid.net, this.zones);
    this.trips = new TripGenerator(this.zones, this.cost, rng, {
      peakTripsPerHour: config.peakTripsPerHour,
      beta: config.beta,
    });
    this.traffic = new TrafficModel(this.grid.net);
    // Route at departure using current mean link speed. Empty links naturally
    // fall back to their speed limit through TrafficModel.linkMeanSpeed().
    this.router = new Router(this.grid.net, (link) => link.length / Math.max(1, this.traffic.linkMeanSpeed(link.id)));
    this.distanceRouter = new Router(this.grid.net, (link) => link.length);
    this.time = config.startHour * HOUR;
    this.produced = new Int32Array(this.zones.length);
    this.attracted = new Int32Array(this.zones.length);
  }

  step(dt: number = FIXED_DT): Trip[] {
    const spawned = this.trips.step(this.time, dt);
    for (const trip of spawned) {
      this.produced[trip.originZone]++;
      this.attracted[trip.destZone]++;
      this.recent.push(trip.departTime);
      const chosen = this.router.routeWithCost(trip.originNode, trip.destNode);
      const shorter = this.distanceRouter.routeWithCost(trip.originNode, trip.destNode);
      const decision: RouteDecision = {
        tripId: trip.id,
        from: trip.originNode,
        to: trip.destNode,
        chosen,
        shorter,
        chosenDistance: this.router.pathDistance(chosen.links),
        shorterDistance: this.distanceRouter.pathDistance(shorter.links),
        shorterLiveCost: this.router.pathCost(shorter.links),
        time: this.time,
      };
      this.routeLog.unshift(decision);
      if (!this.proofRoute && this.isLongerFaster(decision)) this.proofRoute = decision;
      if (this.routeLog.length > 20) this.routeLog.pop();
      this.traffic.enqueue(trip, chosen.links);
    }
    this.traffic.step(this.time, dt);
    this.totalTrips += spawned.length;
    this.time += dt;
    let drop = 0;
    while (drop < this.recent.length && this.recent[drop] < this.time - HOUR) drop++;
    if (drop > 0) this.recent.splice(0, drop);
    return spawned;
  }

  // Observed departures over the trailing sim hour.
  observedTripsPerHour(): number {
    return this.recent.length;
  }

  private isLongerFaster(decision: RouteDecision): boolean {
    return decision.chosen.links.length > decision.shorter.links.length && decision.chosen.cost < decision.shorterLiveCost;
  }
}
