/**
 * X-11 (BIZ-33): mesh / LDraw bricks -> IntentLattice (20 x 8 x 20 LDU cells).
 * Meshes are built from raw triangles, never a BoxGeometry round-trip.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { meshToLattice, latticeFromBricks } from '../web/src/engine/legolize/lattice.js';
import { latticeIndex, type IntentLattice } from '../web/src/engine/legolize/types.js';
import { createNearest, DEFAULT_PALETTE } from '../web/src/engine/legolize/palette.js';

type V3 = [number, number, number];

/** 12 outward-wound triangles of the box [0,w] x [0,h] x [0,d] (+ offset). */
function boxTriangles(w: number, h: number, d: number, o: V3 = [0, 0, 0]): V3[][] {
  const [x0, y0, z0] = o;
  const [x1, y1, z1] = [x0 + w, y0 + h, z0 + d];
  const p = (x: number, y: number, z: number): V3 => [x, y, z];
  const quad = (a: V3, b: V3, c: V3, e: V3): V3[][] => [[a, b, c], [a, c, e]];
  return [
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)), // +z
    ...quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0)), // -z
    ...quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1)), // +x
    ...quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)), // -x
    ...quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0)), // +y
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)), // -y
  ];
}

/** A mesh from raw triangles; `colour` (linear 0-1) becomes a COLOR_0 attribute when given. */
function meshOf(tris: V3[][], opts: { colour?: V3; materialHex?: number } = {}): THREE.Group {
  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, j) => pos.set(v, i * 9 + j * 3)));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (opts.colour) {
    const col = new Float32Array(tris.length * 9);
    for (let i = 0; i < tris.length * 3; i++) col.set(opts.colour, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const mat = new THREE.MeshStandardMaterial({ color: opts.materialHex ?? 0xffffff, side: THREE.DoubleSide, vertexColors: !!opts.colour });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, mat));
  g.updateMatrixWorld(true);
  return g;
}

const filled = (l: IntentLattice): number => l.cells.reduce((n, c) => n + (c ? 1 : 0), 0);
const cellAt = (l: IntentLattice, x: number, p: number, z: number): number => l.cells[latticeIndex(l.dims, x, p, z)]!;

