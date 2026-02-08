/**
 * Room generators — each room type is a function that furnishes
 * a rectangular region of a BlockGrid with appropriate contents.
 */

import { BlockGrid } from '../schem/types.js';
import type { RoomType, RoomBounds } from '../types/index.js';
import type { StylePalette } from './styles.js';
import {
  chandelier, tableAndChairs, longDiningTable, bookshelfWall,
  carpetArea, endRodPillar, fireplace, placeBed, sideTable,
} from './furniture.js';

/** Room generator function signature */
export type RoomGenerator = (grid: BlockGrid, bounds: RoomBounds, style: StylePalette) => void;

/** Registry of room generators by type */
const ROOM_GENERATORS: Record<RoomType, RoomGenerator> = {
  living: generateLivingRoom,
  dining: generateDiningRoom,
  kitchen: generateKitchen,
  foyer: generateFoyer,
  bedroom: generateBedroom,
  bathroom: generateBathroom,
  study: generateStudy,
  library: generateLibrary,
  vault: generateVault,
  armory: generateArmory,
  observatory: generateObservatory,
  lab: generateLab,
  gallery: generateGallery,
  throne: generateThroneRoom,
  forge: generateForge,
  greenhouse: generateGreenhouse,
};

/** Get a room generator by type */
export function getRoomGenerator(type: RoomType): RoomGenerator {
  return ROOM_GENERATORS[type];
}

/** Get all available room types */
export function getRoomTypes(): RoomType[] {
  return Object.keys(ROOM_GENERATORS) as RoomType[];
}

// ─── Room Implementations ────────────────────────────────────────────────────

function generateLivingRoom(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);

  // Fireplace on front wall
  fireplace(grid, cx, y, z1, style);

  // Couches facing fireplace
  grid.set(cx - 1, y, z1 + 3, style.chairN);
  grid.set(cx, y, z1 + 3, style.chairN);
  grid.set(cx + 1, y, z1 + 3, style.chairN);
  grid.set(cx - 2, y, z1 + 2, style.chairE);

  // Coffee table
  grid.set(cx, y, z1 + 2, style.fence);
  grid.set(cx, y + 1, z1 + 2, style.carpet);

  // Carpet area
  carpetArea(grid, cx - 2, y, z1 + 3, cx + 2, z1 + 5, style.carpet);

  // Bookshelves on walls
  bookshelfWall(grid, x1, y, z2 - 1, x1 + 3, 3);

  // Flower pots
  grid.set(x1, y, z1, 'minecraft:potted_fern');
  grid.set(x2, y, z1, 'minecraft:potted_allium');

  // Banners
  grid.set(x1 + 2, y + 3, z1, style.bannerS);
  grid.set(x2 - 2, y + 3, z1, style.bannerS);

  // Chandelier
  chandelier(grid, cx, y + height - 1, z1 + 3, style, 2);
}

function generateDiningRoom(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);

  // Long dining table
  longDiningTable(grid, cx, y, z1 + 2, Math.min(6, z2 - z1 - 3), style);

  // Head chair
  grid.set(cx, y, z2 - 2, style.chairN);

  // Banners on back wall
  grid.set(cx - 2, y + 3, z2, style.bannerN);
  grid.set(cx + 2, y + 3, z2, style.bannerN);

  // Chandeliers
  chandelier(grid, cx, y + height - 1, z1 + 4, style, 2);
  chandelier(grid, cx, y + height - 1, z2 - 3, style, 1);

  // Carpet runner under table
  carpetArea(grid, cx - 2, y, z1 + 1, cx + 2, z2 - 1, style.carpet);
}

