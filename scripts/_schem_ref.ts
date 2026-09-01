/**
 * S3/S5 quality gate: emit a reference .schem + grid digest through the REAL
 * shared export path (engine/schem-pipeline.ts — the same code the LEGO tab's
 * Web Worker runs), then print its sha256.
 *
 * Usage: bun scripts/_schem_ref.ts [model.io] [out.schem] [forcedCellLDU]
 *
 * Baseline (2026-09-01, 21063 @ auto → cellLDU 4, default settings):
 *   schemSha256 52d221188f5677475392a25c4e45f6d137ba43af547c9d8c4ba44b9a8194be6b
 * Any change to voxelization, gap filling, the colour tables or the NBT writer
 * moves this hash. If you didn't mean to, you broke something.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.ts';
import { planResolution, spanOfBricks, DEFAULT_SCHEM_SETTINGS, type ResolutionChoice } from '../web/src/engine/schem-settings.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const file = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/21063.io';
const out  = process.argv[3] ?? 'out.schem';
const forcedCell = process.argv[4];
const lightFill = process.argv.includes('--lights');

const b = readFileSync(file);
const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const bricks = parseLDraw(synthesizeLSynth(io.text).text);

const choice: ResolutionChoice = (forcedCell as ResolutionChoice) ?? DEFAULT_SCHEM_SETTINGS.resolution;
const plan = planResolution(spanOfBricks(bricks), choice);

const t0 = Date.now();
const { grid, bytes } = await runSchemPipeline({
  source: {
    kind: 'bricks',
    bricks,
    colorSpace: io.colorSpace === 'bl' ? 'bl' : 'ldraw',
    options: { cellLDU: plan.cellLDU, maxDim: 700 },
  },
  format: 'schem',
  profile: DEFAULT_SCHEM_SETTINGS.profile,
  lightFill,
});
const voxMs = Date.now() - t0;

writeFileSync(out, bytes!);
const raw = grid.rawData;
console.log(JSON.stringify({
  file,
  cellLDU: plan.cellLDU,
  colorSpace: io.colorSpace,
  lightFill,
  dims: [grid.width, grid.height, grid.length],
  nonAir: grid.countNonAir(),
  palette: [...grid.palette.keys()],
  schemSha256: createHash('sha256').update(bytes!).digest('hex'),
  schemBytes: bytes!.length,
  gridSha256: createHash('sha256').update(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)).digest('hex'),
  voxMs,
}, null, 1));
