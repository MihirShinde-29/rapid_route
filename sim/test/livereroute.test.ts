import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';

// Cars already on the road look again at their route as streets slow down (W12). Here the busiest
// arterial is jammed to walking pace at the morning peak (as a broken signal or roadworks would);
// with live rerouting on, cars already heading down it should find other ways.
function jammedPeak(live: boolean) {
  const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
  sim.rerouteLive = live;
  sim.rerouteQueues = false; // the accident-queue rule is tested on its own
  while (sim.time < 7.75 * HOUR) sim.step();
  // The busiest arterial link, both ways.
  let best = -1;
  for (const lane of sim.traffic.lanes) {
    if (lane.link.arterial && (best < 0 || lane.vehicles.length > sim.traffic.lanes[best].vehicles.length)) best = lane.link.id;
  }
  const back = sim.grid.net.reverse(best);
  const jammed = [best, ...(back === undefined ? [] : [back])];
  for (const id of jammed) sim.traffic.setForcedSpeed(id, 1.5);
  // Cars already on the road heading down the jammed street (not yet on it).
  const caught = new Map<number, number>();
  for (const veh of sim.traffic.vehicles) {
    if (veh.route.slice(veh.ri + 1).some((id) => jammed.includes(id)) && veh.trip.kind !== 'bus') caught.set(veh.trip.id, sim.time);
  }
  const caughtTimes: number[] = [];
  // Mean time of trips that set off in the next half hour and finished within the hour.
  const starts = new Map<number, number>();
  const times: number[] = [];
  const end = sim.time + HOUR;
  const departBy = sim.time + 0.5 * HOUR;
  let maxStepMs = 0;
  let steps = 0;
  let stepMs = 0;
  while (sim.time < end) {
    const t0 = performance.now();
    const spawned = sim.step();
    const ms = performance.now() - t0;
    stepMs += ms;
    steps++;
    maxStepMs = Math.max(maxStepMs, ms);
    if (sim.time < departBy) for (const trip of spawned) starts.set(trip.id, trip.departTime);
    for (const trip of sim.arrivals) {
      const c = caught.get(trip.id);
      if (c !== undefined) caughtTimes.push(sim.time - c);
      const t = starts.get(trip.id);
      if (t !== undefined) times.push(sim.time - t);
    }
  }
  const links = sim.grid.net.links;
  let broken = 0;
  for (const veh of sim.traffic.vehicles) {
    for (let i = 0; i + 1 < veh.route.length; i++) {
      const a = links[veh.route[i]];
      const b = links[veh.route[i + 1]];
      if (a.to !== b.from || b.to === a.from) broken++;
    }
  }
  return {
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    caught: caught.size,
    caughtMean: caughtTimes.reduce((a, b) => a + b, 0) / Math.max(1, caughtTimes.length),
    finished: times.length,
    rerouted: sim.liveReroutes,
    removed: sim.traffic.removedGridlock,
    broken,
    meanStepMs: stepMs / steps,
  };
}

describe('live rerouting (W12)', () => {
  it('cars on the road switch away from a street that slows down, and trips get no slower', () => {
    const on = jammedPeak(true);
    const off = jammedPeak(false);
    console.log('live reroute on', JSON.stringify(on), 'off', JSON.stringify(off));
    expect(on.rerouted).toBeGreaterThan(0);
    expect(off.rerouted).toBe(0);
    expect(on.broken).toBe(0);
    expect(on.removed).toBe(0);
    expect(on.caughtMean).toBeLessThan(off.caughtMean); // the cars it is for get there sooner
    expect(on.mean).toBeLessThanOrEqual(off.mean * 1.02); // and the rest are no worse off
  }, 600_000);
});
