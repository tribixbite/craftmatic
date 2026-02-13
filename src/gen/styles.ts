/**
 * Style presets for structure generation.
 * Each style defines the block palette used for walls, floors, roofs,
 * timber, accents, lighting, and carpets.
 */

import type { StyleName, BlockState } from '../types/index.js';

/** Material palette for a building style */
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
}

/** All style presets */
export const STYLES: Record<StyleName, StylePalette> = {
  fantasy: {
    wall: 'minecraft:white_concrete',
    wallAccent: 'minecraft:chiseled_stone_bricks',
    interiorWall: 'minecraft:white_concrete',
    floorGround: 'minecraft:polished_andesite',
    floorUpper: 'minecraft:oak_planks',
    ceiling: 'minecraft:dark_oak_planks',
    timber: 'minecraft:dark_oak_log',
    timberX: 'minecraft:dark_oak_log[axis=x]',
    timberZ: 'minecraft:dark_oak_log[axis=z]',
    roofN: 'minecraft:dark_oak_stairs[facing=north]',
    roofS: 'minecraft:dark_oak_stairs[facing=south]',
    roofCap: 'minecraft:dark_oak_slab[type=bottom]',
    foundation: 'minecraft:stone_bricks',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:purple_stained_glass_pane',
    doorLowerN: 'minecraft:dark_oak_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:dark_oak_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:dark_oak_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:dark_oak_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:quartz_pillar',
    chairN: 'minecraft:spruce_stairs[facing=north]',
    chairS: 'minecraft:spruce_stairs[facing=south]',
    chairE: 'minecraft:spruce_stairs[facing=east]',
    chairW: 'minecraft:spruce_stairs[facing=west]',
    fence: 'minecraft:dark_oak_fence',
    carpet: 'minecraft:red_carpet',
    carpetAccent: 'minecraft:purple_carpet',
    lantern: 'minecraft:lantern[hanging=true]',
    lanternFloor: 'minecraft:lantern[hanging=false]',
    torchN: 'minecraft:wall_torch[facing=north]',
    torchS: 'minecraft:wall_torch[facing=south]',
    torchE: 'minecraft:wall_torch[facing=east]',
    torchW: 'minecraft:wall_torch[facing=west]',
    slabBottom: 'minecraft:dark_oak_slab[type=bottom]',
    slabTop: 'minecraft:dark_oak_slab[type=top]',
    bannerN: 'minecraft:red_wall_banner[facing=north]',
    bannerS: 'minecraft:red_wall_banner[facing=south]',
  },

  medieval: {
    wall: 'minecraft:stone_bricks',
    wallAccent: 'minecraft:mossy_stone_bricks',
    interiorWall: 'minecraft:stone_bricks',
    floorGround: 'minecraft:cobblestone',
    floorUpper: 'minecraft:oak_planks',
    ceiling: 'minecraft:oak_planks',
    timber: 'minecraft:oak_log',
    timberX: 'minecraft:oak_log[axis=x]',
    timberZ: 'minecraft:oak_log[axis=z]',
    roofN: 'minecraft:cobblestone_stairs[facing=north]',
    roofS: 'minecraft:cobblestone_stairs[facing=south]',
    roofCap: 'minecraft:cobblestone_slab[type=bottom]',
    foundation: 'minecraft:cobblestone',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:glass_pane',
    doorLowerN: 'minecraft:oak_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:oak_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:oak_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:oak_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:oak_log',
    chairN: 'minecraft:oak_stairs[facing=north]',
    chairS: 'minecraft:oak_stairs[facing=south]',
    chairE: 'minecraft:oak_stairs[facing=east]',
    chairW: 'minecraft:oak_stairs[facing=west]',
    fence: 'minecraft:oak_fence',
    carpet: 'minecraft:red_carpet',
    carpetAccent: 'minecraft:yellow_carpet',
    lantern: 'minecraft:lantern[hanging=true]',
    lanternFloor: 'minecraft:lantern[hanging=false]',
    torchN: 'minecraft:wall_torch[facing=north]',
    torchS: 'minecraft:wall_torch[facing=south]',
    torchE: 'minecraft:wall_torch[facing=east]',
    torchW: 'minecraft:wall_torch[facing=west]',
    slabBottom: 'minecraft:oak_slab[type=bottom]',
    slabTop: 'minecraft:oak_slab[type=top]',
    bannerN: 'minecraft:red_wall_banner[facing=north]',
    bannerS: 'minecraft:red_wall_banner[facing=south]',
  },

  modern: {
    wall: 'minecraft:white_concrete',
    wallAccent: 'minecraft:light_gray_concrete',
    interiorWall: 'minecraft:white_concrete',
    floorGround: 'minecraft:polished_andesite',
    floorUpper: 'minecraft:polished_andesite',
    ceiling: 'minecraft:smooth_quartz',
    timber: 'minecraft:quartz_pillar',
    timberX: 'minecraft:quartz_pillar',
    timberZ: 'minecraft:quartz_pillar',
    roofN: 'minecraft:smooth_quartz_stairs[facing=north]',
    roofS: 'minecraft:smooth_quartz_stairs[facing=south]',
    roofCap: 'minecraft:smooth_quartz_slab[type=bottom]',
    foundation: 'minecraft:polished_andesite',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:light_blue_stained_glass_pane',
    doorLowerN: 'minecraft:iron_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:iron_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:iron_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:iron_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:quartz_pillar',
    chairN: 'minecraft:quartz_stairs[facing=north]',
    chairS: 'minecraft:quartz_stairs[facing=south]',
    chairE: 'minecraft:quartz_stairs[facing=east]',
    chairW: 'minecraft:quartz_stairs[facing=west]',
    fence: 'minecraft:iron_bars',
    carpet: 'minecraft:white_carpet',
    carpetAccent: 'minecraft:light_gray_carpet',
    lantern: 'minecraft:sea_lantern',
    lanternFloor: 'minecraft:sea_lantern',
    torchN: 'minecraft:wall_torch[facing=north]',
    torchS: 'minecraft:wall_torch[facing=south]',
    torchE: 'minecraft:wall_torch[facing=east]',
    torchW: 'minecraft:wall_torch[facing=west]',
    slabBottom: 'minecraft:smooth_quartz_slab[type=bottom]',
    slabTop: 'minecraft:smooth_quartz_slab[type=top]',
    bannerN: 'minecraft:white_wall_banner[facing=north]',
    bannerS: 'minecraft:white_wall_banner[facing=south]',
  },

  gothic: {
    wall: 'minecraft:purpur_block',
    wallAccent: 'minecraft:deepslate_bricks',
    interiorWall: 'minecraft:deepslate_tiles',
    floorGround: 'minecraft:polished_deepslate',
    floorUpper: 'minecraft:deepslate_tiles',
    ceiling: 'minecraft:deepslate_bricks',
    timber: 'minecraft:dark_oak_log',
    timberX: 'minecraft:dark_oak_log[axis=x]',
    timberZ: 'minecraft:dark_oak_log[axis=z]',
    roofN: 'minecraft:purpur_stairs[facing=north]',
    roofS: 'minecraft:purpur_stairs[facing=south]',
    roofCap: 'minecraft:purpur_slab[type=bottom]',
    foundation: 'minecraft:polished_blackstone_bricks',
    window: 'minecraft:purple_stained_glass_pane',
    windowAccent: 'minecraft:red_stained_glass_pane',
    doorLowerN: 'minecraft:dark_oak_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:dark_oak_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:dark_oak_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:dark_oak_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:purpur_pillar',
    chairN: 'minecraft:dark_oak_stairs[facing=north]',
    chairS: 'minecraft:dark_oak_stairs[facing=south]',
    chairE: 'minecraft:dark_oak_stairs[facing=east]',
    chairW: 'minecraft:dark_oak_stairs[facing=west]',
    fence: 'minecraft:dark_oak_fence',
    carpet: 'minecraft:red_carpet',
    carpetAccent: 'minecraft:purple_carpet',
    lantern: 'minecraft:soul_lantern[hanging=true]',
    lanternFloor: 'minecraft:soul_lantern[hanging=false]',
    torchN: 'minecraft:soul_wall_torch[facing=north]',
    torchS: 'minecraft:soul_wall_torch[facing=south]',
    torchE: 'minecraft:soul_wall_torch[facing=east]',
    torchW: 'minecraft:soul_wall_torch[facing=west]',
    slabBottom: 'minecraft:purpur_slab[type=bottom]',
    slabTop: 'minecraft:purpur_slab[type=top]',
    bannerN: 'minecraft:purple_wall_banner[facing=north]',
    bannerS: 'minecraft:purple_wall_banner[facing=south]',
  },

  rustic: {
    wall: 'minecraft:spruce_planks',
    wallAccent: 'minecraft:stripped_spruce_log',
    interiorWall: 'minecraft:birch_planks',
    floorGround: 'minecraft:cobblestone',
    floorUpper: 'minecraft:birch_planks',
    ceiling: 'minecraft:spruce_planks',
    timber: 'minecraft:spruce_log',
    timberX: 'minecraft:spruce_log[axis=x]',
    timberZ: 'minecraft:spruce_log[axis=z]',
    roofN: 'minecraft:spruce_stairs[facing=north]',
    roofS: 'minecraft:spruce_stairs[facing=south]',
    roofCap: 'minecraft:spruce_slab[type=bottom]',
    foundation: 'minecraft:cobblestone',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:glass_pane',
    doorLowerN: 'minecraft:spruce_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:spruce_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:spruce_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:spruce_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:spruce_log',
    chairN: 'minecraft:spruce_stairs[facing=north]',
    chairS: 'minecraft:spruce_stairs[facing=south]',
    chairE: 'minecraft:spruce_stairs[facing=east]',
    chairW: 'minecraft:spruce_stairs[facing=west]',
    fence: 'minecraft:spruce_fence',
    carpet: 'minecraft:brown_carpet',
    carpetAccent: 'minecraft:yellow_carpet',
    lantern: 'minecraft:lantern[hanging=true]',
    lanternFloor: 'minecraft:lantern[hanging=false]',
    torchN: 'minecraft:wall_torch[facing=north]',
    torchS: 'minecraft:wall_torch[facing=south]',
    torchE: 'minecraft:wall_torch[facing=east]',
    torchW: 'minecraft:wall_torch[facing=west]',
    slabBottom: 'minecraft:spruce_slab[type=bottom]',
    slabTop: 'minecraft:spruce_slab[type=top]',
    bannerN: 'minecraft:red_wall_banner[facing=north]',
    bannerS: 'minecraft:red_wall_banner[facing=south]',
  },

  steampunk: {
    wall: 'minecraft:iron_block',
    wallAccent: 'minecraft:exposed_copper',
    interiorWall: 'minecraft:iron_block',
    floorGround: 'minecraft:polished_deepslate',
    floorUpper: 'minecraft:dark_oak_planks',
    ceiling: 'minecraft:dark_oak_planks',
    timber: 'minecraft:dark_oak_log',
    timberX: 'minecraft:dark_oak_log[axis=x]',
    timberZ: 'minecraft:dark_oak_log[axis=z]',
    roofN: 'minecraft:cut_copper_stairs[facing=north]',
    roofS: 'minecraft:cut_copper_stairs[facing=south]',
    roofCap: 'minecraft:cut_copper_slab[type=bottom]',
    foundation: 'minecraft:polished_deepslate',
    window: 'minecraft:tinted_glass',
    windowAccent: 'minecraft:orange_stained_glass_pane',
    doorLowerN: 'minecraft:iron_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:iron_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:iron_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:iron_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:iron_block',
    chairN: 'minecraft:dark_oak_stairs[facing=north]',
    chairS: 'minecraft:dark_oak_stairs[facing=south]',
    chairE: 'minecraft:dark_oak_stairs[facing=east]',
    chairW: 'minecraft:dark_oak_stairs[facing=west]',
    fence: 'minecraft:chain',
    carpet: 'minecraft:gray_carpet',
    carpetAccent: 'minecraft:orange_carpet',
    lantern: 'minecraft:redstone_lamp',
    lanternFloor: 'minecraft:redstone_lamp',
    torchN: 'minecraft:wall_torch[facing=north]',
    torchS: 'minecraft:wall_torch[facing=south]',
    torchE: 'minecraft:wall_torch[facing=east]',
    torchW: 'minecraft:wall_torch[facing=west]',
    slabBottom: 'minecraft:dark_oak_slab[type=bottom]',
    slabTop: 'minecraft:dark_oak_slab[type=top]',
    bannerN: 'minecraft:black_wall_banner[facing=north]',
    bannerS: 'minecraft:black_wall_banner[facing=south]',
  },

  elven: {
    wall: 'minecraft:moss_block',
    wallAccent: 'minecraft:stripped_birch_log',
    interiorWall: 'minecraft:birch_planks',
    floorGround: 'minecraft:moss_block',
    floorUpper: 'minecraft:birch_planks',
    ceiling: 'minecraft:birch_planks',
    timber: 'minecraft:birch_log',
    timberX: 'minecraft:birch_log[axis=x]',
    timberZ: 'minecraft:birch_log[axis=z]',
    roofN: 'minecraft:warped_stairs[facing=north]',
    roofS: 'minecraft:warped_stairs[facing=south]',
    roofCap: 'minecraft:warped_slab[type=bottom]',
    foundation: 'minecraft:moss_block',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:green_stained_glass_pane',
    doorLowerN: 'minecraft:birch_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:birch_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:birch_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:birch_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:birch_log',
    chairN: 'minecraft:birch_stairs[facing=north]',
    chairS: 'minecraft:birch_stairs[facing=south]',
    chairE: 'minecraft:birch_stairs[facing=east]',
    chairW: 'minecraft:birch_stairs[facing=west]',
    fence: 'minecraft:birch_fence',
    carpet: 'minecraft:green_carpet',
    carpetAccent: 'minecraft:lime_carpet',
    lantern: 'minecraft:end_rod[facing=down]',
    lanternFloor: 'minecraft:glowstone',
    torchN: 'minecraft:wall_torch[facing=north]',
    torchS: 'minecraft:wall_torch[facing=south]',
    torchE: 'minecraft:wall_torch[facing=east]',
    torchW: 'minecraft:wall_torch[facing=west]',
    slabBottom: 'minecraft:birch_slab[type=bottom]',
    slabTop: 'minecraft:birch_slab[type=top]',
    bannerN: 'minecraft:white_wall_banner[facing=north]',
    bannerS: 'minecraft:white_wall_banner[facing=south]',
  },

  desert: {
    wall: 'minecraft:sandstone',
    wallAccent: 'minecraft:red_sandstone',
    interiorWall: 'minecraft:smooth_sandstone',
    floorGround: 'minecraft:smooth_sandstone',
    floorUpper: 'minecraft:sandstone',
    ceiling: 'minecraft:chiseled_sandstone',
    timber: 'minecraft:acacia_log',
    timberX: 'minecraft:acacia_log[axis=x]',
    timberZ: 'minecraft:acacia_log[axis=z]',
    roofN: 'minecraft:sandstone_stairs[facing=north]',
    roofS: 'minecraft:sandstone_stairs[facing=south]',
    roofCap: 'minecraft:sandstone_slab[type=bottom]',
    foundation: 'minecraft:sandstone',
    window: 'minecraft:glass_pane',
    windowAccent: 'minecraft:orange_stained_glass_pane',
    doorLowerN: 'minecraft:acacia_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:acacia_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:acacia_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:acacia_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:sandstone_wall',
    chairN: 'minecraft:acacia_stairs[facing=north]',
    chairS: 'minecraft:acacia_stairs[facing=south]',
    chairE: 'minecraft:acacia_stairs[facing=east]',
    chairW: 'minecraft:acacia_stairs[facing=west]',
    fence: 'minecraft:acacia_fence',
    carpet: 'minecraft:orange_carpet',
    carpetAccent: 'minecraft:red_carpet',
    lantern: 'minecraft:soul_lantern[hanging=true]',
    lanternFloor: 'minecraft:soul_lantern[hanging=false]',
    torchN: 'minecraft:soul_wall_torch[facing=north]',
    torchS: 'minecraft:soul_wall_torch[facing=south]',
    torchE: 'minecraft:soul_wall_torch[facing=east]',
    torchW: 'minecraft:soul_wall_torch[facing=west]',
    slabBottom: 'minecraft:sandstone_slab[type=bottom]',
    slabTop: 'minecraft:sandstone_slab[type=top]',
    bannerN: 'minecraft:red_wall_banner[facing=north]',
    bannerS: 'minecraft:red_wall_banner[facing=south]',
  },

  underwater: {
    wall: 'minecraft:prismarine',
    wallAccent: 'minecraft:dark_prismarine',
    interiorWall: 'minecraft:prismarine_bricks',
    floorGround: 'minecraft:dark_prismarine',
    floorUpper: 'minecraft:prismarine_bricks',
    ceiling: 'minecraft:prismarine',
    timber: 'minecraft:warped_stem',
    timberX: 'minecraft:warped_stem[axis=x]',
    timberZ: 'minecraft:warped_stem[axis=z]',
    roofN: 'minecraft:prismarine_brick_stairs[facing=north]',
    roofS: 'minecraft:prismarine_brick_stairs[facing=south]',
    roofCap: 'minecraft:prismarine_brick_slab[type=bottom]',
    foundation: 'minecraft:dark_prismarine',
    window: 'minecraft:light_blue_stained_glass_pane',
    windowAccent: 'minecraft:blue_stained_glass_pane',
    doorLowerN: 'minecraft:iron_door[half=lower,facing=north,open=false,hinge=left]',
    doorUpperN: 'minecraft:iron_door[half=upper,facing=north,open=false,hinge=left]',
    doorLowerS: 'minecraft:iron_door[half=lower,facing=south,open=false,hinge=left]',
    doorUpperS: 'minecraft:iron_door[half=upper,facing=south,open=false,hinge=left]',
    pillar: 'minecraft:prismarine_wall',
    chairN: 'minecraft:warped_stairs[facing=north]',
    chairS: 'minecraft:warped_stairs[facing=south]',
    chairE: 'minecraft:warped_stairs[facing=east]',
    chairW: 'minecraft:warped_stairs[facing=west]',
    fence: 'minecraft:warped_fence',
    carpet: 'minecraft:cyan_carpet',
    carpetAccent: 'minecraft:light_blue_carpet',
    lantern: 'minecraft:sea_lantern',
    lanternFloor: 'minecraft:sea_lantern',
    torchN: 'minecraft:soul_wall_torch[facing=north]',
    torchS: 'minecraft:soul_wall_torch[facing=south]',
    torchE: 'minecraft:soul_wall_torch[facing=east]',
    torchW: 'minecraft:soul_wall_torch[facing=west]',
    slabBottom: 'minecraft:prismarine_slab[type=bottom]',
    slabTop: 'minecraft:prismarine_slab[type=top]',
    bannerN: 'minecraft:blue_wall_banner[facing=north]',
    bannerS: 'minecraft:blue_wall_banner[facing=south]',
  },
};

/** Get a style palette by name */
export function getStyle(name: StyleName): StylePalette {
  return STYLES[name];
}

/** Get all available style names */
export function getStyleNames(): StyleName[] {
  return Object.keys(STYLES) as StyleName[];
}
