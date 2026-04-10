/**
 * Semantic block palette — resolves OSM tags + building metadata into
 * Minecraft material palettes for the voxelizer pipeline.
 *
 * When photogrammetry textures are desaturated gray, every voxel maps to
 * andesite/stone/smooth_stone. This module provides metadata-driven material
 * overrides: OSM building:material/colour, building type heuristics, and
 * height-based glass curtain wall detection.
 */

import type { BlockState } from '../types/index.js';
import { rgbToWallBlock } from '../gen/color-blocks.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SemanticPalette {
  /** Primary facade material options (spatially hashed for variety) */
  wallBlocks: BlockState[];
  /** Tint color from OSM colour or SV — passed to rgbToWallBlock for natural variety */
  wallColor?: { r: number; g: number; b: number };
  /** Roof material options */
  roofBlocks?: BlockState[];
  /** Roof tint color from satellite */
  roofColor?: { r: number; g: number; b: number };
  /** Window/glass material */
  glassBlock?: BlockState;
  /** Source that determined the palette (for logging) */
  source: string;
}

// ─── Material Mappings ───────────────────────────────────────────────────────

/** OSM building:material → Minecraft wall block palette (multi-option for variety) */
const MATERIAL_PALETTES: Record<string, BlockState[]> = {
  brick:      ['minecraft:bricks', 'minecraft:red_nether_bricks'],
  stone:      ['minecraft:stone_bricks', 'minecraft:smooth_stone', 'minecraft:stone'],
  limestone:  ['minecraft:sandstone', 'minecraft:smooth_sandstone', 'minecraft:end_stone_bricks'],
  marble:     ['minecraft:quartz_block', 'minecraft:smooth_quartz'],
  granite:    ['minecraft:granite', 'minecraft:polished_granite'],
  sandstone:  ['minecraft:sandstone', 'minecraft:smooth_sandstone', 'minecraft:cut_sandstone'],
  concrete:   ['minecraft:white_concrete', 'minecraft:light_gray_concrete'],
  cement:     ['minecraft:white_concrete', 'minecraft:light_gray_concrete'],
  plaster:    ['minecraft:white_concrete', 'minecraft:smooth_quartz'],
  stucco:     ['minecraft:white_concrete', 'minecraft:smooth_quartz'],
  render:     ['minecraft:white_concrete', 'minecraft:light_gray_concrete'],
  glass:      ['minecraft:white_stained_glass', 'minecraft:light_gray_stained_glass', 'minecraft:glass'],
  metal:      ['minecraft:iron_block', 'minecraft:light_gray_concrete'],
  steel:      ['minecraft:iron_block', 'minecraft:light_gray_concrete'],
  aluminium:  ['minecraft:iron_block', 'minecraft:light_gray_concrete'],
  aluminum:   ['minecraft:iron_block', 'minecraft:light_gray_concrete'],
  wood:       ['minecraft:oak_planks', 'minecraft:stripped_oak_log'],
  timber:     ['minecraft:oak_planks', 'minecraft:stripped_oak_log'],
  clapboard:  ['minecraft:oak_planks', 'minecraft:birch_planks'],
  vinyl:      ['minecraft:white_concrete', 'minecraft:smooth_quartz'],
  siding:     ['minecraft:white_concrete', 'minecraft:smooth_quartz'],
  adobe:      ['minecraft:terracotta', 'minecraft:orange_terracotta'],
  mud:        ['minecraft:terracotta', 'minecraft:brown_terracotta'],
};

/** Blocks considered "gray monotone" from photogrammetry — candidates for override */
const GRAY_FAMILY = new Set<string>([
  'minecraft:andesite',
  'minecraft:polished_andesite',
  'minecraft:smooth_stone',
  'minecraft:stone',
  'minecraft:light_gray_concrete',
  'minecraft:gray_concrete',
  'minecraft:polished_deepslate',
  'minecraft:gravel',
  'minecraft:cobblestone',
  'minecraft:stone_bricks',
]);

