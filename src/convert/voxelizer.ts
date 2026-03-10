/**
 * Voxelize Three.js scenes into BlockGrid using CIE-Lab perceptual color
 * matching and BVH-accelerated raycasting.
 *
 * Supports two modes:
 * - 'solid' (default): Odd-even ray test for watertight meshes (OBJ/STL uploads)
 * - 'surface': Nearest-point proximity for open surface meshes (3D photogrammetry tiles)
 *
 * Key features:
 * - CIE-Lab delta-E color matching via rgbToWallBlock (perceptually accurate)
 * - BVH acceleration via three-mesh-bvh (O(log n) ray-triangle tests)
 * - Optional TextureSampler for UV-mapped meshes (browser provides Canvas-backed)
 * - Progress callback + UI yielding for large meshes
 * - Position-based seed for visual variety in color cluster selection
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { BlockGrid } from '../schem/types.js';
import { rgbToWallBlock } from '../gen/color-blocks.js';
import type { RGB } from '../types/index.js';

/** Optional texture sampler — browser provides Canvas-backed, CLI passes undefined */
export type TextureSampler = (texture: THREE.Texture, uv: THREE.Vector2) => RGB;

/** Minecraft blocks that represent vegetation — rejected when filterVegetation is enabled.
 * Photogrammetry tree canopy maps to greens, dark browns, and olive tones across many
 * block types. This expanded set catches the full range of vegetation colors. */
const VEGETATION_BLOCKS = new Set([
  // Greens
  'minecraft:green_concrete', 'minecraft:lime_concrete',
  'minecraft:green_terracotta', 'minecraft:lime_terracotta',
  'minecraft:moss_block', 'minecraft:green_wool', 'minecraft:lime_wool',
  'minecraft:green_concrete_powder', 'minecraft:lime_concrete_powder',
  // Leaves / organic
  'minecraft:oak_leaves', 'minecraft:spruce_leaves', 'minecraft:birch_leaves',
  'minecraft:jungle_leaves', 'minecraft:acacia_leaves', 'minecraft:dark_oak_leaves',
  'minecraft:azalea_leaves', 'minecraft:flowering_azalea_leaves',
  'minecraft:grass_block', 'minecraft:moss_carpet',
  // Dark browns — only organic/soil blocks, NOT structural (brick, wood, terracotta)
  // Removed: dark_oak_planks, spruce_planks, dark_oak_log, spruce_log,
  // brown_terracotta, brown_concrete, brown_wool — these are valid building materials
  'minecraft:soul_soil', 'minecraft:podzol',
  'minecraft:mud', 'minecraft:packed_mud',
]);

/** Progress info emitted during voxelization */
export interface VoxelizeProgress {
  /** 0-1 completion ratio */
  progress: number;
  /** Current Y layer being processed */
  currentY: number;
  /** Total Y layers */
  totalY: number;
  /** Optional status message (e.g. BVH build phase) */
  message?: string;
}

/** Voxelization mode */
export type VoxelizeMode = 'solid' | 'surface';

interface MeshEntry {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  /** Inverse world matrix for transforming world points to mesh local space */
  inverseMatrix: THREE.Matrix4;
}

/**
 * Voxelize a Three.js scene into a BlockGrid with CIE-Lab color matching.
 *
 * @param object     The Three.js Object3D to voxelize
 * @param resolution Blocks per unit (default: 1 unit = 1 block)
 * @param options    Optional texture sampler, progress callback, and voxelization mode
 */
