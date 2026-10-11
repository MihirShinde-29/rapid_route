import { Network } from './network';
import { mulberry32 } from '../core/rng';

export interface GridOptions {
  cols: number; // intersections per row
  rows: number;
  spacing: number; // m between intersections (mean; see irregular)
  arterialEvery: number; // every Nth row/column is an arterial
  suburbRing: number; // blocks of low-density suburb around the city core
  localSpeed: number; // m/s
  arterialSpeed: number; // m/s
  // Uneven block sizes, crooked suburban streets, cul-de-sacs, T-junctions and a few
  // superblocks. Arterials stay straight and continuous. Needs a core with a suburb ring.
  irregular?: boolean;
}

export const DEFAULT_GRID: GridOptions = {
  cols: 27, // 16x12-block core plus 5 blocks of suburb on each side
  rows: 23,
  spacing: 100,
  arterialEvery: 4,
  suburbRing: 5,
  localSpeed: 11, // ~40 km/h
  arterialSpeed: 17, // ~60 km/h
  irregular: true,
};

// A block is the cell between four intersections; zones live on blocks.
export interface Block {
  r: number;
  c: number;
  corners: [number, number, number, number]; // TL, TR, BR, BL node ids
}

// Several blocks joined into one site by leaving out the streets between them.
export interface Superblock {
  kind: 'park' | 'mall';
  blocks: number[]; // block indices
}

export interface Grid {
  net: Network;
  opts: GridOptions;
  nodeAt(r: number, c: number): number;
  blocks: Block[];
  superblocks: Superblock[];
  width: number;
  height: number;
}

