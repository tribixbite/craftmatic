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
 *     THE FINE WALK (SCALE-06, 2026-10-15). The 1-block grid keeps only a
 *     column's highest top, so a hill built of one-stud rock steps (21063
 *     Neuschwanstein) reads as a cliff over the jump in the 100 % grid while
 *     a minifig-scale player climbs it one stud at a time. When the export's
 *     own fine reach walk (`measureSceneAccess`, 5 x 4 LDU cells, at the
 *     pack's 100 %) reached the target column's top within half a block
 *     (`FINE_REACH_TOLERANCE16`), the rise is admitted too (`FineReachColumns`,
 *     `fineReachColumns`). A rise nothing at 100 % climbs, at the grid's
 *     resolution or the fine walk's, is still refused.
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
 * THE LATE PASS (2026-10-07, `latePass`). After the main plan and the
 * doorway pass the laying walk runs again, judging "reached" by a walk that
 * never drops more than 3 blocks (`SAFE_DROP16`), keying refused edges
 * exactly (source to target surface), targeting a tread-holding column at
 * another level, and laying a run from the GROUND onto the model wherever the
 * 100 % grid walks it (`edgeSweep`), all verified never to block. It only adds
 * to the main plan: 10261's lift hill and its west rim at 200 % (Pixel round
 * 2026-10-07j) were left as walls by the main rule because the grid walk
 * reached them by a 10-block drop off the track or round a corner.
 *
 * THE LANE PASS (2026-10-07, `lanePass`, only with a `lane` check). A child
 * on touch climbs with AUTO-JUMP alone (at most 1.2, sim/physics/body.ts) and
 * walks straight; every rise over that between two columns of a straight
 * climb gets a run in auto-jump hops, planned over the clearance FORMS' own
 * per-column tops and kept only when the per-tick walker with auto-jump
 * climbs it and no other straight walk into its columns gets shorter: 10261's
 * lift hill at 200 % (Pixel round 30k stopped at pin + 28.2).
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
import { COLLIDER_KIT, type Box16, type ColliderForm } from './collider-form.js';
import { AUTO_JUMP_MAX_RISE, GRAVITY, VERTICAL_DRAG, WALK_SPEED } from '../sim/physics/body.js';

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

/**
 * One solid source cell of the shipped grid: the box [x, x+1] × [y+lo/16,
 * y+hi/16] × [z, z+1] in cells, or - with `v` - a clearance form of it
 * (collider-form.ts: a wall pulled back to its geometry; lo/hi are then the
 * form's states, not necessarily its extent).
 */
export interface SourceCell { x: number; y: number; z: number; lo: number; hi: number; v?: number }
export interface GridDims { width: number; height: number; length: number }
/**
 * A per-size carve (collider-carve.ts, SCALE-06): world block key `x,y,z` (from the pin, at one size and turn)
 * -> the form that block takes instead of the scaled cell's, or null for air. Applied after the scaled cells
 * and before the treads, by the runtime and by every reader of the laid grid.
 */
export type SizeCarve = ReadonlyMap<string, ColliderForm | null>;
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

/**
 * How far a wall can move when the wand re-lays the collider grid at size factor `f`: at f > 1 a world column
 * belongs to the cell whose scaled span holds its CENTRE (`cellColumns`), so a cell boundary at `i·f` lands on
 * the whole block `ceil(i·f - 1/2)`; the largest such shift over the grid, in blocks. 0 at 100 %, 200 %,
 * 300 % and 400 %; half a block at 150 %. Self-contained (no imports): the interactives runtime is handed
 * its source (`interactivesScript`), and the simulator's doorway attribution reads it too.
 */
export function relayRounding(f: number): number {
  if (f <= 1) return 0;
  let worst = 0;
  for (let i = 1; i <= 256; i++) worst = Math.max(worst, Math.abs(Math.ceil(i * f - 0.5) - i * f));
  return Math.round(worst * 1e6) / 1e6;
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

/**
 * Where the export's FINE reach walk (`measureSceneAccess` in bedrock-scene-actors.ts, at the pack's own 100 %)
 * stood, per SOURCE collider column: key `x * dims.length + z` (the unturned grid the pack ships), value the
 * reached floor tops in sixteenths of a source block over the grid's floor - the same unit as a source cell's
 * top `y * 16 + hi` (`ColumnBlock.src16`). Built by `fineReachColumns`.
 */
export type FineReachColumns = ReadonlyMap<number, readonly number[]>;

/**
 * How close (sixteenths of a source block) a fine-walk floor must be to a target column's top for the fine walk
 * to count as having climbed it: half a block. A collider's top is its geometry's rounded OUTWARD to a sixteenth
 * and the fine walk stands on a 4 LDU (0.075-block) cell, so the two readings of one surface differ by a
 * sixteenth or two; half a block keeps a lower step of the same column (a different surface) out.
 */
export const FINE_REACH_TOLERANCE16 = 8;

/**
 * The fine walk's reached floors (`SceneAccessMeasurement.reachedFloorsLdu`: LDraw x, y, z triples, the y the
 * floor's surface) in the collider grid's columns. `toGrid` is the export's OWN LDraw-to-grid map - the one
 * `buildColliderGrid` lays the colliders with (`sceneGridPoint` over the shell's frame) - so a floor lands in the
 * column, and at the height, its part's collider has; nothing is fitted by hand. Floors outside the grid are dropped.
 */
export function fineReachColumns(pointsLdu: ArrayLike<number>, toGrid: (p: [number, number, number]) => readonly number[], dims: GridDims): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let k = 0; k + 2 < pointsLdu.length; k += 3) {
    const g = toGrid([pointsLdu[k]!, pointsLdu[k + 1]!, pointsLdu[k + 2]!]);
    const x = Math.floor(g[0]!), z = Math.floor(g[2]!), t = Math.round(g[1]! * 16);
    if (x < 0 || z < 0 || x >= dims.width || z >= dims.length || t < 0) continue;
    const key = x * dims.length + z;
    let tops = out.get(key);
    if (!tops) out.set(key, tops = []);
    if (!tops.includes(t)) tops.push(t);
  }
  for (const tops of out.values()) tops.sort((a, b) => a - b);
  return out;
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
 * Auto-jump's tallest rise in sixteenths (19: 1.1875, the last sixteenth within its 1.2,
 * sim/physics/body.ts `AUTO_JUMP_MAX_RISE`): what a child on touch climbs without pressing
 * jump. The lane pass makes every hop of a straight climb at most this.
 */
export const AUTO_JUMP16 = Math.floor(AUTO_JUMP_MAX_RISE * 16 + 1e-9);
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
/**
 * The deepest drop (sixteenths, 3 blocks: Minecraft's fall damage starts past
 * it) the late tread pass counts as a way a child walks. The reach walk takes
 * ANY drop, so a surface it reaches only by jumping off a coaster's track ten
 * blocks down reads as reachable and its riser is never restored: 10261's
 * lift hill at 200 % (x 27 -> 28, 9.38 -> 11.13 on z 4-5) - the Pixel player
 * stopped there on every try (round 2026-10-07j).
 */
const SAFE_DROP16 = 48;
/**
 * The deepest fall (sixteenths, 4 blocks) a surface the treads made reachable may lead a child to without a
 * guard (`guardPass`). The doorway drop guards' own limit (bedrock-interactives.ts `GUARD_DROP16` =
 * `STAIR_MAX_RISE16`, asserted equal in test/reach-guards.test.ts): Minecraft's fall damage is the distance
 * past 3 blocks in half-hearts, so 4 blocks costs at most one half-heart - the fall off a garden wall, no
 * worse than vanilla terrain - while the next block up starts to hurt and 10261's lift top is 43.5 (Pixel 30l).
 */
export const REACH_GUARD_DROP16 = 64;
/**
 * A reach guard's height over the edge it guards (sixteenths, 1.5 blocks): over the 1.25 jump and the
 * 1.2 auto-jump, so the rail cannot be climbed from the surface it guards - the doorway guards' `GUARD_HEIGHT16`.
 */
export const REACH_GUARD_HEIGHT16 = 24;
/** How often a guard column whose top a reached surface still steps onto is raised a block (`guardPass`). */
const GUARD_RAISES = 3;
/**
 * How far (sixteenths) a player WALKING straight off an edge has fallen by the time it is still over the k-th
 * column past the edge, k = 1, 2, 3 (index 0 is the edge itself): the fall Bedrock's gravity makes
 * (`GRAVITY`, `VERTICAL_DRAG`: y' = (y' - 0.08) x 0.98 a tick) in the ticks the stick walk (`WALK_SPEED`,
 * 0.216 blocks a tick) takes to cross k blocks, read at the last tick the body is still over that column
 * (rounded down: the least it has fallen there). 12, 53 and 105 today: 0.77, 3.35 and 6.59 blocks.
 *
 * Why the guard pass needs it (round 30m, COL-01): a walking body does not drop straight into the next column.
 * 10261's lift top at 200 % ends at world x 80 on the z 27 lane; the column past it holds a ledge 3.6 blocks
 * down (a fall within the limit, read column by column) and the one past that nothing for 43 blocks. The Pixel
 * walked off, crossed the ledge's column having fallen only a block, and fell the 43 (`rec/cm30m-top-s-east.mp4`;
 * the offline walker does the same). So a column CATCHES the body only when its top is no further down than
 * the body has fallen by the time it leaves that column; a body not caught by the third column has fallen past
 * `REACH_GUARD_DROP16` already (`walkOffDrop`).
 */
export const WALK_OFF_FALL16: readonly number[] = ((): number[] => {
  const out = [0];
  let y = 0, vy = 0, travel = 0;
  for (let k = 1; k <= 3; k++) {
    // The last tick the body's centre is still within k blocks of the edge: the fall at that tick.
    let fallen = 0;
    while (travel + WALK_SPEED < k) { travel += WALK_SPEED; vy = (vy - GRAVITY) * VERTICAL_DRAG; y += vy; fallen = -y; }
    out.push(Math.floor(fallen * 16));
  }
  return out;
})();

/** One world block of a scaled column, with the 100 % surface it came from. */
export interface ColumnBlock {
  /**
   * The block's row and VERTICAL EXTENT (sixteenths): the whole block for the
   * column logic here (surfaces, headroom, treads), which reads a clearance
   * form as the full block it sits in - conservative, a partial wall counts as
   * a wall. `form` says what the block really is.
   */
  row: number; lo: number; hi: number;
  /** The source cell's top in sixteenths of a SOURCE block (y·16 + hi) whose scaled top set `hi`; a tread carries the floor's. */
  src16: number;
  /** The clearance form laid here (absent: the full-footprint collider over lo..hi). */
  form?: ColliderForm;
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

