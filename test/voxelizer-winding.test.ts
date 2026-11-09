/**
 * V-01: the opt-in winding-number inside test of the shared voxeliser
 * (`insideTest: 'winding'`). The default ('parity') must stay the even-odd ray fill.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { threeToGrid, threeToGridAsync } from '../src/convert/voxelizer.js';

/** A box [x0,x1]x[y0,y1]x[z0,z1] as an INDEXED geometry, optionally without one face (0 +x,1 -x,2 +y,3 -y,4 +z,5 -z). */
function boxGeometry(min: [number, number, number], max: [number, number, number], omitFace = -1): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  if (omitFace >= 0) {
    const idx = Array.from(g.index!.array);
    idx.splice(omitFace * 6, 6);
    g.setIndex(idx);
    g.clearGroups();
  }
  return g;
}

/** Merge geometries into ONE mesh (indices offset), wrapped in a group with an updated world matrix. */
function oneMesh(...geos: THREE.BufferGeometry[]): THREE.Group {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const g of geos) {
    const base = pos.length / 3;
    pos.push(...Array.from(g.getAttribute('position').array));
    for (const i of Array.from(g.index!.array)) idx.push(i + base);
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setIndex(idx);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0xcc3322, side: THREE.DoubleSide })));
  group.updateMatrixWorld(true);
  return group;
}

const filled = (g: { getIndex(x: number, y: number, z: number): number }, x: number, y: number, z: number): boolean =>
  g.getIndex(x, y, z) !== 0;

describe('voxelizer insideTest: winding', () => {
  // Probe cells sit off every face diagonal: a ray through a shared triangle edge counts the crossing twice.
  // A 6 cube with its +y lid removed, plus a closed 1x12x1 pole so the grid extends 6 cells above the opening.
  const openTopBox = (): THREE.Group => oneMesh(
    boxGeometry([0, 0, 0], [6, 6, 6], 2),
    boxGeometry([7, 0, 0], [8, 12, 1]),
  );

  it('parity fills the column above an open shell (the defect)', () => {
    const grid = threeToGrid(openTopBox(), 1);
    expect(filled(grid, 1, 9, 4)).toBe(true);
  });

  it('winding leaves the column above an open shell empty and keeps the interior', () => {
    const grid = threeToGrid(openTopBox(), 1, { insideTest: 'winding' });
    expect(filled(grid, 1, 9, 4)).toBe(false);
    expect(filled(grid, 1, 8, 4)).toBe(false);
    expect(filled(grid, 3, 3, 3)).toBe(true);
    expect(filled(grid, 3, 1, 3)).toBe(true);
    expect(filled(grid, 7, 9, 0)).toBe(true); // the pole
  });

  it('winding fills where two closed bodies overlap in one mesh (parity cancels it)', () => {
    const two = (): THREE.Group => oneMesh(boxGeometry([0, 0, 0], [6, 6, 6]), boxGeometry([3, 0.13, 0.29], [9, 6.13, 6.29]));
    expect(filled(threeToGrid(two(), 1), 5, 1, 3)).toBe(false);
    expect(filled(threeToGrid(two(), 1, { insideTest: 'winding' }), 5, 1, 3)).toBe(true);
  });

  it('winding agrees with parity on a closed box', () => {
    const closed = (): THREE.Group => oneMesh(boxGeometry([0, 0, 0], [5, 4, 6]));
    const a = threeToGrid(closed(), 1);
    const b = threeToGrid(closed(), 1, { insideTest: 'winding' });
    expect(b.countNonAir()).toBe(a.countNonAir());
    expect(b.countNonAir()).toBe(5 * 4 * 6);
  });

  it("the default and 'parity' are the same voxels", () => {
    const a = threeToGrid(openTopBox(), 1);
    const b = threeToGrid(openTopBox(), 1, { insideTest: 'parity' });
    expect(Array.from(b.rawData)).toEqual(Array.from(a.rawData));
  });

  it('threeToGridAsync honours the option', async () => {
    const grid = await threeToGridAsync(openTopBox(), 1, { insideTest: 'winding', yieldInterval: 0 });
    expect(filled(grid, 1, 9, 4)).toBe(false);
    expect(filled(grid, 3, 3, 3)).toBe(true);
  });
});
