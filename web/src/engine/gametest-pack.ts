/**
 * In-game automated tests for a built Craftmatic add-on, on Minecraft Bedrock's
 * GameTest framework (`@minecraft/server-gametest`, "Beta APIs" experiment).
 *
 * WHY: device QA was adb taps + screenshots, which cannot see a 0.3 s flipper
 * pulse and cannot tell "the door did not open" from "the tap missed". A
 * GameTest runs INSIDE the game on the phone, drives a simulated player through
 * the same server-side paths a real one uses (placement, `playerInteractWith
 * Entity`, collision), asserts on world state, and writes its verdicts to the
 * content log, which adb can pull. See docs/testing-guide.md, "In-game
 * automated tests (GameTest)".
 *
 * Output is ONE test variant of the model's add-on, bound to a dedicated
 * world that has Beta APIs on: the model's behaviour pack with new uuids and a
 * build-time version, `@minecraft/server-gametest` 1.0.0-beta declared (the
 * only version 1.26.5x ships; Mojang's creator-tools pack pairs it with a
 * stable server the same way), a `craftmatic_gt:place` scriptevent hook
 * injected into `scripts/placement.js` (a test drives the pack's OWN
 * `place()`; a simulated player cannot answer the Brick Wand's forms), and
 * the tests themselves in `scripts/gametest.js` with their arena
 * `.mcstructure`. The resource pack ships unchanged.
 *
 * The tests MUST live in the model's own pack. Measured on the Pixel
 * (1.26.51, runs 2-3): a simulated player is `undefined` in
 * `world.getAllPlayers()` of every OTHER pack - even one that declares
 * server-gametest - and that pack's `playerInteractWithEntity` /
 * `entityHitEntity` handlers never toggled a door the simulated player
 * interacted with. A player handle belongs to the script context that
 * spawned it.
 *
 * TODO: move the hook into the placement runtime itself (playable-addon.ts)
 * so the shipped pack and the tested pack differ only in the added files.
 *
 * Expectations come from the offline passability walk
 * (`engine/interactive-walk.ts`): a doorway it calls OK must be blocked closed
 * and walkable open on the device; SEALED must not be walkable either way. So
 * every device result is also a check of the offline harness.
 */

import { BlockGrid } from '@craft/schem/types.js';
import { encodeMcstructureTile } from './mcstructure-encode.js';
import { deterministicUuid } from './mcpack.js';

/** Namespace of every GameTest id, scriptevent and structure this module emits. */
export const GT_NAMESPACE = 'craftmatic_gt';
/** The tag `/gametest runset` is given. */
export const GT_TAG = 'craftmatic_gt';
/** Scriptevent the injected placement hook listens to. */
export const GT_PLACE_EVENT = `${GT_NAMESPACE}:place`;
/** Scriptevent the hook answers with once `place()` settles. */
export const GT_PLACED_EVENT = `${GT_NAMESPACE}:placed`;
/** Blocks of arena floor around the model's footprint. */
export const GT_MARGIN = 3;
/** The only `@minecraft/server-gametest` module version Minecraft 1.26.5x ships. */
export const GT_GAMETEST_VERSION = '1.0.0-beta';
/** Largest arena one `.mcstructure` may carry (a structure block's save limit). */
export const GT_MAX_ARENA = { x: 64, y: 384, z: 64 } as const;

export interface Vec3 { x: number; y: number; z: number }

/** Walk outcome the offline harness predicts, per direction. */
export type WalkOutcome = 'passed' | 'blocked' | 'sealed' | 'partial' | 'fell' | 'no-approach';

/** One doorway the device should walk, in model-local block coordinates (turn 0, 100 %). */
export interface GametestDoorway {
  label: string;
  /** Entity type of the leaf (`craftmatic:<id>_door_<n>`). */
  typeId: string;
  /** Leaf actor position in model-local coordinates (to pick the right entity). */
  actor: Vec3;
  /** Feet position on the approach side and the far side, from the offline walk. */
  start: Vec3;
  end: Vec3;
  /** Offline predictions (`interactive-walk.ts`) for the same start/end. */
  expectClosed: WalkOutcome;
  expectOpen: WalkOutcome;
  /** Offline verdict (OK, SEALED, …) — reported beside the device verdict. */
  offlineVerdict: string;
  /** The arena window it is tested in (`arenaWindows`), 0 for a model that fits one arena. */
  window?: number;
}

/**
 * A moving part the device toggles by a hit (`attackEntity`, the route that
 * reaches `entityHitEntity`): a window, cupboard, hatch, lever or turnable,
 * or a door with no doorway walk. `from` is a standing spot the offline tap
 * audit (`test/_ix-tap-audit.ts`) accepted, so the runtime's line-of-sight
 * test lets the tap through there.
 */
export interface GametestPart {
  label: string;
  typeId: string;
  kind: string;
  /** Actor position, model-local (turn 0, 100 %). */
  actor: Vec3;
  /** Feet position to tap from, model-local. */
  from: Vec3;
  /** The item's open angle (signed), or a turnable's step: what one tap sets or adds. */
  openAngle: number;
  window?: number;
}

/** A seat the device mounts with `interactWithEntity` (the engine's rideable, no script). */
export interface GametestSeat {
  label: string;
  typeId: string;
  /** Seat actor position, model-local. */
  at: Vec3;
  window?: number;
}

export interface GametestPlan {
  /** Placement CONFIG id (`downtown_41732`), used for names. */
  modelId: string;
  label: string;
  dims: { width: number; height: number; length: number };
  /** Entity types the placement spawns (to wait for the placement to land). */
  actorTypes: string[];
  /** Actor property holding a moving part's angle (`craftmatic:angle`). */
  angleProperty: string;
  doorways: GametestDoorway[];
  /** Optional `host:port` for a `/script debugger connect` probe after the run. */
  debuggerTarget?: string | undefined;
  /** A pinball machine's runtime types (`scripts/pinball.js` CONFIG), when the pack has one. */
  pinball?: GametestPinball | undefined;
  /** Moving parts to toggle by a hit, and seats to mount. */
  parts?: GametestPart[] | undefined;
  seats?: GametestSeat[] | undefined;
  /** Model-local x ranges tested one arena at a time (`arenaWindows`); absent: the whole model fits one. */
  windows?: Array<{ x0: number; x1: number }> | undefined;
  /** The set's minifig NPCs, for the roaming test (`figures_<id>`); absent or empty: no test. */
  figures?: GametestFigure[] | undefined;
  /** The pack's collider block, so the roaming test can tell a wall from a floor plate. */
  colliders?: { block: string; loState: string; hiState: string } | undefined;
  /** How long the roaming test watches the figures, in ticks (default `GT_FIGURE_TICKS`). */
  figureTicks?: number | undefined;
  /**
   * The model's arena is wider than one structure (`arenaExceeds`): the
   * structure is capped at `GT_MAX_ARENA` and the roaming test lays the rest
   * of the floor itself, and cleans it up. Only that test is registered then
   * (a smoke or doors arena beside it could sit on the overflow).
   */
  oversized?: boolean | undefined;
}

