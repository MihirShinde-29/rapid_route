import { HOUR } from '../core/time';
import { mulberry32 } from '../core/rng';
import type { Site } from '../city/sites';
import type { EmergencyKind } from '../traffic/vehicleTypes';
import type { Vehicle } from '../traffic/traffic';
import { BLOCK_JUNCTION_M, type Incident, type Simulation } from '../sim';

export type DispatchMode = 'dispatcher' | 'sandbox';
export type CallKind = 'medical' | 'fire' | 'crime' | 'crash';
export type UnitState = 'idle' | 'en_route' | 'on_scene' | 'returning';
export type CallState = 'created' | 'assigned' | 'en_route' | 'resolved' | 'missed';
export type DispatchEnd = null | 'win' | 'loss' | 'ended';

export interface Station {
  id: number;
  kind: EmergencyKind;
  site: Site;
  unitIds: number[];
}

export interface EmergencyUnit {
  id: number;
  kind: EmergencyKind;
  station: Station;
  location: Site;
  state: UnitState;
  tripId: number | null;
  callId: number | null;
  sceneUntil: number | null;
}

export interface EmergencyCall {
  id: number;
  kind: CallKind;
  site: Site;
  incidentId: number | null;
  createdAt: number;
  targetResponseTime: number;
  expiresAt: number;
  state: CallState;
  assignedUnitId: number | null;
  responseTime: number | null;
}

export interface DispatchScore {
  points: number;
  resolvedCalls: number;
  missedCalls: number;
  meanResponseTime: number;
}

export interface DispatchOptions {
  mode: DispatchMode;
  seed?: number;
  callsPerHour?: number;
  shiftDurationSeconds?: number;
  missedLimit?: number;
  unitCounts?: Partial<Record<EmergencyKind, number>>; // units per station of each kind
  accidentsPerHour?: number; // random accidents per sim hour at peak demand (fewer when quieter)
}

// What happened since the UI last looked: for call alerts, sounds and the camera.
export interface DispatchEvent {
  type: 'call' | 'assigned' | 'arrived' | 'resolved' | 'missed' | 'ended';
  t: number;
  callId?: number;
  unitId?: number;
}
const ACCIDENT_CLEARS_AFTER_MISS_S = 20 * 60; // nobody came: it is cleared eventually anyway
const MAX_EVENTS = 200; // kept if nobody drains them (tests, headless runs)

const DEFAULT_CALLS_PER_HOUR = 20;
const DEFAULT_SHIFT_SECONDS = 2 * HOUR;
const DEFAULT_MISSED_LIMIT = 3;
const UNIT_COUNTS: Record<EmergencyKind, number> = { ambulance: 2, fire: 1, police: 2 };
const SITE_TO_UNIT: Record<Site['kind'], EmergencyKind | undefined> = {
  hospital: 'ambulance',
  fire_station: 'fire',
  police_station: 'police',
  house: undefined,
  apartment: undefined,
  tower: undefined,
  shop: undefined,
  warehouse: undefined,
  park: undefined,
  plaza: undefined,
  parking: undefined,
  mall: undefined,
};
const CALL_UNIT: Record<CallKind, EmergencyKind> = {
  medical: 'ambulance',
  fire: 'fire',
  crime: 'police',
  crash: 'police',
};
const CALL_TIMING: Record<CallKind, { target: number; expires: number; scene: number }> = {
  medical: { target: 8 * 60, expires: 15 * 60, scene: 4 * 60 },
  fire: { target: 8 * 60, expires: 15 * 60, scene: 8 * 60 },
  crime: { target: 10 * 60, expires: 20 * 60, scene: 3 * 60 },
  crash: { target: 10 * 60, expires: 20 * 60, scene: 5 * 60 },
};
const CALL_KINDS: CallKind[] = ['medical', 'fire', 'crime', 'crash'];

export interface DispatchCandidate {
  unitId: number;
  eta: number;
}

export interface UnitTravelInfo {
  tripId: number;
  origin: Site;
  destination: Site;
  eta: number;
  route: number[];
}

export class DispatchCenter {
  readonly stations: Station[] = [];
  readonly units: EmergencyUnit[] = [];
  readonly calls: EmergencyCall[] = [];
  readonly mode: DispatchMode;
  readonly shiftEndsAt: number;
  readonly missedLimit: number;
  ended: DispatchEnd = null;
  readonly events: DispatchEvent[] = [];

  private readonly rng: () => number;
  private readonly callsPerHour: number;
  private lastStepTime: number;
  private generationProgress = 0;
  private nextCallId = 1;
  private points = 0;
  private totalResponseTime = 0;
  private resolvedCalls = 0;
  private missedCalls = 0;
  private readonly accidentsPerHour: number;
  private readonly accidentRng: () => number;

