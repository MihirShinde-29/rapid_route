import { describe, expect, it } from 'vitest';
import { BLOCK_JUNCTION_M, DEFAULT_CONFIG, Simulation } from '../src/sim';
import { HOUR } from '../src/core/time';
import { DispatchCenter, sortCallsByPriority } from '../src/dispatch/dispatch';

function quietSimulation(): Simulation {
  return new Simulation({ ...DEFAULT_CONFIG, peakTripsPerHour: 0 });
}

function nonStationSite(sim: Simulation) {
  return sim.sites.find((site) => !site.kind.endsWith('station') && site.kind !== 'hospital')!;
}

function unrelatedLink(sim: Simulation, incidentLinks: number[]): number {
  const link = sim.grid.net.links.find((candidate) =>
    !incidentLinks.includes(candidate.id) &&
    !incidentLinks.includes(sim.grid.net.reverse(candidate.id)!),
  );
  if (!link) throw new Error('Expected a separate street for an unrelated incident');
  return link.id;
}

function exerciseMultiUnitResolution(kind: 'crash' | 'fire', firstKind: 'police' | 'fire', secondKind: 'ambulance'): void {
  const sim = quietSimulation();
  const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
  const call = center.createCall(kind, nonStationSite(sim));
  call.expiresAt = Infinity;
  expect(call.needs).toEqual(kind === 'crash' ? ['police', 'ambulance'] : ['fire', 'ambulance']);

  const firstCandidate = center.candidates(call.id).find(({ unitId }) => center.units[unitId].kind === firstKind);
  expect(firstCandidate).toBeDefined();
  expect(center.assign(call.id, firstCandidate!.unitId)).toBe(true);
  const firstUnit = center.units[firstCandidate!.unitId];
  for (let step = 0; step < 20 * 60 * 10 && firstUnit.state !== 'on_scene'; step++) sim.step();
  expect(firstUnit.state).toBe('on_scene');

  for (let step = 0; step < 10 * 60 * 10 && sim.time <= (firstUnit.sceneUntil ?? Infinity); step++) sim.step();
  expect(call.arrivedUnitIds).toEqual([firstUnit.id]);
  expect(call.state).not.toBe('resolved');

  const secondCandidate = center.candidates(call.id).find(({ unitId }) => center.units[unitId].kind === secondKind);
  expect(secondCandidate).toBeDefined();
  expect(center.assign(call.id, secondCandidate!.unitId)).toBe(true);
  expect(center.assign(call.id, firstUnit.id)).toBe(false);

  for (let step = 0; step < 30 * 60 * 10 && call.state !== 'resolved'; step++) sim.step();
  expect(call.state).toBe('resolved');
  expect(call.assignedUnitIds).toHaveLength(2);
  expect(call.arrivedUnitIds).toHaveLength(2);
  expect(call.responseTime).toBeGreaterThan(0);
  expect(center.score.resolvedCalls).toBe(1);
}

