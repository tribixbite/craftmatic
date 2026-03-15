/**
 * Shared mesh/grid filtering utilities for the 3D Tiles → Schematic pipeline.
 *
 * These are pure Three.js / BlockGrid helpers with no browser deps, so they
 * can be used by both the browser tiles tab and the CLI voxelizer script.
 */

import * as THREE from 'three';
import { BlockGrid } from '../schem/types.js';
import { rgbToLab, deltaESq, WALL_CLUSTERS } from '../gen/color-blocks.js';
import { placeTree, placeVehicle } from '../gen/structures.js';
import type { TreeType } from '../gen/structures.js';

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
/**
 * Morphological closing (dilate then erode) to fill 1-voxel gaps and smooth
 * jagged surfaces in voxelized photogrammetry output.
 *
 * Closing = dilate → erode:
 * - Dilate: expand all solid voxels by `radius` in each axis direction.
 *   Fills 1-voxel holes, cracks between surfaces, and smooths concavities.
 * - Erode: shrink back by `radius`, removing the expansion but keeping
 *   the filled gaps. Restores the original outer profile while interior
 *   gaps stay filled.
 *
 * The dilation assigns each new voxel the most common block in its neighborhood,
 * so filled gaps take on the local wall material (not a random block).
 *
 * @param grid    Source BlockGrid (modified in place)
 * @param radius  Structuring element radius (default: 1 = fills 1-voxel gaps)
 * @returns Number of voxels changed (net fills after erode)
 */
export function morphClose3D(grid: BlockGrid, radius = 1): number {
  const { width, height, length } = grid;

  // Snapshot before dilation
  const before: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        before[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  // ── Dilate: expand solid voxels into adjacent air ──
  // For each air voxel, check if any solid neighbor within radius exists.
  // If so, assign the most common neighbor block.
  let dilated = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (before[(y * length + z) * width + x] !== 'minecraft:air') continue;

        // Count solid neighbors within radius
        const counts = new Map<string, number>();
        let hasSolid = false;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dz = -radius; dz <= radius; dz++) {
            const nz = z + dz;
            if (nz < 0 || nz >= length) continue;
            for (let dx = -radius; dx <= radius; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue;
              const nb = before[(ny * length + nz) * width + nx];
              if (nb !== 'minecraft:air') {
                counts.set(nb, (counts.get(nb) ?? 0) + 1);
                hasSolid = true;
              }
            }
          }
        }

        if (hasSolid) {
          // Assign the most common neighbor block
          let best = 'minecraft:stone';
          let bestCount = 0;
          for (const [block, count] of counts) {
            if (count > bestCount) { best = block; bestCount = count; }
          }
          grid.set(x, y, z, best);
          dilated++;
        }
      }
    }
  }

  // ── Erode: remove voxels that were solid in dilated but air in original ──
  // Only remove voxels on the OUTER surface — voxels that were air before
  // dilation AND have at least one air neighbor now. Interior fills are kept.
  // Actually, standard morphological closing erodes back by checking: if a
  // voxel was air in the original, and ALL its neighbors within radius are
  // solid (meaning it's truly interior), keep it. Otherwise, restore to air.
  let eroded = 0;
  // Snapshot the dilated state
  const afterDilate: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        afterDilate[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        // Only consider voxels that were added by dilation (were air before)
        if (before[(y * length + z) * width + x] !== 'minecraft:air') continue;
        if (afterDilate[(y * length + z) * width + x] === 'minecraft:air') continue;

        // Check if this voxel has any air neighbor within radius in dilated state.
        // If it does, it's on the outer surface of the dilation — erode it back.
        let hasAirNeighbor = false;
        for (let dy = -radius; dy <= radius && !hasAirNeighbor; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) { hasAirNeighbor = true; continue; }
          for (let dz = -radius; dz <= radius && !hasAirNeighbor; dz++) {
            const nz = z + dz;
            if (nz < 0 || nz >= length) { hasAirNeighbor = true; continue; }
            for (let dx = -radius; dx <= radius && !hasAirNeighbor; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= width) { hasAirNeighbor = true; continue; }
              if (afterDilate[(ny * length + nz) * width + nx] === 'minecraft:air') {
                hasAirNeighbor = true;
              }
            }
          }
        }

        if (hasAirNeighbor) {
          grid.set(x, y, z, 'minecraft:air');
          eroded++;
        }
      }
    }
  }

  return dilated - eroded; // Net voxels filled
}

/**
 * Flatten facades using depth histogram snapping. Identifies dominant wall
 * planes via histogram peaks, then snaps all nearby voxels to the nearest peak.
 *
 * Architecture has flat walls at discrete depth positions. Photogrammetry
 * produces noisy surfaces ±1-2 voxels from the true plane. This finds the
 * actual plane positions and enforces planarity.
 *
 * Algorithm per Y-row per facade direction:
 * 1. Build depth histogram (count solid voxels at each X or Z coordinate)
 * 2. Find peaks: coordinates with local maxima in the histogram
 * 3. For each non-peak solid voxel within `snapRadius`, move it to the
 *    nearest peak (snapping to the dominant wall plane)
 *
 * @param grid        Source BlockGrid (modified in place)
 * @param snapRadius  Max distance to snap to a peak (default: 2 voxels)
 * @returns Number of voxels snapped
 */
export function flattenFacades(grid: BlockGrid, snapRadius = 2, maxY?: number): number {
  const { width, height, length } = grid;
  // v95: maxY limits flattening to wall zone only — protects roof geometry from
  // being snapped to facade planes, which was creating holes in top-down views.
  const yLimit = maxY ?? height;
  let snapped = 0;

  // ── X-axis flattening: for each Z row, find dominant X planes ──
  for (let z = 0; z < length; z++) {
    // Build depth histogram across all Y for this Z slice (wall zone only)
    const xHist = new Int32Array(width);
    for (let y = 0; y < yLimit; y++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') xHist[x]++;
      }
    }

    // Find peaks: X positions with more voxels than both neighbors
    // A peak must have at least 15% of height to be a real wall plane
    const minPeak = yLimit * 0.1;
    const peaks: number[] = [];
    for (let x = 0; x < width; x++) {
      if (xHist[x] < minPeak) continue;
      const left = x > 0 ? xHist[x - 1] : 0;
      const right = x < width - 1 ? xHist[x + 1] : 0;
      if (xHist[x] >= left && xHist[x] >= right) {
        peaks.push(x);
      }
    }

    if (peaks.length === 0) continue;

    // Snap non-peak voxels to nearest peak within snapRadius (wall zone only)
    for (let y = 0; y < yLimit; y++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        if (peaks.includes(x)) continue; // Already on a peak

        // Find nearest peak within snapRadius
        let nearestPeak = -1;
        let nearestDist = snapRadius + 1;
        for (const peak of peaks) {
          const dist = Math.abs(x - peak);
          if (dist <= snapRadius && dist < nearestDist) {
            nearestDist = dist;
            nearestPeak = peak;
          }
        }

        if (nearestPeak >= 0 && nearestPeak !== x) {
          // Move voxel to the peak plane — only if target is empty
          if (grid.get(nearestPeak, y, z) === 'minecraft:air') {
            grid.set(nearestPeak, y, z, block);
            grid.set(x, y, z, 'minecraft:air');
            snapped++;
          }
          // If target occupied, leave source block in place (don't destroy it)
        }
      }
    }
  }

  // ── Z-axis flattening: for each X row, find dominant Z planes ──
  for (let x = 0; x < width; x++) {
    const zHist = new Int32Array(length);
    for (let y = 0; y < yLimit; y++) {
      for (let z = 0; z < length; z++) {
        if (grid.get(x, y, z) !== 'minecraft:air') zHist[z]++;
      }
    }

    const minPeak = yLimit * 0.1;
    const peaks: number[] = [];
    for (let z = 0; z < length; z++) {
      if (zHist[z] < minPeak) continue;
      const prev = z > 0 ? zHist[z - 1] : 0;
      const next = z < length - 1 ? zHist[z + 1] : 0;
      if (zHist[z] >= prev && zHist[z] >= next) {
        peaks.push(z);
      }
    }

    if (peaks.length === 0) continue;

    for (let y = 0; y < yLimit; y++) {
      for (let z = 0; z < length; z++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        if (peaks.includes(z)) continue;

        let nearestPeak = -1;
        let nearestDist = snapRadius + 1;
        for (const peak of peaks) {
          const dist = Math.abs(z - peak);
          if (dist <= snapRadius && dist < nearestDist) {
            nearestDist = dist;
            nearestPeak = peak;
          }
        }

        if (nearestPeak >= 0 && nearestPeak !== z) {
          if (grid.get(x, y, nearestPeak) === 'minecraft:air') {
            grid.set(x, y, nearestPeak, block);
            grid.set(x, y, z, 'minecraft:air');
            snapped++;
          }
        }
      }
    }
  }

  return snapped;
}

/**
 * Replace unwanted blocks with their nearest safe alternative.
 * Photogrammetry color noise can produce red_terracotta/bricks on stucco walls.
 * This constrains the palette to architecturally plausible blocks.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param replacements  Map of bad block → replacement block
 * @returns Number of blocks replaced
 */
/**
 * Erode surface protrusions by removing solid voxels with too few solid
 * face-adjacent neighbors (6-connected). Then dilate back to restore
 * wall thickness. This shaves off the 1-block bumps caused by noisy
 * photogrammetry mesh surfaces.
 *
 * A block with <minNeighbors solid face-neighbors is considered a protrusion.
 * After removing protrusions, a dilation pass fills back voxels that have
 * >=minNeighbors solid face-neighbors, restoring legitimate wall surface.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param minNeighbors  Min solid face-neighbors to keep (default: 3 of 6)
 * @returns Net voxels removed
 */
export function erodeSurfaceBumps(grid: BlockGrid, minNeighbors = 3): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';

  // Face-adjacent offsets (6-connected)
  const FACES = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ] as const;

  // Snapshot before erosion
  const snap: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        snap[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  // Erode: remove blocks with fewer than minNeighbors solid face-neighbors
  let eroded = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (snap[(y * length + z) * width + x] === AIR) continue;

        let solidFaces = 0;
        for (const [dx, dy, dz] of FACES) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < length) {
            if (snap[(ny * length + nz) * width + nx] !== AIR) solidFaces++;
          }
        }

        if (solidFaces < minNeighbors) {
          grid.set(x, y, z, AIR);
          eroded++;
        }
      }
    }
  }

  // Dilate back: fill air voxels that now have >=minNeighbors solid face-neighbors.
  // Use the eroded grid state (not snapshot) for neighbor counting.
  // Assign the most common neighbor block.
  let dilated = 0;
  // Snapshot the eroded state
  const erodedSnap: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        erodedSnap[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (erodedSnap[(y * length + z) * width + x] !== AIR) continue;

        let solidFaces = 0;
        const counts = new Map<string, number>();
        for (const [dx, dy, dz] of FACES) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < length) {
            const nb = erodedSnap[(ny * length + nz) * width + nx];
            if (nb !== AIR) {
              solidFaces++;
              counts.set(nb, (counts.get(nb) ?? 0) + 1);
            }
          }
        }

        if (solidFaces >= minNeighbors) {
          // Pick most common neighbor
          let best = 'minecraft:stone';
          let bestC = 0;
          for (const [b, c] of counts) {
            if (c > bestC) { best = b; bestC = c; }
          }
          grid.set(x, y, z, best);
          dilated++;
        }
      }
    }
  }

  return eroded - dilated;
}

/**
 * Fill building interiors using 2D flood-fill per Y-layer.
 *
 * Photogrammetry meshes produce porous voxel shells — surfaces riddled with
 * 1-2 voxel gaps. This function identifies true building interiors vs exterior
 * air using a per-layer approach:
 *
 * For each Y slice:
 * 1. Dilate solid voxels by `dilateRadius` to close wall porosity
 * 2. Flood-fill from grid edges on the dilated layer → marks "exterior" air
 * 3. Any air NOT reachable from edges is "interior" → fill with nearest block
 *
 * Uses 3D Masked Dilation for robust leak-prevention:
 * 1. Create a temporary 3D mask where solid walls are dilated by `dilateRadius`
 *    to virtually close all photogrammetry porosity and cracks.
 * 2. Run a 3D flood-fill from all 6 grid boundaries through the dilated mask
 *    to identify true "exterior" air (reachable from outside).
 * 3. Fill only voxels that are air in the ORIGINAL un-dilated grid AND were
 *    not reached by the flood fill (= interior gaps).
 *
 * This gives the leak-prevention of high dilation while preserving the crisp
 * exterior geometry of the original shell. A 3D flood fill (vs per-Y-layer 2D)
 * is exponentially more robust — a window open on layer Y=10 doesn't leak if
 * Y=9 and Y=11 are solid, since the 3D fill requires a continuous 3D tunnel.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param dilateRadius  Dilation radius for the virtual mask (default: 2)
 * @returns Number of interior air voxels filled
 */
export function fillInteriorGaps(grid: BlockGrid, dilateRadius = 2): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  const totalSize = width * height * length;
  let netFilled = 0;

  // ── Step 1: Snapshot original solid state ──
  const originalSolid = new Uint8Array(totalSize);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          originalSolid[(y * length + z) * width + x] = 1;
        }
      }
    }
  }

  // ── Step 2: Multi-pass 3D dilation (6-connected) to create leak-proof mask ──
  // Each pass expands solid blocks by 1 in all 6 directions (Manhattan distance).
  // dilateRadius=2 closes 2-voxel gaps — enough for most photogrammetry porosity.
  const dirs: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  let currentMask = new Uint8Array(originalSolid);
  for (let step = 0; step < dilateRadius; step++) {
    const nextMask = new Uint8Array(currentMask);
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * length + z) * width + x;
          if (currentMask[idx]) {
            for (const [dx, dy, dz] of dirs) {
              const nx = x + dx, ny = y + dy, nz = z + dz;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < length) {
                nextMask[(ny * length + nz) * width + nx] = 1;
              }
            }
          }
        }
      }
    }
    currentMask = nextMask;
  }
  const dilatedMask = currentMask;

  // ── Step 3: 3D flood fill from grid boundaries to find exterior air ──
  // Seed all 6 outer faces. Any air cell reachable through the dilated mask
  // from a boundary is exterior. Interior pockets are unreachable.
  const exterior = new Uint8Array(totalSize);
  // Use Int32Array as queue for performance (avoid GC from push/shift)
  const q = new Int32Array(totalSize);
  let qHead = 0, qTail = 0;

  // Seed boundary cells that are air in the dilated mask
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (x !== 0 && x !== width - 1 && y !== 0 && y !== height - 1 && z !== 0 && z !== length - 1) continue;
        const idx = (y * length + z) * width + x;
        if (!dilatedMask[idx] && !exterior[idx]) {
          exterior[idx] = 1;
          q[qTail++] = idx;
        }
      }
    }
  }

  // BFS 3D flood fill (6-connected)
  while (qHead < qTail) {
    const idx = q[qHead++];
    const x = idx % width;
    const z = Math.floor(idx / width) % length;
    const y = Math.floor(idx / (width * length));

    for (const [dx, dy, dz] of dirs) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
      const nIdx = (ny * length + nz) * width + nx;
      if (dilatedMask[nIdx] || exterior[nIdx]) continue; // Wall or already visited
      exterior[nIdx] = 1;
      q[qTail++] = nIdx;
    }
  }

  // ── Step 4: Fill interior gaps in the ORIGINAL grid ──
  // Only voxels that were air in the original AND not reached by flood fill.
  // Use smooth_stone for interior fill: neutral gray that reads as depth
  // through shell gaps. NOT in glazeDarkWindows SHADOW_BLOCKS, so fill
  // blocks won't be mistakenly glazed as windows.
  const FILL_BLOCK = 'minecraft:smooth_stone';
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * length + z) * width + x;
        if (originalSolid[idx] || exterior[idx]) continue; // Solid or exterior
        grid.set(x, y, z, FILL_BLOCK);
        netFilled++;
      }
    }
  }

  return netFilled;
}

/**
 * Remove fill blocks that have no solid (non-fill) roof above them.
 *
 * After fillInteriorGaps, stadiums, courtyards, and open-air spaces may be
 * incorrectly filled because the dilation mask closed small rim/wall gaps.
 * This pass checks each fill voxel for a vertical line-of-sight to the sky:
 * - If a fill voxel has a non-fill solid block anywhere above it → keep (under a roof)
 * - If a fill voxel has only air or other fill above → remove (open-air space)
 *
 * To avoid false-clearing on buildings truncated by capture radius (where the top
 * has no roof simply because capture was too short), requires a minimum vertical
 * clearance of `minClearance` air/fill layers above the fill before classifying
 * as open-air. This prevents removing fill at truncation boundaries where the
 * building simply extends beyond the grid.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param fillBlock     The block ID used by fillInteriorGaps (default: smooth_stone)
 * @param minClearance  Minimum air layers above fill before classifying as open-air (default: 5)
 * @returns             Number of fill blocks removed
 */
export function clearOpenAirFill(
  grid: BlockGrid,
  fillBlock = 'minecraft:smooth_stone',
  minClearance = 5,
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';

  // 2D connected-component approach:
  // 1. Build XZ mask of "open-air columns" — has fill, no solid roof above, sufficient clearance
  // 2. 4-connected flood fill to find contiguous open-air regions
  // 3. Only clear fill in large regions (≥MIN_OPEN_AIR_COLUMNS) — stadiums/courtyards are large,
  //    truncation artifacts from missing roof are small/scattered
  const MIN_OPEN_AIR_COLUMNS = 25; // ~5×5m² minimum open-air region

  // Step 1: Build XZ "open-air" mask
  // A column is "open-air" if it has fill blocks AND no solid (non-fill) roof above them
  // AND has sufficient vertical clearance above the topmost real block
  const openAirMask = new Uint8Array(width * length); // 1 = open-air column

  // Minimum real blocks above fill to count as "roofed" — thin photogrammetry
  // artifacts (1-2 blocks) shouldn't prevent courtyard clearing
  const MIN_ROOF_THICKNESS = Math.max(2, minClearance);

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      let hasFill = false;
      let topRealY = -1;
      let realBlocksAboveFill = 0;

      // Top-down scan: find topmost real block, count real blocks above fill
      let seenFill = false;
      for (let y = height - 1; y >= 0; y--) {
        const block = grid.get(x, y, z);
        if (block !== AIR && block !== fillBlock) {
          if (topRealY < 0) topRealY = y;
          if (!seenFill) realBlocksAboveFill++;
        } else if (block === fillBlock) {
          hasFill = true;
          seenFill = true;
        }
      }

      // Column is open-air if: has fill, no SUBSTANTIAL roof above fill, sufficient clearance.
      // A "substantial roof" requires MIN_ROOF_THICKNESS real blocks above the fill —
      // this prevents thin photogrammetry artifacts from masking courtyards.
      const hasRoofAboveFill = realBlocksAboveFill >= MIN_ROOF_THICKNESS;
      const clearanceAbove = topRealY >= 0 ? (height - 1 - topRealY) : 0;
      if (hasFill && !hasRoofAboveFill && clearanceAbove >= minClearance) {
        openAirMask[z * width + x] = 1;
      }
    }
  }

  // Step 2: 4-connected flood fill to find connected components
  const componentId = new Int32Array(width * length); // 0 = unassigned
  const componentSizes: Map<number, number> = new Map();
  let nextId = 1;

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const idx = z * width + x;
      if (openAirMask[idx] !== 1 || componentId[idx] !== 0) continue;

      // BFS flood fill for this component
      const id = nextId++;
      const queue: number[] = [idx];
      let size = 0;
      componentId[idx] = id;

      while (queue.length > 0) {
        const cur = queue.pop()!;
        size++;
        const cx = cur % width;
        const cz = Math.floor(cur / width);

        // 4-connected neighbors
        const neighbors = [
          cz > 0 ? (cz - 1) * width + cx : -1,
          cz < length - 1 ? (cz + 1) * width + cx : -1,
          cx > 0 ? cz * width + (cx - 1) : -1,
          cx < width - 1 ? cz * width + (cx + 1) : -1,
        ];
        for (const ni of neighbors) {
          if (ni >= 0 && openAirMask[ni] === 1 && componentId[ni] === 0) {
            componentId[ni] = id;
            queue.push(ni);
          }
        }
      }

      componentSizes.set(id, size);
    }
  }

  // Step 3: Clear fill only in columns belonging to large components
  let removed = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const id = componentId[z * width + x];
      if (id === 0) continue;
      const size = componentSizes.get(id)!;
      if (size < MIN_OPEN_AIR_COLUMNS) continue;

      // Clear all fill blocks in this open-air column (no roof above them)
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) === fillBlock) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Convert dark exterior surface blocks to gray_stained_glass to represent windows.
 *
 * Uses Chebyshev-1 spatial grouping for vertical window columns:
 * 1. Only considers blocks on exterior facade surfaces (Y≥2, horizontal adjacency to air)
 * 2. Groups facade dark blocks into vertical chains using Chebyshev-1 XZ tolerance:
 *    each block connects to the 3×3 XZ neighborhood (x±1, z±1) above, tolerating
 *    1-block lateral shift per floor (tapers, diagonals, curves)
 * 3. Glazes all dark blocks in chains with ≥2 members
 *
 * @param grid  Source BlockGrid (modified in place)
 * @returns Number of blocks glazed
 */
