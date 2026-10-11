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

// Commercial core in the centre, industrial strip on the core's east edge, residential
// elsewhere with density falling off from the centre. Around the core, a ring of
// low-density suburbs. Parks are scattered through both.
export function generateZones(grid: Grid, rng: Rng): Zone[] {
  const ring = grid.opts.suburbRing;
  const coreCols = grid.opts.cols - 1 - 2 * ring;
  const coreRows = grid.opts.rows - 1 - 2 * ring;
  const midC = (coreCols - 1) / 2;
  const midR = (coreRows - 1) / 2;
  const jitter = (amp: number) => (rng() - 0.5) * 2 * amp;

  const zones: Zone[] = grid.blocks.map((b, id) => {
    const c = b.c - ring;
    const r = b.r - ring;
    const outside = Math.max(0, -c, c - (coreCols - 1), -r, r - (coreRows - 1)); // blocks beyond the core
    let type: ZoneType;
    let density: number;
    if (outside > 0) {
      type = 'residential';
      density = 0.34 - 0.04 * outside + jitter(0.06);
    } else {
      const d = Math.hypot((c - midC) / coreCols, (r - midR) / coreRows); // ~0..0.7
      if (d < 0.2) {
        type = 'commercial';
        density = 0.85 + jitter(0.1);
      } else if (c === coreCols - 1) {
        type = 'industrial';
        density = 0.6 + jitter(0.1);
      } else {
        type = 'residential';
        density = 0.85 - d + jitter(0.1);
      }
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

  const inCore = (z: Zone) => {
    const b = grid.blocks[z.id];
    return b.c >= ring && b.c < ring + coreCols && b.r >= ring && b.r < ring + coreRows;
  };
  const addParks = (candidates: Zone[], count: number) => {
    for (let k = 0; k < count && candidates.length > 0; k++) {
      const z = candidates.splice(Math.floor(rng() * candidates.length), 1)[0];
      z.type = 'park';
      z.density = 0;
    }
  };
  const core = zones.filter((z) => z.type === 'residential' && inCore(z));
  const suburb = zones.filter((z) => z.type === 'residential' && !inCore(z));
  addParks(core, Math.max(2, Math.round((coreCols * coreRows) / 48)));
  addParks(suburb, Math.round(suburb.length / 80));
  return zones;
}
