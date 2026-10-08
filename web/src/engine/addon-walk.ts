/**
 * A walkable preview of a generated add-on, the PURE half: player motion over
 * the collider world the pack ships, and the questions that otherwise cost a
 * device round ("can a player reach the station?", "what is the highest
 * surface on foot?", "did the treads help?").
 *
 * WHAT THE PLAYER COLLIDES WITH. Exactly the blocks the pack ships at the
 * chosen size and quarter turn: `ScaledColliderGrid` (bedrock-collider-scale.ts)
 * is the runtime's own re-lay arithmetic, and the tread plan is read from the
 * pack (`PlacementColliders.treads`) - or planned with the same planner when a
 * pack predates treads - and written over it exactly as the wand does after
 * its re-lay. Nothing here re-derives the block layout. Under the footprint
 * and around it is the player's own world: a ground plane at y = 0 (the pin
 * plane), the surface the reach walk starts from.
 *
 * PHYSICS: Minecraft's per-tick player (0.6 x 1.8 box, gravity 0.08 with the
 *   0.98 drag, jump 0.42, walk 4.317 blocks/s, ground friction 0.546, the
 *   9/16 auto-step, per-axis collision against the partial `lo`/`hi` collider
 *   boxes and the ground plane). The integrator is the headless simulator's
 *   (`web/src/sim/physics/body.ts`, `tickPlayer`), re-exported here: this
 *   module supplies the WORLD it runs over (`WalkWorld.solidsNear`).
 *
 * PARITY. `walkScaledColliders` (the reach BFS) decides what the size
 * recommendation and the tread plan report. `simulateReach` floods the SAME
 * surface graph with the continuous player instead of the BFS's rise rule,
 * moving between adjacent columns with a small set of input macros (walk,
 * edge tap, jump at several timings) and accepting an edge only when the
 * player STANDS on the target surface. The two are compared surface by
 * surface (`compareReach`); a disagreement means one model is wrong and is
 * reported, never hidden. What the BFS cannot see and the player can:
 *   - stepping up under a low ceiling in the ORIGIN column (the BFS checks
 *     headroom only for a jump);
 *   - dropping INTO a low-headroom column from above (a tunnel is entered
 *     from its mouth, not through its roof);
 *   - a 1.25-block rise at exactly the jump's 0.0022-block margin under a
 *     ceiling that the arc clips.
 *
 * Frame: world blocks from the pin at the chosen size and turn (column x in
 * [0, width), z in [0, length), y up from the pin plane); the ring of ground
 * one block around the footprint is where a walk begins. Model points (a
 * coaster's station, `[24.66, 3.30, 9.26]` in model blocks at 100 % from the
 * model's corner) convert with `modelPointToWorld` / `worldPointToModel`.
 *
 * Pure: no DOM, no Three.js, no Bedrock API - it runs in vitest, a Worker or
 * the page.
 */

import {
  JUMP16, PLAYER_NEED16, STEP16, ScaledColliderGrid, blocksAt100, planColliderTreads, walkScaledColliders,
  type GridDims, type QuarterTurn, type ReachResult, type ReachTarget, type SourceCell, type Surface, type TreadBlock, type TreadPlan,
} from './bedrock-collider-scale.js';
import { NO_INPUT, tickPlayer as simTickPlayer, type Box, type Contact as SimContact, type PlayerState, type SolidQuery, type TickResult as SimTickResult, type WalkInput } from '../sim/physics/body.js';
import { BlockPalette, VoxelWorld, type Permutation, type TerrainGenerator, type WorldSolid } from '../sim/world/voxel-world.js';
import { BlockTypes } from '../sim/world/block-types.js';
import { COLLIDER_KIT, COLLIDER_STATES, colliderBlockDefinition, type ColliderForm } from './collider-form.js';

// ─── Constants: the simulator's player physics (web/src/sim/physics/body.ts) ──

export {
  TICKS_PER_SECOND, GRAVITY, VERTICAL_DRAG, JUMP_VELOCITY, TERMINAL_VELOCITY, WALK_SPEED, SPRINT_FACTOR, SNEAK_FACTOR,
  GROUND_FRICTION, AIR_FRICTION, AIR_ACCELERATION, STEP_HEIGHT, JUMP_PEAK, PLAYER_WIDTH, PLAYER_HEIGHT,
  NO_INPUT, playerBox,
} from '../sim/physics/body.js';
export type { Box, PlayerState, WalkInput } from '../sim/physics/body.js';
/** The collision epsilon (Minecraft's own 1e-7). */
const EPS = 1e-7;

// ─── The world ───────────────────────────────────────────────────────────────

/** A solid box in the world frame (blocks from the pin); `tread` marks an invisible step the plan added. */
export interface SolidBox {
  x0: number; y0: number; z0: number; x1: number; y1: number; z1: number;
  /** The world block this box is (`row` = y block; lo/hi its vertical extent, `v` its clearance form, collider-form.ts); the ground plane has none. */
  block?: { x: number; row: number; z: number; lo: number; hi: number; v?: number };
  tread: boolean;
  ground: boolean;
}

/** Where a world's treads came from. */
export type TreadSource = 'shipped' | 'planned' | 'none';

export interface WalkWorldOptions {
  cells: readonly SourceCell[];
  dims: GridDims;
  sizePct: number;
  rotation: QuarterTurn;
  /**
   * The treads to lay over the re-lay: the pack's own plan (`shipped`, the
   * default; falls back to `none` when the pack carries no plan for this
   * size and turn), a fresh plan by the same planner (`planned`, for packs
   * that predate treads), none, or explicit blocks.
   */
  treads?: 'shipped' | 'planned' | 'none' | readonly TreadBlock[];
  /** The shipped plans, `${sizePct}:${rotation}` → decoded blocks, when `treads` is `shipped`. */
  shippedTreads?: (sizePct: number, rotation: QuarterTurn) => readonly TreadBlock[] | undefined;
  /** Model points a planned tread plan should report on (only used with `treads: 'planned'`). */
  targets?: readonly ReachTarget[];
  /** Static entity collision boxes (standing figures) the LIVE player bumps
   * into; never consulted by the reach BFS. See `EntitySolid`. */
  entitySolids?: readonly EntitySolid[];
}

/** The block under the pin plane: the player's own ground, under and around the footprint. */
const GROUND_BLOCK = 'minecraft:grass_block';

let colliderRegistry: { palette: BlockPalette; types: BlockTypes } | undefined;
/**
 * The block registry every walk world shares: the collider kit's definitions
 * exactly as the pack ships them (`colliderBlockDefinition`), read by the
 * simulator's block reader (`sim/world/block-types.ts`, the device's reading,
 * x mirror included) - so the doorway harness, the walk preview and the
 * simulator take a collider form's boxes from ONE reader of ONE definition.
 * TODO(walk-pack-blocks): a pack built before the x-mirror fix ships other
 * definitions; the walk world reads the current kit's, not the pack's own.
 */
