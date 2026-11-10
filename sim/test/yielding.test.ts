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

// A steady stream of cars past a driveway, and a unit waiting to pull out of it. Returns how long
// the unit waited to get onto the street.
function pullOutRun(siren: boolean, left = false) {
  const grid = buildGrid({ ...buildGrid().opts, cols: 6, rows: 1 });
  const model = new TrafficModel(grid.net, { signals: false });
  const route = new Router(grid.net).route(0, 5);
  const back = new Router(grid.net).route(5, 0);
  const car = (id: number): Trip => ({ id, originZone: 0, destZone: 0, originNode: 0, destNode: 5, departTime: 0, kind: 'sedan', departPos: 10 });
  const len = model.lanes[route[1]].geom.length;
  // The unit leaves from the second street, half way along; with `left` it crosses the other lane.
  const unit: Trip = { id: 99, originZone: 0, destZone: 0, originNode: 1, destNode: left ? 0 : 5, departTime: 0, kind: 'ambulance', departPos: len / 2, departLeft: left };
  const unitRoute = left ? back.slice(back.indexOf(grid.net.reverse(route[1])!)) : route.slice(1);
  let queued = -1;
  let out = -1;
  const errors: string[] = [];
  for (let t = 0; t < 300 && out < 0; t += 0.1) {
    const k = Math.round(t * 10);
    if (k % 20 === 0) {
      model.enqueue(car(k), route); // a car every 2 s each way
      model.enqueue({ ...car(100000 + k), originNode: 5, destNode: 0 }, back);
    }
    if (k === 300) {
      model.enqueue(unit, unitRoute, { siren });
      queued = t;
    }
    model.step(t, 0.1);
    if (queued >= 0 && model.vehicleOf(unit.id)) out = t;
    if (k % 5 === 0) errors.push(...model.checkInvariants());
  }
  return { wait: out < 0 ? Infinity : out - queued, errors };
}

describe('pulling out with the siren on', () => {
  it('cars stop to let a unit out of its driveway', () => {
    const on = pullOutRun(true);
    const off = pullOutRun(false);
    expect(on.errors).toEqual([]);
    expect(on.wait).toBeLessThan(off.wait);
  });

  it('and on the far lane when it turns left out', () => {
    const on = pullOutRun(true, true);
    const off = pullOutRun(false, true);
    expect(on.errors).toEqual([]);
    expect(on.wait).toBeLessThan(off.wait);
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
      // While a junction is held, the only cars let in that are not units come from a unit's own
      // approach (the queue ahead of it clearing).
      for (let n = 0; n < net.nodes.length; n++) {
        const now = sim.traffic.boxes[n].holders;
        const from = sim.traffic.preemptedFrom(n);
        if (from) {
          held++;
          const before = holders.get(n) ?? new Set();
          for (const h of now) if (!before.has(h) && !h.siren) expect(from.has(h.conn ? h.conn.inLink : h.route[h.ri])).toBe(true);
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

describe('turning round', () => {
  // A unit drives away from its station without a siren, then is sent back to the station
  // behind it once it is part way along a street. Returns how long that took, and whether it
  // turned round in the street.
  function sendBack(allow: boolean) {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 10 });
    sim.allowTurnRound = allow;
    while (sim.time < 10.1 * HOUR) sim.step();
    const station = sim.sites.find((s) => s.kind === 'fire_station')!;
    const far = sim.sites[(station.id * 7 + 500) % sim.sites.length];
    const trip = sim.sendUnit('fire', station, far, { siren: false })!;
    // Wait until it is on its second street, 40 m or more along it and not at the junction.
    let veh;
    for (let k = 0; k < 6000; k++) {
      sim.step();
      veh = sim.traffic.vehicleOf(trip.id);
      if (veh && veh.ri >= 1 && !veh.conn && !veh.granted && veh.pos > 30 && sim.traffic.lanes[veh.route[veh.ri]].geom.length - veh.pos > 40) break;
    }
    expect(veh, 'unit never part way along its second street').toBeDefined();
    const plan = sim.planUnitTrip(veh!, station);
    const t0 = sim.time;
    expect(sim.sendUnit('fire', veh!, station)).not.toBeNull();
    let done = -1;
    const errors: string[] = [];
    for (let k = 0; k < 20 * 600 && done < 0; k++) {
      sim.step();
      if (sim.arrivals.some((t) => t.id === trip.id)) done = sim.time - t0;
      if (k % 10 === 0) errors.push(...sim.traffic.checkInvariants());
    }
    return { time: done, turned: plan.turnRound === true, errors };
  }

  it('a unit sent back the way it came turns round in the street and gets there sooner', () => {
    const on = sendBack(true);
    const off = sendBack(false);
    expect(on.turned).toBe(true);
    expect(off.turned).toBe(false);
    expect(on.errors).toEqual([]);
    expect(on.time).toBeGreaterThan(0);
    expect(on.time).toBeLessThan(off.time);
  }, 120_000);
});
