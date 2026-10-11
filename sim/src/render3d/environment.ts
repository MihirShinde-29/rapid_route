import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rng';

// Sky, sun/moon lighting and the land around the city. Everything here is visual only.

// Sky and light keyframes over a 24 h day. Colours are sRGB hex.
interface Key {
  h: number;
  zenith: number;
  horizon: number;
  sun: number; // directional light colour
  sunI: number;
  ambient: number;
}

const KEYS: Key[] = [
  { h: 0, zenith: 0x02050c, horizon: 0x0b1424, sun: 0x8fa6e0, sunI: 0.22, ambient: 0.16 },
  { h: 5.2, zenith: 0x040a18, horizon: 0x172036, sun: 0x8fa6e0, sunI: 0.2, ambient: 0.18 },
  { h: 6.3, zenith: 0x2a4370, horizon: 0xe89a6a, sun: 0xffa060, sunI: 0.45, ambient: 0.32 },
  { h: 7.5, zenith: 0x3d74b8, horizon: 0xb4cbe0, sun: 0xffe2b8, sunI: 0.95, ambient: 0.5 },
  { h: 12, zenith: 0x2e6ab4, horizon: 0xbcd6ec, sun: 0xfffaf0, sunI: 1.15, ambient: 0.6 },
  { h: 17, zenith: 0x36659f, horizon: 0xcfc8c4, sun: 0xffe6c0, sunI: 1.0, ambient: 0.52 },
  { h: 18.6, zenith: 0x283a6c, horizon: 0xf0844c, sun: 0xff8a48, sunI: 0.5, ambient: 0.32 },
  { h: 19.6, zenith: 0x0b1430, horizon: 0x3a2a4c, sun: 0x8fa6e0, sunI: 0.2, ambient: 0.2 },
  { h: 21, zenith: 0x03060e, horizon: 0x0c1526, sun: 0x8fa6e0, sunI: 0.22, ambient: 0.16 },
  { h: 24, zenith: 0x02050c, horizon: 0x0b1424, sun: 0x8fa6e0, sunI: 0.22, ambient: 0.16 },
];

const SUNRISE = 6.4;
const SUNSET = 18.6;
const SKY_RADIUS = 1400;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Sun (by day) or moon (by night) direction. x points east, z south, y up.
function lightDirection(hour: number, out: THREE.Vector3): { elevation: number; isSun: boolean } {
  const isSun = hour >= SUNRISE && hour <= SUNSET;
  const span = SUNSET - SUNRISE;
  const t = isSun ? (hour - SUNRISE) / span : (((hour - SUNSET + 24) % 24) / (24 - span));
  const a = t * Math.PI; // 0 rising in the east, PI setting in the west
  out.set(Math.cos(a), Math.sin(a) * 0.85, 0.45).normalize();
  return { elevation: Math.sin(a), isSun };
}

export class Sky {
  readonly sun: THREE.DirectionalLight;
  private ambient: THREE.AmbientLight;
  private hemi: THREE.HemisphereLight;
  private dome: THREE.Mesh;
  private stars: THREE.Points;
  private uniforms: Record<string, THREE.IUniform>;
  private a = new THREE.Color();
  private b = new THREE.Color();
  private dir = new THREE.Vector3();
  night = 1; // 0 full day .. 1 full night; drives windows, lamps and car lights

  constructor(private scene: THREE.Scene, shadowExtent: number) {
    this.ambient = new THREE.AmbientLight(0x8899aa, 0.5);
    this.hemi = new THREE.HemisphereLight(0x9fc4ff, 0x2a2a22, 0.4);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    Object.assign(this.sun.shadow.camera, { left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent, far: 600 });
    scene.add(this.ambient, this.hemi, this.sun, this.sun.target);

    this.uniforms = {
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color() },
      sunGlow: { value: 1 },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunGlow;
          varying vec3 vDir;
          void main() {
            float h = vDir.y;
            vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));
            col = mix(col, horizon * 0.6, smoothstep(0.0, -0.2, h)); // below the horizon line
            float d = max(dot(normalize(vDir), sunDir), 0.0);
            col += sunColor * (pow(d, 900.0) * 3.0 + pow(d, 12.0) * 0.25) * sunGlow;
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    scene.add(this.dome);

