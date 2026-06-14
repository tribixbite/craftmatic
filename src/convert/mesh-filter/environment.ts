/**
 * Environment extraction & replacement — detects trees, roads, and vehicles
 * in photogrammetry voxel grids and replaces them with clean Minecraft features.
 *
 * Extracted from mesh-filter.ts to reduce file size and improve modularity.
 */

import type { BlockGrid } from '../../schem/types.js';
import { placeTree, placeVehicle } from '../../gen/structures.js';
import type { TreeType } from '../../gen/structures.js';
import { VEGETATION_BLOCKS } from '../voxelizer.js';
import { AIR } from './_internal.js';

// ─── Minimal type for AnalysisResult fields used by placeEntryPath ──────────
// Full AnalysisResult lives in mesh-filter.ts; a Pick avoids circular imports
// when the parent file later re-exports from this module.

/** Subset of AnalysisResult consumed by placeEntryPath */
export interface EntryPathAnalysis {
  entryPosition: { x: number; z: number } | null;
  entryPath: Array<{ x: number; z: number }>;
  groundContactY: number;
}

// ─── Entry Path ─────────────────────────────────────────────────────────────

/**
 * Lay a simple slab path from the grid edge to the building entrance.
 *
 * @param grid       Target BlockGrid (modified in place)
 * @param analysis   Analysis result with entry path data
 * @param pathBlock  Block to use for the path (default: stone_brick_slab)
 * @returns Number of path blocks placed
 */
export function placeEntryPath(
  grid: BlockGrid,
  analysis: EntryPathAnalysis,
  pathBlock = 'minecraft:smooth_stone_slab',
): number {

  if (!analysis.entryPosition || analysis.entryPath.length === 0) return 0;

  const y = analysis.groundContactY;
  let placed = 0;

  for (const { x, z } of analysis.entryPath) {
    if (!grid.inBounds(x, y, z)) continue;
    // Only place in air columns
    if (grid.get(x, y, z) === AIR) {
      grid.set(x, y, z, pathBlock);
      placed++;
    }
  }

  return placed;
}

// ─── Vegetation strip ───────────────────────────────────────────────────────

/**
 * Vegetation blocks to strip during post-processing.
 * Single source of truth is VEGETATION_BLOCKS in voxelizer.ts — this alias
 * maintains backward compatibility for existing import sites.
 */
export const VEGETATION_BLOCKS_POST = VEGETATION_BLOCKS;

/**
 * Strip vegetation blocks from a grid, replacing them with air.
 *
 * Designed to run AFTER fillInteriorGaps so that trees placed during voxelization
 * act as solid walls during the flood-fill, preventing holes behind tree canopy.
 * Once fill completes, the building interior is solid, and stripping vegetation
 * reveals the filled wall behind rather than leaving air gaps.
 *
 * @param grid  Mutable BlockGrid
 * @returns Number of vegetation blocks removed
 */