function walkBlockRegistry(): { palette: BlockPalette; types: BlockTypes } {
  if (!colliderRegistry) {
    const types = new BlockTypes();
    for (let v = 0; v < COLLIDER_KIT.VARIANTS.length; v++) types.addDefinition(`blocks/collider_${v}.json`, colliderBlockDefinition(v));
    colliderRegistry = { palette: new BlockPalette(), types };
  }
  return colliderRegistry;
}

/** The collider kit permutation a grid block is laid as (the runtime's lay): its form's variant and states, else the full collider over lo..hi. */
function colliderPermutationOf(b: { lo: number; hi: number; form?: ColliderForm }): { typeId: string; states: Record<string, number> } {
  const f = b.form;
  return { typeId: COLLIDER_KIT.VARIANTS[f ? f.v : 0]!.id, states: { [COLLIDER_STATES.lo]: f ? f.lo : b.lo, [COLLIDER_STATES.hi]: f ? f.hi : b.hi } };
}

/** A collider permutation's facts for a `SolidBox`: its vertical extent (sixteenths) and its form variant (0 = full footprint). */
interface ColliderMeta { lo: number; hi: number; v: number }

/**
 * The collider world at one size and turn: the re-laid grid with its treads
 * written in, and the ground plane under and around it.
 *
 * STORAGE AND COLLISION are the simulator's (`VoxelWorld`): the grid's blocks
 * are the collider kit's permutations (form variant, `lo`/`hi` states) in a
 * voxel world whose terrain is the ground below the pin plane, filled from the
 * re-laid grid section by section as a walk first reads it (a 400 % grid of a
 * large set is too big to lay whole). `solidsNear` is the voxel world's, so the
 * doorway harness's player and the simulator's collide through the same reader.
 */
export class WalkWorld {
  readonly grid: ScaledColliderGrid;
  readonly f: number;
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly treadBlocks: readonly TreadBlock[];
  readonly treadSource: TreadSource;
  /** The plan when the world planned its own treads (refused edges, target results). */
  readonly treadPlan: TreadPlan | undefined;
  private readonly treadKeys = new Set<string>();
  private bfs: ReachResult | undefined;
  private readonly entitySolids: readonly EntitySolid[];
  /** Doors currently toggled open, by an id the caller chooses (a door candidate index, say). */
  private readonly openDoors = new Map<string, OpenDoor>();

  constructor(readonly options: WalkWorldOptions) {
    const { cells, dims, sizePct, rotation } = options;
    if (sizePct < 100) throw new Error(`WalkWorld needs a size of at least 100 % (got ${sizePct}): below it several cells share a block and the re-lay is not the scaled grid`);
    this.f = sizePct / 100;
    this.grid = new ScaledColliderGrid(cells, dims, this.f, rotation);
    this.width = this.grid.width; this.height = this.grid.height; this.length = this.grid.length;
    const want = options.treads ?? 'shipped';
    let blocks: readonly TreadBlock[] = [];
    let source: TreadSource = 'none';
    let plan: TreadPlan | undefined;
    if (Array.isArray(want)) { blocks = want as readonly TreadBlock[]; source = blocks.length ? 'shipped' : 'none'; }
    else if (want === 'shipped') {
      const shipped = options.shippedTreads?.(sizePct, rotation);
      if (shipped && shipped.length) { blocks = shipped; source = 'shipped'; }
    } else if (want === 'planned') {
      plan = planColliderTreads(cells, dims, sizePct, rotation, options.targets ?? []);
      blocks = plan.blocks; source = blocks.length ? 'planned' : 'none';
    }
    for (const b of blocks) {
      this.grid.write(b.x, b.z, { row: b.y, lo: b.lo, hi: b.hi, src16: 0 });
      this.treadKeys.add(`${b.x},${b.y},${b.z}`);
    }
    this.treadBlocks = blocks; this.treadSource = source; this.treadPlan = plan;
    this.entitySolids = options.entitySolids ?? [];
    const { palette, types } = walkBlockRegistry();
    this.palette = palette;
    const grid = this.grid;
    // The terrain IS the laid grid (with its treads) over the ground: a column's block at a row is the collider
    // kit's permutation of its form, and every block under the pin plane is ground.
    const terrain: TerrainGenerator = Object.assign((x: number, y: number, z: number): { typeId: string; states?: Record<string, number> } => {
      if (y < 0) return { typeId: GROUND_BLOCK };
      if (!grid.inside(x, z)) return { typeId: 'minecraft:air' };
      const b = grid.column(x, z).blocks.find(k => k.row === y);
      return b ? colliderPermutationOf(b) : { typeId: 'minecraft:air' };
    }, { materialiseOnRead: true });
    this.voxels = new VoxelWorld('walk', palette, types, terrain);
    this.voxels.setAllLoaded();
  }

  /** The voxel world the walk collides with (the re-laid grid, treads and overlay in it). */
  private readonly voxels: VoxelWorld;
  private readonly palette: BlockPalette;
  /** Collider facts by permutation id (`SolidBox.block`), filled as blocks are met. */
  private readonly metaById = new Map<number, ColliderMeta | null>();
  /** The grid's own permutation under each overlay block, to put back when the overlay changes. */
  private readonly underOverlay = new Map<string, Permutation>();

  get sizePct(): number { return this.options.sizePct; }
  get rotation(): QuarterTurn { return this.options.rotation; }
  get dims(): GridDims { return this.options.dims; }

  /** Whether a world block is a tread the plan added. */
  isTread(x: number, row: number, z: number): boolean { return this.treadKeys.has(`${x},${row},${z}`); }

  /**
   * World blocks laid OVER the shipped grid: a closed door's leaf (the
   * interactives runtime lays those as colliders while it is closed,
   * bedrock-interactives.ts `ixClosedBlocks`), keyed by column then row. A
   * block here replaces the grid's block in that row (the state already
   * merges the static cells there, as the runtime writes it).
   */
  /** Overlay rows by column `"x,z"` (the rows `setOverlayBlocks` wrote), for `boxesInColumn`. */
  private readonly overlayRows = new Map<string, Set<number>>();

