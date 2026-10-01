/**
 * A LEGO BUILDING at the vehicle pipeline's fidelity: the block structure
 * becomes an INVISIBLE collider the player walks on, and a static entity
 * compiled from the real part geometry (ldraw-entity-compiler.ts: exact part
 * boxes, round studs, LDraw colours, Vibrant Visuals maps) stands on the same
 * footprint - the "shell". Doors, seats and figures keep working exactly as
 * before: they live on the block grid and the actor list, the shell is only
 * what the eye sees.
 *
 * Colliders are a custom block, `craftmatic:collider`, with two integer
 * states `lo` / `hi` (sixteenths of a block): the cell's collision box spans
 * lo..hi, measured from the part boxes that fall in the cell. A 53 LDU cell
 * whose only content is an 8 LDU baseplate collides 0..3/16, so the player
 * stands ON the plate the shell draws, not a block above it. The block is
 * fully transparent (alpha-tested clear texture), dampens no light (the
 * interior stays lit by daylight) and has no selection box, so a tap reaches
 * the vanilla door behind it.
 *
 * Frame: the block grid maps LDraw (x, y, z) to cells as (x, −y, −z) - a half
 * turn about X, the proper rotation between two right-handed frames
 * (`sceneGridPoint`). The shell must land on the same cells: at yaw 0 the
 * world sees the render frame as (−x, y, −z) (extraPlacement, proven on the
 * Pixel), so the shell is compiled like a vehicle whose nose is LDraw −Z,
 * `ldrawToRenderRotation('-z')` = diag(−1, −1, 1), which composes to exactly
 * (x, −y, −z) - the grid's frame. Until 2026-09-22 the grid was the MIRROR
 * (x, −y, z) and the shell used the point reflection −I to land on it: a
 * compensation for the mirror, not a frame of its own, and it made every
 * building read backwards. The shell's actor position is its floor centre
 * mapped through the voxelizer's grid origin like every figure and seat.
 */

import { withSizeGroups } from './bedrock-placement-pack.js';
import { BlockGrid } from '@craft/schem/types.js';
import type { Vec3 } from './ldraw-part-geometry.js';
import type { OrientedBoxLdu } from './ldraw-entity-compiler.js';
import { clipParallelepiped, isAxisAligned, parallelepiped, type Parallelepiped } from './oriented-box.js';

export { clipParallelepiped } from './oriented-box.js';
import { sceneGridPoint, type SceneGridFrame } from './bedrock-scene-actors.js';
import { ldrawToRenderRotation } from './ldraw-entity-compiler.js';
import { PACK_NAMESPACE } from './mcpack.js';
import type { LegoEntityQuality } from './ldraw-part-prototype.js';
import { COLLIDER_KIT, COLLIDER_STATES } from './collider-form.js';
import { addLayerBox, newCellLayers, type CellLayers } from './collider-clearance.js';
import { ACTOR_DRAW_CEILING_BLOCKS } from './bedrock-lod-hull.js';
import { JUMP_HEIGHT_BLOCKS } from './addon-scale.js';

/** The custom collider block and its two sixteenth states. */
export const COLLIDER_BLOCK_ID = `${PACK_NAMESPACE}:collider`;
export const COLLIDER_LO_STATE: string = COLLIDER_STATES.lo;
export const COLLIDER_HI_STATE: string = COLLIDER_STATES.hi;
/** The block-state string the grid carries for a collider spanning lo..hi sixteenths. */
export const colliderState = (lo: number, hi: number): string => `${COLLIDER_BLOCK_ID}[lo=${lo},hi=${hi}]`;

/** The LDraw → render matrix for a building shell at yaw 0: a −Z nose, det +1 (see the header). */
export const SHELL_FRAME: readonly number[] = ldrawToRenderRotation('-z');

