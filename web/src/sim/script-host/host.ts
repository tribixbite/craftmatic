/**
 * The script host: a mock `@minecraft/server` (and `-ui`) over the engine,
 * the pack scripts loaded ALL TOGETHER into it, and the engine system that
 * runs them each tick (after-events first, then the scheduler, then every
 * promise the tick started).
 *
 * One host per engine. The host is the only place scripts touch the world;
 * everything they say lands on the engine's timeline with its source script.
 */

import { ORDER, type SimEngine } from '../core/engine.js';
import type { Timeline } from '../core/timeline.js';
import { copy, type Vec3 } from '../core/vec.js';
import type { SimEntity } from '../entity/entity.js';
import type { ControlState } from '../input/controls.js';
import { behaviorPacks, type Addon } from '../pack/pack.js';
import { quirkValue } from '../quirks/registry.js';
import type { BlockStates } from '../world/block-types.js';
import type { Permutation } from '../world/voxel-world.js';
import { SERVER_EXPORTS, SERVER_TYPES } from './api-catalog.js';
import { runCommand as execCommand } from './commands.js';
import { blockFacade, entityFacade, entityMatches, permutationFacade, setDynamic, sortQuery, type FacadeHost, type PlayerExtra } from './facades.js';
import { callerPack } from './pack-context.js';
import { DynamicStore } from '../entity/dynamic-store.js';
import { ModuleLoader, engineDate, seededMath } from './module-loader.js';
import { Scheduler } from './scheduler.js';
import { createUiModule, type FormChooser } from './ui-module.js';
import { executionMode, guard, unmodelled, unmodelledExport } from './unmodelled.js';
import { enumObject } from './enums.js';

/** Events the host delivers to `world.afterEvents` / `system.afterEvents` subscribers. */
type AfterEventName = 'entityHitEntity' | 'playerInteractWithEntity' | 'itemUse' | 'playerLeave' | 'entitySpawn' | 'entityRemove' | 'playerSpawn' | 'scriptEventReceive' | 'entityLoad' | 'worldLoad';
/** Before-events the host can raise (cancelable). */
type BeforeEventName = 'playerInteractWithEntity' | 'playerInteractWithBlock';

export interface ScriptHostOptions {
  /** `ticks` (default): timeouts wait their ticks. `immediate`: every timeout runs on the next microtask (the older host tests' fast-forward). */
  scheduler?: 'ticks' | 'immediate';
  /** Seed of the scripts' `Math.random`. */
  seed?: number;
  /** Time of day the world reports (Minecraft ticks, 0 = sunrise, 6000 = noon). */
  timeOfDay?: number;
  /** Answers every form (default: cancel). */
  chooser?: FormChooser;
  /**
   * Wrap the `Math` the scripts see (after seeding): an instrument that counts
   * a runtime's work (a test counts `Math.ceil` calls), never a change of result.
   */
  wrapMath?: (math: Math) => Math;
  /**
   * `@minecraft/server` exports the client's module version does NOT have
   * (e.g. `LinearSpline` before the camera splines shipped): a script reads
   * them as `undefined`, exactly as an older game answers a feature probe
   * (`typeof LinearSpline === 'undefined'`), instead of the current mock.
   */
  absentExports?: readonly string[];
}

/** The engine's clock epoch for scripts' `Date.now()` (a fixed instant, so traces repeat). */
const EPOCH_MS = Date.UTC(2026, 8, 30, 12, 0, 0);

/** Let every promise the tick started settle before the next tick. */
const drain = (): Promise<void> => new Promise(r => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));

