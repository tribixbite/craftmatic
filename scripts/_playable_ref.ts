/**
 * Bedrock entity gate: export a model to a playable `.mcaddon` through the REAL
 * shared pipeline (engine/schem-pipeline.ts, the code the LEGO tab's Worker
 * runs) against the local LDraw library, then print the entity diagnostics
 * and the archive's sha256.
 *
 * Usage: bun scripts/_playable_ref.ts <model.io|.mpd|.ldr> [out.mcaddon]
 *          [--quality=balanced|high|ultra] [--mode=auto|car|plane|boat]
 *          [--track-grain=N]  (coaster/train track kept at N LDU over the shell budget, FID-02; default 2 like the LEGO tab, 0 = the budget decides)
 *          [--facing=auto|+x|-x|+z|-z] [--label=<text>] [--no-pbr] [--profile=<PackProfile.json>] [--camera=orbit|boom] [--main-only]
 *          [--buildings=bricks|blocks]   (bricks: the building as a brick-accurate shell entity over colliders)
 *          [--scale=auto|0.25|0.5|0.75|1|1.5|2|3|4]   (model scale as a multiplier of the minifig scale, engine/addon-scale.ts)
 *          [--lod=none|hull] [--lod-distance=N]   (default hull: a resident per-colour surface hull the client draws past N; engine/bedrock-lod-hull.ts)
 *          [--faces=<dir>]   (face art for heads no LDraw library prints: <part>.png per head, scripts/gen-face-art.py)
 *          [--mirror=<url>]   (part mirror for names the local library lacks; default prod)
 *          [--detail=<detail.json>]   (a landmark's PlacementDetail from scripts/_landmark_levels.ts: the wand shows its level and suggested size)
 *          [--hints=<file.byom.json>]   (creator hints, engine/byom/hints.ts: vehicles, doors, seats by selector; default: <model stem>.byom.json beside the model when it exists. Runs in explicit mode: no title or set number decides anything)
 *          [--figure-collision-height=N]   (experimental override for a figure NPC's minecraft:collision_box.height, default computed/clamped 1.0-1.8; device-919 roaming experiment)
 *
 * Output defaults to output/bedrock-entity-qa/<stem>.mcaddon (gitignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { seedFaceArt } from '../web/src/engine/head-face.ts';
import type { PackProfile } from '../web/src/engine/pack-profile.ts';
import pako from 'pako';
import { createHash } from 'node:crypto';
import { setLDrawMirror, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { loadModelBricks, readFaceArtDir } from './model-source.ts';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.ts';
import { planResolution, planResolutionAtCell, spanOfBricks, DEFAULT_SCHEM_SETTINGS } from '../web/src/engine/schem-settings.ts';
import { planAddonScale, type AddonScaleChoice } from '../web/src/engine/addon-scale.ts';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.ts';
import { modelExportStem } from '../web/src/engine/export-name.ts';
import { SMOOTH_TRACK_GRAIN_LDU } from '../web/src/engine/coaster-track.ts';
import { sourceHash12, type SourceProvenance } from '../web/src/engine/pipeline-version.ts';
import { computePipelineStamp } from './pipeline-stamp.ts';
import type { PlacementDetail } from '../web/src/brickgen/levels/levels.ts';
import { byomHintsPathFor, parseByomHints, type ByomHints } from '../web/src/engine/byom/hints.ts';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
setLDrawRoot(LDRAW_ROOT);
// `--mirror=<url>`: the part mirror the CLI asks for a name the local library lacks (default prod,
// https://craftmatic.click/ldraw-parts). Measured 2026-09-25: prod answered 429 under several parallel
// exports and the packs silently lost parts to aliases; a running `bun dev:web` serves the same tree at
// http://localhost:4000/ldraw-parts.
const mirrorFlag = process.argv.find(a => a.startsWith('--mirror='))?.slice('--mirror='.length);
if (mirrorFlag) setLDrawMirror(mirrorFlag);
// The local copy of the prod part mirror, when present: a build during a prod
// rate limit would otherwise draw post-2020 parts as older moulds or boxes.
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync('C:/git/clego/ldraw_ref')) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';
// The mirror's answers cached on disk, so a rebuild does not re-ask the network (ldraw-geometry.ts).
process.env.CRAFTMATIC_LDRAW_MIRROR_CACHE ??= 'output/ldraw-mirror-cache';

// `--faces=<dir>`: face ART (route 2, `scripts/gen-face-art.py`) for heads no
// LDraw library prints, one `<part>.png` per head name (`3626cpb3484.png`).
// The compiler draws it on the head as a texture (engine/head-face.ts).
const facesDir = process.argv.find(a => a.startsWith('--faces='))?.slice('--faces='.length);
// `--profile=<json>`: a `PackProfile` (web/src/engine/pack-profile.ts) as JSON; the deflate is injected here (pako, the same
// bytes on every machine), because JSON cannot carry a function. A release profile refuses `--faces` (no face art).
const profileFile = process.argv.find(a => a.startsWith('--profile='))?.slice('--profile='.length);
const packProfile: PackProfile | undefined = profileFile
  ? { ...(JSON.parse(readFileSync(profileFile, 'utf8')) as PackProfile), deflate: (d: Uint8Array) => pako.deflateRaw(d, { level: 9 }) }
  : undefined;
if (facesDir && packProfile?.flags?.faceArt === false) { console.error('--faces conflicts with a profile that sets flags.faceArt=false'); process.exit(2); }
if (facesDir) {
  console.error(`[faces] seeded ${seedFaceArt(readFaceArtDir(facesDir))} face art from ${facesDir}`);
}

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = positional[0];
if (!file) { console.error('usage: bun scripts/_playable_ref.ts <model> [out.mcaddon] [--quality=…] [--mode=…] [--facing=…] [--label=…] [--no-pbr]'); process.exit(2); }
const quality = (flag('quality') ?? 'balanced') as 'balanced' | 'high' | 'ultra';
const vehicleMode = (flag('mode') ?? 'auto') as 'auto' | 'car' | 'plane' | 'boat' | 'static';
const vehicleFacing = (flag('facing') ?? 'auto') as 'auto' | '+x' | '-x' | '+z' | '-z';
const cameraStyle = (flag('camera') ?? 'orbit') as 'orbit' | 'boom';
const setMatch = /(\d{4,6})(?:-\d)?/.exec(basename(file));
// `setNum` — NOT `setNumber`: the misspelt key was silently dropped (scripts/ is
// outside both tsconfigs, so no excess-property check caught it) and every
// Hogwarts set exported as the bare stem `Hogwarts`, pack id `hogwarts`.
const stem = modelExportStem({ name: flag('label') ?? basename(file).replace(/\.[^.]+$/, ''), setNum: setMatch?.[0] });
// Creator hints (B03): `--hints=` or `<stem>.byom.json` beside the model. Parsed now so a bad file stops before a long export.
const detailFile = flag('detail');
const detail = detailFile ? JSON.parse(readFileSync(detailFile, 'utf8')) as PlacementDetail : undefined;
const hintsFile = flag('hints') ?? (existsSync(byomHintsPathFor(file)) ? byomHintsPathFor(file) : undefined);
let byomHints: ByomHints | undefined;
if (hintsFile) {
  const parsedHints = parseByomHints(JSON.parse(readFileSync(hintsFile, 'utf8')));
  if (!parsedHints.ok) { console.error(`${hintsFile}: the creator hints were refused:\n${parsedHints.errors.map(e => `  - ${e}`).join('\n')}`); process.exit(2); }
  byomHints = parsedHints.hints;
}
const label = byomHints?.title ?? flag('label') ?? basename(file).replace(/\.[^.]+$/, '');
/** Hints run in explicit mode (X-17): no title or set number decides beside the creator's word. */
const runProfile: PackProfile | undefined = byomHints ? { ...packProfile, flags: { ...packProfile?.flags, explicitOnly: true } } : packProfile;
const out = positional[1] ?? `output/bedrock-entity-qa/${stem}.mcaddon`;
mkdirSync(out.replace(/[\\/][^\\/]*$/, ''), { recursive: true });

