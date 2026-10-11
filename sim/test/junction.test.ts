import { describe, expect, it } from 'vitest';
import { Network } from '../src/network/network';
import { Router } from '../src/routing/router';
import { TrafficModel } from '../src/traffic/traffic';
import type { Trip } from '../src/demand/trips';
import { SIGNAL_TIMING } from '../src/traffic/signals';

// One four-way junction C. W-C-E is an arterial (unless `arterial` is false), N-C-S a local
// street. Both use the same speed so neither approach arrives first by being faster.
// signals: false keeps plain give-way rules.
function crossing({ signals = false, arterial = true } = {}) {
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
  street(W, C, arterial);
  street(C, E, arterial);
  street(N, C, false);
  street(C, S, false);
  const model = new TrafficModel(net, { signals });
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

describe('traffic signals and stop signs', () => {
  it('cars cross a signal only on green or yellow; right turns may go on red after stopping', () => {
    const { model, send, W, E, N, S } = crossing({ signals: true });
    const sentAt = new Map<number, number>();
    const signals = model.signals!;
    const crossedOn = new Map<string, number>();
    const firstIn = new Map<number, number>();
    const errors: string[] = [];
    const nsIds: number[] = [];
    const ewIds: number[] = [];
    for (let t = 0; t < 400; t += 0.1) {
      if (Math.abs(t % 5) < 0.05 && t < 300) ewIds.push(send(W, E, t));
      if (Math.abs(t % 10) < 0.05 && t < 300) {
        nsIds.push(send(N, S, t));
        sentAt.set(nsIds[nsIds.length - 1], t);
      }
      if (Math.abs(t % 9) < 0.05 && t < 300) send(S, E, t); // right turn
      if (Math.abs(t % 11) < 0.05 && t < 300) send(S, W, t); // left turn
      const before = new Set([...model.vehicles].filter((v) => v.conn).map((v) => v.id));
      model.step(t, 0.1);
      for (const v of model.vehicles) {
        if (!v.conn || before.has(v.id)) continue;
        const light = signals.light(v.conn.inLink, t)!;
        const key = `${light}/${v.conn.kind}`;
        crossedOn.set(key, (crossedOn.get(key) ?? 0) + 1);
        if (!firstIn.has(v.trip.id)) firstIn.set(v.trip.id, t);
      }
      errors.push(...model.checkInvariants());
    }
    expect(errors).toEqual([]);
    expect(crossedOn.get('red/through') ?? 0).toBe(0);
    expect(crossedOn.get('red/left') ?? 0).toBe(0);
    expect(crossedOn.get('green/through')).toBeGreaterThan(0);
    expect(crossedOn.get('red/right')).toBeGreaterThan(0); // right on red is used
    expect(model.arrived).toBeGreaterThan(0.95 * (nsIds.length + ewIds.length));
    // Both axes are served: every car got through, the side street within about one cycle.
    const cycle = SIGNAL_TIMING.arterialGreen + SIGNAL_TIMING.localGreen + 2 * (SIGNAL_TIMING.yellow + SIGNAL_TIMING.allRed);
    for (const id of [...nsIds, ...ewIds]) expect(firstIn.has(id)).toBe(true);
    for (const id of nsIds) if (sentAt.get(id)! < 300) expect(firstIn.get(id)! - sentAt.get(id)!).toBeLessThan(cycle + 15);
  });

  it('at an all-way stop every car halts at the line before crossing', () => {
    const { model, send, W, E, N, S } = crossing({ signals: true, arterial: false });
    const stopped = new Set<number>();
    let crossedWithoutStop = 0;
    const sent: number[] = [];
    for (let t = 0; t < 200; t += 0.1) {
      if (Math.abs(t % 10) < 0.05 && t < 120) sent.push(send(W, E, t));
      if (Math.abs(t % 12) < 0.05 && t < 120) sent.push(send(N, S, t));
      const before = new Set([...model.vehicles].filter((v) => v.conn).map((v) => v.id));
      model.step(t, 0.1);
      for (const v of model.vehicles) {
        if (v.conn) {
          if (!before.has(v.id) && !stopped.has(v.id) && v.ri === 0) crossedWithoutStop++;
          continue;
        }
        if (v.ri === 0 && v.v < 0.5 && model.lanes[v.route[0]].geom.length - v.pos < 4) stopped.add(v.id);
      }
    }
    expect(sent.length).toBeGreaterThan(10);
    expect(model.arrived).toBe(sent.length);
    expect(crossedWithoutStop).toBe(0);
  });
});

describe('T-junction', () => {
  it('only the street that ends at a T has a stop sign; the through street keeps going', () => {
    const net = new Network();
    const C = net.addNode(0, 0);
    const W = net.addNode(-100, 0);
    const E = net.addNode(100, 0);
    const S = net.addNode(0, 100);
    for (const [a, b] of [[W, C], [C, E], [C, S]]) {
      net.addLink(a, b, 1, 11, false);
      net.addLink(b, a, 1, 11, false);
    }
    const model = new TrafficModel(net, { signals: true });
    const router = new Router(net);
    const stem = net.links.find((l) => l.from === S && l.to === C)!.id;
    const bar = net.links.find((l) => l.from === W && l.to === C)!.id;
    expect(model.mustStop(stem)).toBe(true);
    expect(model.mustStop(bar)).toBe(false);
    const trip = (id: number, from: number, to: number): Trip => ({ id, originZone: 0, destZone: 0, originNode: from, destNode: to, departTime: 0 });
    model.enqueue(trip(0, W, E), router.route(W, E));
    model.enqueue(trip(1, S, E), router.route(S, E));
    // Slowest speed within 5 m of the line, per trip, before entering the junction.
    const slowest = new Map<number, number>();
    for (let t = 0; t < 60; t += 0.1) {
      model.step(t, 0.1);
      for (const v of model.vehicles) {
        if (v.conn || v.ri !== 0) continue;
        if (model.lanes[v.route[0]].geom.length - v.pos < 5) slowest.set(v.trip.id, Math.min(slowest.get(v.trip.id) ?? Infinity, v.v));
      }
      expect(model.checkInvariants()).toEqual([]);
    }
    expect(model.arrived).toBe(2);
    expect(slowest.get(0)!).toBeGreaterThan(3); // through traffic does not stop
    expect(slowest.get(1)!).toBeLessThan(0.5); // the stem stops
  });
});