/**
 * The model-local x ranges the tests run in: one arena holds at most
 * `GT_MAX_ARENA.x - 2 * GT_MARGIN` blocks of model, so a wider model (76457,
 * 77092) is tested in windows, each placing the model shifted so that window
 * lies over the arena floor (the rest stands on the world beside it).
 */
export function arenaWindows(dims: GametestPlan['dims']): Array<{ x0: number; x1: number }> {
  const span = GT_MAX_ARENA.x - 2 * GT_MARGIN;
  if (dims.width <= span) return [{ x0: 0, x1: dims.width }];
  const out: Array<{ x0: number; x1: number }> = [];
  for (let x0 = 0; x0 < dims.width; x0 += span - 8) {
    out.push({ x0, x1: Math.min(dims.width, x0 + span) });
    if (x0 + span >= dims.width) break;
  }
  return out;
}

/** The window a model-local x is tested in: the first whose middle part holds it (4 blocks of slack each side). */
export function windowOf(windows: ReadonlyArray<{ x0: number; x1: number }>, x: number): number {
  const i = windows.findIndex((w, k) => x >= w.x0 + (k ? 4 : 0) && x < w.x1 - (k < windows.length - 1 ? 4 : 0));
  return i >= 0 ? i : windows.length - 1;
}

/** One minifig NPC the roaming test follows. */
export interface GametestFigure {
  label: string;
  /** Entity type (`craftmatic:<id>_fig<n>` or `craftmatic:f_<id>_fig<n>`); one type per figure. */
  typeId: string;
  /** Spawn point in model-local blocks (turn 0, 100 %). */
  actor: Vec3;
  /** The source seated it on a chair (`rideOf`): it should stay seated, not roam. */
  seated: boolean;
}

/** Default length of the roaming test's watch: 60 s. */
export const GT_FIGURE_TICKS = 1200;
/** Ticks between two position samples of every figure. */
export const GT_FIGURE_SAMPLE_TICKS = 20;
/** How far outside the model's footprint a figure may stand before it counts as "left the model". */
export const GT_FIGURE_AREA_MARGIN = 1;

/** One position sample of a figure, world blocks, and whether it was riding a seat then. */
export interface FigureSample extends Vec3 { riding?: boolean; clipping?: boolean }

/** What one figure did over the watch (`judgeFigureTrack`). */
export interface FigureTrackVerdict {
  samples: number;
  /** Horizontal distance walked, summed over samples (blocks). */
  pathLength: number;
  /** Largest horizontal distance from the first sample (blocks). */
  maxExcursion: number;
  /** Samples standing outside the footprint plus `GT_FIGURE_AREA_MARGIN`. */
  outsideSamples: number;
  /** Lowest feet height relative to the model's ground (the pin plane). */
  minAboveGround: number;
  /** Fell below the model's ground (more than half a block under the pin plane). */
  belowGround: boolean;
  /** Ended more than 1.5 blocks under where it started (fell off a floor). */
  droppedStorey: boolean;
  /** Samples whose body overlapped a collider taller than a step (furniture or a wall). */
  clippingSamples: number;
  ridingSamples: number;
  /** Walked at least 2 blocks in the watch. */
  moved: boolean;
  endInsideWall: boolean;
}

/**
 * Judge one figure's watch. The home area is the model's footprint (model
 * blocks from the anchor) plus `GT_FIGURE_AREA_MARGIN`; "below the floor" is
 * under the pin plane the model stands on. Pure, so it is unit-tested here and
 * serialised into the device runtime unchanged.
 */
export function judgeFigureTrack(track: FigureSample[], area: { min: Vec3; max: Vec3 }, groundY: number, endInsideWall: boolean, margin: number): FigureTrackVerdict {
  let pathLength = 0, maxExcursion = 0, outsideSamples = 0, clippingSamples = 0, ridingSamples = 0, minY = Infinity;
  const first = track[0];
  for (let i = 0; i < track.length; i++) {
    const s = track[i]!;
    if (i > 0) { const p = track[i - 1]!; pathLength += Math.sqrt((s.x - p.x) ** 2 + (s.z - p.z) ** 2); }
    if (first) maxExcursion = Math.max(maxExcursion, Math.sqrt((s.x - first.x) ** 2 + (s.z - first.z) ** 2));
    if (s.x < area.min.x - margin || s.x > area.max.x + margin || s.z < area.min.z - margin || s.z > area.max.z + margin) outsideSamples++;
    if (s.clipping) clippingSamples++;
    if (s.riding) ridingSamples++;
    minY = Math.min(minY, s.y);
  }
  const last = track[track.length - 1];
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  return {
    samples: track.length, pathLength: r2(pathLength), maxExcursion: r2(maxExcursion), outsideSamples,
    minAboveGround: r2(Number.isFinite(minY) ? minY - groundY : 0),
    belowGround: Number.isFinite(minY) && minY < groundY - 0.5,
    droppedStorey: !!first && !!last && last.y < first.y - 1.5,
    clippingSamples, ridingSamples, moved: pathLength >= 2, endInsideWall,
  };
}

export interface GametestPinball {
  /** The rideable seat pad the player sits on to play. */
  consoleType: string;
  /** Tap-zone entities spawned in front of a seated player. */
  buttonType: string;
  /** Flipper entities, left then right; each carries the flip actor property. */
  flipperTypes: string[];
  /** Actor property holding a flipper's angle. */
  flipProperty: string;
  /** Tag the runtime gives a seated player. */
  seatedTag: string;
  /** Hotbar slot a seated player is parked on; a lower slot is the left flipper, a higher the right. */
  parkSlot: number;
  /** The plunger's tap target, the plunger (its pull property) and the ball (its plane-offset property), when the pack has them. */
  plungerButtonType?: string | undefined;
  plungerType?: string | undefined;
  pullProperty?: string | undefined;
  ballType?: string | undefined;
  ballUProperty?: string | undefined;
}

// ─── The placement hook (test variant only) ────────────────────────────────

/** The line in `placement.js` the hook is inserted before (inside `placementRuntime`). */
const PLACEMENT_ANCHOR = '  world.afterEvents.itemUse.subscribe((ev) => {';

/**
 * Hook source. Runs inside `placementRuntime`'s closure, so `state`, `place`
 * and `histories` are the pack's own. Message: JSON `{ player, x, y, z,
 * rotation?, size? }`; the player is found by NAME so the sender may be any
 * pack (`system.sendScriptEvent` has no source entity).
 */
