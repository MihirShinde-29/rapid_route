import { mulberry32, type Rng } from '../core/rng';
import type { Grid } from '../network/grid';
import type { Link } from '../network/network';
import type { Zone } from '../demand/zones';
import { LaneGeom } from '../traffic/geometry';

// The city layout: what stands on every block, and the addresses. Every building, park,
// plaza or car park is a site with its own entrance on a street; trips and emergency calls go
// from one entrance to another. The 3D view only draws this; it decides how things look
// (heights, colours, trees), not where they are.

export type SiteKind =
  | 'house' | 'apartment' | 'tower' | 'shop' | 'warehouse' | 'park' | 'plaza' | 'parking' | 'mall'
  | 'hospital' | 'fire_station' | 'police_station';

export const STATION_KINDS: SiteKind[] = ['hospital', 'fire_station', 'police_station'];

export interface Rect {
  x0: number; // m, y-down like the network
  y0: number;
  x1: number;
  y1: number;
}

export type Side = 'n' | 'e' | 's' | 'w';

export interface Site {
  id: number;
  kind: SiteKind;
  zone: number;
  size: number; // floor area, m² (parks, plazas and car parks: ground area); weights trips and calls
  address: string; // "214 Oak St"
  entrance: { link: number; pos: number }; // the lane it opens onto, m along it
  door: { x: number; y: number }; // where the driveway meets the lot, m
  lot: Rect;
  front: Side; // the side of the lot its entrance is on
}

export type BlockStyle =
  | 'houses' | 'apartments' | 'perimeter' | 'towers' | 'podium' | 'tower_plaza' | 'parking'
  | 'shed_yard' | 'warehouses' | 'park' | 'station' | 'superblock' | 'empty';

export interface BlockPlan {
  zone: number; // = block index
  rect: Rect; // buildable area inside the pavements
  streets: Record<Side, boolean>; // sides that face a street
  style: BlockStyle;
  sites: number[];
  empty: Rect[]; // lots left open (the view may plant them)
  split: number; // shed_yard: fraction of the width taken by the shed
}

export interface SuperPlan {
  kind: 'park' | 'mall';
  rect: Rect;
  site: number | null;
}

export interface CityLayout {
  sites: Site[];
  blocks: BlockPlan[];
  superblocks: SuperPlan[];
}

export const DRIVEWAY_M = 13; // how far beside the lane a driveway starts
const STREET_PAD = 13.6; // m from the street centreline to the buildable area
const OPEN_PAD = 2.9; // m on sides without a street
const ENTRANCE_MARGIN = 10; // m kept clear at each end of a lane (about 19 m from the junction centre)
const ENTRANCE_GAP = 12; // m between entrances on one lane; closer ones share a driveway

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

// Stations: map fractions (x, y), spread so each covers part of the city. Each takes a whole block.
const STATIONS: [SiteKind, number, number][] = [
  ['hospital', 0.38, 0.38],
  ['hospital', 0.64, 0.66],
  ['fire_station', 0.64, 0.34],
  ['fire_station', 0.36, 0.66],
  ['police_station', 0.5, 0.5],
  ['police_station', 0.25, 0.5],
];
const STATION_SIZE: Partial<Record<SiteKind, number>> = { hospital: 12000, fire_station: 1500, police_station: 2500 };

const width = (r: Rect) => r.x1 - r.x0;
const depth = (r: Rect) => r.y1 - r.y0;
const centre = (r: Rect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

// Split an area into roughly square lots of about `size` m.
function lots(r: Rect, size: number): Rect[] {
  const nx = Math.max(1, Math.round(width(r) / size));
  const ny = Math.max(1, Math.round(depth(r) / size));
  const cw = width(r) / nx;
  const cd = depth(r) / ny;
  const out: Rect[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) out.push({ x0: r.x0 + cw * i, y0: r.y0 + cd * j, x1: r.x0 + cw * (i + 1), y1: r.y0 + cd * (j + 1) });
  }
  return out;
}

