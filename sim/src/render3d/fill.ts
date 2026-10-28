import type { Rng } from '../core/rng';
import type { BlockStyle } from '../city/sites';

// Block fill: small structures in a block's leftover space (sheds, kiosks, tanks, fences...).
// They are scenery, not addresses. An occupancy grid of 1 m cells over the block keeps them off
// the buildings, lots and driveways already there and off each other. Pure geometry (no
// three.js), in whatever units the caller uses: `m` is the size of one metre in them.

export interface Box2 {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export type FillKind = 'shed' | 'hedge' | 'kiosk' | 'transformer' | 'planter' | 'tank' | 'pallets' | 'container' | 'fence';

export interface FillItem {
  kind: FillKind;
  x: number; // centre
  z: number;
  w: number; // along x
  d: number; // along z
}

// Footprints in metres (w, d) and how many to try per 1000 m² of block.
const CATALOG: Partial<Record<BlockStyle, { kind: FillKind; w: number; d: number; per1000: number }[]>> = {
  houses: [
    { kind: 'shed', w: 2.6, d: 2, per1000: 1.2 },
    { kind: 'hedge', w: 5, d: 0.9, per1000: 1.5 },
  ],
  apartments: [
    { kind: 'kiosk', w: 2.6, d: 2.2, per1000: 0.4 },
    { kind: 'planter', w: 3, d: 1.1, per1000: 0.8 },
    { kind: 'transformer', w: 1.6, d: 1.2, per1000: 0.3 },
  ],
  perimeter: [{ kind: 'transformer', w: 1.6, d: 1.2, per1000: 0.3 }],
  towers: [
    { kind: 'kiosk', w: 2.6, d: 2.2, per1000: 0.5 },
    { kind: 'planter', w: 3, d: 1.1, per1000: 1 },
    { kind: 'transformer', w: 1.6, d: 1.2, per1000: 0.3 },
  ],
  tower_plaza: [{ kind: 'planter', w: 3, d: 1.1, per1000: 0.8 }],
  station: [{ kind: 'planter', w: 3, d: 1.1, per1000: 0.6 }],
  warehouses: [
    { kind: 'tank', w: 3.2, d: 3.2, per1000: 0.6 },
    { kind: 'pallets', w: 2.4, d: 1.6, per1000: 1 },
    { kind: 'container', w: 6, d: 2.5, per1000: 0.4 },
  ],
  shed_yard: [
    { kind: 'tank', w: 3.2, d: 3.2, per1000: 0.4 },
    { kind: 'pallets', w: 2.4, d: 1.6, per1000: 0.8 },
  ],
};
const FENCED: BlockStyle[] = ['warehouses', 'shed_yard'];
const CLEAR_M = 0.6; // kept free round each structure

export function fillBlock(block: Box2, taken: readonly Box2[], style: BlockStyle, rng: Rng, m: number): FillItem[] {
  const items: FillItem[] = [];
  const cell = m;
  const nx = Math.max(1, Math.ceil((block.x1 - block.x0) / cell));
  const nz = Math.max(1, Math.ceil((block.z1 - block.z0) / cell));
  const grid = new Uint8Array(nx * nz);
  const cellsOf = (b: Box2, pad: number) => ({
    i0: Math.max(0, Math.floor((b.x0 - pad - block.x0) / cell)),
    i1: Math.min(nx - 1, Math.ceil((b.x1 + pad - block.x0) / cell) - 1),
    k0: Math.max(0, Math.floor((b.z0 - pad - block.z0) / cell)),
    k1: Math.min(nz - 1, Math.ceil((b.z1 + pad - block.z0) / cell) - 1),
  });
  const mark = (b: Box2) => {
    const c = cellsOf(b, 0);
    for (let k = c.k0; k <= c.k1; k++) for (let i = c.i0; i <= c.i1; i++) grid[k * nx + i] = 1;
  };
  const free = (b: Box2, pad = CLEAR_M * m) => {
    if (b.x0 < block.x0 || b.x1 > block.x1 || b.z0 < block.z0 || b.z1 > block.z1) return false;
    const c = cellsOf(b, pad);
    for (let k = c.k0; k <= c.k1; k++) for (let i = c.i0; i <= c.i1; i++) if (grid[k * nx + i]) return false;
    return true;
  };
  for (const b of taken) mark(b);
  const place = (kind: FillKind, x: number, z: number, w: number, d: number) => {
    const b = { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 };
    if (!free(b)) return false;
    mark(b);
    items.push({ kind, x, z, w, d });
    return true;
  };

  // Fences along the block's edges, in 3 m panels, wherever the edge is free. Panels may touch
  // each other, so they are all checked against what was there before any are marked.
  if (FENCED.includes(style)) {
    const t = 0.15 * m;
    const panel = 3 * m;
    const panels: FillItem[] = [];
    const add = (x: number, z: number, w: number, d: number) => {
      if (free({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 }, 0)) panels.push({ kind: 'fence', x, z, w, d });
    };
    for (let x = block.x0 + panel / 2; x + panel / 2 <= block.x1; x += panel) {
      add(x, block.z0 + t / 2, panel, t);
      add(x, block.z1 - t / 2, panel, t);
    }
    // Side panels stop short of the corners, where the end panels already are.
    for (let z = block.z0 + t + panel / 2; z + panel / 2 <= block.z1 - t; z += panel) {
      add(block.x0 + t / 2, z, t, panel);
      add(block.x1 - t / 2, z, t, panel);
    }
    for (const f of panels) {
      mark({ x0: f.x - f.w / 2, x1: f.x + f.w / 2, z0: f.z - f.d / 2, z1: f.z + f.d / 2 });
      items.push(f);
    }
  }
  const area = ((block.x1 - block.x0) * (block.z1 - block.z0)) / (m * m);
  for (const spec of CATALOG[style] ?? []) {
    const wanted = Math.round((area / 1000) * spec.per1000 * (0.6 + 0.8 * rng()));
    let placed = 0;
    for (let attempt = 0; attempt < wanted * 12 && placed < wanted; attempt++) {
      const turn = rng() < 0.5;
      const w = (turn ? spec.d : spec.w) * m;
      const d = (turn ? spec.w : spec.d) * m;
      const x = block.x0 + w / 2 + rng() * (block.x1 - block.x0 - w);
      const z = block.z0 + d / 2 + rng() * (block.z1 - block.z0 - d);
      if (place(spec.kind, x, z, w, d)) placed++;
    }
  }
  return items;
}

// True if two boxes overlap (touching edges do not count); for tests.
export function overlaps(a: Box2, b: Box2): boolean {
  return a.x0 < b.x1 - 1e-9 && b.x0 < a.x1 - 1e-9 && a.z0 < b.z1 - 1e-9 && b.z0 < a.z1 - 1e-9;
}
