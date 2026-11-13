import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Building models from Kenney's City Kits (Suburban, Commercial, Industrial; CC0, www.kenney.nl;
// see docs/CREDITS.md). The view draws each house, apartment block, tower and warehouse as a
// slot (footprint, height, facing); once the kits load, every slot gets the model that fits it
// best, drawn instanced per model. Each kit has its own texture, so its own material.

export type BuildingKind = 'house' | 'apartment' | 'tower' | 'warehouse' | 'shop' | 'hospital' | 'fire_station' | 'police_station';
const STATIONS: BuildingKind[] = ['hospital', 'fire_station', 'police_station'];

// One building to draw, in world units: centred on (x, z), standing on y, `w` along x and `d`
// along z before turning, `h` high, its front turned to face `face` (radians; 0 faces +z).
export interface BuildingSlot {
  kind: BuildingKind;
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  face: number;
  seed: number;
}

interface Model {
  name: string;
  kit: Kit;
  geometry: THREE.BufferGeometry; // footprint centred on the origin, base at y = 0, front -z
  size: THREE.Vector3;
}

type Kit = 'suburban' | 'commercial' | 'industrial';

const letters = (s: string) => s.split('');
const MODELS: Record<BuildingKind, { kit: Kit; names: string[] }> = {
  house: { kit: 'suburban', names: letters('abcdefghijklmnopqrstu').map((c) => `building-type-${c}`) },
  apartment: { kit: 'commercial', names: letters('abcdefghijk').map((c) => `building-${c}`) },
  tower: { kit: 'commercial', names: ['building-l', 'building-m', 'building-n', ...letters('abcde').map((c) => `building-skyscraper-${c}`)] },
  warehouse: { kit: 'industrial', names: letters('abcdefghijklmnopqrst').map((c) => `building-${c}`) },
  shop: { kit: 'commercial', names: letters('abcdefgh').map((c) => `building-${c}`) },
  hospital: { kit: 'commercial', names: ['building-n', 'building-j', 'building-k'] },
  fire_station: { kit: 'industrial', names: ['building-a', 'building-b', 'building-r'] },
  police_station: { kit: 'commercial', names: ['building-i', 'building-j', 'building-l'] },
};
// How far a model may be stretched along the ground to fill a long lot.
const MAX_WIDEN = 1.35;
// How far a model may be stretched upright beyond its own proportions to reach a slot's height.
const MAX_STRETCH = 1.6;

export interface CityKit {
  models: Map<BuildingKind, Model[]>;
  materials: Map<Kit, THREE.MeshStandardMaterial>;
}

export async function loadCityKit(base: string): Promise<CityKit> {
  const loader = new GLTFLoader();
  const models = new Map<BuildingKind, Model[]>();
  const materials = new Map<Kit, THREE.MeshStandardMaterial>();
  const files = new Map<string, Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>> | null>>();
  const geometries = new Map<string, Model>(); // one Model per file, shared between kinds
  for (const [kind, { kit, names }] of Object.entries(MODELS) as [BuildingKind, (typeof MODELS)[BuildingKind]][]) {
    // All at once: the browser fetches them in parallel (each file once, shared between kinds).
    const loaded = await Promise.all(names.map((name) => {
      const key = `${kit}/${name}`;
      if (!files.has(key)) {
        files.set(key, loader.loadAsync(`${base}kenney-city-${kit}/${name}.glb`).catch((e) => {
          console.warn(`Building ${key} failed to load.`, e);
          return null;
        }));
      }
      return files.get(key)!;
    }));
    const list: Model[] = [];
    for (const [k, name] of names.entries()) {
      const gltf = loaded[k];
      if (!gltf) continue;
      const known = geometries.get(`${kit}/${name}`);
      if (known) {
        list.push(known);
        continue;
      }
      {
        gltf.scene.updateMatrixWorld(true);
        const parts: THREE.BufferGeometry[] = [];
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          if (!materials.has(kit)) {
            const src = m.material as THREE.MeshStandardMaterial;
            materials.set(kit, new THREE.MeshStandardMaterial({ map: src.map, roughness: 0.8, metalness: 0 }));
          }
          const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
          for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal' && a !== 'uv') g.deleteAttribute(a);
          parts.push(g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]));
        });
        const geometry = mergeGeometries(parts)!;
        geometry.computeBoundingBox();
        const bb = geometry.boundingBox!;
        geometry.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
        const model = { name, kit, geometry, size: bb.getSize(new THREE.Vector3()) };
        geometries.set(`${kit}/${name}`, model);
        list.push(model);
      }
    }
    models.set(kind, list);
  }
  return { models, materials };
}