export function glazeDarkWindows(grid: BlockGrid, resolution = 1): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let glazed = 0;

  // Dark blocks that typically represent baked window/shadow regions.
  // Only the truly dark blocks qualify — mid-grays (andesite, stone_bricks,
  // polished_andesite) are legitimate facade materials with the wider tonal range.
  const DARK_BLOCKS = new Set([
    'minecraft:gray_concrete',       // lum ~58 — deep shadow/window
    'minecraft:polished_deepslate',  // lum ~54 — deep shadow/window
    'minecraft:brown_concrete',      // lum ~45 — dark recesses
    'minecraft:black_concrete',      // lum ~25 — deep shadow/window
    'minecraft:deepslate',           // lum ~48 — dark recesses
  ]);

  // Scale MIN_Y with resolution: skip ground-level (foundation, entry, base shadow)
  const MIN_Y = Math.max(2, Math.round(2 * resolution));

  // Horizontal directions for facade detection (adjacent to air on X or Z axis)
  const H_DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // Phase 1: Collect all facade dark block positions
  type Pos = { x: number; y: number; z: number };
  const facadeBlocks: Pos[] = [];
  // 3D lookup for quick neighbor queries: key = y*W*L + z*W + x
  const WL = width * length;
  const facadeSet = new Uint8Array(height * WL);

  for (let y = MIN_Y; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (!DARK_BLOCKS.has(block)) continue;

        // Check if on a horizontal facade (adjacent to air on X or Z axis)
        let isFacade = false;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            isFacade = true;
            break;
          }
        }
        if (isFacade) {
          facadeBlocks.push({ x, y, z });
          facadeSet[y * WL + z * width + x] = 1;
        }
      }
    }
  }

  if (facadeBlocks.length === 0) return 0;

  // Count total non-air exterior blocks for glazing cap.
  // If dark facade blocks exceed MAX_GLAZE_PCT of total facade, the "windows"
  // are actually baked photogrammetry shadows — skip glazing entirely.
  const MAX_GLAZE_PCT = 0.30; // max 30% of facade can be glazed (commercial buildings have >20% dark)
  let totalFacadeBlocks = 0;
  for (let y = MIN_Y; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;
        let onFacade = false;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            onFacade = true;
            break;
          }
        }
        if (onFacade) totalFacadeBlocks++;
      }
    }
  }

  if (totalFacadeBlocks > 0 && facadeBlocks.length / totalFacadeBlocks > MAX_GLAZE_PCT) {
    console.log(`    glazeDarkWindows: SKIPPED — ${facadeBlocks.length} dark blocks = ${(100 * facadeBlocks.length / totalFacadeBlocks).toFixed(0)}% of ${totalFacadeBlocks} facade blocks (cap ${(MAX_GLAZE_PCT * 100).toFixed(0)}%)`);
    return 0;
  }

  // Phase 2: Union-Find to group facade dark blocks into vertical chains.
  // Two blocks are connected if they are Chebyshev-1 neighbors in XZ and ±1 in Y.
  // This means a block at (x,y,z) connects to any facade dark block at
  // (x±1, y±1, z±1) — tolerating diagonal walls and tapered facades.
  const parent = new Int32Array(facadeBlocks.length);
  const rank = new Uint8Array(facadeBlocks.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;

  function find(a: number): number {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
  }

  // Build index: for each (y, x, z) → index in facadeBlocks
  // Only need to check Y+1 direction (each pair found once)
  const posIndex = new Map<number, number>(); // key → facadeBlocks index
  for (let i = 0; i < facadeBlocks.length; i++) {
    const { x, y, z } = facadeBlocks[i];
    posIndex.set(y * WL + z * width + x, i);
  }

  for (let i = 0; i < facadeBlocks.length; i++) {
    const { x, y, z } = facadeBlocks[i];
    // Check Chebyshev-1 XZ neighbors at Y+1
    const ny = y + 1;
    if (ny >= height) continue;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
        const nIdx = ny * WL + nz * width + nx;
        if (facadeSet[nIdx]) {
          const j = posIndex.get(nIdx);
          if (j !== undefined) union(i, j);
        }
      }
    }
  }

  // Phase 3: Filter components by size AND vertical extent.
  // Real windows form vertically coherent chains spanning ≥3 Y levels;
  // noise/shadow artifacts are scattered with small vertical bounding boxes.
  const MIN_COMP_SIZE = 3;    // minimum blocks in the chain
  // Scale vertical span threshold with resolution: 3m floor = 9 blocks at res 3
  const MIN_COMP_HEIGHT = Math.max(2, Math.round(2 * resolution));

  const compSize = new Map<number, number>();
  const compMinY = new Map<number, number>();
  const compMaxY = new Map<number, number>();
  for (let i = 0; i < facadeBlocks.length; i++) {
    const root = find(i);
    const { y } = facadeBlocks[i];
    compSize.set(root, (compSize.get(root) ?? 0) + 1);
    compMinY.set(root, Math.min(compMinY.get(root) ?? y, y));
    compMaxY.set(root, Math.max(compMaxY.get(root) ?? y, y));
  }

  for (let i = 0; i < facadeBlocks.length; i++) {
    const root = find(i);
    const size = compSize.get(root) ?? 0;
    const vHeight = (compMaxY.get(root) ?? 0) - (compMinY.get(root) ?? 0) + 1;
    if (size >= MIN_COMP_SIZE && vHeight >= MIN_COMP_HEIGHT) {
      const { x, y, z } = facadeBlocks[i];
      grid.set(x, y, z, 'minecraft:gray_stained_glass');
      glazed++;
    }
  }

  return glazed;
}

/**
 * Inject synthetic windows on exterior facade blocks that lack dark-block windows.
 *
 * When the color pipeline produces a uniformly light facade (e.g. ESB at 78%
 * white_concrete), glazeDarkWindows can't find dark blocks to convert.
 * This function detects floor boundaries from horizontal band analysis and places
 * gray_stained_glass windows in a regular grid pattern between floors.
 *
 * Pattern: 1-block window every 2-3 blocks along the facade, at 2/3 of each
 * floor height. Only modifies exterior facade blocks that are the dominant
 * facade material (to avoid overwriting trim, corners, or accent blocks).
 *
 * @param grid  Source BlockGrid (modified in place)
 * @param existingGlazed  Number of blocks already glazed by glazeDarkWindows
 * @returns Number of blocks converted to windows
 */
export function injectSyntheticWindows(grid: BlockGrid, existingGlazed: number, resolution = 1): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  const GLASS = 'minecraft:gray_stained_glass';

  // Only inject if existing glazing was minimal (< 0.5% of non-air blocks)
  const nonAir = grid.countNonAir();
  if (existingGlazed > nonAir * 0.005) return 0;
  // Scale minimum height with resolution: 8m = 24 blocks at res 3
  if (height < Math.max(8, Math.round(8 * resolution))) return 0;

  // Horizontal directions for facade detection
  const H_DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // Step 1: Find dominant facade material by counting exterior surface blocks
  const facadeCounts = new Map<string, number>();
  for (let y = 2; y < height - 1; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR || block === GLASS) continue;

        let isFacade = false;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            isFacade = true; break;
          }
        }
        if (isFacade) {
          facadeCounts.set(block, (facadeCounts.get(block) ?? 0) + 1);
        }
      }
    }
  }

  if (facadeCounts.size === 0) return 0;

  // Find dominant facade block (must be > 40% of facade)
  let totalFacade = 0;
  let dominantBlock = '';
  let dominantCount = 0;
  for (const [block, count] of facadeCounts) {
    totalFacade += count;
    if (count > dominantCount) { dominantCount = count; dominantBlock = block; }
  }
  if (dominantCount < totalFacade * 0.4) return 0; // no clear dominant material

  // Step 2: Detect floor boundaries using Y-layer block density analysis
  // Each Y-layer has a count of solid blocks. Floor/ceiling slabs show as high-density
  // horizontal bands. The gaps between them are where windows go.
  const layerDensity = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) count++;
      }
    }
    layerDensity[y] = count / (width * length);
  }

  // Estimate floor height from autocorrelation of density profile.
  // At 1 block/m floors are 3-4 blocks; at 3 blocks/m floors are 9-12 blocks.
  const minPeriod = Math.round(3 * resolution);
  const maxPeriod = Math.round(5 * resolution);
  let bestPeriod = minPeriod;
  let bestCorr = -1;
  for (let period = minPeriod; period <= maxPeriod; period++) {
    let corr = 0;
    let count = 0;
    for (let y = 0; y + period < height; y++) {
      corr += layerDensity[y] * layerDensity[y + period];
      count++;
    }
    corr = count > 0 ? corr / count : 0;
    if (corr > bestCorr) { bestCorr = corr; bestPeriod = period; }
  }

  // Step 3: Place windows on exterior dominant-material blocks at regular intervals
  // Window placement: every bestPeriod Y-layers, skip 1 block from floor, place window
  // Horizontally: every 2-3 blocks along the facade
  let injected = 0;
  // Scale foundation skip with resolution: 3m at res 3 = 9 blocks
  const MIN_Y = Math.max(3, Math.round(3 * resolution));

  for (let y = MIN_Y; y < height - 2; y++) {
    // Window rows: not at the very top or bottom of each floor
    const floorPos = y % bestPeriod;
    if (floorPos === 0 || floorPos === bestPeriod - 1) continue; // skip floor/ceiling layers

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block !== dominantBlock) continue;

        // Must be exterior facade
        let isFacade = false;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            isFacade = true; break;
          }
        }
        if (!isFacade) continue;

        // Horizontal spacing: window every 3*resolution blocks (scale with resolution)
        // Use (x + z) to create a consistent pattern across facades
        const hSpacing = Math.max(3, Math.round(3 * resolution));
        if ((x + z) % hSpacing !== 0) continue;

        // Don't place windows on corner blocks (where two facades meet)
        let facadeCount = 0;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            facadeCount++;
          }
        }
        if (facadeCount > 1) continue; // corner — skip

        grid.set(x, y, z, GLASS);
        injected++;
      }
    }
  }

  return injected;
}

/**
 * Detect and regularize windows on building facades, then add doors.
 *
 * For each facade face (N/S/E/W), projects facade blocks to a 2D bitmap.
 * Connected components of glass/dark blocks identify existing window clusters.
 * If windows were detected, snaps them to a regular grid (median spacing).
 * If < 3 windows detected, injects a regular window pattern.
 *
 * Also detects and places doors: lowest dark/glass cluster on the front face
 * touching ground level, 2+ blocks wide.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param groundY       Ground plane Y level
 * @returns Object with counts of windows regularized and doors placed
 */
export function detectAndRegularizeWindows(
  grid: BlockGrid,
  groundY = 0,
): { windowsRegularized: number; doorsPlaced: number } {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  const GLASS = 'minecraft:gray_stained_glass';
  const DOOR_BOTTOM = 'minecraft:oak_door[half=lower,facing=south]';
  const DOOR_TOP = 'minecraft:oak_door[half=upper,facing=south]';

  let windowsRegularized = 0;
  let doorsPlaced = 0;

  // Glass/dark blocks that represent windows
  const WINDOW_BLOCKS = new Set([
    GLASS, 'minecraft:glass', 'minecraft:glass_pane',
    'minecraft:gray_concrete', 'minecraft:polished_deepslate',
  ]);

  // Process each of 4 facade faces
  type FaceDir = { name: string; normal: [number, number]; facadeAxis: 'x' | 'z'; sweepAxis: 'z' | 'x' };
  const faces: FaceDir[] = [
    { name: 'north', normal: [0, -1], facadeAxis: 'z', sweepAxis: 'x' },
    { name: 'south', normal: [0, 1], facadeAxis: 'z', sweepAxis: 'x' },
    { name: 'west', normal: [-1, 0], facadeAxis: 'x', sweepAxis: 'z' },
    { name: 'east', normal: [1, 0], facadeAxis: 'x', sweepAxis: 'z' },
  ];

  // Find building bounds
  let bMinX = width, bMaxX = 0, bMinZ = length, bMaxZ = 0;
  let bMinY = height, bMaxY = 0;
  for (let y = groundY; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          bMinX = Math.min(bMinX, x); bMaxX = Math.max(bMaxX, x);
          bMinZ = Math.min(bMinZ, z); bMaxZ = Math.max(bMaxZ, z);
          bMinY = Math.min(bMinY, y); bMaxY = Math.max(bMaxY, y);
        }
      }
    }
  }
  if (bMaxY - bMinY < 4) return { windowsRegularized: 0, doorsPlaced: 0 };

  for (const face of faces) {
    // Determine facade plane position (outermost row of blocks for this face)
    let facadePos: number;
    const sweepRange: [number, number] = [0, 0];
    if (face.name === 'north') { facadePos = bMinZ; sweepRange[0] = bMinX; sweepRange[1] = bMaxX; }
    else if (face.name === 'south') { facadePos = bMaxZ; sweepRange[0] = bMinX; sweepRange[1] = bMaxX; }
    else if (face.name === 'west') { facadePos = bMinX; sweepRange[0] = bMinZ; sweepRange[1] = bMaxZ; }
    else { facadePos = bMaxX; sweepRange[0] = bMinZ; sweepRange[1] = bMaxZ; }

    // Project facade into 2D bitmap (sweep axis × Y)
    const facadeWidth = sweepRange[1] - sweepRange[0] + 1;
    const facadeHeight = bMaxY - bMinY + 1;
    if (facadeWidth < 3 || facadeHeight < 4) continue;

    // Count existing windows on this face
    let existingWindows = 0;
    const windowPositions: { s: number; y: number }[] = []; // sweep, y coords of windows

    for (let s = sweepRange[0]; s <= sweepRange[1]; s++) {
      for (let y = bMinY + 2; y <= bMaxY - 1; y++) {
        const [x, z] = face.sweepAxis === 'x' ? [s, facadePos] : [facadePos, s];
        const block = grid.get(x, y, z);
        if (WINDOW_BLOCKS.has(block)) {
          existingWindows++;
          windowPositions.push({ s: s - sweepRange[0], y: y - bMinY });
        }
      }
    }

    // If we have enough windows, try to regularize their spacing
    if (windowPositions.length >= 3) {
      // Find median horizontal spacing between windows on the same Y level
      const yGroups = new Map<number, number[]>();
      for (const wp of windowPositions) {
        if (!yGroups.has(wp.y)) yGroups.set(wp.y, []);
        yGroups.get(wp.y)!.push(wp.s);
      }

      const spacings: number[] = [];
      for (const [, positions] of yGroups) {
        positions.sort((a, b) => a - b);
        for (let i = 1; i < positions.length; i++) {
          const gap = positions[i] - positions[i - 1];
          if (gap >= 2 && gap <= 6) spacings.push(gap);
        }
      }

      if (spacings.length >= 2) {
        // Median spacing for regularization
        spacings.sort((a, b) => a - b);
        const medianSpacing = spacings[Math.floor(spacings.length / 2)];

        // Find median vertical spacing
        const sGroups = new Map<number, number[]>();
        for (const wp of windowPositions) {
          if (!sGroups.has(wp.s)) sGroups.set(wp.s, []);
          sGroups.get(wp.s)!.push(wp.y);
        }
        const vSpacings: number[] = [];
        for (const [, positions] of sGroups) {
          positions.sort((a, b) => a - b);
          for (let i = 1; i < positions.length; i++) {
            const gap = positions[i] - positions[i - 1];
            if (gap >= 2 && gap <= 6) vSpacings.push(gap);
          }
        }
        const medianVSpacing = vSpacings.length > 0
          ? vSpacings.sort((a, b) => a - b)[Math.floor(vSpacings.length / 2)]
          : 3;

        // Place regularized window grid
        // Start from the first detected window position, snap to grid
        const startS = windowPositions.length > 0
          ? windowPositions[0].s % medianSpacing
          : 1;
        const startY = windowPositions.length > 0
          ? (windowPositions[0].y - 2) % medianVSpacing + 2
          : 2;

        for (let sy = startY; sy < facadeHeight - 1; sy += medianVSpacing) {
          for (let ss = startS; ss < facadeWidth - 1; ss += medianSpacing) {
            const absS = sweepRange[0] + ss;
            const absY = bMinY + sy;
            const [x, z] = face.sweepAxis === 'x' ? [absS, facadePos] : [facadePos, absS];

            if (!grid.inBounds(x, absY, z)) continue;
            const current = grid.get(x, absY, z);
            // Only place window on solid non-air, non-glass blocks
            if (current === AIR || WINDOW_BLOCKS.has(current)) continue;

            grid.set(x, absY, z, GLASS);
            windowsRegularized++;
          }
        }
      }
    }

    // Door detection: lowest facade cluster touching ground, 2+ blocks wide
    if (face.name === 'south' || face.name === 'north') { // front faces
      const doorY = groundY + 1;
      if (doorY + 1 < height) {
        // Find a 2-block-wide gap or dark region at ground level on this face
        for (let s = sweepRange[0] + 1; s <= sweepRange[1] - 1; s++) {
          const [x, z] = face.sweepAxis === 'x' ? [s, facadePos] : [facadePos, s];
          const block = grid.get(x, doorY, z);
          const blockAbove = grid.get(x, doorY + 1, z);
          // Only place door where facade has solid blocks (to replace, not in air)
          if (block !== AIR && blockAbove !== AIR &&
              !WINDOW_BLOCKS.has(block) && doorsPlaced === 0) {
            grid.set(x, doorY, z, DOOR_BOTTOM);
            grid.set(x, doorY + 1, z, DOOR_TOP);
            doorsPlaced++;
            break; // one door per building
          }
        }
      }
    }
  }

  return { windowsRegularized, doorsPlaced };
}

/**
 * Smooth building surfaces via 2D morphological opening per Y-layer.
 *
 * Opening = erode then dilate — removes 1-voxel protrusions from the
 * exterior surface while preserving the overall shape. After interior
 * flood fill creates solid volumes, the exterior outline can still be
 * bumpy from photogrammetry mesh noise. This cleans it up.
 *
 * @param grid  Source BlockGrid (modified in place)
 * @returns Number of surface voxels removed
 */
export function smoothSurface(grid: BlockGrid, maxY?: number, preserveBoundary = false): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let totalChanged = 0;
  // maxY: optional upper Y bound (exclusive) — skip smoothing above this layer
  // to preserve roof features (gables, peaks, dormers) that read as noise.
  const yLimit = maxY !== undefined ? Math.min(maxY, height) : height;

  // Face-adjacent offsets in XZ plane (4-connected)
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

  // v73: Compute footprint boundary mask — protects silhouette edges (tips, corners)
  // from erosion. Union of all Y layers' boundaries: any XZ position that has a solid
  // voxel adjacent to exterior air at any height is protected at ALL heights.
  let boundaryMask: Set<number> | null = null;
  if (preserveBoundary) {
    boundaryMask = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          if (grid.get(x, y, z) === AIR) continue;
          // Check if this solid voxel touches air in XZ
          for (const [dx, dz] of DIRS) {
            const nx = x + dx, nz = z + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
                grid.get(nx, y, nz) === AIR) {
              boundaryMask.add(z * width + x);
              break;
            }
          }
        }
      }
    }
  }

  for (let y = 0; y < yLimit; y++) {
    // Snapshot this layer
    const layer: boolean[] = new Array(width * length);
    const blocks: string[] = new Array(width * length);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        const b = grid.get(x, y, z);
        layer[idx] = b !== AIR;
        blocks[idx] = b;
      }
    }

    // Erode: remove solid voxels with < 2 solid 4-connected XZ neighbors
    // (these are 1-block protrusions on the surface)
    // v73: Skip erosion for boundary voxels when preserveBoundary is enabled
    const eroded: boolean[] = [...layer];
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (!layer[idx]) continue;
        // Protect footprint boundary — tips, corners, edges
        if (boundaryMask?.has(idx)) continue;

        let solidNeighbors = 0;
        for (const [dx, dz] of DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
            if (layer[nz * width + nx]) solidNeighbors++;
          }
        }

        if (solidNeighbors < 2) {
          eroded[idx] = false;
        }
      }
    }

    // Dilate: restore eroded voxels that have >=3 solid neighbors in eroded state
    // This recovers wall edges that were over-eroded
    const opened: boolean[] = [...eroded];
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (eroded[idx]) continue; // Already solid

        let solidNeighbors = 0;
        for (const [dx, dz] of DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
            if (eroded[nz * width + nx]) solidNeighbors++;
          }
        }

        if (solidNeighbors >= 3) {
          opened[idx] = true;
        }
      }
    }

    // Apply changes: remove voxels that were solid but now air
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (layer[idx] && !opened[idx]) {
          grid.set(x, y, z, AIR);
          totalChanged++;
        } else if (!layer[idx] && opened[idx]) {
          // Dilated back — find nearest block color
          let bestBlock = AIR;
          let bestDist = Infinity;
          for (const [dx, dz] of DIRS) {
            const nx = x + dx, nz = z + dz;
            if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
              const nIdx = nz * width + nx;
              if (blocks[nIdx] !== AIR) {
                const dist = 1;
                if (dist < bestDist) { bestDist = dist; bestBlock = blocks[nIdx]; }
              }
            }
          }
          if (bestBlock !== AIR) {
            grid.set(x, y, z, bestBlock);
          }
        }
      }
    }
  }

  return totalChanged;
}

/**
 * Rectangularize building cross-sections using connected-component AABBs.
 *
 * For each Y layer:
 * 1. Find connected solid regions (4-connected BFS)
 * 2. Discard tiny regions (< minRegionSize voxels — noise/vegetation)
 * 3. For each significant region, compute axis-aligned bounding box (AABB)
 * 4. Fill the AABB with the region's dominant block → perfectly rectangular
 *
 * This replaces the organic outlines from photogrammetry with sharp-edged
 * rectangular building footprints. Separate buildings get separate rectangles
 * as long as they're not connected in that layer.
 *
 * @param grid           Source BlockGrid (modified in place)
 * @param minRegionSize  Minimum connected component size to keep (default: 20 voxels)
 * @param maxExtend      Max distance (Manhattan) from existing solid to fill (default: 2).
 *                        Prevents filling deep voids (balconies/recesses) while still
 *                        smoothing 1-2 block wall jaggedness. Set to Infinity for full AABB.
 * @param facadeDepth    Depth from AABB edges to preserve scan detail (default: 0 = disabled).
 *                        Cells within facadeDepth of any AABB face use maxExtend-limited fill.
 *                        Cells deeper than facadeDepth from all faces get full AABB fill.
 *                        This preserves balconies/recesses near facades while solidifying
 *                        building interiors.
 * @returns Number of voxels changed
 */
