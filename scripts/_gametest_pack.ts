/**
 * Build the GameTest variant of a built Craftmatic add-on (web/src/engine/gametest-pack.ts):
 *
 *   <out>/<stem>-gametest.mcaddon       the model's BP with new uuids, server-gametest, the placement
 *                                       hook, scripts/gametest.js and the arena; its RP unchanged
 *   <out>/<stem>-gametest-plan.json     the doorways and their offline predictions
 *
 * Usage: bun scripts/_gametest_pack.ts <pack.mcaddon> [--out=dir] [--debugger=host:port] [--figure-ticks=1200] [--only=vehicles|figures] [--gait-probe]
 *
 * Deploy it to a world that has Beta APIs + cheats on (never a normal play
 * world), e.g. `python -u scripts/_pixel_dev_deploy.py cmgametest
 * <out>/<stem>-gametest.mcaddon`. On world load the tests run by themselves; pull the newest
 * content log and grep `CMGT ` (docs/testing-guide.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadAddonPreviewModel, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { verdictOf, walkThroughDoorway, type DoorwayWalkTrace } from '../web/src/engine/interactive-walk.ts';
import { createZip, extractMatching } from '../web/src/engine/zip-utils.ts';
import {
  arenaExceeds, arenaWindows, gaitProbeController, gametestVariantFiles, patchPlacementForGametest, variantManifest, windowOf, withGaitProbe, withGametestImport,
  type GametestDoorway, type GametestPart, type GametestPlan, type GametestSeat, type GametestTrain, type GametestVehicle, type WalkOutcome,
} from '../web/src/engine/gametest-pack.ts';
import { auditPackTaps } from '../test/_ix-tap-audit.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';
import { packVersionAt } from '../web/src/engine/pipeline-version.ts';
import { PROP_BALL_U, PROP_FLIP, PROP_PRESS, PROP_PULL } from '../web/src/engine/bedrock-pinball.ts';

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
    const route: DoorwayWalkTrace = { routes: [], tracks: [] };
    const open = walkThroughDoorway(pack, i, 100, 0, true, false, route);
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
    // The route the offline walk followed from this side (column centres between the two spots).
    const way = route.routes.find(r => r.from === dir.from)?.way ?? [];
    // Only a route that climbs or drops past the auto-step needs walking leg by leg (42670 Door 4:
    // down to the street and 1.25 up); a level route is walked straight, as every earlier round
    // did - legs at column centres pulled 10326 Door 4's walker off its stoop (Pixel 2026-09-25b).
    const pts = [start, ...way.slice(1, -1), end];
    const steps = pts.slice(1).some((p, k) => Math.abs(p.y - pts[k]!.y) > 0.6);
    // Or one whose straight line leaves the route's columns: 910047's gate stands on a narrow
    // threshold platform and its diagonal start-to-end line walked off the edge (Pixel 2026-09-25b).
    const cols = new Set(way.map(p => `${Math.floor(p.x)},${Math.floor(p.z)}`));
    let offRoute = false;
    for (let s = 0; s <= 1.0001 && !offRoute; s += 0.05) {
      const x = start.x + (end.x - start.x) * s, z = start.z + (end.z - start.z) * s;
      if (!cols.has(`${Math.floor(x)},${Math.floor(z)}`)) offRoute = true;
    }
    const via = steps || offRoute ? way.slice(1, -1).map(p => ({ x: p.x, y: p.y, z: p.z })) : [];
    doorways.push({
      label: it.label, typeId: it.type, actor: { x: actor.x, y: actor.y, z: actor.z },
      start, end, ...(via.length ? { via } : {}),
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
/** How far past touching (blocks) a test player stands from a closed leaf: the device lands it a little off its target. */
const LEAF_MARGIN_BLOCKS = 0.35;
const seats: GametestSeat[] = [];
const windows = arenaWindows({ width: placement.width, height: placement.height, length: placement.length });
if (cfg) {
  const taps = await auditPackTaps(buffer, { trace: true });
  cfg.items.forEach((it, i) => {
    if (it.passSize !== undefined && it.blocking.length && doorways.some(d => d.typeId === it.type)) return;
    const actor = placement.actors.find(a => a.interactive === i);
    const audit = taps.parts.find(p => p.label === actor?.label);
    // A spot from which the part both OPENS and CLOSES again (the audit's second tap, aimed at
    // the open part's boxes): from a spot that sees only the closed leaf, 71040's Door 1 swung
    // behind a wall and the line-of-sight filter refused the closing hit (Pixel 2026-09-25).
    // Only when no spot does both is an opening-only spot used (the test then reports the close).
    const opens = (audit?.spots ?? []).filter(sp => sp.ok);
    const both = opens.filter(sp => sp.closes);
    // Only a DOORWAY part (it has closed cells) uses the both-ways spot clear of its leaf. For a
    // window the device's line-of-sight filter refused the both-ways spot's hits ("behind a wall")
    // on 31141's and 42652's Window 2 and 80049's Window 3 (Pixel 2026-09-26, `refused` field),
    // where the nearest accepted spot of the earlier rounds had passed all three.
    // TODO: find why the device's line of sight differs from the host's there (eye height on a
    // part-block floor?) and use one rule for both.
    const doorwayPart = it.blocking.length > 0;
    const spots = doorwayPart && both.length ? both : opens;
    if (!actor || !spots.length) { console.log(`  ${it.label}: ${actor ? 'no standing spot the tap audit accepted' : 'no actor'}; not tested`); return; }
    if (!both.length) console.log(`  ${it.label}: no spot closes it again after opening; testing from an opening-only spot`);
    const d2 = (sp: { at: number[] }): number => (sp.at[0]! - actor.x) ** 2 + (sp.at[2]! - actor.z) ** 2 + (sp.at[1]! - actor.y) ** 2;
    // Not standing IN or AGAINST the closed leaf: a doorway will not close on a player whose body
    // overlaps its slab (the runtime's occupancy test, `obstructed`), and a simulated player lands
    // a few hundredths off its teleport target. 71040's Door 1 spot stood 1.2 blocks from the
    // actor but 0.46 from the hinge end, and the closing hit was refused (Pixel 2026-09-25).
    const lf = doorwayPart ? (it as { leaf?: { c: number[]; a: number[]; u: number[]; t: number } }).leaf : undefined;
    const clearOfLeaf = (sp: { at: number[] }): boolean => {
      // A window, lid or cupboard shuts past a player beside it (only a doorway checks occupancy):
      // its nearest accepted spot is the one that passed on the device before any clearance rule.
      if (!doorwayPart) return true;
      if (!lf) return Math.hypot(sp.at[0]! - actor.x, sp.at[2]! - actor.z) >= 1.2;
      const need = 0.3 + lf.t / 2 + LEAF_MARGIN_BLOCKS;
      for (let s = 0; s <= 1.0001; s += 0.05) for (let t = 0; t <= 1.0001; t += 0.05) {
        const p = [0, 1, 2].map(k => lf.c[k]! + lf.a[k]! * s + lf.u[k]! * t);
        if (p[1]! < sp.at[1]! - 0.2 || p[1]! > sp.at[1]! + 2) continue;
        if (Math.hypot(p[0]! - sp.at[0]!, p[2]! - sp.at[2]!) < need) return false;
      }
      return true;
    };
    const clear = spots.filter(clearOfLeaf);
    const pool = clear.length ? clear : spots;
    const best = pool.reduce((a, b) => (d2(b) < d2(a) ? b : a));
    parts.push({ label: it.label, typeId: it.type, kind: it.kind, actor: { x: actor.x, y: actor.y, z: actor.z }, from: { x: best.at[0]!, y: best.at[1]!, z: best.at[2]! }, openAngle: it.angle, window: windowOf(windows, actor.x) });
  });
}
placement.actors.forEach((a, k) => {
  if (!/_seat(_\d+)?$/.test(a.typeId.replace(/^[^:]*:/, ''))) return;
  // A figure the source sat here rides this seat (`rideOf` names the seat's actor index).
  const occupied = placement.actors.some(f => f.rideOf === k);
  seats.push({ label: a.label, typeId: a.typeId, at: { x: a.x, y: a.y, z: a.z }, window: windowOf(windows, a.x), ...(occupied ? { occupied } : {}) });
});
for (const d of doorways) d.window = windowOf(windows, d.actor.x);