  constructor(private readonly sim: Simulation, opts: DispatchOptions) {
    this.mode = opts.mode;
    this.callsPerHour = Math.max(0, opts.callsPerHour ?? DEFAULT_CALLS_PER_HOUR);
    this.shiftEndsAt = sim.time + Math.max(0, opts.shiftDurationSeconds ?? DEFAULT_SHIFT_SECONDS);
    this.missedLimit = Math.max(1, Math.floor(opts.missedLimit ?? DEFAULT_MISSED_LIMIT));
    this.rng = mulberry32(opts.seed ?? sim.config.seed ^ 0xa4d15);
    this.lastStepTime = sim.time;
    this.accidentsPerHour = Math.max(0, opts.accidentsPerHour ?? 0);
    // Its own stream, so random accidents do not change which calls come in.
    this.accidentRng = mulberry32((opts.seed ?? sim.config.seed) ^ 0x5eed);
    const unitCounts = { ...UNIT_COUNTS, ...opts.unitCounts };

    for (const site of sim.sites) {
      const kind = SITE_TO_UNIT[site.kind];
      if (!kind) continue;
      const station: Station = { id: this.stations.length, kind, site, unitIds: [] };
      this.stations.push(station);
      for (let count = 0; count < Math.max(1, unitCounts[kind]); count++) {
        const unit: EmergencyUnit = {
          id: this.units.length,
          kind,
          station,
          location: site,
          state: 'idle',
          tripId: null,
          callId: null,
          sceneUntil: null,
        };
        station.unitIds.push(unit.id);
        this.units.push(unit);
      }
    }
    sim.dispatch = this;
  }

  get score(): DispatchScore {
    return {
      points: this.points,
      resolvedCalls: this.resolvedCalls,
      missedCalls: this.missedCalls,
      meanResponseTime: this.resolvedCalls > 0 ? this.totalResponseTime / this.resolvedCalls : 0,
    };
  }

  createCall(kind?: CallKind, site?: Site): EmergencyCall {
    return this.addCall(kind, site, null);
  }

  createCrashCall(incident: Incident): EmergencyCall {
    if (
      incident.kind !== 'accident' ||
      !this.sim.incidents.some((item) => item.id === incident.id)
    ) {
      throw new RangeError('Crash calls require an active accident');
    }
    const point = this.sim.incidentPoint(incident);
    const site = this.sim.sites.reduce((nearest, candidate) =>
      Math.hypot(candidate.door.x - point.x, candidate.door.y - point.y) <
      Math.hypot(nearest.door.x - point.x, nearest.door.y - point.y)
        ? candidate
        : nearest,
    );
    // The accident stays until the call is handled (or missed), not on its own timer.
    incident.until = null;
    return this.addCall('crash', site, incident.id);
  }

  private addCall(kind: CallKind | undefined, site: Site | undefined, incidentId: number | null): EmergencyCall {
    const callKind = kind ?? CALL_KINDS[Math.floor(this.rng() * CALL_KINDS.length)];
    const callSite = site ?? this.chooseCallSite();
    if (!this.sim.sites.includes(callSite)) throw new RangeError('Call site must belong to this simulation');
    const timing = CALL_TIMING[callKind];
    const call: EmergencyCall = {
      id: this.nextCallId++,
      kind: callKind,
      site: callSite,
      incidentId,
      createdAt: this.sim.time,
      targetResponseTime: timing.target,
      expiresAt: this.sim.time + timing.expires,
      state: 'created',
      assignedUnitId: null,
      responseTime: null,
    };
    this.calls.push(call);
    this.emit({ type: 'call', t: this.sim.time, callId: call.id });
    return call;
  }

  // Take the events since the last call.
  drainEvents(): DispatchEvent[] {
    return this.events.splice(0);
  }

