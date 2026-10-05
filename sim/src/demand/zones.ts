import type { Grid } from '../network/grid';
import type { Rng } from '../core/rng';
import type { Period } from '../core/time';

export type ZoneType = 'residential' | 'commercial' | 'industrial' | 'park';

export interface Zone {
  id: number;
  type: ZoneType;
  density: number; // 0..1, relative built floor area
  accessNodes: number[]; // intersections trips can start/end at
  cx: number; // centroid, m
  cy: number;
}

// Trip production / attraction per unit density, by period.
// AM: homes produce, jobs attract. PM is the reverse.
const PRODUCTION: Record<Period, Record<ZoneType, number>> = {
  am: { residential: 1.0, commercial: 0.25, industrial: 0.15, park: 0 },
  midday: { residential: 0.4, commercial: 0.6, industrial: 0.3, park: 0 },
  pm: { residential: 0.25, commercial: 1.0, industrial: 0.8, park: 0 },
  evening: { residential: 0.5, commercial: 0.5, industrial: 0.1, park: 0 },
  night: { residential: 0.3, commercial: 0.3, industrial: 0.2, park: 0 },
};

const ATTRACTION: Record<Period, Record<ZoneType, number>> = {
  am: { residential: 0.2, commercial: 1.0, industrial: 0.8, park: 0 },
  midday: { residential: 0.4, commercial: 0.8, industrial: 0.3, park: 0 },
  pm: { residential: 1.0, commercial: 0.3, industrial: 0.15, park: 0 },
  evening: { residential: 0.6, commercial: 0.6, industrial: 0.05, park: 0 },
  night: { residential: 0.5, commercial: 0.2, industrial: 0.2, park: 0 },
};

export const production = (z: Zone, p: Period) => z.density * PRODUCTION[p][z.type];
export const attraction = (z: Zone, p: Period) => z.density * ATTRACTION[p][z.type];

// Commercial core in the centre, industrial strip on the east edge,
// residential elsewhere with density falling off from the centre, plus two parks.
export function generateZones(grid: Grid, rng: Rng): Zone[] {
  const blockCols = grid.opts.cols - 1;
  const blockRows = grid.opts.rows - 1;
  const midC = (blockCols - 1) / 2;
  const midR = (blockRows - 1) / 2;
  const jitter = (amp: number) => (rng() - 0.5) * 2 * amp;

  const zones: Zone[] = grid.blocks.map((b, id) => {
    const d = Math.hypot((b.c - midC) / blockCols, (b.r - midR) / blockRows); // ~0..0.7
    let type: ZoneType;
    let density: number;
    if (d < 0.2) {
      type = 'commercial';
      density = 0.85 + jitter(0.1);
    } else if (b.c === blockCols - 1) {
      type = 'industrial';
      density = 0.6 + jitter(0.1);
    } else {
      type = 'residential';
      density = 0.85 - d + jitter(0.1);
    }
    const pts = b.corners.map((n) => grid.net.nodes[n]);
    return {
      id,
      type,
      density: Math.min(1, Math.max(0.15, density)),
      accessNodes: [...b.corners],
      cx: pts.reduce((s, p) => s + p.x, 0) / 4,
      cy: pts.reduce((s, p) => s + p.y, 0) / 4,
    };
  });

  const residential = zones.filter((z) => z.type === 'residential');
  for (let k = 0; k < 2 && residential.length > 0; k++) {
    const z = residential.splice(Math.floor(rng() * residential.length), 1)[0];
    z.type = 'park';
    z.density = 0;
  }
  return zones;
}
