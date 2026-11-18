import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Street life (visual only, the simulation never sees it): people walking round the blocks on the
// pavements, and parked cars in car parks and on house driveways. Both follow the time of day:
// downtown fills up by day and empties at night, driveways empty when people drive to work.

// A walk round one block: its pavement as a closed loop of corners (world x, z), at height y.
export interface WalkRing {
  pts: THREE.Vector2[];
  y: number;
  kind: 'downtown' | 'park' | 'residential' | 'industrial';
  people: number; // walkers on the busiest hour
}

// A parking space: a bay in a car park or a house's driveway. `rot` turns the car's +x (its front).
export interface ParkSpot {
  x: number;
  y: number;
  z: number;
  rot: number;
  kind: 'shops' | 'work' | 'home';
  seed: number;
}

// Share of walkers out, or of spaces taken, through the day; [hour, value] points joined by lines.
const OUT: Record<WalkRing['kind'] | ParkSpot['kind'], [number, number][]> = {
  downtown: [[0, 0.06], [6, 0.08], [8, 0.65], [12, 1], [14, 0.85], [17.5, 0.9], [20, 0.45], [23, 0.12], [24, 0.06]],
  park: [[0, 0], [6, 0.05], [8, 0.35], [12, 0.8], [16, 1], [19, 0.6], [21, 0.1], [24, 0]],
  residential: [[0, 0.02], [6, 0.06], [8, 0.35], [12, 0.3], [17, 0.45], [20, 0.35], [22, 0.08], [24, 0.02]],
  industrial: [[0, 0.03], [6, 0.25], [8, 0.6], [12, 0.6], [17, 0.4], [19, 0.08], [24, 0.03]],
  shops: [[0, 0.08], [7, 0.12], [10, 0.7], [13, 0.92], [17, 0.8], [20, 0.45], [22, 0.12], [24, 0.08]],
  work: [[0, 0.12], [6, 0.2], [9, 0.85], [16, 0.85], [18, 0.35], [21, 0.15], [24, 0.12]],
  home: [[0, 0.92], [6, 0.9], [8.5, 0.4], [16, 0.38], [18.5, 0.8], [21, 0.92], [24, 0.92]],
};

export function share(kind: keyof typeof OUT, hour: number): number {
  const pts = OUT[kind];
  const h = ((hour % 24) + 24) % 24;
  for (let k = 1; k < pts.length; k++) {
    const [h1, v1] = pts[k];
    if (h <= h1) {
      const [h0, v0] = pts[k - 1];
      return v0 + ((v1 - v0) * (h - h0)) / Math.max(1e-6, h1 - h0);
    }
  }
  return pts[pts.length - 1][1];
}

const WALK_SPEED = 1.35; // m/s, real time: people walk at walking pace whatever the sim speed
const PARK_NEAR = 60; // world units: Kit parked cars within this, simple ones beyond
const WALK_NEAR = 130; // world units from the camera; past it a person is a pixel or two
const CLOTHES = [0x2f4a7a, 0x8a2b2b, 0x3d6b45, 0xd8d2c4, 0x22252b, 0x6b5b95, 0xc9822f, 0x4f5b66, 0xb34d6d, 0x1f6f78];
const PAINTS = [0xe9e9ea, 0x1b1c1f, 0xa9aeb5, 0x5b6068, 0x24467e, 0x9b1f1f, 0x2f5d3a, 0xc9c2b0];
const SKIN = [0xf1c9a5, 0xe0ac7e, 0xc68a5c, 0x8d5a3b, 0x5c3a26];
const TROUSERS = [0x2b3a55, 0x1d1f24, 0x6b6250, 0x4a4f57, 0x34465f, 0x5a3d2b];
const HAIR = [0x1a1410, 0x3b2516, 0x6b4a2b, 0xb08a4f, 0x8a8a8a, 0x111111];
// Body parts, metres (scaled up a little so people read from street view). Each part is drawn
// as its own instanced mesh so legs and arms can swing as people walk.
const PERSON_SCALE = 1.15;
const HIP_Y = 0.92;
const SHOULDER_Y = 1.42;
const STRIDE = 0.45; // leg swing, radians either way
const ARM_SWING = 0.35;
const UMBRELLA_ARM = 0.75; // radians forward of hanging, for the arm holding an umbrella
const UMBRELLAS = [0x1b1c20, 0x1b1c20, 0x24324f, 0xa3262a, 0xe0b62c, 0x2f6b4a, 0x6a3d7c, 0x3d8fc4];