export function buildCity(grid: Grid, zones: Zone[], seed: number): CityLayout {
  const net = grid.net;
  const rng: Rng = mulberry32(seed);
  const superOf = new Map<number, number>();
  grid.superblocks.forEach((sb, k) => sb.blocks.forEach((b) => superOf.set(b, k)));
  const reverse = (link: Link) => net.outLinks[link.to].find((id) => net.links[id].to === link.from);
  // A car must be able to arrive on the link and leave it without a U-turn.
  const usable = (link: Link) => {
    const back = reverse(link);
    return net.inLinks[link.from].some((id) => net.links[id].from !== link.to) && net.outLinks[link.to].some((id) => id !== back);
  };
  const geoms = new Map<number, LaneGeom>();
  const geom = (id: number) => {
    let g = geoms.get(id);
    if (!g) geoms.set(id, (g = new LaneGeom(net, net.links[id])));
    return g;
  };

  // Each side of a block, clockwise in y-down coordinates so the block is on the right of the
  // link: the street a lot on that side opens onto.
  const sideLinks = (b: number): Record<Side, number | undefined> => {
    const [tl, tr, br, bl] = grid.blocks[b].corners;
    const find = (from: number, to: number) => net.outLinks[from].find((l) => net.links[l].to === to);
    return { n: find(tl, tr), e: find(tr, br), s: find(br, bl), w: find(bl, tl) };
  };

  const blocks: BlockPlan[] = grid.blocks.map((block, b) => {
    const [tl, tr, br, bl] = block.corners.map((n) => net.nodes[n]);
    const links = sideLinks(b);
    const streets = { n: links.n !== undefined, e: links.e !== undefined, s: links.s !== undefined, w: links.w !== undefined };
    const pad = (on: boolean) => (on ? STREET_PAD : OPEN_PAD);
    const rect = {
      x0: Math.max(tl.x, bl.x) + pad(streets.w),
      x1: Math.min(tr.x, br.x) - pad(streets.e),
      y0: Math.max(tl.y, tr.y) + pad(streets.n),
      y1: Math.min(bl.y, br.y) - pad(streets.s),
    };
    return { zone: b, rect, streets, style: 'empty', sites: [], empty: [], split: 0 };
  });

  const sites: Site[] = [];
  const usableSides = (b: number): Side[] => {
    const links = sideLinks(b);
    return (['n', 'e', 's', 'w'] as Side[]).filter((s) => links[s] !== undefined && usable(net.links[links[s]!]));
  };

  // Adds a site on block `b` opening onto side `front` (or, if that street can't take an
  // entrance, the nearest side that can). `along` places the door along that side (default: the
  // middle of the lot). Returns the site id, or -1 if the block has no usable street.
  const addSite = (b: number, kind: SiteKind, lot: Rect, front: Side, size: number, along?: number): number => {
    const links = sideLinks(b);
    const ok = usableSides(b);
    if (ok.length === 0) return -1;
    if (!ok.includes(front)) {
      const r = blocks[b].rect;
      const c = centre(lot);
      const dist: Record<Side, number> = { n: c.y - r.y0, s: r.y1 - c.y, w: c.x - r.x0, e: r.x1 - c.x };
      front = ok.reduce((a, s) => (dist[s] < dist[a] ? s : a));
    }
    const c = centre(lot);
    const horizontal = front === 'n' || front === 's';
    const t = along ?? (horizontal ? c.x : c.y);
    const door = horizontal ? { x: t, y: front === 'n' ? lot.y0 : lot.y1 } : { x: front === 'w' ? lot.x0 : lot.x1, y: t };
    const id = links[front]!;
    const g = geom(id);
    const pos = Math.min(g.length - ENTRANCE_MARGIN, Math.max(ENTRANCE_MARGIN, (door.x - g.x0) * g.dx + (door.y - g.y0) * g.dy));
    const site: Site = { id: sites.length, kind, zone: b, size: Math.round(size), address: '', entrance: { link: id, pos }, door, lot, front };
    sites.push(site);
    blocks[b].sites.push(site.id);
    return site.id;
  };

  // Stations first: each takes the ordinary block nearest its target point.
  const stationAt = new Map<number, SiteKind>();
  for (const [kind, fx, fy] of STATIONS) {
    let best = -1;
    let bestD = Infinity;
    blocks.forEach((p, b) => {
      if (superOf.has(b) || zones[b].type === 'park' || stationAt.has(b) || usableSides(b).length === 0) return;
      const c = centre(p.rect);
      const d = Math.hypot(c.x - fx * grid.width, c.y - fy * grid.height);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    });
    if (best >= 0) stationAt.set(best, kind);
  }

  for (const p of blocks) {
    const b = p.zone;
    const z = zones[b];
    const r = p.rect;
    const w = width(r);
    const d = depth(r);
    if (superOf.has(b)) {
      p.style = 'superblock';
      continue;
    }
    if (w < 7 || d < 7) continue;
    const station = stationAt.get(b);
    if (station) {
      p.style = 'station';
      addSite(b, station, r, usableSides(b)[0], STATION_SIZE[station]!);
      continue;
    }
    if (z.type === 'park') {
      p.style = 'park';
      addSite(b, 'park', r, 's', w * d);
      continue;
    }
    const style = rng();
    if (z.type === 'commercial') {
      const floors = () => 15 + 45 * z.density;
      if (style < 0.14) {
        // A tower on one half, a public plaza on the other.
        p.style = 'tower_plaza';
        const left = { ...r, x1: r.x0 + w / 2 };
        const right = { ...r, x0: r.x0 + w / 2 };
        addSite(b, 'tower', left, 'w', width(left) * d * 0.4 * floors());
        addSite(b, 'plaza', right, 'e', width(right) * d);
      } else if (style < 0.3) {
        // One podium over the whole block with towers rising from it.
        p.style = 'podium';
        addSite(b, 'tower', r, 's', w * d * (3 + 0.15 * floors()));
      } else if (style < 0.38 && z.density < 0.9) {
        // A surface car park with a low building at the back.
        p.style = 'parking';
        addSite(b, 'shop', { x0: r.x0 + w * 0.1, x1: r.x1 - w * 0.1, y0: r.y0 + d * 0.02, y1: r.y0 + d * 0.28 }, 'n', w * 0.8 * d * 0.26 * 2);
        addSite(b, 'parking', { ...r, y0: r.y0 + d * 0.35 }, 's', w * d * 0.65);
      } else {
        p.style = 'towers';
        for (const lot of lots(r, 36 + 14 * rng())) addSite(b, 'tower', lot, frontOf(lot, r), width(lot) * depth(lot) * 0.45 * floors());
      }
    } else if (z.type === 'industrial') {
      if (style < 0.55) {
        // One big shed and a yard with shipping containers.
        p.style = 'shed_yard';
        p.split = 0.55 + 0.1 * rng();
        addSite(b, 'warehouse', r, 'e', w * d * 0.6);
      } else {
        p.style = 'warehouses';
        for (const lot of lots(r, 39)) addSite(b, 'warehouse', lot, frontOf(lot, r), width(lot) * depth(lot) * 0.8);
      }
    } else if (z.density >= 0.45) {
      const floors = 3 + 12 * z.density;
      if (style < 0.5 && w > 43 && d > 43) {
        // Perimeter block: apartment slabs round the edge, a courtyard inside.
        p.style = 'perimeter';
        const t = Math.min(w, d) * 0.24;
        const slabs: [Side, Rect][] = [
          ['n', { ...r, y1: r.y0 + t }],
          ['s', { ...r, y0: r.y1 - t }],
          ['w', { x0: r.x0, x1: r.x0 + t, y0: r.y0 + t, y1: r.y1 - t }],
          ['e', { x0: r.x1 - t, x1: r.x1, y0: r.y0 + t, y1: r.y1 - t }],
        ];
        for (const [side, lot] of slabs) addSite(b, 'apartment', lot, side, width(lot) * depth(lot) * floors);
      } else {
        p.style = 'apartments';
        for (const lot of lots(r, 33)) {
          if (rng() > 0.35 + 0.65 * z.density) p.empty.push(lot);
          else addSite(b, 'apartment', lot, frontOf(lot, r), width(lot) * depth(lot) * 0.5 * floors);
        }
      }
    } else {
      p.style = 'houses';
      addHouses(p, z);
    }
  }

  // Houses face the streets round the block, each on its own lot (about 24 m of frontage).
  // The corners belong to the north and south rows.
  function addHouses(p: BlockPlan, z: Zone): void {
    const r = p.rect;
    const frontage = 23.6;
    const deep = Math.min(30, depth(r) / 2, width(r) / 2);
    const any = p.streets.n || p.streets.e || p.streets.s || p.streets.w;
    const sides = any ? p.streets : { n: true, e: true, s: true, w: true };
    const yTop = r.y0 + (sides.n ? deep : 0);
    const yBot = r.y1 - (sides.s ? deep : 0);
    const rows: { side: Side; len: number; lot: (a: number, b: number) => Rect }[] = [];
    if (sides.n) rows.push({ side: 'n', len: width(r), lot: (a, b) => ({ x0: r.x0 + a, x1: r.x0 + b, y0: r.y0, y1: r.y0 + deep }) });
    if (sides.s) rows.push({ side: 's', len: width(r), lot: (a, b) => ({ x0: r.x0 + a, x1: r.x0 + b, y0: r.y1 - deep, y1: r.y1 }) });
    if (sides.w) rows.push({ side: 'w', len: yBot - yTop, lot: (a, b) => ({ x0: r.x0, x1: r.x0 + deep, y0: yTop + a, y1: yTop + b }) });
    if (sides.e) rows.push({ side: 'e', len: yBot - yTop, lot: (a, b) => ({ x0: r.x1 - deep, x1: r.x1, y0: yTop + a, y1: yTop + b }) });
    for (const row of rows) {
      const n = Math.floor(row.len / frontage);
      if (n < 1) continue;
      const step = row.len / n;
      for (let k = 0; k < n; k++) {
        const lot = row.lot(step * k, step * (k + 1));
        if (rng() > 0.45 + 0.9 * z.density) {
          p.empty.push(lot); // an empty lot now and then
          continue;
        }
        // The driveway runs down one side of the lot, beside the house.
        const c = centre(lot);
        const along = row.side === 'n' || row.side === 's' ? c.x + step * 0.3 : c.y + step * 0.3;
        addSite(p.zone, 'house', lot, row.side, 180 + 120 * z.density, along);
      }
    }
  }

  // The block side a lot touches with the most frontage (ties: north, east, south, west).
  function frontOf(lot: Rect, r: Rect): Side {
    const touch: [Side, number][] = [
      ['n', lot.y0 - r.y0 < 0.5 ? width(lot) : 0],
      ['e', r.x1 - lot.x1 < 0.5 ? depth(lot) : 0],
      ['s', r.y1 - lot.y1 < 0.5 ? width(lot) : 0],
      ['w', lot.x0 - r.x0 < 0.5 ? depth(lot) : 0],
    ];
    return touch.reduce((a, s) => (s[1] > a[1] ? s : a))[0];
  }

  // Superblocks: one park, or one mall entered from beside its car park (the south side).
  const superblocks: SuperPlan[] = grid.superblocks.map((sb) => {
    const rs = sb.blocks.map((b) => blocks[b].rect);
    const rect = {
      x0: Math.min(...rs.map((q) => q.x0)),
      x1: Math.max(...rs.map((q) => q.x1)),
      y0: Math.min(...rs.map((q) => q.y0)),
      y1: Math.max(...rs.map((q) => q.y1)),
    };
    let site: number | null = null;
    for (const side of ['s', 'n', 'e', 'w'] as Side[]) {
      const b = sb.blocks.find((m) => usableSides(m).includes(side));
      if (b === undefined) continue;
      const c = centre(blocks[b].rect);
      const area = width(rect) * depth(rect);
      site = addSite(b, sb.kind, rect, side, sb.kind === 'mall' ? area * 0.5 : area, side === 'n' || side === 's' ? c.x : c.y);
      blocks[b].sites.pop(); // it belongs to the superblock, not the member block
      break;
    }
    return { kind: sb.kind, rect, site };
  });

  spaceEntrances(sites, geom);
  numberSites(grid, sites, geom);
  return { sites, blocks, superblocks };
}

