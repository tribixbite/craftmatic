/**
 * The runtime test host: ONE serialised pack runtime (the exact text a
 * generated pack ships) run on the headless simulator (`web/src/sim`) - its
 * `@minecraft/server` mock, its voxel world with the pack's block definitions,
 * its entities from definition JSON, its physics and scheduler - instead of a
 * hand-rolled fake of the slice of the API that runtime happens to call.
 *
 * Every test host in `test/` builds on this (docs/sim-engine.md "Folding the
 * older hosts in"); `test/_placement-host.ts` is the placement wand's own
 * layer over the same engine. It depends on nothing test-runner specific, so
 * the CLI probes in `scripts/` use it too.
 *
 * STRICT by default: `run` throws as soon as a script throws (a `script-error`
 * on the timeline) or reaches an API member the simulator does not model
 * (`unmodelled`), and creating a host throws on a refused definition (a
 * `content-log` line) - the faults a hand-rolled fake used to surface as a
 * TypeError in the test. A test that expects one passes `strict: false` and
 * reads `errors()`.
 *
 * What a test may still do on purpose, as the placement host does: replace a
 * member of a facade (`h.api(e).tryTeleport = ...`) to inject a fault the
 * device can produce (a refused teleport, an unloaded block read), or spy on
 * one. The facade is the object the scripts hold, so the injection is seen
 * exactly where the runtime looks.
 */
import type { TimelineEntry, TimelineKind } from '../web/src/sim/core/timeline.js';
import type { Vec3 } from '../web/src/sim/core/vec.js';
import { Simulation } from '../web/src/sim/core/simulation.js';
import type { SimEntity } from '../web/src/sim/entity/entity.js';
import type { PlayerControls } from '../web/src/sim/input/controls.js';
import { entityDefinition, entityFilePath, fixtureAddon, type EntityDefinitionSpec, type FixtureFile, type FixturePackOptions } from '../web/src/sim/pack/fixture.js';
import type { Addon } from '../web/src/sim/pack/pack.js';
import type { FormChooser } from '../web/src/sim/script-host/ui-module.js';
import type { BlockStates } from '../web/src/sim/world/block-types.js';
import type { Permutation, TerrainGenerator } from '../web/src/sim/world/voxel-world.js';
import { colliderKitFiles } from '../web/src/sim/adapters/craftmatic/fixture.js';
import { bedrockJsonText } from '../web/src/engine/bedrock-json.js';

/** Air everywhere (a test lays what it needs). */
export const AIR_WORLD: TerrainGenerator = Object.assign(() => ({ typeId: 'minecraft:air' }), { verticalOnly: true });

/** Solid `typeId` in every block BELOW `groundY` (its top face is the ground at `groundY`), air above. */
export function solidBelow(groundY: number, typeId = 'minecraft:stone'): TerrainGenerator {
  return Object.assign((_x: number, y: number) => ({ typeId: y < groundY ? typeId : 'minecraft:air' }), { verticalOnly: true });
}

export interface SimHostOptions {
  /** The entry module's source: a serialised runtime with its `import` lines intact. */
  script?: string;
  /** More modules by path from the pack root (`scripts/hop.js`). */
  modules?: Record<string, string>;
  /** The entry module's path (default `scripts/main.js`). */
  entry?: string;
  /** Entity types by identifier: a spec (`entityDefinition`) or a whole JSON document (`{ 'minecraft:entity': ... }`). */
  entities?: Record<string, EntityDefinitionSpec | Record<string, unknown>>;
  /** Any other pack files (block definitions, structures), by path. */
  files?: Record<string, FixtureFile>;
  /** Ship the collider kit's block definitions (every form, `craftmatic:collider*`). */
  colliders?: boolean;
  /** More behaviour packs loaded into the same world, after this one (several packs, one world). */
  packs?: readonly FixturePackOptions[];
  /** Fresh terrain (default: air everywhere). */
  terrain?: TerrainGenerator;
  /**
   * A ticking area over x and z in [-r, r] keeps that square loaded whatever
   * the players do (default 1024, the old hosts' "loaded everywhere"); `false`
   * loads only what players load (a test of unloaded chunks).
   */
  loadRadius?: number | false;
  /**
   * A ticking area over exactly this box of x and z instead of the square
   * `loadRadius` (a test whose world sits far from the origin keeps its loaded
   * area, and the engine's per-tick load bookkeeping, small).
   */
  loadArea?: { x0: number; z0: number; x1: number; z1: number };
  /** `@minecraft/server` exports the client lacks (read as undefined: `ScriptHostOptions.absentExports`). */
  absentExports?: readonly string[];
  /** `ticks` (default) or `immediate` (every timeout on the next microtask: the placement host's fast-forward). */
  scheduler?: 'ticks' | 'immediate';
  seed?: number;
  /** Time of day the world reports (default 6000, noon). */
  timeOfDay?: number;
  chooser?: FormChooser;
  wrapMath?: (math: Math) => Math;
  /** Throw on a script error or an unmodelled member (default true). */
  strict?: boolean;
  /** Do not load the scripts yet (a test that sets the world up first calls `start()`). */
  deferScripts?: boolean;
}

