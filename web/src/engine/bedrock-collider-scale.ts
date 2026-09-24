/**
 * The collider grid AT ANOTHER SIZE: what the Brick Wand's re-lay produces
 * from the shipped run-length grid, whether a player can walk it, and the
 * invisible steps ("treads") that restore a climb the scaling broke.
 *
 * Why treads exist. A player stays player-sized at every wand size (figures
 * are capped at 100 %, `figureSizeFactor`), while the model's risers grow
 * with it. A LEGO brick riser is 24 LDU = 0.45 blocks: a step at 100 %, a
 * jump at 200 % (0.9) and, at 300-400 % (1.35-1.8), more than Minecraft's
 * 1.25-block jump - unclimbable. Measured on the coaster (2026-09-21): at 1x
 * the walk reaches platforms 5.56 blocks up via one-block rises; at 200 %
 * those are two-block rises and the highest reachable surface drops to 1.25.
 * The re-lay itself is exact (test/bedrock-collider-scale.test.ts), so this
 * is physics, not a re-lay fault.
 *
 * The decision (user, 2026-09-21): "Invisible geometry that unlocks
 * interactivity and enhances gameplay is almost always desirable. Invisible
 * walls restrict rather than unlock player movement and actions without any
 * reason (sheer bug)." So a tread must UNLOCK movement and may never block
 * it. The rule below is the measurable form of that.
 *
 * THE RULE. A run of treads is planned for exactly one kind of edge:
 *   - `P`: a standing surface the reach walk (from the outside, over
 *     standable surfaces, climbing at most one jump per move - the same walk
 *     `measureSceneAccess` performs) has reached at the chosen size;
 *   - `Q`: a standable surface in a horizontally adjacent column whose rise
 *     from `P` at that size EXCEEDS the jump (the walk cannot make the move),
 *     and which the unassisted walk reaches by NO route (a second step the
 *     first step leads to needs no side hop restored);
 *   - and the same rise in the model's own 100 % grid is AT MOST the jump:
 *     the move a player makes at the scale the set was built for. A rise the
 *     100 % walk could not make is not restored: a sheer wall, a roof, a
 *     decorative ledge higher than a jump stays what it is.
 * The run is laid back from `Q`'s boundary over floor the walk has reached -
 * `P`'s own level, then no higher: a stair's lower step, a landing, the
 * ground before a plinth - so a tread always stands on a surface the player
 * already reaches and is solid down to it (never floating, never bridging a
 * gap). Hops are half a block (`GENTLE_HOP16`, a slab's height, walked up
 * without a jump in every edition) when the floor allows that many treads,
 * else the fewest treads whose hops stay within the jump. A tread keeps the
 * player's full standing headroom above it, so a doorway it sits in stays
 * passable, and a jump-height hop keeps the jump's arc clear.
 *
 * NEVER BLOCK. After planning, the walk is run again from scratch and
 * compared with the walk before any tread: every surface reachable before
 * must still be reachable, the only exception being a floor block that now
 * carries a tread (reachable at the tread's height instead); every tread and
 * every `Q` must be reachable. A plan that would cut a surface off is
 * reverted (`verified: false` on the edge, counted under `unrestored.verify`),
 * so the emitted set of reachable surfaces is a strict superset of the
 * unassisted one whenever any tread is emitted.
 *
 * AT 100 % nothing changes: no rise can exceed the jump at the chosen size
 * while being within it at 100 %, so the planner emits nothing and the
 * structure tiles are untouched (the pipeline never sees the planner).
 *
 * Frame. Everything here is the runtime's own arithmetic (`placeColliders`
 * in bedrock-placement-pack.ts): the turned cell index (`rotatedCell`), the
 * world columns a cell owns at a size (`cellColumns`, centre-in-span at
 * f >= 1), and the per-row sixteenths a scaled span is cut into. Plans are
 * made per size step AND per quarter turn because at a fractional size the
 * column partition is not symmetric under a turn (at 150 % cells alternate
 * one and two blocks wide, and which cells are wide changes with the turn),
 * so a plan for one turn does not rotate into another's.
 */

import { JUMP_HEIGHT_BLOCKS, STEP_HEIGHT_BLOCKS } from './addon-scale.js';
import { PLAYER_HEIGHT_BLOCKS } from './lego-scale.js';

// ─── Collider pairs ───────────────────────────────────────────────────────────

/** Sequential index (1..136) of a `(lo, hi)` sixteenth pair with lo < hi; 0 is air. */
export function colliderPairIndex(lo: number, hi: number): number {
  let n = 1;
  for (let l = 0; l < lo; l++) n += 16 - l;
  return n + (hi - lo - 1);
}

/** Inverse of `colliderPairIndex`. */
export function colliderPairOf(index: number): [number, number] {
  let n = 1;
  for (let l = 0; l < 16; l++) {
    const span = 16 - l;
    if (index < n + span) return [l, l + 1 + (index - n)];
    n += span;
  }
  throw new Error(`collider pair index out of range: ${index}`);
}

