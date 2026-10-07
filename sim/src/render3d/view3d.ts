import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mulberry32, type Rng } from '../core/rng';
import type { Simulation } from '../sim';
import type { Trip } from '../demand/trips';
import type { Zone, ZoneType } from '../demand/zones';
import { VEHICLE_LENGTH } from '../traffic/traffic';

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
const ROAD_COLORS = { local: 0x212c37, arterial: 0x2b3845, slow: 0x7a5a2a, jammed: 0x7a3a2a }; // from the prototype
const CONGESTION_REFRESH_MS = 500;
const ARC_POOL = 600;
const ARC_POINTS = 13;
const ARC_LIFE_MS = 1200;

interface Arc {
  line: THREE.Line;
  positions: Float32Array;
  material: THREE.LineBasicMaterial;
  born: number;
}

// Three.js view of the sim, styled after prototypes/dispatch_3d.html.
// Reads sim state only; never mutates it.
export class View3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.5, 1000);
  private controls: OrbitControls;
  private arcs: Arc[] = [];
  private nextArc = 0;
  private cars!: THREE.InstancedMesh;
  private streets: { links: number[]; arterial: boolean; mat: THREE.MeshStandardMaterial }[] = [];
  private lastCongestion = -Infinity;
  private tmp = new THREE.Object3D();
  private tmpColor = new THREE.Color();
  private routeHighlight: THREE.LineSegments | null = null;
  private highlightedTrip = -1;
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

    this.scene.background = new THREE.Color(0x070a0f);
    this.scene.fog = new THREE.FogExp2(0x070a0f, 0.0055);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 360;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.45;
    const r = 0.6 * Math.max(sim.grid.width, sim.grid.height) * WORLD_PER_M + 10;
    const theta = Math.PI * 0.28;
    const phi = 0.95;
    this.camera.position.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));

    this.buildLights();
    this.buildGround();
    this.buildRoads();
    this.buildZones(mulberry32(sim.config.seed + 1));
    this.buildArcPool();
    this.buildCars();
    this.routeHighlight = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.routeHighlight.position.y = 0.55;
    this.routeHighlight.visible = false;
    this.scene.add(this.routeHighlight);

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

  private buildLights(): void {
    this.scene.add(new THREE.AmbientLight(0x8899aa, 0.55 * Math.PI));
    const sun = new THREE.DirectionalLight(0xfff2d8, 0.9 * Math.PI);
    sun.position.set(60, 90, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -130, right: 130, top: 130, bottom: -130, far: 300 });
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0x3a5570, 0x0a0d12, 0.4 * Math.PI));
  }

  private buildGround(): void {
    const { width, height } = this.sim.grid;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(width * WORLD_PER_M + 44, height * WORLD_PER_M + 44),
      new THREE.MeshStandardMaterial({ color: 0x0e141c, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private buildRoads(): void {
    const { net } = this.sim.grid;
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0x5a6672 });
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
      // Own material per street so it can be tinted by congestion.
      const mat = new THREE.MeshStandardMaterial({
        color: link.arterial ? ROAD_COLORS.arterial : ROAD_COLORS.local,
        roughness: 0.9,
      });
      const back = net.outLinks[link.to].find((id) => net.links[id].to === link.from)!;
      this.streets.push({ links: [link.id, back], arterial: link.arterial, mat });
      const road = new THREE.Mesh(new THREE.BoxGeometry(len, 0.25, link.arterial ? 1.6 : 1.3), mat);
      road.position.set((x0 + x1) / 2, 0.13, (z0 + z1) / 2);
      road.rotation.y = angle;
      road.receiveShadow = true;
      this.scene.add(road);
      if (link.arterial) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(len - 2.6, 0.02, 0.06), stripeMat);
        stripe.position.set((x0 + x1) / 2, 0.27, (z0 + z1) / 2);
        stripe.rotation.y = angle;
        this.scene.add(stripe);
      }
    }
    const nodeMat = new THREE.MeshStandardMaterial({ color: 0x232f3a, roughness: 0.9 });
    const nodeGeo = new THREE.CylinderGeometry(1.3, 1.3, 0.26, 16);
    for (const n of net.nodes) {
      const m = new THREE.Mesh(nodeGeo, nodeMat);
      m.position.set(this.wx(n.x), 0.13, this.wz(n.y));
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  // Building height and count follow zone density, so demand is visible in the skyline.
  private buildZones(rng: Rng): void {
    const size = this.sim.grid.opts.spacing * WORLD_PER_M - BLOCK_INSET * 2;
    for (const z of this.sim.zones) {
      const cx = this.wx(z.cx);
      const cz = this.wz(z.cy);
      const tint = new THREE.Color(ZONE_HEX[z.type]);
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshStandardMaterial({
          color: z.type === 'park' ? 0x152a1c : new THREE.Color(0x0f161e).lerp(tint, 0.22),
          roughness: 1,
        }),
      );
      plate.rotation.x = -Math.PI / 2;
      plate.position.set(cx, 0.03, cz);
      plate.receiveShadow = true;
      this.scene.add(plate);
      if (z.type === 'park') this.addTrees(cx, cz, size, rng);
      else this.addBuildings(z, cx, cz, size, tint, rng);
    }
  }

  private addBuildings(z: Zone, cx: number, cz: number, size: number, tint: THREE.Color, rng: Rng): void {
    const lots = z.type === 'residential' ? 3 : 2;
    const cell = size / lots;
    for (let i = 0; i < lots; i++) {
      for (let j = 0; j < lots; j++) {
        if (z.type === 'residential' && rng() > 0.35 + 0.65 * z.density) continue; // sparser at low density
        let h: number;
        let footprint: number;
        if (z.type === 'commercial') {
          h = (6 + 20 * z.density) * (0.6 + 0.6 * rng());
          footprint = cell * (0.62 + 0.18 * rng());
        } else if (z.type === 'industrial') {
          h = 2.2 + 2.2 * rng();
          footprint = cell * (0.8 + 0.12 * rng());
        } else {
          h = (1.6 + 7 * z.density) * (0.6 + 0.6 * rng());
          footprint = cell * (0.55 + 0.25 * rng());
        }
        const grey = 0.35 + (0.45 + 0.4 * rng()) * 0.25;
        const color = new THREE.Color(grey * 0.9, grey * 0.95, grey * 1.05).lerp(tint, 0.18);
        const lit = rng() > 0.45;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(footprint, h, footprint),
          new THREE.MeshStandardMaterial({
            color,
            roughness: 0.75,
            emissive: lit ? new THREE.Color(0.12, 0.09, 0.03) : new THREE.Color(0, 0, 0),
            emissiveIntensity: lit ? 0.6 : 0,
          }),
        );
        mesh.position.set(cx - size / 2 + cell * (i + 0.5), h / 2, cz - size / 2 + cell * (j + 0.5));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        if (z.type === 'industrial' && rng() > 0.6) {
          const stack = new THREE.Mesh(
            new THREE.CylinderGeometry(0.3, 0.38, h + 4, 8),
            new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.7 }),
          );
          stack.position.set(mesh.position.x + footprint * 0.3, (h + 4) / 2, mesh.position.z + footprint * 0.3);
          stack.castShadow = true;
          this.scene.add(stack);
        }
      }
    }
  }

  private addTrees(cx: number, cz: number, size: number, rng: Rng): void {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e5c3a, roughness: 1 });
    const count = 6 + Math.floor(rng() * 5);
    for (let i = 0; i < count; i++) {
      const x = cx + (rng() - 0.5) * size * 0.85;
      const z = cz + (rng() - 0.5) * size * 0.85;
      const h = 2 + rng() * 1.6;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, h * 0.4, 6), trunkMat);
      trunk.position.set(x, h * 0.2, z);
      trunk.castShadow = true;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, h, 7), leafMat);
      cone.position.set(x, h * 0.9, z);
      cone.castShadow = true;
      this.scene.add(trunk, cone);
    }
  }

  private buildCars(): void {
    // Length is true to the sim so queued cars never look overlapped. Unlit so they pop at night.
    const geo = new THREE.BoxGeometry(VEHICLE_LENGTH * WORLD_PER_M, 0.3, CAR_WIDTH * WORLD_PER_M);
    const mat = new THREE.MeshBasicMaterial();
    this.cars = new THREE.InstancedMesh(geo, mat, MAX_CARS);
    this.cars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cars.count = 0;
    this.cars.frustumCulled = false;
    this.scene.add(this.cars);
  }

  // Cars take their origin zone's colour, lightened so they read against the roads.
  private syncCars(): void {
    const traffic = this.sim.traffic;
    let i = 0;
    for (const veh of traffic.vehicles) {
      if (i >= MAX_CARS) break;
      const p = traffic.pose(veh);
      this.tmp.position.set(this.wx(p.x), 0.4, this.wz(p.y));
      this.tmp.rotation.set(0, -Math.atan2(p.hy, p.hx), 0);
      this.tmp.updateMatrix();
      this.cars.setMatrixAt(i, this.tmp.matrix);
      this.tmpColor.setHex(ZONE_HEX[this.sim.zones[veh.trip.originZone].type]).lerp(new THREE.Color(0xffffff), 0.45);
      this.cars.setColorAt(i, this.tmpColor);
      i++;
    }
    this.cars.count = i;
    this.cars.instanceMatrix.needsUpdate = true;
    if (this.cars.instanceColor) this.cars.instanceColor.needsUpdate = true;
  }

  // Street tint follows the slower direction's mean speed relative to the limit.
  private syncCongestion(): void {
    const traffic = this.sim.traffic;
    const net = this.sim.grid.net;
    for (const st of this.streets) {
      let ratio = 1;
      for (const id of st.links) {
        if (traffic.lanes[id].vehicles.length > 0) ratio = Math.min(ratio, traffic.linkMeanSpeed(id) / net.links[id].speedLimit);
      }
      const color = ratio < 0.3 ? ROAD_COLORS.jammed : ratio < 0.6 ? ROAD_COLORS.slow : st.arterial ? ROAD_COLORS.arterial : ROAD_COLORS.local;
      st.mat.color.setHex(color);
    }
  }

  // Highlight the most recently assigned route so the cost proof is visible
  // in the same view as the traffic and congestion tinting.
  private syncRouteHighlight(): void {
    const decision = this.sim.proofRoute ?? this.sim.routeLog[0];
    if (!this.routeHighlight || !decision) return;
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

  // Fixed pool of OD arcs, reused round-robin so busy peaks allocate nothing.
  private buildArcPool(): void {
    for (let k = 0; k < ARC_POOL; k++) {
      const positions = new Float32Array(ARC_POINTS * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
      const line = new THREE.Line(geo, material);
      line.visible = false;
      line.frustumCulled = false;
      this.scene.add(line);
      this.arcs.push({ line, positions, material, born: -Infinity });
    }
  }

  addTrips(trips: Trip[], now: number): void {
    if (!this.showDesireLines) return;
    for (const t of trips) {
      const o = this.sim.zones[t.originZone];
      const d = this.sim.zones[t.destZone];
      const arc = this.arcs[this.nextArc];
      this.nextArc = (this.nextArc + 1) % ARC_POOL;
      const x0 = this.wx(o.cx);
      const z0 = this.wz(o.cy);
      const x1 = this.wx(d.cx);
      const z1 = this.wz(d.cy);
      const lift = 3 + 0.25 * Math.hypot(x1 - x0, z1 - z0);
      for (let p = 0; p < ARC_POINTS; p++) {
        const s = p / (ARC_POINTS - 1);
        arc.positions[p * 3] = x0 + (x1 - x0) * s;
        arc.positions[p * 3 + 1] = 0.5 + lift * 4 * s * (1 - s);
        arc.positions[p * 3 + 2] = z0 + (z1 - z0) * s;
      }
      arc.line.geometry.attributes.position.needsUpdate = true;
      arc.material.color.setHex(ZONE_HEX[o.type]);
      arc.born = now;
      arc.line.visible = true;
    }
  }

  render(now: number): void {
    for (const arc of this.arcs) {
      if (!arc.line.visible) continue;
      const age = now - arc.born;
      if (age >= ARC_LIFE_MS || !this.showDesireLines) {
        arc.line.visible = false;
        continue;
      }
      arc.material.opacity = 0.7 * (1 - age / ARC_LIFE_MS);
    }
    this.syncCars();
    this.syncRouteHighlight();
    if (now - this.lastCongestion > CONGESTION_REFRESH_MS) {
      this.lastCongestion = now;
      this.syncCongestion();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