export function threeToGrid(
  object: THREE.Object3D,
  resolution = 1,
  options?: {
    onProgress?: (p: VoxelizeProgress) => void;
    textureSampler?: TextureSampler;
    /**
     * Voxelization mode:
     * - 'solid': Odd-even ray test (default). Best for watertight meshes (OBJ/STL files).
     * - 'surface': Nearest-point proximity. Best for open surface meshes (3D photogrammetry,
     *   Google 3D Tiles). A voxel is filled if any mesh surface is within half a voxel.
     */
    mode?: VoxelizeMode;
    /** Yield to main thread every N layers (default: 0 = no yielding, synchronous) */
    yieldInterval?: number;
    /** Skip voxels with vegetation colors (green/olive hues). For photogrammetry tiles. */
    filterVegetation?: boolean;
  },
): BlockGrid {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);

  const width = Math.ceil(size.x * resolution);
  const height = Math.ceil(size.y * resolution);
  const length = Math.ceil(size.z * resolution);

  if (width <= 0 || height <= 0 || length <= 0) {
    return new BlockGrid(1, 1, 1);
  }

  const grid = new BlockGrid(width, height, length);
  const sampler = options?.textureSampler;
  const mode = options?.mode ?? 'solid';
  const filterVeg = options?.filterVegetation ?? false;

  // Collect meshes and build BVH for each geometry
  const meshes: MeshEntry[] = [];
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      // Accept any material type — GLTF tiles use MeshStandardMaterial,
      // some older formats use MeshBasicMaterial or MeshPhongMaterial
      const mat = child.material as THREE.MeshStandardMaterial;
      if (mat) {
        const geo = child.geometry as THREE.BufferGeometry;
        if (geo && !(geo as BVHGeometry).boundsTree) {
          (geo as BVHGeometry).boundsTree = new MeshBVH(geo as never);
        }
        // Pre-compute inverse matrix for world→local transforms in surface mode
        const inverseMatrix = new THREE.Matrix4();
        child.updateWorldMatrix(true, false);
        inverseMatrix.copy(child.matrixWorld).invert();
        meshes.push({ mesh: child, material: mat, inverseMatrix });
      }
    }
  });

  if (mode === 'surface') {
    voxelizeSurface(grid, box, resolution, meshes, sampler, options?.onProgress, filterVeg);
  } else {
    voxelizeSolid(grid, box, resolution, meshes, sampler, options?.onProgress);
  }

  // Final progress
  if (options?.onProgress) {
    options.onProgress({ progress: 1, currentY: height, totalY: height });
  }

  return grid;
}

/**
 * Async version of threeToGrid — yields to the main thread between Y layers
 * to prevent UI freezing on large meshes (browser contexts).
 */
export async function threeToGridAsync(
  object: THREE.Object3D,
  resolution = 1,
  options?: {
    onProgress?: (p: VoxelizeProgress) => void;
    textureSampler?: TextureSampler;
    mode?: VoxelizeMode;
    /** Yield every N layers (default: 4) */
    yieldInterval?: number;
    /** Skip voxels with vegetation colors (green/olive hues). For photogrammetry tiles. */
    filterVegetation?: boolean;
  },
): Promise<BlockGrid> {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);

  const width = Math.ceil(size.x * resolution);
  const height = Math.ceil(size.y * resolution);
  const length = Math.ceil(size.z * resolution);

  if (width <= 0 || height <= 0 || length <= 0) {
    return new BlockGrid(1, 1, 1);
  }

  const grid = new BlockGrid(width, height, length);
  const sampler = options?.textureSampler;
  const mode = options?.mode ?? 'solid';
  const yieldInterval = options?.yieldInterval ?? 4;
  const filterVeg = options?.filterVegetation ?? false;

  // Collect meshes and build BVH (yield between builds to keep UI responsive)
  const meshes: MeshEntry[] = [];
  const meshChildren: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) meshChildren.push(child);
  });

  for (let mi = 0; mi < meshChildren.length; mi++) {
    const child = meshChildren[mi];
    const mat = child.material as THREE.MeshStandardMaterial;
    const geo = child.geometry as THREE.BufferGeometry;
    if (!geo) continue;
    if (!(geo as BVHGeometry).boundsTree) {
      options?.onProgress?.({
        progress: 0, currentY: 0, totalY: 1,
        message: `Building BVH ${mi + 1}/${meshChildren.length}...`,
      });
      (geo as BVHGeometry).boundsTree = new MeshBVH(geo as never);
      // Yield after each BVH construction so the browser can update UI
      await new Promise<void>(r => setTimeout(r, 0));
    }
    const inverseMatrix = new THREE.Matrix4();
    child.updateWorldMatrix(true, false);
    inverseMatrix.copy(child.matrixWorld).invert();
    meshes.push({ mesh: child, material: mat, inverseMatrix });
  }

  if (mode === 'surface') {
    await voxelizeSurfaceAsync(grid, box, resolution, meshes, sampler, yieldInterval, options?.onProgress, filterVeg);
  } else {
    // Solid mode is typically fast enough to run synchronously
    voxelizeSolid(grid, box, resolution, meshes, sampler, options?.onProgress);
  }

  options?.onProgress?.({ progress: 1, currentY: height, totalY: height });
  return grid;
}