export function rectangularize(grid: BlockGrid, minRegionSize = 20, maxExtend = 2, facadeDepth = 0): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let changed = 0;

  for (let y = 0; y < height; y++) {
    // Snapshot the solid mask BEFORE rectangularization for distance checking
    const originalSolid: boolean[] = new Array(width * length);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        originalSolid[z * width + x] = grid.get(x, y, z) !== AIR;
      }
    }

    // Find connected components via BFS
    const visited = new Uint8Array(width * length);
    const regions: Array<{
      minX: number; maxX: number; minZ: number; maxZ: number;
      dominant: string; size: number;
    }> = [];

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (visited[idx] || !originalSolid[idx]) continue;

        // BFS flood fill to find connected region
        let minX = x, maxX = x, minZ = z, maxZ = z;
        const counts = new Map<string, number>();
        const queue: number[] = [idx];
        let head = 0;
        let size = 0;
        visited[idx] = 1;

        while (head < queue.length) {
          const ci = queue[head++];
          const cx = ci % width;
          const cz = (ci - cx) / width;
          size++;

          const block = grid.get(cx, y, cz);
          counts.set(block, (counts.get(block) ?? 0) + 1);

          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cz < minZ) minZ = cz;
          if (cz > maxZ) maxZ = cz;

          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
            const ni = nz * width + nx;
            if (visited[ni] || !originalSolid[ni]) continue;
            visited[ni] = 1;
            queue.push(ni);
          }
        }

        if (size < minRegionSize) continue;

        let dominant = AIR;
        let maxC = 0;
        for (const [b, c] of counts) {
          if (c > maxC) { dominant = b; maxC = c; }
        }

        regions.push({ minX, maxX, minZ, maxZ, dominant, size });
      }
    }

    // Sort by size descending — larger regions get priority in overlaps
    regions.sort((a, b) => b.size - a.size);

    // Fill each region's AABB using hybrid strategy:
    // - Cells within facadeDepth of any AABB edge: distance-limited fill (preserves balconies)
    // - Cells deeper than facadeDepth from all edges: full fill (solidifies interior)
    // When facadeDepth=0, everything uses the maxExtend/full strategy.
    const claimed = new Uint8Array(width * length);
    for (const region of regions) {
      for (let z = region.minZ; z <= region.maxZ; z++) {
        for (let x = region.minX; x <= region.maxX; x++) {
          const idx = z * width + x;
          if (claimed[idx]) continue;

          if (originalSolid[idx]) {
            // Already solid — claim it
            claimed[idx] = 1;
            continue;
          }

          // Compute distance from this cell to the nearest AABB edge (in XZ).
          // Cells near the edge are in the "facade zone" and keep scan detail.
          const edgeDist = Math.min(
            x - region.minX,
            region.maxX - x,
            z - region.minZ,
            region.maxZ - z,
          );
          const inFacadeZone = facadeDepth > 0 && edgeDist < facadeDepth;

          if (inFacadeZone) {
            // Facade zone: only fill within maxExtend of existing solid.
            // This preserves balconies, recesses, and other depth features.
            const effectiveMax = maxExtend;
            let nearestDist = effectiveMax + 1;
            for (let dz2 = -effectiveMax; dz2 <= effectiveMax && nearestDist > 1; dz2++) {
              const nz = z + dz2;
              if (nz < region.minZ || nz > region.maxZ) continue;
              for (let dx2 = -effectiveMax; dx2 <= effectiveMax; dx2++) {
                const nx = x + dx2;
                if (nx < region.minX || nx > region.maxX) continue;
                const dist = Math.abs(dx2) + Math.abs(dz2);
                if (dist >= nearestDist) continue;
                if (originalSolid[nz * width + nx]) {
                  nearestDist = dist;
                }
              }
            }

            if (nearestDist <= effectiveMax) {
              grid.set(x, y, z, region.dominant);
              claimed[idx] = 1;
              changed++;
            }
          } else {
            // Core zone: full fill — solidify the building interior
            grid.set(x, y, z, region.dominant);
            claimed[idx] = 1;
            changed++;
          }
        }
      }
    }

    // Remove small isolated blocks not part of any region
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (grid.get(x, y, z) !== AIR && !claimed[idx]) {
          grid.set(x, y, z, AIR);
          changed++;
        }
      }
    }
  }

  return changed;
}

export function constrainPalette(
  grid: BlockGrid,
  replacements: Map<string, string>,
): number {
  const { width, height, length } = grid;
  let replaced = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        const replacement = replacements.get(block);
        if (replacement) {
          grid.set(x, y, z, replacement);
          replaced++;
        }
      }
    }
  }
  return replaced;
}

export function modeFilter3D(grid: BlockGrid, passes = 2, radius = 1, extraProtected?: Set<string>): number {
  const { width, height, length } = grid;

  // Blocks to never replace (structural/detail elements)
  const PROTECTED = new Set([
    'minecraft:air',
    'minecraft:glass', 'minecraft:glass_pane',
    'minecraft:gray_stained_glass', 'minecraft:black_stained_glass',
    'minecraft:iron_bars', 'minecraft:iron_block',
  ]);
  if (extraProtected) for (const b of extraProtected) PROTECTED.add(b);

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

          // Count non-air neighbors in (2r+1)^3 cube from snapshot
          const neighborCounts = new Map<string, number>();
          let totalNeighbors = 0;
          for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dz = -radius; dz <= radius; dz++) {
              const nz = z + dz;
              if (nz < 0 || nz >= length) continue;
              for (let dx = -radius; dx <= radius; dx++) {
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

          // Replace if center disagrees with plurality, plurality is strong (>35%),
          // AND center block is isolated (< 2 same-type neighbors).
          // 35% threshold works well after K-Means reduces palette to ~5 types —
          // the dominant type in a 27-voxel neighborhood needs ~7 votes to win.
          // This protects 1-block-wide continuous lines (window frames, trim, pipes)
          // which have ≥2 neighbors of their own type — they're part of a feature, not noise.
          const centerCount = neighborCounts.get(center) ?? 0;
          if (majorityBlock !== center && majorityCount > totalNeighbors * 0.35 && centerCount < 2) {
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

/**
 * Approximate luminance for Minecraft blocks (0 = black, 1 = white).
 * Used by carveFacadeShadows to identify shadow/depth regions.
 * Values are empirical approximations of the block's average visual brightness.
 */
const BLOCK_LUMINANCE = new Map<string, number>([
  // Very dark (shadow indicators — likely recesses, balconies, windows)
  ['minecraft:blackstone', 0.10],
  ['minecraft:deepslate_bricks', 0.15],
  ['minecraft:polished_deepslate', 0.18],
  ['minecraft:polished_blackstone', 0.15],
  ['minecraft:nether_bricks', 0.15],
  ['minecraft:black_stained_glass', 0.05],
  // Dark (could be shadow or material)
  ['minecraft:gray_stained_glass', 0.25],
  ['minecraft:gray_concrete', 0.30],
  ['minecraft:brown_terracotta', 0.30],
  ['minecraft:green_concrete', 0.30],
  ['minecraft:stone', 0.35],
  ['minecraft:andesite', 0.35],
  ['minecraft:stone_bricks', 0.38],
  // Medium (structural/material)
  ['minecraft:polished_andesite', 0.42],
  ['minecraft:smooth_stone', 0.45],
  ['minecraft:cobblestone', 0.35],
  ['minecraft:iron_block', 0.70],
  ['minecraft:light_gray_concrete', 0.55],
  // Light (wall material)
  ['minecraft:birch_planks', 0.70],
  ['minecraft:end_stone_bricks', 0.75],
  ['minecraft:smooth_sandstone', 0.80],
  ['minecraft:sandstone', 0.80],
  ['minecraft:smooth_quartz', 0.90],
  ['minecraft:quartz_block', 0.90],
  ['minecraft:white_concrete', 0.95],
  // Terracotta variants
  ['minecraft:red_terracotta', 0.30],
  ['minecraft:orange_terracotta', 0.40],
  ['minecraft:bricks', 0.35],
  ['minecraft:red_concrete', 0.30],
]);

/**
 * Get block luminance (0-1). Returns 0.5 for unknown blocks.
 */
function blockLuminance(block: string): number {
  return BLOCK_LUMINANCE.get(block) ?? 0.5;
}

/**
 * Carve facade shadows into depth features using block luminance.
 *
 * Photogrammetry meshes close up balconies and recesses because the depth
 * scanner can't measure inside them. But the texture captures the shadows
 * correctly — dark pixels where there should be voids. This function
 * converts that color information back into geometry:
 *
 * For each block in the facade zone (≤facadeDepth from any AABB edge):
 * - If block luminance < threshold → replace with AIR (carve shadow into void)
 * - If block luminance ≥ threshold → keep solid (stucco wall / railing)
 *
 * This must run BEFORE palette constraint so the original dark colors
 * (which carry depth information) haven't been remapped yet.
 *
 * @param grid            Source BlockGrid (modified in place)
 * @param facadeDepth     Depth from AABB edges defining the facade zone (default: 4)
 * @param lumThreshold    Luminance below which blocks are shadow candidates (default: 0.45)
 * @param minDarkNeighbors Minimum dark XZ-plane neighbors (of 4) required to carve (default: 2).
 *                         Acts as despeckle filter — only carves connected dark clusters,
 *                         not isolated single-block noise. Creates clean rectangular voids.
 * @returns Number of blocks carved to air
 */
export function carveFacadeShadows(
  grid: BlockGrid,
  facadeDepth = 4,
  lumThreshold = 0.45,
  minDarkNeighbors = 2,
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let carved = 0;

  // XZ-plane 4-connected neighbors
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

  for (let y = 0; y < height; y++) {
    // Find AABB of all solid voxels in this layer
    let minX = width, maxX = -1, minZ = length, maxZ = -1;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
    if (maxX < 0) continue; // Empty layer

    // Pass 1: build dark mask for this layer's facade zone
    const layerW = maxX - minX + 1;
    const layerL = maxZ - minZ + 1;
    const isDark = new Uint8Array(layerW * layerL);
    const inFacade = new Uint8Array(layerW * layerL);

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;

        const edgeDist = Math.min(x - minX, maxX - x, z - minZ, maxZ - z);
        if (edgeDist >= facadeDepth) continue;

        const lx = x - minX;
        const lz = z - minZ;
        const idx = lz * layerW + lx;
        inFacade[idx] = 1;

        if (blockLuminance(block) < lumThreshold) {
          isDark[idx] = 1;
        }
      }
    }

    // Pass 2: carve dark blocks that have enough dark neighbors (despeckle).
    // This ensures only connected dark clusters get carved — isolated dark
    // specks on stucco walls are left solid, preventing "termite damage."
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const lx = x - minX;
        const lz = z - minZ;
        const idx = lz * layerW + lx;
        if (!inFacade[idx] || !isDark[idx]) continue;

        // Count dark 4-connected neighbors in the XZ plane
        let darkNeighbors = 0;
        for (const [dx, dz] of DIRS) {
          const nx = lx + dx;
          const nz = lz + dz;
          if (nx < 0 || nx >= layerW || nz < 0 || nz >= layerL) continue;
          if (isDark[nz * layerW + nx]) darkNeighbors++;
        }

        if (darkNeighbors >= minDarkNeighbors) {
          grid.set(x, y, z, AIR);
          carved++;
        }
      }
    }
  }

  return carved;
}

/**
 * Vertical median filter ("gravity filter") for facade columns.
 *
 * After carving, facade voids have ragged/organic edges. Architecture needs
 * straight vertical lines. This filter enforces vertical consistency:
 *
 * For each facade column (fixed X, Z position, varying Y):
 * - Examine a window of `windowSize` vertical blocks
 * - If majority are air → force center to air
 * - If majority are solid → force center to solid (nearest neighbor block)
 *
 * This straightens wobbly window/balcony edges into clean vertical lines
 * and removes floating single-block artifacts.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param facadeDepth   Depth from AABB edges defining facade zone (default: 4)
 * @param windowSize    Vertical window for median vote (default: 5 = 2 above + 2 below)
 * @returns Number of blocks changed
 */
export function verticalRectify(
  grid: BlockGrid,
  facadeDepth = 4,
  windowSize = 5,
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  const halfW = Math.floor(windowSize / 2);
  let changed = 0;

  // First compute the global AABB per Y-layer for facade zone detection,
  // then process vertical columns.
  // We need per-layer AABB to know which cells are in the facade zone.
  const layerAABB: Array<{ minX: number; maxX: number; minZ: number; maxZ: number } | null> =
    new Array(height).fill(null);

  for (let y = 0; y < height; y++) {
    let minX = width, maxX = -1, minZ = length, maxZ = -1;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
    if (maxX >= 0) {
      layerAABB[y] = { minX, maxX, minZ, maxZ };
    }
  }

  // Snapshot the grid before filtering (so changes don't cascade)
  const snap: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        snap[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  // Process each vertical column (x, z)
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      // Check if this column is in the facade zone for ANY layer
      let inFacade = false;
      for (let y = 0; y < height; y++) {
        const aabb = layerAABB[y];
        if (!aabb) continue;
        const edgeDist = Math.min(
          x - aabb.minX, aabb.maxX - x,
          z - aabb.minZ, aabb.maxZ - z,
        );
        if (edgeDist >= 0 && edgeDist < facadeDepth) {
          inFacade = true;
          break;
        }
      }
      if (!inFacade) continue;

      // Apply vertical median filter to this column
      for (let y = 0; y < height; y++) {
        const aabb = layerAABB[y];
        if (!aabb) continue;

        // Check if this specific cell is in the facade zone
        const edgeDist = Math.min(
          x - aabb.minX, aabb.maxX - x,
          z - aabb.minZ, aabb.maxZ - z,
        );
        if (edgeDist < 0 || edgeDist >= facadeDepth) continue;

        // Count air vs solid in vertical window
        let airCount = 0;
        let solidCount = 0;
        let bestBlock = AIR;
        let bestBlockCount = 0;
        const blockCounts = new Map<string, number>();

        for (let dy = -halfW; dy <= halfW; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          const block = snap[(ny * length + z) * width + x];
          if (block === AIR) {
            airCount++;
          } else {
            solidCount++;
            const c = (blockCounts.get(block) ?? 0) + 1;
            blockCounts.set(block, c);
            if (c > bestBlockCount) {
              bestBlockCount = c;
              bestBlock = block;
            }
          }
        }

        const currentBlock = snap[(y * length + z) * width + x];
        const majority = Math.ceil(windowSize / 2);

        if (currentBlock === AIR && solidCount >= majority) {
          // Majority solid → fill this air cell
          grid.set(x, y, z, bestBlock);
          changed++;
        } else if (currentBlock !== AIR && airCount >= majority) {
          // Majority air → carve this solid cell
          grid.set(x, y, z, AIR);
          changed++;
        }
      }
    }
  }

  return changed;
}

/**
 * Glaze facade air voids — place window blocks where carved air meets the
 * solid core behind it.
 *
 * After carving, facade voids are empty air. The real building has glass windows
 * at the back of these recesses. This pass finds air blocks in the facade zone
 * that border a solid core block (deeper than facadeDepth) and places window
 * material at that boundary — the "glass backplane" of each recess.
 *
 * Additionally, converts any remaining air voids in the facade zone that are
 * fully surrounded by solid blocks into window glass (enclosed void = window).
 *
 * @param grid           Source BlockGrid (modified in place)
 * @param facadeDepth    Depth from AABB edges (facade zone limit, default: 4)
 * @param windowBlock    Block to use for glazing (default: minecraft:gray_stained_glass)
 * @returns Number of blocks glazed
 */
export function glazeBackplane(
  grid: BlockGrid,
  maxDepth = 8,
  windowBlock = 'minecraft:gray_concrete',
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let glazed = 0;

  // Per-face deep raycast: cast rays inward from each AABB face.
  // When a ray crosses solid → air → solid (void in the wall), place a window
  // block at the last air position before the back wall. This restores
  // "window" appearance at the back of carved balcony/recess voids.
  //
  // Ray phases per cast:
  // 1. Skip leading air (outside building)
  // 2. Skip leading solid (outer wall)
  // 3. Traverse air (carved void / balcony)
  // 4. Hit solid (back wall) → place window at last air position
  // Only processes the first void per ray to avoid filling deep interiors.

  for (let y = 0; y < height; y++) {
    // Find AABB for this layer
    let minX = width, maxX = -1, minZ = length, maxZ = -1;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
    if (maxX < 0) continue;

    // Define 4 face directions: [start, step, perpAxis, perpRange]
    // For each face, cast rays from the face inward
    const faces: Array<{
      perpIter: () => Generator<[number, number]>;
      rayStart: (p: number, q: number) => [number, number];
      rayStep: [number, number]; // [dx, dz]
    }> = [
      { // Left face (X=minX, cast +X)
        perpIter: function*() { for (let z = minZ; z <= maxZ; z++) yield [0, z]; },
        rayStart: (_p, z) => [minX, z],
        rayStep: [1, 0],
      },
      { // Right face (X=maxX, cast -X)
        perpIter: function*() { for (let z = minZ; z <= maxZ; z++) yield [0, z]; },
        rayStart: (_p, z) => [maxX, z],
        rayStep: [-1, 0],
      },
      { // Front face (Z=minZ, cast +Z)
        perpIter: function*() { for (let x = minX; x <= maxX; x++) yield [x, 0]; },
        rayStart: (x, _q) => [x, minZ],
        rayStep: [0, 1],
      },
      { // Back face (Z=maxZ, cast -Z)
        perpIter: function*() { for (let x = minX; x <= maxX; x++) yield [x, 0]; },
        rayStart: (x, _q) => [x, maxZ],
        rayStep: [0, -1],
      },
    ];

    for (const face of faces) {
      for (const [p, q] of face.perpIter()) {
        const [sx, sz] = face.rayStart(p, q);
        const [dx, dz] = face.rayStep;

        let phase = 0; // 0=outside, 1=wall, 2=void
        let lastAirX = -1, lastAirZ = -1;

        for (let d = 0; d < maxDepth; d++) {
          const rx = sx + dx * d;
          const rz = sz + dz * d;
          if (rx < 0 || rx >= width || rz < 0 || rz >= length) break;

          const block = grid.get(rx, y, rz);
          const isAir = block === AIR;

          if (phase === 0) {
            // Phase 0: outside building — skip air, advance to wall on first solid
            if (!isAir) phase = 1;
          } else if (phase === 1) {
            // Phase 1: traversing outer wall — skip solid, enter void on first air
            if (isAir) {
              phase = 2;
              lastAirX = rx;
              lastAirZ = rz;
            }
          } else if (phase === 2) {
            // Phase 2: traversing void — track last air position
            if (isAir) {
              lastAirX = rx;
              lastAirZ = rz;
            } else {
              // Hit back wall — place window at last air position
              if (lastAirX >= 0 && grid.get(lastAirX, y, lastAirZ) === AIR) {
                grid.set(lastAirX, y, lastAirZ, windowBlock);
                glazed++;
              }
              break; // Done with this ray
            }
          }
        }
      }
    }
  }

  return glazed;
}

/**
 * Horizontal median filter ("lintel filter") for facade rows.
 *
 * Complement to verticalRectify — cleans horizontal edges (floors/ceilings of
 * balconies). Applies 1D median vote along the X-axis for each facade row
 * (fixed Y, Z). Uses a smaller window (3) than the vertical filter (5) to
 * avoid closing narrow features like fire escape slots.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param facadeDepth   Depth from AABB edges defining facade zone (default: 4)
 * @param windowSize    Horizontal window for median vote (default: 3 = 1 left + 1 right)
 * @returns Number of blocks changed
 */
export function horizontalRectify(
  grid: BlockGrid,
  facadeDepth = 4,
  windowSize = 3,
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  const halfW = Math.floor(windowSize / 2);
  let changed = 0;

  // Per-layer AABB for facade zone detection
  const layerAABB: Array<{ minX: number; maxX: number; minZ: number; maxZ: number } | null> =
    new Array(height).fill(null);

  for (let y = 0; y < height; y++) {
    let minX = width, maxX = -1, minZ = length, maxZ = -1;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
    }
    if (maxX >= 0) layerAABB[y] = { minX, maxX, minZ, maxZ };
  }

  // Snapshot before filtering
  const snap: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        snap[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  // Process each horizontal row (y, z) along X-axis
  for (let y = 0; y < height; y++) {
    const aabb = layerAABB[y];
    if (!aabb) continue;

    for (let z = aabb.minZ; z <= aabb.maxZ; z++) {
      for (let x = aabb.minX; x <= aabb.maxX; x++) {
        const edgeDist = Math.min(
          x - aabb.minX, aabb.maxX - x,
          z - aabb.minZ, aabb.maxZ - z,
        );
        if (edgeDist >= facadeDepth) continue;

        // Count air vs solid in horizontal X window
        let airCount = 0;
        let solidCount = 0;
        let bestBlock = AIR;
        let bestBlockCount = 0;
        const blockCounts = new Map<string, number>();

        for (let dx = -halfW; dx <= halfW; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const block = snap[(y * length + z) * width + nx];
          if (block === AIR) {
            airCount++;
          } else {
            solidCount++;
            const c = (blockCounts.get(block) ?? 0) + 1;
            blockCounts.set(block, c);
            if (c > bestBlockCount) {
              bestBlockCount = c;
              bestBlock = block;
            }
          }
        }

        const currentBlock = snap[(y * length + z) * width + x];
        const majority = Math.ceil(windowSize / 2);

        if (currentBlock === AIR && solidCount >= majority) {
          grid.set(x, y, z, bestBlock);
          changed++;
        } else if (currentBlock !== AIR && airCount >= majority) {
          grid.set(x, y, z, AIR);
          changed++;
        }
      }
    }
  }

  return changed;
}

/**
 * "Cookie Cutter" solidification: one global AABB per Y-layer, solid core +
 * raw scan mask on facades.
 *
 * Unlike rectangularize (which splits into connected components and can fracture
 * a single building), this treats the entire layer as ONE volume:
 *
 * 1. Compute the AABB of all non-air voxels in the layer
 * 2. Core zone (>facadeDepth from all AABB edges): fill with dominant block
 * 3. Facade zone (≤facadeDepth from any edge): leave original scan data untouched.
 *    If the scan says air → keep air (preserving balconies, recesses, windows).
 *    If the scan says solid → keep the block.
 *
 * This produces buildings with solid interiors and architecturally accurate
 * facade depth, without the connected-component splitting that fractures
 * buildings through fire escapes or thin features.
 *
 * @param grid         Source BlockGrid (modified in place)
 * @param facadeDepth  Depth from AABB edges to preserve raw scan data (default: 4 blocks)
 * @param minFill      Min fraction of layer filled to process (skip sparse layers, default: 0.01)
 * @returns Number of core voxels filled
 */
