/**
 * Block shapes — turning a solid export cell into the partial Minecraft block
 * its geometry actually is (docs/schem-shapes-proposal.md passes B and C).
 *
 * THE DESIGN CONSTRAINT, inherited from the two rejected voxelization rewrites
 * (CLAUDE.md 2026-09-08): centred-cell OVER-coverage is the fidelity. Both
 * "more accurate" rewrites removed cells and made the output worse — thin
 * features vanished and surfaces speckled. So this pass never removes a cell and
 * never changes a footprint. It only asks a cell that is ALREADY solid whether
 * it should be a slab or a stair instead of a cube. A one-cell-thick feature
 * keeps its cell either way, so the "feature disappears" failure mode is
 * structurally impossible here.
 *
 * SAFETY RULE beyond the proposal's thresholds: a half-height shape is only
 * emitted when the half being given up is AIR ANYWAY — a bottom slab needs air
 * above it, a top slab needs air below. That keeps every interior seam (a brick
 * stacked on a brick shares its boundary cell, and the two parts' occupancy
 * unions to "full") a full cube, so refinement happens only on surfaces that
 * really do end mid-cell.
 *
 * AVAILABILITY, measured and unavoidable: vanilla Minecraft has NO slab and NO
 * stair for any dyed family — no concrete, wool, terracotta or stained-glass
 * slab exists. The shipped colour tables emit ~97% concrete, so today only the
 * sandstone-mapped LEGO tans can actually take a shape. Everything else keeps
 * its full cube (never a colour substitution — a quartz slab on a white concrete
 * wall is a visible material seam). The mechanism is complete and the table
 * below covers every slab/stair-capable material in the registry, so the
 * proposal's Pass D (a palette that uses stone/wood families) unlocks the rest
 * without touching this file.
 */

import type { BlockGrid } from '@craft/schem/types.js';

/** Which partial shapes vanilla provides for a full block we can emit. */
export interface ShapeVariants {
  /** `<id>[type=top|bottom]` */
  slab?: string;
  /** `<id>[facing=…,half=…,shape=straight]` */
  stairs?: string;
}

/**
 * Full block id → its in-family partial ids.
 *
 * Every entry is a material that appears in `mc-block-registry.json`'s `blocks`
 * list, and every value is a real vanilla 1.20 id. Asymmetries are real, not
 * omissions: `smooth_stone` has a slab but no stairs; `cut_sandstone` and
 * `cut_red_sandstone` likewise.
 */