// ─── The scaled grid ─────────────────────────────────────────────────────────

/** One solid source cell of the shipped grid: the box [x, x+1] × [y+lo/16, y+hi/16] × [z, z+1] in cells. */
export interface SourceCell { x: number; y: number; z: number; lo: number; hi: number }
export interface GridDims { width: number; height: number; length: number }
/** The quarter turns a pack with blocks may take (`placementRuntime`: block packs turn in 90° steps). */
export type QuarterTurn = 0 | 90 | 180 | 270;
export const QUARTER_TURNS: readonly QuarterTurn[] = [0, 90, 180, 270];

/**
 * The world columns one grid cell owns along an axis at scale `f` - the
 * runtime's `cellColumns`, verbatim: at f >= 1 a column belongs to the cell
 * whose scaled span holds its CENTRE (the wall lands on the nearest block
 * instead of dilating outward); below 100 % every column a cell touches.
 */
export function cellColumns(i: number, f: number): [number, number] {
  const a = i * f, b = (i + 1) * f;
  if (f < 1) return [Math.floor(a), Math.max(Math.floor(a), Math.ceil(b) - 1)];
  return [Math.ceil(a - 0.5), Math.max(Math.ceil(a - 0.5), Math.ceil(b - 0.5) - 1)];
}

/** The cell index a source cell takes after the wand's quarter turn - the runtime's `cellAt`. */
export function rotatedCell(x: number, z: number, dims: GridDims, r: QuarterTurn): { x: number; z: number } {
  if (r === 90) return { x: dims.length - 1 - z, z: x };
  if (r === 180) return { x: dims.width - 1 - x, z: dims.length - 1 - z };
  if (r === 270) return { x: z, z: dims.width - 1 - x };
  return { x, z };
}

/** The source cell that a turned cell index came from (inverse of `rotatedCell`). */
export function sourceCellOf(i: number, j: number, dims: GridDims, r: QuarterTurn): { x: number; z: number } {
  if (r === 90) return { x: j, z: dims.length - 1 - i };
  if (r === 180) return { x: dims.width - 1 - i, z: dims.length - 1 - j };
  if (r === 270) return { x: dims.width - 1 - j, z: i };
  return { x: i, z: j };
}

/** The footprint in whole blocks at scale `f` after turn `r` - the runtime's `dims`. */
export function scaledDims(dims: GridDims, f: number, r: QuarterTurn): GridDims {
  const w = r % 180 ? dims.length : dims.width, l = r % 180 ? dims.width : dims.length;
  return { width: Math.max(1, Math.ceil(w * f)), height: Math.max(1, Math.ceil(dims.height * f)), length: Math.max(1, Math.ceil(l * f)) };
}

/** The player's standing height in sixteenths: the space that must be clear above a surface. */
export const PLAYER_NEED16 = Math.ceil(PLAYER_HEIGHT_BLOCKS * 16);
/** The jump in sixteenths: the most a move between adjacent surfaces may rise. */
export const JUMP16 = Math.round(JUMP_HEIGHT_BLOCKS * 16);
/**
 * The auto-step in sixteenths: a rise up to this is walked; above it the
 * player JUMPS, and a jump needs the arc clear above the column it starts
 * from - the body rises the whole rise while still over that column, so the
 * origin's headroom must be at least the rise plus the player's height
 * (test/bedrock-vertical-scale.test.ts models the same). A one-block ledge
 * under a low ceiling is reachable by neither, however clear the ledge's own
 * headroom is.
 */
export const STEP16 = Math.floor(STEP_HEIGHT_BLOCKS * 16);
/**
 * The preferred tread hop: half a block, a slab's height, which a player
 * walks up without jumping in every edition. The shared `STEP_HEIGHT_BLOCKS`
 * (0.6) is Java's auto-step and is not relied on here.
 */
export const GENTLE_HOP16 = 8;
/** The most treads one run may lay (a 1.25-block rise at 400 % is 80 sixteenths: nine half-block hops). */
export const MAX_TREADS_PER_RUN = 10;
/** Refused edges listed in a plan (the counts are complete; the list is a sample for diagnosis). */
export const MAX_REFUSED_REPORTED = 64;

/** One world block of a scaled column, with the 100 % surface it came from. */
export interface ColumnBlock {
  row: number; lo: number; hi: number;
  /** The source cell's top in sixteenths of a SOURCE block (y·16 + hi) whose scaled top set `hi`; a tread carries the floor's. */
  src16: number;
}

interface Column {
  blocks: ColumnBlock[];
  /** Standable tops (sixteenths above the pin), ascending; computed on demand. */
  surfaces?: number[];
}

/**
 * The grid the runtime lays at one size and turn, evaluated column by column
 * from the source cells (a 400 % grid of a large set is tens of millions of
 * blocks; only the columns the walk visits are ever built). `f` >= 1 only:
 * below 100 % several cells share a block and no rise can exceed a jump.
 */
