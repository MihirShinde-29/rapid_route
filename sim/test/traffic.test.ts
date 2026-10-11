import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { TrafficModel } from '../src/traffic/traffic';
import { buildGrid } from '../src/network/grid';
import { Router } from '../src/routing/router';

describe('router', () => {
  it('returns a connected link sequence', () => {
    const grid = buildGrid();
    const r = new Router(grid.net);
    const route = r.route(grid.nodeAt(0, 0), grid.nodeAt(5, 8));
    expect(route.length).toBeGreaterThan(0);
    expect(grid.net.links[route[0]].from).toBe(grid.nodeAt(0, 0));
    expect(grid.net.links[route[route.length - 1]].to).toBe(grid.nodeAt(5, 8));
    for (let k = 1; k < route.length; k++) expect(grid.net.links[route[k]].from).toBe(grid.net.links[route[k - 1]].to);
  });
});

describe('traffic', () => {
  it('a lone car accelerates to near the speed limit', () => {
    const grid = buildGrid({ ...buildGrid().opts, cols: 3, rows: 1 });
    const model = new TrafficModel(grid.net);
    const route = new Router(grid.net).route(0, 2);
    model.enqueue({ id: 0, originZone: 0, destZone: 0, originNode: 0, destNode: 2, departTime: 0 }, route);
    let maxV = 0;
    for (let t = 0; t < 30 && model.arrived === 0; t += 0.1) {
      model.step(t, 0.1);
      for (const v of model.vehicles) maxV = Math.max(maxV, v.v);
    }
    expect(model.arrived).toBe(1);
    expect(maxV).toBeGreaterThan(0.8 * grid.net.links[route[0]].speedLimit);
  });

  it('an incident speed cap slows the cars on that link, not just the router', () => {
    const grid = buildGrid({ ...buildGrid().opts, cols: 3, rows: 1 });
    const model = new TrafficModel(grid.net);
    const route = new Router(grid.net).route(0, 2);
    model.setForcedSpeed(route[0], 3);
    model.enqueue({ id: 0, originZone: 0, destZone: 0, originNode: 0, destNode: 2, departTime: 0 }, route);
    let maxOnCapped = 0;
    let maxAfter = 0;
    for (let t = 0; t < 120 && model.arrived === 0; t += 0.1) {
      model.step(t, 0.1);
      for (const v of model.vehicles) {
        if (v.conn) continue;
        if (v.route[v.ri] === route[0]) maxOnCapped = Math.max(maxOnCapped, v.v);
        else maxAfter = Math.max(maxAfter, v.v);
      }
    }
    expect(model.arrived).toBe(1);
    expect(maxOnCapped).toBeLessThanOrEqual(3.01);
    expect(maxAfter).toBeGreaterThan(6); // speeds back up once past the incident
  });

  it('morning peak: no overlaps, junction rules hold, cars arrive', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 6.5 });
    const end = sim.time + 2 * HOUR;
    let peakVehicles = 0;
    let steps = 0;
    while (sim.time < end) {
      sim.step();
      peakVehicles = Math.max(peakVehicles, sim.traffic.vehicles.size);
      if (++steps % 10 === 0) expect(sim.traffic.checkInvariants()).toEqual([]);
    }
    const t = sim.traffic;
    console.log(
      `peak vehicles ${peakVehicles}, arrived ${t.arrived}, mean trip ${t.meanTravelTime.toFixed(0)} s, ` +
        `backlog ${t.waitingToDepart}, gridlock removals ${t.removedGridlock}`,
    );
    expect(peakVehicles).toBeGreaterThan(300); // MVP: a few hundred cars
    expect(t.arrived).toBeGreaterThan(0.8 * sim.totalTrips);
    expect(t.removedGridlock).toBeLessThan(0.01 * sim.totalTrips);
    // Mixed vehicle lengths must not leave lanes "reserved" forever and block departures.
    expect(t.waitingToDepart).toBeLessThan(0.01 * sim.totalTrips);
  }, 60_000);

  it('a probe trip uses the picked start and end, and the jam follows that pair', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7 });
    const from = sim.grid.nodeAt(3, 4);
    const to = sim.grid.nodeAt(15, 20);
    const d = sim.spawnProbeTrip(from, to);
    const links = sim.grid.net.links;
    expect(links[d.chosen.links[0]].from).toBe(from);
    expect(links[d.chosen.links[d.chosen.links.length - 1]].to).toBe(to);
    sim.toggleProbeJam();
    for (const id of d.shorter.links) expect(sim.traffic.isForcedJammed(id)).toBe(true);
  });
});
