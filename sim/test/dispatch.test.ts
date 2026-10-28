import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Simulation } from '../src/sim';
import { DispatchCenter } from '../src/dispatch/dispatch';

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

  it('filters suitable idle units and sorts them by live ETA', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const call = center.createCall('medical', nonStationSite(sim));
    const candidates = center.candidates(call.id);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map(({ eta }) => eta)).toEqual([...candidates.map(({ eta }) => eta)].sort((a, b) => a - b));
    expect(candidates.every(({ unitId }) => center.units[unitId].kind === 'ambulance')).toBe(true);

    const otherKindCall = center.createCall('fire', nonStationSite(sim));
    expect(center.candidates(otherKindCall.id).every(({ unitId }) => center.units[unitId].kind === 'fire')).toBe(true);
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
    expect(unit.state).toBe('returning');
    for (let step = 0; step < 20 * 60 * 10 && unit.state !== 'idle'; step++) sim.step();
    expect(unit.state).toBe('idle');
  });

  it('keeps an assigned unit en route and resolves the call only after arrival', () => {
    const sim = quietSimulation();
    const center = new DispatchCenter(sim, { mode: 'dispatcher', callsPerHour: 0 });
    const call = center.createCall('crash', nonStationSite(sim));
    const unitId = center.candidates(call.id)[0].unitId;

    expect(center.assign(call.id, unitId)).toBe(true);
    expect(center.units[unitId].state).toBe('en_route');
    expect(call.state).toBe('assigned');
    expect(call.responseTime).toBeNull();
    expect(center.unitTravel(unitId)?.destination).toBe(call.site);
    expect(call.state).not.toBe('resolved');

    for (let step = 0; step < 20 * 60 * 10 && center.units[unitId].state !== 'on_scene'; step++) {
      sim.step();
      expect(call.state).not.toBe('resolved');
    }

    expect(center.units[unitId].state).toBe('on_scene');
    expect(call.state).toBe('en_route');
    expect(call.responseTime).not.toBeNull();

    for (let step = 0; step < 6 * 60 * 10 && call.state !== 'resolved'; step++) sim.step();
    expect(call.state).toBe('resolved');
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
    const unitId = center.candidates(call.id)[0].unitId;

    expect(center.assign(call.id, unitId)).toBe(true);
    expect(sim.incidents).toContain(accident);

    for (let step = 0; step < 20 * 60 * 10 && center.units[unitId].state !== 'on_scene'; step++) sim.step();
    expect(center.units[unitId].state).toBe('on_scene');
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
});
