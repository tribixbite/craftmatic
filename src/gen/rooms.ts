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
  storageCorner, couchSet, rugWithBorder, wallShelf, armorDisplay,
  telescope, plateSet, mapTable, lightFixture,
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
  captains_quarters: generateCaptainsQuarters,
  cell: generateCell,
  nave: generateNave,
  belfry: generateBelfry,
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
  const rw = x2 - x1;
  const rl = z2 - z1;

  // Fireplace on front wall (centered)
  fireplace(grid, cx, y, z1, style);

  // L-shaped couch facing fireplace
  couchSet(grid, cx + 1, y, z1 + 3, style, 'nw');

  // Coffee table (wider, with candle)
  grid.set(cx, y, z1 + 2, style.fence);
  grid.set(cx - 1, y, z1 + 2, style.fence);
  grid.set(cx, y + 1, z1 + 2, style.carpet);
  grid.set(cx - 1, y + 1, z1 + 2, style.carpet);
  grid.set(cx, y + 2, z1 + 2, 'minecraft:candle[candles=1,lit=true]');

  // Area rug with border under seating
  if (rw >= 6 && rl >= 6) {
    rugWithBorder(grid, cx - 2, y, z1 + 2, cx + 2, z1 + 5, style.carpet, style.carpetAccent);
  } else {
    carpetArea(grid, cx - 2, y, z1 + 3, cx + 2, z1 + 5, style.carpet);
  }

  // Bookshelf wall along back (full width)
  bookshelfWall(grid, x1, y, z2, Math.min(x1 + 4, x2), 3);

  // Side table with lamp near couch
  sideTable(grid, x2, y, z1 + 3, style, 'minecraft:candle[candles=3,lit=true]');

  // Storage corner (opposite side from bookshelves)
  if (rw >= 8) storageCorner(grid, x2, y, z2, style, 'west');

  // Wall shelf with decorations
  wallShelf(grid, x1 + 2, y + 2, z1, 'south', ['minecraft:potted_fern']);
  wallShelf(grid, x2 - 1, y + 2, z1, 'south', ['minecraft:potted_allium']);

  // Flower pots in corners
  grid.set(x1, y, z1, 'minecraft:potted_fern');
  grid.set(x2, y, z1, 'minecraft:potted_allium');
  grid.set(x1, y, z2, 'minecraft:potted_blue_orchid');

  // Banners
  grid.set(x1 + 2, y + 3, z1, style.bannerS);
  grid.set(x2 - 2, y + 3, z1, style.bannerS);
  if (rw >= 8) grid.set(cx, y + 3, z2, style.bannerN);

  // Chandelier
  chandelier(grid, cx, y + height - 1, z1 + 3, style, 2);
}

function generateDiningRoom(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const rw = x2 - x1;

  // Long dining table (longer)
  longDiningTable(grid, cx, y, z1 + 2, Math.min(8, z2 - z1 - 2), style);

  // Head chair at end
  grid.set(cx, y, z2 - 1, style.chairN);

  // Sideboard / buffet along side wall
  for (let z = z1; z <= z1 + 3 && z < z2; z++) {
    grid.set(x1, y, z, 'minecraft:polished_andesite');
    grid.set(x1, y + 1, z, 'minecraft:smooth_stone_slab[type=bottom]');
  }
  grid.set(x1, y + 2, z1, 'minecraft:candle[candles=3,lit=true]');
  grid.set(x1, y + 2, z1 + 2, 'minecraft:potted_red_tulip');

  // Wine storage (barrels) on opposite wall
  grid.addBarrel(x2, y, z1, 'up', [
    { slot: 0, id: 'minecraft:potion', count: 4 },
  ]);
  grid.addBarrel(x2, y + 1, z1, 'up', []);
  grid.addBarrel(x2, y, z1 + 1, 'up', []);

  // Banners on walls
  grid.set(cx - 2, y + 3, z2, style.bannerN);
  grid.set(cx + 2, y + 3, z2, style.bannerN);
  if (rw >= 8) {
    grid.set(cx, y + 3, z1, style.bannerS);
  }

  // Chandeliers (multiple for grand feel)
  chandelier(grid, cx, y + height - 1, z1 + 3, style, 2);
  chandelier(grid, cx, y + height - 1, z2 - 2, style, 2);

  // Carpet runner under table with border
  rugWithBorder(grid, cx - 2, y, z1 + 1, cx + 2, z2 - 1, style.carpet, style.carpetAccent);
}

