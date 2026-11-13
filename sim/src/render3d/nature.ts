import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rng';

// Living things in the scene: trees that sway in the breeze, flocks of birds (boids: separation,
// alignment and cohesion, like the cars making way for units) and clouds drifting overhead. All of
// it runs on real time and is scenery only; the simulation never sees it.

// Shared by every swaying thing: time (s) and how hard the wind blows (0 calm .. ~1.5 gale).
export const wind = { time: { value: 0 }, strength: { value: 0.55 } };

// --- Trees ---

export type TreeKind = 'broadleaf' | 'conifer';

// Paint every vertex: `base` darkened towards the bottom of each lump (a cheap ambient shade).
function paint(g: THREE.BufferGeometry, c: THREE.Color, shadeFrom?: { y0: number; y1: number }): THREE.BufferGeometry {
  g = g.index ? g.toNonIndexed() : g;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = shadeFrom ? 0.62 + 0.38 * THREE.MathUtils.clamp((pos.getY(i) - shadeFrom.y0) / (shadeFrom.y1 - shadeFrom.y0), 0, 1) : 1;
    arr.set([c.r * k, c.g * k, c.b * k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
  return g;
}

// A broadleaf tree 1 unit tall: a trunk with two branches and a crown of five leafy lumps, each a
// slightly different green (the instance colour multiplies them).
function broadleaf(seed: number): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const bark = new THREE.Color(0x5b4632);
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(new THREE.CylinderGeometry(0.028, 0.045, 0.5, 6).translate(0, 0.25, 0), bark));
  for (const side of [-1, 1]) {
    const b = new THREE.CylinderGeometry(0.012, 0.02, 0.22, 5).translate(0, 0.11, 0);
    b.rotateZ(side * 0.7).translate(side * 0.02, 0.38, 0);
    parts.push(paint(b, bark));
  }
  const lumps = [
    [0, 0.68, 0, 0.27],
    [0.13, 0.6, 0.06, 0.2],
    [-0.12, 0.62, -0.05, 0.21],
    [0.03, 0.82, -0.08, 0.19],
    [-0.04, 0.58, 0.14, 0.18],
    [0.08, 0.74, 0.12, 0.17],
  ];
  for (const [x, y, z, r] of lumps) {
    // Low-poly lumps (20 faces each), like the Kenney models; most of the city's trees are these.
    const g = new THREE.IcosahedronGeometry(r * (0.95 + 0.2 * rng()), 0);
    g.scale(1, 0.85, 1).rotateY(rng() * Math.PI).translate(x, y, z);
    const shade = 0.85 + 0.3 * rng();
    parts.push(paint(g, new THREE.Color(shade, shade, shade), { y0: y - r, y1: y + r }));
  }
  return mergeGeometries(parts)!;
}

// A conifer 1 unit tall: a trunk and four tiers of needles narrowing to the tip.
function conifer(seed: number): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [paint(new THREE.CylinderGeometry(0.025, 0.04, 0.25, 6).translate(0, 0.125, 0), new THREE.Color(0x4f3a28))];
  const tiers = 4;
  for (let k = 0; k < tiers; k++) {
    const r = 0.3 * (1 - k / (tiers + 0.6)) * (0.92 + 0.16 * rng());
    const h = 0.34 - k * 0.03;
    const y = 0.18 + k * 0.19;
    const g = new THREE.ConeGeometry(r, h, 8).rotateY(rng() * Math.PI).translate(0, y + h / 2, 0);
    const shade = 0.8 + 0.08 * k;
    parts.push(paint(g, new THREE.Color(shade, shade, shade), { y0: y, y1: y + h }));
  }
  return mergeGeometries(parts)!;
}

