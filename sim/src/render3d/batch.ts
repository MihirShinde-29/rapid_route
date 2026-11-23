import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Collects static geometry so a whole class of objects (all buildings, all plates...)
// is one draw call. Each part keeps its own colour as a vertex attribute.
export class StaticBatch {
  private parts: THREE.BufferGeometry[] = [];
  private vertices = 0;
  // Added to every part's height: the blocks are drawn on the raised pavement this way.
  lift = 0;

  // Returns the index of the first vertex this part occupies in the merged geometry.
  add(geo: THREE.BufferGeometry, color: THREE.Color, x: number, y: number, z: number, rotX = 0, rotY = 0): number {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, 0)).setPosition(x, y + this.lift, z));
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const start = this.vertices;
    this.vertices += n;
    this.parts.push(geo);
    return start;
  }

  // Vertices added so far: where the next part will start.
  get size(): number {
    return this.vertices;
  }

  geometry(): THREE.BufferGeometry {
    // Nothing added: an empty geometry (still a valid mesh to draw).
    if (this.parts.length === 0) {
      const g = new THREE.BufferGeometry();
      for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]] as const) g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(0), size));
      g.setIndex([]);
      return g;
    }
    const merged = mergeGeometries(this.parts)!;
    for (const g of this.parts) g.dispose();
    this.parts = [];
    this.vertices = 0;
    return merged;
  }

  build(material: THREE.Material, cast: boolean, receive: boolean): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geometry(), material);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    return mesh;
  }
}

// A prop repeated across the city (lamp posts, lanterns, signal poles): one shared geometry
// drawn once per placement as an InstancedMesh, instead of a copy of it per placement merged into
// a StaticBatch. The colour is baked into the shared geometry, so the same vertex-coloured
// materials work. Optional per-instance floats (e.g. a lamp's switch-on point) become instanced
// attributes the shader reads like ordinary ones.
export class PropInstances {
  private matrices: THREE.Matrix4[] = [];
  private floats = new Map<string, number[]>();
  private readonly geo: THREE.BufferGeometry;
  private static tmp = new THREE.Euler();

  constructor(geo: THREE.BufferGeometry, color: THREE.Color) {
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    this.geo = geo;
  }

  add(x: number, y: number, z: number, rotX = 0, rotY = 0, attrs?: Record<string, number>): void {
    const e = PropInstances.tmp.set(rotX, rotY, 0);
    this.matrices.push(new THREE.Matrix4().makeRotationFromEuler(e).setPosition(x, y, z));
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      const list = this.floats.get(k) ?? [];
      list[this.matrices.length - 1] = v;
      this.floats.set(k, list);
    }
  }

  get count(): number {
    return this.matrices.length;
  }

  build(material: THREE.Material, cast: boolean, receive: boolean): THREE.InstancedMesh {
    const n = this.matrices.length;
    const mesh = new THREE.InstancedMesh(this.geo, material, Math.max(1, n));
    mesh.count = n;
    this.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    for (const [k, list] of this.floats) {
      const a = new Float32Array(Math.max(1, n));
      for (let i = 0; i < n; i++) a[i] = list[i] ?? 0;
      this.geo.setAttribute(k, new THREE.InstancedBufferAttribute(a, 1));
    }
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.computeBoundingSphere();
    this.matrices = [];
    return mesh;
  }

  // Where each placement ended up after buildCells: its cell's mesh and its index there, so a
  // caller can recolour one (the signal lamps).
  where: { mesh: THREE.InstancedMesh; at: number }[] = [];

  // As build, but split into square cells `cell` wide, one instanced mesh per cell with its own
  // bounds, so the cells off screen are culled instead of the whole city's props being drawn
  // every frame. The cells share the vertex buffers; only the per-instance data differs.
  buildCells(material: THREE.Material, cast: boolean, receive: boolean, cell: number): THREE.Group {
    const cells = new Map<string, number[]>();
    this.matrices.forEach((m, i) => {
      const k = `${Math.floor(m.elements[12] / cell)},${Math.floor(m.elements[14] / cell)}`;
      const list = cells.get(k);
      if (list) list.push(i);
      else cells.set(k, [i]);
    });
    const group = new THREE.Group();
    this.where = new Array(this.matrices.length);
    for (const ids of cells.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setIndex(this.geo.index);
      for (const [name, attr] of Object.entries(this.geo.attributes)) geo.setAttribute(name, attr);
      for (const [k, list] of this.floats) geo.setAttribute(k, new THREE.InstancedBufferAttribute(Float32Array.from(ids, (i) => list[i] ?? 0), 1));
      const mesh = new THREE.InstancedMesh(geo, material, ids.length);
      ids.forEach((i, j) => {
        mesh.setMatrixAt(j, this.matrices[i]);
        this.where[i] = { mesh, at: j };
      });
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    this.matrices = [];
    return group;
  }
}
