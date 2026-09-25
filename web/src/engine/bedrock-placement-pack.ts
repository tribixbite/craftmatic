import { QUARTER_TURNS, colliderPairIndex, colliderPairOf, planColliderTreads, type QuarterTurn, type ReachTarget, type SourceCell, type TreadBlock, type TreadPlan } from './bedrock-collider-scale.js';
import { COLLIDER_KIT, colliderFormKit, type ColliderFormKit } from './collider-form.js';

declare const world: any;
declare const system: any;
declare const StructureSaveMode: any;
declare const BlockPermutation: any;
declare const BlockVolume: any;
declare const ActionFormData: any;
declare const ModalFormData: any;

export type PlacementRotation = 0 | 90 | 180 | 270;

export interface PlacementActor {
  typeId: string;
  label: string;
  x: number; y: number; z: number;
  yaw?: number;
  /** Spawn only while the selected wand size is below this percentage. */
  maxSizeExclusive?: number;
  /** Runtime-door candidate whose successful installation may replace this actor. */
  doorCandidateIndex?: number;
  /** The 100% structure already contains the measured vanilla replacement. */
  hideAt100?: boolean;
  /** Index of another actor this one rides once both are spawned (a figure found sitting on a seat). */
  rideOf?: number;
  /** Measured track route index; the coaster runtime owns motion after placement. */
  coasterRouteIndex?: number;
  /** This car's place in its route's train (0 = lead); written so the order is deterministic, not first-seen. */
  coasterCarIndex?: number;
  /** A pinball part (console, ball, flipper); the pinball runtime groups them by the placement frame written here. */
  pinball?: boolean;
  /**
   * An interactive part's index in `scripts/interactives.js`'s items
   * (bedrock-interactives.ts): the placement writes it with the anchor, turn
   * and size, and the interactives runtime lays the doorway from them.
   */
  interactive?: number;
}

/**
 * In-game size steps (percent of the exported size). Every entity in the pack
 * carries one component group per step (`withSizeGroups`), so the wand can
 * spawn a whole placement at ½× or 2× without re-exporting; the block
 * structure follows only when the pack ships its collider grid (`colliders`).
 */
export const SIZE_STEPS: readonly number[] = [25, 50, 75, 100, 150, 200, 300, 400];
/** `craftmatic:size_<pct>` is both the component group and the event that selects it. */
export const SIZE_EVENT_PREFIX = 'craftmatic:size_';

/** Invisible-collider grid shipped for scripted re-tiling at another size. */
export interface PlacementColliders {
  width: number; height: number; length: number;
  /** The collider block id and its two sixteenth states (bedrock-building-shell.ts). */
  block: string; loState: string; hiState: string;
  /** Run-length cells, x-major `(x*height + y)*length + z` — see `encodeColliderRuns`. */
  runs: string;
  /** Cells that are not colliders (doors, lights); they stay blocks only at 100 %. */
  keptCells: number;
  /** Invisible steps per size and turn (bedrock-collider-scale.ts); absent when the feature is off or no size needed one. */
  treads?: PlacementTreads;
}

/**
 * The tread plans a brick-shell pack ships: for every size step above 100 %
 * and every quarter turn, the FINAL collider pair of each world block a tread
 * run changes (`encodeTreadPlan`), set by the runtime after its re-lay. Only
 * keys with at least one block are present; 100 % never has one.
 */
export interface PlacementTreads {
  /** `${sizePct}:${rotation}` → encoded blocks. */
  plans: Record<string, string>;
  /** Blocks per key, for the wand's messages. */
  counts: Record<string, number>;
}

/** What the planner found, per size and turn, for the pack's own diagnostics. */
export interface PlacementTreadReport {
  rule: string;
  plans: Array<Omit<TreadPlan, 'blocks' | 'before' | 'after'> & { blocks: number; before: TreadReachSummary; after: TreadReachSummary }>;
}

/** A walk's result with its highest surface in blocks at 100 %, comparable across sizes. */
export interface TreadReachSummary {
  surfaces: number; columns: number;
  highestBlocks: number;
}

/**
 * The measured size at which a player can actually walk through this model
 * (`recommendAccessScale` in bedrock-scene-actors.ts), carried into the pack so
 * the wand can name it.
 *
 * It is a RECOMMENDATION and nothing else: the wand labels that step, quotes
 * the reason and never changes the size by itself. `reason` is carried WHOLE —
 * where the measurement found a tension (a size that opens the doors but puts
 * the stairs past the player's jump) the sentence says so, and truncating it to
 * a number would throw away the half the user needs.
 */
export interface PlacementAccess {
  /** The size step (100…400) the measurement recommends; absent when no step makes the model walkable. */
  sizePct?: number;
  /** The measurement's own sentence, for the wand menu and the placement confirmation. */
  reason: string;
}

export interface PlacementPackSpec {
  stem: string;
  label: string;
  width: number; height: number; length: number;
  tiles: PlacementTile[];
  actors?: PlacementActor[];
  /** Enable controls supplied by the playable DeLorean runtime. */
  vehicleControls?: boolean;
  /** Sparse non-air model points used to make rotation obvious in preview (drawn only when no ghost entity ships). */
  previewPoints?: Array<{ x: number; y: number; z: number }>;
  /** Translucent ghost entity of the whole placement (bedrock-preview-entity.ts); spawned at the pin, turned with the rotation. */
  preview?: { typeId: string };
  /** The collider grid behind the structure tiles, for placement at another size. Absent: the blocks are fixed at 100 %. */
  colliders?: PlacementColliders;
  /** Existing invisible-seat entity type, enabling an explicit user-marked brick chair. */
  manualSeatTypeId?: string;
  /** Semantic LDraw leaves preserved for a usable vanilla door after resizing. */
  runtimeDoorCandidates?: Array<{ x: number; y: number; z: number; requiredSize: number; lower: { id: string; states: Record<string, string | number | boolean> }; upper: { id: string; states: Record<string, string | number | boolean> } }>;
  /** A measured, export-time interaction warning shown in the Brick Wand. */
  interactionNote?: string;
  /** The measured walk-through size and its reason, named (never applied) by the wand. */
  access?: PlacementAccess;
  /**
   * Invisible steps where a scaled-up rise the model's own figures could climb
   * has grown past the player's jump (bedrock-collider-scale.ts). Default on;
   * `false` ships the bare collider grid. Needs `colliders`.
   */
  treads?: boolean;
  /** Model points that should be reachable on foot (a boarding platform), reported per size in the tread diagnostics. */
  reachTargets?: ReachTarget[];
  /**
   * Ticks each tile's ticking area stays alive after its `structure load`, and
   * ticks the last area is held after the final piece. A ticking area removed
   * the moment the command returns can unload the chunk before its block
   * updates reach the client, which read as "nothing appeared until I came back".
   */
  settleTicks?: number;
  finalHoldTicks?: number;
}

export interface PlacementPackAssets {
  itemId: string;
  shortAlias: string;
  script: string;
  files: Array<{ name: string; data: Uint8Array }>;
  /** The tread planner's findings (also written as `craftmatic-treads.json`); absent for a pack without colliders or with `treads: false`. */
  treads?: PlacementTreadReport;
}

export interface PlacementTile {
  identifier: string;
  dx: number; dy: number; dz: number;
  width: number; height: number; length: number;
  nonAir: number;
}

export interface RotatedTilePlacement extends PlacementTile {
  width: number;
  length: number;
}

/** Short deterministic command name; the full per-model alias also remains available. */
export function placementAlias(stem: string): string {
  if (/76252/.test(stem)) return 'b76252';
  if (/8855/.test(stem)) return 'b8855';
  let hash = 0x811c9dc5;
  for (const ch of `craftmatic.brickwand:${stem}`) hash = Math.imul((hash ^ ch.charCodeAt(0)) >>> 0, 0x01000193) >>> 0;
  return `b_${hash.toString(16).padStart(8, '0').slice(0, 6)}`;
}

export function rotatedSize(width: number, height: number, length: number, rotation: PlacementRotation) {
  return rotation % 180 ? { width: length, height, length: width } : { width, height, length };
}

/** Position a separately rotated tile inside the model's normalized rotated bounds. */
export function rotateTilePlacement(
  tile: PlacementTile, modelWidth: number, modelLength: number, rotation: PlacementRotation,
): RotatedTilePlacement {
  if (rotation === 90) return { ...tile, dx: modelLength - tile.dz - tile.length, dz: tile.dx, width: tile.length, length: tile.width };
  if (rotation === 180) return { ...tile, dx: modelWidth - tile.dx - tile.width, dz: modelLength - tile.dz - tile.length };
  if (rotation === 270) return { ...tile, dx: tile.dz, dz: modelWidth - tile.dx - tile.width, width: tile.length, length: tile.width };
  return { ...tile };
}

/** Rotate an entity/component point with the same normalized transform as the blocks. */
export function rotatePlacementPoint(
  point: { x: number; y: number; z: number }, width: number, length: number, rotation: PlacementRotation,
) {
  if (rotation === 90) return { x: length - point.z, y: point.y, z: point.x };
  if (rotation === 180) return { x: width - point.x, y: point.y, z: length - point.z };
  if (rotation === 270) return { x: point.z, y: point.y, z: width - point.x };
  return { ...point };
}

// ─── Culling bounds ──────────────────────────────────────────────────────────