export const SHAPE_VARIANTS: Readonly<Record<string, ShapeVariants>> = {
  'minecraft:stone': { slab: 'minecraft:stone_slab', stairs: 'minecraft:stone_stairs' },
  'minecraft:smooth_stone': { slab: 'minecraft:smooth_stone_slab' },
  'minecraft:cobblestone': { slab: 'minecraft:cobblestone_slab', stairs: 'minecraft:cobblestone_stairs' },
  'minecraft:mossy_cobblestone': { slab: 'minecraft:mossy_cobblestone_slab', stairs: 'minecraft:mossy_cobblestone_stairs' },
  'minecraft:stone_bricks': { slab: 'minecraft:stone_brick_slab', stairs: 'minecraft:stone_brick_stairs' },
  'minecraft:mossy_stone_bricks': { slab: 'minecraft:mossy_stone_brick_slab', stairs: 'minecraft:mossy_stone_brick_stairs' },
  'minecraft:andesite': { slab: 'minecraft:andesite_slab', stairs: 'minecraft:andesite_stairs' },
  'minecraft:polished_andesite': { slab: 'minecraft:polished_andesite_slab', stairs: 'minecraft:polished_andesite_stairs' },
  'minecraft:diorite': { slab: 'minecraft:diorite_slab', stairs: 'minecraft:diorite_stairs' },
  'minecraft:polished_diorite': { slab: 'minecraft:polished_diorite_slab', stairs: 'minecraft:polished_diorite_stairs' },
  'minecraft:granite': { slab: 'minecraft:granite_slab', stairs: 'minecraft:granite_stairs' },
  'minecraft:polished_granite': { slab: 'minecraft:polished_granite_slab', stairs: 'minecraft:polished_granite_stairs' },
  'minecraft:cobbled_deepslate': { slab: 'minecraft:cobbled_deepslate_slab', stairs: 'minecraft:cobbled_deepslate_stairs' },
  'minecraft:polished_deepslate': { slab: 'minecraft:polished_deepslate_slab', stairs: 'minecraft:polished_deepslate_stairs' },
  'minecraft:deepslate_bricks': { slab: 'minecraft:deepslate_brick_slab', stairs: 'minecraft:deepslate_brick_stairs' },
  'minecraft:deepslate_tiles': { slab: 'minecraft:deepslate_tile_slab', stairs: 'minecraft:deepslate_tile_stairs' },
  'minecraft:blackstone': { slab: 'minecraft:blackstone_slab', stairs: 'minecraft:blackstone_stairs' },
  'minecraft:polished_blackstone': { slab: 'minecraft:polished_blackstone_slab', stairs: 'minecraft:polished_blackstone_stairs' },
  'minecraft:polished_blackstone_bricks': { slab: 'minecraft:polished_blackstone_brick_slab', stairs: 'minecraft:polished_blackstone_brick_stairs' },
  'minecraft:sandstone': { slab: 'minecraft:sandstone_slab', stairs: 'minecraft:sandstone_stairs' },
  'minecraft:smooth_sandstone': { slab: 'minecraft:smooth_sandstone_slab', stairs: 'minecraft:smooth_sandstone_stairs' },
  'minecraft:cut_sandstone': { slab: 'minecraft:cut_sandstone_slab' },
  'minecraft:red_sandstone': { slab: 'minecraft:red_sandstone_slab', stairs: 'minecraft:red_sandstone_stairs' },
  'minecraft:smooth_red_sandstone': { slab: 'minecraft:smooth_red_sandstone_slab', stairs: 'minecraft:smooth_red_sandstone_stairs' },
  'minecraft:cut_red_sandstone': { slab: 'minecraft:cut_red_sandstone_slab' },
  'minecraft:bricks': { slab: 'minecraft:brick_slab', stairs: 'minecraft:brick_stairs' },
  'minecraft:mud_bricks': { slab: 'minecraft:mud_brick_slab', stairs: 'minecraft:mud_brick_stairs' },
  'minecraft:nether_bricks': { slab: 'minecraft:nether_brick_slab', stairs: 'minecraft:nether_brick_stairs' },
  'minecraft:red_nether_bricks': { slab: 'minecraft:red_nether_brick_slab', stairs: 'minecraft:red_nether_brick_stairs' },
  'minecraft:prismarine': { slab: 'minecraft:prismarine_slab', stairs: 'minecraft:prismarine_stairs' },
  'minecraft:prismarine_bricks': { slab: 'minecraft:prismarine_brick_slab', stairs: 'minecraft:prismarine_brick_stairs' },
  'minecraft:dark_prismarine': { slab: 'minecraft:dark_prismarine_slab', stairs: 'minecraft:dark_prismarine_stairs' },
  'minecraft:quartz_block': { slab: 'minecraft:quartz_slab', stairs: 'minecraft:quartz_stairs' },
  'minecraft:smooth_quartz': { slab: 'minecraft:smooth_quartz_slab', stairs: 'minecraft:smooth_quartz_stairs' },
  'minecraft:purpur_block': { slab: 'minecraft:purpur_slab', stairs: 'minecraft:purpur_stairs' },
  'minecraft:end_stone_bricks': { slab: 'minecraft:end_stone_brick_slab', stairs: 'minecraft:end_stone_brick_stairs' },
  // Waxed copper only — unwaxed cut copper oxidizes in-world, so a model built
  // in it would drift off the LEGO hue the palette matched it to.
  'minecraft:waxed_cut_copper': { slab: 'minecraft:waxed_cut_copper_slab', stairs: 'minecraft:waxed_cut_copper_stairs' },
  'minecraft:waxed_exposed_cut_copper': { slab: 'minecraft:waxed_exposed_cut_copper_slab', stairs: 'minecraft:waxed_exposed_cut_copper_stairs' },
  'minecraft:waxed_weathered_cut_copper': { slab: 'minecraft:waxed_weathered_cut_copper_slab', stairs: 'minecraft:waxed_weathered_cut_copper_stairs' },
  'minecraft:waxed_oxidized_cut_copper': { slab: 'minecraft:waxed_oxidized_cut_copper_slab', stairs: 'minecraft:waxed_oxidized_cut_copper_stairs' },
  'minecraft:oak_planks': { slab: 'minecraft:oak_slab', stairs: 'minecraft:oak_stairs' },
  'minecraft:spruce_planks': { slab: 'minecraft:spruce_slab', stairs: 'minecraft:spruce_stairs' },
  'minecraft:birch_planks': { slab: 'minecraft:birch_slab', stairs: 'minecraft:birch_stairs' },
  'minecraft:jungle_planks': { slab: 'minecraft:jungle_slab', stairs: 'minecraft:jungle_stairs' },
  'minecraft:acacia_planks': { slab: 'minecraft:acacia_slab', stairs: 'minecraft:acacia_stairs' },
  'minecraft:dark_oak_planks': { slab: 'minecraft:dark_oak_slab', stairs: 'minecraft:dark_oak_stairs' },
  'minecraft:mangrove_planks': { slab: 'minecraft:mangrove_slab', stairs: 'minecraft:mangrove_stairs' },
  'minecraft:cherry_planks': { slab: 'minecraft:cherry_slab', stairs: 'minecraft:cherry_stairs' },
  'minecraft:bamboo_planks': { slab: 'minecraft:bamboo_slab', stairs: 'minecraft:bamboo_stairs' },
  'minecraft:crimson_planks': { slab: 'minecraft:crimson_slab', stairs: 'minecraft:crimson_stairs' },
  'minecraft:warped_planks': { slab: 'minecraft:warped_slab', stairs: 'minecraft:warped_stairs' },
};