/**
 * Cuboid budgets for a building shell - a whole building is many times a
 * vehicle. Bricks are single boxes at any grain, so the grain only decides
 * slopes, curves and holes.
 *
 * `microcellLdu` is where every part STARTS; `maxModelCubes` is what the
 * entity must fit, and the compiler's per-part planner (`planPartGrains`)
 * coarsens individual parts, least visible loss per cuboid first, until it
 * does. Retuned 2026-09-21 from a table that had `balanced` at 8 LDU with a
 * 64-cuboid part cap: on 10303 (3,808 parts) that shipped 13.9k cuboids at an
 * area-weighted six-view silhouette IoU of 0.930, with the four coaster track
 * moulds - the set's whole point - pushed to 16 LDU by the part cap; `high`
 * asked for 4 LDU but its 32,768 cap sent the whole model back to 8. Measured
 * on the same set: uniform 4 LDU is 50.9k cuboids / 0.949, uniform 2 LDU
 * 142k / 0.967, 1 LDU 316k / 0.977 (and 68 s of compile). The device limits
 * (guide): ~480k resident cuboids over every active pack, ~50k DRAWN for
 * 60 fps, ~100k for 30. So:
 *
 *   balanced  48k total: one set fully in view stays at 60 fps, 10 % of the
 *             device; 10303 plans to IoU 0.957 with its track at 2-4 LDU.
 *   high      96k: a 30 fps scene when the whole set is near, 20 %.
 *   ultra    160k: everything at 2 LDU for a set this size (10303 is 157k),
 *             a third of the device. 1 LDU is not offered for a shell: 2.2x
 *             the cuboids again for +0.010 IoU, and a minute of compile.
 *
 * `maxPartCubes` is only a guard against a pathological mould now; the
 * planner, not the cap, decides what a detailed part may cost.
 */
export const LEGO_SHELL_QUALITY: Record<'balanced' | 'high' | 'ultra', LegoEntityQuality> = {
  balanced: { maxModelCubes: 49152, maxPartCubes: 4096, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 12288, studFacets: 4 },
  high: { maxModelCubes: 98304, maxPartCubes: 4096, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 16384, studFacets: 4 },
  ultra: { maxModelCubes: 163840, maxPartCubes: 4096, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 24576, studFacets: 4 },
};

