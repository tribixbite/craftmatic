/**
 * Semantic voxel classification — assigns a structural role (wall, roof, window,
 * ground, vegetation, etc.) to each voxel in a BlockGrid.
 *
 * Used by the tiles→schematic pipeline to separate building elements from terrain,
 * enabling per-class block substitution and priority-aware writing that prevents
 * ground blocks from overwriting building structure.
 *
 * Index order matches BlockGrid: YZX — (y * length + z) * width + x
 */

import { BlockGrid } from '../schem/types.js';

// ─── Voxel Class Enum ────────────────────────────────────────────────────────

/** Semantic role assigned to each voxel in the classified grid */
export enum VoxelClass {
  AIR = 0,

  // Building elements (1-9)
  BUILDING_WALL = 1,
  BUILDING_ROOF = 2,
  BUILDING_WINDOW = 3,
  BUILDING_DOOR = 4,
  BUILDING_TRIM = 5,

  // Ground surfaces (10-19)
  GROUND_TERRAIN = 10,
  GROUND_ROAD = 11,
  GROUND_SIDEWALK = 12,
  GROUND_PATH = 13,
  GROUND_GRASS = 14,

  // Vegetation (20-29)
  VEGETATION_TREE = 20,
  VEGETATION_BUSH = 21,

  // Other (30+)
  WATER = 30,
  FENCE = 40,
  VEHICLE = 50,
  UNKNOWN = 99,
}

// ─── Write Priority ──────────────────────────────────────────────────────────
// Higher priority classes overwrite lower when two sources contest the same voxel.
// Building structure always wins over terrain and vegetation.

/** Priority for write conflicts — higher value wins */
export const VOXEL_PRIORITY: Record<VoxelClass, number> = {
  [VoxelClass.AIR]: 0,
  [VoxelClass.UNKNOWN]: 5,
  [VoxelClass.GROUND_GRASS]: 10,
  [VoxelClass.GROUND_TERRAIN]: 15,
  [VoxelClass.GROUND_PATH]: 20,
  [VoxelClass.GROUND_SIDEWALK]: 25,
  [VoxelClass.GROUND_ROAD]: 30,
  [VoxelClass.VEGETATION_TREE]: 35,
  [VoxelClass.VEGETATION_BUSH]: 35,
  [VoxelClass.VEHICLE]: 45,
  [VoxelClass.FENCE]: 50,
  [VoxelClass.WATER]: 55,
  [VoxelClass.BUILDING_TRIM]: 80,
  [VoxelClass.BUILDING_WINDOW]: 85,
  [VoxelClass.BUILDING_DOOR]: 85,
  [VoxelClass.BUILDING_ROOF]: 90,
  [VoxelClass.BUILDING_WALL]: 100,
};

// ─── Classified Grid ─────────────────────────────────────────────────────────

/** Result of classifying a BlockGrid — parallel class array + derived bounds */
export interface ClassifiedGrid {
  /** Source block grid (unmodified) */
  blocks: BlockGrid;
  /** Per-voxel class label, same index layout as BlockGrid (YZX order) */
  classes: Uint8Array;
  /** Detected ground plane Y level */
  groundY: number;
  /** Axis-aligned bounding box of all BUILDING_* classified voxels */
  buildingBounds: {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
  };
  /** Y level at or above which wall voxels become roof candidates */
  roofCutoffY: number;
}

// ─── Block Name Classification Sets ──────────────────────────────────────────
// Block name substring/prefix checks for fast classification without regex.

/** Grass/dirt ground blocks */
const GRASS_BLOCKS = new Set([
  'minecraft:grass_block', 'minecraft:dirt', 'minecraft:podzol',
  'minecraft:coarse_dirt', 'minecraft:rooted_dirt', 'minecraft:mycelium',
  'minecraft:moss_block', 'minecraft:dirt_path',
]);

/** Hard surface ground blocks (roads, foundations) */
const ROAD_BLOCKS = new Set([
  'minecraft:stone', 'minecraft:gray_concrete', 'minecraft:black_concrete',
  'minecraft:andesite', 'minecraft:polished_andesite', 'minecraft:smooth_stone',
  'minecraft:deepslate', 'minecraft:basalt',
]);

/** Paved walkway / sidewalk blocks */
const SIDEWALK_BLOCKS = new Set([
  'minecraft:cobblestone', 'minecraft:stone_bricks', 'minecraft:polished_diorite',
  'minecraft:smooth_stone_slab', 'minecraft:stone_brick_slab',
  'minecraft:cobblestone_slab',
]);

/** Loose path / trail blocks */
const PATH_BLOCKS = new Set([
  'minecraft:gravel', 'minecraft:sand', 'minecraft:red_sand',
  'minecraft:coarse_dirt',
]);