// The model for a slot and its scale (x, y, z): the footprint fits inside the slot keeping the
// model's shape; the height follows the slot within MAX_STRETCH. Among the models closest in
// shape (height over footprint), the slot's seed picks one, so neighbours differ.
export function fitSlot(kit: CityKit, slot: BuildingSlot): { model: Model; scale: THREE.Vector3 } | null {
  const list = kit.models.get(slot.kind);
  if (!list || list.length === 0) return null;
  const foot = (m: Model) => Math.min(slot.w / m.size.x, slot.d / m.size.z);
  // Closest in height for its footprint, and in footprint proportions (long lots, long models).
  const shape = (m: Model) =>
    Math.abs(Math.log((slot.h / (m.size.y * foot(m))) || 1)) + 0.7 * Math.abs(Math.log(slot.w / slot.d / (m.size.x / m.size.z)));
  const ranked = [...list].sort((a, b) => shape(a) - shape(b));
  const pool = ranked.slice(0, Math.min(ranked.length, slot.kind === 'house' || slot.kind === 'warehouse' ? 8 : STATIONS.includes(slot.kind) ? 1 : 3));
  const model = pool[Math.floor(slot.seed * pool.length) % pool.length];
  const s = foot(model);
  const sy = THREE.MathUtils.clamp(slot.h / model.size.y, s / MAX_STRETCH, s * MAX_STRETCH);
  // Fill a long lot: stretch along the longer side, a little.
  const sx = slot.kind === 'house' ? s : Math.min(slot.w / model.size.x, s * MAX_WIDEN);
  const sz = slot.kind === 'house' ? s : Math.min(slot.d / model.size.z, s * MAX_WIDEN);
  return { model, scale: new THREE.Vector3(sx, slot.kind === 'house' ? s : sy, sz) };
}

// Beyond this distance from the camera (world units) a building is drawn as its stand-in box.
// Measured: full models on every building still fit the frame budget (about 7 ms a frame drawn at
// the morning peak), so this covers the whole city from the usual views; stand-ins only past it.
const LOD_FAR = 500;