export class ScaledColliderGrid {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  private readonly columns = new Map<number, Column>();
  private readonly cellsByColumn = new Map<number, SourceCell[]>();
  /** Surface key stride: tops run 0..16·height. */
  private readonly keyT: number;

  constructor(readonly cells: readonly SourceCell[], readonly dims: GridDims, readonly f: number, readonly r: QuarterTurn) {
    if (f < 1) throw new Error(`ScaledColliderGrid needs a size factor of at least 1 (got ${f})`);
    const d = scaledDims(dims, f, r);
    this.width = d.width; this.height = d.height; this.length = d.length;
    this.keyT = 16 * this.height + 1;
    for (const c of cells) {
      const k = c.x * dims.length + c.z;
      let list = this.cellsByColumn.get(k);
      if (!list) this.cellsByColumn.set(k, list = []);
      list.push(c);
    }
  }

  /** Inside the laid footprint (the pad ring around it is the player's own ground). */
  inside(x: number, z: number): boolean { return x >= 0 && z >= 0 && x < this.width && z < this.length; }
  /** Inside the footprint or on the one-block ring around it, where the walk starts. */
  inRing(x: number, z: number): boolean { return x >= -1 && z >= -1 && x <= this.width && z <= this.length; }

  private colKey(x: number, z: number): number { return (x + 1) * (this.length + 2) + (z + 1); }
  /** A surface's identity: its column and its top. */
  key(x: number, z: number, t: number): number { return this.colKey(x, z) * this.keyT + t; }
  /** Column index and top from a surface key. */
  unkey(key: number): { x: number; z: number; t: number } {
    const t = key % this.keyT, col = (key - t) / this.keyT;
    const zz = col % (this.length + 2), xx = (col - zz) / (this.length + 2);
    return { x: xx - 1, z: zz - 1, t };
  }

  /** The blocks of a world column, laid exactly as `placeColliders` lays them. */
  column(x: number, z: number): Column {
    const k = this.colKey(x, z);
    let col = this.columns.get(k);
    if (col) return col;
    col = { blocks: [] };
    this.columns.set(k, col);
    if (!this.inside(x, z)) return col;
    // The turned cell whose scaled span holds this column's centre (f >= 1).
    const i = Math.floor((x + 0.5) / this.f), j = Math.floor((z + 0.5) / this.f);
    const rotW = this.r % 180 ? this.dims.length : this.dims.width, rotL = this.r % 180 ? this.dims.width : this.dims.length;
    if (i >= rotW || j >= rotL) return col;
    const s = sourceCellOf(i, j, this.dims, this.r);
    const rows = new Map<number, ColumnBlock>();
    for (const c of this.cellsByColumn.get(s.x * this.dims.length + s.z) ?? []) {
      const wy0 = (c.y + c.lo / 16) * this.f, wy1 = (c.y + c.hi / 16) * this.f;
      const src16 = c.y * 16 + c.hi;
      for (let wy = Math.floor(wy0); wy < Math.ceil(wy1); wy++) {
        const l = Math.max(0, Math.min(15, Math.floor((wy0 - wy) * 16)));
        const h = Math.max(l + 1, Math.min(16, Math.ceil((wy1 - wy) * 16)));
        const prev = rows.get(wy);
        // A block two cells share keeps min lo / max hi (the runtime's merge); the top's provenance follows the higher hi.
        if (!prev) rows.set(wy, { row: wy, lo: l, hi: h, src16 });
        else { prev.lo = Math.min(prev.lo, l); if (h > prev.hi || (h === prev.hi && src16 > prev.src16)) { prev.hi = h; prev.src16 = src16; } }
      }
    }
    col.blocks = [...rows.values()].sort((p, q) => p.row - q.row);
    return col;
  }

  /** The block in `row` of a column, if solid. */
  blockAt(x: number, z: number, row: number): ColumnBlock | undefined {
    return this.column(x, z).blocks.find(b => b.row === row);
  }

  /** The solid block whose top is exactly `t` (sixteenths), if any; `t` = 0 is the ground, not a block. */
  blockWithTop(x: number, z: number, t: number): ColumnBlock | undefined {
    if (t <= 0) return undefined;
    const row = (t - 1) >> 4;
    const b = this.blockAt(x, z, row);
    return b && row * 16 + b.hi === t ? b : undefined;
  }

  /** True when no solid in the column overlaps the open span (a, b] of sixteenths. */
  clear(x: number, z: number, a: number, b: number): boolean {
    for (const bl of this.column(x, z).blocks) {
      const lo16 = bl.row * 16 + bl.lo, hi16 = bl.row * 16 + bl.hi;
      if (lo16 < b && hi16 > a) return false;
    }
    return true;
  }

