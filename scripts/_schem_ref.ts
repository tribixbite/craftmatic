/**
 * S3/S5 quality gate: emit a reference .schem + grid digest through the REAL
 * shared export path (engine/schem-pipeline.ts — the same code the LEGO tab's
 * Web Worker runs), then print its sha256.
 *
 * Usage: bun scripts/_schem_ref.ts [model.io] [out.schem] [forcedCellLDU] [--no-bridge]
 *
 * Baseline (2026-09-08, 21063 @ auto → cellLDU 4, default settings):
 *   schemSha256 408211962258b430e0e9957f68c9e4722a9eb0ea9fd22429124082998bde5d3d
 *   gridSha256  41800dbd4766c3fcd9525af0ec1ef8e78e680fc235d63e16752bc26cb765ed16
 *   nonAir 1,190,999 · dims 131×196×291
 * PREVIOUS baseline 53dac11a86…e40e2, retired 2026-09-08 by the Bedrock-export
 * work — but NOT caused by it: measured at the commit BEFORE those edits (with
 * the encode-path changes stashed) the hash was already 40821196…, and it is
 * stable across repeated runs. `nonAir` and `dims` are unchanged from the old
 * baseline, so whatever moved it permuted the palette rather than the model. The
 * docstring had simply drifted from the code; recorded here rather than left
 * stale, since a stale gate is a gate nobody trusts.
 * PREVIOUS baseline d158bebb54…3fd7 (nonAir 1,189,251), retired 2026-09-08 by
 * the inter-part contact pass (bridgePartContacts) that closed the sub-cell
 * gaps quantization opened between touching parts — the "minifig hair floats
 * above the head" bug. Verified additive: 1,748 cells gained, 0 lost
 * (`scripts/_schem_diff.ts`).
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
// Positional, so a flag must not land here: passing `--mcpack` as argv[4] made
// it the resolution choice and produced an EMPTY grid.
const forcedCellArg = process.argv[4];
const forcedCell = forcedCellArg?.startsWith('--') ? undefined : forcedCellArg;
const lightFill = process.argv.includes('--lights');
/** A/B switch for the inter-part contact pass (see bridgePartContacts). */
const bridgeParts = !process.argv.includes('--no-bridge');
/** A/B switch for the block-shape pass (see engine/block-shapes.ts). */
const shapes = !process.argv.includes('--no-shapes');
/**
 * `--mcpack` emits Bedrock's native format (engine/mcpack.ts) through the SAME
 * pipeline instead of a Java .schem — the grid is identical, only the encoder
 * differs, which is exactly the claim worth being able to check offline.
 */
const mcpack = process.argv.includes('--mcpack');
/** `--profile=textured` to A/B a block-mapping profile (see engine/block-profiles.ts). */
const profile = process.argv.find(a => a.startsWith('--profile='))?.slice('--profile='.length)
  ?? DEFAULT_SCHEM_SETTINGS.profile;

const b = readFileSync(file);
const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const bricks = parseLDraw(synthesizeLSynth(io.text).text);

const choice: ResolutionChoice = (forcedCell as ResolutionChoice) ?? DEFAULT_SCHEM_SETTINGS.resolution;
const plan = planResolution(spanOfBricks(bricks), choice);

const t0 = Date.now();
const { grid, bytes, shapes: shapeStats, elements: elementStats, mcpack: packInfo } = await runSchemPipeline({
  source: {
    kind: 'bricks',
    bricks,
    colorSpace: io.colorSpace === 'bl' ? 'bl' : 'ldraw',
    options: { cellLDU: plan.cellLDU, maxDim: 700, bridgeParts },
  },
  format: mcpack ? 'mcpack' : 'schem',
  packStem: out.replace(/\.[^.]+$/, '').replace(/^.*[\/]/, ''),
  profile,
  lightFill,
  shapes,
});
const voxMs = Date.now() - t0;

writeFileSync(out, bytes!);
const raw = grid.rawData;
console.log(JSON.stringify({
  file,
  cellLDU: plan.cellLDU,
  colorSpace: io.colorSpace,
  profile,
  bridgeParts,
  lightFill,
  shapes,
  shapeStats,
  elementStats,
  dims: [grid.width, grid.height, grid.length],
  nonAir: grid.countNonAir(),
  palette: [...grid.palette.keys()],
  format: mcpack ? 'mcpack' : 'schem',
  packInfo,
  schemSha256: createHash('sha256').update(bytes!).digest('hex'),
  schemBytes: bytes!.length,
  gridSha256: createHash('sha256').update(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)).digest('hex'),
  voxMs,
}, null, 1));
