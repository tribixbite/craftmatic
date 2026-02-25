/**
 * Data-driven material resolution — replaces style-preset-based palette selection
 * for real-address generation.
 *
 * Instead of yearBuilt → StyleName → 50 hardcoded blocks, each material field
 * is resolved independently through a priority chain:
 *   1. Observed data (SV color, OSM tags, assessor records)
 *   2. Category default with deterministic random selection
 *
 * Fantasy style presets remain available for the creative Generate tab.
 */

import type { BlockState, BuildingCategory, RoofShape, FloorPlanShape } from '../types/index.js';
import type { StylePalette, MaterialPalette, StructuralProfile } from './styles.js';
import { rgbToWallBlock, rgbToRoofOverride, rgbToTrimBlock } from './color-blocks.js';
import type { PropertyData } from './address-pipeline.js';

// ─── Deterministic RNG ──────────────────────────────────────────────────────
// Inspired by arnis: per-element deterministic RNG seeded by address hash.
// Every building generates identically regardless of processing order.

/** Simple mulberry32 PRNG — returns values in [0, 1) */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element from an array using deterministic RNG */
function pick<T>(options: T[], rng: () => number): T {
  return options[Math.floor(rng() * options.length)];
}

// ─── Building Category Inference ─────────────────────────────────────────────

/** Infer building category from property type and OSM tags */
export function inferCategory(propertyType: string, osmBuilding?: string): BuildingCategory {
  const pt = propertyType.toLowerCase();
  const ob = (osmBuilding ?? '').toLowerCase();

  // Commercial
  if (/commercial|retail|office|shop|store|supermarket|mall/.test(pt) ||
      /commercial|retail|office|shop|supermarket/.test(ob)) return 'commercial';

  // Industrial
  if (/industrial|warehouse|factory|manufacturing/.test(pt) ||
      /industrial|warehouse|factory|manufacture/.test(ob)) return 'industrial';

  // Civic / Institutional
  if (/church|school|hospital|government|library|fire_station|police|civic|public/.test(pt) ||
      /church|school|hospital|government|library|fire_station|police|civic|public/.test(ob)) return 'civic';

  // Historic
  if (/historic|monument|heritage|castle|palace|museum/.test(pt) ||
      /historic|monument|heritage|castle|palace|museum/.test(ob)) return 'historic';

  // Everything else is residential
  return 'residential';
}

// ─── Category Default Palettes ───────────────────────────────────────────────
// Each field has an array of plausible block options. The resolver picks from
// these using deterministic RNG when no observed data is available.

interface CategoryPalette {
  wall: BlockState[];
  wallAccent: BlockState[];
  interiorWall: BlockState[];
  floorGround: BlockState[];
  floorUpper: BlockState[];
  ceiling: BlockState[];
  timber: BlockState[];
  roofStairs: string[];      // base name for stair/slab derivation
  roofCap: BlockState[];
  foundation: BlockState[];
  window: BlockState[];
  windowAccent: BlockState[];
  door: string[];            // base name for door derivation
  pillar: BlockState[];
  chairStairs: string[];     // base name for chair derivation
  fence: BlockState[];
  carpet: BlockState[];
  carpetAccent: BlockState[];
  lantern: BlockState[];
  lanternFloor: BlockState[];
  slab: string[];            // base name for slab derivation
  bannerColor: string[];
  bedColor: StylePalette['bedColor'][];
  fireplaceBlock: BlockState[];
  fireplaceAccent: BlockState[];
  tableSurface: BlockState[];
  candle: BlockState[];
  counterBlock: BlockState[];
  counterSlab: BlockState[];
  plant1: BlockState[];
  plant2: BlockState[];
  plant3: BlockState[];
  // Structural defaults
  defaultRoofShape: RoofShape;
  defaultPlanShape: FloorPlanShape;
  roofHeight: number;
  wallAccentFrequency: number;
}

