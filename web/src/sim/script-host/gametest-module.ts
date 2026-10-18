/**
 * `@minecraft/server-gametest` in the simulator (TODO(sim-gametest) closed
 * 2026-10-08): the SAME test definitions the Pixel runs (a GameTest variant's
 * `scripts/gametest.js`, web/src/engine/gametest-pack.ts) registered and run
 * offline, writing the same `CMGT` lines the phone's content log gets.
 *
 * Modelled, as the catalog lists them (unmodelled members throw and are
 * recorded, as everywhere in the mock):
 *
 *   - `register` / `registerAsync(className, testName, fn)` and the builder
 *     (`maxTicks`, `structureName`, `tag`, `padding`, `batch`, ... recorded;
 *     `maxTicks` and `structureName` applied by the runner);
 *   - `Test`: `idle`, `succeed`, `fail`, `failIf`, `getDimension`,
 *     `worldLocation`, `worldBlockLocation`, `relativeLocation`,
 *     `relativeBlockLocation`, `getBlock`, `getTestDirection`,
 *     `spawnSimulatedPlayer`, `removeSimulatedPlayer`, `setBlockType`,
 *     `setBlockPermutation`, `spawn`, `isCompleted`, `print`;
 *   - `SimulatedPlayer` (a player facade with the members below; quirk
 *     `gametest-simulated-player`): `attackEntity` (a hit, no reach limit),
 *     `attack` (the view ray: 7 blocks in Creative, 3 in Survival),
 *     `interactWithEntity` (the interact a hold makes), `interact` (the view
 *     ray, 5 blocks), `lookAtEntity`, `lookAtLocation`, `moveToLocation` /
 *     `moveRelative` / `stopMoving` (steering the controls; test-RELATIVE
 *     coordinates, as the Pixel measured), `jump` (none while riding: a
 *     simulated Jump never climbed the rotor), `rotateBody`, `isSneaking` (set:
 *     the sneak), `getGameMode`; its stick never reaches `inputInfo`.
 *
 * The runner (`runGametest`) lays the test's structure (the structure's layer
 * 0 at relative y 1, as the Pixel measured: "relative y = 0 read AIR"), keeps
 * the arena loaded, calls the test function and ticks until it succeeds,
 * fails or reaches `maxTicks`. A simulated player WALKS STRAIGHT at its target
 * with the player integrator: the device's navigation round obstacles is not
 * modelled (quirk gap).
 */

import { ORDER } from '../core/engine.js';
import type { Simulation } from '../core/simulation.js';
import { copy, lookAngles, type Vec3 } from '../core/vec.js';
import type { SimEntity } from '../entity/entity.js';
import { aimPoint, interact, lookAt, pick } from '../input/touch.js';
import { quirkValue } from '../quirks/registry.js';
import { forEachStructureBlock } from '../world/mcstructure.js';
import { GAMETEST_EXPORTS, GAMETEST_TYPES } from './api-catalog.js';
import { enumObject } from './enums.js';
import { callerPack, withPack } from './pack-context.js';
import { blockFacade } from './facades.js';
import { guard, unmodelledExport } from './unmodelled.js';

/** One registered test. */
export interface GametestDefinition {
  className: string;
  testName: string;
  /** `className:testName`, the id `/gametest run` takes. */
  id: string;
  fn: (test: Record<string, unknown>) => unknown;
  async: boolean;
  /** The builder's settings (`maxTicks`, `structureName`, `tag` (all of them), `padding`, ...). */
  settings: { maxTicks?: number; structureName?: string; tags: string[]; [k: string]: unknown };
  /** The pack that registered it (its callbacks run as that pack's code). */
  packKey?: string;
}

/** The tests a world's scripts registered. */
export class GametestRegistry {
  readonly tests: GametestDefinition[] = [];
  find(id: string): GametestDefinition | undefined { return this.tests.find(t => t.id === id || t.testName === id); }
}

/** A simulated player's movement intent, steered each tick (`simulated-players` system). */
interface Steering { to?: Vec3; relative?: { strafe: number; forward: number }; jumpTicks: number }

/** A simulated player's own state beside the engine entity. */
interface SimulatedState { gameMode: string; steering: Steering; /** What `isSneaking` was set to (no sneak edge: it never dismounts). */ sneaking?: boolean }

/** The default `maxTicks` of a GameTest (the framework's). */
export const GAMETEST_DEFAULT_MAX_TICKS = 100;

/**
 * Build `@minecraft/server-gametest` for one simulation, register it with the host, and install the system that
 * steers simulated players. Returns the module object (what `import * as gt` gets).
 */