  /**
   * Replace the laid-over blocks (keys `"x,row,z"` from the pin, the
   * `ixWorldBlocks` convention: `[lo, hi]` or `[lo, hi, v]` with `v` a
   * clearance form). An empty map clears them. Written into the voxel world
   * as the runtime writes them; the grid's own block comes back when cleared.
   */
  setOverlayBlocks(blocks: ReadonlyMap<string, readonly (number | undefined)[]>): void {
    for (const [key, p] of this.underOverlay) { const [x, y, z] = key.split(',').map(Number) as [number, number, number]; this.voxels.setPermutation(x, y, z, p); }
    this.underOverlay.clear();
    this.overlayRows.clear();
    for (const [key, st] of blocks) {
      const [x, row, z] = key.split(',').map(Number) as [number, number, number];
      if (!this.grid.inside(x, z)) continue;
      const lo = st[0]!, hi = st[1]!, v = st[2] ?? 0;
      if (!this.underOverlay.has(key)) this.underOverlay.set(key, this.voxels.permutationAt(x, row, z));
      const perm = colliderPermutationOf({ lo, hi, ...(v ? { form: { v, lo, hi } } : {}) });
      this.voxels.setPermutation(x, row, z, this.palette.intern(perm.typeId, perm.states));
      const col = `${x},${z}`;
      let rows = this.overlayRows.get(col);
      if (!rows) this.overlayRows.set(col, rows = new Set());
      rows.add(row);
    }
  }

  /**
   * Change some laid-over blocks in place (`setOverlayBlocks`' convention; `null` takes the overlay off that
   * block and puts the grid's own back). The tread planner's lane walk re-lays a few treads between thousands
   * of walks; rewriting the whole overlay each time was most of its cost.
   */
  patchOverlayBlocks(changes: ReadonlyMap<string, readonly (number | undefined)[] | null>): void {
    for (const [key, st] of changes) {
      const [x, row, z] = key.split(',').map(Number) as [number, number, number];
      if (!this.grid.inside(x, z)) continue;
      const col = `${x},${z}`;
      if (!st) {
        const under = this.underOverlay.get(key);
        if (under) { this.voxels.setPermutation(x, row, z, under); this.underOverlay.delete(key); }
        this.overlayRows.get(col)?.delete(row);
        continue;
      }
      const lo = st[0]!, hi = st[1]!, v = st[2] ?? 0;
      if (!this.underOverlay.has(key)) this.underOverlay.set(key, this.voxels.permutationAt(x, row, z));
      const perm = colliderPermutationOf({ lo, hi, ...(v ? { form: { v, lo, hi } } : {}) });
      this.voxels.setPermutation(x, row, z, this.palette.intern(perm.typeId, perm.states));
      let rows = this.overlayRows.get(col);
      if (!rows) this.overlayRows.set(col, rows = new Set());
      rows.add(row);
    }
  }

  /** The collider facts of a permutation (null: not a collider - ground, or air). */
  private metaOf(id: number): ColliderMeta | null {
    let m = this.metaById.get(id);
    if (m !== undefined) return m;
    const p = this.palette.get(id), v = COLLIDER_KIT.variantOf(p.typeId);
    if (v < 0) m = null;
    else {
      const lo = Number(p.states[COLLIDER_STATES.lo]), hi = Number(p.states[COLLIDER_STATES.hi]);
      // A clearance form's vertical extent runs over all its boxes (a floor + wall form's wall reaches the block top).
      const boxes = COLLIDER_KIT.formBoxes(v, lo, hi);
      m = v ? { lo: Math.min(...boxes.map(b => b[2])), hi: Math.max(...boxes.map(b => b[3])), v } : { lo, hi, v: 0 };
    }
    this.metaById.set(id, m);
    return m;
  }

  /**
   * One of the voxel world's solids as a `SolidBox`: the ground's, or a
   * collider form's box with its block's facts and tread flag. Undefined for a
   * block whose span misses [y0, y1] (the grid walk reads a column's blocks by
   * row) or that an open door drops.
   */
  private toSolidBox(s: WorldSolid, y0 = -Infinity, y1 = Infinity): SolidBox | undefined {
    const b = s.block;
    if (!b) return undefined;
    const id = this.voxels.rawId(b.x, b.y, b.z);
    const m = this.metaOf(id);
    if (!m) return b.typeId === GROUND_BLOCK ? { x0: s.x0, y0: s.y0, z0: s.z0, x1: s.x1, y1: s.y1, z1: s.z1, tread: false, ground: true } : undefined;
    const by0 = b.y + m.lo / 16, by1 = b.y + m.hi / 16;
    if (by1 <= y0 || by0 >= y1) return undefined;
    // An open door drops any block of this column whose span the opening covers.
    const open = this.openDoorAt(b.x, b.z);
    if (open && by0 >= open.y0 - EPS && by1 <= open.y1 + EPS) return undefined;
    return { x0: s.x0, y0: s.y0, z0: s.z0, x1: s.x1, y1: s.y1, z1: s.z1, block: { x: b.x, row: b.y, z: b.z, lo: m.lo, hi: m.hi, ...(m.v ? { v: m.v } : {}) }, tread: this.isTread(b.x, b.y, b.z), ground: false };
  }

  /** The solid boxes of one column, row by row (none outside the footprint; the ground plane is separate). Skips a block an open door has dropped. */
  boxesInColumn(x: number, z: number): SolidBox[] {
    if (!this.grid.inside(x, z)) return [];
    const rows = this.grid.column(x, z).blocks.map(b => b.row);
    for (const r of this.overlayRows.get(`${x},${z}`) ?? []) rows.push(r);
    if (!rows.length) return [];
    // A thin probe inside the column over its rows: the voxel world answers this column's blocks only.
    const probe = { x0: x + 0.25, y0: Math.min(...rows), z0: z + 0.25, x1: x + 0.75, y1: Math.max(...rows) + 1, z1: z + 0.75 };
    const out: SolidBox[] = [];
    for (const s of this.voxels.solidsNear(probe, 0, 0, 0)) { const sb = this.toSolidBox(s); if (sb && !sb.ground) out.push(sb); }
    return out;
  }

  /** Every solid box of the laid footprint (for drawing); a 400 % grid of a large set is tens of thousands. */
  solidBoxes(): SolidBox[] {
    const out: SolidBox[] = [];
    for (let x = 0; x < this.width; x++) for (let z = 0; z < this.length; z++) for (const b of this.boxesInColumn(x, z)) out.push(b);
    return out;
  }

  /** The solids a box moving by `(dx, dy, dz)` could meet: the columns it sweeps, the ground plane included. */
  solidsNear(box: Box, dx: number, dy: number, dz: number): SolidBox[] {
    const x0 = Math.floor(Math.min(box.x0, box.x0 + dx) - EPS), x1 = Math.floor(Math.max(box.x1, box.x1 + dx) + EPS);
    const z0 = Math.floor(Math.min(box.z0, box.z0 + dz) - EPS), z1 = Math.floor(Math.max(box.z1, box.z1 + dz) + EPS);
    const y0 = Math.min(box.y0, box.y0 + dy) - EPS, y1 = Math.max(box.y1, box.y1 + dy) + EPS;
    const out: SolidBox[] = [];
    for (const s of this.voxels.solidsNear(box, dx, dy, dz)) { const sb = this.toSolidBox(s, y0, y1); if (sb) out.push(sb); }
    for (const s of this.entitySolids) {
      if (s.x1 <= x0 || s.x0 > x1 + 1 || s.z1 <= z0 || s.z0 > z1 + 1 || s.y1 <= y0 || s.y0 >= y1) continue;
      out.push({ x0: s.x0, y0: s.y0, z0: s.z0, x1: s.x1, y1: s.y1, z1: s.z1, tread: false, ground: false });
    }
    return out;
  }