/** Glass block variants that should never be overridden */
const GLASS_BLOCKS = new Set<string>([
  'minecraft:glass',
  'minecraft:glass_pane',
  'minecraft:gray_stained_glass',
  'minecraft:light_gray_stained_glass',
  'minecraft:white_stained_glass',
  'minecraft:black_stained_glass',
  'minecraft:blue_stained_glass',
  'minecraft:cyan_stained_glass',
  'minecraft:light_blue_stained_glass',
]);

// ─── Palette Resolution ──────────────────────────────────────────────────────

/**
 * Parse OSM colour tag (hex #rrggbb or CSS color name) to RGB.
 * Returns null if unparseable.
 */
function parseOSMColour(colour: string | undefined): { r: number; g: number; b: number } | null {
  if (!colour) return null;
  // Hex formats: #rgb, #rrggbb
  const hex6 = colour.match(/^#?([0-9a-f]{6})$/i);
  if (hex6) {
    const h = hex6[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const hex3 = colour.match(/^#?([0-9a-f]{3})$/i);
  if (hex3) {
    const h = hex3[1];
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  // Named CSS colors (common in OSM)
  const NAMED: Record<string, [number, number, number]> = {
    white:  [255, 255, 255], black:  [0,   0,   0],   gray:   [128, 128, 128],
    grey:   [128, 128, 128], red:    [255, 0,   0],   brown:  [139, 69,  19],
    beige:  [245, 245, 220], cream:  [255, 253, 208], tan:    [210, 180, 140],
    yellow: [255, 255, 0],   orange: [255, 165, 0],   green:  [0,   128, 0],
    blue:   [0,   0,   255], ivory:  [255, 255, 240], buff:   [218, 199, 155],
    salmon: [250, 128, 114], terracotta: [204, 78, 42], sandstone: [210, 180, 140],
  };
  const lower = colour.toLowerCase().trim();
  const named = NAMED[lower];
  if (named) return { r: named[0], g: named[1], b: named[2] };
  return null;
}

/**
 * Resolve a semantic block palette from available building metadata.
 *
 * Priority chain:
 * 1. OSM building:colour → tinted wall blocks via rgbToWallBlock
 * 2. OSM building:material → material-specific palette
 * 3. Height > 50m + commercial → glass curtain wall
 * 4. Building type heuristic → category defaults
 * 5. null (no semantic override available)
 *
 * @param osmTags     Raw OSM tags object (may be empty)
 * @param heightM     Building height in meters (0 if unknown)
 */
export function resolveSemanticPalette(
  osmTags: Record<string, string>,
  heightM: number,
): SemanticPalette | null {
  const material = osmTags['building:material'];
  const colour = osmTags['building:colour'];
  const roofColour = osmTags['roof:colour'];
  const buildingType = osmTags['building'] ?? 'yes';

  // Priority 1: OSM building:colour → tinted blocks
  const wallColor = parseOSMColour(colour);
  if (wallColor) {
    // Use rgbToWallBlock to get the nearest Minecraft block for this color
    const primary = rgbToWallBlock(wallColor.r, wallColor.g, wallColor.b);

    // Skip if the colour resolves to a gray-family block — photogrammetry already
    // provides natural gray texture variety. Recoloring gray→gray reduces diversity.
    if (GRAY_FAMILY.has(primary)) {
      return null;
    }

    const palette: SemanticPalette = {
      wallBlocks: [primary],
      wallColor,
      source: `OSM building:colour=${colour}`,
    };
    // Optionally add material variety if material tag also present
    if (material) {
      const matKey = material.toLowerCase().trim();
      const matPalette = MATERIAL_PALETTES[matKey];
      if (matPalette) {
        palette.wallBlocks = [...new Set([primary, ...matPalette])];
        palette.source += ` + material=${material}`;
      }
    }
    // Roof colour
    const roofColor = parseOSMColour(roofColour);
    if (roofColor) {
      palette.roofColor = roofColor;
      palette.roofBlocks = [rgbToWallBlock(roofColor.r, roofColor.g, roofColor.b)];
    }
    return palette;
  }

  // Priority 2: OSM building:material → material palette
  if (material) {
    const matKey = material.toLowerCase().trim();
    // Check exact match first, then substring match
    let matPalette = MATERIAL_PALETTES[matKey];
    if (!matPalette) {
      for (const [key, val] of Object.entries(MATERIAL_PALETTES)) {
        if (matKey.includes(key)) { matPalette = val; break; }
      }
    }
    if (matPalette) {
      const palette: SemanticPalette = {
        wallBlocks: matPalette,
        source: `OSM material=${material}`,
      };
      const roofColor = parseOSMColour(roofColour);
      if (roofColor) {
        palette.roofColor = roofColor;
        palette.roofBlocks = [rgbToWallBlock(roofColor.r, roofColor.g, roofColor.b)];
      }
      return palette;
    }
  }

  // Priority 3: Tall commercial → glass curtain wall
  const commercialTypes = new Set(['commercial', 'office', 'retail', 'hotel', 'industrial']);
  if (heightM > 50 && commercialTypes.has(buildingType)) {
    return {
      wallBlocks: ['minecraft:white_stained_glass', 'minecraft:light_gray_stained_glass', 'minecraft:light_gray_concrete'],
      glassBlock: 'minecraft:white_stained_glass',
      source: `height=${heightM.toFixed(0)}m + type=${buildingType} → glass curtain wall`,
    };
  }

  // Priority 4: Height > 30m without material → likely modern concrete/glass
  if (heightM > 30) {
    return {
      wallBlocks: ['minecraft:light_gray_concrete', 'minecraft:white_concrete', 'minecraft:smooth_quartz'],
      glassBlock: 'minecraft:light_gray_stained_glass',
      source: `height=${heightM.toFixed(0)}m → modern commercial default`,
    };
  }

  // No semantic data available
  return null;
}

// ─── Grid Application ────────────────────────────────────────────────────────

/**
 * Apply a semantic palette to a voxelized grid, replacing gray-family blocks
 * on facade surfaces with material-appropriate alternatives.
 *
 * Blend strategy: only overrides voxels whose current block is in GRAY_FAMILY.
 * Colorful blocks (bricks, terracotta, wood) and glass blocks are preserved.
 *
 * @param grid     BlockGrid (modified in place)
 * @param palette  Resolved semantic palette
 * @returns Number of blocks replaced
 */
export function applySemanticPalette(
  grid: import('../schem/types.js').BlockGrid,
  palette: SemanticPalette,
): number {
  const { width, height, length } = grid;
  const AIR = 'minecraft:air';
  let replaced = 0;

  // Determine wall height cutoff for roof vs wall assignment
  // Roof = top 15% of building, wall = everything else
  let maxY = 0;
  for (let y = height - 1; y >= 0; y--) {
    let hasBlock = false;
    for (let z = 0; z < length && !hasBlock; z++) {
      for (let x = 0; x < width && !hasBlock; x++) {
        if (grid.get(x, y, z) !== AIR) hasBlock = true;
      }
    }
    if (hasBlock) { maxY = y; break; }
  }
  const roofCutoffY = Math.round(maxY * 0.85);

  for (let y = 0; y < height; y++) {
    const isRoof = y >= roofCutoffY;

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;

        // Never override glass blocks
        if (GLASS_BLOCKS.has(block)) continue;

        // Only override gray-family blocks (blend, don't replace)
        if (!GRAY_FAMILY.has(block)) continue;

        // Roof blocks
        if (isRoof && palette.roofBlocks && palette.roofBlocks.length > 0) {
          if (palette.roofColor) {
            const rb = rgbToWallBlock(palette.roofColor.r, palette.roofColor.g, palette.roofColor.b, x, y, z);
            grid.set(x, y, z, rb);
          } else {
            // Spatial hash for variety
            const hash = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
            const rb = palette.roofBlocks[hash % palette.roofBlocks.length];
            grid.set(x, y, z, rb);
          }
          replaced++;
          continue;
        }

        // Wall blocks
        if (palette.wallColor) {
          // Use tinted wall color with spatial hash for natural variety
          const wb = rgbToWallBlock(palette.wallColor.r, palette.wallColor.g, palette.wallColor.b, x, y, z);
          grid.set(x, y, z, wb);
        } else if (palette.wallBlocks.length > 0) {
          // Spatial hash across palette options
          const hash = ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0;
          const wb = palette.wallBlocks[hash % palette.wallBlocks.length];
          grid.set(x, y, z, wb);
        }
        replaced++;
      }
    }
  }

  return replaced;
}
