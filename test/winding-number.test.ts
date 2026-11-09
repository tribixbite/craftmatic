/** V-01: the winding-number field and the soup re-orientation behind the voxeliser's `insideTest: 'winding'`. */
import { describe, it, expect } from 'vitest';
import { WindingField, orientedComponents } from '../src/convert/winding-number.js';

/** Closed unit-ish box as 12 outward CCW triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const c = (x: number, y: number, z: number): number[] => [x, y, z];
  const v = [c(x0, y0, z0), c(x1, y0, z0), c(x1, y1, z0), c(x0, y1, z0), c(x0, y0, z1), c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1)];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]; // z-, z+, y-, y+, x-, x+
  return quads.flatMap(([a, b, cc, d]) => [...v[a!]!, ...v[b!]!, ...v[cc!]!, ...v[a!]!, ...v[cc!]!, ...v[d!]!]);
}

describe('WindingField', () => {
  const field = new WindingField(box(0, 0, 0, 2, 2, 2));
  it('is 1 inside and 0 outside a closed outward box', () => {
    expect(field.winding(1, 1, 1)).toBeCloseTo(1, 6);
    expect(field.winding(5, 1, 1)).toBeCloseTo(0, 6);
    expect(field.winding(-3, -3, 9)).toBeCloseTo(0, 6);
  });
  it('is -1 inside an inside-out box', () => {
    const inv = box(0, 0, 0, 2, 2, 2);
    for (let t = 0; t < inv.length; t += 9) for (let k = 0; k < 3; k++) { const a = inv[t + 3 + k]!; inv[t + 3 + k] = inv[t + 6 + k]!; inv[t + 6 + k] = a; }
    expect(new WindingField(inv).winding(1, 1, 1)).toBeCloseTo(-1, 6);
  });
  it('the far-field approximation tracks the exact sum over many triangles', () => {
    // 20 disjoint boxes: the tree takes dipole shortcuts for distant ones.
    const soup: number[] = [];
    for (let i = 0; i < 20; i++) soup.push(...box(i * 4, 0, 0, i * 4 + 2, 2, 2));
    const f = new WindingField(soup);
    expect(f.winding(41, 1, 1)).toBeCloseTo(1, 1); // inside box 10 (order-0 dipoles: ~2 % error, far inside the 0.5 margin)
    expect(f.winding(43, 1, 1)).toBeCloseTo(0, 1); // gap
    expect(f.winding(100, 50, 50)).toBeCloseTo(0, 1);
  });
  it('an open box reads about one half just inside its opening', () => {
    const open = box(0, 0, 0, 2, 2, 2).slice(0, 9 * 10); // drop the last face (x+): 2 triangles
    expect(Math.abs(new WindingField(open).winding(1.9, 1, 1))).toBeGreaterThan(0.3);
    expect(Math.abs(new WindingField(open).winding(1.9, 1, 1))).toBeLessThan(0.9);
  });
  it('rejects a partial triangle', () => {
    expect(() => new WindingField([0, 0, 0, 1, 0])).toThrow(RangeError);
  });
});

describe('orientedComponents', () => {
  it('flips a mixed-orientation closed box to outward', () => {
    const soup = box(0, 0, 0, 2, 2, 2);
    for (let t = 0; t < 9 * 4; t += 9) for (let k = 0; k < 3; k++) { const a = soup[t + 3 + k]!; soup[t + 3 + k] = soup[t + 6 + k]!; soup[t + 6 + k] = a; }
    const parts = orientedComponents(soup);
    expect(parts).toHaveLength(1);
    expect(new WindingField(parts[0]!).winding(1, 1, 1)).toBeCloseTo(1, 6);
  });
  it('keeps two separate bodies apart and drops degenerate triangles', () => {
    const soup = [...box(0, 0, 0, 1, 1, 1), ...box(5, 0, 0, 6, 1, 1), 0, 0, 0, 0, 0, 0, 1, 1, 1];
    const parts = orientedComponents(soup);
    expect(parts.map((p) => p.length / 9).sort()).toEqual([12, 12]);
  });
});