function generateKitchen(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const rw = x2 - x1;
  const cx = Math.floor((x1 + x2) / 2);

  // Full counter along back wall
  for (let x = x1; x <= x2; x++) {
    grid.set(x, y, z2, 'minecraft:polished_andesite');
    grid.set(x, y + 1, z2, 'minecraft:smooth_stone_slab[type=bottom]');
  }
  // Cooking stations
  grid.set(x1, y, z2, 'minecraft:furnace[facing=north,lit=false]');
  grid.set(x1 + 1, y, z2, 'minecraft:smoker[facing=north,lit=false]');
  grid.set(x1 + 2, y, z2, 'minecraft:blast_furnace[facing=north,lit=false]');
  grid.set(x1 + 3, y, z2, 'minecraft:crafting_table');
  // Sink
  grid.set(x2, y, z2, 'minecraft:water_cauldron[level=3]');
  grid.set(x2 - 1, y, z2, 'minecraft:water_cauldron[level=3]');

  // Counter along side wall
  for (let z = z1; z <= z1 + 3 && z < z2; z++) {
    grid.set(x2, y, z, 'minecraft:polished_andesite');
    grid.set(x2, y + 1, z, 'minecraft:smooth_stone_slab[type=bottom]');
  }
  // Hanging pots above counter (use chains and iron trapdoors)
  grid.set(x1, y + 3, z2, 'minecraft:chain');
  grid.set(x1 + 1, y + 3, z2, 'minecraft:chain');
  grid.set(x1 + 2, y + 3, z2, 'minecraft:chain');

  // Kitchen island table (centered)
  tableAndChairs(grid, cx, y, z1 + 3, style, 'nsew');

  // Pantry storage (barrels + chest)
  grid.addChest(x1, y, z1, 'south', [
    { slot: 0, id: 'minecraft:bread', count: 64 },
    { slot: 1, id: 'minecraft:cooked_beef', count: 64 },
    { slot: 2, id: 'minecraft:golden_apple', count: 16 },
    { slot: 3, id: 'minecraft:cookie', count: 64 },
  ]);
  grid.addBarrel(x1 + 1, y, z1, 'up', [
    { slot: 0, id: 'minecraft:apple', count: 32 },
    { slot: 1, id: 'minecraft:wheat', count: 64 },
  ]);
  grid.addBarrel(x1 + 1, y + 1, z1, 'up', []);

  // Flower pot on counter
  if (rw >= 6) grid.set(cx, y + 2, z2, 'minecraft:potted_red_tulip');

  // Checkerboard accent floor
  for (let x = x1 + 2; x <= x2 - 2; x++) {
    for (let z = z1 + 2; z <= z2 - 2; z++) {
      if ((x + z) % 2 === 0) {
        grid.set(x, y - 1, z, 'minecraft:polished_andesite');
      }
    }
  }

  // Ceiling lights
  chandelier(grid, cx, y + height - 1, z1 + 3, style, 1);
  if (rw >= 8) chandelier(grid, cx, y + height - 1, z2 - 2, style, 1);
}

function generateFoyer(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);

  // Grand carpet runner with border (full depth)
  rugWithBorder(grid, cx - 2, y, z1, cx + 2, z2, style.carpet, style.carpetAccent);

  // Decorative pillars at entrance
  for (const px of [x1, x2]) {
    for (const pz of [z1, z2]) {
      grid.set(px, y, pz, style.pillar);
      grid.set(px, y + 1, pz, style.pillar);
      grid.set(px, y + 2, pz, style.pillar);
      grid.set(px, y + 3, pz, 'minecraft:end_rod[facing=up]');
    }
  }

  // Bell
  grid.set(cx, y, z1 + 1, 'minecraft:bell[attachment=floor,facing=north]');

  // Console tables on both sides
  sideTable(grid, x2 - 1, y, z1 + 3, style, 'minecraft:candle[candles=3,lit=true]');
  sideTable(grid, x1 + 1, y, z1 + 3, style, 'minecraft:potted_red_tulip');
  sideTable(grid, x2 - 1, y, z2 - 2, style, 'minecraft:potted_azure_bluet');
  sideTable(grid, x1 + 1, y, z2 - 2, style, 'minecraft:potted_lily_of_the_valley');

  // Wall banners (both sides)
  grid.set(x1 + 2, y + 3, z1, style.bannerS);
  grid.set(x2 - 2, y + 3, z1, style.bannerS);
  grid.set(cx, y + 3, z2, style.bannerN);

  // Armor display if room is large enough
  if (x2 - x1 >= 8) {
    armorDisplay(grid, x1 + 1, y, z1 + 1);
    armorDisplay(grid, x2 - 1, y, z1 + 1);
  }

  // Chandelier
  chandelier(grid, cx, y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
}