// Leaves bend away from the wind, more towards the top, each tree on its own gusts.
export function windMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = wind.time;
    shader.uniforms.uWind = wind.strength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 wp = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        #else
          vec2 wp = vec2(0.0);
        #endif
        float ph = wp.x * 0.31 + wp.y * 0.23;
        float gust = sin(uWindTime * 1.3 + ph) * 0.6 + sin(uWindTime * 2.9 + ph * 1.7) * 0.3 + sin(uWindTime * 0.4 + ph * 0.5) * 0.4;
        float bend = transformed.y * transformed.y * uWind * 0.05;
        transformed.x += bend * (0.6 + gust);
        transformed.z += bend * 0.35 * gust;`,
      );
  };
  return m;
}

export interface TreeSpot {
  x: number;
  y: number;
  z: number;
  height: number; // world units
  kind: TreeKind;
  color: THREE.Color; // leaves
}

// Beyond this from the camera (world units) a tree is drawn as a simple one-lump stand-in.
const TREE_NEAR = 70;

// A simple tree for the distance: a trunk and one crown (a lump or a cone), a tenth of the faces.
function standInTree(kind: TreeKind): THREE.BufferGeometry {
  const trunk = paint(new THREE.CylinderGeometry(0.03, 0.045, 0.5, 4).translate(0, 0.25, 0), new THREE.Color(0x5b4632));
  const crown = kind === 'broadleaf'
    ? paint(new THREE.IcosahedronGeometry(0.32, 0).scale(1, 0.9, 1).translate(0, 0.66, 0), new THREE.Color(1, 1, 1), { y0: 0.36, y1: 0.95 })
    : paint(new THREE.ConeGeometry(0.28, 0.85, 6).translate(0, 0.6, 0), new THREE.Color(0.9, 0.9, 0.9), { y0: 0.18, y1: 1 });
  return mergeGeometries([trunk, crown])!;
}

export interface Trees {
  group: THREE.Group;
  // Full trees near the camera, stand-ins further away (re-sorted when the camera moves).
  update(camera: THREE.Vector3): void;
}

// Every tree as instances: two full shapes of each kind (picked by position) and a stand-in.
export function buildTrees(spots: TreeSpot[]): Trees {
  const material = windMaterial();
  const group = new THREE.Group();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const kinds: TreeKind[] = ['broadleaf', 'conifer'];
  const full: Record<TreeKind, THREE.BufferGeometry[]> = { broadleaf: [broadleaf(3), broadleaf(8)], conifer: [conifer(5), conifer(11)] };
  // Each spot's pose and colour, worked out once.
  const trees = spots.map((s) => {
    const spin = (s.x * 12.9 + s.z * 7.7) % (Math.PI * 2);
    const wide = 0.9 + 0.2 * Math.abs(Math.sin(s.x * 3.1 + s.z));
    return {
      kind: s.kind,
      shape: Math.floor(Math.abs(s.x * 7.1 + s.z * 3.3)) % 2,
      at: new THREE.Vector3(s.x, s.y, s.z),
      matrix: new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y, s.z), q.setFromAxisAngle(up, spin), new THREE.Vector3(s.height * wide, s.height, s.height * wide)),
      color: s.color,
    };
  });
  const make = (geo: THREE.BufferGeometry, max: number, shadow: boolean) => {
    const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, max));
    mesh.count = 0;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };
  const count = (k: TreeKind, shape?: number) => trees.filter((t) => t.kind === k && (shape === undefined || t.shape === shape)).length;
  const near: Record<TreeKind, THREE.InstancedMesh[]> = {
    broadleaf: full.broadleaf.map((g, v) => make(g, count('broadleaf', v), true)),
    conifer: full.conifer.map((g, v) => make(g, count('conifer', v), true)),
  };
  const far: Record<TreeKind, THREE.InstancedMesh> = { broadleaf: make(standInTree('broadleaf'), count('broadleaf'), false), conifer: make(standInTree('conifer'), count('conifer'), false) };
  const last = new THREE.Vector3(Infinity, 0, 0);
  const near2 = TREE_NEAR * TREE_NEAR;
  return {
    group,
    update(camera: THREE.Vector3) {
      if (camera.distanceToSquared(last) < 9) return; // moved less than 3 units
      last.copy(camera);
      const meshes = [...kinds.flatMap((k) => near[k]), ...kinds.map((k) => far[k])];
      for (const m of meshes) m.count = 0;
      for (const t of trees) {
        const m = t.at.distanceToSquared(camera) < near2 ? near[t.kind][t.shape] : far[t.kind];
        m.setMatrixAt(m.count, t.matrix);
        m.setColorAt(m.count, t.color);
        m.count++;
      }
      for (const m of meshes) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
      }
    },
  };
}

export function coniferGeometry(seed: number): THREE.BufferGeometry {
  return conifer(seed);
}

// --- Birds ---

// Flocks of birds steered as boids: keep apart from close neighbours (separation), fly the way the
// flock flies (alignment), keep with the flock (cohesion), and head for a wandering waypoint over
// the city, staying between the rooftops and the clouds.
const FLOCKS = 5;
const PER_FLOCK = 22;
const SPEED = 3.2; // world units/s (~23 m/s)
const SEE = 3.5; // neighbour distance, world units
const APART = 0.9;

interface Bird {
  p: THREE.Vector3;
  v: THREE.Vector3;
  flock: number;
}

export class Birds {
  readonly mesh: THREE.InstancedMesh;
  private birds: Bird[] = [];
  private goals: THREE.Vector3[] = [];
  private rng = mulberry32(99);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private c = new THREE.Vector3();
  private fwd = new THREE.Vector3(0, 0, 1);
  private one = new THREE.Vector3(1, 1, 1);

  constructor(private halfSize: number) {
    // A small body and two wings (wings along x, flapped in the shader).
    const s = 0.13;
    const body = new THREE.BoxGeometry(s * 0.25, s * 0.18, s * 0.9);
    const wings = new THREE.BufferGeometry();
    wings.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, s * 0.25, -s * 1.1, 0, -s * 0.05, 0, 0, -s * 0.3,
      0, 0, s * 0.25, 0, 0, -s * 0.3, s * 1.1, 0, -s * 0.05,
    ], 3));
    wings.computeVertexNormals();
    const geo = mergeGeometries([body.toNonIndexed().deleteAttribute('uv'), wings])!;
    const mat = new THREE.MeshLambertMaterial({ color: 0x4a4440, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = wind.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float ph = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 1.3;
          // Flap, with a glide now and then.
          float flap = sin(uWindTime * 11.0 + ph) * smoothstep(-0.4, 0.2, sin(uWindTime * 0.7 + ph));
          transformed.y += flap * abs(transformed.x) * 0.9;`,
        );
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, FLOCKS * PER_FLOCK);
    this.mesh.frustumCulled = false;
    for (let f = 0; f < FLOCKS; f++) {
      const home = this.randomGoal();
      this.goals.push(this.randomGoal());
      for (let k = 0; k < PER_FLOCK; k++) {
        this.birds.push({
          p: home.clone().add(new THREE.Vector3((this.rng() - 0.5) * 6, (this.rng() - 0.5) * 2, (this.rng() - 0.5) * 6)),
          v: new THREE.Vector3(this.rng() - 0.5, 0, this.rng() - 0.5).normalize().multiplyScalar(SPEED),
          flock: f,
        });
      }
    }
  }

  private randomGoal(): THREE.Vector3 {
    const r = this.halfSize * 0.9;
    return new THREE.Vector3((this.rng() - 0.5) * 2 * r, 9 + this.rng() * 16, (this.rng() - 0.5) * 2 * r);
  }

  // `night` 0..1: the birds roost (hide) after dusk.
  update(dt: number, night: number): void {
    this.mesh.visible = night < 0.6;
    if (!this.mesh.visible) return;
    dt = Math.min(dt, 0.05);
    const centres = this.goals.map(() => new THREE.Vector3());
    const heads = this.goals.map(() => new THREE.Vector3());
    const counts = this.goals.map(() => 0);
    for (const b of this.birds) {
      centres[b.flock].add(b.p);
      heads[b.flock].add(b.v);
      counts[b.flock]++;
    }
    this.goals.forEach((g, f) => {
      centres[f].divideScalar(counts[f]);
      heads[f].divideScalar(counts[f]);
      if (centres[f].distanceTo(g) < 8) this.goals[f] = this.randomGoal(); // reached: wander on
    });
    const steer = this.a;
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      steer.set(0, 0, 0);
      // Separation from close flock-mates.
      for (let j = 0; j < this.birds.length; j++) {
        if (j === i || this.birds[j].flock !== b.flock) continue;
        const d = b.p.distanceTo(this.birds[j].p);
        if (d < APART && d > 0) steer.add(this.b.subVectors(b.p, this.birds[j].p).multiplyScalar((APART - d) / d * 3));
      }
      // Alignment and cohesion with the flock, and the pull of its waypoint.
      steer.add(this.b.copy(heads[b.flock]).sub(b.v).multiplyScalar(0.6));
      if (b.p.distanceTo(centres[b.flock]) > SEE * 0.3) steer.add(this.b.subVectors(centres[b.flock], b.p).multiplyScalar(0.35));
      steer.add(this.c.subVectors(this.goals[b.flock], b.p).normalize().multiplyScalar(1.4));
      // Keep above the rooftops.
      if (b.p.y < 7) steer.y += (7 - b.p.y) * 2;
      b.v.addScaledVector(steer, dt);
      b.v.y *= 0.98;
      const sp = b.v.length();
      b.v.multiplyScalar(THREE.MathUtils.clamp(sp, SPEED * 0.7, SPEED * 1.3) / Math.max(sp, 1e-6));
      b.p.addScaledVector(b.v, dt);
      this.q.setFromUnitVectors(this.fwd, this.c.copy(b.v).normalize());
      this.mesh.setMatrixAt(i, this.m.compose(b.p, this.q, this.one));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// --- Clouds ---

function cloudTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const rng = mulberry32(42);
  for (let k = 0; k < 18; k++) {
    const x = 34 + rng() * 60;
    const y = 44 + rng() * 40;
    const r = 18 + rng() * 26;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}

// Soft clouds high over the city: puffs drawn as camera-facing quads, drifting with the wind and
// wrapping round. `cover` (0..1) is how much of the sky they fill; the colour follows the light.
export class Clouds {
  readonly mesh: THREE.Mesh;
  private uniforms = {
    uTime: wind.time,
    uDrift: { value: 1.5 }, // world units/s
    uSpan: { value: 900 },
    uCover: { value: 0.45 },
    uColor: { value: new THREE.Color(1, 1, 1) },
    uMap: { value: cloudTexture() },
  };

  constructor(span: number) {
    this.uniforms.uSpan.value = span;
    const rng = mulberry32(5);
    const centres: number[] = [];
    const sizes: number[] = [];
    const seeds: number[] = [];
    const CLOUDS = 40;
    for (let k = 0; k < CLOUDS; k++) {
      const cx = (rng() - 0.5) * span;
      const cz = (rng() - 0.5) * span;
      const cy = 170 + rng() * 60;
      const seed = rng();
      const puffs = 5 + Math.floor(rng() * 5);
      for (let p = 0; p < puffs; p++) {
        centres.push(cx + (rng() - 0.5) * 70, cy + (rng() - 0.5) * 10, cz + (rng() - 0.5) * 35);
        sizes.push(45 + rng() * 45);
        seeds.push(seed);
      }
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('centre', new THREE.InstancedBufferAttribute(new Float32Array(centres), 3));
    geo.setAttribute('size', new THREE.InstancedBufferAttribute(new Float32Array(sizes), 1));
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(new Float32Array(seeds), 1));
    geo.instanceCount = sizes.length;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
      vertexShader: `
        attribute vec3 centre; attribute float size; attribute float seed;
        uniform float uTime, uDrift, uSpan, uCover;
        varying vec2 vUv; varying float vShow; varying float vShade;
        void main() {
          vec3 c = centre;
          c.x = mod(c.x + uTime * uDrift + uSpan * 0.5, uSpan) - uSpan * 0.5;
          vShow = step(seed, uCover);
          vUv = uv;
          vShade = 0.86 + 0.3 * (position.y + 0.5); // lighter on top
          vec4 mv = viewMatrix * vec4(c, 1.0);
          mv.xy += position.xy * size * (0.75 + 0.5 * vShow);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform vec3 uColor;
        varying vec2 vUv; varying float vShow; varying float vShade;
        void main() {
          if (vShow < 0.5) discard;
          float a = texture2D(uMap, vUv).a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor * min(vShade, 1.0), a * 0.9);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -0.5;
  }

  // Light from the sky (`light`, the colour a white cloud would take), how much sky is covered,
  // and how fast they drift.
  update(light: THREE.Color, cover: number, drift: number): void {
    this.uniforms.uColor.value.copy(light);
    this.uniforms.uCover.value += (cover - this.uniforms.uCover.value) * 0.02;
    this.uniforms.uDrift.value = drift;
  }
}
