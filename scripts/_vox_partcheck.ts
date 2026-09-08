/**
 * Per-part voxel-coverage check.
 *
 * Voxelizes ONE part at a time and compares the result against what the part's
 * real LDraw extent says it should be: a 2×4 brick is 40×24×80 LDU, so at a
 * 4-LDU cell it must come out a solid 10×6×20 box plus studs. Reports cells,
 * the implied solid volume, the AABB volume, the fill ratio, and — the thing
 * that actually matters — whether the shell has HOLES (air cells reachable from
 * outside that sit strictly inside the part's AABB interior).
 *
 * Usage: bun scripts/_vox_partcheck.ts [cellLDU=4]
 */
import { setLDrawRoot, voxelizeLDrawGeometry, __debugWorldTris } from '../web/src/engine/ldraw-geometry.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import type { BlockGrid } from '../src/schem/types.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const cell = Number(process.argv[2] ?? 4);

const PARTS = [
  ['3001', 'Brick 2x4'],
  ['3004', 'Brick 1x2'],
  ['3020', 'Plate 2x4'],
  ['3040', 'Slope 45 2x1'],
  ['3062b', 'Round Brick 1x1'],
  ['3626c', 'Minifig Head'],
  ['4286', 'Slope 33 3x1'],
  ['3068b', 'Tile 2x2'],
  ['3665', 'Slope Inverted 45 2x1'],
  ['54200', 'Slope 31 1x1 (cheese)'],
];

/** Air cells strictly inside the grid that are NOT reachable from the border. */
function enclosedAir(grid: BlockGrid): number {
  const { width: W, height: H, length: L } = grid;
  const seen = new Uint8Array(W * H * L);
  const idx = (x: number, y: number, z: number) => (x * H + y) * L + z;
  const stack: number[] = [];
  const air = (x: number, y: number, z: number) => grid.get(x, y, z) === 'minecraft:air';
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) {
    if (x && y && z && x < W - 1 && y < H - 1 && z < L - 1) continue;
    if (!air(x, y, z) || seen[idx(x, y, z)]) continue;
    seen[idx(x, y, z)] = 1; stack.push(x, y, z);
  }
  while (stack.length) {
    const z = stack.pop()!, y = stack.pop()!, x = stack.pop()!;
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as const) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= L) continue;
      const i = idx(nx, ny, nz);
      if (seen[i] || !air(nx, ny, nz)) continue;
      seen[i] = 1; stack.push(nx, ny, nz);
    }
  }
  let enclosed = 0;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++)
    if (air(x, y, z) && !seen[idx(x, y, z)]) enclosed++;
  return enclosed;
}

console.log(`cell=${cell}`);
for (const [id, name] of PARTS) {
  const brick: ParsedBrick = { color: 15, x: 0, y: 0, z: 0, part: `${id}.dat` };
  const tris = await __debugWorldTris(brick);
  if (tris.length === 0) { console.log(`${id.padEnd(7)} ${name.padEnd(24)} NO GEOMETRY`); continue; }
  let xn = Infinity, xx = -Infinity, yn = Infinity, yx = -Infinity, zn = Infinity, zx = -Infinity;
  for (const t of tris) for (const v of t) {
    if (v[0] < xn) xn = v[0]; if (v[0] > xx) xx = v[0];
    if (v[1] < yn) yn = v[1]; if (v[1] > yx) yx = v[1];
    if (v[2] < zn) zn = v[2]; if (v[2] > zx) zx = v[2];
  }
  const r = await voxelizeLDrawGeometry([brick], undefined, { cellLDU: cell, bridgeParts: false });
  const cells = r.grid.countNonAir();
  const aabbCells = ((xx - xn) / cell) * ((yx - yn) / cell) * ((zx - zn) / cell);
  const d = r.dimensions;
  console.log(
    `${id.padEnd(7)} ${name.padEnd(24)} tris=${String(tris.length).padStart(5)} ` +
    `dims=${`${d.w}x${d.h}x${d.l}`.padEnd(12)} cells=${String(cells).padStart(6)} ` +
    `aabbCells=${aabbCells.toFixed(0).padStart(6)} fill=${(cells / aabbCells * 100).toFixed(1).padStart(6)}% ` +
    `enclosedAir=${enclosedAir(r.grid)}`,
  );
}
