// Node built-ins; the project has no @types/node.
// @ts-ignore
import { writeFileSync } from 'node:fs';
declare const process: { env: Record<string, string | undefined> };
import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { mulberry32 } from '../src/core/rng';
import { Simulation, DEFAULT_CONFIG, type SimConfig } from '../src/sim';
import { DispatchCenter } from '../src/dispatch/dispatch';
import type { EmergencyKind } from '../src/traffic/vehicleTypes';
import type { Weather } from '../src/traffic/traffic';

// Experiments for the report (W13). Slow (several minutes), so they run only when asked:
//   EXPERIMENTS=1 npx vitest run test/experiments.test.ts
// Results are printed and written to docs/A5_EXPERIMENTS.json.

const results: Record<string, unknown> = {};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const stations = (sim: Simulation) => sim.sites.filter((s) => s.kind === 'hospital' || s.kind.endsWith('_station'));
const UNIT_OF: Record<string, EmergencyKind> = { hospital: 'ambulance', fire_station: 'fire', police_station: 'police' };

describe.runIf(process.env.EXPERIMENTS === '1')('experiments for the report', () => {
  it('performance: step time with more cars (1000+) and units out', () => {
    const out: unknown[] = [];
    for (const peak of [11500, 15000, 18000]) {
      const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5, peakTripsPerHour: peak });
      while (sim.time < 8 * HOUR) sim.step();
      // 24 units out with their sirens on across the city.
      const st = stations(sim);
      const rng = mulberry32(11);
      for (let k = 0; k < 24; k++) {
        const from = st[k % st.length];
        sim.sendUnit(UNIT_OF[from.kind], from, sim.sites[Math.floor(rng() * sim.sites.length)]);
      }
      const ms: number[] = [];
      let cars = 0;
      const removedBefore = sim.traffic.removedGridlock;
      while (sim.time < 8.25 * HOUR) {
        const t0 = performance.now();
        sim.step();
        ms.push(performance.now() - t0);
        cars = Math.max(cars, sim.traffic.vehicles.size);
      }
      out.push({ peakTripsPerHour: peak, maxVehicles: cars, meanStepMs: round(mean(ms)), p95StepMs: round(pct(ms, 0.95)), gridlockRemovals: sim.traffic.removedGridlock - removedBefore });
    }
    results.performance = out;
    console.log('performance', JSON.stringify(out));
  }, 900_000);

  it('yielding: the same unit trips with the siren on and off', () => {
    const run = (siren: boolean) => {
      const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
      while (sim.time < 8 * HOUR) sim.step();
      const st = stations(sim);
      const rng = mulberry32(5);
      const sent = new Map<number, number>();
      const times: number[] = [];
      for (let k = 0; k < 16; k++) {
        const from = st[Math.floor(rng() * st.length)];
        const to = sim.sites[Math.floor(rng() * sim.sites.length)];
        const trip = sim.sendUnit(UNIT_OF[from.kind], from, to, { siren });
        if (trip) sent.set(trip.id, sim.time);
        for (let s = 0; s < 200; s++) {
          sim.step();
          for (const a of sim.arrivals) if (sent.has(a.id)) times.push(sim.time - sent.get(a.id)!);
        }
      }
      for (let s = 0; s < 9000 && times.length < sent.size; s++) {
        sim.step();
        for (const a of sim.arrivals) if (sent.has(a.id)) times.push(sim.time - sent.get(a.id)!);
      }
      return times;
    };
    const on = run(true);
    const off = run(false);
    results.yielding = { trips: on.length, meanOnS: round(mean(on), 0), meanOffS: round(mean(off), 0), medianOnS: round(median(on), 0), medianOffS: round(median(off), 0), ratio: round(mean(on) / mean(off)) };
    console.log('yielding', JSON.stringify(results.yielding));
    expect(mean(on)).toBeLessThan(mean(off));
  }, 900_000);

  it('ETA accuracy: unit trips against their unit ETA at the peak', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
    while (sim.time < 8 * HOUR) sim.step();
    const st = stations(sim);
    const rng = mulberry32(3);
    const sent = new Map<number, { unitEta: number; at: number }>();
    const ratios: number[] = [];
    const errs: number[] = [];
    const collect = () => {
      for (const a of sim.arrivals) {
        const s = sent.get(a.id);
        if (!s) continue;
        ratios.push((sim.time - s.at) / s.unitEta);
        errs.push(Math.abs(sim.time - s.at - s.unitEta));
      }
    };
    for (let k = 0; k < 40; k++) {
      const from = st[Math.floor(rng() * st.length)];
      const to = sim.sites[Math.floor(rng() * sim.sites.length)];
      const plan = sim.planUnitTrip(from, to);
      const trip = sim.sendUnit(UNIT_OF[from.kind], from, to);
      if (trip) sent.set(trip.id, { unitEta: plan.unitEta, at: sim.time });
      for (let s = 0; s < 200; s++) {
        sim.step();
        collect();
      }
    }
    for (let s = 0; s < 9000 && ratios.length < sent.size; s++) {
      sim.step();
      collect();
    }
    results.eta = { trips: ratios.length, medianRatio: round(median(ratios)), p10: round(pct(ratios, 0.1)), p90: round(pct(ratios, 0.9)), meanAbsErrorS: round(mean(errs), 0) };
    console.log('eta', JSON.stringify(results.eta));
  }, 900_000);

  it('dispatch policy: lowest live ETA against nearest unit, over a 2-hour auto-dispatched shift', () => {
    // Three call streams (seeds) per setting, pooled.
    const shift = (policy: 'eta' | 'nearest', callsPerHour: number) => {
      let calls = 0;
      let missed = 0;
      let within = 0;
      const resp: number[] = [];
      for (const seed of [21, 22, 23]) {
        const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7 });
        const center = new DispatchCenter(sim, { mode: 'sandbox', callsPerHour, policy, accidentsPerHour: 1, seed });
        while (sim.time < 9 * HOUR) sim.step();
        const done = center.calls.filter((c) => c.state === 'resolved');
        calls += center.calls.length;
        missed += center.calls.filter((c) => c.state === 'missed').length;
        within += done.filter((c) => (c.responseTime ?? 0) <= c.targetResponseTime).length;
        resp.push(...done.map((c) => c.responseTime ?? 0));
      }
      return { policy, callsPerHour, seeds: 3, calls, resolved: resp.length, missed, meanResponseS: round(mean(resp), 0), medianResponseS: round(median(resp), 0), withinTarget: round(within / Math.max(1, resp.length)) };
    };
    const out = [shift('eta', 20), shift('nearest', 20), shift('eta', 30), shift('nearest', 30)];
    results.dispatchPolicy = out;
    console.log('dispatchPolicy', JSON.stringify(out));
  }, 900_000);

  it('coverage: share of junctions a free unit can reach in 4 and 8 minutes at the peak', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
    while (sim.time < 8 * HOUR) sim.step();
    const net = sim.grid.net;
    const out: Record<string, unknown> = {};
    for (const kind of ['all', 'ambulance', 'fire', 'police'] as const) {
      const src = stations(sim).filter((s) => kind === 'all' || UNIT_OF[s.kind] === kind).map((s) => net.links[s.entrance.link].to);
      const times = [...sim.coverageTimes(src)].filter((t) => Number.isFinite(t));
      out[kind] = { within4min: round(times.filter((t) => t <= 240).length / times.length), within8min: round(times.filter((t) => t <= 480).length / times.length), medianS: round(median(times), 0) };
    }
    results.coverage = out;
    console.log('coverage', JSON.stringify(out));
  }, 300_000);

  it('weather: peak trip times in clear, rain and fog', () => {
    const out: Record<string, unknown> = {};
    for (const w of ['clear', 'rain', 'fog'] as Weather[]) {
      const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 } as SimConfig);
      sim.weather = w;
      const starts = new Map<number, number>();
      const times: number[] = [];
      while (sim.time < 8.25 * HOUR) {
        const spawned = sim.step();
        if (sim.time < 8 * HOUR) for (const t of spawned) starts.set(t.id, t.departTime);
        for (const t of sim.arrivals) if (starts.has(t.id)) times.push(sim.time - starts.get(t.id)!);
      }
      out[w] = { meanTripS: round(mean(times), 0), gridlockRemovals: sim.traffic.removedGridlock };
    }
    results.weather = out;
    console.log('weather', JSON.stringify(out));
  }, 900_000);

  it('writes the results', () => {
    writeFileSync(new URL('../../docs/A5_EXPERIMENTS.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
  });
});