/** Blocks that stay VISIBLE under the shell: what the scene made live, and light sources. */
export function isSceneBlock(state: string): boolean {
  const id = state.replace(/\[.*$/, '');
  return /_door$|trapdoor$|glowstone|sea_lantern|lantern$|torch$|_light$|light_block|shroomlight|froglight|_bed$|_sign$/.test(id) || id.startsWith(`${PACK_NAMESPACE}:`);
}

export interface ColliderGridStats {
  /** Cells turned into colliders. */
  colliders: number;
  /** Of those, cells whose collision box is not the full block (a floor plate, a ceiling slab). */
  partial: number;
  /** Visible scene blocks left as they are (doors, lights). */
  kept: number;
  /**
   * Solid voxel cells with NO visible geometry in their world block, which are
   * therefore NOT colliders (see `buildColliderGrid`). 0 when no boxes were given.
   */
  emptyVoxelsDropped: number;
  /** Blocks the visible geometry occupies that the voxel grid had left air, made colliders. */
  geometryBlocksAdded: number;
  /** Body cuboids of TILTED parts laid from their oriented box (`ColliderSourceBox.obb`, `isTiltedBox`), not their bounding box. */
  turnedBoxes: number;
  /**
   * Cells the bounding boxes of those tilted cuboids would have made colliders that no geometry
   * reaches (the invisible bands the old rule laid; 0 when there are no tilted parts).
   */
  turnedCellsSpared: number;
  /** Body cuboids turned about the VERTICAL only (a yaw off the grid axes) laid from their own box (`yawStepKept`). */
  yawBoxes: number;
  /** Runs of bounding-box-only space under those cuboids kept as colliders: a step a jump over what is drawn under it. */
  yawRunsKept: number;
  /** Runs dropped: a floor over a drop of more than a jump, or a wall's corner taller than a jump (76417's Gate 1 corner). */
  yawRunsDropped: number;
  /** Cells the bounding boxes of the yaw-turned cuboids would have made colliders that end up holding nothing. */
  yawCellsSpared: number;
}

/**
 * One body cuboid a collider grid is laid from: its LDraw AABB (source frame)
 * and, for a turned part, the oriented cuboid itself (`obb`), which is laid
 * INSTEAD of the AABB (see `buildColliderGrid`).
 */
export interface ColliderSourceBox { min: Vec3; max: Vec3; obb?: OrientedBoxLdu }

/**
 * Whether a turned cuboid is TILTED: its own up axis (LDraw -Y) leaves the
 * vertical by more than `TILT_EPS`. A tilted cuboid is laid from its oriented
 * box alone; one turned about the vertical only (a yaw) is laid from its
 * oriented box PLUS the parts of its bounding box that are a step a player
 * uses (`yawStepKept`).
 *
 * Decided by measurement over the 40 favourites (2026-09-30,
 * `output/tilted-colliders-0930/`): laying EVERY turned cuboid exactly took
 * 76435's reach from 415.9 to 303.2 square blocks at 100 % (13 of its 33
 * reached rooms lost) - the climb to its upper floor runs over parts turned
 * 45 degrees about the vertical, whose bounding boxes were the steps - and
 * left 76417's Gate 1 on the bare corner of a baseplate turned 45 degrees
 * (a 13.9-block fall the device would see). What the handrail case needs is
 * the vertical band, which only a tilt makes.
 */
export const TILT_EPS = 1e-3;
export function isTiltedBox(box: OrientedBoxLdu): boolean {
  return Math.abs(box.R[4]!) < 1 - TILT_EPS;
}

/**
 * The tallest a run of a yaw-turned cuboid's bounding-box-only space may stand
 * over what is drawn under it (or the ground) and stay a collider: a jump
 * (`JUMP_HEIGHT_BLOCKS`). Over more than that it is either a floor in open air
 * - a player walks onto it and off its edge into the drop (76417's Gate 1
 * opened onto the corner of a baseplate turned 45 degrees: invisible floor
 * over a 17-block fall, Saga round 2026-09-30i) - or a wall's corner, an
 * invisible pillar beside a doorway. Under it, it is a step the model's own
 * climbs use (76435's stair: risers of 1.19 and 1.44 blocks without the
 * corners, 0.44-0.75 with them).
 */
export const YAW_STEP_MAX_BLOCKS = JUMP_HEIGHT_BLOCKS;

/**
 * Whether a run of bounding-box-only space (blocks from the grid floor) is
 * kept: its top is at most `YAW_STEP_MAX_BLOCKS` over `support`, the highest
 * drawn surface at or under its bottom in the same column (the ground, 0,
 * when nothing is drawn there).
 */
export function yawStepKept(top: number, support: number): boolean {
  return top - support <= YAW_STEP_MAX_BLOCKS + 1e-6;
}

/**
 * An oriented LDraw cuboid in the collider grid's frame, or null when it is
 * degenerate (a zero-thickness box: the caller lays its AABB instead).
 */
export function gridParallelepiped(frame: SceneGridFrame, box: OrientedBoxLdu): Parallelepiped | null {
  const { R, t, min, max } = box;
  const world = (v: Vec3): Vec3 => [
    R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2] + t[0],
    R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2] + t[1],
    R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2] + t[2],
  ];
  const o = sceneGridPoint(frame, world(min));
  const edge = (k: 0 | 1 | 2): Vec3 => {
    const v: Vec3 = [min[0], min[1], min[2]];
    v[k] = max[k];
    const q = sceneGridPoint(frame, world(v));
    return [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
  };
  return parallelepiped(o, [edge(0), edge(1), edge(2)]);
}

/**
 * The shell's invisible walkable blocks: a collider wherever the shell's own
 * part geometry is, at the height that geometry spans in the block. `boxes`
 * are LDraw AABBs (source frame) of every body cuboid the shell was compiled
 * from (`CompiledLdrawGeometry.partBoxesLdu`) — what the player SEES.
 *
 * Occupancy comes from those boxes, not from the voxel grid, because the two
 * are half a block apart. The voxelizer centres its cells on multiples of the
 * cell size (`parityFill`: a surface on a lattice line must not collapse), so
 * voxel `i` holds the geometry of grid coordinates [i − ½, i + ½); the
 * structure lays voxel `i` at world block [i, i + 1), and the shell entity is
 * drawn at `sceneGridPoint` — the same world the doors, figures and seats use.
 * Read as colliders, the voxel grid sat half a block off the model in every
 * axis. On 76417 Gringotts (2026-09-24, measured over the shipped cells) 1,070
 * of 3,535 collider blocks held no geometry at all — 138 of them one layer
 * over the bank floor, an invisible plane a player walked on a block above
 * the floor — and 614 blocks holding geometry had no collider. The old rule
 * "a solid cell no box reaches collides fully" is what turned the half-block
 * offset into full invisible blocks.
 *
 * The voxel grid still decides two things: the blocks the scene made live
 * (doors, lights), which stay as they are, and `keepClear` — cells the door
 * pass opened (the leaf and the passage to it, `applySceneDoors`), which stay
 * air even where a wall's geometry reaches them. With no boxes at all (the
 * shell did not report them) the voxel grid is used as before.
 */
