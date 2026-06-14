/**
 * Browser mesh file → BlockGrid pipeline.
 * Loads mesh on main thread (requires DOM for texture loading), then offloads
 * BVH construction + voxelization to a Web Worker for non-blocking UI.
 *
 * Falls back to main-thread async voxelizer if Worker creation fails.
 */

import * as THREE from 'three';
import { BlockGrid } from '@craft/schem/types.js';
import { threeToGridAsync, type VoxelizeProgress, type VoxelizeMode } from '@craft/convert/voxelizer.js';
import { loadMeshFromBytes, analyzeMesh, type MeshInfo } from './mesh-import.js';
import { createCanvasTextureSampler } from './texture-sampler.js';
import type { SerializedMesh, WorkerInput, WorkerOutput } from './voxelize-worker.js';

/**
 * Load a mesh file and voxelize it into a BlockGrid.
 *
 * Uses a Web Worker for BVH + voxelization to keep the UI responsive.
 * Falls back to main-thread async voxelizer if Workers aren't available.
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
    /** Clamp largest dimension to this many blocks (default: 96) */
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

  // Auto-detect mode: GLB/GLTF (photogrammetry) → surface, OBJ → solid
  const ext = filename.split('.').pop()?.toLowerCase();
  const mode = options?.mode ?? (ext === 'obj' ? 'solid' : 'surface');

  // Try Web Worker path for non-blocking voxelization
  try {
    const grid = await voxelizeInWorker(object, resolution, maxDim, mode, options?.onProgress);
    return { grid, info };
  } catch (err) {
    console.warn('[mesh-to-grid] Worker failed, falling back to main thread:', err);
  }

  // Fallback: main-thread async voxelizer (yields between layers)
  const sampler = info.hasTextures ? createCanvasTextureSampler() : undefined;
  const grid = await threeToGridAsync(object, resolution, {
    onProgress: options?.onProgress,
    textureSampler: sampler,
    mode,
    maxDimension: maxDim,
    yieldInterval: 1,
  });

  return { grid, info };
}

/**
 * Serialize Three.js mesh data and run voxelization in a Web Worker.
 * Extracts geometry buffers + texture pixels on main thread (requires DOM),
 * then transfers them to the worker for BVH construction + voxelization.
 */
async function voxelizeInWorker(
  object: THREE.Object3D,
  resolution: number,
  maxDimension: number,
  mode: VoxelizeMode,
  onProgress?: (p: VoxelizeProgress) => void,
): Promise<BlockGrid> {
  // Compute bounding box on main thread (needed for worker input)
  const box = new THREE.Box3().setFromObject(object);

  // Serialize each mesh: extract geometry buffers + rasterize texture pixels
  const serializedMeshes: SerializedMesh[] = [];
  // Typed-array .buffer is ArrayBufferLike (could be SharedArrayBuffer in
  // general); these are all freshly-constructed plain ArrayBuffers, and the
  // list only feeds postMessage's transfer parameter.
  const transferables: Transferable[] = [];

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.material) return;

    const mat = child.material as THREE.MeshStandardMaterial;
    const geo = child.geometry as THREE.BufferGeometry;
    if (!geo?.attributes?.position) return;

    child.updateWorldMatrix(true, false);

    // Clone geometry buffers for transfer (originals stay on main thread)
    const posArray = new Float32Array(geo.attributes.position.array);
    transferables.push(posArray.buffer);

    let indexArray: Uint16Array | Uint32Array | null = null;
    if (geo.index) {
      indexArray = geo.index.array instanceof Uint32Array
        ? new Uint32Array(geo.index.array)
        : new Uint16Array(geo.index.array);
      transferables.push(indexArray.buffer);
    }

    let uvArray: Float32Array | null = null;
    if (geo.attributes.uv) {
      uvArray = new Float32Array(geo.attributes.uv.array);
      transferables.push(uvArray.buffer);
    }

    let normalArray: Float32Array | null = null;
    if (geo.attributes.normal) {
      normalArray = new Float32Array(geo.attributes.normal.array);
      transferables.push(normalArray.buffer);
    }

    // Rasterize texture to raw RGBA pixels using OffscreenCanvas
    let textureData: Uint8ClampedArray | null = null;
    let textureWidth = 0;
    let textureHeight = 0;
    if (mat.map?.image) {
      const pixels = rasterizeTexture(mat.map.image);
      if (pixels) {
        textureData = pixels.data;
        textureWidth = pixels.width;
        textureHeight = pixels.height;
        transferables.push(textureData.buffer);
      }
    }

    // Material base color (0-255 range)
    const col = mat.color ?? new THREE.Color(0xB0B0B0);
    const materialColor: [number, number, number] = [
      Math.round(col.r * 255),
      Math.round(col.g * 255),
      Math.round(col.b * 255),
    ];

    serializedMeshes.push({
      position: posArray,
      index: indexArray,
      uv: uvArray,
      normal: normalArray,
      materialColor,
      textureData,
      textureWidth,
      textureHeight,
      matrixWorld: Array.from(child.matrixWorld.elements),
    });
  });

  if (serializedMeshes.length === 0) {
    return new BlockGrid(1, 1, 1);
  }

  const workerInput: WorkerInput = {
    meshes: serializedMeshes,
    boxMin: [box.min.x, box.min.y, box.min.z],
    boxMax: [box.max.x, box.max.y, box.max.z],
    resolution,
    mode,
    maxDimension,
    filterVegetation: false,
  };

  // Spawn worker and run voxelization
  return new Promise<BlockGrid>((resolve, reject) => {
    const worker = new Worker(
      new URL('./voxelize-worker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (event: MessageEvent<WorkerOutput>) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        onProgress?.({
          progress: msg.progress,
          currentY: msg.currentY,
          totalY: msg.totalY,
          phase: msg.phase,
          message: msg.message,
        });
      } else if (msg.type === 'result') {
        // Reconstruct BlockGrid from worker output
        const grid = new BlockGrid(msg.width, msg.height, msg.length);
        const { blocks, palette } = msg;
        for (let y = 0; y < msg.height; y++) {
          for (let z = 0; z < msg.length; z++) {
            for (let x = 0; x < msg.width; x++) {
              const idx = (y * msg.length + z) * msg.width + x;
              const paletteIdx = blocks[idx];
              if (paletteIdx !== 0) { // Skip air (index 0)
                grid.set(x, y, z, palette[paletteIdx]);
              }
            }
          }
        }
        worker.terminate();
        resolve(grid);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(`Worker error: ${err.message}`));
    };

    // Transfer serialized data (zero-copy move, not clone)
    worker.postMessage(workerInput, transferables);
  });
}

/**
 * Rasterize a texture image to raw RGBA pixel data using OffscreenCanvas.
 * Returns null if the image can't be drawn (e.g., cross-origin).
 */
function rasterizeTexture(
  image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas,
): { data: Uint8ClampedArray; width: number; height: number } | null {
  try {
    const w = (image as HTMLImageElement).width || 64;
    const h = (image as HTMLImageElement).height || 64;
    // Cap texture size to reduce transfer overhead — 512×512 max for browser
    const maxTex = 512;
    const scale = Math.min(1, maxTex / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image as CanvasImageSource, 0, 0, tw, th);
    const imageData = ctx.getImageData(0, 0, tw, th);
    return { data: imageData.data, width: tw, height: th };
  } catch {
    return null;
  }
}