// A box the size of the model, each face one flat colour taken from the model's own faces that
// point the same way (roof colour on top, wall colour on the sides). 12 triangles instead of
// about 1500, for buildings far from the camera.
function standIn(model: Model): THREE.BufferGeometry {
  const g = model.geometry;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const index = g.index!;
  const dirs = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
  const best = dirs.map(() => ({ area: 0, u: 0, v: 0 }));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < index.count; t += 3) {
    const [i0, i1, i2] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    n.crossVectors(b.sub(a), c.sub(a));
    const area = n.length() / 2;
    if (area <= 0) continue;
    n.normalize();
    dirs.forEach((d, k) => {
      if (n.dot(d) > 0.6 && area > best[k].area) best[k] = { area, u: (uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3, v: (uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3 };
    });
  }
  const box = new THREE.BoxGeometry(model.size.x * 0.96, model.size.y * 0.92, model.size.z * 0.96).translate(0, (model.size.y * 0.92) / 2, 0);
  const buv = box.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry faces, 4 vertices each: +x, -x, +y, -y, +z, -z.
  for (let f = 0; f < 6; f++) {
    const src = best[f].area > 0 ? best[f] : best[0];
    for (let k = 0; k < 4; k++) buv.setXY(f * 4 + k, src.u, src.v);
  }
  return box;
}

export interface KitBuildings {
  group: THREE.Group;
  // Full models near the camera, stand-ins further away.
  update(camera: THREE.Vector3): void;
}

// One batched mesh per kit (one draw call each, culled per building), every slot an instance.
export function buildKitBuildings(kit: CityKit, slots: BuildingSlot[]): KitBuildings {
  const placed: { model: Model; matrix: THREE.Matrix4; at: THREE.Vector3 }[] = [];
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const slot of slots) {
    const fit = fitSlot(kit, slot);
    if (!fit) continue;
    // The kits' fronts face -z, so turn a half turn more.
    const at = new THREE.Vector3(slot.x, slot.y, slot.z);
    placed.push({ model: fit.model, matrix: new THREE.Matrix4().compose(at, q.setFromAxisAngle(up, slot.face + Math.PI), fit.scale), at });
  }
  const group = new THREE.Group();
  // Stations: a plate on the roof so they read from the air (hospital white with a red cross,
  // fire station red, police station blue).
  const PLATE: Partial<Record<BuildingKind, number>> = { hospital: 0xf2f2f2, fire_station: 0xc0392b, police_station: 0x2f5fa8 };
  for (const slot of slots) {
    const color = PLATE[slot.kind];
    const fit = color === undefined ? null : fitSlot(kit, slot);
    if (!fit || color === undefined) continue;
    const top = slot.y + fit.model.size.y * fit.scale.y + 0.03;
    const side = Math.min(fit.model.size.x * fit.scale.x, fit.model.size.z * fit.scale.z) * 0.45;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(side, 0.04, side), new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
    plate.position.set(slot.x, top, slot.z);
    group.add(plate);
    if (slot.kind === 'hospital') {
      const red = new THREE.MeshStandardMaterial({ color: 0xd8262a, roughness: 0.6 });
      for (const [w, d] of [[0.7, 0.22], [0.22, 0.7]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(side * w, 0.05, side * d), red);
        bar.position.set(slot.x, top + 0.03, slot.z);
        group.add(bar);
      }
    }
  }
  const lods: { mesh: THREE.BatchedMesh; id: number; at: THREE.Vector3; near: number; far: number; isNear: boolean }[] = [];
  for (const kitName of new Set(placed.map((p) => p.model.kit))) {
    const mine = placed.filter((p) => p.model.kit === kitName);
    const models = [...new Set(mine.map((p) => p.model))];
    const stand = new Map(models.map((m) => [m, standIn(m)]));
    let verts = 0;
    let idx = 0;
    for (const m of models) {
      verts += m.geometry.attributes.position.count + stand.get(m)!.attributes.position.count;
      idx += m.geometry.index!.count + stand.get(m)!.index!.count;
    }
    const mesh = new THREE.BatchedMesh(mine.length, verts, idx, kit.materials.get(kitName)!);
    const ids = new Map(models.map((m) => [m, { near: mesh.addGeometry(m.geometry), far: mesh.addGeometry(stand.get(m)!) }]));
    for (const p of mine) {
      const g = ids.get(p.model)!;
      const id = mesh.addInstance(g.far);
      mesh.setMatrixAt(id, p.matrix);
      lods.push({ mesh, id, at: p.at, near: g.near, far: g.far, isNear: false });
    }
    // Houses are most of the triangles and cast little shade, so they stay out of the shadow pass.
    mesh.castShadow = kitName !== 'suburban';
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return {
    group,
    update(camera: THREE.Vector3) {
      const far2 = LOD_FAR * LOD_FAR;
      for (const l of lods) {
        const near = l.at.distanceToSquared(camera) < far2;
        if (near !== l.isNear) {
          l.mesh.setGeometryIdAt(l.id, near ? l.near : l.far);
          l.isNear = near;
        }
      }
    },
  };
}