/** A model's extent in BLOCKS, relative to the entity's own position, at 100 %. */
export interface ModelExtentBlocks {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** The three `visible_bounds_*` fields of a geometry description (blocks). */
export interface VisibleBounds {
  visible_bounds_width: number;
  visible_bounds_height: number;
  visible_bounds_offset: [number, number, number];
}

const ceil2 = (v: number): number => Math.ceil(v * 100) / 100;

/**
 * The culling box a geometry must declare so the model never vanishes at any
 * in-game size step.
 *
 * Bedrock frustum-culls an entity against the box declared in its GEOMETRY
 * description: `visible_bounds_width` (used for BOTH horizontal axes),
 * `visible_bounds_height` and `visible_bounds_offset`, all in blocks, centred
 * on the entity's position plus the offset. The box is baked at build time and
 * `minecraft:scale` is documented as a "visual size multiplier" only - it does
 * not resize the box. `withSizeGroups` offers 25 %…400 %, so a geometry sized
 * for 100 % renders up to FOUR TIMES outside its own culling box and the whole
 * entity pops out of view the moment that small box leaves the frustum, which
 * is what "entire sets disappear when the camera is tilted, especially with
 * scaled up placements" describes.
 *
 * Mojang author their own geometries the same way: `slime.geo.json` is a
 * single 8-unit (half-block) cube and declares `visible_bounds_width: 5`,
 * `visible_bounds_height: 2`, `offset [0, 1, 0]` - a box sized for the LARGEST
 * scale its render controller applies (variant 4), not for the model as
 * authored. `ender_dragon.geo.json` sets `visible_bounds_width: 14` for a body
 * reaching x = −7, i.e. twice the largest distance from the origin, confirming
 * the width is a radius about the entity position rather than a footprint.
 *
 * So the box has to cover the union of `f × extent` over every size step. An
 * over-large box only means the entity is drawn while slightly off screen
 * (cheap); a too-small one makes it vanish, which is the bug.
 *
 * @param extent Model AABB in blocks relative to the entity position, at 100 %.
 * @param padBlocks Slack at 100 % for geometry that can reach past that AABB
 *   (a rotated bone's cuboids are authored unrotated at the pivot), scaled with
 *   the model.
 */
export function visibleBoundsForSizeSteps(extent: ModelExtentBlocks, padBlocks = 0): VisibleBounds {
  const fMin = Math.min(...SIZE_STEPS) / 100, fMax = Math.max(...SIZE_STEPS) / 100;
  // f × [a, b] for every f in [fMin, fMax] stays inside this interval: a
  // negative bound reaches furthest at fMax, a positive one at fMin.
  const span = (a: number, b: number): [number, number] => [Math.min(fMin * a, fMax * a), Math.max(fMin * b, fMax * b)];
  const pad = Math.max(0, padBlocks);
  const [x0, x1] = span(extent.min[0] - pad, extent.max[0] + pad);
  const [y0, y1] = span(extent.min[1] - pad, extent.max[1] + pad);
  const [z0, z1] = span(extent.min[2] - pad, extent.max[2] + pad);
  // One width serves +X, −X, +Z and −Z, so it is twice the furthest horizontal
  // reach from the entity position; the height gets its own offset instead.
  const radius = Math.max(Math.abs(x0), Math.abs(x1), Math.abs(z0), Math.abs(z1));
  // Round the offset FIRST, then size the height around the rounded value: a
  // height rounded independently can end up a few thousandths short of the
  // shifted centre and clip the model it was computed from.
  const offsetY = Math.round((y0 + y1) / 2 * 100) / 100;
  return {
    visible_bounds_width: Math.max(1, ceil2(radius * 2)),
    visible_bounds_height: Math.max(1, ceil2(2 * Math.max(Math.abs(y0 - offsetY), Math.abs(y1 - offsetY)))),
    visible_bounds_offset: [0, offsetY, 0],
  };
}

// ─── Size groups ─────────────────────────────────────────────────────────────

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Bedrock validates `third_person_camera_radius` against [1, 64] and rejects
 * the whole entity definition when one value falls outside it - and ONE bad
 * definition takes the pack's entity with it.
 *
 * Scaling a seat by the size factor overflows that ceiling on its own:
 * `chaseRadius` caps a base radius at 30, so anything above 21.3 breaks at
 * 300 %. Measured on a device (Bedrock 1.26.51.1): The Milano 76286 has a base
 * radius of 30, its `craftmatic:size_300`/`size_400` groups asked for 90.0 and
 * 120.0, and the world load logged the session's only two `[error]` lines.
 * Clamping loses nothing a player can see - past ~64 blocks the chase camera is
 * already further out than the render distance the vehicle is visible at.
 */
const CAMERA_RADIUS_MIN = 1;
const CAMERA_RADIUS_MAX = 64;
const clampCameraRadius = (v: number): number =>
  Math.min(CAMERA_RADIUS_MAX, Math.max(CAMERA_RADIUS_MIN, v));

/** A `minecraft:rideable` component with every seat position (and camera radius) scaled by `f`. */
function scaleRideable(rideable: Record<string, unknown>, f: number): Record<string, unknown> {
  const scaleSeat = (seat: Record<string, unknown>): Record<string, unknown> => ({
    ...seat,
    ...(Array.isArray(seat.position) ? { position: (seat.position as number[]).map(v => round3(v * f)) } : {}),
    ...(typeof seat.third_person_camera_radius === 'number'
      ? { third_person_camera_radius: clampCameraRadius(round3(seat.third_person_camera_radius * f)) }
      : {}),
  });
  const seats = rideable.seats;
  return {
    ...rideable,
    seats: Array.isArray(seats) ? seats.map(s => scaleSeat(s as Record<string, unknown>)) : seats && typeof seats === 'object' ? scaleSeat(seats as Record<string, unknown>) : seats,
  };
}

/**
 * How an entity follows the wand's size steps.
 *
 * `playerSized` marks a FIGURE, or a seat whose rider is one. The rule
 * (2026-09-21, verbatim): "when scaling a model it should never result in the
 * minifigs becoming giants - the minifigs should be capped to always be the
 * same size as a player". A minifig at 100 % IS player height by the one
 * shared scale (lego-scale.ts: 96 LDU = 1.8 blocks, 2.03 with hair on the
 * device), so its scale, collision box and any rider offset follow the step
 * only BELOW 100 % (`figureSizeFactor`); at 150-400 % they keep the 100 %
 * values and a 400 % building is walked by player-sized figures. For the
 * invisible seat the offset is where a player-sized rider's origin sits under
 * the pan (-0.3), not a measurement inside the model, so it is capped the
 * same way.
 */
export interface SizeGroupOptions {
  playerSized?: boolean;
}

/** The size factor a player-sized entity takes at wand factor `f`: never above 1. */
export const figureSizeFactor = (f: number): number => Math.min(1, f);

/**
 * Give an entity definition one component group per size step, each setting
 * `minecraft:scale`, a collision box scaled to match and (for a mount) its
 * seats scaled too - `minecraft:scale` does not move a rider's seat, so a
 * half-size car would otherwise seat the player at full height. The
 * `craftmatic:size_<pct>` event selects one step and drops the others;
 * `craftmatic:size_100` drops them all. Groups and events the definition
 * already has (an aircraft's descend group) are kept.
 *
 * A `playerSized` entity (see `SizeGroupOptions`) still carries every group,
 * so the runtime's one `triggerEvent(size_<pct>)` per actor works unchanged,
 * but the groups above 100 % hold the 100 % values.
 */
export function withSizeGroups(
  behavior: unknown,
  collision: { width: number; height: number },
  rideable?: Record<string, unknown>,
  options: SizeGroupOptions = {},
): unknown {
  const b = behavior as { 'minecraft:entity': Record<string, unknown> };
  const e = b['minecraft:entity'];
  const groups: Record<string, unknown> = { ...((e.component_groups as Record<string, unknown> | undefined) ?? {}) };
  const events: Record<string, unknown> = { ...((e.events as Record<string, unknown> | undefined) ?? {}) };
  const names = SIZE_STEPS.filter(p => p !== 100).map(p => `${SIZE_EVENT_PREFIX}${p}`);
  for (const pct of SIZE_STEPS) {
    if (pct === 100) continue;
    const name = `${SIZE_EVENT_PREFIX}${pct}`;
    const f = options.playerSized ? figureSizeFactor(pct / 100) : pct / 100;
    groups[name] = {
      'minecraft:scale': { value: f },
      'minecraft:collision_box': { width: round3(collision.width * f), height: round3(collision.height * f) },
      ...(rideable ? { 'minecraft:rideable': scaleRideable(rideable, f) } : {}),
    };
    events[name] = { remove: { component_groups: names.filter(n => n !== name) }, add: { component_groups: [name] } };
  }
  events[`${SIZE_EVENT_PREFIX}100`] = { remove: { component_groups: names } };
  return { ...b, 'minecraft:entity': { ...e, component_groups: groups, events } };
}

// ─── Collider runs ───────────────────────────────────────────────────────────

/** The pair codec lives with the scaled grid (bedrock-collider-scale.ts); re-exported so callers keep one import. */
export { colliderPairIndex, colliderPairOf };

/**
 * Run-length code: `[valueChar][countChar]` pairs, count 1..200 as char
 * 40+n−1. The value is 0 for air, else `v·136 + pair` - the collider pair
 * index (1..136, `colliderPairIndex`) of a cell whose clearance form is
 * variant `v` (collider-form.ts; 0 = the full-footprint collider, so a pack
 * without clearance encodes exactly as before) - as char 40+value.
 */
const RUN_BASE = 40, RUN_MAX = 200;
/** Collider pairs per variant in a run value. */
export const RUN_PAIRS = 136;
/** A run value's variant and pair (value > 0). */
export const runValueOf = (value: number): { v: number; lo: number; hi: number } => {
  const v = Math.floor((value - 1) / RUN_PAIRS);
  const [lo, hi] = colliderPairOf(value - v * RUN_PAIRS);
  return { v, lo, hi };
};

/**
 * Encode a grid of collider states (`craftmatic:collider[lo=…,hi=…]`, or a
 * clearance form `craftmatic:collider_<kind><shape>[lo=…,hi=…]`) as runs over
 * `(x*height + y)*length + z`. Anything that is not a collider - air, or a
 * scene block such as a door - is 0. Pure and small enough to ship inside the
 * pack's script config (a 60×40×60 castle is a few KB after the air runs).
 */
export function encodeColliderRuns(
  grid: { width: number; height: number; length: number; get(x: number, y: number, z: number): string },
  block: string,
): { runs: string; colliders: number; keptCells: number } {
  const re = new RegExp(`^(${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:_[a-z]\\d+)?)\\[lo=(\\d+),hi=(\\d+)\\]$`);
  let out = '', prev = -1, count = 0, colliders = 0, keptCells = 0;
  const flush = (): void => {
    while (count > 0) {
      const n = Math.min(RUN_MAX, count);
      out += String.fromCharCode(RUN_BASE + prev) + String.fromCharCode(RUN_BASE + n - 1);
      count -= n;
    }
  };
  for (let x = 0; x < grid.width; x++) for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) {
    const state = grid.get(x, y, z);
    let v = 0;
    const m = re.exec(state);
    if (m) {
      const variant = Math.max(0, COLLIDER_KIT.variantOf(m[1]!));
      v = variant * RUN_PAIRS + colliderPairIndex(Number(m[2]), Number(m[3])); colliders++;
    }
    else if (state !== 'minecraft:air') keptCells++;
    if (v === prev) { count++; continue; }
    flush();
    prev = v; count = 1;
  }
  flush();
  return { runs: out, colliders, keptCells };
}

/** Decode runs back to a flat array of run values (0 = air; a full cell's value is its pair index). Exported for tests. */
export function decodeColliderRuns(runs: string): Uint16Array {
  const cells: number[] = [];
  for (let k = 0; k + 1 < runs.length; k += 2) {
    const v = runs.charCodeAt(k) - RUN_BASE, n = runs.charCodeAt(k + 1) - RUN_BASE + 1;
    for (let j = 0; j < n; j++) cells.push(v);
  }
  return Uint16Array.from(cells);
}

/** The solid cells of a shipped collider grid, decoded from its runs. */
export function colliderSourceCells(c: Pick<PlacementColliders, 'width' | 'height' | 'length' | 'runs'>): SourceCell[] {
  const cells = decodeColliderRuns(c.runs);
  const out: SourceCell[] = [];
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]!;
    if (v === 0) continue;
    const cell = runValueOf(v);
    out.push({ z: i % c.length, y: Math.floor(i / c.length) % c.height, x: Math.floor(i / (c.length * c.height)), lo: cell.lo, hi: cell.hi, ...(cell.v ? { v: cell.v } : {}) });
  }
  return out;
}

/**
 * Tread plan code: 7 chars per block - x, y, z as two base-200 digits each
 * (char 40 + digit, high digit first) and the collider pair index as one
 * char (40 + index). Coordinates are world blocks from the pin at that size
 * and turn (up to 39,999, far past a 400 % footprint).
 */
const TREAD_DIGIT_BASE = 200;
export function encodeTreadPlan(blocks: readonly TreadBlock[]): string {
  const digits = (v: number): string => {
    if (v < 0 || v >= TREAD_DIGIT_BASE * TREAD_DIGIT_BASE) throw new Error(`tread coordinate out of range: ${v}`);
    return String.fromCharCode(RUN_BASE + Math.floor(v / TREAD_DIGIT_BASE)) + String.fromCharCode(RUN_BASE + v % TREAD_DIGIT_BASE);
  };
  return blocks.map(b => `${digits(b.x)}${digits(b.y)}${digits(b.z)}${String.fromCharCode(RUN_BASE + colliderPairIndex(b.lo, b.hi))}`).join('');
}

/** Inverse of `encodeTreadPlan`. */
export function decodeTreadPlan(plan: string): TreadBlock[] {
  const out: TreadBlock[] = [];
  for (let k = 0; k + 6 < plan.length; k += 7) {
    const v = (o: number): number => (plan.charCodeAt(k + o) - RUN_BASE) * TREAD_DIGIT_BASE + plan.charCodeAt(k + o + 1) - RUN_BASE;
    const [lo, hi] = colliderPairOf(plan.charCodeAt(k + 6) - RUN_BASE);
    out.push({ x: v(0), y: v(2), z: v(4), lo, hi });
  }
  return out;
}

/** The planner's rule in one sentence, carried in the pack's diagnostics beside the counts. */
export const TREAD_RULE = 'An invisible step is laid only where a rise between two standable surfaces exceeds the player\'s 1.25-block jump at the chosen size while being within that jump in the 100 % grid (a rise the model\'s own figures climb), laid back over floor the player already reaches, in half-block hops where the floor allows and the fewest jump-height hops otherwise, keeping full standing headroom; a run that would make any previously reachable surface unreachable is reverted, so reachability only grows.';

/**
 * Plan treads for every size step above 100 % and every quarter turn, and
 * attach the encoded plans to the shipped colliders. 100 % is never planned:
 * the tiles carry the grid verbatim and the planner is empty there by
 * construction (asserted in test/bedrock-collider-treads.test.ts).
 */