  /**
   * The standable tops of a column, ascending: the ground (t = 0, the
   * player's own world under the pin and around it) and every solid's top,
   * each with the player's full height clear above it.
   */
  surfaces(x: number, z: number): number[] {
    const col = this.column(x, z);
    if (col.surfaces) return col.surfaces;
    const out: number[] = [];
    if (this.clear(x, z, 0, PLAYER_NEED16)) out.push(0);
    for (const b of col.blocks) {
      const t = b.row * 16 + b.hi;
      if (this.clear(x, z, t, t + PLAYER_NEED16)) out.push(t);
    }
    col.surfaces = out;
    return out;
  }

  /**
   * Whether a player standing at `t` in a column can rise to `t2` in an
   * adjacent one: a step is walked; a jump needs the arc clear above the
   * origin; more than a jump is never made. Drops are always allowed.
   */
  canRise(x: number, z: number, t: number, t2: number): boolean {
    const rise = t2 - t;
    if (rise <= STEP16) return true;
    if (rise > JUMP16) return false;
    return this.clear(x, z, t, t2 + PLAYER_NEED16);
  }

  /**
   * A move from a surface to one in the ADJACENT column, which is what a walk
   * actually does. `canRise` only judges the origin column, so on its own it
   * let a walk DROP into a neighbour without asking whether the neighbour is
   * passable between the two heights — stepping through that column's own
   * floor into the underpass beneath it. A simulated player walking the same
   * blocks cannot make that move, and neither can one in game: every
   * disagreement between the two models on 10303 and 10261 was this
   * (`addon-walk.ts`, 2026-09-22).
   */
  canMove(x: number, z: number, t: number, nx: number, nz: number, t2: number): boolean {
    if (!this.canRise(x, z, t, t2)) return false;
    // Entering the neighbour at the origin's height and falling to t2: that
    // span of the neighbour column has to be free for the player's body.
    return t2 >= t || this.clear(nx, nz, t2, t + PLAYER_NEED16);
  }

  /** Replace (or add) a block of a column; the column's surfaces are recomputed on the next read. */
  write(x: number, z: number, block: ColumnBlock): void {
    const col = this.column(x, z);
    const at = col.blocks.findIndex(b => b.row === block.row);
    if (at >= 0) col.blocks[at] = block; else { col.blocks.push(block); col.blocks.sort((p, q) => p.row - q.row); }
    col.surfaces = undefined;
  }

  /** Remove a block from a column (undoing a tread's fill row). */
  erase(x: number, z: number, row: number): void {
    const col = this.column(x, z);
    col.blocks = col.blocks.filter(b => b.row !== row);
    col.surfaces = undefined;
  }

  /** Every laid block, for comparison with the runtime's output (tests). Keyed `x,y,z` from the pin, value `[lo, hi]`. */
  allBlocks(): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    for (let x = 0; x < this.width; x++) for (let z = 0; z < this.length; z++) for (const b of this.column(x, z).blocks) out.set(`${x},${b.row},${z}`, [b.lo, b.hi]);
    return out;
  }
}

// ─── The reach walk ──────────────────────────────────────────────────────────

export interface ReachResult {
  /** Surface keys (`grid.key`) reached, including the ring's ground. */
  visited: Set<number>;
  /** Reached surfaces inside the footprint. */
  surfaces: number;
  /** Columns inside the footprint with at least one reached surface. */
  columns: number;
  /** The highest reached top inside the footprint, sixteenths above the pin. */
  highest16: number;
}

/** A surface the walk stands on: a column and its top in sixteenths above the pin. */
export interface Surface { x: number; z: number; t: number }

/**
 * The breadth-first walk over standable surfaces from the ring of ground
 * around the footprint, moving to a neighbouring column's surface at most one
 * jump up (any drop) - the block-grid form of `measureSceneAccess`'s walk.
 * `onBlocked` sees every neighbour surface the walk could NOT climb to, in
 * walk order, with the walk's own visited set; when it returns true it has
 * made that surface reachable (laying treads) and pushed what it laid.
 */
export function walkScaledColliders(
  grid: ScaledColliderGrid,
  onBlocked?: (from: Surface, to: Surface, push: (s: Surface) => void, visited: ReadonlySet<number>) => boolean,
): ReachResult {
  const visited = new Set<number>();
  const queue: Surface[] = [];
  const push = (s: Surface): void => {
    const k = grid.key(s.x, s.z, s.t);
    if (visited.has(k)) return;
    visited.add(k);
    queue.push(s);
  };
  for (let x = -1; x <= grid.width; x++) for (let z = -1; z <= grid.length; z++) {
    if (x !== -1 && z !== -1 && x !== grid.width && z !== grid.length) continue;
    for (const t of grid.surfaces(x, z)) push({ x, z, t });
  }
  for (let h = 0; h < queue.length; h++) {
    const s = queue[h]!;
    for (const [nx, nz] of [[s.x + 1, s.z], [s.x - 1, s.z], [s.x, s.z + 1], [s.x, s.z - 1]] as const) {
      if (!grid.inRing(nx, nz)) continue;
      for (const t of grid.surfaces(nx, nz)) {
        if (visited.has(grid.key(nx, nz, t))) continue;
        if (grid.canMove(s.x, s.z, s.t, nx, nz, t)) { push({ x: nx, z: nz, t }); continue; }
        if (onBlocked && onBlocked(s, { x: nx, z: nz, t }, push, visited)) push({ x: nx, z: nz, t });
      }
    }
  }
  let surfaces = 0, highest16 = 0;
  const columns = new Set<number>();
  for (const k of visited) {
    const { x, z, t } = grid.unkey(k);
    if (!grid.inside(x, z)) continue;
    surfaces++;
    columns.add(x * grid.length + z);
    if (t > highest16) highest16 = t;
  }
  return { visited, surfaces, columns: columns.size, highest16 };
}

