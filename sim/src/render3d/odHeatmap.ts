import type { Simulation } from '../sim';
import type { Period } from '../core/time';
import type { ZoneType } from '../demand/zones';

const TYPE_ORDER: ZoneType[] = ['residential', 'commercial', 'industrial', 'park'];
const TYPE_CSS: Record<ZoneType, string> = {
  residential: '#3987e5',
  commercial: '#d95926',
  industrial: '#199e70',
  park: '#4e5a65',
};
const TYPE_SHORT: Record<ZoneType, string> = {
  residential: 'Res',
  commercial: 'Com',
  industrial: 'Ind',
  park: 'Park',
};

// Sequential blue on the dark panel: near-zero recedes into the surface.
const LOW = [0x0e, 0x14, 0x1c];
const HIGH = [0xcd, 0xe2, 0xfb];
const BAND = 5; // px, zone-type strip along each axis

export function zoneLabel(sim: Simulation, id: number): string {
  const b = sim.grid.blocks[id];
  return `${TYPE_SHORT[sim.zones[id].type]} ${b.r}·${b.c}`;
}

// Zones x zones OD share matrix for the current period, rows = origins.
export class OdHeatmap {
  private ctx: CanvasRenderingContext2D;
  private order: number[];
  private shares: Float64Array | null = null;
  private period: Period | null = null;
  private cell = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private tooltip: HTMLElement,
    private sim: Simulation,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.order = sim.zones
      .map((z) => z.id)
      .sort((a, b) => TYPE_ORDER.indexOf(sim.zones[a].type) - TYPE_ORDER.indexOf(sim.zones[b].type) || a - b);
    canvas.addEventListener('pointermove', (e) => this.hover(e));
    canvas.addEventListener('pointerleave', () => (this.tooltip.hidden = true));
  }

  update(period: Period): void {
    if (period === this.period) return;
    this.period = period;
    this.shares = this.sim.trips.odShares(period);
    this.draw();
  }

  topPairs(k: number): { o: number; d: number; share: number }[] {
    if (!this.shares) return [];
    const n = this.sim.zones.length;
    const all: { o: number; d: number; share: number }[] = [];
    this.shares.forEach((share, idx) => {
      if (share > 0) all.push({ o: Math.floor(idx / n), d: idx % n, share });
    });
    return all.sort((a, b) => b.share - a.share).slice(0, k);
  }

  private draw(): void {
    const { canvas, ctx, sim } = this;
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = this.order.length;
    this.cell = (size - BAND - 2) / n;
    const shares = this.shares!;
    let max = 0;
    for (const s of shares) max = Math.max(max, s);

    ctx.clearRect(0, 0, size, size);
    for (let a = 0; a < n; a++) {
      const zt = sim.zones[this.order[a]].type;
      ctx.fillStyle = TYPE_CSS[zt];
      ctx.fillRect(0, BAND + 2 + a * this.cell, BAND, this.cell); // origin strip (left)
      ctx.fillRect(BAND + 2 + a * this.cell, 0, this.cell, BAND); // destination strip (top)
    }
    // One pixel per OD pair, then scaled into place: hundreds of zones means far more
    // cells than screen pixels, so per-cell fillRect would be slow and blurry anyway.
    const nZ = sim.zones.length;
    const img = new ImageData(n, n);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const v = shares[this.order[a] * nZ + this.order[b]];
        const t = max > 0 ? Math.sqrt(v / max) : 0;
        const i = (a * n + b) * 4;
        for (let k = 0; k < 3; k++) img.data[i + k] = Math.round(LOW[k] + (HIGH[k] - LOW[k]) * t);
        img.data[i + 3] = 255;
      }
    }
    const off = document.createElement('canvas');
    off.width = off.height = n;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = n > size; // downsampling: average; upsampling: crisp cells
    ctx.drawImage(off, BAND + 2, BAND + 2, n * this.cell, n * this.cell);
  }

  private hover(e: PointerEvent): void {
    if (!this.shares) return;
    const rect = this.canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left - BAND - 2) / this.cell);
    const row = Math.floor((e.clientY - rect.top - BAND - 2) / this.cell);
    const n = this.order.length;
    if (row < 0 || col < 0 || row >= n || col >= n) {
      this.tooltip.hidden = true;
      return;
    }
    const o = this.order[row];
    const d = this.order[col];
    const share = this.shares[o * this.sim.zones.length + d];
    const perHour = share * this.sim.trips.ratePerHour(this.sim.time);
    this.tooltip.textContent = `${zoneLabel(this.sim, o)} → ${zoneLabel(this.sim, d)} · ${(share * 100).toFixed(2)}% · ≈${perHour.toFixed(0)} trips/h now`;
    this.tooltip.hidden = false;
  }
}
