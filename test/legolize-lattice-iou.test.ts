/**
 * X-11 (BIZ-33) measurement, not a unit test: voxel IoU between the lattice of an
 * IMPORTED MESH (all of a model's part triangles merged into ONE mesh, as a GLB
 * export would be) and the ground-truth lattice built per brick
 * (`latticeFromBricks`). Needs the local part library, so it only runs with
 * `LEGOLIZE_IOU=1` (target >= 0.85; numbers are recorded in TASKS-BUSINESS.md).
 *
 *   LEGOLIZE_IOU=1 bunx vitest run test/legolize-lattice-iou.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import * as THREE from 'three';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { __debugWorldTris, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { meshToLattice, latticeFromBricks, type BrickLike } from '../web/src/engine/legolize/lattice.js';
import type { IntentLattice } from '../web/src/engine/legolize/types.js';
import { latticeIndex } from '../web/src/engine/legolize/types.js';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const RUN = !!process.env['LEGOLIZE_IOU'] && existsSync(LDRAW_ROOT);

/** A tiny LDR line: colour, position (LDU), identity rotation, part. */
const ldr = (rows: Array<[number, number, number, number, string]>): string =>
  rows.map(([c, x, y, z, p]) => `1 ${c} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 ${p}`).join('\n');

/** Hand-written small builds from plain bricks / plates / slopes (origin = top stud plane, y down). */
const SYNTHETIC: Record<string, string> = {
  'wall-2x4-three-courses': ldr([
    [4, 0, 0, 0, '3001.dat'], [4, 80, 0, 0, '3001.dat'],
    [4, 0, -24, 0, '3001.dat'], [4, 80, -24, 0, '3001.dat'],
    [14, 0, -48, 0, '3001.dat'], [14, 80, -48, 0, '3001.dat'],
  ]),
  'plate-base-with-bricks': ldr([
    [7, 0, 0, 0, '3811.dat'],
    [1, 20, -8, 20, '3003.dat'], [1, 100, -8, 20, '3003.dat'], [2, 60, -8, 100, '3001.dat'],
  ]),
  'tower-with-slope': ldr([
    [15, 0, 0, 0, '3003.dat'], [15, 0, -24, 0, '3003.dat'], [15, 0, -48, 0, '3003.dat'],
    [4, 0, -72, 0, '3039.dat'],
  ]),
};

/** Merge triangles into one three.js mesh in the lattice frame (Y up). */
function mergedMesh(tris: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>>): THREE.Group {
  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, j) => pos.set([v[0], -v[1], v[2]], i * 9 + j * 3)));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc91a09, side: THREE.DoubleSide })));
  g.updateMatrixWorld(true);
  return g;
}

/** Voxel IoU of two lattices over the union of their extents (same origin corner). */
export function voxelIoU(a: IntentLattice, b: IntentLattice): number {
  const dims: [number, number, number] = [Math.max(a.dims[0], b.dims[0]), Math.max(a.dims[1], b.dims[1]), Math.max(a.dims[2], b.dims[2])];
  const at = (l: IntentLattice, x: number, p: number, z: number): boolean =>
    x < l.dims[0] && p < l.dims[1] && z < l.dims[2] && l.cells[latticeIndex(l.dims, x, p, z)] !== 0;
  let inter = 0, uni = 0;
  for (let p = 0; p < dims[1]; p++) for (let z = 0; z < dims[2]; z++) for (let x = 0; x < dims[0]; x++) {
    const A = at(a, x, p, z), B = at(b, x, p, z);
    if (A && B) inter++;
    if (A || B) uni++;
  }
  return uni === 0 ? 1 : inter / uni;
}

describe.skipIf(!RUN)('legolize-lattice IoU measurement', () => {
  beforeAll(() => setLDrawRoot(LDRAW_ROOT));
  const models: Array<[string, string]> = [
    ...Object.entries(SYNTHETIC),
    ['nimbus-fixture', 'test/fixtures/nimbus-fixture.ldr'],
    ['batcave-car-assembly', 'test/fixtures/batcave-car-assembly.ldr'],
  ].map(([n, v]) => [n!, v!] as [string, string]);

  for (const [name, src] of models) {
    it(`${name}: merged-mesh lattice vs per-brick lattice`, async () => {
      const text = src.endsWith('.ldr') ? readFileSync(src, 'utf-8') : src;
      const bricks: BrickLike[] = parseLDraw(text);
      expect(bricks.length).toBeGreaterThan(0);
      const all: Array<ReadonlyArray<readonly [number, number, number]>> = [];
      for (const b of bricks) all.push(...(await __debugWorldTris(b)));
      const truth = await latticeFromBricks(bricks, { mode: 'solid' });
      const mesh = await meshToLattice(mergedMesh(all), { lduPerUnit: 1, mode: 'solid' });
      const iou = voxelIoU(mesh, truth);
      console.log(`IOU ${name}: ${iou.toFixed(3)}  bricks=${bricks.length} truth=${truth.dims.join('x')} mesh=${mesh.dims.join('x')}`);
      expect(iou).toBeGreaterThan(0);
    }, 300_000);
  }
});