interface Walker {
  i: number; // its own colours' index
  ring: number;
  s: number; // distance along the ring, world units
  dir: 1 | -1;
  side: number; // across the pavement, -0.5..0.5
  speed: number; // world units a second
  seed: number; // out when seed < share
  phase: number;
}

export class StreetLife {
  readonly group = new THREE.Group();
  private walkers: Walker[] = [];
  private lens: number[];
  // Legs and arms (left, right), torso, head and hair: one instanced mesh each.
  private parts: { mesh: THREE.InstancedMesh; colors: THREE.Color[]; pivot: THREE.Vector3 | null; swing: number; rain?: 'only' | 'hold' }[] = [];
  private rainNow = false;
  private slotOf: (Walker | undefined)[] = [];
  private base = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private out = new THREE.Matrix4();
  private shown = 0;
  // Parked cars: the Kit model (body and wheels) near the camera, the simple body further away,
  // as the moving cars do; a thousand full models in the car parks cost about 15 fps.
  private near: THREE.InstancedMesh | null = null;
  private wheels: THREE.InstancedMesh | null = null;
  private far: THREE.InstancedMesh;
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  private carMat = new THREE.Matrix4();
  private lastHour = -1;
  private lastMs = performance.now();
  // 1 on Graphics high; fewer people on medium and low.
  amount = 1;

  // In rain people hold umbrellas (the right arm raised and still) and fewer are out.
  set raining(on: boolean) {
    if (on === this.rainNow) return;
    this.rainNow = on;
    this.slotOf = []; // colour every slot again, umbrellas included
  }