export type SlabHalf = 'top' | 'bottom';
export type StairFacing = 'north' | 'south' | 'east' | 'west';

/** `minecraft:sandstone_slab[type=bottom]`, or null when the family has none. */
export function slabIdFor(block: string, half: SlabHalf): string | null {
  const slab = SHAPE_VARIANTS[block]?.slab;
  return slab ? `${slab}[type=${half}]` : null;
}

/**
 * `minecraft:sandstone_stairs[facing=north,half=bottom,shape=straight]`, or null.
 * Properties are written in alphabetical order because the litematic reader
 * re-sorts them — writing them any other way breaks id equality on re-import.
 */
export function stairsIdFor(block: string, facing: StairFacing, half: SlabHalf): string | null {
  const stairs = SHAPE_VARIANTS[block]?.stairs;
  return stairs ? `${stairs}[facing=${facing},half=${half},shape=straight]` : null;
}

// ─── Per-cell vertical occupancy ─────────────────────────────────────────────

/** Quantization of the [cell bottom, cell top] fraction into a byte. */
const Q = 255;

/**
 * Per-cell vertical occupancy of the emitted grid, produced by the voxelizer.
 *
 * `lo`/`hi` are the quantized hull of the world-Y interval every contributing
 * part occupies inside that cell, 0 = the cell's bottom face, 255 = its top.
 * The hull (not the exact union) is deliberate: it can only ever bias a cell
 * toward "full", which is the safe direction.
 *
 * Cells with no contribution — the ones `bridgePartContacts` and
 * `fillSingleVoxelGaps` add — keep the empty sentinel (lo > hi) and are treated
 * as fully occupied, i.e. left as cubes.
 */
export interface ShapeHints {
  width: number; height: number; length: number;
  lo: Uint8Array;
  hi: Uint8Array;
  /**
   * Per-cell stair request from the slope pass: 0 = none, 1-8 = a `StairCode`,
   * 255 = two different slopes claimed the cell (ambiguous → left alone).
   * Absent when the slope pass is off.
   */
  stair?: Uint8Array;
  /**
   * Per-cell semantic-element request (engine/part-elements.ts): 0 = none,
   * 1-4 = an `ElementKind`, 255 = two different mapped parts claimed the cell.
   * `applyPartElements` runs first and zeroes every cell it declines, so a
   * non-zero entry afterwards means an element WAS placed and the slab/stair
   * pass must leave that cell alone.
   */
  element?: Uint8Array;
}

