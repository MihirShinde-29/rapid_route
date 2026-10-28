import { MinHeap } from '../core/heap';

export interface Node {
  id: number;
  x: number;
  y: number;
}

// Directed link. Two-way streets are two links.
export interface Link {
  id: number;
  from: number;
  to: number;
  length: number; // m
  lanes: number;
  speedLimit: number; // m/s
  arterial: boolean;
}

export class Network {
  readonly nodes: Node[] = [];
  readonly links: Link[] = [];
  readonly outLinks: number[][] = [];
  readonly inLinks: number[][] = [];
  private reverses: (number | undefined)[] | null = null;

  addNode(x: number, y: number): number {
    const id = this.nodes.length;
    this.nodes.push({ id, x, y });
    this.outLinks.push([]);
    this.inLinks.push([]);
    return id;
  }

  addLink(from: number, to: number, lanes: number, speedLimit: number, arterial: boolean): number {
    const a = this.nodes[from];
    const b = this.nodes[to];
    const id = this.links.length;
    this.links.push({ id, from, to, length: Math.hypot(b.x - a.x, b.y - a.y), lanes, speedLimit, arterial });
    this.outLinks[from].push(id);
    this.inLinks[to].push(id);
    this.reverses = null;
    return id;
  }

  // The other direction of a two-way street; undefined on a one-way link.
  reverse(id: number): number | undefined {
    if (!this.reverses) {
      this.reverses = this.links.map((l) => this.outLinks[l.to].find((o) => this.links[o].to === l.from));
    }
    return this.reverses[id];
  }
}

export type LinkCost = (link: Link) => number;

export const freeFlowTime: LinkCost = (link) => link.length / link.speedLimit;

// Single-source shortest costs to every node (Infinity if unreachable).
export function shortestCosts(net: Network, source: number, cost: LinkCost = freeFlowTime): Float64Array {
  const dist = new Float64Array(net.nodes.length).fill(Infinity);
  dist[source] = 0;
  const heap = new MinHeap<number>();
  heap.push(source, 0);
  while (heap.size > 0) {
    const u = heap.pop()!;
    for (const lid of net.outLinks[u]) {
      const link = net.links[lid];
      const d = dist[u] + cost(link);
      if (d < dist[link.to]) {
        dist[link.to] = d;
        heap.push(link.to, d);
      }
    }
  }
  return dist;
}