const RESIDENTIAL: CategoryPalette = {
  wall: ['minecraft:smooth_quartz', 'minecraft:white_concrete', 'minecraft:birch_planks',
    'minecraft:oak_planks', 'minecraft:bricks', 'minecraft:sandstone'],
  wallAccent: ['minecraft:stripped_birch_log', 'minecraft:bricks', 'minecraft:stone_bricks',
    'minecraft:white_terracotta'],
  interiorWall: ['minecraft:white_concrete', 'minecraft:birch_planks', 'minecraft:smooth_quartz'],
  floorGround: ['minecraft:birch_planks', 'minecraft:oak_planks', 'minecraft:polished_andesite'],
  floorUpper: ['minecraft:birch_planks', 'minecraft:oak_planks', 'minecraft:spruce_planks'],
  ceiling: ['minecraft:birch_planks', 'minecraft:stripped_birch_log', 'minecraft:smooth_quartz'],
  timber: ['minecraft:birch_log', 'minecraft:oak_log', 'minecraft:spruce_log'],
  roofStairs: ['minecraft:stone_brick_stairs', 'minecraft:dark_oak_stairs',
    'minecraft:spruce_stairs', 'minecraft:brick_stairs'],
  roofCap: ['minecraft:stone_brick_slab[type=bottom]', 'minecraft:dark_oak_slab[type=bottom]',
    'minecraft:spruce_slab[type=bottom]', 'minecraft:brick_slab[type=bottom]'],
  foundation: ['minecraft:bricks', 'minecraft:cobblestone', 'minecraft:stone_bricks'],
  window: ['minecraft:glass_pane'],
  windowAccent: ['minecraft:glass_pane'],
  door: ['minecraft:birch_door', 'minecraft:oak_door', 'minecraft:spruce_door'],
  pillar: ['minecraft:quartz_pillar', 'minecraft:birch_log', 'minecraft:oak_log'],
  chairStairs: ['minecraft:birch_stairs', 'minecraft:oak_stairs', 'minecraft:spruce_stairs'],
  fence: ['minecraft:birch_fence', 'minecraft:oak_fence', 'minecraft:spruce_fence'],
  carpet: ['minecraft:blue_carpet', 'minecraft:red_carpet', 'minecraft:white_carpet',
    'minecraft:brown_carpet'],
  carpetAccent: ['minecraft:red_carpet', 'minecraft:light_gray_carpet', 'minecraft:yellow_carpet'],
  lantern: ['minecraft:lantern[hanging=true]'],
  lanternFloor: ['minecraft:lantern[hanging=false]'],
  slab: ['minecraft:birch_slab', 'minecraft:oak_slab', 'minecraft:spruce_slab'],
  bannerColor: ['blue', 'red', 'white'],
  bedColor: ['blue', 'white', 'red', 'brown', 'gray'],
  fireplaceBlock: ['minecraft:bricks', 'minecraft:cobblestone'],
  fireplaceAccent: ['minecraft:bricks', 'minecraft:stone_bricks'],
  tableSurface: ['minecraft:white_carpet', 'minecraft:light_gray_carpet'],
  candle: ['minecraft:candle[candles=3,lit=true]'],
  counterBlock: ['minecraft:smooth_quartz', 'minecraft:polished_andesite'],
  counterSlab: ['minecraft:birch_slab[type=bottom]', 'minecraft:smooth_quartz_slab[type=bottom]'],
  plant1: ['minecraft:potted_lily_of_the_valley', 'minecraft:potted_fern',
    'minecraft:potted_dandelion'],
  plant2: ['minecraft:potted_blue_orchid', 'minecraft:potted_azure_bluet',
    'minecraft:potted_allium'],
  plant3: ['minecraft:potted_red_tulip', 'minecraft:potted_poppy',
    'minecraft:potted_cornflower'],
  defaultRoofShape: 'gable',
  defaultPlanShape: 'rect',
  roofHeight: 8,
  wallAccentFrequency: 0,
};

const COMMERCIAL: CategoryPalette = {
  wall: ['minecraft:white_concrete', 'minecraft:light_gray_concrete',
    'minecraft:smooth_quartz', 'minecraft:iron_block'],
  wallAccent: ['minecraft:light_gray_concrete', 'minecraft:gray_concrete',
    'minecraft:polished_andesite'],
  interiorWall: ['minecraft:white_concrete', 'minecraft:light_gray_concrete'],
  floorGround: ['minecraft:polished_andesite', 'minecraft:smooth_stone'],
  floorUpper: ['minecraft:polished_andesite', 'minecraft:smooth_stone'],
  ceiling: ['minecraft:smooth_quartz', 'minecraft:white_concrete'],
  timber: ['minecraft:quartz_pillar', 'minecraft:iron_block'],
  roofStairs: ['minecraft:smooth_quartz_stairs', 'minecraft:stone_brick_stairs'],
  roofCap: ['minecraft:smooth_quartz_slab[type=bottom]', 'minecraft:stone_brick_slab[type=bottom]'],
  foundation: ['minecraft:polished_andesite', 'minecraft:stone_bricks'],
  window: ['minecraft:glass_pane', 'minecraft:light_blue_stained_glass_pane'],
  windowAccent: ['minecraft:light_blue_stained_glass_pane'],
  door: ['minecraft:iron_door'],
  pillar: ['minecraft:quartz_pillar', 'minecraft:iron_block'],
  chairStairs: ['minecraft:quartz_stairs', 'minecraft:stone_brick_stairs'],
  fence: ['minecraft:iron_bars'],
  carpet: ['minecraft:light_gray_carpet', 'minecraft:white_carpet'],
  carpetAccent: ['minecraft:gray_carpet'],
  lantern: ['minecraft:sea_lantern'],
  lanternFloor: ['minecraft:sea_lantern'],
  slab: ['minecraft:smooth_quartz_slab', 'minecraft:smooth_stone_slab'],
  bannerColor: ['white', 'blue'],
  bedColor: ['white', 'gray'],
  fireplaceBlock: ['minecraft:polished_andesite'],
  fireplaceAccent: ['minecraft:smooth_stone'],
  tableSurface: ['minecraft:light_gray_carpet'],
  candle: ['minecraft:candle[candles=1,lit=true]'],
  counterBlock: ['minecraft:smooth_quartz'],
  counterSlab: ['minecraft:smooth_quartz_slab[type=bottom]'],
  plant1: ['minecraft:potted_bamboo', 'minecraft:potted_fern'],
  plant2: ['minecraft:potted_fern', 'minecraft:potted_lily_of_the_valley'],
  plant3: ['minecraft:potted_lily_of_the_valley', 'minecraft:potted_bamboo'],
  defaultRoofShape: 'flat',
  defaultPlanShape: 'rect',
  roofHeight: 4,
  wallAccentFrequency: 5,
};