// A pinball machine: its types from scripts/pinball.js's CONFIG, and the seated
// tag + parked hotbar slot read out of the same serialised runtime.
const pinballName = [...entries.keys()].find(n => n === `${bpFolder}/scripts/pinball.js`);
let pinball: GametestPlan['pinball'];
if (pinballName) {
  const js = text(pinballName);
  const cfg = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(js)?.[1] ?? 'null') as { consoleType: string; buttonType: string; flipperTypes: string[]; plungerButtonType?: string; plungerType?: string; ballType?: string; cabinetButtonTypes?: { left?: string; right?: string } } | null;
  const park = /\bPARK_SLOT = (\d+)/.exec(js)?.[1];
  const tag = /\bSEATED_TAG = ["']([^"']+)["']/.exec(js)?.[1];
  if (!cfg || park === undefined || !tag) throw new Error(`${pinballName}: CONFIG, PARK_SLOT or SEATED_TAG not found; the pinball runtime changed shape`);
  pinball = {
    consoleType: cfg.consoleType, buttonType: cfg.buttonType, flipperTypes: cfg.flipperTypes, flipProperty: PROP_FLIP, seatedTag: tag, parkSlot: Number(park),
    plungerButtonType: cfg.plungerButtonType, plungerType: cfg.plungerType, pullProperty: PROP_PULL, ballType: cfg.ballType, ballUProperty: PROP_BALL_U,
    cabinetButtonTypes: cfg.cabinetButtonTypes, pressProperty: PROP_PRESS,
  };
}

