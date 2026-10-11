import { describe, expect, it } from 'vitest';
import { mulberry32, poisson } from '../src/core/rng';
import { HOUR, volumeFactor } from '../src/core/time';
import { buildGrid } from '../src/network/grid';
import { shortestCosts } from '../src/network/network';
import { gravityOd } from '../src/demand/od';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it('poisson has the right mean', () => {
    const rng = mulberry32(1);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += poisson(rng, 2.5);
    expect(sum / n).toBeCloseTo(2.5, 1);
  });
});

describe('network', () => {
  it('prefers arterials when they are faster', () => {
    const grid = buildGrid();
    const k = grid.opts.suburbRing; // first arterial row and column, at the core's edge
    const d = shortestCosts(grid.net, grid.nodeAt(k, k));
    // Along that arterial row (17 m/s): 8 blocks
    expect(d[grid.nodeAt(k, k + 8)]).toBeCloseTo((8 * grid.opts.spacing) / 17, 6);
  });
});

describe('demand', () => {
  const sim = new Simulation();
  const n = sim.zones.length;
  const typeShare = (od: Float64Array, from: string, to: string) => {
    let s = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (sim.zones[i].type === from && sim.zones[j].type === to) s += od[i * n + j];
    return s;
  };

  it('OD shares sum to 1 with no intrazonal or park trips', () => {
    const od = gravityOd(sim.zones, sim.cost, 'am', DEFAULT_CONFIG.beta);
    expect(od.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    for (let i = 0; i < n; i++) {
      expect(od[i * n + i]).toBe(0);
      if (sim.zones[i].type === 'park') {
        for (let j = 0; j < n; j++) expect(od[i * n + j] + od[j * n + i]).toBe(0);
      }
    }
  });

  it('AM peak flows home->work, PM reverses', () => {
    const am = gravityOd(sim.zones, sim.cost, 'am', DEFAULT_CONFIG.beta);
    const pm = gravityOd(sim.zones, sim.cost, 'pm', DEFAULT_CONFIG.beta);
    expect(typeShare(am, 'residential', 'commercial')).toBeGreaterThan(typeShare(am, 'commercial', 'residential'));
    expect(typeShare(pm, 'commercial', 'residential')).toBeGreaterThan(typeShare(pm, 'residential', 'commercial'));
  });

  it('closer zones attract more trips (distance decay)', () => {
    const od = gravityOd(sim.zones, sim.cost, 'am', DEFAULT_CONFIG.beta);
    const costs = [...sim.cost].filter((c) => c > 0).sort((a, b) => a - b);
    const median = costs[Math.floor(costs.length / 2)];
    const near: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (i === j || od[i * n + j] === 0) continue;
        (sim.cost[i * n + j] < median ? near : far).push(od[i * n + j]);
      }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(near)).toBeGreaterThan(mean(far));
  });

  it('generates trips at the time-of-day rate', () => {
    const s = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
    const t0 = s.time;
    while (s.time < t0 + HOUR) s.step();
    const expected = DEFAULT_CONFIG.peakTripsPerHour * volumeFactor(8 * HOUR);
    expect(Math.abs(s.totalTrips - expected) / expected).toBeLessThan(0.1);
  }, 60_000);

  it('peak is much busier than night', () => {
    expect(volumeFactor(8 * HOUR)).toBeGreaterThan(5 * volumeFactor(3 * HOUR));
  });
});
