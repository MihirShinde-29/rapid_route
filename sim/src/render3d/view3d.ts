import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mulberry32, type Rng } from '../core/rng';
import type { Incident, IncidentKind, Simulation } from '../sim';
import type { Trip } from '../demand/trips';
import { DEPART_FRAC, type Vehicle } from '../traffic/traffic';
import { JUNCTION_RADIUS } from '../traffic/geometry';
import { nearestJunction } from '../network/grid';
import type { BlockPlan, Rect as CityRect, Site } from '../city/sites';
import type { Light } from '../traffic/signals';
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
const ROAD_COLORS = { local: 0x262d35, arterial: 0x2e3640, slow: 0x9a6a2a, jammed: 0x9a3a2a, closed: 0x6a2448 };
// Incident pins, seen from city zoom; close up the scene shows wrecks, cones or barriers.
export const INCIDENT_HEX: Record<IncidentKind, number> = { accident: 0xff4d4d, lane: 0xffa53d, closure: 0xc04a8c };
const LAMP_COLOR = 0xffc27a;
const CONGESTION_REFRESH_MS = 500;
const DEPART_S = 4; // sim s a new car takes to pull out of its lot onto the road
const PARK_SPEED = 6; // m/s driving off the road into the destination lot
const DRIVEWAY_M = 13; // how far beside the lane a car's driveway starts

type Area = { x0: number; x1: number; z0: number; z1: number }; // world units


// A car that has arrived: drawn driving from the road into its destination lot, then gone.
interface Parking {
  trip: Trip;
  kind: VehicleKind;
  p0: THREE.Vector2; // m, where it left the road
  c: THREE.Vector2; // Bezier control point
  p2: THREE.Vector2; // the lot
  start: number; // sim s
  dur: number;
  turn: Turn; // indicator towards the lot
}

function bezier(a: THREE.Vector2, c: THREE.Vector2, b: THREE.Vector2, s: number, out: THREE.Vector2, dir: THREE.Vector2): void {
  const u = 1 - s;
  out.set(u * u * a.x + 2 * u * s * c.x + s * s * b.x, u * u * a.y + 2 * u * s * c.y + s * s * b.y);
  dir.set(2 * u * (c.x - a.x) + 2 * s * (b.x - c.x), 2 * u * (c.y - a.y) + 2 * s * (b.y - c.y));
}

const ease = (s: number) => s * s * (3 - 2 * s);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

const BRAKE_ON = new THREE.Color(1, 0.12, 0.06);
const BRAKE_OFF = new THREE.Color(0, 0, 0); // additive: black draws nothing
const INDICATOR_ON = new THREE.Color(1, 0.55, 0.05);
const INDICATE_M = 40; // start indicating this far before a turn
type Turn = 'left' | 'right' | null;
const SIGNAL = {
  red: new THREE.Color(1, 0.12, 0.08),
  redOff: new THREE.Color(0.18, 0.04, 0.03),
  yellow: new THREE.Color(1, 0.72, 0.1),
  yellowOff: new THREE.Color(0.17, 0.12, 0.03),
  green: new THREE.Color(0.2, 1, 0.45),
  greenOff: new THREE.Color(0.03, 0.14, 0.06),
};

// A signal head on one approach to a signalised junction. Its lamps show the sim's timed
// signal for that approach, the same light the cars obey.
interface Signal {
  lane: number;
  light: Light | null; // last shown, so lamps are only recoloured on a change
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
  private bp = new THREE.Vector2();
  private bd = new THREE.Vector2();
  private fleet = new Map<
    VehicleKind,
    {
      body: THREE.InstancedMesh;
      lights: THREE.InstancedMesh;
      brake: THREE.InstancedMesh;
      left: THREE.InstancedMesh;
      right: THREE.InstancedMesh;
      n: number;
    }
  >();
  private blinkOn = false;
  private brakeMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  private signals: Signal[] = [];
  private signalLamps!: THREE.InstancedMesh; // three per signal: red, yellow, green
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
  // Chase camera: sits behind the followed car and turns with it. Dragging looks around;
  // after letting go the view swings back to face forward.
  private chase = { heading: 0, look: 0, pitch: 1.05, dist: 16, dragging: false, released: 0, frame: 0 };
  private raycaster = new THREE.Raycaster();
  private incidentGroup = new THREE.Group();
  private incidentKey = '';
  private beacons: THREE.MeshBasicMaterial[] = [];
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
    this.controls.addEventListener('start', () => {
      this.chase.dragging = true;
    });
    this.controls.addEventListener('end', () => {
      this.chase.dragging = false;
      this.chase.released = performance.now();
      if (this.followSeen) {
        // Keep the zoom, tilt and look direction the user dragged to, relative to the car.
        const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
        this.chase.look = wrapAngle(s.theta - this.chase.heading);
        this.chase.pitch = s.phi;
        this.chase.dist = s.radius;
      }
    });
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