// ─── Treads ──────────────────────────────────────────────────────────────────

/** A tread block as it ships: the FINAL collider pair of a world block the run changes. */
export interface TreadBlock { x: number; y: number; z: number; lo: number; hi: number }

/** Why a blocked rise the rule would restore could not be. */
export type UnrestoredReason = 'no-run' | 'headroom' | 'verify';

export interface TreadRun {
  /** The surface the run climbs from and the one it reaches. */
  from: Surface; to: Surface;
  /** The rise in the 100 % grid (source blocks) that qualified the edge, and at this size (blocks). */
  rise100: number; rise: number;
  /** Treads laid and the hop between them, sixteenths. */
  treads: number; hop16: number;
  /** Each tread's column, the floor it stands on and its top (sixteenths), from the one beside `to` back to the landing. */
  columns: Array<{ x: number; z: number; floor16: number; top16: number }>;
}

/**
 * A model point that must be reachable on foot - a coaster's boarding
 * platform, a doorway threshold - in model blocks at 100 % from the model's
 * corner (the frame `PlacementActor` positions use).
 */
export interface ReachTarget { label: string; x: number; y: number; z: number }

export interface ReachTargetResult extends ReachTarget {
  /** The world column the point lands in at this size and turn, and the columns around it searched (radius in blocks). */
  column: { x: number; z: number; radius: number };
  /** A reached surface exists within the radius whose top is within a block (at 100 %) of the point's height. */
  reachedBefore: boolean;
  reachedAfter: boolean;
  /** The reached top nearest the point's height within the radius, blocks at 100 %, after treads; null when none is reached there. */
  nearestAfter: number | null;
}

export interface TreadPlan {
  sizePct: number;
  rotation: QuarterTurn;
  /** The blocks to set after the re-lay, in a deterministic order. */
  blocks: TreadBlock[];
  runs: TreadRun[];
  unrestored: Record<UnrestoredReason, number>;
  /** The first `MAX_REFUSED_REPORTED` edges the rule covered but no run could serve, with why. */
  refused: Array<{ from: Surface; to: Surface; rise100: number; reason: UnrestoredReason }>;
  /**
   * Distinct surfaces the rule wanted restored that stay unreachable with the
   * treads laid - the honest measure of what the planner could not do (a
   * refused edge whose target another column's run reached costs nothing).
   */
  refusedUnreached: number;
  /** The walk before any tread and after them. */
  before: Omit<ReachResult, 'visited'>;
  after: Omit<ReachResult, 'visited'>;
  /**
   * The never-block invariant held: every surface reachable before is
   * reachable after, save floor blocks that now carry a tread, and every
   * tread and restored surface is reachable. False only if even one run at a
   * time could not be verified, in which case `blocks` is empty.
   */
  verified: boolean;
  targets?: ReachTargetResult[];
}

/** The blocks a run writes (final pairs) with what was there, for a revert; `null` = air. */
interface RunEdit {
  writes: Array<{ x: number; z: number; block: ColumnBlock; previous: ColumnBlock | null }>;
  columns: Array<{ x: number; z: number; floor16: number; top16: number }>;
  run: TreadRun;
  to: Surface;
  /** The floor surface before the lowest tread, where the climb starts. */
  landing: Surface;
  treadSurfaces: Surface[];
}

const noVisited = (r: ReachResult): Omit<ReachResult, 'visited'> => ({ surfaces: r.surfaces, columns: r.columns, highest16: r.highest16 });

/** Where a model point lands in the laid grid at this size and turn (the runtime's `pointAt` then `× f`). */
function targetColumn(t: ReachTarget, dims: GridDims, f: number, r: QuarterTurn): { x: number; z: number } {
  const q = r === 90 ? { x: dims.length - t.z, z: t.x } : r === 180 ? { x: dims.width - t.x, z: dims.length - t.z } : r === 270 ? { x: t.z, z: dims.width - t.x } : { x: t.x, z: t.z };
  return { x: Math.floor(q.x * f), z: Math.floor(q.z * f) };
}