export function withColliderTreads(colliders: PlacementColliders, targets: readonly ReachTarget[] = []): { colliders: PlacementColliders; report: PlacementTreadReport } {
  // Planned over the grid as it was BEFORE clearance: every clearance form
  // (collider-form.ts) read as the full cell over its vertical extent. A tread
  // only ever fills a column the planner found standable and clear, and its
  // never-block check then holds in a world at least as blocked as the one the
  // pack lays - a form only adds room. Planning on the forms themselves opens
  // columns at 300-400 % that the planner's fast path then fails to verify, and
  // its slow path took 10261 from 70 s to 190 s to export (2026-09-25).
  const cells = colliderSourceCells(colliders).map(c => {
    if (!c.v) return c;
    const boxes = COLLIDER_KIT.formBoxes(c.v, c.lo, c.hi);
    return { x: c.x, y: c.y, z: c.z, lo: Math.min(...boxes.map(b => b[2])), hi: Math.max(...boxes.map(b => b[3])) };
  });
  const dims = { width: colliders.width, height: colliders.height, length: colliders.length };
  const plans: Record<string, string> = {}, counts: Record<string, number> = {};
  const report: PlacementTreadReport = { rule: TREAD_RULE, plans: [] };
  const blocksAt100 = (t16: number, f: number): number => Math.round(t16 / 16 / f * 100) / 100;
  for (const pct of SIZE_STEPS) {
    if (pct <= 100) continue;
    for (const r of QUARTER_TURNS) {
      const plan = planColliderTreads(cells, dims, pct, r, targets);
      const f = pct / 100;
      const { blocks, before, after, ...rest } = plan;
      report.plans.push({ ...rest, blocks: blocks.length, before: { surfaces: before.surfaces, columns: before.columns, highestBlocks: blocksAt100(before.highest16, f) }, after: { surfaces: after.surfaces, columns: after.columns, highestBlocks: blocksAt100(after.highest16, f) } });
      if (!blocks.length) continue;
      const key = `${pct}:${r}`;
      plans[key] = encodeTreadPlan(blocks);
      counts[key] = blocks.length;
    }
  }
  return { colliders: Object.keys(plans).length ? { ...colliders, treads: { plans, counts } } : colliders, report };
}

/** Blocks a tread plan changes, for a size and turn, from the shipped colliders. */
export function treadBlocksFor(colliders: PlacementColliders, sizePct: number, rotation: QuarterTurn): TreadBlock[] {
  const plan = colliders.treads?.plans[`${sizePct}:${rotation}`];
  return plan ? decodeTreadPlan(plan) : [];
}

const enc = new TextEncoder();
const text = (value: string) => enc.encode(value.endsWith('\n') ? value : `${value}\n`);

