import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { buildGrid } from '../src/network/grid';
import { Router } from '../src/routing/router';
import { TrafficModel } from '../src/traffic/traffic';
import type { Trip } from '../src/demand/trips';

// One straight street of five blocks, traffic both ways, and part of the eastbound lane of the
// middle block blocked (`from`, `to`: fractions of its length). `east`, `west`: seconds
// between departures each way.
function blockedStreet(east: number, west: number, from: number, to: number, passSpeed: number) {
  const grid = buildGrid({ ...buildGrid().opts, cols: 6, rows: 1 });
  const model = new TrafficModel(grid.net, { signals: false });
  const router = new Router(grid.net);
  const eastRoute = router.route(0, 5);
  const westRoute = router.route(5, 0);
  const lane = eastRoute[2];
  const len = model.lanes[lane].geom.length;
  model.addBlockage(lane, from * len, to * len, passSpeed);
  let id = 0;
  const trip = (dest: number): Trip => ({ id: id++, originZone: 0, destZone: 0, originNode: 0, destNode: dest, departTime: 0, departPos: 20 });
  const errors: string[] = [];
  let passed = 0; // eastbound cars that pulled fully out into the oncoming lane
  let maxStopped = 0;
  const sent = { east: 0, west: 0 };
  const seen = new Set<number>();
  for (let k = 0; k < 6000; k++) {
    const t = k / 10;
    if (k < 3000 && k % Math.round(east * 10) === 0) {
      model.enqueue({ ...trip(5), originNode: 0 }, eastRoute);
      sent.east++;
    }
    if (k < 3000 && k % Math.round(west * 10) === 0) {
      model.enqueue({ ...trip(0), originNode: 5 }, westRoute);
      sent.west++;
    }
    model.step(t, 0.1);
    errors.push(...model.zoneConflicts());
    if (k % 5 === 0) errors.push(...model.checkInvariants());
    for (const v of model.vehicles) {
      maxStopped = Math.max(maxStopped, v.stoppedFor);
      if (v.pass === 1 && !seen.has(v.id)) {
        seen.add(v.id);
        passed++;
      }
    }
    if (k > 3000 && model.vehicles.size === 0 && model.waitingToDepart === 0) break;
  }
  return { errors, passed, maxStopped, sent, arrived: model.arrived, left: model.vehicles.size + model.waitingToDepart, removed: model.removedGridlock };
}

describe('a blocked lane (one-lane-bridge control)', () => {
  it('cars pass an accident through the oncoming lane, never meeting an oncoming car in the zone', () => {
    const run = blockedStreet(6, 6, 0.45, 0.6, 4);
    expect(run.errors).toEqual([]);
    expect(run.left).toBe(0);
    expect(run.removed).toBe(0);
    expect(run.arrived).toBe(run.sent.east + run.sent.west);
    expect(run.passed).toBe(run.sent.east);
  });

  it('with steady oncoming traffic the blocked side still gets turns at a long lane closure', () => {
    const run = blockedStreet(12, 6, 0.25, 0.8, 7);
    expect(run.errors).toEqual([]);
    expect(run.left).toBe(0);
    expect(run.removed).toBe(0);
    expect(run.passed).toBe(run.sent.east);
    expect(run.maxStopped).toBeLessThan(90);
  });
});

// The busiest arterial lane right now.
function busyArterial(sim: Simulation): number {
  let best = -1;
  for (const lane of sim.traffic.lanes) {
    if (!lane.link.arterial) continue;
    if (best < 0 || lane.vehicles.length > sim.traffic.lanes[best].vehicles.length) best = lane.link.id;
  }
  return best;
}

describe('incidents on a lane in the city', () => {
  for (const kind of ['accident', 'lane'] as const) {
    it(`${kind === 'accident' ? 'an accident' : 'a lane closure'} on a busy arterial at the peak: cars get round it, no gridlock`, () => {
      const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
      while (sim.time < 7.75 * HOUR) sim.step();
      const inc = sim.addIncident(kind, busyArterial(sim));
      expect(inc.lane).toBe(inc.links[0]);
      expect(inc.to - inc.from).toBeGreaterThanOrEqual(12);
      let passed = 0;
      let steps = 0;
      const end = sim.time + 0.25 * HOUR;
      while (sim.time < end) {
        sim.step();
        if (sim.time > inc.placedAt + 30) expect(sim.traffic.zoneConflicts()).toEqual([]);
        if (++steps % 10 === 0) expect(sim.traffic.checkInvariants()).toEqual([]);
        for (const v of sim.traffic.lanes[inc.lane!].vehicles) if (v.pass === 1) passed++;
      }
      expect(passed).toBeGreaterThan(0);
      expect(sim.traffic.removedGridlock).toBe(0);
      if (kind === 'accident') {
        while (sim.time < inc.until! + 1) sim.step();
        expect(sim.incidents).toHaveLength(0);
        expect(sim.traffic.blockages).toHaveLength(0);
      }
    }, 120_000);
  }
});

describe('units and blocked lanes together', () => {
  it('12 units at the peak with an accident and a lane closure on busy arterials: all arrive, no gridlock', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
    while (sim.time < 8.08 * HOUR) sim.step();
    const stations = sim.sites.filter((s) => s.kind === 'hospital' || s.kind.endsWith('_station'));
    const pending = new Set<number>();
    for (let r = 0; r < 2; r++) {
      stations.forEach((st, k) => {
        const kind = st.kind === 'hospital' ? 'ambulance' : st.kind === 'fire_station' ? 'fire' : 'police';
        const trip = sim.sendUnit(kind, st, sim.sites[(k * 331 + 97 + r * 500) % sim.sites.length]);
        if (trip) pending.add(trip.id);
      });
    }
    const lanes = sim.traffic.lanes.filter((l) => l.link.arterial && l.geom.length > 70).sort((a, b) => b.vehicles.length - a.vehicles.length);
    sim.addIncident('accident', lanes[0].link.id);
    sim.addIncident('lane', lanes[3].link.id);
    let steps = 0;
    while (sim.time < 8.25 * HOUR) {
      sim.step();
      for (const t of sim.arrivals) pending.delete(t.id);
      if (++steps % 10 === 0) {
        expect(sim.traffic.checkInvariants()).toEqual([]);
        expect(sim.traffic.zoneConflicts()).toEqual([]);
      }
    }
    expect(pending.size).toBe(0);
    expect(sim.traffic.removedGridlock).toBe(0);
  }, 180_000);
});