export class ScriptHost implements FacadeHost {
  readonly timeline: Timeline;
  readonly scheduler: Scheduler;
  readonly stats = new Map<string, number>();
  chooser: FormChooser;
  timeOfDay: number;
  private readonly facades = new Map<SimEntity, Record<string, unknown>>();
  private readonly sims = new WeakMap<object, SimEntity>();
  private readonly dimensions = new Map<string, Record<string, unknown>>();
  private readonly players = new Map<SimEntity, PlayerExtra>();
  private readonly subscribers = new Map<string, Array<(ev: unknown) => void>>();
  private readonly beforeSubscribers = new Map<string, Array<(ev: unknown) => void>>();
  private readonly queue: Array<{ name: AfterEventName; payload: () => unknown }> = [];
  /** The world's dynamic properties, scoped by the writing pack like an entity's (quirk `dynamic-properties-per-pack`). */
  private readonly worldDynamic = new DynamicStore();
  private readonly savedStructures = new Map<string, { size: Vec3; blocks: Array<[number, number, number, Permutation]> }>();
  private readonly serverModule: Record<string, unknown>;
  private readonly uiModule: Record<string, unknown>;
  readonly loaders: ModuleLoader[] = [];

  constructor(readonly engine: SimEngine, readonly controls: ControlState, readonly options: ScriptHostOptions = {}) {
    this.timeline = engine.timeline;
    this.scheduler = new Scheduler(this.timeline, options.scheduler ?? 'ticks', () => engine.tick);
    this.chooser = options.chooser ?? (() => ({ cancel: true }));
    this.timeOfDay = options.timeOfDay ?? 6000;
    this.serverModule = this.buildServerModule();
    this.uiModule = createUiModule(this.timeline, () => this.chooser, p => this.simOf(p)?.id ?? '?', () => engine.tick);
    engine.on('entityHitEntity', e => this.enqueue('entityHitEntity', () => ({ damagingEntity: this.entity(e.damagingEntity), hitEntity: this.entity(e.hitEntity) })));
    engine.on('playerInteractWithEntity', e => this.enqueue('playerInteractWithEntity', () => ({ player: this.entity(e.player), target: this.entity(e.target), beforeItemStack: undefined, itemStack: undefined })));
    engine.on('itemUse', e => this.enqueue('itemUse', () => ({ source: this.entity(e.source), itemStack: guard({ typeId: e.itemTypeId, amount: 1 }, 'ItemStack', this.timeline) })));
    engine.on('scriptEventReceive', e => this.enqueue('scriptEventReceive', () => ({ id: e.id, message: e.message, sourceEntity: e.sourceEntity ? this.entity(e.sourceEntity) : undefined, sourceType: e.sourceEntity ? 'Entity' : 'Server' })));
    engine.on('entitySpawn', e => this.enqueue('entitySpawn', () => ({ entity: this.entity(e.entity), cause: 'Spawned' })));
    engine.on('entityRemove', e => this.enqueue('entityRemove', () => ({ removedEntityId: e.entity.id, typeId: e.entity.typeId })));
    engine.on('entityLoad', e => this.enqueue('entityLoad', () => ({ entity: this.entity(e.entity) })));
    engine.addSystem({ name: 'scripts', order: ORDER.scripts, tick: () => this.tick() });
  }

  /** The module a script importing `name` gets (`@minecraft/server`, `@minecraft/server-ui`, a registered one), or undefined. */
  builtin(name: string): Record<string, unknown> | undefined {
    return name === '@minecraft/server' ? this.serverModule : name === '@minecraft/server-ui' ? this.uiModule : this.modules.get(name);
  }

  /** Modules beyond the server and UI ones (`@minecraft/server-gametest`, script-host/gametest-module.ts). */
  private readonly modules = new Map<string, Record<string, unknown>>();
  /** Make `name` importable (the simulation registers the GameTest module). */
  registerModule(name: string, module: Record<string, unknown>): void { this.modules.set(name, module); }
  /** A GameTest simulated player's own members (the GameTest module sets this; facades.ts adds them). */
  simulatedMembers: ((sim: SimEntity) => Record<string, unknown>) | undefined;

  // ─── Loading ───────────────────────────────────────────────────────────────

