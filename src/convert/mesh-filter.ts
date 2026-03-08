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
export function flattenFacades(grid: BlockGrid, snapRadius = 2): number {
  const { width, height, length } = grid;
  let snapped = 0;

  // ── X-axis flattening: for each Z row, find dominant X planes ──
  for (let z = 0; z < length; z++) {
    // Build depth histogram across all Y for this Z slice
    const xHist = new Int32Array(width);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') xHist[x]++;
      }
    }

    // Find peaks: X positions with more voxels than both neighbors
    // A peak must have at least 15% of height to be a real wall plane
    const minPeak = height * 0.1;
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

    // Snap non-peak voxels to nearest peak within snapRadius
    for (let y = 0; y < height; y++) {
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
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        if (grid.get(x, y, z) !== 'minecraft:air') zHist[z]++;
      }
    }

    const minPeak = height * 0.1;
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

    for (let y = 0; y < height; y++) {
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
 * This produces solid building volumes with flat walls while preserving:
 * - Separation between distinct buildings (flood fill reaches between them)
 * - Bay window / recess shapes (exterior contour preserved)
 * - Surface texture colors (only interior air gets filled)
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param dilateRadius  Dilation radius for closing wall gaps (default: 3)
 * @returns Number of interior air voxels filled
 */
export function fillInteriorGaps(grid: BlockGrid, dilateRadius = 3): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let netFilled = 0;

  for (let y = 0; y < height; y++) {
    // Snapshot this layer: solid mask + block types
    const solid: boolean[] = new Array(width * length);
    const blocks: string[] = new Array(width * length);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const b = grid.get(x, y, z);
        const idx = z * width + x;
        blocks[idx] = b;
        solid[idx] = b !== AIR;
      }
    }

    // ── Step 1: Dilate solid voxels to close wall gaps ──
    // A larger radius closes more porosity but may also close real gaps
    // like courtyards. Manhattan distance keeps the dilation tight.
    const dilated: boolean[] = [...solid];
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (solid[z * width + x]) continue; // Already solid

        let hasSolid = false;
        for (let dz = -dilateRadius; dz <= dilateRadius && !hasSolid; dz++) {
          const nz = z + dz;
          if (nz < 0 || nz >= length) continue;
          for (let dx = -dilateRadius; dx <= dilateRadius && !hasSolid; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            if (Math.abs(dx) + Math.abs(dz) > dilateRadius) continue;
            if (solid[nz * width + nx]) hasSolid = true;
          }
        }
        if (hasSolid) dilated[z * width + x] = true;
      }
    }

    // ── Step 2: Flood fill from edges to find exterior air ──
    // Any air cell in the dilated grid reachable from an edge is "exterior."
    // Interior air pockets are enclosed by dilated walls and won't be reached.
    const exterior: boolean[] = new Array(width * length).fill(false);
    const queue: number[] = [];
    let head = 0;

    // Seed: all edge cells that are air in the dilated grid
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (z !== 0 && z !== length - 1 && x !== 0 && x !== width - 1) continue;
        const idx = z * width + x;
        if (!dilated[idx]) {
          exterior[idx] = true;
          queue.push(idx);
        }
      }
    }

    // BFS flood fill (4-connected)
    while (head < queue.length) {
      const idx = queue[head++];
      const qx = idx % width;
      const qz = (idx - qx) / width;

      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = qx + dx;
        const nz = qz + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
        const nIdx = nz * width + nx;
        if (exterior[nIdx] || dilated[nIdx]) continue; // Already visited or solid wall
        exterior[nIdx] = true;
        queue.push(nIdx);
      }
    }

    // ── Step 3: Fill interior air with nearest solid block ──
    // Only fill voxels that are air in the ORIGINAL grid and NOT exterior.
    // The dilation was only used for the flood fill computation.
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (solid[idx]) continue;     // Already solid in original
        if (exterior[idx]) continue;   // Exterior air — leave as-is

        // Find the nearest solid block in the original layer (search radius 5)
        let bestBlock = AIR;
        let bestDist = Infinity;
        const searchR = 5;
        for (let dz = -searchR; dz <= searchR; dz++) {
          const nz = z + dz;
          if (nz < 0 || nz >= length) continue;
          for (let dx = -searchR; dx <= searchR; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const nIdx = nz * width + nx;
            if (!solid[nIdx]) continue;
            const dist = Math.abs(dx) + Math.abs(dz);
            if (dist < bestDist) {
              bestDist = dist;
              bestBlock = blocks[nIdx];
            }
          }
        }

        if (bestBlock !== AIR) {
          grid.set(x, y, z, bestBlock);
          netFilled++;
        }
      }
    }
  }

  return netFilled;
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
export function smoothSurface(grid: BlockGrid): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let totalChanged = 0;

  // Face-adjacent offsets in XZ plane (4-connected)
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

  for (let y = 0; y < height; y++) {
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

    // Erode: remove solid voxels with < 3 solid 4-connected XZ neighbors
    // (these are 1-block protrusions on the surface)
    const eroded: boolean[] = [...layer];
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (!layer[idx]) continue;

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

export function modeFilter3D(grid: BlockGrid, passes = 2, radius = 1): number {
  const { width, height, length } = grid;

  // Blocks to never replace (structural/detail elements)
  const PROTECTED = new Set([
    'minecraft:air',
    'minecraft:glass', 'minecraft:glass_pane',
    'minecraft:gray_stained_glass', 'minecraft:black_stained_glass',
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
  facadeDepth = 4,
  windowBlock = 'minecraft:gray_stained_glass',
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let glazed = 0;

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

    // Strategy: only glaze air blocks that are clearly enclosed window slots.
    // Requirements: air in facade zone with ≥3 solid XZ neighbors AND
    // solid above AND below. This catches narrow window slots carved into
    // thick walls but skips wide-open balcony voids and building surfaces.
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (grid.get(x, y, z) !== AIR) continue;

        const edgeDist = Math.min(
          x - minX, maxX - x,
          z - minZ, maxZ - z,
        );
        if (edgeDist >= facadeDepth || edgeDist < 1) continue;

        // Count total solid neighbors (6-connected: ±X, ±Y, ±Z)
        let solidN = 0;
        if (x > 0 && grid.get(x - 1, y, z) !== AIR) solidN++;
        if (x < width - 1 && grid.get(x + 1, y, z) !== AIR) solidN++;
        if (z > 0 && grid.get(x, y, z - 1) !== AIR) solidN++;
        if (z < length - 1 && grid.get(x, y, z + 1) !== AIR) solidN++;
        if (y > 0 && grid.get(x, y - 1, z) !== AIR) solidN++;
        if (y < height - 1 && grid.get(x, y + 1, z) !== AIR) solidN++;
        // Need ≥4 solid of 6 neighbors: enclosed air pocket (window in wall)
        if (solidN >= 4) {
          grid.set(x, y, z, windowBlock);
          glazed++;
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
          grid.set(x, y, z, barBlock);
          converted++;
        }
      }
    }
  }

  return converted;
}