  /** The open door (if any) whose column is `(x, z)`. */
  private openDoorAt(x: number, z: number): OpenDoor | undefined {
    for (const d of this.openDoors.values()) if (d.x === x && d.z === z) return d;
    return undefined;
  }

  /**
   * Toggle a runtime door candidate's collision: while open, LEGO-brick
   * colliders in the column at `(x, z)` between `y` and `y + heightBlocks`
   * (a vanilla door's own opening, `PlacementActor`'s frame) stop blocking
   * the player, matching the wand swapping that brick-built opening for a
   * real door block once the size reaches the candidate's `requiredSize`.
   * Approximate, stated rather than hidden: it drops every collider block in
   * that COLUMN inside the height band, not only the ones a specific door
   * leaf occupies — sound at 100 % (a door candidate marks a full-column
   * cell-sized opening), and a caller can pass a taller `heightBlocks` if a
   * scaled opening needs it. Never touches `reach()`/`simulated()`, which
   * grade the model by its SHIPPED colliders, door state aside.
   */
  setDoorOpen(id: string, x: number, z: number, y: number, open: boolean, heightBlocks = 2): void {
    if (!open) { this.openDoors.delete(id); return; }
    this.openDoors.set(id, { x: Math.floor(x), z: Math.floor(z), y0: y - EPS, y1: y + heightBlocks + EPS });
  }

  /** Whether a door id is currently toggled open. */
  isDoorOpen(id: string): boolean { return this.openDoors.has(id); }

  /** The reach walk over this world (treads included), memoised. */
  reach(): ReachResult { return this.bfs ??= walkScaledColliders(this.grid); }

  private sims = new Map<string, SimulatedReach>();
  /** The simulated player's flood over this world (`simulateReach`), memoised per edge mode. */
  simulated(options: SimulateReachOptions = {}): SimulatedReach {
    const key = `${options.edges ?? 'bfs'}:${options.tickBudget ?? 0}`;
    let s = this.sims.get(key);
    if (!s) this.sims.set(key, s = simulateReach(this, options));
    return s;
  }
}

/** Build a world from a pack's shipped colliders (already decoded) and tread plans. */
export function buildWalkWorld(options: WalkWorldOptions): WalkWorld { return new WalkWorld(options); }

// ─── Entities the player collides with, and doors that stop blocking ────────

/** A static, non-block solid the player collides with: an entity's own
 * `minecraft:collision_box` (only where the pack's behaviour file declares
 * `has_collision: true` — a standing figure, never a ride car; see
 * `addon-preview-data.ts`'s `entityCollisionFromSources`). World blocks, axis
 * aligned about the entity's placed point; it never affects the reach BFS
 * (`WalkWorld.reach()`/`simulated()` only ever consult the LEGO collider
 * grid), only live player movement, matching what these are: a mob the
 * player bumps into right now, not a structural obstruction the walk-through
 * measurement is judging the model by. */