/** Glass variants → windows */
const GLASS_BLOCKS = new Set([
  'minecraft:glass', 'minecraft:glass_pane',
  'minecraft:gray_stained_glass', 'minecraft:gray_stained_glass_pane',
  'minecraft:light_gray_stained_glass', 'minecraft:light_gray_stained_glass_pane',
  'minecraft:white_stained_glass', 'minecraft:white_stained_glass_pane',
  'minecraft:blue_stained_glass', 'minecraft:blue_stained_glass_pane',
  'minecraft:light_blue_stained_glass', 'minecraft:light_blue_stained_glass_pane',
  'minecraft:cyan_stained_glass', 'minecraft:cyan_stained_glass_pane',
  'minecraft:brown_stained_glass', 'minecraft:brown_stained_glass_pane',
  'minecraft:black_stained_glass', 'minecraft:black_stained_glass_pane',
  'minecraft:tinted_glass',
]);

/** Vegetation leaf/foliage blocks */
const LEAF_BLOCKS = new Set([
  'minecraft:oak_leaves', 'minecraft:spruce_leaves', 'minecraft:birch_leaves',
  'minecraft:jungle_leaves', 'minecraft:acacia_leaves', 'minecraft:dark_oak_leaves',
  'minecraft:azalea_leaves', 'minecraft:flowering_azalea_leaves',
  'minecraft:cherry_leaves', 'minecraft:mangrove_leaves',
  'minecraft:moss_carpet',
]);

/** Bush-like vegetation blocks */
const BUSH_BLOCKS = new Set([
  'minecraft:green_wool', 'minecraft:green_concrete',
  'minecraft:lime_wool', 'minecraft:lime_concrete',
  'minecraft:azalea', 'minecraft:flowering_azalea',
  'minecraft:fern', 'minecraft:large_fern',
]);

/** Water blocks */
const WATER_BLOCKS = new Set([
  'minecraft:water', 'minecraft:ice', 'minecraft:packed_ice',
  'minecraft:blue_ice', 'minecraft:frosted_ice',
]);

/** Door blocks — partial name match covers all wood variants + iron */
const DOOR_SUFFIX = '_door';

/** Fence blocks — partial name match covers all wood/nether variants */
const FENCE_SUFFIX = '_fence';

/** Log blocks used as tree trunks (not stripped — those are building material) */
const LOG_BLOCKS = new Set([
  'minecraft:oak_log', 'minecraft:spruce_log', 'minecraft:birch_log',
  'minecraft:jungle_log', 'minecraft:acacia_log', 'minecraft:dark_oak_log',
  'minecraft:cherry_log', 'minecraft:mangrove_log',
]);

// ─── Index Helper ────────────────────────────────────────────────────────────

/** Convert (x, y, z) to flat index in YZX order — matches BlockGrid layout */
function idx(x: number, y: number, z: number, width: number, length: number): number {
  return (y * length + z) * width + x;
}

// ─── Strip Block Properties ──────────────────────────────────────────────────

/** Extract base block name without properties, e.g. "minecraft:oak_door[facing=north]" → "minecraft:oak_door" */
function baseName(blockState: string): string {
  const bracket = blockState.indexOf('[');
  return bracket === -1 ? blockState : blockState.substring(0, bracket);
}

// ─── Ground Classification ───────────────────────────────────────────────────

/** Classify a block name as a ground-level surface type, or null if not ground */
function classifyGround(block: string): VoxelClass | null {
  const base = baseName(block);
  if (GRASS_BLOCKS.has(base)) return VoxelClass.GROUND_GRASS;
  if (ROAD_BLOCKS.has(base)) return VoxelClass.GROUND_ROAD;
  if (SIDEWALK_BLOCKS.has(base)) return VoxelClass.GROUND_SIDEWALK;
  if (PATH_BLOCKS.has(base)) return VoxelClass.GROUND_PATH;
  return null;
}

/** Classify a block name by its material regardless of position */
function classifyByName(block: string): VoxelClass | null {
  const base = baseName(block);

  // Glass → window
  if (GLASS_BLOCKS.has(base) || base.includes('stained_glass')) return VoxelClass.BUILDING_WINDOW;

  // Doors
  if (base.endsWith(DOOR_SUFFIX)) return VoxelClass.BUILDING_DOOR;

  // Leaves / foliage → tree vegetation
  if (LEAF_BLOCKS.has(base) || base.includes('leaves')) return VoxelClass.VEGETATION_TREE;

  // Bush-like vegetation
  if (BUSH_BLOCKS.has(base)) return VoxelClass.VEGETATION_BUSH;

  // Water
  if (WATER_BLOCKS.has(base)) return VoxelClass.WATER;

  // Fences
  if (base.endsWith(FENCE_SUFFIX) || base.endsWith('_fence_gate')) return VoxelClass.FENCE;

  // Bare logs that are part of tree trunks (only when surrounded by leaves — handled spatially)
  // Standalone log detection deferred to spatial pass

  return null;
}

