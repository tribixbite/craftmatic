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

      // Get triangle vertices (local space)
      const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
      const a = new THREE.Vector3().fromBufferAttribute(posAttr, i0);
      const b = new THREE.Vector3().fromBufferAttribute(posAttr, i1);
      const c = new THREE.Vector3().fromBufferAttribute(posAttr, i2);

      // Compute barycentric coordinates of closestPoint in the triangle
      const bary = computeBarycentric(closestPoint, a, b, c);

      // Interpolate UV using barycentric
      const uv0 = new THREE.Vector2().fromBufferAttribute(uvAttr, i0);
      const uv1 = new THREE.Vector2().fromBufferAttribute(uvAttr, i1);
      const uv2 = new THREE.Vector2().fromBufferAttribute(uvAttr, i2);

      uvCoord.set(
        uv0.x * bary.x + uv1.x * bary.y + uv2.x * bary.z,
        uv0.y * bary.x + uv1.y * bary.y + uv2.y * bary.z,
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
 * Returns Vector3(u, v, w) where P = u*A + v*B + w*C.
 */
function computeBarycentric(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): THREE.Vector3 {
  const v0 = new THREE.Vector3().subVectors(b, a);
  const v1 = new THREE.Vector3().subVectors(c, a);
  const v2 = new THREE.Vector3().subVectors(p, a);

  const d00 = v0.dot(v0);
  const d01 = v0.dot(v1);
  const d11 = v1.dot(v1);
  const d20 = v2.dot(v0);
  const d21 = v2.dot(v1);

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) return new THREE.Vector3(1, 0, 0); // Degenerate triangle

  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1.0 - v - w;

  return new THREE.Vector3(u, v, w);
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

/** Extended MeshBVH type with closestPointToPoint (available in v0.9.9) */
interface MeshBVHExt {
  closestPointToPoint(
    point: THREE.Vector3,
    target?: { point: THREE.Vector3; distance: number; faceIndex: number },
    minThreshold?: number,
    maxThreshold?: number,
  ): { point: THREE.Vector3; distance: number; faceIndex: number } | null;
}