/** Allocate hints for a grid, marked empty. */
export function createShapeHints(
  width: number, height: number, length: number, withStairs = false, withElements = false,
): ShapeHints {
  const n = width * height * length;
  const lo = new Uint8Array(n).fill(Q);
  const hi = new Uint8Array(n);
  return {
    width, height, length, lo, hi,
    ...(withStairs ? { stair: new Uint8Array(n) } : {}),
    ...(withElements ? { element: new Uint8Array(n) } : {}),
  };
}

/** Record a part's element request for one cell, resolving collisions to "none". */
export function addElementRequest(h: ShapeHints, x: number, y: number, z: number, kind: number): void {
  if (!h.element) return;
  const i = (y * h.length + z) * h.width + x;
  const prev = h.element[i]!;
  if (prev === 0) h.element[i] = kind;
  else if (prev !== kind) h.element[i] = 255;
}

// ─── Slope parts → stairs (pass B) ───────────────────────────────────────────

export const STAIR_FACINGS: readonly StairFacing[] = ['north', 'south', 'east', 'west'];
/** Two different slopes wanted this cell — neither wins. */
const STAIR_CONFLICT = 255;

/** Pack a facing + half into the 1..8 range stored per cell. */
export function stairCode(facing: StairFacing, half: SlabHalf): number {
  return STAIR_FACINGS.indexOf(facing) + 1 + (half === 'top' ? 4 : 0);
}

/** Unpack a stored stair code; null for 0 and for the conflict marker. */
export function decodeStairCode(code: number): { facing: StairFacing; half: SlabHalf } | null {
  if (code < 1 || code > 8) return null;
  const i = (code - 1) % 4;
  return { facing: STAIR_FACINGS[i]!, half: code > 4 ? 'top' : 'bottom' };
}

/** Record a part's stair request for one cell, resolving collisions to "none". */
export function addStairRequest(h: ShapeHints, x: number, y: number, z: number, code: number): void {
  if (!h.stair) return;
  const i = (y * h.length + z) * h.width + x;
  const prev = h.stair[i]!;
  if (prev === 0) h.stair[i] = code;
  else if (prev !== code) h.stair[i] = STAIR_CONFLICT;
}

/**
 * Is this part a single-wedge LEGO slope, judged by the LDraw library's OWN
 * description line (the first line of the `.dat`, which the export already has
 * in hand)?
 *
 * Deliberately NOT a hand-written part-id list, which is what the proposal
 * suggested: the library has 350 parts whose description starts "Slope Brick",
 * ids are re-tooled (`3040`→`3040b`, `3665`→`3665a` are `~Moved to` stubs), and
 * a list would be stale the day after it was written. The description is
 * authoritative data that ships with the geometry.
 *
 * Excluded, per the proposal and for good reason:
 *   • Double / Convex / Concave / Curved — more than one slope face, so a single
 *     stair is the wrong shape;
 *   • angles outside 32-60° — this keeps the 33° and 45° families and drops the
 *     cheese slopes (LDraw calls them "Slope Brick 18" and "Slope Brick 31",
 *     checked: 54200 is 31°) and the steep 55/65/75° ones, none of which read
 *     like a stair's 45° step;
 *   • anything with a Cutout / Open Centre, whose footprint is not a wedge.
 * Orientation is never taken from the description — only membership. Which way
 * the part slopes comes from its real triangles (`analyzeSlope`).
 */
export function isSlopeDescription(header: string): boolean {
  const m = /^0\s+[~=]*Slope Brick\s+(\d+)(?:\/(\d+))?\s/i.exec(header);
  if (!m) return false;
  const angle = Number(m[1]);
  if (m[2]) return false;                    // "33/45" = two different faces
  if (angle < 32 || angle > 60) return false;
  return !/double|convex|concave|curved|cutout|cut out|open centre|open center/i.test(header);
}

