import { pick, poisson, sampleCdf, type Rng } from '../core/rng';
import { periodAt, volumeFactor, HOUR, type Period } from '../core/time';
import { gravityOd } from './od';
import type { Zone } from './zones';

export interface Trip {
  id: number;
  originZone: number;
  destZone: number;
  originNode: number;
  destNode: number;
  departTime: number; // s since midnight
}

export interface TripGenOptions {
  peakTripsPerHour: number; // citywide rate at volumeFactor = 1
  beta: number; // gravity distance decay, 1/s
}

// Poisson trip arrivals at a time-of-day rate; OD pair drawn from the
// current period's gravity matrix.
export class TripGenerator {
  private cdfs = new Map<Period, Float64Array>();
  private nextId = 0;

  constructor(
    private zones: Zone[],
    private cost: Float64Array,
    private rng: Rng,
    readonly opts: TripGenOptions,
  ) {}

  ratePerHour(t: number): number {
    return this.opts.peakTripsPerHour * volumeFactor(t);
  }

  odShares(period: Period): Float64Array {
    return gravityOd(this.zones, this.cost, period, this.opts.beta);
  }

  step(t: number, dt: number): Trip[] {
    const count = poisson(this.rng, (this.ratePerHour(t) / HOUR) * dt);
    const trips: Trip[] = [];
    if (count === 0) return trips;
    const cdf = this.cdf(periodAt(t));
    const n = this.zones.length;
    for (let k = 0; k < count; k++) {
      const cell = sampleCdf(this.rng, cdf);
      const o = this.zones[Math.floor(cell / n)];
      const d = this.zones[cell % n];
      const originNode = pick(this.rng, o.accessNodes);
      // Adjacent zones share corners; avoid zero-length trips.
      const destChoices = d.accessNodes.filter((x) => x !== originNode);
      trips.push({
        id: this.nextId++,
        originZone: o.id,
        destZone: d.id,
        originNode,
        destNode: pick(this.rng, destChoices),
        departTime: t,
      });
    }
    return trips;
  }

  private cdf(period: Period): Float64Array {
    let cdf = this.cdfs.get(period);
    if (!cdf) {
      cdf = this.odShares(period);
      for (let k = 1; k < cdf.length; k++) cdf[k] += cdf[k - 1];
      this.cdfs.set(period, cdf);
    }
    return cdf;
  }
}
