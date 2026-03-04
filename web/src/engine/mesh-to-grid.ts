/**
 * Browser mesh file → BlockGrid pipeline.
 * Loads mesh, voxelizes with CIE-Lab matching + BVH acceleration,
 * and provides a Canvas-backed texture sampler for UV-mapped meshes.
 */

import { BlockGrid } from '@craft/schem/types.js';
import { threeToGrid, type VoxelizeProgress } from '@craft/convert/voxelizer.js';
import { loadMeshFromBytes, analyzeMesh, type MeshInfo } from './mesh-import.js';
import { createCanvasTextureSampler } from './texture-sampler.js';

/**
 * Load a mesh file and voxelize it into a BlockGrid.
 *
 * @param bytes       Raw file bytes
 * @param filename    Original filename (for type detection)
 * @param options     Resolution and max dimension limits
 * @returns BlockGrid + mesh metadata
 */
export async function meshFileToGrid(
  bytes: ArrayBuffer,
  filename: string,
  options?: {
    /** Blocks per unit (default: 1) */
    resolution?: number;
    /** Clamp largest dimension to this many blocks (default: 256) */
    maxDimension?: number;
    /** Progress callback */
    onProgress?: (p: VoxelizeProgress) => void;
  },
): Promise<{ grid: BlockGrid; info: MeshInfo }> {
  const object = await loadMeshFromBytes(bytes, filename);
  const info = analyzeMesh(object);

  // Compute resolution that keeps the largest dimension under maxDimension
  const maxDim = options?.maxDimension ?? 256;
  const largestExtent = Math.max(info.boundingBox.width, info.boundingBox.height, info.boundingBox.depth);
  let resolution = options?.resolution ?? 1;
  if (largestExtent * resolution > maxDim) {
    resolution = maxDim / largestExtent;
  }

  // Create Canvas-backed texture sampler for UV-mapped meshes
  const sampler: TextureSampler | undefined = info.hasTextures
    ? createCanvasTextureSampler()
    : undefined;

  const grid = threeToGrid(object, resolution, {
    onProgress: options?.onProgress,
    textureSampler: sampler,
  });

  return { grid, info };
}