  /** Load and start every behaviour pack's scripts (entry modules in pack order, one shared context). */
  loadScripts(addon: Addon): void {
    const console = this.captureConsole();
    for (const pack of behaviorPacks(addon)) {
      if (!pack.scriptEntry) continue;
      const loader = new ModuleLoader(pack, {
        builtin: name => this.builtin(name),
        Math: this.options.wrapMath ? this.options.wrapMath(seededMath(this.options.seed ?? 1)) : seededMath(this.options.seed ?? 1),
        Date: engineDate(() => EPOCH_MS + this.engine.tick * 50),
        console,
        onError: (path, e) => this.timeline.add('script-error', `module ${path}: ${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`, { source: path }),
      });
      this.loaders.push(loader);
      loader.loadEntry();
    }
    // `world.afterEvents.worldLoad`: once per world open, delivered in the first script tick after the scripts
    // loaded (every pack's subscriptions are in by then). Assumed, not measured: the device fires it after world
    // initialisation, once, before any player input; its exact tick relative to `system.run` is not probed.
    if (!this.queue.some(q => q.name === 'worldLoad')) this.enqueue('worldLoad', () => ({}));
  }

  /**
   * Reload every script into a FRESH context over the same world, as a world
   * reopened (or `/reload`) leaves it: subscriptions, timers, jobs, queued
   * events and every module's state are gone; blocks, entities, their tags and
   * dynamic properties, the world's dynamic properties and saved structures
   * stay (they are saved in the world). Facades stay the same objects: a new
   * script reading an entity gets the same handle a test holds.
   */
  reloadScripts(addons: readonly Addon[]): void {
    this.subscribers.clear();
    this.beforeSubscribers.clear();
    this.queue.length = 0;
    this.scheduler.clear();
    this.loaders.length = 0;
    for (const addon of addons) this.loadScripts(addon);
  }

  private captureConsole(): Pick<Console, 'log' | 'warn' | 'error' | 'info' | 'debug'> {
    const line = (level: string) => (...args: unknown[]): void => {
      const src = this.timeline.callerSource();
      this.timeline.add('console', `${level === 'log' ? '' : `[${level}] `}${args.map(a => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(' ')}`, src ? { source: src } : {});
    };
    return { log: line('log'), warn: line('warn'), error: line('error'), info: line('info'), debug: line('debug') };
  }

  // ─── The tick ──────────────────────────────────────────────────────────────

  private enqueue(name: AfterEventName, payload: () => unknown): void { this.queue.push({ name, payload }); }

  /** Deliver an after-event now (the input module's before/after pairs use this). */
  deliver(name: AfterEventName, payload: unknown): void {
    for (const cb of [...(this.subscribers.get(name) ?? [])]) {
      try { this.scheduler.inEventHandler(() => cb(payload)); } catch (e) { this.scheduler.fault(e, `afterEvents.${name}`); }
    }
  }

  /** How many callbacks scripts have subscribed to an after-event (`before`: a before-event) - whether a runtime listens at all. */
  subscriberCount(name: string, before = false): number { return (before ? this.beforeSubscribers : this.subscribers).get(name)?.length ?? 0; }

  /**
   * Fire a before-event; returns true when a subscriber cancelled it. The input module raises
   * `playerInteractWithEntity` (a held press on an entity) and `playerInteractWithBlock` (an item used on a
   * block: payload `{ player, block, blockFace, faceLocation, itemStack, isFirstEvent }` as facades).
   * Each callback runs in restricted-execution (read-only) mode, as on the device: a member the typings forbid there
   * throws (`executionMode`, unmodelled.ts); a script defers the change with `system.run`.
   */
  before(name: BeforeEventName, payload: Record<string, unknown>): boolean {
    const ev = { ...payload, cancel: false };
    for (const cb of [...(this.beforeSubscribers.get(name) ?? [])]) {
      const was = executionMode.restricted;
      executionMode.restricted = true;
      try { this.scheduler.inEventHandler(() => cb(ev)); } catch (e) { this.scheduler.fault(e, `beforeEvents.${name}`); } finally { executionMode.restricted = was; }
    }
    return ev.cancel === true;
  }

