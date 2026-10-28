import { MinHeap } from '../core/heap';
import { freeFlowTime, type LinkCost, type Network } from '../network/network';

export interface RouteResult {
  links: number[];
  cost: number;
}

// A link a route may start or end on, with the cost of the part of it that counts.
export interface LinkEnd {
  link: number;
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

  // `skip`: links the route may not use (rerouting uses it to rule out U-turns).
  routeWithCost(from: number, to: number, skip: readonly number[] = []): RouteResult {
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
        if (skip.includes(lid)) continue;
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

  // Cheapest route that starts on one of `from` and ends on one of `to`, searched link by link so
  // it never makes a U-turn (it goes round the block instead). A start's `cost` is what is left
  // of that link to drive; an end's `cost` is the part of it driven before arriving. A start that
  // is also an end is only reached again by a loop; the caller handles staying on that link.
  routeLinks(from: readonly LinkEnd[], to: readonly LinkEnd[]): RouteResult {
    const net = this.net;
    const n = net.links.length;
    const g = new Float64Array(n).fill(Infinity);
    const pred = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const ends = new Map<number, number>();
    for (const e of to) ends.set(e.link, Math.min(ends.get(e.link) ?? Infinity, e.cost));
    const goals = [...new Set(to.map((e) => net.links[e.link].from))];
    const h = (node: number) => goals.reduce((m, goal) => Math.min(m, this.heuristic(node, goal)), Infinity);
    const heap = new MinHeap<number>();
    for (const s of from) {
      if (s.cost >= g[s.link]) continue;
      g[s.link] = s.cost;
      heap.push(s.link, s.cost + h(net.links[s.link].to));
    }
    let best = Infinity;
    let bestLast = -1;
    let bestEnd = -1;
    while (heap.size > 0 && heap.minKey < best) {
      const u = heap.pop()!;
      if (closed[u]) continue;
      closed[u] = 1;
      const back = net.reverse(u);
      for (const v of net.outLinks[net.links[u].to]) {
        if (v === back) continue;
        const end = ends.get(v);
        if (end !== undefined && g[u] + end < best) {
          best = g[u] + end;
          bestLast = u;
          bestEnd = v;
        }
        const next = g[u] + this.cost(net.links[v]);
        if (next >= g[v]) continue;
        g[v] = next;
        pred[v] = u;
        heap.push(v, next + h(net.links[v].to));
      }
    }
    if (bestEnd < 0) return { links: [], cost: Infinity };
    const links = [bestEnd];
    for (let l = bestLast; l >= 0; l = pred[l]) links.push(l);
    return { links: links.reverse(), cost: best };
  }

  // Cost from the nearest of `sources` to every node (multi-source Dijkstra; Infinity if unreachable).
  costsFrom(sources: readonly number[]): Float64Array {
    const g = new Float64Array(this.net.nodes.length).fill(Infinity);
    const heap = new MinHeap<number>();
    for (const s of sources) {
      g[s] = 0;
      heap.push(s, 0);
    }
    const closed = new Uint8Array(this.net.nodes.length);
    while (heap.size > 0) {
      const u = heap.pop()!;
      if (closed[u]) continue;
      closed[u] = 1;
      for (const lid of this.net.outLinks[u]) {
        const link = this.net.links[lid];
        const next = g[u] + this.cost(link);
        if (next >= g[link.to]) continue;
        g[link.to] = next;
        heap.push(link.to, next);
      }
    }
    return g;
  }

  pathCost(links: number[]): number {
    return links.reduce((sum, id) => sum + this.cost(this.net.links[id]), 0);
  }

  pathDistance(links: number[]): number {
    return links.reduce((sum, id) => sum + this.net.links[id].length, 0);
  }

  private heuristic(from: number, to: number): number {
    const a = this.net.nodes[from];
    const b = this.net.nodes[to];
    return Math.hypot(a.x - b.x, a.y - b.y) / this.maxSpeed;
  }
}
