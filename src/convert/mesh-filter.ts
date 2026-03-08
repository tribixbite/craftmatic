/**
 * Shared mesh/grid filtering utilities for the 3D Tiles → Schematic pipeline.
 *
 * These are pure Three.js / BlockGrid helpers with no browser deps, so they
 * can be used by both the browser tiles tab and the CLI voxelizer script.
 */

import * as THREE from 'three';
import { BlockGrid } from '../schem/types.js';

/**
 * Filter captured tile meshes by vertical extent above estimated ground level.
 *
 * Two-pass algorithm:
 * 1. Compute world AABB for each mesh candidate
 * 2. Estimate ground as the median of AABB min-Y values
 * 3. Remove meshes whose max-Y doesn't rise above `minHeight` meters from ground
 *
 * Terrain, roads, and sidewalks are typically flat and sit near ground level,
 * so they get filtered out while building geometry (which rises above ground)
 * is preserved.
 *
 * @param candidates  Array of { mesh, worldBox } pairs (meshes already radius-filtered)
 * @param minHeight   Minimum vertical extent above ground to keep a mesh (meters)
 * @returns Object with kept meshes, ground level, and count of filtered meshes
 */
export function filterMeshesByHeight(
  candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }>,
  minHeight: number,
): {
  kept: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }>;
  groundY: number;
  heightFiltered: number;
} {
  if (candidates.length === 0) {
    return { kept: [], groundY: 0, heightFiltered: 0 };
  }

  // Estimate ground as median of mesh AABB min-Y values.
  // The median is robust against outlier meshes (e.g. underground fragments).
  const yMins = candidates.map(c => c.worldBox.min.y).sort((a, b) => a - b);
  const groundY = yMins[Math.floor(yMins.length / 2)];

  const kept: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
  let heightFiltered = 0;

  for (const candidate of candidates) {
    const verticalExtent = candidate.worldBox.max.y - groundY;
    if (verticalExtent < minHeight) {
      heightFiltered++;
    } else {
      kept.push(candidate);
    }
  }

  return { kept, groundY, heightFiltered };
}

/**
 * Trim sparse bottom layers from a voxelized grid.
 *
 * Scans Y layers bottom-up and removes consecutive layers where less than
 * `fillThreshold` fraction of XZ cells are filled. These layers are typically
 * residual terrain, roads, or sidewalk geometry that wasn't fully filtered
 * during mesh capture.
 *
 * Returns the original grid if no trimming is needed.
 *
 * @param grid           Source BlockGrid
 * @param fillThreshold  Minimum fill ratio to count as building content (default: 0.05 = 5%)
 */
export function trimSparseBottomLayers(
  grid: BlockGrid,
  fillThreshold = 0.05,
): BlockGrid {
  const { width, height, length } = grid;
  const totalXZ = width * length;

  // Find first Y layer from bottom with sufficient fill
  let trimY = 0;
  for (let y = 0; y < height; y++) {
    let filled = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') filled++;
      }
    }
    if (filled / totalXZ >= fillThreshold) {
      trimY = y;
      break;
    }
    // If we reach the top without finding a dense layer, keep everything
    if (y === height - 1) return grid;
  }

  if (trimY === 0) return grid; // Nothing to trim

  // Copy layers [trimY..height-1] into a new smaller grid
  const newHeight = height - trimY;
  const trimmed = new BlockGrid(width, newHeight, length);
  for (let y = 0; y < newHeight; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y + trimY, z);
        if (block !== 'minecraft:air') {
          trimmed.set(x, y, z, block);
        }
      }
    }
  }
  return trimmed;
}

/**
 * Smooth voxelized output by replacing rare/noisy blocks with common neighbors.
 *
 * Two-pass approach:
 * 1. Count global block frequencies. Blocks below `minFrequency` fraction of
 *    total non-air blocks are marked "rare."
 * 2. For each rare-block voxel, find the most common non-air block in its
 *    3x3x3 neighborhood and replace with that. If no neighbors, use the
 *    globally most common block.
 *
 * This eliminates salt-and-pepper noise from texture sampling (e.g. single
 * ice blocks in a stucco wall) without affecting the dominant palette.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param minFrequency  Minimum fraction of total blocks to be "common" (default: 0.02 = 2%)
 * @returns Number of blocks replaced
 */