const PLACEMENT_HOOK = `  system.afterEvents.scriptEventReceive.subscribe((ev) => {
    if (ev.id !== "${GT_PLACE_EVENT}") return;
    let a;
    try { a = JSON.parse(ev.message); } catch (e) { console.warn("CMGT_HOOK bad message " + ev.message); return; }
    // Measured on the Pixel (run 2): even with server-gametest declared, a simulated player
    // is not found by name from this pack. place() only needs a player for its dimension,
    // messages and undo history, so fall back to a real player and say which was used.
    const all = world.getAllPlayers(), real = all.filter(Boolean);
    const src = ev.sourceEntity && ev.sourceEntity.typeId === "minecraft:player" ? ev.sourceEntity : undefined;
    const p = src || real.find((x) => x.name === a.player) || real[0];
    console.warn("CMGT_HOOK " + JSON.stringify({ requested: a.player, players: all.length, undefinedPlayers: all.length - real.length, names: real.map((x) => x.name), using: p ? p.name : null }));
    if (!p) return;
    const st = state(p);
    st.anchor = { x: a.x, y: a.y, z: a.z }; st.dimension = p.dimension.id; st.rotation = a.rotation || 0; st.size = a.size || 100; st.aim = false;
    system.run(() => place(p).then(() => {
      const h = histories.get(p.id);
      system.sendScriptEvent("${GT_PLACED_EVENT}", JSON.stringify({ player: a.player, placedFor: p.name, entities: h ? h.entities.length : -1 }));
    }, (e) => system.sendScriptEvent("${GT_PLACED_EVENT}", JSON.stringify({ player: a.player, error: String(e && e.message || e) }))));
  }, { namespaces: ["${GT_NAMESPACE}"] });
  console.warn("CMGT_HOOK_READY " + config.id);
`;

/**
 * Insert the placement hook. Throws when the anchor line is missing or not
 * unique, so a change to the placement runtime cannot silently produce a test
 * pack whose tests can never place anything.
 */
