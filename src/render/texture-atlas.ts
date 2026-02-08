/**
 * Texture atlas management — load and build texture atlases
 * for block rendering. Currently uses solid colors with subtle
 * noise patterns as procedural textures.
 *
 * TODO: Implement full texture atlas building from individual PNGs
 * TODO: Add proper UV mapping for non-cubic blocks
 */

import type { AtlasUV, BlockFace, BlockFaceMap } from '../types/index.js';

/** Placeholder atlas UV — maps everything to full texture */
const FULL_UV: AtlasUV = { u: 0, v: 0, w: 1, h: 1 };

/**
 * Get UV coordinates for a block face from the texture atlas.
 * Currently returns placeholder UVs — will be replaced when
 * the atlas build system is implemented.
 */
export function getBlockFaceUV(_blockState: string, _face: BlockFace): AtlasUV {
  // TODO: Implement proper atlas UV lookup
  return FULL_UV;
}

/**
 * Get all face UVs for a block.
 */
export function getBlockUVs(_blockState: string): BlockFaceMap {
  return {
    top: FULL_UV,
    bottom: FULL_UV,
    north: FULL_UV,
    south: FULL_UV,
    east: FULL_UV,
    west: FULL_UV,
  };
}