    this.scene.add(this.incidentGroup);

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
      const degree = net.outLinks[n.id].length;
      if (degree === 0) continue; // inside a superblock
      // Dead ends get a turning circle.
      const r = degree === 1 ? 1.9 : 1.3;
      this.flat.add(new THREE.CylinderGeometry(r, r, 0.26, 20), nodeColor, this.wx(n.x), 0.13, this.wz(n.y));
    }
  }

  // Draws the city layout from the simulation (sim/src/city/sites.ts): which block holds what,
  // and every site's lot. This only decides looks: heights, colours, roofs and trees.
  private buildZones(rng: Rng): void {
    const { net, blocks } = this.sim.grid;
    const layout = this.sim.layout;
    for (const z of this.sim.zones) {
      const plan = layout.blocks[z.id];
      const [a, b, c, d] = blocks[z.id].corners;
      const [tl, tr, br, bl] = [a, b, c, d].map((n) => net.nodes[n]);
      // Sides without a street (superblocks, dropped streets) run to the centreline so
      // neighbouring plates join up.
      const ins = (on: boolean) => (on ? BLOCK_INSET / WORLD_PER_M : 0);
      const st = plan.streets;
      const tint = new THREE.Color(ZONE_HEX[z.type]);
      // Low-density blocks read as lawns; denser blocks as paved lots tinted by zone type.
      const plateColor =
        z.type === 'park' ? new THREE.Color(0x3d5a30)
        : z.type === 'residential' && z.density < 0.45 ? new THREE.Color(0x46603a).lerp(tint, 0.08)
        : new THREE.Color(0x30363d).lerp(tint, 0.14);
      const quad = [
        [tl.x + ins(st.w), tl.y + ins(st.n)],
        [tr.x - ins(st.e), tr.y + ins(st.n)],
        [br.x - ins(st.e), br.y - ins(st.s)],
        [bl.x + ins(st.w), bl.y - ins(st.s)],
      ].map(([x, y]) => new THREE.Vector3(this.wx(x), 0.03, this.wz(y)));
      // A unit plane (same attributes as the rest of the batch) with its corners moved onto the quad.
      const plate = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      [quad[0], quad[1], quad[3], quad[2]].forEach((q, i) => plate.attributes.position.setXYZ(i, q.x, q.y, q.z));
      this.flat.add(plate, plateColor, 0, 0, 0);
      this.drawBlock(plan, z, tint, rng);
    }
    for (const sb of layout.superblocks) {
      if (sb.kind === 'park') this.addPark(this.area(sb.rect), rng, true);
      else this.addMall(this.area(sb.rect), rng);
    }
    this.buildStreetTrees(rng);
  }

  // A rectangle in sim metres as world units.
  private area(r: CityRect): Area {
    return { x0: this.wx(r.x0), x1: this.wx(r.x1), z0: this.wz(r.y0), z1: this.wz(r.y1) };
  }

  // Building styles vary block by block: towers, podiums, plazas and car parks downtown,
  // perimeter blocks or apartment lots in denser housing, houses along the streets in the
  // suburbs, sheds and container yards in industrial blocks.
  private drawBlock(plan: BlockPlan, z: Zone, tint: THREE.Color, rng: Rng): void {
    const r = this.area(plan.rect);
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const color = () => {
      const grey = 0.35 + (0.45 + 0.4 * rng()) * 0.25;
      return new THREE.Color(grey * 0.9, grey * 0.95, grey * 1.05).lerp(tint, 0.18);
    };
    const sites = plan.sites.map((id) => this.sim.sites[id]);
    const lot = (site: Site) => {
      const q = this.area(site.lot);
      return { ...q, x: (q.x0 + q.x1) / 2, z: (q.z0 + q.z1) / 2, cell: Math.min(q.x1 - q.x0, q.z1 - q.z0) };
    };
    switch (plan.style) {
      case 'tower_plaza':
      case 'towers':
      case 'parking':
        for (const site of sites) {
          const q = lot(site);
          if (site.kind === 'tower') this.addTower(q.x, q.z, q.cell, z.density, color(), rng);
          else if (site.kind === 'plaza') this.addPlaza(q, rng);
          else if (site.kind === 'parking') this.addParkingLot(q, rng);
          else this.addBlock(q.x1 - q.x0, 2 * FLOOR, q.z1 - q.z0, q.x, 0, q.z, color(), rng);
        }
        break;
      case 'podium': {
        // One podium over the whole block with towers rising from it.
        const base = (2 + Math.floor(rng() * 2)) * FLOOR;
        this.addBlock(w, base, d, cx, 0, cz, color(), rng);
        const n = w > d * 1.3 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const h = (8 + 18 * z.density) * (0.6 + 0.5 * rng());
          const fp = Math.min(w / n, d) * 0.55;
          this.addBlock(fp, h, fp, r.x0 + (w / n) * (k + 0.5), base, cz, color(), rng);
        }
        break;
      }
      case 'shed_yard': {
        // One big shed and a yard with shipping containers.
        const shedW = w * plan.split;
        this.addWarehouse(r.x0 + shedW / 2, cz, Math.min(shedW, d), color(), rng);
        this.addYard({ x0: r.x0 + shedW + 0.4, x1: r.x1, z0: r.z0, z1: r.z1 }, rng);
        break;
      }
      case 'warehouses':
        for (const site of sites) {
          const q = lot(site);
          this.addWarehouse(q.x, q.z, q.cell, color(), rng);
        }
        break;
      case 'perimeter': {
        // Apartment slabs round the edge, a green courtyard inside.
        const floors = Math.max(3, Math.round(((1.6 + 7 * z.density) * (0.7 + 0.4 * rng())) / FLOOR));
        const c = color();
        for (const site of sites) {
          const q = lot(site);
          this.addBlock(q.x1 - q.x0, floors * FLOOR, q.z1 - q.z0, q.x, 0, q.z, c, rng);
        }
        const t = Math.min(w, d) * 0.24;
        this.flat.add(new THREE.PlaneGeometry(w - 2 * t, d - 2 * t), new THREE.Color(0x3f5c34), cx, 0.05, cz, -Math.PI / 2);
        for (let k = 0; k < 3; k++) this.addTree(cx + (rng() - 0.5) * (w - 2 * t) * 0.6, cz + (rng() - 0.5) * (d - 2 * t) * 0.6, rng, 0.6);
        break;
      }
      case 'apartments':
        for (const site of sites) {
          const q = lot(site);
          this.addApartment(q.x, q.z, q.cell, z.density, color(), rng);
        }
        for (const e of plan.empty) {
          const q = this.area(e);
          this.addTree((q.x0 + q.x1) / 2, (q.z0 + q.z1) / 2, rng, 0.7);
        }
        break;
      case 'houses':
        for (const site of sites) this.drawHouse(site, rng);
        break;
      case 'park':
        this.addPark(r, rng, false);
        break;
      case 'station':
        for (const site of sites) this.drawStation(site, rng);
        break;
    }
  }

  // A house set back behind a lawn, a driveway from the street to its door, and sometimes a
  // pool or a tree in the back garden.
  private drawHouse(site: Site, rng: Rng): void {
    const q = this.area(site.lot);
    // Outward normal (towards the street) and the lot's depth along it.
    const [nx, nz] = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] }[site.front];
    const deep = nx !== 0 ? q.x1 - q.x0 : q.z1 - q.z0;
    const wide = nx !== 0 ? q.z1 - q.z0 : q.x1 - q.x0;
    const fx = nx !== 0 ? (nx < 0 ? q.x0 : q.x1) : (q.x0 + q.x1) / 2;
    const fz = nz !== 0 ? (nz < 0 ? q.z0 : q.z1) : (q.z0 + q.z1) / 2;
    const c = new THREE.Color().setHSL(0.08 + 0.06 * rng(), 0.18 + 0.2 * rng(), 0.55 + 0.2 * rng());
    this.addHouse(fx - nx * deep * 0.42, fz - nz * deep * 0.42, Math.min(wide, deep) * 1.05, c, rng);
    // Driveway from the street to the door.
    const dl = deep * 0.3;
    const dx = this.wx(site.door.x);
    const dz = this.wz(site.door.y);
    this.flat.add(new THREE.PlaneGeometry(nx !== 0 ? dl : 0.5, nz !== 0 ? dl : 0.5), new THREE.Color(0x5a5f66), dx - nx * dl * 0.5, 0.045, dz - nz * dl * 0.5, -Math.PI / 2);
    const bx = fx - nx * deep * 0.88;
    const bz = fz - nz * deep * 0.88;
    const extra = rng();
    if (extra < 0.12) this.flat.add(new THREE.PlaneGeometry(0.9, 0.55), new THREE.Color(0x3fa7c9), bx, 0.05, bz, -Math.PI / 2);
    else if (extra < 0.55) this.addTree(bx + Math.abs(nz) * (rng() - 0.5) * wide * 0.5, bz + Math.abs(nx) * (rng() - 0.5) * wide * 0.5, rng, 0.55);
  }

  // Placeholder station buildings (their own models come later): a hospital with a red cross on
  // the roof, a red-brick fire station, a blue-grey police station.
  private drawStation(site: Site, rng: Rng): void {
    const q = this.area(site.lot);
    const x = (q.x0 + q.x1) / 2;
    const z = (q.z0 + q.z1) / 2;
    const w = (q.x1 - q.x0) * 0.8;
    const d = (q.z1 - q.z0) * 0.8;
    const look = {
      hospital: { color: 0xe4e6ea, floors: 6 },
      fire_station: { color: 0x9a3b2c, floors: 2 },
      police_station: { color: 0x4a5e7a, floors: 3 },
    }[site.kind as 'hospital' | 'fire_station' | 'police_station'];
    const h = look.floors * FLOOR;
    this.addBlock(w, h, d, x, 0, z, new THREE.Color(look.color), rng);
    if (site.kind === 'hospital') {
      const red = new THREE.Color(0xd8262a);
      const s = Math.min(w, d) * 0.4;
      this.solid.add(new THREE.BoxGeometry(s, 0.05, s * 0.3), red, x, h + 0.2, z);
      this.solid.add(new THREE.BoxGeometry(s * 0.3, 0.05, s), red, x, h + 0.2, z);
    }
  }

  private addPlaza(r: Area, rng: Rng): void {
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    this.flat.add(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.Color(0x8d8a82), cx, 0.04, cz, -Math.PI / 2);
    this.solid.add(new THREE.CylinderGeometry(0.9, 0.95, 0.18, 20), new THREE.Color(0x9a978f), cx, 0.09, cz); // fountain
    this.flat.add(new THREE.CircleGeometry(0.8, 20), new THREE.Color(0x4aa3c8), cx, 0.19, cz, -Math.PI / 2);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      this.addTree(cx + sx * (r.x1 - r.x0) * 0.32, cz + sz * (r.z1 - r.z0) * 0.32, rng, 0.6);
    }
  }

  // Painted bays with parked cars in the usual paint colours.
  private addParkingLot(r: Area, rng: Rng): void {
    const line = new THREE.Color(0xbfc4ca);
    this.flat.add(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.Color(0x2b3036), (r.x0 + r.x1) / 2, 0.04, (r.z0 + r.z1) / 2, -Math.PI / 2);
    const bay = 0.4; // ~2.8 m
    const rowDepth = 0.75;
    const paints = [0xe9e9ea, 0x1b1c1f, 0xa9aeb5, 0x5b6068, 0x24467e, 0x9b1f1f];
    for (let z = r.z0 + 0.3; z + rowDepth <= r.z1 - 0.2; z += rowDepth * 2 + 0.6) {
      for (let x = r.x0 + 0.3; x + bay <= r.x1 - 0.3; x += bay) {
        this.flat.add(new THREE.PlaneGeometry(0.025, rowDepth), line, x, 0.05, z + rowDepth / 2, -Math.PI / 2);
        if (rng() < 0.6) {
          const car = new THREE.Color(paints[Math.floor(rng() * paints.length)]);
          this.solid.add(new THREE.BoxGeometry(0.28, 0.2, 0.6), car, x + bay / 2, 0.12, z + rowDepth / 2);
        }
      }
    }
  }

  // Concrete yard with stacks of shipping containers.
  private addYard(r: Area, rng: Rng): void {
    if (r.x1 - r.x0 < 1.5) return;
    const cz = (r.z0 + r.z1) / 2;
    this.flat.add(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.Color(0x6b6a66), (r.x0 + r.x1) / 2, 0.04, cz, -Math.PI / 2);
    const colors = [0xb0412e, 0x2f6aa3, 0x3b7d4a, 0xc58b2b, 0x8a8f96];
    const cw = 0.36; // 2.5 m wide, 12 m long
    for (let x = r.x0 + 0.4; x + cw < r.x1 - 0.2; x += cw + 0.1) {
      if (rng() < 0.3) continue;
      const stack = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < stack; k++) {
        const c = new THREE.Color(colors[Math.floor(rng() * colors.length)]);
        this.solid.add(new THREE.BoxGeometry(cw, 0.36, 1.7), c, x + cw / 2, 0.18 + 0.37 * k, cz - (r.z1 - r.z0) * 0.2);
      }
    }
  }

  // Lawn with crossing footpaths and trees; large parks also get a pond and a loop path.
  private addPark(r: Area, rng: Rng, large: boolean): void {
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const path = new THREE.Color(0xa59b84);
    this.flat.add(new THREE.PlaneGeometry(w, 0.35), path, cx, 0.045, cz, -Math.PI / 2);
    this.flat.add(new THREE.PlaneGeometry(0.35, d), path, cx, 0.046, cz, -Math.PI / 2);
    let pond: { x: number; z: number; r: number } | null = null;
    if (large) {
      pond = { x: cx + w * 0.22, z: cz - d * 0.2, r: Math.min(w, d) * 0.14 };
      const water = new THREE.CircleGeometry(pond.r, 28);
      water.scale(1.5, 1, 1);
      this.flat.add(water, new THREE.Color(0x3d7fa6), pond.x, 0.05, pond.z, -Math.PI / 2);
      const loop = Math.min(w, d) * 0.36;
      this.flat.add(new THREE.RingGeometry(loop, loop + 0.3, 48), path, cx, 0.047, cz, -Math.PI / 2);
    }
    const count = Math.round((w * d) / (large ? 9 : 12));
    for (let i = 0; i < count; i++) {
      const x = r.x0 + rng() * w;
      const z = r.z0 + rng() * d;
      if (Math.abs(x - cx) < 0.5 || Math.abs(z - cz) < 0.5) continue; // keep the paths clear
      if (pond && Math.hypot((x - pond.x) / 1.5, z - pond.z) < pond.r + 0.6) continue;
      this.addTree(x, z, rng, 0.8 + 0.4 * rng());
    }
  }

  // A big-box shopping centre with a large car park and trees along the edge.
  private addMall(r: Area, rng: Rng): void {
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const cx = (r.x0 + r.x1) / 2;
    this.addParkingLot({ x0: r.x0, x1: r.x1, z0: r.z0 + d * 0.48, z1: r.z1 }, rng);
    const bw = w * 0.82;
    const bd = d * 0.38;
    const bz = r.z0 + d * 0.06 + bd / 2;
    this.solid.add(new THREE.BoxGeometry(bw, 2 * FLOOR, bd), new THREE.Color(0xc9c2b4), cx, FLOOR, bz);
    this.solid.add(new THREE.BoxGeometry(bw * 0.3, 2.6 * FLOOR, bd * 0.5), new THREE.Color(0x7d8b99), cx, 1.3 * FLOOR, bz + bd * 0.3); // entrance hall
    for (let k = 0; k < 4; k++) {
      this.solid.add(new THREE.BoxGeometry(bw * 0.12, 0.3, bd * 0.2), new THREE.Color(0x5b6570), cx - bw * 0.3 + k * bw * 0.2, 2 * FLOOR + 0.15, bz - bd * 0.1); // roof plant
    }
    for (let x = r.x0 + 0.5; x < r.x1; x += 2.2) this.addTree(x, r.z1 - 0.3, rng, 0.6);
  }

  // Rows of trees along some streets: a third of local streets and half the arterials.
  private buildStreetTrees(rng: Rng): void {
    const net = this.sim.grid.net;
    const spots: [number, number][] = [];
    for (const link of net.links) {
      if (link.from > link.to || rng() > (link.arterial ? 0.5 : 0.33)) continue;
      const a = net.nodes[link.from];
      const b = net.nodes[link.to];
      const ax = this.wx(a.x);
      const az = this.wz(a.y);
      const len = Math.hypot(this.wx(b.x) - ax, this.wz(b.y) - az);
      const ux = (this.wx(b.x) - ax) / len;
      const uz = (this.wz(b.y) - az) / len;
      const off = (link.arterial ? 0.8 : 0.65) + 0.35;
      for (let t = 2.4; t < len - 2.4; t += 2.2) {
        if (Math.abs(t - len / 2) < 0.8) continue; // the street lamp
        for (const side of [-1, 1]) spots.push([ax + ux * t - uz * off * side, az + uz * t + ux * off * side]);
      }
    }
    const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
      const arr = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < arr.length; i += 3) arr.set([c.r, c.g, c.b], i);
      return g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    };
    const trunk = paint(new THREE.CylinderGeometry(0.06, 0.08, 0.8, 5).translate(0, 0.4, 0), new THREE.Color(0x4a3a2a));
    const crown = paint(new THREE.SphereGeometry(0.42, 7, 5).translate(0, 1.05, 0), new THREE.Color(1, 1, 1));
    const mesh = new THREE.InstancedMesh(
      mergeGeometries([trunk, crown])!,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }),
      spots.length,
    );
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    spots.forEach(([x, z], i) => {
      const s = 0.8 + 0.4 * rng();
      mesh.setMatrixAt(i, m.makeScale(s, s, s).setPosition(x, 0.25, z));
      mesh.setColorAt(i, col.setHex(0x3a6b34).multiplyScalar(0.75 + 0.5 * rng()));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
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

  private addTree(x: number, z: number, rng: Rng, scale = 1): void {
    const h = (2 + rng() * 1.6) * scale;
    const leafColor = new THREE.Color(0x2e5c3a).multiplyScalar(0.8 + 0.4 * rng());
    this.solid.add(new THREE.CylinderGeometry(0.15, 0.18, h * 0.5, 6), new THREE.Color(0x3a2a1a), x, h * 0.25, z);
    if (rng() > 0.5) this.solid.add(new THREE.ConeGeometry(0.9 * scale, h, 7), leafColor, x, h * 0.9, z);
    else this.solid.add(new THREE.SphereGeometry((0.85 + 0.3 * rng()) * scale, 7, 5), leafColor, x, h * 0.7, z);
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
      const left = new THREE.InstancedMesh(geo.indicatorL, this.brakeMat, MAX_CARS);
      left.instanceMatrix = body.instanceMatrix;
      const right = new THREE.InstancedMesh(geo.indicatorR, this.brakeMat, MAX_CARS);
      right.instanceMatrix = body.instanceMatrix;
      for (const m of [body, lights, brake, left, right]) {
        m.count = 0;
        m.frustumCulled = false;
        this.scene.add(m);
      }
      this.carLights.push(lights);
      this.fleet.set(kind, { body, lights, brake, left, right, n: 0 });
    }
  }

  // A driveway beside a lane: the point `along` metres down the lane, moved DRIVEWAY_M to the
  // right (y-down), into the block whose buildings face that street.
  private driveway(laneId: number, along: number): { x: number; y: number; hx: number; hy: number } {
    const p = this.sim.traffic.lanes[laneId].geom.pose(along);
    return { x: p.x - p.hy * DRIVEWAY_M, y: p.y + p.hx * DRIVEWAY_M, hx: p.hx, hy: p.hy };
  }

  private placeCar(kind: VehicleKind, trip: Trip, x: number, y: number, hx: number, hy: number, lift: number, scale: number, braking: boolean, turn: Turn = null): void {
    const f = this.fleet.get(kind)!;
    if (f.n >= MAX_CARS) return;
    this.tmp.position.set(this.wx(x), lift, this.wz(y));
    this.tmp.rotation.set(0, -Math.atan2(hy, hx), 0);
    this.tmp.scale.setScalar(scale);
    this.tmp.updateMatrix();
    f.body.setMatrixAt(f.n, this.tmp.matrix);
    f.body.setColorAt(f.n, vehiclePaint(trip, kind, this.tmpColor));
    f.brake.setColorAt(f.n, braking ? BRAKE_ON : BRAKE_OFF);
    f.left.setColorAt(f.n, this.blinkOn && turn === 'left' ? INDICATOR_ON : BRAKE_OFF);
    f.right.setColorAt(f.n, this.blinkOn && turn === 'right' ? INDICATOR_ON : BRAKE_OFF);
    f.n++;
  }

  // Which way a car is about to turn: on a turning connector, or approaching one.
  private turnAhead(veh: Vehicle): Turn {
    const traffic = this.sim.traffic;
    if (veh.conn) return veh.conn.kind === 'through' ? null : veh.conn.kind;
    if (veh.ri === veh.route.length - 1) return null;
    const lane = traffic.lanes[veh.route[veh.ri]];
    if (lane.geom.length - veh.pos > INDICATE_M) return null;
    const kind = traffic.connector(veh.route[veh.ri], veh.route[veh.ri + 1]).kind;
    return kind === 'through' ? null : kind;
  }

  // Side of the heading a point lies on (y-down: positive cross product is the right).
  private sideOf(px: number, py: number, hx: number, hy: number, tx: number, ty: number): Turn {
    return hx * (ty - py) - hy * (tx - px) > 0 ? 'right' : 'left';
  }

  private syncCars(): void {
    const traffic = this.sim.traffic;
    const now = this.sim.time;
    this.blinkOn = performance.now() % 700 < 380; // real time, so the blink rate ignores sim speed
    for (const f of this.fleet.values()) f.n = 0;
    for (const veh of traffic.vehicles) {
      const kind = veh.trip.kind ?? 'sedan';
      const p = traffic.pose(veh);
      const age = now - veh.departTime;
      if (age >= 0 && age < DEPART_S) {
        // Pulling out of a driveway beside the street: straight out to the kerb, then turning
        // to join the car's real position on the road.
        const lane = traffic.lanes[veh.route[0]];
        const d = this.driveway(lane.link.id, Math.max(veh.len, veh.trip.departPos ?? DEPART_FRAC * lane.geom.length) - veh.len / 2);
        const lot = new THREE.Vector2(d.x, d.y);
        const road = new THREE.Vector2(p.x, p.y);
        const c = new THREE.Vector2(d.x + d.hy * (DRIVEWAY_M - 1), d.y - d.hx * (DRIVEWAY_M - 1));
        const s = ease(age / DEPART_S);
        bezier(lot, c, road, s, this.bp, this.bd);
        // Indicates towards the road it is pulling onto.
        const turn = s < 0.7 ? this.sideOf(this.bp.x, this.bp.y, this.bd.x, this.bd.y, p.x + p.hx * 20, p.y + p.hy * 20) : null;
        this.placeCar(kind, veh.trip, this.bp.x, this.bp.y, this.bd.x, this.bd.y, 0.08 + 0.18 * s, 0.6 + 0.4 * s, false, turn);
      } else {
        // On the road surface; brake lights while slowing down or held at a stop.
        this.placeCar(kind, veh.trip, p.x, p.y, p.hx, p.hy, 0.26, 1, veh.acc < -0.8 || veh.v < 0.5, this.turnAhead(veh));
      }
    }
    // Cars that reached their destination this frame turn off into their lot.
    for (const veh of this.lastVehicles) {
      if (traffic.vehicles.has(veh) || veh.ri !== veh.route.length - 1 || veh.stoppedFor >= 180) continue; // still driving, or removed by the gridlock guard
      const p = traffic.pose(veh);
      // Turning off the street into a driveway beside it.
      const p0 = new THREE.Vector2(p.x, p.y);
      const p2 = new THREE.Vector2(p.x + p.hx * 6 - p.hy * DRIVEWAY_M, p.y + p.hy * 6 + p.hx * DRIVEWAY_M);
      const c = new THREE.Vector2(p.x + p.hx * 6, p.y + p.hy * 6);
      const dist = p0.distanceTo(c) + c.distanceTo(p2);
      const turn = this.sideOf(p.x, p.y, p.hx, p.hy, p2.x, p2.y);
      this.parking.push({ trip: veh.trip, kind: veh.trip.kind ?? 'sedan', p0, c, p2, start: now, dur: dist / PARK_SPEED, turn });
    }
    this.lastVehicles = new Set(traffic.vehicles);
    this.parking = this.parking.filter((pk) => now - pk.start < pk.dur && now >= pk.start);
    for (const pk of this.parking) {
      const s = ease((now - pk.start) / pk.dur);
      bezier(pk.p0, pk.c, pk.p2, s, this.bp, this.bd);
      this.placeCar(pk.kind, pk.trip, this.bp.x, this.bp.y, this.bd.x, this.bd.y, 0.26 - 0.18 * s, 1 - 0.4 * s, true, s < 0.6 ? pk.turn : null);
    }
    for (const f of this.fleet.values()) {
      f.body.count = f.n;
      f.lights.count = f.n;
      f.brake.count = f.n;
      f.left.count = f.n;
      f.right.count = f.n;
      f.body.instanceMatrix.needsUpdate = true;
      if (f.body.instanceColor) f.body.instanceColor.needsUpdate = true;
      for (const m of [f.brake, f.left, f.right]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // Signal heads on every approach to a signalised junction, stop signs at all-way stops.
  // Poles, housings and signs are static; the lamps are one instanced mesh recoloured on change.
  private buildSignals(): void {
    const net = this.sim.grid.net;
    const traffic = this.sim.traffic;
    const pole = new THREE.Color(0x30343a);
    const housing = new THREE.Color(0x15181c);
    const stopRed = new THREE.Color(0xb3191c);
    const white = new THREE.Color(0xf2f2f2);
    const lampPos: THREE.Vector3[] = [];
    for (let node = 0; node < net.nodes.length; node++) {
      const signalised = traffic.signals?.isSignalised(node) ?? false;
      if (!signalised && !traffic.isStopSign(node)) continue;
      const c = net.nodes[node];
      for (const id of net.inLinks[node]) {
        // At a T-junction only the street that ends there has a stop sign.
        const stop = !signalised && traffic.mustStop(id);
        if (!signalised && !stop) continue;
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
        // Stop line across the approach lane.
        const lx = this.wx(c.x - dx * JUNCTION_RADIUS - dy * (half / 2));
        const lz = this.wz(c.y - dy * JUNCTION_RADIUS + dx * (half / 2));
        const line = new THREE.PlaneGeometry(0.06, half * WORLD_PER_M * 0.95).rotateX(-Math.PI / 2);
        this.solid.add(line, white, lx, 0.27, lz, 0, -Math.atan2(dy, dx));
        if (stop) {
          this.solid.add(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5), pole, x, 0.25, z);
          // Octagon facing the oncoming cars.
          const sign = new THREE.CylinderGeometry(0.11, 0.11, 0.015, 8).rotateX(Math.PI / 2).rotateZ(Math.PI / 8);
          this.solid.add(sign, stopRed, x - dx * 0.02, 0.52, z - dy * 0.02, 0, Math.atan2(dx, dy));
          continue;
        }
        this.solid.add(new THREE.CylinderGeometry(0.035, 0.045, 1.3, 6), pole, x, 0.65, z);
        this.solid.add(new THREE.BoxGeometry(0.13, 0.46, 0.13), housing, x, 1.42, z);
        // Lamps face the oncoming cars: red, yellow, green from the top.
        const fx = x - dx * 0.07;
        const fz = z - dy * 0.07;
        lampPos.push(new THREE.Vector3(fx, 1.57, fz), new THREE.Vector3(fx, 1.42, fz), new THREE.Vector3(fx, 1.27, fz));
        this.signals.push({ lane: id, light: null });
      }
    }
    this.signalLamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.058, 8, 6), new THREE.MeshBasicMaterial(), Math.max(1, lampPos.length));
    this.signalLamps.count = lampPos.length;
    const m = new THREE.Matrix4();
    lampPos.forEach((p, i) => {
      this.signalLamps.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      this.signalLamps.setColorAt(i, SIGNAL.redOff);
    });
    this.scene.add(this.signalLamps);
  }

  private syncSignals(): void {
    const plans = this.sim.traffic.signals;
    if (!plans) return;
    let changed = false;
    this.signals.forEach((sg, i) => {
      const light = plans.light(sg.lane, this.sim.time);
      if (light === sg.light) return;
      sg.light = light;
      changed = true;
      this.signalLamps.setColorAt(3 * i, light === 'red' ? SIGNAL.red : SIGNAL.redOff);
      this.signalLamps.setColorAt(3 * i + 1, light === 'yellow' ? SIGNAL.yellow : SIGNAL.yellowOff);
      this.signalLamps.setColorAt(3 * i + 2, light === 'green' ? SIGNAL.green : SIGNAL.greenOff);
    });
    if (changed) this.signalLamps.instanceColor!.needsUpdate = true;
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
      const color = st.links.some((id) => traffic.isClosed(id))
        ? ROAD_COLORS.closed
        : ratio < 0.3 ? ROAD_COLORS.jammed : ratio < 0.6 ? ROAD_COLORS.slow : st.arterial ? ROAD_COLORS.arterial : ROAD_COLORS.local;
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

  // Ground point under a screen point in sim metres, or null if off the map.
  private groundAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, hit)) return null;
    const x = hit.x / WORLD_PER_M + this.sim.grid.width / 2;
    const y = hit.z / WORLD_PER_M + this.sim.grid.height / 2;
    const margin = this.sim.grid.opts.spacing / 2;
    if (x < -margin || y < -margin || x > this.sim.grid.width + margin || y > this.sim.grid.height + margin) return null;
    return { x, y };
  }

  // Nearest intersection under a screen point, or null if off the map.
  pickNode(clientX: number, clientY: number): number | null {
    const p = this.groundAt(clientX, clientY);
    return p ? nearestJunction(this.sim.grid.net, p.x, p.y) : null;
  }

  // Street under a screen point (one of its links), or null if none is within reach.
  pickLink(clientX: number, clientY: number): number | null {
    const p = this.groundAt(clientX, clientY);
    if (!p) return null;
    const { nodes, links } = this.sim.grid.net;
    let best: number | null = null;
    let bestD = 25; // m
    for (const link of links) {
      const a = nodes[link.from];
      const b = nodes[link.to];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
      const d = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
      if (d < bestD) [best, bestD] = [link.id, d];
    }
    return best;
  }

  // Markers for the placed incidents; rebuilt when the set changes.
  private syncIncidents(now: number): void {
    const incidents = this.sim.incidents;
    const key = incidents.map((i) => i.id).join(',');
    if (key !== this.incidentKey) {
      this.incidentKey = key;
      for (const child of [...this.incidentGroup.children]) {
        this.incidentGroup.remove(child);
        child.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
      }
      this.beacons = [];
      for (const inc of incidents) this.incidentGroup.add(this.incidentMarker(inc));
    }
    // Beacons flash in real time, so they still read when paused.
    const on = now % 800 < 400;
    for (const m of this.beacons) m.color.setHex(on ? 0xfff1c2 : 0x6a4a10);
  }

  private incidentMarker(inc: Incident): THREE.Group {
    const net = this.sim.grid.net;
    const link = net.links[inc.links[0]];
    const a = net.nodes[link.from];
    const b = net.nodes[link.to];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const g = new THREE.Group();
    g.position.set(this.wx((a.x + b.x) / 2), 0.26, this.wz((a.y + b.y) / 2)); // on the road surface, like the cars
    g.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
    // Scene details in metres: x along the street, z across it, origin at its middle.
    const local = new THREE.Group();
    local.scale.setScalar(WORLD_PER_M);
    g.add(local);
    const mat = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const box = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, rot = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
      m.position.set(x, y + h / 2, z);
      m.rotation.y = rot;
      local.add(m);
    };
    // Cones, beacons and wrecks are drawn 1.5x, like the slightly oversized cars, so they read.
    const cone = (x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.65, 10), mat(0xff7a1a));
      m.position.set(x, 0.85, z);
      local.add(m);
    };
    const beacon = (x: number, y: number, z: number) => {
      const m = new THREE.MeshBasicMaterial({ color: 0xfff1c2 });
      this.beacons.push(m);
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), m);
      s.position.set(x, y, z);
      local.add(s);
    };
    if (inc.kind === 'accident') {
      // Two cars at an angle across the lane, with cones behind them.
      box(6.7, 2.1, 2.9, 0xe8e8e8, -2, 0.2, 1.4, 0.5);
      box(6.6, 2.1, 2.9, 0x8a1c1c, 4, 0.2, 2.6, -0.35);
      beacon(-2, 3.4, 1.4);
      for (const x of [-9, -12, -15]) cone(x, 1.6 - (x + 9) * 0.1);
    } else if (inc.kind === 'lane') {
      // A line of cones closing one lane each way, and a flashing arrow board.
      for (let k = 0; k < 7; k++) {
        const x = -len * 0.25 + (k * len * 0.5) / 6;
        cone(x, 3.2);
        cone(-x, -3.2);
      }
      box(0.3, 1.6, 2.2, 0x222222, -len * 0.25 - 4, 0.2, 3.2);
      beacon(-len * 0.25 - 4, 2.4, 3.2);
    } else {
      // Red and white barriers across the street at both ends.
      for (const x of [-len / 2 + 14, len / 2 - 14]) {
        box(0.5, 0.45, 9, 0xd8d8d8, x, 0.7, 0);
        box(0.5, 0.45, 9, 0xc82828, x, 1.15, 0);
        for (const z of [-4.2, 4.2]) box(0.3, 1.6, 0.3, 0x444444, x, 0, z);
      }
    }
    // A pin above, drawn over buildings so it reads from city zoom.
    const pin = new THREE.Mesh(
      mergeGeometries([new THREE.CylinderGeometry(0.1, 0.1, 5, 8).translate(0, 2.5, 0).toNonIndexed(), new THREE.OctahedronGeometry(1.1).translate(0, 6, 0)])!,
      new THREE.MeshBasicMaterial({ color: INCIDENT_HEX[inc.kind], depthTest: false }),
    );
    pin.renderOrder = 10;
    g.add(pin);
    return g;
  }

  // Swing the camera over an incident's street, keeping the current viewing angle.
  focusIncident(inc: Incident): void {
    this.follow(null);
    const net = this.sim.grid.net;
    const link = net.links[inc.links[0]];
    const a = net.nodes[link.from];
    const b = net.nodes[link.to];
    const target = new THREE.Vector3(this.wx((a.x + b.x) / 2), 0, this.wz((a.y + b.y) / 2));
    // Steep and high enough to see the street between downtown towers.
    const theta = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
    this.controls.target.copy(target);
    this.camera.position.setFromSpherical(new THREE.Spherical(55, 0.42, theta)).add(target);
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

  // Start/destination labels on the pins, and a live distance/ETA label under the probe car.
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
    // Under the car on screen: anchored below the lowest corner of its footprint.
    const p = traffic.pose(veh);
    const half = veh.len / 2;
    const side = CAR_WIDTH / 2;
    let lowest = -Infinity;
    let onScreen = true;
    for (const [a, b] of [[half, side], [half, -side], [-half, side], [-half, -side]]) {
      const v = this.tagV.set(this.wx(p.x + p.hx * a - p.hy * b), 0.26, this.wz(p.y + p.hy * a + p.hx * b)).project(this.camera);
      if (v.z >= 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) onScreen = false;
      lowest = Math.max(lowest, ((1 - v.y) / 2) * this.container.clientHeight);
    }
    const c = this.tagV.set(this.wx(p.x), 0.26, this.wz(p.y)).project(this.camera);
    const el = this.tags.car;
    el.hidden = !onScreen;
    if (!onScreen) return;
    const sx = this.container.offsetLeft + ((c.x + 1) / 2) * this.container.clientWidth;
    const sy = this.container.offsetTop + lowest + 14;
    el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, 0)`;
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
    // Orbit about the car only: no panning away from it, no drift after a drag.
    this.controls.enablePan = tripId === null;
    this.controls.enableDamping = tripId === null;
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
    const behind = Math.atan2(-p.hx, -p.hy); // azimuth of the point behind the car (world x, z)
    const c = this.chase;
    const now = performance.now();
    const dt = Math.min(0.1, (now - (c.frame || now)) / 1000);
    c.frame = now;
    if (!this.followSeen) {
      c.heading = behind;
      c.look = 0;
      c.pitch = 1.05;
      c.dist = 16;
      this.followSeen = true;
    }
    if (c.dragging) {
      // The user is orbiting: carry the camera along with the car and leave the angle to them.
      this.camera.position.add(target.clone().sub(this.controls.target));
      this.controls.target.copy(target);
      return;
    }
    // Turn with the car smoothly, so junction turns sweep rather than snap.
    c.heading = wrapAngle(c.heading + wrapAngle(behind - c.heading) * Math.min(1, 4 * dt));
    if (now - c.released > 1500) c.look *= 1 - Math.min(1, 2 * dt);
    this.controls.target.copy(target);
    this.camera.position.setFromSpherical(new THREE.Spherical(c.dist, c.pitch, c.heading + c.look)).add(target);
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
    this.syncIncidents(now);
    this.syncTags();
    if (now - this.lastCongestion > CONGESTION_REFRESH_MS) {
      this.lastCongestion = now;
      this.syncCongestion();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