/** A slope's downhill direction in PART-LOCAL XZ, plus which face is cut. */
export interface SlopeAnalysis {
  /** Unit-ish local direction pointing at the FULL-HEIGHT side of the wedge. */
  ux: number; uz: number;
  /** True when the wedge is cut out of the UNDERSIDE (LEGO inverted slopes). */
  inverted: boolean;
}

/** Minimum half-to-half height difference (LDU) that counts as a real wedge. */
const SLOPE_MIN_FALL = 4;

/**
 * Derive a slope's orientation from its own triangles.
 *
 * Samples the part's highest surface on a coarse XZ lattice: a normal LEGO
 * slope's TOP falls away across the part, an inverted slope's top is flat and
 * its UNDERSIDE is what rises. The reported direction points at the
 * full-height side, which is exactly what a Minecraft stair's `facing` means
 * (verified by rendering, not from memory — see applyBlockShapes).
 *
 * The top gradient is the primary signal because the underside estimate is
 * polluted: LEGO parts are hollow and studded, so a lattice cell that lands
 * inside a stud's top disc sees ONLY vertices at y = −4 and reports the part's
 * lowest surface as its highest point. Measured on 3040b (Slope Brick 45 2×1),
 * that made a normal slope read as inverted. Cross-check that the fix is right:
 * 3040b / 3039 / 3037 are the same wedge in three widths and now all report the
 * same direction, as do 4286 / 3298 in the 33° family.
 *
 * Returns null when no single axis dominates — the honest answer for corner
 * slopes, double wedges and anything the description filter let through.
 */
export function analyzeSlope(
  tris: ReadonlyArray<readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]]>,
): SlopeAnalysis | null {
  if (tris.length < 4) return null;
  const N = 8;
  let xn = Infinity, xx = -Infinity, zn = Infinity, zx = -Infinity;
  let yn = Infinity, yx = -Infinity;
  for (const t of tris) for (const v of t) {
    if (v[0] < xn) xn = v[0]; if (v[0] > xx) xx = v[0];
    if (v[1] < yn) yn = v[1]; if (v[1] > yx) yx = v[1];
    if (v[2] < zn) zn = v[2]; if (v[2] > zx) zx = v[2];
  }
  const w = xx - xn, d = zx - zn;
  if (!(w > 1e-6) || !(d > 1e-6) || !(yx - yn > 1e-6)) return null;

  // LDraw Y points DOWN: the highest material has the SMALLEST y.
  const hiY = new Float64Array(N * N).fill(Infinity);   // per cell, smallest y
  const loY = new Float64Array(N * N).fill(-Infinity);  // per cell, largest y
  const seen = new Uint8Array(N * N);
  for (const t of tris) for (const v of t) {
    const cx = Math.min(N - 1, Math.max(0, Math.floor(((v[0] - xn) / w) * N)));
    const cz = Math.min(N - 1, Math.max(0, Math.floor(((v[2] - zn) / d) * N)));
    const i = cz * N + cx;
    if (v[1] < hiY[i]!) hiY[i] = v[1];
    if (v[1] > loY[i]!) loY[i] = v[1];
    seen[i] = 1;
  }

  /** Mean of `field` on each side of the part's midline, per axis. */
  const gradient = (field: Float64Array, mask: Uint8Array): { gx: number; gz: number } => {
    let xLoSum = 0, xLoN = 0, xHiSum = 0, xHiN = 0;
    let zLoSum = 0, zLoN = 0, zHiSum = 0, zHiN = 0;
    for (let cz = 0; cz < N; cz++) for (let cx = 0; cx < N; cx++) {
      const i = cz * N + cx;
      if (!mask[i]) continue;
      const v = field[i]!;
      if (cx < N / 2) { xLoSum += v; xLoN++; } else { xHiSum += v; xHiN++; }
      if (cz < N / 2) { zLoSum += v; zLoN++; } else { zHiSum += v; zHiN++; }
    }
    if (!xLoN || !xHiN || !zLoN || !zHiN) return { gx: 0, gz: 0 };
    return { gx: xHiSum / xHiN - xLoSum / xLoN, gz: zHiSum / zHiN - zLoSum / zLoN };
  };

  const top = gradient(hiY, seen);
  let inverted = false;
  let gx: number, gz: number;
  if (Math.max(Math.abs(top.gx), Math.abs(top.gz)) >= SLOPE_MIN_FALL) {
    // Normal slope: full height where the top surface is HIGHEST (smallest y).
    gx = -top.gx; gz = -top.gz;
  } else {
    // Flat top → look underneath, ignoring cells that only saw a stud's top
    // disc. Those report the part's HIGHEST surface as their lowest point, so
    // anything whose lowest point is still in the top quarter of the part is
    // not telling us about the underside. (A real inverted slope keeps a wall
    // thickness at its thin end, so it survives this cut; a stud disc does not.)
    const cut = yn + 0.25 * (yx - yn);
    const solid = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) if (seen[i] && loY[i]! > cut) solid[i] = 1;
    const bottom = gradient(loY, solid);
    if (Math.max(Math.abs(bottom.gx), Math.abs(bottom.gz)) < SLOPE_MIN_FALL) return null;
    // Inverted slope: full height where the underside reaches LOWEST (largest y).
    inverted = true;
    gx = bottom.gx; gz = bottom.gz;
  }

  const ax = Math.abs(gx), az = Math.abs(gz);
  // One axis must clearly dominate, or this is a corner/double slope.
  if (Math.min(ax, az) > 0.4 * Math.max(ax, az)) return null;
  return ax >= az
    ? { ux: Math.sign(gx), uz: 0, inverted }
    : { ux: 0, uz: Math.sign(gz), inverted };
}