describe('dispatch', () => {
  it('creates addressed calls and generates them at the configured rate', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 3600, seed: 3 });
    const call = center.createCall('medical', nonStationSite(sim));
    expect(call.site.address).toMatch(/^\d+ \w+ (St|Ave)$/);
    expect(call.state).toBe('created');

    sim.step(1);
    sim.step(1);
    expect(center.calls).toHaveLength(2);
    expect(center.calls[1].state).toBe('created');
  });

  it('orders calls by severity, then remaining time', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const low = center.createCall('medical', nonStationSite(sim), 'low');
    const medium = center.createCall('medical', nonStationSite(sim), 'medium');
    const criticalLater = center.createCall('medical', nonStationSite(sim), 'critical');
    const criticalSooner = center.createCall('medical', nonStationSite(sim), 'critical');
    criticalLater.expiresAt = sim.time + 300;
    criticalSooner.expiresAt = sim.time + 100;

    expect(sortCallsByPriority([low, criticalLater, medium, criticalSooner], sim.time).map((call) => call.id))
      .toEqual([criticalSooner.id, criticalLater.id, medium.id, low.id]);
  });

  it('expires critical calls before low-severity calls created at the same time', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const low = center.createCall('medical', nonStationSite(sim), 'low');
    const critical = center.createCall('medical', nonStationSite(sim), 'critical');

    expect(critical.expiresAt).toBeLessThan(low.expiresAt);
    center.step(critical.expiresAt);

    expect(critical.state).toBe('missed');
    expect(low.state).toBe('created');
  });

  it('awards more points for critical calls than lower-severity calls', () => {
    const scoreFor = (severity: 'low' | 'medium' | 'critical', targetResponseTime: number) => {
      const sim = quietSimulation();
      const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
      const call = center.createCall('medical', nonStationSite(sim), severity);
      call.targetResponseTime = targetResponseTime;
      call.expiresAt = Infinity;
      const unitId = center.candidates(call.id)[0].unitId;
      expect(center.assign(call.id, unitId)).toBe(true);
      for (let step = 0; step < 20 * 60 * 10 && call.state !== 'resolved'; step++) sim.step();
      expect(call.state).toBe('resolved');
      return center.score.points;
    };

    expect(scoreFor('medium', Infinity)).toBe(100);
    expect(scoreFor('critical', Infinity)).toBeGreaterThan(scoreFor('low', Infinity));
    expect(scoreFor('critical', 0)).toBeGreaterThan(scoreFor('low', 0));
  });

  it('filters suitable idle units and sorts them by live ETA', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const call = center.createCall('medical', nonStationSite(sim));
    const candidates = center.candidates(call.id);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map(({ eta }) => eta)).toEqual([...candidates.map(({ eta }) => eta)].sort((a, b) => a - b));
    expect(candidates.every(({ unitId }) => center.units[unitId].kind === 'ambulance')).toBe(true);

    const otherKindCall = center.createCall('fire', nonStationSite(sim));
    expect(new Set(center.candidates(otherKindCall.id).map(({ unitId }) => center.units[unitId].kind))).toEqual(new Set(['fire', 'ambulance']));
  });

  it('assigns a selected unit to a selected call', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const call = center.createCall('medical', nonStationSite(sim));
    const unitId = center.candidates(call.id)[0].unitId;

    expect(center.assign(call.id, unitId)).toBe(true);
    expect(call.state).toBe('assigned');
    expect(call.assignedUnitId).toBe(unitId);
    expect(center.units[unitId].state).toBe('en_route');
    expect(center.assign(call.id, unitId)).toBe(false);
  });

  it('does not offer or assign a committed unit to another active call', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const first = center.createCall('medical', nonStationSite(sim));
    const unitId = center.candidates(first.id)[0].unitId;
    expect(center.assign(first.id, unitId)).toBe(true);

    const second = center.createCall('medical', sim.sites[(first.site.id + 100) % sim.sites.length]);
    expect(center.candidates(second.id).some((candidate) => candidate.unitId === unitId)).toBe(false);
    expect(center.assign(second.id, unitId)).toBe(false);
  });

  it('offers and assigns a suitable unit from another station as mutual aid when local units are busy', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const target = center.createCall('medical', nonStationSite(sim), 'medium');
    const localStation = center.stations
      .filter((station) => station.kind === 'ambulance')
      .sort((a, b) =>
        sim.planUnitTrip(a.site, target.site).unitEta - sim.planUnitTrip(b.site, target.site).unitEta ||
        a.id - b.id,
      )[0];

    for (const unitId of localStation.unitIds) {
      const blockingCall = center.createCall('medical', nonStationSite(sim), 'medium');
      expect(center.assign(blockingCall.id, unitId)).toBe(true);
    }

    const candidates = center.candidates(target.id);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.mutualAid)).toBe(true);
    const candidate = candidates[0];
    const unit = center.units[candidate.unitId];
    expect(unit.station).not.toBe(localStation);
    expect(candidate.eta).toBe(sim.planUnitTrip(unit.location, target.site).unitEta);
    expect(center.assign(target.id, unit.id)).toBe(true);
    expect(unit.callId).toBe(target.id);
  });

  it('resolves a call from the simulation arrival stream and tracks response', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const call = center.createCall('medical', nonStationSite(sim));
    const unitId = center.candidates(call.id)[0].unitId;
    expect(center.assign(call.id, unitId)).toBe(true);

    for (let step = 0; step < 20 * 60 * 10 && center.units[unitId].state !== 'on_scene'; step++) sim.step();

    expect(call.state).toBe('en_route');
    expect(call.responseTime).not.toBeNull();
    expect(call.responseTime).toBeGreaterThanOrEqual(0);
    const unit = center.units[unitId];
    expect(unit.state).toBe('on_scene');

    for (let step = 0; step < 6 * 60 * 10 && call.state !== 'resolved'; step++) sim.step();
    expect(call.state).toBe('resolved');
    expect(center.score.resolvedCalls).toBe(1);
    expect(center.score.meanResponseTime).toBe(call.responseTime);
    expect(center.score.points).toBeGreaterThan(0);
    // A medical call: the ambulance takes the patient to hospital before it is free again.
    expect(unit.state).toBe('to_hospital');
    for (let step = 0; step < 40 * 60 * 10 && unit.state !== 'idle'; step++) sim.step();
    expect(unit.state).toBe('idle');
  });

  it('takes the patient to the nearest hospital after a medical call, then returns', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const call = center.createCall('medical', nonStationSite(sim));
    const unitId = center.candidates(call.id)[0].unitId;
    const unit = center.units[unitId];
    expect(center.assign(call.id, unitId)).toBe(true);
    const states: string[] = [];
    let hospital: string | null = null;
    for (let step = 0; step < 60 * 60 * 10 && !(states.includes('to_hospital') && unit.state === 'idle'); step++) {
      sim.step();
      if (states[states.length - 1] !== unit.state) states.push(unit.state);
      if (unit.state === 'to_hospital' && unit.tripId === null) hospital = unit.location.kind;
    }
    expect(call.state).toBe('resolved');
    expect(hospital).toBe('hospital'); // handed over at a hospital
    expect(states.indexOf('on_scene')).toBeLessThan(states.indexOf('to_hospital'));
    expect(unit.state).toBe('idle');
    expect(unit.location).toBe(unit.station.site);
    expect(center.isFree(unit)).toBe(true);
  });

  it('resolves a crash only after police and ambulance arrive', () => {
    exerciseMultiUnitResolution('crash', 'police', 'ambulance');
  });

  it('resolves a fire only after fire engine and ambulance arrive', () => {
    exerciseMultiUnitResolution('fire', 'fire', 'ambulance');
  });

  it('creates a linked crash call when an accident is placed', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const accident = sim.addIncident('accident', sim.grid.net.links.find((link) => link.arterial)!.id);

    const call = center.createCrashCall(accident);

    expect(call.kind).toBe('crash');
    expect(call.incidentId).toBe(accident.id);
    expect(center.calls).toContain(call);
    expect(sim.incidents).toContain(accident);
  });

  it('removes only the associated accident after resolving its crash call and keeps call history', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const accident = sim.addIncident('accident', sim.grid.net.links.find((link) => link.arterial)!.id);
    const unrelated = sim.addIncident('lane', unrelatedLink(sim, accident.links));
    const call = center.createCrashCall(accident);
    const firstUnitId = center.candidates(call.id)[0].unitId;

    expect(center.assign(call.id, firstUnitId)).toBe(true);
    const secondUnitId = center.candidates(call.id).find(({ unitId }) => unitId !== firstUnitId)!.unitId;
    expect(center.assign(call.id, secondUnitId)).toBe(true);
    expect(sim.incidents).toContain(accident);

    for (let step = 0; step < 20 * 60 * 10 && center.units[firstUnitId].state !== 'on_scene'; step++) sim.step();
    expect(center.units[firstUnitId].state).toBe('on_scene');
    expect(call.state).toBe('en_route');
    expect(sim.incidents).toContain(accident);

    for (let step = 0; step < 6 * 60 * 10 && call.state !== 'resolved'; step++) sim.step();

    expect(call.state).toBe('resolved');
    expect(center.calls).toContain(call);
    expect(sim.incidents).not.toContain(accident);
    expect(sim.incidents).toContain(unrelated);
    expect(sim.incidents.map((incident) => incident.id)).toEqual([unrelated.id]);
    expect(sim.traffic.blockages.map((blockage) => blockage.id)).toEqual([unrelated.blockage]);
    expect(sim.traffic.blockDelay(accident.lane!)).toBe(0);
    expect(sim.traffic.blockDelay(unrelated.lane!)).toBeGreaterThan(0);
  });

  it('marks an unassigned call missed at expiry', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const call = center.createCall('crime', nonStationSite(sim));

    center.step(call.expiresAt);

    expect(call.state).toBe('missed');
    expect(center.score.missedCalls).toBe(1);
    expect(center.score.points).toBe(-50);
  });

  it('wins after a shift and loses at the missed-call limit', () => {
    const winningSim = quietSimulation();
    const winner = new DispatchCenter(winningSim, { mode: 'dispatcher', callsPerHour: 0, shiftDurationSeconds: 10 });
    winner.step(winner.shiftEndsAt);
    expect(winner.ended).toBe('win');

    const losingSim = quietSimulation();
    const loser = new DispatchCenter(losingSim, { mode: 'dispatcher', callsPerHour: 0, missedLimit: 2 });
    loser.createCall('medical', nonStationSite(losingSim));
    loser.createCall('fire', nonStationSite(losingSim));
    loser.step(loser.calls[0].expiresAt);
    expect(loser.ended).toBe('loss');
    expect(loser.score.missedCalls).toBe(2);
  });

  it('automatically assigns the fastest suitable unit in sandbox mode', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'sandbox', callsPerHour: 0 });
    const call = center.createCall('medical', nonStationSite(sim));
    const fastest = center.candidates(call.id)[0].unitId;

    center.step(sim.time);

    expect(call.state).toBe('assigned');
    expect(call.assignedUnitId).toBe(fastest);
  });

  it('reports call, assigned, arrived, resolved and ended events in order', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const call = center.createCall('medical', nonStationSite(sim));
    const unitId = center.candidates(call.id)[0].unitId;
    center.assign(call.id, unitId);
    for (let step = 0; step < 30 * 60 * 10 && call.state !== 'resolved'; step++) sim.step();
    center.end();
    const events = center.drainEvents();
    expect(events.map((e) => e.type)).toEqual(['call', 'assigned', 'arrived', 'resolved', 'ended']);
    expect(events.slice(0, 4).every((e) => e.callId === call.id)).toBe(true);
    expect(events[1].unitId).toBe(unitId);
    expect(center.drainEvents()).toEqual([]);
  });

  it('sets the number of units per station by difficulty', () => {
    const sim = quietSimulation();
    const easy = new DispatchCenter(sim, { mode: 'dispatcher', unitCounts: { ambulance: 3, police: 2 } });
    const hard = new DispatchCenter(sim, { mode: 'dispatcher', unitCounts: { police: 1 } });
    for (const station of easy.stations) expect(station.unitIds.length).toBe(station.kind === 'ambulance' ? 3 : station.kind === 'police' ? 2 : 1);
    for (const station of hard.stations) expect(station.unitIds.length).toBe(station.kind === 'police' ? 1 : station.kind === 'ambulance' ? 2 : 1);
  });

  it('places random accidents on busy streets, each with its own crash call, more at rush hour', () => {
    const count = (hour: number) => {
      const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: hour });
      const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0, accidentsPerHour: 12, missedLimit: 1000 });
      while (sim.time < (hour + 1) * HOUR) sim.step();
      for (const call of center.calls) {
        expect(call.kind).toBe('crash');
        const inc = sim.incidents.find((i) => i.id === call.incidentId);
        if (!inc) continue; // cleared on its own after 20 minutes
        expect(inc.kind).toBe('accident');
        const len = sim.traffic.lanes[inc.lane!].geom.length;
        expect(inc.from).toBeGreaterThanOrEqual(BLOCK_JUNCTION_M - 1e-9);
        expect(inc.to).toBeLessThanOrEqual(len - BLOCK_JUNCTION_M + 1e-9);
      }
      return center.calls.length;
    };
    const rush = count(7.5);
    const night = count(2);
    expect(rush).toBeGreaterThanOrEqual(5);
    expect(rush).toBeLessThanOrEqual(20);
    expect(night).toBeLessThan(rush);
    // Never two on one street.
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'sandbox' });
    for (let k = 0; k < 30; k++) center.randomAccident();
    const streets = sim.incidents.map((i) => Math.min(i.links[0], sim.grid.net.reverse(i.links[0]) ?? Infinity));
    expect(new Set(streets).size).toBe(sim.incidents.length);
    expect(center.calls.map((c) => c.incidentId)).toEqual(sim.incidents.map((i) => i.id));
  }, 120_000);

  it('keeps an accident with a crash call until the call is handled, and clears it later if missed', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0, missedLimit: 10 });
    const accident = sim.addIncident('accident', sim.grid.net.links.find((link) => link.arterial)!.id);
    const call = center.createCrashCall(accident);
    while (sim.time < accident.placedAt + 25 * 60) sim.step();
    expect(call.state).toBe('missed');
    expect(sim.incidents).toContain(accident); // its own 20-minute timer no longer applies
    while (sim.time < accident.placedAt + 41 * 60) sim.step();
    expect(sim.incidents).not.toContain(accident);
  });

  it('sends a unit that is driving back to its station to a new call, from where it is', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const first = center.createCall('crime', nonStationSite(sim));
    const unitId = center.candidates(first.id)[0].unitId;
    center.assign(first.id, unitId);
    const unit = center.units[unitId];
    for (let step = 0; step < 40 * 60 * 10 && !(unit.state === 'returning' && unit.tripId !== null && sim.traffic.vehicleOf(unit.tripId)); step++) sim.step();
    expect(unit.state).toBe('returning');
    for (let step = 0; step < 100; step++) sim.step();
    const veh = sim.traffic.vehicleOf(unit.tripId!)!;
    expect(veh.siren).toBe(false);
    const second = center.createCall('crime', sim.sites[(first.site.id + 400) % sim.sites.length]);
    const offer = center.candidates(second.id).find((c) => c.unitId === unitId);
    expect(offer).toBeDefined();
    expect(center.assign(second.id, unitId)).toBe(true);
    expect(unit.state).toBe('en_route');
    expect(veh.siren).toBe(true);
    for (let step = 0; step < 30 * 60 * 10 && unit.state === 'en_route'; step++) sim.step();
    expect(unit.state).toBe('on_scene');
    expect(unit.location).toBe(second.site);
    expect(second.responseTime).not.toBeNull();
  });
});
