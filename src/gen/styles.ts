/**
 * Style presets for structure generation.
 * Each style defines the block palette used for walls, floors, roofs,
 * timber, accents, lighting, and carpets.
 *
 * Uses CompactStyle specs — directional variants (facing, axis, half, type)
 * are derived automatically by createPalette() to eliminate duplication.
 */

import type { StyleName, BlockState, RoofShape } from '../types/index.js';

/** Material palette for a building style (fully expanded) */
export interface StylePalette {
  /** Primary exterior/interior wall material */
  wall: BlockState;
  /** Secondary wall accent material */
  wallAccent: BlockState;
  /** Interior dividing wall material */
  interiorWall: BlockState;
  /** Ground floor material */
  floorGround: BlockState;
  /** Upper story floor material */
  floorUpper: BlockState;
  /** Ceiling material */
  ceiling: BlockState;
  /** Structural timber / frame columns */
  timber: BlockState;
  /** Horizontal timber beams */
  timberX: BlockState;
  timberZ: BlockState;
  /** Roof stair material (north-facing) */
  roofN: BlockState;
  roofS: BlockState;
  /** Roof ridge cap */
  roofCap: BlockState;
  /** Default roof shape for this style */
  defaultRoofShape: RoofShape;
  /** Preferred roof height in blocks (controls pitch steepness) */
  roofHeight: number;
  /** Foundation material */
  foundation: BlockState;
  /** Window material */
  window: BlockState;
  /** Colored window */
  windowAccent: BlockState;
  /** Door lower/upper */
  doorLowerN: BlockState;
  doorUpperN: BlockState;
  doorLowerS: BlockState;
  doorUpperS: BlockState;
  /** Pillar / column material */
  pillar: BlockState;
  /** Stair material for furniture (chairs, couches) */
  chairN: BlockState;
  chairS: BlockState;
  chairE: BlockState;
  chairW: BlockState;
  /** Fence for tables */
  fence: BlockState;
  /** Primary carpet */
  carpet: BlockState;
  /** Secondary carpet */
  carpetAccent: BlockState;
  /** Hanging lantern */
  lantern: BlockState;
  /** Floor lantern */
  lanternFloor: BlockState;
  /** Wall torch */
  torchN: BlockState;
  torchS: BlockState;
  torchE: BlockState;
  torchW: BlockState;
  /** Slab material */
  slabBottom: BlockState;
  slabTop: BlockState;
  /** Banner colors */
  bannerN: BlockState;
  bannerS: BlockState;
  // ─── Style-specific furniture ─────────────────────────────────────────────
  /** Bed color name (used in bed block IDs) */
  bedColor: 'red' | 'blue' | 'cyan' | 'white' | 'green' | 'brown' | 'black' | 'gray' | 'orange' | 'light_blue';
  /** Fireplace surround block */
  fireplaceBlock: BlockState;
  /** Fireplace accent block (side columns) */
  fireplaceAccent: BlockState;
  /** Table surface material (placed on top of fence posts) */
  tableSurface: BlockState;
  /** Candle style for table decorations */
  candle: BlockState;
  /** Counter/workbench surface block */
  counterBlock: BlockState;
  /** Counter surface slab */
  counterSlab: BlockState;
  /** Decorative potted plants — 3 variants per style */
  plant1: BlockState;
  plant2: BlockState;
  plant3: BlockState;
}

// ─── Compact Style Spec ──────────────────────────────────────────────────────

/**
 * Compact style definition — directional block variants (facing, axis, half,
 * type) are derived automatically by createPalette(). Reduces each style from
 * ~95 fields to ~34 unique values.
 */
interface CompactStyle {
  // ─── Core materials ─────────────────────────────────────────────
  wall: BlockState;
  wallAccent: BlockState;
  interiorWall: BlockState;
  floorGround: BlockState;
  floorUpper: BlockState;
  ceiling: BlockState;
  foundation: BlockState;
  pillar: BlockState;
  window: BlockState;
  windowAccent: BlockState;
  fence: BlockState;
  carpet: BlockState;
  carpetAccent: BlockState;

  // ─── Timber (axis=x/z auto-derived if block name contains '_log') ────
  timber: BlockState;

  // ─── Roof stairs base (e.g. 'minecraft:dark_oak_stairs') ─────────────
  /** Full block ID without [facing=...] — north/south variants derived */
  roofStairs: string;
  roofCap: BlockState;
  defaultRoofShape: RoofShape;
  roofHeight: number;

