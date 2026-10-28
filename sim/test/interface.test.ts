import { describe, expect, it } from 'vitest';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { siteAccess, type Site } from '../src/city/sites';
import { HOUR } from '../src/core/time';
import { buildGrid } from '../src/network/grid';
import { TrafficModel } from '../src/traffic/traffic';

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
const access = (site: Site) => siteAccess(net, site.entrance, (id) => sim.traffic.lanes[id].geom.length);
// The route leaves from a lane `from` can pull out onto and ends on one `to` can turn in from.
function endsOk(route: number[], from: Site, to: Site): boolean {
  return access(from).out.some((a) => a.link === route[0]) && access(to).in.some((a) => a.link === route[route.length - 1]);
}

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
        expect(endsOk(plan.route, from, to)).toBe(true);
        expect(routeErrors(plan.route)).toEqual([]);
        expect(plan.eta).toBeGreaterThanOrEqual(0);
        expect(plan.eta).toBeLessThan(1e4);
      }
    }
  });

  it('can leave and reach every site, dead-end streets included', () => {
    const hospital = station('hospital');
    let deadEnds = 0;
    for (const site of sim.sites) {
      const a = access(site);
      expect(a.in.length).toBeGreaterThan(0);
      expect(a.out.length).toBeGreaterThan(0);
      if (a.in.length === 1 && a.out.length === 1 && a.in[0].link !== a.out[0].link) deadEnds++;
      if (site === hospital) continue;
      for (const [from, to] of [[hospital, site], [site, hospital]]) {
        const plan = sim.planTrip(from, to);
        expect(plan.route.length, `${from.address} -> ${to.address}`).toBeGreaterThan(0);
        expect(endsOk(plan.route, from, to)).toBe(true);
        expect(routeErrors(plan.route)).toEqual([]);
      }
    }
    expect(deadEnds).toBeGreaterThan(0); // in on the way in, out on the way out
  });

  it('crosses to the far kerb with a left turn rather than going round the block', () => {
    // Two sites facing each other across a local street: one short left turn in.
    const from = sim.sites.find((s) => {
      const back = net.reverse(s.entrance.link);
      return !net.links[s.entrance.link].arterial && sim.sites.some((o) => o.entrance.link === back && o.entrance.pos < sim.traffic.lanes[back].geom.length - s.entrance.pos - 20);
    })!;
    const back = net.reverse(from.entrance.link)!;
    const opposite = sim.sites.find((o) => o.entrance.link === back && o.entrance.pos < sim.traffic.lanes[back].geom.length - from.entrance.pos - 20)!;
    const plan = sim.planTrip(from, opposite);
    expect(plan.route).toEqual([from.entrance.link]);
    expect(plan.arriveLeft).toBe(true);
    expect(plan.departLeft).toBe(false);
  });
});

describe('generated trips', () => {
  it('run from one site entrance to another, some of them to parks and the mall', () => {
    const s = new Simulation({ ...DEFAULT_CONFIG, startHour: 12 });
    const end = s.time + 0.25 * HOUR;
    let trips = 0;
    let leisure = 0;
    let left = 0;
    while (s.time < end) {
      for (const trip of s.step()) {
        trips++;
        expect(trip.originSite).toBeDefined();
        const from = s.sites[trip.originSite!];
        const to = s.sites[trip.destSite!];
        if (['park', 'mall', 'plaza'].includes(to.kind)) leisure++;
        if (trip.departLeft || trip.arriveLeft) left++;
        const route = s.routeLog.find((d) => d.tripId === trip.id)!.chosen.links;
        expect(endsOk(route, from, to)).toBe(true);
        expect(routeErrors(route)).toEqual([]);
      }
    }
    expect(trips).toBeGreaterThan(200);
    expect(leisure / trips).toBeGreaterThan(0.1);
    expect(left).toBeGreaterThan(0);
    expect(left / trips).toBeLessThan(0.5);
  }, 60_000);

  it('turn left into a driveway only through a gap in the oncoming lane', () => {
    // One straight two-way street: cars heading west, one car heading east turning left in.
    const grid = buildGrid({ ...buildGrid().opts, cols: 3, rows: 1 });
    const g = grid.net;
    const model = new TrafficModel(g);
    const east = [g.outLinks[0][0], g.outLinks[1].find((l) => g.links[l].to === 2)!];
    const west = [g.outLinks[2][0], g.outLinks[1].find((l) => g.links[l].to === 0)!];
    const len = model.lanes[east[1]].geom.length;
    const at = 40; // the driveway, m along the eastbound lane
    const crossAt = len - at; // the same point on the westbound lane
    let id = 0;
    const trip = (route: number[], extra = {}) => ({ id: id++, originZone: 0, destZone: 0, originNode: g.links[route[0]].from, destNode: g.links[route[route.length - 1]].to, departTime: 0, ...extra });
    const turner = trip(east, { arrivePos: at, arriveLeft: true });
    model.enqueue(turner, east);
    let held = false; // slowed beside the driveway with no gap yet
    let turned = false;
    let arrived = false;
    for (let t = 0; t < 300 && !arrived; t += 0.1) {
      if (Math.round(t * 10) % 40 === 0 && t < 120) model.enqueue(trip(west), west); // one every 4 s
      model.step(t, 0.1);
      const veh = model.vehicleOf(turner.id);
      if (veh && veh.ri === 1 && !veh.turnIn && at - veh.pos < 12 && veh.v < 3) held = true;
      if (veh && veh.turnIn && !turned) {
        turned = true;
        for (const o of model.lanes[west[0]].vehicles) {
          if (o.pos - o.len - 2 > crossAt) continue; // past the driveway
          expect((crossAt - o.pos) / Math.max(o.v, 2)).toBeGreaterThan(2.4);
        }
      }
      arrived = model.arrivals.some((x) => x.id === turner.id);
    }
    expect(held).toBe(true);
    expect(turned).toBe(true);
    expect(arrived).toBe(true);
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