export function solidifyCore(grid: BlockGrid, facadeDepth = 4, minFill = 0.01): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let totalFilled = 0;

  for (let y = 0; y < height; y++) {
    // Find AABB of all solid voxels in this layer
    let minX = width, maxX = -1, minZ = length, maxZ = -1;
    const counts = new Map<string, number>();
    let solidCount = 0;

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;
        solidCount++;
        counts.set(block, (counts.get(block) ?? 0) + 1);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }

    // Skip sparse layers (terrain remnants)
    if (solidCount < width * length * minFill) continue;
    if (maxX < 0) continue; // No solid voxels

    // Find the dominant (most common) block for this layer
    let dominant = AIR;
    let maxC = 0;
    for (const [b, c] of counts) {
      if (c > maxC) { dominant = b; maxC = c; }
    }

    // Fill core zone: cells inside the AABB that are more than facadeDepth
    // from all four edges. Facade zone cells are left completely untouched.
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (grid.get(x, y, z) !== AIR) continue; // Already solid

        // Distance from this cell to nearest AABB edge
        const edgeDist = Math.min(
          x - minX,
          maxX - x,
          z - minZ,
          maxZ - z,
        );

        // Only fill core zone — facade zone keeps raw scan data
        if (edgeDist >= facadeDepth) {
          grid.set(x, y, z, dominant);
          totalFilled++;
        }
      }
    }
  }

  return totalFilled;
}

/**
 * Replace solid facade blocks in a central vertical strip with thin bars
 * to simulate a fire escape or other metalwork feature.
 *
 * Identifies the center X range (configurable %) and replaces solid blocks
 * in the facade zone with iron_bars if the block has air on the outward side
 * (i.e., it's a protruding element, not the back wall). Converts "chunky noise"
 * from photogrammetry into thin, architectural metalwork.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param facadeDepth   Facade zone depth from edges
 * @param centerStart   Start of center zone as fraction of width (0-1, default: 0.38)
 * @param centerEnd     End of center zone as fraction of width (0-1, default: 0.62)
 * @param barBlock      Block to use for the bars (default: iron_bars)
 * @returns Number of blocks converted to bars
 */
export function fireEscapeFilter(
  grid: BlockGrid,
  facadeDepth = 4,
  centerStart = 0.38,
  centerEnd = 0.62,
  barBlock = 'minecraft:iron_bars',
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let converted = 0;

  // Absolute X range for the center zone
  const xMin = Math.floor(width * centerStart);
  const xMax = Math.ceil(width * centerEnd);

  for (let y = 0; y < height; y++) {
    // Per-layer AABB
    let lMinX = width, lMaxX = -1, lMinZ = length, lMaxZ = -1;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          if (x < lMinX) lMinX = x;
          if (x > lMaxX) lMaxX = x;
          if (z < lMinZ) lMinZ = z;
          if (z > lMaxZ) lMaxZ = z;
        }
      }
    }
    if (lMaxX < 0) continue;

    for (let z = lMinZ; z <= lMaxZ; z++) {
      for (let x = xMin; x <= xMax; x++) {
        if (x < lMinX || x > lMaxX) continue;
        const block = grid.get(x, y, z);
        if (block === AIR || block === barBlock) continue;

        const edgeDist = Math.min(
          x - lMinX, lMaxX - x,
          z - lMinZ, lMaxZ - z,
        );
        if (edgeDist >= facadeDepth) continue; // Skip core

        // Check if the outward direction (toward nearest edge) has air.
        // If so, this block is a protruding element → convert to bars.
        const dLeft = x - lMinX;
        const dRight = lMaxX - x;
        const dFront = z - lMinZ;
        const dBack = lMaxZ - z;

        let outX = x, outZ = z;
        if (dLeft <= dRight && dLeft <= dFront && dLeft <= dBack) outX = x - 1;
        else if (dRight <= dLeft && dRight <= dFront && dRight <= dBack) outX = x + 1;
        else if (dFront <= dBack) outZ = z - 1;
        else outZ = z + 1;

        if (outX < 0 || outX >= width || outZ < 0 || outZ >= length) continue;
        if (grid.get(outX, y, outZ) === AIR) {
          // Create horizontal platform bands (every 3 Y-levels) to simulate
          // fire escape landings. Between platforms, leave the wall material
          // so the fire escape reads as horizontal stripes, not a solid column.
          if (y % 3 === 0) {
            grid.set(x, y, z, barBlock);
            converted++;
          }
        }
      }
    }
  }

  return converted;
}

/**
 * Add a Spanish/Mediterranean roof cornice to the top of the building.
 *
 * Scans the height map to find the roofline, then adds:
 * 1. A clay tile cap (bricks/terracotta) replacing the topmost wall blocks
 * 2. A 1-block overhang (eave) protruding outward from perimeter edges
 *
 * This breaks the flat-top box silhouette that is common in voxelized
 * photogrammetry and adds the architectural "hat" that defines the style.
 *
 * @param grid       Source BlockGrid (modified in place)
 * @param tileBlock  Block for clay roof tiles (default: bricks)
 * @param eaveBlock  Block for wooden eave overhang (default: spruce_planks)
 * @returns          Number of blocks placed/changed
 */

// ─── Facade Homogeneity (v74) ──────────────────────────────────────────────

export type FacadeDir = '+x' | '-x' | '+z' | '-z';

/**
 * Per-face minority block collapse — forces facade surfaces toward homogeneous
 * materials. For each exterior face direction (+x/-x/+z/-z), blocks that appear
 * in < minPct of that face's surface are replaced with the nearest majority block
 * found on the same face at the same Y level, or the face's global mode.
 *
 * This pushes heterogeneous facades (54% dominant) toward Flatiron-level
 * homogeneity (70%+), which VLMs perceive as "clean, complete surfaces" (C=3).
 *
 * Run AFTER glazeDarkWindows + modeFilter (so glass is already placed and protected).
 */
export function homogenizeFacadesByFace(
  grid: BlockGrid,
  minPct = 0.05,
  searchRadius = 6,
  protectedBlocks?: Set<string>,
): number {
  const AIR = 'minecraft:air';
  const MIN_SAMPLES = 100;

  // Blocks that should never be replaced (glass, trim accents)
  const prot = new Set<string>([
    AIR,
    'minecraft:gray_stained_glass', 'minecraft:glass', 'minecraft:glass_pane',
    'minecraft:iron_bars', 'minecraft:smooth_stone_slab',
  ]);
  if (protectedBlocks) for (const b of protectedBlocks) prot.add(b);

  const { width, height, length } = grid;
  const faces: FacadeDir[] = ['+x', '-x', '+z', '-z'];
  let totalReplaced = 0;

  // For each face direction, collect exterior surface voxels
  for (const dir of faces) {
    // Collect surface positions: solid block whose neighbor in dir is air
    const surface: Array<{ x: number; y: number; z: number; b: string }> = [];
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const b = grid.get(x, y, z);
          if (b === AIR || prot.has(b)) continue;

          let isExterior = false;
          if (dir === '+x') isExterior = x === width - 1 || grid.get(x + 1, y, z) === AIR;
          else if (dir === '-x') isExterior = x === 0 || grid.get(x - 1, y, z) === AIR;
          else if (dir === '+z') isExterior = z === length - 1 || grid.get(x, y, z + 1) === AIR;
          else isExterior = z === 0 || grid.get(x, y, z - 1) === AIR;

          if (isExterior) surface.push({ x, y, z, b });
        }
      }
    }

    if (surface.length < MIN_SAMPLES) continue;

    // Build frequency histogram for this face
    const freq = new Map<string, number>();
    for (const p of surface) freq.set(p.b, (freq.get(p.b) ?? 0) + 1);

    // Find face mode (most frequent block)
    let faceMode = '';
    let faceModeCount = 0;
    for (const [b, c] of freq) {
      if (c > faceModeCount) { faceMode = b; faceModeCount = c; }
    }
    if (!faceMode) continue;

    // Identify minority blocks (< minPct of this face)
    const threshold = surface.length * minPct;
    const minority = new Set<string>();
    for (const [b, c] of freq) {
      if (c < threshold) minority.add(b);
    }
    if (minority.size === 0) continue;

    // Replace minority blocks with nearest majority on same face + same Y
    for (const p of surface) {
      if (!minority.has(p.b)) continue;

      // Search outward on the face plane (same Y) for nearest non-minority block
      let bestBlock: string | null = null;
      for (let r = 1; r <= searchRadius && !bestBlock; r++) {
        for (let d = -r; d <= r && !bestBlock; d++) {
          // For x-faces, search along z axis. For z-faces, search along x axis.
          let nx = p.x, nz = p.z;
          if (dir === '+x' || dir === '-x') nz = p.z + d;
          else nx = p.x + d;

          if (!grid.inBounds(nx, p.y, nz)) continue;
          const nb = grid.get(nx, p.y, nz);
          if (nb === AIR || prot.has(nb) || minority.has(nb)) continue;

          // Verify it's also on the same face surface
          let neighborIsExterior = false;
          if (dir === '+x') neighborIsExterior = nx === width - 1 || grid.get(nx + 1, p.y, nz) === AIR;
          else if (dir === '-x') neighborIsExterior = nx === 0 || grid.get(nx - 1, p.y, nz) === AIR;
          else if (dir === '+z') neighborIsExterior = nz === length - 1 || grid.get(nx, p.y, nz + 1) === AIR;
          else neighborIsExterior = nz === 0 || grid.get(nx, p.y, nz - 1) === AIR;

          if (neighborIsExterior) bestBlock = nb;
        }
      }

      if (!bestBlock) bestBlock = faceMode;

      grid.set(p.x, p.y, p.z, bestBlock);
      totalReplaced++;
    }
  }

  return totalReplaced;
}

// ─── Footprint Edge Straightening (v74) ─────────────────────────────────────

/**
 * Straighten jagged stair-step edges on near-rectangular building footprints.
 * For each Y layer, computes the silhouette edge traces (leftmost/rightmost solid
 * per z-row, and top/bottom solid per x-column), applies a median filter to smooth
 * stair-steps, then fills or clears the 1-2 block band to match.
 *
 * Only shifts edges by up to maxShift blocks to avoid distorting real architectural
 * features (balconies, setbacks). Run after fill but before facade smoothing.
 */
export function straightenFootprintEdges(
  grid: BlockGrid,
  maxShift = 2,
  windowRadius = 2,
  wallBlock?: string,
): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;
  let changed = 0;

  // Determine dominant wall block from bottom 25% of height
  const wallDom = wallBlock ?? (() => {
    const counts = new Map<string, number>();
    const maxY = Math.floor(height * 0.25);
    for (let y = 0; y <= maxY; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const b = grid.get(x, y, z);
          if (b !== AIR) counts.set(b, (counts.get(b) ?? 0) + 1);
        }
      }
    }
    let best = AIR;
    let bestC = 0;
    for (const [b, c] of counts) { if (c > bestC) { best = b; bestC = c; } }
    return best;
  })();

  // Median of an array (handles NaN by filtering)
  function median(arr: number[]): number {
    const valid = arr.filter(v => v >= 0);
    if (valid.length === 0) return -1;
    valid.sort((a, b) => a - b);
    return valid[Math.floor(valid.length / 2)];
  }

  // Process each Y layer
  for (let y = 0; y < height; y++) {
    // Check if this layer has enough blocks to be worth straightening
    let layerCount = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) layerCount++;
      }
    }
    if (layerCount < 20) continue; // Skip sparse layers

    // Compute left (min-x) and right (max-x) traces for each z
    const leftTrace = new Int32Array(length).fill(-1);
    const rightTrace = new Int32Array(length).fill(-1);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          if (leftTrace[z] < 0) leftTrace[z] = x;
          rightTrace[z] = x;
        }
      }
    }

    // Median-filter the traces
    for (let z = 0; z < length; z++) {
      if (leftTrace[z] < 0) continue;

      // Collect window for left trace
      const leftWindow: number[] = [];
      const rightWindow: number[] = [];
      for (let dz = -windowRadius; dz <= windowRadius; dz++) {
        const nz = z + dz;
        if (nz >= 0 && nz < length) {
          if (leftTrace[nz] >= 0) leftWindow.push(leftTrace[nz]);
          if (rightTrace[nz] >= 0) rightWindow.push(rightTrace[nz]);
        }
      }

      const newLeft = median(leftWindow);
      const newRight = median(rightWindow);

      // Apply left edge correction (within maxShift)
      if (newLeft >= 0 && Math.abs(newLeft - leftTrace[z]) <= maxShift && newLeft !== leftTrace[z]) {
        if (newLeft < leftTrace[z]) {
          // Fill inward (extend building edge)
          for (let x = newLeft; x < leftTrace[z]; x++) {
            if (grid.get(x, y, z) === AIR) { grid.set(x, y, z, wallDom); changed++; }
          }
        } else {
          // Clear outward (retract building edge)
          for (let x = leftTrace[z]; x < newLeft; x++) {
            if (grid.get(x, y, z) !== AIR) { grid.set(x, y, z, AIR); changed++; }
          }
        }
      }

      // Apply right edge correction
      if (newRight >= 0 && Math.abs(newRight - rightTrace[z]) <= maxShift && newRight !== rightTrace[z]) {
        if (newRight > rightTrace[z]) {
          for (let x = rightTrace[z] + 1; x <= newRight; x++) {
            if (grid.get(x, y, z) === AIR) { grid.set(x, y, z, wallDom); changed++; }
          }
        } else {
          for (let x = newRight + 1; x <= rightTrace[z]; x++) {
            if (grid.get(x, y, z) !== AIR) { grid.set(x, y, z, AIR); changed++; }
          }
        }
      }
    }

    // Same for front/back traces (min-z/max-z per x column)
    const frontTrace = new Int32Array(width).fill(-1);
    const backTrace = new Int32Array(width).fill(-1);
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < length; z++) {
        if (grid.get(x, y, z) !== AIR) {
          if (frontTrace[x] < 0) frontTrace[x] = z;
          backTrace[x] = z;
        }
      }
    }

    for (let x = 0; x < width; x++) {
      if (frontTrace[x] < 0) continue;

      const frontWindow: number[] = [];
      const backWindow: number[] = [];
      for (let dx = -windowRadius; dx <= windowRadius; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < width) {
          if (frontTrace[nx] >= 0) frontWindow.push(frontTrace[nx]);
          if (backTrace[nx] >= 0) backWindow.push(backTrace[nx]);
        }
      }

      const newFront = median(frontWindow);
      const newBack = median(backWindow);

      if (newFront >= 0 && Math.abs(newFront - frontTrace[x]) <= maxShift && newFront !== frontTrace[x]) {
        if (newFront < frontTrace[x]) {
          for (let z = newFront; z < frontTrace[x]; z++) {
            if (grid.get(x, y, z) === AIR) { grid.set(x, y, z, wallDom); changed++; }
          }
        } else {
          for (let z = frontTrace[x]; z < newFront; z++) {
            if (grid.get(x, y, z) !== AIR) { grid.set(x, y, z, AIR); changed++; }
          }
        }
      }

      if (newBack >= 0 && Math.abs(newBack - backTrace[x]) <= maxShift && newBack !== backTrace[x]) {
        if (newBack > backTrace[x]) {
          for (let z = backTrace[x] + 1; z <= newBack; z++) {
            if (grid.get(x, y, z) === AIR) { grid.set(x, y, z, wallDom); changed++; }
          }
        } else {
          for (let z = newBack + 1; z <= backTrace[x]; z++) {
            if (grid.get(x, y, z) !== AIR) { grid.set(x, y, z, AIR); changed++; }
          }
        }
      }
    }
  }

  return changed;
}

/**
 * Add a hip/pyramid roof by stacking progressively inset footprints.
 * Each layer erodes the XZ footprint by 1 block and places it 1 Y higher.
 * Creates a natural sloped roof from any footprint shape (triangles, rectangles, L-shapes).
 *
 * @param grid       Source BlockGrid (modified in place)
 * @param roofBlock  Block for roof surface (default: same as topmost layer's dominant block)
 * @param maxLayers  Maximum number of roof layers to add (default: 15)
 * @returns          Number of blocks placed
 */
export function addPeakedRoof(
  grid: BlockGrid,
  roofBlock?: string,
  maxLayers = 15,
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let placed = 0;

  // Find the highest non-air Y for each (x, z) — the "roof surface"
  const heightMap = new Int32Array(width * length).fill(-1);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) {
          heightMap[z * width + x] = y;
          break;
        }
      }
    }
  }

  // Find the max height (roof level) and dominant roof block
  let maxH = 0;
  const blockCounts = new Map<string, number>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightMap[z * width + x];
      if (h > maxH) maxH = h;
    }
  }
  // Sample blocks at the top layer to find dominant roof block
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightMap[z * width + x];
      if (h >= maxH - 2) { // top 3 layers
        const b = grid.get(x, h, z);
        if (b !== AIR) blockCounts.set(b, (blockCounts.get(b) ?? 0) + 1);
      }
    }
  }
  const dominantRoof = roofBlock ?? [...blockCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'minecraft:andesite';

  // Build roof layers by iteratively eroding the footprint
  // Start with the top-layer footprint (all positions at maxH or within 2 blocks of it)
  let currentFootprint = new Set<number>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightMap[z * width + x];
      if (h >= maxH - 2) { // within 2 blocks of top
        currentFootprint.add(z * width + x);
      }
    }
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

  for (let layer = 0; layer < maxLayers; layer++) {
    // Erode: remove boundary voxels (those touching air/outside)
    const eroded = new Set<number>();
    for (const idx of currentFootprint) {
      const x = idx % width;
      const z = Math.floor(idx / width);
      let isBoundary = false;
      for (const [dx, dz] of DIRS) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= length) {
          isBoundary = true;
          break;
        }
        if (!currentFootprint.has(nz * width + nx)) {
          isBoundary = true;
          break;
        }
      }
      if (!isBoundary) {
        eroded.add(idx);
      }
    }

    if (eroded.size === 0) break; // Fully eroded — peak reached

    // Place roof blocks at maxH + 1 + layer for the eroded footprint
    const placeY = maxH + 1 + layer;
    if (placeY >= 256) break; // MC height limit

    // Expand grid height if needed (BlockGrid.expandHeight adds air layers on top)
    if (placeY >= grid.height) {
      grid.expandHeight(placeY + maxLayers + 1);
    }

    for (const idx of eroded) {
      const x = idx % width;
      const z = Math.floor(idx / width);
      grid.set(x, placeY, z, dominantRoof);
      placed++;
    }

    currentFootprint = eroded;
  }

  return placed;
}

export function addRoofCornice(
  grid: BlockGrid,
  tileBlock = 'minecraft:bricks',
  eaveBlock = 'minecraft:spruce_planks',
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let placed = 0;

  // Build height map: for each (x, z) find highest non-air Y
  const heightMap = new Int32Array(width * length).fill(-1);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) {
          heightMap[z * width + x] = y;
          break;
        }
      }
    }
  }

  // Find global roof level: the mode (most frequent) of the height map,
  // excluding ground-level and air columns. This is the building's roofline.
  const hCounts = new Map<number, number>();
  for (let i = 0; i < heightMap.length; i++) {
    const h = heightMap[i];
    if (h > 2) hCounts.set(h, (hCounts.get(h) ?? 0) + 1);
  }
  let roofY = -1;
  let roofCount = 0;
  for (const [h, c] of hCounts) {
    if (c > roofCount) { roofY = h; roofCount = c; }
  }
  if (roofY < 3) return 0; // No clear roofline

  // Phase 1: Replace top blocks at roof level with clay tile
  // Only replace blocks that ARE at the roof level (not recessed lower areas)
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightMap[z * width + x];
      if (h === roofY && grid.get(x, h, z) !== AIR) {
        grid.set(x, h, z, tileBlock);
        placed++;
      }
    }
  }

  // Phase 2: Add eave overhang — place blocks 1 position outward from the
  // roof perimeter at roof level. An edge block is one at roofY where at
  // least one horizontal neighbor is air or out of bounds.
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightMap[z * width + x];
      if (h !== roofY) continue;

      // Check if this is a perimeter block (has air neighbor at roof level)
      for (const [dx, dz] of directions) {
        const nx = x + dx;
        const nz = z + dz;
        const neighborIsAir =
          nx < 0 || nx >= width || nz < 0 || nz >= length ||
          grid.get(nx, roofY, nz) === AIR;

        if (neighborIsAir && nx >= 0 && nx < width && nz >= 0 && nz < length) {
          // Place eave at the air neighbor position if it's empty
          if (grid.get(nx, roofY, nz) === AIR) {
            grid.set(nx, roofY, nz, eaveBlock);
            placed++;
          }
        }
      }
    }
  }

  return placed;
}

/**
 * Remove small disconnected voxel clusters via 3D flood-fill connected-component analysis.
 *
 * Finds all connected components of non-air blocks (6-connected: face neighbors only),
 * keeps the largest component, and sets all blocks in smaller components to air.
 * This eliminates floating debris, stray voxels from photogrammetry noise, and
 * disconnected terrain fragments that aren't part of the main structure.
 *
 * @param grid      BlockGrid to clean up (modified in place)
 * @param minSize   Minimum voxel count to keep a component (default: 50).
 *                  Components smaller than this are removed regardless.
 *                  Set to 0 to only keep the single largest component.
 * @returns Number of blocks removed
 */
export function removeSmallComponents(grid: BlockGrid, minSize = 50): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;
  const total = width * height * length;

  // Component label for each voxel (0 = unlabeled, -1 = air)
  const labels = new Int32Array(total);
  const idx = (x: number, y: number, z: number) => (y * length + z) * width + x;

  // Mark air voxels
  for (let y = 0; y < height; y++)
    for (let z = 0; z < length; z++)
      for (let x = 0; x < width; x++)
        if (grid.get(x, y, z) === AIR) labels[idx(x, y, z)] = -1;

  // 6-connected neighbor offsets
  const offsets: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];

  // Flood-fill to find connected components
  let nextLabel = 1;
  const componentSizes = new Map<number, number>(); // label → voxel count

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, z);
        if (labels[i] !== 0) continue; // already labeled or air

        // BFS flood fill for this component
        const label = nextLabel++;
        let size = 0;
        const queue: [number, number, number][] = [[x, y, z]];
        labels[i] = label;

        while (queue.length > 0) {
          const [cx, cy, cz] = queue.pop()!;
          size++;

          for (const [dx, dy, dz] of offsets) {
            const nx = cx + dx;
            const ny = cy + dy;
            const nz = cz + dz;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
            const ni = idx(nx, ny, nz);
            if (labels[ni] !== 0) continue; // already labeled or air
            labels[ni] = label;
            queue.push([nx, ny, nz]);
          }
        }

        componentSizes.set(label, size);
      }
    }
  }

  // Find the largest component
  let largestLabel = 0;
  let largestSize = 0;
  for (const [label, size] of componentSizes) {
    if (size > largestSize) {
      largestSize = size;
      largestLabel = label;
    }
  }

  // Remove blocks in small components
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, z);
        const label = labels[i];
        if (label <= 0) continue; // air or unlabeled
        const size = componentSizes.get(label) ?? 0;
        // Remove if not the largest AND below minSize threshold
        if (label !== largestLabel && size < minSize) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Isolate the tallest structure from surrounding shorter buildings.
 *
 * For skyscrapers captured with photogrammetry, surrounding buildings are often
 * fused into the same mesh. This filter:
 * 1. Builds a height map (max occupied Y per XZ column)
 * 2. Samples the footprint at a fraction of max height (above surrounding buildings)
 * 3. Expands this footprint by a margin (to capture setbacks at lower levels)
 * 4. Removes blocks in columns outside the expanded footprint
 *
 * Only effective for buildings significantly taller than their surroundings.
 *
 * @param grid           Mutable BlockGrid
 * @param heightFraction Sample footprint at this fraction of max height (default 0.5)
 * @param expansion      Expand sampled footprint by this many blocks (default 10)
 * @returns Number of blocks removed
 */