function generateKitchen(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;

  // Counter along back wall
  for (let cx = x1; cx < x1 + 6 && cx <= x2; cx++) {
    grid.set(cx, y, z2, 'minecraft:polished_andesite');
    grid.set(cx, y + 1, z2, 'minecraft:smooth_stone_slab[type=bottom]');
  }
  // Cooking stations
  grid.set(x1, y, z2, 'minecraft:furnace[facing=south,lit=false]');
  grid.set(x1 + 1, y, z2, 'minecraft:smoker[facing=south,lit=false]');
  grid.set(x1 + 2, y, z2, 'minecraft:blast_furnace[facing=south,lit=false]');
  grid.set(x1 + 3, y, z2, 'minecraft:crafting_table');

  // Sink
  grid.set(x2, y, z2, 'minecraft:water_cauldron[level=3]');
  grid.set(x2 - 1, y, z2, 'minecraft:water_cauldron[level=3]');

  // Kitchen island table
  tableAndChairs(grid, Math.floor((x1 + x2) / 2), y, z1 + 3, style, 'nsew');

  // Pantry chest
  grid.addChest(x2, y, z1, 'west', [
    { slot: 0, id: 'minecraft:bread', count: 64 },
    { slot: 1, id: 'minecraft:cooked_beef', count: 64 },
    { slot: 2, id: 'minecraft:golden_apple', count: 16 },
    { slot: 3, id: 'minecraft:cookie', count: 64 },
  ]);

  // Ceiling light
  grid.set(Math.floor((x1 + x2) / 2), y + height, Math.floor((z1 + z2) / 2), 'minecraft:glowstone');
}

function generateFoyer(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2 } = b;

  // Carpet runner
  for (let z = z1; z <= z2; z++) {
    grid.set(x1, y, z, style.carpet);
    grid.set(x1 + 1, y, z, style.carpet);
  }
  // Broader carpet
  carpetArea(grid, x1 + 3, y, z1 + 2, x2 - 2, z2 - 2, style.carpet);

  // Decorative pillars
  grid.set(x1, y, z1, style.pillar);
  grid.set(x1, y + 1, z1, style.pillar);
  grid.set(x1, y + 2, z1, 'minecraft:end_rod[facing=up]');
  grid.set(x2, y, z1, style.pillar);
  grid.set(x2, y + 1, z1, style.pillar);
  grid.set(x2, y + 2, z1, 'minecraft:end_rod[facing=up]');

  // Bell
  grid.set(x1 + 2, y, z1, 'minecraft:bell[attachment=floor,facing=north]');

  // Console tables
  sideTable(grid, x2, y, z1 + 4, style, 'minecraft:candle[candles=3,lit=true]');
  sideTable(grid, x2, y, z1 + 6, style, 'minecraft:potted_red_tulip');

  // Banners
  grid.set(x1 + 4, y + 3, z1, style.bannerS);
}

