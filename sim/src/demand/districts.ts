import type { Grid } from '../network/grid';

// Nine districts for reading OD flows: downtown (the core) and the eight suburban sectors
// around it. Hundreds of zone-to-zone pairs are too many to read; nine by nine is not.
export const DISTRICTS = ['NW', 'N', 'NE', 'W', 'Downtown', 'E', 'SW', 'S', 'SE'] as const;
export const DOWNTOWN = 4;

// District of each block (zones live on blocks, so this is also per zone).
export function blockDistricts(grid: Grid): Int8Array {
  const { rows, cols, suburbRing: ring } = grid.opts;
  // Blocks between the core's edge streets are downtown; the rest are suburbs.
  const band = (k: number, n: number) => (k < ring ? 0 : k > n - 2 - ring ? 2 : 1);
  return Int8Array.from(grid.blocks, (b) => band(b.r, rows) * 3 + band(b.c, cols));
}

// Zone-to-zone shares (row-major, origins as rows) summed into district-to-district shares.
export function districtShares(district: Int8Array, shares: Float64Array): Float64Array {
  const n = district.length;
  const k = DISTRICTS.length;
  const out = new Float64Array(k * k);
  for (let o = 0; o < n; o++) {
    const row = district[o] * k;
    for (let d = 0; d < n; d++) out[row + district[d]] += shares[o * n + d];
  }
  return out;
}
