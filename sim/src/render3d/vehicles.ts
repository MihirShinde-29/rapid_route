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
const WHITE = new THREE.Color(0.95, 0.95, 0.95);
const RED_LENS = new THREE.Color(0.45, 0.04, 0.04);
const BLUE_LENS = new THREE.Color(0.05, 0.1, 0.5);
const STRIPE = new THREE.Color(0.75, 0.08, 0.08);
const CHROME = new THREE.Color(0.75, 0.76, 0.78);
// Emergency units are painted white (see vehiclePaint) with their livery in the model, since the
// paint colour multiplies every part.
const POLICE_BLUE = new THREE.Color(0x1d2c4c);
const FIRE_RED = new THREE.Color(0xc0261d);

const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);

// Model geometry plus its night lights (head/tail glow and a beam on the road).
// worldPerM converts metres to world units; W is the car width in world units; +x is forward.
export function vehicleGeometry(
  kind: VehicleKind,
  worldPerM: number,
  W: number,
): {
  body: THREE.BufferGeometry;
  lights: THREE.BufferGeometry;
  brake: THREE.BufferGeometry;
  indicatorL: THREE.BufferGeometry;
  indicatorR: THREE.BufferGeometry;
  // Emergency units only: the two sets of siren lamps, flashed alternately.
  sirenA: THREE.BufferGeometry | null;
  sirenB: THREE.BufferGeometry | null;
} {
  const b = new StaticBatch();
  // Siren lamps (x along the car, y height, z across), as lenses on the body and glows over them.
  const lamps: { x: number; y: number; z: number; w: number; a: boolean }[] = [];
  const lightBar = (x: number, y: number) => {
    b.add(box(0.05, 0.016, W * 0.74), TRIM, x, y, 0);
    for (const side of [-1, 1]) lamps.push({ x, y: y + 0.02, z: side * W * 0.19, w: W * 0.32, a: side < 0 });
  };
  const len = VEHICLE_SPECS[kind].length * worldPerM;
  let lightY = 0.11;
  let wheelR = 0.048;
  switch (kind) {
    case 'police':
      // A sedan in navy with white doors and a light bar.
      b.add(box(len, 0.1, W), POLICE_BLUE, 0, 0.095, 0);
      b.add(box(len * 0.4, 0.06, W * 1.01), WHITE, -len * 0.02, 0.1, 0);
      b.add(box(len * 0.5, 0.085, W * 0.84), GLASS, -len * 0.04, 0.187, 0);
      b.add(box(len * 0.4, 0.02, W * 0.86), POLICE_BLUE, -len * 0.05, 0.235, 0);
      b.add(box(0.012, 0.05, W * 0.8), TRIM, len / 2 + 0.006, 0.08, 0); // push bar
      lightBar(-len * 0.04, 0.245);
      break;
    case 'ambulance':
      // A cab in front of a tall box body, red stripe, light bar on the cab and lamps on the box.
      b.add(box(len * 0.26, 0.17, W), BODY, len * 0.37, 0.13, 0);
      b.add(box(0.012, 0.07, W * 0.86), GLASS, len / 2, 0.18, 0);
      b.add(box(len * 0.2, 0.06, W * 1.01), GLASS, len * 0.37, 0.18, 0);
      b.add(box(len * 0.74, 0.28, W * 1.06), BODY, -len * 0.13, 0.185, 0);
      b.add(box(len * 0.74, 0.035, W * 1.07), STRIPE, -len * 0.13, 0.15, 0);
      b.add(box(0.012, 0.1, W * 0.4), GLASS, -len / 2 - 0.006, 0.2, 0); // rear door windows
      lightBar(len * 0.37, 0.215);
      for (const [x, a] of [[len * 0.23, false], [-len * 0.49, true]] as const) {
        for (const side of [-1, 1]) lamps.push({ x, y: 0.33, z: side * W * 0.46, w: W * 0.12, a: a === side < 0 });
      }
      lightY = 0.1;
      break;
    case 'fire':
      // A red cab and body with a white band, a ladder on top and a light bar on the cab.
      wheelR = 0.055;
      lightY = 0.1;
      b.add(box(len * 0.24, 0.22, W), FIRE_RED, len * 0.38, 0.145, 0);
      b.add(box(0.012, 0.08, W * 0.86), GLASS, len / 2, 0.2, 0);
      b.add(box(len * 0.18, 0.07, W * 1.01), GLASS, len * 0.4, 0.2, 0);
      b.add(box(len * 0.76, 0.24, W * 1.04), FIRE_RED, -len * 0.12, 0.165, 0);
      b.add(box(len * 1.0, 0.03, W * 1.06), WHITE, 0, 0.1, 0);
      b.add(box(len * 0.76, 0.03, W * 0.9), TRIM, -len * 0.12, 0.04, 0); // chassis
      for (const side of [-1, 1]) b.add(box(len * 0.8, 0.018, 0.02), CHROME, -len * 0.08, 0.3, side * W * 0.24);
      for (let k = 0; k < 9; k++) b.add(box(0.012, 0.012, W * 0.48), CHROME, -len * 0.46 + k * len * 0.1, 0.3, 0);
      lightBar(len * 0.38, 0.257);
      break;
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
  // Turn indicators at the four corners (+z is the car's right), switched like the brake lights.
  const indicator = (side: number) => {
    const g = new StaticBatch();
    for (const end of [-1, 1]) g.add(box(0.03, 0.035, W * 0.14), BODY, end * (len / 2 + 0.006), lightY + 0.012, side * W * 0.44);
    return g.geometry();
  };
  // Siren lamps: red lenses on one side, blue on the other; their glows are switched per vehicle.
  let sirenA: THREE.BufferGeometry | null = null;
  let sirenB: THREE.BufferGeometry | null = null;
  if (lamps.length > 0) {
    const ga = new StaticBatch();
    const gb = new StaticBatch();
    for (const p of lamps) {
      b.add(box(0.035, 0.022, p.w), p.a ? RED_LENS : BLUE_LENS, p.x, p.y, p.z);
      (p.a ? ga : gb).add(box(0.08, 0.05, p.w * 1.25), BODY, p.x, p.y, p.z);
    }
    sirenA = ga.geometry();
    sirenB = gb.geometry();
  }
  return { body: b.geometry(), lights, brake: k.geometry(), indicatorL: indicator(-1), indicatorR: indicator(1), sirenA, sirenB };
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
  if (kind === 'ambulance' || kind === 'fire' || kind === 'police') return out.setHex(0xf4f4f4);
  if (kind === 'truck' || kind === 'van') return out.setHex(FLEET[Math.floor(h * FLEET.length)]);
  let acc = 0;
  for (const [hex, share] of PAINT) {
    acc += share;
    if (h < acc) return out.setHex(hex);
  }
  return out.setHex(PAINT[0][0]);
}