  private async tick(): Promise<void> {
    while (this.queue.length) { const q = this.queue.shift()!; this.deliver(q.name, q.payload()); }
    this.scheduler.runDue(this.engine.tick);
    await drain();
  }

  // ─── FacadeHost ────────────────────────────────────────────────────────────

  entity(sim: SimEntity): Record<string, unknown> {
    let f = this.facades.get(sim);
    if (!f) { f = entityFacade(this, sim); this.facades.set(sim, f); this.sims.set(f, sim); }
    return f;
  }

  simOf(api: unknown): SimEntity | undefined { return api && typeof api === 'object' ? this.sims.get(api) : undefined; }

  /** What a script's `Date.now()` answers at the current tick (the engine clock), for a world state that stamps a time. */
  scriptNow(): number { return EPOCH_MS + this.engine.tick * 50; }

  playerState(sim: SimEntity): PlayerExtra {
    let s = this.players.get(sim);
    if (!s) this.players.set(sim, s = { selectedSlot: 0, items: [], camera: { tick: 0 }, permissions: new Map() });
    return s;
  }

  permutation(p: Permutation): Record<string, unknown> { return permutationFacade(this, p); }

  resolvePermutation(typeId: string, states: BlockStates = {}): Permutation {
    const id = typeId.includes(':') ? typeId : `minecraft:${typeId}`;
    const types = this.engine.blockTypes;
    if (!types.exists(id)) throw Object.assign(new Error(`Failed to resolve block permutation: ${id} is not a registered block`), { name: 'Error' });
    const declared = types.declaredStates(id);
    if (declared) {
      for (const [k, v] of Object.entries(states)) {
        const d = declared.get(k);
        if (!d) throw new Error(`Failed to resolve block permutation: ${id} has no state ${k}`);
        const ok = Array.isArray(d) ? d.includes(v) : typeof v === 'number' && v >= d.min && v <= d.max;
        if (!ok) throw new Error(`Failed to resolve block permutation: ${id} state ${k}=${String(v)} is out of range`);
      }
    }
    return this.engine.palette.intern(id, states);
  }

  runCommand(dimension: string, command: string, source?: SimEntity): { successCount: number } { return execCommand(this, dimension, command, source); }

  dimensionApi(id: string): Record<string, unknown> {
    const key = this.engine.dimension(id).id;
    let d = this.dimensions.get(key);
    if (!d) this.dimensions.set(key, d = this.buildDimension(key));
    return d;
  }

  // ─── @minecraft/server ─────────────────────────────────────────────────────

