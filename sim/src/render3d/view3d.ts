import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mulberry32, type Rng } from '../core/rng';
import type { Simulation } from '../sim';
import type { Trip } from '../demand/trips';
import type { Vehicle } from '../traffic/traffic';
import { JUNCTION_RADIUS } from '../traffic/geometry';
import type { Zone, ZoneType } from '../demand/zones';
import { hourOf } from '../core/time';
import { Sky, Terrain } from './environment';
import { StaticBatch } from './batch';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { vehicleGeometry, vehiclePaint } from './vehicles';
import { VEHICLE_KINDS, type VehicleKind } from '../traffic/vehicleTypes';

// Zone identity colours (validated categorical slots 1-3 on the dark surface).
// Parks are shown by their trees, not by colour.
export const ZONE_HEX: Record<ZoneType, number> = {
  residential: 0x3987e5,
  commercial: 0xd95926,
  industrial: 0x199e70,
  park: 0x2e5c3a,
};

const WORLD_PER_M = 0.14; // 100 m block spacing -> 14 world units, as in the prototype
const BLOCK_INSET = 1.4;
const MAX_CARS = 4000;
const CAR_WIDTH = 2.2; // m, slightly wide so cars read at city zoom
const ROAD_COLORS = { local: 0x262d35, arterial: 0x2e3640, slow: 0x9a6a2a, jammed: 0x9a3a2a };
const LAMP_COLOR = 0xffc27a;
const CONGESTION_REFRESH_MS = 500;
const DEPART_S = 4; // sim s a new car takes to pull out of its lot onto the road
const PARK_SPEED = 6; // m/s driving off the road into the destination lot
const LOT_DEPTH = 0.42; // how far from the corner toward the block centre the lot is

// A car that has arrived: drawn driving from the road into its destination lot, then gone.
interface Parking {
  trip: Trip;
  kind: VehicleKind;
  p0: THREE.Vector2; // m, where it left the road
  c: THREE.Vector2; // Bezier control point
  p2: THREE.Vector2; // the lot
  start: number; // sim s
  dur: number;
}

function bezier(a: THREE.Vector2, c: THREE.Vector2, b: THREE.Vector2, s: number, out: THREE.Vector2, dir: THREE.Vector2): void {
  const u = 1 - s;
  out.set(u * u * a.x + 2 * u * s * c.x + s * s * b.x, u * u * a.y + 2 * u * s * c.y + s * s * b.y);
  dir.set(2 * u * (c.x - a.x) + 2 * s * (b.x - c.x), 2 * u * (c.y - a.y) + 2 * s * (b.y - c.y));
}

const ease = (s: number) => s * s * (3 - 2 * s);

const BRAKE_ON = new THREE.Color(1, 0.12, 0.06);
const BRAKE_OFF = new THREE.Color(0, 0, 0); // additive: black draws nothing
const SIGNAL = {
  red: new THREE.Color(1, 0.12, 0.08),
  redOff: new THREE.Color(0.18, 0.04, 0.03),
  green: new THREE.Color(0.2, 1, 0.45),
  greenOff: new THREE.Color(0.03, 0.14, 0.06),
};

// A signal head on one approach to a junction. It shows the sim's right-of-way decision
// for that approach: green while its cars hold the junction, red while they wait.
interface Signal {
  lane: number;
  node: number;
  arterial: boolean;
}
const ARC_POOL = 600;
const ARC_POINTS = 13;
const ARC_LIFE_MS = 1200;

interface Arc {
  rgb: [number, number, number];
  born: number;
}

const SEGS_PER_ARC = ARC_POINTS - 1;
const VERTS_PER_ARC = SEGS_PER_ARC * 2;

// Facade texture: TILES x TILES windows, some lit. The colour map is white wall with
// glass panes (tinted by each building's vertex colour); the glow map lights the lit ones.
const TILES = 8;
const BAY = 0.42; // world units per window bay (~3 m)
const FLOOR = 0.42; // world units per storey (~3 m)

function windowTextures(maxAnisotropy: number): { map: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
  const px = 32;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = c.height = TILES * px;
    return c;
  };
  const mapCanvas = make();
  const glowCanvas = make();
  const m = mapCanvas.getContext('2d')!;
  const g = glowCanvas.getContext('2d')!;
  m.fillStyle = '#ffffff';
  m.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, glowCanvas.width, glowCanvas.height);
  const rng = mulberry32(99);
  for (let i = 0; i < TILES; i++) {
    for (let j = 0; j < TILES; j++) {
      const x = i * px + 6;
      const y = j * px + 8;
      const w = px - 12;
      const h = px - 14;
      const lit = rng() < 0.2;
      m.fillStyle = lit ? '#ffe2b0' : '#2f3a48';
      m.fillRect(x, y, w, h);
      m.fillStyle = 'rgba(255,255,255,0.12)'; // sky reflection on the upper pane
      if (!lit) m.fillRect(x, y, w, h * 0.35);
      if (lit) {
        g.fillStyle = rng() < 0.5 ? '#ffc070' : '#a87848';
        g.fillRect(x, y, w, h);
      }
    }
  }
  const tex = (c: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAnisotropy;
    return t;
  };
  return { map: tex(mapCanvas), glow: tex(glowCanvas) };
}

// Soft white-to-black radial gradient, for additive glows on the road.
function radialGlow(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.5, '#555555');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Box whose side UVs are scaled to its real size, so every building gets the same
// window size and floor height. A random offset keeps neighbours from looking identical.
function facadeBox(w: number, h: number, d: number, rng: Rng): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const offU = Math.floor(rng() * TILES) / TILES;
  const offV = Math.floor(rng() * TILES) / TILES;
  // Face order is +x, -x, +y, -y, +z, -z with 4 vertices each; the x faces span depth.
  const faceWidth = [d, d, w, w, w, w];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const v = f * 4 + k;
      uv.setXY(v, offU + (uv.getX(v) * faceWidth[f]) / (BAY * TILES), offV + (uv.getY(v) * h) / (FLOOR * TILES));
    }
  }
  return geo;
}