function generateBedroom(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;

  // Bed
  placeBed(grid, x1 + 3, y, z1 + 1, 'south');

  // Nightstands
  grid.addBarrel(x1 + 2, y, z1 + 1, 'up', [
    { slot: 0, id: 'minecraft:book', count: 1 },
    { slot: 1, id: 'minecraft:clock', count: 1 },
  ]);
  grid.set(x1 + 2, y + 1, z1 + 1, 'minecraft:candle[candles=1,lit=true]');

  // Wardrobe chest
  grid.addChest(x1, y, z2 - 1, 'east', [
    { slot: 0, id: 'minecraft:diamond_chestplate', count: 1 },
    { slot: 1, id: 'minecraft:elytra', count: 1 },
    { slot: 2, id: 'minecraft:golden_apple', count: 8 },
  ]);

  // Vanity
  grid.set(x2, y, z1, 'minecraft:crafting_table');
  grid.set(x2, y + 1, z1, 'minecraft:potted_azure_bluet');

  // Carpet
  carpetArea(grid, x1 + 1, y, z1 + 3, x2 - 1, z2 - 1, 'minecraft:blue_carpet');

  // Chandelier
  chandelier(grid, Math.floor((x1 + x2) / 2), y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
}

function generateBathroom(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;

  // Bathtub
  grid.set(x2, y, z1 + 1, 'minecraft:water_cauldron[level=3]');
  grid.set(x2, y, z1 + 2, 'minecraft:water_cauldron[level=3]');
  grid.set(x2, y, z1 + 3, 'minecraft:water_cauldron[level=3]');
  grid.set(x2 - 1, y, z1 + 1, 'minecraft:smooth_quartz');
  grid.set(x2 - 1, y, z1 + 3, 'minecraft:smooth_quartz');

  // Sink and mirror
  grid.set(x1 + 1, y, z1, 'minecraft:water_cauldron[level=3]');
  grid.set(x1 + 1, y + 1, z1, 'minecraft:sea_lantern');
  grid.set(x1 + 1, y + 2, z1, 'minecraft:glass_pane');

  // Checkerboard floor
  for (let x = x1; x <= x2; x++) {
    for (let z = z1; z <= z2; z++) {
      if ((x + z) % 2 === 0) {
        grid.set(x, b.y - 1, z, 'minecraft:smooth_quartz');
      }
    }
  }

  // Lighting
  chandelier(grid, Math.floor((x1 + x2) / 2), y + height - 1, z1 + 2, style, 1);
}

function generateStudy(grid: BlockGrid, b: RoomBounds, _style: StylePalette): void {
  const { x1, y, z1, x2, z2 } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const cz = Math.floor((z1 + z2) / 2);

  // Enchanting table surrounded by bookshelves
  grid.set(cx, y, cz, 'minecraft:enchanting_table');
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const dist = Math.abs(dx) + Math.abs(dz);
      if (dist === 2 || dist === 3) {
        const bx = cx + dx, bz = cz + dz;
        if (grid.inBounds(bx, y, bz) && bx > x1 && bx < x2 && bz > z1 && bz < z2) {
          grid.set(bx, y, bz, 'minecraft:bookshelf');
          grid.set(bx, y + 1, bz, 'minecraft:bookshelf');
        }
      }
    }
  }

  // Brewing corner
  grid.set(x2, y, z2, 'minecraft:brewing_stand');
  grid.set(x2 - 1, y, z2, 'minecraft:water_cauldron[level=3]');

  // End rod accent lighting
  grid.set(cx - 2, y, cz - 2, 'minecraft:end_rod[facing=up]');
  grid.set(cx + 2, y, cz - 2, 'minecraft:end_rod[facing=up]');
  grid.set(cx - 2, y, cz + 2, 'minecraft:end_rod[facing=up]');
  grid.set(cx + 2, y, cz + 2, 'minecraft:end_rod[facing=up]');

  // Carpet
  carpetArea(grid, cx - 1, y, cz - 1, cx + 1, cz + 1, 'minecraft:purple_carpet');
}

function generateLibrary(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);

  // Bookshelves lining walls (3 rows high)
  bookshelfWall(grid, x1, y, z1, x2, 3);
  bookshelfWall(grid, x1, y, z2, x2, 3);
  for (let r = 0; r < 3; r++) {
    for (let z = z1; z <= z2; z++) {
      grid.set(x1, y + r, z, 'minecraft:bookshelf');
    }
  }

  // Reading table
  tableAndChairs(grid, cx, y, Math.floor((z1 + z2) / 2), style, 'nsew');

  // Lectern
  grid.set(cx + 2, y, z1 + 2, 'minecraft:lectern[facing=south]');

  // Carpet
  carpetArea(grid, x1 + 2, y, z1 + 1, x2 - 1, z2 - 1, style.carpet);

  // Chandelier
  chandelier(grid, cx, y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
}