    const rng = mulberry32(7);
    const pos = new Float32Array(2500 * 3);
    for (let i = 0; i < 2500; i++) {
      const theta = rng() * Math.PI * 2;
      const y = 0.05 + rng() * 0.95;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(theta) * r * SKY_RADIUS * 0.95, y * SKY_RADIUS * 0.95, Math.sin(theta) * r * SKY_RADIUS * 0.95], i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }),
    );
    this.stars.frustumCulled = false;
    scene.add(this.stars);
  }

  private lerpKey(hour: number, field: 'zenith' | 'horizon' | 'sun', out: THREE.Color): THREE.Color {
    const [k0, k1, t] = this.keysAt(hour);
    return out.setHex(k0[field]).lerp(this.b.setHex(k1[field]), t);
  }

  private keysAt(hour: number): [Key, Key, number] {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
    const k0 = KEYS[i];
    const k1 = KEYS[i + 1];
    return [k0, k1, smoothstep(0, 1, (hour - k0.h) / (k1.h - k0.h))];
  }

  update(hour: number, camera: THREE.Camera): void {
    const [k0, k1, t] = this.keysAt(hour);
    const { elevation, isSun } = lightDirection(hour, this.dir);
    this.night = isSun ? 1 - smoothstep(0.02, 0.3, elevation) : 1;

    this.sun.position.copy(this.dir).multiplyScalar(300);
    this.lerpKey(hour, 'sun', this.sun.color);
    // Fade the light out as the sun or moon touches the horizon so shadows never streak.
    this.sun.intensity = (k0.sunI + (k1.sunI - k0.sunI) * t) * Math.PI * smoothstep(0, 0.12, elevation);
    const ambient = k0.ambient + (k1.ambient - k0.ambient) * t;
    this.ambient.intensity = ambient * Math.PI;
    this.hemi.intensity = ambient * 0.8 * Math.PI;

    this.lerpKey(hour, 'zenith', this.uniforms.zenith.value);
    this.lerpKey(hour, 'horizon', this.uniforms.horizon.value);
    this.uniforms.sunDir.value.copy(this.dir);
    this.uniforms.sunColor.value.copy(this.sun.color);
    this.uniforms.sunGlow.value = (isSun ? 1 : 0.25) * smoothstep(-0.05, 0.05, elevation);
    const z = this.uniforms.zenith.value as THREE.Color;
    const skyLum = 0.2126 * z.r + 0.7152 * z.g + 0.0722 * z.b;
    (this.stars.material as THREE.PointsMaterial).opacity = (1 - smoothstep(0.004, 0.03, skyLum)) * 0.9; // only once the sky is dark

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(this.uniforms.horizon.value).lerp(this.a.copy(this.uniforms.zenith.value), 0.35);
    // Sky follows the camera so it never clips.
    this.dome.position.copy(camera.position);
    this.stars.position.copy(camera.position);
  }
}

// --- Terrain ---

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, y * f);
    f *= 2;
    amp *= 0.5;
  }
  return sum; // ~0..1
}

// Land around a city of half-size (hx, hz), all in world units. The city plus a ring
// of suburbs (flatRing) is flat at y=0; beyond it farmland rolls gently, a river
// winds across the south, a lake sits to the north-west and mountains close the horizon.
export class Terrain {
  static readonly WATER_Y = -0.7;
  readonly size: number;

  constructor(
    private hx: number,
    private hz: number,
    private flatRing: number,
  ) {
    this.size = 2 * Math.max(hx, hz) + 1500;
  }

  // Distance outside the flat city+suburb rectangle (0 inside).
  private outside(x: number, z: number): number {
    const dx = Math.max(0, Math.abs(x) - this.hx - this.flatRing);
    const dz = Math.max(0, Math.abs(z) - this.hz - this.flatRing);
    return Math.hypot(dx, dz);
  }

  riverZ(x: number): number {
    return this.hz + this.flatRing + 70 + Math.sin(x * 0.012) * 28 + Math.sin(x * 0.031 + 1.3) * 10;
  }

  private lakeDepth(x: number, z: number): number {
    const cx = -this.hx - this.flatRing - 150;
    const cz = -this.hz - this.flatRing - 110;
    const d = Math.hypot((x - cx) / 120, (z - cz) / 80) + (fbm(x * 0.02, z * 0.02) - 0.5) * 0.4;
    return 4 * (1 - smoothstep(0.7, 1.05, d));
  }

