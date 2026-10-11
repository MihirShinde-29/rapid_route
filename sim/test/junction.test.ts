import { describe, expect, it } from 'vitest';
import { Network } from '../src/network/network';
import { Router } from '../src/routing/router';
import { TrafficModel } from '../src/traffic/traffic';
import type { Trip } from '../src/demand/trips';

// One four-way junction C. W-C-E is an arterial, N-C-S a local street.
// Both use the same speed so neither approach arrives first by being faster.
function crossing() {
  const net = new Network();
  const C = net.addNode(0, 0);
  const W = net.addNode(-100, 0);
  const E = net.addNode(100, 0);
  const N = net.addNode(0, -100);
  const S = net.addNode(0, 100);
  const street = (a: number, b: number, arterial: boolean) => {
    net.addLink(a, b, 1, 11, arterial);
    net.addLink(b, a, 1, 11, arterial);
  };
  street(W, C, true);
  street(C, E, true);
  street(N, C, false);
  street(C, S, false);
  const model = new TrafficModel(net);
  const router = new Router(net);
  let nextId = 0;
  const send = (from: number, to: number, t: number): number => {
    const trip: Trip = { id: nextId++, originZone: 0, destZone: 0, originNode: from, destNode: to, departTime: t };
    model.enqueue(trip, router.route(from, to));
    return trip.id;
  };
  return { net, model, send, C, W, E, N, S };
}

// Sim time each trip's car first entered the junction.
function run(model: TrafficModel, until: number, schedule: (t: number) => void = () => {}) {
  const entered = new Map<number, number>();
  const maxStopped = new Map<number, number>();
  const errors: string[] = [];
  for (let t = 0; t < until; t += 0.1) {
    schedule(t);
    model.step(t, 0.1);
    for (const v of model.vehicles) {
      if (v.conn && !entered.has(v.trip.id)) entered.set(v.trip.id, t);
      maxStopped.set(v.trip.id, Math.max(maxStopped.get(v.trip.id) ?? 0, v.stoppedFor));
    }
    errors.push(...model.checkInvariants());
  }
  return { entered, maxStopped, errors };
}

describe('junction right-of-way', () => {
  it('arterial goes first when both approaches arrive together', () => {
    const { model, send, W, E, N, S } = crossing();
    const art = send(W, E, 0);
    const local = send(N, S, 0);
    const { entered, errors } = run(model, 40);
    expect(errors).toEqual([]);
    expect(entered.get(art)!).toBeLessThan(entered.get(local)!);
    expect(model.arrived).toBe(2);
  });

  it('a side street is not starved by a steady arterial stream', () => {
    const { model, send, W, E, N, S } = crossing();
    let local = -1;
    const { entered, errors } = run(model, 200, (t) => {
      if (Math.abs(t % 1.5) < 0.05 && t < 150) send(W, E, t); // more than the lane can carry
      if (t === 0) local = send(N, S, t);
    });
    expect(errors).toEqual([]);
    // Reaches the stop line after ~10 s; must get in shortly after the 8 s starvation limit,
    // long before the arterial stream ends at 150 s.
    expect(entered.get(local)!).toBeLessThan(40);
  });

  it("a jammed exit does not block cross traffic (don't block the box)", () => {
    const { model, send, W, E, N, S, C, net } = crossing();
    const exit = net.outLinks[C].find((id) => net.links[id].to === S)!;
    model.setForcedSpeed(exit, 0.5); // incident on C->S: southbound cars crawl and queue back
    const crossIds: number[] = [];
    const { maxStopped, errors } = run(model, 300, (t) => {
      if (Math.abs(t % 2) < 0.05 && t < 80) send(N, S, t);
      if (Math.abs(t % 4) < 0.05 && t < 160) crossIds.push(send(W, E, t));
    });
    expect(errors).toEqual([]);
    const present = new Set([...model.vehicles].map((v) => v.trip.id));
    for (const id of crossIds) {
      expect(present.has(id)).toBe(false); // every eastbound car got through
      expect(maxStopped.get(id) ?? 0).toBeLessThan(15); // and never waited behind the southbound queue
    }
  });
});