const INDUSTRIAL: CategoryPalette = {
  wall: ['minecraft:iron_block', 'minecraft:gray_concrete',
    'minecraft:stone', 'minecraft:smooth_stone'],
  wallAccent: ['minecraft:light_gray_concrete', 'minecraft:exposed_copper'],
  interiorWall: ['minecraft:iron_block', 'minecraft:gray_concrete'],
  floorGround: ['minecraft:smooth_stone', 'minecraft:polished_deepslate'],
  floorUpper: ['minecraft:smooth_stone', 'minecraft:polished_deepslate'],
  ceiling: ['minecraft:iron_block', 'minecraft:smooth_stone'],
  timber: ['minecraft:iron_block'],
  roofStairs: ['minecraft:smooth_stone_stairs', 'minecraft:cobblestone_stairs'],
  roofCap: ['minecraft:smooth_stone_slab[type=bottom]', 'minecraft:cobblestone_slab[type=bottom]'],
  foundation: ['minecraft:smooth_stone', 'minecraft:polished_deepslate'],
  window: ['minecraft:tinted_glass', 'minecraft:glass_pane'],
  windowAccent: ['minecraft:tinted_glass'],
  door: ['minecraft:iron_door'],
  pillar: ['minecraft:iron_block'],
  chairStairs: ['minecraft:stone_stairs'],
  fence: ['minecraft:chain', 'minecraft:iron_bars'],
  carpet: ['minecraft:gray_carpet'],
  carpetAccent: ['minecraft:light_gray_carpet'],
  lantern: ['minecraft:redstone_lamp'],
  lanternFloor: ['minecraft:redstone_lamp'],
  slab: ['minecraft:smooth_stone_slab'],
  bannerColor: ['gray', 'black'],
  bedColor: ['gray'],
  fireplaceBlock: ['minecraft:iron_block'],
  fireplaceAccent: ['minecraft:exposed_copper'],
  tableSurface: ['minecraft:gray_carpet'],
  candle: ['minecraft:redstone_lamp'],
  counterBlock: ['minecraft:iron_block'],
  counterSlab: ['minecraft:smooth_stone_slab[type=bottom]'],
  plant1: ['minecraft:potted_dead_bush'],
  plant2: ['minecraft:potted_cactus'],
  plant3: ['minecraft:potted_dead_bush'],
  defaultRoofShape: 'flat',
  defaultPlanShape: 'rect',
  roofHeight: 4,
  wallAccentFrequency: 0,
};

