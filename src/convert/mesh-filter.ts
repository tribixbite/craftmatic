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
        if (grid.get(x, y, z) !== 'air') filled++;
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
        if (block !== 'air') {
          trimmed.set(x, y, z, block);
        }
      }
    }
  }
  return trimmed;
}
