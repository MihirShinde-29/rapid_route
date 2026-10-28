import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/time';
import { Simulation, DEFAULT_CONFIG } from '../src/sim';
import { DISTRICTS, DOWNTOWN, districtShares } from '../src/demand/districts';

const K = DISTRICTS.length;

// Into downtown from elsewhere, and out of downtown to elsewhere.
function downtownFlows(m: ArrayLike<number>): { inbound: number; outbound: number } {
  let inbound = 0;
  let outbound = 0;
  for (let o = 0; o < K; o++) {
    if (o === DOWNTOWN) continue;
    inbound += m[o * K + DOWNTOWN];
    outbound += m[DOWNTOWN * K + o];
  }
  return { inbound, outbound };
}

// The busiest link with cars on it right now, among arterials (they have detours).
function busyArterial(sim: Simulation): number {
  let best = -1;
  for (const lane of sim.traffic.lanes) {
    if (!lane.link.arterial) continue;
    if (best < 0 || lane.vehicles.length > sim.traffic.lanes[best].vehicles.length) best = lane.link.id;
  }
  return best;
}

function routesAreValid(sim: Simulation): string[] {
  const links = sim.grid.net.links;
  const errors: string[] = [];
  for (const veh of sim.traffic.vehicles) {
    for (let i = 0; i + 1 < veh.route.length; i++) {
      const a = links[veh.route[i]];
      const b = links[veh.route[i + 1]];
      if (a.to !== b.from) errors.push(`vehicle ${veh.id}: route breaks after link ${a.id}`);
      if (b.to === a.from) errors.push(`vehicle ${veh.id}: U-turn at node ${a.to}`);
    }
  }
  return errors;
}

describe('district OD matrix', () => {
  it('district shares sum to 1; downtown gets more trips in the AM and sends more in the PM', () => {
    const sim = new Simulation(DEFAULT_CONFIG);
    const am = districtShares(sim.district, sim.trips.odShares('am'));
    const pm = districtShares(sim.district, sim.trips.odShares('pm'));
    expect(am.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(downtownFlows(am).inbound).toBeGreaterThan(downtownFlows(am).outbound);
    expect(downtownFlows(pm).outbound).toBeGreaterThan(downtownFlows(pm).inbound);
  });

  it('observed district counts match the trips generated in the last hour', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
    const end = sim.time + 0.25 * HOUR;
    while (sim.time < end) sim.step();
    const observed = sim.observedDistrictOd();
    expect(observed.reduce((a, b) => a + b, 0)).toBe(sim.observedTripsPerHour());
    expect(downtownFlows(observed).inbound).toBeGreaterThan(downtownFlows(observed).outbound);
  }, 60_000);
});

describe('incidents', () => {
  it('a road closure reroutes traffic and no through traffic enters the closed street', () => {
    const sim = new Simulation({ ...DEFAULT_CONFIG, startHour: 7.5 });
    while (sim.time < 7.75 * HOUR) sim.step();
    const inc = sim.addIncident('closure', busyArterial(sim));
    expect(inc.rerouted).toBeGreaterThan(0);
    expect(routesAreValid(sim)).toEqual([]);
    const closed = new Set(inc.links);
    const end = sim.time + 0.25 * HOUR;
    let steps = 0;
    while (sim.time < end) {
      sim.step();
      if (++steps % 10 !== 0) continue;
      expect(sim.traffic.checkInvariants()).toEqual([]);
      for (const id of inc.links) {
        for (const veh of sim.traffic.lanes[id].vehicles) {
          // Committed to the junction when it closed, or the trip starts or ends on this street.
          const local = closed.has(veh.route[0]) || closed.has(veh.route[veh.route.length - 1]);
          if (!local) expect(veh.enteredLane).toBeLessThan(inc.placedAt + 30);
        }
      }
    }
    expect(routesAreValid(sim)).toEqual([]);
    expect(sim.traffic.removedGridlock).toBe(0);
    sim.removeIncident(inc.id);
    for (const id of inc.links) expect(sim.traffic.isClosed(id)).toBe(false);
  }, 60_000);
});
