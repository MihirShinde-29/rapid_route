import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { isEmergency, VEHICLE_KINDS, VEHICLE_SPECS, type VehicleKind } from '../traffic/vehicleTypes';

// Vehicle models from Kenney's Car Kit (CC0, www.kenney.nl; see docs/CREDITS.md), fitted to our
// vehicle sizes. The body is one geometry; the four road wheels are separate so the view can spin
// and steer them. Our frame, as in vehicles.ts: +x forward, +y up, +z the car's right, the
// ground at y = 0, the footprint centred on the origin.

// The Car Kit has no bus; buses keep the classic model.
const FILE: Partial<Record<VehicleKind, string>> = {
  hatchback: 'hatchback-sports',
  sedan: 'sedan',
  taxi: 'taxi',
  suv: 'suv',
  pickup: 'truck',
  van: 'van',
  truck: 'delivery',
  ambulance: 'ambulance',
  fire: 'firetruck',
  police: 'police',
};
const WHEEL = /^wheel-(front|back)-(left|right)$/;
// Long vehicles keep the model's proportions only up to this much wider than our car width;
// past that they are stretched along their length instead.
const MAX_WIDEN = 1.2;

export interface WheelSlot {
  x: number;
  y: number; // axle height
  z: number;
  front: boolean;
  right: boolean;
}

export interface KenneyVehicle {
  body: THREE.BufferGeometry;
  wheelL: THREE.BufferGeometry; // a left wheel centred on its axle
  wheelR: THREE.BufferGeometry;
  slots: WheelSlot[];
  radius: number; // wheel radius, world units
  top: number; // height of the roof, world units
}

export interface KenneyKit {
  vehicles: Map<VehicleKind, KenneyVehicle>;
  material: THREE.MeshStandardMaterial;
}

// Loads and fits every model. `base` is the folder holding the .glb files.
export async function loadKenneyKit(base: string, worldPerM: number, width: number): Promise<KenneyKit> {
  const loader = new GLTFLoader();
  let map: THREE.Texture | null = null;
  let pixels: ImageData | null = null;
  const vehicles = new Map<VehicleKind, KenneyVehicle>();
  for (const kind of VEHICLE_KINDS) {
    if (!FILE[kind]) continue;
    const gltf = await loader.loadAsync(`${base}${FILE[kind]}.glb`);
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    if (!map) {
      map = (meshes[0].material as THREE.MeshStandardMaterial).map;
      pixels = map ? imagePixels(map.image as CanvasImageSource & { width: number; height: number }) : null;
    }
    vehicles.set(kind, fit(kind, meshes, pixels, worldPerM, width));
  }
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0.1 });
  repaintable(material);
  return { vehicles, material };
}

// The node a mesh belongs to: the named wheel nodes hold their mesh directly.
const nodeName = (m: THREE.Object3D) => m.name || m.parent?.name || '';

function fit(kind: VehicleKind, meshes: THREE.Mesh[], pixels: ImageData | null, worldPerM: number, width: number): KenneyVehicle {
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  // Kenney: +z forward, +x the left side. Turn a quarter so +z -> +x and +x -> -z.
  const kLen = box.max.z - box.min.z;
  const kWidth = box.max.x - box.min.x;
  const sx = (VEHICLE_SPECS[kind].length * worldPerM) / kLen;
  const sz = Math.min(sx, (MAX_WIDEN * width) / kWidth);
  const sy = Math.sqrt(sx * sz);
  const midZ = (box.max.z + box.min.z) / 2;
  const toOurs = new THREE.Matrix4()
    .makeScale(sx, sy, sz)
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
    .multiply(new THREE.Matrix4().makeTranslation(-(box.max.x + box.min.x) / 2, -box.min.y, -midZ));

  const parts: THREE.BufferGeometry[] = [];
  const slots: WheelSlot[] = [];
  let wheelL: THREE.BufferGeometry | null = null;
  let wheelR: THREE.BufferGeometry | null = null;
  let radius = 0;
  for (const m of meshes) {
    const name = nodeName(m);
    const w = WHEEL.exec(name);
    if (!w) {
      parts.push(clean(m.geometry.clone().applyMatrix4(toOurs.clone().multiply(m.matrixWorld))));
      continue;
    }
    // A wheel: its geometry about its own axle, and where that axle sits.
    const centre = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld).applyMatrix4(toOurs);
    const right = w[2] === 'right';
    slots.push({ x: centre.x, y: centre.y, z: centre.z, front: w[1] === 'front', right });
    const local = m.matrixWorld.clone().setPosition(0, 0, 0);
    const shape = new THREE.Matrix4().makeScale(sx, sy, sz).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)).multiply(local);
    const g = clean(m.geometry.clone().applyMatrix4(shape));
    g.setAttribute('paint', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
    g.computeBoundingBox();
    radius = Math.max(radius, (g.boundingBox!.max.y - g.boundingBox!.min.y) / 2);
    if (right && !wheelR) wheelR = g;
    if (!right && !wheelL) wheelL = g;
  }
  const body = mergeGeometries(parts)!;
  body.computeBoundingBox();
  body.setAttribute('paint', paintWeights(body, pixels, isEmergency(kind)));
  return { body, wheelL: wheelL!, wheelR: wheelR!, slots, radius, top: body.boundingBox!.max.y };
}