// Every rideable vehicle type the placement spawns (family `craftmatic_vehicle`),
// driven in the vehicle arena: its kind, seats and shipped size.
const vehicles: GametestVehicle[] = [];
for (const typeId of [...new Set(placement.actors.map(a => a.typeId))]) {
  const cid = typeId.replace(/^[^:]*:/, '');
  const beh = [...entries.keys()].find(n => n === `${bpFolder}/entities/${cid}.json`);
  if (!beh) continue;
  const ent = JSON.parse(text(beh).replace(/^﻿/, ''))['minecraft:entity'];
  const family: string[] = ent?.components?.['minecraft:type_family']?.family ?? [];
  if (!family.includes('craftmatic_vehicle')) continue;
  const kind = (['hover', 'boat', 'plane', 'car'] as const).find(k => family.includes(k)) ?? 'car';
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const [name] of entries) {
    if (!name.endsWith(`/models/entity/${cid}.geo.json`)) continue;
    for (const geo of JSON.parse(text(name).replace(/^﻿/, ''))['minecraft:geometry'] ?? []) for (const bone of geo.bones ?? []) for (const c of bone.cubes ?? []) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, c.origin[k]); max[k] = Math.max(max[k]!, c.origin[k] + c.size[k]); }
    }
  }
  const size = Number.isFinite(min[0]) ? { width: (max[0]! - min[0]!) / 16, height: (max[1]! - min[1]!) / 16, length: (max[2]! - min[2]!) / 16 } : { width: 2, height: 2, length: 4 };
  const label = placement.actors.find(a => a.typeId === typeId)?.label ?? cid;
  // A scripted vehicle (bedrock-vehicle.ts) declares the attitude properties its runtime writes.
  const scripted = 'craftmatic:fl_pitch' in (ent.description?.properties ?? {});
  vehicles.push({ label, typeId, kind, seats: ent.components['minecraft:rideable']?.seat_count ?? 1, size, ...(scripted ? { scripted } : {}) });
}

