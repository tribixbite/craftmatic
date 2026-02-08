# Generation Styles

The structure generator uses a style preset system to control materials, decorations, and atmosphere of generated buildings.

## Style Presets

### Fantasy
White concrete walls, dark oak timber, magical items, purple/blue accents.
- Walls: `white_concrete`
- Floor: `dark_oak_planks`
- Roof: `dark_oak_stairs`
- Accent: `end_stone_bricks`
- Glass: `glass_pane`
- Lighting: `lantern`, `end_rod`
- Carpets: `red_carpet`, `blue_carpet`, `cyan_carpet`, `yellow_carpet`

### Medieval
Stone/cobblestone walls, oak timber, banners, iron fixtures.
- Walls: `stone_bricks`
- Floor: `oak_planks`
- Roof: `dark_oak_stairs`
- Accent: `cobblestone`
- Glass: `glass_pane`
- Lighting: `torch`
- Carpets: `red_carpet`, `green_carpet`

### Modern
Concrete and glass, sea lanterns, minimal furniture.
- Walls: `smooth_quartz`
- Floor: `polished_granite`
- Roof: `smooth_stone_slab`
- Accent: `quartz_pillar`
- Glass: `glass`
- Lighting: `sea_lantern`
- Carpets: `white_carpet`, `light_gray_carpet`

### Gothic
Deepslate, nether brick, soul lanterns, iron bars.
- Walls: `deepslate_bricks`
- Floor: `polished_blackstone`
- Roof: `dark_oak_stairs`
- Accent: `nether_bricks`
- Glass: `tinted_glass`
- Lighting: `soul_lantern`
- Carpets: `black_carpet`, `purple_carpet`, `gray_carpet`

### Rustic
Spruce/birch wood, hay, composters, flower pots.
- Walls: `spruce_planks`
- Floor: `birch_planks`
- Roof: `spruce_stairs`
- Accent: `stripped_spruce_log`
- Glass: `glass_pane`
- Lighting: `torch`
- Carpets: `brown_carpet`, `green_carpet`, `yellow_carpet`

## StylePalette Interface

Each preset defines 40+ fields:

```typescript
interface StylePalette {
  // Structural
  wall: string;           // Primary wall material
  wallAlt: string;        // Secondary wall material
  floor: string;          // Floor material
  ceiling: string;        // Ceiling material
  foundation: string;     // Foundation material
  stairs: string;         // Staircase material
  slab: string;           // Slab material
  roof: string;           // Roof material (stairs)
  roofSlab: string;       // Roof edge material (slabs)

  // Timber frame
  timber: string;         // Log for columns/beams
  timberX: string;        // Log[axis=x]
  timberZ: string;        // Log[axis=z]

  // Decorative
  accent: string;         // Accent block
  pillar: string;         // Pillar material
  glass: string;          // Window material
  door: string;           // Door material
  trapdoor: string;       // Trapdoor material
  fence: string;          // Fence material

  // Furniture
  table: string;          // Table surface
  chair: string;          // Chair material
  bookshelf: string;      // Bookshelf block

  // Lighting
  lightHang: string;      // Hanging light
  lightWall: string;      // Wall-mounted light
  lightFloor: string;     // Floor-standing light

  // Carpets (array of block states)
  carpets: string[];

  // Additional decorative elements
  banner: string;
  flower: string;
  pot: string;
}
```

## Room Types

16 room generators, each receiving `(grid, bounds, style)`:

| Room | Key Features |
|------|-------------|
| living | Fireplace, seating area, carpet |
| dining | Long table, chandelier |
| kitchen | Furnaces, smoker, crafting table |
| foyer | Grand entrance, carpet runner |
| bedroom | Bed, side tables, wardrobe |
| bathroom | Cauldron (bath), flower pots |
| study | Desk, bookshelves, writing area |
| library | Floor-to-ceiling bookshelves |
| vault | Treasure chests, gold blocks, barriers |
| armory | Armor stands, weapon racks |
| observatory | Glass ceiling, redstone instruments |
| lab | Brewing stands, cauldrons, potions |
| gallery | Item frames, paintings, pedestals |
| throne | Throne, red carpet runner, banners |
| forge | Blast furnace, anvil, lava |
| greenhouse | Glass walls, composters, plants |

## Seeded Random

Generation uses mulberry32 PRNG for deterministic output:
- Pass `--seed <n>` to get reproducible results
- Without a seed, `Date.now()` is used
- Room assignments and furniture placement use the seeded RNG