// Three.js view of the sim, styled after prototypes/dispatch_3d.html.
// Reads sim state only; never mutates it.
export class View3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.5, 4000);
  private controls: OrbitControls;
  private arcs: Arc[] = [];
  private nextArc = 0;
  private arcLines!: THREE.LineSegments;
  private parking: Parking[] = [];
  private lastVehicles = new Set<Vehicle>();
  private nodeZones: number[][] = [];
  private bp = new THREE.Vector2();
  private bd = new THREE.Vector2();
  private fleet = new Map<VehicleKind, { body: THREE.InstancedMesh; lights: THREE.InstancedMesh; brake: THREE.InstancedMesh; n: number }>();
  private brakeMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private signals: Signal[] = [];
  private signalLamps!: THREE.InstancedMesh; // two per signal: red then green
  private tags!: { start: HTMLDivElement; end: HTMLDivElement; car: HTMLDivElement };
  private pinNodes: [number | null, number | null] = [null, null];
  private tagV = new THREE.Vector3();
  private streets: { links: number[]; arterial: boolean; firstVertex: number; vertexCount: number }[] = [];
  private roads!: THREE.Mesh;
  private flat = new StaticBatch(); // plates, intersections: receive shadows only
  private solid = new StaticBatch(); // roofs, stacks, trees: cast and receive
  private facades = new StaticBatch(); // building walls with windows
  private lastCongestion = -Infinity;
  private tmp = new THREE.Object3D();
  private tmpColor = new THREE.Color();
  private routeHighlight: THREE.LineSegments | null = null;
  private proofCar: THREE.Group | null = null; // highlight on the road under the probe or proof vehicle
  private highlightedTrip = -1;
  private sky!: Sky;
  private facadeMat!: THREE.MeshStandardMaterial;
  private lampHeadMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private lampPoolMat!: THREE.MeshBasicMaterial;
  private lampPools!: THREE.Mesh;
  private carLightMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private carLights: THREE.InstancedMesh[] = [];
  private probePins: THREE.Mesh[] = [];
  private followTrip: number | null = null;
  private followVeh: Vehicle | null = null;
  private followSeen = false;
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  onFollowEnd: (() => void) | null = null; // the followed vehicle reached its destination
  showDesireLines = true;

  constructor(
    private container: HTMLElement,
    private sim: Simulation,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.FogExp2(0x0b1424, 0.0016);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 700;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.45;
    const r = 0.6 * Math.max(sim.grid.width, sim.grid.height) * WORLD_PER_M + 10;
    const theta = Math.PI * 0.28;
    const phi = 1.12;
    this.camera.position.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));

    const hx = (sim.grid.width * WORLD_PER_M) / 2;
    const hz = (sim.grid.height * WORLD_PER_M) / 2;
    this.sky = new Sky(this.scene, Math.hypot(hx, hz) + 12);
    const terrain = new Terrain(hx, hz, this.blockSize()); // a block of open grass before the countryside
    this.scene.add(terrain.build());
    this.scene.add(terrain.buildForest(6000));
    const rng = mulberry32(sim.config.seed + 1);
    this.buildGround();
    this.buildRoads();
    this.buildZones(rng);
    this.buildStreetLamps();
    this.buildSignals();
    this.buildTags();
    this.scene.add(this.flat.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), false, true));
    this.scene.add(this.solid.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), true, true));
    const windows = windowTextures(this.renderer.capabilities.getMaxAnisotropy());
    this.facadeMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: windows.map,
      emissiveMap: windows.glow,
      emissive: 0xffffff,
      emissiveIntensity: 0.6,
      roughness: 0.6,
      metalness: 0.1,
    });
    this.scene.add(this.facades.build(this.facadeMat, true, true));
    this.buildArcPool();
    this.buildCars();
    this.routeHighlight = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.routeHighlight.position.y = 0.55;
    this.routeHighlight.visible = false;
    this.scene.add(this.routeHighlight);
    const glowMat = { color: 0xffd166, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ ...glowMat, map: radialGlow() }));
    glow.scale.set(1.7, 1, 1.1);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.5, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ ...glowMat }));
    ring.scale.set(1.7, 1, 0.9);
    this.proofCar = new THREE.Group();
    this.proofCar.add(glow, ring);
    this.proofCar.visible = false;
    this.scene.add(this.proofCar);
    // Probe start (green) and destination (red) pins.
    for (const color of [0x3ddc84, 0xff5a5a]) {
      const pin = new THREE.Mesh(
        mergeGeometries([new THREE.CylinderGeometry(0.1, 0.1, 4, 8).translate(0, 2, 0), new THREE.SphereGeometry(0.7, 14, 10).translate(0, 4.4, 0)])!,
        new THREE.MeshBasicMaterial({ color }),
      );
      pin.visible = false;
      this.scene.add(pin);
      this.probePins.push(pin);
    }

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  private wx(x: number): number {
    return (x - this.sim.grid.width / 2) * WORLD_PER_M;
  }

  private wz(y: number): number {
    return (y - this.sim.grid.height / 2) * WORLD_PER_M;
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, true);
  }

  private blockSize(): number {
    return this.sim.grid.opts.spacing * WORLD_PER_M;
  }

  // Pavement under the simulated city; the terrain around it is grass.
  private buildGround(): void {
    const w = this.sim.grid.width * WORLD_PER_M + 3;
    const h = this.sim.grid.height * WORLD_PER_M + 3;
    this.flat.add(new THREE.PlaneGeometry(w, h), new THREE.Color(0x3a3f45), 0, 0.01, 0, -Math.PI / 2);
  }

  // A lamp post at the middle of every street, on alternating sides (both sides on arterials).
  // Heads glow and light pools appear on the road at night.
  private buildStreetLamps(): void {
    const { net } = this.sim.grid;
    const heads = new StaticBatch();
    const pools = new StaticBatch();
    const post = new THREE.Color(0x3a4048);
    const lamp = new THREE.Color(LAMP_COLOR);
    let k = 0;
    for (const link of net.links) {
      if (link.from > link.to) continue;
      const a = net.nodes[link.from];
      const b = net.nodes[link.to];
      const mx = this.wx((a.x + b.x) / 2);
      const mz = this.wz((a.y + b.y) / 2);
      const dx = (b.x - a.x) / link.length;
      const dz = (b.y - a.y) / link.length;
      const angle = -Math.atan2(dz, dx);
      const half = link.arterial ? 0.8 : 0.65;
      const sides = link.arterial ? [-1, 1] : [k++ % 2 === 0 ? 1 : -1];
      for (const side of sides) {
        // Normal to the street, pointing to this side.
        const nx = -dz * side;
        const nz = dx * side;
        const px = mx + nx * (half + 0.45);
        const pz = mz + nz * (half + 0.45);
        this.solid.add(new THREE.CylinderGeometry(0.045, 0.06, 1.7, 5), post, px, 0.85, pz);
        const hx = px - nx * 0.4;
        const hz = pz - nz * 0.4;
        this.solid.add(new THREE.BoxGeometry(0.42, 0.04, 0.04), post, (px + hx) / 2, 1.68, (pz + hz) / 2, 0, angle + Math.PI / 2);
        heads.add(new THREE.BoxGeometry(0.24, 0.05, 0.12), lamp, hx, 1.64, hz, 0, angle + Math.PI / 2);
        pools.add(new THREE.CircleGeometry(1.05, 18), lamp, hx, 0.27, hz, -Math.PI / 2);
      }
    }
    this.scene.add(heads.build(this.lampHeadMat, false, false));
    this.lampPoolMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      map: radialGlow(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.lampPools = pools.build(this.lampPoolMat, false, false);
    this.scene.add(this.lampPools);
  }

  // Arterials: solid double yellow centre line and white edge lines. Local streets: a dashed
  // white centre line. Markings stop short of the junctions.
  private addLaneMarkings(b: StaticBatch, arterial: boolean, x0: number, z0: number, x1: number, z1: number, yellow: THREE.Color, white: THREE.Color): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    const angle = -Math.atan2(uz, ux);
    const clear = 1.5; // junction box
    const span = len - 2 * clear;
    const y = 0.27;
    // A flat strip of the given length centred at distance `along` from the start, offset sideways.
    const strip = (along: number, length: number, side: number, width: number, color: THREE.Color) =>
      b.add(new THREE.PlaneGeometry(length, width).rotateX(-Math.PI / 2), color, x0 + ux * along - uz * side, y, z0 + uz * along + ux * side, 0, angle);
    if (arterial) {
      strip(len / 2, span, 0.045, 0.035, yellow);
      strip(len / 2, span, -0.045, 0.035, yellow);
      strip(len / 2, span, 0.68, 0.03, white);
      strip(len / 2, span, -0.68, 0.03, white);
    } else {
      const dash = 0.45;
      const gap = 0.4;
      const n = Math.floor((span + gap) / (dash + gap));
      const start = clear + (span - (n * (dash + gap) - gap)) / 2;
      for (let k = 0; k < n; k++) strip(start + k * (dash + gap) + dash / 2, dash, 0, 0.04, white);
    }
  }

  private buildRoads(): void {
    const { net } = this.sim.grid;
    const roads = new StaticBatch();
    const stripes = new StaticBatch();
    const yellow = new THREE.Color(0xd9b23a);
    const white = new THREE.Color(0xc9ced4);
    for (const link of net.links) {
      if (link.from > link.to) continue; // one mesh per two-way street
      const a = net.nodes[link.from];
      const b = net.nodes[link.to];
      const x0 = this.wx(a.x);
      const z0 = this.wz(a.y);
      const x1 = this.wx(b.x);
      const z1 = this.wz(b.y);
      const len = Math.hypot(x1 - x0, z1 - z0);
      const angle = -Math.atan2(z1 - z0, x1 - x0);
      // Each street keeps its vertex range so congestion can recolour it in place.
      const back = net.outLinks[link.to].find((id) => net.links[id].to === link.from)!;
      const geo = new THREE.BoxGeometry(len, 0.25, link.arterial ? 1.6 : 1.3);
      const vertexCount = geo.attributes.position.count;
      const color = new THREE.Color(link.arterial ? ROAD_COLORS.arterial : ROAD_COLORS.local);
      const firstVertex = roads.add(geo, color, (x0 + x1) / 2, 0.13, (z0 + z1) / 2, 0, angle);
      this.streets.push({ links: [link.id, back], arterial: link.arterial, firstVertex, vertexCount });
      this.addLaneMarkings(stripes, link.arterial, x0, z0, x1, z1, yellow, white);
    }
    this.roads = roads.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), false, true);
    this.scene.add(this.roads);
    this.scene.add(stripes.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }), false, true));
    const nodeColor = new THREE.Color(ROAD_COLORS.local);
    for (const n of net.nodes) {
      this.flat.add(new THREE.CylinderGeometry(1.3, 1.3, 0.26, 16), nodeColor, this.wx(n.x), 0.13, this.wz(n.y));
    }
  }

  // Building height and count follow zone density, so demand is visible in the skyline.
  private buildZones(rng: Rng): void {
    const size = this.sim.grid.opts.spacing * WORLD_PER_M - BLOCK_INSET * 2;
    for (const z of this.sim.zones) {
      const cx = this.wx(z.cx);
      const cz = this.wz(z.cy);
      const tint = new THREE.Color(ZONE_HEX[z.type]);
      // Low-density blocks read as lawns; denser blocks as paved lots tinted by zone type.
      const plateColor =
        z.type === 'park' ? new THREE.Color(0x3d5a30)
        : z.type === 'residential' && z.density < 0.45 ? new THREE.Color(0x46603a).lerp(tint, 0.08)
        : new THREE.Color(0x30363d).lerp(tint, 0.14);
      this.flat.add(new THREE.PlaneGeometry(size, size), plateColor, cx, 0.03, cz, -Math.PI / 2);
      if (z.type === 'park') this.addTrees(cx, cz, size, rng);
      else this.addBuildings(z, cx, cz, size, tint, rng);
    }
  }

  // Each lot gets a building shaped by its zone: towers downtown, houses or apartment
  // blocks in residential areas depending on density, warehouses in industrial zones.
  private addBuildings(z: Zone, cx: number, cz: number, size: number, tint: THREE.Color, rng: Rng): void {
    const lots = z.type === 'residential' ? 3 : 2;
    const cell = size / lots;
    for (let i = 0; i < lots; i++) {
      for (let j = 0; j < lots; j++) {
        if (z.type === 'residential' && rng() > 0.35 + 0.65 * z.density) continue; // sparser at low density
        const grey = 0.35 + (0.45 + 0.4 * rng()) * 0.25;
        const color = new THREE.Color(grey * 0.9, grey * 0.95, grey * 1.05).lerp(tint, 0.18);
        const bx = cx - size / 2 + cell * (i + 0.5);
        const bz = cz - size / 2 + cell * (j + 0.5);
        if (z.type === 'commercial') this.addTower(bx, bz, cell, z.density, color, rng);
        else if (z.type === 'industrial') this.addWarehouse(bx, bz, cell, color, rng);
        else if (z.density < 0.45) this.addHouse(bx, bz, cell, color, rng);
        else this.addApartment(bx, bz, cell, z.density, color, rng);
      }
    }
  }

  // Windowed walls from y0 to y0 + h, capped with a slightly wider parapet roof.
  private addBlock(w: number, h: number, d: number, x: number, y0: number, z: number, color: THREE.Color, rng: Rng): void {
    this.facades.add(facadeBox(w, h, d, rng), color, x, y0 + h / 2, z);
    const roof = color.clone().multiplyScalar(0.62);
    this.solid.add(new THREE.BoxGeometry(w + 0.12, 0.16, d + 0.12), roof, x, y0 + h + 0.08, z);
  }

  private addTower(x: number, z: number, cell: number, density: number, color: THREE.Color, rng: Rng): void {
    const h = (6 + 20 * density) * (0.6 + 0.6 * rng());
    const fp = cell * (0.62 + 0.18 * rng());
    let base = 0;
    if (h > 8) {
      // Podium: a wider lobby/retail base under the tower.
      base = 3 * FLOOR;
      this.addBlock(Math.min(fp * 1.18, cell * 0.92), base, Math.min(fp * 1.18, cell * 0.92), x, 0, z, color, rng);
    }
    let top = fp;
    if (h > 14 && rng() > 0.4) {
      // Setback: the upper third steps in.
      const lower = (h - base) * 0.65;
      this.addBlock(fp, lower, fp, x, base, z, color, rng);
      top = fp * 0.72;
      this.addBlock(top, h - base - lower, top, x, base + lower, z, color, rng);
    } else {
      this.addBlock(fp, h - base, fp, x, base, z, color, rng);
    }
    const plant = new THREE.Color(0x56606b);
    this.solid.add(new THREE.BoxGeometry(top * 0.4, 0.5, top * 0.3), plant, x, h + 0.41, z); // rooftop plant room
    if (h > 20) this.solid.add(new THREE.CylinderGeometry(0.04, 0.06, 3, 6), plant, x + top * 0.25, h + 1.66, z + top * 0.25);
  }

  private addApartment(x: number, z: number, cell: number, density: number, color: THREE.Color, rng: Rng): void {
    const floors = Math.max(3, Math.round(((1.6 + 7 * density) * (0.6 + 0.6 * rng())) / FLOOR));
    const h = floors * FLOOR;
    const fp = cell * (0.6 + 0.2 * rng());
    const long = rng() > 0.5;
    const w = long ? fp : fp * 0.7;
    const d = long ? fp * 0.7 : fp;
    this.addBlock(w, h, d, x, 0, z, color, rng);
    if (rng() > 0.5) {
      // Water tank on the roof.
      this.solid.add(new THREE.CylinderGeometry(0.22, 0.22, 0.4, 10), new THREE.Color(0x6b5a4a), x + w * 0.2, h + 0.36, z - d * 0.15);
    }
  }

  private addHouse(x: number, z: number, cell: number, color: THREE.Color, rng: Rng): void {
    const fp = cell * (0.42 + 0.14 * rng());
    const h = 2 * FLOOR;
    const ox = (rng() - 0.5) * cell * 0.2;
    const oz = (rng() - 0.5) * cell * 0.2;
    this.facades.add(facadeBox(fp, h, fp * 0.85, rng), color.clone().lerp(new THREE.Color(0xd8cbb8), 0.35), x + ox, h / 2, z + oz);
    // Hip roof: a four-sided cone turned 45 degrees, with a small overhang.
    const roofColors = [0x8a4a36, 0x4a5260, 0x6b4a3a, 0x5c3b32];
    const roof = new THREE.ConeGeometry(fp * 0.78, 0.55, 4);
    roof.scale(1, 1, 0.85);
    this.solid.add(roof, new THREE.Color(roofColors[Math.floor(rng() * roofColors.length)]), x + ox, h + 0.275, z + oz, 0, Math.PI / 4);
    if (rng() > 0.5) {
      // Garage on one side.
      const g = fp * 0.4;
      this.solid.add(new THREE.BoxGeometry(g, FLOOR * 0.9, g), color.clone().multiplyScalar(0.8), x + ox + fp * 0.5 + g * 0.5, FLOOR * 0.45, z + oz + fp * 0.2);
    }
  }

  // Warehouses have no window grid: plain walls, a sawtooth roof and a loading door.
  private addWarehouse(x: number, z: number, cell: number, color: THREE.Color, rng: Rng): void {
    const h = 2.2 + 2.2 * rng();
    const fp = cell * (0.8 + 0.12 * rng());
    const wall = color.clone().multiplyScalar(0.85);
    this.solid.add(new THREE.BoxGeometry(fp, h, fp), wall, x, h / 2, z);
    const ridges = 4;
    const r = fp / ridges / Math.sqrt(3); // triangle with base fp / ridges
    const ridgeColor = new THREE.Color(0x5a6470);
    for (let k = 0; k < ridges; k++) {
      const rx = x - fp / 2 + (fp / ridges) * (k + 0.5);
      this.solid.add(new THREE.CylinderGeometry(r, r, fp, 3), ridgeColor, rx, h + r / 2, z, -Math.PI / 2);
    }
    const door = new THREE.Color(0x2a3038);
    this.solid.add(new THREE.BoxGeometry(0.06, 1.2, fp * 0.3), door, x + fp / 2 + 0.03, 0.6, z);
    if (rng() > 0.6) {
      const stackColor = new THREE.Color(0x4a5560);
      this.solid.add(new THREE.CylinderGeometry(0.3, 0.38, h + 4, 8), stackColor, x + fp * 0.3, (h + 4) / 2, z + fp * 0.3);
    }
  }

  private addTrees(cx: number, cz: number, size: number, rng: Rng): void {
    const count = 6 + Math.floor(rng() * 5);
    for (let i = 0; i < count; i++) this.addTree(cx + (rng() - 0.5) * size * 0.85, cz + (rng() - 0.5) * size * 0.85, rng);
  }

  private addTree(x: number, z: number, rng: Rng): void {
    const h = 2 + rng() * 1.6;
    const leafColor = new THREE.Color(0x2e5c3a).multiplyScalar(0.8 + 0.4 * rng());
    this.solid.add(new THREE.CylinderGeometry(0.15, 0.18, h * 0.5, 6), new THREE.Color(0x3a2a1a), x, h * 0.25, z);
    if (rng() > 0.5) this.solid.add(new THREE.ConeGeometry(0.9, h, 7), leafColor, x, h * 0.9, z);
    else this.solid.add(new THREE.SphereGeometry(0.85 + 0.3 * rng(), 7, 5), leafColor, x, h * 0.7, z);
  }

  // One instanced mesh per vehicle type (see vehicles.ts), plus a matching mesh for its
  // night lights that shares the body's instance matrices.
  private buildCars(): void {
    const W = CAR_WIDTH * WORLD_PER_M;
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 });
    for (const kind of VEHICLE_KINDS) {
      const geo = vehicleGeometry(kind, WORLD_PER_M, W);
      const body = new THREE.InstancedMesh(geo.body, bodyMat, MAX_CARS);
      body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const lights = new THREE.InstancedMesh(geo.lights, this.carLightMat, MAX_CARS);
      lights.instanceMatrix = body.instanceMatrix; // same poses as the bodies
      const brake = new THREE.InstancedMesh(geo.brake, this.brakeMat, MAX_CARS);
      brake.instanceMatrix = body.instanceMatrix;
      for (const m of [body, lights, brake]) {
        m.count = 0;
        m.frustumCulled = false;
        this.scene.add(m);
      }
      this.carLights.push(lights);
      this.fleet.set(kind, { body, lights, brake, n: 0 });
    }
  }

  // A point inside the zone's block near one of its corner nodes, where its buildings are.
  // Trips start and end at intersections; this is the lot a car pulls out of or into.
  private lotPoint(node: number, zoneId: number): THREE.Vector2 {
    if (this.nodeZones.length === 0) {
      this.nodeZones = this.sim.grid.net.nodes.map(() => []);
      for (const z of this.sim.zones) for (const n of z.accessNodes) this.nodeZones[n].push(z.id);
    }
    const zones = this.nodeZones[node];
    const z = this.sim.zones[zones.includes(zoneId) ? zoneId : zones[0]];
    const n = this.sim.grid.net.nodes[node];
    return new THREE.Vector2(n.x + (z.cx - n.x) * LOT_DEPTH, n.y + (z.cy - n.y) * LOT_DEPTH);
  }

  private placeCar(kind: VehicleKind, trip: Trip, x: number, y: number, hx: number, hy: number, lift: number, scale: number, braking: boolean): void {
    const f = this.fleet.get(kind)!;
    if (f.n >= MAX_CARS) return;
    this.tmp.position.set(this.wx(x), lift, this.wz(y));
    this.tmp.rotation.set(0, -Math.atan2(hy, hx), 0);
    this.tmp.scale.setScalar(scale);
    this.tmp.updateMatrix();
    f.body.setMatrixAt(f.n, this.tmp.matrix);
    f.body.setColorAt(f.n, vehiclePaint(trip, kind, this.tmpColor));
    f.brake.setColorAt(f.n, braking ? BRAKE_ON : BRAKE_OFF);
    f.n++;
  }

  private syncCars(): void {
    const traffic = this.sim.traffic;
    const now = this.sim.time;
    for (const f of this.fleet.values()) f.n = 0;
    for (const veh of traffic.vehicles) {
      const kind = veh.trip.kind ?? 'sedan';
      const p = traffic.pose(veh);
      const age = now - veh.departTime;
      if (age >= 0 && age < DEPART_S) {
        // Pulling out: blend from the origin lot onto the road, joining the car's real position.
        const lot = this.lotPoint(veh.trip.originNode, veh.trip.originZone);
        const road = new THREE.Vector2(p.x, p.y);
        const c = new THREE.Vector2(p.x - p.hx * 10, p.y - p.hy * 10);
        const s = ease(age / DEPART_S);
        bezier(lot, c, road, s, this.bp, this.bd);
        this.placeCar(kind, veh.trip, this.bp.x, this.bp.y, this.bd.x, this.bd.y, 0.08 + 0.18 * s, 0.6 + 0.4 * s, false);
      } else {
        // On the road surface; brake lights while slowing down or held at a stop.
        this.placeCar(kind, veh.trip, p.x, p.y, p.hx, p.hy, 0.26, 1, veh.acc < -0.8 || veh.v < 0.5);
      }
    }
    // Cars that reached their destination this frame turn off into their lot.
    for (const veh of this.lastVehicles) {
      if (traffic.vehicles.has(veh) || veh.ri !== veh.route.length - 1 || veh.stoppedFor >= 180) continue; // still driving, or removed by the gridlock guard
      const p = traffic.pose(veh);
      const p0 = new THREE.Vector2(p.x, p.y);
      const p2 = this.lotPoint(veh.trip.destNode, veh.trip.destZone);
      const c = new THREE.Vector2(p.x + p.hx * 10, p.y + p.hy * 10);
      const dist = p0.distanceTo(c) + c.distanceTo(p2);
      this.parking.push({ trip: veh.trip, kind: veh.trip.kind ?? 'sedan', p0, c, p2, start: now, dur: dist / PARK_SPEED });
    }
    this.lastVehicles = new Set(traffic.vehicles);
    this.parking = this.parking.filter((pk) => now - pk.start < pk.dur && now >= pk.start);
    for (const pk of this.parking) {
      const s = ease((now - pk.start) / pk.dur);
      bezier(pk.p0, pk.c, pk.p2, s, this.bp, this.bd);
      this.placeCar(pk.kind, pk.trip, this.bp.x, this.bp.y, this.bd.x, this.bd.y, 0.26 - 0.18 * s, 1 - 0.4 * s, true);
    }
    for (const f of this.fleet.values()) {
      f.body.count = f.n;
      f.lights.count = f.n;
      f.brake.count = f.n;
      f.body.instanceMatrix.needsUpdate = true;
      if (f.body.instanceColor) f.body.instanceColor.needsUpdate = true;
      if (f.brake.instanceColor) f.brake.instanceColor.needsUpdate = true;
    }
  }

  // Signal heads on every approach to junctions on an arterial. Poles and housings are static;
  // the lamps are one instanced mesh recoloured each frame.
  private buildSignals(): void {
    const net = this.sim.grid.net;
    const pole = new THREE.Color(0x30343a);
    const housing = new THREE.Color(0x15181c);
    const lampPos: THREE.Vector3[] = [];
    for (let node = 0; node < net.nodes.length; node++) {
      const ins = net.inLinks[node];
      if (ins.length < 3 || !ins.some((id) => net.links[id].arterial)) continue;
      const c = net.nodes[node];
      for (const id of ins) {
        const link = net.links[id];
        const a = net.nodes[link.from];
        const dx = (c.x - a.x) / link.length;
        const dy = (c.y - a.y) / link.length;
        // Kerbside on the approach's right, just before the junction (metres, y-down).
        const half = (link.arterial ? 1.6 : 1.3) / 2 / WORLD_PER_M;
        const px = c.x - dx * (JUNCTION_RADIUS + 1) - dy * (half + 1.2);
        const py = c.y - dy * (JUNCTION_RADIUS + 1) + dx * (half + 1.2);
        const x = this.wx(px);
        const z = this.wz(py);
        this.solid.add(new THREE.CylinderGeometry(0.035, 0.045, 1.3, 6), pole, x, 0.65, z);
        this.solid.add(new THREE.BoxGeometry(0.13, 0.32, 0.13), housing, x, 1.36, z);
        // Lamps face the oncoming cars.
        const fx = x - dx * 0.07;
        const fz = z - dy * 0.07;
        lampPos.push(new THREE.Vector3(fx, 1.44, fz), new THREE.Vector3(fx, 1.28, fz));
        this.signals.push({ lane: id, node, arterial: link.arterial });
      }
    }
    this.signalLamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.058, 8, 6), new THREE.MeshBasicMaterial(), lampPos.length);
    const m = new THREE.Matrix4();
    lampPos.forEach((p, i) => {
      this.signalLamps.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      this.signalLamps.setColorAt(i, SIGNAL.redOff);
    });
    this.scene.add(this.signalLamps);
  }

  private syncSignals(): void {
    const traffic = this.sim.traffic;
    this.signals.forEach((sg, i) => {
      const box = traffic.boxes[sg.node];
      let green = false;
      for (const h of box.holders) {
        if (h.route[h.ri] === sg.lane) {
          green = true;
          break;
        }
      }
      if (!green) {
        // Nobody from here in the junction: red if a car waits; if none, arterials rest on green.
        const front = traffic.lanes[sg.lane].vehicles[0];
        const waiting = front !== undefined && !front.granted && front.requestSince >= 0;
        green = !waiting && box.holders.size === 0 && sg.arterial;
      }
      this.signalLamps.setColorAt(2 * i, green ? SIGNAL.redOff : SIGNAL.red);
      this.signalLamps.setColorAt(2 * i + 1, green ? SIGNAL.green : SIGNAL.greenOff);
    });
    this.signalLamps.instanceColor!.needsUpdate = true;
  }

  // Street tint follows the slower direction's mean speed relative to the limit.
  private syncCongestion(): void {
    const traffic = this.sim.traffic;
    const net = this.sim.grid.net;
    const colors = this.roads.geometry.attributes.color as THREE.BufferAttribute;
    for (const st of this.streets) {
      let ratio = 1;
      for (const id of st.links) {
        if (traffic.lanes[id].vehicles.length > 0 || traffic.isForcedJammed(id)) ratio = Math.min(ratio, traffic.linkMeanSpeed(id) / net.links[id].speedLimit);
      }
      const color = ratio < 0.3 ? ROAD_COLORS.jammed : ratio < 0.6 ? ROAD_COLORS.slow : st.arterial ? ROAD_COLORS.arterial : ROAD_COLORS.local;
      this.tmpColor.setHex(color);
      for (let v = st.firstVertex; v < st.firstVertex + st.vertexCount; v++) {
        colors.setXYZ(v, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
      }
    }
    colors.needsUpdate = true;
  }

  // Highlight the most recently assigned route so the cost proof is visible
  // in the same view as the traffic and congestion tinting.
  private syncRouteHighlight(): void {
    if (!this.routeHighlight) return;
    const decision = this.followTrip !== null ? this.sim.probeDecision : this.showDesireLines ? this.sim.proofRoute : null;
    if (!decision) {
      this.routeHighlight.visible = false;
      this.highlightedTrip = -1;
      return;
    }
    if (decision.tripId === this.highlightedTrip) return;
    this.highlightedTrip = decision.tripId;
    const points: number[] = [];
    for (const id of decision.chosen.links) {
      const link = this.sim.grid.net.links[id];
      const a = this.sim.grid.net.nodes[link.from];
      const b = this.sim.grid.net.nodes[link.to];
      points.push(this.wx(a.x), 0, this.wz(a.y), this.wx(b.x), 0, this.wz(b.y));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.routeHighlight.geometry.dispose();
    this.routeHighlight.geometry = geometry;
    this.routeHighlight.visible = points.length > 0;
  }

  private syncProofCar(): void {
    if (!this.proofCar) return;
    const proofId = this.followTrip ?? (this.showDesireLines ? this.sim.proofRoute?.tripId : undefined);
    if (proofId === undefined) {
      this.proofCar.visible = false;
      return;
    }
    const vehicle = [...this.sim.traffic.vehicles].find((v) => v.trip.id === proofId);
    if (!vehicle) {
      this.proofCar.visible = false;
      return;
    }
    const p = this.sim.traffic.pose(vehicle);
    this.proofCar.position.set(this.wx(p.x), 0.275, this.wz(p.y)); // just above the road surface
    this.proofCar.rotation.y = -Math.atan2(p.hy, p.hx);
    this.proofCar.scale.setScalar(vehicle.len * WORLD_PER_M);
    this.proofCar.visible = true;
  }

  // Fixed pool of OD arcs in one line batch, reused round-robin so busy peaks allocate
  // nothing. Additive blending: fading an arc's colour to black fades it out.
  private buildArcPool(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_POOL * VERTS_PER_ARC * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ARC_POOL * VERTS_PER_ARC * 3), 3));
    this.arcLines = new THREE.LineSegments(
      geo,
      // No fog: fog would tint faded (black) arcs toward the sky colour and leave them visible.
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    this.arcLines.frustumCulled = false;
    this.scene.add(this.arcLines);
    for (let k = 0; k < ARC_POOL; k++) this.arcs.push({ rgb: [0, 0, 0], born: -Infinity });
  }

  addTrips(trips: Trip[], now: number): void {
    if (!this.showDesireLines) return;
    for (const t of trips) {
      const o = this.sim.zones[t.originZone];
      const d = this.sim.zones[t.destZone];
      const k = this.nextArc;
      const arc = this.arcs[k];
      this.nextArc = (this.nextArc + 1) % ARC_POOL;
      const pos = this.arcLines.geometry.attributes.position as THREE.BufferAttribute;
      const x0 = this.wx(o.cx);
      const z0 = this.wz(o.cy);
      const x1 = this.wx(d.cx);
      const z1 = this.wz(d.cy);
      const lift = 3 + 0.25 * Math.hypot(x1 - x0, z1 - z0);
      const setPoint = (v: number, s: number) =>
        pos.setXYZ(v, x0 + (x1 - x0) * s, 0.5 + lift * 4 * s * (1 - s), z0 + (z1 - z0) * s);
      for (let seg = 0; seg < SEGS_PER_ARC; seg++) {
        const v = k * VERTS_PER_ARC + seg * 2;
        setPoint(v, seg / SEGS_PER_ARC);
        setPoint(v + 1, (seg + 1) / SEGS_PER_ARC);
      }
      pos.needsUpdate = true;
      const c = new THREE.Color(ZONE_HEX[o.type]);
      arc.rgb = [c.r, c.g, c.b];
      arc.born = now;
    }
  }

  // Nearest intersection under a screen point, or null if off the map.
  pickNode(clientX: number, clientY: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, hit)) return null;
    const { cols, rows, spacing } = this.sim.grid.opts;
    const c = Math.round((hit.x / WORLD_PER_M + this.sim.grid.width / 2) / spacing);
    const r = Math.round((hit.z / WORLD_PER_M + this.sim.grid.height / 2) / spacing);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
    return this.sim.grid.nodeAt(r, c);
  }

  private buildTags(): void {
    const parent = this.container.parentElement!;
    const make = (cls: string) => {
      const el = document.createElement('div');
      el.className = `tag ${cls}`;
      el.hidden = true;
      parent.appendChild(el);
      return el;
    };
    this.tags = { start: make('tag-start'), end: make('tag-end'), car: make('tag-car') };
    this.tags.start.textContent = 'Start';
    this.tags.end.textContent = 'Destination';
  }

  // Pin a label above a world point; hidden when the point is behind the camera or off screen.
  private placeTag(el: HTMLDivElement, x: number, y: number, z: number): void {
    const v = this.tagV.set(x, y, z).project(this.camera);
    const onScreen = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
    el.hidden = !onScreen;
    if (!onScreen) return;
    const sx = this.container.offsetLeft + ((v.x + 1) / 2) * this.container.clientWidth;
    const sy = this.container.offsetTop + ((1 - v.y) / 2) * this.container.clientHeight;
    el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
  }

  // Start/destination labels on the pins, and a live distance/ETA label over the probe car.
  private syncTags(): void {
    const [from, to] = this.pinNodes;
    [this.tags.start, this.tags.end].forEach((el, k) => {
      const node = k === 0 ? from : to;
      if (node === null) {
        el.hidden = true;
        return;
      }
      const n = this.sim.grid.net.nodes[node];
      this.placeTag(el, this.wx(n.x), 5.4, this.wz(n.y));
    });
    const veh = this.followVeh;
    if (this.followTrip === null || !veh || !this.sim.traffic.vehicles.has(veh)) {
      this.tags.car.hidden = true;
      return;
    }
    const traffic = this.sim.traffic;
    const net = this.sim.grid.net;
    const lane = traffic.lanes[veh.route[veh.ri]];
    const onLane = veh.conn ? 0 : Math.max(0, lane.geom.length - veh.pos);
    const rest = veh.route.slice(veh.ri + 1);
    let metres = onLane;
    for (const id of rest) metres += net.links[id].length;
    const eta = onLane / Math.max(1, traffic.linkMeanSpeed(lane.link.id)) + this.sim.router.pathCost(rest);
    const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    const text = `PROBE · ${(metres / 1000).toFixed(1)} km left · ETA ${clock(eta)} · ${clock(this.sim.time - veh.departTime)} elapsed`;
    if (this.tags.car.textContent !== text) this.tags.car.textContent = text;
    const p = traffic.pose(veh);
    this.placeTag(this.tags.car, this.wx(p.x), 1.4, this.wz(p.y));
  }

  setProbePins(from: number | null, to: number | null): void {
    this.pinNodes = [from, to];
    [from, to].forEach((node, k) => {
      const pin = this.probePins[k];
      pin.visible = node !== null;
      if (node === null) return;
      const n = this.sim.grid.net.nodes[node];
      pin.position.set(this.wx(n.x), 0, this.wz(n.y));
    });
  }

  // Keep the camera on one trip's vehicle until it arrives; null stops following.
  follow(tripId: number | null): void {
    this.followTrip = tripId;
    this.followVeh = null;
    this.followSeen = false;
  }

  get following(): boolean {
    return this.followTrip !== null;
  }

  private syncFollow(): void {
    if (this.followTrip === null) return;
    if (!this.followVeh || !this.sim.traffic.vehicles.has(this.followVeh)) {
      this.followVeh = null;
      for (const v of this.sim.traffic.vehicles) if (v.trip.id === this.followTrip) this.followVeh = v;
      if (!this.followVeh) {
        // Not on the road yet (waiting to depart), or already arrived.
        if (this.followSeen) {
          this.follow(null);
          this.onFollowEnd?.();
        }
        return;
      }
    }
    const p = this.sim.traffic.pose(this.followVeh);
    const target = new THREE.Vector3(this.wx(p.x), 0.3, this.wz(p.y));
    if (!this.followSeen) {
      // Swing in close, keeping the current viewing direction.
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(dir, 28);
      this.followSeen = true;
      return;
    }
    const delta = target.sub(this.controls.target).multiplyScalar(0.15);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  // Sky and lights follow the sim clock: windows, street lamps and headlights come on at dusk.
  private syncDaylight(): void {
    this.sky.update(hourOf(this.sim.time), this.camera);
    const night = this.sky.night;
    this.facadeMat.emissiveIntensity = 0.04 + 0.9 * night;
    this.lampHeadMat.color.setScalar(0.35 + 0.65 * night);
    this.lampPoolMat.color.setScalar(0.32 * night);
    this.lampPools.visible = night > 0.02;
    this.carLightMat.color.setScalar(night);
    for (const m of this.carLights) m.visible = night > 0.02;
  }

  render(now: number): void {
    const arcColors = this.arcLines.geometry.attributes.color as THREE.BufferAttribute;
    let arcsChanged = false;
    let arcsLive = false;
    this.arcs.forEach((arc, k) => {
      if (arc.born === -Infinity) return;
      const age = now - arc.born;
      const fade = age >= ARC_LIFE_MS || !this.showDesireLines ? 0 : 0.7 * (1 - age / ARC_LIFE_MS);
      if (fade === 0) arc.born = -Infinity;
      else arcsLive = true;
      for (let v = k * VERTS_PER_ARC; v < (k + 1) * VERTS_PER_ARC; v++) {
        arcColors.setXYZ(v, arc.rgb[0] * fade, arc.rgb[1] * fade, arc.rgb[2] * fade);
      }
      arcsChanged = true;
    });
    if (arcsChanged) arcColors.needsUpdate = true;
    this.arcLines.visible = arcsLive;
    this.syncCars();
    this.syncDaylight();
    this.syncRouteHighlight();
    this.syncProofCar();
    this.syncFollow();
    this.syncSignals();
    this.syncTags();
    if (now - this.lastCongestion > CONGESTION_REFRESH_MS) {
      this.lastCongestion = now;
      this.syncCongestion();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