// Serialized into each generated pack. Keep this function plain JavaScript so
// its toString() output is a valid Bedrock script module after TS transpilation.
function placementRuntime(config: any, openVehicleControls: ((player: any) => Promise<void>) | undefined, kit: ColliderFormKit) {
  // Bedrock's form renderer drops a bare `%` ("100%" rendered "100" on the Pixel, 2026-09-21); the word, as playable-addon.ts's bedrockInGameText.
  const percent = (n: any) => `${n} percent`;
  const states = new Map(), previews = new Set(), histories = new Map(), held = new Set(), showing = new Set();
  // Dynamic properties survive a behavior-pack script reload. Keep this small:
  // marked chairs are explicit user intent, never inferred furniture candidates.
  const seatStoreKey = `craftmatic:${config.id}:manual_seats`, manualSeatCap = 12;
  let active: any;
  const rotations = [0, 90, 180, 270];
  const sizes: number[] = config.sizes && config.sizes.length ? config.sizes : [100];
  const nextDoorSize = (size: number): number | undefined => {
    const pending = (config.runtimeDoorCandidates || []).map((d: any) => d.requiredSize).filter((required: number) => required > size);
    return pending.length ? Math.min(...pending) : undefined;
  };
  const sizeEvent = (pct: number) => `${config.sizeEventPrefix || 'craftmatic:size_'}${pct}`;
  // The measured walk-through size (bedrock-scene-actors.ts). A RECOMMENDATION:
  // the wand names the step and quotes the whole reason; it never resizes by itself.
  const access = config.access || null;
  const recommendedSize: number = access && access.sizePct ? access.sizePct : 0;
  const sizeLabel = (pct: number) => `${percent(pct)}${pct === recommendedSize ? ' (recommended)' : ''}`;
  /** The measurement as one line for a menu body, with the reason carried whole. */
  const walkThroughLine = (): string => !access || !access.reason ? ''
    : `\n\n§aWalk-through: ${recommendedSize ? `${percent(recommendedSize)}` : 'no size fits'}§r — ${access.reason}`;
  // A pack with no block structure (a vehicle, a figure) may turn in 15° steps; blocks turn by 90°.
  const fineTurn = config.tiles.length === 0;
  const turnStep = fineTurn ? 15 : 90;
  const tell = (p: any, s: string) => { try { p.sendMessage(`§b[Brick Wand]§r ${s}`); } catch {} };
  const wait = (ticks: number) => new Promise(resolve => system.runTimeout(resolve, ticks));
  const show = async (p: any, form: any) => {
    if (showing.has(p.id)) return { canceled: true };
    showing.add(p.id);
    try { return await form.show(p); }
    catch (e: any) { tell(p, `Menu unavailable: ${e.message || e}`); return { canceled: true }; }
    finally { showing.delete(p.id); }
  };
  const areaPrefix = `cm_${config.shortAlias}_${Date.now().toString(36).slice(-4)}`;
  let areaCounter = 0, loadedAreaId: any, loadedDimension: any;
  const unload = async () => {
    const id = loadedAreaId, dimension = loadedDimension;
    loadedAreaId = undefined; loadedDimension = undefined;
    if (!id || !dimension) return;
    try { dimension.runCommand(`tickingarea remove ${id}`); } catch {}
    await wait(2);
  };
  const load = async (dimension: any, from: any, to: any) => {
    await unload();
    const fx = Math.floor(Math.min(from.x, to.x)), fz = Math.floor(Math.min(from.z, to.z));
    const tx = Math.floor(Math.max(from.x, to.x)), tz = Math.floor(Math.max(from.z, to.z));
    const range = dimension.heightRange, y = Math.max(range.min, Math.min(range.max - 1, Math.floor(from.y ?? 0)));
    const areaId = `${areaPrefix}_${++areaCounter}`;
    try {
      const result = dimension.runCommand(`tickingarea add ${fx} ${y} ${fz} ${tx} ${y} ${tz} ${areaId} true`);
      if (result?.successCount === 0) throw new Error('tickingarea command reported successCount 0');
      loadedAreaId = areaId; loadedDimension = dimension;
    }
    catch (e: any) { throw new Error(`Could not preload the build area: ${e.message || e}`); }
    await wait(2);
    const probes = [];
    for (let cx = Math.floor(fx / 16); cx <= Math.floor(tx / 16); cx++) for (let cz = Math.floor(fz / 16); cz <= Math.floor(tz / 16); cz++) {
      probes.push({ x: Math.max(fx, Math.min(tx, cx * 16 + 8)), y, z: Math.max(fz, Math.min(tz, cz * 16 + 8)) });
    }
    let lastFailure = 'no probe result';
    for (let elapsed = 0; elapsed <= 600; elapsed += 2) {
      if (active?.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
      let ready = true;
      for (const q of probes) try {
        if (!dimension.getBlock(q)) { ready = false; lastFailure = `${q.x},${q.y},${q.z} returned undefined`; break; }
      } catch (e: any) {
        ready = false; lastFailure = `${q.x},${q.y},${q.z} threw ${e?.name || 'Error'}: ${e?.message || e}`; break;
      }
      if (ready) return;
      if (elapsed === 600) {
        console.warn(`BRICK_WAND_LOAD_TIMEOUT ${areaId} ${lastFailure}`);
        throw new Error(`Timed out waiting for the build area to load; probe ${lastFailure}. Use Undo to restore any changed area.`);
      }
      await wait(2);
    }
  };
  const readManualSeats = (p: any) => {
    try {
      const saved = JSON.parse(String(p.getDynamicProperty?.(seatStoreKey) || '{}'));
      const anchors = Array.isArray(saved.anchors) ? saved.anchors.filter((v: any) => [v.x, v.y, v.z, v.yaw].every(Number.isFinite)).slice(0, manualSeatCap) : [];
      const entityIds = Array.isArray(saved.entityIds) ? saved.entityIds.filter((v: any) => typeof v === 'string').slice(0, manualSeatCap) : [];
      return { anchors, entityIds };
    } catch { return { anchors: [], entityIds: [] }; }
  };
  const saveManualSeats = (p: any, st: any) => {
    try { p.setDynamicProperty?.(seatStoreKey, JSON.stringify({ anchors: (st.manualSeats || []).slice(0, manualSeatCap), entityIds: (st.manualSeatIds || []).slice(0, manualSeatCap) })); }
    catch (e: any) { tell(p, `§eMarked seats cannot persist for this player (${e?.message || e}). They still last until this script reloads.`); }
  };
  // ── The Undo record survives a reload and a restart ──
  // `histories` is this script's memory and a world reload empties it, which
  // left agents cleaning a placement up by hand (2026-09-25). So the record
  // (the dimension, the block snapshots, the spawned entity ids, the box it
  // covered and the tag every spawned entity carries) is also written to the
  // PLAYER's dynamic properties, which the world saves with the player, and
  // the snapshots are saved into the WORLD (StructureSaveMode.World), not
  // memory. A string property holds at most 32,767 characters, so the JSON is
  // split over numbered keys: `<key>` = "<count>:<chunk 0>", `<key>:<i>` = chunk i.
  const undoKey = `craftmatic:${config.id}:undo`, UNDO_CHUNK = 30000, UNDO_MAX_CHUNKS = 64;
  const undoChunks = (p: any): number => {
    try { const head = String(p.getDynamicProperty?.(undoKey) ?? ''); const n = Number(head.slice(0, head.indexOf(':'))); return Number.isInteger(n) && n > 0 ? Math.min(n, UNDO_MAX_CHUNKS) : 0; } catch { return 0; }
  };
  const clearHistory = (p: any) => {
    const n = undoChunks(p);
    try { p.setDynamicProperty?.(undoKey, undefined); } catch {}
    for (let i = 1; i < n; i++) try { p.setDynamicProperty?.(`${undoKey}:${i}`, undefined); } catch {}
  };
  const saveHistory = (p: any, h: any) => {
    const text = JSON.stringify({ v: 1, dimension: h.dimension, backups: h.backups, entities: h.entities, bounds: h.bounds, tag: h.tag });
    const n = Math.max(1, Math.ceil(text.length / UNDO_CHUNK));
    if (n > UNDO_MAX_CHUNKS) { tell(p, `§eThis placement's Undo record is too large to keep across a reload (${text.length} characters); Undo works until the world closes.`); clearHistory(p); return; }
    try {
      clearHistory(p);
      p.setDynamicProperty?.(undoKey, `${n}:${text.slice(0, UNDO_CHUNK)}`);
      for (let i = 1; i < n; i++) p.setDynamicProperty?.(`${undoKey}:${i}`, text.slice(i * UNDO_CHUNK, (i + 1) * UNDO_CHUNK));
    } catch (e: any) { tell(p, `§eUndo cannot persist for this player (${e?.message || e}); it works until the world closes.`); }
  };
  const loadHistory = (p: any) => {
    const n = undoChunks(p);
    if (!n) return undefined;
    try {
      const head = String(p.getDynamicProperty?.(undoKey));
      let text = head.slice(head.indexOf(':') + 1);
      for (let i = 1; i < n; i++) text += String(p.getDynamicProperty?.(`${undoKey}:${i}`) ?? '');
      const h = JSON.parse(text);
      if (!h || h.v !== 1 || typeof h.dimension !== 'string' || !Array.isArray(h.backups) || !Array.isArray(h.entities)) return undefined;
      return { dimension: h.dimension, backups: h.backups, entities: h.entities, bounds: h.bounds, tag: h.tag };
    } catch { return undefined; }
  };
  /** This player's last placement: the script's memory, else the record a previous session saved. */
  const historyOf = (p: any) => {
    if (!histories.has(p.id)) { const saved = loadHistory(p); if (saved) histories.set(p.id, saved); }
    return histories.get(p.id);
  };
  const setHistory = (p: any, h: any) => { histories.set(p.id, h); saveHistory(p, h); };
  const dropHistory = (p: any) => { histories.delete(p.id); clearHistory(p); };
  const removeManualSeatEntities = (st: any) => {
    for (const id of st.manualSeatIds || []) try { world.getEntity(id)?.remove(); } catch {}
    st.manualSeatIds = [];
  };
  const state = (p: any) => {
    if (!states.has(p.id)) {
      const saved = readManualSeats(p);
      states.set(p.id, { anchor: undefined, dimension: undefined, rotation: 0, size: 100, aim: false, manualSeats: saved.anchors, manualSeatIds: saved.entityIds });
    }
    return states.get(p.id);
  };
  const factor = (s: any) => (s.size || 100) / 100;
  // Footprint of the model turned by r: exact swaps at multiples of 90°, the
  // bounding box of the turned rectangle in between (entity-only packs).
  const size = (r: number) => {
    const rr = ((r % 360) + 360) % 360;
    if (rr % 90 === 0) return rr % 180
      ? { width: config.length, height: config.height, length: config.width }
      : { width: config.width, height: config.height, length: config.length };
    const a = rr * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    return { width: Math.ceil(config.width * c + config.length * s), height: config.height, length: Math.ceil(config.width * s + config.length * c) };
  };
  // The footprint at the chosen size, in whole blocks.
  const dims = (st: any) => {
    const d = size(st.rotation), f = factor(st);
    return { width: Math.max(1, Math.ceil(d.width * f)), height: Math.max(1, Math.ceil(d.height * f)), length: Math.max(1, Math.ceil(d.length * f)) };
  };
  const tileAt = (t: any, r: number) => {
    if (r === 90) return { ...t, dx: config.length - t.dz - t.length, dz: t.dx, width: t.length, length: t.width };
    if (r === 180) return { ...t, dx: config.width - t.dx - t.width, dz: config.length - t.dz - t.length };
    if (r === 270) return { ...t, dx: t.dz, dz: config.width - t.dx - t.width, width: t.length, length: t.width };
    return { ...t };
  };
  // A model point (blocks from the model's corner) inside the turned footprint.
  const pointAt = (v: any, r: number) => {
    const rr = ((r % 360) + 360) % 360;
    if (rr === 90) return { x: config.length - v.z, y: v.y, z: v.x };
    if (rr === 180) return { x: config.width - v.x, y: v.y, z: config.length - v.z };
    if (rr === 270) return { x: v.z, y: v.y, z: config.width - v.x };
    if (rr === 0) return { x: v.x, y: v.y, z: v.z };
    // Fine turn about the footprint centre, in the world's sense (yaw +90 = the 90° case above).
    const d = size(rr), a = rr * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const px = v.x - config.width / 2, pz = v.z - config.length / 2;
    return { x: d.width / 2 + px * c - pz * s, y: v.y, z: d.length / 2 + px * s + pz * c };
  };
  // World position of a model point for a pinned state (turned, then sized about the pin).
  const worldPoint = (st: any, v: any) => {
    const q = pointAt(v, st.rotation), f = factor(st);
    return { x: st.anchor.x + q.x * f, y: st.anchor.y + q.y * f, z: st.anchor.z + q.z * f };
  };
  // Inverse of the exact quarter-turn mappings above. Building packs turn in
  // quarter turns, so a marked chair stays on the same LEGO chair through a
  // rotate/resize/re-place instead of becoming a world-fixed marker.
  const modelPoint = (st: any, world: any) => {
    const f = factor(st), q = { x: (world.x - st.anchor.x) / f, y: (world.y - st.anchor.y) / f, z: (world.z - st.anchor.z) / f };
    const r = ((st.rotation % 360) + 360) % 360;
    if (r === 90) return { x: q.z, y: q.y, z: config.length - q.x };
    if (r === 180) return { x: config.width - q.x, y: q.y, z: config.length - q.z };
    if (r === 270) return { x: config.width - q.z, y: q.y, z: q.x };
    return q;
  };
  // The turned, sized footprint centre relative to the pin.
  const centreOffset = (st: any) => {
    const q = pointAt({ x: config.width / 2, y: 0, z: config.length / 2 }, st.rotation), f = factor(st);
    return { x: q.x * f, z: q.z * f };
  };
  const pinCentredAt = (p: any, st: any, target: any) => {
    const c = centreOffset(st);
    st.anchor = { x: Math.floor(target.x - c.x), y: Math.floor(target.y), z: Math.floor(target.z - c.z) };
    st.dimension = p.dimension.id; previews.add(p.id);
  };
  const blocksResizable = !config.tiles.length || !!config.colliders;
  const summary = (st: any) => {
    const d = dims(st);
    const sizeNote = st.size !== 100 ? ` · ${percent(st.size)}${config.tiles.length && !config.colliders ? ' (blocks stay 100 percent)' : ''}` : '';
    return `${d.width} × ${d.height} × ${d.length} blocks · ${st.rotation}°${sizeNote}${st.aim ? ' · following your aim' : ''}\nOrigin: ${st.anchor ? `${st.anchor.x}, ${st.anchor.y}, ${st.anchor.z} in ${st.dimension}` : 'not pinned'}`;
  };
  const validate = (p: any, st: any) => {
    if (!st.anchor) throw new Error('Pin an origin, follow your aim or enter coordinates first.');
    if (st.dimension !== p.dimension.id) throw new Error(`Origin is pinned in ${st.dimension}. Re-pin after changing dimensions.`);
    if (st.size !== 100 && !blocksResizable) throw new Error('This pack\'s blocks were exported as coloured blocks and cannot be resized in game. Set the size back to 100 percent, or export again at another model scale.');
    const d = dims(st), range = p.dimension.heightRange;
    if (st.anchor.y < range.min || st.anchor.y + d.height - 1 >= range.max) throw new Error(`Build exceeds world height ${range.min}–${range.max - 1}.`);
    return d;
  };
  const outline = (d: any) => {
    const points: any[] = [], seen = new Set(), along = (axis: string, fixed: any, end: number) => {
      const count = Math.max(2, Math.min(12, Math.ceil(end / 8) + 1));
      for (let i = 0; i < count; i++) {
        const point = { ...fixed, [axis]: end * i / (count - 1) }, key = `${point.x || 0}:${point.y || 0}:${point.z || 0}`;
        if (!seen.has(key)) { seen.add(key); points.push(point); }
      }
    };
    for (const y of [0, d.height]) for (const z of [0, d.length]) along('x', { y, z }, d.width);
    for (const x of [0, d.width]) for (const z of [0, d.length]) along('y', { x, z }, d.height);
    for (const x of [0, d.width]) for (const y of [0, d.height]) along('z', { x, y }, d.length);
    return points;
  };
  // Ghost preview entity, one per player, pinned at the turned, sized footprint
  // centre with yaw = the wand rotation and the size group applied (see
  // bedrock-preview-entity.ts).
  const ghosts = new Map<string, { id: string; size: number }>();
  const removeGhost = (playerId: string) => {
    const g = ghosts.get(playerId); ghosts.delete(playerId);
    if (!g) return;
    try { world.getEntity(g.id)?.remove(); } catch {}
  };
  const syncGhost = (p: any, st: any, visible: boolean) => {
    if (!config.preview) return;
    if (!visible) { removeGhost(p.id); return; }
    const c = centreOffset(st);
    const at = { x: st.anchor.x + c.x, y: st.anchor.y, z: st.anchor.z + c.z };
    let ghost: any, entry = ghosts.get(p.id);
    if (entry) { try { ghost = world.getEntity(entry.id); } catch {} }
    if (ghost && ghost.dimension?.id !== p.dimension.id) { removeGhost(p.id); ghost = undefined; entry = undefined; }
    if (!ghost) {
      try { ghost = p.dimension.spawnEntity(config.preview.typeId, at); entry = { id: ghost.id, size: 100 }; ghosts.set(p.id, entry); } catch { return; }
    }
    if (entry && entry.size !== st.size) {
      entry.size = st.size;
      try { ghost.triggerEvent(sizeEvent(st.size)); } catch {}
    }
    try { ghost.teleport(at, { rotation: { x: 0, y: st.rotation } }); }
    catch { try { ghost.setRotation({ x: 0, y: st.rotation }); } catch {} }
  };
  // A ghost outliving its script (crash, reload) is swept when the pack starts.
  if (config.preview) system.run(() => {
    for (const id of ['overworld', 'nether', 'the_end']) {
      let d: any; try { d = world.getDimension(id); } catch { continue; }
      try { for (const e of d.getEntities({ type: config.preview.typeId })) e.remove(); } catch {}
    }
  });
  try { world.afterEvents.playerLeave.subscribe((ev: any) => { removeGhost(ev.playerId); states.delete(ev.playerId); previews.delete(ev.playerId); }); } catch {}
  const draw = (p: any) => {
    const st = state(p);
    syncGhost(p, st, previews.has(p.id) && !!st.anchor && !active && st.dimension === p.dimension.id);
    if (!previews.has(p.id) || !st.anchor || active) return;
    if (st.dimension !== p.dimension.id) { p.onScreenDisplay.setActionBar(`PREVIEW PAUSED · origin is in ${st.dimension} · re-pin here`); return; }
    const d = dims(st), particles: any[] = [];
    const worldCorner = (q: any) => ({ x: st.anchor.x + q.x, y: st.anchor.y + q.y, z: st.anchor.z + q.z });
    const mark = (effect: string, q: any) => particles.push({ effect, point: worldCorner(q) });
    const mode = st.aim ? 'AIMING' : 'PINNED PREVIEW';
    p.onScreenDisplay.setActionBar(`${mode} · ${config.label} · ${d.width}×${d.height}×${d.length} · ${st.rotation}°${st.size !== 100 ? ` · ${percent(st.size)}` : ''} · §cX §aY §9Z §6MODEL -Z${st.aim ? ' · open the wand to pin' : ''}`);
    for (const q of outline(d)) mark('minecraft:endrod', q);
    const axisLength = 6;
    for (let i = 0; i <= axisLength; i++) {
      mark('minecraft:redstone_ore_dust_particle', { x: i, y: 0, z: 0 });
      mark('minecraft:villager_happy', { x: 0, y: i, z: 0 });
      mark('minecraft:water_splash_particle_manual', { x: 0, y: 0, z: i });
    }
    const front = [
      { x: config.width / 2, y: 1, z: 0 },
      { x: config.width / 2, y: 1, z: -1 },
      { x: config.width / 2, y: 1, z: -2 },
      { x: config.width / 2 - 1, y: 1, z: -1 },
      { x: config.width / 2 + 1, y: 1, z: -1 },
    ];
    const f = factor(st);
    for (const q of front) { const r = pointAt(q, st.rotation); mark('minecraft:totem_particle', { x: r.x * f, y: r.y * f, z: r.z * f }); }
    if (!config.preview) for (const sample of config.previewPoints) { const r = pointAt(sample, st.rotation); mark('minecraft:villager_happy', { x: r.x * f, y: r.y * f, z: r.z * f }); }
    for (const marker of particles.slice(0, 320)) try { p.dimension.spawnParticle(marker.effect, marker.point); } catch {}
  };
  // Aim mode: the preview follows the block the player looks at (its centre
  // lands on the face they hit), until they pin it or turn aim off.
  const aimTarget = (p: any) => {
    let hit: any;
    try { hit = p.getBlockFromViewDirection?.({ maxDistance: 96, includeLiquidBlocks: false, includePassableBlocks: false }); } catch { return undefined; }
    const b = hit?.block?.location;
    if (!b) return undefined;
    const face = String(hit.face || 'Up');
    const dx = face === 'East' ? 1 : face === 'West' ? -1 : 0, dy = face === 'Up' ? 1 : face === 'Down' ? -1 : 0, dz = face === 'South' ? 1 : face === 'North' ? -1 : 0;
    return { x: b.x + dx + 0.5, y: b.y + dy, z: b.z + dz + 0.5 };
  };
  const aimTick = () => {
    if (active) return;
    for (const p of world.getAllPlayers().filter(Boolean)) {
      const st = states.get(p.id);
      if (!st || !st.aim) continue;
      const target = aimTarget(p);
      if (!target) { try { p.onScreenDisplay.setActionBar(`AIMING · ${config.label} · look at a block within 96 blocks (not the sky)`); } catch {} continue; }
      pinCentredAt(p, st, target);
      draw(p);
    }
  };
  // `.filter(Boolean)` everywhere: a pack that does not declare
  // @minecraft/server-gametest sees each GameTest simulated player as
  // `undefined` in the player lists (placement.js threw 845 times, 2026-09-24).
  system.runInterval(() => { for (const p of world.getAllPlayers().filter(Boolean)) draw(p); }, 12);
  system.runInterval(aimTick, 4);
  system.runInterval(() => {
    const online = new Set();
    for (const p of world.getAllPlayers().filter(Boolean)) {
      online.add(p.id);
      let item: any;
      try { item = p.getComponent('minecraft:inventory')?.container?.getItem(p.selectedSlotIndex); } catch {}
      // A seated pinball player taps hotbar slots as flippers (bedrock-pinball.ts): not a wand.
      if (item?.typeId === config.itemId && !p.hasTag?.('craftmatic_pinball')) {
        if (!held.has(p.id)) { held.add(p.id); system.run(() => menu(p).catch((e: any) => tell(p, e.message || String(e)))); }
      } else held.delete(p.id);
    }
    for (const id of held) if (!online.has(id)) held.delete(id);
  }, 5);
  async function edit(p: any): Promise<any> {
    const st = state(p), a = st.anchor || { x: Math.floor(p.location.x), y: Math.floor(p.location.y), z: Math.floor(p.location.z) };
    const r = await show(p, new ModalFormData().title(`${config.label} · Coordinates`).textField('X', '0', { defaultValue: String(a.x) }).textField('Y', '64', { defaultValue: String(a.y) }).textField('Z', '0', { defaultValue: String(a.z) }));
    if (r.canceled) return menu(p);
    const values = r.formValues.map((v: any) => Number(v));
    if (!values.every((v: number) => Number.isSafeInteger(v) && Math.abs(v) < 30000000)) { tell(p, 'Use whole-number world coordinates.'); return edit(p); }
    st.anchor = { x: values[0], y: values[1], z: values[2] }; st.dimension = p.dimension.id; st.aim = false; previews.add(p.id); return menu(p);
  }
  async function confirmPlace(p: any): Promise<any> {
    const st = state(p); try { validate(p, st); } catch (e: any) { tell(p, e.message); return menu(p); }
    const scripted = st.size !== 100 && config.tiles.length && config.colliders;
    // The measured walk-through size is stated here too, whenever the chosen
    // size is not it — the last moment at which changing it costs nothing.
    const walkNote = recommendedSize && st.size !== recommendedSize ? `\n\nWalk-through size is ${percent(recommendedSize)}, not ${percent(st.size)}: ${access.reason}` : '';
    const r = await show(p, new ActionFormData().title(`Place ${config.label}?`).body(`${summary(st)}\n\nBlocks in this area will be replaced.${scripted ? `\nAt ${percent(st.size)} the invisible walkable blocks are re-laid to size; the ${config.colliders.keptCells} visible block${config.colliders.keptCells === 1 ? '' : 's'} (doors, lights) of the 100 percent export are left out.${stepsNote(st)}` : ''}${walkNote}`).button('Place now').button('Back'));
    if (!r.canceled && r.selection === 0) return place(p);
    return menu(p);
  }
  async function lighting(p: any): Promise<any> {
    const r = await show(p, new ActionFormData().title(`${config.label} · Lighting`).body('Night vision changes only your view. It does not place lights or change the build.').button('Enable night vision · 10 min').button('Disable night vision').button('Back'));
    if (r.canceled || r.selection === 2) return menu(p);
    try {
      if (r.selection === 0) { p.addEffect('minecraft:night_vision', 12000, { showParticles: false }); return tell(p, 'Night vision enabled for 10 minutes.'); }
      if (r.selection === 1) { p.removeEffect('minecraft:night_vision'); return tell(p, 'Night vision disabled.'); }
    } catch (e: any) { return tell(p, `Could not change night vision: ${e.message || e}`); }
  }
  // Colliders re-laid at another size: each exported cell covers a `factor`-wide
  // block range; its sixteenth heights are re-cut per world block row, and a
  // block two cells share (size < 100 %) keeps the lowest lo and highest hi.
  const pairOf = (index: number) => {
    let n = 1;
    for (let l = 0; l < 16; l++) { const span = 16 - l; if (index < n + span) return [l, l + 1 + (index - n)]; n += span; }
    return [0, 16];
  };
  /**
   * The world columns one grid cell owns along an axis at scale `f`.
   *
   * At `f` >= 1 a column belongs to the cell when its CENTRE falls inside the
   * cell's scaled span, so a wall lands on the nearest block instead of being
   * dilated outward by up to a whole block. "Any overlap" used to claim both
   * neighbours of every fractional boundary: at 150 % the wall beside a doorway
   * claimed the doorway's own first column and the player walked into a wall
   * with nothing drawn on it. The ranges still tile the footprint exactly (cell
   * i ends where cell i+1 begins), so no wall can develop a hole.
   *
   * Below 100 % a cell is NARROWER than a block and several cells share one, so
   * every column a cell touches must stay solid - a centre test would drop
   * cells and leave holes to fall through.
   */
  const cellColumns = (i: number, f: number) => {
    const a = i * f, b = (i + 1) * f;
    if (f < 1) return [Math.floor(a), Math.max(Math.floor(a), Math.ceil(b) - 1)];
    return [Math.ceil(a - 0.5), Math.max(Math.ceil(a - 0.5), Math.ceil(b - 0.5) - 1)];
  };
  /**
   * Remove this pack's colliders from a world box, in `fill`-sized pieces.
   *
   * `fillBlocks` takes a BlockVolume INSTANCE (a plain `{from, to}` object is
   * rejected by the native binding) and is capped at 32768 blocks per call like
   * `/fill`, so the box is walked in 32-cubes. The `blockFilter` is what keeps
   * this safe: only `craftmatic:collider` is removed, never the player's own
   * world inside the footprint.
   */
  const clearColliders = (dim: any, from: any, to: any) => {
    // Every collider form (collider-form.ts), never anything else.
    const step = 32, types = kit.VARIANTS.map((d: any) => d.id);
    let failures = 0;
    for (let x = from.x; x <= to.x; x += step) for (let y = from.y; y <= to.y; y += step) for (let z = from.z; z <= to.z; z += step) {
      const a = { x, y, z }, bb = { x: Math.min(to.x, x + step - 1), y: Math.min(to.y, y + step - 1), z: Math.min(to.z, z + step - 1) };
      try { dim.fillBlocks(new BlockVolume(a, bb), 'minecraft:air', { blockFilter: { includeTypes: types } }); }
      catch (e: any) { failures++; if (failures === 1) console.warn(`BRICK_WAND_CLEAR_FAILED ${a.x},${a.y},${a.z} ${e && e.message ? e.message : e}`); }
    }
    return failures;
  };
  /**
   * A footprint split into boxes small enough for ONE ticking area (48 × 48
   * horizontally is 9 chunks; a bigger `tickingarea add` is refused and `load`
   * then fails the whole placement).
   */
  const placementBoxes = (width: number, height: number, length: number) => {
    const box = 48, out: any[] = [];
    for (let bx = 0; bx < width; bx += box) for (let by = 0; by < height; by += 320) for (let bz = 0; bz < length; bz += box) {
      out.push({ x0: bx, y0: by, z0: bz, x1: Math.min(width, bx + box) - 1, y1: Math.min(height, by + 320) - 1, z1: Math.min(length, bz + box) - 1 });
    }
    return out;
  };
  /**
   * The clearance-form cells of the shipped grid as world blocks at 100 %
   * turned `r`, with the form each takes there: `[wx, wy, wz, form]` from the
   * anchor. Memoised per turn (a set has a few thousand form cells).
   */
  const turnedFormsCache = new Map<number, any[]>();
  const turnedForms = (r: number): any[] => {
    const cached = turnedFormsCache.get(r);
    if (cached) return cached;
    const out: any[] = [];
    const c = config.colliders, runs: string = c ? c.runs : '';
    let cell = 0;
    for (let k = 0; k + 1 < runs.length; k += 2) {
      const value = runs.charCodeAt(k) - 40, n = runs.charCodeAt(k + 1) - 40 + 1;
      const cv = value > 0 ? Math.floor((value - 1) / 136) : 0;
      if (cv === 0) { cell += n; continue; }
      const [lo, hi] = pairOf(value - cv * 136);
      for (let j = 0; j < n; j++, cell++) {
        const z = cell % c.length, y = Math.floor(cell / c.length) % c.height, x = Math.floor(cell / (c.length * c.height));
        const at = new Map<string, any[]>();
        kit.cellPieces(x, y, z, cv, lo, hi, c, 1, r, (wx: number, wy: number, wz: number, box: any) => {
          const key = `${wx},${wy},${wz}`;
          const list = at.get(key);
          if (list) list.push(box); else at.set(key, [box]);
        });
        for (const [key, list] of at) {
          const form = kit.cover(list);
          if (form) out.push([...key.split(',').map(Number), form]);
        }
      }
    }
    turnedFormsCache.set(r, out);
    return out;
  };
  async function placeColliders(st: any, dim: any, backups: any[], progress: (what: string) => void, key: string, stale?: any) {
    const c = config.colliders, f = factor(st), r = st.rotation, d = dims(st);
    const cellAt = (x: number, z: number) => r === 90 ? { x: c.length - 1 - z, z: x } : r === 180 ? { x: c.width - 1 - x, z: c.length - 1 - z } : r === 270 ? { x: z, z: c.width - 1 - x } : { x, z };
    // A PREVIOUS placement's colliders are invisible; left standing they are
    // exactly the "invisible wall" a player hits after cycling the size up or
    // down. A smaller re-lay does not even reach the bigger one's footprint, so
    // sweep the box the previous one covered before laying this one. Only this
    // pack's collider block is removed (blockFilter), and undo still restores
    // the boxes THIS placement backs up - the swept cells were our own debris.
    if (stale && stale.dimension === dim.id) {
      const old = placementBoxes(stale.to.x - stale.from.x + 1, stale.to.y - stale.from.y + 1, stale.to.z - stale.from.z + 1);
      for (let si = 0; si < old.length; si++) {
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        progress(`clearing the previous placement ${si + 1}/${old.length}`);
        const b = old[si];
        const from = { x: stale.from.x + b.x0, y: stale.from.y + b.y0, z: stale.from.z + b.z0 };
        const to = { x: stale.from.x + b.x1, y: stale.from.y + b.y1, z: stale.from.z + b.z1 };
        await load(dim, from, to);
        clearColliders(dim, from, to);
      }
    }
    const boxes = placementBoxes(d.width, d.height, d.length);
    const runs: string = c.runs;
    // Invisible steps for THIS size and turn (bedrock-collider-scale.ts): the
    // final pair of every block a tread run changes, 7 chars per block (x, y,
    // z as two base-200 digits each, then the pair index). Set after the
    // re-lay of each box so a tread wins over the cell it stands on.
    const treadPlan: string = (c.treads && c.treads.plans && c.treads.plans[`${st.size}:${r}`]) || '';
    let placed = 0, steps = 0;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
      progress(`re-laying walkable blocks ${bi + 1}/${boxes.length}`);
      const from = { x: st.anchor.x + b.x0, y: st.anchor.y + b.y0, z: st.anchor.z + b.z0 }, to = { x: st.anchor.x + b.x1, y: st.anchor.y + b.y1, z: st.anchor.z + b.z1 };
      await load(dim, from, to);
      const name = `craftmatic:${key}_c${bi}`;
      world.structureManager.createFromWorld(name, dim, from, to, { includeEntities: false, saveMode: StructureSaveMode.World });
      backups.push({ name, from });
      // Clear the box first: a smaller re-lay must not leave the old size behind.
      clearColliders(dim, from, to);
      // Cells this pass wrote. Merging is only right BETWEEN cells of this
      // re-lay (below 100 % several share a block, and at a fractional size two
      // cell rows share a world row); merging with whatever the world already
      // held would union a stale placement back in. Each cell's pieces come
      // from the collider form kit (`cellPieces`: the turned cell, the columns
      // it owns, the rows its span crosses, a clearance form's own boxes), and
      // a block takes the form covering every piece it received (`cover`).
      const written = new Set();
      const pieces = new Map<string, any[]>();
      let fellBack = 0;
      let cell = 0, budget = 0;
      for (let k = 0; k + 1 < runs.length; k += 2) {
        const value = runs.charCodeAt(k) - 40, n = runs.charCodeAt(k + 1) - 40 + 1;
        if (value === 0) { cell += n; continue; }
        const cv = Math.floor((value - 1) / 136);
        const [lo, hi] = pairOf(value - cv * 136);
        for (let j = 0; j < n; j++, cell++) {
          const z = cell % c.length, y = Math.floor(cell / c.length) % c.height, x = Math.floor(cell / (c.length * c.height));
          const rc = cellAt(x, z);
          const [x0, x1] = cellColumns(rc.x, f);
          const [z0, z1] = cellColumns(rc.z, f);
          if (x1 < b.x0 || x0 > b.x1 || z1 < b.z0 || z0 > b.z1) continue;
          kit.cellPieces(x, y, z, cv, lo, hi, c, f, r, (wx: number, wy: number, wz: number, box: any) => {
            if (wx < b.x0 || wx > b.x1 || wy < b.y0 || wy > b.y1 || wz < b.z0 || wz > b.z1) return;
            const key = `${wx},${wy},${wz}`;
            const list = pieces.get(key);
            if (list) list.push(box); else pieces.set(key, [box]);
          });
          if (++budget % 2000 === 0) {
            if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
            await wait(1);
          }
        }
      }
      for (const [key, list] of pieces) {
        const form = kit.cover(list);
        if (!form) continue;
        const [wx, wy, wz] = key.split(',').map(Number);
        const pos = { x: st.anchor.x + wx, y: st.anchor.y + wy, z: st.anchor.z + wz };
        let block: any;
        try { block = dim.getBlock(pos); } catch {}
        if (!block) continue;
        try { if (!kit.lay(block, form, c.loState, c.hiState, (id: string, st: any) => BlockPermutation.resolve(id, st))) fellBack++; written.add(`${pos.x},${pos.y},${pos.z}`); placed++; } catch {}
        if (++budget % 400 === 0) {
          if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
          await wait(1);
        }
      }
      if (fellBack) console.warn(`BRICK_WAND_FORM_FALLBACK ${fellBack} clearance forms laid as full colliders (their blocks are not defined in this world: is an older pack higher in the stack?)`);
      for (let k = 0; k + 6 < treadPlan.length; k += 7) {
        const digits = (o: number) => (treadPlan.charCodeAt(k + o) - 40) * 200 + treadPlan.charCodeAt(k + o + 1) - 40;
        const tx = digits(0), ty = digits(2), tz = digits(4);
        if (tx < b.x0 || tx > b.x1 || ty < b.y0 || ty > b.y1 || tz < b.z0 || tz > b.z1) continue;
        const [tl, th] = pairOf(treadPlan.charCodeAt(k + 6) - 40);
        const pos = { x: st.anchor.x + tx, y: st.anchor.y + ty, z: st.anchor.z + tz };
        let block: any;
        try { block = dim.getBlock(pos); } catch {}
        if (!block) continue;
        try { block.setPermutation(BlockPermutation.resolve(c.block, { [c.loState]: tl, [c.hiState]: th })); written.add(`${pos.x},${pos.y},${pos.z}`); steps++; } catch {}
        if (++budget % 400 === 0) {
          if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
          await wait(1);
        }
      }
      await wait(config.settleTicks);
    }
    return { placed, steps };
  }
  // Invisible steps the pack adds at a size and turn (0 at 100 %, or when the model needs none).
  const stepsAt = (st: any): number => (config.colliders && config.colliders.treads && config.colliders.treads.counts && config.colliders.treads.counts[`${st.size}:${st.rotation}`]) || 0;
  const stepsNote = (st: any): string => {
    const n = stepsAt(st);
    return n ? ` ${n} invisible step${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} added where the LEGO risers grew past a player's jump - the model's own stairs and ledges, climbable at 100 percent; nothing that was walkable is blocked.` : '';
  };
  async function place(p: any) {
    if (active) return tell(p, 'Another placement is running.');
    const st = { ...state(p), anchor: { ...state(p).anchor } }, dim = p.dimension;
    validate(p, st); active = { player: p.id, cancelled: false }; previews.delete(p.id); state(p).aim = false;
    const key = `${config.id}_${p.id.replaceAll('-', '').slice(0, 8)}_${Date.now().toString(36)}`, backups: any[] = [], entities: string[] = [], failedActors: string[] = [], spawned: any[] = [];
    // Every entity this placement spawns carries this tag, so an Undo after a
    // reload finds them by tag in whatever chunks it loads, not only by an id.
    const tag = `cmu_${config.shortAlias}_${p.id.replaceAll('-', '').slice(0, 8)}_${Date.now().toString(36)}`;
    // The world box this placement covers, remembered so the NEXT one can clear
    // the colliders it leaves behind (they are invisible; see placeColliders).
    const dPlace = dims(st);
    const bounds = { dimension: dim.id, from: { ...st.anchor }, to: { x: st.anchor.x + dPlace.width - 1, y: st.anchor.y + dPlace.height - 1, z: st.anchor.z + dPlace.length - 1 } };
    const previous = historyOf(p);
    removeGhost(p.id);
    const scripted = st.size !== 100 && config.tiles.length > 0;
    // Live progress on the action bar (the chat log scrolls away); one chat
    // line at the start and one at the end.
    const total = (scripted ? 1 : config.tiles.length) + config.actors.length, settle = config.settleTicks, hold = config.finalHoldTicks;
    const progress = (done: number, what: string) => {
      const n = 12, k = Math.max(0, Math.min(n, Math.round(done / Math.max(1, total) * n)));
      try { p.onScreenDisplay.setActionBar(`§b[Brick Wand]§r ${'▰'.repeat(k)}§8${'▱'.repeat(n - k)}§r ${percent(Math.round(done / Math.max(1, total) * 100))} · ${what}`); } catch {}
    };
    const pieces = `${scripted ? 'the walkable blocks' : `${config.tiles.length} structure piece${config.tiles.length === 1 ? '' : 's'}`}${config.actors.length ? ` and ${config.actors.length} entit${config.actors.length === 1 ? 'y' : 'ies'}` : ''}${st.size !== 100 ? ` at ${percent(st.size)}` : ''}`;
    tell(p, `Placing ${config.label}: ${pieces}. Watch the bar above the hotbar.`);
    let stepsAdded = 0;
    try {
      if (scripted) {
        const laid = await placeColliders(st, dim, backups, what => progress(0, what), key, previous && previous.bounds);
        stepsAdded = laid.steps;
        progress(1, `${laid.placed} walkable blocks laid${laid.steps ? `, ${laid.steps} invisible steps added` : ''}`);
      } else for (let i = 0; i < config.tiles.length; i++) {
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        const t = tileAt(config.tiles[i], st.rotation), from = { x: st.anchor.x + t.dx, y: st.anchor.y + t.dy, z: st.anchor.z + t.dz }, to = { x: from.x + t.width - 1, y: from.y + t.height - 1, z: from.z + t.length - 1 }, name = `craftmatic:${key}_${i}`;
        progress(i, `loading area for piece ${i + 1}/${config.tiles.length}`);
        await load(dim, from, to);
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        world.structureManager.createFromWorld(name, dim, from, to, { includeEntities: false, saveMode: StructureSaveMode.World });
        backups.push({ name, from });
        // A failed `structure load` (unknown structure, bad rotation) reports
        // successCount 0 without throwing; treated as success it placed nothing
        // and reported 100 %.
        const loadResult = await dim.runCommand(`structure load ${t.identifier} ${from.x} ${from.y} ${from.z} ${st.rotation}_degrees none`);
        if (loadResult && loadResult.successCount === 0) throw new Error(`structure ${t.identifier} could not be loaded (piece ${i + 1}/${config.tiles.length}). Is the behavior pack's structures folder intact?`);
        // A structure turned by `structure load` moves each block but keeps its
        // states, and a clearance form's shape is part of its id (a wall pulled
        // back to its west side would stay west after a quarter turn). So each
        // form block of this piece is re-set, while the piece's area is loaded,
        // to the form the turn gives it - `cellPieces`, the arithmetic of every
        // other size. Only this pack's collider blocks are touched.
        // Unturned it is the same pass, as a check: a form block the world does
        // not know (an older pack's definitions winning) arrives as air or an
        // unknown block, and is laid as the full collider instead - never a hole.
        if (config.colliders) {
          let fellBack = 0;
          for (const [wx, wy, wz, form] of turnedForms(st.rotation)) {
            const pos = { x: st.anchor.x + wx, y: st.anchor.y + wy, z: st.anchor.z + wz };
            if (pos.x < from.x || pos.x > to.x || pos.y < from.y || pos.y > to.y || pos.z < from.z || pos.z > to.z) continue;
            try {
              const block = dim.getBlock(pos);
              if (!block) continue;
              const ours = kit.variantOf(block.typeId) >= 0;
              if (!ours && !(block.isAir === true || block.typeId === 'minecraft:air' || block.typeId === 'minecraft:unknown')) continue;
              if (ours && block.typeId === kit.VARIANTS[form.v].id && Number(block.permutation.getState(config.colliders.loState)) === form.lo && Number(block.permutation.getState(config.colliders.hiState)) === form.hi) continue;
              if (!kit.lay(block, form, config.colliders.loState, config.colliders.hiState, (id: string, st2: any) => BlockPermutation.resolve(id, st2))) fellBack++;
            } catch {}
          }
          if (fellBack) console.warn(`BRICK_WAND_FORM_FALLBACK ${fellBack} clearance forms laid as full colliders (their blocks are not defined in this world: is an older pack higher in the stack?)`);
        }
        progress(i + 1, `piece ${i + 1}/${config.tiles.length} placed`);
        // Let the chunks tick with the area still alive so the block updates
        // reach every client before the area (and maybe the chunk) goes away.
        await wait(settle);
      }
      // Structure tiles contain the 100 percent doors. At another size they are
      // intentionally replaced by colliders, so re-hang only semantic leaves
      // whose measured physical height now reaches two blocks.
      const installedDoors = new Set<number>();
      for (const [doorIndex, door] of (scripted ? (config.runtimeDoorCandidates || []) : []).entries()) {
        if (st.size < door.requiredSize) continue;
        const q = worldPoint(st, door), x = Math.floor(q.x), y = Math.floor(q.y), z = Math.floor(q.z);
        try {
          await load(dim, { x: x - 1, z: z - 1 }, { x: x + 1, z: z + 1 });
          // Bedrock's legacy door direction is south=0, west=1, north=2,
          // east=3. A quarter turn adds one; apply a real Bedrock permutation
          // instead of emitting Java's facing/half/hinge command syntax.
          const rotateDoor = (states: any) => typeof states.direction === 'number' ? { ...states, direction: (states.direction + st.rotation / 90) % 4 } : states;
          if (x < bounds.from.x || x > bounds.to.x || y < bounds.from.y || y + 1 > bounds.to.y || z < bounds.from.z || z > bounds.to.z)
            throw new Error('measured door clearance falls outside the resized placement');
          const below = dim.getBlock({ x, y: y - 1, z }), lower = dim.getBlock({ x, y, z }), upper = dim.getBlock({ x, y: y + 1, z });
          if (!below || !lower || !upper) throw new Error('door support or clearance cells are outside the loaded placement area');
          if (below.isAir === true || below.typeId === 'minecraft:air') throw new Error('no solid support exists below the resized opening');
          lower.setPermutation(BlockPermutation.resolve('minecraft:air'));
          upper.setPermutation(BlockPermutation.resolve('minecraft:air'));
          lower.setPermutation(BlockPermutation.resolve(door.lower.id, rotateDoor(door.lower.states)));
          upper.setPermutation(BlockPermutation.resolve(door.upper.id, rotateDoor(door.upper.states)));
          installedDoors.add(doorIndex);
        } catch (e: any) { tell(p, `§eDoor could not be re-hung at ${percent(st.size)} (${e?.message || e}).`); }
      }
      const done0 = scripted ? 1 : config.tiles.length;
      for (let j = 0; j < config.actors.length; j++) {
        const actor = config.actors[j];
        // A sub-scale source door leaf remains honest LEGO geometry until its
        // measured opening can accept a two-block vanilla door. At and above
        // that threshold runtimeDoorCandidates takes over; do not render both.
        const doorReplaced = scripted
          ? actor.doorCandidateIndex !== undefined && installedDoors.has(actor.doorCandidateIndex)
          : st.size === 100 && actor.hideAt100 === true;
        if (actor.maxSizeExclusive !== undefined && st.size >= actor.maxSizeExclusive && doorReplaced) {
          progress(done0 + j + 1, `${actor.label} replaced by interactive blocks`);
          continue;
        }
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        const q = worldPoint(st, actor);
        progress(done0 + j, `spawning ${actor.label}`);
        await load(dim, { x: q.x - 1, z: q.z - 1 }, { x: q.x + 1, z: q.z + 1 });
        if (active.cancelled) throw new Error('Canceled. Use Undo to restore any changed area.');
        // One entity that fails to spawn (a type the content log rejected)
        // must not stop the rest: the Pixel round of 2026-09-16 lost every
        // vehicle placement to its first figure NPC.
        try {
          // A figure must stand ON the floor where the source put it - not inside
          // a wall it can never path out of, not sunk into a floor plate, and not
          // inside the world block under the pin. The figure is player-sized at
          // every step at or above 100 % (its body never scales up), while the
          // floors and walls around it do, so the check is geometric rather than
          // a cell rule: the body [feet, feet + height) is raised to the top of
          // whatever collision span it overlaps, repeatedly, until it is clear.
          // A floor plate (0..3/16 at 100 %, 0..12/16 at 400 %) lifts the feet by
          // its own thickness only; a wall lifts past itself; a ceiling slab over
          // the head is left alone unless the body actually reaches it. If the
          // lift would exceed three cells (three blocks × the size factor) the
          // figure stays where the source put it (round b lifted one onto the
          // roof by treating "any collider" as a wall - that is why the budget).
          let spawnY = q.y;
          if (config.colliders && /_fig[0-9]+$/.test(actor.typeId)) {
            const bx = Math.floor(q.x), bz = Math.floor(q.z), f = factor(st);
            const bodyHeight = 1.8 * Math.min(1, f), budget = 3 * f;
            // The collision span [bottom, top] of the block in world row `y`, or null for air.
            const spanAt = (y: number) => {
              try {
                const b = dim.getBlock({ x: bx, y, z: bz });
                if (!b) return null;
                const v = kit.variantOf(b.typeId);
                if (v >= 0) {
                  const lo = Number(b.permutation.getState(config.colliders.loState)), hi = Number(b.permutation.getState(config.colliders.hiState));
                  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [y, y + 1];
                  // A clearance form's vertical extent (collider-form.ts); a full collider's is lo..hi.
                  const boxes = kit.formBoxes(v, lo, hi);
                  return [y + Math.min(...boxes.map((q: any) => q[2])) / 16, y + Math.max(...boxes.map((q: any) => q[3])) / 16];
                }
                if (b.isAir === true || b.isLiquid === true || b.typeId === 'minecraft:air') return null;
                return [y, y + 1];
              } catch { return null; }
            };
            let feet = q.y;
            for (let guard = 0; guard < 64; guard++) {
              let lifted = false;
              for (let y = Math.floor(feet); y <= Math.floor(feet + bodyHeight - 1e-9); y++) {
                const s = spanAt(y);
                // The body overlaps a span when the span starts below the head and ends above the feet.
                if (s && s[0] < feet + bodyHeight - 1e-9 && s[1] > feet + 1e-9) { feet = s[1]; lifted = true; break; }
              }
              if (!lifted) break;
            }
            if (feet - q.y <= budget + 1e-9) spawnY = feet;
          }
          const entity = dim.spawnEntity(actor.typeId, { x: q.x, y: spawnY, z: q.z });
          entity.nameTag = actor.label;
          // A moving part keeps yaw 0: its rig's root turns it (the interactives
          // runtime sets the turn), so its world-aligned tap boxes stay true.
          entity.setRotation({ x: 0, y: actor.interactive !== undefined ? 0 : (actor.yaw || 0) + st.rotation }); entities.push(entity.id); spawned[j] = entity;
          try { entity.addTag?.(tag); } catch {}
          if (/_fig[0-9]+$/.test(actor.typeId)) {
            // The figure's home record (bedrock-figure-life.ts FigureHome): where it
            // stands, the placement's world box, the pin plane and the size, so
            // scripts/figures.js keeps it on this model, on this floor, and can
            // re-adopt it after a reload. A source-seated figure stays seated.
            try {
              entity.setDynamicProperty('craftmatic:fig', JSON.stringify({ home: [q.x, spawnY, q.z], area: [bounds.from.x, bounds.from.z, bounds.to.x + 1, bounds.to.z + 1], ground: st.anchor.y, f: factor(st), mode: actor.rideOf !== undefined ? 'seated' : 'roam' }));
            } catch {}
          }
          if (actor.coasterRouteIndex !== undefined) {
            // Store the transformed model origin, not the cart's start point.
            // Route samples use the same rotation/scale as every shell actor.
            entity.setDynamicProperty('craftmatic:coaster_origin', worldPoint(st, { x: 0, y: 0, z: 0 }));
            entity.setDynamicProperty('craftmatic:coaster_rotation', st.rotation);
            entity.setDynamicProperty('craftmatic:coaster_scale', factor(st));
            entity.setDynamicProperty('craftmatic:coaster_route', actor.coasterRouteIndex);
            // A train's car order: the runtime honours a written index and only
            // assigns one itself when this is absent (bedrock-coaster.ts).
            if (actor.coasterCarIndex !== undefined) entity.setDynamicProperty('craftmatic:coaster_car', actor.coasterCarIndex);
          }
          if (actor.pinball) {
            // The same transformed model origin the coaster stores; the pinball
            // runtime maps the table's plane into the world with it (bedrock-pinball.ts).
            entity.setDynamicProperty('craftmatic:pinball_origin', worldPoint(st, { x: 0, y: 0, z: 0 }));
            entity.setDynamicProperty('craftmatic:pinball_rotation', st.rotation);
            entity.setDynamicProperty('craftmatic:pinball_scale', factor(st));
          }
          if (actor.interactive !== undefined) {
            // A door, window or turnable (bedrock-interactives.ts): its runtime
            // maps the doorway's collider cells with the placement's own anchor,
            // turn and size, and lays the closed state on its next sync pass.
            entity.setDynamicProperty('craftmatic:ix', actor.interactive);
            entity.setDynamicProperty('craftmatic:ix_anchor', { x: st.anchor.x, y: st.anchor.y, z: st.anchor.z });
            entity.setDynamicProperty('craftmatic:ix_rotation', st.rotation);
            entity.setDynamicProperty('craftmatic:ix_scale', factor(st));
          }
          if (st.size !== 100) { try { entity.triggerEvent(sizeEvent(st.size)); } catch (e: any) { tell(p, `§e${actor.label} could not take size ${percent(st.size)} (${e && e.message ? e.message : e}); it stands at 100 percent.`); } }
          progress(done0 + j + 1, `${actor.label} placed`);
        } catch (e: any) {
          failedActors.push(actor.label);
          tell(p, `§e${actor.label} could not be spawned (${e && e.message ? e.message : e}); continuing.`);
          progress(done0 + j + 1, `${actor.label} skipped`);
        }
        await wait(settle);
      }
      // Brick-built chairs have no reliable LDraw mould signature. A player can
      // explicitly mark the sitting surface; model-local anchors follow the
      // normal rotation/size transform and are recorded for Undo.
      removeManualSeatEntities(st);
      for (const [k, seat] of (st.manualSeats || []).entries()) {
        if (!config.manualSeatTypeId) break;
        const q = worldPoint(st, seat);
        try {
          if (config.colliders) {
            const block = dim.getBlock({ x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) });
            if (block && kit.variantOf(block.typeId) >= 0) {
              const lo = Number(block.permutation.getState(config.colliders.loState)), hi = Number(block.permutation.getState(config.colliders.hiState));
              if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo >= 12) tell(p, `§eMarked seat ${k + 1} is inside a wall-height collider; stand on the chair surface and mark it again.`);
            }
          }
          const entity = dim.spawnEntity(config.manualSeatTypeId, q);
          entity.nameTag = `Marked seat ${k + 1}`;
          entity.setRotation({ x: 0, y: (seat.yaw || 0) + st.rotation });
          if (st.size !== 100) entity.triggerEvent(sizeEvent(st.size));
          entities.push(entity.id);
          try { entity.addTag?.(tag); } catch {}
          st.manualSeatIds.push(entity.id);
        } catch (e: any) { failedActors.push(`marked seat ${k + 1}`); tell(p, `§eMarked seat ${k + 1} could not be spawned (${e?.message || e}).`); }
        await wait(settle);
      }
      saveManualSeats(p, st);
      // A figure the source seated on a chair rides that chair's seat entity (its sit pose plays while riding).
      for (let j = 0; j < config.actors.length; j++) {
        const actor = config.actors[j];
        if (actor.rideOf === undefined || !spawned[j] || !spawned[actor.rideOf]) continue;
        try {
          const seat = spawned[actor.rideOf].getComponent('minecraft:rideable');
          if (!seat || !seat.addRider(spawned[j])) tell(p, `§e${actor.label} could not take its seat; it stands instead.`);
        } catch (e: any) { tell(p, `§e${actor.label} could not take its seat (${e && e.message ? e.message : e}).`); }
      }
      // Replacing a placement must retire its old actors too; otherwise every
      // re-place duplicated figures, mould seats and user-marked brick chairs.
      if (previous) {
        for (const id of previous.entities) try { world.getEntity(id)?.remove(); } catch {}
        // A record from an earlier session: its entities may not have been
        // loaded by id; any of them in loaded chunks go by the placement's tag.
        if (previous.tag) try { for (const e of world.getDimension(previous.dimension).getEntities({ tags: [previous.tag] }) || []) try { e.remove(); } catch {} } catch {}
        for (const b of previous.backups) try { world.structureManager.delete(b.name); } catch {}
      }
      setHistory(p, { dimension: dim.id, backups, entities, bounds, tag });
      progress(total, 'done');
      await wait(hold);
      const stepsDone = stepsAdded ? ` ${stepsAdded} invisible step${stepsAdded === 1 ? '' : 's'} added where its risers grew past a jump.` : '';
      tell(p, failedActors.length ? `§aPlaced ${config.label} (${failedActors.length} entit${failedActors.length === 1 ? 'y' : 'ies'} could not be spawned).${stepsDone} Use the Brick Wand to undo.` : `§aPlaced ${config.label}.${stepsDone} Use the Brick Wand to undo.`);
    } catch (e: any) {
      if (backups.length || entities.length) {
        if (previous) for (const b of previous.backups) try { world.structureManager.delete(b.name); } catch {}
        setHistory(p, { dimension: dim.id, backups, entities, bounds, tag });
      }
      tell(p, `§cPlacement stopped: ${e.message || e}`);
    }
    finally { await unload(); active = undefined; }
  }
  async function undo(p: any) {
    if (active) return tell(p, 'Wait for placement to finish or cancel it first.');
    const h = historyOf(p); if (!h) return tell(p, 'Nothing to undo.');
    active = { player: p.id, cancelled: false };
    try {
      const dim = world.getDimension(h.dimension);
      // Entities first, by id where they are loaded; the rest are found by the
      // placement's tag as each area loads below (a reload leaves the chunks
      // unloaded until then, and world.getEntity sees only loaded ones).
      const missing = new Set<string>();
      for (const id of h.entities) {
        let e: any;
        try { e = world.getEntity(id); } catch {}
        if (e) { try { e.remove(); } catch {} } else missing.add(id);
      }
      const sweep = () => {
        if (!h.tag || !missing.size) return;
        let found: any[] = [];
        try { found = dim.getEntities({ tags: [h.tag] }) || []; } catch {}
        for (const e of found) { missing.delete(e.id); try { e.remove(); } catch {} }
      };
      for (const b of h.backups) {
        const structure = world.structureManager.get(b.name);
        if (!structure) continue;
        const to = { x: b.from.x + structure.size.x - 1, y: b.from.y + structure.size.y - 1, z: b.from.z + structure.size.z - 1 };
        await load(dim, b.from, to);
        world.structureManager.place(b.name, dim, b.from, { includeEntities: false, includeBlocks: true });
        world.structureManager.delete(b.name);
        sweep();
        await wait(1);
      }
      // Entities outside every snapshot (an entity-only pack, or one standing
      // past the blocks): load the placement's box a piece at a time and sweep.
      if (missing.size && h.tag && h.bounds && h.bounds.from && h.bounds.to) {
        const f = h.bounds.from, t = h.bounds.to;
        for (const box of placementBoxes(t.x - f.x + 1, t.y - f.y + 1, t.z - f.z + 1)) {
          if (!missing.size) break;
          await load(dim, { x: f.x + box.x0, y: f.y + box.y0, z: f.z + box.z0 }, { x: f.x + box.x1, y: f.y + box.y1, z: f.z + box.z1 });
          sweep();
        }
      }
      dropHistory(p);
      tell(p, missing.size ? `§aUndo complete§r (${missing.size} entit${missing.size === 1 ? 'y was' : 'ies were'} not found - already removed, or outside the placement's box).` : '§aUndo complete.');
    } catch (e: any) { tell(p, `Undo stopped: ${e.message || e}`); }
    finally { await unload(); active = undefined; }
  }
  async function manageManualSeats(p: any, st: any) {
    const seats = st.manualSeats || [];
    const f = new ActionFormData().title(`${config.label} · marked seats`).body(seats.length ? 'Remove a marker if it is not on the sitting surface. Marked seats remain model-local through resize and quarter turns.' : 'No marked seats yet. Stand on a chair’s sitting surface and choose Add seat here.');
    for (let i = 0; i < seats.length; i++) f.button(`Remove seat ${i + 1}`);
    if (seats.length) f.button('Remove all marked seats');
    f.button('Back');
    const r = await show(p, f); if (r.canceled || r.selection === undefined) return;
    if (r.selection < seats.length) seats.splice(r.selection, 1);
    else if (seats.length && r.selection === seats.length) seats.splice(0, seats.length);
    else return menu(p);
    removeManualSeatEntities(st); saveManualSeats(p, st);
    tell(p, 'Marked seat anchor removed. Re-place the build to update its seat entities.');
    return menu(p);
  }
  async function menu(p: any): Promise<any> {
    const st = state(p), running = active?.player === p.id;
    const nextSize = sizes[(sizes.indexOf(st.size) + 1) % sizes.length];
    const interaction = config.interactionNote ? `\n\n§eInteraction scale: ${config.interactionNote}` : '';
    const f = new ActionFormData().title(`${config.label} · Brick Wand`).body(`${summary(st)}${interaction}${walkThroughLine()}\n\nPreview first: ${config.preview ? 'a translucent ghost of the whole build stands at the pin, turned to the chosen rotation and size, with' : 'a full-size outline and model markers stay fixed at the pinned placement;'} red/green/blue marking +X/+Y/+Z and gold the model's -Z side. "Follow my aim" moves it to wherever you look until you pin. Place is always a separate confirmation.`);
    if (running) f.button('Cancel placement');
    else {
      f.button('Pin centred on me').button('Pin corner at my feet').button('Edit coordinates').button(`Rotate → ${(st.rotation + turnStep) % 360}°`).button('View preview in world').button('Place…').button('Undo last placement').button('Hide preview').button('Lighting / night vision');
      f.button(st.aim ? 'Stop following my aim' : 'Follow my aim').button(`Size ${sizeLabel(st.size)} → ${sizeLabel(nextSize)}${!blocksResizable && nextSize !== 100 ? ' (entities only)' : ''}`);
      const recommendedDoorSize = nextDoorSize(st.size);
      if (recommendedDoorSize) f.button(`Use next door size ${percent(recommendedDoorSize)}`);
      if (config.manualSeatTypeId) {
        f.button(`Add seat here (${(st.manualSeats || []).length}/${manualSeatCap})`);
        f.button('Manage marked seats');
      }
      if (fineTurn) f.button(`Turn back ← ${((st.rotation - turnStep) % 360 + 360) % 360}°`);
    }
    if (!running && config.vehicleControls) f.button('DeLorean controls');
    const r = await show(p, f); if (r.canceled) return;
    if (running) { if (active?.player === p.id) active.cancelled = true; return tell(p, 'Cancel requested.'); }
    if (r.selection === 0) {
      // The origin is the model's corner; put the ROTATED, SIZED footprint centre on the player so a
      // vehicle-only pack lands where they stand instead of half a model away.
      st.aim = false;
      pinCentredAt(p, st, p.location);
      return menu(p);
    }
    if (r.selection === 1) { st.aim = false; st.anchor = { x: Math.floor(p.location.x), y: Math.floor(p.location.y), z: Math.floor(p.location.z) }; st.dimension = p.dimension.id; previews.add(p.id); return menu(p); }
    if (r.selection === 2) return edit(p);
    if (r.selection === 3) {
      st.rotation = fineTurn ? (st.rotation + turnStep) % 360 : rotations[(rotations.indexOf(st.rotation) + 1) % 4];
      if (st.anchor) previews.add(p.id); return menu(p);
    }
    if (r.selection === 4) { try { validate(p, st); } catch (e: any) { tell(p, e.message); return menu(p); } previews.add(p.id); return tell(p, config.preview ? "The ghost stands at the pin, turned to the chosen rotation and size. Switch away from the wand and back to rotate, resize or place." : "Full-size preview fixed at the pin. Red/green/blue mark +X/+Y/+Z; gold marks the model's -Z side. Switch away from the wand and back to rotate or place."); }
    if (r.selection === 5) return confirmPlace(p);
    if (r.selection === 6) return undo(p);
    if (r.selection === 7) { previews.delete(p.id); st.aim = false; removeGhost(p.id); return tell(p, 'Preview hidden.'); }
    if (r.selection === 8) return lighting(p);
    if (r.selection === 9) {
      st.aim = !st.aim;
      if (st.aim) { previews.add(p.id); const target = aimTarget(p); if (target) pinCentredAt(p, st, target); return tell(p, 'The preview now follows the block you look at. Open the wand and pin (or place) when it is where you want it.'); }
      return tell(p, st.anchor ? 'The preview stays where it is.' : 'Aim stopped.');
    }
    if (r.selection === 10) {
      st.size = nextSize;
      if (st.anchor) previews.add(p.id);
      if (!blocksResizable && nextSize !== 100) tell(p, 'This pack\'s blocks were exported as coloured blocks: only the entities take the new size. Export again with brick-accurate buildings or at another model scale for the blocks to follow.');
      // The measured reason, quoted whole, the moment the wand lands on that step.
      if (recommendedSize && nextSize === recommendedSize) tell(p, `${percent(nextSize)} is the measured walk-through size: ${access.reason}`);
      return menu(p);
    }
    const recommendedDoorSize = nextDoorSize(st.size);
    if (recommendedDoorSize && r.selection === 11) { st.size = recommendedDoorSize; if (st.anchor) previews.add(p.id); return tell(p, `Door size set to ${percent(recommendedDoorSize)}. Eligible leaves at or below this threshold become interactive; larger measured leaves remain source geometry.`); }
    const seatSelection = 11 + (recommendedDoorSize ? 1 : 0);
    if (config.manualSeatTypeId && r.selection === seatSelection) {
      try {
        validate(p, st);
        const at = modelPoint(st, p.location);
        if (at.x < 0 || at.x > config.width || at.y < 0 || at.y > config.height || at.z < 0 || at.z > config.length) throw new Error('Stand on the chair seat inside the pinned build before marking it.');
        if ((st.manualSeats || []).length >= manualSeatCap) throw new Error(`You can mark up to ${manualSeatCap} seats. Use Manage marked seats to remove one first.`);
        if ((st.manualSeats || []).some((seat: any) => Math.abs(seat.x - at.x) < .25 && Math.abs(seat.y - at.y) < .25 && Math.abs(seat.z - at.z) < .25)) throw new Error('That chair surface is already marked.');
        st.manualSeats = [...(st.manualSeats || []), { x: at.x, y: at.y, z: at.z, yaw: (p.getRotation?.().y || 0) - st.rotation }];
        saveManualSeats(p, st);
        return tell(p, 'Seat marked at your feet. Stand on the chair’s sitting surface; it will rotate, resize and be removed with this placement.');
      } catch (e: any) { tell(p, e.message || String(e)); return menu(p); }
    }
    const manageSeatsSelection = seatSelection + 1;
    if (config.manualSeatTypeId && r.selection === manageSeatsSelection) return manageManualSeats(p, st);
    const afterSeat = (recommendedDoorSize ? 1 : 0) + (config.manualSeatTypeId ? 2 : 0);
    if (fineTurn && r.selection === 11 + afterSeat) { st.rotation = ((st.rotation - turnStep) % 360 + 360) % 360; if (st.anchor) previews.add(p.id); return menu(p); }
    if (r.selection === (fineTurn ? 12 + afterSeat : 11 + afterSeat) && config.vehicleControls && openVehicleControls) return openVehicleControls(p);
  }
  world.afterEvents.itemUse.subscribe((ev: any) => { if (ev.itemStack.typeId === config.itemId) system.run(() => menu(ev.source).catch((e: any) => tell(ev.source, e.message || String(e)))); });
  console.warn(`BRICK_WAND_READY ${config.id}`);
}

