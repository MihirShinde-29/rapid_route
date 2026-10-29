import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { mulberry32 } from '../src/core/rng';

describe('unit ETAs', () => {
  it('a unit with its siren on arrives in about its unit ETA at the morning peak', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
    while (sim.time < 8 * HOUR) sim.step();
    const rng = mulberry32(3);
    const stations = sim.sites.filter((s) => s.kind === 'hospital' || s.kind.endsWith('_station'));
    const sent = new Map<number, { eta: number; unitEta: number; at: number }>();
    const ratios: { unit: number; live: number }[] = [];
    const collect = () => {
      for (const a of sim.arrivals) {
        const s = sent.get(a.id);
        if (s) ratios.push({ unit: (sim.time - s.at) / s.unitEta, live: (sim.time - s.at) / s.eta });
      }
    };
    for (let k = 0; k < 24; k++) {
      const from = stations[Math.floor(rng() * stations.length)];
      const to = sim.sites[Math.floor(rng() * sim.sites.length)];
      const plan = sim.planTrip(from, to);
      const trip = sim.sendUnit('ambulance', from, to);
      if (trip) sent.set(trip.id, { eta: plan.eta, unitEta: plan.unitEta, at: sim.time });
      for (let s = 0; s < 300; s++) {
        sim.step();
        collect();
      }
    }
    for (let s = 0; s < 6000 && ratios.length < sent.size; s++) {
      sim.step();
      collect();
    }
    expect(ratios.length).toBe(sent.size);
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
    expect(median(ratios.map((r) => r.unit))).toBeGreaterThan(0.85);
    expect(median(ratios.map((r) => r.unit))).toBeLessThan(1.15);
    // The live-traffic ETA, meant for ordinary cars, overstates a unit's trip.
    expect(median(ratios.map((r) => r.live))).toBeLessThan(0.8);
  }, 120_000);
});
