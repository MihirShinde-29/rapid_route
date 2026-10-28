import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { fillBlock, overlaps, type Box2 } from '../src/render3d/fill';
import type { BlockStyle } from '../src/city/sites';

const box = (x: number, z: number, w: number, d: number): Box2 => ({ x0: x, x1: x + w, z0: z, z1: z + d });

describe('block fill', () => {
  it('puts structures only in free space: inside the block, off what is there, off each other', () => {
    const rng = mulberry32(3);
    const styles: BlockStyle[] = ['houses', 'apartments', 'towers', 'warehouses', 'shed_yard', 'station'];
    let total = 0;
    for (let trial = 0; trial < 60; trial++) {
      const style = styles[trial % styles.length];
      const block = box(0, 0, 60 + rng() * 60, 60 + rng() * 60);
      const taken: Box2[] = [];
      for (let k = 0; k < 6; k++) taken.push(box(rng() * 80, rng() * 80, 5 + rng() * 20, 5 + rng() * 20));
      const items = fillBlock(block, taken, style, rng, 1);
      total += items.length;
      const boxes = items.map((it) => box(it.x - it.w / 2, it.z - it.d / 2, it.w, it.d));
      boxes.forEach((b, i) => {
        expect(b.x0).toBeGreaterThanOrEqual(block.x0 - 1e-9);
        expect(b.x1).toBeLessThanOrEqual(block.x1 + 1e-9);
        expect(b.z0).toBeGreaterThanOrEqual(block.z0 - 1e-9);
        expect(b.z1).toBeLessThanOrEqual(block.z1 + 1e-9);
        for (const t of taken) expect(overlaps(b, t)).toBe(false);
        for (let j = 0; j < i; j++) expect(overlaps(b, boxes[j])).toBe(false);
      });
    }
    expect(total).toBeGreaterThan(100);
  });
});