export function isolateTallestStructure(grid: BlockGrid, heightFraction = 0.5, expansion = 10): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;

  // Find max occupied Y
  let maxOccupiedY = 0;
  for (let y = height - 1; y >= 0; y--) {
    let found = false;
    for (let x = 0; x < width && !found; x++)
      for (let z = 0; z < length && !found; z++)
        if (grid.get(x, y, z) !== AIR) { maxOccupiedY = y; found = true; }
    if (found) break;
  }

  if (maxOccupiedY < 20) {
    console.log(`Tower isolation: skipped (max height ${maxOccupiedY} < 20)`);
    return 0;
  }

  // Build height map (max Y per XZ column)
  const heightMap = new Uint16Array(width * length);
  let occupiedCols = 0;
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < length; z++) {
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) {
          heightMap[z * width + x] = y;
          occupiedCols++;
          break;
        }
      }
    }
  }

  // Compute median height of occupied columns
  const colHeights = Array.from(heightMap).filter(h => h > 0);
  colHeights.sort((a, b) => a - b);
  const medianH = colHeights[Math.floor(colHeights.length * 0.5)] || 0;

  // Only effective if tallest structure rises meaningfully above median surroundings
  // 1.25x threshold catches NYC skyscrapers surrounded by shorter midtown buildings
  if (maxOccupiedY < medianH * 1.25) {
    console.log(`Tower isolation: skipped (maxY ${maxOccupiedY} < median ${medianH} × 1.25 = ${Math.round(medianH * 1.25)})`);
    return 0;
  }

  // Per-layer approach: at each Y level, only keep blocks within expansion
  // distance of the actual occupied footprint at THAT level or any higher level.
  // This preserves the building's natural silhouette while trimming noise that's
  // spatially separated from the building at each height.
  //
  // Build cumulative top-down footprint: union of all layers from top to current Y.
  // This captures setbacks naturally (upper layers are narrower, lower layers wider).
  const cumulativeFootprint = new Uint8Array(width * length);
  let seedCount = 0;

  // First, count seed columns from top 25%
  const seedStartY = Math.floor(maxOccupiedY * heightFraction);
  for (let y = maxOccupiedY; y >= seedStartY; y--) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < length; z++) {
        if (!cumulativeFootprint[z * width + x] && grid.get(x, y, z) !== AIR) {
          cumulativeFootprint[z * width + x] = 1;
          seedCount++;
        }
      }
    }
  }

  if (seedCount === 0) return 0;

  // Keep only the largest connected component of the seed (2D 4-connected).
  // This prevents nearby tall buildings from leaking into the allowed mask.
  {
    const seedLabels = new Int32Array(width * length);
    let nextLabel = 1;
    const compSizes = new Map<number, number>();
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = z * width + x;
        if (!cumulativeFootprint[i] || seedLabels[i] !== 0) continue;
        const label = nextLabel++;
        let size = 0;
        const queue: [number, number][] = [[x, z]];
        seedLabels[i] = label;
        while (queue.length > 0) {
          const [cx, cz] = queue.pop()!;
          size++;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
            const ni = nz * width + nx;
            if (cumulativeFootprint[ni] && seedLabels[ni] === 0) {
              seedLabels[ni] = label;
              queue.push([nx, nz]);
            }
          }
        }
        compSizes.set(label, size);
      }
    }
    // Find largest component
    let bestLabel = 0, bestSize = 0;
    for (const [label, size] of compSizes) {
      if (size > bestSize) { bestSize = size; bestLabel = label; }
    }
    // Strip non-largest from seed
    let stripped = 0;
    for (let i = 0; i < width * length; i++) {
      if (cumulativeFootprint[i] && seedLabels[i] !== bestLabel) {
        cumulativeFootprint[i] = 0;
        stripped++;
      }
    }
    if (stripped > 0) {
      seedCount -= stripped;
      console.log(`Tower isolation: kept largest seed component (${bestSize} cols), stripped ${stripped} cols from ${compSizes.size - 1} other components`);
    }
  }

  // Dilate the top-portion footprint by expansion
  const allowed = new Uint8Array(width * length);
  const expSq = expansion * expansion;
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < length; z++) {
      if (!cumulativeFootprint[z * width + x]) continue;
      for (let dx = -expansion; dx <= expansion; dx++) {
        for (let dz = -expansion; dz <= expansion; dz++) {
          if (dx * dx + dz * dz > expSq) continue;
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
            allowed[nz * width + nx] = 1;
          }
        }
      }
    }
  }

  // Remove blocks outside the allowed mask at ALL heights
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (!allowed[z * width + x] && grid.get(x, y, z) !== AIR) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  console.log(`Tower isolation: seed Y≥${seedStartY}/${maxOccupiedY} (${seedCount} cols), expansion ${expansion} → removed ${removed} blocks`);
  return removed;
}

/**
 * Crop grid to keep only blocks within a given XZ radius from the center.
 *
 * Useful for isolating the central building when the capture radius grabs
 * neighboring structures. Uses circular (Euclidean) XZ distance from grid center.
 *
 * @param grid     Mutable BlockGrid
 * @param radius   Max XZ distance from center to keep (in blocks)
 * @returns Number of blocks removed
 */
export function cropToCenter(grid: BlockGrid, radius: number): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;
  const cx = width / 2;
  const cz = length / 2;
  const r2 = radius * radius;
  let removed = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz > r2) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Crop grid to a rectangular area centered on the grid center.
 * Unlike circular cropToCenter, this preserves straight edges and right angles
 * which is critical for building geometry appearance.
 *
 * @param grid     Mutable BlockGrid
 * @param radius   Half-width of the rectangle in blocks (same as cropToCenter's radius)
 * @returns Number of blocks removed
 */
export function cropToRect(grid: BlockGrid, radius: number): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;
  const cx = Math.floor(width / 2);
  const cz = Math.floor(length / 2);
  let removed = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        if (Math.abs(x - cx) > radius || Math.abs(z - cz) > radius) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Crop grid to an axis-aligned bounding box (AABB).
 * Unlike circular cropToCenter, this preserves rectangular/triangular shapes.
 * Keeps blocks within [minX..maxX, minZ..maxZ] and removes everything outside.
 *
 * @param grid     Mutable BlockGrid
 * @param minX     Min X boundary (inclusive)
 * @param maxX     Max X boundary (inclusive)
 * @param minZ     Min Z boundary (inclusive)
 * @param maxZ     Max Z boundary (inclusive)
 * @param margin   Extra blocks around the AABB to keep (default: 2)
 * @returns Number of blocks removed
 */
export function cropToAABB(
  grid: BlockGrid, minX: number, maxX: number, minZ: number, maxZ: number, margin = 2,
): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;
  const lo_x = Math.max(0, minX - margin);
  const hi_x = Math.min(width - 1, maxX + margin);
  const lo_z = Math.max(0, minZ - margin);
  const hi_z = Math.min(length - 1, maxZ + margin);
  let removed = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        if (x < lo_x || x > hi_x || z < lo_z || z > hi_z) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Remove ground plane and terrain below a building.
 *
 * For each XZ column, finds the lowest non-air Y ("ground height").
 * Computes the median ground height as the ground plane level.
 * Removes all blocks at or below (groundPlaneY + margin) for columns
 * whose ground height is within tolerance of the median.
 * This strips flat terrain without removing building foundations on slopes.
 *
 * @param grid     Mutable BlockGrid
 * @param margin   Extra layers above ground plane to remove (default: 1)
 * @returns Object with removed count and detected ground Y
 */
export function removeGroundPlane(
  grid: BlockGrid, margin = 1,
): { removed: number; groundY: number } {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;

  // Find lowest non-air Y for each XZ column
  const groundHeights: number[] = [];
  const columnGround: number[][] = []; // [x, z, groundY]
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          groundHeights.push(y);
          columnGround.push([x, z, y]);
          break;
        }
      }
    }
  }

  if (groundHeights.length === 0) return { removed: 0, groundY: 0 };

  // Low percentile ground height = ground plane level.
  // Median fails when a hollow building shell covers >50% of footprint — the
  // lowest solid block for interior columns is the roof, making median = roof height,
  // which deletes the entire building. 10th percentile ignores noise while finding
  // the true ground level even when the building dominates the footprint.
  const sorted = [...groundHeights].sort((a, b) => a - b);
  const groundY = sorted[Math.floor(sorted.length * 0.10)];
  const cutY = groundY + margin;

  // Remove blocks at or below cutY for columns near the ground plane.
  // Columns whose ground height is far above the median are building walls
  // extending down — don't strip those.
  let removed = 0;
  const tolerance = 3; // columns with ground height > groundY + tolerance are kept
  for (const [x, z, colGround] of columnGround) {
    if (colGround > groundY + tolerance) continue;
    for (let y = 0; y <= Math.min(cutY, height - 1); y++) {
      if (grid.get(x, y, z) !== AIR) {
        grid.set(x, y, z, AIR);
        removed++;
      }
    }
  }

  return { removed, groundY };
}

/**
 * Mask a BlockGrid to an OSM building footprint polygon.
 *
 * Projects the OSM polygon to block coordinates centered on the capture point
 * (address lat/lng), rasterizes to a 2D bitmap, dilates by a margin, then
 * clears all grid blocks outside the footprint at every Y layer.
 *
 * Coordinate mapping:
 * - Grid center (W/2, L/2) = capture center (address lat/lng)
 * - Grid X ≈ East (ENU capture frame), Grid Z ≈ South (Three.js convention)
 * - Polygon lon → X (east offset), polygon lat → -Z (north flipped to south)
 *
 * @param grid       Mutable BlockGrid
 * @param polygon    OSM building polygon vertices as {lat, lon}[]
 * @param centerLat  Capture center latitude (address coords)
 * @param centerLng  Capture center longitude (address coords)
 * @param dilate     Expand footprint by this many blocks in each direction (default 3)
 * @param resolution Blocks per meter (default 1) — scales polygon projection to grid units
 * @param rotationAngle Radians to rotate polygon (PCA horizontal alignment angle, default 0)
 * @returns Number of blocks removed
 */
export function maskToFootprint(
  grid: BlockGrid,
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  dilate = 3,
  resolution = 1,
  rotationAngle = 0,
): number {
  if (polygon.length < 3) return 0;

  const AIR = 'minecraft:air';
  const { width, height, length } = grid;

  // Project polygon to block coords centered on capture point.
  // Grid X = East (lon offset), Grid Z = South (negated lat offset).
  // Scale by resolution (blocks/meter) so polygon maps correctly at higher resolutions.
  const latScale = 111320 * resolution; // meters per degree × blocks per meter
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180) * resolution;

  let blockPts = polygon.map(p => ({
    x: Math.round((p.lon - centerLng) * lonScale),
    z: Math.round((centerLat - p.lat) * latScale), // flip: grid Z = south
  }));

  // Rotate polygon to match PCA horizontal alignment applied to the mesh.
  // The mesh was rotated by -rotationAngle around Y, so polygon must rotate the same.
  if (Math.abs(rotationAngle) > 0.01) {
    const cos = Math.cos(-rotationAngle);
    const sin = Math.sin(-rotationAngle);
    blockPts = blockPts.map(p => ({
      x: Math.round(p.x * cos - p.z * sin),
      z: Math.round(p.x * sin + p.z * cos),
    }));
  }

  // Auto-close polygon if needed
  const first = blockPts[0];
  const last = blockPts[blockPts.length - 1];
  if (first.x !== last.x || first.z !== last.z) {
    blockPts.push({ x: first.x, z: first.z });
  }

  // Compute bitmap bounds with dilation margin
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of blockPts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  minX -= dilate; maxX += dilate;
  minZ -= dilate; maxZ += dilate;

  // Scanline fill the polygon into a bitmap
  const bitmap = new CoordinateBitmapImpl(minX, maxX, minZ, maxZ);
  for (let z = minZ; z <= maxZ; z++) {
    const scanZ = z + 0.5;
    const intercepts: { x: number; dir: 1 | -1 }[] = [];
    for (let i = 0; i < blockPts.length - 1; i++) {
      const a = blockPts[i], b = blockPts[i + 1];
      if (a.z === b.z) continue;
      const eMinZ = Math.min(a.z, b.z), eMaxZ = Math.max(a.z, b.z);
      if (scanZ <= eMinZ || scanZ > eMaxZ) continue;
      const t = (scanZ - a.z) / (b.z - a.z);
      intercepts.push({ x: a.x + t * (b.x - a.x), dir: a.z < b.z ? 1 : -1 });
    }
    intercepts.sort((a, b) => a.x - b.x);
    let winding = 0, idx = 0;
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5;
      while (idx < intercepts.length && intercepts[idx].x <= cx) {
        winding += intercepts[idx].dir;
        idx++;
      }
      if (winding !== 0) bitmap.set(x, z);
    }
  }

  // Morphological close: dilate then erode by same amount.
  // Fills internal gaps without expanding the footprint boundary.
  if (dilate > 0 && bitmap.count > 0) {
    // Step 1: Dilate (expand by dilate blocks)
    const original: [number, number][] = [];
    for (let lz = 0; lz <= maxZ - minZ; lz++) {
      for (let lx = 0; lx <= maxX - minX; lx++) {
        const x = lx + minX, z = lz + minZ;
        if (bitmap.contains(x, z)) original.push([x, z]);
      }
    }
    for (const [ox, oz] of original) {
      for (let dz = -dilate; dz <= dilate; dz++) {
        for (let dx = -dilate; dx <= dilate; dx++) {
          bitmap.set(ox + dx, oz + dz);
        }
      }
    }

    // Step 2: Erode (shrink by dilate blocks) — completes morphological close.
    // A cell survives erosion only if ALL cells within dilate radius are set.
    const toRemove: [number, number][] = [];
    for (let lz = 0; lz <= maxZ - minZ; lz++) {
      for (let lx = 0; lx <= maxX - minX; lx++) {
        const x = lx + minX, z = lz + minZ;
        if (!bitmap.contains(x, z)) continue;
        let allSet = true;
        for (let ez = -dilate; ez <= dilate && allSet; ez++) {
          for (let ex = -dilate; ex <= dilate && allSet; ex++) {
            if (!bitmap.contains(x + ex, z + ez)) allSet = false;
          }
        }
        if (!allSet) toRemove.push([x, z]);
      }
    }
    for (const [rx, rz] of toRemove) {
      bitmap.clear(rx, rz);
    }
  }

  // Map grid XZ to bitmap coords and mask. Grid center = bitmap (0,0).
  const gridCx = Math.floor(width / 2);
  const gridCz = Math.floor(length / 2);

  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        const bx = x - gridCx;
        const bz = z - gridCz;
        if (!bitmap.contains(bx, bz)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// v95: Advanced building isolation — 3-tier strategy for fused meshes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Auto-align an OSM polygon to the voxel footprint using sliding-window IoU.
 * Fixes geocoding drift that causes maskToFootprint to clip the entire building.
 * Slides the polygon bitmask ±searchRadius blocks and finds the offset with max IoU.
 *
 * @returns The best (dx, dz) offset and its IoU, or null if no good alignment found.
 */
export function alignOSMToFootprint(
  grid: BlockGrid,
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  resolution = 1,
  rotationAngle = 0,
  searchRadius = 40,
  minIoU = 0.25,
): { dx: number; dz: number; iou: number } | null {
  if (polygon.length < 3) return null;

  const AIR = 'minecraft:air';
  const { width, length } = grid;

  // Build voxel footprint bitmask (XZ occupied columns)
  const gridCx = Math.floor(width / 2);
  const gridCz = Math.floor(length / 2);
  const voxelFoot = new Set<string>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < grid.height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          voxelFoot.add(`${x - gridCx},${z - gridCz}`);
          break;
        }
      }
    }
  }
  if (voxelFoot.size === 0) return null;

  // Project polygon to block coords (same math as maskToFootprint)
  const latScale = 111320 * resolution;
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180) * resolution;
  let blockPts = polygon.map(p => ({
    x: (p.lon - centerLng) * lonScale,
    z: (centerLat - p.lat) * latScale,
  }));
  if (Math.abs(rotationAngle) > 0.01) {
    const cos = Math.cos(-rotationAngle);
    const sin = Math.sin(-rotationAngle);
    blockPts = blockPts.map(p => ({
      x: p.x * cos - p.z * sin,
      z: p.x * sin + p.z * cos,
    }));
  }

  // Rasterize polygon to set of (x,z) cells using scanline fill
  const rasterizePoly = (pts: { x: number; z: number }[], ox: number, oz: number): Set<string> => {
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      const rz = Math.round(p.z) + oz;
      if (rz < minZ) minZ = rz;
      if (rz > maxZ) maxZ = rz;
    }
    const cells = new Set<string>();
    for (let z = minZ; z <= maxZ; z++) {
      const scanZ = z + 0.5;
      const intercepts: { x: number; dir: 1 | -1 }[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const az = Math.round(a.z) + oz, bz = Math.round(b.z) + oz;
        if (az === bz) continue;
        const eMinZ = Math.min(az, bz), eMaxZ = Math.max(az, bz);
        if (scanZ <= eMinZ || scanZ > eMaxZ) continue;
        const t = (scanZ - (a.z + oz)) / ((b.z + oz) - (a.z + oz));
        intercepts.push({ x: (a.x + ox) + t * ((b.x + ox) - (a.x + ox)), dir: az < bz ? 1 : -1 });
      }
      intercepts.sort((a, b) => a.x - b.x);
      let winding = 0, idx = 0;
      let minX = Infinity, maxX = -Infinity;
      for (const p of pts) {
        const rx = Math.round(p.x) + ox;
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
      }
      for (let x = minX; x <= maxX; x++) {
        const cx = x + 0.5;
        while (idx < intercepts.length && intercepts[idx].x <= cx) {
          winding += intercepts[idx].dir;
          idx++;
        }
        if (winding !== 0) cells.add(`${x},${z}`);
      }
    }
    return cells;
  };

  // Slide and find best IoU
  let bestIoU = 0;
  let bestDx = 0, bestDz = 0;

  for (let dz = -searchRadius; dz <= searchRadius; dz++) {
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      const osmCells = rasterizePoly(blockPts, dx, dz);
      if (osmCells.size === 0) continue;

      let intersection = 0;
      for (const key of osmCells) {
        if (voxelFoot.has(key)) intersection++;
      }
      const union = voxelFoot.size + osmCells.size - intersection;
      const iou = union > 0 ? intersection / union : 0;

      if (iou > bestIoU) {
        bestIoU = iou;
        bestDx = dx;
        bestDz = dz;
      }
    }
  }

  if (bestIoU < minIoU) return null;
  return { dx: bestDx, dz: bestDz, iou: bestIoU };
}

/**
 * Apply maskToFootprint with a pre-computed alignment offset.
 * Shifts the polygon by (dx, dz) blocks before masking.
 */
export function maskToFootprintAligned(
  grid: BlockGrid,
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  dilate: number,
  resolution: number,
  rotationAngle: number,
  dx: number,
  dz: number,
): number {
  if (polygon.length < 3) return 0;

  const AIR = 'minecraft:air';
  const { width, height, length } = grid;
  const latScale = 111320 * resolution;
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180) * resolution;

  let blockPts = polygon.map(p => ({
    x: Math.round((p.lon - centerLng) * lonScale) + dx,
    z: Math.round((centerLat - p.lat) * latScale) + dz,
  }));

  if (Math.abs(rotationAngle) > 0.01) {
    const cos = Math.cos(-rotationAngle);
    const sin = Math.sin(-rotationAngle);
    blockPts = blockPts.map(p => ({
      x: Math.round(p.x * cos - p.z * sin),
      z: Math.round(p.x * sin + p.z * cos),
    }));
  }

  // Auto-close
  const first = blockPts[0], last = blockPts[blockPts.length - 1];
  if (first.x !== last.x || first.z !== last.z) blockPts.push({ x: first.x, z: first.z });

  // Compute bounds with dilation
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of blockPts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  minX -= dilate; maxX += dilate;
  minZ -= dilate; maxZ += dilate;

  // Scanline fill
  const bitmap = new CoordinateBitmapImpl(minX, maxX, minZ, maxZ);
  for (let z = minZ; z <= maxZ; z++) {
    const scanZ = z + 0.5;
    const intercepts: { x: number; dir: 1 | -1 }[] = [];
    for (let i = 0; i < blockPts.length - 1; i++) {
      const a = blockPts[i], b = blockPts[i + 1];
      if (a.z === b.z) continue;
      const eMinZ = Math.min(a.z, b.z), eMaxZ = Math.max(a.z, b.z);
      if (scanZ <= eMinZ || scanZ > eMaxZ) continue;
      const t = (scanZ - a.z) / (b.z - a.z);
      intercepts.push({ x: a.x + t * (b.x - a.x), dir: a.z < b.z ? 1 : -1 });
    }
    intercepts.sort((a, b) => a.x - b.x);
    let winding = 0, idx = 0;
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5;
      while (idx < intercepts.length && intercepts[idx].x <= cx) {
        winding += intercepts[idx].dir;
        idx++;
      }
      if (winding !== 0) bitmap.set(x, z);
    }
  }

  // Dilate
  if (dilate > 0 && bitmap.count > 0) {
    const original: [number, number][] = [];
    for (let lz = 0; lz <= maxZ - minZ; lz++) {
      for (let lx = 0; lx <= maxX - minX; lx++) {
        const x = lx + minX, z = lz + minZ;
        if (bitmap.contains(x, z)) original.push([x, z]);
      }
    }
    for (const [ox, oz] of original) {
      for (let ddz = -dilate; ddz <= dilate; ddz++) {
        for (let ddx = -dilate; ddx <= dilate; ddx++) {
          bitmap.set(ox + ddx, oz + ddz);
        }
      }
    }
  }

  // Apply mask
  const gridCx = Math.floor(width / 2);
  const gridCz = Math.floor(length / 2);
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        if (!bitmap.contains(x - gridCx, z - gridCz)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }
  return removed;
}

