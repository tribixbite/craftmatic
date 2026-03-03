/**
 * Browser mesh file → BlockGrid pipeline.
 * Loads mesh, voxelizes with CIE-Lab matching + BVH acceleration,
 * and provides a Canvas-backed texture sampler for UV-mapped meshes.
 */

import * as THREE from 'three';
import { BlockGrid } from '@craft/schem/types.js';
import { threeToGrid, type TextureSampler, type VoxelizeProgress } from '@craft/convert/voxelizer.js';
import { loadMeshFromBytes, analyzeMesh, type MeshInfo } from './mesh-import.js';
import type { RGB } from '@craft/types/index.js';

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

/**
 * Create a texture sampler backed by a 2D canvas.
 * Draws the texture to an offscreen canvas and samples pixels via getImageData.
 * Caches canvas per texture to avoid redrawing.
 */
function createCanvasTextureSampler(): TextureSampler {
  const cache = new Map<THREE.Texture, { ctx: CanvasRenderingContext2D; w: number; h: number }>();

  return (texture: THREE.Texture, uv: THREE.Vector2): RGB => {
    let entry = cache.get(texture);
    if (!entry) {
      const image = texture.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
      if (!image) return [128, 128, 128]; // No image data — neutral gray

      const w = image.width || 64;
      const h = image.height || 64;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image as CanvasImageSource, 0, 0);
      entry = { ctx: ctx as unknown as CanvasRenderingContext2D, w, h };
      cache.set(texture, entry);
    }

    // UV wrapping (repeat)
    const u = ((uv.x % 1) + 1) % 1;
    const v = ((uv.y % 1) + 1) % 1;
    const px = Math.floor(u * (entry.w - 1));
    const py = Math.floor((1 - v) * (entry.h - 1)); // UV y is flipped vs canvas

    const pixel = entry.ctx.getImageData(px, py, 1, 1).data;
    return [pixel[0], pixel[1], pixel[2]];
  };
}
