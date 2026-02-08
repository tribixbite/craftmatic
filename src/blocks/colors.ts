/**
 * Block color map — maps Minecraft block state IDs to RGB colors.
 * Used for 2D rendering (floor plans, isometric views).
 * Ported from render_schematic.py's 170+ entry BLOCK_COLORS dict.
 */

import type { RGB } from '../types/index.js';
import { getBaseId } from './registry.js';

/** Block ID -> RGB color mapping */
const BLOCK_COLORS: Record<string, RGB> = {
  // Stone / brick
  'minecraft:stone_bricks': [122, 122, 122],
  'minecraft:stone_brick_slab': [130, 130, 130],
  'minecraft:stone_brick_wall': [115, 115, 115],
  'minecraft:stone_brick_stairs': [125, 125, 125],
  'minecraft:chiseled_stone_bricks': [120, 118, 120],
  'minecraft:polished_andesite': [136, 136, 132],
  'minecraft:polished_deepslate': [72, 72, 76],
  'minecraft:smooth_stone_slab': [165, 165, 165],
  'minecraft:smooth_quartz': [235, 229, 222],
  'minecraft:smooth_quartz_slab': [232, 226, 219],
  'minecraft:quartz_block': [235, 230, 224],
  'minecraft:quartz_pillar': [230, 226, 220],
  'minecraft:bricks': [150, 97, 83],
  'minecraft:nether_bricks': [44, 22, 26],

  // Dark oak
  'minecraft:dark_oak_log': [60, 46, 26],
  'minecraft:dark_oak_planks': [67, 43, 20],
  'minecraft:dark_oak_slab': [67, 43, 20],
  'minecraft:dark_oak_stairs': [67, 43, 20],
  'minecraft:dark_oak_fence': [60, 40, 18],
  'minecraft:dark_oak_door': [70, 46, 22],
  'minecraft:stripped_dark_oak_log': [96, 76, 49],

  // Oak
  'minecraft:oak_planks': [162, 130, 78],
  'minecraft:oak_slab': [162, 130, 78],
  'minecraft:oak_stairs': [162, 130, 78],
  'minecraft:oak_fence': [158, 126, 74],

  // Spruce
  'minecraft:spruce_stairs': [114, 85, 48],
  'minecraft:spruce_slab': [114, 85, 48],

  // Glass
  'minecraft:glass_pane': [173, 203, 227],
  'minecraft:tinted_glass': [40, 30, 40],
  'minecraft:blue_stained_glass_pane': [51, 76, 178],
  'minecraft:purple_stained_glass_pane': [127, 63, 178],

  // Concrete
  'minecraft:white_concrete': [207, 213, 214],

  // Lighting
  'minecraft:lantern': [210, 170, 80],
  'minecraft:soul_lantern': [80, 200, 200],
  'minecraft:glowstone': [171, 131, 56],
  'minecraft:sea_lantern': [140, 210, 200],
  'minecraft:end_rod': [230, 225, 210],
  'minecraft:chain': [55, 60, 68],
  'minecraft:candle': [220, 190, 110],
  'minecraft:white_candle': [235, 235, 225],
  'minecraft:campfire': [220, 110, 30],
  'minecraft:soul_campfire': [50, 190, 190],
  'minecraft:wall_torch': [255, 210, 60],
  'minecraft:soul_wall_torch': [60, 210, 210],

  // Metal
  'minecraft:iron_bars': [160, 160, 160],
  'minecraft:iron_block': [222, 222, 222],
  'minecraft:iron_trapdoor': [190, 190, 190],
  'minecraft:dark_oak_trapdoor': [60, 40, 20],
  'minecraft:lightning_rod': [200, 130, 80],

  // Carpet
  'minecraft:red_carpet': [170, 42, 36],
  'minecraft:blue_carpet': [53, 57, 168],
  'minecraft:white_carpet': [238, 240, 240],
  'minecraft:purple_carpet': [130, 48, 180],
  'minecraft:black_carpet': [28, 25, 25],
  'minecraft:yellow_carpet': [252, 202, 42],
  'minecraft:cyan_carpet': [24, 142, 150],
  'minecraft:magenta_carpet': [195, 72, 185],

  // Furniture
  'minecraft:bookshelf': [109, 90, 55],
  'minecraft:crafting_table': [120, 82, 48],
  'minecraft:cartography_table': [100, 80, 50],
  'minecraft:smithing_table': [50, 50, 55],
  'minecraft:loom': [155, 135, 105],
  'minecraft:grindstone': [140, 140, 140],
  'minecraft:anvil': [72, 72, 72],
  'minecraft:lectern': [155, 125, 72],
  'minecraft:jukebox': [118, 75, 52],
  'minecraft:note_block': [105, 68, 48],
  'minecraft:brown_glazed_terracotta': [120, 80, 50],
  'minecraft:cyan_glazed_terracotta': [70, 130, 130],
  'minecraft:potted_oak_sapling': [60, 120, 45],
  'minecraft:bell': [210, 190, 55],
  'minecraft:enchanting_table': [120, 35, 35],
  'minecraft:brewing_stand': [125, 115, 92],
  'minecraft:ender_chest': [30, 65, 65],
  'minecraft:furnace': [132, 132, 132],
  'minecraft:smoker': [122, 122, 112],
  'minecraft:blast_furnace': [105, 105, 108],
  'minecraft:cauldron': [62, 62, 62],
  'minecraft:water_cauldron': [50, 85, 190],
  'minecraft:composter': [105, 82, 42],

  // Flower pots
  'minecraft:potted_red_tulip': [190, 60, 50],
  'minecraft:potted_azure_bluet': [180, 200, 210],
  'minecraft:potted_wither_rose': [35, 35, 30],
  'minecraft:potted_fern': [70, 145, 55],
  'minecraft:potted_allium': [170, 120, 200],
  'minecraft:potted_blue_orchid': [60, 160, 200],
  'minecraft:potted_lily_of_the_valley': [220, 230, 220],
  'minecraft:potted_crimson_fungus': [160, 45, 40],
  'minecraft:potted_warped_fungus': [40, 160, 140],
  'minecraft:potted_cactus': [80, 140, 50],
  'minecraft:potted_': [80, 145, 62],

  // Beds
  'minecraft:red_bed': [170, 42, 36],
  'minecraft:blue_bed': [53, 57, 168],
  'minecraft:cyan_bed': [24, 142, 150],

  // Storage
  'minecraft:chest': [168, 125, 48],
  'minecraft:trapped_chest': [158, 118, 42],
  'minecraft:barrel': [135, 105, 58],

  // Fantastical
  'minecraft:gold_block': [248, 212, 65],
  'minecraft:diamond_block': [100, 225, 220],
  'minecraft:emerald_block': [45, 182, 76],
  'minecraft:lapis_block': [42, 72, 165],
  'minecraft:amethyst_block': [138, 102, 198],
  'minecraft:amethyst_cluster': [165, 125, 215],
  'minecraft:large_amethyst_bud': [150, 115, 205],
  'minecraft:budding_amethyst': [145, 105, 200],
  'minecraft:crying_obsidian': [55, 12, 88],
  'minecraft:obsidian': [18, 12, 28],
  'minecraft:gilded_blackstone': [58, 45, 32],
  'minecraft:polished_blackstone': [56, 50, 60],
  'minecraft:polished_blackstone_bricks': [50, 45, 54],
  'minecraft:prismarine': [102, 175, 162],
  'minecraft:prismarine_bricks': [102, 175, 148],
  'minecraft:dark_prismarine': [54, 95, 78],
  'minecraft:purpur_block': [175, 130, 175],
  'minecraft:purpur_pillar': [178, 135, 178],
  'minecraft:end_stone_bricks': [222, 228, 168],
  'minecraft:beacon': [125, 235, 235],
  'minecraft:conduit': [165, 145, 105],
  'minecraft:lodestone': [148, 148, 148],
  'minecraft:respawn_anchor': [55, 22, 78],
  'minecraft:dragon_egg': [22, 12, 32],
  'minecraft:waxed_copper_block': [198, 112, 82],
  'minecraft:waxed_oxidized_copper': [85, 168, 138],
  'minecraft:waxed_copper_bulb': [195, 110, 78],
  'minecraft:sculk': [14, 40, 45],
  'minecraft:sculk_catalyst': [18, 48, 55],

  // Banners
  'minecraft:red_wall_banner': [170, 42, 36],
  'minecraft:blue_wall_banner': [53, 57, 168],
  'minecraft:black_wall_banner': [28, 25, 25],
  'minecraft:white_wall_banner': [238, 240, 240],
  'minecraft:purple_wall_banner': [130, 48, 180],

  // Skulls
  'minecraft:dragon_head': [28, 28, 35],
  'minecraft:skeleton_skull': [205, 205, 195],
  'minecraft:wither_skeleton_skull': [55, 55, 55],

  // Misc blocks
  'minecraft:hay_block': [186, 162, 62],
  'minecraft:target': [200, 170, 150],
};

