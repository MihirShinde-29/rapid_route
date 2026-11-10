import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { BUS_DWELL_S } from '../src/traffic/traffic';

describe('buses', () => {
  it('run three lines along arterials with stops away from the junctions', () => {
    const sim = new Simulation(DEFAULT_CONFIG);
    expect(sim.busLines.length).toBe(3);
    const links = sim.grid.net.links;
    for (const line of sim.busLines) {
      for (const d of [0, 1]) {
        expect(line.routes[d].every((id) => links[id].arterial)).toBe(true);
        expect(line.stops[d].length).toBeGreaterThan(3);
        for (const s of line.stops[d]) {
          const len = sim.traffic.lanes[s.link].geom.length;
          expect(s.pos).toBeGreaterThanOrEqual(30);
          expect(len - s.pos).toBeGreaterThanOrEqual(30);
        }
      }
    }
  });

  it('stop at their stops for the dwell time while the cars behind queue, at the morning peak, with no gridlock', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
    const stopsServed = new Map<number, Set<number>>(); // bus trip -> stops it waited at
    const dwellStart = new Map<number, number>();
    let longest = 0;
    let queuedBehind = 0;
    let steps = 0;
    while (sim.time < 8.25 * HOUR) {
      sim.step();
      for (const v of sim.traffic.vehicles) {
        if (v.trip.kind !== 'bus') continue;
        if (v.dwellUntil >= 0) {
          if (!dwellStart.has(v.trip.id)) dwellStart.set(v.trip.id, sim.time);
          if (!stopsServed.has(v.trip.id)) stopsServed.set(v.trip.id, new Set());
          stopsServed.get(v.trip.id)!.add(v.stopAt);
          // A car stopped right behind a waiting bus.
          const lane = sim.traffic.lanes[v.route[v.ri]].vehicles;
          const behind = lane[lane.indexOf(v) + 1];
          if (behind && behind.v < 0.5 && v.pos - v.len - behind.pos < 6) queuedBehind++;
        } else if (dwellStart.has(v.trip.id)) {
          longest = Math.max(longest, sim.time - dwellStart.get(v.trip.id)!);
          dwellStart.delete(v.trip.id);
        }
      }
      if (++steps % 20 === 0) expect(sim.traffic.checkInvariants()).toEqual([]);
    }
    const buses = [...stopsServed.values()];
    expect(buses.length).toBeGreaterThan(5);
    expect(Math.max(...buses.map((b) => b.size))).toBeGreaterThan(3);
    expect(longest).toBeGreaterThanOrEqual(BUS_DWELL_S - 0.2);
    expect(queuedBehind).toBeGreaterThan(0);
    expect(sim.traffic.removedGridlock).toBe(0);
  }, 300_000);
});
