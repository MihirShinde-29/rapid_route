import type { EmergencyCall } from '../dispatch/dispatch';
import type { Site } from '../city/sites';
import { CHART_COLORS, formatMinutes } from './responseChart';

// End-of-shift map: the street grid, the stations, and every finished call where it happened,
// coloured like the response chart (green within target, amber over, a red cross missed), so the
// player can see which parts of the city their units reached late.
const NS = 'http://www.w3.org/2000/svg';
const STATION_MARK: Record<string, { letter: string; color: string }> = {
  hospital: { letter: 'H', color: '#f2f2f2' },
  fire_station: { letter: 'F', color: '#e0564a' },
  police_station: { letter: 'P', color: '#6f9be0' },
};

export interface MapStreets {
  width: number; // metres
  height: number;
  nodes: { x: number; y: number }[];
  links: { from: number; to: number; arterial?: boolean }[];
}

export function callMap(calls: EmergencyCall[], streets: MapStreets, stations: Site[], width: number): SVGSVGElement {
  const pad = 8;
  const scale = (width - 2 * pad) / streets.width;
  const height = Math.round(streets.height * scale + 2 * pad);
  const X = (x: number) => pad + x * scale;
  const Y = (y: number) => pad + y * scale;
  const done = calls.filter((c) => c.state === 'resolved' || c.state === 'missed');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');
  const late = done.filter((c) => c.state === 'missed' || (c.responseTime ?? 0) > c.targetResponseTime).length;
  svg.setAttribute('aria-label', `Map of ${done.length} finished calls, ${late} late or missed`);
  const el = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    parent.appendChild(node);
    return node;
  };
  el('rect', { x: 0, y: 0, width, height, fill: '#0e141c', rx: 4 });
  // Streets, each drawn once (links come in pairs, one per direction).
  const seen = new Set<string>();
  for (const l of streets.links) {
    const key = l.from < l.to ? `${l.from}-${l.to}` : `${l.to}-${l.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = streets.nodes[l.from];
    const b = streets.nodes[l.to];
    el('line', { x1: X(a.x), y1: Y(a.y), x2: X(b.x), y2: Y(b.y), stroke: l.arterial ? '#3a4652' : '#26313c', 'stroke-width': l.arterial ? 2 : 1 });
  }
  for (const s of stations) {
    const m = STATION_MARK[s.kind];
    if (!m) continue;
    const g = el('g', {});
    el('title', {}, g).textContent = `${s.kind.replace('_', ' ')} · ${s.address}`;
    el('rect', { x: X(s.door.x) - 6, y: Y(s.door.y) - 6, width: 12, height: 12, rx: 2, fill: '#121821', stroke: m.color, 'stroke-width': 1.5 }, g);
    const t = el('text', { x: X(s.door.x), y: Y(s.door.y) + 3.5, 'text-anchor': 'middle', fill: m.color, 'font-size': 9, 'font-weight': 600, 'font-family': 'IBM Plex Mono, monospace' }, g);
    t.textContent = m.letter;
  }
  done.forEach((call, k) => {
    const x = X(call.site.door.x);
    const y = Y(call.site.door.y);
    const g = el('g', {});
    const title = el('title', {}, g);
    if (call.state === 'missed') {
      const r = 4;
      el('path', { d: `M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}`, stroke: '#0e141c', 'stroke-width': 5, 'stroke-linecap': 'round' }, g);
      el('path', { d: `M${x - r} ${y - r}L${x + r} ${y + r}M${x + r} ${y - r}L${x - r} ${y + r}`, stroke: CHART_COLORS.MISSED, 'stroke-width': 2, 'stroke-linecap': 'round' }, g);
      title.textContent = `Call ${k + 1} · ${call.kind} at ${call.site.address} · missed`;
    } else {
      const ok = (call.responseTime ?? 0) <= call.targetResponseTime;
      // A 2px ring in the surface colour keeps overlapping calls apart.
      el('circle', { cx: x, cy: y, r: 5, fill: ok ? CHART_COLORS.GOOD : CHART_COLORS.OVER, stroke: '#0e141c', 'stroke-width': 2 }, g);
      title.textContent = `Call ${k + 1} · ${call.kind} at ${call.site.address} · ${formatMinutes(call.responseTime ?? 0)} (target ${formatMinutes(call.targetResponseTime)})`;
    }
    // Larger invisible hit target for the tooltip.
    el('circle', { cx: x, cy: y, r: 9, fill: 'transparent' }, g);
  });
  return svg;
}
