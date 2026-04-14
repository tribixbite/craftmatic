/**
 * Courtyard/atrium void detection for the voxelizer pipeline.
 *
 * Interior fill steps (fillInteriorGaps, scanlineInteriorFill) can solidify
 * intentional architectural voids — courtyards, atriums, light wells.
 * This module detects such voids post-fill by ray-casting upward from interior
 * air columns and returns the set of (x,z) coordinates that should remain empty.
 *
 * Algorithm:
 * 1. For each (x, z) column, check if it is an interior void:
 *    - Air at the top Y layer (sky-visible)
 *    - Air at ground level (empty column, not a wall)
 *    - Surrounded by solid walls on at least 2 horizontal sides
 * 2. Flood-fill connected void columns to find contiguous regions
 * 3. Filter: only keep regions with area > 4 blocks (ignore single-block gaps)
 */

import { BlockGrid } from '../../schem/types.js';

const AIR = 'minecraft:air';

/**
 * Check if a column has any solid (non-air) block at any Y level.
 */
function columnHasSolid(grid: BlockGrid, x: number, z: number): boolean {
  for (let y = 0; y < grid.height; y++) {
    if (grid.get(x, y, z) !== AIR) return true;
  }
  return false;
}

/**
 * Count how many of the 4 cardinal neighbors (N/S/E/W) have at least one
 * solid block in their column. This determines if a void column is "walled in".
 */
function countSolidNeighborSides(grid: BlockGrid, x: number, z: number): number {
  const { width, length } = grid;
  const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let solidSides = 0;
  for (const [dx, dz] of dirs) {
    const nx = x + dx;
    const nz = z + dz;
    // Out-of-bounds counts as solid (edge of grid acts as a wall)
    if (nx < 0 || nx >= width || nz < 0 || nz >= length) {
      solidSides++;
      continue;
    }
    if (columnHasSolid(grid, nx, nz)) solidSides++;
  }
  return solidSides;
}

/**
 * Detect courtyard/atrium voids by ray-casting upward from interior air columns.
 *
 * A void is a connected region of air columns that:
 * - Have sky access (no solid block at the topmost occupied Y layer or above)
 * - Are empty at ground level (air at y=0 or first few layers)
 * - Are surrounded by solid walls on at least 2 cardinal sides
 *
 * These voids are preserved during interior fill to prevent solidifying
 * courtyards, atriums, and light wells.
 *
 * @param grid  The BlockGrid after interior fill has been applied
 * @returns Set of "x,z" coordinate strings representing courtyard void columns
 */
export function detectCourtyardVoids(grid: BlockGrid): Set<string> {
  const { width, height, length } = grid;
  const result = new Set<string>();

  if (width === 0 || height === 0 || length === 0) return result;

  // Step 1: Find the effective building top — the highest Y with significant solid blocks.
  // This avoids false positives from spires/antennas that leave most columns "sky-visible".
  let topY = height - 1;
  for (let y = height - 1; y >= 0; y--) {
    let solidCount = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) solidCount++;
      }
    }
    // At least 3 solid blocks at this layer = meaningful building structure
    if (solidCount >= 3) {
      topY = y;
      break;
    }
  }

  // Step 2: Find the ground level — lowest Y with any solid block
  let groundY = 0;
  for (let y = 0; y < height; y++) {
    let hasSolid = false;
    for (let z = 0; z < length && !hasSolid; z++) {
      for (let x = 0; x < width && !hasSolid; x++) {
        if (grid.get(x, y, z) !== AIR) hasSolid = true;
      }
    }
    if (hasSolid) {
      groundY = y;
      break;
    }
  }

  // Step 3: Identify candidate courtyard columns.
  // A column is a courtyard candidate if:
  //  (a) The top layer is air (sky access — no solid block at topY)
  //  (b) The ground layer is air (empty at base, not a wall/foundation)
  //  (c) At least 2 cardinal neighbors have solid columns (walled in, not exterior)
  const candidates = new Set<string>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      // (a) Sky access: air at topY (and above)
      if (grid.get(x, topY, z) !== AIR) continue;

      // (b) Ground level empty: air at groundY
      if (grid.get(x, groundY, z) !== AIR) continue;

      // Additional check: the column should be entirely air (a true void column).
      // If it has scattered solid blocks, it's more likely a partial wall than a courtyard.
      if (columnHasSolid(grid, x, z)) continue;

      // (c) Surrounded by solid walls on >= 2 sides
      if (countSolidNeighborSides(grid, x, z) >= 2) {
        candidates.add(`${x},${z}`);
      }
    }
  }

  if (candidates.size === 0) return result;

  // Step 4: Flood-fill connected candidate columns into contiguous regions.
  // Only keep regions with area > 4 blocks (filter out single-block noise).
  const visited = new Set<string>();
  const MIN_REGION_SIZE = 4;

  for (const startKey of candidates) {
    if (visited.has(startKey)) continue;

    // BFS flood-fill from this candidate
    const region: string[] = [];
    const queue: string[] = [startKey];
    visited.add(startKey);

    while (queue.length > 0) {
      const key = queue.pop()!;
      region.push(key);

      // Parse coordinates from key
      const comma = key.indexOf(',');
      const cx = parseInt(key.substring(0, comma), 10);
      const cz = parseInt(key.substring(comma + 1), 10);

      // Check 4-connected neighbors
      const neighbors: [number, number][] = [
        [cx + 1, cz], [cx - 1, cz], [cx, cz + 1], [cx, cz - 1],
      ];
      for (const [nx, nz] of neighbors) {
        const nKey = `${nx},${nz}`;
        if (!visited.has(nKey) && candidates.has(nKey)) {
          visited.add(nKey);
          queue.push(nKey);
        }
      }
    }

    // Only keep regions larger than the minimum size
    if (region.length > MIN_REGION_SIZE) {
      for (const key of region) {
        result.add(key);
      }
    }
  }

  return result;
}
