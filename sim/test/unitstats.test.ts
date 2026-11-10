import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';

// The same units sent at the morning peak in two identical cities, siren on in one and off in the
// other. Returns per unit: the trip time each way, and the stats from the siren run.
function pairedRun(n: number) {
  const make = () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.75 });
    while (sim.time < 8 * HOUR) sim.step();
    return sim;
  };
  const on = make();
  const off = make();
  const stations = on.sites.filter((s) => s.kind === 'hospital' || s.kind.endsWith('_station'));
  const send = (sim: Simulation, siren: boolean) =>
    Array.from({ length: n }, (_, k) => {
      const st = stations[k % stations.length];
      const kind = st.kind === 'hospital' ? 'ambulance' : st.kind === 'fire_station' ? 'fire' : 'police';
      return sim.sendUnit(kind, st, sim.sites[(k * 331 + 97) % sim.sites.length], { siren })!;
    });
  const tripsOn = send(on, true);
  const tripsOff = send(off, false);
  const done = (sim: Simulation, ids: number[]) => {
    const at = new Map<number, number>();
    const t0 = sim.time;
    while (at.size < ids.length && sim.time < t0 + HOUR) {
      sim.step();
      for (const t of sim.arrivals) if (ids.includes(t.id)) at.set(t.id, sim.time - t0);
    }
    return at;
  };
  const timesOn = done(on, tripsOn.map((t) => t.id));
  const timesOff = done(off, tripsOff.map((t) => t.id));
  return tripsOn.map((t, k) => ({
    on: timesOn.get(t.id)!,
    off: timesOff.get(tripsOff[k].id)!,
    stats: on.unitStats(t.id)!,
  }));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('unit stats', () => {
  it('counts the cars that made way and estimates the time saved against driving without a siren', () => {
    const runs = pairedRun(12);
    for (const r of runs) {
      expect(r.on).toBeGreaterThan(0);
      expect(r.off).toBeGreaterThan(0);
      expect(r.stats.arrivedAt).not.toBeNull();
    }
    expect(runs.reduce((n, r) => n + r.stats.carsYielded, 0)).toBeGreaterThan(0);
    expect(runs.some((r) => r.stats.junctionsHeld > 0)).toBe(true);
    // The estimate of the time without a siren (normalEta) against the measured time without one.
    const ratio = median(runs.map((r) => r.stats.normalEta / r.off));
    const saved = runs.reduce((s, r) => s + r.stats.savedS!, 0);
    const measured = runs.reduce((s, r) => s + (r.off - r.on), 0);
    console.log(`normalEta / siren-off time: median ${ratio.toFixed(2)}; saved, estimated ${saved.toFixed(0)} s vs measured ${measured.toFixed(0)} s`);
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.4);
    expect(saved).toBeGreaterThan(0);
    expect(saved).toBeLessThan(measured); // an underestimate, never a boast
  }, 180_000);
});
