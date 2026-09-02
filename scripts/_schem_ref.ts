/**
 * S3/S5 quality gate: emit a reference .schem + grid digest through the REAL
 * shared export path (engine/schem-pipeline.ts — the same code the LEGO tab's
 * Web Worker runs), then print its sha256.
 *
 * Usage: bun scripts/_schem_ref.ts [model.io] [out.schem] [forcedCellLDU]
 *
 * Baseline (2026-09-02, 21063 @ auto → cellLDU 4, default settings):
 *   schemSha256 d158bebb54bb00cad0ead543a8310bf53fbb7f7f49021252f852e820e2cf3fd7
 *   nonAir 1,189,251 · dims 131×196×291
 * Any change to voxelization, gap filling, the colour tables or the NBT writer
 * moves this hash. If you didn't mean to, you broke something.
 *
 * PREVIOUS baseline 52d221188f…4be6b (nonAir 1,184,777), retired 2026-09-02 by
 * the concurrent-resolution fix in ldraw-geometry.ts. `partGeomCache` handed
 * out a part's triangle array before its sub-file references had been appended,
 * so a parent could bake in a HALF-ASSEMBLED child — which child lost the race
 * depended purely on fetch timing. Two consequences, both now gone: 4,474 cells
 * of real geometry were silently dropped, and the same model voxelized to a
 * DIFFERENT grid over a warm cache (1,174,763 cells) than over the network. The
 * old hash was reproducible only because the CLI's timing was.
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
