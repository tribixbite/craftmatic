/**
 * Before/after evidence for the floating-hair fix, on REAL parts.
 *
 * Picks a minifig out of a model (a 3626* head plus every brick within one
 * stud), voxelizes just that cluster through the real geometry voxelizer with
 * the inter-part contact pass OFF and ON, and prints the same vertical slice
 * both ways plus the 6-connected component count.
 *
 * Usage: bun scripts/_minifig_slice.ts <model.io> [cellLDU=4] [figIndex=0] [--pair]
 *          [--out <prefix>]   also writes <prefix>-off.schem / <prefix>-on.schem
 *                             so the two can be compared in an external viewer
 */
import { readFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { writeFileSync } from 'node:fs';
import { setLDrawRoot, voxelizeLDrawGeometry } from '../web/src/engine/ldraw-geometry.ts';
import { fillSingleVoxelGaps } from '../web/src/engine/ldraw-voxelizer.ts';
import { encodeSchemBytes } from '../web/src/engine/schem-encode.ts';
import type { BlockGrid } from '../src/schem/types.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const file = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/76416-1.io';
const cell = Number(process.argv[3] ?? 4);
const which = Number(process.argv[4] ?? 0);

const b = readFileSync(file);
const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const bricks = parseLDraw(synthesizeLSynth(io.text).text);
const bare = (p: string) => p.replace(/\.dat$/i, '').toLowerCase().split(/[/\\]/).pop()!;
const heads = bricks.filter(x => /^3626/.test(bare(x.part)))
  .filter(h => bricks.some(o => o !== h && Math.hypot(o.x - h.x, o.z - h.z) < 24 && o.y < h.y - 1));
const head = heads[which];
if (!head) { console.log(`no assembled minifig #${which} in ${file}`); process.exit(1); }
let fig = bricks.filter(x => Math.hypot(x.x - head.x, x.z - head.z) < 30 && Math.abs(x.y - head.y) < 90);
// --pair isolates the head and the piece sitting on it, so the head-to-hair
// seam is not hidden by the torso/neck cells that surround it in a full figure.
if (process.argv.includes('--pair')) {
  const above = fig.filter(x => x !== head && x.y < head.y - 1).sort((p2, q) => q.y - p2.y)[0];
  fig = above ? [head, above] : [head];
}
console.log(`minifig #${which} at (${head.x},${head.y},${head.z}) — ${fig.length} parts: ${fig.map(f => f.part.replace(/\.dat$/, '')).join(' ')}`);

function components(grid: BlockGrid): number {
  const { width: W, height: H, length: L } = grid;
  const seen = new Uint8Array(W * H * L);
  const idx = (x: number, y: number, z: number) => (x * H + y) * L + z;
  let n = 0;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) {
    if (seen[idx(x, y, z)] || grid.get(x, y, z) === 'minecraft:air') continue;
    n++;
    const st: Array<[number, number, number]> = [[x, y, z]];
    seen[idx(x, y, z)] = 1;
    while (st.length) {
      const [cx, cy, cz] = st.pop()!;
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as const) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= L) continue;
        const i = idx(nx, ny, nz);
        if (seen[i] || grid.get(nx, ny, nz) === 'minecraft:air') continue;
        seen[i] = 1; st.push([nx, ny, nz]);
      }
    }
  }
  return n;
}

/** One-character-per-cell X/Y slice at the model's mid Z. */
function slice(grid: BlockGrid): string[] {
  const z = Math.floor(grid.length / 2);
  const rows: string[] = [];
  for (let y = grid.height - 1; y >= 0; y--) {
    let r = '';
    for (let x = 0; x < grid.width; x++) r += grid.get(x, y, z) === 'minecraft:air' ? '.' : '#';
    rows.push(`  y=${String(y).padStart(2)} |${r}|`);
  }
  return rows;
}

const off = await voxelizeLDrawGeometry(fig, undefined, { cellLDU: cell, bridgeParts: false });
const on  = await voxelizeLDrawGeometry(fig, undefined, { cellLDU: cell, bridgeParts: true });
const a = slice(off.grid), c = slice(on.grid);
console.log(`\nOFF: ${off.grid.countNonAir()} cells, ${components(off.grid)} components` +
  `      ON: ${on.grid.countNonAir()} cells, ${components(on.grid)} components (+${on.bridge?.cellsAdded} bridge cells, ${on.bridge?.bridgedPairs} pairs)`);
for (let i = 0; i < Math.max(a.length, c.length); i++) {
  console.log(`${(a[i] ?? '').padEnd(46)}${c[i] ?? ''}`);
}

const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const prefix = process.argv[outIdx + 1]!;
  for (const [tag, r] of [['off', off], ['on', on]] as const) {
    fillSingleVoxelGaps(r.grid);            // same post-pass the real export runs
    writeFileSync(`${prefix}-${tag}.schem`, encodeSchemBytes(r.grid));
  }
  console.log(`wrote ${prefix}-off.schem / ${prefix}-on.schem`);
}
