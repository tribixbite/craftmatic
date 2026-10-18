/**
 * S3 profiler: measure the peak-allocation stages of the .schem export path.
 *
 * Runs the REAL LEGO-tab export chain on a reference set at the same cellLDU
 * the UI would pick, sampling process.memoryUsage() + explicit structure-size
 * estimates at each stage.
 *
 * Usage: bun scripts/_schem_profile.ts [path-to.io] [cellLDU]
 */
import { readFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { voxelizeLDraw, fillSingleVoxelGaps } from '../web/src/engine/ldraw-voxelizer.ts';
import { studioColorToBlock } from '../web/src/engine/studio-colors.ts';
import { encodeSchemBytes } from '../web/src/viewer/exporter.ts';

(globalThis as any).__voxProfile = true;
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const file = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/21063.io';
const forcedCell = process.argv[3] ? Number(process.argv[3]) : undefined;

const MB = (n: number) => (n / 1048576).toFixed(1) + ' MB';
let peakRss = 0;
function mem(label: string) {
  const m = process.memoryUsage();
  if (m.rss > peakRss) peakRss = m.rss;
  console.log(`  [${label.padEnd(28)}] heap=${MB(m.heapUsed).padStart(10)}  rss=${MB(m.rss).padStart(10)}`);
}

const bytes = readFileSync(file);
const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const io = await extractIoModel(ab);
console.log(`file=${file}  entry=${io.sourceEntry}  colorSpace=${io.colorSpace}`);
const colorFn = io.colorSpace === 'bl' ? studioColorToBlock : undefined;
const bricks = parseLDraw(synthesizeLSynth(io.text).text);
console.log(`bricks=${bricks.length}`);
mem('parsed');

// Replicate lego.ts cellLDU selection
const spanLDU = (() => {
  let nx = Infinity, xx = -Infinity, ny = Infinity, xy = -Infinity, nz = Infinity, xz = -Infinity;
  for (const b of bricks) {
    if (b.x < nx) nx = b.x; if (b.x > xx) xx = b.x;
    if (b.y < ny) ny = b.y; if (b.y > xy) xy = b.y;
    if (b.z < nz) nz = b.z; if (b.z > xz) xz = b.z;
  }
  return { x: xx - nx + 80, y: xy - ny + 80, z: xz - nz + 80 };
})();
let cellLDU = 20;
for (const c of [4, 5, 8, 10, 20]) {
  const w = spanLDU.x / c, h = spanLDU.y / c, l = spanLDU.z / c;
  if (Math.max(w, l) <= 640 && h <= 320 && w * h * l <= 30_000_000) { cellLDU = c; break; }
}
if (forcedCell) cellLDU = forcedCell;
console.log(`cellLDU=${cellLDU} (span ${spanLDU.x.toFixed(0)}×${spanLDU.y.toFixed(0)}×${spanLDU.z.toFixed(0)} LDU)`);

const opts = { cellLDU, maxDim: 700 };
const t0 = Date.now();
let grid;
try {
  const r = await voxelizeLDrawGeometry(bricks, colorFn, opts);
  grid = r.grid.countNonAir() >= bricks.length ? r.grid : voxelizeLDraw(bricks, colorFn, opts).grid;
} catch (e) {
  console.log('geometry voxelize failed:', e);
  grid = voxelizeLDraw(bricks, colorFn, opts).grid;
}
mem('after voxelize');
console.log(`  voxelize ${Date.now() - t0} ms; grid ${grid.width}×${grid.height}×${grid.length} = ${(grid.totalBlocks / 1e6).toFixed(2)}M cells, palette=${grid.palette.size}`);
console.log(`  grid.data bytes = ${MB(grid.totalBlocks * 2)}`);

const t1 = Date.now();
fillSingleVoxelGaps(grid);
mem('after fillSingleVoxelGaps');
console.log(`  fillGaps ${Date.now() - t1} ms; nonAir=${grid.countNonAir().toLocaleString()}`);

// Stage: encodeBlockData (number[] varint accumulation)
const t2 = Date.now();
const bd = grid.encodeBlockData();
mem('after encodeBlockData');
console.log(`  encodeBlockData ${Date.now() - t2} ms; ${bd.length.toLocaleString()} bytes (${MB(bd.length)}); transient number[] ≈ ${MB(bd.length * 8)} (min, pre-doubling)`);

const t3 = Date.now();
const schem = encodeSchemBytes(grid);
mem('after encodeSchemBytes');
console.log(`  encodeSchemBytes ${Date.now() - t3} ms; gzipped ${MB(schem.length)}`);

console.log(`PEAK RSS = ${MB(peakRss)}`);