/**
 * Turn a part-local slope analysis into the per-cell stair code for one placed
 * brick, or 0 when the placement is not axis-aligned enough to be honest about.
 *
 * `rot` is the brick's row-major 3×3 world rotation. The part must stand
 * upright (its local Y still maps to world Y) — a slope tipped onto its side is
 * a wall wedge, not a stair — and a brick placed upside-down flips the wedge to
 * the underside, i.e. `half=top`.
 */
export function stairCodeForPlacement(slope: SlopeAnalysis, rot: readonly number[]): number {
  const upright = rot[4] ?? 1;
  if (Math.abs(upright) < 0.95) return 0;
  const wx = (rot[0] ?? 1) * slope.ux + (rot[2] ?? 0) * slope.uz;
  const wz = (rot[6] ?? 0) * slope.ux + (rot[8] ?? 1) * slope.uz;
  const ax = Math.abs(wx), az = Math.abs(wz);
  if (Math.max(ax, az) < 0.9) return 0;                // rotated off-axis
  // Grid X is world X (east +x) and grid Z is world Z (south +z).
  const facing: StairFacing = ax >= az ? (wx > 0 ? 'east' : 'west') : (wz > 0 ? 'south' : 'north');
  const flipped = upright < 0;                          // brick placed upside-down
  return stairCode(facing, slope.inverted !== flipped ? 'top' : 'bottom');
}

/** Union one part's occupancy interval into a cell (values are 0..1 fractions). */
export function addOccupancy(h: ShapeHints, x: number, y: number, z: number, uLo: number, uHi: number): void {
  const i = (y * h.length + z) * h.width + x;
  const qLo = uLo <= 0 ? 0 : uLo >= 1 ? Q : Math.round(uLo * Q);
  const qHi = uHi <= 0 ? 0 : uHi >= 1 ? Q : Math.round(uHi * Q);
  if (qLo < h.lo[i]!) h.lo[i] = qLo;
  if (qHi > h.hi[i]!) h.hi[i] = qHi;
}

// ─── Classification ──────────────────────────────────────────────────────────

/** At or above this fraction of the cell's height, a cube is the closer shape. */
const FULL_ENOUGH = 0.75;
/** A half holding at most this much of its own volume counts as empty. */
const HALF_EMPTY = 0.2;

export type CellShape = 'full' | 'slab-bottom' | 'slab-top';