// ─── Solid mode: odd-even inside/outside test ───────────────────────────────

function voxelizeSolid(
  grid: BlockGrid,
  box: THREE.Box3,
  resolution: number,
  meshes: MeshEntry[],
  sampler: TextureSampler | undefined,
  onProgress?: (p: VoxelizeProgress) => void,
): void {
  const { width, height, length } = grid;
  const raycaster = new THREE.Raycaster();
  const directions = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  const uvCoord = new THREE.Vector2();

  for (let y = 0; y < height; y++) {
    onProgress?.({ progress: y / height, currentY: y, totalY: height });

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const worldX = box.min.x + (x + 0.5) / resolution;
        const worldY = box.min.y + (y + 0.5) / resolution;
        const worldZ = box.min.z + (z + 0.5) / resolution;
        const point = new THREE.Vector3(worldX, worldY, worldZ);

        let hitColor: RGB | null = null;

        for (const dir of directions) {
          if (hitColor) break;

          const origin = point.clone().sub(dir.clone().multiplyScalar(1000));
          raycaster.set(origin, dir);

          for (const { mesh, material } of meshes) {
            const intersections = raycaster.intersectObject(mesh);
            if (intersections.length > 0) {
              const dist = origin.distanceTo(point);
              const before = intersections.filter(i => i.distance < dist);
              if (before.length % 2 === 1) {
                hitColor = getIntersectionColor(
                  intersections[before.length - 1], material, sampler, uvCoord,
                );
                break;
              }
            }
          }
        }

        if (hitColor) {
          const seed = x * 1000000 + y * 1000 + z;
          grid.set(x, y, z, rgbToWallBlock(hitColor[0], hitColor[1], hitColor[2], seed));
        }
      }
    }
  }
}

// ─── Surface mode: nearest-point proximity ──────────────────────────────────

/**
 * Surface voxelization using closest-point-to-geometry queries.
 *
 * For each voxel, finds the nearest point on any mesh surface.
 * If within half a voxel distance, the voxel is filled.
 * Color is sampled from the nearest surface point's UV/material.
 *
 * This works correctly for open surface meshes (photogrammetry, 3D tiles)
 * where the solid mode's odd-even test would fail.
 */