function generateVault(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const cz = Math.floor((z1 + z2) / 2);

  // Gilded blackstone floor
  grid.fill(x1, y - 1, z1, x2, y - 1, z2, 'minecraft:gilded_blackstone');

  // Reinforced walls
  for (let vy = y; vy < y + height; vy++) {
    for (let x = x1; x <= x2; x++) {
      grid.set(x, vy, z1, 'minecraft:polished_blackstone_bricks');
      grid.set(x, vy, z2, 'minecraft:polished_blackstone_bricks');
    }
    for (let z = z1; z <= z2; z++) {
      grid.set(x2, vy, z, 'minecraft:polished_blackstone_bricks');
    }
  }

  // Gold pyramid
  grid.set(cx, y, cz, 'minecraft:gold_block');
  grid.set(cx + 1, y, cz, 'minecraft:gold_block');
  grid.set(cx - 1, y, cz, 'minecraft:gold_block');
  grid.set(cx, y, cz + 1, 'minecraft:gold_block');
  grid.set(cx, y, cz - 1, 'minecraft:gold_block');
  grid.set(cx, y + 1, cz, 'minecraft:gold_block');

  // Dragon egg on top
  grid.set(cx, y + 2, cz, 'minecraft:dragon_egg');

  // Diamond/emerald pedestals
  grid.set(x2 - 2, y, z1 + 2, 'minecraft:diamond_block');
  grid.set(x2 - 2, y + 1, z1 + 2, 'minecraft:diamond_block');
  grid.set(x2 - 2, y, z2 - 2, 'minecraft:emerald_block');
  grid.set(x2 - 2, y + 1, z2 - 2, 'minecraft:emerald_block');

  // Treasure chests
  grid.addChest(x2 - 1, y, z1 + 1, 'south', [
    { slot: 0, id: 'minecraft:diamond', count: 64 },
    { slot: 1, id: 'minecraft:emerald', count: 64 },
    { slot: 2, id: 'minecraft:gold_ingot', count: 64 },
    { slot: 3, id: 'minecraft:netherite_ingot', count: 16 },
  ]);

  // Soul lanterns
  chandelier(grid, cx - 2, y + height - 1, z1 + 2, { ...style, lantern: 'minecraft:soul_lantern[hanging=true]' }, 1);
  chandelier(grid, cx + 2, y + height - 1, z2 - 2, { ...style, lantern: 'minecraft:soul_lantern[hanging=true]' }, 1);

  // Crying obsidian corners
  grid.set(x1, y, z1, 'minecraft:crying_obsidian');
  grid.set(x2, y, z1, 'minecraft:crying_obsidian');
  grid.set(x1, y, z2, 'minecraft:crying_obsidian');
  grid.set(x2, y, z2, 'minecraft:crying_obsidian');
}

