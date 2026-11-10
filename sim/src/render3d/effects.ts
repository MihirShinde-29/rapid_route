import * as THREE from 'three';

// Animated effects for incidents and calls: smoke and flame particles from emitters, flickering
// flares and flashing lamps. Everything runs on real time, so it keeps moving when the sim is
// paused, and switches off with `enabled` (low graphics). Positions are world units.

const MAX_PARTICLES = 3000;
const SMOKE_LIFE_S = 4.5;
const FLAME_LIFE_S = 0.8;

export type EmitterKind = 'smoke' | 'flame';

interface Emitter {
  kind: EmitterKind;
  at: THREE.Vector3;
  rate: number; // particles per second
  size: number; // world units at birth
  carry: number; // fractional particle owed
}

interface Particle {
  kind: EmitterKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
}

// A lamp that flashes on a pattern: on while (t + phase) mod period < duty.
interface Lamp {
  material: THREE.MeshBasicMaterial;
  on: THREE.Color;
  off: THREE.Color;
  period: number; // ms
  duty: number; // ms
  phase: number; // ms
}

export class Effects {
  enabled = true;
  private emitters = new Map<string, Emitter>();
  private particles: Particle[] = [];
  private points: THREE.Points;
  private pos = new Float32Array(MAX_PARTICLES * 3);
  private col = new Float32Array(MAX_PARTICLES * 4);
  private sizes = new Float32Array(MAX_PARTICLES);
  private lamps = new Map<string, Lamp[]>();
  private flares = new Map<string, THREE.Mesh[]>();
  private last = performance.now();

  constructor(scene: THREE.Scene) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    // Soft round sprites, sized in world units and faded per particle.
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float size;
        attribute vec4 color;
        varying vec4 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 600.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec4 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = vColor.a * smoothstep(1.0, 0.3, d);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor.rgb, a);
        }`,
    });
    this.points = new THREE.Points(g, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  // Start (or move) an emitter. `rate` is particles per second at full strength.
  emit(id: string, kind: EmitterKind, at: THREE.Vector3, opts: { rate?: number; size?: number } = {}): void {
    const e = this.emitters.get(id);
    const rate = opts.rate ?? (kind === 'smoke' ? 6 : 30);
    const size = opts.size ?? (kind === 'smoke' ? 0.35 : 0.22);
    if (e) {
      e.at.copy(at);
      e.rate = rate;
      e.size = size;
    } else {
      this.emitters.set(id, { kind, at: at.clone(), rate, size, carry: 0 });
    }
  }

  // Stop an emitter; its particles live out their time.
  stop(id: string): void {
    this.emitters.delete(id);
  }

  // Flash a set of materials on a pattern (see Lamp). Replaces any lamps under the same id.
  // `stagger` delays each lamp after the first (a sequence); `offset` delays them all.
  flash(id: string, materials: THREE.MeshBasicMaterial[], on: number, off: number, period: number, duty: number, stagger = 0, offset = 0): void {
    this.lamps.set(
      id,
      materials.map((material, k) => ({ material, on: new THREE.Color(on), off: new THREE.Color(off), period, duty, phase: offset + k * stagger })),
    );
  }

  // Road flares: meshes whose brightness flickers.
  flicker(id: string, meshes: THREE.Mesh[]): void {
    this.flares.set(id, meshes);
  }

  // Forget the lamps and flares under an id (the meshes belong to the caller).
  clear(id: string): void {
    this.lamps.delete(id);
    this.flares.delete(id);
    this.stop(id);
  }

  update(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    for (const lamps of this.lamps.values()) {
      for (const l of lamps) l.material.color.copy((now + l.period - l.phase) % l.period < l.duty ? l.on : l.off);
    }
    for (const meshes of this.flares.values()) {
      for (const m of meshes) {
        const s = 0.75 + 0.25 * Math.sin(now / 37 + m.id) * Math.sin(now / 91 + 2 * m.id);
        m.scale.setScalar(s);
        (m.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.4 * s;
      }
    }
    this.points.visible = this.enabled;
    if (!this.enabled) {
      this.particles.length = 0;
      return;
    }
    for (const e of this.emitters.values()) {
      e.carry += e.rate * dt;
      while (e.carry >= 1 && this.particles.length < MAX_PARTICLES) {
        e.carry--;
        const smoke = e.kind === 'smoke';
        const spread = e.size * 0.6;
        this.particles.push({
          kind: e.kind,
          x: e.at.x + (Math.random() - 0.5) * spread,
          y: e.at.y,
          z: e.at.z + (Math.random() - 0.5) * spread,
          vx: (Math.random() - 0.5) * (smoke ? 0.08 : 0.15) + (smoke ? 0.06 : 0), // a light breeze
          vy: smoke ? 0.25 + Math.random() * 0.15 : 0.5 + Math.random() * 0.4,
          vz: (Math.random() - 0.5) * (smoke ? 0.08 : 0.15),
          age: 0,
          life: (smoke ? SMOKE_LIFE_S : FLAME_LIFE_S) * (0.7 + Math.random() * 0.6),
          size: e.size * (0.8 + Math.random() * 0.4),
        });
      }
      e.carry = Math.min(e.carry, 1);
    }
    let n = 0;
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const f = p.age / p.life;
      this.particles[n] = p;
      this.pos[n * 3] = p.x;
      this.pos[n * 3 + 1] = p.y;
      this.pos[n * 3 + 2] = p.z;
      if (p.kind === 'smoke') {
        // Dark grey, growing and fading as it rises.
        const g = 0.22 + 0.25 * f;
        this.col.set([g, g, g * 1.04, 0.55 * (1 - f) * Math.min(1, f * 8)], n * 4);
        this.sizes[n] = p.size * (1 + 2.5 * f);
      } else {
        // Yellow to orange to dark red, shrinking.
        this.col.set([1, 0.85 - 0.6 * f, 0.3 - 0.3 * f, 0.9 * (1 - f)], n * 4);
        this.sizes[n] = p.size * (1 - 0.6 * f);
      }
      n++;
    }
    this.particles.length = n;
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    for (const name of ['position', 'color', 'size']) (g.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
  }
}
