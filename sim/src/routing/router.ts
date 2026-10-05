import { MinHeap } from '../core/heap';
import { freeFlowTime, type LinkCost, type Network } from '../network/network';

// Placeholder router: free-flow shortest paths, one Dijkstra tree per origin, cached.
// To be replaced by A* on live travel times (see docs/MVP_WORK_SPLIT.md).
export class Router {
  private trees = new Map<number, Int32Array>(); // origin -> predecessor link per node

  constructor(
    private net: Network,
    private cost: LinkCost = freeFlowTime,
  ) {}

  // Link ids from `from` to `to`; empty if unreachable or from === to.
  route(from: number, to: number): number[] {
    const pred = this.tree(from);
    const links: number[] = [];
    let node = to;
    while (node !== from) {
      const lid = pred[node];
      if (lid < 0) return [];
      links.push(lid);
      node = this.net.links[lid].from;
    }
    return links.reverse();
  }

  private tree(source: number): Int32Array {
    let pred = this.trees.get(source);
    if (pred) return pred;
    const n = this.net.nodes.length;
    const dist = new Float64Array(n).fill(Infinity);
    pred = new Int32Array(n).fill(-1);
    dist[source] = 0;
    const heap = new MinHeap<number>();
    heap.push(source, 0);
    while (heap.size > 0) {
      const u = heap.pop()!;
      for (const lid of this.net.outLinks[u]) {
        const link = this.net.links[lid];
        const d = dist[u] + this.cost(link);
        if (d < dist[link.to]) {
          dist[link.to] = d;
          pred[link.to] = lid;
          heap.push(link.to, d);
        }
      }
    }
    this.trees.set(source, pred);
    return pred;
  }
}