export function buildColliderGrid(grid: BlockGrid, boxes: ReadonlyArray<ColliderSourceBox>, frame: SceneGridFrame, keepClear?: ReadonlySet<number>): { grid: BlockGrid; stats: ColliderGridStats; layers: CellLayers } {
  const out = new BlockGrid(grid.width, grid.height, grid.length);
  const lo = new Float32Array(grid.width * grid.height * grid.length).fill(1);
  const hi = new Float32Array(grid.width * grid.height * grid.length).fill(0);
  const idx = (x: number, y: number, z: number): number => (x * grid.height + y) * grid.length + z;
  // The geometry each cell holds, as sixteen layer footprints (sixteenths, rounded outward): what
  // clearance (collider-clearance.ts) trims a cell's collider back to. Same membership and rounding
  // as the cell's own lo/hi below, so a cell's layers span exactly its collider's lo..hi.
  // Rounded outward past float noise only (`floor16` / `ceil16`): the cell's lo/hi are kept as
  // float32, the layers are computed in float64, and a box edge ON a sixteenth (a plate top at
  // 12/16) read 12.0000016 in one and 12 in the other - the layers then spanned [4,13] over a
  // [4,12] collider and clearance refused the cell as one the doorway cut had changed (69 cells
  // of 10261, a set with no doorway, 2026-09-29).
  const layers: CellLayers = new Map();
  /** Widen cell `i`'s vertical span to cellLo..cellHi (blocks within the cell) and return its layer record. */
  const mark = (i: number, cellLo: number, cellHi: number): Uint8Array => {
    if (cellLo < lo[i]!) lo[i] = cellLo;
    if (cellHi > hi[i]!) hi[i] = cellHi;
    let cell = layers.get(i);
    if (!cell) layers.set(i, cell = newCellLayers());
    return cell;
  };
  /** A footprint (blocks within the cell) over layers l0..l1 (sixteenths), rounded outward as the AABB path always was. */
  const footprint = (cell: Uint8Array, fx0: number, fx1: number, l0: number, l1: number, fz0: number, fz1: number): void => {
    addLayerBox(cell,
      Math.max(0, Math.min(15, floor16(fx0))), Math.max(1, Math.min(16, ceil16(fx1))),
      l0, l1,
      Math.max(0, Math.min(15, floor16(fz0))), Math.max(1, Math.min(16, ceil16(fz1))));
  };
  // What is DRAWN in each column (x, z): the vertical spans (blocks from the grid floor, flat pairs) of
  // every cuboid's own geometry there - the support a yaw-turned cuboid's bounding-box corners are
  // judged against (`yawStepKept`). Recorded at full precision, per cuboid, so a cuboid is never its
  // own support and a stack of plates reads as the plates it is.
  const drawn = new Map<number, number[]>();
  const colKey = (x: number, z: number): number => x * grid.length + z;
  const addDrawn = (x: number, z: number, y0: number, y1: number): void => {
    const k = colKey(x, z);
    let a = drawn.get(k);
    if (!a) drawn.set(k, a = []);
    a.push(y0, y1);
  };
  /**
   * A turned cuboid laid from its own box (a parallelepiped `pp` in grid units) over the cells
   * x0..x1, y0..y1, z0..z1 of its bounding box: only the cells the cuboid itself passes through,
   * each over the height it spans IN that cell, with a footprint per sixteenth layer.
   */
  const layOriented = (pp: Parallelepiped, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void => {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      // Membership: the cuboid reaches into the cell past the same margins the AABB path skips.
      if (!clipParallelepiped(pp, [x + 0.02, y + 0.001, z + 0.02], [x + 0.98, y + 0.999, z + 0.98])) continue;
      const whole = clipParallelepiped(pp, [x, y, z], [x + 1, y + 1, z + 1]);
      if (!whole) continue;
      const cellLo = whole.min[1] - y, cellHi = whole.max[1] - y;
      if (cellHi <= cellLo) continue;
      addDrawn(x, z, y + cellLo, y + cellHi);
      const cell = mark(idx(x, y, z), cellLo, cellHi);
      // One footprint per sixteenth the cuboid spans here (the same range the cell's lo/hi round to).
      const l0 = Math.max(0, Math.min(15, floor16(cellLo))), l1 = Math.max(l0 + 1, Math.min(16, ceil16(cellHi)));
      for (let l = l0; l < l1; l++) {
        // The layer's slab, narrowed to the cuboid's span in the cell, so a slab only reached by rounding still answers.
        const s0 = Math.max(y + l / 16, y + cellLo), s1 = Math.min(y + (l + 1) / 16, y + cellHi);
        const slab = s1 > s0 ? clipParallelepiped(pp, [x, s0, z], [x + 1, s1, z + 1]) : null;
        const f = slab ?? whole;
        footprint(cell, f.min[0] - x, f.max[0] - x, l, l + 1, f.min[2] - z, f.max[2] - z);
      }
    }
  };
  /** One cell's share of an axis-aligned box: its span and its footprint (blocks within the cell). */
  interface AabbPiece { x: number; y: number; z: number; cellLo: number; cellHi: number; fx0: number; fx1: number; fz0: number; fz1: number }
  const layAabbPiece = (p: AabbPiece): void => {
    const cell = mark(idx(p.x, p.y, p.z), p.cellLo, p.cellHi);
    const l = Math.max(0, Math.min(15, floor16(p.cellLo)));
    footprint(cell, p.fx0, p.fx1, l, Math.max(l + 1, Math.min(16, ceil16(p.cellHi))), p.fz0, p.fz1);
  };
  // Cells the AABB of a TURNED cuboid would have laid (the rule before 2026-09-30), to count what it spares.
  const turnedAabbCells = new Set<number>(), yawAabbCells = new Set<number>();
  // The bounding-box pieces of the yaw-turned cuboids, per column: judged once everything drawn is known.
  const yawPieces = new Map<number, AabbPiece[]>();
  let turnedBoxes = 0, yawBoxes = 0;
  for (const b of boxes) {
    // LDraw Y is down: the box's max y is its lowest point, so the grid span runs from max→min.
    const a = sceneGridPoint(frame, [b.min[0], b.max[1], b.min[2]]);
    const c = sceneGridPoint(frame, [b.max[0], b.min[1], b.max[2]]);
    const yLo = Math.min(a[1], c[1]), yHi = Math.max(a[1], c[1]);
    const bx0 = Math.min(a[0], c[0]), bx1 = Math.max(a[0], c[0]), bz0 = Math.min(a[2], c[2]), bz1 = Math.max(a[2], c[2]);
    // The cells the box covers: a cell it reaches by 0.02 or less in x/z (0.001 in y) is skipped.
    const x0 = Math.max(0, Math.floor(bx0 + 0.02)), x1 = Math.min(grid.width - 1, Math.floor(bx1 - 0.02));
    const z0 = Math.max(0, Math.floor(bz0 + 0.02)), z1 = Math.min(grid.length - 1, Math.floor(bz1 - 0.02));
    const y0 = Math.max(0, Math.floor(yLo + 0.001)), y1 = Math.min(grid.height - 1, Math.ceil(yHi - 0.001) - 1);
    const tilted = !!b.obb && isTiltedBox(b.obb);
    const pp = b.obb ? gridParallelepiped(frame, b.obb) : null;
    if (pp && tilted) {
      // A TILTED cuboid (2026-09-30): its bounding box laid a band where nothing is drawn under every
      // tilted part (10326's handrail: a child walking the corridor met air at head height). A ramp or
      // a sloped roof keeps a top in every column it crosses: the cuboid's own highest point there.
      turnedBoxes++;
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) turnedAabbCells.add(idx(x, y, z));
      layOriented(pp, x0, x1, y0, y1, z0, z1);
      continue;
    }
    const pieces: AabbPiece[] = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const cellLo = Math.max(0, yLo - y), cellHi = Math.min(1, yHi - y);
      if (cellHi <= cellLo) continue;
      pieces.push({ x, y, z, cellLo, cellHi, fx0: Math.max(bx0, x) - x, fx1: Math.min(bx1, x + 1) - x, fz0: Math.max(bz0, z) - z, fz1: Math.min(bz1, z + 1) - z });
    }
    if (pp && !isAxisAligned(pp)) {
      // A cuboid turned about the VERTICAL only, off the grid axes (2026-09-30): laid from its own box
      // like a tilted one, and its bounding box's corners - space it does not reach - are judged
      // below, column by column, as the steps they may be (`yawStepKept`).
      yawBoxes++;
      layOriented(pp, x0, x1, y0, y1, z0, z1);
      for (const p of pieces) {
        yawAabbCells.add(idx(p.x, p.y, p.z));
        const k = colKey(p.x, p.z);
        let list = yawPieces.get(k);
        if (!list) yawPieces.set(k, list = []);
        list.push(p);
      }
      continue;
    }
    // An axis-aligned cuboid (or a turned one that is its own bounding box): its box IS its geometry.
    for (const p of pieces) { addDrawn(p.x, p.z, p.y + p.cellLo, p.y + p.cellHi); layAabbPiece(p); }
  }
  // The yaw-turned cuboids' bounding boxes, column by column (2026-09-30). The bounding-box pieces in
  // a column merge into RUNS (touching spans, blocks); a run is laid as the bounding boxes laid it when
  // its top is within a jump of the highest drawn surface at or under its bottom (or the ground) -
  // a step the model's climbs use - and dropped otherwise: a floor over a drop, or a wall's corner
  // taller than a jump. A run kept becomes support for the runs over it (a stair of turned treads
  // climbs run on run). Runs are judged over WHOLE columns: what is drawn anywhere in the column's
  // block supports the corner of a cuboid over it.
  let yawRunsKept = 0, yawRunsDropped = 0;
  for (const [k, list] of yawPieces) {
    const spans = drawn.get(k) ?? [];
    const pieces = [...list].sort((p, q) => (p.y + p.cellLo) - (q.y + q.cellLo));
    const runs: Array<{ bottom: number; top: number; pieces: AabbPiece[] }> = [];
    for (const p of pieces) {
      const p0 = p.y + p.cellLo, p1 = p.y + p.cellHi, last = runs[runs.length - 1];
      if (last && p0 <= last.top + 1e-3) { last.top = Math.max(last.top, p1); last.pieces.push(p); }
      else runs.push({ bottom: p0, top: p1, pieces: [p] });
    }
    const kept: number[] = [];
    for (const run of runs) {
      // The highest drawn (or kept) surface at or under the run's bottom; the ground (0) is under every run.
      let support = 0;
      for (let i = 1; i < spans.length; i += 2) if (spans[i]! <= run.bottom + 1e-3 && spans[i]! > support) support = spans[i]!;
      for (const top of kept) if (top <= run.bottom + 1e-3 && top > support) support = top;
      if (!yawStepKept(run.top, support)) { yawRunsDropped++; continue; }
      yawRunsKept++;
      kept.push(run.top);
      for (const p of run.pieces) layAabbPiece(p);
    }
  }
  let turnedCellsSpared = 0, yawCellsSpared = 0;
  for (const i of turnedAabbCells) if (!(hi[i]! > lo[i]!)) turnedCellsSpared++;
  for (const i of yawAabbCells) if (!(hi[i]! > lo[i]!)) yawCellsSpared++;
  const stats: ColliderGridStats = { colliders: 0, partial: 0, kept: 0, emptyVoxelsDropped: 0, geometryBlocksAdded: 0, turnedBoxes, turnedCellsSpared, yawBoxes, yawRunsKept, yawRunsDropped, yawCellsSpared };
  const fromGeometry = boxes.length > 0;
  for (let x = 0; x < grid.width; x++) for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) {
    const state = grid.get(x, y, z);
    if (state !== 'minecraft:air' && isSceneBlock(state)) { out.set(x, y, z, state); stats.kept++; continue; }
    const i = idx(x, y, z);
    const seen = hi[i]! > lo[i]!;
    if (fromGeometry) {
      // Geometry decides; a cell the door pass opened stays open.
      if (!seen) { if (state !== 'minecraft:air') stats.emptyVoxelsDropped++; continue; }
      if (keepClear?.has(i)) continue;
      if (state === 'minecraft:air') stats.geometryBlocksAdded++;
    } else if (state === 'minecraft:air') continue;
    let l = 0, h = 16;
    if (seen) {
      l = Math.max(0, Math.min(15, floor16(lo[i]!)));
      h = Math.max(l + 1, Math.min(16, ceil16(hi[i]!)));
    }
    if (l !== 0 || h !== 16) stats.partial++;
    out.set(x, y, z, colliderState(l, h));
    stats.colliders++;
  }
  // Only cells that became colliders keep their geometry (a door-cleared or scene cell is not trimmed).
  for (const i of [...layers.keys()]) {
    const z = i % grid.length, y = Math.floor(i / grid.length) % grid.height, x = Math.floor(i / (grid.length * grid.height));
    if (!out.get(x, y, z).startsWith(COLLIDER_BLOCK_ID)) layers.delete(i);
  }
  return { grid: out, stats, layers };
}