export function buildGrid(opts: GridOptions = DEFAULT_GRID): Grid {
  const { cols, rows, spacing, arterialEvery, suburbRing: ring } = opts;
  const irregular = (opts.irregular ?? false) && cols > 2 * ring + 4 && rows > 2 * ring + 4;
  const rng = mulberry32(0x5eed);
  // Arterials are counted from the core's edge so the core keeps its layout.
  const isArterial = (k: number) => (((k - ring) % arterialEvery) + arterialEvery) % arterialEvery === 0;
  const coreLine = (k: number, n: number) => k >= ring && k <= n - 1 - ring;
  const nodeAt = (r: number, c: number) => r * cols + c;
  const suburban = (n: number) => !(coreLine(Math.floor(n / cols), rows) && coreLine(n % cols, cols));

  // Street positions. Irregular: downtown blocks of 92-108 m, suburban ones of 85-130 m.
  const positions = (n: number) => {
    const out = [0];
    for (let k = 0; k < n - 1; k++) {
      const core = k >= ring && k < n - 1 - ring;
      const f = !irregular ? 1 : core ? 0.92 + 0.16 * rng() : 0.85 + 0.45 * rng();
      out.push(out[k] + Math.round(spacing * f));
    }
    return out;
  };
  const xs = positions(cols);
  const ys = positions(rows);

  const net = new Network();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Suburban junctions of two local streets sit a little off the grid.
      const crooked = irregular && !isArterial(r) && !isArterial(c) && suburban(nodeAt(r, c));
      const j = () => (crooked ? Math.round((rng() - 0.5) * 14) : 0);
      net.addNode(xs[c] + j(), ys[r] + j());
    }
  }

  // Street segments between neighbouring nodes.
  type Seg = { a: number; b: number; arterial: boolean };
  const segs = new Map<string, Seg>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c < cols - 1) segs.set(key(nodeAt(r, c), nodeAt(r, c + 1)), { a: nodeAt(r, c), b: nodeAt(r, c + 1), arterial: isArterial(r) });
      if (r < rows - 1) segs.set(key(nodeAt(r, c), nodeAt(r + 1, c)), { a: nodeAt(r, c), b: nodeAt(r + 1, c), arterial: isArterial(c) });
    }
  }

  const blockAt = (r: number, c: number) => r * (cols - 1) + c;
  const superblocks: Superblock[] = [];
  if (irregular) {
    const keep = new Set<number>(); // superblock nodes: no random removals around them
    // h x w blocks starting at block (r, c); the streets inside them are dropped.
    const join = (kind: Superblock['kind'], r: number, c: number, h: number, w: number) => {
      const blocks: number[] = [];
      for (let i = 0; i < h; i++) for (let k = 0; k < w; k++) blocks.push(blockAt(r + i, c + k));
      for (let i = 0; i <= h; i++) for (let k = 0; k <= w; k++) keep.add(nodeAt(r + i, c + k));
      for (let i = 1; i < h; i++) for (let k = 0; k < w; k++) segs.delete(key(nodeAt(r + i, c + k), nodeAt(r + i, c + k + 1)));
      for (let i = 0; i < h; i++) for (let k = 1; k < w; k++) segs.delete(key(nodeAt(r + i, c + k), nodeAt(r + i + 1, c + k)));
      superblocks.push({ kind, blocks });
    };
    // Positions are chosen so the dropped streets are local ones, never arterials.
    join('park', ring + 1, ring + 5, 2, 2); // a central park in the core
    join('mall', 1, cols - 1 - ring - 8, 2, 2); // a shopping centre in the northern suburbs
    join('park', rows - 1 - ring + 1, 3, 1, 2);
    join('park', ring + 5, cols - 1 - ring + 1, 2, 1);

    const degree = new Int32Array(net.nodes.length);
    for (const sg of segs.values()) {
      degree[sg.a]++;
      degree[sg.b]++;
    }
    // Every junction that still has a street must stay reachable.
    const connected = () => {
      const adj: number[][] = net.nodes.map(() => []);
      for (const sg of segs.values()) {
        adj[sg.a].push(sg.b);
        adj[sg.b].push(sg.a);
      }
      const seen = new Uint8Array(net.nodes.length);
      const stack = [nodeAt(0, 0)];
      seen[stack[0]] = 1;
      while (stack.length > 0) {
        for (const n of adj[stack.pop()!]) {
          if (seen[n]) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      return degree.every((d, n) => d === 0 || seen[n] === 1);
    };
    const remove = (k: string): boolean => {
      const sg = segs.get(k)!;
      segs.delete(k);
      degree[sg.a]--;
      degree[sg.b]--;
      if (connected()) return true;
      segs.set(k, sg);
      degree[sg.a]++;
      degree[sg.b]++;
      return false;
    };
    // Cul-de-sacs: a few suburban junctions keep only one of their four streets.
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const n = nodeAt(r, c);
        if (isArterial(r) || isArterial(c) || !suburban(n) || keep.has(n) || degree[n] !== 4 || rng() > 0.12) continue;
        const around = [nodeAt(r - 1, c), nodeAt(r + 1, c), nodeAt(r, c - 1), nodeAt(r, c + 1)];
        const stay = Math.floor(rng() * 4);
        around.forEach((m, i) => {
          if (i !== stay && degree[m] >= 3 && !keep.has(m)) remove(key(n, m));
        });
      }
    }
    // T-junctions: drop some other suburban local street segments.
    for (const [k, sg] of [...segs]) {
      if (sg.arterial || !suburban(sg.a) || !suburban(sg.b) || keep.has(sg.a) || keep.has(sg.b)) continue;
      if (rng() > 0.09 || Math.min(degree[sg.a], degree[sg.b]) < 3) continue;
      remove(k);
    }
  }

  for (const sg of segs.values()) {
    const lanes = sg.arterial ? 2 : 1;
    const speed = sg.arterial ? opts.arterialSpeed : opts.localSpeed;
    net.addLink(sg.a, sg.b, lanes, speed, sg.arterial);
    net.addLink(sg.b, sg.a, lanes, speed, sg.arterial);
  }

  const blocks: Block[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      blocks.push({
        r,
        c,
        corners: [nodeAt(r, c), nodeAt(r, c + 1), nodeAt(r + 1, c + 1), nodeAt(r + 1, c)],
      });
    }
  }

  return { net, opts, nodeAt, blocks, superblocks, width: xs[cols - 1], height: ys[rows - 1] };
}

// True if a street runs directly between two nodes.
export function hasStreet(net: Network, a: number, b: number): boolean {
  return net.outLinks[a].some((id) => net.links[id].to === b);
}

// Nearest node that has streets (superblock centres have none).
export function nearestJunction(net: Network, x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  for (const n of net.nodes) {
    if (net.outLinks[n.id].length === 0) continue;
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bestD) [best, bestD] = [n.id, d];
  }
  return best;
}
