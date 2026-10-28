import { HOUR } from '../core/time';
import { mulberry32 } from '../core/rng';
import type { Site } from '../city/sites';
import type { EmergencyKind } from '../traffic/vehicleTypes';
import type { Simulation } from '../sim';

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
}

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

  private readonly rng: () => number;
  private readonly callsPerHour: number;
  private lastStepTime: number;
  private generationProgress = 0;
  private nextCallId = 1;
  private points = 0;
  private totalResponseTime = 0;
  private resolvedCalls = 0;
  private missedCalls = 0;

  constructor(private readonly sim: Simulation, opts: DispatchOptions) {
    this.mode = opts.mode;
    this.callsPerHour = Math.max(0, opts.callsPerHour ?? DEFAULT_CALLS_PER_HOUR);
    this.shiftEndsAt = sim.time + Math.max(0, opts.shiftDurationSeconds ?? DEFAULT_SHIFT_SECONDS);
    this.missedLimit = Math.max(1, Math.floor(opts.missedLimit ?? DEFAULT_MISSED_LIMIT));
    this.rng = mulberry32(opts.seed ?? sim.config.seed ^ 0xa4d15);
    this.lastStepTime = sim.time;

    for (const site of sim.sites) {
      const kind = SITE_TO_UNIT[site.kind];
      if (!kind) continue;
      const station: Station = { id: this.stations.length, kind, site, unitIds: [] };
      this.stations.push(station);
      for (let count = 0; count < UNIT_COUNTS[kind]; count++) {
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
    const callKind = kind ?? CALL_KINDS[Math.floor(this.rng() * CALL_KINDS.length)];
    const callSite = site ?? this.chooseCallSite();
    if (!this.sim.sites.includes(callSite)) throw new RangeError('Call site must belong to this simulation');
    const timing = CALL_TIMING[callKind];
    const call: EmergencyCall = {
      id: this.nextCallId++,
      kind: callKind,
      site: callSite,
      createdAt: this.sim.time,
      targetResponseTime: timing.target,
      expiresAt: this.sim.time + timing.expires,
      state: 'created',
      assignedUnitId: null,
      responseTime: null,
    };
    this.calls.push(call);
    return call;
  }

  candidates(callId: number): DispatchCandidate[] {
    const call = this.calls.find((item) => item.id === callId);
    if (!call || call.state !== 'created') return [];
    return this.units
      .filter((unit) => unit.state === 'idle' && unit.kind === CALL_UNIT[call.kind])
      .map((unit) => ({ unitId: unit.id, eta: this.sim.planTrip(unit.location, call.site).eta }))
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
      eta: plan.eta,
      route: vehicle ? vehicle.route.slice(vehicle.ri) : plan.route,
    };
  }

  assign(callId: number, unitId: number): boolean {
    const call = this.calls.find((item) => item.id === callId);
    const unit = this.units.find((item) => item.id === unitId);
    if (!call || call.state !== 'created' || !unit || unit.state !== 'idle' || unit.kind !== CALL_UNIT[call.kind]) return false;
    const trip = this.sim.sendUnit(unit.kind, unit.location, call.site);
    if (!trip) return false;
    call.state = 'assigned';
    call.assignedUnitId = unit.id;
    unit.state = 'en_route';
    unit.tripId = trip.id;
    unit.callId = call.id;
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
  }

  end(): void {
    if (this.ended === null) this.ended = 'ended';
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
    this.missedCalls++;
    this.points -= 50;
  }

  private resolveCall(call: EmergencyCall): void {
    call.state = 'resolved';
    const responseTime = call.responseTime ?? 0;
    this.totalResponseTime += responseTime;
    this.resolvedCalls++;
    this.points += responseTime <= call.targetResponseTime
      ? 100
      : Math.max(20, 100 - (80 * (responseTime - call.targetResponseTime)) / (call.expiresAt - call.createdAt - call.targetResponseTime));
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