/**
 * A fraction of a block in sixteenths, rounded down / up past float noise: an
 * edge within 1/1000 of a sixteenth (6e-5 block) of a sixteenth is ON it. The
 * collider grid and its layer geometry both round with these, so they agree.
 */
const NOISE16 = 1e-3;
const floor16 = (v: number): number => Math.floor(v * 16 + NOISE16);
const ceil16 = (v: number): number => Math.ceil(v * 16 - NOISE16);

/** The cell index `buildColliderGrid`'s `keepClear` uses: `(x·height + y)·length + z`. */
export const colliderCellIndex = (grid: { height: number; length: number }, x: number, y: number, z: number): number => (x * grid.height + y) * grid.length + z;

// The collider blocks' definitions live with the forms they lay (collider-form.ts), so the walk worlds and the
// simulator read the very block JSON the pack ships without importing the exporter; re-exported for the pack writer.
export { collisionBox, colliderBlockDefinition } from './collider-form.js';

/** Every collider block id the pack defines (43: the full form and the clearance forms), for fills and type checks. */
export const COLLIDER_BLOCK_IDS: readonly string[] = COLLIDER_KIT.VARIANTS.map(d => d.id);
/** The pack file name of variant `v`'s block definition. */
export const colliderBlockFile = (v: number): string => v === 0 ? 'collider.json' : `${COLLIDER_KIT.VARIANTS[v]!.id.replace(/^.*:/, '')}.json`;

