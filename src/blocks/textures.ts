/**
 * Block to texture face mapping.
 * Maps block state IDs to per-face texture names for use with texture atlas.
 */

import type { BlockFace } from '../types/index.js';
import { getBlockName, getAxis } from './registry.js';

/** Per-face texture names for a block */
export interface BlockTextures {
  top: string;
  bottom: string;
  north: string;
  south: string;
  east: string;
  west: string;
}

/** Default face: all faces use the same texture */
function allFaces(name: string): BlockTextures {
  return { top: name, bottom: name, north: name, south: name, east: name, west: name };
}

/** Top-bottom different from sides */
function topBottomSides(top: string, bottom: string, side: string): BlockTextures {
  return { top, bottom, north: side, south: side, east: side, west: side };
}

/** Log-style: top/bottom are end grain, sides are bark */
function logTextures(end: string, side: string, axis: string = 'y'): BlockTextures {
  if (axis === 'x') {
    return { top: side, bottom: side, north: side, south: side, east: end, west: end };
  }
  if (axis === 'z') {
    return { top: side, bottom: side, north: end, south: end, east: side, west: side };
  }
  // axis === 'y' (default)
  return { top: end, bottom: end, north: side, south: side, east: side, west: side };
}

/**
 * Get texture names for each face of a block.
 * Returns texture atlas key names (not file paths).
 */
export function getBlockTextures(blockState: string): BlockTextures {
  const name = getBlockName(blockState);
  const axis = getAxis(blockState) ?? 'y';

  // Logs
  if (name.includes('_log') || name === 'dark_oak_log') {
    const woodType = name.replace('_log', '').replace('stripped_', '');
    const isStripped = name.startsWith('stripped_');
    const prefix = isStripped ? `stripped_${woodType}` : woodType;
    return logTextures(`${prefix}_log_top`, `${prefix}_log`, axis);
  }

  // Planks
  if (name.includes('_planks')) return allFaces(name);

  // Stone variants
  if (name === 'stone_bricks') return allFaces('stone_bricks');
  if (name === 'chiseled_stone_bricks') return allFaces('chiseled_stone_bricks');
  if (name === 'polished_andesite') return allFaces('polished_andesite');
  if (name === 'polished_deepslate') return allFaces('polished_deepslate');

  // Quartz
  if (name === 'quartz_block') return allFaces('quartz_block_side');
  if (name === 'quartz_pillar') return topBottomSides('quartz_block_top', 'quartz_block_bottom', 'quartz_pillar');
  if (name === 'smooth_quartz') return allFaces('quartz_block_bottom');

  // Crafting/utility blocks with distinct top
  if (name === 'crafting_table') return topBottomSides('crafting_table_top', 'oak_planks', 'crafting_table_side');
  if (name === 'bookshelf') return topBottomSides('oak_planks', 'oak_planks', 'bookshelf');
  if (name === 'furnace') return topBottomSides('furnace_top', 'furnace_top', 'furnace_front');

  // Concrete, glass, wool — uniform
  if (name.includes('concrete')) return allFaces(name);
  if (name.includes('glass')) return allFaces('glass');

  // Default: use block name as texture for all faces
  return allFaces(name);
}

/**
 * Get the appropriate face texture name for a given face direction.
 */
export function getFaceTexture(blockState: string, face: BlockFace): string {
  const textures = getBlockTextures(blockState);
  return textures[face];
}
