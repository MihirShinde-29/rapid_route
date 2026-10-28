import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { mulberry32 } from '../src/core/rng';

describe('coverage map', () => {
  it('times from the stations match single-source A* from the nearest one, on live traffic', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.75 });
    while (sim.time < 8 * HOUR) sim.step();
    const net = sim.grid.net;
    const sources = sim.sites.filter((s) => s.kind === 'hospital' || s.kind.endsWith('_station')).map((s) => net.links[s.entrance.link].to);
    const times = sim.coverageTimes(sources);
    const rng = mulberry32(7);
    for (let k = 0; k < 60; k++) {
      const node = Math.floor(rng() * net.nodes.length);
      const best = Math.min(...sources.map((s) => (s === node ? 0 : sim.router.routeWithCost(s, node).cost)));
      expect(times[node]).toBeCloseTo(best, 6);
    }
    for (const s of sources) expect(times[s]).toBe(0);
    // Fewer free units never make anywhere quicker to reach.
    const fewer = sim.coverageTimes(sources.slice(0, 2));
    for (let n = 0; n < net.nodes.length; n++) expect(fewer[n]).toBeGreaterThanOrEqual(times[n] - 1e-9);
  }, 60_000);
});