export function stripVegetation(grid: BlockGrid): number {

  const { width, height, length } = grid;
  let removed = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (VEGETATION_BLOCKS_POST.has(block)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

// ─── Environment Extraction ─────────────────────────────────────────────────

/** A detected tree cluster from photogrammetry voxels */
export interface DetectedTree {
  /** Center X in grid coordinates */
  x: number;
  /** Center Z in grid coordinates */
  z: number;
  /** Height in blocks (from base to canopy top) */
  height: number;
  /** Canopy XZ spread radius in blocks */
  canopyRadius: number;
}

/** A detected road region from photogrammetry ground blocks */
export interface DetectedRoad {
  /** Set of "x,z" keys for road cells */
  cells: Set<string>;
  /** Most common block type in the road region */
  surfaceBlock: string;
}

/** A detected vehicle cluster (conservative — better to miss than false-positive) */
export interface DetectedVehicle {
  /** Center X in grid coordinates */
  x: number;
  /** Center Z in grid coordinates */
  z: number;
  /** Width in blocks (smaller XZ dimension) */
  width: number;
  /** Length in blocks (larger XZ dimension) */
  length: number;
  /** Primary color block */
  colorBlock: string;
}

/** Extracted environment data from photogrammetry BEFORE vegetation strip */
export interface ExtractedEnvironment {
  /** Tree cluster positions and sizes */
  trees: DetectedTree[];
  /** Road/paved surface regions */
  roads: DetectedRoad;
  /** Vehicle clusters (conservative detection) */
  vehicles: DetectedVehicle[];
  /** Block type at each ground-level XZ cell ("x,z" → block) */
  groundMaterials: Map<string, string>;
}

/** Road-like blocks: gray/dark non-vegetation at ground level */
export const ROAD_BLOCKS = new Set([
  'minecraft:gray_concrete', 'minecraft:light_gray_concrete',
  'minecraft:stone', 'minecraft:andesite', 'minecraft:polished_andesite',
  'minecraft:smooth_stone', 'minecraft:stone_bricks',
  'minecraft:gray_terracotta', 'minecraft:light_gray_terracotta',
  'minecraft:gray_wool', 'minecraft:light_gray_wool',
  'minecraft:cobblestone', 'minecraft:gravel',
]);

/** Vehicle-like blocks: distinctive solid colors at low height */
export const VEHICLE_BLOCKS = new Set([
  'minecraft:blue_concrete', 'minecraft:red_concrete', 'minecraft:white_concrete',
  'minecraft:black_concrete', 'minecraft:yellow_concrete', 'minecraft:silver_glazed_terracotta',
  'minecraft:light_gray_concrete', 'minecraft:cyan_concrete',
  'minecraft:blue_terracotta', 'minecraft:red_terracotta', 'minecraft:white_terracotta',
]);

/**
 * Extract environment feature positions from a voxelized grid BEFORE vegetation
 * stripping. Detects trees (connected vegetation components), road surfaces,
 * and vehicle clusters to preserve their positions for later clean replacement.
 *
 * Must be called AFTER voxelization but BEFORE stripVegetation().
 *
 * @param grid     The voxelized BlockGrid (still has vegetation)
 * @param groundY  Ground plane Y level (0 for bottom-trimmed grids)
 * @returns Extracted environment data with tree/road/vehicle positions
 */
export function extractEnvironmentPositions(
  grid: BlockGrid,
  groundY: number,
): ExtractedEnvironment {
  const { width, height, length } = grid;


  // ─── Trees: connected components of vegetation blocks ─────────
  // BFS flood-fill on VEGETATION_BLOCKS_POST, skip small clusters (< 3 blocks)
  const visited = new Uint8Array(width * height * length);
  const trees: DetectedTree[] = [];

  const idx = (x: number, y: number, z: number) => (y * length + z) * width + x;

  for (let y = groundY + 2; y < height; y++) { // Trees start above ground+1
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (!VEGETATION_BLOCKS_POST.has(block) || visited[idx(x, y, z)]) continue;

        // BFS flood-fill this vegetation component
        const queue: [number, number, number][] = [[x, y, z]];
        const component: [number, number, number][] = [];
        visited[idx(x, y, z)] = 1;

        while (queue.length > 0) {
          const [cx, cy, cz] = queue.pop()!;
          component.push([cx, cy, cz]);

          // 6-connected neighbors
          for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as const) {
            const nx = cx + dx, ny = cy + dy, nz = cz + dz;
            if (!grid.inBounds(nx, ny, nz) || visited[idx(nx, ny, nz)]) continue;
            const nb = grid.get(nx, ny, nz);
            if (VEGETATION_BLOCKS_POST.has(nb)) {
              visited[idx(nx, ny, nz)] = 1;
              queue.push([nx, ny, nz]);
            }
          }
        }

        // Only record tree clusters taller than 2 blocks
        if (component.length < 4) continue;

        let minX = width, maxX = 0, minY = height, maxY = 0, minZ = length, maxZ = 0;
        for (const [cx, cy, cz] of component) {
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
        }
        const treeHeight = maxY - minY + 1;
        if (treeHeight < 3) continue; // Too short to be a tree

        const centerX = Math.round((minX + maxX) / 2);
        const centerZ = Math.round((minZ + maxZ) / 2);
        const canopyRadius = Math.max(1, Math.round(Math.max(maxX - minX, maxZ - minZ) / 2));

        trees.push({ x: centerX, z: centerZ, height: treeHeight, canopyRadius });
      }
    }
  }

  // ─── Roads: gray/dark blocks at ground level ──────────────────
  const roadCells = new Set<string>();
  const roadBlockCounts = new Map<string, number>();
  const groundMaterials = new Map<string, string>();

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      // Check ground and ground+1 layers
      for (let dy = 0; dy <= 1; dy++) {
        const y = groundY + dy;
        if (y >= height) continue;
        const block = grid.get(x, y, z);
        if (block === AIR) continue;

        // Record ground material
        if (dy === 0) groundMaterials.set(`${x},${z}`, block);

        // Detect road blocks
        if (ROAD_BLOCKS.has(block)) {
          roadCells.add(`${x},${z}`);
          roadBlockCounts.set(block, (roadBlockCounts.get(block) ?? 0) + 1);
        }
      }
    }
  }

  // Find most common road block
  let roadSurface = 'minecraft:gray_concrete';
  let maxCount = 0;
  for (const [block, count] of roadBlockCounts) {
    if (count > maxCount) { maxCount = count; roadSurface = block; }
  }

  // ─── Vehicles: small colored clusters at ground+1 ─────────────
  const vehicles: DetectedVehicle[] = [];
  const vehicleVisited = new Uint8Array(width * length);

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      if (vehicleVisited[z * width + x]) continue;

      // Check ground+1 through ground+3 for vehicle-colored blocks
      let foundVehicle = false;
      let vehicleBlock = '';
      for (let dy = 1; dy <= 3; dy++) {
        const y = groundY + dy;
        if (y >= height) break;
        const block = grid.get(x, y, z);
        if (VEHICLE_BLOCKS.has(block)) {
          foundVehicle = true;
          vehicleBlock = block;
          break;
        }
      }
      if (!foundVehicle) continue;

      // BFS to find the cluster extent in XZ
      const clusterQueue: [number, number][] = [[x, z]];
      const cluster: [number, number][] = [];
      vehicleVisited[z * width + x] = 1;

      while (clusterQueue.length > 0) {
        const [cx, cz] = clusterQueue.pop()!;
        cluster.push([cx, cz]);

        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
          if (vehicleVisited[nz * width + nx]) continue;

          let hasVehicleBlock = false;
          for (let dy = 1; dy <= 3; dy++) {
            const y = groundY + dy;
            if (y >= height) break;
            if (VEHICLE_BLOCKS.has(grid.get(nx, y, nz))) {
              hasVehicleBlock = true;
              break;
            }
          }
          if (hasVehicleBlock) {
            vehicleVisited[nz * width + nx] = 1;
            clusterQueue.push([nx, nz]);
          }
        }
      }

      // Vehicle size check: 2-6 long, 1-3 wide, compact
      if (cluster.length < 2 || cluster.length > 18) continue;
      let cMinX = width, cMaxX = 0, cMinZ = length, cMaxZ = 0;
      for (const [cx, cz] of cluster) {
        cMinX = Math.min(cMinX, cx); cMaxX = Math.max(cMaxX, cx);
        cMinZ = Math.min(cMinZ, cz); cMaxZ = Math.max(cMaxZ, cz);
      }
      const w = cMaxX - cMinX + 1;
      const l = cMaxZ - cMinZ + 1;
      const minDim = Math.min(w, l);
      const maxDim = Math.max(w, l);

      // Conservative: vehicle-shaped (2-6 long, 1-3 wide)
      if (minDim >= 1 && minDim <= 3 && maxDim >= 2 && maxDim <= 6) {
        vehicles.push({
          x: Math.round((cMinX + cMaxX) / 2),
          z: Math.round((cMinZ + cMaxZ) / 2),
          width: minDim,
          length: maxDim,
          colorBlock: vehicleBlock,
        });
      }
    }
  }

  return {
    trees,
    roads: { cells: roadCells, surfaceBlock: roadSurface },
    vehicles,
    groundMaterials,
  };
}

