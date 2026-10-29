import type { EmergencyCall } from '../dispatch/dispatch';

// End-of-shift chart: one bar per finished call, in the order the calls came in, as tall as its
// response time, with a tick at that call's target. Status colours carry a legend label too:
// green within target, amber over it, a red cross for a missed call.
const GOOD = '#0ca30c';
const OVER = '#fab219';
const MISSED = '#d03b3b';
const NS = 'http://www.w3.org/2000/svg';

export function responseChart(calls: EmergencyCall[], width: number): SVGSVGElement {
  const done = calls.filter((c) => c.state === 'resolved' || c.state === 'missed');
  const height = 150;
  const pad = { left: 30, right: 6, top: 8, bottom: 18 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const minutes = (s: number) => s / 60;
  const top = Math.max(15, ...done.map((c) => minutes(Math.max(c.responseTime ?? 0, c.targetResponseTime))));
  const yMax = Math.ceil(top / 5) * 5;
  const y = (m: number) => pad.top + plotH * (1 - m / yMax);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');
  const within = done.filter((c) => c.state === 'resolved' && (c.responseTime ?? 0) <= c.targetResponseTime).length;
  svg.setAttribute('aria-label', `Response times: ${within} of ${done.length} calls within target`);
  const el = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    parent.appendChild(node);
    return node;
  };

  // Recessive grid and minute labels.
  for (let m = 0; m <= yMax; m += 5) {
    el('line', { x1: pad.left, x2: width - pad.right, y1: y(m), y2: y(m), stroke: '#212c37', 'stroke-width': 1 });
    const label = el('text', { x: pad.left - 5, y: y(m) + 3, 'text-anchor': 'end', fill: '#7c8a97', 'font-size': 9, 'font-family': 'IBM Plex Mono, monospace' });
    label.textContent = String(m);
  }
  const unit = el('text', { x: pad.left, y: height - 4, fill: '#7c8a97', 'font-size': 9, 'font-family': 'IBM Plex Mono, monospace' });
  unit.textContent = done.length > 0 ? `calls 1–${done.length} in the order they came in` : 'no calls finished';

  if (done.length === 0) return svg;
  const slot = plotW / done.length;
  const gap = slot >= 6 ? 2 : 0;
  const barW = Math.max(1, slot - gap);
  done.forEach((call, k) => {
    const x = pad.left + k * slot + gap / 2;
    const g = el('g', {});
    const title = el('title', {}, g);
    if (call.state === 'missed') {
      const cx = x + barW / 2;
      const cy = y(yMax) + 6;
      const r = Math.min(4, Math.max(2, barW / 2));
      el('path', { d: `M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx + r} ${cy - r}L${cx - r} ${cy + r}`, stroke: MISSED, 'stroke-width': 2, 'stroke-linecap': 'round' }, g);
      title.textContent = `Call ${k + 1} · ${call.kind} at ${call.site.address} · missed`;
    } else {
      const m = minutes(call.responseTime ?? 0);
      const ok = (call.responseTime ?? 0) <= call.targetResponseTime;
      const h = Math.max(1, y(0) - y(m));
      const r = Math.min(4, barW / 2);
      // Rounded at the data end, square on the baseline.
      el('path', {
        d: `M${x} ${y(0)}V${y(0) - h + r}Q${x} ${y(0) - h} ${x + r} ${y(0) - h}H${x + barW - r}Q${x + barW} ${y(0) - h} ${x + barW} ${y(0) - h + r}V${y(0)}Z`,
        fill: ok ? GOOD : OVER,
      }, g);
      title.textContent = `Call ${k + 1} · ${call.kind} at ${call.site.address} · ${formatMinutes(call.responseTime ?? 0)} (target ${formatMinutes(call.targetResponseTime)})`;
    }
    // Target tick, in text ink so it reads against both bar colours.
    el('line', { x1: x - gap / 2, x2: x + barW + gap / 2, y1: y(minutes(call.targetResponseTime)), y2: y(minutes(call.targetResponseTime)), stroke: '#dce4ea', 'stroke-width': 1.5 }, g);
    // Hit target as tall as the plot, so thin bars are easy to hover.
    el('rect', { x: pad.left + k * slot, y: pad.top, width: slot, height: plotH, fill: 'transparent' }, g);
  });
  return svg;
}

export function formatMinutes(s: number): string {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export const CHART_COLORS = { GOOD, OVER, MISSED };
