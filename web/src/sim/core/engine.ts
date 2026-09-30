/**
 * The simulator's engine: one world (dimensions of voxels, entities, players),
 * a tick counter and an ordered list of SYSTEMS that advance it. Everything
 * that makes the world move is a system - loading, input, player and entity
 * physics, riders, the script host - so a new behaviour is a new system, not
 * an edit here.
 *
 * The engine knows nothing about any particular add-on. Content arrives as
 * packs (`loadAddon`): block and entity definitions, structures, scripts.
 */

import { BlockPalette, VoxelWorld, columnsAround, flatTerrain, type TerrainGenerator } from '../world/voxel-world.js';
import { BlockTypes } from '../world/block-types.js';
import { parseMcstructure, type ParsedStructure } from '../world/mcstructure.js';
import { EntityDefinitions } from '../entity/definitions.js';
import { SimEntity } from '../entity/entity.js';
import { Timeline } from './timeline.js';
import { behaviorPacks, packFiles, type Addon, type Pack } from '../pack/pack.js';
import type { Vec3 } from './vec.js';

/** A system: one step of the tick, run in `order`. */
export interface EngineSystem {
  readonly name: string;
  readonly order: number;
  tick(engine: SimEngine): void | Promise<void>;
}

/** Standard system orders (lower runs first). */
export const ORDER = { loading: 0, input: 10, players: 20, mounts: 25, entities: 30, riders: 40, effects: 50, scripts: 60, observers: 90 } as const;

/** A ticking area a script or command added: keeps its chunk columns loaded. */
export interface TickingArea { name: string; dimension: string; x0: number; z0: number; x1: number; z1: number }

/** Engine events the script host turns into `world.afterEvents` (and the input module raises). */
export interface EngineEvents {
  entityHitEntity: { damagingEntity: SimEntity; hitEntity: SimEntity };
  playerInteractWithEntity: { player: SimEntity; target: SimEntity };
  itemUse: { source: SimEntity; itemTypeId: string };
  scriptEventReceive: { id: string; message: string; sourceEntity?: SimEntity };
  entityRemove: { entity: SimEntity };
  entitySpawn: { entity: SimEntity };
  /** A body touched down: how far it fell (from the top of the fall) and whether slow falling was active at any point of it. */
  landed: { entity: SimEntity; fallDistance: number; slowFell: boolean; at: Vec3 };
  /** A rider left its mount (sneak, removal, a teleport), with where it was. */
  dismounted: { rider: SimEntity; mount: SimEntity; cause: 'sneak' | 'teleport' | 'script' | 'removed' };
}
type Listener<K extends keyof EngineEvents> = (ev: EngineEvents[K]) => void;

export interface EngineOptions {
  /** Terrain of new dimensions (default: the QA worlds' superflat). */
  terrain?: TerrainGenerator;
}

export class SimEngine {
  tick = 0;
  readonly timeline = new Timeline();
  readonly palette = new BlockPalette();
  readonly blockTypes = new BlockTypes();
  readonly definitions = new EntityDefinitions();
  readonly structures = new Map<string, ParsedStructure>();
  readonly entities = new Map<string, SimEntity>();
  readonly players: SimEntity[] = [];
  readonly tickingAreas = new Map<string, TickingArea>();
  readonly packs: Pack[] = [];
  private readonly dimensions = new Map<string, VoxelWorld>();
  private readonly systems: EngineSystem[] = [];
  private readonly listeners = new Map<keyof EngineEvents, Array<Listener<keyof EngineEvents>>>();

  constructor(readonly options: EngineOptions = {}) {
    this.addSystem({ name: 'loading', order: ORDER.loading, tick: e => e.updateLoaded() });
  }

  // ─── Content ───────────────────────────────────────────────────────────────

  /** Load an add-on's behaviour packs: block and entity definitions and structures (scripts are the script host's). */
  loadAddon(addon: Addon): void {
    for (const pack of behaviorPacks(addon)) {
      this.packs.push(pack);
      const text = (d: Uint8Array): string => new TextDecoder().decode(d);
      for (const [path, data] of packFiles(pack, 'blocks/', '.json')) {
        try { this.blockTypes.addDefinition(path, JSON.parse(text(data))); }
        catch (e) { this.timeline.add('content-log', `[Blocks] ${path}: ${(e as Error).message}`); }
      }
      for (const [path, data] of packFiles(pack, 'entities/', '.json')) this.definitions.load(path, text(data));
      for (const [path, data] of packFiles(pack, 'structures/', '.mcstructure')) {
        // `structures/<namespace>/<name>.mcstructure` is `<namespace>:<name>`; a file at the root is `mystructure:<name>`.
        const rel = path.slice('structures/'.length, -'.mcstructure'.length).split('/');
        const id = rel.length > 1 ? `${rel[0]}:${rel.slice(1).join('/')}` : `mystructure:${rel[0]}`;
        try { this.structures.set(id, parseMcstructure(data)); }
        catch (e) { this.timeline.add('content-log', `[Structure] ${path}: ${(e as Error).message}`); }
      }
    }
    for (const line of this.definitions.contentLog.splice(0)) this.timeline.add('content-log', line);
    for (const line of this.blockTypes.loadErrors.splice(0)) this.timeline.add('content-log', `[Blocks] ${line}`);
  }

