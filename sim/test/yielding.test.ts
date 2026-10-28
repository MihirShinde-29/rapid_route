import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { buildGrid } from '../src/network/grid';
import { Router } from '../src/routing/router';
import { TrafficModel } from '../src/traffic/traffic';
import type { Trip } from '../src/demand/trips';

// One straight street of five blocks with a line of cars on it, and a unit setting off behind
// them. Returns the unit's trip time and what happened on the way.
function queueRun(siren: boolean) {
  const grid = buildGrid({ ...buildGrid().opts, cols: 6, rows: 1 });
  const model = new TrafficModel(grid.net, { signals: false });
  const route = new Router(grid.net).route(0, 5);
  const trip = (id: number, kind?: Trip['kind']): Trip => ({ id, originZone: 0, destZone: 0, originNode: 0, destNode: 5, departTime: 0, kind, departPos: 20 });
  const unit = trip(99, 'ambulance');
  let start = -1;
  let end = -1;
  let maxShift = 0;
  const errors: string[] = [];
  for (let t = 0; t < 400 && end < 0; t += 0.1) {
    const k = Math.round(t * 10);
    if (k % 40 === 0 && k < 400) model.enqueue(trip(k, 'truck'), route); // a truck every 4 s
    if (k === 450) model.enqueue(unit, route, { siren });
    model.step(t, 0.1);
    if (start < 0 && model.vehicleOf(unit.id)) start = t;
    for (const v of model.vehicles) maxShift = Math.max(maxShift, v.shift);
    if (k % 5 === 0) errors.push(...model.checkInvariants());
    if (model.arrivals.some((x) => x.id === unit.id)) end = t;
  }
  // Let the rest finish.
  for (let t = 400; t < 800 && model.vehicles.size > 0; t += 0.1) model.step(t, 0.1);
  return { time: end - start, maxShift, errors, left: model.vehicles.size, arrived: model.arrived };
}

describe('yielding to sirens', () => {
  it('a unit passes a line of cars that pull over, and they merge back and finish', () => {
    const run = queueRun(true);
    expect(run.errors).toEqual([]);
    expect(run.maxShift).toBe(1);
    expect(run.time).toBeGreaterThan(0);
    expect(run.left).toBe(0);
    expect(run.arrived).toBe(11);
  });

  it('gets there faster with the siren on than stuck behind the same cars', () => {
    const on = queueRun(true);
    const off = queueRun(false);
    expect(off.maxShift).toBe(0);
    expect(on.time).toBeLessThan(0.8 * off.time);
  });
});

describe('units in city traffic', () => {
  it('junctions hold cross traffic for a unit, cars yield, and the peak stays clear', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.75 });
    while (sim.time < 8 * HOUR) sim.step();
    const stations = sim.sites.filter((s) => s.kind === 'hospital' || s.kind.endsWith('_station'));
    const units = stations.map((st, k) => sim.sendUnit(st.kind === 'hospital' ? 'ambulance' : st.kind === 'fire_station' ? 'fire' : 'police', st, sim.sites[(k * 331 + 97) % sim.sites.length])!);
    const pending = new Set(units.map((u) => u.id));
    const holders = new Map<number, Set<unknown>>();
    sim.traffic.boxes.forEach((box, n) => holders.set(n, new Set(box.holders)));
    let pulledOver = 0;
    let held = 0;
    let steps = 0;
    const net = sim.grid.net;
    while (pending.size > 0 && sim.time < 8.5 * HOUR) {
      sim.step();
      for (const t of sim.arrivals) pending.delete(t.id);
      for (const t of sim.removals) expect(pending.has(t.id)).toBe(false);
      for (const v of sim.traffic.vehicles) if (v.shift >= 0.8) pulledOver++;
      // A car that is not a unit never enters a junction while it is held.
      for (let n = 0; n < net.nodes.length; n++) {
        const now = sim.traffic.boxes[n].holders;
        if (sim.traffic.isPreempted(n)) {
          held++;
          const before = holders.get(n) ?? new Set();
          for (const h of now) if (!before.has(h)) expect(h.siren).toBe(true);
        }
        if (now.size === 0) holders.delete(n);
        else holders.set(n, new Set(now));
      }
      if (++steps % 10 === 0) expect(sim.traffic.checkInvariants()).toEqual([]);
    }
    expect(pending.size).toBe(0);
    expect(pulledOver).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
    expect(sim.traffic.removedGridlock).toBe(0);
  }, 120_000);
});