const CIVIC: CategoryPalette = {
  wall: ['minecraft:stone_bricks', 'minecraft:smooth_quartz',
    'minecraft:polished_andesite'],
  wallAccent: ['minecraft:chiseled_stone_bricks', 'minecraft:quartz_pillar'],
  interiorWall: ['minecraft:smooth_quartz', 'minecraft:white_concrete'],
  floorGround: ['minecraft:polished_andesite', 'minecraft:polished_deepslate'],
  floorUpper: ['minecraft:polished_andesite', 'minecraft:birch_planks'],
  ceiling: ['minecraft:smooth_quartz', 'minecraft:polished_andesite'],
  timber: ['minecraft:quartz_pillar'],
  roofStairs: ['minecraft:stone_brick_stairs', 'minecraft:dark_oak_stairs'],
  roofCap: ['minecraft:stone_brick_slab[type=bottom]', 'minecraft:dark_oak_slab[type=bottom]'],
  foundation: ['minecraft:stone_bricks', 'minecraft:polished_andesite'],
  window: ['minecraft:glass_pane'],
  windowAccent: ['minecraft:light_blue_stained_glass_pane'],
  door: ['minecraft:dark_oak_door', 'minecraft:oak_door'],
  pillar: ['minecraft:quartz_pillar', 'minecraft:stone_bricks'],
  chairStairs: ['minecraft:dark_oak_stairs', 'minecraft:oak_stairs'],
  fence: ['minecraft:dark_oak_fence', 'minecraft:stone_brick_wall'],
  carpet: ['minecraft:blue_carpet', 'minecraft:red_carpet'],
  carpetAccent: ['minecraft:light_gray_carpet'],
  lantern: ['minecraft:lantern[hanging=true]'],
  lanternFloor: ['minecraft:lantern[hanging=false]'],
  slab: ['minecraft:stone_brick_slab', 'minecraft:dark_oak_slab'],
  bannerColor: ['blue', 'white'],
  bedColor: ['blue', 'white'],
  fireplaceBlock: ['minecraft:stone_bricks'],
  fireplaceAccent: ['minecraft:chiseled_stone_bricks'],
  tableSurface: ['minecraft:white_carpet'],
  candle: ['minecraft:candle[candles=3,lit=true]'],
  counterBlock: ['minecraft:polished_andesite'],
  counterSlab: ['minecraft:smooth_stone_slab[type=bottom]'],
  plant1: ['minecraft:potted_oak_sapling'],
  plant2: ['minecraft:potted_fern'],
  plant3: ['minecraft:potted_azalea_bush'],
  defaultRoofShape: 'gable',
  defaultPlanShape: 'rect',
  roofHeight: 10,
  wallAccentFrequency: 4,
};

const HISTORIC: CategoryPalette = {
  wall: ['minecraft:bricks', 'minecraft:stone_bricks', 'minecraft:cobblestone'],
  wallAccent: ['minecraft:mossy_stone_bricks', 'minecraft:chiseled_stone_bricks'],
  interiorWall: ['minecraft:oak_planks', 'minecraft:birch_planks'],
  floorGround: ['minecraft:cobblestone', 'minecraft:oak_planks'],
  floorUpper: ['minecraft:oak_planks', 'minecraft:dark_oak_planks'],
  ceiling: ['minecraft:oak_planks', 'minecraft:dark_oak_planks'],
  timber: ['minecraft:oak_log', 'minecraft:dark_oak_log'],
  roofStairs: ['minecraft:dark_oak_stairs', 'minecraft:cobblestone_stairs',
    'minecraft:stone_brick_stairs'],
  roofCap: ['minecraft:dark_oak_slab[type=bottom]', 'minecraft:cobblestone_slab[type=bottom]',
    'minecraft:stone_brick_slab[type=bottom]'],
  foundation: ['minecraft:cobblestone', 'minecraft:stone_bricks'],
  window: ['minecraft:glass_pane'],
  windowAccent: ['minecraft:glass_pane', 'minecraft:gray_stained_glass_pane'],
  door: ['minecraft:dark_oak_door', 'minecraft:oak_door'],
  pillar: ['minecraft:oak_log', 'minecraft:dark_oak_log', 'minecraft:quartz_pillar'],
  chairStairs: ['minecraft:dark_oak_stairs', 'minecraft:oak_stairs'],
  fence: ['minecraft:dark_oak_fence', 'minecraft:oak_fence'],
  carpet: ['minecraft:red_carpet', 'minecraft:brown_carpet'],
  carpetAccent: ['minecraft:yellow_carpet', 'minecraft:red_carpet'],
  lantern: ['minecraft:lantern[hanging=true]'],
  lanternFloor: ['minecraft:lantern[hanging=false]'],
  slab: ['minecraft:dark_oak_slab', 'minecraft:oak_slab'],
  bannerColor: ['red', 'gray'],
  bedColor: ['red', 'brown'],
  fireplaceBlock: ['minecraft:cobblestone', 'minecraft:bricks'],
  fireplaceAccent: ['minecraft:mossy_cobblestone', 'minecraft:stone_bricks'],
  tableSurface: ['minecraft:red_carpet', 'minecraft:brown_carpet'],
  candle: ['minecraft:candle[candles=3,lit=true]'],
  counterBlock: ['minecraft:cobblestone', 'minecraft:oak_planks'],
  counterSlab: ['minecraft:cobblestone_slab[type=bottom]', 'minecraft:oak_slab[type=bottom]'],
  plant1: ['minecraft:potted_fern', 'minecraft:potted_oak_sapling'],
  plant2: ['minecraft:potted_dandelion', 'minecraft:potted_poppy'],
  plant3: ['minecraft:potted_red_tulip', 'minecraft:potted_allium'],
  defaultRoofShape: 'gable',
  defaultPlanShape: 'L',
  roofHeight: 10,
  wallAccentFrequency: 5,
};