export function patchPlacementForGametest(placementJs: string): string {
  const first = placementJs.indexOf(PLACEMENT_ANCHOR);
  if (first < 0) throw new Error('placement.js: itemUse anchor not found; the placement runtime changed shape');
  if (placementJs.indexOf(PLACEMENT_ANCHOR, first + 1) >= 0) throw new Error('placement.js: itemUse anchor is not unique');
  // The closure names the hook calls; a rename in the runtime must fail here, not on the phone.
  for (const pattern of [/\bstate = \(p\) =>/, /\basync function place\(p\)/, /\bhistories\.set\(/]) {
    if (!pattern.test(placementJs)) throw new Error(`placement.js: ${pattern} not found; the hook would not bind`);
  }
  return placementJs.slice(0, first) + PLACEMENT_HOOK + placementJs.slice(first);
}

// ─── Manifests ──────────────────────────────────────────────────────────────

interface Manifest {
  format_version: number;
  header: { name: string; description?: string; uuid: string; version: number[]; min_engine_version?: number[] };
  modules: Array<{ type: string; uuid: string; version: number[]; language?: string; entry?: string }>;
  dependencies?: Array<{ uuid?: string; module_name?: string; version: number[] | string }>;
}

/**
 * The model BP's manifest with new header/module uuids derived from the old
 * ones, so the variant can sit beside the shipped pack on one device without
 * a uuid clash. Dependencies (its RP, the script modules) are unchanged.
 */
export function variantManifest(manifest: Manifest, version: number[] = manifest.header.version): Manifest {
  const renew = (uuid: string): string => deterministicUuid(`${GT_NAMESPACE}.variant:${uuid}`);
  const deps = (manifest.dependencies ?? []).filter(d => d.module_name !== '@minecraft/server-gametest');
  return {
    ...manifest,
    // A new version per build: an import of an already-installed uuid+version is a no-op.
    header: { ...manifest.header, name: `${manifest.header.name} [GameTest]`, uuid: renew(manifest.header.uuid), version },
    modules: manifest.modules.map(m => ({ ...m, uuid: renew(m.uuid), version })),
    // Measured on the Pixel (1.26.51, 2026-09-24): in a pack WITHOUT this module,
    // `world.getAllPlayers()` / `getPlayers()` return `undefined` in place of every
    // simulated player, so the placement runtime's per-tick loops threw on `p.id`
    // and the hook could not find the test's player by name.
    dependencies: [...deps, { module_name: '@minecraft/server-gametest', version: GT_GAMETEST_VERSION }],
  };
}

// ─── Arena structure ────────────────────────────────────────────────────────

/** Arena size: the model's box plus `GT_MARGIN` each side, one floor layer and headroom. */
export function arenaSize(dims: GametestPlan['dims']): Vec3 {
  // The full size: a model wider than one structure (`arenaExceeds`) gets a capped structure
  // (`buildArenaStructure` with `overflow`) and is tested in x-windows (`arenaWindows`).
  return { x: dims.width + 2 * GT_MARGIN, y: dims.height + 3, z: dims.length + 2 * GT_MARGIN };
}

/** Is the model's arena larger than one structure can carry? */
export function arenaExceeds(dims: GametestPlan['dims']): boolean {
  const size = arenaSize(dims);
  return size.x > GT_MAX_ARENA.x || size.z > GT_MAX_ARENA.z || size.y > GT_MAX_ARENA.y;
}

/**
 * The arena: smooth stone at y = 0, explicit air above (so the structure
 * clears whatever the test area held). The model is placed with its anchor at
 * relative (GT_MARGIN, 1, GT_MARGIN). A model too large for one structure is
 * refused unless `overflow` is set; then the structure is capped at
 * `GT_MAX_ARENA` and the test lays the remaining floor (`GametestPlan.oversized`).
 */
export function buildArenaStructure(dims: GametestPlan['dims'], options: { overflow?: boolean } = {}): Uint8Array {
  const full = arenaSize(dims);
  if (arenaExceeds(dims) && !options.overflow) {
    // TODO: tile large models over several test structures instead of laying the overflow floor at run time.
    throw new Error(`arena ${full.x}x${full.y}x${full.z} exceeds one structure (${GT_MAX_ARENA.x}x${GT_MAX_ARENA.y}x${GT_MAX_ARENA.z})`);
  }
  const size = { x: Math.min(full.x, GT_MAX_ARENA.x), y: Math.min(full.y, GT_MAX_ARENA.y), z: Math.min(full.z, GT_MAX_ARENA.z) };
  const grid = new BlockGrid(size.x, size.y, size.z);
  for (let x = 0; x < size.x; x++) for (let z = 0; z < size.z; z++) grid.set(x, 0, z, 'minecraft:smooth_stone');
  const tile = { name: 'arena', x: 0, y: 0, z: 0, width: size.x, height: size.y, length: size.z, ix: 0, iy: 0, iz: 0, nonAir: size.x * size.z };
  const encoded = encodeMcstructureTile(grid, tile);
  if (encoded.unmapped.length) throw new Error(`arena blocks without a Bedrock mapping: ${encoded.unmapped.join(', ')}`);
  return encoded.bytes;
}

// ─── Walk judgement (shared by the runtime and the unit tests) ──────────────

/**
 * Where a walker ended relative to its start->end line: `passed` at 75 % or
 * more of the way, `blocked` under 50 %, otherwise `partial`; `fell` when it
 * ended more than a block below both ends (run 4: 41732's Door 3 "walked
 * through" by dropping 3.25 blocks off the far side - the drop that makes the
 * offline walk call it SEALED).
 */
export function judgeWalk(start: Vec3, end: Vec3, at: Vec3): { outcome: 'passed' | 'blocked' | 'partial' | 'fell'; progress: number } {
  const dx = end.x - start.x, dz = end.z - start.z, len2 = dx * dx + dz * dz;
  const progress = len2 > 0 ? ((at.x - start.x) * dx + (at.z - start.z) * dz) / len2 : 0;
  const rounded = Math.round(progress * 100) / 100;
  if (at.y < Math.min(start.y, end.y) - 1) return { outcome: 'fell', progress: rounded };
  return { outcome: progress >= 0.75 ? 'passed' : progress < 0.5 ? 'blocked' : 'partial', progress: rounded };
}

/** Does a device outcome satisfy an offline prediction? `sealed` means "not walkable". */
export function outcomeMatches(expected: WalkOutcome, device: string): boolean {
  if (expected === 'passed') return device === 'passed';
  if (expected === 'no-approach') return true;
  return device !== 'passed';
}

// ─── The GameTest runtime (serialised with .toString()) ─────────────────────

/** Modules the runtime is handed, so it references nothing outside itself. */
interface RuntimeModules { mc: any; gt: any }

/**
 * Registered in the GameTest pack. Everything it reports is one content-log
 * line `CMGT <TAG> <json>` via `console.warn` (the level the content log keeps
 * by default), then ~16 KiB of padding so the block-buffered log flushes.
 */
export function gametestRuntime(mods: RuntimeModules, plan: GametestPlan, arena: Vec3, margin: number, judge: typeof judgeWalk, matches: typeof outcomeMatches, judgeFigure?: typeof judgeFigureTrack): void {
  const { mc, gt } = mods;
  const { world, system } = mc;
  const NS = 'craftmatic_gt';
  const log = (tag: string, data: unknown): void => { console.warn(`CMGT ${tag} ${JSON.stringify(data)}`); };
  const flush = (): void => { const pad = 'x'.repeat(1000); for (let i = 0; i < 18; i++) console.warn(`CMGT_PAD ${i} ${pad}`); };
  const placedReplies = new Map<string, any>();
  system.afterEvents.scriptEventReceive.subscribe((ev: any) => {
    if (ev.id === `${NS}:placed`) { try { const m = JSON.parse(ev.message); placedReplies.set(m.player, m); } catch { /* malformed */ } }
    if (ev.id === `${NS}:run`) runAll(ev.sourceEntity);
    if (ev.id === `${NS}:probe`) void probe(ev.message);
  }, { namespaces: [NS] });

  /** Entity-interaction events a simulated player caused, as this pack's own handlers see them. */
  const events = { interact: 0, hit: 0 };
  const isSim = (p: any): boolean => !!p && String(p.name).startsWith('cmgt_');
  world.afterEvents.playerInteractWithEntity.subscribe((ev: any) => { if (isSim(ev.player)) events.interact++; });
  world.afterEvents.entityHitEntity.subscribe((ev: any) => { if (isSim(ev.damagingEntity)) events.hit++; });

  const round = (v: any): Vec3 => ({ x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(v.z * 100) / 100 });
  const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const dist2 = (a: Vec3, b: Vec3): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
  const gameMode = mc.GameMode.Survival ?? mc.GameMode.survival;

  /**
   * Where the arena floor landed, in test-relative y. Measured on the Pixel
   * (2026-09-24): relative y = 0 read AIR, so the structure's layer 0 is not
   * simply relative 0 - find the smooth stone instead of assuming.
   */
  const floorY = (test: any, x: number, z: number): { y: number; column: string[] } => {
    const column: string[] = [];
    let y = 0, found = false;
    for (let ry = -3; ry <= 3; ry++) {
      let id = '?';
      try { id = test.getBlock({ x, y: ry, z })?.typeId ?? 'none'; } catch (err) { id = `error:${String(err)}`; }
      column.push(`${ry}:${id.replace('minecraft:', '')}`);
      if (!found && id === 'minecraft:smooth_stone') { y = ry; found = true; }
    }
    return { y: found ? y : 0, column };
  };

  const oversized = !!plan.oversized;
  if (oversized) log('OVERSIZED', { model: plan.modelId, arena, note: 'only the figures test runs; it lays the floor past the structure itself' });

  /** Smoke: the framework runs, a simulated player spawns on the arena floor and walks 4 blocks. */
  if (!oversized) gt.registerAsync(NS, 'smoke', async (test: any) => {
    const f = floorY(test, 2, 2);
    const sim = test.spawnSimulatedPlayer({ x: 2, y: f.y + 1, z: 2 }, 'cmgt_smoke', gameMode);
    await test.idle(10);
    const from = { ...sim.location };
    // SimulatedPlayer movement takes TEST-RELATIVE coordinates (run 2: a world
    // target sent the walker to origin + target).
    const targetRel = { x: 6.5, y: f.y + 1, z: 2.5 };
    const target = test.worldLocation(targetRel);
    sim.moveToLocation(targetRel);
    const track: Vec3[] = [];
    for (let i = 0; i < 6; i++) { await test.idle(10); track.push(round(sim.location)); }
    const to = { ...sim.location };
    const moved = Math.sqrt((from.x - to.x) ** 2 + (from.z - to.z) ** 2);
    log('SMOKE', { floorY: f.y, column: f.column, from: round(from), target: round(target), track, movedHorizontally: Math.round(moved * 100) / 100, direction: String(test.getTestDirection()) });
    flush();
    if (moved < 2) test.fail(`simulated player moved only ${moved.toFixed(2)} blocks`); else test.succeed();
  }).structureName(`${NS}:arena_${plan.modelId}`).maxTicks(300).tag(NS);

  /**
   * Place the model at 100 %, turn 0, with the pack's own placement code (the
   * injected hook), for a simulated player spawned in the arena. Returns
   * undefined (after failing the test) when the placement did not land.
   */
  const placeModel = async (test: any, testName: string, shiftX = 0): Promise<{ sim: any; anchor: Vec3; dim: any } | undefined> => {
    const name = `cmgt_${Math.floor(Math.random() * 1e6)}`;
    const f = floorY(test, margin, margin);
    // A window past the first: the model is placed shifted -x so that window lies over the arena.
    const anchor = test.worldBlockLocation({ x: margin - shiftX, y: f.y + 1, z: margin });
    const sim = test.spawnSimulatedPlayer({ x: 1, y: f.y + 1, z: 1 }, name, gameMode);
    log('ARENA', { test: testName, model: plan.modelId, anchor, floorY: f.y, column: f.column, arena, direction: String(test.getTestDirection()), player: name });
    await test.idle(5);
    let reply: any;
    // The placement runtime runs one placement at a time and answers a second
    // one at once with nothing placed (entities -1: "Another placement is
    // running"), which is what a doors and a figures test starting together
    // get (Pixel, 2026-09-25). Ask again until it takes.
    for (let attempt = 0; attempt < 12; attempt++) {
      placedReplies.delete(name);
      system.sendScriptEvent(`${NS}:place`, JSON.stringify({ player: name, x: anchor.x, y: anchor.y, z: anchor.z, rotation: 0, size: 100 }));
      reply = undefined;
      for (let t = 0; t < 1200 && !reply; t += 10) { await test.idle(10); reply = placedReplies.get(name); }
      if (!reply || reply.error || reply.entities !== -1) break;
      log('PLACE_RETRY', { test: testName, attempt });
      await test.idle(100);
    }
    const dim = test.getDimension();
    const spawned = dim.getEntities({ location: add(anchor, { x: plan.dims.width / 2, y: plan.dims.height / 2, z: plan.dims.length / 2 }), maxDistance: Math.max(plan.dims.width, plan.dims.length, plan.dims.height) + 4 }).filter((e: any) => plan.actorTypes.includes(e.typeId));
    log('PLACED', { test: testName, reply: reply ?? 'timeout', actorsFound: spawned.length, actorsExpected: plan.actorTypes.length });
    if (!reply || reply.error) { flush(); test.fail(`placement did not complete: ${reply ? reply.error : 'no reply in 1200 ticks'}`); return undefined; }
    return { sim, anchor, dim };
  };
  const nearest = (dim: any, type: string, at: Vec3, maxDistance: number): any =>
    dim.getEntities({ type, location: at, maxDistance }).sort((a: any, b: any) => dist2(a.location, at) - dist2(b.location, at))[0];

  // The plan's arena windows (`arenaWindows`) and each item's window (`windowOf`), computed by the plan builder.
  const windows: Array<{ x0: number; x1: number }> = plan.windows?.length ? plan.windows : [{ x0: 0, x1: plan.dims.width }];
  const windowIndexOf = (item: { window?: number }): number => item.window ?? 0;
  const suffix = (w: number): string => (windows.length > 1 ? `_w${w}` : '');
  const angleOf = (e: any): unknown => { try { return e.getProperty(plan.angleProperty); } catch (err) { return `error: ${String(err)}`; } };

  /** Doors: place the model with its own placement code, then walk every doorway closed and open. */
  for (let w = 0; w < windows.length; w++) {
  const doorways = plan.doorways.filter(d => windowIndexOf(d) === w);
  // An oversized model tested in windows runs its doors per window; one without windows only runs the figures test.
  if (doorways.length && (!oversized || windows.length > 1)) gt.registerAsync(NS, `doors_${plan.modelId}${suffix(w)}`, async (test: any) => {
    const placed = await placeModel(test, 'doors', windows[w]!.x0);
    if (!placed) return;
    const { sim, anchor, dim } = placed;
    await test.idle(40); // two interactives sync passes: closed doorways get their colliders

    const walk = async (startW: Vec3, endW: Vec3): Promise<{ outcome: string; progress: number; at: Vec3 }> => {
      sim.teleport(startW, { facingLocation: endW });
      await test.idle(4);
      sim.moveToLocation(test.relativeLocation(endW)); // relative, like every SimulatedPlayer move
      await test.idle(60);
      sim.stopMoving();
      const at = { ...sim.location };
      const j = judge(startW, endW, at);
      return { outcome: j.outcome, progress: j.progress, at: round(at) };
    };
    const results: any[] = [];
    for (const d of doorways) {
      const leafAt = add(anchor, d.actor);
      const leaf = nearest(dim, d.typeId, leafAt, 4);
      const startW = add(anchor, d.start), endW = add(anchor, d.end);
      const row: any = { label: d.label, offline: d.offlineVerdict, expectClosed: d.expectClosed, expectOpen: d.expectOpen };
      if (!leaf) { row.error = 'leaf entity not found'; results.push(row); log('DOOR', row); continue; }
      try {
        const face = async (): Promise<void> => { sim.teleport(startW, { facingLocation: leaf.location }); await test.idle(4); sim.lookAtEntity(leaf); };
        // A double door's leaves share cells and move together (run 4: opening Door 2
        // opened Door 4). Close a leaf that starts open, so every doorway starts closed.
        const initial = angleOf(leaf);
        if (initial !== 0) { await face(); sim.attackEntity(leaf); await test.idle(20); row.resetFrom = initial; }
        row.angleClosed = angleOf(leaf);
        row.closed = await walk(startW, endW);
        await face();
        const before = { ...events };
        row.interactReturned = sim.interactWithEntity(leaf);
        await test.idle(20);
        row.angleAfterInteract = angleOf(leaf);
        row.interactEvents = events.interact - before.interact;
        if (row.angleAfterInteract === row.angleClosed) {
          // The interact did not toggle it: try the other route the runtime listens to (a hit).
          row.attackReturned = sim.attackEntity(leaf);
          await test.idle(20);
          row.angleAfterAttack = angleOf(leaf);
          row.hitEvents = events.hit - before.hit;
        }
        row.open = await walk(startW, endW);
        row.pass = matches(d.expectClosed, row.closed.outcome) && matches(d.expectOpen, row.open.outcome);
        // Leave it closed for the next doorway (its partner may be next).
        if (angleOf(leaf) !== 0) { await face(); sim.attackEntity(leaf); await test.idle(20); }
      } catch (err) {
        row.error = String(err && (err as Error).message || err);
        row.pass = false;
      }
      results.push(row);
      log('DOOR', row);
    }
    const failed = results.filter(r => !r.pass);
    log('SUMMARY', { model: plan.modelId, doorways: results.length, asPredicted: results.length - failed.length, differ: failed.map(r => r.label) });
    flush();
    if (failed.length) test.fail(`${failed.length}/${results.length} doorways differ from the offline walk: ${failed.map(r => r.label).join(', ')}`);
    else test.succeed();
  }).structureName(`${NS}:arena_${plan.modelId}`).maxTicks(3000 + doorways.length * 400).tag(NS);

  /**
   * Parts and seats: every moving part without a doorway walk is hit twice
   * from a spot the offline tap audit accepted - a door-like part must read
   * its open angle, then 0; a turnable two steps - and every seat is mounted
   * with `interactWithEntity` (run 1 on 11374 seated a player this way) and
   * left again.
   */
  const parts = (plan.parts ?? []).filter(p => windowIndexOf(p) === w);
  const seats = (plan.seats ?? []).filter(s => windowIndexOf(s) === w);
  if (parts.length || seats.length) gt.registerAsync(NS, `parts_${plan.modelId}${suffix(w)}`, async (test: any) => {
    const placed = await placeModel(test, 'parts', windows[w]!.x0);
    if (!placed) return;
    const { sim, anchor, dim } = placed;
    await test.idle(40);
    const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) < 0.5;
    const results: any[] = [];
    for (const p of parts) {
      const row: any = { label: p.label, kind: p.kind, openAngle: p.openAngle };
      const e = nearest(dim, p.typeId, add(anchor, p.actor), 4);
      if (!e) { row.error = 'entity not found'; row.pass = false; results.push(row); log('PART', row); continue; }
      try {
        sim.teleport(add(anchor, p.from), { facingLocation: e.location });
        await test.idle(4);
        sim.lookAtEntity(e);
        const before = { ...events };
        const a0 = angleOf(e);
        row.hit1 = sim.attackEntity(e);
        await test.idle(20);
        const a1 = angleOf(e);
        row.hit2 = sim.attackEntity(e);
        await test.idle(20);
        const a2 = angleOf(e);
        row.angles = [a0, a1, a2];
        row.hitEvents = events.hit - before.hit;
        row.pass = p.kind === 'turnable'
          ? typeof a0 === 'number' && near(a1, a0 + p.openAngle) && near(a2, a0 + 2 * p.openAngle)
          : near(a0, 0) && near(a1, p.openAngle) && near(a2, 0);
      } catch (err) { row.error = String(err && (err as Error).message || err); row.pass = false; }
      results.push(row);
      log('PART', row);
    }
    for (const s of seats) {
      const row: any = { label: s.label, kind: 'seat' };
      const seat = nearest(dim, s.typeId, add(anchor, s.at), 1.5);
      if (!seat) { row.error = 'seat entity not found'; row.pass = false; results.push(row); log('SEAT', row); continue; }
      const riders = (): string[] => { try { return (seat.getComponent('minecraft:rideable')?.getRiders?.() ?? []).map((r: any) => r?.name ?? r?.typeId ?? 'undefined'); } catch (err) { return [`error: ${String(err)}`]; } };
      try {
        sim.teleport(add(seat.location, { x: 0, y: 0.1, z: 0 }), { facingLocation: seat.location });
        await test.idle(4);
        sim.lookAtEntity(seat);
        row.interactReturned = sim.interactWithEntity(seat);
        await test.idle(20);
        row.riders = riders();
        row.pass = row.riders.includes(sim.name);
        try { seat.getComponent('minecraft:rideable')?.ejectRiders?.(); } catch { /* nothing to eject */ }
        await test.idle(10);
      } catch (err) { row.error = String(err && (err as Error).message || err); row.pass = false; }
      results.push(row);
      log('SEAT', row);
    }
    const failed = results.filter(r => !r.pass);
    log('PARTS_SUMMARY', { model: plan.modelId, window: w, parts: parts.length, seats: seats.length, passed: results.length - failed.length, failed: failed.map(r => r.label) });
    flush();
    if (failed.length) test.fail(`${failed.length}/${results.length} parts or seats failed: ${failed.map(r => r.label).join(', ')}`);
    else test.succeed();
  }).structureName(`${NS}:arena_${plan.modelId}`).maxTicks(2000 + parts.length * 120 + seats.length * 80).tag(NS);
  }

  /**
   * Pinball: sit on the machine's seat pad, then press each flipper the way the
   * phone does it (a hotbar slot left / right of the parked one), then by a hit
   * on a tap zone, sampling both flippers' angle property every tick - the
   * 0.3 s pulse that screenshots missed.
   */
  const pb = plan.pinball;
  if (pb && !oversized) gt.registerAsync(NS, `pinball_${plan.modelId}`, async (test: any) => {
    const placed = await placeModel(test, 'pinball');
    if (!placed) return;
    const { sim, anchor, dim } = placed;
    await test.idle(20);
    const row: any = {};
    const centre = add(anchor, { x: plan.dims.width / 2, y: 0, z: plan.dims.length / 2 });
    const seat = nearest(dim, pb.consoleType, centre, 40);
    const flippers = pb.flipperTypes.map(t => nearest(dim, t, centre, 40));
    row.found = { seat: !!seat, flippers: flippers.map(f => !!f) };
    if (!seat || flippers.some(f => !f)) { log('PINBALL', row); flush(); test.fail('pinball parts missing'); return; }
    const riders = (): string[] => { try { return (seat.getComponent('minecraft:rideable')?.getRiders?.() ?? []).map((r: any) => r?.name ?? r?.typeId ?? 'undefined'); } catch (err) { return [`error: ${String(err)}`]; } };
    const flipAngles = (): unknown[] => flippers.map(f => { try { return f.getProperty(pb.flipProperty); } catch (err) { return `error: ${String(err)}`; } });

    // Seat: the interaction a phone tap-and-hold makes, then the component call as a fallback.
    sim.teleport(add(seat.location, { x: 0, y: 0, z: 1.2 }), { facingLocation: seat.location });
    await test.idle(4);
    sim.lookAtEntity(seat);
    row.interactReturned = sim.interactWithEntity(seat);
    await test.idle(20);
    row.ridersAfterInteract = riders();
    if (!row.ridersAfterInteract.includes(sim.name)) {
      try { row.addRiderReturned = seat.getComponent('minecraft:rideable').addRider(sim); } catch (err) { row.addRiderReturned = `error: ${String(err)}`; }
      await test.idle(20);
      row.ridersAfterAddRider = riders();
    }
    // The runtime tags a seated player and parks the hotbar; the seat lifts over several ticks.
    let t = 0;
    for (; t < 200; t += 5) { if (sim.hasTag(pb.seatedTag) && sim.selectedSlotIndex === pb.parkSlot) break; await test.idle(5); }
    row.seated = { tagged: sim.hasTag(pb.seatedTag), slot: sim.selectedSlotIndex, ticks: t };
    await test.idle(40);
    row.restAngles = flipAngles();

    const pulse = async (label: string, act: () => unknown): Promise<any> => {
      const rest = flipAngles();
      const out: any = { label, rest, returned: act(), samples: [] as unknown[] };
      for (let i = 0; i < 16; i++) { await test.idle(1); out.samples.push(flipAngles()); }
      out.slotAfter = sim.selectedSlotIndex;
      // Largest move of each flipper from rest over the 16 ticks.
      out.maxMove = flippers.map((_, k) => Math.round(Math.max(0, ...out.samples.map((sm: any) => Math.abs(Number(sm[k]) - Number(rest[k])) || 0))));
      await test.idle(20);
      return out;
    };
    row.left = await pulse('slot left', () => { sim.selectedSlotIndex = pb.parkSlot - 1; return sim.selectedSlotIndex; });
    row.right = await pulse('slot right', () => { sim.selectedSlotIndex = pb.parkSlot + 1; return sim.selectedSlotIndex; });
    // Each flipper target: a hit must move exactly its own flipper.
    const targets = dim.getEntities({ type: pb.buttonType, location: sim.location, maxDistance: 12 });
    row.targetsFound = targets.length;
    row.targetHits = [];
    for (const t of targets) row.targetHits.push((await pulse('target hit', () => sim.attackEntity(t))).maxMove);
    const moved = (r: any, k: number): boolean => !!r && r.maxMove[k] > 5;
    const targetsOk = targets.length === 2 && [0, 1].every(k => row.targetHits.filter((mv: number[]) => mv[k]! > 5 && mv[1 - k]! <= 5).length === 1);
    // The plunger: hit its target (take hold), wait, hit again (let go); the
    // plunger's pull must rise and the ball must leave up the table (-u).
    let plungerOk = true;
    if (pb.plungerButtonType && pb.plungerType && pb.ballType) {
      const target = nearest(dim, pb.plungerButtonType, sim.location, 12);
      const plunger = nearest(dim, pb.plungerType, centre, 40);
      const ball = nearest(dim, pb.ballType, centre, 40);
      const prop = (e: any, k: string | undefined): number => { try { return Number(e?.getProperty(k)); } catch { return NaN; } };
      row.plunger = { targetFound: !!target, plungerFound: !!plunger, ballFound: !!ball, pull: [] as number[], ballU: [] as number[] };
      if (target && plunger && ball) {
        row.plunger.grabReturned = sim.attackEntity(target);
        for (let i = 0; i < 20; i++) { await test.idle(1); row.plunger.pull.push(Math.round(prop(plunger, pb.pullProperty) * 100) / 100); }
        row.plunger.releaseReturned = sim.attackEntity(target);
        for (let i = 0; i < 20; i++) { await test.idle(1); row.plunger.ballU.push(Math.round(prop(ball, pb.ballUProperty))); }
        const maxPull = Math.max(0, ...row.plunger.pull.filter(Number.isFinite));
        const minU = Math.min(0, ...row.plunger.ballU.filter(Number.isFinite));
        row.plunger.maxPull = maxPull; row.plunger.minBallU = minU;
        plungerOk = maxPull > 0.3 && minU < -50;
      } else plungerOk = false;
    }
    row.targetsOk = targetsOk; row.plungerOk = plungerOk;
    row.pass = moved(row.left, 0) && moved(row.right, 1) && targetsOk && plungerOk;
    log('PINBALL', row);
    flush();
    if (row.pass) test.succeed(); else test.fail(`pinball: slots ${moved(row.left, 0) && moved(row.right, 1)}, targets ${targetsOk}, plunger ${plungerOk}`);
  }).structureName(`${NS}:arena_${plan.modelId}`).maxTicks(3000).tag(NS);

  /**
   * Figures: place the model, find every minifig NPC it spawned, then sample
   * each one's position (and whether it rides a seat, and whether its body is
   * inside a collider taller than a step) every `GT_FIGURE_SAMPLE_TICKS` for
   * the watch. Fails when a figure leaves the footprint, falls under the pin
   * plane, ends inside a wall, or when fewer than half the roaming figures
   * walked 2 blocks.
   */
  const figs = plan.figures ?? [];
  const watchTicks = plan.figureTicks ?? 1200;
  if (figs.length && judgeFigure) gt.registerAsync(NS, `figures_${plan.modelId}`, async (test: any) => {
    // An oversized model: lay the floor (and clear the air) past the capped structure first.
    const overflowBoxes: Array<{ floor: any[]; air: any[] }> = [];
    if (oversized) {
      const f0 = floorY(test, margin, margin).y;
      const cap = { x: 64, z: 64 };
      const boxes: Array<[number, number, number, number]> = [];
      if (arena.x > cap.x) boxes.push([cap.x, arena.x - 1, 0, Math.min(arena.z, cap.z) - 1]);
      if (arena.z > cap.z) boxes.push([0, arena.x - 1, cap.z, arena.z - 1]);
      for (const [x0, x1, z0, z1] of boxes) {
        const floor = [test.worldBlockLocation({ x: x0, y: f0, z: z0 }), test.worldBlockLocation({ x: x1, y: f0, z: z1 })];
        const air = [test.worldBlockLocation({ x: x0, y: f0 + 1, z: z0 }), test.worldBlockLocation({ x: x1, y: f0 + arena.y, z: z1 })];
        overflowBoxes.push({ floor, air });
        try {
          const d = test.getDimension();
          d.fillBlocks(new mc.BlockVolume(air[0], air[1]), 'minecraft:air');
          d.fillBlocks(new mc.BlockVolume(floor[0], floor[1]), 'minecraft:smooth_stone');
        } catch (err) { log('OVERFLOW', { error: String(err && (err as Error).message || err) }); }
      }
      log('OVERFLOW', { boxes: overflowBoxes });
    }
    const placed = await placeModel(test, 'figures');
    if (!placed) return;
    const { sim, anchor, dim } = placed;
    // Out of the way: in a corner of the arena, so it neither blocks nor lures a figure much.
    try { sim.teleport(test.worldLocation({ x: 0.5, y: 2, z: 0.5 })); } catch { /* stays */ }
    await test.idle(40);
    const col = plan.colliders;
    /** Collision span [bottom, top] of the block in world row y at column (x, z); null for air. */
    const spanAt = (x: number, y: number, z: number): number[] | null => {
      let b: any;
      try { b = dim.getBlock({ x, y, z }); } catch { return null; }
      if (!b || b.isAir === true || b.isLiquid === true || b.typeId === 'minecraft:air') return null;
      if (col && b.typeId === col.block) {
        const lo = Number(b.permutation.getState(col.loState)), hi = Number(b.permutation.getState(col.hiState));
        return Number.isFinite(lo) && Number.isFinite(hi) ? [y + lo / 16, y + hi / 16] : [y, y + 1];
      }
      return [y, y + 1];
    };
    /** Does a body standing at `at` overlap a span that rises more than a step above its feet (furniture, a wall)? And a wall (a span at least 12/16 thick)? */
    const bodyCheck = (at: Vec3): { clipping: boolean; wall: boolean } => {
      const x = Math.floor(at.x), z = Math.floor(at.z), feet = at.y;
      let clipping = false, wall = false;
      for (let y = Math.floor(feet); y <= Math.floor(feet + 1.6); y++) {
        const s = spanAt(x, y, z);
        if (!s || !(s[0]! < feet + 1.6 && s[1]! > feet + 0.6)) continue;
        clipping = true;
        if (s[1]! - s[0]! >= 0.75) wall = true;
      }
      return { clipping, wall };
    };
    const centre = add(anchor, { x: plan.dims.width / 2, y: 0, z: plan.dims.length / 2 });
    const reach = Math.max(plan.dims.width, plan.dims.length) + 6;
    const tracked = figs.map(f => {
      const want = add(anchor, f.actor);
      const e = dim.getEntities({ type: f.typeId, location: centre, maxDistance: reach }).sort((a: any, b: any) => dist2(a.location, want) - dist2(b.location, want))[0];
      return { f, e, track: [] as any[] };
    });
    log('FIGURES_FOUND', { model: plan.modelId, expected: figs.length, found: tracked.filter(t => t.e).length, missing: tracked.filter(t => !t.e).map(t => t.f.label) });
    const riding = (e: any): boolean => { try { return !!e.getComponent('minecraft:riding'); } catch { return false; } };
    for (let t = 0; t <= watchTicks; t += 20) {
      for (const tr of tracked) {
        if (!tr.e) continue;
        let loc: any;
        try { loc = tr.e.location; } catch { continue; } // removed or unloaded
        const c = bodyCheck(loc);
        tr.track.push({ ...round(loc), riding: riding(tr.e), clipping: c.clipping });
      }
      if (t < watchTicks) await test.idle(20);
    }
    const area = { min: anchor, max: add(anchor, { x: plan.dims.width, y: plan.dims.height, z: plan.dims.length }) };
    const rows = tracked.map(tr => {
      if (!tr.e || !tr.track.length) return { label: tr.f.label, seated: tr.f.seated, error: 'not found' } as any;
      const last = tr.track[tr.track.length - 1];
      const v = judgeFigure(tr.track, area, anchor.y, bodyCheck(last).wall, 1);
      // Relative to the anchor so a row reads in model blocks.
      const rel = (p: Vec3): Vec3 => round({ x: p.x - anchor.x, y: p.y - anchor.y, z: p.z - anchor.z });
      return { label: tr.f.label, seated: tr.f.seated, start: rel(tr.track[0]), end: rel(last), ...v,
        path: tr.track.filter((_: any, i: number) => i % 6 === 0).map((p: any) => [Math.round((p.x - anchor.x) * 10) / 10, Math.round((p.y - anchor.y) * 10) / 10, Math.round((p.z - anchor.z) * 10) / 10]) };
    });
    for (const r of rows) log('FIGURE', r);
    const found = rows.filter(r => !r.error);
    const roamers = found.filter(r => !r.seated);
    const bad = (k: string): string[] => found.filter(r => r[k]).map(r => r.label);
    const summary = {
      model: plan.modelId, figures: figs.length, found: found.length, roamers: roamers.length,
      moved: roamers.filter(r => r.moved).length, still: roamers.filter(r => !r.moved).map(r => r.label),
      leftArea: found.filter(r => r.outsideSamples > 0).map(r => r.label), belowGround: bad('belowGround'),
      droppedStorey: bad('droppedStorey'),
      // A seated figure sits in its bench's collider cells by design; only a standing one inside a wall is a fault.
      endInsideWall: roamers.filter(r => r.endInsideWall && r.ridingSamples < r.samples).map(r => r.label),
      clipping: found.filter(r => r.clippingSamples > 0).map(r => `${r.label}:${r.clippingSamples}`),
      seatedStayed: found.filter(r => r.seated && r.ridingSamples === r.samples).length, seatedInSet: found.filter(r => r.seated).length,
      satDown: roamers.filter(r => r.ridingSamples > 0).map(r => r.label),
      meanPath: roamers.length ? Math.round(roamers.reduce((s, r) => s + r.pathLength, 0) / roamers.length * 10) / 10 : 0,
      watchTicks,
    };
    log('FIGURE_SUMMARY', summary);
    flush();
    // Leave nothing past the structure for the next run (GameTest clears only its own box).
    if (oversized) {
      try {
        for (const e of dim.getEntities({ location: centre, maxDistance: reach + 4 })) if (plan.actorTypes.includes(e.typeId)) { try { e.remove(); } catch { /* gone */ } }
        for (const b of overflowBoxes) dim.fillBlocks(new mc.BlockVolume(b.air[0], b.air[1]), 'minecraft:air');
      } catch (err) { log('OVERFLOW', { cleanupError: String(err && (err as Error).message || err) }); }
    }
    const problems: string[] = [];
    if (found.length < figs.length) problems.push(`${figs.length - found.length} figure(s) not found`);
    if (summary.leftArea.length) problems.push(`left the model: ${summary.leftArea.join(', ')}`);
    if (summary.belowGround.length) problems.push(`fell below the floor: ${summary.belowGround.join(', ')}`);
    if (summary.endInsideWall.length) problems.push(`inside a wall: ${summary.endInsideWall.join(', ')}`);
    if (roamers.length && summary.moved * 2 < roamers.length) problems.push(`only ${summary.moved}/${roamers.length} roaming figures moved`);
    if (problems.length) test.fail(problems.join('; ')); else test.succeed();
  }).structureName(`${NS}:arena_${plan.modelId}`).maxTicks(5400 + watchTicks).tag(NS);

  /** Creator-tooling probe: which /script subcommands a script may run on this device. */
  async function probe(target: string | undefined): Promise<void> {
    // Run 5 measured every /script subcommand at successCount 0 from the dimension;
    // try each from the dimension AND as the real player.
    const dim = world.getDimension('overworld');
    const player = world.getPlayers().filter(Boolean).find((p: any) => !String(p.name).startsWith('cmgt_'));
    const tryCmd = (cmd: string): void => {
      for (const [source, runner] of [['dimension', dim], ['player', player]] as const) {
        if (!runner) continue;
        try { const r = runner.runCommand(cmd); log('PROBE', { cmd, source, successCount: r?.successCount }); }
        catch (err) { log('PROBE', { cmd, source, error: String(err && (err as Error).message || err) }); }
      }
    };
    tryCmd('script profiler start');
    await new Promise<void>(res => system.runTimeout(() => res(), 100));
    tryCmd('script profiler stop');
    tryCmd('script diagnostics startcapture');
    await new Promise<void>(res => system.runTimeout(() => res(), 100));
    tryCmd('script diagnostics stopcapture');
    const t = (target || plan.debuggerTarget || '').trim();
    if (t) tryCmd(`script debugger connect ${t.replace(':', ' ')}`);
    flush();
  }

  /** Run every test once: clear old test areas, then `runset` as the real player. */
  function runAll(player: any): void {
    const p = player ?? world.getPlayers().find((x: any) => !String(x.name).startsWith('cmgt_'));
    if (!p) { log('RUN', { error: 'no real player online' }); return; }
    for (const cmd of ['gametest clearall', `gametest runset ${NS}`]) {
      try { const r = p.runCommand(cmd); log('RUN', { cmd, successCount: r?.successCount }); }
      catch (err) { log('RUN', { cmd, error: String(err && (err as Error).message || err) }); }
    }
  }

  let started = false;
  world.afterEvents.playerSpawn.subscribe((ev: any) => {
    if (started || !ev.initialSpawn || String(ev.player.name).startsWith('cmgt_')) return;
    started = true;
    // Let chunks, packs and the interactives runtime settle before the first run.
    system.runTimeout(() => { runAll(ev.player); system.runTimeout(() => void probe(undefined), 2400 + plan.doorways.length * 500); }, 200);
  });
  log('READY', { model: plan.modelId, doorways: plan.doorways.length, arena });
}

