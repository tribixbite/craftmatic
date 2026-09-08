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
  'minecraft:stone_bricks': { slab: 'minecraft:stone_brick_slab', stairs: 'minecraft:stone_brick_stairs' },
  'minecraft:mossy_stone_bricks': { slab: 'minecraft:mossy_stone_brick_slab', stairs: 'minecraft:mossy_stone_brick_stairs' },
  'minecraft:andesite': { slab: 'minecraft:andesite_slab', stairs: 'minecraft:andesite_stairs' },
  'minecraft:polished_andesite': { slab: 'minecraft:polished_andesite_slab', stairs: 'minecraft:polished_andesite_stairs' },
  'minecraft:diorite': { slab: 'minecraft:diorite_slab', stairs: 'minecraft:diorite_stairs' },
  'minecraft:polished_diorite': { slab: 'minecraft:polished_diorite_slab', stairs: 'minecraft:polished_diorite_stairs' },
  'minecraft:granite': { slab: 'minecraft:granite_slab', stairs: 'minecraft:granite_stairs' },
  'minecraft:polished_granite': { slab: 'minecraft:polished_granite_slab', stairs: 'minecraft:polished_granite_stairs' },
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
  'minecraft:nether_bricks': { slab: 'minecraft:nether_brick_slab', stairs: 'minecraft:nether_brick_stairs' },
  'minecraft:red_nether_bricks': { slab: 'minecraft:red_nether_brick_slab', stairs: 'minecraft:red_nether_brick_stairs' },
  'minecraft:prismarine': { slab: 'minecraft:prismarine_slab', stairs: 'minecraft:prismarine_stairs' },
  'minecraft:prismarine_bricks': { slab: 'minecraft:prismarine_brick_slab', stairs: 'minecraft:prismarine_brick_stairs' },
  'minecraft:dark_prismarine': { slab: 'minecraft:dark_prismarine_slab', stairs: 'minecraft:dark_prismarine_stairs' },
  'minecraft:quartz_block': { slab: 'minecraft:quartz_slab', stairs: 'minecraft:quartz_stairs' },
  'minecraft:smooth_quartz': { slab: 'minecraft:smooth_quartz_slab', stairs: 'minecraft:smooth_quartz_stairs' },
  'minecraft:purpur_block': { slab: 'minecraft:purpur_slab', stairs: 'minecraft:purpur_stairs' },
  'minecraft:end_stone_bricks': { slab: 'minecraft:end_stone_brick_slab', stairs: 'minecraft:end_stone_brick_stairs' },
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
}

/** Allocate hints for a grid, marked empty. */
export function createShapeHints(width: number, height: number, length: number): ShapeHints {
  const n = width * height * length;
  const lo = new Uint8Array(n).fill(Q);
  const hi = new Uint8Array(n);
  return { width, height, length, lo, hi };
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
 * Refine solid cells into slabs where the geometry is genuinely half-height.
 *
 * Additive-safe by construction: it only ever replaces one solid palette entry
 * with another solid palette entry. No cell becomes air, no cell is created, no
 * footprint moves.
 */
export function applyBlockShapes(grid: BlockGrid, hints: ShapeHints): ShapeStats {
  const stats: ShapeStats = {
    candidates: 0, slabs: 0, noVariant: 0, blockedByNeighbour: 0, noVariantByBlock: {},
  };
  const { width, height, length } = grid;
  if (hints.width !== width || hints.height !== height || hints.length !== length) return stats;

  // Palette index → the slab ids for that block, resolved once per entry.
  const slabIndex = new Map<number, { top: number; bottom: number } | null>();
  const resolve = (idx: number): { top: number; bottom: number } | null => {
    const cached = slabIndex.get(idx);
    if (cached !== undefined) return cached;
    const block = grid.blockStateFromIndex(idx);
    const top = slabIdFor(block, 'top'), bottom = slabIdFor(block, 'bottom');
    const entry = top && bottom
      ? { top: grid.paletteIndexOf(top), bottom: grid.paletteIndexOf(bottom) }
      : null;
    slabIndex.set(idx, entry);
    return entry;
  };

  const airIdx = grid.paletteIndexOf(AIR);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = grid.getIndex(x, y, z);
        if (idx === airIdx) continue;
        const i = (y * length + z) * width + x;
        const shape = classifyOccupancy(hints.lo[i]!, hints.hi[i]!);
        if (shape === 'full') continue;
        stats.candidates++;
        // Only give up a half that is air anyway — see the safety rule above.
        const neighbourAir = shape === 'slab-bottom'
          ? (y + 1 >= height || grid.getIndex(x, y + 1, z) === airIdx)
          : (y === 0 || grid.getIndex(x, y - 1, z) === airIdx);
        if (!neighbourAir) { stats.blockedByNeighbour++; continue; }
        const variants = resolve(idx);
        if (!variants) {
          stats.noVariant++;
          const block = grid.blockStateFromIndex(idx);
          stats.noVariantByBlock[block] = (stats.noVariantByBlock[block] ?? 0) + 1;
          continue;
        }
        grid.setIndex(x, y, z, shape === 'slab-bottom' ? variants.bottom : variants.top);
        stats.slabs++;
      }
    }
  }
  return stats;
}