/** An entity type document: a spec is wrapped, a whole document is taken as is. */
function entityDocument(id: string, def: EntityDefinitionSpec | Record<string, unknown>): Record<string, unknown> {
  return 'minecraft:entity' in def ? def as Record<string, unknown> : entityDefinition(id, def as EntityDefinitionSpec);
}

/** The pack a host loads, as fixture options (exported so a test can load the same pack twice). */
export function hostPack(o: SimHostOptions): FixturePackOptions {
  const files: Record<string, FixtureFile> = { ...(o.colliders ? colliderKitFiles() : {}), ...(o.files ?? {}) };
  const entry = o.entry ?? 'scripts/main.js';
  if (o.script !== undefined) files[entry] = o.script;
  for (const [path, text] of Object.entries(o.modules ?? {})) files[path] = text;
  for (const [id, def] of Object.entries(o.entities ?? {})) files[entityFilePath(id)] = entityDocument(id, def);
  // Object files go through the exporter's own JSON writer, so a float default is written as the pack writes it.
  return { name: 'runtime_test', files, json: v => bedrockJsonText(v), ...(o.script !== undefined || o.modules?.[entry] ? { scriptEntry: entry } : {}) };
}

/** A host: the simulation, what the scripts see, and the handles a test drives it with. */
export function simHost(o: SimHostOptions = {}) {
  const sim = new Simulation({
    terrain: o.terrain ?? AIR_WORLD, scheduler: o.scheduler ?? 'ticks',
    ...(o.seed !== undefined ? { seed: o.seed } : {}), ...(o.timeOfDay !== undefined ? { timeOfDay: o.timeOfDay } : {}),
    ...(o.chooser ? { chooser: o.chooser } : {}), ...(o.wrapMath ? { wrapMath: o.wrapMath } : {}),
    ...(o.absentExports ? { absentExports: o.absentExports } : {}),
  });
  const { engine, host } = sim;
  const timeline = engine.timeline;
  const strict = o.strict ?? true;
  const addon: Addon = fixtureAddon([hostPack(o), ...(o.packs ?? [])], 'runtime-test');
  if (o.loadArea) engine.tickingAreas.set('test-world', { name: 'test-world', dimension: 'minecraft:overworld', ...o.loadArea });
  else if (o.loadRadius !== false) {
    const r = o.loadRadius ?? 1024;
    engine.tickingAreas.set('test-world', { name: 'test-world', dimension: 'minecraft:overworld', x0: -r, z0: -r, x1: r, z1: r });
  }
  // Definitions and blocks first; a refused one is a broken fixture.
  sim.addons.push(addon);
  engine.loadAddon(addon);
  engine.updateLoaded();
  const refused = timeline.of('content-log').map(e => e.text);
  if (strict && refused.length) throw new Error(`the host's pack was refused as the game would refuse it:\n  ${refused.join('\n  ')}`);

  /** Timeline entries already reported (strict mode throws once per new fault). */
  let checked = timeline.entries.length;
  const faults = (from = 0): TimelineEntry[] => timeline.entries.slice(from).filter(e => e.kind === 'script-error' || e.kind === 'unmodelled');
  const check = (): void => {
    if (!strict) return;
    const bad = faults(checked);
    checked = timeline.entries.length;
    if (bad.length) throw new Error(`the runtime faulted at tick ${bad[0]!.tick}:\n  ${bad.map(e => `${e.kind}: ${e.text}${e.source ? ` (${e.source})` : ''}`).join('\n  ')}`);
  };
  let started = false;
  const start = (): void => {
    if (started) throw new Error('scripts already started (use reload() to load them again)');
    started = true;
    host.loadScripts(addon);
    check();
  };
  if (!o.deferScripts) start();

  const server = (): Record<string, unknown> => host.builtin('@minecraft/server')!;
  const w = (dim = 'overworld') => engine.dimension(dim);

  return {
    sim, engine, host, timeline, addon,
    /** `world` / `system` as the scripts see them. */
    get world(): any { return server()['world']; },
    get system(): any { return server()['system']; },
    /** A dimension facade (`world.getDimension`). */
    dimension: (id = 'overworld'): any => host.dimensionApi(id),
    /** The facade scripts hold for an engine entity (one object per entity). */
    api: (e: SimEntity): any => host.entity(e),
    /** The engine entity behind a facade. */
    simOf: (api: unknown): SimEntity | undefined => host.simOf(api),
    start,
    /** Reopen the world: every script loaded again into a fresh context over the same blocks and entities. */
    reload: (): void => { sim.reloadScripts(); check(); },

    /** Spawn an entity of a loaded type (the game's spawn: its `minecraft:entity_spawned` event, the after-event). */
    spawn(typeId: string, at: Vec3, s: { dynamic?: Record<string, unknown>; yaw?: number; pitch?: number; tags?: readonly string[]; dimension?: string; /** The entity id (a trace that must repeat names its entities); default the engine's own. */ id?: string } = {}): SimEntity {
      const e = engine.spawnEntity(typeId, s.dimension ?? 'overworld', at, s.id);
      for (const [k, v] of Object.entries(s.dynamic ?? {})) e.dynamic.set(k, v);
      e.rotation = { x: s.pitch ?? 0, y: s.yaw ?? 0 };
      for (const t of s.tags ?? []) e.tags.add(t);
      return e;
    },
    /** A player standing at `at` (default the origin), looking along yaw/pitch, with hotbar items. */
    addPlayer(name = 'Player', at: Vec3 = { x: 0.5, y: 0, z: 0.5 }, s: { yaw?: number; pitch?: number; items?: readonly string[] } = {}): SimEntity {
      const p = sim.addPlayer(name, at, [...(s.items ?? [])]);
      p.rotation = { x: s.pitch ?? 0, y: s.yaw ?? 0 };
      return p;
    },
    /**
     * Put `rider` in `mount`'s first free seat as WORLD STATE (a rider already
     * aboard when the test begins): the seat is taken as if boarded in an
     * earlier tick, so the device's spawn-tick refusal of `addRider` (quirk
     * `add-rider-spawn-tick`) does not apply. Scripts board through the API.
     */
    seat(rider: SimEntity, mount: SimEntity): void {
      const r = mount.addRider(rider, Math.max(engine.tick, mount.spawnTick, rider.spawnTick) + 1);
      if (!r.ok) throw new Error(`cannot seat ${rider.typeId} on ${mount.typeId}: ${r.why}`);
    },
    /** Take `rider` off whatever it rides (no set-down: the test says where it goes). */
    unseat(rider: SimEntity): void { rider.ridingOn?.removeRider(rider); },
    /** Remove an entity from the world (Undo, a kill). */
    remove(e: SimEntity): void { engine.removeEntity(e); },
    /** Hold controls for a player (the move stick, Jump, Sneak). */
    controls(player: SimEntity, c: Partial<PlayerControls>): void { sim.controls.set(player.id, c); },

    /** Lay a block (a vanilla id, or a pack block with its states). */
    setBlock(x: number, y: number, z: number, typeId: string, states: BlockStates = {}, dim = 'overworld'): void { w(dim).setPermutation(x, y, z, host.resolvePermutation(typeId, states)); },
    /** Fill a box of blocks, both corners inclusive. */
    fill(from: Vec3, to: Vec3, typeId: string, states: BlockStates = {}, dim = 'overworld'): void {
      const p = host.resolvePermutation(typeId, states);
      for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++) for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z++) w(dim).setPermutation(x, y, z, p);
    },
    /** The block at a position (loaded or not). */
    block: (x: number, y: number, z: number, dim = 'overworld'): Permutation => w(dim).permutationAt(x, y, z),
    /** Every block written since the world began (runtime or test), `"x,y,z"` → permutation. */
    writes(dim = 'overworld'): Map<string, Permutation> {
      const out = new Map<string, Permutation>();
      for (const k of w(dim).writes.keys()) { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; out.set(k, w(dim).permutationAt(x, y, z)); }
      return out;
    },

    /** Advance `n` ticks (synchronous runtimes: `SimEngine.stepSync`), then throw on a new fault when strict. */
    run(n = 1): void { for (let i = 0; i < n; i++) { engine.stepSync(); check(); } },
    /** Advance `n` ticks awaiting every script promise each tick (forms, `waitTicks`). */
    async runAsync(n = 1): Promise<void> { for (let i = 0; i < n; i++) { await engine.step(); check(); } },
    /** `run` one tick at a time until `done()` holds or `limit` ticks pass; returns the ticks run. */
    runUntil(done: () => boolean, limit = 5000): number { let n = 0; while (!done() && n < limit) { engine.stepSync(); check(); n++; } return n; },

    /** Lines the game said (`actionbar`, `chat`, `console`, ...), optionally for one target. */
    lines: (kind: TimelineKind, target?: string): string[] => timeline.of(kind, target).map(e => e.text),
    /** Script errors and unmodelled members recorded so far. */
    errors: (): string[] => faults().map(e => `${e.kind}: ${e.text}`),
  };
}

export type SimHost = ReturnType<typeof simHost>;
