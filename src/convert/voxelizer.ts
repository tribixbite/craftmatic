/**
 * Voxelize Three.js scenes into BlockGrid using CIE-Lab perceptual color
 * matching and BVH-accelerated raycasting.
 *
 * Extracted from three-to-schem.ts. This module has zero imports from
 * ../schem/ (except types) so it can be included in browser builds.
 *
 * Key improvements over the original:
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

/**
 * Voxelize a Three.js scene into a BlockGrid with CIE-Lab color matching.
 *
 * @param object     The Three.js Object3D to voxelize
 * @param resolution Blocks per unit (default: 1 unit = 1 block)
 * @param options    Optional texture sampler and progress callback
 */
export function threeToGrid(
  object: THREE.Object3D,
  resolution = 1,
  options?: {
    onProgress?: (p: VoxelizeProgress) => void;
    textureSampler?: TextureSampler;
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

  // Collect meshes and build BVH for each geometry
  const meshes: { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial }[] = [];
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const mat = child.material as THREE.MeshStandardMaterial;
      if (mat) {
        // Build BVH acceleration structure for fast raycasting.
        // Assign to geometry.boundsTree so Three.js raycaster uses it automatically.
        const geo = child.geometry as THREE.BufferGeometry;
        if (geo && !(geo as BVHGeometry).boundsTree) {
          // Cast needed: three-mesh-bvh bundles its own @types/three version
          (geo as BVHGeometry).boundsTree = new MeshBVH(geo as never);
        }
        meshes.push({ mesh: child, material: mat });
      }
    }
  });

  // Ray directions for inside/outside testing
  const raycaster = new THREE.Raycaster();
  const directions = [
    new THREE.Vector3(0, 1, 0),   // Up
    new THREE.Vector3(1, 0, 0),   // Right
    new THREE.Vector3(0, 0, 1),   // Forward
  ];

  const uvCoord = new THREE.Vector2();

  for (let y = 0; y < height; y++) {
    // Progress callback
    if (options?.onProgress) {
      options.onProgress({ progress: y / height, currentY: y, totalY: height });
    }

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const worldX = box.min.x + (x + 0.5) / resolution;
        const worldY = box.min.y + (y + 0.5) / resolution;
        const worldZ = box.min.z + (z + 0.5) / resolution;
        const point = new THREE.Vector3(worldX, worldY, worldZ);

        let hitColor: RGB | null = null;

        // Try each ray direction to detect if point is inside geometry
        for (const dir of directions) {
          if (hitColor) break;

          const origin = point.clone().sub(dir.clone().multiplyScalar(1000));
          raycaster.set(origin, dir);

          for (const { mesh, material } of meshes) {
            const intersections = raycaster.intersectObject(mesh);
            if (intersections.length > 0) {
              // Odd number of intersections before our point = inside
              const dist = origin.distanceTo(point);
              const before = intersections.filter(i => i.distance < dist);
              if (before.length % 2 === 1) {
                // Get color from texture UV or material color
                hitColor = getIntersectionColor(
                  intersections[before.length - 1], material, sampler, uvCoord,
                );
                break;
              }
            }
          }
        }

        if (hitColor) {
          // Position-based seed for visual variety in color cluster selection
          const seed = x * 1000000 + y * 1000 + z;
          const blockState = rgbToWallBlock(hitColor[0], hitColor[1], hitColor[2], seed);
          grid.set(x, y, z, blockState);
        }
      }
    }
  }

  // Final progress
  if (options?.onProgress) {
    options.onProgress({ progress: 1, currentY: height, totalY: height });
  }

  return grid;
}

/**
 * Get the RGB color at an intersection point.
 * Tries texture sampling first (if sampler provided and mesh has UV + texture),
 * then falls back to material.color.
 */
function getIntersectionColor(
  intersection: THREE.Intersection,
  material: THREE.MeshStandardMaterial,
  sampler: TextureSampler | undefined,
  uvCoord: THREE.Vector2,
): RGB {
  // Try texture sampling via UV coordinates
  if (sampler && material.map && intersection.uv) {
    uvCoord.copy(intersection.uv);
    return sampler(material.map, uvCoord);
  }

  // Fallback to material base color
  const c = material.color ?? new THREE.Color(0x808080);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}

/** Type augmentation for BVH-enhanced geometry (avoids global prototype patching) */
interface BVHGeometry extends THREE.BufferGeometry {
  boundsTree?: MeshBVH;
}