  private signal(name: string, typeName: string, map: Map<string, Array<(ev: unknown) => void>>): Record<string, unknown> {
    return guard({
      subscribe: (cb: (ev: unknown) => void) => { const l = map.get(name) ?? []; l.push(cb); map.set(name, l); return cb; },
      unsubscribe: (cb: (ev: unknown) => void) => { const l = map.get(name) ?? []; const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); },
    }, typeName, this.timeline);
  }

  private buildDimension(id: string): Record<string, unknown> {
    const engine = this.engine, w = engine.dimension(id), timeline = this.timeline;
    const vol = (v: unknown): { from: Vec3; to: Vec3 } | undefined => (v instanceof BlockVolumeImpl ? { from: v.from, to: v.to } : undefined);
    return guard({
      get id() { return id; },
      get heightRange() { return { min: w.heightRange.min, max: w.heightRange.max }; },
      get localizationKey() { return `dimension.${id.replace(/^minecraft:/, '')}`; },
      getBlock: (loc: Vec3) => blockFacade(this, id, loc.x, loc.y, loc.z),
      getEntities: (q?: Record<string, unknown>) => sortQuery(engine.loadedEntities(id).filter(e => entityMatches(e, q ?? {})), q ?? {}).map(e => this.entity(e)),
      getPlayers: (q?: Record<string, unknown>) => sortQuery(engine.players.filter(p => p.valid && p.dimension === id && entityMatches(p, q ?? {})), q ?? {}).map(e => this.entity(e)),
      getEntitiesAtBlockLocation: (loc: Vec3) => engine.loadedEntities(id).filter(e => Math.floor(e.location.x) === Math.floor(loc.x) && Math.floor(e.location.y) === Math.floor(loc.y) && Math.floor(e.location.z) === Math.floor(loc.z)).map(e => this.entity(e)),
      isChunkLoaded: (loc: Vec3) => w.isLoaded(loc.x, loc.z),
      spawnEntity: (typeId: string, loc: Vec3) => {
        const tid = typeId.includes(':') ? typeId : `minecraft:${typeId}`;
        if (!w.isLoaded(loc.x, loc.z)) throw Object.assign(new Error(`Cannot spawn ${tid} at ${loc.x},${loc.y},${loc.z}: the chunk is not loaded`), { name: 'LocationInUnloadedChunkError' });
        return this.entity(engine.spawnEntity(tid, id, copy(loc)));
      },
      spawnParticle: (name: string) => { this.stats.set(`particle ${name}`, (this.stats.get(`particle ${name}`) ?? 0) + 1); },
      playSound: (name: string) => { this.stats.set(`sound ${name}`, (this.stats.get(`sound ${name}`) ?? 0) + 1); },
      runCommand: (cmd: string) => this.runCommand(id, cmd),
      setBlockType: (loc: Vec3, t: string | { id: string }) => { if (!w.isLoaded(loc.x, loc.z)) throw new Error('setBlockType: not loaded'); w.setPermutation(loc.x, loc.y, loc.z, this.resolvePermutation(typeof t === 'string' ? t : t.id)); },
      setBlockPermutation: (loc: Vec3, p: { __perm?: Permutation }) => { if (!p?.__perm) throw new TypeError('setBlockPermutation: not a BlockPermutation'); if (!w.isLoaded(loc.x, loc.z)) throw new Error('setBlockPermutation: not loaded'); w.setPermutation(loc.x, loc.y, loc.z, p.__perm); },
      fillBlocks: (volume: unknown, block: string | { __perm?: Permutation }, options?: { blockFilter?: { includeTypes?: string[]; excludeTypes?: string[] } }) => {
        // quirk fill-volume-limit: a BlockVolume instance, at most 32768 blocks.
        const v = vol(volume);
        if (!v) throw new TypeError('Native type conversion failed: expected BlockVolume');
        const lo = { x: Math.min(v.from.x, v.to.x), y: Math.min(v.from.y, v.to.y), z: Math.min(v.from.z, v.to.z) }, hi = { x: Math.max(v.from.x, v.to.x), y: Math.max(v.from.y, v.to.y), z: Math.max(v.from.z, v.to.z) };
        const n = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1);
        if (n > quirkValue('fill-volume-limit', 'maxBlocks')) throw new Error(`The volume of blocks is too large (${n} > ${quirkValue('fill-volume-limit', 'maxBlocks')})`);
        const p = typeof block === 'string' ? this.resolvePermutation(block) : block?.__perm;
        if (!p) throw new TypeError('fillBlocks: bad block');
        const inc = options?.blockFilter?.includeTypes, exc = options?.blockFilter?.excludeTypes;
        let placed = 0;
        for (let x = lo.x; x <= hi.x; x++) for (let z = lo.z; z <= hi.z; z++) {
          if (!w.isLoaded(x, z)) throw new Error(`fillBlocks: ${x},${z} is not loaded`);
          for (let y = lo.y; y <= hi.y; y++) {
            const cur = w.permutationAt(x, y, z).typeId;
            if (inc && !inc.includes(cur)) continue;
            if (exc && exc.includes(cur)) continue;
            w.setPermutation(x, y, z, p); placed++;
          }
        }
        return guard({ getCapacity: () => placed }, 'ListBlockVolume', timeline);
      },
      getBlockFromRay: () => { throw unmodelled(timeline, 'Dimension.getBlockFromRay'); },
    }, 'Dimension', timeline);
  }

  private buildServerModule(): Record<string, unknown> {
    const host = this, engine = this.engine, timeline = this.timeline;
    const worldAfter = guard(Object.fromEntries((['entityHitEntity', 'playerInteractWithEntity', 'itemUse', 'playerLeave', 'entitySpawn', 'entityRemove', 'playerSpawn', 'entityLoad', 'worldLoad'] as const).map(n => [n, this.signal(n, `${n[0]!.toUpperCase()}${n.slice(1)}AfterEventSignal`, this.subscribers)])), 'WorldAfterEvents', timeline);
    const worldBefore = guard({
      playerInteractWithEntity: this.signal('playerInteractWithEntity', 'PlayerInteractWithEntityBeforeEventSignal', this.beforeSubscribers),
      playerInteractWithBlock: this.signal('playerInteractWithBlock', 'PlayerInteractWithBlockBeforeEventSignal', this.beforeSubscribers),
    }, 'WorldBeforeEvents', timeline);
    const structureManager = guard({
      createFromWorld: (name: string, dim: { id: string }, from: Vec3, to: Vec3) => {
        const w = engine.dimension(dim.id);
        const lo = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) }, hi = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) };
        const blocks: Array<[number, number, number, Permutation]> = [];
        for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) for (let z = lo.z; z <= hi.z; z++) blocks.push([x - lo.x, y - lo.y, z - lo.z, w.permutationAt(x, y, z)]);
        const size = { x: hi.x - lo.x + 1, y: hi.y - lo.y + 1, z: hi.z - lo.z + 1 };
        host.savedStructures.set(name, { size, blocks });
        return guard({ id: name, size, isValid: true }, 'Structure', timeline);
      },
      get: (name: string) => {
        const s = host.savedStructures.get(name);
        if (s) return guard({ id: name, size: { ...s.size }, isValid: true }, 'Structure', timeline);
        const p = engine.structures.get(name);
        return p ? guard({ id: name, size: { ...p.size }, isValid: true }, 'Structure', timeline) : undefined;
      },
      place: (name: string | { id: string }, dim: { id: string }, at: Vec3) => {
        const s = host.savedStructures.get(typeof name === 'string' ? name : name.id);
        if (!s) throw new Error(`structureManager.place: no structure ${String(name)}`);
        const w = engine.dimension(dim.id);
        for (const [x, y, z, p] of s.blocks) w.setPermutation(at.x + x, at.y + y, at.z + z, p);
      },
      delete: (name: string | { id: string }) => host.savedStructures.delete(typeof name === 'string' ? name : name.id),
      getWorldStructureIds: () => [...host.savedStructures.keys()],
      getPackStructureIds: () => [...engine.structures.keys()],
    }, 'StructureManager', timeline);
    const world = guard({
      get afterEvents() { return worldAfter; },
      get beforeEvents() { return worldBefore; },
      get structureManager() { return structureManager; },
      getAllPlayers: () => engine.players.filter(p => p.valid).map(p => host.entity(p)),
      getPlayers: (q?: Record<string, unknown>) => engine.players.filter(p => p.valid && entityMatches(p, q ?? {})).map(p => host.entity(p)),
      getDimension: (id: string) => host.dimensionApi(id),
      getEntity: (id: string) => { const e = engine.entities.get(id); return e && e.valid && engine.isEntityLoaded(e) ? host.entity(e) : undefined; },
      getTimeOfDay: () => host.timeOfDay % 24000,
      setTimeOfDay: (t: number) => { host.timeOfDay = t; },
      getAbsoluteTime: () => host.timeOfDay + engine.tick,
      getDay: () => Math.floor((host.timeOfDay + engine.tick) / 24000),
      sendMessage: (m: unknown) => { timeline.add('chat', typeof m === 'string' ? m : JSON.stringify(m)); },
      getDynamicProperty: (k: string) => host.worldDynamic.getFor(callerPack(), k),
      setDynamicProperty: (k: string, v?: unknown) => { setDynamic(timeline, host.worldDynamic, k, v); },
      getDynamicPropertyIds: () => host.worldDynamic.keysFor(callerPack()),
    }, 'World', timeline);
    const sched = this.scheduler;
    const systemAfter = guard({ scriptEventReceive: this.signal('scriptEventReceive', 'ScriptEventCommandMessageAfterEventSignal', this.subscribers) }, 'SystemAfterEvents', timeline);
    const system = guard({
      get currentTick() { return engine.tick; },
      get afterEvents() { return systemAfter; },
      run: (fn: () => void) => sched.run(fn),
      runTimeout: (fn: () => void, t?: number) => sched.runTimeout(fn, t),
      runInterval: (fn: () => void, t?: number) => sched.runInterval(fn, t),
      runJob: (g: Generator<unknown, unknown, unknown>) => sched.runJob(g),
      clearRun: (id: number) => sched.clearRun(id),
      clearJob: (id: number) => sched.clearJob(id),
      waitTicks: (t: number) => new Promise<void>(r => sched.runTimeout(r, t)),
      sendScriptEvent: (id: string, message: string) => engine.emit('scriptEventReceive', { id, message }),
    }, 'System', timeline);
    const BlockPermutation = { resolve: (id: string, states?: BlockStates) => host.permutation(host.resolvePermutation(id, states)) };
    const implemented: Record<string, unknown> = {
      world, system, BlockPermutation, BlockVolume: BlockVolumeImpl,
      LinearSpline: class LinearSpline { controlPoints: unknown[] = []; },
      CatmullRomSpline: class CatmullRomSpline { controlPoints: unknown[] = []; },
    };
    // Enums: every catalog enum with its REAL values (a numeric enum's numbers, a string enum's ids: the catalog's
    // `values`, read from the typings); a member the typings give no literal for stands for itself.
    for (const [name, t] of Object.entries(SERVER_TYPES)) {
      if (t.kind === 'enum' && SERVER_EXPORTS.includes(name)) implemented[name] = enumObject(t);
    }
    // An export the client's module version lacks reads undefined (`ScriptHostOptions.absentExports`).
    const absent = new Set(this.options.absentExports ?? []);
    return new Proxy(implemented, {
      get(t, prop) {
        if (typeof prop === 'string' && absent.has(prop)) return undefined;
        if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop);
        if (SERVER_EXPORTS.includes(prop)) return unmodelledExport(`@minecraft/server.${prop}`, timeline);
        return undefined;
      },
    });
  }
}

/** `BlockVolume`: a real class, so `instanceof` tells an instance from a plain `{from, to}` (quirk `fill-volume-limit`). */
class BlockVolumeImpl {
  constructor(public from: Vec3, public to: Vec3) {}
  getCapacity(): number { return (Math.abs(this.to.x - this.from.x) + 1) * (Math.abs(this.to.y - this.from.y) + 1) * (Math.abs(this.to.z - this.from.z) + 1); }
  getMin(): Vec3 { return { x: Math.min(this.from.x, this.to.x), y: Math.min(this.from.y, this.to.y), z: Math.min(this.from.z, this.to.z) }; }
  getMax(): Vec3 { return { x: Math.max(this.from.x, this.to.x), y: Math.max(this.from.y, this.to.y), z: Math.max(this.from.z, this.to.z) }; }
  isInside(p: Vec3): boolean { const a = this.getMin(), b = this.getMax(); return p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y && p.z >= a.z && p.z <= b.z; }
}