export function buildPlacementPackAssets(spec: PlacementPackSpec): PlacementPackAssets {
  const id = spec.stem.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
  const itemId = `craftmatic:${id}_brick_wand`;
  const shortAlias = placementAlias(spec.stem);
  // Invisible steps are planned from the shipped grid here, so a brick-shell
  // pack carries them without the pipeline knowing (bedrock-collider-scale.ts).
  const treads = spec.colliders && spec.treads !== false ? withColliderTreads(spec.colliders, spec.reachTargets ?? []) : undefined;
  const config = { id, shortAlias, vehicleControls: spec.vehicleControls === true, label: spec.label, itemId, width: spec.width, height: spec.height, length: spec.length, tiles: spec.tiles, actors: spec.actors ?? [], previewPoints: (spec.previewPoints ?? []).slice(0, 120),
    preview: spec.preview ?? null, colliders: treads ? treads.colliders : spec.colliders ?? null, interactionNote: spec.interactionNote ?? '', access: spec.access ?? null, manualSeatTypeId: spec.manualSeatTypeId ?? '', runtimeDoorCandidates: spec.runtimeDoorCandidates ?? [], sizes: [...SIZE_STEPS], sizeEventPrefix: SIZE_EVENT_PREFIX, settleTicks: spec.settleTicks ?? 8, finalHoldTicks: spec.finalHoldTicks ?? 40 };
  const controlsImport = spec.vehicleControls ? 'import { showTimeMachineControls } from "./time-machine.js";\n' : '';
  const script = `${controlsImport}import { world, system, StructureSaveMode, BlockPermutation, BlockVolume } from "@minecraft/server";\nimport { ActionFormData, ModalFormData } from "@minecraft/server-ui";\nconst CONFIG = ${JSON.stringify(config)};\n(${placementRuntime.toString()})(CONFIG, ${spec.vehicleControls ? "showTimeMachineControls" : "undefined"}, (${colliderFormKit.toString()})());\n`;
  const item = {
    format_version: '1.21.30',
    'minecraft:item': {
      description: { identifier: itemId, menu_category: { category: 'items' } },
      components: {
        'minecraft:icon': 'brick',
        'minecraft:display_name': { value: `${spec.label} BrickWand` },
        'minecraft:max_stack_size': 1,
      },
    },
  };
  const grant = `give @s ${itemId} 1\ntellraw @s ${JSON.stringify({ rawtext: [{ text: `§b[BrickWand]§r Select ${spec.label} BrickWand in your hotbar to open it. Switch away and back to reopen. "Follow my aim" moves the ghost preview to wherever you look; pin, rotate and size it, then place.` }] })}\n`;
  return {
    itemId, shortAlias, script,
    files: [
      { name: `items/${id}_brick_wand.json`, data: text(JSON.stringify(item, null, 2)) },
      { name: 'scripts/placement.js', data: text(script) },
      { name: `functions/${shortAlias}.mcfunction`, data: text(grant) },
      { name: `functions/craftmatic/${id}.mcfunction`, data: text(grant) },
      // The planner's findings, inspectable from the pack: counts per size and
      // turn, what could not be restored and why, and the walk before/after.
      ...(treads ? [{ name: 'craftmatic-treads.json', data: text(JSON.stringify(treads.report, null, 1)) }] : []),
    ],
    ...(treads ? { treads: treads.report } : {}),
  };
}