/**
 * Height gradient severing — splits fused buildings by detecting steep height
 * discontinuities in the 2D heightmap and severing the 3D grid at those boundaries.
 * Returns blocks removed (smaller components after severing).
 */
export function severByHeightGradient(
  grid: BlockGrid,
  gradientThreshold = 3,
  minComponentVolume = 200,
): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;

  // Step 1: Build 2D heightmap (max Y per XZ column)
  const heightmap = new Int32Array(width * length);
  heightmap.fill(-1);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) {
          heightmap[z * width + x] = y;
          break;
        }
      }
    }
  }

  // Step 2: Compute gradient and mark chasms (steep height drops)
  const chasmMap = new Uint8Array(width * length); // 1 = chasm
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightmap[z * width + x];
      if (h < 0) continue;
      // Check 4-connected neighbors
      const neighbors = [
        x > 0 ? heightmap[z * width + (x - 1)] : -1,
        x < width - 1 ? heightmap[z * width + (x + 1)] : -1,
        z > 0 ? heightmap[(z - 1) * width + x] : -1,
        z < length - 1 ? heightmap[(z + 1) * width + x] : -1,
      ];
      for (const nh of neighbors) {
        if (nh >= 0 && Math.abs(h - nh) > gradientThreshold) {
          chasmMap[z * width + x] = 1;
          break;
        }
      }
    }
  }

  // Step 3: 3D connected component labeling that respects chasms.
  // Flood fill cannot cross an XZ coordinate marked as chasm.
  const total = width * height * length;
  const labels = new Int32Array(total);
  let nextLabel = 1;
  const compSizes: number[] = [0];
  const stack: number[] = [];
  const offsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * length + z) * width + x;
        if (labels[idx] !== 0 || grid.get(x, y, z) === AIR) continue;

        const label = nextLabel++;
        labels[idx] = label;
        stack.push(idx);
        let size = 0;

        while (stack.length > 0) {
          const ci = stack.pop()!;
          size++;
          const cx = ci % width;
          const cz = Math.floor(ci / width) % length;
          const cy = Math.floor(ci / (width * length));

          for (const [ddx, ddy, ddz] of offsets) {
            const nx = cx + ddx, ny = cy + ddy, nz = cz + ddz;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
            const ni = (ny * length + nz) * width + nx;
            if (labels[ni] !== 0 || grid.get(nx, ny, nz) === AIR) continue;

            // Block crossing through chasm boundaries
            if (chasmMap[nz * width + nx] === 1 || chasmMap[cz * width + cx] === 1) {
              // Allow vertical movement within same XZ column (building on its own podium)
              if (ddx !== 0 || ddz !== 0) continue;
            }

            labels[ni] = label;
            stack.push(ni);
          }
        }
        compSizes.push(size);
      }
    }
  }

  if (nextLabel <= 2) return 0; // Single component after severing

  // Step 4: Find largest component (likely the target building)
  let largestLabel = 1, largestSize = 0;
  for (let i = 1; i < compSizes.length; i++) {
    if (compSizes[i] > largestSize) {
      largestSize = compSizes[i];
      largestLabel = i;
    }
  }

  // Step 5: Recombine — if a smaller component vertically overlaps the largest
  // (shares XZ columns) and is directly beneath it, keep it (podium/base).
  const keepLabels = new Set<number>([largestLabel]);
  const largestXZ = new Set<string>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (labels[(y * length + z) * width + x] === largestLabel) {
          largestXZ.add(`${x},${z}`);
          break;
        }
      }
    }
  }
  for (let i = 1; i < compSizes.length; i++) {
    if (i === largestLabel || compSizes[i] < minComponentVolume) continue;
    // Check if this component shares >50% XZ overlap with largest
    let overlap = 0, compCols = 0;
    const seen = new Set<string>();
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const key = `${x},${z}`;
        if (seen.has(key)) continue;
        for (let y = 0; y < height; y++) {
          if (labels[(y * length + z) * width + x] === i) {
            seen.add(key);
            compCols++;
            if (largestXZ.has(key)) overlap++;
            break;
          }
        }
      }
    }
    if (compCols > 0 && overlap / compCols > 0.5) {
      keepLabels.add(i); // Podium/base of same building
    }
  }

  // Step 6: Remove non-kept components
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const lbl = labels[(y * length + z) * width + x];
        if (lbl === 0) continue;
        if (!keepLabels.has(lbl)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }
  return removed;
}

/**
 * Distance transform + watershed for isolating same-height fused buildings.
 * Computes Manhattan distance transform on XZ footprint, finds local maxima
 * (building centers), watershed-grows from them, and keeps the region closest
 * to grid center. Returns blocks removed.
 */
export function watershedIsolate(
  grid: BlockGrid,
  minCenterDist = 4,
): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;

  // Step 1: Build 2D occupancy footprint
  const occupied = new Uint8Array(width * length);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) { occupied[z * width + x] = 1; break; }
      }
    }
  }

  // Step 2: Manhattan distance transform (distance from nearest air/boundary)
  const dist = new Int32Array(width * length);
  const INF = width + length;
  // Forward pass
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      if (occupied[z * width + x] === 0) { dist[z * width + x] = 0; continue; }
      let d = INF;
      if (x > 0) d = Math.min(d, dist[z * width + (x - 1)] + 1);
      if (z > 0) d = Math.min(d, dist[(z - 1) * width + x] + 1);
      dist[z * width + x] = d;
    }
  }
  // Backward pass
  for (let z = length - 1; z >= 0; z--) {
    for (let x = width - 1; x >= 0; x--) {
      if (occupied[z * width + x] === 0) continue;
      let d = dist[z * width + x];
      if (x < width - 1) d = Math.min(d, dist[z * width + (x + 1)] + 1);
      if (z < length - 1) d = Math.min(d, dist[(z + 1) * width + x] + 1);
      dist[z * width + x] = d;
    }
  }

  // Step 3: Find local maxima (building centers) with minimum distance threshold
  // Scale minCenterDist with building size — prevents splitting single buildings
  const footprintMin = Math.min(width, length);
  const effectiveMinDist = Math.max(minCenterDist, Math.floor(footprintMin / 4));
  const rawMaxima: { x: number; z: number; d: number }[] = [];
  for (let z = 1; z < length - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      const d = dist[z * width + x];
      if (d < effectiveMinDist) continue;
      // Check if local maximum in 8-connected neighborhood
      let isMax = true;
      for (let ddz = -1; ddz <= 1 && isMax; ddz++) {
        for (let ddx = -1; ddx <= 1 && isMax; ddx++) {
          if (ddx === 0 && ddz === 0) continue;
          if (dist[(z + ddz) * width + (x + ddx)] > d) isMax = false;
        }
      }
      if (isMax) rawMaxima.push({ x, z, d });
    }
  }

  // Merge maxima that are close together (same building plateau)
  rawMaxima.sort((a, b) => b.d - a.d); // highest distance first
  const maxima: typeof rawMaxima = [];
  for (const m of rawMaxima) {
    const tooClose = maxima.some(
      (existing) => Math.abs(existing.x - m.x) + Math.abs(existing.z - m.z) < effectiveMinDist,
    );
    if (!tooClose) maxima.push(m);
  }

  if (maxima.length <= 1) return 0; // Single building center

  // Step 4: Watershed — grow from maxima simultaneously
  const regionMap = new Int32Array(width * length); // 0=unassigned
  const queue: { x: number; z: number; region: number; d: number }[] = [];

  // Seed regions from maxima (sorted by distance descending for priority)
  maxima.sort((a, b) => b.d - a.d);
  for (let i = 0; i < maxima.length; i++) {
    const m = maxima[i];
    const region = i + 1;
    regionMap[m.z * width + m.x] = region;
    queue.push({ x: m.x, z: m.z, region, d: m.d });
  }

  // BFS growth — process in order of decreasing distance (highest priority first)
  queue.sort((a, b) => b.d - a.d);
  let qi = 0;
  while (qi < queue.length) {
    const { x, z, region } = queue[qi++];
    for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + ddx, nz = z + ddz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
      if (occupied[nz * width + nx] === 0) continue;
      if (regionMap[nz * width + nx] !== 0) continue;
      regionMap[nz * width + nx] = region;
      queue.push({ x: nx, z: nz, region, d: dist[nz * width + nx] });
    }
  }

  // Step 5: Find the region closest to grid center
  const cx = Math.floor(width / 2), cz = Math.floor(length / 2);
  let bestRegion = 1, bestDist = Infinity;
  for (let i = 0; i < maxima.length; i++) {
    const m = maxima[i];
    const d = Math.abs(m.x - cx) + Math.abs(m.z - cz);
    if (d < bestDist) { bestDist = d; bestRegion = i + 1; }
  }

  // Step 6: Remove all voxels not in the best region's XZ columns
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        if (regionMap[z * width + x] !== bestRegion) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }
  return removed;
}

/**
 * Enforce a polygon footprint on the grid — clip blocks outside the polygon
 * AND fill empty columns inside the polygon to the building's median height.
 * Uses the building's centroid for polygon alignment (not grid center), which
 * fixes the offset caused by OSM pre-fill masking removing neighbors.
 *
 * v71: This gives sharp straight edges matching the real building outline,
 * overriding the photogrammetry mesh's rounded edges.
 */
export function enforceFootprintPolygon(
  grid: BlockGrid,
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  resolution = 1,
  rotationAngle = 0,
  wallBlock = 'minecraft:stone_bricks',
  roofBlock = 'minecraft:light_gray_concrete',
  /** Buffer in blocks around polygon for clip tolerance (0 = exact) */
  buffer = 2,
): { clipped: number; filled: number } {
  if (polygon.length < 3) return { clipped: 0, filled: 0 };

  const AIR = 'minecraft:air';
  const { width, height, length } = grid;

  // Compute building centroid — center of mass of occupied columns
  let centX = 0, centZ = 0, centCount = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          centX += x;
          centZ += z;
          centCount++;
          break;
        }
      }
    }
  }
  if (centCount === 0) return { clipped: 0, filled: 0 };
  centX = Math.round(centX / centCount);
  centZ = Math.round(centZ / centCount);

  // Compute median building height for fill
  const colHeights: number[] = [];
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      let topY = -1;
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) { topY = y; break; }
      }
      if (topY >= 0) colHeights.push(topY);
    }
  }
  colHeights.sort((a, b) => a - b);
  const medianH = colHeights[Math.floor(colHeights.length * 0.75)] ?? 10;

  // Project polygon to block coords centered on building centroid
  const latScale = 111320 * resolution;
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180) * resolution;

  let blockPts = polygon.map(p => ({
    x: Math.round((p.lon - centerLng) * lonScale),
    z: Math.round((centerLat - p.lat) * latScale),
  }));

  // Apply ENU rotation
  if (Math.abs(rotationAngle) > 0.01) {
    const cos = Math.cos(-rotationAngle);
    const sin = Math.sin(-rotationAngle);
    blockPts = blockPts.map(p => ({
      x: Math.round(p.x * cos - p.z * sin),
      z: Math.round(p.x * sin + p.z * cos),
    }));
  }

  // Auto-close polygon
  const first = blockPts[0];
  const last = blockPts[blockPts.length - 1];
  if (first.x !== last.x || first.z !== last.z) {
    blockPts.push({ x: first.x, z: first.z });
  }

  // Compute polygon centroid in block coords
  let polyCx = 0, polyCz = 0;
  for (const p of blockPts) { polyCx += p.x; polyCz += p.z; }
  polyCx = Math.round(polyCx / blockPts.length);
  polyCz = Math.round(polyCz / blockPts.length);

  // Shift polygon so its centroid aligns with building centroid in grid
  const shiftX = centX - polyCx;
  const shiftZ = centZ - polyCz;
  blockPts = blockPts.map(p => ({ x: p.x + shiftX, z: p.z + shiftZ }));

  // Clamp polygon to grid bounds — points outside the grid can't affect voxels
  blockPts = blockPts.map(p => ({
    x: Math.max(-1, Math.min(width, p.x)),
    z: Math.max(-1, Math.min(length, p.z)),
  }));

  // Scanline fill polygon into bitmap (no dilation — exact edges)
  let minX = 0, maxX = width - 1, minZ = 0, maxZ = length - 1;
  // Use grid bounds as bitmap extent — we only care about grid cells
  const bitmap = new CoordinateBitmapImpl(minX, maxX, minZ, maxZ);
  for (let z = minZ; z <= maxZ; z++) {
    const scanZ = z + 0.5;
    const intercepts: { x: number; dir: 1 | -1 }[] = [];
    for (let i = 0; i < blockPts.length - 1; i++) {
      const a = blockPts[i], b = blockPts[i + 1];
      if (a.z === b.z) continue;
      const eMinZ = Math.min(a.z, b.z), eMaxZ = Math.max(a.z, b.z);
      if (scanZ <= eMinZ || scanZ > eMaxZ) continue;
      const t = (scanZ - a.z) / (b.z - a.z);
      intercepts.push({ x: a.x + t * (b.x - a.x), dir: a.z < b.z ? 1 : -1 });
    }
    intercepts.sort((a, b) => a.x - b.x);
    let winding = 0, idx = 0;
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5;
      while (idx < intercepts.length && intercepts[idx].x <= cx) {
        winding += intercepts[idx].dir;
        idx++;
      }
      if (winding !== 0) bitmap.set(x, z);
    }
  }

  // Create dilated bitmap for clip tolerance (photogrammetry edges bleed 1-3 blocks
  // outside the exact OSM polygon). Core (un-dilated) bitmap used for fill decisions.
  const clipBitmap = new CoordinateBitmapImpl(minX, maxX, minZ, maxZ);
  // Copy core into clip bitmap
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      if (bitmap.contains(x, z)) clipBitmap.set(x, z);
    }
  }
  if (buffer > 0) {
    // Dilate clip bitmap
    const toSet: Array<[number, number]> = [];
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!bitmap.contains(x, z)) continue;
        for (let dz = -buffer; dz <= buffer; dz++) {
          for (let dx = -buffer; dx <= buffer; dx++) {
            const nx = x + dx, nz = z + dz;
            if (nx >= minX && nx <= maxX && nz >= minZ && nz <= maxZ) {
              toSet.push([nx, nz]);
            }
          }
        }
      }
    }
    for (const [x, z] of toSet) clipBitmap.set(x, z);
  }

  // Build occupied-column bitmap (before clipping) for proximity-gated fill
  const occupiedCol = new Uint8Array(width * length);
  let existingBlockCount = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          occupiedCol[z * width + x] = 1;
          existingBlockCount++;
          break;
        }
      }
    }
  }

  // v71b: Skip clipping — the pre-fill OSM mask already removed neighbors.
  // Clipping here destroys legitimate building geometry that extends slightly
  // beyond the OSM polygon (wing connectors, overhangs, bay windows).
  const clipped = 0;

  // Fill empty columns inside core polygon — proximity-gated.
  // Only fill columns adjacent (within 2 blocks) to existing occupied columns
  // to prevent massive fills for partial captures (e.g. Dakota corner-only).
  // Also cap total fill to 30% of existing block count.
  const fillCap = Math.floor(existingBlockCount * 0.30);
  let filled = 0;
  for (let z = 0; z < length && filled < fillCap; z++) {
    for (let x = 0; x < width && filled < fillCap; x++) {
      if (!bitmap.contains(x, z)) continue; // Outside core polygon
      // Skip already-occupied columns
      if (occupiedCol[z * width + x]) continue;
      // Proximity gate: require occupied neighbor within 2 blocks
      let hasNeighbor = false;
      for (let dz = -2; dz <= 2 && !hasNeighbor; dz++) {
        for (let dx = -2; dx <= 2 && !hasNeighbor; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
            if (occupiedCol[nz * width + nx]) hasNeighbor = true;
          }
        }
      }
      if (!hasNeighbor) continue;
      // Fill to median height
      for (let y = 0; y < medianH; y++) {
        grid.set(x, y, z, wallBlock);
        filled++;
      }
      grid.set(x, medianH, z, roofBlock);
      filled++;
    }
  }

  return { clipped, filled };
}

/**
 * Minimal CoordinateBitmap for internal use (avoids circular import).
 * Same bit-packed logic as src/gen/coordinate-bitmap.ts.
 */
class CoordinateBitmapImpl {
  private bits: Uint8Array;
  readonly minX: number;
  readonly minZ: number;
  readonly width: number;
  readonly height: number;
  private _count = 0;

  constructor(minX: number, maxX: number, minZ: number, maxZ: number) {
    this.minX = minX; this.minZ = minZ;
    this.width = maxX - minX + 1;
    this.height = maxZ - minZ + 1;
    this.bits = new Uint8Array(Math.ceil(this.width * this.height / 8));
  }

  get count(): number { return this._count; }

  set(x: number, z: number): boolean {
    const lx = x - this.minX, lz = z - this.minZ;
    if (lx < 0 || lx >= this.width || lz < 0 || lz >= this.height) return false;
    const i = lz * this.width + lx;
    const mask = 1 << (i & 7);
    if ((this.bits[i >> 3] & mask) !== 0) return false;
    this.bits[i >> 3] |= mask;
    this._count++;
    return true;
  }

  contains(x: number, z: number): boolean {
    const lx = x - this.minX, lz = z - this.minZ;
    if (lx < 0 || lx >= this.width || lz < 0 || lz >= this.height) return false;
    const i = lz * this.width + lx;
    return ((this.bits[i >> 3] >> (i & 7)) & 1) === 1;
  }

  clear(x: number, z: number): boolean {
    const lx = x - this.minX, lz = z - this.minZ;
    if (lx < 0 || lx >= this.width || lz < 0 || lz >= this.height) return false;
    const i = lz * this.width + lx;
    const mask = 1 << (i & 7);
    if ((this.bits[i >> 3] & mask) === 0) return false;
    this.bits[i >> 3] &= ~mask;
    this._count--;
    return true;
  }
}

// ─── Auto-Detection Analyzer ─────────────────────────────────────────────────

/** Building shape classification from volumetric analysis */
export type BuildingTypology = 'tower' | 'flatiron' | 'block' | 'house' | 'complex';

/** Detected front face direction for street frontage */
export type FaceDirection = '+x' | '-x' | '+z' | '-z';

/** Complete analysis result with recommended pipeline parameters */
export interface AnalysisResult {
  // 1. Terrain / ground plane
  groundPlaneY: number;        // estimated ground Y layer
  slopeAngle: number;          // degrees — 0 = flat, >5 = sloped terrain
  isFlat: boolean;             // slopeAngle < 3°

  // 2. Central component isolation
  componentCount: number;      // number of distinct 3D connected components
  centralAABB: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
  suggestedCropRadius: number; // auto-computed XZ radius for --crop

  // 3. Capture boundary intersection — partial capture detection
  edgeTouchPct: number;        // % of non-air voxels touching grid XZ edges
  isPartialCapture: boolean;   // edgeTouchPct > 5% → building extends beyond capture

  // 4. Volumetric typology
  typology: BuildingTypology;
  aspectRatio: number;         // height / max(width, length) of central component
  footprintFill: number;       // fraction of XZ bounding rect filled at ground level
  isRectangular: boolean;      // footprintFill > 0.7

  // 5. Roof analysis
  isFlatRoof: boolean;         // low heightmap variance in top 10%
  roofVariance: number;        // normalized variance of top-layer height distribution

  // 6. Facade color clustering (k=2 dominant + secondary)
  dominantBlock: string;       // most common non-air block on exterior surface
  secondaryBlock: string;      // second most common exterior block
  dominantPct: number;         // % of exterior surface covered by dominant block
  suggestedRemaps: Map<string, string>; // auto-generated --remap args

  // 7. Noise estimation
  protrusion1vCount: number;   // single-voxel protrusions (noise indicator)
  noisePct: number;            // protrusions / total non-air
  suggestedClean: number;      // recommended --clean value

  // 8. Street frontage
  frontFace: FaceDirection;    // side with most ground-level density

  // 9. Confidence score
  confidence: number;          // 1-10 predicted voxelization quality

  // 10. Entry/door detection
  entryPosition: { x: number; z: number } | null; // ground-level doorway position (grid coords)
  entryFace: FaceDirection;    // face where entry was detected (usually matches frontFace)
  entryWidth: number;          // width of the detected opening in blocks

  // 11. Ground boundary / footprint
  footprintArea: number;       // number of XZ columns with building blocks at ground level
  perimeterLength: number;     // number of ground-level blocks on the building perimeter
  groundContactY: number;      // Y layer where building first contacts ground

  // 12. Entry path — straight-line path from grid edge to detected entry
  entryPath: Array<{ x: number; z: number }>;  // path blocks from edge to door (empty if no entry)

  // 13. Data quality assessment
  compactness: number;           // footprintArea / AABB area (1.0 = perfect rectangle, <0.3 = scattered)
  dataQuality: 'good' | 'fair' | 'poor'; // overall capture quality verdict

  // 14. Building extent (at 1 block/m, blocks ≈ meters)
  estimatedWidthM: number;       // central component X extent
  estimatedHeightM: number;      // central component Y extent
  estimatedDepthM: number;       // central component Z extent
  estimatedFloors: number;       // estimated floor count (height / 3.5m per floor)

  // Recommended CLI args
  recommended: {
    generic: boolean;
    fill: boolean;
    noPalette: boolean;
    noCornice: boolean;
    noFireEscape: boolean;
    smoothPct: number;
    modePasses: number;
    cropRadius: number;       // circular crop (0 = skip)
    useAABBCrop: boolean;     // use AABB crop instead of circular (shape-preserving)
    cleanMinSize: number;
    remaps: Map<string, string>;
  };
}

/**
 * 3D flood-fill connected component labeling.
 * Returns component sizes and a label map (0 = air, 1..N = component ID).
 */
