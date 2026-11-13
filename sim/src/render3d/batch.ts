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