// Driven trains: every railway route (`physics.DRIVER`) in scripts/coaster.js's
// CONFIG, found after placement by its cars' types and route index.
const trains: GametestTrain[] = [];
const coasterName = [...entries.keys()].find(n => n === `${bpFolder}/scripts/coaster.js`);
if (coasterName) {
  const cc = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(text(coasterName))?.[1] ?? 'null') as {
    routes: Array<{ label: string; physics?: { DRIVER?: unknown }; path: { length: number; closed: boolean }; cars?: { slots?: Array<{ type: string }> } }>;
  } | null;
  if (!cc) throw new Error(`${coasterName}: no CONFIG line; the coaster runtime changed shape`);
  cc.routes.forEach((route, r) => {
    if (!route.physics?.DRIVER) return;
    const carTypes = [...new Set((route.cars?.slots ?? []).map(s => s.type))];
    const actor = placement.actors.find(a => carTypes.includes(a.typeId));
    if (!carTypes.length || !actor) { console.log(`  train ${route.label}: no car actor; not tested`); return; }
    trains.push({ label: route.label, route: r, carTypes, closed: route.path.closed, length: Math.round(route.path.length * 1000) / 1000, at: { x: actor.x, y: actor.y, z: actor.z }, window: windowOf(windows, actor.x) });
  });
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
  vehicles: vehicles.length ? vehicles : undefined,
  trains: trains.length ? trains : undefined,
  // `--only=vehicles`: a short run with nothing but the vehicle tests.
  vehiclesOnly: flag('only') === 'vehicles' || undefined,
  // `--only=figures`: the figures test alone (a long `--figure-ticks` watch).
  figuresOnly: flag('only') === 'figures' || undefined,
};
// `--gait-probe`: the walk-cycle probe on the first standing figure (units of
// query.modified_distance_moved per block at 50 %, 100 % and 200 % of the walker's speed).
const gaitFigure = process.argv.includes('--gait-probe') ? plan.figures!.find(f => !f.seated) : undefined;
if (process.argv.includes('--gait-probe') && !gaitFigure) throw new Error('--gait-probe: this pack has no standing figure');
if (gaitFigure) plan.gaitProbe = { typeId: gaitFigure.typeId, speeds: [0.03, 0.06, 0.12] };
// A Minifig Creator pack (`--creator=starter` builds): its figure type, for `creator_<id>`.
const wandName = [...entries.keys()].find(n => n === `${bpFolder}/scripts/minifig-wand.js`);
if (wandName) {
  const wandConfig = /^const C=(\{.*\});$/m.exec(text(wandName));
  if (!wandConfig) throw new Error(`${wandName}: no creator CONFIG found (the wand script changed shape)`);
  plan.creatorFigure = (JSON.parse(wandConfig[1]!) as { figureType: string }).figureType;
}

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
  } else if (gaitFigure && name.startsWith(`${bpFolder}/entities/`) && name.endsWith('.json')
    && JSON.parse(text(name).replace(/^\uFEFF/, ''))['minecraft:entity']?.description?.identifier === gaitFigure.typeId) {
    variantFiles.push({ name, data: new TextEncoder().encode(JSON.stringify(withGaitProbe(JSON.parse(text(name).replace(/^\uFEFF/, ''))), null, 1)) });
  } else {
    variantFiles.push({ name, data: new Uint8Array(data) });
  }
}
for (const f of gametestVariantFiles(plan)) variantFiles.push({ name: `${bpFolder}/${f.name}`, data: f.data });
if (gaitFigure) variantFiles.push({ name: `${bpFolder}/animation_controllers/cm_gait_probe.json`, data: new TextEncoder().encode(JSON.stringify(gaitProbeController(), null, 1)) });
const variantPath = join(outDir, `${stem}-gametest.mcaddon`);
writeFileSync(variantPath, await createZip(variantFiles));

const planPath = join(outDir, `${stem}-gametest-plan.json`);
writeFileSync(planPath, JSON.stringify(plan, null, 1) + '\n');

console.log(`${placement.label}: ${doorways.length} doorways, ${parts.length} parts, ${seats.length} seats, ${plan.figures!.length} figures, ${vehicles.length} vehicles${plan.vehiclesOnly ? ' (vehicle tests only)' : ''}${plan.figuresOnly ? ' (figures test only)' : ''}${windows.length > 1 ? ` in ${windows.length} arena windows` : ''}${pinball ? `, pinball ${JSON.stringify(pinball)}` : ''}`);
for (const t of trains) console.log(`  train ${t.label} route ${t.route} ${t.closed ? 'circuit' : 'open line'} ${t.length} blocks, car types ${t.carTypes.join(', ')}`);
for (const v of vehicles) console.log(`  vehicle ${v.kind.padEnd(5)}${v.scripted ? ' (scripted)' : ''} ${v.typeId} seats ${v.seats} size ${v.size.width.toFixed(1)}x${v.size.height.toFixed(1)}x${v.size.length.toFixed(1)}`);
for (const d of doorways) console.log(`  ${d.label.padEnd(8)} ${d.offlineVerdict.padEnd(8)} closed:${d.expectClosed.padEnd(8)} open:${d.expectOpen.padEnd(8)} start ${JSON.stringify(d.start)} end ${JSON.stringify(d.end)}`);
console.log(`variant ${variantPath}\nplan    ${planPath}`);