export function labelConnectedComponents(grid: BlockGrid): {
  labels: Int32Array;
  sizes: number[];
  count: number;
} {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;
  const total = width * height * length;
  const labels = new Int32Array(total); // 0 = unlabeled/air
  let nextLabel = 1;
  const sizes: number[] = [0]; // sizes[0] unused (air)

  // 6-connected flood fill via stack-based BFS
  const stack: number[] = [];
  const offsets = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0],
    [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ] as const;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * length + z) * width + x;
        if (labels[idx] !== 0 || grid.get(x, y, z) === AIR) continue;

        const label = nextLabel++;
        labels[idx] = label;
        stack.push(idx);
        let size = 0;

        while (stack.length > 0) {
          const ci = stack.pop()!;
          size++;
          const cx2 = ci % width;
          const cz2 = Math.floor(ci / width) % length;
          const cy2 = Math.floor(ci / (width * length));

          for (const [dx, dy, dz] of offsets) {
            const nx = cx2 + dx, ny = cy2 + dy, nz = cz2 + dz;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
            const ni = (ny * length + nz) * width + nx;
            if (labels[ni] !== 0 || grid.get(nx, ny, nz) === AIR) continue;
            labels[ni] = label;
            stack.push(ni);
          }
        }

        sizes.push(size);
      }
    }
  }

  return { labels, sizes, count: nextLabel - 1 };
}

/**
 * Analyze a voxel grid to auto-detect building properties and recommend
 * optimal pipeline parameters. Runs after trimSparseBottomLayers but before
 * any destructive shape processing.
 *
 * Implements 9 analysis criteria:
 * 1. Terrain/slope, 2. Component isolation, 3. Partial capture,
 * 4. Volumetric typology, 5. Roof flatness, 6. Facade color clustering,
 * 7. Noise estimation, 8. Street frontage, 9. Confidence scoring
 */
export function analyzeGrid(grid: BlockGrid): AnalysisResult {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;

  // ── 1. Ground plane / slope estimation ──
  // Find lowest non-air Y for each XZ column → fit plane
  const groundHeights: number[] = [];
  const groundXZ: [number, number][] = [];
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          groundHeights.push(y);
          groundXZ.push([x, z]);
          break;
        }
      }
    }
  }

  let groundPlaneY = 0;
  let slopeAngle = 0;
  if (groundHeights.length > 0) {
    const sorted = [...groundHeights].sort((a, b) => a - b);
    groundPlaneY = sorted[Math.floor(sorted.length / 2)];

    // Use bottom 10% of heights for slope estimation
    const threshold = sorted[Math.floor(sorted.length * 0.1)];
    const groundOnly: { x: number; z: number; y: number }[] = [];
    for (let i = 0; i < groundHeights.length; i++) {
      if (groundHeights[i] <= threshold + 2) {
        groundOnly.push({ x: groundXZ[i][0], z: groundXZ[i][1], y: groundHeights[i] });
      }
    }

    if (groundOnly.length >= 3) {
      const minGY = groundOnly.reduce((m, g) => Math.min(m, g.y), Infinity);
      const maxGY = groundOnly.reduce((m, g) => Math.max(m, g.y), -Infinity);
      const rise = maxGY - minGY;
      const run = Math.sqrt(width * width + length * length);
      slopeAngle = Math.atan2(rise, run) * (180 / Math.PI);
    }
  }

  // ── 2. Connected component isolation ──
  const { labels, sizes: _componentSizes, count: componentCount } = labelConnectedComponents(grid);

  // Find primary building component using size-weighted centrality score.
  // Pure centroid-proximity fails for ring/courtyard buildings (Pentagon, Colosseum)
  // where a tiny noise voxel at center beats the actual structure.
  const cx = width / 2;
  const cz = length / 2;
  let centralLabel = 1;

  if (componentCount > 0) {
    const centroidX = new Float64Array(componentCount + 1);
    const centroidZ = new Float64Array(componentCount + 1);
    const compCounts = new Float64Array(componentCount + 1);

    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const lbl = labels[(y * length + z) * width + x];
          if (lbl === 0) continue;
          centroidX[lbl] += x;
          centroidZ[lbl] += z;
          compCounts[lbl]++;
        }
      }
    }

    // Establish baseline: largest component size
    let maxCompSize = 0;
    for (let i = 1; i <= componentCount; i++) {
      if (compCounts[i] > maxCompSize) maxCompSize = compCounts[i];
    }

    const maxDist = Math.sqrt(cx * cx + cz * cz); // max possible distance (corner to center)
    let bestScore = -Infinity;

    for (let i = 1; i <= componentCount; i++) {
      // Filter noise: must be ≥5% of largest component or ≥100 voxels
      if (compCounts[i] < Math.max(100, maxCompSize * 0.05)) continue;

      const mx = centroidX[i] / compCounts[i];
      const mz = centroidZ[i] / compCounts[i];
      const dist = Math.sqrt((mx - cx) * (mx - cx) + (mz - cz) * (mz - cz));

      // Score = volume penalized by distance from center (up to 50% reduction at edge)
      const normalizedDist = maxDist > 0 ? dist / maxDist : 0;
      const score = compCounts[i] * (1.0 - normalizedDist * 0.5);

      if (score > bestScore) {
        bestScore = score;
        centralLabel = i;
      }
    }
  }

  // Compute AABB of central component
  let cMinX = width, cMaxX = 0, cMinZ = length, cMaxZ = 0, cMinY = height, cMaxY = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (labels[(y * length + z) * width + x] !== centralLabel) continue;
        if (x < cMinX) cMinX = x;
        if (x > cMaxX) cMaxX = x;
        if (z < cMinZ) cMinZ = z;
        if (z > cMaxZ) cMaxZ = z;
        if (y < cMinY) cMinY = y;
        if (y > cMaxY) cMaxY = y;
      }
    }
  }

  const centralAABB = { minX: cMinX, maxX: cMaxX, minZ: cMinZ, maxZ: cMaxZ, minY: cMinY, maxY: cMaxY };

  // Suggested crop radius: half-diagonal of central AABB + 2 block margin
  const halfW = (cMaxX - cMinX) / 2;
  const halfL = (cMaxZ - cMinZ) / 2;
  const suggestedCropRadius = Math.ceil(Math.sqrt(halfW * halfW + halfL * halfL) + 2);

  // ── 3. Capture boundary intersection ──
  // Detect if building extends beyond capture radius by counting blocks on grid edges.
  // Note: cylindrical captures have low edge touch (~1.2%). The CLI pipeline handles
  // this by running OSM mask BEFORE fill to remove capture boundary walls.
  let edgeTouchCount = 0;
  let totalNonAir = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        totalNonAir++;
        if (x === 0 || x === width - 1 || z === 0 || z === length - 1) {
          edgeTouchCount++;
        }
      }
    }
  }
  const edgeTouchPct = totalNonAir > 0 ? (edgeTouchCount / totalNonAir) * 100 : 0;
  const isPartialCapture = edgeTouchPct > 5;

  // ── 4. Volumetric typology ──
  const centralW = cMaxX - cMinX + 1;
  const centralH = cMaxY - cMinY + 1;
  const centralL = cMaxZ - cMinZ + 1;
  const maxFootprint = Math.max(centralW, centralL);
  const aspectRatio = centralH / Math.max(maxFootprint, 1);

  // Footprint fill via ray-containment at mid-height.
  // Surface-mode voxelization produces hollow shells, so counting solid voxels
  // gives low fill (22%) for rectangular buildings. Instead, for each XZ column
  // cast rays in ±X direction: if both hit solid blocks, column is "inside".
  const midY = Math.floor((cMinY + cMaxY) / 2);
  let fpContained = 0;
  const fpTotal = centralW * centralL;
  for (let z = cMinZ; z <= cMaxZ; z++) {
    for (let x = cMinX; x <= cMaxX; x++) {
      // Cast +X ray from this column
      let hitPosX = false;
      for (let rx = x + 1; rx <= cMaxX; rx++) {
        if (labels[(midY * length + z) * width + rx] === centralLabel) { hitPosX = true; break; }
      }
      // Cast -X ray
      let hitNegX = false;
      for (let rx = x - 1; rx >= cMinX; rx--) {
        if (labels[(midY * length + z) * width + rx] === centralLabel) { hitNegX = true; break; }
      }
      // Cast +Z ray
      let hitPosZ = false;
      for (let rz = z + 1; rz <= cMaxZ; rz++) {
        if (labels[(midY * length + rz) * width + x] === centralLabel) { hitPosZ = true; break; }
      }
      // Cast -Z ray
      let hitNegZ = false;
      for (let rz = z - 1; rz >= cMinZ; rz--) {
        if (labels[(midY * length + rz) * width + x] === centralLabel) { hitNegZ = true; break; }
      }
      // Column is "contained" if enclosed from all 4 directions (or is itself solid)
      if ((hitPosX && hitNegX && hitPosZ && hitNegZ) ||
          labels[(midY * length + z) * width + x] === centralLabel) {
        fpContained++;
      }
    }
  }
  const footprintFill = fpTotal > 0 ? fpContained / fpTotal : 0;

  // Classify building shape.
  // Ray-containment footprintFill for surface-mode voxels:
  //   >0.25 = enclosed shell (typical building with thin surface walls)
  //   <0.25 = scattered/complex (multiple disconnected structures)
  // Quadrant analysis distinguishes rectangular from triangular footprints.
  const isEnclosed = footprintFill > 0.25;

  // Note: flatiron/wedge detection was attempted using corner occupancy,
  // footprint taper, and XZ projection fill, but surface-mode voxels produce
  // shells too sparse for reliable shape classification (all large buildings
  // cluster at 0.5-0.6 fill regardless of actual footprint shape).
  // Wedge buildings still get correct processing as 'block' (solidifyCore
  // fills any enclosed shell). Use --generic for manual non-rectangular override.
  const isRectangular = isEnclosed;

  let typology: BuildingTypology;
  if (aspectRatio > 1.5) {
    typology = 'tower';
  } else if (!isEnclosed) {
    typology = 'complex';
  } else if (centralH > 10) {
    typology = 'block';
  } else {
    typology = 'house';
  }

  // ── 5. Roof flatness ──
  const heightMap: number[] = [];
  for (let z = cMinZ; z <= cMaxZ; z++) {
    for (let x = cMinX; x <= cMaxX; x++) {
      for (let y = cMaxY; y >= cMinY; y--) {
        if (labels[(y * length + z) * width + x] === centralLabel) {
          heightMap.push(y);
          break;
        }
      }
    }
  }

  let roofVariance = 0;
  let isFlatRoof = true;
  if (heightMap.length > 0) {
    const sortedH = [...heightMap].sort((a, b) => b - a);
    const top10pct = sortedH.slice(0, Math.max(1, Math.floor(sortedH.length * 0.1)));
    const mean = top10pct.reduce((s, v) => s + v, 0) / top10pct.length;
    roofVariance = top10pct.reduce((s, v) => s + (v - mean) ** 2, 0) / top10pct.length;
    isFlatRoof = roofVariance < 2.0;
  }

  // ── 6. Facade color clustering ──
  // Count blocks on exterior surface of central component (exposed to air)
  const surfaceBlocks = new Map<string, number>();
  for (let y = cMinY; y <= cMaxY; y++) {
    for (let z = cMinZ; z <= cMaxZ; z++) {
      for (let x = cMinX; x <= cMaxX; x++) {
        if (labels[(y * length + z) * width + x] !== centralLabel) continue;
        const block = grid.get(x, y, z);
        if (block === AIR) continue;

        let isSurface = false;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as [number,number,number][]) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (!grid.inBounds(nx, ny, nz) || grid.get(nx, ny, nz) === AIR) {
            isSurface = true;
            break;
          }
        }
        if (isSurface) {
          surfaceBlocks.set(block, (surfaceBlocks.get(block) ?? 0) + 1);
        }
      }
    }
  }

  const sortedBlocks = [...surfaceBlocks.entries()].sort((a, b) => b[1] - a[1]);
  const totalSurface = sortedBlocks.reduce((s, [, c]) => s + c, 0);
  const dominantBlock = sortedBlocks[0]?.[0] ?? AIR;
  const dominantPct = totalSurface > 0 ? (sortedBlocks[0]?.[1] ?? 0) / totalSurface * 100 : 0;
  const secondaryBlock = sortedBlocks[1]?.[0] ?? AIR;

  // Auto-generate remap suggestions based on dominant facade material
  const suggestedRemaps = new Map<string, string>();
  const WARM_BLOCKS = new Set([
    'minecraft:smooth_sandstone', 'minecraft:sandstone', 'minecraft:orange_terracotta',
    'minecraft:yellow_terracotta', 'minecraft:white_terracotta', 'minecraft:terracotta',
  ]);
  const COOL_BLOCKS = new Set([
    'minecraft:cyan_terracotta', 'minecraft:light_blue_terracotta', 'minecraft:prismarine',
    'minecraft:dark_prismarine', 'minecraft:warped_planks',
  ]);

  const WHITE_BLOCKS = new Set([
    'minecraft:smooth_quartz', 'minecraft:white_concrete', 'minecraft:quartz_block',
    'minecraft:snow_block', 'minecraft:iron_block',
  ]);

  if (WARM_BLOCKS.has(dominantBlock) || WARM_BLOCKS.has(secondaryBlock)) {
    // Warm stucco building — remap shadows to sandstone family
    suggestedRemaps.set('minecraft:gray_concrete', 'minecraft:sandstone');
    suggestedRemaps.set('minecraft:light_gray_concrete', 'minecraft:smooth_sandstone');
    suggestedRemaps.set('minecraft:stone', 'minecraft:sandstone');
  } else if (COOL_BLOCKS.has(dominantBlock) || COOL_BLOCKS.has(secondaryBlock)) {
    // Copper/green building — remap to prismarine family
    suggestedRemaps.set('minecraft:gray_concrete', 'minecraft:dark_prismarine');
    suggestedRemaps.set('minecraft:light_gray_concrete', 'minecraft:prismarine');
    suggestedRemaps.set('minecraft:white_concrete', 'minecraft:prismarine');
  } else if (WHITE_BLOCKS.has(dominantBlock) || WHITE_BLOCKS.has(secondaryBlock)) {
    // White/light gray building — only remap the darkest noise (stone, cobblestone)
    // to preserve texture variety from andesite and stone_bricks which add visual
    // interest to facades (window sills, trim bands, floor separators).
    suggestedRemaps.set('minecraft:stone', 'minecraft:light_gray_concrete');
    suggestedRemaps.set('minecraft:cobblestone', 'minecraft:light_gray_concrete');
  }

  // ── 7. Noise estimation ──
  let protrusion1vCount = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        let neighbors = 0;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as [number,number,number][]) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (grid.inBounds(nx, ny, nz) && grid.get(nx, ny, nz) !== AIR) neighbors++;
        }
        if (neighbors <= 1) protrusion1vCount++;
      }
    }
  }
  const noisePct = totalNonAir > 0 ? (protrusion1vCount / totalNonAir) * 100 : 0;
  const suggestedClean = noisePct > 10 ? 100 : noisePct > 5 ? 50 : 0;

  // ── 8. Street frontage ──
  // Evaluate face density at ground level of central component
  const faceScores: Record<FaceDirection, number> = { '+x': 0, '-x': 0, '+z': 0, '-z': 0 };
  const scanH = Math.min(3, centralH);
  for (let dy = 0; dy < scanH; dy++) {
    const y = cMinY + dy;
    if (y >= height) break;
    for (let z = cMinZ; z <= cMaxZ; z++) {
      if (grid.inBounds(cMaxX, y, z) && grid.get(cMaxX, y, z) !== AIR) faceScores['+x']++;
      if (grid.inBounds(cMinX, y, z) && grid.get(cMinX, y, z) !== AIR) faceScores['-x']++;
    }
    for (let x = cMinX; x <= cMaxX; x++) {
      if (grid.inBounds(x, y, cMaxZ) && grid.get(x, y, cMaxZ) !== AIR) faceScores['+z']++;
      if (grid.inBounds(x, y, cMinZ) && grid.get(x, y, cMinZ) !== AIR) faceScores['-z']++;
    }
  }
  const frontFace = (Object.entries(faceScores) as [FaceDirection, number][])
    .sort((a, b) => b[1] - a[1])[0][0];

  // ── 10. Entry/door detection ──
  // Two strategies:
  // A. Air gap scan — contiguous air runs in facade surface at ground level.
  // B. Facade recession — spots where the wall is indented ≥2 blocks compared to neighbors.
  //    Common for building entrances (recessed doorways, covered porticos).
  let entryPosition: { x: number; z: number } | null = null;
  let entryFace: FaceDirection = frontFace;
  let entryWidth = 0;

  {
    const doorScanH = Math.min(3, centralH);
    type DoorCandidate = { x: number; z: number; width: number; distFromCenter: number; score: number };
    const candidates: DoorCandidate[] = [];

    const faces: FaceDirection[] = ['+x', '-x', '+z', '-z'];
    for (const face of faces) {
      const isXFace = face === '+x' || face === '-x';
      const fixedCoord = face === '+x' ? cMaxX : face === '-x' ? cMinX : face === '+z' ? cMaxZ : cMinZ;
      const sweepMin = isXFace ? cMinZ : cMinX;
      const sweepMax = isXFace ? cMaxZ : cMaxX;
      const sweepCenter = (sweepMin + sweepMax) / 2;
      const isFrontFace = face === frontFace;

      // Measure facade depth at each sweep position — how far from the AABB face
      // to the first solid block along the face normal direction.
      const depths: number[] = [];
      const occupied: boolean[] = [];
      for (let s = sweepMin; s <= sweepMax; s++) {
        let minDepth = Infinity;
        let hasBlock = false;
        for (let dy = 0; dy < doorScanH; dy++) {
          const y = cMinY + dy;
          if (y >= height) break;
          // Ray inward from face boundary to find first solid block
          const maxProbe = 6; // probe up to 6 blocks deep
          for (let d = 0; d < maxProbe; d++) {
            let px: number, pz: number;
            if (face === '+x') { px = cMaxX - d; pz = s; }
            else if (face === '-x') { px = cMinX + d; pz = s; }
            else if (face === '+z') { px = s; pz = cMaxZ - d; }
            else { px = s; pz = cMinZ + d; }
            if (grid.inBounds(px, y, pz) && grid.get(px, y, pz) !== AIR) {
              hasBlock = true;
              if (d < minDepth) minDepth = d;
              break;
            }
          }
        }
        depths.push(minDepth === Infinity ? -1 : minDepth);
        occupied.push(hasBlock);
      }

      // Strategy A: Air gap — contiguous runs of no block at facade boundary
      let runStart = -1;
      for (let i = 0; i <= occupied.length; i++) {
        if (i < occupied.length && !occupied[i]) {
          if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
          const runLen = i - runStart;
          if (runLen >= 1 && runLen <= 4) {
            const midRun = sweepMin + runStart + runLen / 2;
            const dist = Math.abs(midRun - sweepCenter);
            const gapX = isXFace ? fixedCoord : Math.round(midRun);
            const gapZ = isXFace ? Math.round(midRun) : fixedCoord;
            candidates.push({
              x: gapX, z: gapZ, width: runLen, distFromCenter: dist,
              score: (isFrontFace ? 10 : 3) + (4 - runLen) - dist * 0.1,
            });
          }
          runStart = -1;
        }
      }

      // Strategy B: Facade recession — contiguous runs deeper than neighbors
      // A recession is where depth[i] > median(depths) + 1 (entry is set back from facade)
      const validDepths = depths.filter(d => d >= 0);
      if (validDepths.length > 0) {
        const sortedDepths = [...validDepths].sort((a, b) => a - b);
        const medianDepth = sortedDepths[Math.floor(sortedDepths.length / 2)];
        const recessThreshold = medianDepth + 1;

        let rStart = -1;
        for (let i = 0; i <= depths.length; i++) {
          if (i < depths.length && depths[i] >= recessThreshold) {
            if (rStart < 0) rStart = i;
          } else if (rStart >= 0) {
            const rLen = i - rStart;
            // Recessed entry: 1-5 blocks wide
            if (rLen >= 1 && rLen <= 5) {
              const midRun = sweepMin + rStart + rLen / 2;
              const dist = Math.abs(midRun - sweepCenter);
              // Position at the recessed depth
              const avgDepth = depths.slice(rStart, rStart + rLen).reduce((s, d) => s + d, 0) / rLen;
              let gapX: number, gapZ: number;
              if (face === '+x') { gapX = Math.round(cMaxX - avgDepth); gapZ = Math.round(midRun); }
              else if (face === '-x') { gapX = Math.round(cMinX + avgDepth); gapZ = Math.round(midRun); }
              else if (face === '+z') { gapX = Math.round(midRun); gapZ = Math.round(cMaxZ - avgDepth); }
              else { gapX = Math.round(midRun); gapZ = Math.round(cMinZ + avgDepth); }
              candidates.push({
                x: gapX, z: gapZ, width: rLen, distFromCenter: dist,
                // Recession score: lower than air gap, but boost for front face and depth
                score: (isFrontFace ? 6 : 1) + avgDepth * 0.5 - dist * 0.1,
              });
            }
            rStart = -1;
          }
        }
      }
    }

    // Pick the best candidate by score
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      entryPosition = { x: best.x, z: best.z };
      entryWidth = best.width;
      // Determine face from position
      if (best.x >= cMaxX) entryFace = '+x';
      else if (best.x <= cMinX) entryFace = '-x';
      else if (best.z >= cMaxZ) entryFace = '+z';
      else if (best.z <= cMinZ) entryFace = '-z';
      else entryFace = frontFace; // recessed entries are inside the AABB
    }
  }

  // ── 11. Ground boundary / footprint ──
  // Count XZ columns with building blocks at the ground contact layer.
  // Perimeter = ground-level blocks adjacent to air in the XZ plane.
  const groundContactY = cMinY;
  let footprintArea = 0;
  let perimeterLength = 0;

  for (let z = cMinZ; z <= cMaxZ; z++) {
    for (let x = cMinX; x <= cMaxX; x++) {
      // Check bottom 2 layers for ground contact
      let hasGround = false;
      for (let dy = 0; dy < Math.min(2, centralH); dy++) {
        const y = groundContactY + dy;
        if (labels[(y * length + z) * width + x] === centralLabel) {
          hasGround = true;
          break;
        }
      }
      if (!hasGround) continue;
      footprintArea++;

      // Check 4-connected XZ neighbors — if any neighbor is air/empty, this is perimeter
      let isPerimeter = false;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]] as [number,number][]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= length) {
          isPerimeter = true; // grid edge = perimeter
          break;
        }
        let neighborHasGround = false;
        for (let dy = 0; dy < Math.min(2, centralH); dy++) {
          const y = groundContactY + dy;
          if (labels[(y * length + z + dz) * width + (x + dx)] === centralLabel) {
            neighborHasGround = true;
            break;
          }
        }
        if (!neighborHasGround) {
          isPerimeter = true;
          break;
        }
      }
      if (isPerimeter) perimeterLength++;
    }
  }

  // ── 12. Entry path generation ──
  // Straight-line path from the nearest grid edge to the entry position.
  // Follows the entry face normal outward to the grid boundary.
  const entryPath: Array<{ x: number; z: number }> = [];
  if (entryPosition) {
    let px = entryPosition.x;
    let pz = entryPosition.z;
    // Walk from entry toward the grid edge along the face normal
    const dx = entryFace === '+x' ? 1 : entryFace === '-x' ? -1 : 0;
    const dz = entryFace === '+z' ? 1 : entryFace === '-z' ? -1 : 0;
    // Start one step outside the entry
    px += dx;
    pz += dz;
    while (px >= 0 && px < width && pz >= 0 && pz < length) {
      // Skip if this position is inside the building
      const isBuilding = grid.inBounds(px, groundContactY, pz) &&
                         grid.get(px, groundContactY, pz) !== AIR;
      if (!isBuilding) {
        entryPath.push({ x: px, z: pz });
      }
      px += dx;
      pz += dz;
    }
  }

  // ── 13. Compactness and data quality ──
  const aabbArea = centralW * centralL;
  const compactness = aabbArea > 0 ? footprintArea / aabbArea : 0;

  // ── 14. Confidence scoring ──
  // Weighted heuristic 1-10 estimating voxelization quality.
  // Calibrated against Gemini visual scores: Francisco 9.5/10, Sentinel 5/10,
  // Green 6/10, Beach 4/10.
  let confidence = 5.0;

  // Positive indicators
  if (componentCount === 1) confidence += 1.0;
  else if (componentCount <= 3) confidence += 0.3;
  if (isRectangular) confidence += 0.5;
  if (isFlatRoof) confidence += 0.2;
  if (dominantPct > 40) confidence += 0.5;        // uniform facade color
  if (aspectRatio > 0.4 && aspectRatio < 2.0) confidence += 0.3;
  if (!isPartialCapture) confidence += 0.3;
  if (entryPosition) confidence += 0.3;            // detected entry = clean geometry
  // Footprint fill quality: high fill = clean rectangular building
  if (footprintFill > 0.4) confidence += 0.5;
  else if (footprintFill > 0.25) confidence += 0.2;
  // Large central component relative to total = focused capture
  const centralPct = totalNonAir > 0 ? (footprintArea * centralH) / totalNonAir : 0;
  if (centralPct > 0.6) confidence += 0.5;

  // Negative indicators
  if (isPartialCapture) confidence -= 2.0;
  if (noisePct > 15) confidence -= 1.5;
  else if (noisePct > 8) confidence -= 0.5;
  if (componentCount > 5) confidence -= 1.5;
  else if (componentCount > 3) confidence -= 0.5;
  if (slopeAngle > 10) confidence -= 0.5;
  if (totalNonAir < 500) confidence -= 2.0;
  else if (totalNonAir < 2000) confidence -= 0.5;
  if (edgeTouchPct > 15) confidence -= 1.0;
  // Small footprint relative to grid = lots of surrounding noise
  if (footprintArea < 50 && totalNonAir > 5000) confidence -= 1.0;

  confidence = Math.max(1, Math.min(10, confidence));

  const dataQuality: 'good' | 'fair' | 'poor' = confidence >= 7 ? 'good'
    : confidence >= 5 ? 'fair' : 'poor';

  // ── Build recommended pipeline args ──
  // Use AABB crop for non-rectangular buildings (preserves shape), circular for rectangular
  const needsCrop = componentCount > 1;
  const t = typology as BuildingTypology; // widen for future flatiron support
  const useAABBCrop = needsCrop && (t === 'flatiron' || t === 'complex');
  // solidifyCore works for rectangular buildings (block, tower, house).
  // Non-rectangular (flatiron, complex) need generic mode to preserve shape.
  const useGeneric = t === 'flatiron' || t === 'complex';
  // Use full palette only for white/gray rectangular buildings where it was tuned.
  // Non-rectangular and colored buildings need colors preserved.
  const wantFullPalette = !useGeneric && (WHITE_BLOCKS.has(dominantBlock) || WHITE_BLOCKS.has(secondaryBlock));
  const recommended = {
    generic: useGeneric,
    fill: true,
    noPalette: !wantFullPalette,
    noCornice: !isFlatRoof || typology === 'house',
    noFireEscape: typology !== 'block' || centralH < 15,
    smoothPct: 0, // disabled: modeFilter3D handles noise locally; smoothRareBlocks
    // uses global frequency threshold that erases surface details after interior fill
    // inflates totalNonAir (2% of 425K solid = 8500 blocks, erasing windows/trim)
    modePasses: noisePct > 10 ? 4 : 3, // v92: bumped 2-3→3-4 for cleaner surfaces (deep review: "noisy, artifact-ridden")
    cropRadius: needsCrop && !useAABBCrop ? suggestedCropRadius : 0,
    useAABBCrop,
    cleanMinSize: suggestedClean,
    remaps: suggestedRemaps,
  };

  return {
    groundPlaneY, slopeAngle, isFlat: slopeAngle < 3,
    componentCount, centralAABB, suggestedCropRadius,
    edgeTouchPct, isPartialCapture,
    typology, aspectRatio, footprintFill, isRectangular,
    isFlatRoof, roofVariance,
    dominantBlock, secondaryBlock, dominantPct, suggestedRemaps,
    protrusion1vCount, noisePct, suggestedClean,
    frontFace,
    confidence,
    entryPosition, entryFace, entryWidth,
    footprintArea, perimeterLength, groundContactY,
    entryPath,
    compactness, dataQuality,
    // At 1 block/m resolution, block dimensions ≈ meters
    estimatedWidthM: centralW,
    estimatedHeightM: centralH,
    estimatedDepthM: centralL,
    estimatedFloors: Math.max(1, Math.round(centralH / 3.5)),
    recommended,
  };
}