/** The reached top nearest a target's height within `radius` columns and a block (at 100 %) of it; null when none. */
function targetReached(grid: ScaledColliderGrid, reach: ReachResult, at: { x: number; z: number }, radius: number, y16: number, f: number): number | null {
  let best: number | null = null;
  for (let x = at.x - radius; x <= at.x + radius; x++) for (let z = at.z - radius; z <= at.z + radius; z++) {
    if (!grid.inside(x, z)) continue;
    for (const t of grid.surfaces(x, z)) {
      if (!reach.visited.has(grid.key(x, z, t)) || Math.abs(t - y16) > 16 * f) continue;
      if (best === null || Math.abs(t - y16) < Math.abs(best - y16)) best = t;
    }
  }
  return best;
}

/**
 * Plan the treads for one size step and quarter turn. Pure: the same cells
 * give the same plan. See the module header for the rule.
 */
export function planColliderTreads(cells: readonly SourceCell[], dims: GridDims, sizePct: number, rotation: QuarterTurn, targets: readonly ReachTarget[] = []): TreadPlan {
  const f = sizePct / 100;
  const unrestored: Record<UnrestoredReason, number> = { 'no-run': 0, headroom: 0, verify: 0 };
  const refused: TreadPlan['refused'] = [];
  const refusedTargets: Surface[] = [];
  const refuse = (p: Surface, q: Surface, reason: UnrestoredReason): void => {
    unrestored[reason]++;
    refusedTargets.push(q);
    if (refused.length < MAX_REFUSED_REPORTED) refused.push({ from: p, to: q, rise100: (q.t - p.t) / 16 / f, reason });
  };
  if (f < 1) {
    // Below 100 % several cells share a block and no rise can exceed the jump; the walk is not defined here.
    const none = { surfaces: 0, columns: 0, highest16: 0 };
    return { sizePct, rotation, blocks: [], runs: [], unrestored, refused, refusedUnreached: 0, before: none, after: none, verified: true };
  }
  const grid = new ScaledColliderGrid(cells, dims, f, rotation);
  const before = walkScaledColliders(grid);
  const report = (after: ReachResult, edits: readonly RunEdit[], verified: boolean): TreadPlan => {
    const finalBlocks = new Map<string, TreadBlock>();
    for (const e of edits) for (const w of e.writes) finalBlocks.set(`${w.x},${w.block.row},${w.z}`, { x: w.x, y: w.block.row, z: w.z, lo: w.block.lo, hi: w.block.hi });
    const blocks = [...finalBlocks.values()].sort((p, q) => p.x - q.x || p.z - q.z || p.y - q.y);
    const radius = Math.ceil(f);
    const targetResults = targets.map((t): ReachTargetResult => {
      const at = targetColumn(t, dims, f, rotation), y16 = Math.round(t.y * f * 16);
      const nearest = targetReached(grid, after, at, radius, y16, f);
      return { ...t, column: { ...at, radius }, reachedBefore: targetReached(grid, before, at, radius, y16, f) !== null, reachedAfter: nearest !== null, nearestAfter: nearest === null ? null : blocksAt100(nearest, f) };
    });
    const unreached = new Set<number>();
    for (const q of refusedTargets) { const k = grid.key(q.x, q.z, q.t); if (!after.visited.has(k)) unreached.add(k); }
    return { sizePct, rotation, blocks, runs: edits.map(e => e.run), unrestored, refused, refusedUnreached: unreached.size, before: noVisited(before), after: noVisited(after), verified, ...(targets.length ? { targets: targetResults } : {}) };
  };
  if (f === 1) return report(before, [], true);

  const treadFloor = new Map<number, number>();   // column key → the floor top a tread replaced there
  const arrivals = new Set<number>();             // columns earlier runs arrive at (their `to` and landing), never converted
  const colKey = (x: number, z: number): number => (x + 1) * (grid.length + 2) + (z + 1);
  const failed = new Set<number>();               // edges refused, never retried
  const edgeKey = (p: Surface, q: Surface): number => grid.key(p.x, p.z, p.t) * 4 + (q.x > p.x ? 0 : q.x < p.x ? 1 : q.z > p.z ? 2 : 3);
  const edits: RunEdit[] = [];

  /**
   * The 100 % rule and the geometry of one run; a reason when the rule applies
   * but the run cannot be laid. A run whose start `p` is the surface an
   * EARLIER run climbed to ABSORBS that run: a ledge one block wide between
   * the ground and a higher surface can only be climbed by one continuous
   * staircase from the ground through the ledge, never by two runs that each
   * need the ledge as their own floor. The earlier run is reverted, the
   * combined run planned over the freed floor, and the earlier run put back
   * unless the combined one is GENTLE (walked without a jump): a steeper
   * merged staircase would replace a gentle climb another column of the same
   * riser already serves, so it is refused instead.
   */
  const planRun = (p: Surface, q: Surface, visited: ReadonlySet<number>): RunEdit | UnrestoredReason | 'no-rule' => {
    const ownerAt = edits.findIndex(e => e.to.x === p.x && e.to.z === p.z && e.to.t === p.t);
    if (ownerAt < 0) return planRunCore(p, q, visited);
    const owner = edits[ownerAt]!;
    revert(owner); edits.splice(ownerAt, 1);
    const result = planRunCore(p, q, visited);
    if (typeof result !== 'string' && result.run.hop16 <= GENTLE_HOP16) return result;
    edits.push(owner); apply(owner);
    return typeof result === 'string' ? result : 'no-run';
  };
  const planRunCore = (p: Surface, q: Surface, visited: ReadonlySet<number>): RunEdit | UnrestoredReason | 'no-rule' => {
    // A tread is reached by its own run and is never a target; a column another run arrives at (its
    // `to` or its landing) is never converted, so a later run cannot break an earlier one's approach.
    if (!grid.inside(q.x, q.z) || treadFloor.has(colKey(q.x, q.z))) return 'no-rule';
    const qb = grid.blockWithTop(q.x, q.z, q.t);
    if (!qb) return 'no-rule';
    const pSrc = p.t > 0 ? grid.blockWithTop(p.x, p.z, p.t)?.src16 : 0;
    if (pSrc === undefined) return 'no-rule';
    const rise100 = (qb.src16 - pSrc) / 16;
    if (rise100 > JUMP_HEIGHT_BLOCKS + 1e-9) return 'no-rule';
    const rise16 = q.t - p.t;
    const dx = p.x - q.x, dz = p.z - q.z;
    // The straight run of REACHABLE floor back from p, away from q: each column's highest reached surface no
    // higher than the one before it (p's own level, a lower step, the ground before a plinth), inside the
    // footprint and clear of other treads and of columns earlier runs arrive at. `floors[k]` is column k's
    // surface; the run may end on the ring's ground. A narrow ledge thus takes its staircase from the floor
    // below it instead of having none.
    const floors: number[] = [p.t];
    const columnAt = (k: number): { x: number; z: number } => ({ x: p.x + k * dx, z: p.z + k * dz });
    const reachedFloor = (x: number, z: number, atMost: number): number | undefined => {
      let best: number | undefined;
      for (const t of grid.surfaces(x, z)) if (t <= atMost && visited.has(grid.key(x, z, t)) && (best === undefined || t > best)) best = t;
      return best;
    };
    for (let k = 1; k <= MAX_TREADS_PER_RUN; k++) {
      const c = columnAt(k);
      if (!grid.inRing(c.x, c.z)) break;
      const t = reachedFloor(c.x, c.z, floors[k - 1]!);
      if (t === undefined) break;
      floors.push(t);
      // The landing may be on the ring or a protected column; a tread column may not.
      if (!grid.inside(c.x, c.z) || treadFloor.has(colKey(c.x, c.z)) || arrivals.has(colKey(c.x, c.z))) break;
    }
    if (treadFloor.has(colKey(p.x, p.z)) || arrivals.has(colKey(p.x, p.z))) return 'no-run';
    // `n` treads occupy columns 0..n-1 and land on column n. The fewest treads whose hops are gentle, else the
    // fewest whose hops are within a jump; every tread must clear the floor it stands on.
    const hopFor = (n: number): number => Math.ceil((q.t - floors[n]!) / (n + 1));
    const feasible = (n: number): boolean => {
      const hop = hopFor(n);
      if (hop > JUMP16) return false;
      for (let k = 1; k <= n; k++) if (q.t - k * hop < floors[k - 1]! + 1) return false;
      return true;
    };
    let n = -1;
    for (let cand = 1; cand < floors.length && n < 0; cand++) if (feasible(cand) && hopFor(cand) <= GENTLE_HOP16) n = cand;
    for (let cand = 1; cand < floors.length && n < 0; cand++) if (feasible(cand)) n = cand;
    if (n < 1) return 'no-run';
    const hop16 = hopFor(n);
    const tops: number[] = [];
    for (let k = 1; k <= n; k++) tops.push(q.t - k * hop16);
    const landing = { ...columnAt(n), t: floors[n]! };
    // A jump-height hop needs its arc clear above the column it starts from (the landing for the lowest tread).
    if (hop16 > STEP16 && !grid.clear(landing.x, landing.z, landing.t, tops[n - 1]! + PLAYER_NEED16)) return 'headroom';
    const writes: RunEdit['writes'] = [];
    const columns: RunEdit['columns'] = [];
    const treadSurfaces: Surface[] = [];
    for (let k = 1; k <= n; k++) {
      const { x, z } = columnAt(k - 1), top = tops[k - 1]!, floor16 = floors[k - 1]!;
      // Open from the floor to the tread's own standing headroom - and, when the next hop up is a jump, to the
      // arc of that jump - so the tread never reduces headroom below the player's and every hop is one the game allows.
      const next = k === 1 ? q.t : tops[k - 2]!;
      if (!grid.clear(x, z, floor16, (hop16 > STEP16 ? next : top) + PLAYER_NEED16)) return 'headroom';
      const floorBlock = floor16 > 0 ? grid.blockWithTop(x, z, floor16) : undefined;
      const floorRow = floorBlock ? floorBlock.row : -1;
      const topRow = (top - 1) >> 4, topHi = top - 16 * topRow;
      const src16 = floorBlock ? floorBlock.src16 : 0;
      const put = (row: number, lo: number, hi: number): void => { writes.push({ x, z, block: { row, lo, hi, src16 }, previous: grid.blockAt(x, z, row) ?? null }); };
      // Solid from the floor up to the tread's top: the floor block raised, full rows between, the top row cut at the tread.
      if (floorBlock && topRow === floorRow) put(floorRow, floorBlock.lo, topHi);
      else {
        if (floorBlock) put(floorRow, floorBlock.lo, 16);
        for (let row = floorRow + 1; row < topRow; row++) put(row, 0, 16);
        put(topRow, 0, topHi);
      }
      columns.push({ x, z, floor16, top16: top });
      treadSurfaces.push({ x, z, t: top });
    }
    return { writes, columns, treadSurfaces, to: q, landing, run: { from: p, to: q, rise100, rise: rise16 / 16, treads: n, hop16, columns: columns.map(c => ({ ...c })) } };
  };
  const apply = (e: RunEdit): void => {
    for (const w of e.writes) grid.write(w.x, w.z, w.block);
    for (const c of e.columns) treadFloor.set(colKey(c.x, c.z), c.floor16);
    arrivals.add(colKey(e.to.x, e.to.z)); arrivals.add(colKey(e.landing.x, e.landing.z));
  };
  const revert = (e: RunEdit): void => {
    for (let i = e.writes.length - 1; i >= 0; i--) {
      const w = e.writes[i]!;
      if (w.previous) grid.write(w.x, w.z, w.previous); else grid.erase(w.x, w.z, w.block.row);
    }
    for (const c of e.columns) treadFloor.delete(colKey(c.x, c.z));
    // Arrivals are rebuilt from the runs that remain (another run may share a column).
    arrivals.clear();
    for (const o of edits) if (o !== e) { arrivals.add(colKey(o.to.x, o.to.z)); arrivals.add(colKey(o.landing.x, o.landing.z)); }
  };
  /** The never-block invariant against the unassisted walk, for the grid as it stands. */
  const holds = (after: ReachResult): boolean => {
    for (const k of before.visited) {
      if (after.visited.has(k)) continue;
      const { x, z, t } = grid.unkey(k);
      if (treadFloor.get(colKey(x, z)) !== t) return false;
    }
    for (const e of edits) {
      if (!after.visited.has(grid.key(e.to.x, e.to.z, e.to.t))) return false;
      for (const s of e.treadSurfaces) if (!after.visited.has(grid.key(s.x, s.z, s.t))) return false;
    }
    return true;
  };
  /** One walk that lays a run at every blocked rise the rule covers; `verifyEach` checks the invariant per run and reverts breakers. */
  const layingWalk = (verifyEach: boolean): void => {
    walkScaledColliders(grid, (p, q, push, visited) => {
      // Only a surface the unassisted walk cannot reach AT ALL is restored: a
      // stair's second step is reached by its first even when a side hop onto
      // it is past the jump, and a tread there would be clutter, not a way up.
      if (before.visited.has(grid.key(q.x, q.z, q.t))) return false;
      const ek = edgeKey(p, q);
      if (failed.has(ek)) return false;
      const e = planRun(p, q, visited);
      if (e === 'no-rule') return false;
      if (typeof e === 'string') { refuse(p, q, e); failed.add(ek); return false; }
      apply(e); edits.push(e);
      if (verifyEach && !holds(walkScaledColliders(grid))) { revert(e); edits.pop(); refuse(p, q, 'verify'); failed.add(ek); return false; }
      for (const s of e.treadSurfaces) push(s);
      return true;
    });
  };
  // Fast path: one laying walk, then a single verification from scratch.
  layingWalk(false);
  let after = walkScaledColliders(grid);
  if (holds(after)) return report(after, edits, true);
  // Slow path: undo everything and re-plan one run at a time, each verified
  // against the unassisted walk, until a pass lays nothing new.
  for (let i = edits.length - 1; i >= 0; i--) revert(edits[i]!);
  edits.length = 0; failed.clear(); arrivals.clear();
  unrestored['no-run'] = 0; unrestored.headroom = 0; unrestored.verify = 0; refused.length = 0; refusedTargets.length = 0;
  for (let pass = 0; pass < 64; pass++) {
    const count = edits.length;
    layingWalk(true);
    if (edits.length === count) break;
  }
  after = walkScaledColliders(grid);
  if (holds(after)) return report(after, edits, true);
  for (let i = edits.length - 1; i >= 0; i--) revert(edits[i]!);
  edits.length = 0;
  return report(walkScaledColliders(grid), [], false);
}

/** Sixteenths above the pin as blocks at 100 % (comparable across sizes), two decimals. */
export const blocksAt100 = (t16: number, f: number): number => Math.round(t16 / 16 / f * 100) / 100;