/** Category default palettes indexed by BuildingCategory */
export const CATEGORY_DEFAULTS: Record<BuildingCategory, CategoryPalette> = {
  residential: RESIDENTIAL,
  commercial: COMMERCIAL,
  industrial: INDUSTRIAL,
  civic: CIVIC,
  historic: HISTORIC,
};

// ─── Observed Data Extraction ────────────────────────────────────────────────
// Parse observed colors/materials from PropertyData into block overrides.

/** Extract wall block from all available color/material sources */
function resolveWallBlock(prop: PropertyData, rng: () => number, cat: CategoryPalette, seed: number): BlockState {
  // Priority 0: Pre-set wallOverride from satellite/Smarty chain (set before pipeline)
  if (prop.wallOverride) return prop.wallOverride;
  // Priority 1: OSM building:colour → CIE-Lab nearest block (multi-option cluster)
  if (prop.osmBuildingColour) {
    const rgb = hexToRgb(prop.osmBuildingColour);
    if (rgb) return rgbToWallBlock(rgb[0], rgb[1], rgb[2], seed);
  }
  // Priority 2: SV color extraction
  if (prop.svWallOverride) return prop.svWallOverride;
  // Priority 3: SV texture classification
  if (prop.svTextureBlock) return prop.svTextureBlock;
  // Priority 4: Satellite detected color (multi-option cluster)
  if (prop.detectedColor) {
    return rgbToWallBlock(prop.detectedColor.r, prop.detectedColor.g, prop.detectedColor.b, seed);
  }
  // Priority 5: OSM building:material → block
  if (prop.osmMaterial) {
    const mapped = osmMaterialToBlock(prop.osmMaterial);
    if (mapped) return mapped;
  }
  // Priority 6: Smarty construction type → block
  if (prop.constructionType) {
    const mapped = constructionToBlock(prop.constructionType);
    if (mapped) return mapped;
  }
  // Priority 7: Smarty exterior type → block
  if (prop.exteriorType) {
    const mapped = exteriorTypeToBlock(prop.exteriorType);
    if (mapped) return mapped;
  }
  // Fallback: category default
  return pick(cat.wall, rng);
}