// ─── Main Classification ─────────────────────────────────────────────────────

/**
 * Classify every voxel in a BlockGrid with a semantic role.
 *
 * Classification proceeds in phases:
 * 1. Material-based: block name determines ground, glass, vegetation, water, fence
 * 2. Building envelope: 3D flood fill from tallest column marks connected structure
 * 3. Roof detection: top voxels within 3 blocks of building max Y → roof
 * 4. Remaining non-air voxels below ground threshold → terrain/unknown
 *
 * @param grid    Source BlockGrid to classify
 * @param groundY Override ground plane Y level (auto-detected if omitted)
 * @returns ClassifiedGrid with parallel class array and derived metadata
 */
export function classifyGrid(grid: BlockGrid, groundY?: number): ClassifiedGrid {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;
  const total = width * height * length;
  const classes = new Uint8Array(total); // initialized to VoxelClass.AIR (0)

  // ── Phase 0: Detect ground plane if not provided ──
  // Median of lowest non-air Y per column (same approach as analyzeGrid)
  if (groundY == null) {
    const lowestY: number[] = [];
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
          if (grid.get(x, y, z) !== AIR) {
            lowestY.push(y);
            break;
          }
        }
      }
    }
    if (lowestY.length > 0) {
      lowestY.sort((a, b) => a - b);
      groundY = lowestY[Math.floor(lowestY.length / 2)];
    } else {
      groundY = 0;
    }
  }

  // Ground plane threshold — blocks at or below this Y are classified as ground
  const groundThreshold = groundY + 1;

  // ── Phase 1: Material-based classification ──
  // Classify blocks that have unambiguous names (glass, leaves, water, doors, etc.)
  // Ground blocks only apply at low Y levels.
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;

        const i = idx(x, y, z, width, length);

        // Check ground-level surfaces first (only at low Y)
        if (y <= groundThreshold) {
          const groundClass = classifyGround(block);
          if (groundClass !== null) {
            classes[i] = groundClass;
            continue;
          }
        }

        // Check material-based classification (position-independent)
        const nameClass = classifyByName(block);
        if (nameClass !== null) {
          classes[i] = nameClass;
          continue;
        }

        // Mark as UNKNOWN for now — spatial passes will refine
        classes[i] = VoxelClass.UNKNOWN;
      }
    }
  }

  // ── Phase 2: Building envelope via 3D flood fill ──
  // Find the tallest non-air column and flood fill outward from it.
  // All connected non-air voxels above ground threshold become BUILDING_WALL.
  let tallestX = 0, tallestZ = 0, maxBuildingY = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y > groundThreshold; y--) {
        if (grid.get(x, y, z) !== AIR) {
          if (y > maxBuildingY) {
            maxBuildingY = y;
            tallestX = x;
            tallestZ = z;
          }
          break;
        }
      }
    }
  }

  // BFS flood fill from tallest column — marks connected structure as BUILDING_WALL
  if (maxBuildingY > groundThreshold) {
    const visited = new Uint8Array(total);
    const stack: number[] = [];

    // 6-connected neighbor offsets
    const offsets: readonly [number, number, number][] = [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1],
    ];

    // Seed from every non-air block in the tallest column above ground
    for (let y = groundThreshold + 1; y < height; y++) {
      if (grid.get(tallestX, y, tallestZ) !== AIR) {
        const i = idx(tallestX, y, tallestZ, width, length);
        if (!visited[i]) {
          visited[i] = 1;
          stack.push(i);
        }
      }
    }

    while (stack.length > 0) {
      const ci = stack.pop()!;
      const cx = ci % width;
      const cz = Math.floor(ci / width) % length;
      const cy = Math.floor(ci / (width * length));

      // Only classify UNKNOWN voxels as building wall — preserve specific classes
      // (glass→window, door, vegetation, etc.) that were set in Phase 1
      if (classes[ci] === VoxelClass.UNKNOWN) {
        classes[ci] = VoxelClass.BUILDING_WALL;
      }

      for (const [dx, dy, dz] of offsets) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
        // Only flood into blocks above ground threshold
        if (ny <= groundThreshold) continue;
        const ni = idx(nx, ny, nz, width, length);
        if (visited[ni]) continue;
        if (grid.get(nx, ny, nz) === AIR) continue;
        visited[ni] = 1;
        stack.push(ni);
      }
    }
  }

  // ── Phase 3: Roof detection ──
  // For each XZ column, if the topmost building voxel is within 3 blocks of the
  // overall max building Y, reclassify it (and blocks immediately below that are
  // also building) as BUILDING_ROOF.
  const ROOF_PROXIMITY = 3;
  const roofCutoffY = Math.max(0, maxBuildingY - ROOF_PROXIMITY);

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      // Find topmost building voxel in this column
      for (let y = height - 1; y > groundThreshold; y--) {
        const i = idx(x, y, z, width, length);
        if (classes[i] === VoxelClass.BUILDING_WALL) {
          // Reclassify as roof if near the top of the building
          if (y >= roofCutoffY) {
            classes[i] = VoxelClass.BUILDING_ROOF;
          }
          break; // only the topmost wall block per column
        }
      }
    }
  }

  // ── Phase 4: Tree trunk classification ──
  // Bare logs adjacent to leaf blocks are tree trunks, not building material.
  // This prevents stripped logs (building material) from being misclassified.
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = baseName(grid.get(x, y, z));
        if (!LOG_BLOCKS.has(block)) continue;

        // Check if any neighbor is a leaf block → this log is a tree trunk
        let adjacentLeaf = false;
        for (let dy = -1; dy <= 1 && !adjacentLeaf; dy++) {
          for (let dz = -1; dz <= 1 && !adjacentLeaf; dz++) {
            for (let dx = -1; dx <= 1 && !adjacentLeaf; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const nx = x + dx, ny = y + dy, nz = z + dz;
              if (!grid.inBounds(nx, ny, nz)) continue;
              const nb = baseName(grid.get(nx, ny, nz));
              if (LEAF_BLOCKS.has(nb) || nb.includes('leaves')) {
                adjacentLeaf = true;
              }
            }
          }
        }

        if (adjacentLeaf) {
          const i = idx(x, y, z, width, length);
          classes[i] = VoxelClass.VEGETATION_TREE;
        }
      }
    }
  }

  // ── Phase 5: Remaining UNKNOWN below ground threshold → GROUND_TERRAIN ──
  for (let y = 0; y <= groundThreshold && y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, z, width, length);
        if (classes[i] === VoxelClass.UNKNOWN) {
          classes[i] = VoxelClass.GROUND_TERRAIN;
        }
      }
    }
  }

  // ── Compute building bounding box ──
  let bMinX = width, bMinY = height, bMinZ = length;
  let bMaxX = -1, bMaxY = -1, bMaxZ = -1;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const c = classes[idx(x, y, z, width, length)];
        if (c >= VoxelClass.BUILDING_WALL && c <= VoxelClass.BUILDING_TRIM) {
          if (x < bMinX) bMinX = x;
          if (y < bMinY) bMinY = y;
          if (z < bMinZ) bMinZ = z;
          if (x > bMaxX) bMaxX = x;
          if (y > bMaxY) bMaxY = y;
          if (z > bMaxZ) bMaxZ = z;
        }
      }
    }
  }

  // Clamp to valid range if no building blocks found
  if (bMaxX < 0) {
    bMinX = bMinY = bMinZ = 0;
    bMaxX = bMaxY = bMaxZ = 0;
  }

  return {
    blocks: grid,
    classes,
    groundY,
    buildingBounds: {
      minX: bMinX, minY: bMinY, minZ: bMinZ,
      maxX: bMaxX, maxY: bMaxY, maxZ: bMaxZ,
    },
    roofCutoffY,
  };
}

