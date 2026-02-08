# Block Mapping

## Color Map

The block color map (`src/blocks/colors.ts`) provides RGB colors for 2D rendering. It contains 170+ entries covering all common Minecraft blocks.

### Lookup Strategy

1. **Exact match**: Look up the full block state string (e.g. `minecraft:oak_planks`)
2. **Base ID**: Strip properties and namespace (e.g. `oak_planks`)
3. **Prefix match**: Match material prefix (e.g. `dark_oak_` → brown tones)
4. **Hash fallback**: Generate a deterministic color from the block name hash

### Block Categories

| Category | Example Blocks | Color Range |
|----------|---------------|-------------|
| Stone | stone, cobblestone, andesite | Gray (128-160) |
| Wood | oak_planks, spruce_planks | Brown (120-180) |
| Logs | oak_log, dark_oak_log | Dark brown (60-100) |
| Concrete | white_concrete, red_concrete | Vivid colors |
| Wool | white_wool, blue_wool | Vivid colors |
| Carpet | red_carpet, cyan_carpet | Matching wool colors |
| Glass | glass, glass_pane | Light blue-white (200-230) |
| Ore blocks | gold_block, diamond_block | Bright colors |
| Nether | netherrack, nether_bricks | Dark red (100-130, 20-50, 20-50) |
| End | end_stone, purpur_block | Yellow/Purple |

### Special Block Sets

- **FURNITURE_BLOCKS**: crafting_table, anvil, loom, stonecutter, etc.
- **LIGHT_BLOCKS**: torch, lantern, glowstone, sea_lantern, etc.
- **BED_BLOCKS**: all 16 wool color beds
- **DOOR_BLOCKS**: all wood type doors + iron_door

These sets are used by the 2D renderer to draw special markers on floor plans.

## Texture Mapping

The texture system (`src/blocks/textures.ts`) maps block states to per-face texture names.

### Face System

Each block has 6 faces: `top`, `bottom`, `north`, `south`, `east`, `west`.

### Texture Patterns

- **allFaces**: Same texture on all sides (stone, planks, concrete)
- **topBottomSides**: Different top/bottom vs sides (grass, crafting table)
- **logTextures**: End grain on top/bottom, bark on sides, respects `axis` property
- **Directional**: Stairs, doors, etc. have orientation-dependent textures

### Current Status

The texture atlas system is a placeholder — all blocks currently use solid colors.

TODO: Implement procedural 16x16 texture generation for common blocks.