// ─── Clean Feature Replacement ──────────────────────────────────────────────

/**
 * Replace noisy photogrammetry features with clean Minecraft equivalents
 * at the positions detected by extractEnvironmentPositions().
 *
 * Must be called AFTER stripVegetation() has cleared the noisy blobs,
 * so we're placing clean features into air where vegetation used to be.
 *
 * @param grid          Mutable BlockGrid (post-strip)
 * @param env           Extracted environment positions from pre-strip detection
 * @param treePalette   Climate-appropriate tree species palette
 * @param groundCover   Ground cover type for road surface selection
 * @param groundY       Ground plane Y level
 * @returns Counts of replaced features
 */
export function replaceWithCleanFeatures(
  grid: BlockGrid,
  env: ExtractedEnvironment,
  treePalette: TreeType[],
  groundCover: string,
  groundY = 0,
): { trees: number; roads: number; vehicles: number } {
  let treesPlaced = 0;
  let roadsPlaced = 0;
  let vehiclesPlaced = 0;

  // Replace detected tree clusters with clean Minecraft trees
  for (const tree of env.trees) {
    // Select species from palette based on index for variety
    const species = treePalette[treesPlaced % treePalette.length];
    // Scale height: photogrammetry trees are in blocks, convert to trunk height
    const trunkHeight = Math.max(3, Math.min(7, Math.round(tree.height * 0.6)));
    // Check the tree position has space (canopy needs room)
    const treeTop = groundY + 1 + trunkHeight + 3; // trunk + canopy
    if (treeTop >= grid.height) continue;
    if (!grid.inBounds(tree.x, groundY + 1, tree.z)) continue;

    placeTree(grid, tree.x, groundY + 1, tree.z, species, trunkHeight);
    treesPlaced++;
  }

  // Replace detected road cells with appropriate surface blocks
  const roadBlock = groundCover === 'desert'
    ? 'minecraft:smooth_sandstone' : 'minecraft:gray_concrete';
  for (const key of env.roads.cells) {
    const [xStr, zStr] = key.split(',');
    const x = parseInt(xStr, 10);
    const z = parseInt(zStr, 10);
    if (!grid.inBounds(x, groundY, z)) continue;
    // Only place road if cell is air (vegetation was stripped)
    if (grid.get(x, groundY, z) === 'minecraft:air') {
      grid.set(x, groundY, z, roadBlock);
      roadsPlaced++;
    }
  }

  // Replace detected vehicle clusters with clean vehicle templates
  for (const vehicle of env.vehicles) {
    if (!grid.inBounds(vehicle.x, groundY + 1, vehicle.z)) continue;
    // Determine facing from shape
    const facing: 'north' | 'south' | 'east' | 'west' =
      vehicle.length > vehicle.width ? 'north' : 'east';
    placeVehicle(grid, vehicle.x, groundY + 1, vehicle.z, facing, vehicle.colorBlock);
    vehiclesPlaced++;
  }

  return { trees: treesPlaced, roads: roadsPlaced, vehicles: vehiclesPlaced };
}