/** Blocks considered "furniture" — drawn with a marker in detailed view */
export const FURNITURE_BLOCKS = new Set([
  'minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel',
  'minecraft:enchanting_table', 'minecraft:brewing_stand', 'minecraft:anvil',
  'minecraft:crafting_table', 'minecraft:furnace', 'minecraft:smoker',
  'minecraft:blast_furnace', 'minecraft:lectern', 'minecraft:bell',
  'minecraft:jukebox', 'minecraft:note_block', 'minecraft:grindstone',
  'minecraft:smithing_table', 'minecraft:cartography_table', 'minecraft:loom',
  'minecraft:composter', 'minecraft:ender_chest', 'minecraft:beacon',
  'minecraft:conduit', 'minecraft:lodestone', 'minecraft:respawn_anchor',
  'minecraft:dragon_egg',
]);

/** Light-emitting blocks — drawn with a glow marker */
export const LIGHT_BLOCKS = new Set([
  'minecraft:lantern', 'minecraft:soul_lantern', 'minecraft:glowstone',
  'minecraft:sea_lantern', 'minecraft:end_rod', 'minecraft:candle',
  'minecraft:white_candle', 'minecraft:campfire', 'minecraft:soul_campfire',
  'minecraft:wall_torch', 'minecraft:soul_wall_torch',
]);

