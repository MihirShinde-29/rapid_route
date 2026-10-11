import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Collects static geometry so a whole class of objects (all buildings, all plates...)
// is one draw call. Each part keeps its own colour as a vertex attribute.
export class StaticBatch {
  private parts: THREE.BufferGeometry[] = [];
  private vertices = 0;

  // Returns the index of the first vertex this part occupies in the merged geometry.
  add(geo: THREE.BufferGeometry, color: THREE.Color, x: number, y: number, z: number, rotX = 0, rotY = 0): number {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, 0)).setPosition(x, y, z));
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const start = this.vertices;
    this.vertices += n;
    this.parts.push(geo);
    return start;
  }

  geometry(): THREE.BufferGeometry {
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