export function createGametestModule(sim: Simulation, registry: GametestRegistry): Record<string, unknown> {
  const { engine, host, controls } = sim;
  const timeline = engine.timeline;
  const states = new Map<SimEntity, SimulatedState>();

  // Steer every simulated player from its intent, before the players move (quirk `gametest-simulated-player`).
  engine.addSystem({
    name: 'simulated-players', order: ORDER.input, tick: () => {
      for (const [p, st] of states) {
        if (!p.valid) { states.delete(p); continue; }
        const s = st.steering;
        let forward = 0, strafe = 0;
        if (s.to) {
          const dx = s.to.x - p.location.x, dz = s.to.z - p.location.z, d = Math.hypot(dx, dz);
          if (d < 0.25) delete s.to;
          else { p.rotation.y = lookAngles({ x: dx, y: 0, z: dz }).yaw; forward = d < 0.6 ? 0.4 : 1; }
        } else if (s.relative) { forward = s.relative.forward; strafe = s.relative.strafe; }
        const jump = s.jumpTicks > 0;
        if (s.jumpTicks > 0) s.jumpTicks--;
        controls.set(p.id, { forward, strafe, jump });
      }
    },
  });

  /** A simulated player's own members (the facade adds them to its player facade: one object per entity). */
  host.simulatedMembers = (p: SimEntity): Record<string, unknown> => {
    const st = (): SimulatedState => states.get(p) ?? { gameMode: 'Survival', steering: { jumpTicks: 0 } };
    const testOf = (): GametestContext | undefined => contexts.get(p);
    const rel = (loc: Vec3): Vec3 => { const t = testOf(); return t ? t.worldLocation(loc) : copy(loc); };
    const hitWithin = (reach: number): SimEntity | undefined => pick(engine, p, reach).entity;
    return {
      // `isSneaking = true` reads back, but is no sneak: it does not dismount a rider (Pixel quirk probe run 2,
      // `output/gametest-quirks-0930/run2/cmgt.log` QDM: 14 of 14 sneak cases stayed riding; quirk `gametest-simulated-player`).
      get isSneaking() { return st().sneaking === true; },
      set isSneaking(v: boolean) { st().sneaking = !!v; },
      getGameMode: () => st().gameMode,
      attackEntity: (e: unknown) => { const t = host.simOf(e); if (!t) throw new TypeError('attackEntity: not an entity'); engine.emit('entityHitEntity', { damagingEntity: p, hitEntity: t }); return true; },
      attack: () => {
        const reach = st().gameMode === 'Creative' ? quirkValue('gametest-simulated-player', 'attackReachCreative') : quirkValue('gametest-simulated-player', 'attackReachSurvival');
        const t = hitWithin(reach);
        if (t) engine.emit('entityHitEntity', { damagingEntity: p, hitEntity: t });
        return !!t;
      },
      interactWithEntity: (e: unknown) => {
        const t = host.simOf(e);
        if (!t) throw new TypeError('interactWithEntity: not an entity');
        // On a NON-rideable entity it returns true and raises no `playerInteractWithEntity` the pack sees (Pixel GameTest,
        // 41732 run 5: six door leaves WITH `minecraft:interact`, interactEvents 0, a hit toggled each; quirk
        // `gametest-simulated-player`). A rideable it mounts, as a hold does.
        if (!t.rideable()) return true;
        const r = interact(engine, p, t, (pl, tg) => host.before('playerInteractWithEntity', { player: host.entity(pl), target: host.entity(tg) }));
        return !r.cancelled;
      },
      interact: () => {
        const t = hitWithin(quirkValue('gametest-simulated-player', 'interactReach'));
        if (!t) return false;
        const r = interact(engine, p, t, (pl, tg) => host.before('playerInteractWithEntity', { player: host.entity(pl), target: host.entity(tg) }));
        return !r.cancelled;
      },
      lookAtEntity: (e: unknown) => { const t = host.simOf(e); if (t) lookAt(p, aimPoint(p, t)); },
      lookAtLocation: (loc: Vec3) => { lookAt(p, rel(loc)); },
      moveToLocation: (loc: Vec3) => { const s = st().steering; s.to = rel(loc); delete s.relative; return true; },
      moveRelative: (leftRight: number, backwardForward: number, speed = 1) => { const s = st().steering; delete s.to; s.relative = { strafe: leftRight * speed, forward: backwardForward * speed }; },
      stopMoving: () => { const s = st().steering; delete s.to; delete s.relative; controls.set(p.id, { forward: 0, strafe: 0 }); },
      jump: () => {
        // A simulated Jump never climbed the rotor (gametest-pack.ts, Pixel 2026-09-25): riding, it does nothing.
        if (p.ridingOn || !p.onGround) return false;
        st().steering.jumpTicks = 1;
        return true;
      },
      rotateBody: (deg: number) => { p.rotation.y += deg; },
    };
  };

  /** The live test of each simulated player (its relative frame). */
  const contexts = new Map<SimEntity, GametestContext>();

  const builder = (def: GametestDefinition): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    for (const m of GAMETEST_TYPES['RegistrationBuilder']?.members ?? []) {
      b[m] = (v: unknown) => {
        if (m === 'tag') def.settings.tags.push(String(v));
        else def.settings[m] = v;
        return proxy;
      };
    }
    const proxy = guard(b, 'RegistrationBuilder', timeline);
    return proxy;
  };
  const registerAs = (asyncTest: boolean) => (className: string, testName: string, fn: (test: Record<string, unknown>) => unknown): Record<string, unknown> => {
    const pack = callerPack();
    const def: GametestDefinition = { className, testName, id: `${className}:${testName}`, fn, async: asyncTest, settings: { tags: [] }, ...(pack ? { packKey: pack } : {}) };
    registry.tests.push(def);
    return builder(def);
  };

  const implemented: Record<string, unknown> = { register: registerAs(false), registerAsync: registerAs(true) };
  for (const [name, t] of Object.entries(GAMETEST_TYPES)) if (t.kind === 'enum' && GAMETEST_EXPORTS.includes(name)) implemented[name] = enumObject(t);
  const module = new Proxy(implemented, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop);
      if (GAMETEST_EXPORTS.includes(prop)) return unmodelledExport(`@minecraft/server-gametest.${prop}`, timeline);
      return undefined;
    },
  });
  (registry as GametestRegistry & { contexts?: Map<SimEntity, GametestContext>; states?: Map<SimEntity, SimulatedState> }).contexts = contexts;
  (registry as GametestRegistry & { states?: Map<SimEntity, SimulatedState> }).states = states;
  return module;
}

