import { MinHeap } from '../core/heap';
import { freeFlowTime, type LinkCost, type Network } from '../network/network';

export interface RouteResult {
  links: number[];
  cost: number;
}

// A* route assignment. The cost function is deliberately injected so the
// simulator can route on live travel time while tests can supply deterministic
// link costs. The returned route is a list of directed link ids.
export class Router {
  private readonly maxSpeed: number;

  constructor(
    private net: Network,
    private cost: LinkCost = freeFlowTime,
  ) {
    this.maxSpeed = Math.max(...net.links.map((link) => link.speedLimit));
  }

  // Link ids from `from` to `to`; empty if unreachable or from === to.
  route(from: number, to: number): number[] {
    return this.routeWithCost(from, to).links;
  }

  routeWithCost(from: number, to: number): RouteResult {
    if (from === to) return { links: [], cost: 0 };
    const g = new Float64Array(this.net.nodes.length).fill(Infinity);
    const pred = new Int32Array(this.net.nodes.length).fill(-1);
    const closed = new Uint8Array(this.net.nodes.length);
    g[from] = 0;
    const heap = new MinHeap<number>();
    heap.push(from, this.heuristic(from, to));

    while (heap.size > 0) {
      const u = heap.pop()!;
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === to) break;
      for (const lid of this.net.outLinks[u]) {
        const link = this.net.links[lid];
        const next = g[u] + this.cost(link);
        if (next >= g[link.to]) continue;
        g[link.to] = next;
        pred[link.to] = lid;
        heap.push(link.to, next + this.heuristic(link.to, to));
      }
    }

    const links: number[] = [];
    let node = to;
    while (node !== from) {
      const lid = pred[node];
      if (lid < 0) return { links: [], cost: Infinity };
      links.push(lid);
      node = this.net.links[lid].from;
    }
    return { links: links.reverse(), cost: g[to] };
  }

  private heuristic(from: number, to: number): number {
    const a = this.net.nodes[from];
    const b = this.net.nodes[to];
    return Math.hypot(a.x - b.x, a.y - b.y) / this.maxSpeed;
  }
}