/** The resource-pack `blocks.json` entry: sound and the transparent texture. */
export const COLLIDER_BLOCKS_JSON = {
  format_version: '1.21.40',
  [COLLIDER_BLOCK_ID]: { sound: 'stone', textures: 'craftmatic_collider' },
} as const;
/** Terrain texture entry for the clear tile. */
export const COLLIDER_TERRAIN_TEXTURE = { craftmatic_collider: { textures: 'textures/blocks/craftmatic_collider' } } as const;

/**
 * Bedrock stops DRAWING an actor beyond a distance that scales with its
 * collision box: measured on the Pixel 8 Pro (2026-09-21, 10303 photographed
 * in full at 60 blocks and absent at 70, 86, 100 and 168 with the old
 * 0.1 × 0.1 shell box; the 0.6 × 1.8 figures still drawn at 100 and gone by
 * 168), the fit is `64 × max(1, |box diagonal|)` blocks. It is not the
 * geometry's `visible_bounds` (frustum culling; the shell declared 177 × 189)
 * and not the LOD hull (same actor, same cull). So the shell's box is sized
 * for the cull distance the model deserves: `SHELL_CULL_PER_MODEL_BLOCK`
 * times its largest dimension, never under the 64-block floor.
 *
 * The box is a NEEDLE: `SHELL_BOX_WIDTH` wide and as tall as the diagonal
 * needs. Width barely moves the diagonal, and a thin box intercepts no taps.
 * It stands above the model: the shell's origin is lifted a block over its
 * roof (`originAboveModel`, every cube's top is below the origin) and a
 * collision box extends UP from the origin, so the needle is in the sky over
 * the model's centre column and touches nothing the player stands on
 * (asserted in test/bedrock-building-shell.test.ts). The wand's size groups
 * scale it with the model (`withSizeGroups`), so the cull distance scales
 * too: a 400 % placement is drawn four times as far, a 25 % one keeps the floor.
 *
 * MEASURED, round 2026-09-26a: at 100 % the needle buys NO draw distance. On
 * both phones (Pixel 26.51, Saga 26.52; render distance 192, simulation 8
 * chunks) the 76417 shell (needle 2.115, 135 blocks by the fit), a door
 * (0.25 x 2.5), a figure and vanilla mobs all stopped drawing together at
 * 71-73 blocks. `actorCullDistance` is therefore capped at the measured
 * `ACTOR_DRAW_CEILING_BLOCKS` (bedrock-lod-hull.ts), which the LOD plan uses.
 * The needle is KEPT: it costs nothing (no taps, over the roof), and whether a
 * box scaled past 100 % by the size groups lifts the ceiling is unmeasured.
 *
 * TODO(cull): measure a 200 % and a 400 % placement's shell on a phone (the
 * needle's box scaled 2x/4x): if it is also gone at ~72, drop the needle for
 * a plain small box and `SHELL_CULL_PER_MODEL_BLOCK` with it.
 *
 * `playable-addon.ts` passes the compiled `sizeBlocks`; the fallback extent
 * (10303's height) is for a caller that has none.
 */