/** What a running test knows: its frame and its outcome. */
interface GametestContext {
  origin: Vec3;
  worldLocation(rel: Vec3): Vec3;
  outcome?: { status: 'pass' | 'fail'; message?: string };
}

/** One test's result. */
export interface GametestRunResult {
  id: string;
  status: 'pass' | 'fail' | 'timeout' | 'error';
  message?: string;
  ticks: number;
  /** Every `CMGT ...` line the test's scripts wrote (the content log's lines without the logger prefix; `CMGT_PAD` dropped). */
  lines: string[];
}

/** Where the runner lays a test's structure (world blocks): the corner of a flat-world area well away from the origin. */
export const GAMETEST_ORIGIN: Vec3 = { x: 1000, y: -61, z: 1000 };

/**
 * Run one registered test: lay its structure (layer 0 at relative y 1), keep the arena loaded, call it, and tick
 * until it succeeds, fails, or passes `maxTicks`. The CMGT lines its scripts wrote meanwhile are returned.
 */
export async function runGametest(sim: Simulation, def: GametestDefinition, origin: Vec3 = GAMETEST_ORIGIN): Promise<GametestRunResult> {
  const { engine, host } = sim;
  const timeline = engine.timeline;
  const registry = sim.gametests as GametestRegistry & { contexts: Map<SimEntity, GametestContext>; states: Map<SimEntity, SimulatedState> };
  const structure = def.settings.structureName ? engine.structures.get(def.settings.structureName) : undefined;
  const size = structure?.size ?? { x: 16, y: 8, z: 16 };
  // The arena (and a margin) stays loaded for the test, as the framework keeps its area ticking.
  engine.tickingAreas.set(`gametest:${def.id}`, { name: `gametest:${def.id}`, dimension: 'minecraft:overworld', x0: origin.x - 32, z0: origin.z - 32, x1: origin.x + size.x + 32, z1: origin.z + size.z + 32 });
  engine.updateLoaded();
  const w = engine.dimension('overworld');
  if (structure) forEachStructureBlock(structure, 0, (dx, dy, dz, b) => {
    let p;
    try { p = host.resolvePermutation(b.typeId, b.states); } catch { p = host.resolvePermutation('minecraft:air'); timeline.add('content-log', `[GameTest] ${def.settings.structureName}: unknown block ${b.typeId} placed as air`); }
    w.setPermutation(origin.x + dx, origin.y + 1 + dy, origin.z + dz, p);
  });
  else if (def.settings.structureName) timeline.add('content-log', `[GameTest] ${def.id}: no structure ${def.settings.structureName}`);
  const ctx: GametestContext = { origin, worldLocation: rel => ({ x: origin.x + rel.x, y: origin.y + rel.y, z: origin.z + rel.z }) };
  const fromWorld = (loc: Vec3): Vec3 => ({ x: loc.x - origin.x, y: loc.y - origin.y, z: loc.z - origin.z });
  const flo = (v: Vec3): Vec3 => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });
  const players: SimEntity[] = [];
  const test = guard({
    idle: (ticks: number) => new Promise<void>(r => host.scheduler.runTimeout(() => r(), Math.max(1, Math.floor(ticks)))),
    succeed: () => { ctx.outcome ??= { status: 'pass' }; },
    fail: (message?: string) => { ctx.outcome ??= { status: 'fail', message: String(message ?? '') }; },
    failIf: (fn: () => void) => { try { fn(); } catch (e) { ctx.outcome ??= { status: 'fail', message: String((e as Error)?.message ?? e) }; } },
    isCompleted: () => !!ctx.outcome,
    print: (text: string) => { timeline.add('console', String(text)); },
    getDimension: () => host.dimensionApi('overworld'),
    getTestDirection: () => 'South',
    worldLocation: (rel: Vec3) => ctx.worldLocation(rel),
    worldBlockLocation: (rel: Vec3) => flo(ctx.worldLocation(rel)),
    relativeLocation: (loc: Vec3) => fromWorld(loc),
    relativeBlockLocation: (loc: Vec3) => flo(fromWorld(loc)),
    getBlock: (rel: Vec3) => { const at = ctx.worldLocation(rel); return blockFacade(host, 'minecraft:overworld', at.x, at.y, at.z); },
    setBlockType: (type: string | { id: string }, rel: Vec3) => { const at = flo(ctx.worldLocation(rel)); w.setPermutation(at.x, at.y, at.z, host.resolvePermutation(typeof type === 'string' ? type : type.id)); },
    setBlockPermutation: (perm: { __perm?: import('../world/voxel-world.js').Permutation }, rel: Vec3) => {
      if (!perm?.__perm) throw new TypeError('setBlockPermutation: not a BlockPermutation');
      const at = flo(ctx.worldLocation(rel)); w.setPermutation(at.x, at.y, at.z, perm.__perm);
    },
    spawn: (type: string, rel: Vec3) => host.entity(engine.spawnEntity(type.includes(':') ? type : `minecraft:${type}`, 'overworld', ctx.worldLocation(rel))),
    spawnSimulatedPlayer: (rel: Vec3, name = 'Simulated Player', gameMode?: string) => {
      const at = ctx.worldLocation(rel);
      const p = engine.addPlayer(String(name), 'overworld', at);
      p.simulated = true;
      registry.states.set(p, { gameMode: gameMode ?? 'Survival', steering: { jumpTicks: 0 } });
      registry.contexts.set(p, ctx);
      players.push(p);
      engine.emit('entitySpawn', { entity: p });
      return host.entity(p);
    },
    removeSimulatedPlayer: (sp: unknown) => { const p = host.simOf(sp); if (p) { engine.removeEntity(p); registry.states.delete(p); registry.contexts.delete(p); } },
  }, 'Test', timeline);
  const from = timeline.entries.length;
  const t0 = engine.tick;
  const maxTicks = Number(def.settings.maxTicks ?? GAMETEST_DEFAULT_MAX_TICKS);
  let thrown: unknown;
  const start = (): unknown => { try { return def.fn(test); } catch (e) { thrown = e; return undefined; } };
  const ret = def.packKey ? withPack(def.packKey, start) : start();
  if (ret && typeof (ret as Promise<unknown>).then === 'function') (ret as Promise<unknown>).then(undefined, e => { thrown = e; });
  while (!ctx.outcome && thrown === undefined && engine.tick - t0 < maxTicks) await engine.step();
  // Let the last lines a test wrote (its summary, the padding) land.
  await engine.step();
  for (const p of players) if (p.valid) { engine.removeEntity(p); registry.states.delete(p); registry.contexts.delete(p); }
  engine.tickingAreas.delete(`gametest:${def.id}`);
  const lines = timeline.entries.slice(from).filter(e => e.kind === 'console' && /\bCMGT\s/.test(e.text) && !/CMGT_PAD/.test(e.text)).map(e => e.text.replace(/^\[\w+\]\s*/, ''));
  const status = thrown !== undefined ? 'error' : ctx.outcome?.status ?? 'timeout';
  const message = thrown !== undefined ? `${(thrown as Error)?.name ?? 'Error'}: ${(thrown as Error)?.message ?? String(thrown)}` : ctx.outcome?.message ?? (status === 'timeout' ? `no verdict in ${maxTicks} ticks` : undefined);
  return { id: def.id, status, ticks: engine.tick - t0, lines, ...(message ? { message } : {}) };
}