  /** `carve`: the size's carve (`SizeCarve`), applied to every column as it is built. */
  constructor(readonly cells: readonly SourceCell[], readonly dims: GridDims, readonly f: number, readonly r: QuarterTurn, readonly carve?: SizeCarve) {
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
    const pieces = new Map<number, Box16[]>();
    const cellsHere = this.cellsByColumn.get(s.x * this.dims.length + s.z) ?? [];
    const anyForm = cellsHere.some(c => c.v);
    for (const c of cellsHere) {
      if (!c.v) {
        // A full cell: the re-lay's row arithmetic directly (what `cellPieces` computes for it, without the allocation).
        const wy0 = (c.y + c.lo / 16) * this.f, wy1 = (c.y + c.hi / 16) * this.f;
        const src16 = c.y * 16 + c.hi;
        for (let wy = Math.floor(wy0); wy < Math.ceil(wy1); wy++) {
          const l = Math.max(0, Math.min(15, Math.floor((wy0 - wy) * 16)));
          const h = Math.max(l + 1, Math.min(16, Math.ceil((wy1 - wy) * 16)));
          if (anyForm) {
            const list = pieces.get(wy), b: Box16 = [0, 16, l, h, 0, 16];
            if (list) list.push(b); else pieces.set(wy, [b]);
          }
          const prev = rows.get(wy);
          if (!prev) rows.set(wy, { row: wy, lo: l, hi: h, src16 });
          else { prev.lo = Math.min(prev.lo, l); if (h > prev.hi || (h === prev.hi && src16 > prev.src16)) { prev.hi = h; prev.src16 = src16; } }
        }
        continue;
      }
      const boxes = COLLIDER_KIT.formBoxes(c.v, c.lo, c.hi);
      const top = Math.max(...boxes.map(b => b[3]));
      const src16 = c.y * 16 + top;
      // The re-lay's own pieces (collider-form.ts `cellPieces`), this column's only.
      COLLIDER_KIT.cellPieces(c.x, c.y, c.z, c.v ?? 0, c.lo, c.hi, this.dims, this.f, this.r, (wx, wy, wz, b) => {
        if (wx !== x || wz !== z) return;
        const l = b[2], h = b[3];
        const list = pieces.get(wy);
        if (list) list.push(b); else pieces.set(wy, [b]);
        const prev = rows.get(wy);
        // A block two cells share keeps min lo / max hi (the runtime's merge); the top's provenance follows the higher hi.
        if (!prev) rows.set(wy, { row: wy, lo: l, hi: h, src16 });
        else { prev.lo = Math.min(prev.lo, l); if (h > prev.hi || (h === prev.hi && src16 > prev.src16)) { prev.hi = h; prev.src16 = src16; } }
      });
    }
    for (const [wy, list] of pieces) {
      // Only a row a clearance form reached can be anything but full.
      if (list.every(b => b[0] === 0 && b[1] === 16 && b[4] === 0 && b[5] === 16)) continue;
      const form = COLLIDER_KIT.cover(list);
      if (form && form.v !== 0) rows.get(wy)!.form = form;
    }
    if (this.carve?.size) {
      for (const [wy, b] of [...rows]) {
        const key = `${x},${wy},${z}`;
        if (!this.carve.has(key)) continue;
        const form = this.carve.get(key);
        if (!form) { rows.delete(wy); continue; }
        const boxes = COLLIDER_KIT.formBoxes(form.v, form.lo, form.hi);
        const lo = Math.min(...boxes.map(q => q[2])), hi = Math.max(...boxes.map(q => q[3]));
        // The source top follows the block's own top down (sixteenths of a SOURCE block: a world sixteenth / f).
        b.src16 += (hi - b.hi) / this.f;
        b.lo = lo; b.hi = hi;
        if (form.v !== 0) b.form = form; else delete b.form;
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

/**
 * The scaled grid with the jump of AUTO-JUMP (`AUTO_JUMP16`, 1.2) instead of the jump button's (1.25): what a
 * player who only walks climbs - adb's one finger and a child on touch. The cross pass judges what a run's
 * removal loses with it (`crossPass`).
 */
class AutoJumpGrid extends ScaledColliderGrid {
  override canRise(x: number, z: number, t: number, t2: number): boolean {
    return t2 - t <= AUTO_JUMP16 && super.canRise(x, z, t, t2);
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
  maxDrop16 = Infinity,
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
        // A bounded walk (`maxDrop16`) never steps down further than that: neither moves nor offers the edge.
        if (s.t - t > maxDrop16) continue;
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
  /** Laid by the lane pass (an auto-jump climb of a straight lane, proved by the walk), not the reach rule. */
  lane?: true;
  /** Admitted by the FINE walk (`FineReachColumns`): `rise100` is over the jump in the 1-block grid, and the fine walk stood on the target's top. */
  fine?: true;
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
  /** The blocks to set after the re-lay, in a deterministic order: the treads' and the reach guards'. */
  blocks: TreadBlock[];
  /** Of `blocks`, the reach guards' (`guardPasses`): what is left of `blocks` without them is the treads'. */
  guardBlocks: TreadBlock[];
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
  /**
   * The reach guards (`guardPasses`): invisible rails where a reached surface meets a fall of more than
   * `REACH_GUARD_DROP16`. Their blocks are in `blocks`; absent when no guard was laid.
   */
  guards?: ReachGuardReport;
}

/** What the reach guard passes did for one size and turn. */
export interface ReachGuardReport {
  /** Columns that got a guard (`capped` of them a fresh surface's own column on the footprint's border) and the blocks those guards wrote (also in `TreadPlan.blocks`). */
  columns: number;
  capped: number;
  /** Of `columns`, those the second pass over the FORM grid added: edges the full-cell reading hides (0 without a lane check). */
  formColumns: number;
  blocks: number;
  /** Edges over a fall that got no guard: the column is a doorway's, or a guard there would block a route (`verify`). */
  unguarded: { door: number; verify: number };
  /** Edges over a fall off the footprint's border left open: the border column is a doorway's, or its cap failed the check (`TODO(reach-guards)`). */
  pastEdge: number;
  /** A sample of the guarded columns (world blocks from the pin; the guard's span in sixteenths). */
  sample: Array<{ x: number; z: number; lo16: number; hi16: number; drop16: number; cap?: true }>;
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
  /**
   * The same climb with the jump's own hops, when this run SOFTENED them to auto-jump's (`planRunCore`): what the
   * cross pass judges instead should this run's side shorten a walk in (`crossPass`).
   */
  hard?: RunEdit;
}

const noVisited = (r: ReachResult): Omit<ReachResult, 'visited'> => ({ surfaces: r.surfaces, columns: r.columns, highest16: r.highest16 });

/** A LEGO plate's height at 100 % on a microscale set (sixteenths): 21063's east plate strip, 76419's south yard. */
const PLATE16_AT_100 = 5;
/**
 * A cross probe whose feet start at most this high (blocks) starts on the GROUND, the way in from outside
 * (`crossLaneProbes` puts feet 0.01 over a floor): on it or a step over it (a carved plate edge sits a
 * sixteenth or two high); under a per-size carve (`carved`), on a base plate at the size, at most an auto-jump.
 * At 300 % 21063's east plate strip stands 15/16 high, and one fine run laid across its whole width at z 42
 * walled off the flank the Pixel climbed (round 30zi: 10.3 blocks) while a step's 9/16 never probed it. Without
 * a carve (200 %) the plate's 10/16 changed the device-proven routes' plan (21063's lanes over 2 blocks 26 -> 20,
 * 2026-10-16), so it stays a step there until a device round judges it. Not every floor: the hill runs above
 * 76419's south shore at 300 % climb more than their sides cost.
 */
const groundProbeY = (f: number, carved: boolean): number =>
  (carved ? Math.min(AUTO_JUMP16, Math.max(STEP16, Math.round(PLATE16_AT_100 * f))) : STEP16) / 16 + 0.01;
/**
 * A fine run the cross pass would revert is kept when it is the first way (breadth first from the ground) to at
 * least this many surfaces per tread, and to `CROSS_GATEWAY_MIN` at least (`crossPass`'s `gateway`): measured,
 * 21063's flank run 115 for 8 treads (kept), 76419's boathouse run 8 for 8 (reverted).
 */
const CROSS_GATEWAY_PER_TREAD = 3, CROSS_GATEWAY_MIN = 16;
/** A straight walk a run must leave no shorter (`crossLaneProbes`): feet start (world blocks from the pin) and direction. */
interface CrossProbe { from: { x: number; y: number; z: number }; dir: { x: number; z: number } }
/**
 * The cross-lane walks a run must leave no shorter: into each column it writes, along x and z both ways, from
 * the column two out on its highest floor `reach` stands on at most an auto-jump over the column's old floor.
 * A start on the run itself is the run's own lane, never probed (its old floor is under a tread). `g` is the
 * FORM grid the walks are judged over (the lane pass's, the cross pass's).
 */
function crossLaneProbes(g: ScaledColliderGrid, reach: ReachResult, columns: RunEdit['columns']): CrossProbe[] {
  const out: CrossProbe[] = [];
  for (const c of columns) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const sx = c.x - 2 * dx, sz = c.z - 2 * dz;
    if (columns.some(o => o.x === sx && o.z === sz)) continue;
    const floors = g.surfaces(sx, sz).filter(t => t <= c.floor16 + AUTO_JUMP16 && reach.visited.has(g.key(sx, sz, t)));
    if (!floors.length) continue;
    out.push({ from: { x: sx + 0.5, y: Math.max(...floors) / 16 + 0.01, z: sz + 0.5 }, dir: { x: dx, z: dz } });
  }
  return out;
}

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

/** Where a run is planned: the grid and the column protections earlier runs set on it (`planRunCore`). */
interface RunGround {
  g: ScaledColliderGrid;
  /** A tread an earlier run laid stands in this column (at a level that matters for a surface at `t`). */
  treadAt(x: number, z: number, t: number): boolean;
  /** The column holds a tread or an earlier run's arrival (its `to` or landing) near the level `t`: never converted. */
  taken(x: number, z: number, t: number): boolean;
  isTreadTop(s: Surface): boolean;
  /** A tread-holding column is a target at another level (the late and lane passes). */
  stacked(): boolean;
}

/**
 * The lane pass's physical check (`planColliderTreads` `lane`): how far, in blocks along `dir` (a unit x/z
 * step), the per-tick player with AUTO-JUMP walks straight from `from` (feet, world blocks from the pin) over
 * the shipped colliders WITH THEIR FORMS and `treads` laid, at most `limit`; its feet falling a block under the
 * highest they stood ends the walk (off the lane). `colliderLaneWalk` (bedrock-placement-pack.ts) builds it over
 * the walk preview's world.
 */
export type LaneWalk = (treads: readonly TreadBlock[], from: { x: number; y: number; z: number }, dir: { x: number; z: number }, limit: number) => number;
/** The lane pass's inputs (`planColliderTreads` `lane`): the walk, and the source cells WITH their clearance forms. */
export interface TreadLaneCheck { walk: LaneWalk; cells: readonly SourceCell[] }
/**
 * A lane walk is judged from the run's LANDING column (where its lowest tread is climbed from) to `LANE_PAST`
 * blocks into the column past the riser's top: a run is kept only when the walk gets there with it and did not
 * without it, and a candidate whose walk gets there already (the forms climb where the grid reads a wall) is
 * not given one.
 */
export const LANE_PAST = 0.6;
/** How far a cross-lane walk goes (blocks): from two columns out, past the column a run writes. */
export const LANE_CROSS = 3.5;
/** A cross-lane walk a run shortens by more than this (blocks) rejects the run: under a tick of walking, noise. */
export const LANE_SLACK = 0.1;
/** The most rounds the lane pass makes (each climbs at least one more riser of some lane; 10261's lift hill at 200 % has 12). */
export const LANE_ROUNDS = 32;

/**
 * Plan the treads for one size step and quarter turn. Pure: the same cells
 * give the same plan. See the module header for the rule. `fine`: the export's
 * fine reach walk per source column (`fineReachColumns`); without it the 100 %
 * rule reads the 1-block grid alone, as it always did. `carve`: the size's carve
 * (collider-carve.ts), which every grid the plan reads is laid with; the lane
 * walk must be built over it too (`colliderLaneWalk`).
 */
export function planColliderTreads(cells: readonly SourceCell[], dims: GridDims, sizePct: number, rotation: QuarterTurn, targets: readonly ReachTarget[] = [], doorCells: ReadonlyArray<readonly (number | undefined)[]> = [], lane?: TreadLaneCheck, fine?: FineReachColumns, carve?: SizeCarve): TreadPlan {
  const f = sizePct / 100;
  /**
   * The fine walk stood on the top `src16` of the source column under world column `q` (this size and turn):
   * the rise onto it is one the model's own scale climbs, however the 1-block grid reads the column.
   */
  const fineClimbed = (q: { x: number; z: number }, src16: number): boolean => {
    if (!fine?.size) return false;
    const s = sourceCellOf(Math.floor((q.x + 0.5) / f), Math.floor((q.z + 0.5) / f), dims, rotation);
    return (fine.get(s.x * dims.length + s.z) ?? []).some(t => Math.abs(t - src16) <= FINE_REACH_TOLERANCE16);
  };
  const unrestored: Record<UnrestoredReason, number> = { 'no-run': 0, headroom: 0, verify: 0 };
  const refused: TreadPlan['refused'] = [];
  const refusedTargets: Surface[] = [];
  /** Each refused edge's reason (`refuseKey`), so a late-pass restoration can take it back out of `unrestored`. */
  const failedReason = new Map<string, UnrestoredReason>();
  const refuseKey = (p: Surface, q: Surface): string => `${p.x},${p.z},${p.t}>${q.x},${q.z},${q.t}`;
  const refuse = (p: Surface, q: Surface, reason: UnrestoredReason): void => {
    unrestored[reason]++;
    failedReason.set(refuseKey(p, q), reason);
    refusedTargets.push(q);
    if (refused.length < MAX_REFUSED_REPORTED) refused.push({ from: p, to: q, rise100: (q.t - p.t) / 16 / f, reason });
  };
  if (f < 1) {
    // Below 100 % several cells share a block and no rise can exceed the jump; the walk is not defined here.
    const none = { surfaces: 0, columns: 0, highest16: 0 };
    return { sizePct, rotation, blocks: [], guardBlocks: [], runs: [], unrestored, refused, refusedUnreached: 0, before: none, after: none, verified: true };
  }
  const grid = new ScaledColliderGrid(cells, dims, f, rotation, carve);
  const before = walkScaledColliders(grid);
  /** The unassisted walk taking no drop past `SAFE_DROP16`: what the late pass counts as reached already. */
  const beforeSafe = walkScaledColliders(grid, undefined, SAFE_DROP16);
  /** The reach guards' final blocks and report (`guardPasses`, last): empty until they run. */
  let guardBlocks: TreadBlock[] = [];
  let guardReport: ReachGuardReport | undefined;
  /** The lane pass's FORM grid with every tread laid (set when the plan has a lane check): the second guard pass reads it. */
  let formGrid: ScaledColliderGrid | undefined;
  const report = (after: ReachResult, edits: readonly RunEdit[], verified: boolean): TreadPlan => {
    const finalBlocks = new Map<string, TreadBlock>();
    for (const e of edits) for (const w of e.writes) finalBlocks.set(`${w.x},${w.block.row},${w.z}`, { x: w.x, y: w.block.row, z: w.z, lo: w.block.lo, hi: w.block.hi });
    for (const b of guardBlocks) finalBlocks.set(`${b.x},${b.y},${b.z}`, b);
    const blocks = [...finalBlocks.values()].sort((p, q) => p.x - q.x || p.z - q.z || p.y - q.y);
    const radius = Math.ceil(f);
    const targetResults = targets.map((t): ReachTargetResult => {
      const at = targetColumn(t, dims, f, rotation), y16 = Math.round(t.y * f * 16);
      const nearest = targetReached(grid, after, at, radius, y16, f);
      return { ...t, column: { ...at, radius }, reachedBefore: targetReached(grid, before, at, radius, y16, f) !== null, reachedAfter: nearest !== null, nearestAfter: nearest === null ? null : blocksAt100(nearest, f) };
    });
    const unreached = new Set<number>();
    for (const q of refusedTargets) { const k = grid.key(q.x, q.z, q.t); if (!after.visited.has(k)) unreached.add(k); }
    const guardKeys = new Set(guardBlocks.map(b => `${b.x},${b.y},${b.z}`));
    return { sizePct, rotation, blocks, guardBlocks: blocks.filter(b => guardKeys.has(`${b.x},${b.y},${b.z}`)), runs: edits.map(e => e.run), unrestored, refused, refusedUnreached: unreached.size, before: noVisited(before), after: noVisited(after), verified, ...(targets.length ? { targets: targetResults } : {}), ...(guardReport ? { guards: guardReport } : {}) };
  };
  if (f === 1) return report(before, [], true);

  const treadFloor = new Map<number, number>();   // column key → the floor top a tread replaced there
  const arrivals = new Set<number>();             // columns earlier runs arrive at (their `to` and landing), never converted
  const colKey = (x: number, z: number): number => (x + 1) * (grid.length + 2) + (z + 1);
  const failed = new Set<number>();               // edges refused, never retried
  const edgeKey = (p: Surface, q: Surface): number => grid.key(p.x, p.z, p.t) * 4 + (q.x > p.x ? 0 : q.x < p.x ? 1 : q.z > p.z ? 2 : 3);
  const edits: RunEdit[] = [];
  /** Whether a surface is the top of a tread some run laid (a tread is never another run's target). */
  const isTreadTop = (s: Surface): boolean => treadFloor.has(colKey(s.x, s.z)) && edits.some(e => e.columns.some(c => c.x === s.x && c.z === s.z && c.top16 === s.t));
  /** Set only during `latePass`: a column holding a tread is then a target at another level. */
  let stackedTargets = false;

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
  /**
   * `on`: the grid planned over and the column protections that apply there - the main plan's own by default;
   * the lane pass plans over the FORM grid with its own (`RunGround`). `maxHop16`: the tallest hop a run may
   * make (the jump; the lane pass passes auto-jump's `AUTO_JUMP16`).
   */
  // The main plan's protections are per COLUMN, whatever the level (as they always were).
  const mainGround: RunGround = {
    g: grid, isTreadTop: s => isTreadTop(s), stacked: () => stackedTargets,
    treadAt: (x, z) => treadFloor.has(colKey(x, z)),
    taken: (x, z) => treadFloor.has(colKey(x, z)) || arrivals.has(colKey(x, z)),
  };
  const planRunCore = (p: Surface, q: Surface, visited: ReadonlySet<number>, maxHop16 = JUMP16, on: RunGround = mainGround): RunEdit | UnrestoredReason | 'no-rule' => {
    const { g } = on;
    // A tread is reached by its own run and is never a target; a column another run arrives at (its
    // `to` or its landing) is never converted, so a later run cannot break an earlier one's approach.
    // (`latePass` lifts the column rule for a surface at another level than the column's tread.)
    if (!g.inside(q.x, q.z) || (on.treadAt(q.x, q.z, q.t) && (!on.stacked() || on.isTreadTop(q)))) return 'no-rule';
    const qb = g.blockWithTop(q.x, q.z, q.t);
    if (!qb) return 'no-rule';
    const pSrc = p.t > 0 ? g.blockWithTop(p.x, p.z, p.t)?.src16 : 0;
    if (pSrc === undefined) return 'no-rule';
    const rise100 = (qb.src16 - pSrc) / 16;
    // Over the jump in the 1-block grid: restored only where the fine walk climbed onto that top at 100 %.
    const byFine = rise100 > JUMP_HEIGHT_BLOCKS + 1e-9;
    if (byFine && !fineClimbed(q, qb.src16)) return 'no-rule';
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
      for (const t of g.surfaces(x, z)) if (t <= atMost && visited.has(g.key(x, z, t)) && (best === undefined || t > best)) best = t;
      return best;
    };
    for (let k = 1; k <= MAX_TREADS_PER_RUN; k++) {
      const c = columnAt(k);
      if (!g.inRing(c.x, c.z)) break;
      const t = reachedFloor(c.x, c.z, floors[k - 1]!);
      if (t === undefined) break;
      floors.push(t);
      // The landing may be on the ring or a protected column; a tread column may not.
      if (!g.inside(c.x, c.z) || on.taken(c.x, c.z, t)) break;
    }
    if (on.taken(p.x, p.z, p.t)) return 'no-run';
    // `n` treads occupy columns 0..n-1 and land on column n. The fewest treads whose hops are gentle, else the
    // fewest whose hops are within a jump; every tread must clear the floor it stands on.
    const hopFor = (n: number): number => Math.ceil((q.t - floors[n]!) / (n + 1));
    const feasible = (n: number): boolean => {
      const hop = hopFor(n);
      if (hop > maxHop16) return false;
      for (let k = 1; k <= n; k++) if (q.t - k * hop < floors[k - 1]! + 1) return false;
      return true;
    };
    // The jump's own hop of 1.25 is climbed only by pressing jump, and a child on touch does not: the Pixel (round
    // 30zm) stopped at the foot of 21063's 400 % south run, three treads of 1.25 where four of 1.0 fit in the same
    // columns. So a run that would be laid with jump-height hops, and whose foot is the GROUND (the pin plane: the way
    // onto the model from outside), takes the fewest treads whose hops AUTO-JUMP climbs (`AUTO_JUMP16`, 1.1875)
    // instead, when they fit. Only a run that is laid ANYWAY, and only from the ground: offered to every run, the
    // softer hops made runs feasible that the jump's could not lay (headroom) - on 21063's 300 % plate (z 38-40, x 30-32,
    // landing on the ground east of the model) one stood 1.31 over the flank lane the Pixel climbed, and that climb
    // fell 10.38 -> 2.19 blocks (2026-10-17).
    let n = -1;
    for (let cand = 1; cand < floors.length && n < 0; cand++) if (feasible(cand) && hopFor(cand) <= GENTLE_HOP16) n = cand;
    const gentle = n >= 1;
    for (let cand = 1; cand < floors.length && n < 0; cand++) if (feasible(cand)) n = cand;
    if (n < 1) return 'no-run';
    /** The tread tops and landing of the run of `m` treads, or 'headroom' where the game would not let the player climb it. */
    const layout = (m: number): { hop16: number; tops: number[]; landing: Surface } | 'headroom' => {
      const hop16 = hopFor(m);
      const tops: number[] = [];
      for (let k = 1; k <= m; k++) tops.push(q.t - k * hop16);
      const landing = { ...columnAt(m), t: floors[m]! };
      // A jump-height hop needs its arc clear above the column it starts from (the landing for the lowest tread).
      if (hop16 > STEP16 && !g.clear(landing.x, landing.z, landing.t, tops[m - 1]! + PLAYER_NEED16)) return 'headroom';
      for (let k = 1; k <= m; k++) {
        const { x, z } = columnAt(k - 1), next = k === 1 ? q.t : tops[k - 2]!;
        // Open from the floor to the tread's own standing headroom - and, when the next hop up is a jump, to the
        // arc of that jump - so the tread never reduces headroom below the player's and every hop is one the game allows.
        if (!g.clear(x, z, floors[k - 1]!, (hop16 > STEP16 ? next : tops[k - 1]!) + PLAYER_NEED16)) return 'headroom';
      }
      return { hop16, tops, landing };
    };
    const laid = layout(n);
    if (laid === 'headroom') return 'headroom';
    /** The edit that lays the run of `m` treads (`at`: its layout). */
    const build = (m: number, at: { hop16: number; tops: number[]; landing: Surface }): RunEdit => {
      const { hop16, tops, landing } = at;
      const writes: RunEdit['writes'] = [];
      const columns: RunEdit['columns'] = [];
      const treadSurfaces: Surface[] = [];
      for (let k = 1; k <= m; k++) {
        const { x, z } = columnAt(k - 1), top = tops[k - 1]!, floor16 = floors[k - 1]!;
        const floorBlock = floor16 > 0 ? g.blockWithTop(x, z, floor16) : undefined;
        const floorRow = floorBlock ? floorBlock.row : -1;
        const topRow = (top - 1) >> 4, topHi = top - 16 * topRow;
        const src16 = floorBlock ? floorBlock.src16 : 0;
        const put = (row: number, lo: number, hi: number): void => { writes.push({ x, z, block: { row, lo, hi, src16 }, previous: g.blockAt(x, z, row) ?? null }); };
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
      return { writes, columns, treadSurfaces, to: q, landing, run: { from: p, to: q, rise100, rise: rise16 / 16, treads: m, hop16, columns: columns.map(c => ({ ...c })), ...(byFine ? { fine: true as const } : {}) } };
    };
    const hard = build(n, laid);
    if (!gentle && laid.hop16 > AUTO_JUMP16) {
      for (let cand = n + 1; cand < floors.length; cand++) {
        if (floors[cand] !== 0 || !feasible(cand) || hopFor(cand) > AUTO_JUMP16) continue;
        const soft = layout(cand);
        if (soft !== 'headroom') return { ...build(cand, soft), hard };
        break;
      }
    }
    return hard;
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
  /**
   * Every surface the unassisted walk reached still is, save a floor a tread now covers. `laneToo`: a lane run's
   * tread covers a floor as well (the lane pass keeps its floors apart from `treadFloor`; after it, the cross pass).
   * `prior`: judge only what a change TAKES - a surface reached before the change and not after. The cross pass
   * passes the walk as the grid stood before its revert: a lane run's treads can also cover a second surface in
   * a column (a ledge over its floor), which neither exemption names, so the absolute check was already false
   * when the cross pass started and every revert was refused (76419 at 200 % under the per-size carve: the
   * boathouse run stood, every turn).
   */
  const neverBlocks = (after: ReachResult, laneToo = false, prior?: ReachResult): boolean => {
    const laneFloors = new Set<string>();
    if (laneToo) for (const e of edits) if (e.run.lane) for (const c of e.columns) laneFloors.add(`${c.x},${c.z},${c.floor16}`);
    for (const k of before.visited) {
      if (after.visited.has(k) || (prior && !prior.visited.has(k))) continue;
      const { x, z, t } = grid.unkey(k);
      if (treadFloor.get(colKey(x, z)) !== t && !laneFloors.has(`${x},${z},${t}`)) return false;
    }
    return true;
  };
  const holds = (after: ReachResult): boolean => {
    if (!neverBlocks(after)) return false;
    for (const e of edits) {
      if (!after.visited.has(grid.key(e.to.x, e.to.z, e.to.t))) return false;
      for (const s of e.treadSurfaces) if (!after.visited.has(grid.key(s.x, s.z, s.t))) return false;
    }
    return true;
  };
  /**
   * One walk that lays a run at every blocked rise the rule covers; `verifyEach` checks the invariant per run and
   * reverts breakers. `retry` (the late pass) keys edges EXACTLY - source surface to target surface - and tries
   * each once: the main walk's `failed` key is per source surface and direction, so one refusal toward a
   * neighbour column (its lower level, say) silently skipped every other level of it - 10261's lift hill at
   * 200 %, where the riser 53 -> 54 shares its key with the platform level under it. An edge the main walk
   * refused is retried against the grid as it now stands and is not counted twice.
   */
  const layingWalk = (verifyEach: boolean, retry?: Set<string>): void => {
    walkScaledColliders(grid, (p, q, push, visited) => {
      // Only a surface the unassisted walk cannot reach AT ALL is restored: a
      // stair's second step is reached by its first even when a side hop onto
      // it is past the jump, and a tread there would be clutter, not a way up.
      // The late pass walks and judges "reached" without a drop past `SAFE_DROP16`.
      if ((retry ? beforeSafe : before).visited.has(grid.key(q.x, q.z, q.t))) return false;
      const ek = edgeKey(p, q), rk = refuseKey(p, q);
      if (retry) { if (retry.has(rk)) return false; retry.add(rk); }
      else if (failed.has(ek)) return false;
      // Refused before (counted in `unrestored`): a second refusal is not counted again.
      const counted = !!retry && failedReason.has(rk);
      const e = planRun(p, q, visited);
      if (e === 'no-rule') return false;
      if (typeof e === 'string') { if (!counted) { refuse(p, q, e); failed.add(ek); } return false; }
      apply(e); edits.push(e);
      if (verifyEach && !holds(walkScaledColliders(grid))) { revert(e); edits.pop(); if (!counted) { refuse(p, q, 'verify'); failed.add(ek); } return false; }
      // A refused edge restored now is no longer unrestored.
      if (counted) { const was = failedReason.get(rk)!; if (unrestored[was] > 0) unrestored[was]--; failedReason.delete(rk); }
      for (const s of e.treadSurfaces) push(s);
      return true;
    }, retry ? SAFE_DROP16 : Infinity);
  };
  /**
   * DOORWAY THRESHOLDS. A doorway joins two places, and the walk above counts
   * its threshold (the floor of a leaf's column) reached from whichever side
   * gets there first - so once one side has a way up (the model's own stair,
   * an access stair, bedrock-interactives.ts `planThresholdStairs`), the rule
   * "restore only what is reached by no route" drops the other side's climb:
   * 31141's front ledge lost its treads at 150-200 % when a stair up to Door
   * 2's back appeared, and the door read ONE-WAY from the front. So after the
   * main plan, every blocked rise from a REACHED surface into a threshold
   * surface of `doorCells`' world columns is restored by the same rule (within
   * the jump at 100 %, laid back over reached floor), each run verified
   * against the unassisted walk (never block) and reverted if it fails.
   */
  const doorColumns = new Set<number>();
  for (const c of doorCells) {
    const turned = rotatedCell(c[0]!, c[2]!, dims, rotation);
    const [x0, x1] = cellColumns(turned.x, f), [z0, z1] = cellColumns(turned.z, f);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) doorColumns.add(colKey(x, z));
  }
  const doorwayPass = (): void => {
    if (!doorColumns.size) return;
    let reach = walkScaledColliders(grid);
    for (const ck of doorColumns) {
      const x = Math.floor(ck / (grid.length + 2)) - 1, z = ck % (grid.length + 2) - 1;
      if (!grid.inside(x, z)) continue;
      for (const t of grid.surfaces(x, z)) {
        const q = { x, z, t };
        for (const [px, pz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]] as const) {
          if (!grid.inRing(px, pz)) continue;
          for (const tp of grid.surfaces(px, pz)) {
            const p = { x: px, z: pz, t: tp };
            if (!reach.visited.has(grid.key(px, pz, tp)) || grid.canMove(px, pz, tp, x, z, t)) continue;
            const ek = edgeKey(p, q);
            if (failed.has(ek)) continue;
            const e = planRun(p, q, reach.visited);
            if (e === 'no-rule') continue;
            if (typeof e === 'string') { refuse(p, q, e); failed.add(ek); continue; }
            apply(e); edits.push(e);
            const walked = walkScaledColliders(grid);
            if (!holds(walked)) { revert(e); edits.pop(); refuse(p, q, 'verify'); failed.add(ek); continue; }
            reach = walked;
          }
        }
      }
    }
  };
  /**
   * THE LATE PASS. The main laying walk restores the rises it meets as it
   * walks; a surface it reaches only through a LATER run (the doorway pass)
   * has its own blocked rises never looked at, and the main plan never
   * targets a column holding a tread at any height. Both left 10261's lift
   * hill at 200 % with one riser unrestored (x 53 -> 54, 1.375 in the shipped
   * forms, 1.875 as the planner reads them): the hill's top is reached only
   * after the doorway pass, and the device player stopped there on every try
   * (Pixel round 2026-10-07j). So after the main plan and the doorway pass,
   * the laying walk runs again - verified run by run against the unassisted
   * walk (never block), reverted where it fails - with a tread-holding column
   * a target at another level than its tread's top (the run writes behind
   * `p`, never in the target's column), until a pass lays nothing new. It runs
   * last, so it only adds to the main plan.
   * A player walking STRAIGHT up a lane of 10261's lift hill still stopped
   * at x 39.7 at 200 % after this pass (that lane rises 1.75 every second
   * column; the plan reaches the top from the next lane), and at x 28.2 with
   * auto-jump alone: the LANE PASS below takes it, over the forms' own tops
   * (a run planned over full cells made the walk worse, x 30.7).
   */
  const latePass = (): void => {
    stackedTargets = true;
    const mark = edits.length, stats = { ...unrestored }, reasons = new Map(failedReason);
    /**
     * THE MODEL'S EDGE FROM THE GROUND. A rise from the ground (the pin plane)
     * onto the model that the 100 % rule covers but this size breaks is
     * restored even where the surface is reached some other way: a child
     * walks up to a model from wherever it stands. 10261's base at 200 % is a
     * 1.5-block rim along its west side (0.75 at 100 %), reached by the grid
     * walk only round the corner, and the Pixel player could not climb it at
     * z 7339-7344 (round 2026-10-07j). Only from the ground: there the walk
     * and the device read the same flat floor, so a tread cannot hide a riser
     * the planner's full-cell reading of a clearance form does not see. A
     * refusal is not counted: the surface is reached.
     */
    const edgeSweep = (retried: Set<string>): void => {
      const reach = walkScaledColliders(grid, undefined, SAFE_DROP16);
      for (const k of reach.visited) {
        const p = grid.unkey(k);
        if (p.t !== 0) continue;
        for (const [nx, nz] of [[p.x + 1, p.z], [p.x - 1, p.z], [p.x, p.z + 1], [p.x, p.z - 1]] as const) {
          if (!grid.inside(nx, nz)) continue;
          for (const t of grid.surfaces(nx, nz)) {
            const q = { x: nx, z: nz, t };
            if (t <= 0 || !reach.visited.has(grid.key(nx, nz, t)) || grid.canMove(p.x, p.z, 0, nx, nz, t)) continue;
            const rk = refuseKey(p, q);
            if (retried.has(rk)) continue;
            retried.add(rk);
            if (!grid.surfaces(p.x, p.z).includes(0)) continue;
            // The core planner, never `planRun`: its merge with an earlier run could not be undone by `until`'s revert.
            const e = planRunCore(p, q, reach.visited);
            if (typeof e === 'string') continue;
            apply(e); edits.push(e);
          }
        }
      }
    };
    const until = (verifyEach: boolean): void => {
      const retried = new Set<string>(), edged = new Set<string>();
      for (let pass = 0; pass < 16; pass++) {
        const count = edits.length;
        layingWalk(verifyEach, retried);
        // Verified as a batch by `latePass` (and, on its slow path, run by run below).
        if (!verifyEach) edgeSweep(edged);
        else {
          const mark = edits.length;
          edgeSweep(edged);
          for (let i = edits.length - 1; i >= mark; i--) {
            const e = edits[i]!;
            if (holds(walkScaledColliders(grid))) break;
            revert(e); edits.splice(i, 1);
          }
        }
        if (edits.length === count) break;
      }
    };
    // Fast: lay every late run, then verify once; only when that fails, again one verified run at a time.
    until(false);
    if (edits.length > mark && !holds(walkScaledColliders(grid))) {
      for (let i = edits.length - 1; i >= mark; i--) revert(edits[i]!);
      edits.length = mark;
      Object.assign(unrestored, stats);
      failedReason.clear();
      for (const [k, v] of reasons) failedReason.set(k, v);
      until(true);
    }
    stackedTargets = false;
  };
  /**
   * THE CROSS PASS (SCALE-06, Saga round 30zi). A run the FINE walk admitted (`TreadRun.fine`: a rise over the
   * jump in the 1-block grid that the model's own scale climbs) is laid where the per-tick player may already
   * walk - the forms and the drawn studs climb where the grid reads a wall - and a run is a staircase one column
   * wide whose SIDES are walls as tall as its treads. 76419's fine runs along its south plate row at 200 % rose
   * three blocks across the boathouse slip, and the Saga stopped against the side of one where 30zg had walked
   * up the shore. So, after the lane pass, every fine run must leave each straight walk from the GROUND into a
   * column it writes, from two columns out along x and z (`crossLaneProbes`), no shorter than it was without
   * that run (`LANE_CROSS`, `LANE_SLACK`), over the shipped forms with every other tread laid. A run that shortens
   * one is reverted, newest first, unless it is the gateway to enough of the model (`CROSS_GATEWAY_PER_TREAD`),
   * the walk over the forms (climbing auto-jump's 1.2) then loses any surface (a climb is worth its sides), a
   * later run writes over it (it is that run's floor), or its removal takes a surface the unassisted walk reached. It runs after
   * the lane pass because a lane run can climb on from a fine run's top (21061 at 150 %: 8.46 -> 4.46 blocks when
   * it ran before). A reverted run is counted `verify`. Without `lane` (the grid-only callers) it checks nothing.
   * TODO(cross-pass-main): the jump-rule runs are not judged (76419 has one along the same row at x 16-19, a
   * 2-block side; months of device rounds stand on them) - judge them too once a round shows one in the way.
   */
  const crossPass = (): void => {
    if (!lane || !edits.some(e => e.run.fine)) return;
    /** The forms with every run laid, and the walk over them (the probes' floors); rebuilt after a run is swapped. */
    const laidForms = (): { fg: ScaledColliderGrid; reach: ReachResult } => {
      const fg = new ScaledColliderGrid(lane.cells, dims, f, rotation, carve);
      for (const e of edits) for (const w of e.writes) fg.write(w.x, w.z, { ...w.block });
      return { fg, reach: walkScaledColliders(fg, undefined, SAFE_DROP16) };
    };
    let { fg, reach } = laidForms();
    /**
     * The forms with EVERY run laid, climbing only what auto-jump climbs (`AutoJumpGrid`), and the walk over them:
     * the same for every run judged until one is reverted,
     * so built once per revert (it was rebuilt per run, twice - here and in `gateway` - and was most of the pass's
     * cost: 76417 at 300 % under the carve, ~140 runs judged, 39 of a 57 s plan).
     */
    interface AllLaid { grid: AutoJumpGrid; reach: ReachResult; under: Map<RunEdit, Array<{ x: number; z: number; row: number; block: ColumnBlock | undefined }>> }
    let allLaid: AllLaid | undefined;
    const withEveryRun = (): AllLaid => {
      if (!allLaid) {
        // Laid run by run, keeping what each run's writes covered, so `formReach(e)` can lift one run off and back.
        const grid = new AutoJumpGrid(lane.cells, dims, f, rotation, carve);
        const under = new Map<RunEdit, Array<{ x: number; z: number; row: number; block: ColumnBlock | undefined }>>();
        for (const e of edits) {
          under.set(e, e.writes.map(w => ({ x: w.x, z: w.z, row: w.block.row, block: grid.blockAt(w.x, w.z, w.block.row) })));
          for (const w of e.writes) grid.write(w.x, w.z, { ...w.block });
        }
        allLaid = { grid, reach: walkScaledColliders(grid), under };
      }
      return allLaid;
    };
    /**
     * The walk over the forms with every run laid but `skip`: the shared grid with that run's writes lifted off
     * (what they covered put back) and laid again after. Exact because a run a later one writes over is never
     * judged (it is that run's floor), so nothing laid after `skip` sits in its cells.
     */
    const formReach = (skip?: RunEdit): ReachResult => {
      const all = withEveryRun();
      if (!skip) return all.reach;
      const g = all.grid, under = all.under.get(skip)!;
      for (let i = under.length - 1; i >= 0; i--) { const u = under[i]!; if (u.block) g.write(u.x, u.z, { ...u.block }); else g.erase(u.x, u.z, u.row); }
      const r = walkScaledColliders(g);
      for (const w of skip.writes) g.write(w.x, w.z, { ...w.block });
      return r;
    };
    const blocksOf = (skip?: RunEdit): TreadBlock[] => {
      const out = new Map<string, TreadBlock>();
      for (const e of edits) if (e !== skip) for (const w of e.writes) out.set(`${w.x},${w.block.row},${w.z}`, { x: w.x, y: w.block.row, z: w.z, lo: w.block.lo, hi: w.block.hi });
      return [...out.values()];
    };
    /**
     * The surfaces a run is the GATEWAY to: in the breadth-first walk from the ground over the forms with every run
     * laid (climbing auto-jump's 1.2, `AutoJumpGrid`), those first reached over one of the run's treads.
     */
    const gateway = (e: RunEdit): number => {
      const g = withEveryRun().grid;
      const own = new Set(e.treadSurfaces.map(q => g.key(q.x, q.z, q.t)));
      const via = new Map<number, boolean>();
      const queue: Surface[] = [];
      for (let x = -1; x <= g.width; x++) for (let z = -1; z <= g.length; z++) {
        if (x !== -1 && z !== -1 && x !== g.width && z !== g.length) continue;
        for (const t of g.surfaces(x, z)) { const k = g.key(x, z, t); if (!via.has(k)) { via.set(k, false); queue.push({ x, z, t }); } }
      }
      let count = 0;
      for (let h = 0; h < queue.length; h++) {
        const q = queue[h]!, through = via.get(g.key(q.x, q.z, q.t))!;
        for (const [nx, nz] of [[q.x + 1, q.z], [q.x - 1, q.z], [q.x, q.z + 1], [q.x, q.z - 1]] as const) {
          if (!g.inRing(nx, nz)) continue;
          for (const t of g.surfaces(nx, nz)) {
            const k = g.key(nx, nz, t);
            if (via.has(k) || !g.canMove(q.x, q.z, q.t, nx, nz, t)) continue;
            const v = through || own.has(k);
            via.set(k, v);
            if (v && !own.has(k)) count++;
            queue.push({ x: nx, z: nz, t });
          }
        }
      }
      return count;
    };
    let reverted = false;
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i]!;
      // A lane run had its own cross walks (`lanePass`); a run a later one writes over is that run's floor.
      if (!e.run.fine || e.run.lane) continue;
      const mine = new Set(e.writes.map(w => `${w.x},${w.block.row},${w.z}`));
      if (edits.slice(i + 1).some(o => o.writes.some(w => mine.has(`${w.x},${w.block.row},${w.z}`)))) continue;
      // Only walks that start on the GROUND: the way in from outside. Judged on every reached floor, the pass also
      // took the hill runs above 76419's south shore at 300 % (the straight climb there 7.25 -> 4.44 blocks), and
      // those climb more than their sides cost.
      const probes = crossLaneProbes(fg, reach, e.columns).filter(pr => pr.from.y <= groundProbeY(f, !!carve?.size) + 1e-9);
      if (!probes.length) continue;
      const withRun = blocksOf(), withoutRun = blocksOf(e);
      const worse = probes.some(pr => lane.walk(withRun, pr.from, pr.dir, LANE_CROSS) < lane.walk(withoutRun, pr.from, pr.dir, LANE_CROSS) - LANE_SLACK);
      if (!worse) continue;
      // A SOFTENED run (`RunEdit.hard`) that shortens a walk in goes back to the jump's hops and is judged as that:
      // auto-jump climbs the softened one, so the walk below counts what it opens and would keep it whatever its side
      // costs - on 21063's 300 % east edge (z 39-40) two runs walled the flank lanes the Pixel climbed (10.38 -> 2.19
      // blocks), where their jump-height forms opened nothing auto-jump climbs and were reverted (2026-10-17).
      // The swap keeps the never-block invariant on the full-cell grid as a revert does; where it would not, the
      // softened run is judged as it is.
      if (e.hard) {
        const prior = walkScaledColliders(grid);
        revert(e); apply(e.hard); edits[i] = e.hard;
        if (neverBlocks(walkScaledColliders(grid), true, prior)) {
          allLaid = undefined; reverted = true;
          ({ fg, reach } = laidForms());
          i++;
          continue;
        }
        revert(e.hard); apply(e); edits[i] = e;
      }
      // Kept when the walk over the FORMS loses any surface without it (bar its own tread tops; judged before the
      // gateway, which costs a walk of its own and only matters for a run that loses nothing): a climb is worth
      // its sides. Judged on the full-cell grid, a wall's rim read as a floor offered a way round that the shipped
      // forms do not, and 21061's 150 % reach fell 8.46 -> 4.25 blocks. The walk climbs only auto-jump's 1.2, as a
      // child on touch does: with the jump's 1.25 it found a way up 21063's east flank at 200 % without the run
      // there, the pass took the run, and the climb the Pixel walked to the lawn (round 30zi) stopped 3.7 blocks
      // up instead of 8.1.
      const reachWith = formReach(), reachWithout = formReach(e);
      const own = new Set(e.treadSurfaces.map(s => fg.key(s.x, s.z, s.t)));
      let lost = false;
      for (const k of reachWith.visited) if (!own.has(k) && !reachWithout.visited.has(k)) { lost = true; break; }
      if (lost) continue;
      // Kept when it is the GATEWAY to enough of the model: 21063's east-flank run at 200 % is the first way to 115
      // surfaces (the road and the lawn the Pixel walked to in round 30zi); removed, the climb there stopped 3.7
      // blocks up instead of 8.1, though a grid walk found other ways round. 76419's boathouse run is the first way
      // to 8, a hut roof, and goes.
      if (gateway(e) >= Math.max(CROSS_GATEWAY_MIN, CROSS_GATEWAY_PER_TREAD * e.columns.length)) continue;
      // Never block on the full-cell grid too; what the other runs climb to is judged on the forms above (the
      // lane runs were proved there, and the full-cell reading can strand one the forms still reach).
      const prior = walkScaledColliders(grid);
      revert(e); edits.splice(i, 1);
      if (!neverBlocks(walkScaledColliders(grid), true, prior)) { edits.splice(i, 0, e); apply(e); continue; }
      refuse(e.run.from, e.run.to, 'verify');
      reverted = true;
      allLaid = undefined;
    }
    // The second guard pass reads the lane pass's form grid: lay it again without the reverted runs.
    if (reverted && formGrid) {
      formGrid = new ScaledColliderGrid(lane.cells, dims, f, rotation, carve);
      for (const e of edits) for (const w of e.writes) formGrid.write(w.x, w.z, { ...w.block });
    }
  };
  /**
   * THE LANE PASS (2026-10-07). Every pass above restores a surface only where the grid walk does not reach
   * it, and the grid walk climbs a jump (1.25) and takes any detour; a child on touch climbs by AUTO-JUMP
   * alone (Bedrock's touch default: an obstacle over 0.5 and at most 1.2 over the feet, sim/physics/body.ts
   * `autoJumpWanted`) and walks straight. 10261's lift hill at 200 % is reached by the grid walk from the next
   * lane, while a straight lane rises 1.25 at x 28.5 and 1.75 every second column from x 40 - the Pixel's
   * auto-jump-only climb stopped at pin + 28.2 on three tries (round 30k), as `_walk_line.ts --jump=auto` does.
   *
   * So, last: every rise between two surfaces the safe walk reaches, in adjacent columns of a straight LANE,
   * that is taller than auto-jump (`AUTO_JUMP16`) while within the 100 % rule, is offered a run whose hops
   * auto-jump climbs. A lane is a climb that continues: the column behind the foot holds a reached surface at
   * most an auto-jump under it, and the column past the top one at most an auto-jump over it - a hill or a
   * stair, not a wall's rim over a drop. Bottom up.
   *
   * The grid reads a clearance form as its whole cell, and at 200 % a form's columns differ by up to a block
   * (10261's x 30 is 12.0 where the grid reads 12.875), so a run planned on the grid alone raised lanes the
   * forms keep lower and the straight walk got WORSE (x 39.7 -> 30.7, tried twice). So each run is kept only
   * when `lane.walk` - the per-tick player with auto-jump over the shipped FORMS and every tread so far - walks
   * the lane from the run's landing into the column past the riser's top with it and did not without it
   * (`LANE_PAST`), and no straight walk INTO a column it writes, from two columns out along x or z, gets shorter
   * (`LANE_CROSS`, `LANE_SLACK`: a tread on another lane's approach is a new riser there); and the whole pass is
   * verified never to block over the form grid (all at once, then run by run when the batch fails), so it only
   * adds. Without `lane` (the grid-only callers) the pass lays nothing: certain-only.
   */
  const lanePass = (): void => {
    if (!lane) return;
    const walk = lane.walk;
    // The FORM grid: each column read from its OWN pieces of a clearance form, with every tread laid so far.
    const fg = new ScaledColliderGrid(lane.cells, dims, f, rotation, carve);
    for (const e of edits) for (const w of e.writes) fg.write(w.x, w.z, { ...w.block });
    const fBefore = walkScaledColliders(fg);
    let reach = walkScaledColliders(fg, undefined, SAFE_DROP16);
    /** Column key -> the floors lane treads replaced there (a column may hold treads at two levels). */
    const laneFloor = new Map<number, Set<number>>();
    const laneEdits: RunEdit[] = [];
    // The lane pass's protections are per column AND level: a tread laid under a track (10261's lower level, 10
    // blocks down) does not stop a run on the track over it. Within a body height of another run's tread or
    // arrival, the column is taken.
    const near = (t: number, spans: ReadonlyArray<readonly [number, number]>): boolean => spans && spans.some(([a, b]) => t >= a - PLAYER_NEED16 && t <= b + PLAYER_NEED16);
    const laneSpans = (x: number, z: number, arrivalsToo: boolean): Array<readonly [number, number]> => {
      const out: Array<readonly [number, number]> = [];
      for (const e of laneEdits) {
        for (const c of e.columns) if (c.x === x && c.z === z) out.push([c.floor16, c.top16]);
        if (arrivalsToo) for (const a of [e.to, e.landing]) if (a.x === x && a.z === z) out.push([a.t, a.t]);
      }
      return out;
    };
    const ground: RunGround = {
      g: fg, stacked: () => true,
      treadAt: (x, z, t) => near(t, laneSpans(x, z, false)),
      taken: (x, z, t) => near(t, laneSpans(x, z, true)),
      isTreadTop: q => laneEdits.some(e => e.columns.some(c => c.x === q.x && c.z === q.z && c.top16 === q.t)),
    };
    const reachedNear = (x: number, z: number, lo: number, hi: number): boolean => fg.inRing(x, z) && fg.surfaces(x, z).some(t => t >= lo && t <= hi && reach.visited.has(fg.key(x, z, t)));
    /**
     * This round's candidates, bottom up: a riser over auto-jump (and within two) from a REACHED surface `p` to
     * the next column's surface `q` (reached or not - a run makes it so, as every pass restores the unreached
     * under the 100 % rule), the lane continuing either side; each edge offered once over the whole pass.
     */
    const tried = new Set<string>();
    const scan = (): Array<{ p: Surface; q: Surface }> => {
      const out: Array<{ p: Surface; q: Surface }> = [];
      for (const k of reach.visited) {
        const p = fg.unkey(k);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = p.x + dx, nz = p.z + dz;
          if (!fg.inside(nx, nz)) continue;
          for (const t of fg.surfaces(nx, nz)) {
            const rise = t - p.t;
            if (rise <= AUTO_JUMP16 || rise > 2 * AUTO_JUMP16) continue;
            if (!reachedNear(p.x - dx, p.z - dz, p.t - AUTO_JUMP16, p.t)) continue;
            if (!fg.inRing(nx + dx, nz + dz) || !fg.surfaces(nx + dx, nz + dz).some(u => u >= t && u <= t + AUTO_JUMP16)) continue;
            const key = `${p.x},${p.z},${p.t}>${nx},${nz},${t}`;
            if (tried.has(key)) continue;
            tried.add(key);
            out.push({ p, q: { x: nx, z: nz, t } });
          }
        }
      }
      return out.sort((a, b) => a.p.t - b.p.t || a.p.x - b.p.x || a.p.z - b.p.z || a.q.x - b.q.x || a.q.z - b.q.z);
    };
    /** Every tread block laid so far, the main plan's then the lane pass's (the final pair per block). */
    let laidCache: { count: number; last: RunEdit | undefined; blocks: TreadBlock[] } | undefined;
    const laidBlocks = (): TreadBlock[] => {
      // Rebuilt only when the lane runs changed (thousands of walks read it between changes).
      const last = laneEdits[laneEdits.length - 1];
      if (laidCache && laidCache.count === laneEdits.length && laidCache.last === last) return laidCache.blocks;
      const out = new Map<string, TreadBlock>();
      for (const e of [...edits, ...laneEdits]) for (const w of e.writes) out.set(`${w.x},${w.block.row},${w.z}`, { x: w.x, y: w.block.row, z: w.z, lo: w.block.lo, hi: w.block.hi });
      laidCache = { count: laneEdits.length, last, blocks: [...out.values()] };
      return laidCache.blocks;
    };
    /**
     * Whether the auto-jump walker, starting on the run's landing (its column centre, its floor), walks along the
     * lane into the column past `q` (`LANE_PAST` into it): the lane is climbed.
     */
    const climbs = (e: RunEdit): boolean => {
      const dx = e.to.x - e.landing.x, dz = e.to.z - e.landing.z, n = Math.abs(dx) + Math.abs(dz);
      const dir = { x: Math.sign(dx), z: Math.sign(dz) }, goal = n + 0.5 + LANE_PAST;
      return walk(laidBlocks(), { x: e.landing.x + 0.5, y: e.landing.t / 16 + 0.01, z: e.landing.z + 0.5 }, dir, goal) >= goal - 1e-6;
    };
    const noteFloors = (e: RunEdit): void => {
      for (const c of e.columns) {
        const k = colKey(c.x, c.z);
        let set = laneFloor.get(k);
        if (!set) laneFloor.set(k, set = new Set());
        set.add(c.floor16);
      }
    };
    const laneApply = (e: RunEdit): void => {
      for (const w of e.writes) fg.write(w.x, w.z, w.block);
      noteFloors(e);
      laneEdits.push(e);
    };
    const laneRevert = (e: RunEdit): void => {
      for (let i = e.writes.length - 1; i >= 0; i--) {
        const w = e.writes[i]!;
        if (w.previous) fg.write(w.x, w.z, w.previous); else fg.erase(w.x, w.z, w.block.row);
      }
      laneEdits.splice(laneEdits.indexOf(e), 1);
      laneFloor.clear();
      for (const o of laneEdits) noteFloors(o);
    };
    /** Never block, over the form grid: every surface reached before the pass still is, save a floor a lane tread now covers. */
    const laneHolds = (): boolean => {
      const after = walkScaledColliders(fg);
      for (const k of fBefore.visited) {
        if (after.visited.has(k)) continue;
        const { x, z, t } = fg.unkey(k);
        if (!laneFloor.get(colKey(x, z))?.has(t)) return false;
      }
      return true;
    };
    const layRound = (candidates: ReadonlyArray<{ p: Surface; q: Surface }>, verifyEach: boolean): void => {
      for (const { p, q } of candidates) {
        // An earlier run may have raised p's column (then p is no longer a top) or made the rise climbable.
        if (p.t > 0 && !fg.blockWithTop(p.x, p.z, p.t)) continue;
        if (!fg.surfaces(q.x, q.z).includes(q.t) || q.t - p.t <= AUTO_JUMP16) continue;
        const e = planRunCore(p, q, reach.visited, AUTO_JUMP16, ground);
        if (typeof e === 'string') continue;
        // Already climbed from where the run would start (the forms climb where the grid reads a wall): no run.
        if (climbs(e)) continue;
        // Every straight lane INTO a column the run raises, from two columns out in each direction: a run must
        // not stop a walk it was not laid for (a tread on another lane's approach is a new riser there).
        // TODO(lane-pass-cost): the `was` walks repeat between runs that touch nothing near them; cache them per
        // probe until a run writes within its reach (~10 s per size and turn at 200-400 % on 10261, ~10,000 walks).
        const probes = crossLaneProbes(fg, reach, e.columns);
        const was = probes.map(pr => walk(laidBlocks(), pr.from, pr.dir, LANE_CROSS));
        laneApply(e);
        const worse = probes.some((pr, i) => walk(laidBlocks(), pr.from, pr.dir, LANE_CROSS) < was[i]! - LANE_SLACK);
        if (worse || !climbs(e) || (verifyEach && !laneHolds())) laneRevert(e);
      }
    };
    /** Rounds until one lays nothing: a run up one riser reaches the foot of the next. */
    const lay = (verifyEach: boolean): void => {
      for (let round = 0; round < LANE_ROUNDS; round++) {
        const count = laneEdits.length;
        layRound(scan(), verifyEach);
        if (laneEdits.length === count) break;
        reach = walkScaledColliders(fg, undefined, SAFE_DROP16);
      }
    };
    lay(false);
    if (laneEdits.length && !laneHolds()) {
      for (let i = laneEdits.length - 1; i >= 0; i--) laneRevert(laneEdits[i]!);
      tried.clear();
      reach = walkScaledColliders(fg, undefined, SAFE_DROP16);
      lay(true);
    }
    // Into the plan: the main grid takes the lane treads as the runtime lays them (its row replaced). They are
    // proved by the walk and the form grid; the full-cell grid's own reach is reported, not re-judged.
    for (const e of laneEdits) {
      const writes = e.writes.map(w => ({ x: w.x, z: w.z, block: w.block, previous: grid.blockAt(w.x, w.z, w.block.row) ?? null }));
      for (const w of writes) grid.write(w.x, w.z, w.block);
      edits.push({ ...e, writes, run: { ...e.run, lane: true } });
    }
    // Every tread of the plan is laid in it (the main plan's at the start, the lane runs as they were kept).
    formGrid = fg;
  };
  /**
   * THE REACH GUARDS (2026-10-08, after Pixel round 30l; every reached edge and the form grid since 2026-10-11,
   * after round 30m). Every pass above makes surfaces reachable that the model, at this size, did not let a
   * child walk to - and the edges of that new reach are nobody's design: the lane pass took the Pixel player up
   * 10261's lift hill at 200 % to pin + (69.2, 42), and walking straight on past the top, where the track curves
   * away, it walked off the model at x ~81 and fell 43.5 blocks. Before the pass that edge was out of reach on
   * foot. And the model's own reach grows past its design with the size: a ledge a minifig drops off is, at
   * 200-400 %, a fall of two to four times its height for a player who stays player-sized. So, last: wherever a
   * surface the walk with the treads reaches meets a neighbouring column the body walks into at its height and,
   * walking straight on, falls more than `REACH_GUARD_DROP16` (`walkOffDrop`: a column catches the body only when
   * its top is no further down than the body has fallen while still over it, `WALK_OFF_FALL16`; the Pixel crossed
   * a ledge 3.6 blocks under 10261's lift top and fell the 43 past it, round 30m), that column gets a guard -
   * its empty cells filled from the surface's top to `REACH_GUARD_HEIGHT16` over it, as bedrock-interactives.ts
   * `planDropGuards` guards a doorway over a drop at export. The 100 % grid gets none (no plan is made there:
   * whatever it reaches is the model's own, at the scale the set was built for). Until 2026-10-11 only a FRESH
   * surface - reached now and NOT by the unassisted walk (`before`, which takes any jump, detour and drop) - was
   * guarded (COL-01).
   *
   * Certain only, never blocking. The grid here reads a clearance form as its whole cell, which over-reads
   * solid: a column it calls open is open and a fall it measures is at least that deep, so a guard stands only
   * over a certain fall. But a fall the full-cell reading HIDES is a fall all the same: 10261's lift top at
   * 200 % (round 30m, pin + (79.5, 43.6, 27.7) then +x) ends, in the shipped forms, at world x 80 on the z 27
   * lane - the form of cell (40, 13) covers only its north half - while this grid reads world columns 80 and 81
   * solid to 43.6 there, so the guard stood at x 82 and the device walked off at x 80 and fell 43 blocks. So
   * when the plan has the lane check it runs the SAME pass a second time over the FORM grid (every form as its
   * own pieces per world column, the treads and the first pass's guards laid), where that lane ends at an open
   * column; a column the form grid calls open holds no geometry either (a form is a superset of its geometry),
   * so its guards are as certain. Never in a doorway's column. A guard whose top a reached surface still steps
   * onto is raised a block (at most `GUARD_RAISES` times). And the guards are verified as a batch, then by
   * halves down to one column: every surface the walk reached with the treads that was reached before them,
   * and every surface reached without a fall past the limit, must still be reached, and no guard's top may be -
   * a column that fails is left unguarded and counted (`unguarded.verify`).
   * A column past the footprint cannot hold a guard (the runtime re-lays and clears only its boxes), so a fresh
   * surface on the border over a fall is CAPPED instead: the guard stands over its own top and the next column
   * in becomes the edge (10261 at 200 %: the lift's north side runs along z 0). A surface of the model's OWN
   * reach on the border is never capped (a cap gives up the column, and the model's reach is kept whole), and a
   * border edge left open (a doorway's column, the model's own, a cap that fails the check) is counted as
   * `pastEdge` (`TODO(reach-guards)`: a guard ring outside the footprint would need the runtime's boxes widened).
   */
  /** One guard column: its spans (merged where they overlap; each is clear, as every span is), and the writes laying it. */
  interface Guard { x: number; z: number; spans: Array<[number, number]>; drop16: number; edges: number; caps: Surface[]; writes: Array<{ block: ColumnBlock; previous: ColumnBlock | null }>; laid: boolean }
  const mergeSpans = (spans: ReadonlyArray<readonly [number, number]>): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const [a, b] of [...spans].sort((p, q) => p[0] - q[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b); else if (b > a) out.push([a, b]);
    }
    return out;
  };
  /** Lay a guard's spans in grid `g` (a solid already in a row - a slab's underside, a capped surface's own top - is joined, not replaced). */
  const layGuard = (g: ScaledColliderGrid, guard: Guard): void => {
    guard.writes = [];
    for (const [a, b] of guard.spans) {
      for (let row = Math.floor(a / 16); row * 16 < b; row++) {
        const l = Math.max(0, a - row * 16), h = Math.min(16, b - row * 16);
        if (h <= l) continue;
        const previous = g.blockAt(guard.x, guard.z, row) ?? null;
        const block: ColumnBlock = previous ? { row, lo: Math.min(l, previous.lo), hi: Math.max(h, previous.hi), src16: previous.src16 } : { row, lo: l, hi: h, src16: a };
        guard.writes.push({ block, previous });
        g.write(guard.x, guard.z, block);
      }
    }
    guard.laid = true;
  };
  const unlayGuard = (g: ScaledColliderGrid, guard: Guard): void => {
    for (let i = guard.writes.length - 1; i >= 0; i--) {
      const w = guard.writes[i]!;
      if (w.previous) g.write(guard.x, guard.z, w.previous); else g.erase(guard.x, guard.z, w.block.row);
    }
    guard.writes = [];
    guard.laid = false;
  };
  /** The highest top at or under `t` in a column of `g` (the ground, 0, when none). */
  const topUnder = (g: ScaledColliderGrid, x: number, z: number, t: number): number => {
    let landing = 0;
    for (const b of g.column(x, z).blocks) { const top = b.row * 16 + b.hi; if (top <= t && top > landing) landing = top; }
    return landing;
  };
  /**
   * The fall (sixteenths) a player walking straight off surface `s` toward (dx, dz) takes, by `WALK_OFF_FALL16`:
   * column k past the edge catches the body when its top is no further down than the body has fallen while still
   * over it; a solid the body meets in column k while still over column k - 1 (anything in the column from the
   * body's height then to the top of its head) stops it, and it drops in column k - 1; past the footprint there
   * is only the ground. Not caught by the last column of the table, the body has fallen past the limit already.
   */
  const walkOffDrop = (g: ScaledColliderGrid, s: Surface, dx: number, dz: number): number => {
    let previous = 0;
    for (let k = 1; k < WALK_OFF_FALL16.length; k++) {
      const x = s.x + k * dx, z = s.z + k * dz;
      const inside = g.inside(x, z);
      if (k > 1 && inside && !g.clear(x, z, s.t - WALK_OFF_FALL16[k - 1]!, s.t + PLAYER_NEED16)) return s.t - previous;
      const top = inside ? topUnder(g, x, z, s.t) : 0;
      if (top >= s.t - WALK_OFF_FALL16[k]!) return s.t - top;
      previous = top;
    }
    return s.t - previous;
  };
  /** The guards laid so far, by the pass that laid them, and the counts the report carries. */
  const guardsLaid: Guard[] = [];
  const guardCounts = { capped: 0, formColumns: 0, unguarded: { door: 0, verify: 0 }, pastEdge: 0 };
  /**
   * One guard pass over grid `g` with its treads laid: `base` is the unassisted walk over that grid (what is
   * the model's own reach there), `prior` the guards an earlier pass laid, written into `g` first so they read
   * as walls and are never laid twice. Returns the guards this pass kept (their writes are in `g`).
   */
  const guardPass = (g: ScaledColliderGrid, base: ReachResult, prior: readonly Guard[]): Guard[] => {
    for (const p of prior) layGuard(g, { ...p, spans: p.spans.map(([a, b]) => [a, b] as [number, number]), writes: [], laid: false });
    const reached = walkScaledColliders(g);
    const top16 = g.height * 16;
    /** Every reached surface inside the footprint, high enough that a fall from it can pass the limit; fresh = not the model's own reach. */
    const standing: Array<Surface & { fresh: boolean }> = [];
    for (const k of reached.visited) {
      const s = g.unkey(k);
      if (g.inside(s.x, s.z) && s.t > REACH_GUARD_DROP16) standing.push({ ...s, fresh: !base.visited.has(k) });
    }
    if (!standing.length) return [];
    // In a fixed order (the plan is pure).
    standing.sort((p, q) => p.x - q.x || p.z - q.z || p.t - q.t);
    const unguarded = { door: 0, verify: 0 };
    let pastEdge = 0;
    const guards = new Map<number, Guard>();
    const add = (x: number, z: number, span: [number, number], drop16: number, cap?: Surface): void => {
      const ck = colKey(x, z);
      let guard = guards.get(ck);
      if (!guard) guards.set(ck, guard = { x, z, spans: [], drop16, edges: 0, caps: [], writes: [], laid: false });
      if (cap) guard.caps.push(cap);
      guard.spans = mergeSpans([...guard.spans, span]);
      guard.drop16 = Math.max(guard.drop16, drop16);
      guard.edges++;
    };
    const sides = (s: Surface): Array<readonly [number, number]> => [[s.x + 1, s.z], [s.x - 1, s.z], [s.x, s.z + 1], [s.x, s.z - 1]];
    // 1. THE FOOTPRINT'S BORDER. Past it there is no column to guard (the runtime re-lays and clears only its
    //    boxes), so a fresh surface on the border over a fall to the ground is CAPPED: its own column takes the
    //    guard over its top, and the next column in becomes the edge, held by a wall instead of a fall. It gives up
    //    a column of the reach the treads made - never the model's own, whose border edge stays open (`pastEdge`).
    for (const s of standing) {
      const out = sides(s).filter(([nx, nz]) => !g.inside(nx, nz)).length;
      if (!out) continue;
      if (!s.fresh || doorColumns.has(colKey(s.x, s.z))) { pastEdge += out; continue; }
      // A column with two fresh border surfaces (a deck over a deck) caps both.
      add(s.x, s.z, [s.t, Math.min(top16, s.t + REACH_GUARD_HEIGHT16)], s.t, s);
    }
    for (const guard of guards.values()) layGuard(g, guard);
    const capped = new Set<number>([...guards.values()].flatMap(guard => guard.caps.map(c => g.key(c.x, c.z, c.t))));
    // 2. EVERY OTHER EDGE, read with the caps laid: a column the body walks into at a reached surface's height
    //    and, walking straight on, falls more than the limit (`walkOffDrop`) takes a guard over that surface's top.
    const edged = new Set<number>();
    for (const s of standing) {
      if (capped.has(g.key(s.x, s.z, s.t))) continue;
      for (const [nx, nz] of sides(s)) {
        if (!g.inside(nx, nz)) continue;
        const ck = colKey(nx, nz);
        // A capped column is a wall now (should anything step onto its top, the raise and the check below see it).
        if (guards.get(ck)?.caps.length) continue;
        // A wall or a step up within the body's height: the body does not go over an edge into this column.
        if (!g.clear(nx, nz, s.t, s.t + PLAYER_NEED16)) continue;
        const drop16 = walkOffDrop(g, s, nx - s.x, nz - s.z);
        if (drop16 <= REACH_GUARD_DROP16) continue;
        if (doorColumns.has(ck)) { unguarded.door++; continue; }
        add(nx, nz, [s.t, Math.min(top16, s.t + REACH_GUARD_HEIGHT16)], drop16);
        edged.add(ck);
      }
    }
    // Laid only after every edge is read: a guard laid early would read as a wall to the next surface's edge.
    for (const ck of edged) layGuard(g, guards.get(ck)!);
    const all = [...guards.values()];
    // What the guards must keep: the old reach that survived the treads, every run's target and tread (the treads'
    // own never-block rule), and every surface walked to without a fall past the limit, with the treads and
    // without any guard - save a capped surface itself, and save the LEDGE a guard stands over: the highest top
    // under the guard's foot in its column (10261's ledge 3.6 blocks under the lift top, which the walk-off
    // overshoots and the guard now keeps the body from dropping onto) and any surface there within a body's
    // height under the foot (its headroom is the guard's). Those are given up from this side; anything reached
    // only through them still has to be reached, or the guard fails the check below.
    for (const guard of all) unlayGuard(g, guard);
    const shadowed = (k: number): boolean => {
      const s = g.unkey(k), guard = guards.get(colKey(s.x, s.z));
      return !!guard && guard.spans.some(([a]) => s.t <= a && (s.t > a - PLAYER_NEED16 || s.t === topUnder(g, s.x, s.z, a)));
    };
    const keep: number[] = [...walkScaledColliders(g, undefined, REACH_GUARD_DROP16).visited].filter(k => !capped.has(k) && !shadowed(k));
    for (const k of reached.visited) if (base.visited.has(k)) keep.push(k);
    for (const e of edits) for (const s of [e.to, ...e.treadSurfaces]) { const k = g.key(s.x, s.z, s.t); if (reached.visited.has(k)) keep.push(k); }
    for (const guard of all) layGuard(g, guard);
    const topReached = (guard: Guard, walked: ReachResult): boolean => guard.spans.some(([, b]) => walked.visited.has(g.key(guard.x, guard.z, b)));
    // A guard a reached surface steps onto is no rail: raise it a block (the walk is redone after each round).
    for (let raise = 0; raise < GUARD_RAISES; raise++) {
      const walked = walkScaledColliders(g);
      const hit = all.filter(guard => topReached(guard, walked));
      if (!hit.length) break;
      for (const guard of hit) { unlayGuard(g, guard); guard.spans = mergeSpans(guard.spans.map(([a, b]) => [a, Math.min(top16, b + 16)] as [number, number])); layGuard(g, guard); }
    }
    const fine = (): boolean => {
      const walked = walkScaledColliders(g);
      return keep.every(k => walked.visited.has(k)) && !all.some(guard => guard.laid && topReached(guard, walked));
    };
    // Verified as a batch, then by halves: a half that fails is split until the failing columns stand alone.
    const settle = (batch: Guard[]): void => {
      for (const guard of batch) if (!guard.laid) layGuard(g, guard);
      if (fine()) return;
      for (const guard of batch) unlayGuard(g, guard);
      if (batch.length === 1) { if (batch[0]!.caps.length) pastEdge += batch[0]!.edges; else unguarded.verify += batch[0]!.edges; return; }
      const mid = batch.length >> 1;
      settle(batch.slice(0, mid));
      settle(batch.slice(mid));
    };
    if (!fine()) { for (const guard of all) unlayGuard(g, guard); settle(all); }
    guardCounts.unguarded.door += unguarded.door; guardCounts.unguarded.verify += unguarded.verify; guardCounts.pastEdge += pastEdge;
    return all.filter(guard => guard.laid);
  };
  /**
   * The guard passes: over the full-cell grid, then - with the lane check, which brings the forms - over the
   * form grid with the first pass's guards laid. The form grid's own unassisted walk is its base (the main
   * plan's `before` is the full-cell grid's).
   */
  const guardPasses = (): void => {
    const first = guardPass(grid, before, []);
    guardsLaid.push(...first);
    if (formGrid) {
      const second = guardPass(formGrid, walkScaledColliders(new ScaledColliderGrid(lane!.cells, dims, f, rotation, carve)), first);
      guardsLaid.push(...second);
      guardCounts.formColumns = second.length;
    }
    if (!guardsLaid.length) return;
    guardCounts.capped = guardsLaid.filter(guard => guard.caps.length).length;
    const out = new Map<string, TreadBlock>();
    for (const guard of guardsLaid) for (const w of guard.writes) out.set(`${guard.x},${w.block.row},${guard.z}`, { x: guard.x, y: w.block.row, z: guard.z, lo: w.block.lo, hi: w.block.hi });
    guardBlocks = [...out.values()];
    guardReport = {
      columns: guardsLaid.length, capped: guardCounts.capped, formColumns: guardCounts.formColumns, blocks: guardBlocks.length, unguarded: guardCounts.unguarded, pastEdge: guardCounts.pastEdge,
      sample: guardsLaid.slice(0, MAX_REFUSED_REPORTED).map(guard => ({ x: guard.x, z: guard.z, lo16: guard.spans[0]![0], hi16: guard.spans[guard.spans.length - 1]![1], drop16: guard.drop16, ...(guard.caps.length ? { cap: true as const } : {}) })),
    };
  };
  // Fast path: one laying walk, then a single verification from scratch.
  layingWalk(false);
  let after = walkScaledColliders(grid);
  if (holds(after)) { doorwayPass(); latePass(); lanePass(); crossPass(); guardPasses(); return report(walkScaledColliders(grid), edits, true); }
  // Slow path: undo everything and re-plan one run at a time, each verified
  // against the unassisted walk, until a pass lays nothing new.
  for (let i = edits.length - 1; i >= 0; i--) revert(edits[i]!);
  edits.length = 0; failed.clear(); arrivals.clear();
  unrestored['no-run'] = 0; unrestored.headroom = 0; unrestored.verify = 0; refused.length = 0; refusedTargets.length = 0; failedReason.clear();
  for (let pass = 0; pass < 64; pass++) {
    const count = edits.length;
    layingWalk(true);
    if (edits.length === count) break;
  }
  after = walkScaledColliders(grid);
  if (holds(after)) { doorwayPass(); latePass(); lanePass(); crossPass(); guardPasses(); return report(walkScaledColliders(grid), edits, true); }
  for (let i = edits.length - 1; i >= 0; i--) revert(edits[i]!);
  edits.length = 0;
  return report(walkScaledColliders(grid), [], false);
}

/** Sixteenths above the pin as blocks at 100 % (comparable across sizes), two decimals. */
export const blocksAt100 = (t16: number, f: number): number => Math.round(t16 / 16 / f * 100) / 100;
