/**
 * Canonical texture-name list for the block atlas — a PURE data leaf.
 *
 * Lives separately from `texture-atlas.ts` (which imports `node:fs`/
 * `node:stream`) so browser-safe modules — notably the palette-validity
 * gate in `src/pipeline/verify/objective.ts` via `src/blocks/known-blocks.ts`
 * — can consume the list without dragging node builtins into a Vite bundle.
 * Same leaf-module pattern as `src/pipeline/voxel-defaults.ts`.
 */

/** Common block texture names that should be in every atlas */
export const COMMON_TEXTURES = [
  // Stone variants
  'stone', 'cobblestone', 'stone_bricks', 'chiseled_stone_bricks', 'mossy_stone_bricks',
  'cracked_stone_bricks', 'mossy_cobblestone',
  'polished_andesite', 'polished_diorite', 'polished_granite',
  'andesite', 'diorite', 'granite',
  'deepslate', 'deepslate_bricks', 'polished_deepslate',
  'polished_blackstone', 'polished_blackstone_bricks',
  'deepslate_tiles', 'cracked_deepslate_bricks', 'cracked_deepslate_tiles',
  'blackstone', 'gilded_blackstone',
  // Wood planks
  'oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks',
  'acacia_planks', 'jungle_planks', 'warped_planks', 'crimson_planks',
  // Logs
  'oak_log', 'oak_log_top', 'spruce_log', 'spruce_log_top',
  'birch_log', 'birch_log_top', 'dark_oak_log', 'dark_oak_log_top',
  'acacia_log', 'acacia_log_top', 'jungle_log', 'jungle_log_top',
  'warped_stem', 'warped_stem_top', 'crimson_stem', 'crimson_stem_top',
  // Stripped logs
  'stripped_oak_log', 'stripped_oak_log_top',
  'stripped_dark_oak_log', 'stripped_dark_oak_log_top',
  'stripped_spruce_log', 'stripped_spruce_log_top',
  'stripped_birch_log', 'stripped_birch_log_top',
  'stripped_acacia_log', 'stripped_acacia_log_top',
  'stripped_warped_stem', 'stripped_crimson_stem',
  // Concrete (all 16)
  'white_concrete', 'gray_concrete', 'light_gray_concrete', 'black_concrete',
  'red_concrete', 'blue_concrete', 'green_concrete', 'yellow_concrete',
  'orange_concrete', 'cyan_concrete', 'purple_concrete', 'pink_concrete',
  'brown_concrete', 'lime_concrete', 'magenta_concrete', 'light_blue_concrete',
  // Bricks & terracotta
  'bricks', 'nether_bricks', 'red_nether_bricks', 'end_stone_bricks',
  'terracotta', 'white_terracotta', 'orange_terracotta', 'red_terracotta',
  'brown_terracotta', 'yellow_terracotta', 'light_gray_terracotta', 'cyan_terracotta',
  'black_terracotta', 'blue_terracotta', 'gray_terracotta', 'green_terracotta',
  'light_blue_terracotta', 'lime_terracotta', 'magenta_terracotta',
  'pink_terracotta', 'purple_terracotta',
  // Glass
  'glass',
  // Quartz
  'quartz_block_side', 'quartz_block_top', 'quartz_block_bottom',
  'quartz_pillar', 'quartz_pillar_top', 'smooth_quartz',
  // Functional blocks
  'bookshelf', 'crafting_table_top', 'crafting_table_side',
  'furnace_top', 'furnace_front', 'furnace_side',
  'enchanting_table_top', 'enchanting_table_side', 'enchanting_table_bottom',
  'anvil', 'anvil_top', 'lectern_top', 'lectern_sides', 'lectern_front',
  'cartography_table_top', 'cartography_table_side1',
  'smithing_table_top', 'smithing_table_side', 'smithing_table_front',
  'loom_top', 'loom_side', 'loom_front',
  'note_block', 'jukebox_top', 'jukebox_side',
  'stonecutter_top', 'stonecutter_side',
  'grindstone_side', 'grindstone_round',
  'brewing_stand', 'brewing_stand_base',
  'composter_top', 'composter_side',
  'smoker_top', 'smoker_side', 'smoker_front',
  'blast_furnace_top', 'blast_furnace_side', 'blast_furnace_front',
  'barrel_top', 'barrel_side', 'barrel_bottom',
  // Precious / ore blocks
  'obsidian', 'glowstone', 'sea_lantern',
  'gold_block', 'diamond_block', 'emerald_block', 'lapis_block', 'iron_block',
  'copper_block', 'redstone_block', 'amethyst_block',
  'netherrack',
  // Prismarine
  'prismarine', 'prismarine_bricks', 'dark_prismarine',
  // Sandstone
  'sandstone', 'sandstone_top', 'sandstone_bottom', 'chiseled_sandstone',
  'smooth_sandstone', 'smooth_sandstone_top',
  'red_sandstone', 'red_sandstone_top', 'red_sandstone_bottom',
  'chiseled_red_sandstone', 'smooth_red_sandstone',
  // Copper variants
  'exposed_copper', 'weathered_copper', 'oxidized_copper',
  'cut_copper', 'exposed_cut_copper', 'weathered_cut_copper', 'oxidized_cut_copper',
  // Coral blocks
  'tube_coral_block', 'brain_coral_block', 'bubble_coral_block',
  'fire_coral_block', 'horn_coral_block',
  'dead_tube_coral_block', 'dead_brain_coral_block',
  // Natural / terrain
  'dirt', 'sand', 'gravel', 'clay', 'grass_block_top', 'grass_block_side',
  'moss_block', 'tuff', 'tuff_bricks', 'calcite',
  'mud_bricks', 'packed_mud', 'podzol',
  // Leaves
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'dark_oak_leaves', 'acacia_leaves',
  'azalea_leaves', 'flowering_azalea_leaves',
  // Wool (all 16)
  'white_wool', 'orange_wool', 'red_wool', 'blue_wool', 'light_blue_wool',
  'yellow_wool', 'black_wool', 'brown_wool', 'green_wool', 'gray_wool',
  'light_gray_wool', 'purple_wool', 'cyan_wool', 'magenta_wool', 'pink_wool', 'lime_wool',
  // Carpet (uses wool textures but listed for atlas coverage)
  'red_carpet', 'blue_carpet', 'cyan_carpet', 'yellow_carpet', 'white_carpet',
  'black_carpet', 'purple_carpet', 'green_carpet', 'brown_carpet', 'gray_carpet',
  'light_gray_carpet', 'orange_carpet', 'lime_carpet', 'pink_carpet',
  'magenta_carpet', 'light_blue_carpet',
  // Nether
  'soul_sand',
  // End
  'end_stone', 'end_stone_bricks', 'purpur_block', 'purpur_pillar', 'purpur_pillar_top',
  // Misc blocks
  'hay_block_side', 'hay_block_top', 'bone_block_side', 'bone_block_top',
  'redstone_lamp', 'beacon', 'flower_pot', 'cobweb',
  'ice', 'packed_ice', 'dragon_egg',
  // Doors
  'oak_door_top', 'oak_door_bottom', 'spruce_door_top', 'spruce_door_bottom',
  'birch_door_top', 'birch_door_bottom', 'dark_oak_door_top', 'dark_oak_door_bottom',
  'acacia_door_top', 'acacia_door_bottom', 'iron_door_top', 'iron_door_bottom',
  'warped_door_top', 'warped_door_bottom', 'crimson_door_top', 'crimson_door_bottom',
  // Trapdoors
  'oak_trapdoor', 'spruce_trapdoor', 'birch_trapdoor', 'dark_oak_trapdoor',
  'iron_trapdoor', 'warped_trapdoor',
  // Metal / utility
  'iron_bars', 'chain', 'cauldron_side', 'cauldron_top', 'cauldron_inner',
  // Lighting
  'lantern', 'soul_lantern', 'end_rod', 'torch', 'soul_torch',
  'campfire_log_lit', 'soul_campfire_log_lit',
];
