/**
 * Pre-voxelization mesh utilities — pure Three.js filters.
 *
 * `filterMeshesByHeight` removes flat terrain/roads/sidewalks from a set of
 * radius-filtered tile meshes before voxelization. `trimSparseBottomLayers`
 * trims empty-ish layers off the bottom of a voxel grid (same concern,
 * post-voxelization safety net).
 *
 * Moved from src/convert/mesh-filter/mesh-capture.ts to sever the browser's
 * dependency on the old mesh-filter barrel so Chunk 12 can delete it.
 */

import type * as THREE from 'three';
import { BlockGrid } from '../../schem/types.js';

export interface MeshCandidate {
  readonly child: THREE.Mesh;
  readonly worldBox: THREE.Box3;
}

/**
 * Filter captured tile meshes by vertical extent above estimated ground level.
 *
 * Two-pass algorithm:
 *   1. Compute world AABB for each mesh candidate
 *   2. Estimate ground as the median of AABB min-Y values
 *   3. Remove meshes whose max-Y doesn't rise above `minHeight` meters from ground
 *
 * Terrain, roads, and sidewalks are typically flat and sit near ground level,
 * so they get filtered out while building geometry (which rises above ground)
 * is preserved.
 */
export function filterMeshesByHeight(
  candidates: readonly MeshCandidate[],
  minHeight: number,
): {
  kept: MeshCandidate[];
  groundY: number;
  heightFiltered: number;
} {
  if (candidates.length === 0) {
    return { kept: [], groundY: 0, heightFiltered: 0 };
  }
  // Median min-Y as ground estimate — robust against outlier meshes.
  const yMins = candidates.map(c => c.worldBox.min.y).sort((a, b) => a - b);
  const groundY = yMins[Math.floor(yMins.length / 2)];

  const kept: MeshCandidate[] = [];
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
 */
export function trimSparseBottomLayers(
  grid: BlockGrid,
  fillThreshold = 0.05,
): BlockGrid {
  const { width, height, length } = grid;
  const totalXZ = width * length;

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
    if (y === height - 1) return grid;
  }

  if (trimY === 0) return grid;

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
