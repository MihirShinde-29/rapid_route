import type { Link, Network } from '../network/network';

// Right-hand traffic, one lane per direction (MVP cut).
export const JUNCTION_RADIUS = 9; // m; links stop this far short of the node centre
export const LANE_OFFSET = 2.5; // m from the street centreline

export interface Pose {
  x: number;
  y: number;
  hx: number; // unit heading
  hy: number;
}

// Drivable part of a link: from just past the upstream junction to the stop line.
export class LaneGeom {
  readonly x0: number;
  readonly y0: number;
  readonly dx: number;
  readonly dy: number;
  readonly length: number;

  constructor(net: Network, link: Link) {
    const a = net.nodes[link.from];
    const b = net.nodes[link.to];
    this.dx = (b.x - a.x) / link.length;
    this.dy = (b.y - a.y) / link.length;
    // Right of travel direction in y-down coordinates.
    const nx = -this.dy;
    const ny = this.dx;
    this.x0 = a.x + this.dx * JUNCTION_RADIUS + nx * LANE_OFFSET;
    this.y0 = a.y + this.dy * JUNCTION_RADIUS + ny * LANE_OFFSET;
    this.length = link.length - 2 * JUNCTION_RADIUS;
  }

  pose(s: number): Pose {
    return { x: this.x0 + this.dx * s, y: this.y0 + this.dy * s, hx: this.dx, hy: this.dy };
  }
}

const SAMPLES = 16;

// Path through a junction from one lane's stop line to the next lane's start.
// Straight for through movements, quadratic Bezier for turns.
export class Connector {
  readonly length: number;
  readonly turn: boolean;
  readonly kind: 'left' | 'right' | 'through';
  readonly inDx: number; // approach direction
  readonly inDy: number;
  private px: number[];
  private py: number[];
  private cum: number[];

  constructor(
    readonly inLink: number,
    readonly outLink: number,
    a: LaneGeom,
    b: LaneGeom,
  ) {
    const ex = a.x0 + a.dx * a.length;
    const ey = a.y0 + a.dy * a.length;
    const sx = b.x0;
    const sy = b.y0;
    this.turn = Math.abs(a.dx * b.dx + a.dy * b.dy) < 0.5;
    const cross = a.dx * b.dy - a.dy * b.dx; // > 0 is a right turn in y-down coordinates
    this.kind = !this.turn ? 'through' : cross > 0 ? 'right' : 'left';
    this.inDx = a.dx;
    this.inDy = a.dy;
    // Control point where the two lane lines cross (perpendicular grid streets).
    const t = this.turn ? (sx - ex) * a.dx + (sy - ey) * a.dy : 0.5;
    const cx = this.turn ? ex + a.dx * t : (ex + sx) / 2;
    const cy = this.turn ? ey + a.dy * t : (ey + sy) / 2;
    this.px = [];
    this.py = [];
    this.cum = [0];
    for (let i = 0; i <= SAMPLES; i++) {
      const u = i / SAMPLES;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * u * (1 - u);
      const w2 = u * u;
      this.px.push(w0 * ex + w1 * cx + w2 * sx);
      this.py.push(w0 * ey + w1 * cy + w2 * sy);
      if (i > 0) this.cum.push(this.cum[i - 1] + Math.hypot(this.px[i] - this.px[i - 1], this.py[i] - this.py[i - 1]));
    }
    this.length = this.cum[SAMPLES];
  }

  pose(s: number): Pose {
    let i = 1;
    while (i < SAMPLES && this.cum[i] < s) i++;
    const seg = this.cum[i] - this.cum[i - 1] || 1;
    const f = Math.min(1, Math.max(0, (s - this.cum[i - 1]) / seg));
    const hx = (this.px[i] - this.px[i - 1]) / seg;
    const hy = (this.py[i] - this.py[i - 1]) / seg;
    return { x: this.px[i - 1] + (this.px[i] - this.px[i - 1]) * f, y: this.py[i - 1] + (this.py[i] - this.py[i - 1]) * f, hx, hy };
  }
}

// Can two movements share a junction at the same time? Conservative rules:
// same approach (they queue in one lane); opposite approaches unless exactly one turns left;
// two right turns from any approaches. Different movements into the same exit always conflict.
export function compatible(p: Connector, q: Connector): boolean {
  if (p.inLink === q.inLink) return true;
  if (p.outLink === q.outLink) return false;
  const opposite = p.inDx * q.inDx + p.inDy * q.inDy < -0.5;
  if (opposite) return (p.kind === 'left') === (q.kind === 'left');
  return p.kind === 'right' && q.kind === 'right';
}
