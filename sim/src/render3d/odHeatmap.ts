import type { Simulation } from '../sim';
import type { Period } from '../core/time';
import { DISTRICTS, districtShares } from '../demand/districts';

// Sequential blue on the dark panel: near-zero recedes into the surface.
const LOW = [0x0e, 0x14, 0x1c];
const HIGH = [0x6f, 0xa8, 0xf0];
const LABEL_W = 30; // px, row labels on the left
const LABEL_H = 16; // px, column labels on top
const SHORT = DISTRICTS.map((d) => (d === 'Downtown' ? 'DT' : d));
const K = DISTRICTS.length;

// District x district OD matrix, rows = origins. Colour: the model's share of trips for the
// current period. Number: trips actually generated between the two districts in the last
// sim hour, so the panel shows the demand model and the trips it produced side by side.
export class OdHeatmap {
  private ctx: CanvasRenderingContext2D;
  private shares: Float64Array | null = null;
  private observed: Int32Array = new Int32Array(K * K);
  private period: Period | null = null;
  private cell = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private tooltip: HTMLElement,
    private sim: Simulation,
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointermove', (e) => this.hover(e));
    canvas.addEventListener('pointerleave', () => (this.tooltip.hidden = true));
  }

  update(period: Period): void {
    if (period !== this.period) {
      this.period = period;
      this.shares = districtShares(this.sim.district, this.sim.trips.odShares(period));
    }
    this.observed = this.sim.observedDistrictOd();
    this.draw();
  }

  topPairs(k: number): { o: number; d: number; share: number }[] {
    if (!this.shares) return [];
    return Array.from(this.shares, (share, i) => ({ o: Math.floor(i / K), d: i % K, share }))
      .sort((a, b) => b.share - a.share)
      .slice(0, k);
  }

  private draw(): void {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    this.cell = Math.min((size - LABEL_W) / K, (size - LABEL_H) / K);
    const c = this.cell;
    const shares = this.shares!;
    const max = Math.max(...shares);

    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(220, 228, 234, 0.6)';
    for (let k = 0; k < K; k++) {
      ctx.fillText(SHORT[k], LABEL_W + (k + 0.5) * c, LABEL_H / 2); // destinations across the top
      ctx.fillText(SHORT[k], LABEL_W / 2, LABEL_H + (k + 0.5) * c); // origins down the side
    }
    for (let o = 0; o < K; o++) {
      for (let d = 0; d < K; d++) {
        // Square root so the many small flows stay visible next to downtown's large share.
        const t = max > 0 ? Math.sqrt(shares[o * K + d] / max) : 0;
        const rgb = LOW.map((lo, i) => Math.round(lo + (HIGH[i] - lo) * t));
        const x = LABEL_W + d * c;
        const y = LABEL_H + o * c;
        ctx.fillStyle = `rgb(${rgb.join(',')})`;
        ctx.fillRect(x + 0.5, y + 0.5, c - 1, c - 1);
        const n = this.observed[o * K + d];
        if (n === 0) continue;
        ctx.fillStyle = t > 0.55 ? '#08131c' : 'rgba(230, 237, 243, 0.9)';
        ctx.fillText(n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n), x + c / 2, y + c / 2 + 0.5);
      }
    }
  }

  private hover(e: PointerEvent): void {
    if (!this.shares) return;
    const rect = this.canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left - LABEL_W) / this.cell);
    const row = Math.floor((e.clientY - rect.top - LABEL_H) / this.cell);
    if (row < 0 || col < 0 || row >= K || col >= K) {
      this.tooltip.hidden = true;
      return;
    }
    const i = row * K + col;
    const total = this.observed.reduce((a, b) => a + b, 0);
    const seen = this.observed[i];
    this.tooltip.textContent =
      `${DISTRICTS[row]} → ${DISTRICTS[col]} · model ${(this.shares[i] * 100).toFixed(1)}% · ` +
      `last hour ${seen} trips (${total > 0 ? ((seen / total) * 100).toFixed(1) : '0'}%)`;
    this.tooltip.hidden = false;
  }
}
