import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { mulberry32 } from '../src/core/rng';
import { DispatchCenter } from '../src/dispatch/dispatch';

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

describe('station placement', () => {
  it('moves a station to another building before the shift; dispatch and coverage follow, and it can be undone', () => {
    const sim = new Simulation(DEFAULT_CONFIG);
    const net = sim.grid.net;
    const fire = sim.sites.filter((s) => s.kind === 'fire_station');
    const from = fire[0];
    // Not onto a park, the mall or another station.
    expect(sim.canHostStation(sim.sites.find((s) => s.kind === 'park')!)).toBe(false);
    expect(sim.moveStation(from, fire[1])).toBe(false);
    const to = sim.sites.find((s) => s.kind === 'house' && sim.canHostStation(s) && Math.hypot(s.door.x - from.door.x, s.door.y - from.door.y) > 1000)!;
    const node = (s: typeof from) => net.links[s.entrance.link].to;
    const before = sim.coverageTimes(fire.map(node));
    expect(sim.moveStation(from, to)).toBe(true);
    expect(to.kind).toBe('fire_station');
    expect(from.kind).toBe('house');
    const moved = sim.sites.filter((s) => s.kind === 'fire_station');
    const after = sim.coverageTimes(moved.map(node));
    expect(after[node(to)]).toBe(0);
    expect(before[node(to)]).toBeGreaterThan(0);
    // The dispatch centre built at the start of the shift bases the fire engine there.
    const dispatch = new DispatchCenter(sim, { mode: 'sandbox' });
    const station = dispatch.stations.find((s) => s.site === to)!;
    expect(station.kind).toBe('fire');
    expect(dispatch.units.filter((u) => u.station === station).every((u) => u.location === to)).toBe(true);
    expect(dispatch.stations.some((s) => s.site === from)).toBe(false);
    // Undo puts it back.
    expect(sim.moveStation(to, from)).toBe(true);
    expect(from.kind).toBe('fire_station');
    expect(to.kind).toBe('house');
  });
});