// Same attributes on every part, so they merge.
function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  return g;
}

function imagePixels(img: CanvasImageSource & { width: number; height: number }): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

// Per vertex: 0 where the model keeps its own colours, else the luminance of the model's body
// paint, so the shader can repaint it in the car's colour with the same shading. The paint is the
// most common strongly coloured texel on the body; texels of about the same hue count as paint.
function paintWeights(g: THREE.BufferGeometry, pixels: ImageData | null, keep: boolean): THREE.BufferAttribute {
  const n = g.attributes.position.count;
  const out = new Float32Array(n);
  if (keep || !pixels) return new THREE.BufferAttribute(out, 1);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const hsl = { h: 0, s: 0, l: 0 };
  const c = new THREE.Color();
  const texel = (i: number) => {
    const px = Math.min(pixels.width - 1, Math.max(0, Math.floor(uv.getX(i) * pixels.width)));
    const py = Math.min(pixels.height - 1, Math.max(0, Math.floor(uv.getY(i) * pixels.height)));
    const k = (py * pixels.width + px) * 4;
    return c.setRGB(pixels.data[k] / 255, pixels.data[k + 1] / 255, pixels.data[k + 2] / 255, THREE.SRGBColorSpace);
  };
  // Most common saturated hue, in 10-degree bins.
  const bins = new Float32Array(36);
  for (let i = 0; i < n; i++) {
    texel(i).getHSL(hsl);
    if (hsl.s > 0.35 && hsl.l > 0.15 && hsl.l < 0.85) bins[Math.floor(hsl.h * 36) % 36]++;
  }
  let best = 0;
  for (let b = 1; b < 36; b++) if (bins[b] > bins[best]) best = b;
  let lumSum = 0;
  let count = 0;
  const near = (h: number) => Math.min(Math.abs(h * 36 - (best + 0.5)), 36 - Math.abs(h * 36 - (best + 0.5))) < 1.6;
  for (let i = 0; i < n; i++) {
    const t = texel(i);
    t.getHSL(hsl);
    if (hsl.s > 0.35 && near(hsl.h)) {
      out[i] = 1;
      lumSum += luminance(t);
      count++;
    }
  }
  const lum = count > 0 ? lumSum / count : 1;
  for (let i = 0; i < n; i++) if (out[i] > 0) out[i] = lum;
  return new THREE.BufferAttribute(out, 1);
}

const luminance = (c: THREE.Color) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; // linear

// The instance colour repaints the body-paint parts (keeping their light and dark shades) and
// leaves the rest of the texture as it is.
function repaintable(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float paint;\nvarying float vPaint;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvPaint = paint;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPaint;')
      .replace(
        '#include <color_fragment>',
        `#if defined( USE_COLOR )
          if (vPaint > 0.0) {
            float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) / vPaint;
            diffuseColor.rgb = vColor.rgb * clamp(l, 0.0, 1.6);
          }
        #endif`,
      );
  };
}