/**
 * Which shape a cell's occupancy hull asks for, ignoring neighbours and block
 * availability. Exported for the unit tests.
 *
 * CORRECTED FROM THE PROPOSAL (measured 2026-09-08). The proposal's rule was
 * "bottom half ≥0.6 full and top ≤0.2 → bottom slab". That assumes a plate sits
 * flush inside one cell, which the CENTRED lattice makes the exception rather
 * than the rule: a plate stacked on a brick at 1 block/stud puts most of itself
 * into the brick's own boundary cell (where the two parts' occupancy unions to
 * "full", correctly) and only ~10% of its height into the cell above. Under
 * ≥0.6 that cell stayed a full cube — the single commonest plate arrangement in
 * LEGO, missed. Measured on 21063: 1,813 → 2,775 candidate cells at cellLDU 20
 * (1 block/stud) and 87,160 → 87,800 at cellLDU 4.
 *
 * The rule here is nearest-shape instead of threshold-on-one-half: a cube
 * represents 1.0 of the cell and a slab 0.5, so anything under 0.75 of the
 * cell's height is closer to a slab — provided the mass is on ONE side of the
 * midline, which is what makes a slab representable at all. An interval that
 * straddles the middle stays a cube (the over-coverage rule: ambiguous keeps
 * the conservative shape).
 */
export function classifyOccupancy(qLo: number, qHi: number): CellShape {
  if (qLo > qHi) return 'full';                  // no contribution recorded
  const lo = qLo / Q, hi = qHi / Q;
  if (hi - lo >= FULL_ENOUGH) return 'full';
  const bottom = Math.max(0, Math.min(hi, 0.5) - Math.min(lo, 0.5)) / 0.5;
  const top = Math.max(0, Math.max(hi, 0.5) - Math.max(lo, 0.5)) / 0.5;
  if (top <= HALF_EMPTY && bottom > 0) return 'slab-bottom';
  if (bottom <= HALF_EMPTY && top > 0) return 'slab-top';
  return 'full';
}

export interface ShapeStats {
  /** Cells whose occupancy asked for a partial shape. */
  candidates: number;
  /** Of those, the ones actually rewritten (family has the shape). */
  slabs: number;
  /** Cells rewritten to stairs by the slope pass. */
  stairs: number;
  /** Cells a slope claimed (before the neighbour and availability checks). */
  stairCandidates: number;
  /** Slope cells whose family has no stair id; they fall through to the slab pass. */
  stairNoVariant: number;
  /** Candidates refused because the family has no slab (concrete, glass, …). */
  noVariant: number;
  /** Candidates refused because the half they'd give up is not air. */
  blockedByNeighbour: number;
  /**
   * `noVariant` broken down by block id. This is the measured value of the
   * proposal's Pass D: every count here is a cell that WOULD take a slab if the
   * colour profile mapped that LEGO colour to a slab-capable material.
   */
  noVariantByBlock: Record<string, number>;
}

const AIR = 'minecraft:air';

/**
 * Refine solid cells into slabs and stairs where the geometry is genuinely
 * partial.
 *
 * Additive-safe by construction: it only ever replaces one solid palette entry
 * with another solid palette entry. No cell becomes air, no cell is created, no
 * footprint moves.
 *
 * MINECRAFT'S `facing` MEANS THE FULL-HEIGHT SIDE — verified by rendering, not
 * from memory or from this repo's generator (whose gable code reads
 * inconsistently). A `sandstone_stairs[facing=north]` placed directly south of a
 * full sandstone block renders FLUSH with it, with the step descending south:
 * output/schem-backlog/schemat-io-stair-flush.png. So a LEGO slope's stair
 * faces UPHILL, which is what `analyzeSlope` reports.
 *
 * A stair wins over a slab on the same cell: it is the better fit for a wedge
 * and it keeps MORE material (3/4 of the cell against a slab's 1/2), so it is
 * the more conservative of the two refinements.
 */
