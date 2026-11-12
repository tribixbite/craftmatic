/**
 * L-01 (BIZ-33): an LDraw brick is a SOLID of 3 plate layers, and its studs are not an extra layer.
 *
 * X-10 found `latticeFromBricks` filled one plate layer of a single 3001: a brick is a closed bowl (roof slab,
 * four walls, underside cavity open to the ground) whose cavity cells have their centre in air, so the shell
 * fill left layers 0..1 empty. V-02 found the merged-mesh lattice one partial layer taller than the truth: the
 * studs (4 LDU, half a plate) stand on every top face. These tests build that geometry synthetically (a bowl
 * brick with its studs) so they run without the LDraw library; the real-library numbers are the env-gated
 * `legolize-lattice-iou.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { latticeFromBricks, meshToLattice, type BrickLike, type TriangleLike } from '../web/src/engine/legolize/lattice.js';
import { latticeIndex, type IntentLattice } from '../web/src/engine/legolize/types.js';
import type { InsideTest } from '@craft/convert/voxelizer.js';

type V3 = [number, number, number];
const v = (x: number, y: number, z: number): V3 => [x, y, z];
const quad = (a: V3, b: V3, c: V3, d: V3): TriangleLike[] => [[a, b, c], [a, c, d]];

/** Closed axis-aligned box in the LDraw frame (Y down). */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): TriangleLike[] {
  return [
    ...quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)),
    ...quad(v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)),
    ...quad(v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)),
    ...quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)),
    ...quad(v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0)),
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),
  ];
}

/** An open-bottomed stud (LDraw's stud: side wall + top disc, no base) from y0 up to y1. */
function stud(cx: number, cz: number, y0: number, y1: number): TriangleLike[] {
  const n = 12, r = 6;
  const ring = (i: number, y: number): V3 => v(cx + r * Math.cos((2 * Math.PI * i) / n), y, cz + r * Math.sin((2 * Math.PI * i) / n));
  const out: TriangleLike[] = [];
  for (let i = 0; i < n; i++) {
    out.push([ring(i, y0), ring(i + 1, y0), ring(i + 1, y1)], [ring(i, y0), ring(i + 1, y1), ring(i, y1)]);
    out.push([v(cx, y1, cz), ring(i, y1), ring(i + 1, y1)]);
  }
  return out;
}

/**
 * A 3001-like brick, `w` x `d` studs, origin at the top-face corner, y DOWN: a 4 LDU roof slab, 4 LDU walls and
 * a 20 LDU cavity open at the bottom (y = 24), one stud per cell standing 4 LDU above the top face. One closed
 * surface (outer faces + underside rim + inner faces), as the library's bricks are.
 */
function hollowBrick(w: number, d: number): TriangleLike[] {
  const W = w * 20, D = d * 20, H = 24, T = 4;
  const tris: TriangleLike[] = [];
  // Outer top and four outer sides.
  tris.push(...quad(v(0, 0, D), v(W, 0, D), v(W, 0, 0), v(0, 0, 0)));
  tris.push(...quad(v(0, 0, D), v(W, 0, D), v(W, H, D), v(0, H, D)));
  tris.push(...quad(v(W, 0, 0), v(0, 0, 0), v(0, H, 0), v(W, H, 0)));
  tris.push(...quad(v(W, 0, D), v(W, 0, 0), v(W, H, 0), v(W, H, D)));
  tris.push(...quad(v(0, 0, 0), v(0, 0, D), v(0, H, D), v(0, H, 0)));
  // Underside rim: the flat annulus between the outer wall and the inner wall.
  tris.push(...quad(v(0, H, 0), v(W, H, 0), v(W - T, H, T), v(T, H, T)));
  tris.push(...quad(v(W, H, 0), v(W, H, D), v(W - T, H, D - T), v(W - T, H, T)));
  tris.push(...quad(v(W, H, D), v(0, H, D), v(T, H, D - T), v(W - T, H, D - T)));
  tris.push(...quad(v(0, H, D), v(0, H, 0), v(T, H, T), v(T, H, D - T)));
  // Inner walls and the cavity ceiling.
  tris.push(...quad(v(T, T, D - T), v(W - T, T, D - T), v(W - T, H, D - T), v(T, H, D - T)));
  tris.push(...quad(v(W - T, T, T), v(T, T, T), v(T, H, T), v(W - T, H, T)));
  tris.push(...quad(v(W - T, T, D - T), v(W - T, T, T), v(W - T, H, T), v(W - T, H, D - T)));
  tris.push(...quad(v(T, T, T), v(T, T, D - T), v(T, H, D - T), v(T, H, T)));
  tris.push(...quad(v(T, T, T), v(W - T, T, T), v(W - T, T, D - T), v(T, T, D - T)));
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) tris.push(...stud(10 + 20 * i, 10 + 20 * j, 0, -4));
  return tris;
}

