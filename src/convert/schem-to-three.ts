/**
 * Convert .schem schematic data to Three.js Object3D.
 * Creates textured/colored mesh from block data.
 */

import * as THREE from 'three';
import { BlockGrid } from '../schem/types.js';
import type { SchematicData } from '../types/index.js';
import { schematicToGrid } from '../schem/parse.js';
import { buildScene } from '../render/three-scene.js';

/**
 * Convert SchematicData to a Three.js Group.
 * Each non-air block becomes an instanced mesh colored by block type.
 */
export function schemToThree(data: SchematicData): THREE.Group {
  const grid = schematicToGrid(data);
  return buildScene(grid);
}

/**
 * Convert a BlockGrid directly to a Three.js Group.
 */
export function gridToThree(grid: BlockGrid): THREE.Group {
  return buildScene(grid);
}