// ─── Priority-Aware Write Helpers ────────────────────────────────────────────

/**
 * Check whether a new voxel class can overwrite the existing class at a given index.
 * Returns true if the new class has strictly higher priority than the existing one.
 *
 * @param classes  The classification array
 * @param index    Flat voxel index (YZX order)
 * @param newClass The class that wants to write
 */
export function canWrite(classes: Uint8Array, index: number, newClass: VoxelClass): boolean {
  const existing = classes[index] as VoxelClass;
  return VOXEL_PRIORITY[newClass] > VOXEL_PRIORITY[existing];
}

/**
 * Write a block to the grid only if the new voxel class has higher priority than
 * the existing class at that position. Updates both the BlockGrid and the
 * classification array atomically.
 *
 * @param grid       Target BlockGrid
 * @param classes    Parallel classification array
 * @param x          X coordinate
 * @param y          Y coordinate
 * @param z          Z coordinate
 * @param block      Minecraft block state to write
 * @param voxelClass Semantic class for the new block
 * @returns true if the write succeeded, false if priority was insufficient
 */
export function writeWithPriority(
  grid: BlockGrid,
  classes: Uint8Array,
  x: number,
  y: number,
  z: number,
  block: string,
  voxelClass: VoxelClass,
): boolean {
  const { width, length } = grid;
  if (!grid.inBounds(x, y, z)) return false;

  const i = idx(x, y, z, width, length);
  if (!canWrite(classes, i, voxelClass)) return false;

  grid.set(x, y, z, block);
  classes[i] = voxelClass;
  return true;
}