export function smoothRareBlocks(grid: BlockGrid, minFrequency = 0.02): number {
  const { width, height, length } = grid;

  // Pass 1: count global block frequencies
  const freq = new Map<string, number>();
  let totalNonAir = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        totalNonAir++;
        freq.set(block, (freq.get(block) ?? 0) + 1);
      }
    }
  }

  if (totalNonAir === 0) return 0;

  // Identify rare blocks (below threshold)
  const threshold = totalNonAir * minFrequency;
  const rareBlocks = new Set<string>();
  for (const [block, count] of freq) {
    if (count < threshold) rareBlocks.add(block);
  }

  if (rareBlocks.size === 0) return 0;

  // Find the globally most common block as fallback
  let globalBest = 'minecraft:stone';
  let globalBestCount = 0;
  for (const [block, count] of freq) {
    if (!rareBlocks.has(block) && count > globalBestCount) {
      globalBest = block;
      globalBestCount = count;
    }
  }

  // Pass 2: replace rare blocks with most common neighbor
  let replaced = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air' || !rareBlocks.has(block)) continue;

        // Count non-air neighbors in 3x3x3 cube
        const neighborCounts = new Map<string, number>();
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dz = -1; dz <= 1; dz++) {
            const nz = z + dz;
            if (nz < 0 || nz >= length) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue;
              const nb = grid.get(nx, ny, nz);
              if (nb !== 'minecraft:air' && !rareBlocks.has(nb)) {
                neighborCounts.set(nb, (neighborCounts.get(nb) ?? 0) + 1);
              }
            }
          }
        }

        // Pick the most common non-rare neighbor, or global best if isolated
        let bestNeighbor = globalBest;
        let bestCount = 0;
        for (const [nb, count] of neighborCounts) {
          if (count > bestCount) {
            bestNeighbor = nb;
            bestCount = count;
          }
        }

        grid.set(x, y, z, bestNeighbor);
        replaced++;
      }
    }
  }

  return replaced;
}

/**
 * 3D mode filter (majority-vote smoother): for every non-air voxel, examine
 * its 3×3×3 neighborhood (26 neighbors). If the center block disagrees with
 * the neighborhood majority, replace it with that majority block.
 *
 * Unlike smoothRareBlocks (which only targets globally rare blocks), this
 * filter catches locally isolated blocks — e.g. a single brown_terracotta
 * speck on a wall of smooth_sandstone. This produces the "stucco" effect
 * of smooth contiguous surfaces.
 *
 * Protected blocks (glass, iron_bars, etc.) are never replaced.
 *
 * @param grid       Source BlockGrid (modified in place)
 * @param passes     Number of smoothing passes (default: 2)
 * @returns Total blocks replaced across all passes
 */
export function modeFilter3D(grid: BlockGrid, passes = 2): number {
  const { width, height, length } = grid;

  // Blocks to never replace (structural/detail elements)
  const PROTECTED = new Set([
    'minecraft:air',
    'minecraft:glass', 'minecraft:glass_pane',
    'minecraft:iron_bars', 'minecraft:iron_block',
  ]);

  let totalReplaced = 0;

  for (let pass = 0; pass < passes; pass++) {
    // Snapshot current state so replacements in this pass don't cascade
    const snapshot: string[] = new Array(width * height * length);
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          snapshot[(y * length + z) * width + x] = grid.get(x, y, z);
        }
      }
    }

    let passReplaced = 0;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const center = snapshot[(y * length + z) * width + x];
          if (PROTECTED.has(center)) continue;

          // Count non-air neighbors in 3×3×3 cube from snapshot
          const neighborCounts = new Map<string, number>();
          let totalNeighbors = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dz = -1; dz <= 1; dz++) {
              const nz = z + dz;
              if (nz < 0 || nz >= length) continue;
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                const nb = snapshot[(ny * length + nz) * width + nx];
                if (nb === 'minecraft:air') continue;
                neighborCounts.set(nb, (neighborCounts.get(nb) ?? 0) + 1);
                totalNeighbors++;
              }
            }
          }

          if (totalNeighbors === 0) continue;

          // Find the majority neighbor block
          let majorityBlock = center;
          let majorityCount = 0;
          for (const [block, count] of neighborCounts) {
            if (count > majorityCount) {
              majorityCount = count;
              majorityBlock = block;
            }
          }

          // Replace if center disagrees with majority and majority is strong
          // (needs >40% of neighbors to be the same block for replacement)
          if (majorityBlock !== center && majorityCount > totalNeighbors * 0.4) {
            grid.set(x, y, z, majorityBlock);
            passReplaced++;
          }
        }
      }
    }

    totalReplaced += passReplaced;
    if (passReplaced === 0) break; // Converged early
  }

  return totalReplaced;
}