function generateBedroom(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const rw = x2 - x1;

  // Bed against wall with headboard
  placeBed(grid, x1 + 3, y, z1 + 1, 'south');
  // Headboard wall decoration
  grid.set(x1 + 3, y + 2, z1, style.bannerS);

  // Nightstands on both sides of bed
  grid.addBarrel(x1 + 2, y, z1 + 1, 'up', [
    { slot: 0, id: 'minecraft:book', count: 1 },
    { slot: 1, id: 'minecraft:clock', count: 1 },
  ]);
  grid.set(x1 + 2, y + 1, z1 + 1, 'minecraft:candle[candles=1,lit=true]');
  if (rw >= 6) {
    grid.addBarrel(x1 + 4, y, z1 + 1, 'up', []);
    grid.set(x1 + 4, y + 1, z1 + 1, 'minecraft:potted_azure_bluet');
  }

  // Second bed if room is wide enough
  if (rw >= 10) {
    placeBed(grid, x2 - 3, y, z1 + 1, 'south');
    grid.set(x2 - 3, y + 2, z1, style.bannerS);
  }

  // Wardrobe (double chest)
  grid.addChest(x1, y, z2 - 1, 'east', [
    { slot: 0, id: 'minecraft:diamond_chestplate', count: 1 },
    { slot: 1, id: 'minecraft:elytra', count: 1 },
    { slot: 2, id: 'minecraft:golden_apple', count: 8 },
  ]);
  grid.addChest(x1, y, z2, 'east', [
    { slot: 0, id: 'minecraft:leather_chestplate', count: 1 },
    { slot: 1, id: 'minecraft:leather_leggings', count: 1 },
  ]);

  // Vanity / desk area
  grid.set(x2, y, z1, 'minecraft:crafting_table');
  grid.set(x2, y + 1, z1, 'minecraft:potted_azure_bluet');
  grid.set(x2 - 1, y, z1, style.chairW);
  // Mirror above vanity
  grid.set(x2, y + 2, z1, 'minecraft:glass_pane');

  // Bookshelf accent
  grid.set(x2, y, z2, 'minecraft:bookshelf');
  grid.set(x2, y + 1, z2, 'minecraft:bookshelf');

  // Area rug with border
  rugWithBorder(grid, x1 + 1, y, z1 + 3, x2 - 1, z2 - 1, 'minecraft:blue_carpet', 'minecraft:light_blue_carpet');

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

  // Lighting — two fixtures for even coverage
  chandelier(grid, Math.floor((x1 + x2) / 2), y + height - 1, z1 + 2, style, 1);
  lightFixture(grid, x2, y + height - 1, z2, 1, 'lantern');

  // Potted plant in corner
  grid.set(x2, y, z2, 'minecraft:potted_fern');
}

function generateStudy(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
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

  // Desk area along back wall
  grid.set(x1, y, z1, 'minecraft:crafting_table');
  grid.set(x1 + 1, y, z1, 'minecraft:cartography_table');
  grid.set(x1, y + 1, z1, 'minecraft:candle[candles=3,lit=true]');
  grid.set(x1 + 2, y, z1, style.chairS);

  // Brewing corner with storage
  grid.set(x2, y, z2, 'minecraft:brewing_stand');
  grid.set(x2 - 1, y, z2, 'minecraft:water_cauldron[level=3]');
  grid.addBarrel(x2, y, z2 - 1, 'up', [
    { slot: 0, id: 'minecraft:blaze_powder', count: 8 },
    { slot: 1, id: 'minecraft:nether_wart', count: 16 },
  ]);

  // Lectern in corner
  grid.set(x2, y, z1, 'minecraft:lectern[facing=south]');

  // End rod accent lighting (corners)
  endRodPillar(grid, cx - 2, y, cz - 2, 3);
  endRodPillar(grid, cx + 2, y, cz - 2, 3);
  endRodPillar(grid, cx - 2, y, cz + 2, 3);
  endRodPillar(grid, cx + 2, y, cz + 2, 3);

  // Carpet with border
  rugWithBorder(grid, cx - 1, y, cz - 1, cx + 1, cz + 1, 'minecraft:purple_carpet', 'minecraft:magenta_carpet');

  // Wall banner
  grid.set(cx, y + 3, z1, style.bannerS);

  // Chandelier
  chandelier(grid, cx, y + height - 1, cz, style, 2);
}

