/**
 * Per-class block mapping — resolves a Minecraft block name for each VoxelClass
 * based on environmental context (climate, ground cover, urbanization).
 *
 * This module provides the default block assignments that the voxel classifier
 * uses when writing terrain, vegetation, and other non-building elements.
 * Building blocks (wall, roof, window) are typically resolved by the color
 * pipeline (color-blocks.ts) rather than these defaults.
 */

import type { BlockState } from '../types/index.js';
import { BlockGrid } from '../schem/types.js';
import { VoxelClass } from './voxel-classifier.js';

// ─── Block Context ───────────────────────────────────────────────────────────

/** Environmental context that influences block selection */
export interface BlockContext {
  /** Ground cover biome — drives terrain block choices */
  groundCover: 'grass' | 'forest' | 'desert' | 'urban';
  /** USDA hardiness zone string, e.g. "7b" — used for vegetation tuning */
  climateZone?: string;
}

/** Default context when none is provided */
const DEFAULT_CONTEXT: BlockContext = {
  groundCover: 'grass',
};

// ─── Ground Block Maps ───────────────────────────────────────────────────────
// Keyed by groundCover type, returns the appropriate block for each ground class.

const GRASS_BY_COVER: Record<BlockContext['groundCover'], BlockState> = {
  grass: 'minecraft:grass_block',
  forest: 'minecraft:podzol',
  desert: 'minecraft:sand',
  urban: 'minecraft:grass_block',
};

const ROAD_BY_COVER: Record<BlockContext['groundCover'], BlockState> = {
  grass: 'minecraft:gray_concrete',
  forest: 'minecraft:gray_concrete',
  desert: 'minecraft:smooth_sandstone',
  urban: 'minecraft:gray_concrete',
};

const SIDEWALK_BY_COVER: Record<BlockContext['groundCover'], BlockState> = {
  grass: 'minecraft:smooth_stone_slab[type=double]',
  forest: 'minecraft:cobblestone',
  desert: 'minecraft:smooth_sandstone_slab[type=double]',
  urban: 'minecraft:smooth_stone_slab[type=double]',
};

const PATH_BY_COVER: Record<BlockContext['groundCover'], BlockState> = {
  grass: 'minecraft:gravel',
  forest: 'minecraft:coarse_dirt',
  desert: 'minecraft:red_sand',
  urban: 'minecraft:stone_bricks',
};

const TERRAIN_BY_COVER: Record<BlockContext['groundCover'], BlockState> = {
  grass: 'minecraft:dirt',
  forest: 'minecraft:dirt',
  desert: 'minecraft:sandstone',
  urban: 'minecraft:dirt',
};

// ─── Vegetation Blocks ───────────────────────────────────────────────────────

const TREE_BY_COVER: Record<BlockContext['groundCover'], BlockState> = {
  grass: 'minecraft:oak_leaves',
  forest: 'minecraft:spruce_leaves',
  desert: 'minecraft:acacia_leaves',
  urban: 'minecraft:birch_leaves',
};

const BUSH_BY_COVER: Record<BlockContext['groundCover'], BlockState> = {
  grass: 'minecraft:azalea_leaves',
  forest: 'minecraft:moss_block',
  desert: 'minecraft:dead_bush',  // arid shrub
  urban: 'minecraft:azalea_leaves',
};

// ─── Fence Blocks ────────────────────────────────────────────────────────────

const FENCE_BY_COVER: Record<BlockContext['groundCover'], BlockState> = {
  grass: 'minecraft:oak_fence',
  forest: 'minecraft:spruce_fence',
  desert: 'minecraft:acacia_fence',
  urban: 'minecraft:stone_brick_wall',
};

// ─── Resolve Function ────────────────────────────────────────────────────────

/**
 * Resolve a Minecraft block name for a given voxel class and environmental context.
 *
 * Building element classes (WALL, ROOF, WINDOW, DOOR, TRIM) return generic
 * placeholder blocks — the color pipeline typically overrides these with
 * perceptually-matched blocks from the photogrammetry texture.
 *
 * Terrain and vegetation classes return context-sensitive blocks based on the
 * groundCover biome.
 *
 * @param voxelClass  The semantic class to resolve a block for
 * @param context     Environmental context (defaults to grass biome)
 * @returns A fully-qualified Minecraft block state string
 */
export function resolveBlock(voxelClass: VoxelClass, context?: BlockContext): BlockState {
  const ctx = context ?? DEFAULT_CONTEXT;

  switch (voxelClass) {
    // ── Ground surfaces ──
    case VoxelClass.GROUND_GRASS:
      return GRASS_BY_COVER[ctx.groundCover];
    case VoxelClass.GROUND_ROAD:
      return ROAD_BY_COVER[ctx.groundCover];
    case VoxelClass.GROUND_SIDEWALK:
      return SIDEWALK_BY_COVER[ctx.groundCover];
    case VoxelClass.GROUND_PATH:
      return PATH_BY_COVER[ctx.groundCover];
    case VoxelClass.GROUND_TERRAIN:
      return TERRAIN_BY_COVER[ctx.groundCover];

    // ── Vegetation ──
    case VoxelClass.VEGETATION_TREE:
      return TREE_BY_COVER[ctx.groundCover];
    case VoxelClass.VEGETATION_BUSH:
      return BUSH_BY_COVER[ctx.groundCover];

    // ── Water ──
    case VoxelClass.WATER:
      return 'minecraft:water';

    // ── Fence ──
    case VoxelClass.FENCE:
      return FENCE_BY_COVER[ctx.groundCover];

    // ── Vehicle (placeholder — car body approximation) ──
    case VoxelClass.VEHICLE:
      return 'minecraft:light_gray_concrete';

    // ── Building elements (generic defaults — color pipeline overrides these) ──
    case VoxelClass.BUILDING_WALL:
      return 'minecraft:stone_bricks';
    case VoxelClass.BUILDING_ROOF:
      return 'minecraft:deepslate_tile_stairs[facing=north]';
    case VoxelClass.BUILDING_WINDOW:
      return 'minecraft:gray_stained_glass';
    case VoxelClass.BUILDING_DOOR:
      return 'minecraft:oak_door[facing=south,half=lower]';
    case VoxelClass.BUILDING_TRIM:
      return 'minecraft:quartz_pillar';

    // ── Air / Unknown ──
    case VoxelClass.AIR:
      return 'minecraft:air';
    case VoxelClass.UNKNOWN:
      return 'minecraft:stone';

    default:
      return 'minecraft:stone';
  }
}

/**
 * Resolve all non-air voxels in a classification array to their default blocks,
 * writing into the provided BlockGrid. Respects write priority — existing
 * higher-priority blocks are not overwritten.
 *
 * Useful for filling in terrain/vegetation defaults after the color pipeline
 * has written building blocks with higher priority.
 *
 * @param grid    Target BlockGrid to write into
 * @param classes Parallel classification array from classifyGrid()
 * @param context Environmental context for block selection
 * @returns Number of blocks written
 */
export function applyClassDefaults(
  grid: BlockGrid,
  classes: Uint8Array,
  context?: BlockContext,
): number {
  const { width, height, length } = grid;
  let written = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = (y * length + z) * width + x;
        const cls = classes[i] as VoxelClass;
        if (cls === VoxelClass.AIR) continue;

        const block = resolveBlock(cls, context);
        if (block !== 'minecraft:air') {
          grid.set(x, y, z, block);
          written++;
        }
      }
    }
  }

  return written;
}