describe('legolize-lattice', () => {
  it('a 40x24x40 LDU box fills exactly 2x3x2 plate cells', async () => {
    const lat = await meshToLattice(meshOf(boxTriangles(40, 24, 40)), { lduPerUnit: 1, mode: 'solid' });
    expect(lat.dims).toEqual([2, 3, 2]);
    expect(filled(lat)).toBe(12);
  });

  it('a vertex-coloured red mesh snaps to LDraw 4', async () => {
    const lat = await meshToLattice(meshOf(boxTriangles(40, 24, 40), { colour: [1, 0, 0] }), { lduPerUnit: 1, mode: 'solid' });
    expect(lat.labels).toHaveLength(1);
    expect(lat.labels[0]).toMatchObject({ role: 'solid', colour: 4 });
    expect(cellAt(lat, 0, 0, 0)).toBe(1);
  });

  it('an injected nearest() decides the colour code', async () => {
    const lat = await meshToLattice(meshOf(boxTriangles(40, 24, 40), { colour: [1, 0, 0] }), { lduPerUnit: 1, mode: 'solid', nearest: () => 15 });
    expect(lat.labels.map((l) => l.colour)).toEqual([15]);
  });

  it('a material colour is used when there are no vertex colours', async () => {
    const lat = await meshToLattice(meshOf(boxTriangles(40, 24, 40), { materialHex: 0x0055bf }), { lduPerUnit: 1, mode: 'solid' });
    expect(lat.labels[0]!.colour).toBe(1);
  });

  it('a 1-plate-thick slab is one cell tall, not zero', async () => {
    const lat = await meshToLattice(meshOf(boxTriangles(60, 8, 60)), { lduPerUnit: 1, mode: 'solid' });
    expect(lat.dims).toEqual([3, 1, 3]);
    expect(filled(lat)).toBe(9);
  });

  it('lduPerUnit scales the input units (metres at 1000 LDU per unit)', async () => {
    // A 0.04 x 0.024 x 0.04 box at 1000 LDU per unit is 40 x 24 x 40 LDU.
    const lat = await meshToLattice(meshOf(boxTriangles(0.04, 0.024, 0.04)), { lduPerUnit: 1000, mode: 'solid' });
    expect(lat.dims).toEqual([2, 3, 2]);
  });

  it('surface mode leaves the interior of a closed box empty and solid mode fills it', async () => {
    const box = (): THREE.Group => meshOf(boxTriangles(200, 80, 200));
    const solid = await meshToLattice(box(), { lduPerUnit: 1, mode: 'solid' });
    const surface = await meshToLattice(box(), { lduPerUnit: 1, mode: 'surface' });
    expect(solid.dims).toEqual([10, 10, 10]);
    expect(filled(solid)).toBe(1000);
    expect(cellAt(surface, 5, 5, 5)).toBe(0);
    expect(cellAt(surface, 0, 0, 0)).not.toBe(0);
    expect(filled(surface)).toBeLessThan(filled(solid));
  });

  it('does not mutate or reparent the input object', async () => {
    const obj = meshOf(boxTriangles(40, 24, 40));
    const parent = new THREE.Group();
    parent.add(obj);
    await meshToLattice(obj, { lduPerUnit: 1, mode: 'solid' });
    expect(obj.parent).toBe(parent);
    expect(obj.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('refuses a lattice past maxCells', async () => {
    await expect(meshToLattice(meshOf(boxTriangles(400, 400, 400)), { lduPerUnit: 1, mode: 'solid', maxCells: 100 })).rejects.toThrow(/maxCells/);
  });

  it('latticeFromBricks of one 2x4 brick fills 2x3x4 cells', async () => {
    // LDraw: origin on the top stud plane, body runs to +y (down): [0,24] in y.
    const tris = boxTriangles(40, 24, 80);
    const lat = await latticeFromBricks(
      [{ part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }],
      { partTriangles: async () => tris, mode: 'solid' },
    );
    expect(lat.dims).toEqual([2, 3, 4]);
    expect(filled(lat)).toBe(24);
    // The brick's own LDraw colour survives exactly.
    expect(lat.labels).toHaveLength(1);
    expect(lat.labels[0]!.colour).toBe(4);
  });

  it('latticeFromBricks keeps a stacked brick on the layers above its support', async () => {
    const lat = await latticeFromBricks(
      [{ part: 'a.dat', color: 4, x: 0, y: 0, z: 0 }, { part: 'a.dat', color: 1, x: 0, y: -24, z: 0 }],
      { partTriangles: async (b) => boxTriangles(40, 24, 40, [b.x, b.y, b.z]), mode: 'solid' },
    );
    expect(lat.dims).toEqual([2, 6, 2]);
    // LDraw y is down: the brick at y=-24 is the upper one.
    expect(lat.labels[cellAt(lat, 0, 5, 0) - 1]!.colour).toBe(1);
    expect(lat.labels[cellAt(lat, 0, 0, 0) - 1]!.colour).toBe(4);
  });
});

describe('legolize-palette', () => {
  it('the default palette has 40 distinct codes', () => {
    expect(DEFAULT_PALETTE).toHaveLength(40);
    expect(new Set(DEFAULT_PALETTE.map((c) => c.code)).size).toBe(40);
  });
  it('every palette colour maps to itself', () => {
    const nearest = createNearest();
    for (const c of DEFAULT_PALETTE) expect(nearest(c.rgb)).toBe(c.code);
  });
  it('pure white maps to 15 and near-black to 0', () => {
    const nearest = createNearest();
    expect(nearest([255, 255, 255])).toBe(15);
    expect(nearest([5, 5, 5])).toBe(0);
  });
});