function voxelizeSurface(
  grid: BlockGrid,
  box: THREE.Box3,
  resolution: number,
  meshes: MeshEntry[],
  sampler: TextureSampler | undefined,
  onProgress?: (p: VoxelizeProgress) => void,
  filterVegetation = false,
): void {
  const { width, height, length } = grid;
  // Surface proximity threshold: voxels within this distance of mesh surface get filled.
  // Must be > 0.5/resolution (half-voxel) to guarantee at least one voxel per face.
  // 0.75 catches diagonal walls (voxel center-to-edge = 0.707) producing watertight
  // shells. May create 2-block thick walls at perpendiculars, but watertightness is
  // more important than sub-meter thinness at 1 block/m resolution.
  const threshold = 0.75 / resolution;

  // Reusable objects to avoid per-voxel allocation
  const localPoint = new THREE.Vector3();
  const closestTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: 0 };
  const uvCoord = new THREE.Vector2();

  for (let y = 0; y < height; y++) {
    onProgress?.({ progress: y / height, currentY: y, totalY: height });

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const worldX = box.min.x + (x + 0.5) / resolution;
        const worldY = box.min.y + (y + 0.5) / resolution;
        const worldZ = box.min.z + (z + 0.5) / resolution;

        let bestDist = Infinity;
        let bestColor: RGB | null = null;

        for (const { mesh, material, inverseMatrix } of meshes) {
          const geo = mesh.geometry as BVHGeometry;
          if (!geo.boundsTree) continue;

          // Transform world point to mesh's local coordinate space
          localPoint.set(worldX, worldY, worldZ);
          localPoint.applyMatrix4(inverseMatrix);

          // Find closest point on mesh surface via BVH
          closestTarget.distance = Infinity;
          const result = (geo.boundsTree as MeshBVHExt).closestPointToPoint(
            localPoint,
            closestTarget,
            0,
            Math.min(threshold, bestDist),  // maxThreshold optimization
          );

          if (result && result.distance < threshold && result.distance < bestDist) {
            bestDist = result.distance;
            // Sample color at the closest surface point
            bestColor = sampleColorAtSurfacePoint(
              geo, result.faceIndex, result.point, material,
              sampler, uvCoord,
            );
          }
        }

        if (bestColor) {
          const seed = x * 1000000 + y * 1000 + z;
          const block = rgbToWallBlock(bestColor[0], bestColor[1], bestColor[2], seed);
          // Skip vegetation blocks (trees/bushes in photogrammetry tiles)
          if (!filterVegetation || !VEGETATION_BLOCKS.has(block)) {
            grid.set(x, y, z, block);
          }
        }
      }
    }
  }
}

/**
 * Async surface voxelizer — yields to main thread between Y layers to prevent
 * UI freezing on large meshes in browser contexts.
 */
async function voxelizeSurfaceAsync(
  grid: BlockGrid,
  box: THREE.Box3,
  resolution: number,
  meshes: MeshEntry[],
  sampler: TextureSampler | undefined,
  yieldInterval: number,
  onProgress?: (p: VoxelizeProgress) => void,
  filterVegetation = false,
): Promise<void> {
  const { width, height, length } = grid;
  // Must match sync threshold — 0.75 / resolution (watertight diagonal shells)
  const threshold = 0.75 / resolution;

  // Pre-compute bounding boxes for each mesh (in world space) for fast rejection
  const meshBounds: THREE.Box3[] = meshes.map(({ mesh }) => {
    return new THREE.Box3().setFromObject(mesh).expandByScalar(threshold);
  });

  // Reusable objects — allocated once, reused per voxel
  const localPoint = new THREE.Vector3();
  const closestTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: 0 };
  const uvCoord = new THREE.Vector2();
  const worldPos = new THREE.Vector3();

  for (let y = 0; y < height; y++) {
    onProgress?.({ progress: y / height, currentY: y, totalY: height });

    // Yield to main thread periodically so UI stays responsive
    if (yieldInterval > 0 && y > 0 && y % yieldInterval === 0) {
      await new Promise<void>(r => setTimeout(r, 0));
    }

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const worldX = box.min.x + (x + 0.5) / resolution;
        const worldY = box.min.y + (y + 0.5) / resolution;
        const worldZ = box.min.z + (z + 0.5) / resolution;
        worldPos.set(worldX, worldY, worldZ);

        let bestDist = Infinity;
        let bestColor: RGB | null = null;

        for (let m = 0; m < meshes.length; m++) {
          // Fast AABB rejection — skip meshes whose bounding box is too far
          if (!meshBounds[m].containsPoint(worldPos)) continue;

          const { mesh, material, inverseMatrix } = meshes[m];
          const geo = mesh.geometry as BVHGeometry;
          if (!geo.boundsTree) continue;

          localPoint.set(worldX, worldY, worldZ);
          localPoint.applyMatrix4(inverseMatrix);

          closestTarget.distance = Infinity;
          const result = (geo.boundsTree as MeshBVHExt).closestPointToPoint(
            localPoint, closestTarget, 0, Math.min(threshold, bestDist),
          );

          if (result && result.distance < threshold && result.distance < bestDist) {
            bestDist = result.distance;
            bestColor = sampleColorAtSurfacePoint(
              geo, result.faceIndex, result.point, material, sampler, uvCoord,
            );
          }
        }

        if (bestColor) {
          const seed = x * 1000000 + y * 1000 + z;
          const block = rgbToWallBlock(bestColor[0], bestColor[1], bestColor[2], seed);
          // Skip vegetation blocks (trees/bushes in photogrammetry tiles)
          if (!filterVegetation || !VEGETATION_BLOCKS.has(block)) {
            grid.set(x, y, z, block);
          }
        }
      }
    }
  }
}