/**
 * Place an entry path (walkway) into the grid at the ground contact layer.
 * Stamps path blocks along the entry path from grid edge to the building entrance.
 * Only places blocks in air columns — doesn't overwrite existing geometry.
 *
 * @param grid       Target BlockGrid (modified in place)
 * @param analysis   Analysis result with entry path data
 * @param pathBlock  Block to use for the path (default: stone_brick_slab)
 * @returns Number of path blocks placed
 */
export function placeEntryPath(
  grid: BlockGrid,
  analysis: AnalysisResult,
  pathBlock = 'minecraft:smooth_stone_slab',
): number {
  const AIR = 'minecraft:air';
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

/**
 * Vegetation blocks to strip during post-processing.
 * Photogrammetry trees map to greens, dark browns, and olive tones.
 * Matches the set in voxelizer.ts (duplicated to avoid circular dependency).
 */
const VEGETATION_BLOCKS_POST = new Set([
  'minecraft:green_concrete', 'minecraft:lime_concrete',
  'minecraft:green_terracotta', 'minecraft:lime_terracotta',
  'minecraft:moss_block', 'minecraft:green_wool', 'minecraft:lime_wool',
  'minecraft:green_concrete_powder', 'minecraft:lime_concrete_powder',
  'minecraft:oak_leaves', 'minecraft:spruce_leaves', 'minecraft:birch_leaves',
  'minecraft:jungle_leaves', 'minecraft:acacia_leaves', 'minecraft:dark_oak_leaves',
  'minecraft:azalea_leaves', 'minecraft:flowering_azalea_leaves',
  'minecraft:grass_block', 'minecraft:moss_carpet',
  'minecraft:soul_soil', 'minecraft:podzol',
  'minecraft:mud', 'minecraft:packed_mud',
]);

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
  const AIR = 'minecraft:air';
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
const ROAD_BLOCKS = new Set([
  'minecraft:gray_concrete', 'minecraft:light_gray_concrete',
  'minecraft:stone', 'minecraft:andesite', 'minecraft:polished_andesite',
  'minecraft:smooth_stone', 'minecraft:stone_bricks',
  'minecraft:gray_terracotta', 'minecraft:light_gray_terracotta',
  'minecraft:gray_wool', 'minecraft:light_gray_wool',
  'minecraft:cobblestone', 'minecraft:gravel',
]);

/** Vehicle-like blocks: distinctive solid colors at low height */
const VEHICLE_BLOCKS = new Set([
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
  const AIR = 'minecraft:air';

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

/**
 * K-Means block palette consolidation — cluster exterior blocks into k groups
 * to ensure visual coherence. Without this, per-voxel CIE-Lab matching spreads
 * similar colors across many blocks (smooth_stone vs andesite vs stone_bricks)
 * creating noisy facades. This merges similar blocks into the k most distinct
 * representatives for a cleaner, more intentional look.
 *
 * Algorithm: frequency-weighted K-Means++ in CIE-Lab space.
 * Protected blocks (glass, fill, vegetation) are excluded from consolidation.
 *
 * @param grid  The BlockGrid to consolidate in-place
 * @param k     Number of distinct block clusters to keep (default: 5)
 * @returns     Number of blocks reassigned
 */
export function consolidateBlockPalette(grid: BlockGrid, k = 5): number {
  // Protected blocks that should not be consolidated
  const PROTECTED = new Set([
    'minecraft:air',
    'minecraft:smooth_stone', // fill block
    'minecraft:gray_stained_glass', // windows from glazeDarkWindows
    'minecraft:glass', 'minecraft:glass_pane',
    'minecraft:smooth_stone_slab', // entry path
  ]);

  // Build block → RGB lookup from WALL_CLUSTERS
  const blockRgb = new Map<string, [number, number, number]>();
  for (const cluster of WALL_CLUSTERS) {
    for (const opt of cluster.options) {
      if (!blockRgb.has(opt)) blockRgb.set(opt, [...cluster.rgb] as [number, number, number]);
    }
  }

  // Collect non-protected block frequencies
  const blockCounts = new Map<string, number>();
  const { width, height, length } = grid;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (PROTECTED.has(block) || !blockRgb.has(block)) continue;
        blockCounts.set(block, (blockCounts.get(block) || 0) + 1);
      }
    }
  }

  const uniqueBlocks = [...blockCounts.keys()];
  if (uniqueBlocks.length <= k) return 0; // Already few enough distinct blocks

  // Convert each unique block to Lab space with its count weight
  type BlockEntry = { block: string; lab: [number, number, number]; count: number };
  const entries: BlockEntry[] = uniqueBlocks.map(block => ({
    block,
    lab: rgbToLab(...blockRgb.get(block)!),
    count: blockCounts.get(block)!,
  }));

  // Sort by frequency descending — most common blocks become initial centroids
  entries.sort((a, b) => b.count - a.count);

  // K-Means++ initialization: pick k centroids weighted by distance to nearest existing centroid
  const centroids: [number, number, number][] = [entries[0].lab];
  for (let c = 1; c < k; c++) {
    // Compute distance from each entry to nearest existing centroid
    let totalDist = 0;
    const dists: number[] = [];
    for (const entry of entries) {
      let minDist = Infinity;
      for (const centroid of centroids) {
        const d = deltaESq(entry.lab[0], entry.lab[1], entry.lab[2], centroid[0], centroid[1], centroid[2]);
        if (d < minDist) minDist = d;
      }
      dists.push(minDist * entry.count); // Weight by frequency
      totalDist += minDist * entry.count;
    }
    // Pick proportional to distance²
    let target = Math.random() * totalDist;
    let picked = 0;
    for (let i = 0; i < dists.length; i++) {
      target -= dists[i];
      if (target <= 0) { picked = i; break; }
    }
    centroids.push([...entries[picked].lab] as [number, number, number]);
  }

  // K-Means iterations (max 20)
  const assignments = new Int32Array(entries.length);
  for (let iter = 0; iter < 20; iter++) {
    let changed = 0;

    // Assign each entry to nearest centroid
    for (let i = 0; i < entries.length; i++) {
      const { lab } = entries[i];
      let bestC = 0;
      let bestDist = deltaESq(lab[0], lab[1], lab[2], centroids[0][0], centroids[0][1], centroids[0][2]);
      for (let c = 1; c < k; c++) {
        const d = deltaESq(lab[0], lab[1], lab[2], centroids[c][0], centroids[c][1], centroids[c][2]);
        if (d < bestDist) { bestDist = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed++; }
    }

    if (changed === 0) break; // Converged

    // Recompute centroids (weighted by block count)
    for (let c = 0; c < k; c++) {
      let sumL = 0, sumA = 0, sumB = 0, totalW = 0;
      for (let i = 0; i < entries.length; i++) {
        if (assignments[i] !== c) continue;
        const w = entries[i].count;
        sumL += entries[i].lab[0] * w;
        sumA += entries[i].lab[1] * w;
        sumB += entries[i].lab[2] * w;
        totalW += w;
      }
      if (totalW > 0) {
        centroids[c] = [sumL / totalW, sumA / totalW, sumB / totalW];
      }
    }
  }

  // For each cluster, pick the representative block: the most frequent block in the cluster
  const clusterBlock = new Map<number, string>();
  for (let c = 0; c < k; c++) {
    let bestBlock = '';
    let bestCount = 0;
    for (let i = 0; i < entries.length; i++) {
      if (assignments[i] !== c) continue;
      if (entries[i].count > bestCount) {
        bestCount = entries[i].count;
        bestBlock = entries[i].block;
      }
    }
    if (bestBlock) clusterBlock.set(c, bestBlock);
  }

  // Build remap: for each entry, if its cluster's representative is different, remap
  const remap = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    const rep = clusterBlock.get(assignments[i]);
    if (rep && rep !== entries[i].block) {
      remap.set(entries[i].block, rep);
    }
  }

  if (remap.size === 0) return 0;

  // Apply remap in-place
  let reassigned = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        const newBlock = remap.get(block);
        if (newBlock) {
          grid.set(x, y, z, newBlock);
          reassigned++;
        }
      }
    }
  }

  return reassigned;
}

/**
 * Isolate the primary building by removing non-primary connected components.
 *
 * Uses size-weighted centrality scoring (same formula as analyzeGrid) to identify
 * the primary building component, then removes all other components except
 * nearby annexes (wings within `annexRadius` of the primary AABB with sufficient
 * volume). This replaces OSM masking when the polygon is misaligned.
 *
 * Safety: Single-component grids → 0 removals. Dominant central building →
 * only small debris removed.
 *
 * @param grid         Mutable BlockGrid
 * @param annexRadius  Keep secondary components within N blocks of primary AABB (default 3)
 * @param minVolumePct Annexes must be ≥ this fraction of primary volume to keep (default 0.05)
 * @returns Number of blocks removed
 */
export function isolatePrimaryBuilding(
  grid: BlockGrid,
  annexRadius = 2,      // v95: tightened 3→2 — adjacent buildings must be directly touching
  minVolumePct = 0.15,  // v95: tightened 0.05→0.15 — annexes must be ≥15% of primary volume
): number {
  const AIR = 'minecraft:air';
  const { width, height, length } = grid;

  // Step 1: Label connected components
  const { labels, count } = labelConnectedComponents(grid);
  if (count <= 1) return 0; // single component or empty — nothing to isolate

  // Step 2: Compute per-component centroid and volume
  const centroidX = new Float64Array(count + 1);
  const centroidZ = new Float64Array(count + 1);
  const compCounts = new Float64Array(count + 1);

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const lbl = labels[(y * length + z) * width + x];
        if (lbl === 0) continue;
        centroidX[lbl] += x;
        centroidZ[lbl] += z;
        compCounts[lbl]++;
      }
    }
  }

  // Step 3: Score components using volume × centrality (identical to analyzeGrid)
  const cx = width / 2;
  const cz = length / 2;
  const maxDist = Math.sqrt(cx * cx + cz * cz);
  let bestLabel = 1;
  let bestScore = -Infinity;
  let maxCompSize = 0;

  for (let i = 1; i <= count; i++) {
    if (compCounts[i] > maxCompSize) maxCompSize = compCounts[i];
  }

  for (let i = 1; i <= count; i++) {
    // Filter noise: must be ≥5% of largest component or ≥100 voxels
    if (compCounts[i] < Math.max(100, maxCompSize * 0.05)) continue;

    const mx = centroidX[i] / compCounts[i];
    const mz = centroidZ[i] / compCounts[i];
    const dist = Math.sqrt((mx - cx) * (mx - cx) + (mz - cz) * (mz - cz));
    const normalizedDist = maxDist > 0 ? dist / maxDist : 0;
    // v95: Reduced distance penalty 0.5→0.2 so volume dominates scoring.
    // Previously a centered component with 60% of the volume could beat the actual
    // target building if it was off-center. Now size is the primary signal.
    const score = compCounts[i] * (1.0 - normalizedDist * 0.2);

    if (score > bestScore) {
      bestScore = score;
      bestLabel = i;
    }
  }

  const primaryVolume = compCounts[bestLabel];

  // Step 4: Compute primary component's XZ AABB
  let pMinX = width, pMaxX = 0, pMinZ = length, pMaxZ = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (labels[(y * length + z) * width + x] !== bestLabel) continue;
        if (x < pMinX) pMinX = x;
        if (x > pMaxX) pMaxX = x;
        if (z < pMinZ) pMinZ = z;
        if (z > pMaxZ) pMaxZ = z;
      }
    }
  }

  // Step 5: Decide which components to keep
  const keepLabels = new Set<number>([bestLabel]);

  for (let i = 1; i <= count; i++) {
    if (i === bestLabel) continue;
    if (compCounts[i] < primaryVolume * minVolumePct) continue; // too small to be an annex

    // Compute this component's XZ AABB
    let cMinX = width, cMaxX = 0, cMinZ = length, cMaxZ = 0;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          if (labels[(y * length + z) * width + x] !== i) continue;
          if (x < cMinX) cMinX = x;
          if (x > cMaxX) cMaxX = x;
          if (z < cMinZ) cMinZ = z;
          if (z > cMaxZ) cMaxZ = z;
        }
      }
    }

    // Check if AABB overlaps or is within annexRadius of primary AABB
    const xOverlap = cMaxX >= pMinX - annexRadius && cMinX <= pMaxX + annexRadius;
    const zOverlap = cMaxZ >= pMinZ - annexRadius && cMinZ <= pMaxZ + annexRadius;
    if (xOverlap && zOverlap) {
      keepLabels.add(i);
    }
  }

  // Step 6: Clear everything not in keepLabels
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const lbl = labels[(y * length + z) * width + x];
        if (lbl === 0) continue; // air
        if (!keepLabels.has(lbl)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Enforce luminance contrast between roof, wall, and ground zone materials.
 *
 * Pure function — no grid mutation. Computes luminance via WALL_CLUSTERS RGB
 * lookup and ensures all zone pairs have at least `minDeltaL` luminance separation.
 *
 * @param roofBlock   Current roof dominant block (e.g. 'minecraft:gray_concrete')
 * @param wallBlock   Current wall dominant block
 * @param groundBlock Current ground zone block
 * @param minDeltaL   Minimum luminance difference between any pair (default 25)
 * @returns Adjusted triplet with guaranteed contrast
 */
export function enforceZoneContrast(
  roofBlock: string,
  wallBlock: string,
  groundBlock: string,
  minDeltaL = 25,
): { roof: string; wall: string; ground: string } {
  // Luminance from WALL_CLUSTERS RGB mean
  const blockLum = (block: string): number => {
    const c = WALL_CLUSTERS.find(cl => cl.options.includes(block));
    if (!c) return 128;
    return (c.rgb[0] + c.rgb[1] + c.rgb[2]) / 3;
  };

  let roof = roofBlock;
  let wall = wallBlock;
  let ground = groundBlock;

  const roofLum = blockLum(roof);
  let wallLum = blockLum(wall);

  // Step 1: Darken mid-gray satellite roofs (baked sunlight artifact, lum 100-155)
  if (roofLum >= 100 && roofLum <= 155) {
    roof = 'minecraft:gray_concrete'; // lum ~58
  }

  // Step 2: Ensure wall contrasts with roof
  const newRoofLum = blockLum(roof);
  const roofWallGap = Math.abs(newRoofLum - wallLum);
  if (roofWallGap < minDeltaL + 15) { // 40 = 25 + 15 for generous gap
    wall = newRoofLum < 100
      ? 'minecraft:stone_bricks'      // dark roof → medium textured wall (lum 124)
      : 'minecraft:polished_andesite'; // light roof → slate-toned wall (lum 134)
    wallLum = blockLum(wall);
  }

  // Step 3: Cap overly-bright walls — white/cream walls lose texture in renders
  if (wallLum > 190 && newRoofLum < 100) {
    wall = 'minecraft:stone_bricks'; // lum 124
    wallLum = blockLum(wall);
  }

  // Step 4: Ensure ground contrasts with wall
  const wallGroundGap = Math.abs(wallLum - blockLum(ground));
  if (wallGroundGap < minDeltaL) {
    // Pick ground that contrasts: if wall is light, go dark; if dark, go warm
    ground = wallLum > 140
      ? 'minecraft:polished_andesite' // lum 134 — medium contrast
      : 'minecraft:sandstone';        // lum 202 — warm contrast
    // If still too close, force guaranteed separation
    if (Math.abs(wallLum - blockLum(ground)) < minDeltaL) {
      ground = wallLum > 128 ? 'minecraft:gray_concrete' : 'minecraft:smooth_quartz';
    }
  }

  // Step 5: All three too similar — force guaranteed triplet
  const finalRoofLum = blockLum(roof);
  const finalWallLum = blockLum(wall);
  const finalGroundLum = blockLum(ground);
  const rwGap = Math.abs(finalRoofLum - finalWallLum);
  const wgGap = Math.abs(finalWallLum - finalGroundLum);
  const rgGap = Math.abs(finalRoofLum - finalGroundLum);
  if (rwGap < minDeltaL && wgGap < minDeltaL && rgGap < minDeltaL) {
    // Force dark/medium/warm triplet
    roof = 'minecraft:gray_concrete';     // lum 58
    wall = 'minecraft:stone_bricks';      // lum 124
    ground = 'minecraft:sandstone';       // lum 202
  }

  return { roof, wall, ground };
}
