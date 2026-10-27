import type { Grid } from '../network/grid';
import type { Link } from '../network/network';
import type { Zone } from '../demand/zones';
import { LaneGeom } from '../traffic/geometry';

// Addresses: every building, park or lot with its own entrance on a street. Trips and
// emergency calls go from one entrance to another.
//
// Day-1 stub: one site per block side, its entrance half way along the lane whose kerb
// faces the block. The real layout replaces this without changing the types below.

export type SiteKind =
  | 'house' | 'apartment' | 'tower' | 'shop' | 'warehouse' | 'park' | 'plaza' | 'parking' | 'mall'
  | 'hospital' | 'fire_station' | 'police_station';

export const STATION_KINDS: SiteKind[] = ['hospital', 'fire_station', 'police_station'];

export interface Site {
  id: number;
  kind: SiteKind;
  zone: number;
  size: number; // floor area, m² (parks: ground area); weights trips and calls
  address: string; // "214 Oak St"
  entrance: { link: number; pos: number }; // the lane it opens onto, m along it
  door: { x: number; y: number }; // where the driveway meets the building, m
}

export const DRIVEWAY_M = 13; // how far beside the lane a driveway starts

const ROW_NAMES = [
  'Oak', 'Maple', 'Pine', 'Cedar', 'Elm', 'Birch', 'Walnut', 'Chestnut', 'Spruce', 'Willow', 'Ash', 'Hickory',
  'Poplar', 'Magnolia', 'Laurel', 'Sycamore', 'Juniper', 'Linden', 'Hawthorn', 'Alder', 'Cherry', 'Locust', 'Holly',
];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

// Streets running east-west are named, north-south ones numbered.
export function streetName(grid: Grid, link: Link): string {
  const { cols } = grid.opts;
  const a = grid.net.nodes[link.from];
  const b = grid.net.nodes[link.to];
  if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) {
    const r = Math.floor(link.from / cols);
    return `${ROW_NAMES[r % ROW_NAMES.length]} St`;
  }
  return `${ordinal((link.from % cols) + 1)} Ave`;
}

// Station placement for the stub: map fractions (x, y), spread so each covers part of the city.
const STATIONS: [SiteKind, number, number][] = [
  ['hospital', 0.38, 0.38],
  ['hospital', 0.64, 0.66],
  ['fire_station', 0.64, 0.34],
  ['fire_station', 0.36, 0.66],
  ['police_station', 0.5, 0.5],
  ['police_station', 0.25, 0.5],
];

const SIZE: Record<SiteKind, number> = {
  house: 180, apartment: 2400, tower: 9000, shop: 700, warehouse: 2500, park: 8000, plaza: 1500,
  parking: 1200, mall: 12000, hospital: 8000, fire_station: 900, police_station: 1200,
};

export function buildSites(grid: Grid, zones: Zone[]): Site[] {
  const net = grid.net;
  const { cols } = grid.opts;
  const superKind = new Map<number, 'park' | 'mall'>();
  for (const sb of grid.superblocks) for (const b of sb.blocks) superKind.set(b, sb.kind);
  const reverse = (link: Link) => net.outLinks[link.to].find((id) => net.links[id].to === link.from);
  // A car must be able to arrive on the link and leave it without a U-turn.
  const usable = (link: Link) => {
    const back = reverse(link);
    return net.inLinks[link.from].some((id) => net.links[id].from !== link.to) && net.outLinks[link.to].some((id) => id !== back);
  };

  const sites: Site[] = [];
  grid.blocks.forEach((block, b) => {
    const zone = zones[b];
    const kind: SiteKind =
      superKind.get(b) ??
      (zone.type === 'park' ? 'park'
        : zone.type === 'industrial' ? 'warehouse'
        : zone.type === 'commercial' ? (zone.density >= 0.8 ? 'tower' : 'shop')
        : zone.density >= 0.6 ? 'apartment' : 'house');
    const [tl, tr, br, bl] = block.corners;
    // Clockwise in y-down coordinates, so the block is on the right of each side.
    for (const [from, to] of [[tl, tr], [tr, br], [br, bl], [bl, tl]]) {
      const id = net.outLinks[from].find((l) => net.links[l].to === to);
      if (id === undefined || !usable(net.links[id])) continue;
      const link = net.links[id];
      const geom = new LaneGeom(net, link);
      const pos = geom.length / 2;
      const p = geom.pose(pos);
      const door = { x: p.x - p.hy * DRIVEWAY_M, y: p.y + p.hx * DRIVEWAY_M };
      // House numbers: hundreds count blocks along the street; odd on one side, even on the other.
      const ew = Math.abs(p.hx) >= Math.abs(p.hy);
      const along = ew ? Math.min(link.from % cols, link.to % cols) : Math.min(Math.floor(link.from / cols), Math.floor(link.to / cols));
      const odd = ew ? p.hx < 0 : p.hy > 0; // north and west sides
      const forward = ew ? p.hx > 0 : p.hy > 0; // numbers rise to the east and south
      const frac = forward ? pos / geom.length : 1 - pos / geom.length;
      const number = (along + 1) * 100 + 2 * Math.round(5 + 40 * frac) + (odd ? 1 : 0);
      sites.push({
        id: sites.length,
        kind,
        zone: b,
        size: Math.round(SIZE[kind] * (kind === 'park' || kind === 'mall' ? 1 : 0.5 + zone.density)),
        address: `${number} ${streetName(grid, link)}`,
        entrance: { link: id, pos },
        door,
      });
    }
  });

  // Stations take over the site nearest each target point, one per block.
  const used = new Set<number>();
  for (const [kind, fx, fy] of STATIONS) {
    let best = -1;
    let bestD = Infinity;
    for (const s of sites) {
      if (s.kind === 'park' || s.kind === 'mall' || used.has(s.zone)) continue;
      const d = Math.hypot(s.door.x - fx * grid.width, s.door.y - fy * grid.height);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    if (best < 0) continue;
    sites[best].kind = kind;
    sites[best].size = SIZE[kind];
    used.add(sites[best].zone);
  }
  return sites;
}
