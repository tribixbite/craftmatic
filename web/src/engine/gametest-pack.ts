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
 * Output is TWO packs, both bound to a dedicated world that has Beta APIs on:
 *
 * 1. A **test variant** of the model's behaviour pack: the same files with new
 *    uuids and one scriptevent hook injected into `scripts/placement.js`
 *    (`craftmatic_gt:place`), so a test can drive the pack's OWN `place()` for a
 *    named player without the Brick Wand's forms (a simulated player cannot
 *    answer a form). The model's resource pack ships unchanged.
 *    TODO: move the hook into the placement runtime itself (playable-addon.ts)
 *    so the shipped pack and the tested pack are byte-identical but for uuids.
 * 2. The **GameTest pack**: a tiny arena `.mcstructure` (a floor under the
 *    model's footprint plus a margin) and `scripts/main.js`, which registers
 *    `craftmatic_gt:smoke` and `craftmatic_gt:doors_<id>` and runs them on world
 *    load (`gametest runset craftmatic_gt`). Its dependencies are stable
 *    `@minecraft/server` + `@minecraft/server-gametest` `1.0.0-beta` (the only
 *    version 1.26.5x ships; Mojang's own creator-tools pack pairs a stable
 *    server with the beta gametest module the same way).
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
/** Stable server module the test pack binds; matches the model packs. */
export const GT_SERVER_VERSION = '2.9.0';
/** The only `@minecraft/server-gametest` module version Minecraft 1.26.5x ships. */
export const GT_GAMETEST_VERSION = '1.0.0-beta';
/** Largest arena one `.mcstructure` may carry (a structure block's save limit). */
export const GT_MAX_ARENA = { x: 64, y: 384, z: 64 } as const;

export interface Vec3 { x: number; y: number; z: number }

/** Walk outcome the offline harness predicts, per direction. */
export type WalkOutcome = 'passed' | 'blocked' | 'sealed' | 'partial' | 'no-approach';

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
    const p = world.getPlayers({ name: a.player })[0];
    if (!p) { console.warn("CMGT_HOOK no player " + a.player); return; }
    const st = state(p);
    st.anchor = { x: a.x, y: a.y, z: a.z }; st.dimension = p.dimension.id; st.rotation = a.rotation || 0; st.size = a.size || 100; st.aim = false;
    system.run(() => place(p).then(() => {
      const h = histories.get(p.id);
      system.sendScriptEvent("${GT_PLACED_EVENT}", JSON.stringify({ player: a.player, entities: h ? h.entities.length : -1 }));
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

/** Manifest of the GameTest pack. Version follows the model pack's so a rebuild is recognisable. */
export function gametestManifest(plan: GametestPlan, version: number[]): Manifest {
  const id = `${GT_NAMESPACE}.pack:${plan.modelId}`;
  return {
    format_version: 2,
    header: {
      name: `Craftmatic GameTests — ${plan.label}`,
      description: `Automated in-game tests for ${plan.label}. Needs the Beta APIs experiment and cheats; runs on world load (gametest runset ${GT_TAG}).`,
      uuid: deterministicUuid(`${id}:header`),
      version,
      min_engine_version: [1, 26, 40],
    },
    modules: [
      { type: 'data', uuid: deterministicUuid(`${id}:data`), version },
      { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: deterministicUuid(`${id}:script`), version },
    ],
    dependencies: [
      { module_name: '@minecraft/server', version: GT_SERVER_VERSION },
      { module_name: '@minecraft/server-gametest', version: GT_GAMETEST_VERSION },
    ],
  };
}

// ─── Arena structure ────────────────────────────────────────────────────────

/** Arena size: the model's box plus `GT_MARGIN` each side, one floor layer and headroom. */
export function arenaSize(dims: GametestPlan['dims']): Vec3 {
  return { x: dims.width + 2 * GT_MARGIN, y: dims.height + 3, z: dims.length + 2 * GT_MARGIN };
}

/**
 * The arena: smooth stone at y = 0, explicit air above (so the structure
 * clears whatever the test area held). The model is placed with its anchor at
 * relative (GT_MARGIN, 1, GT_MARGIN).
 */
export function buildArenaStructure(dims: GametestPlan['dims']): Uint8Array {
  const size = arenaSize(dims);
  if (size.x > GT_MAX_ARENA.x || size.z > GT_MAX_ARENA.z || size.y > GT_MAX_ARENA.y) {
    // TODO: tile large models over several test structures (or use structureLocation + a bare floor).
    throw new Error(`arena ${size.x}x${size.y}x${size.z} exceeds one structure (${GT_MAX_ARENA.x}x${GT_MAX_ARENA.y}x${GT_MAX_ARENA.z})`);
  }
  const grid = new BlockGrid(size.x, size.y, size.z);
  for (let x = 0; x < size.x; x++) for (let z = 0; z < size.z; z++) grid.set(x, 0, z, 'minecraft:smooth_stone');
  const tile = { name: 'arena', x: 0, y: 0, z: 0, width: size.x, height: size.y, length: size.z, ix: 0, iy: 0, iz: 0, nonAir: size.x * size.z };
  const encoded = encodeMcstructureTile(grid, tile);
  if (encoded.unmapped.length) throw new Error(`arena blocks without a Bedrock mapping: ${encoded.unmapped.join(', ')}`);
  return encoded.bytes;
}

// ─── Walk judgement (shared by the runtime and the unit tests) ──────────────

/**
 * Where a walker ended relative to its start→end line: `passed` at 75 % or
 * more of the way, `blocked` under 50 %, otherwise `partial`.
 */
export function judgeWalk(start: Vec3, end: Vec3, at: Vec3): { outcome: 'passed' | 'blocked' | 'partial'; progress: number } {
  const dx = end.x - start.x, dz = end.z - start.z, len2 = dx * dx + dz * dz;
  const progress = len2 > 0 ? ((at.x - start.x) * dx + (at.z - start.z) * dz) / len2 : 0;
  const rounded = Math.round(progress * 100) / 100;
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
export function gametestRuntime(mods: RuntimeModules, plan: GametestPlan, arena: Vec3, margin: number, judge: typeof judgeWalk, matches: typeof outcomeMatches): void {
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

  /** Smoke: the framework runs, a simulated player spawns on the arena floor and walks 4 blocks. */
  gt.registerAsync(NS, 'smoke', async (test: any) => {
    const f = floorY(test, 2, 2);
    const sim = test.spawnSimulatedPlayer({ x: 2, y: f.y + 1, z: 2 }, 'cmgt_smoke', gameMode);
    await test.idle(10);
    const from = { ...sim.location };
    const target = test.worldLocation({ x: 6.5, y: f.y + 1, z: 2.5 });
    sim.moveToLocation(target);
    const track: Vec3[] = [];
    for (let i = 0; i < 6; i++) { await test.idle(10); track.push(round(sim.location)); }
    const to = { ...sim.location };
    const moved = Math.sqrt((from.x - to.x) ** 2 + (from.z - to.z) ** 2);
    log('SMOKE', { floorY: f.y, column: f.column, from: round(from), target: round(target), track, movedHorizontally: Math.round(moved * 100) / 100, direction: String(test.getTestDirection()) });
    flush();
    if (moved < 2) test.fail(`simulated player moved only ${moved.toFixed(2)} blocks`); else test.succeed();
  }).structureName(`${NS}:arena_${plan.modelId}`).maxTicks(300).tag(NS);

  /** Doors: place the model with its own placement code, then walk every doorway closed and open. */
  gt.registerAsync(NS, `doors_${plan.modelId}`, async (test: any) => {
    const name = `cmgt_${Math.floor(Math.random() * 1e6)}`;
    const f = floorY(test, margin, margin);
    const anchor = test.worldBlockLocation({ x: margin, y: f.y + 1, z: margin });
    const sim = test.spawnSimulatedPlayer({ x: 1, y: f.y + 1, z: 1 }, name, gameMode);
    log('ARENA', { model: plan.modelId, anchor, floorY: f.y, column: f.column, arena, direction: String(test.getTestDirection()), player: name });
    await test.idle(5);
    system.sendScriptEvent(`${NS}:place`, JSON.stringify({ player: name, x: anchor.x, y: anchor.y, z: anchor.z, rotation: 0, size: 100 }));
    let reply: any;
    for (let t = 0; t < 1200 && !reply; t += 10) { await test.idle(10); reply = placedReplies.get(name); }
    const dim = test.getDimension();
    const spawned = dim.getEntities({ location: add(anchor, { x: plan.dims.width / 2, y: plan.dims.height / 2, z: plan.dims.length / 2 }), maxDistance: Math.max(plan.dims.width, plan.dims.length, plan.dims.height) + 4 }).filter((e: any) => plan.actorTypes.includes(e.typeId));
    log('PLACED', { reply: reply ?? 'timeout', actorsFound: spawned.length, actorsExpected: plan.actorTypes.length });
    if (!reply || reply.error) { flush(); test.fail(`placement did not complete: ${reply ? reply.error : 'no reply in 1200 ticks'}`); return; }
    await test.idle(40); // two interactives sync passes: closed doorways get their colliders

    const walk = async (startW: Vec3, endW: Vec3): Promise<{ outcome: string; progress: number; at: Vec3 }> => {
      sim.teleport(startW, { facingLocation: endW });
      await test.idle(4);
      sim.moveToLocation(endW);
      await test.idle(60);
      sim.stopMoving();
      const at = { ...sim.location };
      const j = judge(startW, endW, at);
      return { outcome: j.outcome, progress: j.progress, at: round(at) };
    };
    const angleOf = (e: any): unknown => { try { return e.getProperty(plan.angleProperty); } catch (err) { return `error: ${String(err)}`; } };

    const results: any[] = [];
    for (const d of plan.doorways) {
      const leafAt = add(anchor, d.actor);
      const leaf = dim.getEntities({ type: d.typeId, location: leafAt, maxDistance: 4 })
        .sort((a: any, b: any) => dist2(a.location, leafAt) - dist2(b.location, leafAt))[0];
      const startW = add(anchor, d.start), endW = add(anchor, d.end);
      const row: any = { label: d.label, offline: d.offlineVerdict, expectClosed: d.expectClosed, expectOpen: d.expectOpen };
      if (!leaf) { row.error = 'leaf entity not found'; results.push(row); log('DOOR', row); continue; }
      try {
        row.angleClosed = angleOf(leaf);
        row.closed = await walk(startW, endW);
        sim.teleport(startW, { facingLocation: leaf.location });
        await test.idle(4);
        sim.lookAtEntity(leaf);
        row.interactReturned = sim.interactWithEntity(leaf);
        await test.idle(20);
        row.angleAfterInteract = angleOf(leaf);
        if (row.angleAfterInteract === row.angleClosed) {
          // playerInteractWithEntity did not toggle it: try the other route the runtime listens to.
          row.attackReturned = sim.attackEntity(leaf);
          await test.idle(20);
          row.angleAfterAttack = angleOf(leaf);
        }
        row.open = await walk(startW, endW);
        row.pass = matches(d.expectClosed, row.closed.outcome) && matches(d.expectOpen, row.open.outcome);
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
  }).structureName(`${NS}:arena_${plan.modelId}`).maxTicks(3000 + plan.doorways.length * 400).tag(NS);

  /** Creator-tooling probe: which /script subcommands a script may run on this device. */
  async function probe(target: string | undefined): Promise<void> {
    const dim = world.getDimension('overworld');
    const tryCmd = (cmd: string): void => {
      try { const r = dim.runCommand(cmd); log('PROBE', { cmd, successCount: r?.successCount }); }
      catch (err) { log('PROBE', { cmd, error: String(err && (err as Error).message || err) }); }
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
    + `(${gametestRuntime.toString()})({ mc, gt }, PLAN, ${JSON.stringify(arena)}, ${GT_MARGIN}, ${judgeWalk.toString()}, ${outcomeMatches.toString()});\n`;
}

/** Every file of the GameTest pack, relative to its folder. */
export function gametestPackFiles(plan: GametestPlan, version: number[]): Array<{ name: string; data: Uint8Array }> {
  const enc = new TextEncoder();
  return [
    { name: 'manifest.json', data: enc.encode(JSON.stringify(gametestManifest(plan, version), null, 2) + '\n') },
    { name: 'scripts/main.js', data: enc.encode(gametestScript(plan)) },
    { name: `structures/${GT_NAMESPACE}/arena_${plan.modelId}.mcstructure`, data: buildArenaStructure(plan.dims) },
  ];
}