const PARTS: Record<string, TriangleLike[]> = {
  brick2x4: hollowBrick(4, 2),
  // A plate with studs: a solid 8 LDU slab.
  plate2x2: [...box(0, 0, 0, 40, 8, 40), ...[0, 1].flatMap((i) => [0, 1].flatMap((j) => stud(10 + 20 * i, 10 + 20 * j, 0, -4)))],
  // A bridge: two 1x1 pillars 24 tall, a 1x4 plate across their tops, 40 LDU of open air between (open to +-z).
  pillar: box(0, 0, 0, 20, 24, 20),
  deck: box(0, 0, 0, 80, 8, 20),
};

const brick = (part: string, x: number, y: number, z: number): BrickLike => ({ part, color: 4, x, y, z });
const moved = (b: BrickLike): TriangleLike[] => PARTS[b.part]!.map((t) => t.map(([x, y, z]) => [x + b.x, y + b.y, z + b.z] as V3));
const opts = (insideTest: InsideTest) => ({ mode: 'solid' as const, insideTest, partTriangles: async (b: BrickLike) => moved(b) });
const filledAt = (l: IntentLattice, x: number, p: number, z: number): boolean => l.cells[latticeIndex(l.dims, x, p, z)] !== 0;
const layerCounts = (l: IntentLattice): number[] => {
  const out: number[] = [];
  for (let p = 0; p < l.dims[1]; p++) {
    let n = 0;
    for (let z = 0; z < l.dims[2]; z++) for (let x = 0; x < l.dims[0]; x++) if (filledAt(l, x, p, z)) n++;
    out.push(n);
  }
  return out;
};

/** A three.js Group (Y up, merged into ONE mesh) of the same placed bricks, as an imported GLB would be. */
function mergedMesh(bricks: BrickLike[]): THREE.Group {
  const tris = bricks.flatMap(moved);
  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((p, j) => pos.set([p[0], -p[1], p[2]], i * 9 + j * 3)));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc91a09, side: THREE.DoubleSide })));
  g.updateMatrixWorld(true);
  return g;
}

describe.each(['parity', 'winding'] as const)('legolize underside + studs (%s)', (insideTest) => {
  it('a single hollow brick fills all three plate layers and its studs are not a fourth', async () => {
    const lat = await latticeFromBricks([brick('brick2x4', 0, 0, 0)], opts(insideTest));
    expect(layerCounts(lat)).toEqual([8, 8, 8]);
  });

  it('two stacked bricks fill six layers', async () => {
    const lat = await latticeFromBricks([brick('brick2x4', 0, 0, 0), brick('brick2x4', 0, -24, 0)], opts(insideTest));
    expect(layerCounts(lat)).toEqual([8, 8, 8, 8, 8, 8]);
  });

  it('a stud-topped plate is one layer, not two', async () => {
    const lat = await latticeFromBricks([brick('plate2x2', 0, 0, 0)], opts(insideTest));
    expect(layerCounts(lat)).toEqual([4]);
  });

  it('a plate bridge does not fill the open air under it', async () => {
    const lat = await latticeFromBricks(
      [brick('pillar', 0, 0, 0), brick('pillar', 60, 0, 0), brick('deck', 0, -8, 0)], opts(insideTest),
    );
    // Layers 0..2 are the pillars (cells x 0 and 3); the deck is layer 3. The two middle columns stay empty below it.
    expect(layerCounts(lat)).toEqual([2, 2, 2, 4]);
  });

  it('the merged mesh of the same two bricks gives the same lattice', async () => {
    const lat = await meshToLattice(mergedMesh([brick('brick2x4', 0, 0, 0), brick('brick2x4', 0, -24, 0)]), { lduPerUnit: 1, mode: 'solid', insideTest });
    expect(layerCounts(lat)).toEqual([8, 8, 8, 8, 8, 8]);
  });
});