/**
 * Sample color at a surface point identified by faceIndex and position.
 * Uses UV interpolation to sample the texture at the exact surface point,
 * or falls back to material.color if no texture/UV data is available.
 */
function sampleColorAtSurfacePoint(
  geometry: THREE.BufferGeometry,
  faceIndex: number,
  closestPoint: THREE.Vector3,
  material: THREE.MeshStandardMaterial,
  sampler: TextureSampler | undefined,
  uvCoord: THREE.Vector2,
): RGB {
  // Interpolate UV at the closest surface point using barycentric coordinates
  if (sampler && material.map) {
    const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute | null;
    if (uvAttr) {
      const index = geometry.index;
      const i0 = index ? index.getX(faceIndex * 3) : faceIndex * 3;
      const i1 = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
      const i2 = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;

      // Get triangle vertices and compute barycentric (all using pre-allocated scratch)
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      _triA.fromBufferAttribute(posAttr, i0);
      _triB.fromBufferAttribute(posAttr, i1);
      _triC.fromBufferAttribute(posAttr, i2);
      computeBarycentric(closestPoint, _triA, _triB, _triC, _baryOut);

      // Interpolate UV using barycentric weights
      _uv0.fromBufferAttribute(uvAttr, i0);
      _uv1.fromBufferAttribute(uvAttr, i1);
      _uv2.fromBufferAttribute(uvAttr, i2);

      uvCoord.set(
        _uv0.x * _baryOut.x + _uv1.x * _baryOut.y + _uv2.x * _baryOut.z,
        _uv0.y * _baryOut.x + _uv1.y * _baryOut.y + _uv2.y * _baryOut.z,
      );

      return sampler(material.map, uvCoord);
    }
  }

  // Fallback to material base color
  const col = material.color ?? new THREE.Color(0x808080);
  return [Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255)];
}

/**
 * Compute barycentric coordinates of point P in triangle ABC.
 * Writes (u, v, w) into `out` where P = u*A + v*B + w*C.
 * Uses pre-allocated scratch vectors to avoid per-call allocations.
 */
// Pre-allocated scratch objects for hot-path functions (avoid per-voxel GC pressure)
const _baryV0 = new THREE.Vector3();
const _baryV1 = new THREE.Vector3();
const _baryV2 = new THREE.Vector3();
const _baryOut = new THREE.Vector3();
const _triA = new THREE.Vector3();
const _triB = new THREE.Vector3();
const _triC = new THREE.Vector3();
const _uv0 = new THREE.Vector2();
const _uv1 = new THREE.Vector2();
const _uv2 = new THREE.Vector2();