  // ─── Systems and events ────────────────────────────────────────────────────

  addSystem(system: EngineSystem): void {
    this.systems.push(system);
    this.systems.sort((a, b) => a.order - b.order);
  }

  on<K extends keyof EngineEvents>(event: K, listener: Listener<K>): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener<keyof EngineEvents>);
    this.listeners.set(event, list);
  }

  emit<K extends keyof EngineEvents>(event: K, payload: EngineEvents[K]): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }

  /** Advance one tick: every system in order. */
  async step(): Promise<void> {
    this.tick++;
    this.timeline.tick = this.tick;
    for (const s of this.systems) await s.tick(this);
  }

  /** Advance `n` ticks. */
  async run(n: number): Promise<void> { for (let i = 0; i < n; i++) await this.step(); }

  // ─── World ─────────────────────────────────────────────────────────────────

  /** A dimension's voxels (created on first use). Accepts `overworld` or `minecraft:overworld`. */
  dimension(id: string): VoxelWorld {
    const key = id.startsWith('minecraft:') ? id : `minecraft:${id}`;
    let d = this.dimensions.get(key);
    if (!d) this.dimensions.set(key, d = new VoxelWorld(key, this.palette, this.blockTypes, this.options.terrain ?? flatTerrain()));
    return d;
  }

  /** Recompute each dimension's loaded columns from players and ticking areas. */
  updateLoaded(): void {
    const byDim = new Map<string, Set<string>>();
    const cols = (dim: string): Set<string> => { let s = byDim.get(dim); if (!s) byDim.set(dim, s = new Set()); return s; };
    for (const p of this.players) if (p.valid) for (const c of columnsAround(p.location.x, p.location.z)) cols(this.dimension(p.dimension).id).add(c);
    for (const a of this.tickingAreas.values()) {
      const s = cols(this.dimension(a.dimension).id);
      for (let cx = Math.floor(Math.min(a.x0, a.x1)) >> 4; cx <= Math.floor(Math.max(a.x0, a.x1)) >> 4; cx++)
        for (let cz = Math.floor(Math.min(a.z0, a.z1)) >> 4; cz <= Math.floor(Math.max(a.z0, a.z1)) >> 4; cz++) s.add(`${cx},${cz}`);
    }
    for (const [id, d] of this.dimensions) d.setLoaded(byDim.get(id) ?? new Set());
  }

  /** Whether an entity's chunk is loaded (entities outside do not tick and scripts cannot see them, quirk `unloaded-entity-invisible`). */
  isEntityLoaded(e: SimEntity): boolean { return this.dimension(e.dimension).isLoaded(e.location.x, e.location.z); }

  // ─── Entities ──────────────────────────────────────────────────────────────

  /** Spawn an entity of a loaded type; throws as the game does for an unknown type. */
  spawnEntity(typeId: string, dimension: string, at: Vec3): SimEntity {
    const def = this.definitions.get(typeId);
    if (!def) throw new Error(`Invalid entity type: ${typeId} is not a valid entity type`);
    const e = new SimEntity(typeId, this.dimension(dimension).id, at, this.tick, def);
    this.entities.set(e.id, e);
    this.emit('entitySpawn', { entity: e });
    return e;
  }

  /** Add a player standing at a point. */
  addPlayer(name: string, dimension: string, at: Vec3): SimEntity {
    const p = new SimEntity('minecraft:player', this.dimension(dimension).id, at, this.tick - 1, undefined, true);
    p.nameTag = name;
    this.entities.set(p.id, p);
    this.players.push(p);
    this.updateLoaded();
    return p;
  }

  /** Remove an entity: its riders dismount, it leaves any mount. */
  removeEntity(e: SimEntity): void {
    if (!e.valid) return;
    for (const r of e.riderList()) { e.removeRider(r); this.emit('dismounted', { rider: r, mount: e, cause: 'removed' }); }
    e.ridingOn?.removeRider(e);
    e.valid = false;
    this.entities.delete(e.id);
    this.emit('entityRemove', { entity: e });
  }

  /** Loaded, valid entities of a dimension. */
  loadedEntities(dimension?: string): SimEntity[] {
    const d = dimension ? this.dimension(dimension).id : undefined;
    return [...this.entities.values()].filter(e => e.valid && (!d || e.dimension === d) && this.isEntityLoaded(e));
  }
}