// Entrances on one lane at least ENTRANCE_GAP apart; one that can't move far enough shares the
// driveway before it.
function spaceEntrances(sites: Site[], geom: (id: number) => LaneGeom): void {
  const byLane = new Map<number, Site[]>();
  for (const s of sites) {
    const list = byLane.get(s.entrance.link) ?? [];
    list.push(s);
    byLane.set(s.entrance.link, list);
  }
  for (const [lane, list] of byLane) {
    const max = geom(lane).length - ENTRANCE_MARGIN;
    list.sort((a, b) => a.entrance.pos - b.entrance.pos);
    for (let k = 1; k < list.length; k++) {
      const prev = list[k - 1].entrance.pos;
      const cur = list[k].entrance;
      if (cur.pos - prev >= ENTRANCE_GAP - 1e-9 || cur.pos === prev) continue;
      cur.pos = prev + ENTRANCE_GAP <= max ? prev + ENTRANCE_GAP : prev;
    }
  }
}

// House numbers: hundreds count blocks along the street, odd on the north and west sides.
function numberSites(grid: Grid, sites: Site[], geom: (id: number) => LaneGeom): void {
  const { cols } = grid.opts;
  for (const s of sites) {
    const link = grid.net.links[s.entrance.link];
    const g = geom(link.id);
    const ew = Math.abs(g.dx) >= Math.abs(g.dy);
    const along = ew ? Math.min(link.from % cols, link.to % cols) : Math.min(Math.floor(link.from / cols), Math.floor(link.to / cols));
    const forward = ew ? g.dx > 0 : g.dy > 0; // numbers rise to the east and south
    const frac = forward ? s.entrance.pos / g.length : 1 - s.entrance.pos / g.length;
    const odd = ew ? g.dx < 0 : g.dy > 0;
    s.address = `${(along + 1) * 100 + 2 * Math.round(1 + 47 * frac) + (odd ? 1 : 0)} ${streetName(grid, link)}`;
  }
}
