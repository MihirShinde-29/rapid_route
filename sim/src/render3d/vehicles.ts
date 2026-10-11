import * as THREE from 'three';
import { StaticBatch } from './batch';
import type { Trip } from '../demand/trips';
import { hash01, VEHICLE_SPECS, type VehicleKind } from '../traffic/vehicleTypes';

// Vehicle models for rendering, one per type in traffic/vehicleTypes.ts. Each model is
// built at its type's real length, the same length the traffic model uses.

const BODY = new THREE.Color(1, 1, 1); // takes the per-vehicle paint colour
const GLASS = new THREE.Color(0.16, 0.19, 0.24);
const TYRE = new THREE.Color(0.05, 0.05, 0.05);
const TRIM = new THREE.Color(0.22, 0.22, 0.24);
const HEAD = new THREE.Color(1, 1, 0.85);
const TAIL = new THREE.Color(1, 0.08, 0.06);
const HEAD_GLOW = new THREE.Color(1, 0.92, 0.75);
const TAIL_GLOW = new THREE.Color(0.9, 0.05, 0.03);

const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);

// Model geometry plus its night lights (head/tail glow and a beam on the road).
// worldPerM converts metres to world units; W is the car width in world units; +x is forward.
export function vehicleGeometry(
  kind: VehicleKind,
  worldPerM: number,
  W: number,
): { body: THREE.BufferGeometry; lights: THREE.BufferGeometry; brake: THREE.BufferGeometry } {
  const b = new StaticBatch();
  const len = VEHICLE_SPECS[kind].length * worldPerM;
  let lightY = 0.11;
  let wheelR = 0.048;
  switch (kind) {
    case 'sedan':
    case 'taxi':
      b.add(box(len, 0.1, W), BODY, 0, 0.095, 0);
      b.add(box(len * 0.5, 0.085, W * 0.84), GLASS, -len * 0.04, 0.187, 0);
      b.add(box(len * 0.4, 0.02, W * 0.86), BODY, -len * 0.05, 0.235, 0);
      if (kind === 'taxi') b.add(box(0.07, 0.035, W * 0.4), new THREE.Color(1, 1, 0.8), -len * 0.05, 0.262, 0);
      break;
    case 'hatchback':
      b.add(box(len, 0.1, W * 0.96), BODY, 0, 0.095, 0);
      b.add(box(len * 0.58, 0.09, W * 0.82), GLASS, -len * 0.1, 0.19, 0);
      b.add(box(len * 0.5, 0.02, W * 0.84), BODY, -len * 0.12, 0.24, 0);
      break;
    case 'suv':
      wheelR = 0.056;
      lightY = 0.14;
      b.add(box(len, 0.14, W * 1.04), BODY, 0, 0.12, 0);
      b.add(box(len * 0.62, 0.09, W * 0.9), GLASS, -len * 0.06, 0.235, 0);
      b.add(box(len * 0.58, 0.02, W * 0.92), BODY, -len * 0.06, 0.288, 0);
      b.add(box(len * 0.5, 0.012, 0.012), TRIM, -len * 0.06, 0.304, W * 0.36); // roof rails
      b.add(box(len * 0.5, 0.012, 0.012), TRIM, -len * 0.06, 0.304, -W * 0.36);
      break;
    case 'pickup':
      wheelR = 0.054;
      lightY = 0.12;
      b.add(box(len, 0.11, W), BODY, 0, 0.1, 0);
      b.add(box(len * 0.3, 0.09, W * 0.84), GLASS, len * 0.1, 0.2, 0); // cab
      b.add(box(len * 0.26, 0.02, W * 0.86), BODY, len * 0.09, 0.25, 0);
      b.add(box(len * 0.42, 0.012, W * 0.84), TRIM, -len * 0.26, 0.158, 0); // open bed
      break;
    case 'van':
      b.add(box(len, 0.22, W), BODY, 0, 0.155, 0);
      b.add(box(0.012, 0.08, W * 0.86), GLASS, len / 2, 0.21, 0); // windscreen
      b.add(box(len * 0.22, 0.07, W * 1.01), GLASS, len * 0.34, 0.21, 0); // cab side windows
      lightY = 0.1;
      break;
    case 'truck':
      wheelR = 0.055;
      lightY = 0.1;
      b.add(box(len * 0.28, 0.2, W), BODY, len * 0.36, 0.145, 0); // cab
      b.add(box(0.012, 0.08, W * 0.86), GLASS, len / 2, 0.2, 0);
      b.add(box(len * 0.7, 0.32, W * 1.06), new THREE.Color(0.9, 0.9, 0.92), -len * 0.15, 0.215, 0); // cargo box
      b.add(box(len * 0.7, 0.03, W * 0.9), TRIM, -len * 0.15, 0.04, 0); // chassis
      break;
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.add(new THREE.CylinderGeometry(wheelR, wheelR, 0.04, 10), TYRE, sx * len * 0.31, wheelR, sz * W * 0.47, Math.PI / 2);
    b.add(box(0.012, 0.025, W * 0.22), HEAD, len / 2, lightY, sx * W * 0.3);
    b.add(box(0.012, 0.025, W * 0.22), TAIL, -len / 2, lightY, sx * W * 0.3);
  }

  const l = new StaticBatch();
  for (const sx of [-1, 1]) {
    l.add(box(0.016, 0.032, W * 0.24), HEAD_GLOW, len / 2 + 0.005, lightY, sx * W * 0.3);
    l.add(box(0.016, 0.032, W * 0.24), TAIL_GLOW, -len / 2 - 0.005, lightY, sx * W * 0.3);
  }
  const beamLength = 1.4;
  const beamStart = l.add(new THREE.PlaneGeometry(beamLength, W * 1.2), HEAD_GLOW, len / 2 + beamLength / 2, 0.015, 0, -Math.PI / 2);
  const lights = l.geometry();
  // Fade the beam out with distance and widen it into a cone.
  const pos = lights.attributes.position as THREE.BufferAttribute;
  const col = lights.attributes.color as THREE.BufferAttribute;
  for (let v = beamStart; v < beamStart + 4; v++) {
    const far = pos.getX(v) > len / 2 + beamLength / 2;
    if (far) pos.setZ(v, pos.getZ(v) * 1.8);
    const k = far ? 0 : 0.45;
    col.setXYZ(v, HEAD_GLOW.r * k, HEAD_GLOW.g * k, HEAD_GLOW.b * k);
  }
  // Brake lights: slightly larger than the tail lights, switched per vehicle by instance colour.
  const k = new StaticBatch();
  for (const sx of [-1, 1]) k.add(box(0.02, 0.04, W * 0.27), BODY, -len / 2 - 0.009, lightY, sx * W * 0.3);
  return { body: b.geometry(), lights, brake: k.geometry() };
}

// Common real-world paint colours with rough market shares.
const PAINT: [number, number][] = [
  [0xe9e9ea, 0.2], // white
  [0x1b1c1f, 0.17], // black
  [0xa9aeb5, 0.16], // silver
  [0x5b6068, 0.13], // grey
  [0x24467e, 0.09], // blue
  [0x9b1f1f, 0.09], // red
  [0x2e5238, 0.04], // green
  [0xb9a684, 0.05], // beige
  [0x6a1e3a, 0.03], // maroon
  [0xd0862a, 0.04], // orange
];
const FLEET: number[] = [0xf2f2f2, 0xe9e9ea, 0xc8ccd0, 0x2a5aa0, 0xb02a2a]; // delivery liveries

export function vehiclePaint(trip: Trip, kind: VehicleKind, out: THREE.Color): THREE.Color {
  const h = hash01(trip.id, 0x2c1b);
  if (kind === 'taxi') return out.setHex(0xf2c21a);
  if (kind === 'truck' || kind === 'van') return out.setHex(FLEET[Math.floor(h * FLEET.length)]);
  let acc = 0;
  for (const [hex, share] of PAINT) {
    acc += share;
    if (h < acc) return out.setHex(hex);
  }
  return out.setHex(PAINT[0][0]);
}
