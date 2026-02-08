/**
 * Convert Three.js Object3D to .schem schematic data.
 * Voxelizes a Three.js scene into a block grid.
 *
 * Strategy:
 * 1. Get bounding box of the scene
 * 2. Create a voxel grid at the specified resolution
 * 3. For each grid cell, check if any geometry occupies it
 * 4. Map material color to closest Minecraft block state
 * 5. Build SchematicData from the voxel grid
 */

import * as THREE from 'three';
import { BlockGrid } from '../schem/types.js';
import type { SchematicData, RGB } from '../types/index.js';
import { gridToSchematic } from '../schem/write.js';
import { getAllBlockColors } from '../blocks/colors.js';

/**
 * Voxelize a Three.js scene into a BlockGrid.
 * @param object The Three.js Object3D to convert
 * @param resolution Blocks per unit (default: 1 unit = 1 block)
 */
export function threeToGrid(object: THREE.Object3D, resolution = 1): BlockGrid {
  // Get bounding box
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

  // Collect all meshes with their materials
  const meshes: { mesh: THREE.Mesh; color: RGB }[] = [];
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const material = child.material as THREE.MeshStandardMaterial;
      if (material && material.color) {
        const c = material.color;
        meshes.push({
          mesh: child,
          color: [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)],
        });
      }
    }
  });

  // For each voxel position, check if any mesh geometry contains it
  const raycaster = new THREE.Raycaster();
  const origins = [
    new THREE.Vector3(0, 1, 0),  // Top-down
    new THREE.Vector3(1, 0, 0),  // Side
    new THREE.Vector3(0, 0, 1),  // Front
  ];

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const worldX = box.min.x + (x + 0.5) / resolution;
        const worldY = box.min.y + (y + 0.5) / resolution;
        const worldZ = box.min.z + (z + 0.5) / resolution;

        // Raycast from multiple directions to detect occupancy
        const point = new THREE.Vector3(worldX, worldY, worldZ);

        for (const dir of origins) {
          const origin = point.clone().sub(dir.clone().multiplyScalar(1000));
          raycaster.set(origin, dir);

          for (const { mesh, color } of meshes) {
            const intersections = raycaster.intersectObject(mesh);
            if (intersections.length > 0) {
              // Check if our point is inside (odd number of intersections before it)
              const beforePoint = intersections.filter(
                i => i.distance < origin.distanceTo(point)
              );
              if (beforePoint.length % 2 === 1) {
                const blockState = colorToBlockState(color);
                grid.set(x, y, z, blockState);
                break;
              }
            }
          }

          if (grid.get(x, y, z) !== 'minecraft:air') break;
        }
      }
    }
  }

  return grid;
}

/**
 * Convert a Three.js Object3D to SchematicData.
 */
export function threeToSchem(object: THREE.Object3D, resolution = 1): SchematicData {
  const grid = threeToGrid(object, resolution);
  return gridToSchematic(grid);
}

/**
 * Map an RGB color to the closest Minecraft block state.
 * Uses Euclidean distance in RGB color space.
 */
function colorToBlockState(target: RGB): string {
  const allColors = getAllBlockColors();
  let bestBlock = 'minecraft:stone';
  let bestDist = Infinity;

  for (const [blockId, color] of allColors) {
    if (blockId === 'minecraft:air') continue;
    const dr = target[0] - color[0];
    const dg = target[1] - color[1];
    const db = target[2] - color[2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestBlock = blockId;
    }
  }

  return bestBlock;
}