// ── Load the model (same paths as the LEGO tab) ──────────────────────────────
// Pack provenance (engine/pipeline-version.ts): the source file's sha256/12 —
// the model index's convention, over the bytes on disk — and the pipeline
// stamp computed from THIS working tree (the browser gets it injected by Vite).
const sourceBytes = readFileSync(file);
const sourceProvenance: SourceProvenance = { file: basename(file), hash: sourceHash12(sourceBytes), origin: 'cli', path: file, ...(setMatch ? { setNum: setMatch[0] } : {}) };
const { closure: _closure, ...pipelineStamp } = computePipelineStamp();
const { bricks, colorSpace, seeded } = await loadModelBricks(file, sourceBytes);

// One plan drives the block cell AND the entity scale (ui/schem-export.ts does the same).
const scalePlan = planAddonScale(bricks, (flag('scale') as AddonScaleChoice | undefined) ?? byomHints?.scale ?? 'auto', label, { packProfile: runProfile });
const resolutionFlag = flag('resolution') as 'auto' | 'minifig' | undefined;
const plan = resolutionFlag && resolutionFlag !== 'auto' && resolutionFlag !== 'minifig'
  ? planResolution(spanOfBricks(bricks), resolutionFlag)
  : planResolutionAtCell(spanOfBricks(bricks), scalePlan.lduPerBlock);