/** `scripts/main.js` of the GameTest pack. */
export function gametestScript(plan: GametestPlan): string {
  const arena = arenaSize(plan.dims);
  return `import * as mc from "@minecraft/server";\nimport * as gt from "@minecraft/server-gametest";\n`
    + `const PLAN = ${JSON.stringify(plan)};\n`
    + `(${gametestRuntime.toString()})({ mc, gt }, PLAN, ${JSON.stringify(arena)}, ${GT_MARGIN}, ${judgeWalk.toString()}, ${outcomeMatches.toString()}, ${judgeFigureTrack.toString()});\n`;
}

/** `scripts/main.js` of the variant: the model's entry plus the tests (import declarations hoist). */
export function withGametestImport(mainJs: string): string {
  if (mainJs.includes('./gametest.js')) return mainJs;
  return `${mainJs.replace(/\s*$/, '')}\nimport "./gametest.js";\n`;
}

/** Files the test variant ADDS to the model's behaviour pack, relative to its folder. */
export function gametestVariantFiles(plan: GametestPlan): Array<{ name: string; data: Uint8Array }> {
  const enc = new TextEncoder();
  return [
    { name: 'scripts/gametest.js', data: enc.encode(gametestScript(plan)) },
    { name: `structures/${GT_NAMESPACE}/arena_${plan.modelId}.mcstructure`, data: buildArenaStructure(plan.dims, { overflow: !!plan.oversized }) },
  ];
}