/** Bed blocks */
export const BED_BLOCKS = new Set([
  'minecraft:red_bed', 'minecraft:blue_bed', 'minecraft:cyan_bed',
]);

/** Door blocks */
export const DOOR_BLOCKS = new Set([
  'minecraft:dark_oak_door', 'minecraft:oak_door', 'minecraft:spruce_door',
  'minecraft:iron_door',
]);

/**
 * Look up color for a block state with prefix/property fallback.
 * Returns null for air blocks.
 */
export function getBlockColor(blockState: string): RGB | null {
  if (blockState === 'minecraft:air') return null;

  const base = getBaseId(blockState);

  // Exact match
  if (base in BLOCK_COLORS) return BLOCK_COLORS[base];

  // Prefix matching for variants (e.g. "minecraft:potted_" matches any potted plant)
  for (const [prefix, color] of Object.entries(BLOCK_COLORS)) {
    if (prefix.endsWith('_') && base.startsWith(prefix)) return color;
  }

  // Startswith matching for block states with different properties
  for (const [key, color] of Object.entries(BLOCK_COLORS)) {
    if (blockState.startsWith(key)) return color;
  }

  // Hash-based fallback color for unknown blocks
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash + base.charCodeAt(i)) & 0xffffff;
  }
  return [(hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff];
}

/**
 * Get all known block colors.
 */
export function getAllBlockColors(): ReadonlyMap<string, RGB> {
  return new Map(Object.entries(BLOCK_COLORS));
}
