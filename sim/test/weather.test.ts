import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import type { Weather } from '../src/traffic/traffic';

// Rain and fog (W12): cars drive below the limit and leave longer gaps, so trips take longer,
// and the network still flows (no gridlock removals) at the morning peak.
function peak(weather: Weather) {
  const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
  sim.weather = weather;
  const starts = new Map<number, number>();
  const times: number[] = [];
  while (sim.time < 8.25 * HOUR) {
    const spawned = sim.step();
    if (sim.time < 8 * HOUR) for (const t of spawned) starts.set(t.id, t.departTime);
    for (const t of sim.arrivals) {
      const s = starts.get(t.id);
      if (s !== undefined) times.push(sim.time - s);
    }
  }
  let speed = 0;
  for (const v of sim.traffic.vehicles) speed += v.v;
  return {
    meanTrip: times.reduce((a, b) => a + b, 0) / times.length,
    meanSpeed: speed / sim.traffic.vehicles.size,
    removed: sim.traffic.removedGridlock,
  };
}

describe('weather (W12)', () => {
  it('rain and fog lengthen trips, fog the most, without gridlock', () => {
    const clear = peak('clear');
    const rain = peak('rain');
    const fog = peak('fog');
    console.log('weather', JSON.stringify({ clear, rain, fog }));
    expect(rain.meanTrip).toBeGreaterThan(clear.meanTrip);
    expect(fog.meanTrip).toBeGreaterThan(rain.meanTrip);
    for (const r of [clear, rain, fog]) expect(r.removed).toBe(0);
  }, 600_000);
});
