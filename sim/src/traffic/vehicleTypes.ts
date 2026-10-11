import type { ZoneType } from '../demand/zones';

// Vehicle types. Length and acceleration feed the traffic model, so a truck takes more
// road and pulls away more slowly than a hatchback.

export type VehicleKind = 'hatchback' | 'sedan' | 'taxi' | 'suv' | 'pickup' | 'van' | 'truck';
export const VEHICLE_KINDS: VehicleKind[] = ['hatchback', 'sedan', 'taxi', 'suv', 'pickup', 'van', 'truck'];

export interface VehicleSpec {
  length: number; // m, bumper to bumper
  accel: number; // IDM maximum acceleration, m/s²
}

export const VEHICLE_SPECS: Record<VehicleKind, VehicleSpec> = {
  hatchback: { length: 3.9, accel: 1.7 },
  sedan: { length: 4.6, accel: 1.5 },
  taxi: { length: 4.6, accel: 1.5 },
  suv: { length: 4.9, accel: 1.4 },
  pickup: { length: 5.4, accel: 1.3 },
  van: { length: 5.5, accel: 1.2 },
  truck: { length: 8.5, accel: 0.9 },
};

// Stable per-trip pseudo-random number in [0, 1). Does not touch the sim RNG, so adding
// vehicle types leaves demand and routing unchanged.
export function hash01(n: number, salt: number): number {
  let x = Math.imul(n ^ salt, 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0; // keep it unsigned
  return x / 4294967296;
}

// Trips to or from industrial zones are mostly trucks and vans; some downtown trips are taxis.
export function vehicleKindFor(tripId: number, origin: ZoneType, dest: ZoneType): VehicleKind {
  const h = hash01(tripId, 0x9e37);
  if (origin === 'industrial' || dest === 'industrial') {
    if (h < 0.15) return 'truck';
    if (h < 0.35) return 'van';
    if (h < 0.45) return 'pickup';
  }
  if ((origin === 'commercial' || dest === 'commercial') && h > 0.93) return 'taxi';
  const k = hash01(tripId, 0x51ed);
  if (k < 0.36) return 'sedan';
  if (k < 0.58) return 'hatchback';
  if (k < 0.82) return 'suv';
  if (k < 0.91) return 'pickup';
  if (k < 0.97) return 'van';
  return 'truck';
}
