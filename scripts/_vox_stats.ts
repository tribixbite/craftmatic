/**
 * Measurement harness for export voxelization quality.
 *
 * Runs the REAL geometry voxelizer (engine/ldraw-geometry.ts) over a model at a
 * given cell size and reports the numbers the fidelity work is judged on:
 * non-air cells, fallback (no-geometry) parts, the inter-part contact pass
 * (floating / bridged / cells added) and wall time.
 *
 * Usage: bun scripts/_vox_stats.ts <model.io> [cellLDU=4] [--no-bridge]
 */
import { readFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { setLDrawRoot, voxelizeLDrawGeometry } from '../web/src/engine/ldraw-geometry.ts';
import { getBlockProfile } from '../web/src/engine/block-profiles.ts';

if (process.argv.includes('--profile')) (globalThis as { __voxProfile?: boolean }).__voxProfile = true;
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const file = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/76416-1.io';
const cell = Number(process.argv[3] ?? 4);
const bridgeParts = !process.argv.includes('--no-bridge');

const buf = readFileSync(file);
const io = await extractIoModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const bricks = parseLDraw(synthesizeLSynth(io.text).text);
const colorFn = getBlockProfile('default').colorFn(io.colorSpace === 'bl' ? 'bl' : 'ldraw');

const t0 = Date.now();
const r = await voxelizeLDrawGeometry(bricks, colorFn, { cellLDU: cell, maxDim: 700, bridgeParts });
const ms = Date.now() - t0;

console.log(JSON.stringify({
  file, cell, bridgeParts,
  bricks: bricks.length,
  dims: r.dimensions,
  nonAir: r.grid.countNonAir(),
  fallbackPartCount: r.fallbackPartCount,
  bridge: r.bridge,
  ms,
}));
