import { pick, poisson, sampleCdf, type Rng } from '../core/rng';
import { periodAt, volumeFactor, HOUR, type Period } from '../core/time';
import { gravityOd } from './od';
import type { Zone } from './zones';
import type { Site, SiteKind } from '../city/sites';
import { vehicleKindFor, type VehicleKind } from '../traffic/vehicleTypes';

// Share of trips that go out to a park, the mall or a plaza instead of their usual destination.
const LEISURE_SHARE: Record<Period, number> = { am: 0.04, midday: 0.22, pm: 0.12, evening: 0.3, night: 0.06 };
const LEISURE_KINDS: SiteKind[] = ['park', 'mall', 'plaza'];
const LEISURE_PULL: Partial<Record<SiteKind, number>> = { mall: 4 };
const LEISURE_SPEED = 10; // m/s, crow-flies distance to time for the distance decay

export interface Trip {
  id: number;
  originZone: number;
  destZone: number;
  originNode: number;
  destNode: number;
  departTime: number; // s since midnight
  kind?: VehicleKind; // unset means a standard 4.5 m car
  // Driveway positions, m along the first and last lane. Unset: DEPART_FRAC / ARRIVE_FRAC of it.
  departPos?: number;
  arrivePos?: number;
  // Crossing the other lane: pulling out to the left, or turning left into the destination.
  departLeft?: boolean;
  arriveLeft?: boolean;
  originSite?: number; // generated trips run from one site's entrance to another's
  destSite?: number;
}

export interface TripGenOptions {
  peakTripsPerHour: number; // citywide rate at volumeFactor = 1
  beta: number; // gravity distance decay, 1/s
}

// Poisson trip arrivals at a time-of-day rate; OD pair drawn from the current period's gravity
// matrix, then a site in each zone weighted by its size. Some trips go to a park, the mall or a
// plaza instead, the nearer and bigger the likelier.
export class TripGenerator {
  private cdfs = new Map<Period, Float64Array>();
  private siteCdfs: { ids: number[]; cdf: Float64Array }[];
  private leisure: Site[];
  private leisureCdfs = new Map<number, Float64Array>();
  private nextId = 0;

  constructor(
    private zones: Zone[],
    private cost: Float64Array,
    private rng: Rng,
    readonly opts: TripGenOptions,
    sites: readonly Site[] = [],
  ) {
    this.siteCdfs = zones.map((z) => {
      const ids = sites.filter((s) => s.zone === z.id).map((s) => s.id);
      return { ids, cdf: cumulative(ids.map((id) => sites[id].size)) };
    });
    // A zone without sites of its own (part of a superblock, or no street to open onto) uses
    // the nearest zone that has some.
    const own = this.siteCdfs.slice();
    zones.forEach((z, k) => {
      if (own[k].ids.length > 0) return;
      let best = -1;
      for (let j = 0; j < zones.length; j++) {
        if (own[j].ids.length === 0 || zones[j].type === 'park') continue;
        if (best < 0 || Math.hypot(zones[j].cx - z.cx, zones[j].cy - z.cy) < Math.hypot(zones[best].cx - z.cx, zones[best].cy - z.cy)) best = j;
      }
      if (best >= 0) this.siteCdfs[k] = own[best];
    });
    this.leisure = sites.filter((s) => LEISURE_KINDS.includes(s.kind));
  }

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
    const period = periodAt(t);
    const cdf = this.cdf(period);
    const n = this.zones.length;
    for (let k = 0; k < count; k++) {
      const cell = sampleCdf(this.rng, cdf);
      const o = this.zones[Math.floor(cell / n)];
      let d = this.zones[cell % n];
      const originSite = this.siteIn(o);
      let destSite = this.siteIn(d);
      if (originSite !== undefined && this.leisure.length > 0 && this.rng() < LEISURE_SHARE[period]) {
        const site = this.leisure[sampleCdf(this.rng, this.leisureCdf(o))];
        if (site.id !== originSite) {
          destSite = site.id;
          d = this.zones[site.zone];
        }
      }
      const id = this.nextId++;
      const trip: Trip = {
        id,
        originZone: o.id,
        destZone: d.id,
        originNode: -1,
        destNode: -1,
        departTime: t,
        kind: vehicleKindFor(id, o.type, d.type),
      };
      if (originSite !== undefined && destSite !== undefined && destSite !== originSite) {
        trip.originSite = originSite;
        trip.destSite = destSite;
      } else {
        // Adjacent zones share corners; avoid zero-length trips.
        trip.originNode = pick(this.rng, o.accessNodes);
        trip.destNode = pick(this.rng, d.accessNodes.filter((x) => x !== trip.originNode));
      }
      trips.push(trip);
    }
    return trips;
  }

  private siteIn(z: Zone): number | undefined {
    const { ids, cdf } = this.siteCdfs[z.id];
    return ids.length > 0 ? ids[sampleCdf(this.rng, cdf)] : undefined;
  }

  private leisureCdf(o: Zone): Float64Array {
    let cdf = this.leisureCdfs.get(o.id);
    if (!cdf) {
      cdf = cumulative(
        this.leisure.map((s) => {
          const time = Math.hypot(s.door.x - o.cx, s.door.y - o.cy) / LEISURE_SPEED;
          return Math.sqrt(s.size) * (LEISURE_PULL[s.kind] ?? 1) * Math.exp(-this.opts.beta * time);
        }),
      );
      this.leisureCdfs.set(o.id, cdf);
    }
    return cdf;
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

function cumulative(weights: number[]): Float64Array {
  const cdf = new Float64Array(weights);
  for (let k = 1; k < cdf.length; k++) cdf[k] += cdf[k - 1];
  return cdf;
}