  // ─── Door base (e.g. 'minecraft:dark_oak_door') ─────────────────────
  /** Full block ID without [half=...,facing=...] — 4 variants derived */
  door: string;

  // ─── Chair stairs base (e.g. 'minecraft:spruce_stairs') ─────────────
  /** Full block ID without [facing=...] — N/S/E/W derived */
  chairStairs: string;

  // ─── Torch type: 'wall_torch' or 'soul_wall_torch' (default: wall_torch)
  torch?: 'wall_torch' | 'soul_wall_torch';

  // ─── Slab base (e.g. 'minecraft:dark_oak_slab') ────────────────────
  /** Full block ID without [type=...] — top/bottom derived */
  slab: string;

  // ─── Banner color (e.g. 'red', 'white') ────────────────────────────
  bannerColor: string;

  // ─── Lighting ──────────────────────────────────────────────────────
  lantern: BlockState;
  lanternFloor: BlockState;

  // ─── Furniture ─────────────────────────────────────────────────────
  bedColor: StylePalette['bedColor'];
  fireplaceBlock: BlockState;
  fireplaceAccent: BlockState;
  tableSurface: BlockState;
  candle: BlockState;
  counterBlock: BlockState;
  counterSlab: BlockState;
  plant1: BlockState;
  plant2: BlockState;
  plant3: BlockState;
}

/**
 * Expand a CompactStyle spec into a full StylePalette by deriving all
 * directional variants (facing, axis, half, type) from base block IDs.
 */
function createPalette(spec: CompactStyle): StylePalette {
  const torch = spec.torch ?? 'wall_torch';
  // Logs support [axis=x/z], non-log blocks (quartz_pillar, concrete) don't
  const hasAxis = spec.timber.includes('_log');

  return {
    wall: spec.wall,
    wallAccent: spec.wallAccent,
    interiorWall: spec.interiorWall,
    floorGround: spec.floorGround,
    floorUpper: spec.floorUpper,
    ceiling: spec.ceiling,
    foundation: spec.foundation,
    pillar: spec.pillar,
    window: spec.window,
    windowAccent: spec.windowAccent,
    fence: spec.fence,
    carpet: spec.carpet,
    carpetAccent: spec.carpetAccent,
    lantern: spec.lantern,
    lanternFloor: spec.lanternFloor,
    roofCap: spec.roofCap,
    defaultRoofShape: spec.defaultRoofShape,
    roofHeight: spec.roofHeight,
    bedColor: spec.bedColor,
    fireplaceBlock: spec.fireplaceBlock,
    fireplaceAccent: spec.fireplaceAccent,
    tableSurface: spec.tableSurface,
    candle: spec.candle,
    counterBlock: spec.counterBlock,
    counterSlab: spec.counterSlab,
    plant1: spec.plant1,
    plant2: spec.plant2,
    plant3: spec.plant3,

    // ─── Derived: timber axis variants ──────────────────────────────
    timber: spec.timber,
    timberX: hasAxis ? `${spec.timber}[axis=x]` : spec.timber,
    timberZ: hasAxis ? `${spec.timber}[axis=z]` : spec.timber,

    // ─── Derived: roof facing ───────────────────────────────────────
    roofN: `${spec.roofStairs}[facing=north]`,
    roofS: `${spec.roofStairs}[facing=south]`,

    // ─── Derived: door half × facing ────────────────────────────────
    doorLowerN: `${spec.door}[half=lower,facing=north,open=false,hinge=left]`,
    doorUpperN: `${spec.door}[half=upper,facing=north,open=false,hinge=left]`,
    doorLowerS: `${spec.door}[half=lower,facing=south,open=false,hinge=left]`,
    doorUpperS: `${spec.door}[half=upper,facing=south,open=false,hinge=left]`,

    // ─── Derived: chair facing ──────────────────────────────────────
    chairN: `${spec.chairStairs}[facing=north]`,
    chairS: `${spec.chairStairs}[facing=south]`,
    chairE: `${spec.chairStairs}[facing=east]`,
    chairW: `${spec.chairStairs}[facing=west]`,

    // ─── Derived: torch facing ──────────────────────────────────────
    torchN: `minecraft:${torch}[facing=north]`,
    torchS: `minecraft:${torch}[facing=south]`,
    torchE: `minecraft:${torch}[facing=east]`,
    torchW: `minecraft:${torch}[facing=west]`,

    // ─── Derived: slab type ─────────────────────────────────────────
    slabBottom: `${spec.slab}[type=bottom]`,
    slabTop: `${spec.slab}[type=top]`,

    // ─── Derived: banner facing ─────────────────────────────────────
    bannerN: `minecraft:${spec.bannerColor}_wall_banner[facing=north]`,
    bannerS: `minecraft:${spec.bannerColor}_wall_banner[facing=south]`,
  };
}

