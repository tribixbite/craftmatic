/**
 * Browser mesh file → BlockGrid pipeline.
 * Loads mesh, voxelizes with CIE-Lab matching + BVH acceleration,
 * and provides a Canvas-backed texture sampler for UV-mapped meshes.
 */

import { BlockGrid } from '@craft/schem/types.js';
import { threeToGridAsync, type VoxelizeProgress, type VoxelizeMode, type TextureSampler } from '@craft/convert/voxelizer.js';
import { loadMeshFromBytes, analyzeMesh, type MeshInfo } from './mesh-import.js';
import { createCanvasTextureSampler } from './texture-sampler.js';

/**
 * Load a mesh file and voxelize it into a BlockGrid.
 *
 * Uses async voxelizer (threeToGridAsync) which yields between BVH builds
 * and Y-layer slices — prevents freezing the main thread on large meshes.
 *
 * GLB files default to 'surface' mode (open photogrammetry meshes) while
 * OBJ defaults to 'solid' (watertight models).
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
    /** Voxelization mode: 'surface' for photogrammetry, 'solid' for watertight (auto-detected) */
    mode?: VoxelizeMode;
    /** Progress callback */
    onProgress?: (p: VoxelizeProgress) => void;
  },
): Promise<{ grid: BlockGrid; info: MeshInfo }> {
  const object = await loadMeshFromBytes(bytes, filename);
  const info = analyzeMesh(object);

  // Compute resolution that keeps the largest dimension under maxDimension.
  // Default 96 for browser — balances quality vs mobile voxelization speed.
  // At 96, a 140m building → 96×8×78 ≈ 60k voxels (vs 177k at 128).
  // CLI uses 256 via explicit option.
  const maxDim = options?.maxDimension ?? 96;
  const largestExtent = Math.max(info.boundingBox.width, info.boundingBox.height, info.boundingBox.depth);
  let resolution = options?.resolution ?? 1;
  if (largestExtent * resolution > maxDim) {
    resolution = maxDim / largestExtent;
  }

  // Create Canvas-backed texture sampler for UV-mapped meshes
  const sampler: TextureSampler | undefined = info.hasTextures
    ? createCanvasTextureSampler()
    : undefined;

  // Auto-detect mode: GLB/GLTF (photogrammetry) → surface, OBJ → solid
  const ext = filename.split('.').pop()?.toLowerCase();
  const mode = options?.mode ?? (ext === 'obj' ? 'solid' : 'surface');

  const grid = await threeToGridAsync(object, resolution, {
    onProgress: options?.onProgress,
    textureSampler: sampler,
    mode,
    maxDimension: maxDim,
    yieldInterval: 1, // yield every layer for responsive UI on mobile
  });

  return { grid, info };
}

