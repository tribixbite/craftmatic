/**
 * Build the GameTest variant of a built Craftmatic add-on (web/src/engine/gametest-pack.ts):
 *
 *   <out>/<stem>-gametest.mcaddon       the model's BP with new uuids, server-gametest, the placement
 *                                       hook, scripts/gametest.js and the arena; its RP unchanged
 *   <out>/<stem>-gametest-plan.json     the doorways and their offline predictions
 *
 * Usage: bun scripts/_gametest_pack.ts <pack.mcaddon> [--out=dir] [--debugger=host:port] [--figure-ticks=1200]
 *
 * Deploy it to a world that has Beta APIs + cheats on (never a normal play
 * world), e.g. `python -u scripts/_pixel_dev_deploy.py cmgametest
 * <out>/<stem>-gametest.mcaddon`. On world load the tests run by themselves; pull the newest
 * content log and grep `CMGT ` (docs/testing-guide.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadAddonPreviewModel, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { verdictOf, walkThroughDoorway } from '../web/src/engine/interactive-walk.ts';
import { createZip, extractMatching } from '../web/src/engine/zip-utils.ts';
import {
  arenaExceeds, arenaWindows, gametestVariantFiles, patchPlacementForGametest, variantManifest, windowOf, withGametestImport,
  type GametestDoorway, type GametestPart, type GametestPlan, type GametestSeat, type WalkOutcome,
} from '../web/src/engine/gametest-pack.ts';
import { auditPackTaps } from '../test/_ix-tap-audit.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';
import { packVersionAt } from '../web/src/engine/pipeline-version.ts';
import { PROP_BALL_U, PROP_FLIP, PROP_PULL } from '../web/src/engine/bedrock-pinball.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_gametest_pack.ts <pack.mcaddon> [--out=dir] [--debugger=host:port]'); process.exit(2); }
const outDir = resolve(flag('out') ?? 'output/gametest');
mkdirSync(outDir, { recursive: true });
const stem = basename(file).replace(/\.mcaddon$/i, '');

const bytes = readFileSync(file);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const entries = await extractMatching(buffer, () => true);
const text = (name: string): string => new TextDecoder().decode(entries.get(name)!);

const placementName = [...entries.keys()].find(n => /\/scripts\/placement\.js$/.test(n));
if (!placementName) throw new Error(`${file}: no scripts/placement.js (not a playable add-on)`);
const bpFolder = placementName.split('/')[0]!;
const placementJs = text(placementName);
const configMatch = /^const CONFIG = (\{.*\});$/m.exec(placementJs);
if (!configMatch) throw new Error('placement.js: no `const CONFIG = {...};` line');
const placement = JSON.parse(configMatch[1]!) as {
  id: string; label: string; width: number; height: number; length: number;
  actors: Array<{ typeId: string; label: string; x: number; y: number; z: number; interactive?: number; rideOf?: number }>;
  colliders?: { block: string; loState: string; hiState: string };
};

// Offline predictions: the same walk `_ix_passability.ts` runs, at 100 %, turn 0.
const model = await loadAddonPreviewModel(buffer);
const cfg = model.interactives;
const doorways: GametestDoorway[] = [];
if (cfg) {
  const pack = { cells: model.cells, dims: model.dims, interactives: cfg, shippedTreads: (s: number, r: QuarterTurn) => treadBlocksAt(model, s, r) };
  cfg.items.forEach((it, i) => {
    if (it.passSize === undefined || !it.blocking.length) return;
    const open = walkThroughDoorway(pack, i, 100, 0, true);
    const closed = walkThroughDoorway(pack, i, 100, 0, false);
    const actor = placement.actors.find(a => a.interactive === i);
    // Walk the first direction that has a start; an END exists only for a walk that got
    // somewhere, so a sealed side mirrors its start across the leaf.
    const dir = open.directions.find(d => d.start) ?? closed.directions.find(d => d.start);
    if (!actor || !dir?.start) { console.log(`  ${it.label}: no actor or approach; skipped`); return; }
    const start = dir.start;
    // No end means the walk never got through: mirror the start across the doorway centre.
    const end = dir.end ?? { x: 2 * open.centre.x - start.x, y: start.y, z: 2 * open.centre.z - start.z };
    const openDir = open.directions.find(d => d.from === dir.from);
    const closedDir = closed.directions.find(d => d.from === dir.from);
    doorways.push({
      label: it.label, typeId: it.type, actor: { x: actor.x, y: actor.y, z: actor.z },
      start, end,
      // SEALED: the walk never reaches the leaf, and its per-direction rows read a zero-tick
      // "passed" on the reachable side; the prediction is "not walkable" both ways.
      expectClosed: (open.outcome === 'sealed' ? 'sealed' : closedDir?.outcome ?? closed.outcome) as WalkOutcome,
      // A sealed doorway is sealed as a whole; per-direction outcomes only say blocked.
      expectOpen: (open.outcome === 'sealed' ? 'sealed' : openDir?.outcome ?? open.outcome) as WalkOutcome,
      offlineVerdict: verdictOf(open, closed),
    });
  });
}

// Every other moving part is toggled by a hit from a spot the offline tap audit
// accepted (the runtime's line of sight lets the tap through there), and every
// seat is mounted. A part no spot reaches is reported, not tested.
const parts: GametestPart[] = [];
const seats: GametestSeat[] = [];
const windows = arenaWindows({ width: placement.width, height: placement.height, length: placement.length });
if (cfg) {
  const taps = await auditPackTaps(buffer, { trace: true });
  cfg.items.forEach((it, i) => {
    if (it.passSize !== undefined && it.blocking.length && doorways.some(d => d.typeId === it.type)) return;
    const actor = placement.actors.find(a => a.interactive === i);
    const audit = taps.parts.find(p => p.label === actor?.label);
    const spots = (audit?.spots ?? []).filter(sp => sp.ok);
    if (!actor || !spots.length) { console.log(`  ${it.label}: ${actor ? 'no standing spot the tap audit accepted' : 'no actor'}; not tested`); return; }
    const d2 = (sp: { at: number[] }): number => (sp.at[0]! - actor.x) ** 2 + (sp.at[2]! - actor.z) ** 2 + (sp.at[1]! - actor.y) ** 2;
    const best = spots.reduce((a, b) => (d2(b) < d2(a) ? b : a));
    parts.push({ label: it.label, typeId: it.type, kind: it.kind, actor: { x: actor.x, y: actor.y, z: actor.z }, from: { x: best.at[0]!, y: best.at[1]!, z: best.at[2]! }, openAngle: it.angle, window: windowOf(windows, actor.x) });
  });
}
for (const a of placement.actors) {
  if (!/_seat(_\d+)?$/.test(a.typeId.replace(/^[^:]*:/, ''))) continue;
  seats.push({ label: a.label, typeId: a.typeId, at: { x: a.x, y: a.y, z: a.z }, window: windowOf(windows, a.x) });
}
for (const d of doorways) d.window = windowOf(windows, d.actor.x);

// A pinball machine: its types from scripts/pinball.js's CONFIG, and the seated
// tag + parked hotbar slot read out of the same serialised runtime.
const pinballName = [...entries.keys()].find(n => n === `${bpFolder}/scripts/pinball.js`);
let pinball: GametestPlan['pinball'];
if (pinballName) {
  const js = text(pinballName);
  const cfg = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(js)?.[1] ?? 'null') as { consoleType: string; buttonType: string; flipperTypes: string[]; plungerButtonType?: string; plungerType?: string; ballType?: string } | null;
  const park = /\bPARK_SLOT = (\d+)/.exec(js)?.[1];
  const tag = /\bSEATED_TAG = ["']([^"']+)["']/.exec(js)?.[1];
  if (!cfg || park === undefined || !tag) throw new Error(`${pinballName}: CONFIG, PARK_SLOT or SEATED_TAG not found; the pinball runtime changed shape`);
  pinball = {
    consoleType: cfg.consoleType, buttonType: cfg.buttonType, flipperTypes: cfg.flipperTypes, flipProperty: PROP_FLIP, seatedTag: tag, parkSlot: Number(park),
    plungerButtonType: cfg.plungerButtonType, plungerType: cfg.plungerType, pullProperty: PROP_PULL, ballType: cfg.ballType, ballUProperty: PROP_BALL_U,
  };
}

const plan: GametestPlan = {
  modelId: placement.id,
  label: placement.label,
  dims: { width: placement.width, height: placement.height, length: placement.length },
  actorTypes: placement.actors.map(a => a.typeId),
  angleProperty: cfg?.property ?? 'craftmatic:angle',
  doorways,
  debuggerTarget: flag('debugger'),
  pinball,
  parts,
  seats,
  ...(windows.length > 1 ? { windows } : {}),
  // Every minifig NPC the placement spawns (`_fig<n>` types; a seated one rides a seat).
  figures: placement.actors.filter(a => /_fig\d+$/.test(a.typeId)).map(a => ({ label: a.label, typeId: a.typeId, actor: { x: a.x, y: a.y, z: a.z }, seated: a.rideOf !== undefined })),
  colliders: placement.colliders ? { block: placement.colliders.block, loState: placement.colliders.loState, hiState: placement.colliders.hiState } : undefined,
  figureTicks: flag('figure-ticks') ? Number(flag('figure-ticks')) : undefined,
  // Wider than one structure: only the figures test runs, laying the floor past the structure itself.
  oversized: arenaExceeds({ width: placement.width, height: placement.height, length: placement.length }) || undefined,
};

// Both test packs carry the BUILD time as their version, so every rebuild re-imports.
const testVersion = packVersionAt();

// The model pack with the hook, the module and the tests IN it (see the module docs for why).
const mainName = `${bpFolder}/scripts/main.js`;
const variantFiles: Array<{ name: string; data: Uint8Array }> = [];
for (const [name, data] of entries) {
  if (name.endsWith('/')) continue;
  if (name === `${bpFolder}/manifest.json`) {
    const manifest = JSON.parse(text(name).replace(/^\uFEFF/, ''));
    const entry = manifest.modules.find((m: { type: string; entry?: string }) => m.type === 'script')?.entry;
    if (entry !== 'scripts/main.js') throw new Error(`${bpFolder}: script entry is ${entry}, expected scripts/main.js`);
    variantFiles.push({ name, data: new TextEncoder().encode(JSON.stringify(variantManifest(manifest, testVersion), null, 2) + '\n') });
  } else if (name === placementName) {
    variantFiles.push({ name, data: new TextEncoder().encode(patchPlacementForGametest(placementJs)) });
  } else if (name === mainName) {
    variantFiles.push({ name, data: new TextEncoder().encode(withGametestImport(text(name))) });
  } else {
    variantFiles.push({ name, data: new Uint8Array(data) });
  }
}
for (const f of gametestVariantFiles(plan)) variantFiles.push({ name: `${bpFolder}/${f.name}`, data: f.data });
const variantPath = join(outDir, `${stem}-gametest.mcaddon`);
writeFileSync(variantPath, await createZip(variantFiles));

const planPath = join(outDir, `${stem}-gametest-plan.json`);
writeFileSync(planPath, JSON.stringify(plan, null, 1) + '\n');

console.log(`${placement.label}: ${doorways.length} doorways, ${parts.length} parts, ${seats.length} seats, ${plan.figures!.length} figures${windows.length > 1 ? ` in ${windows.length} arena windows` : ''}${pinball ? `, pinball ${JSON.stringify(pinball)}` : ''}`);
for (const d of doorways) console.log(`  ${d.label.padEnd(8)} ${d.offlineVerdict.padEnd(8)} closed:${d.expectClosed.padEnd(8)} open:${d.expectOpen.padEnd(8)} start ${JSON.stringify(d.start)} end ${JSON.stringify(d.end)}`);
console.log(`variant ${variantPath}\nplan    ${planPath}`);