// ─── Style Definitions ───────────────────────────────────────────────────────

/** All style presets */
export const STYLES: Record<StyleName, StylePalette> = {
  fantasy: createPalette({
    wall: 'minecraft:white_concrete',
    wallAccent: 'minecraft:chiseled_stone_bricks',
    interiorWall: 'minecraft:white_concrete',
    floorGround: 'minecraft:polished_andesite',
    floorUpper: 'minecraft:oak_planks',
    ceiling: 'minecraft:dark_oak_planks',
    timber: 'minecraft:dark_oak_log',
    roofStairs: 'minecraft:dark_oak_stairs',
    roofCap: 'minecraft:dark_oak_slab[type=bottom]',
    defaultRoofShape: 'gambrel',
    roofHeight: 10,
    foundation: 'minecraft:stone_bricks',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:purple_stained_glass_pane',
    door: 'minecraft:dark_oak_door',
    pillar: 'minecraft:quartz_pillar',
    chairStairs: 'minecraft:spruce_stairs',
    fence: 'minecraft:dark_oak_fence',
    carpet: 'minecraft:red_carpet',
    carpetAccent: 'minecraft:purple_carpet',
    lantern: 'minecraft:lantern[hanging=true]',
    lanternFloor: 'minecraft:lantern[hanging=false]',
    slab: 'minecraft:dark_oak_slab',
    bannerColor: 'red',
    bedColor: 'red',
    fireplaceBlock: 'minecraft:bricks',
    fireplaceAccent: 'minecraft:nether_bricks',
    tableSurface: 'minecraft:white_carpet',
    candle: 'minecraft:candle[candles=3,lit=true]',
    counterBlock: 'minecraft:polished_andesite',
    counterSlab: 'minecraft:smooth_stone_slab[type=bottom]',
    plant1: 'minecraft:potted_allium',
    plant2: 'minecraft:potted_azure_bluet',
    plant3: 'minecraft:potted_red_tulip',
  }),

  medieval: createPalette({
    wall: 'minecraft:stone_bricks',
    wallAccent: 'minecraft:mossy_stone_bricks',
    interiorWall: 'minecraft:stone_bricks',
    floorGround: 'minecraft:cobblestone',
    floorUpper: 'minecraft:oak_planks',
    ceiling: 'minecraft:oak_planks',
    timber: 'minecraft:oak_log',
    roofStairs: 'minecraft:cobblestone_stairs',
    roofCap: 'minecraft:cobblestone_slab[type=bottom]',
    defaultRoofShape: 'gable',
    roofHeight: 10,
    foundation: 'minecraft:cobblestone',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:glass_pane',
    door: 'minecraft:oak_door',
    pillar: 'minecraft:oak_log',
    chairStairs: 'minecraft:oak_stairs',
    fence: 'minecraft:oak_fence',
    carpet: 'minecraft:red_carpet',
    carpetAccent: 'minecraft:yellow_carpet',
    lantern: 'minecraft:lantern[hanging=true]',
    lanternFloor: 'minecraft:lantern[hanging=false]',
    slab: 'minecraft:oak_slab',
    bannerColor: 'red',
    bedColor: 'red',
    fireplaceBlock: 'minecraft:cobblestone',
    fireplaceAccent: 'minecraft:mossy_cobblestone',
    tableSurface: 'minecraft:red_carpet',
    candle: 'minecraft:candle[candles=3,lit=true]',
    counterBlock: 'minecraft:cobblestone',
    counterSlab: 'minecraft:cobblestone_slab[type=bottom]',
    plant1: 'minecraft:potted_fern',
    plant2: 'minecraft:potted_oak_sapling',
    plant3: 'minecraft:potted_red_tulip',
  }),

  modern: createPalette({
    wall: 'minecraft:white_concrete',
    wallAccent: 'minecraft:light_gray_concrete',
    interiorWall: 'minecraft:white_concrete',
    floorGround: 'minecraft:polished_andesite',
    floorUpper: 'minecraft:polished_andesite',
    ceiling: 'minecraft:smooth_quartz',
    timber: 'minecraft:quartz_pillar',
    roofStairs: 'minecraft:smooth_quartz_stairs',
    roofCap: 'minecraft:smooth_quartz_slab[type=bottom]',
    defaultRoofShape: 'flat',
    roofHeight: 4,
    foundation: 'minecraft:polished_andesite',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:light_blue_stained_glass_pane',
    door: 'minecraft:iron_door',
    pillar: 'minecraft:quartz_pillar',
    chairStairs: 'minecraft:quartz_stairs',
    fence: 'minecraft:iron_bars',
    carpet: 'minecraft:white_carpet',
    carpetAccent: 'minecraft:light_gray_carpet',
    lantern: 'minecraft:sea_lantern',
    lanternFloor: 'minecraft:sea_lantern',
    slab: 'minecraft:smooth_quartz_slab',
    bannerColor: 'white',
    bedColor: 'white',
    fireplaceBlock: 'minecraft:polished_andesite',
    fireplaceAccent: 'minecraft:smooth_stone',
    tableSurface: 'minecraft:light_gray_carpet',
    candle: 'minecraft:candle[candles=1,lit=true]',
    counterBlock: 'minecraft:smooth_quartz',
    counterSlab: 'minecraft:smooth_quartz_slab[type=bottom]',
    plant1: 'minecraft:potted_bamboo',
    plant2: 'minecraft:potted_fern',
    plant3: 'minecraft:potted_lily_of_the_valley',
  }),

  gothic: createPalette({
    wall: 'minecraft:deepslate_bricks',
    wallAccent: 'minecraft:polished_blackstone_bricks',
    interiorWall: 'minecraft:deepslate_tiles',
    floorGround: 'minecraft:polished_deepslate',
    floorUpper: 'minecraft:deepslate_tiles',
    ceiling: 'minecraft:deepslate_bricks',
    timber: 'minecraft:dark_oak_log',
    roofStairs: 'minecraft:dark_oak_stairs',
    roofCap: 'minecraft:dark_oak_slab[type=bottom]',
    defaultRoofShape: 'mansard',
    roofHeight: 12,
    foundation: 'minecraft:polished_blackstone_bricks',
    window: 'minecraft:gray_stained_glass_pane',
    windowAccent: 'minecraft:red_stained_glass_pane',
    door: 'minecraft:dark_oak_door',
    pillar: 'minecraft:polished_blackstone_bricks',
    chairStairs: 'minecraft:dark_oak_stairs',
    fence: 'minecraft:dark_oak_fence',
    carpet: 'minecraft:red_carpet',
    carpetAccent: 'minecraft:black_carpet',
    lantern: 'minecraft:soul_lantern[hanging=true]',
    lanternFloor: 'minecraft:soul_lantern[hanging=false]',
    torch: 'soul_wall_torch',
    slab: 'minecraft:deepslate_brick_slab',
    bannerColor: 'gray',
    bedColor: 'black',
    fireplaceBlock: 'minecraft:polished_blackstone_bricks',
    fireplaceAccent: 'minecraft:crying_obsidian',
    tableSurface: 'minecraft:black_carpet',
    candle: 'minecraft:soul_lantern[hanging=false]',
    counterBlock: 'minecraft:polished_deepslate',
    counterSlab: 'minecraft:polished_deepslate_slab[type=bottom]',
    plant1: 'minecraft:potted_wither_rose',
    plant2: 'minecraft:potted_dead_bush',
    plant3: 'minecraft:potted_crimson_fungus',
  }),

  rustic: createPalette({
    wall: 'minecraft:spruce_planks',
    wallAccent: 'minecraft:stripped_spruce_log',
    interiorWall: 'minecraft:birch_planks',
    floorGround: 'minecraft:cobblestone',
    floorUpper: 'minecraft:birch_planks',
    ceiling: 'minecraft:spruce_planks',
    timber: 'minecraft:spruce_log',
    roofStairs: 'minecraft:spruce_stairs',
    roofCap: 'minecraft:spruce_slab[type=bottom]',
    defaultRoofShape: 'gambrel',
    roofHeight: 10,
    foundation: 'minecraft:cobblestone',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:glass_pane',
    door: 'minecraft:spruce_door',
    pillar: 'minecraft:spruce_log',
    chairStairs: 'minecraft:spruce_stairs',
    fence: 'minecraft:spruce_fence',
    carpet: 'minecraft:brown_carpet',
    carpetAccent: 'minecraft:yellow_carpet',
    lantern: 'minecraft:lantern[hanging=true]',
    lanternFloor: 'minecraft:lantern[hanging=false]',
    slab: 'minecraft:spruce_slab',
    bannerColor: 'red',
    bedColor: 'brown',
    fireplaceBlock: 'minecraft:cobblestone',
    fireplaceAccent: 'minecraft:stone_bricks',
    tableSurface: 'minecraft:brown_carpet',
    candle: 'minecraft:candle[candles=3,lit=true]',
    counterBlock: 'minecraft:cobblestone',
    counterSlab: 'minecraft:cobblestone_slab[type=bottom]',
    plant1: 'minecraft:potted_fern',
    plant2: 'minecraft:potted_dandelion',
    plant3: 'minecraft:potted_poppy',
  }),

  steampunk: createPalette({
    wall: 'minecraft:iron_block',
    wallAccent: 'minecraft:exposed_copper',
    interiorWall: 'minecraft:iron_block',
    floorGround: 'minecraft:polished_deepslate',
    floorUpper: 'minecraft:dark_oak_planks',
    ceiling: 'minecraft:dark_oak_planks',
    timber: 'minecraft:dark_oak_log',
    roofStairs: 'minecraft:cut_copper_stairs',
    roofCap: 'minecraft:cut_copper_slab[type=bottom]',
    defaultRoofShape: 'mansard',
    roofHeight: 10,
    foundation: 'minecraft:polished_deepslate',
    window: 'minecraft:tinted_glass',
    windowAccent: 'minecraft:orange_stained_glass_pane',
    door: 'minecraft:iron_door',
    pillar: 'minecraft:iron_block',
    chairStairs: 'minecraft:dark_oak_stairs',
    fence: 'minecraft:chain',
    carpet: 'minecraft:gray_carpet',
    carpetAccent: 'minecraft:orange_carpet',
    lantern: 'minecraft:redstone_lamp',
    lanternFloor: 'minecraft:redstone_lamp',
    slab: 'minecraft:dark_oak_slab',
    bannerColor: 'black',
    bedColor: 'gray',
    fireplaceBlock: 'minecraft:iron_block',
    fireplaceAccent: 'minecraft:exposed_copper',
    tableSurface: 'minecraft:orange_carpet',
    candle: 'minecraft:redstone_lamp',
    counterBlock: 'minecraft:iron_block',
    counterSlab: 'minecraft:smooth_stone_slab[type=bottom]',
    plant1: 'minecraft:potted_dead_bush',
    plant2: 'minecraft:potted_cactus',
    plant3: 'minecraft:potted_crimson_fungus',
  }),

  elven: createPalette({
    wall: 'minecraft:moss_block',
    wallAccent: 'minecraft:stripped_birch_log',
    interiorWall: 'minecraft:birch_planks',
    floorGround: 'minecraft:moss_block',
    floorUpper: 'minecraft:birch_planks',
    ceiling: 'minecraft:birch_planks',
    timber: 'minecraft:birch_log',
    roofStairs: 'minecraft:warped_stairs',
    roofCap: 'minecraft:warped_slab[type=bottom]',
    defaultRoofShape: 'hip',
    roofHeight: 8,
    foundation: 'minecraft:stone_bricks',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:green_stained_glass_pane',
    door: 'minecraft:birch_door',
    pillar: 'minecraft:birch_log',
    chairStairs: 'minecraft:birch_stairs',
    fence: 'minecraft:birch_fence',
    carpet: 'minecraft:green_carpet',
    carpetAccent: 'minecraft:lime_carpet',
    lantern: 'minecraft:end_rod[facing=down]',
    lanternFloor: 'minecraft:glowstone',
    slab: 'minecraft:birch_slab',
    bannerColor: 'white',
    bedColor: 'green',
    fireplaceBlock: 'minecraft:moss_block',
    fireplaceAccent: 'minecraft:mossy_cobblestone',
    tableSurface: 'minecraft:green_carpet',
    candle: 'minecraft:glowstone',
    counterBlock: 'minecraft:moss_block',
    counterSlab: 'minecraft:birch_slab[type=bottom]',
    plant1: 'minecraft:potted_birch_sapling',
    plant2: 'minecraft:potted_azalea_bush',
    plant3: 'minecraft:potted_flowering_azalea_bush',
  }),

  desert: createPalette({
    wall: 'minecraft:sandstone',
    wallAccent: 'minecraft:white_terracotta',
    interiorWall: 'minecraft:smooth_sandstone',
    floorGround: 'minecraft:smooth_sandstone',
    floorUpper: 'minecraft:sandstone',
    ceiling: 'minecraft:chiseled_sandstone',
    timber: 'minecraft:acacia_log',
    roofStairs: 'minecraft:sandstone_stairs',
    roofCap: 'minecraft:sandstone_slab[type=bottom]',
    defaultRoofShape: 'flat',
    roofHeight: 4,
    foundation: 'minecraft:sandstone',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:orange_stained_glass_pane',
    door: 'minecraft:acacia_door',
    pillar: 'minecraft:sandstone_wall',
    chairStairs: 'minecraft:acacia_stairs',
    fence: 'minecraft:acacia_fence',
    carpet: 'minecraft:orange_carpet',
    carpetAccent: 'minecraft:red_carpet',
    lantern: 'minecraft:soul_lantern[hanging=true]',
    lanternFloor: 'minecraft:soul_lantern[hanging=false]',
    torch: 'soul_wall_torch',
    slab: 'minecraft:sandstone_slab',
    bannerColor: 'red',
    bedColor: 'orange',
    fireplaceBlock: 'minecraft:sandstone',
    fireplaceAccent: 'minecraft:red_sandstone',
    tableSurface: 'minecraft:orange_carpet',
    candle: 'minecraft:candle[candles=3,lit=true]',
    counterBlock: 'minecraft:smooth_sandstone',
    counterSlab: 'minecraft:sandstone_slab[type=bottom]',
    plant1: 'minecraft:potted_dead_bush',
    plant2: 'minecraft:potted_cactus',
    plant3: 'minecraft:potted_red_tulip',
  }),

  underwater: createPalette({
    wall: 'minecraft:prismarine_bricks',
    wallAccent: 'minecraft:blue_concrete',
    interiorWall: 'minecraft:dark_prismarine',
    floorGround: 'minecraft:dark_prismarine',
    floorUpper: 'minecraft:warped_planks',
    ceiling: 'minecraft:dark_prismarine',
    timber: 'minecraft:blue_concrete',
    roofStairs: 'minecraft:dark_prismarine_stairs',
    roofCap: 'minecraft:dark_prismarine_slab[type=bottom]',
    defaultRoofShape: 'hip',
    roofHeight: 8,
    foundation: 'minecraft:prismarine',
    window: 'minecraft:light_blue_stained_glass_pane',
    windowAccent: 'minecraft:blue_stained_glass_pane',
    door: 'minecraft:iron_door',
    pillar: 'minecraft:warped_fence',
    chairStairs: 'minecraft:warped_stairs',
    fence: 'minecraft:warped_fence',
    carpet: 'minecraft:cyan_carpet',
    carpetAccent: 'minecraft:light_blue_carpet',
    lantern: 'minecraft:sea_lantern',
    lanternFloor: 'minecraft:sea_lantern',
    torch: 'soul_wall_torch',
    slab: 'minecraft:warped_slab',
    bannerColor: 'blue',
    bedColor: 'cyan',
    fireplaceBlock: 'minecraft:prismarine_bricks',
    fireplaceAccent: 'minecraft:dark_prismarine',
    tableSurface: 'minecraft:cyan_carpet',
    candle: 'minecraft:sea_lantern',
    counterBlock: 'minecraft:dark_prismarine',
    counterSlab: 'minecraft:dark_prismarine_slab[type=bottom]',
    plant1: 'minecraft:potted_warped_fungus',
    plant2: 'minecraft:potted_crimson_fungus',
    plant3: 'minecraft:potted_fern',
  }),
};

/** Get a style palette by name */
export function getStyle(name: StyleName): StylePalette {
  return STYLES[name];
}

/** Get all available style names */
export function getStyleNames(): StyleName[] {
  return Object.keys(STYLES) as StyleName[];
}