export interface EntitySolid { key: string; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

/** A door opening the player can toggle: a column at `(x, z)` between `y0`
 * and `y1` (world blocks) whose LEGO-brick colliders stop blocking while
 * open. Approximate rather than exact — see `WalkWorld.setDoorOpen`. */
interface OpenDoor { x: number; z: number; y0: number; y1: number }

// ─── Frames ──────────────────────────────────────────────────────────────────

/** A point in model blocks at 100 % from the model's corner (the frame `PlacementActor` positions and `ReachTarget` use). */
export interface ModelPoint { x: number; y: number; z: number }
/** A point in world blocks from the pin at a size and turn. */
export interface WorldPoint { x: number; y: number; z: number }

/** The runtime's `pointAt` then `× f`: where a model point lands in the laid world at this size and turn. */
export function modelPointToWorld(p: ModelPoint, dims: GridDims, f: number, r: QuarterTurn): WorldPoint {
  const q = r === 90 ? { x: dims.length - p.z, z: p.x } : r === 180 ? { x: dims.width - p.x, z: dims.length - p.z } : r === 270 ? { x: p.z, z: dims.width - p.x } : { x: p.x, z: p.z };
  return { x: q.x * f, y: p.y * f, z: q.z * f };
}

/** Inverse of `modelPointToWorld`. */
export function worldPointToModel(p: WorldPoint, dims: GridDims, f: number, r: QuarterTurn): ModelPoint {
  const qx = p.x / f, qz = p.z / f;
  const m = r === 90 ? { x: qz, z: dims.length - qx } : r === 180 ? { x: dims.width - qx, z: dims.length - qz } : r === 270 ? { x: dims.width - qz, z: qx } : { x: qx, z: qz };
  return { x: m.x, y: p.y / f, z: m.z };
}

// ─── The player: the simulator's integrator over this world ────────────────

/** A solid the move was clipped by (a `SolidBox` of this world), and on which axis. */
export type Contact = SimContact<SolidBox>;
/** One tick's result over this world (`tickPlayer` returns it when called with a `WalkWorld`). */
export type TickResult = SimTickResult<SolidBox>;

/**
 * One tick of the player over a world of `SolidBox`es: the simulator's
 * `tickPlayer` (web/src/sim/physics/body.ts), typed for this module's solids
 * so a caller reads each contact's collider `block`.
 */
export function tickPlayer(world: SolidQuery<SolidBox>, prev: PlayerState, input: WalkInput): TickResult {
  return simTickPlayer(world, prev, input);
}

/** A player standing still with feet at `at` (default: the ring's ground at the footprint's -x, -z corner). */
export function spawnState(_world: WalkWorld, at?: Partial<WorldPoint>): PlayerState {
  return { x: at?.x ?? -0.5, y: at?.y ?? 0, z: at?.z ?? -0.5, vx: 0, vy: 0, vz: 0, onGround: at?.y === undefined || at.y === 0, sneaking: false, tick: 0 };
}

// ─── Moves between surfaces: the macros ──────────────────────────────────────

/** A macro: the input for a tick given the tick index and the state so far, or null to stop early. */
export type Macro = (tick: number, state: PlayerState, arrivedAbove: boolean) => WalkInput | null;

/** The named macros the simulated walk tries for one edge, in order; the first success wins. */
export interface MacroSpec { name: string; macro: Macro; maxTicks: number }

/** The direction from column `a` to column `b` as a unit move vector. */
const towards = (a: Surface, b: Surface): { x: number; z: number } => ({ x: Math.sign(b.x - a.x), z: Math.sign(b.z - a.z) });

/**
 * The macros for moving from `a` onto `b`, adjacent columns. `above` is
 * whether the box's centre is horizontally over `b`: the walk holds its
 * direction until it is airborne over the target (then coasts), the edge tap
 * sneaks to the lip and steps off, and the jumps hold the direction and jump
 * at tick `k` (a run-up) or jump first and move after `j` ticks (a low lintel).
 */
export function edgeMacros(a: Surface, b: Surface): MacroSpec[] {
  const d = towards(a, b);
  const hold: WalkInput = { move: d, jump: false, sneak: false };
  const holdSneak: WalkInput = { move: d, jump: false, sneak: true };
  const holdJump: WalkInput = { move: d, jump: true, sneak: false };
  const jumpOnly: WalkInput = { move: { x: 0, z: 0 }, jump: true, sneak: false };
  const rise = b.t - a.t;
  const out: MacroSpec[] = [];
  const walk: Macro = (_t, s, above) => (above && !s.onGround ? NO_INPUT : hold);
  out.push({ name: 'walk', macro: walk, maxTicks: 40 });
  if (rise <= STEP16) {
    // A drop: sneak to the lip (the sneak guard stops the box there), one tap off it, then coast - the fewest blocks of drift.
    let stalled = 0, tapped = false, px = NaN, pz = NaN;
    out.push({
      name: 'edge-tap', maxTicks: 80,
      macro: (_t, s, above) => {
        if (above || tapped) return NO_INPUT;
        if (s.onGround && Math.abs(s.x - px) + Math.abs(s.z - pz) < 1e-4) stalled++;
        px = s.x; pz = s.z;
        if (stalled >= 2) { tapped = true; return hold; }
        return holdSneak;
      },
    });
    out.push({ name: 'sneak-walk', macro: (_t, _s, above) => (above ? NO_INPUT : holdSneak), maxTicks: 80 });
  }
  if (rise > STEP16 || rise <= 0) {
    for (const k of [0, 1, 2, 3, 4]) out.push({ name: `jump@${k}`, macro: (t, s, above) => (above && !s.onGround ? NO_INPUT : t === k ? holdJump : hold), maxTicks: 50 });
    for (const j of [1, 2, 3, 4, 5, 6]) out.push({ name: `jump-then-move@${j}`, macro: (t, s, above) => (t === 0 ? jumpOnly : t < j ? NO_INPUT : above && !s.onGround ? NO_INPUT : hold), maxTicks: 50 });
  }
  return out;
}

export interface EdgeResult {
  from: Surface; to: Surface;
  ok: boolean;
  /** The macro that succeeded, or the last one tried. */
  macro: string;
  ticks: number;
  /**
   * Why no macro landed. The first two are read off the grid and name what
   * the reach walk's rise rule does not check; the rest are the dominant
   * contact of the attempts.
   *   - `target-column-blocked`: the target column is not clear between the
   *     target's top and the origin's standing height - the surface lies
   *     under a floor or lintel (a drop through a floor, a passage entered
   *     through its roof) - the body cannot get down or across to it;
   *   - `origin-headroom`: a step or jump up whose raised body would meet the
   *     origin column's ceiling (the walk checks this for a jump only);
   *   - `jump-arc-headroom`: a JUMP onto a ledge whose own headroom is within
   *     a sixteenth of the body (10261's station: 1.8125 over the ledge for a
   *     1.8 body): the feet must clear the riser inside that sliver of the arc,
   *     which a jump moving ~0.2 blocks a tick there does not hit. The walk
   *     checks only that the body fits on the ledge. Whether Bedrock's client
   *     lets the jump through is UNMEASURED;
   *   - `ceiling` / `wall` / `overshoot` / `short`: what the attempts met.
   */
  reason?: 'target-column-blocked' | 'origin-headroom' | 'jump-arc-headroom' | 'ceiling' | 'wall' | 'overshoot' | 'short' | 'unknown';
  /** Where the player ended after the last attempt (world frame), for diagnosis. */
  end: WorldPoint;
  /**
   * Every surface an attempt ended STANDING on, targeted or not: a player who
   * drifts one column past a ledge has still reached where it landed, and the
   * flood counts it (distinct, in attempt order).
   */
  landed: Surface[];
}

/**
 * Whether the continuous player, starting at rest on `a`'s column centre,
 * can end STANDING on `b` (feet on its top, box centre over its column)
 * with any of the macros.
 */
export function simulateEdge(world: WalkWorld, a: Surface, b: Surface, macros: readonly MacroSpec[] = edgeMacros(a, b)): EdgeResult {
  const { grid } = world;
  const targetY = b.t / 16;
  const landed: Surface[] = [];
  const landedKeys = new Set<number>();
  /** The surface the player stands on now, if its feet are on a standable top of the column under its centre. */
  const standingOn = (s: PlayerState): Surface | null => {
    if (!s.onGround) return null;
    const x = Math.floor(s.x), z = Math.floor(s.z);
    if (!grid.inRing(x, z)) return null;
    const t = Math.round(s.y * 16);
    if (Math.abs(s.y * 16 - t) > 1e-6 || !grid.surfaces(x, z).includes(t)) return null;
    return { x, z, t };
  };
  const noteLanding = (s: PlayerState): void => {
    const on = standingOn(s);
    if (!on) return;
    const k = grid.key(on.x, on.z, on.t);
    if (!landedKeys.has(k)) { landedKeys.add(k); landed.push(on); }
  };
  let last: EdgeResult | null = null;
  let ceilings = 0, walls = 0, overshoots = 0, shorts = 0;
  for (const m of macros) {
    let s = spawnState(world, { x: a.x + 0.5, y: a.t / 16, z: a.z + 0.5 });
    let sawCeiling = false, sawWall = false;
    // `above` is sticky: once the centre has been over the target column the macro coasts, so a player who
    // drops past a ledge does not walk off wherever it landed (that landing is a reached surface in its own right).
    let above = false;
    let t = 0;
    for (; t < m.maxTicks; t++) {
      above = above || (Math.floor(s.x) === b.x && Math.floor(s.z) === b.z);
      if (s.onGround) noteLanding(s);
      if (above && s.onGround && Math.floor(s.x) === b.x && Math.floor(s.z) === b.z && Math.abs(s.y - targetY) < 1e-6) return { from: a, to: b, ok: true, macro: m.name, ticks: t, end: { x: s.x, y: s.y, z: s.z }, landed };
      const input = m.macro(t, s, above);
      if (input === null) break;
      const r = tickPlayer(world, s, input);
      s = r.state;
      if (r.collided.above) sawCeiling = true;
      if (r.collided.x || r.collided.z) sawWall = true;
    }
    if (s.onGround && Math.floor(s.x) === b.x && Math.floor(s.z) === b.z && Math.abs(s.y - targetY) < 1e-6) { noteLanding(s); return { from: a, to: b, ok: true, macro: m.name, ticks: t, end: { x: s.x, y: s.y, z: s.z }, landed }; }
    // Let the attempt settle (a fall in progress) before reading where it stands.
    for (let extra = 0; extra < 40 && !s.onGround; extra++) s = tickPlayer(world, s, NO_INPUT).state;
    noteLanding(s);
    const passed = Math.abs(s.x - (a.x + 0.5)) > 1.5 || Math.abs(s.z - (a.z + 0.5)) > 1.5;
    if (sawCeiling) ceilings++; else if (passed) overshoots++; else if (sawWall) walls++; else shorts++;
    last = { from: a, to: b, ok: false, macro: m.name, ticks: t, end: { x: s.x, y: s.y, z: s.z }, landed };
  }
  const reason = structuralReason(world, a, b) ?? (ceilings ? 'ceiling' : walls ? 'wall' : overshoots ? 'overshoot' : shorts ? 'short' : 'unknown');
  return last ? { ...last, reason } : { from: a, to: b, ok: false, macro: '-', ticks: 0, reason, end: { x: a.x + 0.5, y: a.t / 16, z: a.z + 0.5 }, landed };
}

/**
 * What the grid says about a move the reach walk allows and the player could
 * not make: the body's own volume in the two columns during the move. The
 * body enters the target column at the origin's height and its top must be
 * clear from the target's top up to there; stepping or jumping, the body
 * rises to the target's height while still over the origin column.
 */
export function structuralReason(world: WalkWorld, a: Surface, b: Surface): 'target-column-blocked' | 'origin-headroom' | 'jump-arc-headroom' | null {
  const { grid } = world;
  if (b.t < a.t && grid.inside(b.x, b.z) && !grid.clear(b.x, b.z, b.t, a.t + PLAYER_NEED16)) return 'target-column-blocked';
  if (b.t > a.t && grid.inside(a.x, a.z) && !grid.clear(a.x, a.z, a.t, b.t + PLAYER_NEED16)) return 'origin-headroom';
  // A jump (above the auto-step) onto a ledge with under a sixteenth to spare over the body: see `EdgeResult.reason`.
  if (b.t - a.t > STEP16 && grid.inside(b.x, b.z) && !grid.clear(b.x, b.z, b.t, b.t + PLAYER_NEED16 + 1)) return 'jump-arc-headroom';
  return null;
}

// ─── The simulated reach ─────────────────────────────────────────────────────

export interface SimulatedReach {
  /** Surface keys (`world.grid.key`) the player reached, ring included. */
  visited: Set<number>;
  /** Reached surfaces / columns inside the footprint and the highest top, as `ReachResult`. */
  surfaces: number;
  columns: number;
  highest16: number;
  /** Edges attempted and edges that landed. */
  edges: { tried: number; ok: number };
  /** For every surface the BFS reaches and the player did not, the attempts made at it (from reached neighbours). */
  failures: Map<number, EdgeResult[]>;
  /** The walk's parent link per reached surface key, for routes. */
  parent: Map<number, number>;
}

export interface SimulateReachOptions {
  /**
   * Which neighbour edges the flood tries: `bfs` (default) only edges the
   * reach walk's rise rule allows, so the simulated set is a subset of the
   * BFS's and every difference is a move the walk allows and the player
   * cannot make; `all` also tries edges the walk refuses whose rise is within
   * the jump, so a move the player can make and the walk refuses shows too.
   */
  edges?: 'bfs' | 'all';
  /** Stop after this many ticks of simulation in total (a guard for huge grids); 0 = unlimited. */
  tickBudget?: number;
}

/**
 * Flood the surface graph with the continuous player from the ring of ground
 * around the footprint, moving between adjacent columns by `simulateEdge`.
 */
export function simulateReach(world: WalkWorld, options: SimulateReachOptions = {}): SimulatedReach {
  const { grid } = world;
  const mode = options.edges ?? 'bfs';
  const visited = new Set<number>();
  const parent = new Map<number, number>();
  const queue: Surface[] = [];
  const failures = new Map<number, EdgeResult[]>();
  let tried = 0, ok = 0, ticks = 0;
  const push = (s: Surface, from: number): void => {
    const k = grid.key(s.x, s.z, s.t);
    if (visited.has(k)) return;
    visited.add(k); parent.set(k, from); queue.push(s);
    failures.delete(k);
  };
  for (let x = -1; x <= grid.width; x++) for (let z = -1; z <= grid.length; z++) {
    if (x !== -1 && z !== -1 && x !== grid.width && z !== grid.length) continue;
    for (const t of grid.surfaces(x, z)) push({ x, z, t }, -1);
  }
  for (let h = 0; h < queue.length; h++) {
    const s = queue[h]!;
    for (const [nx, nz] of [[s.x + 1, s.z], [s.x - 1, s.z], [s.x, s.z + 1], [s.x, s.z - 1]] as const) {
      if (!grid.inRing(nx, nz)) continue;
      for (const t of grid.surfaces(nx, nz)) {
        const k = grid.key(nx, nz, t);
        if (visited.has(k)) continue;
        const allowed = grid.canRise(s.x, s.z, s.t, t);
        if (!allowed && (mode === 'bfs' || t - s.t > JUMP16)) continue;
        // Ring-to-ring moves are the player's own flat ground: never simulated.
        if (!grid.inside(nx, nz) && !grid.inside(s.x, s.z)) { push({ x: nx, z: nz, t }, grid.key(s.x, s.z, s.t)); continue; }
        if (options.tickBudget && ticks > options.tickBudget) continue;
        const r = simulateEdge(world, s, { x: nx, z: nz, t });
        tried++; ticks += r.ticks;
        // Wherever an attempt came to rest is reached, targeted or not.
        for (const l of r.landed) push(l, grid.key(s.x, s.z, s.t));
        if (r.ok) { ok++; continue; }
        let list = failures.get(k);
        if (!list) failures.set(k, list = []);
        list.push(r);
      }
    }
  }
  let surfaces = 0, highest16 = 0;
  const columns = new Set<number>();
  for (const k of visited) {
    const { x, z, t } = grid.unkey(k);
    if (!grid.inside(x, z)) continue;
    surfaces++; columns.add(x * grid.length + z);
    if (t > highest16) highest16 = t;
  }
  return { visited, surfaces, columns: columns.size, highest16, edges: { tried, ok }, failures, parent };
}

/** See `classifyDivergence`; `player-only` is a surface only the player reached (`edges: 'all'`). */
export type DivergenceClass = 'target-column-blocked' | 'origin-headroom' | 'jump-arc-headroom' | 'downstream' | 'unexplained' | 'player-only';

/** One surface the two models disagree on, with what the player tried there. */
export interface Divergence {
  surface: Surface;
  /** Blocks at 100 % (comparable across sizes) of the surface's top. */
  top100: number;
  attempts: EdgeResult[];
  class: DivergenceClass;
}

export interface ReachComparison {
  bfs: Omit<ReachResult, 'visited'>;
  sim: Omit<SimulatedReach, 'visited' | 'failures' | 'parent'>;
  /** Surfaces inside the footprint both reach. */
  agreed: number;
  /** The BFS reaches these and the player does not (the walk is optimistic there). */
  bfsOnly: Divergence[];
  /** The player reaches these and the BFS does not (only with `edges: 'all'`; the walk is pessimistic there). */
  simOnly: Divergence[];
  /** `agreed / (agreed + bfsOnly + simOnly)`, 1 when the models agree everywhere. */
  agreement: number;
  /** Divergences per class (`DivergenceClass`), the honest summary of the disagreement. */
  classes: Record<string, number>;
  highest: { bfs100: number; sim100: number };
}

/** The reach walk against the simulated player, surface by surface, inside the footprint. */
export function compareReach(world: WalkWorld, options: SimulateReachOptions = {}): ReachComparison {
  const bfs = world.reach();
  const sim = world.simulated(options);
  const { grid, f } = world;
  const bfsOnly: Divergence[] = [], simOnly: Divergence[] = [];
  const classes: Record<string, number> = {};
  let agreed = 0;
  for (const k of bfs.visited) {
    const s = grid.unkey(k);
    if (!grid.inside(s.x, s.z)) continue;
    if (sim.visited.has(k)) { agreed++; continue; }
    const d: Divergence = { surface: s, top100: blocksAt100(s.t, f), attempts: sim.failures.get(k) ?? [], class: 'unexplained' };
    d.class = classifyDivergence(world, sim, d);
    classes[d.class] = (classes[d.class] ?? 0) + 1;
    bfsOnly.push(d);
  }
  for (const k of sim.visited) {
    const s = grid.unkey(k);
    if (!grid.inside(s.x, s.z) || bfs.visited.has(k)) continue;
    simOnly.push({ surface: s, top100: blocksAt100(s.t, f), attempts: [], class: 'player-only' });
    classes['player-only'] = (classes['player-only'] ?? 0) + 1;
  }
  const total = agreed + bfsOnly.length + simOnly.length;
  return {
    bfs: { surfaces: bfs.surfaces, columns: bfs.columns, highest16: bfs.highest16 },
    sim: { surfaces: sim.surfaces, columns: sim.columns, highest16: sim.highest16, edges: sim.edges },
    agreed, bfsOnly, simOnly, agreement: total ? agreed / total : 1, classes,
    highest: { bfs100: blocksAt100(bfs.highest16, f), sim100: blocksAt100(sim.highest16, f) },
  };
}

/**
 * What explains a surface the BFS reaches and the player does not:
 *   - `target-column-blocked` / `origin-headroom` / `jump-arc-headroom`: every attempt at it from a
 *     reached neighbour fails a check the reach walk does not make;
 *   - `downstream`: no reached neighbour may move onto it by the walk's own
 *     rule - it lies beyond surfaces that are themselves BFS-only, so it is
 *     cut off by their divergence, not its own;
 *   - `unexplained`: an attempt from a reached neighbour failed for a reason
 *     the grid does not account for - a finding to look at.
 */
export function classifyDivergence(world: WalkWorld, sim: SimulatedReach, d: Divergence): DivergenceClass {
  const { grid } = world;
  if (d.attempts.length) {
    const reasons = new Set(d.attempts.map(a => structuralReason(world, a.from, a.to)));
    if (reasons.has(null)) return 'unexplained';
    return reasons.size === 1 ? [...reasons][0]! : 'target-column-blocked';
  }
  const s = d.surface;
  for (const [nx, nz] of [[s.x + 1, s.z], [s.x - 1, s.z], [s.x, s.z + 1], [s.x, s.z - 1]] as const) {
    if (!grid.inRing(nx, nz)) continue;
    for (const t of grid.surfaces(nx, nz)) if (sim.visited.has(grid.key(nx, nz, t)) && grid.canRise(nx, nz, t, s.t)) return 'unexplained';
  }
  return 'downstream';
}

// ─── The questions ───────────────────────────────────────────────────────────

/** The highest surface a player reaches on foot, by each model. */
export function highestReachable(world: WalkWorld, sim?: SimulatedReach): { bfs: { highest16: number; blocks100: number }; sim?: { highest16: number; blocks100: number } } {
  const bfs = world.reach();
  const out: ReturnType<typeof highestReachable> = { bfs: { highest16: bfs.highest16, blocks100: blocksAt100(bfs.highest16, world.f) } };
  if (sim) out.sim = { highest16: sim.highest16, blocks100: blocksAt100(sim.highest16, world.f) };
  return out;
}

/** Why a target point is not reached, as the nearest reached surface sees it. */
export type TargetRefusal =
  | { kind: 'no-surface'; detail: string }        // no standable surface within a block (at 100 %) of the point's height in the searched columns
  | { kind: 'rise'; detail: string; rise100: number }  // the nearest reached neighbour is more than a jump below
  | { kind: 'headroom'; detail: string }          // a jump would fit but its arc is blocked over the origin
  | { kind: 'isolated'; detail: string }          // no reached surface borders the target's columns at all
  | { kind: 'player'; detail: string };           // the BFS reaches it but the player could not (see `edge`)

export interface PointReach {
  target: ReachTarget;
  /** The world column the point lands in and the search radius around it (`ceil(f)`, one model block). */
  column: { x: number; z: number; radius: number };
  /** The reach walk finds a reached surface within the radius and a block (at 100 %) of the point's height. */
  bfs: boolean;
  /** The simulated player's flood reaches such a surface. */
  sim: boolean;
  /** The route from the ring to the target's surface - the player's own when it reached it, else the BFS's - or empty. */
  route: Surface[];
  /** When the BFS reaches the point and the player does not: the first surface of the BFS route the player never stood on, with its attempts. */
  failedAt?: { surface: Surface; attempts: EdgeResult[]; class: DivergenceClass };
  /** The reached surface nearest the point (by column distance then height), if any is reached at all. */
  nearest: Surface | null;
  nearest100: ModelPoint | null;
  refusal?: TargetRefusal;
}

/** A surface's centre as a model point at 100 %. */
function surfaceToModel(world: WalkWorld, s: Surface): ModelPoint {
  return worldPointToModel({ x: s.x + 0.5, y: s.t / 16, z: s.z + 0.5 }, world.dims, world.f, world.rotation);
}

/** The BFS route (parent links) from the ring to a surface, in the reach walk's own order. */
function routeFrom(world: WalkWorld, goal: Surface): Surface[] {
  const { grid } = world;
  const parent = new Map<number, number>();
  const queue: Surface[] = [];
  const goalKey = grid.key(goal.x, goal.z, goal.t);
  const push = (s: Surface, from: number): void => { const k = grid.key(s.x, s.z, s.t); if (parent.has(k)) return; parent.set(k, from); queue.push(s); };
  for (let x = -1; x <= grid.width; x++) for (let z = -1; z <= grid.length; z++) {
    if (x !== -1 && z !== -1 && x !== grid.width && z !== grid.length) continue;
    for (const t of grid.surfaces(x, z)) push({ x, z, t }, -1);
  }
  for (let h = 0; h < queue.length && !parent.has(goalKey); h++) {
    const s = queue[h]!;
    for (const [nx, nz] of [[s.x + 1, s.z], [s.x - 1, s.z], [s.x, s.z + 1], [s.x, s.z - 1]] as const) {
      if (!grid.inRing(nx, nz)) continue;
      for (const t of grid.surfaces(nx, nz)) if (grid.canRise(s.x, s.z, s.t, t)) push({ x: nx, z: nz, t }, grid.key(s.x, s.z, s.t));
    }
  }
  if (!parent.has(goalKey)) return [];
  const route: Surface[] = [];
  for (let k = goalKey; k !== -1; k = parent.get(k)!) route.unshift(grid.unkey(k));
  return route;
}

/**
 * Can a player reach a model point from the outside at this size? The reach
 * walk's answer (the same test `planColliderTreads` applies to its targets)
 * and the simulated player's, each with its route; when not reached, the
 * nearest reached surface and why the point is refused.
 */
export function reachPoint(world: WalkWorld, target: ReachTarget): PointReach {
  const { grid, f } = world;
  const w = modelPointToWorld(target, world.dims, f, world.rotation);
  const at = { x: Math.floor(w.x), z: Math.floor(w.z) };
  const radius = Math.ceil(f);
  const y16 = Math.round(target.y * f * 16);
  const reach = world.reach();
  const sim = world.simulated();
  const column = { ...at, radius };
  // The reached surface within the radius nearest the point's height, as `targetReached` picks it - per model.
  let goal: Surface | null = null, simGoal: Surface | null = null;
  const candidates: Surface[] = [];
  for (let x = at.x - radius; x <= at.x + radius; x++) for (let z = at.z - radius; z <= at.z + radius; z++) {
    if (!grid.inside(x, z)) continue;
    for (const t of grid.surfaces(x, z)) {
      if (Math.abs(t - y16) > 16 * f) continue;
      candidates.push({ x, z, t });
      const k = grid.key(x, z, t);
      if (reach.visited.has(k) && (goal === null || Math.abs(t - y16) < Math.abs(goal.t - y16))) goal = { x, z, t };
      if (sim.visited.has(k) && (simGoal === null || Math.abs(t - y16) < Math.abs(simGoal.t - y16))) simGoal = { x, z, t };
    }
  }
  // The reached surface nearest the point anywhere, for the "nearest" readout.
  let nearest: Surface | null = null, nearestD = Infinity;
  for (const k of reach.visited) {
    const s = grid.unkey(k);
    if (!grid.inside(s.x, s.z)) continue;
    const d = Math.hypot(s.x + 0.5 - w.x, s.z + 0.5 - w.z) + Math.abs(s.t / 16 - w.y);
    if (d < nearestD) { nearestD = d; nearest = s; }
  }
  const base: PointReach = { target, column, bfs: goal !== null, sim: simGoal !== null, route: [], nearest, nearest100: nearest ? surfaceToModel(world, nearest) : null };
  if (simGoal) {
    // The player's own route: the flood's parent links.
    const route: Surface[] = [];
    for (let k = grid.key(simGoal.x, simGoal.z, simGoal.t); k !== -1; k = sim.parent.get(k)!) route.unshift(grid.unkey(k));
    base.route = route;
    return base;
  }
  if (goal) {
    const route = routeFrom(world, goal);
    base.route = route;
    const first = route.find(s => !sim.visited.has(grid.key(s.x, s.z, s.t)));
    if (first) {
      const attempts = sim.failures.get(grid.key(first.x, first.z, first.t)) ?? [];
      const d: Divergence = { surface: first, top100: blocksAt100(first.t, f), attempts, class: 'unexplained' };
      d.class = classifyDivergence(world, sim, d);
      base.failedAt = { surface: first, attempts, class: d.class };
      base.refusal = { kind: 'player', detail: `the walk's route passes (${first.x}, ${first.z}) at ${blocksAt100(first.t, f)} blocks (at 100 %), which the player never stood on: ${d.class}${attempts.length ? ` (${attempts.map(a => `from (${a.from.x}, ${a.from.z}) at ${blocksAt100(a.from.t, f)}: ${a.reason}`).join('; ')})` : ''}` };
    }
    return base;
  }
  if (!candidates.length) { base.refusal = { kind: 'no-surface', detail: `no standable surface within ${radius} column(s) of (${at.x}, ${at.z}) lies within a block (at 100 %) of height ${target.y.toFixed(2)}` }; return base; }
  // Why: the best reached neighbour of any candidate and what stops the move.
  let best: { rise16: number; headroom: boolean; from: Surface; to: Surface } | null = null;
  for (const c of candidates) for (const [nx, nz] of [[c.x + 1, c.z], [c.x - 1, c.z], [c.x, c.z + 1], [c.x, c.z - 1]] as const) {
    if (!grid.inRing(nx, nz)) continue;
    for (const t of grid.surfaces(nx, nz)) {
      if (!reach.visited.has(grid.key(nx, nz, t))) continue;
      const rise16 = c.t - t;
      const headroom = rise16 <= JUMP16 && rise16 > STEP16 && !grid.clear(nx, nz, t, c.t + PLAYER_NEED16);
      if (!best || rise16 < best.rise16) best = { rise16, headroom, from: { x: nx, z: nz, t }, to: c };
    }
  }
  if (!best) { base.refusal = { kind: 'isolated', detail: `no reached surface borders the ${candidates.length} candidate surface(s) near the point` }; return base; }
  if (best.headroom) base.refusal = { kind: 'headroom', detail: `a ${blocksAt100(best.rise16, f)}-block (at 100 %) jump from (${best.from.x}, ${best.from.z}) would reach it, but the arc above that column is blocked` };
  else base.refusal = { kind: 'rise', rise100: blocksAt100(best.rise16, f), detail: `the nearest reached surface, at (${best.from.x}, ${best.from.z}), is ${(best.rise16 / 16).toFixed(2)} blocks below (${blocksAt100(best.rise16, f)} at 100 %), more than the ${JUMP16 / 16}-block jump` };
  return base;
}

/** The tread plan's own verdict per target (`planColliderTreads`' target results), when the world planned its treads. */
export function plannedTargets(world: WalkWorld): TreadPlan['targets'] | undefined { return world.treadPlan?.targets; }

/** A route as model points at 100 % (surface centres), for a legend or a marker trail. */
export function routeAsModelPoints(world: WalkWorld, route: readonly Surface[]): ModelPoint[] { return route.map(s => surfaceToModel(world, s)); }