  constructor(
    private rings: WalkRing[],
    private spots: ParkSpot[],
    carBody: THREE.BufferGeometry,
    carMaterial: THREE.Material,
    private worldPerM: number,
    private pavementWidth: number,
  ) {
    this.lens = rings.map((r) => r.pts.reduce((a, p, k) => a + p.distanceTo(r.pts[(k + 1) % r.pts.length]), 0));
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    rings.forEach((r, i) => {
      for (let k = 0; k < r.people; k++) {
        this.walkers.push({
          i: this.walkers.length,
          ring: i,
          s: rnd() * this.lens[i],
          dir: rnd() < 0.5 ? 1 : -1,
          side: rnd() - 0.5,
          speed: WALK_SPEED * (0.75 + 0.5 * rnd()) * worldPerM,
          seed: rnd(),
          phase: rnd() * Math.PI * 2,
        });
      }
    });
    // A person about 1.75 m tall, low-poly but shaped: legs and arms as capsules hanging from the
    // hip and shoulder, a tapered torso (wider at the shoulders, flatter front to back), a head on a
    // neck, and hair over the top and back of the head.
    const m = worldPerM * PERSON_SCALE;
    const limb = (r: number, len: number) => new THREE.CapsuleGeometry(r * m, (len - 2 * r) * m, 2, 6).translate(0, -(len / 2) * m, 0);
    const leg = limb(0.08, 0.92);
    const arm = limb(0.055, 0.62);
    const torso = mergeGeometries([
      new THREE.CylinderGeometry(0.21 * m, 0.16 * m, 0.56 * m, 8).scale(1, 1, 0.6).translate(0, 1.18 * m, 0),
      new THREE.SphereGeometry(0.16 * m, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.3, 0.5, 0.75).translate(0, 1.45 * m, 0), // shoulders
    ])!;
    const head = mergeGeometries([
      new THREE.CylinderGeometry(0.045 * m, 0.05 * m, 0.1 * m, 8).translate(0, 1.52 * m, 0), // neck
      new THREE.SphereGeometry(0.1 * m, 9, 7).scale(0.9, 1.1, 1).translate(0, 1.64 * m, 0),
    ])!;
    const hair = new THREE.SphereGeometry(0.106 * m, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.92, 1.1, 1.04).translate(0, 1.655 * m, -0.008 * m);
    const n = Math.max(1, this.walkers.length);
    const pick = (list: number[], k: number) => new THREE.Color(list[Math.floor(k) % list.length]);
    const shirt = this.walkers.map((w) => pick(CLOTHES, w.seed * 997));
    const trousers = this.walkers.map((w) => pick(TROUSERS, w.phase * 389));
    const skin = this.walkers.map((w) => pick(SKIN, w.phase * 131));
    const hairColor = this.walkers.map((w) => pick(HAIR, w.seed * 613));
    const cloth = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const flesh = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const add = (g: THREE.BufferGeometry, mat: THREE.Material, colors: THREE.Color[], pivot: THREE.Vector3 | null, swing: number, rain?: 'only' | 'hold') => {
      const mesh = new THREE.InstancedMesh(g, mat, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, colors[0] ?? new THREE.Color());
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false; // a thousand small shadows cost more than they show
      this.group.add(mesh);
      this.parts.push({ mesh, colors, pivot, swing, rain });
    };
    const hip = 0.1 * m;
    const shoulder = 0.25 * m;
    add(leg, cloth, trousers, new THREE.Vector3(-hip, HIP_Y * m, 0), STRIDE);
    add(leg, cloth, trousers, new THREE.Vector3(hip, HIP_Y * m, 0), -STRIDE);
    add(arm, cloth, shirt, new THREE.Vector3(-shoulder, SHOULDER_Y * m, 0), -ARM_SWING);
    add(arm, cloth, shirt, new THREE.Vector3(shoulder, SHOULDER_Y * m, 0), ARM_SWING, 'hold');
    add(torso, cloth, shirt, null, 0);
    add(head, flesh, skin, null, 0);
    add(hair, flesh, hairColor, null, 0);
    // Umbrella: a domed canopy of eight panels on a shaft, held in the right hand (the arm raised
    // forward, see UMBRELLA_ARM) with the canopy over the head.
    const hand = new THREE.Vector3(shoulder, (SHOULDER_Y - 0.62 * Math.cos(UMBRELLA_ARM)) * m, 0.62 * Math.sin(UMBRELLA_ARM) * m);
    const top = 2.02 * m;
    // The shaft leans in from the hand so the canopy sits over the head, a little forward.
    const crown = new THREE.Vector3(hand.x * 0.3, top, hand.z * 0.45);
    const along = crown.clone().sub(hand);
    const lean = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.clone().normalize());
    const canopy = mergeGeometries([
      new THREE.ConeGeometry(0.55 * m, 0.2 * m, 8, 1, true).translate(crown.x, top, crown.z),
      new THREE.ConeGeometry(0.03 * m, 0.06 * m, 6).translate(crown.x, top + 0.13 * m, crown.z), // the tip
    ])!;
    const shaft = mergeGeometries([
      new THREE.CylinderGeometry(0.012 * m, 0.012 * m, along.length(), 5).applyQuaternion(lean).translate((hand.x + crown.x) / 2, (hand.y + crown.y) / 2, (hand.z + crown.z) / 2),
      new THREE.CylinderGeometry(0.025 * m, 0.025 * m, 0.12 * m, 6).applyQuaternion(lean).translate(hand.x, hand.y + 0.02 * m, hand.z), // handle
    ])!;
    const umbrellaColor = this.walkers.map((w) => pick(UMBRELLAS, w.seed * 271 + w.phase * 17));
    const fabric = new THREE.MeshStandardMaterial({ roughness: 0.55, side: THREE.DoubleSide });
    add(canopy, fabric, umbrellaColor, null, 0, 'only');
    add(shaft, new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5 }), this.walkers.map(() => new THREE.Color(0xffffff)), null, 0, 'only');
    this.far = this.makeCars(carBody, carMaterial, false);
  }

  // Parked cars: `kit` is the Kit car (body, wheels, material) for near the camera, or null for
  // the simple body everywhere (Graphics low).
  setCarModel(far: THREE.BufferGeometry, farMaterial: THREE.Material, kit: { body: THREE.BufferGeometry; wheels: THREE.BufferGeometry; material: THREE.Material } | null): void {
    for (const m of [this.far, this.near, this.wheels]) {
      if (!m) continue;
      this.group.remove(m);
      m.dispose();
    }
    this.far = this.makeCars(far, farMaterial, false);
    this.near = kit ? this.makeCars(kit.body, kit.material, true) : null;
    this.wheels = kit ? this.makeCars(kit.wheels, kit.material, true, false) : null;
    this.lastHour = -1; // place them again
  }

  private makeCars(body: THREE.BufferGeometry, material: THREE.Material, shadow: boolean, painted = true): THREE.InstancedMesh {
    const cars = new THREE.InstancedMesh(body, material, Math.max(1, this.spots.length));
    if (painted) cars.setColorAt(0, new THREE.Color()); // colours are set as the cars are placed
    cars.count = 0;
    // Bounds would be worked out once, maybe before any car is placed, and then cull them all.
    cars.frustumCulled = false;
    cars.castShadow = shadow;
    cars.receiveShadow = true;
    this.group.add(cars);
    return cars;
  }

  update(hour: number, camera: THREE.Vector3): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastMs) / 1000);
    this.lastMs = now;
    this.syncCars(hour, camera);
    this.syncWalkers(hour, dt, camera);
  }

  // Which spaces are taken changes slowly: redo it every sim minute or so, or when the camera
  // has moved far enough to change which cars are near.
  private syncCars(hour: number, camera: THREE.Vector3): void {
    if (Math.abs(hour - this.lastHour) < 0.02 && camera.distanceToSquared(this.lastCam) < 25) return;
    this.lastHour = hour;
    this.lastCam.copy(camera);
    const shares = { shops: share('shops', hour), work: share('work', hour), home: share('home', hour) };
    const near2 = this.near ? PARK_NEAR * PARK_NEAR : -1;
    const c = new THREE.Color();
    let nn = 0;
    let nf = 0;
    for (const s of this.spots) {
      if (s.seed >= shares[s.kind]) continue;
      this.carMat.makeRotationY(s.rot).setPosition(s.x, s.y, s.z);
      c.setHex(PAINTS[Math.floor(s.seed * 7919) % PAINTS.length]);
      const d2 = (s.x - camera.x) ** 2 + (s.y - camera.y) ** 2 + (s.z - camera.z) ** 2;
      if (d2 < near2) {
        this.near!.setMatrixAt(nn, this.carMat);
        this.near!.setColorAt(nn, c);
        this.wheels!.setMatrixAt(nn, this.carMat);
        nn++;
      } else {
        this.far.setMatrixAt(nf, this.carMat);
        this.far.setColorAt(nf, c);
        nf++;
      }
    }
    for (const [m, n] of [[this.near, nn], [this.wheels, nn], [this.far, nf]] as const) {
      if (!m) continue;
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  private syncWalkers(hour: number, dt: number, camera: THREE.Vector3): void {
    const out = {
      downtown: share('downtown', hour) * this.amount,
      park: share('park', hour) * this.amount,
      residential: share('residential', hour) * this.amount,
      industrial: share('industrial', hour) * this.amount,
    };
    const near2 = WALK_NEAR * WALK_NEAR;
    const t = performance.now() / 1000;
    const across = this.pavementWidth * 0.4; // stay off the kerb edge
    let n = 0;
    for (const w of this.walkers) {
      const ring = this.rings[w.ring];
      if (w.seed >= out[ring.kind] * (this.rainNow ? 0.6 : 1)) continue;
      const len = this.lens[w.ring];
      w.s = (w.s + w.dir * w.speed * dt + len) % len;
      // Where on the loop: walk the corners to the side holding s.
      let s = w.s;
      let k = 0;
      const pts = ring.pts;
      for (; k < pts.length; k++) {
        const d = pts[k].distanceTo(pts[(k + 1) % pts.length]);
        if (s <= d) break;
        s -= d;
      }
      k %= pts.length;
      const p0 = pts[k];
      const p1 = pts[(k + 1) % pts.length];
      const d = Math.max(1e-6, p0.distanceTo(p1));
      const ux = (p1.x - p0.x) / d;
      const uz = (p1.y - p0.y) / d;
      const x = p0.x + ux * s - uz * w.side * across;
      const z = p0.y + uz * s + ux * w.side * across;
      const dx = x - camera.x;
      const dz = z - camera.z;
      if (dx * dx + dz * dz > near2) continue;
      // Stride: about two steps a second at walking pace, faster walkers step faster.
      const pace = w.speed / (WALK_SPEED * this.worldPerM);
      const cycle = t * 6.5 * pace + w.phase;
      const swing = Math.sin(cycle);
      const bob = Math.abs(Math.cos(cycle)) * 0.03 * this.worldPerM;
      this.base.makeRotationY(Math.atan2(ux * w.dir, uz * w.dir)).setPosition(x, ring.y + bob, z);
      const fresh = this.slotOf[n] !== w;
      this.slotOf[n] = w;
      for (const part of this.parts) {
        if (part.rain === 'only' && !this.rainNow) continue;
        if (part.pivot) {
          const angle = part.rain === 'hold' && this.rainNow ? -UMBRELLA_ARM : swing * part.swing;
          this.local.makeRotationX(angle).setPosition(part.pivot);
          part.mesh.setMatrixAt(n, this.out.multiplyMatrices(this.base, this.local));
        } else {
          part.mesh.setMatrixAt(n, this.base);
        }
        if (fresh) part.mesh.setColorAt(n, part.colors[w.i]);
      }
      n++;
    }
    for (const part of this.parts) {
      const mesh = part.mesh;
      mesh.count = part.rain === 'only' && !this.rainNow ? 0 : n;
      if (n > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    this.shown = n;
  }

  get people(): number {
    return this.shown;
  }

  get parked(): number {
    return this.far.count + (this.near?.count ?? 0);
  }
}