  height(x: number, z: number): number {
    const d = this.outside(x, z);
    if (d === 0) return 0;
    const rolling = (fbm(x * 0.008, z * 0.008) - 0.45) * 8 * smoothstep(0, 60, d);
    const n = fbm(x * 0.004 + 10, z * 0.004 + 10, 5);
    const mountains = smoothstep(380, 750, d) * (30 + 150 * n * n);
    let h = Math.max(-0.2, rolling) * smoothstep(0, 30, d) + mountains;
    const river = Math.exp(-(((z - this.riverZ(x)) / 16) ** 2));
    h -= river * 4 * smoothstep(10, 40, d);
    h -= this.lakeDepth(x, z) * smoothstep(20, 60, d);
    return h;
  }

  // Ground colour: grass with field patches near town, forest-dark and rock higher up, snow on peaks.
  private color(x: number, z: number, h: number, out: THREE.Color): THREE.Color {
    if (h < Terrain.WATER_Y + 0.4) return out.setHex(0x8a7a5a); // shore sand / riverbed
    const d = this.outside(x, z);
    out.setHex(0x4d6b38);
    if (d > 15 && d < 380 && h < 6) {
      // Patchwork fields on a rotated grid.
      const fx = Math.floor((x * 0.8 + z * 0.6) / 26);
      const fz = Math.floor((-x * 0.6 + z * 0.8) / 18);
      const k = hash(fx, fz);
      const fields = [0x6f7d3a, 0x8c8a4a, 0x5d7a34, 0x9a8455, 0x4f6a30];
      if (k < 0.75) out.setHex(fields[Math.floor(k * fields.length / 0.75)]);
    }
    out.lerp(this.tmp.setHex(0x6b6a62), smoothstep(25, 70, h)); // rock
    out.lerp(this.tmp.setHex(0xe8edf2), smoothstep(95, 130, h)); // snow
    const shade = 0.88 + 0.24 * fbm(x * 0.05, z * 0.05);
    return out.multiplyScalar(shade);
  }
  private tmp = new THREE.Color();

  build(): THREE.Group {
    const group = new THREE.Group();
    const segs = 260;
    const geo = new THREE.PlaneGeometry(this.size, this.size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // Sink the mesh slightly so the flat city ground never z-fights with plates and roads.
      const h = this.height(x, z) - 0.05;
      pos.setY(i, h);
      this.color(x, z, h, c);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
    ground.receiveShadow = true;
    group.add(ground);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(this.size, this.size),
      new THREE.MeshStandardMaterial({ color: 0x2a5878, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.88 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = Terrain.WATER_Y;
    water.receiveShadow = true;
    group.add(water);
    return group;
  }

  // Forest: instanced trees on gentle land outside the suburbs, away from water and fields.
  buildForest(count: number): THREE.InstancedMesh {
    const trunk = new THREE.CylinderGeometry(0.25, 0.35, 2, 5);
    trunk.translate(0, 1, 0);
    const crown = new THREE.ConeGeometry(1.6, 4.5, 6);
    crown.translate(0, 4, 0);
    const paint = (g: THREE.BufferGeometry, hex: number) => {
      const col = new THREE.Color(hex);
      const arr = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < arr.length; i += 3) arr.set([col.r, col.g, col.b], i);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      return g;
    };
    const merged = mergeGeometries([paint(trunk, 0x5a4330), paint(crown, 0xffffff)])!;
    const mesh = new THREE.InstancedMesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }), count);
    const rng = mulberry32(17);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const col = new THREE.Color();
    let n = 0;
    for (let tries = 0; n < count && tries < count * 20; tries++) {
      const x = (rng() - 0.5) * this.size * 0.8;
      const z = (rng() - 0.5) * this.size * 0.8;
      const d = this.outside(x, z);
      if (d < 25) continue;
      const h = this.height(x, z);
      if (h < Terrain.WATER_Y + 0.6 || h > 70) continue;
      if (fbm(x * 0.012 + 5, z * 0.012 + 5) < 0.5 && d < 380) continue; // clumps, leaving open fields
      const scale = 0.7 + rng() * 0.9;
      p.set(x, h - 0.1, z);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rng() * Math.PI * 2);
      s.set(scale, scale * (0.8 + rng() * 0.5), scale);
      mesh.setMatrixAt(n, m.compose(p, q, s));
      mesh.setColorAt(n, col.setHex(0x2f5a2c).multiplyScalar(0.7 + rng() * 0.6));
      n++;
    }
    mesh.count = n;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}
