import { shortestCosts, type Network, type LinkCost, freeFlowTime } from '../network/network';
import type { Period } from '../core/time';
import { attraction, production, type Zone } from './zones';

// Zone-to-zone cost (s): mean over access-node pairs, so neighbouring zones
// that share a corner still get a non-zero cost.
export function zoneCostMatrix(net: Network, zones: Zone[], cost: LinkCost = freeFlowTime): Float64Array {
  const n = zones.length;
  const fromNode = new Map<number, Float64Array>();
  for (const z of zones) {
    for (const a of z.accessNodes) {
      if (!fromNode.has(a)) fromNode.set(a, shortestCosts(net, a, cost));
    }
  }
  const m = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let sum = 0;
      for (const a of zones[i].accessNodes) {
        const d = fromNode.get(a)!;
        for (const b of zones[j].accessNodes) sum += d[b];
      }
      m[i * n + j] = sum / (zones[i].accessNodes.length * zones[j].accessNodes.length);
    }
  }
  return m;
}

// Production-constrained gravity model:
//   T_ij = P_i * A_j * exp(-beta c_ij) / sum_k A_k exp(-beta c_ik)
// Returned as shares of total trips (sums to 1). Intrazonal trips excluded.
export function gravityOd(zones: Zone[], cost: Float64Array, period: Period, beta: number): Float64Array {
  const n = zones.length;
  const od = new Float64Array(n * n);
  const attr = zones.map((z) => attraction(z, period));
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = production(zones[i], period);
    if (p <= 0) continue;
    let denom = 0;
    for (let j = 0; j < n; j++) if (j !== i) denom += attr[j] * Math.exp(-beta * cost[i * n + j]);
    if (denom <= 0) continue;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const t = (p * attr[j] * Math.exp(-beta * cost[i * n + j])) / denom;
      od[i * n + j] = t;
      total += t;
    }
  }
  if (total > 0) for (let k = 0; k < od.length; k++) od[k] /= total;
  return od;
}