export function applyBlockShapes(grid: BlockGrid, hints: ShapeHints): ShapeStats {
  const stats: ShapeStats = {
    candidates: 0, slabs: 0, stairs: 0, stairCandidates: 0, stairNoVariant: 0,
    noVariant: 0, blockedByNeighbour: 0, noVariantByBlock: {},
  };
  const { width, height, length } = grid;
  if (hints.width !== width || hints.height !== height || hints.length !== length) return stats;

  // Palette index → the shape ids for that block. Resolved once per entry, and
  // LAZILY: `paletteIndexOf` interns, so eagerly resolving all eight stair
  // orientations would put unused entries in every export's palette (and widen
  // the litematic's bits-per-entry for nothing).
  interface Variants { slab: { top: number; bottom: number } | null; hasStairs: boolean }
  const variantCache = new Map<number, Variants>();
  const stairCache = new Map<number, number>();          // (idx << 4) | code → palette idx
  const variantsOf = (idx: number): Variants => {
    let v = variantCache.get(idx);
    if (v) return v;
    const block = grid.blockStateFromIndex(idx);
    const top = slabIdFor(block, 'top'), bottom = slabIdFor(block, 'bottom');
    v = {
      slab: top && bottom
        ? { top: grid.paletteIndexOf(top), bottom: grid.paletteIndexOf(bottom) }
        : null,
      hasStairs: stairsIdFor(block, 'north', 'bottom') !== null,
    };
    variantCache.set(idx, v);
    return v;
  };
  const stairIndexOf = (idx: number, code: number): number | null => {
    if (!variantsOf(idx).hasStairs) return null;
    const key = (idx << 4) | code;
    let p = stairCache.get(key);
    if (p === undefined) {
      const spec = decodeStairCode(code)!;
      p = grid.paletteIndexOf(stairsIdFor(grid.blockStateFromIndex(idx), spec.facing, spec.half)!);
      stairCache.set(key, p);
    }
    return p;
  };

  const airIdx = grid.paletteIndexOf(AIR);
  const isAir = (x: number, y: number, z: number): boolean =>
    y < 0 || y >= height || grid.getIndex(x, y, z) === airIdx;

  const stair = hints.stair;
  const element = hints.element;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = grid.getIndex(x, y, z);
        if (idx === airIdx) continue;
        const i = (y * length + z) * width + x;
        // A cell the element pass already turned into a pane/fence/bar/ladder
        // is finished — a slab of it would be neither. (That pass zeroes every
        // cell it DECLINED, so those still fall through to the rules below.)
        if (element && element[i] !== 0) continue;

        // ── Slope pass: the owning part told us this cell is a wedge ────────
        // A cell this pass cannot take (family has no stairs, or the open side
        // is blocked) FALLS THROUGH to the occupancy pass rather than being
        // consumed — a slope's leading cell is often a legitimate slab.
        const spec = stair ? decodeStairCode(stair[i]!) : null;
        if (spec) {
          stats.stairCandidates++;
          // The quarter a stair gives up is in the half AWAY from `facing`, on
          // the side the slope descends — only safe when that side is open.
          if (isAir(x, spec.half === 'bottom' ? y + 1 : y - 1, z)) {
            const stairIdx = stairIndexOf(idx, stair![i]!);
            if (stairIdx !== null) {
              grid.setIndex(x, y, z, stairIdx);
              stats.stairs++;
              continue;
            }
            stats.stairNoVariant++;
          }
        }

        // ── Occupancy pass: is this cell genuinely half-height? ─────────────
        const shape = classifyOccupancy(hints.lo[i]!, hints.hi[i]!);
        if (shape === 'full') continue;
        stats.candidates++;
        // Only give up a half that is air anyway — see the safety rule above.
        if (!isAir(x, shape === 'slab-bottom' ? y + 1 : y - 1, z)) {
          stats.blockedByNeighbour++;
          continue;
        }
        const variants = variantsOf(idx);
        if (!variants.slab) {
          stats.noVariant++;
          const block = grid.blockStateFromIndex(idx);
          stats.noVariantByBlock[block] = (stats.noVariantByBlock[block] ?? 0) + 1;
          continue;
        }
        grid.setIndex(x, y, z, shape === 'slab-bottom' ? variants.slab.bottom : variants.slab.top);
        stats.slabs++;
      }
    }
  }
  return stats;
}