function computeBarycentric(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  _baryV0.subVectors(b, a);
  _baryV1.subVectors(c, a);
  _baryV2.subVectors(p, a);

  const d00 = _baryV0.dot(_baryV0);
  const d01 = _baryV0.dot(_baryV1);
  const d11 = _baryV1.dot(_baryV1);
  const d20 = _baryV2.dot(_baryV0);
  const d21 = _baryV2.dot(_baryV1);

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) return out.set(1, 0, 0); // Degenerate triangle

  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  return out.set(1.0 - v - w, v, w);
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Get the RGB color at an intersection point (used by solid mode).
 * Tries texture sampling first (if sampler provided and mesh has UV + texture),
 * then falls back to material.color.
 */
function getIntersectionColor(
  intersection: THREE.Intersection,
  material: THREE.MeshStandardMaterial,
  sampler: TextureSampler | undefined,
  uvCoord: THREE.Vector2,
): RGB {
  if (sampler && material.map && intersection.uv) {
    uvCoord.copy(intersection.uv);
    return sampler(material.map, uvCoord);
  }
  const c = material.color ?? new THREE.Color(0x808080);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}

/** Type augmentation for BVH-enhanced geometry */
interface BVHGeometry extends THREE.BufferGeometry {
  boundsTree?: MeshBVH;
}

/**
 * Create a texture sampler for CLI/Node contexts (no Canvas required).
 * Reads pixel data directly from DataTexture's raw typed array.
 * Falls back to material color for non-DataTexture images.
 *
 * Uses **dominant color (mode) sampling** instead of mean averaging:
 * pixels in the kernel are bucketed by luminance, and the most frequent
 * bucket's average color is returned. This preserves dominant surface
 * colors (e.g. white stucco) even when mixed with minority features
 * (windows, shadows, trim) that would pull the mean toward gray.
 *
 * @param gamma - Power-law brightness correction. Values < 1 brighten
 *   (e.g. 0.5 compensates for baked lighting in Google 3D Tiles textures).
 *   Default 1.0 (no correction).
 * @param kernelSize - Sampling kernel radius in pixels. At kernel=16,
 *   each sample inspects a 33x33 pixel region (~1089 pixels).
 *   Default 16.
 * @param desaturate - Saturation reduction factor (0-1). Default 0.65.
 */