function generateArmory(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;

  // Smithing stations
  grid.set(x2, y, z2, 'minecraft:smithing_table');
  grid.set(x2 - 1, y, z2, 'minecraft:grindstone[face=floor,facing=north]');
  grid.set(x2 - 2, y, z2, 'minecraft:anvil[facing=north]');

  // Weapon chest
  grid.addChest(x2, y, z1, 'west', [
    { slot: 0, id: 'minecraft:iron_sword', count: 1 },
    { slot: 1, id: 'minecraft:iron_axe', count: 1 },
    { slot: 2, id: 'minecraft:shield', count: 2 },
    { slot: 3, id: 'minecraft:crossbow', count: 1 },
    { slot: 4, id: 'minecraft:arrow', count: 64 },
  ]);

  // Armor chest
  grid.addChest(x2, y, z1 + 1, 'west', [
    { slot: 0, id: 'minecraft:iron_helmet', count: 2 },
    { slot: 1, id: 'minecraft:iron_chestplate', count: 2 },
    { slot: 2, id: 'minecraft:iron_leggings', count: 2 },
    { slot: 3, id: 'minecraft:iron_boots', count: 2 },
  ]);

  // Training target
  grid.set(x2 - 2, y, z1 + 4, 'minecraft:hay_block');
  grid.set(x2 - 2, y + 1, z1 + 4, 'minecraft:target');

  // Carpet
  carpetArea(grid, x1 + 1, y, z1 + 3, x2 - 1, z2 - 3, 'minecraft:black_carpet');

  // Chandelier
  chandelier(grid, Math.floor((x1 + x2) / 2), y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
}

function generateObservatory(grid: BlockGrid, b: RoomBounds, _style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const cz = Math.floor((z1 + z2) / 2);

  // End stone brick floor
  grid.fill(x1, y - 1, z1, x2, y - 1, z2, 'minecraft:end_stone_bricks');

  // Beacon on iron base
  grid.fill(cx - 1, y, cz - 1, cx + 1, y, cz + 1, 'minecraft:iron_block');
  grid.set(cx, y + 1, cz, 'minecraft:beacon');

  // Purpur columns
  for (const [px, pz] of [[x1 + 1, z1 + 2], [x2 - 1, z1 + 2], [x1 + 1, z2 - 2], [x2 - 1, z2 - 2]]) {
    for (let py = y; py < y + height; py++) {
      grid.set(px, py, pz, 'minecraft:purpur_pillar');
    }
  }

  // Amethyst corner
  grid.set(x1, y, z1, 'minecraft:budding_amethyst');
  grid.set(x1 + 1, y, z1, 'minecraft:amethyst_block');
  grid.set(x1, y, z1 + 1, 'minecraft:amethyst_block');
  grid.set(x1, y + 1, z1, 'minecraft:amethyst_cluster[facing=up]');

  // End rod pillars
  for (const [ex, ez] of [[x1 + 3, z1 + 3], [x2 - 3, z1 + 3], [x1 + 3, z2 - 3], [x2 - 3, z2 - 3]]) {
    endRodPillar(grid, ex, y, ez, 4);
  }

  // Sea lantern floor accents
  for (const [sx, sz] of [[cx - 3, cz], [cx + 3, cz], [cx, cz - 3], [cx, cz + 3]]) {
    grid.set(sx, y - 1, sz, 'minecraft:sea_lantern');
  }

  // Purple carpet cross
  for (let i = -2; i <= 2; i++) {
    grid.set(cx + i, y, cz, 'minecraft:purple_carpet');
    grid.set(cx, y, cz + i, 'minecraft:purple_carpet');
  }
}

function generateLab(grid: BlockGrid, b: RoomBounds, _style: StylePalette): void {
  const { x1, y, z1, x2, z2 } = b;

  // Brewing stands
  grid.set(x2, y, z1, 'minecraft:brewing_stand');
  grid.set(x2 - 1, y, z1, 'minecraft:brewing_stand');

  // Cauldrons
  grid.set(x2, y, z1 + 1, 'minecraft:water_cauldron[level=3]');
  grid.set(x1, y, z2, 'minecraft:water_cauldron[level=3]');

  // Workbenches
  grid.set(x1, y, z1, 'minecraft:crafting_table');
  grid.set(x1 + 1, y, z1, 'minecraft:cartography_table');

  // Bookshelves for reference
  bookshelfWall(grid, x1, y, z2 - 1, x1 + 3, 2);

  // Supply chest
  grid.addChest(x2, y, z2, 'west', [
    { slot: 0, id: 'minecraft:blaze_powder', count: 16 },
    { slot: 1, id: 'minecraft:nether_wart', count: 32 },
    { slot: 2, id: 'minecraft:ghast_tear', count: 4 },
    { slot: 3, id: 'minecraft:glowstone_dust', count: 32 },
  ]);

  // End rod lighting
  grid.set(x1 + 2, y, z1 + 2, 'minecraft:end_rod[facing=up]');
  grid.set(x2 - 2, y, z2 - 2, 'minecraft:end_rod[facing=up]');
}

function generateGallery(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const cz = Math.floor((z1 + z2) / 2);

  // Central display
  grid.set(cx, y, cz, 'minecraft:waxed_copper_block');
  grid.set(cx, y + 1, cz, 'minecraft:waxed_oxidized_copper');
  grid.set(cx, y + 2, cz, 'minecraft:lightning_rod');

  // Banner gallery along wall
  for (let i = 2; i <= Math.min(8, x2 - x1 - 1); i += 2) {
    const bannerColors = [
      'minecraft:purple_wall_banner[facing=south]',
      'minecraft:red_wall_banner[facing=south]',
      'minecraft:blue_wall_banner[facing=south]',
      'minecraft:white_wall_banner[facing=south]',
    ];
    grid.set(x1 + i, y + 3, z1, bannerColors[(i / 2) % bannerColors.length]);
  }

  // Display pedestals
  grid.set(cx - 3, y, cz + 2, 'minecraft:quartz_block');
  grid.set(cx - 3, y + 1, cz + 2, 'minecraft:potted_crimson_fungus');
  grid.set(cx + 3, y, cz + 2, 'minecraft:quartz_block');
  grid.set(cx + 3, y + 1, cz + 2, 'minecraft:amethyst_cluster[facing=up]');

  // Carpet
  carpetArea(grid, x1 + 1, y, z1 + 2, x2 - 1, z2 - 1, 'minecraft:cyan_carpet');

  // Soul lanterns
  chandelier(grid, cx - 3, y + height - 1, cz, { ...style, lantern: 'minecraft:soul_lantern[hanging=true]' }, 1);
  chandelier(grid, cx + 3, y + height - 1, cz, { ...style, lantern: 'minecraft:soul_lantern[hanging=true]' }, 1);
}

function generateThroneRoom(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);

  // Throne (stairs as chair on raised platform)
  grid.set(cx, y, z2 - 2, style.floorGround);
  grid.set(cx, y + 1, z2 - 2, style.chairN);
  // Armrests
  grid.set(cx - 1, y, z2 - 2, style.slabBottom);
  grid.set(cx + 1, y, z2 - 2, style.slabBottom);

  // Red carpet runner to throne
  for (let z = z1; z <= z2 - 3; z++) {
    grid.set(cx, y, z, style.carpet);
  }

  // Pillars flanking throne
  for (let py = y; py < y + height; py++) {
    grid.set(cx - 3, py, z2 - 1, style.pillar);
    grid.set(cx + 3, py, z2 - 1, style.pillar);
  }

  // Banners
  grid.set(cx - 2, y + 3, z2, style.bannerN);
  grid.set(cx + 2, y + 3, z2, style.bannerN);

  // Chandelier
  chandelier(grid, cx, y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
}

function generateForge(grid: BlockGrid, b: RoomBounds, _style: StylePalette): void {
  const { x1, y, z1, x2, z2 } = b;

  // Forge stations
  grid.set(x1, y, z2, 'minecraft:blast_furnace[facing=south,lit=false]');
  grid.set(x1 + 1, y, z2, 'minecraft:blast_furnace[facing=south,lit=false]');
  grid.set(x1 + 2, y, z2, 'minecraft:smithing_table');
  grid.set(x1 + 3, y, z2, 'minecraft:anvil[facing=north]');
  grid.set(x1 + 4, y, z2, 'minecraft:grindstone[face=floor,facing=north]');

  // Lava (represented by campfire for safety)
  grid.set(x2, y, z2, 'minecraft:campfire[lit=true]');

  // Tool/material storage
  grid.addChest(x2, y, z1, 'west', [
    { slot: 0, id: 'minecraft:iron_ingot', count: 64 },
    { slot: 1, id: 'minecraft:gold_ingot', count: 32 },
    { slot: 2, id: 'minecraft:diamond', count: 16 },
    { slot: 3, id: 'minecraft:coal', count: 64 },
  ]);

  // Water quench
  grid.set(x2 - 1, y, z2, 'minecraft:water_cauldron[level=3]');
}

function generateGreenhouse(grid: BlockGrid, b: RoomBounds, _style: StylePalette): void {
  const { x1, y, z1, x2, z2 } = b;

  // Composters
  grid.set(x1, y, z1, 'minecraft:composter');
  grid.set(x1 + 1, y, z1, 'minecraft:composter');

  // Flower pots along walls
  const flowers = [
    'minecraft:potted_red_tulip', 'minecraft:potted_azure_bluet',
    'minecraft:potted_allium', 'minecraft:potted_blue_orchid',
    'minecraft:potted_lily_of_the_valley', 'minecraft:potted_fern',
    'minecraft:potted_cactus', 'minecraft:potted_oak_sapling',
  ];
  let fi = 0;
  for (let x = x1; x <= x2; x += 2) {
    grid.set(x, y, z2, flowers[fi % flowers.length]);
    fi++;
  }
  for (let z = z1; z <= z2; z += 2) {
    grid.set(x1, y, z, flowers[fi % flowers.length]);
    fi++;
  }

  // Water source
  grid.set(Math.floor((x1 + x2) / 2), y, Math.floor((z1 + z2) / 2), 'minecraft:water_cauldron[level=3]');

  // Glowstone for plant growth
  grid.set(Math.floor((x1 + x2) / 2), y + 4, Math.floor((z1 + z2) / 2), 'minecraft:glowstone');
}
