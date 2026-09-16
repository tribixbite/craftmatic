/**
 * Bedrock entity gate: export a model to a playable `.mcaddon` through the REAL
 * shared pipeline (engine/schem-pipeline.ts, the code the LEGO tab's Worker
 * runs) against the local LDraw library, then print the entity diagnostics
 * and the archive's sha256.
 *
 * Usage: bun scripts/_playable_ref.ts <model.io|.mpd|.ldr> [out.mcaddon]
 *          [--quality=balanced|high|ultra] [--mode=auto|car|plane|boat]
 *          [--facing=auto|+x|-x|+z|-z] [--label=<text>] [--no-pbr] [--camera=orbit|boom] [--main-only]
 *          [--buildings=bricks|blocks]   (bricks: the building as a brick-accurate shell entity over colliders)
 *
 * Output defaults to output/bedrock-entity-qa/<stem>.mcaddon (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.ts';
import { planResolution, spanOfBricks, DEFAULT_SCHEM_SETTINGS } from '../web/src/engine/schem-settings.ts';
import { modelExportStem } from '../web/src/engine/export-name.ts';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
setLDrawRoot(LDRAW_ROOT);

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = positional[0];
if (!file) { console.error('usage: bun scripts/_playable_ref.ts <model> [out.mcaddon] [--quality=…] [--mode=…] [--facing=…] [--label=…] [--no-pbr]'); process.exit(2); }
const quality = (flag('quality') ?? 'balanced') as 'balanced' | 'high' | 'ultra';
const vehicleMode = (flag('mode') ?? 'auto') as 'auto' | 'car' | 'plane' | 'boat' | 'static';
const vehicleFacing = (flag('facing') ?? 'auto') as 'auto' | '+x' | '-x' | '+z' | '-z';
const cameraStyle = (flag('camera') ?? 'orbit') as 'orbit' | 'boom';
const setMatch = /(\d{4,6})(?:-\d)?/.exec(basename(file));
const stem = modelExportStem({ name: flag('label') ?? basename(file).replace(/\.[^.]+$/, ''), setNumber: setMatch?.[0] });
const label = flag('label') ?? basename(file).replace(/\.[^.]+$/, '');
const out = positional[1] ?? `output/bedrock-entity-qa/${stem}.mcaddon`;
mkdirSync(out.replace(/[\\/][^\\/]*$/, ''), { recursive: true });

// ── Load the model text (same paths as the LEGO tab) ─────────────────────────
let text: string;
let colorSpace: 'bl' | 'ldraw' = 'ldraw';
let customParts = new Map<string, string>();
if (/\.io$/i.test(file)) {
  const b = readFileSync(file);
  const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  text = io.text;
  colorSpace = io.colorSpace === 'bl' ? 'bl' : 'ldraw';
  customParts = io.customParts;
} else {
  text = readFileSync(file, 'utf8');
}
const doc = parseLDrawDocument(synthesizeLSynth(text).text);
// Embedded part definitions beat the library, exactly as the viewer seeds the Worker.
const seeded = seedDatTexts([...embeddedPartTexts(doc), ...customParts]);
const bricks = doc.bricks;

const plan = planResolution(spanOfBricks(bricks), (flag('resolution') as 'auto' | 'minifig' | undefined) ?? 'minifig');
const t0 = Date.now();
const result = await runSchemPipeline({
  source: { kind: 'bricks', bricks, colorSpace, options: { cellLDU: plan.cellLDU, maxDim: 700 } },
  format: 'mcaddon',
  packStem: stem,
  packLabel: label,
  profile: DEFAULT_SCHEM_SETTINGS.profile,
  lightFill: false,
  shapes: false,
  vehicleMode,
  vehicleFacing,
  entityQuality: quality,
  cameraStyle,
  mainVehicleOnly: process.argv.includes('--main-only'),
  buildingFidelity: (flag('buildings') ?? 'bricks') as 'bricks' | 'blocks',
}, (phase, pct) => { if (process.env.VERBOSE) console.error(`  ${phase}${pct !== undefined ? ` ${pct}%` : ''}`); });
const ms = Date.now() - t0;

writeFileSync(out, result.bytes!);

// ── Pull the diagnostics back out of the archive (proves they shipped) ───────
const { extractFile, listZipEntries } = await import('../web/src/engine/zip-utils.ts');
const bytes = result.bytes!;
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const entries = listZipEntries(buffer);
const diagName = entries.find(e => e.endsWith('/craftmatic-diagnostics.json'));
const diagnostics = diagName ? JSON.parse(new TextDecoder().decode(await extractFile(buffer, diagName))) : null;

console.log(JSON.stringify({
  file, stem, label, bricks: bricks.length, embeddedParts: seeded, colorSpace, quality, vehicleMode, vehicleFacing,
  components: result.mcpack?.components ?? [],
  warnings: result.mcpack?.warnings ?? [],
  entities: diagnostics?.entities ?? null,
  geoFiles: entries.filter(e => /\.geo\.json$/.test(e)),
  textureSets: entries.filter(e => /\.texture_set\.json$/.test(e)),
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  ms,
  out,
}, null, 1));