/** Extract roof override from observed data */
function resolveRoofOverride(
  prop: PropertyData, rng: () => number, cat: CategoryPalette,
): { stairs: string; cap: BlockState } {
  // Priority 1: OSM roof:colour (most specific — exact color)
  if (prop.osmRoofColour) {
    const rgb = hexToRgb(prop.osmRoofColour);
    if (rgb) {
      const override = rgbToRoofOverride(rgb[0], rgb[1], rgb[2]);
      return { stairs: override.north.replace(/\[.*$/, ''), cap: override.cap };
    }
  }
  // Priority 2: OSM roof:material (structured tag > image analysis)
  if (prop.osmRoofMaterial) {
    const mapped = osmRoofMaterialToStairs(prop.osmRoofMaterial);
    if (mapped) return mapped;
  }
  // Priority 3: Smarty roofType (assessor records)
  if (prop.roofType) {
    const mapped = smartyRoofTypeToStairs(prop.roofType);
    if (mapped) return mapped;
  }
  // Priority 4: SV roof color (image-derived — lowest real-data priority)
  if (prop.svRoofOverride) {
    return {
      stairs: prop.svRoofOverride.north.replace(/\[.*$/, ''),
      cap: prop.svRoofOverride.cap,
    };
  }
  // Fallback: category default (pick matching stair + cap at same index)
  const idx = Math.floor(rng() * cat.roofStairs.length);
  return {
    stairs: cat.roofStairs[idx],
    cap: cat.roofCap[Math.min(idx, cat.roofCap.length - 1)],
  };
}

/** Extract trim block from observed data */
function resolveTrimBlock(prop: PropertyData, rng: () => number, cat: CategoryPalette): BlockState {
  if (prop.osmBuildingColour) {
    const rgb = hexToRgb(prop.osmBuildingColour);
    if (rgb) return rgbToTrimBlock(rgb[0], rgb[1], rgb[2]);
  }
  if (prop.svTrimOverride) return prop.svTrimOverride;
  return pick(cat.wallAccent, rng);
}

// ─── Material Lookup Tables ──────────────────────────────────────────────────

/** OSM building:material → Minecraft wall block (from arnis pattern) */
function osmMaterialToBlock(material: string): BlockState | undefined {
  const m = material.toLowerCase().trim();
  const MAP: Record<string, BlockState> = {
    'brick': 'minecraft:bricks',
    'stone': 'minecraft:stone_bricks',
    'wood': 'minecraft:oak_planks',
    'timber_framing': 'minecraft:oak_planks',
    'concrete': 'minecraft:light_gray_concrete',
    'glass': 'minecraft:glass',
    'metal': 'minecraft:iron_block',
    'steel': 'minecraft:iron_block',
    'plaster': 'minecraft:white_concrete',
    'stucco': 'minecraft:sandstone',
    'adobe': 'minecraft:terracotta',
    'sandstone': 'minecraft:sandstone',
    'limestone': 'minecraft:smooth_quartz',
    'granite': 'minecraft:polished_granite',
    'marble': 'minecraft:smooth_quartz',
    'cob': 'minecraft:terracotta',
    'mud': 'minecraft:terracotta',
    'clay': 'minecraft:terracotta',
    'bamboo': 'minecraft:bamboo_planks',
    'vinyl': 'minecraft:white_concrete',
    'aluminium': 'minecraft:iron_block',
    'copper': 'minecraft:exposed_copper',
    'slate': 'minecraft:deepslate_bricks',
  };
  return MAP[m];
}

/** Smarty constructionType → Minecraft wall block */
function constructionToBlock(constructionType: string): BlockState | undefined {
  const ct = constructionType.toLowerCase().trim();
  if (/frame|wood/.test(ct)) return 'minecraft:oak_planks';
  if (/masonry|brick/.test(ct)) return 'minecraft:bricks';
  if (/concrete|reinforced/.test(ct)) return 'minecraft:light_gray_concrete';
  if (/steel|metal/.test(ct)) return 'minecraft:iron_block';
  if (/stone/.test(ct)) return 'minecraft:stone_bricks';
  if (/stucco/.test(ct)) return 'minecraft:sandstone';
  if (/log/.test(ct)) return 'minecraft:spruce_log';
  if (/adobe/.test(ct)) return 'minecraft:terracotta';
  return undefined;
}

/** Smarty exteriorType → Minecraft wall block */
function exteriorTypeToBlock(ext: string): BlockState | undefined {
  const e = ext.toLowerCase().trim();
  if (/vinyl|aluminum|siding/.test(e)) return 'minecraft:white_concrete';
  if (/brick/.test(e)) return 'minecraft:bricks';
  if (/stucco/.test(e)) return 'minecraft:sandstone';
  if (/wood|cedar|shingle/.test(e)) return 'minecraft:spruce_planks';
  if (/stone/.test(e)) return 'minecraft:stone_bricks';
  if (/concrete|block/.test(e)) return 'minecraft:light_gray_concrete';
  if (/metal|steel/.test(e)) return 'minecraft:iron_block';
  if (/log/.test(e)) return 'minecraft:spruce_log';
  return undefined;
}

/** OSM roof:material → stair base + cap */
function osmRoofMaterialToStairs(material: string): { stairs: string; cap: BlockState } | undefined {
  const m = material.toLowerCase().trim();
  const MAP: Record<string, { stairs: string; cap: BlockState }> = {
    'tile': { stairs: 'minecraft:brick_stairs', cap: 'minecraft:brick_slab[type=bottom]' },
    'clay': { stairs: 'minecraft:brick_stairs', cap: 'minecraft:brick_slab[type=bottom]' },
    'slate': { stairs: 'minecraft:deepslate_tile_stairs', cap: 'minecraft:deepslate_tile_slab[type=bottom]' },
    'metal': { stairs: 'minecraft:stone_stairs', cap: 'minecraft:stone_slab[type=bottom]' },
    'copper': { stairs: 'minecraft:cut_copper_stairs', cap: 'minecraft:cut_copper_slab[type=bottom]' },
    'concrete': { stairs: 'minecraft:smooth_stone_stairs', cap: 'minecraft:smooth_stone_slab[type=bottom]' },
    'asphalt': { stairs: 'minecraft:cobblestone_stairs', cap: 'minecraft:cobblestone_slab[type=bottom]' },
    'wood': { stairs: 'minecraft:spruce_stairs', cap: 'minecraft:spruce_slab[type=bottom]' },
    'thatch': { stairs: 'minecraft:oak_stairs', cap: 'minecraft:oak_slab[type=bottom]' },
    'glass': { stairs: 'minecraft:smooth_quartz_stairs', cap: 'minecraft:smooth_quartz_slab[type=bottom]' },
  };
  return MAP[m];
}

/** Smarty roofType (assessor roof covering) → stair base + cap */
function smartyRoofTypeToStairs(roofType: string): { stairs: string; cap: BlockState } | undefined {
  const r = roofType.toLowerCase().trim();
  if (/asphalt|composition|comp/.test(r)) return { stairs: 'minecraft:cobblestone_stairs', cap: 'minecraft:cobblestone_slab[type=bottom]' };
  if (/tile|clay/.test(r)) return { stairs: 'minecraft:brick_stairs', cap: 'minecraft:brick_slab[type=bottom]' };
  if (/slate/.test(r)) return { stairs: 'minecraft:deepslate_tile_stairs', cap: 'minecraft:deepslate_tile_slab[type=bottom]' };
  if (/metal|steel|tin/.test(r)) return { stairs: 'minecraft:stone_stairs', cap: 'minecraft:stone_slab[type=bottom]' };
  if (/wood|shake|shingle/.test(r)) return { stairs: 'minecraft:spruce_stairs', cap: 'minecraft:spruce_slab[type=bottom]' };
  if (/concrete|built.?up|membrane/.test(r)) return { stairs: 'minecraft:smooth_stone_stairs', cap: 'minecraft:smooth_stone_slab[type=bottom]' };
  if (/copper/.test(r)) return { stairs: 'minecraft:cut_copper_stairs', cap: 'minecraft:cut_copper_slab[type=bottom]' };
  return undefined;
}

/** Parse hex color (#RGB or #RRGGBB) to [r, g, b] tuple */
function hexToRgb(hex: string): [number, number, number] | undefined {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  if (h.length === 6) {
    return [
      parseInt(h.substring(0, 2), 16),
      parseInt(h.substring(2, 4), 16),
      parseInt(h.substring(4, 6), 16),
    ];
  }
  return undefined;
}

// ─── Main Resolver ───────────────────────────────────────────────────────────

/**
 * Resolve a full StylePalette from observed property data + category defaults.
 * This replaces the style-preset-based material selection for real addresses.
 *
 * The resulting palette is compatible with all existing generation code that
 * accepts StylePalette (gen-house.ts, structures.ts, rooms, decorators, etc.).
 */
export function resolvePalette(
  prop: PropertyData,
  category: BuildingCategory,
  seed: number,
): StylePalette {
  const rng = mulberry32(seed);
  const cat = CATEGORY_DEFAULTS[category];

  // Resolve key visual materials from observed data
  const wall = resolveWallBlock(prop, rng, cat, seed);
  const roofResolved = resolveRoofOverride(prop, rng, cat);
  const wallAccent = resolveTrimBlock(prop, rng, cat);

  // Derive structural timber from wall material — wood walls get matching log,
  // masonry/concrete walls get quartz pillar or oak log
  const timber = deriveTimber(wall, rng, cat);
  const hasAxis = timber.includes('_log');

  // Derive door from construction type
  const doorBase = deriveDoor(prop, wall, rng, cat);

  // Build the full MaterialPalette
  const materials: MaterialPalette = {
    wall,
    wallAccent,
    interiorWall: pick(cat.interiorWall, rng),
    floorGround: pick(cat.floorGround, rng),
    floorUpper: pick(cat.floorUpper, rng),
    ceiling: pick(cat.ceiling, rng),
    timber,
    timberX: hasAxis ? `${timber}[axis=x]` : timber,
    timberZ: hasAxis ? `${timber}[axis=z]` : timber,
    roofN: `${roofResolved.stairs}[facing=north]`,
    roofS: `${roofResolved.stairs}[facing=south]`,
    roofE: `${roofResolved.stairs}[facing=east]`,
    roofW: `${roofResolved.stairs}[facing=west]`,
    roofCap: roofResolved.cap,
    foundation: pick(cat.foundation, rng),
    window: pick(cat.window, rng),
    windowAccent: pick(cat.windowAccent, rng),
    doorLowerN: `${doorBase}[half=lower,facing=north,open=false,hinge=left]`,
    doorUpperN: `${doorBase}[half=upper,facing=north,open=false,hinge=left]`,
    doorLowerS: `${doorBase}[half=lower,facing=south,open=false,hinge=left]`,
    doorUpperS: `${doorBase}[half=upper,facing=south,open=false,hinge=left]`,
    pillar: pick(cat.pillar, rng),
    chairN: `${pick(cat.chairStairs, rng)}[facing=north]`,
    chairS: `${pick(cat.chairStairs, rng)}[facing=south]`,
    chairE: `${pick(cat.chairStairs, rng)}[facing=east]`,
    chairW: `${pick(cat.chairStairs, rng)}[facing=west]`,
    fence: pick(cat.fence, rng),
    carpet: pick(cat.carpet, rng),
    carpetAccent: pick(cat.carpetAccent, rng),
    lantern: pick(cat.lantern, rng),
    lanternFloor: pick(cat.lanternFloor, rng),
    torchN: 'minecraft:wall_torch[facing=north]',
    torchS: 'minecraft:wall_torch[facing=south]',
    torchE: 'minecraft:wall_torch[facing=east]',
    torchW: 'minecraft:wall_torch[facing=west]',
    slabBottom: `${pick(cat.slab, rng)}[type=bottom]`,
    slabTop: `${pick(cat.slab, rng)}[type=top]`,
    bannerN: `minecraft:${pick(cat.bannerColor, rng)}_wall_banner[facing=north]`,
    bannerS: `minecraft:${pick(cat.bannerColor, rng)}_wall_banner[facing=south]`,
    bedColor: pick(cat.bedColor, rng),
    fireplaceBlock: pick(cat.fireplaceBlock, rng),
    fireplaceAccent: pick(cat.fireplaceAccent, rng),
    tableSurface: pick(cat.tableSurface, rng),
    candle: pick(cat.candle, rng),
    counterBlock: pick(cat.counterBlock, rng),
    counterSlab: pick(cat.counterSlab, rng),
    plant1: pick(cat.plant1, rng),
    plant2: pick(cat.plant2, rng),
    plant3: pick(cat.plant3, rng),
  };

  // Structural profile — observed data overrides category defaults
  const profile: StructuralProfile = {
    defaultRoofShape: cat.defaultRoofShape,
    defaultPlanShape: cat.defaultPlanShape,
    roofHeight: cat.roofHeight,
    wallAccentFrequency: cat.wallAccentFrequency,
  };

  return { ...materials, ...profile };
}

/** Derive timber material that complements the wall block */
function deriveTimber(wall: BlockState, rng: () => number, cat: CategoryPalette): BlockState {
  // Wood walls → matching log variant
  if (wall.includes('oak_planks')) return 'minecraft:oak_log';
  if (wall.includes('birch_planks')) return 'minecraft:birch_log';
  if (wall.includes('spruce_planks')) return 'minecraft:spruce_log';
  if (wall.includes('dark_oak_planks')) return 'minecraft:dark_oak_log';
  if (wall.includes('jungle_planks')) return 'minecraft:jungle_log';
  if (wall.includes('spruce_log')) return 'minecraft:spruce_log';
  // Masonry/concrete/metal → category default
  return pick(cat.timber, rng);
}

/** Derive door material that matches the building */
function deriveDoor(prop: PropertyData, wall: BlockState, rng: () => number, cat: CategoryPalette): string {
  // Priority 1: Architecture type → door inference
  const archDoor = inferDoorFromArchitecture(
    prop.osmArchitecture ?? prop.architectureType ?? prop.svArchitectureLabel,
    prop.yearBuilt,
  );
  if (archDoor) return archDoor;
  // Priority 2: SV vision override
  if (prop.svDoorOverride) {
    return `minecraft:${prop.svDoorOverride}_door`;
  }
  // Priority 3: Iron door for modern/commercial wall materials
  if (wall.includes('iron_block') || wall.includes('concrete')) {
    return 'minecraft:iron_door';
  }
  // Priority 4: Wood door matching wall wood type
  if (wall.includes('oak_planks')) return 'minecraft:oak_door';
  if (wall.includes('birch_planks')) return 'minecraft:birch_door';
  if (wall.includes('spruce_planks')) return 'minecraft:spruce_door';
  if (wall.includes('dark_oak_planks')) return 'minecraft:dark_oak_door';
  // Category default
  return pick(cat.door, rng);
}

/** Infer door material from architecture type label */
function inferDoorFromArchitecture(arch: string | undefined, _year: number): string | undefined {
  if (!arch) return undefined;
  const a = arch.toLowerCase();
  // Modern/contemporary → iron door
  if (/contemporary|modern|minimalist|international|bauhaus/i.test(a)) return 'minecraft:iron_door';
  // Rustic/craftsman → spruce
  if (/craftsman|rustic|cabin|log|farmhouse/i.test(a)) return 'minecraft:spruce_door';
  // Gothic/Victorian → dark oak
  if (/victorian|gothic|queen\s*anne|second\s*empire/i.test(a)) return 'minecraft:dark_oak_door';
  // Colonial → birch (light formal)
  if (/colonial|georgian|federal|cape\s*cod/i.test(a)) return 'minecraft:birch_door';
  // Tudor → dark oak
  if (/tudor|half.?timber|english/i.test(a)) return 'minecraft:dark_oak_door';
  // Mediterranean/Desert → acacia
  if (/mediterranean|spanish|mission|pueblo|desert|adobe/i.test(a)) return 'minecraft:acacia_door';
  return undefined;
}
