import { describe, expect, it } from 'vitest';
import { Router } from '../src/routing/router';
import { Network } from '../src/network/network';

function testNetwork(): Network {
  const net = new Network();
  net.addNode(0, 0); // 0
  net.addNode(100, 0); // 1
  net.addNode(200, 0); // 2
  net.addNode(100, 100); // 3
  net.addLink(0, 1, 1, 10, false);
  net.addLink(1, 2, 1, 10, false);
  net.addLink(0, 3, 1, 10, false);
  net.addLink(3, 2, 1, 10, false);
  return net;
}

describe('A* router', () => {
  it('returns a connected route and its accumulated cost', () => {
    const net = testNetwork();
    const result = new Router(net).routeWithCost(0, 2);
    expect(result.links).toHaveLength(2);
    expect(result.cost).toBeCloseTo(20, 6);
    expect(net.links[result.links[0]].to).toBe(net.links[result.links[1]].from);
  });

  it('uses the injected live travel-time cost', () => {
    const net = testNetwork();
    const live = new Router(net, (link) => (link.id === 0 || link.id === 1 ? 30 : 10));
    const result = live.routeWithCost(0, 2);
    expect(result.links).toEqual([2, 3]);
    expect(result.cost).toBeCloseTo(20, 6);
  });
});
