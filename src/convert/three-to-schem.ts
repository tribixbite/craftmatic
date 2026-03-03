/**
 * Convert Three.js Object3D to .schem schematic data.
 *
 * Thin wrapper: voxelization is handled by voxelizer.ts (CIE-Lab + BVH).
 * This module re-exports threeToGrid and adds threeToSchem which
 * combines voxelization with schematic serialization.
 */

import type * as THREE from 'three';
import type { SchematicData } from '../types/index.js';
import { gridToSchematic } from '../schem/write.js';

// Re-export the upgraded voxelizer
export { threeToGrid } from './voxelizer.js';
export type { TextureSampler, VoxelizeProgress } from './voxelizer.js';

// Import locally for threeToSchem
import { threeToGrid } from './voxelizer.js';

/**
 * Convert a Three.js Object3D to SchematicData.
 * Voxelizes with CIE-Lab color matching + BVH acceleration,
 * then serializes as Sponge Schematic v2.
 */
export function threeToSchem(object: THREE.Object3D, resolution = 1): SchematicData {
  const grid = threeToGrid(object, resolution);
  return gridToSchematic(grid);
}