function generateLibrary(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const cz = Math.floor((z1 + z2) / 2);
  const rw = x2 - x1;

  // Bookshelves lining all walls (3 rows high)
  bookshelfWall(grid, x1, y, z1, x2, 3);
  bookshelfWall(grid, x1, y, z2, x2, 3);
  for (let r = 0; r < 3; r++) {
    for (let z = z1; z <= z2; z++) {
      grid.set(x1, y + r, z, 'minecraft:bookshelf');
      grid.set(x2, y + r, z, 'minecraft:bookshelf');
    }
  }

  // Reading table (centered)
  tableAndChairs(grid, cx, y, cz, style, 'nsew');

  // Second reading nook if room is large
  if (rw >= 8) {
    tableAndChairs(grid, cx - 3, y, cz + 2, style, 'ns');
  }

  // Lecterns
  grid.set(cx + 2, y, z1 + 2, 'minecraft:lectern[facing=south]');
  grid.set(cx - 2, y, z2 - 2, 'minecraft:lectern[facing=north]');

  // Map/globe display
  grid.set(cx, y, z1 + 2, 'minecraft:cartography_table');

  // Reading lamps (end rod pillars)
  endRodPillar(grid, x1 + 2, y, cz, 3);
  endRodPillar(grid, x2 - 2, y, cz, 3);

  // Large carpet
  rugWithBorder(grid, x1 + 2, y, z1 + 1, x2 - 2, z2 - 1, style.carpet, style.carpetAccent);

  // Chandeliers (multiple)
  chandelier(grid, cx, y + height - 1, z1 + 3, style, 2);
  chandelier(grid, cx, y + height - 1, z2 - 3, style, 2);
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
  const cx = Math.floor((x1 + x2) / 2);
  const rw = x2 - x1;

  // Smithing stations along back wall
  grid.set(x2, y, z2, 'minecraft:smithing_table');
  grid.set(x2 - 1, y, z2, 'minecraft:grindstone[face=floor,facing=north]');
  grid.set(x2 - 2, y, z2, 'minecraft:anvil[facing=north]');
  grid.set(x2 - 3, y, z2, 'minecraft:stonecutter[facing=north]');

  // Weapon rack along side wall
  grid.addChest(x1, y, z1, 'east', [
    { slot: 0, id: 'minecraft:iron_sword', count: 1 },
    { slot: 1, id: 'minecraft:iron_axe', count: 1 },
    { slot: 2, id: 'minecraft:shield', count: 2 },
    { slot: 3, id: 'minecraft:crossbow', count: 1 },
    { slot: 4, id: 'minecraft:arrow', count: 64 },
  ]);
  grid.addChest(x1, y, z1 + 1, 'east', [
    { slot: 0, id: 'minecraft:iron_helmet', count: 2 },
    { slot: 1, id: 'minecraft:iron_chestplate', count: 2 },
    { slot: 2, id: 'minecraft:iron_leggings', count: 2 },
    { slot: 3, id: 'minecraft:iron_boots', count: 2 },
  ]);

  // Armor stands along wall
  armorDisplay(grid, x1, y, z2 - 1);
  armorDisplay(grid, x1, y, z2 - 3);
  if (rw >= 8) armorDisplay(grid, x1, y, z2 - 5);

  // Training targets (two targets)
  grid.set(x2 - 1, y, z1 + 3, 'minecraft:hay_block');
  grid.set(x2 - 1, y + 1, z1 + 3, 'minecraft:target');
  if (rw >= 8) {
    grid.set(x2 - 1, y, z1 + 5, 'minecraft:hay_block');
    grid.set(x2 - 1, y + 1, z1 + 5, 'minecraft:target');
  }

  // Weapon racks (wall shelves with items)
  wallShelf(grid, x1 + 2, y + 2, z1, 'south', ['minecraft:chain']);
  wallShelf(grid, x1 + 4, y + 2, z1, 'south', ['minecraft:chain']);

  // Banners
  grid.set(cx, y + 3, z1, style.bannerS);
  grid.set(cx, y + 3, z2, style.bannerN);

  // Carpet with border
  rugWithBorder(grid, x1 + 1, y, z1 + 2, x2 - 2, z2 - 2, 'minecraft:black_carpet', 'minecraft:red_carpet');

  // Potted plant near entrance
  grid.set(x1 + 1, y, z1, 'minecraft:potted_fern');

  // Chandelier + secondary light
  chandelier(grid, cx, y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
  lightFixture(grid, x2 - 1, y + height - 1, z1 + 1, 1, 'lantern');
}

function generateObservatory(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
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

  // Wall banner and shelf for decoration
  grid.set(cx, y + 3, z1, style.bannerS);
  wallShelf(grid, x2 - 1, y + 2, z2, 'north', ['minecraft:potted_allium']);
}

function generateLab(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const cz = Math.floor((z1 + z2) / 2);

  // Brewing station (expanded)
  grid.set(x2, y, z1, 'minecraft:brewing_stand');
  grid.set(x2 - 1, y, z1, 'minecraft:brewing_stand');
  grid.set(x2, y, z1 + 1, 'minecraft:water_cauldron[level=3]');
  grid.set(x2 - 1, y, z1 + 1, 'minecraft:water_cauldron[level=3]');
  // Reagent shelves above
  wallShelf(grid, x2, y + 2, z1, 'south', ['minecraft:chain']);
  wallShelf(grid, x2 - 1, y + 2, z1, 'south', ['minecraft:chain']);

  // Workbench area
  grid.set(x1, y, z1, 'minecraft:crafting_table');
  grid.set(x1 + 1, y, z1, 'minecraft:cartography_table');
  grid.set(x1 + 2, y, z1, style.chairS);

  // Experiment table (center)
  grid.set(cx, y, cz, style.fence);
  grid.set(cx, y + 1, cz, 'minecraft:white_carpet');
  grid.set(cx, y + 2, cz, 'minecraft:candle[candles=1,lit=true]');

  // Cauldron array
  grid.set(x1, y, z2, 'minecraft:water_cauldron[level=3]');
  grid.set(x1, y, z2 - 1, 'minecraft:water_cauldron[level=3]');

  // Bookshelves for reference (taller)
  bookshelfWall(grid, x1 + 2, y, z2, x2 - 1, 3);

  // Supply storage
  grid.addChest(x2, y, z2, 'north', [
    { slot: 0, id: 'minecraft:blaze_powder', count: 16 },
    { slot: 1, id: 'minecraft:nether_wart', count: 32 },
    { slot: 2, id: 'minecraft:ghast_tear', count: 4 },
    { slot: 3, id: 'minecraft:glowstone_dust', count: 32 },
  ]);
  grid.addBarrel(x2, y, z2 - 1, 'up', [
    { slot: 0, id: 'minecraft:redstone', count: 64 },
    { slot: 1, id: 'minecraft:gunpowder', count: 32 },
  ]);

  // End rod lighting (pillars in corners)
  endRodPillar(grid, x1 + 2, y, z1 + 2, 3);
  endRodPillar(grid, x2 - 2, y, z2 - 2, 3);

  // Purple carpet accent
  carpetArea(grid, cx - 1, y, cz - 1, cx + 1, cz + 1, 'minecraft:purple_carpet');

  // Potted plant in open corner
  grid.set(x1, y, z1 + 2, 'minecraft:potted_warped_fungus');

  // Extra light near workbench
  lightFixture(grid, x1 + 1, y + height - 1, z1 + 1, 1, 'lantern');

  // Chandelier
  chandelier(grid, cx, y + height - 1, cz, style, 1);
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
  const rw = x2 - x1;

  // Raised dais for throne (2 levels)
  grid.fill(cx - 2, y, z2 - 3, cx + 2, y, z2 - 1, style.floorGround);
  grid.fill(cx - 1, y + 1, z2 - 2, cx + 1, y + 1, z2 - 1, style.floorGround);
  // Throne chair on dais
  grid.set(cx, y + 2, z2 - 2, style.chairN);
  // Armrests
  grid.set(cx - 1, y + 1, z2 - 2, style.slabBottom);
  grid.set(cx + 1, y + 1, z2 - 2, style.slabBottom);

  // Red carpet runner to throne (wider)
  for (let z = z1; z <= z2 - 4; z++) {
    grid.set(cx - 1, y, z, style.carpet);
    grid.set(cx, y, z, style.carpet);
    grid.set(cx + 1, y, z, style.carpet);
  }

  // Pillars flanking throne and along aisle
  for (let py = y; py < y + height; py++) {
    grid.set(cx - 3, py, z2 - 1, style.pillar);
    grid.set(cx + 3, py, z2 - 1, style.pillar);
  }
  // Additional pillars along aisle
  if (rw >= 8) {
    for (let py = y; py < y + height; py++) {
      grid.set(x1 + 1, py, z1 + 2, style.pillar);
      grid.set(x2 - 1, py, z1 + 2, style.pillar);
      grid.set(x1 + 1, py, z2 - 4, style.pillar);
      grid.set(x2 - 1, py, z2 - 4, style.pillar);
    }
  }

  // Banners flanking throne and along walls
  grid.set(cx - 2, y + 3, z2, style.bannerN);
  grid.set(cx + 2, y + 3, z2, style.bannerN);
  grid.set(x1 + 1, y + 3, z1, style.bannerS);
  grid.set(x2 - 1, y + 3, z1, style.bannerS);

  // Gold block accents near throne
  grid.set(cx - 2, y, z2 - 1, 'minecraft:gold_block');
  grid.set(cx + 2, y, z2 - 1, 'minecraft:gold_block');

  // Torches on pillars
  grid.set(cx - 2, y + 2, z2 - 1, style.torchN);
  grid.set(cx + 2, y + 2, z2 - 1, style.torchN);

  // Grand chandelier
  chandelier(grid, cx, y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
  if (rw >= 8) {
    chandelier(grid, cx - 3, y + height - 1, z1 + 3, style, 1);
    chandelier(grid, cx + 3, y + height - 1, z1 + 3, style, 1);
  }
}

function generateForge(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);

  // Forge stations along back wall
  grid.set(x1, y, z2, 'minecraft:blast_furnace[facing=north,lit=true]');
  grid.set(x1 + 1, y, z2, 'minecraft:blast_furnace[facing=north,lit=true]');
  grid.set(x1 + 2, y, z2, 'minecraft:smithing_table');
  grid.set(x1 + 3, y, z2, 'minecraft:anvil[facing=north]');
  grid.set(x1 + 4, y, z2, 'minecraft:grindstone[face=floor,facing=north]');

  // Lava pit (campfires for glow)
  grid.set(x2, y, z2, 'minecraft:campfire[lit=true]');
  grid.set(x2, y, z2 - 1, 'minecraft:campfire[lit=true]');

  // Water quench trough
  grid.set(x2 - 1, y, z2, 'minecraft:water_cauldron[level=3]');
  grid.set(x2 - 2, y, z2, 'minecraft:water_cauldron[level=3]');

  // Tool/material storage (barrels + chests)
  grid.addChest(x2, y, z1, 'west', [
    { slot: 0, id: 'minecraft:iron_ingot', count: 64 },
    { slot: 1, id: 'minecraft:gold_ingot', count: 32 },
    { slot: 2, id: 'minecraft:diamond', count: 16 },
    { slot: 3, id: 'minecraft:coal', count: 64 },
  ]);
  grid.addBarrel(x2, y, z1 + 1, 'up', [
    { slot: 0, id: 'minecraft:iron_ingot', count: 64 },
  ]);
  grid.addBarrel(x2, y + 1, z1, 'up', []);

  // Fuel storage
  grid.addBarrel(x1, y, z1, 'up', [
    { slot: 0, id: 'minecraft:coal', count: 64 },
    { slot: 1, id: 'minecraft:charcoal', count: 64 },
  ]);
  grid.addBarrel(x1, y + 1, z1, 'up', []);

  // Work table (center)
  grid.set(cx, y, Math.floor((z1 + z2) / 2), 'minecraft:crafting_table');
  grid.set(cx + 1, y, Math.floor((z1 + z2) / 2), style.chairW);

  // Stone floor for heat resistance
  grid.fill(x1, y - 1, z2 - 2, x2, y - 1, z2, 'minecraft:polished_blackstone');

  // Carpet near entrance for warmth
  carpetArea(grid, cx - 1, y, z1 + 1, cx + 1, z1 + 2, style.carpet);

  // Banner on front wall
  grid.set(cx, y + 3, z1, style.bannerS);

  // Chandelier
  chandelier(grid, cx, y + height - 1, Math.floor((z1 + z2) / 2), style, 1);
}

function generateGreenhouse(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const cz = Math.floor((z1 + z2) / 2);

  // Composters
  grid.set(x1, y, z1, 'minecraft:composter');
  grid.set(x1 + 1, y, z1, 'minecraft:composter');

  // Flower pots along ALL walls (dense)
  const flowers = [
    'minecraft:potted_red_tulip', 'minecraft:potted_azure_bluet',
    'minecraft:potted_allium', 'minecraft:potted_blue_orchid',
    'minecraft:potted_lily_of_the_valley', 'minecraft:potted_fern',
    'minecraft:potted_cactus', 'minecraft:potted_oak_sapling',
    'minecraft:potted_crimson_fungus', 'minecraft:potted_warped_fungus',
  ];
  let fi = 0;
  // Back wall
  for (let x = x1; x <= x2; x += 2) {
    grid.set(x, y, z2, flowers[fi++ % flowers.length]);
  }
  // Front wall
  for (let x = x1 + 2; x <= x2; x += 2) {
    grid.set(x, y, z1, flowers[fi++ % flowers.length]);
  }
  // Left wall
  for (let z = z1; z <= z2; z += 2) {
    grid.set(x1, y, z, flowers[fi++ % flowers.length]);
  }
  // Right wall
  for (let z = z1 + 2; z <= z2; z += 2) {
    grid.set(x2, y, z, flowers[fi++ % flowers.length]);
  }

  // Central planter (raised bed)
  grid.fill(cx - 1, y, cz - 1, cx + 1, y, cz + 1, 'minecraft:grass_block');
  grid.set(cx, y + 1, cz, 'minecraft:potted_oak_sapling');
  grid.set(cx - 1, y + 1, cz, 'minecraft:potted_fern');
  grid.set(cx + 1, y + 1, cz, 'minecraft:potted_blue_orchid');

  // Water sources (two cauldrons)
  grid.set(cx - 2, y, cz, 'minecraft:water_cauldron[level=3]');
  grid.set(cx + 2, y, cz, 'minecraft:water_cauldron[level=3]');

  // Path around planter
  carpetArea(grid, cx - 2, y, cz - 2, cx + 2, cz + 2, 'minecraft:green_carpet');
  // Re-place planter over carpet
  grid.fill(cx - 1, y, cz - 1, cx + 1, y, cz + 1, 'minecraft:grass_block');

  // Grow lights (glowstone in ceiling)
  grid.set(cx - 2, y + height - 1, cz - 2, 'minecraft:glowstone');
  grid.set(cx + 2, y + height - 1, cz + 2, 'minecraft:glowstone');
  grid.set(cx, y + height - 1, cz, 'minecraft:glowstone');

  // Additional potted plants in corners
  grid.set(x1 + 1, y, z1 + 1, 'minecraft:potted_bamboo');
  grid.set(x2 - 1, y, z1 + 1, 'minecraft:potted_dead_bush');
  grid.set(x1 + 1, y, z2 - 1, 'minecraft:potted_birch_sapling');
  grid.set(x2 - 1, y, z2 - 1, 'minecraft:potted_crimson_fungus');

  // Hanging vines (chains + lanterns)
  chandelier(grid, cx - 2, y + height - 1, cz, style, 2);
  chandelier(grid, cx + 2, y + height - 1, cz, style, 2);
}

// ─── New Room Types (v0.2.0) ────────────────────────────────────────────────

function generateCaptainsQuarters(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const rw = x2 - x1;

  // Captain's bed against back wall
  placeBed(grid, x1 + 2, y, z1 + 1, 'south', 'red');
  grid.set(x1 + 2, y + 2, z1, style.bannerS);

  // Nightstand
  grid.addBarrel(x1 + 1, y, z1 + 1, 'up', [
    { slot: 0, id: 'minecraft:compass', count: 1 },
    { slot: 1, id: 'minecraft:clock', count: 1 },
  ]);
  grid.set(x1 + 1, y + 1, z1 + 1, 'minecraft:candle[candles=1,lit=true]');

  // Navigation desk with maps
  mapTable(grid, x2, y, z1, style);
  grid.set(x2 - 1, y, z1, style.chairW);

  // Telescope by window
  telescope(grid, x2, y, z2 - 1, 3);

  // Plate set on desk area (dining surface)
  if (rw >= 6) {
    grid.set(cx, y, z1 + 3, style.fence);
    grid.set(cx, y + 1, z1 + 3, style.carpet);
    plateSet(grid, cx - 1, y + 2, z1 + 3, 3, 'x');
  }

  // Wardrobe / treasure chest
  grid.addChest(x1, y, z2, 'east', [
    { slot: 0, id: 'minecraft:map', count: 3 },
    { slot: 1, id: 'minecraft:spyglass', count: 1 },
    { slot: 2, id: 'minecraft:gold_ingot', count: 32 },
  ]);

  // Bookshelf accent
  grid.set(x2, y, z2, 'minecraft:bookshelf');
  grid.set(x2, y + 1, z2, 'minecraft:bookshelf');

  // Rug
  rugWithBorder(grid, x1 + 1, y, z1 + 3, x2 - 1, z2 - 1, 'minecraft:red_carpet', 'minecraft:yellow_carpet');

  // Chandelier
  chandelier(grid, cx, y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
}

function generateCell(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);

  // Iron bar front wall (replace doorway side)
  for (let x = x1; x <= x2; x++) {
    for (let vy = y; vy < y + height - 1; vy++) {
      grid.set(x, vy, z1, 'minecraft:iron_bars');
    }
  }
  // Gap for "door"
  grid.set(cx, y, z1, 'minecraft:air');
  grid.set(cx, y + 1, z1, 'minecraft:air');

  // Single cot against wall
  placeBed(grid, x1 + 1, y, z2 - 1, 'north', 'cyan');

  // Bone block atmosphere
  grid.set(x2, y, z2, 'minecraft:bone_block');
  grid.set(x2, y + 1, z2, 'minecraft:skeleton_skull');

  // Chain from ceiling
  for (let vy = y + 1; vy < y + height; vy++) {
    grid.set(x1, vy, z1 + 2, 'minecraft:chain');
  }

  // Single torch for dim lighting
  grid.set(cx, y + 2, z2, style.torchN);

  // Floor lantern for additional dim light
  grid.set(x1, y, z2 - 1, style.lanternFloor);

  // Cobweb decoration in upper corner
  if (grid.inBounds(x2, y + height - 1, z2))
    grid.set(x2, y + height - 1, z2, 'minecraft:cobweb');

  // Cracked floor patches
  grid.set(cx, y - 1, Math.floor((z1 + z2) / 2), 'minecraft:cracked_stone_bricks');
  grid.set(cx + 1, y - 1, Math.floor((z1 + z2) / 2) + 1, 'minecraft:cracked_stone_bricks');
}

function generateNave(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const rw = x2 - x1;
  const rl = z2 - z1;

  // Pew rows (stairs facing altar/back wall)
  const pewStart = z1 + 2;
  const pewEnd = z2 - 4;
  for (let z = pewStart; z <= pewEnd; z += 2) {
    // Left pew row
    for (let x = x1 + 1; x <= cx - 2; x++) {
      grid.set(x, y, z, style.chairN);
    }
    // Right pew row
    for (let x = cx + 2; x <= x2 - 1; x++) {
      grid.set(x, y, z, style.chairN);
    }
  }

  // Central aisle carpet
  for (let z = z1; z <= z2; z++) {
    grid.set(cx, y, z, style.carpet);
    if (rw >= 8) {
      grid.set(cx - 1, y, z, style.carpet);
      grid.set(cx + 1, y, z, style.carpet);
    }
  }

  // Altar platform at back
  grid.fill(cx - 2, y, z2 - 2, cx + 2, y, z2 - 1, style.wallAccent);
  grid.fill(cx - 1, y + 1, z2 - 2, cx + 1, y + 1, z2 - 1, style.wallAccent);
  // Altar table
  grid.set(cx, y + 2, z2 - 2, 'minecraft:enchanting_table');

  // Candle arrays flanking altar
  grid.set(cx - 2, y + 1, z2 - 1, 'minecraft:candle[candles=4,lit=true]');
  grid.set(cx + 2, y + 1, z2 - 1, 'minecraft:candle[candles=4,lit=true]');

  // Stained glass windows along walls
  for (let z = z1 + 3; z < z2 - 2; z += 3) {
    grid.set(x1, y + 2, z, style.windowAccent);
    grid.set(x1, y + 3, z, style.windowAccent);
    grid.set(x2, y + 2, z, style.windowAccent);
    grid.set(x2, y + 3, z, style.windowAccent);
  }

  // Pillar rows along aisles
  for (let z = z1 + 2; z < z2 - 2; z += 4) {
    for (let py = y; py < y + height; py++) {
      if (rw >= 8) {
        grid.set(cx - 2, py, z, style.pillar);
        grid.set(cx + 2, py, z, style.pillar);
      }
    }
  }

  // Banners
  grid.set(cx - 1, y + 3, z2, style.bannerN);
  grid.set(cx + 1, y + 3, z2, style.bannerN);

  // Light fixtures along nave — chain + lantern
  if (rl >= 10) {
    lightFixture(grid, cx - 3, y + height - 1, z1 + 4, 2, 'lantern');
    lightFixture(grid, cx + 3, y + height - 1, z1 + 4, 2, 'lantern');
    lightFixture(grid, cx - 3, y + height - 1, z2 - 5, 2, 'lantern');
    lightFixture(grid, cx + 3, y + height - 1, z2 - 5, 2, 'lantern');
  }
  chandelier(grid, cx, y + height - 1, Math.floor((z1 + z2) / 2), style, 2);
}

function generateBelfry(grid: BlockGrid, b: RoomBounds, style: StylePalette): void {
  const { x1, y, z1, x2, z2, height } = b;
  const cx = Math.floor((x1 + x2) / 2);
  const cz = Math.floor((z1 + z2) / 2);

  // Central bell
  grid.set(cx, y + 1, cz, 'minecraft:bell[attachment=ceiling,facing=north]');
  // Chain suspending bell
  for (let vy = y + 2; vy < y + height; vy++) {
    grid.set(cx, vy, cz, 'minecraft:chain');
  }

  // Open arched windows on all sides (clear walls and place window accents)
  for (let x = x1 + 1; x <= x2 - 1; x++) {
    for (let vy = y + 1; vy < y + height - 1; vy++) {
      grid.set(x, vy, z1, 'minecraft:air');
      grid.set(x, vy, z2, 'minecraft:air');
    }
    // Arch tops
    grid.set(x, y + height - 1, z1, style.wallAccent);
    grid.set(x, y + height - 1, z2, style.wallAccent);
  }
  for (let z = z1 + 1; z <= z2 - 1; z++) {
    for (let vy = y + 1; vy < y + height - 1; vy++) {
      grid.set(x1, vy, z, 'minecraft:air');
      grid.set(x2, vy, z, 'minecraft:air');
    }
    grid.set(x1, y + height - 1, z, style.wallAccent);
    grid.set(x2, y + height - 1, z, style.wallAccent);
  }

  // Restore corner pillars
  for (const [px, pz] of [[x1, z1], [x1, z2], [x2, z1], [x2, z2]] as [number, number][]) {
    for (let vy = y; vy < y + height; vy++) {
      grid.set(px, vy, pz, style.pillar);
    }
  }

  // Low fence railing at openings
  for (let x = x1 + 1; x <= x2 - 1; x++) {
    grid.set(x, y + 1, z1, style.fence);
    grid.set(x, y + 1, z2, style.fence);
  }
  for (let z = z1 + 1; z <= z2 - 1; z++) {
    grid.set(x1, y + 1, z, style.fence);
    grid.set(x2, y + 1, z, style.fence);
  }

  // Floor (stone)
  grid.fill(x1 + 1, y - 1, z1 + 1, x2 - 1, y - 1, z2 - 1, style.floorGround);
}