  private emit(e: DispatchEvent): void {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  candidates(callId: number): DispatchCandidate[] {
    const call = this.calls.find((item) => item.id === callId);
    if (!call || call.state !== 'created') return [];
    return this.units
      .filter((unit) => this.isFree(unit) && unit.kind === CALL_UNIT[call.kind])
      .map((unit) => ({ unitId: unit.id, eta: this.sim.planTrip(this.startOf(unit), call.site).unitEta }))
      .filter((candidate) => Number.isFinite(candidate.eta))
      .sort((a, b) => a.eta - b.eta || a.unitId - b.unitId);
  }

  unitTravel(unitId: number): UnitTravelInfo | null {
    const unit = this.units.find((item) => item.id === unitId);
    if (!unit || unit.state !== 'en_route' || unit.tripId === null || unit.callId === null) return null;
    const call = this.calls.find((item) => item.id === unit.callId);
    if (!call) return null;
    const vehicle = this.sim.traffic.vehicleOf(unit.tripId);
    const plan = this.sim.planTrip(vehicle ?? unit.location, call.site);
    return {
      tripId: unit.tripId,
      origin: unit.station.site,
      destination: call.site,
      eta: plan.unitEta,
      route: vehicle ? vehicle.route.slice(vehicle.ri) : plan.route,
    };
  }

  // Idle at its station, or driving back to it (it turns round from where it is).
  isFree(unit: EmergencyUnit): boolean {
    if (unit.state === 'idle') return true;
    return unit.state === 'returning' && unit.tripId !== null && this.sim.traffic.vehicleOf(unit.tripId) !== undefined;
  }

  // Where a unit would set off from: its site, or its vehicle if it is on the road.
  private startOf(unit: EmergencyUnit): Site | Vehicle {
    return (unit.state === 'returning' && unit.tripId !== null && this.sim.traffic.vehicleOf(unit.tripId)) || unit.location;
  }

  assign(callId: number, unitId: number): boolean {
    const call = this.calls.find((item) => item.id === callId);
    const unit = this.units.find((item) => item.id === unitId);
    if (!call || call.state !== 'created' || !unit || !this.isFree(unit) || unit.kind !== CALL_UNIT[call.kind]) return false;
    const trip = this.sim.sendUnit(unit.kind, this.startOf(unit), call.site);
    if (!trip) return false;
    call.state = 'assigned';
    call.assignedUnitId = unit.id;
    unit.state = 'en_route';
    unit.tripId = trip.id;
    unit.callId = call.id;
    this.emit({ type: 'assigned', t: this.sim.time, callId: call.id, unitId: unit.id });
    return true;
  }

  step(t: number): void {
    if (this.ended !== null) return;
    const dt = Math.max(0, t - this.lastStepTime);
    this.lastStepTime = t;

    if (t < this.shiftEndsAt && this.callsPerHour > 0) {
      this.generationProgress += (dt * this.callsPerHour) / HOUR;
      while (this.generationProgress >= 1) {
        this.generationProgress--;
        this.createCall();
      }
    }
    if (t < this.shiftEndsAt && this.accidentsPerHour > 0) {
      // More at rush hour: the rate follows trip demand.
      const busy = this.sim.trips.ratePerHour(t) / this.sim.config.peakTripsPerHour;
      if (this.accidentRng() < (dt * this.accidentsPerHour * busy) / HOUR) this.randomAccident();
    }

    this.expireCalls(t);
    this.processRemovals();
    this.processArrivals(t);
    this.advanceUnits(t);

    if (this.mode === 'sandbox') {
      for (const call of this.calls) {
        if (call.state !== 'created') continue;
        const fastest = this.candidates(call.id)[0];
        if (fastest) this.assign(call.id, fastest.unitId);
      }
    }

    if (this.missedCalls >= this.missedLimit && this.mode === 'dispatcher') this.ended = 'loss';
    else if (t >= this.shiftEndsAt && this.mode === 'dispatcher') this.ended = 'win';
    if (this.ended !== null) this.emit({ type: 'ended', t });
  }

  end(): void {
    if (this.ended !== null) return;
    this.ended = 'ended';
    this.emit({ type: 'ended', t: this.sim.time });
  }

  // An accident on a random street, more likely where there is traffic, with its crash call.
  // Returns null if no street is free for one.
  randomAccident(): EmergencyCall | null {
    const { sim } = this;
    const net = sim.grid.net;
    const stationLinks = new Set(this.stations.flatMap((s) => [s.site.entrance.link, net.reverse(s.site.entrance.link)]));
    const minLength = 2 * BLOCK_JUNCTION_M + 12;
    let total = 0;
    const options: { link: number; weight: number }[] = [];
    for (const link of net.links) {
      const lane = sim.traffic.lanes[link.id];
      const back = net.reverse(link.id);
      if (lane.geom.length < minLength || stationLinks.has(link.id)) continue;
      if (sim.incidentOn(link.id) || (back !== undefined && sim.incidentOn(back))) continue;
      const weight = 1 + lane.vehicles.length;
      options.push({ link: link.id, weight });
      total += weight;
    }
    if (options.length === 0) return null;
    let pick = this.accidentRng() * total;
    const chosen = options.find((o) => (pick -= o.weight) < 0) ?? options[options.length - 1];
    const len = sim.traffic.lanes[chosen.link].geom.length;
    const at = BLOCK_JUNCTION_M + 6 + this.accidentRng() * (len - minLength);
    return this.createCrashCall(sim.addIncident('accident', chosen.link, at));
  }

  private expireCalls(t: number): void {
    for (const call of this.calls) {
      if (call.state === 'created' || call.state === 'assigned' || call.state === 'en_route') {
        if (call.responseTime === null && t >= call.expiresAt) this.markMissed(call);
      }
    }
  }

  private processRemovals(): void {
    for (const trip of this.sim.removals) {
      const unit = this.units.find((item) => item.tripId === trip.id);
      if (!unit) continue;
      const call = unit.callId === null ? undefined : this.calls.find((item) => item.id === unit.callId);
      if (call && call.state !== 'resolved' && call.state !== 'missed') this.markMissed(call);
      this.resetUnit(unit);
      unit.location = unit.station.site;
    }
  }

  private processArrivals(t: number): void {
    for (const trip of this.sim.arrivals) {
      const unit = this.units.find((item) => item.tripId === trip.id);
      if (!unit) continue;
      unit.tripId = null;
      if (unit.state === 'returning') {
        this.resetUnit(unit);
        unit.location = unit.station.site;
        continue;
      }

      const call = unit.callId === null ? undefined : this.calls.find((item) => item.id === unit.callId);
      if (!call || call.state === 'missed') {
        unit.location = call?.site ?? unit.location;
        this.startReturn(unit);
        continue;
      }

      unit.location = call.site;
      call.responseTime = Math.max(0, t - call.createdAt);
      this.emit({ type: 'arrived', t, callId: call.id, unitId: unit.id });
      unit.state = 'on_scene';
      unit.sceneUntil = t + CALL_TIMING[call.kind].scene;
      unit.callId = call.id;
    }
  }

  private advanceUnits(t: number): void {
    for (const unit of this.units) {
      if (unit.state === 'en_route' && unit.tripId !== null) {
        if (this.sim.traffic.vehicleOf(unit.tripId)) {
          const call = this.calls.find((item) => item.id === unit.callId);
          if (call?.state === 'assigned') call.state = 'en_route';
        }
      } else if (unit.state === 'on_scene' && unit.sceneUntil !== null && t >= unit.sceneUntil) {
        const call = unit.callId === null ? undefined : this.calls.find((item) => item.id === unit.callId);
        if (call && call.state !== 'missed' && call.state !== 'resolved') this.resolveCall(call);
        this.startReturn(unit);
      }
    }
  }

  private startReturn(unit: EmergencyUnit): void {
    const trip = this.sim.sendUnit(unit.kind, unit.location, unit.station.site, { siren: false });
    unit.callId = null;
    unit.sceneUntil = null;
    if (!trip) {
      unit.state = 'idle';
      unit.tripId = null;
      return;
    }
    unit.state = 'returning';
    unit.tripId = trip.id;
  }

  private markMissed(call: EmergencyCall): void {
    if (call.state === 'missed' || call.state === 'resolved') return;
    call.state = 'missed';
    this.emit({ type: 'missed', t: this.sim.time, callId: call.id });
    const accident = call.incidentId === null ? undefined : this.sim.incidents.find((i) => i.id === call.incidentId);
    if (accident) accident.until = this.sim.time + ACCIDENT_CLEARS_AFTER_MISS_S;
    this.missedCalls++;
    this.points -= 50;
  }

  private resolveCall(call: EmergencyCall): void {
    call.state = 'resolved';
    this.emit({ type: 'resolved', t: this.sim.time, callId: call.id, unitId: call.assignedUnitId ?? undefined });
    if (call.incidentId !== null) this.sim.removeIncident(call.incidentId);
    const responseTime = call.responseTime ?? 0;
    this.totalResponseTime += responseTime;
    this.resolvedCalls++;
    this.points += responseTime <= call.targetResponseTime
      ? 100
      : Math.round(Math.max(20, 100 - (80 * (responseTime - call.targetResponseTime)) / (call.expiresAt - call.createdAt - call.targetResponseTime)));
  }

  private resetUnit(unit: EmergencyUnit): void {
    unit.state = 'idle';
    unit.tripId = null;
    unit.callId = null;
    unit.sceneUntil = null;
  }

  private chooseCallSite(): Site {
    let total = 0;
    const weights = this.sim.sites.map((site) => {
      const density = Math.max(0.1, this.sim.zones[site.zone]?.density ?? 0.1);
      const weight = Math.sqrt(Math.max(1, site.size)) * density;
      total += weight;
      return weight;
    });
    let target = this.rng() * total;
    for (let index = 0; index < weights.length; index++) {
      target -= weights[index];
      if (target < 0) return this.sim.sites[index];
    }
    return this.sim.sites[this.sim.sites.length - 1];
  }
}