export function createDataTextureSampler(gamma = 1.0, kernelSize = 24, desaturate = 0.5): TextureSampler {
  // Pre-compute 256-entry LUT for the gamma correction (avoids Math.pow per pixel)
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(Math.pow(i / 255, gamma) * 255);
  }

  // Luminance bucket count — 8 buckets ≈ 32 luminance levels each.
  // Enough granularity to separate light walls from dark shadows/windows,
  // but coarse enough that similar tones cluster together.
  const BUCKET_COUNT = 8;
  const BUCKET_SIZE = 256 / BUCKET_COUNT;

  return (texture: THREE.Texture, uv: THREE.Vector2): RGB => {
    const image = texture.image as { data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number };
    if (!image?.data || !image.width || !image.height) {
      return [128, 128, 128]; // No raw data — neutral gray
    }

    const w = image.width;
    const h = image.height;
    const data = image.data;

    // UV wrapping (repeat)
    const u = ((uv.x % 1) + 1) % 1;
    const v = ((uv.y % 1) + 1) % 1;
    const cx = Math.floor(u * (w - 1));
    const cy = Math.floor((1 - v) * (h - 1)); // UV y is flipped

    let r: number, g: number, b: number;
    // Whether center-pixel sampling picked a darker bucket than mode —
    // indicates a feature pixel (window, trim) whose darkness should be preserved.
    let isCenterPixelFeature = false;

    if (kernelSize <= 0) {
      // Point sampling (no bucketing)
      const idx = (cy * w + cx) * 4;
      r = data[idx]; g = data[idx + 1]; b = data[idx + 2];
    } else {
      // Dominant color (mode) sampling: bucket pixels by luminance,
      // then return the average color of the most populated bucket.
      // This beats mean averaging because:
      // - 60% white wall + 40% dark window → Mean=gray, Mode=white (correct)
      // - Shadows and trim become minority populations, not color pollution
      const bucketR = new Float64Array(BUCKET_COUNT);
      const bucketG = new Float64Array(BUCKET_COUNT);
      const bucketB = new Float64Array(BUCKET_COUNT);
      const bucketCount = new Uint32Array(BUCKET_COUNT);

      const k = kernelSize;
      for (let dy = -k; dy <= k; dy++) {
        const py = Math.min(h - 1, Math.max(0, cy + dy));
        for (let dx = -k; dx <= k; dx++) {
          const px = Math.min(w - 1, Math.max(0, cx + dx));
          const idx = (py * w + px) * 4;
          const pr = data[idx], pg = data[idx + 1], pb = data[idx + 2];
          // Luminance bucket (BT.601 approximation)
          const lum = (pr * 77 + pg * 150 + pb * 29) >> 8;
          const bucket = Math.min(BUCKET_COUNT - 1, Math.floor(lum / BUCKET_SIZE));
          bucketR[bucket] += pr;
          bucketG[bucket] += pg;
          bucketB[bucket] += pb;
          bucketCount[bucket]++;
        }
      }

      // Find the most populated bucket (mode)
      let bestBucket = 0;
      let bestCount = 0;
      for (let i = 0; i < BUCKET_COUNT; i++) {
        if (bucketCount[i] > bestCount) {
          bestCount = bucketCount[i];
          bestBucket = i;
        }
      }

      // Center-pixel bucket sampling: use the bucket that the CENTER pixel
      // belongs to, if it has enough support (>5% of kernel area). This
      // preserves minority features (windows, trim) as distinct darker blocks
      // instead of always returning the dominant wall color.
      const centerIdx = (cy * w + cx) * 4;
      const cLum = (data[centerIdx] * 77 + data[centerIdx + 1] * 150 + data[centerIdx + 2] * 29) >> 8;
      const centerBucket = Math.min(BUCKET_COUNT - 1, Math.floor(cLum / BUCKET_SIZE));
      const totalKernelPixels = (k * 2 + 1) * (k * 2 + 1);
      const minFeaturePixels = totalKernelPixels * 0.05; // 5% threshold
      const selectedBucket = bucketCount[centerBucket] >= minFeaturePixels ? centerBucket : bestBucket;
      // Track when center-pixel sampling chose a MUCH darker bucket than the
      // mode — this pixel is a real feature (window, deep recess) not just
      // baked shadow. Require ≥3 bucket gap (~96 luminance units) so same-
      // material shadows still get the black-point lift.
      isCenterPixelFeature = selectedBucket !== bestBucket && (bestBucket - selectedBucket) >= 3;

      if (bucketCount[selectedBucket] > 0) {
        r = Math.round(bucketR[selectedBucket] / bucketCount[selectedBucket]);
        g = Math.round(bucketG[selectedBucket] / bucketCount[selectedBucket]);
        b = Math.round(bucketB[selectedBucket] / bucketCount[selectedBucket]);
      } else if (bestCount > 0) {
        r = Math.round(bucketR[bestBucket] / bestCount);
        g = Math.round(bucketG[bestBucket] / bestCount);
        b = Math.round(bucketB[bestBucket] / bestCount);
      } else {
        r = 128; g = 128; b = 128;
      }
    }

    // ── Pipeline order: green detect → desaturate → luminance clamp
    // Desaturation runs FIRST so baked blue/warm shadows get neutralized to
    // dark gray before luminance clamping. If clamping ran first, it would
    // brighten colored shadows above the desaturation's lightness thresholds,
    // causing them to retain saturation and map to wrong blocks (terracotta, bricks).

    // Step 1: Detect green vegetation — skip desaturation/clamping for green pixels
    const pixelHue = (() => {
      const rf2 = r / 255, gf2 = g / 255, bf2 = b / 255;
      const mx = Math.max(rf2, gf2, bf2), mn = Math.min(rf2, gf2, bf2);
      if (mx === mn) return 0;
      const d2 = mx - mn;
      let h2 = 0;
      if (mx === rf2) h2 = ((gf2 - bf2) / d2 + (gf2 < bf2 ? 6 : 0)) / 6;
      else if (mx === gf2) h2 = ((bf2 - rf2) / d2 + 2) / 6;
      else h2 = ((rf2 - gf2) / d2 + 4) / 6;
      return h2 * 360;
    })();
    const isGreenish = pixelHue >= 85 && pixelHue <= 160;

    // Step 2: Selective desaturation — neutralize baked-lighting color casts.
    // Runs BEFORE luminance clamping so dark colored shadows become dark gray,
    // then clamping brightens them to visible mid-grays (stone, andesite).
    if (desaturate > 0 && !isGreenish) {
      const rf = r / 255, gf = g / 255, bf = b / 255;
      const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
      const l = (max + min) / 2;
      if (max !== min) {
        const d = max - min;
        let s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        let hue = 0;
        if (max === rf) hue = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
        else if (max === gf) hue = ((bf - rf) / d + 2) / 6;
        else hue = ((rf - gf) / d + 4) / 6;

        const hueDeg = hue * 360;
        // Blue/cyan (190°-260°): heavy desat — kill sky reflection shadows
        // Red/orange/brown (0°-70°, 320°-360°): preserve mid-tones (brick, sandstone)
        // Green (85°-160°, l<0.7): boost — vegetation recovery
        if (hueDeg >= 190 && hueDeg <= 260) {
          s *= 0.1; // Kill blue skylight contamination
        } else if ((hueDeg <= 70 || hueDeg >= 320) && l < 0.40) {
          s *= 0.3; // Only desat very dark warm (deep shadow, not brick)
        } else if (hueDeg >= 85 && hueDeg <= 160 && l < 0.7) {
          s = Math.min(1, s * 1.3); // Vegetation boost
        } else {
          s *= 0.85; // Preserve most color — was 0.7, too aggressive for building materials
        }

        const hue2rgb = (p: number, q: number, t: number): number => {
          if (t < 0) t += 1;
          if (t > 1) t -= 1;
          if (t < 1 / 6) return p + (q - p) * 6 * t;
          if (t < 1 / 2) return q;
          if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
          return p;
        };
        const q2 = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q2;
        r = Math.round(hue2rgb(p, q2, hue + 1 / 3) * 255);
        g = Math.round(hue2rgb(p, q2, hue) * 255);
        b = Math.round(hue2rgb(p, q2, hue - 1 / 3) * 255);
      }
    }

    // Step 3: Black-point lift — smoothly compress shadows into visible range.
    // Photogrammetry bakes deep ambient occlusion that maps to blackstone/deepslate.
    // Instead of multiplicative scaling (which amplifies color noise in dark pixels),
    // use a levels-style black point lift: output = MIN + input * (255-MIN) / 255.
    // This maps [0,255] → [MIN,255] without amplifying any channel.
    //
    // SKIP for center-pixel features (windows, trim): their darkness is the real
    // signal, not baked AO. Preserving dark values lets CIE-Lab match to
    // gray_concrete, polished_andesite, etc. for glazeDarkWindows to convert.
    if (!isGreenish && !isCenterPixelFeature) {
      const MIN_BRIGHT = 130;
      const range = 255 - MIN_BRIGHT; // 125
      r = Math.round(MIN_BRIGHT + (r * range) / 255);
      g = Math.round(MIN_BRIGHT + (g * range) / 255);
      b = Math.round(MIN_BRIGHT + (b * range) / 255);
    }

    // Apply gamma correction
    return [lut[r], lut[g], lut[b]];
  };
}

/** Extended MeshBVH type with closestPointToPoint (available in v0.9.9) */
interface MeshBVHExt {
  closestPointToPoint(
    point: THREE.Vector3,
    target?: { point: THREE.Vector3; distance: number; faceIndex: number },
    minThreshold?: number,
    maxThreshold?: number,
  ): { point: THREE.Vector3; distance: number; faceIndex: number } | null;
}
