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
    voxelizeSurface(grid, box, resolution, meshes, sampler, options?.onProgress);
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
    await voxelizeSurfaceAsync(grid, box, resolution, meshes, sampler, yieldInterval, options?.onProgress);
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
): void {
  const { width, height, length } = grid;
  // Half-voxel distance threshold: a point is "on the surface" if the nearest
  // mesh surface is closer than this
  const threshold = 0.7 / resolution;

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
          grid.set(x, y, z, rgbToWallBlock(bestColor[0], bestColor[1], bestColor[2], seed));
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
): Promise<void> {
  const { width, height, length } = grid;
  const threshold = 0.7 / resolution;

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
          grid.set(x, y, z, rgbToWallBlock(bestColor[0], bestColor[1], bestColor[2], seed));
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
 */
export function createDataTextureSampler(): TextureSampler {
  return (texture: THREE.Texture, uv: THREE.Vector2): RGB => {
    const image = texture.image as { data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number };
    if (!image?.data || !image.width || !image.height) {
      return [128, 128, 128]; // No raw data — neutral gray
    }

    const w = image.width;
    const h = image.height;

    // UV wrapping (repeat)
    const u = ((uv.x % 1) + 1) % 1;
    const v = ((uv.y % 1) + 1) % 1;
    const px = Math.floor(u * (w - 1));
    const py = Math.floor((1 - v) * (h - 1)); // UV y is flipped

    const idx = (py * w + px) * 4;
    return [image.data[idx], image.data[idx + 1], image.data[idx + 2]];
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