const modelScale = Math.round(LDU_PER_BLOCK / plan.cellLDU * 1000) / 1000;
console.error(`  scale: ${scalePlan.reason} (cell ${Math.round(plan.cellLDU * 100) / 100} LDU, ${modelScale}x)`);
/** Track grain: the LEGO tab's default (smooth track ON since 2026-10-28) unless `--track-grain=0` asks the budget. */
const trackGrainLdu = flag('track-grain') !== undefined ? Number(flag('track-grain')) : DEFAULT_SCHEM_SETTINGS.addonSmoothTrack ? SMOOTH_TRACK_GRAIN_LDU : 0;
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
  modelScale,
  lod: (flag('lod') ?? 'hull') as 'none' | 'hull',
  ...(flag('lod-distance') ? { lodDistance: Number(flag('lod-distance')) } : {}),
  ...(trackGrainLdu > 0 ? { trackGrainLdu } : {}),
  ...(flag('figure-collision-height') ? { figureCollisionHeight: Number(flag('figure-collision-height')) } : {}),
  pipelineStamp,
  sourceProvenance,
  ...(runProfile ? { packProfile: runProfile } : {}),
  ...(byomHints ? { byomHints } : {}),
  ...(detail ? { detail } : {}),
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
// The pack NAMES as Minecraft shows them and the provenance record, read back
// from the archive rather than echoed from the inputs.
const readJson = async (suffix: string): Promise<any> => { const name = entries.find(e => e.endsWith(suffix)); return name ? JSON.parse(new TextDecoder().decode(await extractFile(buffer, name))) : null; };
const bpManifest = await readJson('_BP/manifest.json'), rpManifest = await readJson('_RP/manifest.json');
const provenance = await readJson('/craftmatic-provenance.json');

console.log(JSON.stringify({
  file, stem, label, bricks: bricks.length, embeddedParts: seeded, colorSpace, quality, vehicleMode, vehicleFacing,
  scale: { choice: scalePlan.choice, scale: modelScale, cue: scalePlan.cue, cellLDU: plan.cellLDU, reason: scalePlan.reason },
  packNames: { bp: bpManifest?.header?.name ?? null, rp: rpManifest?.header?.name ?? null, version: bpManifest?.header?.version ?? null },
  provenance,
  components: result.mcpack?.components ?? [],
  warnings: result.mcpack?.warnings ?? [],
  entities: diagnostics?.entities ?? null,
  // The measured walk-through size, read back OUT of the pack's own
  // craftmatic-diagnostics.json - so this prints what shipped, not what the
  // pipeline returned in memory. It is a recommendation: `scale` above is what
  // the pack was actually exported at.
  access: diagnostics?.access ?? null,
  lod: diagnostics?.lod ?? null,
  coaster: diagnostics?.coaster ?? null,
  // Every place the source sits a figure and what the pack gives the player there (engine/seat-census.ts).
  seats: result.mcpack?.seatCensus ?? null,
  packBudget: diagnostics?.pack ?? null,
  geoFiles: entries.filter(e => /\.geo\.json$/.test(e)),
  textureSets: entries.filter(e => /\.texture_set\.json$/.test(e)),
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  ms,
  out,
}, null, 1));