export const ACTOR_CULL_FLOOR_BLOCKS = 64;
export const SHELL_CULL_PER_MODEL_BLOCK = 4;
export const SHELL_BOX_WIDTH = 0.1;
export const SHELL_FALLBACK_EXTENT_BLOCKS = 44;

/**
 * The distance at which Bedrock stops drawing an actor with this collision box
 * at wand factor `f`: the fit above, never past the ceiling measured on
 * 26.51/26.52 (`ACTOR_DRAW_CEILING_BLOCKS`; above 100 % the ceiling is assumed,
 * see TODO(cull)).
 */
export function actorCullDistance(box: { width: number; height: number }, f = 1): number {
  return Math.min(ACTOR_DRAW_CEILING_BLOCKS, actorCullFit(box, f));
}
/** The box fit alone (no ceiling): what the needle is sized for. */
export function actorCullFit(box: { width: number; height: number }, f = 1): number {
  return ACTOR_CULL_FLOOR_BLOCKS * Math.max(1, f * Math.hypot(box.width, box.width, box.height));
}

/** The shell's collision box for a model of this extent (blocks at 100 %): a needle tall enough for its cull distance. */
export function shellCollisionBox(extent?: { width: number; height: number; length: number }): { width: number; height: number } {
  const largest = extent ? Math.max(extent.width, extent.height, extent.length) : SHELL_FALLBACK_EXTENT_BLOCKS;
  const wanted = Math.max(ACTOR_CULL_FLOOR_BLOCKS, SHELL_CULL_PER_MODEL_BLOCK * largest);
  const diagonal = wanted / ACTOR_CULL_FLOOR_BLOCKS;
  const height = Math.max(SHELL_BOX_WIDTH, Math.sqrt(Math.max(0, diagonal * diagonal - 2 * SHELL_BOX_WIDTH * SHELL_BOX_WIDTH)));
  return { width: SHELL_BOX_WIDTH, height: Math.ceil(height * 1000) / 1000 };
}

/** The static shell entity: no gravity, no collision, cannot be selected, hurt or pushed; its collision box only sets how far it is drawn. */
export function shellBehavior(id: string, extentBlocks?: { width: number; height: number; length: number }): unknown {
  const box = shellCollisionBox(extentBlocks);
  return withSizeGroups({
    format_version: '1.26.30',
    'minecraft:entity': {
      description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: false, is_summonable: true },
      components: {
        'minecraft:type_family': { family: ['craftmatic_shell'] },
        'minecraft:nameable': {}, 'minecraft:persistent': {},
        'minecraft:health': { value: 100, max: 100 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': box,
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:pushable_by_block': {},
        'minecraft:knockback_resistance': { value: 1 },
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 120, max_dropped_ticks: 20, use_motion_prediction_hints: false } },
      },
    },
  }, box);
}
