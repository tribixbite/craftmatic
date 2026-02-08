/**
 * Three.js scene builder — creates a 3D scene from schematic data.
 * Generates block meshes with color-coded materials.
 *
 * Note: Three.js is used server-side for scene graph construction.
 * The actual WebGL rendering happens in the browser via the viewer.
 */

import * as THREE from 'three';
import { BlockGrid } from '../schem/types.js';
import { getBlockColor } from '../blocks/colors.js';
import { isAir, isSolidBlock } from '../blocks/registry.js';
import type { RGB } from '../types/index.js';

/** Build a Three.js scene from a BlockGrid */
export function buildScene(grid: BlockGrid): THREE.Group {
  const group = new THREE.Group();
  const { width, height, length } = grid;

  // Collect unique materials
  const materialCache = new Map<string, THREE.MeshStandardMaterial>();

  // Instance tracking: group blocks by material for instanced rendering
  const instanceMap = new Map<string, THREE.Matrix4[]>();

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;

        // Skip fully occluded blocks (all 6 neighbors are solid)
        if (isFullyOccluded(grid, x, y, z)) continue;

        const color = getBlockColor(bs);
        if (!color) continue;

        const key = colorKey(color);
        if (!instanceMap.has(key)) {
          instanceMap.set(key, []);
          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color[0] / 255, color[1] / 255, color[2] / 255),
            roughness: 0.8,
            metalness: 0.1,
          });
          materialCache.set(key, mat);
        }

        const matrix = new THREE.Matrix4();
        matrix.setPosition(x - width / 2, y, z - length / 2);
        instanceMap.get(key)!.push(matrix);
      }
    }
  }

  // Create instanced meshes
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  for (const [key, matrices] of instanceMap) {
    const material = materialCache.get(key)!;
    const instanced = new THREE.InstancedMesh(geometry, material, matrices.length);
    for (let i = 0; i < matrices.length; i++) {
      instanced.setMatrixAt(i, matrices[i]);
    }
    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
  }

  return group;
}

/** Check if a block is completely surrounded by solid blocks */
function isFullyOccluded(grid: BlockGrid, x: number, y: number, z: number): boolean {
  return (
    isSolidBlock(grid.get(x + 1, y, z)) &&
    isSolidBlock(grid.get(x - 1, y, z)) &&
    isSolidBlock(grid.get(x, y + 1, z)) &&
    isSolidBlock(grid.get(x, y - 1, z)) &&
    isSolidBlock(grid.get(x, y, z + 1)) &&
    isSolidBlock(grid.get(x, y, z - 1))
  );
}

function colorKey(c: RGB): string {
  return `${c[0]},${c[1]},${c[2]}`;
}

/**
 * Serialize a BlockGrid to a JSON format suitable for the browser viewer.
 * Only includes non-air, visible blocks with their colors.
 */
export function serializeForViewer(grid: BlockGrid): object {
  const { width, height, length } = grid;
  const blocks: { x: number; y: number; z: number; color: RGB }[] = [];

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;
        if (isFullyOccluded(grid, x, y, z)) continue;

        const color = getBlockColor(bs);
        if (!color) continue;
        blocks.push({ x, y, z, color });
      }
    }
  }

  return {
    width, height, length,
    blockCount: blocks.length,
    blocks,
  };
}
