import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim';
import type { Site } from '../src/city/sites';

const sim = new Simulation();
const net = sim.grid.net;

// Every step of a route is a real junction movement (no U-turns, no jumps).
function routeErrors(route: number[]): string[] {
  const errors: string[] = [];
  for (let k = 1; k < route.length; k++) {
    const a = net.links[route[k - 1]];
    const b = net.links[route[k]];
    if (a.to !== b.from) errors.push(`gap ${a.id}->${b.id}`);
    else if (b.to === a.from) errors.push(`U-turn ${a.id}->${b.id}`);
  }
  return errors;
}

const station = (kind: Site['kind']) => sim.sites.find((s) => s.kind === kind)!;

describe('sites', () => {
  it('has addresses across the city and two of each station', () => {
    expect(sim.sites.length).toBeGreaterThan(1000);
    for (const kind of ['hospital', 'fire_station', 'police_station'] as const) {
      expect(sim.sites.filter((s) => s.kind === kind)).toHaveLength(2);
    }
    for (const s of sim.sites) {
      expect(s.address).toMatch(/^\d+ \w+ (St|Ave)$/);
      expect(s.entrance.pos).toBeGreaterThan(0);
      expect(s.entrance.pos).toBeLessThan(sim.traffic.lanes[s.entrance.link].geom.length);
    }
  });

  it('keeps every lot inside its block, with no two lots overlapping', () => {
    const inside = (a: Site['lot'], b: Site['lot']) => a.x0 >= b.x0 - 1e-6 && a.x1 <= b.x1 + 1e-6 && a.y0 >= b.y0 - 1e-6 && a.y1 <= b.y1 + 1e-6;
    const overlap = (a: Site['lot'], b: Site['lot']) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1e-6 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1e-6;
    for (const plan of sim.layout.blocks) {
      const lots = plan.sites.map((id) => sim.sites[id].lot);
      for (const lot of lots) expect(inside(lot, plan.rect)).toBe(true);
      for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) expect(overlap(lots[i], lots[j])).toBe(false);
    }
  });

  it('plans valid routes from every station to a sample of sites', () => {
    const stations = sim.sites.filter((s) => s.kind.endsWith('station') || s.kind === 'hospital');
    for (const from of stations) {
      for (let k = 0; k < sim.sites.length; k += 37) {
        const to = sim.sites[k];
        const plan = sim.planTrip(from, to);
        expect(plan.route.length, `${from.address} -> ${to.address}`).toBeGreaterThan(0);
        expect(plan.route[0]).toBe(from.entrance.link);
        expect(plan.route[plan.route.length - 1]).toBe(to.entrance.link);
        expect(routeErrors(plan.route)).toEqual([]);
        expect(plan.eta).toBeGreaterThanOrEqual(0);
        expect(plan.eta).toBeLessThan(1e4);
      }
    }
  });

  it('goes round the block to reach the far kerb of the same street', () => {
    const from = sim.sites[100];
    const back = net.outLinks[net.links[from.entrance.link].to].find((id) => net.links[id].to === net.links[from.entrance.link].from);
    const opposite = sim.sites.find((s) => s.entrance.link === back);
    if (!opposite) return;
    const plan = sim.planTrip(from, opposite);
    expect(plan.route.length).toBeGreaterThan(2);
    expect(routeErrors(plan.route)).toEqual([]);
  });
});

describe('emergency units', () => {
  it('drive from a station to a call with the siren on and report arrival', () => {
    const s = new Simulation();
    const hospital = s.sites.find((x) => x.kind === 'hospital')!;
    const call = s.sites[s.sites.length >> 1];
    const trip = s.sendUnit('ambulance', hospital, call)!;
    expect(trip).not.toBeNull();
    let arrivedAt = -1;
    let sawSiren = false;
    for (let k = 0; k < 20 * 60 * 10 && arrivedAt < 0; k++) {
      s.step();
      const veh = s.traffic.vehicleOf(trip.id);
      if (veh) sawSiren ||= veh.siren;
      if (s.arrivals.some((t) => t.id === trip.id)) arrivedAt = s.time;
      expect(s.removals.some((t) => t.id === trip.id)).toBe(false);
    }
    expect(sawSiren).toBe(true);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(s.traffic.vehicleOf(trip.id)).toBeUndefined();
  });

  it('can be redirected while driving and arrive at the new site', () => {
    const s = new Simulation();
    const fire = station('fire_station');
    const first = s.sites[50];
    const second = s.sites[s.sites.length - 50];
    const trip = s.sendUnit('fire', s.sites[fire.id], first)!;
    for (let k = 0; k < 300; k++) s.step();
    const veh = s.traffic.vehicleOf(trip.id)!;
    expect(veh).toBeDefined();
    expect(s.sendUnit('fire', veh, second)).toBe(trip);
    expect(routeErrors(veh.route)).toEqual([]);
    let arrived = false;
    for (let k = 0; k < 20 * 60 * 10 && !arrived; k++) {
      s.step();
      arrived = s.arrivals.some((t) => t.id === trip.id);
    }
    expect(arrived).toBe(true);
    expect(veh.route[veh.route.length - 1]).toBe(second.entrance.link);
  });

  it('can turn the siren off on the way back', () => {
    const s = new Simulation();
    const police = s.sites.find((x) => x.kind === 'police_station')!;
    const trip = s.sendUnit('police', police, s.sites[300])!;
    for (let k = 0; k < 100 && !s.traffic.vehicleOf(trip.id); k++) s.step();
    s.traffic.setSiren(trip.id, false);
    expect(s.traffic.vehicleOf(trip.id)!.siren).toBe(false);
  });
});

describe('coverage', () => {
  it('matches the cheapest single-source route', () => {
    const sources = sim.sites.filter((s) => s.kind === 'fire_station').map((s) => net.links[s.entrance.link].to);
    const times = sim.coverageTimes(sources);
    for (let n = 0; n < net.nodes.length; n += 23) {
      if (net.outLinks[n].length === 0) continue;
      const best = Math.min(...sources.map((src) => sim.router.routeWithCost(src, n).cost));
      expect(times[n]).toBeCloseTo(best, 6);
    }
  });
});
