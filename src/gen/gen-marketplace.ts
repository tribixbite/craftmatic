/**
 * Marketplace structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType } from '../types/index.js';
import { placeTree } from './structures.js';
import { type StylePalette } from './styles.js';

// ─── Marketplace ─────────────────────────────────────────────────────────────

export function generateMarketplace(
  _floors: number, style: StylePalette, _rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, _rng: () => number
): BlockGrid {
  const bw = bwOpt ?? 25;
  const bl = blOpt ?? 20;
  const margin = 3;
  const gw = bw + margin * 2;
  const gl = bl + margin * 2;
  const gh = 12;

  const bx1 = margin;
  const bx2 = margin + bw - 1;
  const bz1 = margin;
  const bz2 = margin + bl - 1;
  const xMid = margin + Math.floor(bw / 2);
  const zMid = margin + Math.floor(bl / 2);

  const grid = new BlockGrid(gw, gh, gl);

  // Ground floor
  grid.fill(bx1, 0, bz1, bx2, 0, bz2, style.floorGround);

  // Perimeter low wall with fence posts
  for (let x = bx1; x <= bx2; x++) {
    grid.set(x, 1, bz1, style.wall);
    grid.set(x, 1, bz2, style.wall);
  }
  for (let z = bz1; z <= bz2; z++) {
    grid.set(bx1, 1, z, style.wall);
    grid.set(bx2, 1, z, style.wall);
  }
  // Fence on top of low wall
  for (let x = bx1; x <= bx2; x += 2) {
    grid.set(x, 2, bz1, style.fence);
    grid.set(x, 2, bz2, style.fence);
  }
  for (let z = bz1; z <= bz2; z += 2) {
    grid.set(bx1, 2, z, style.fence);
    grid.set(bx2, 2, z, style.fence);
  }

  // Gates (openings at mid-points)
  for (let dy = 1; dy <= 2; dy++) {
    grid.set(xMid, dy, bz1, 'minecraft:air');
    grid.set(xMid - 1, dy, bz1, 'minecraft:air');
    grid.set(xMid, dy, bz2, 'minecraft:air');
    grid.set(xMid - 1, dy, bz2, 'minecraft:air');
  }

  // Covered central walkway (E-W through middle)
  for (let x = bx1 + 2; x <= bx2 - 2; x++) {
    grid.set(x, 0, zMid, 'minecraft:polished_deepslate');
    // Roof over walkway
    grid.set(x, 4, zMid - 1, style.slabBottom);
    grid.set(x, 4, zMid, style.slabBottom);
    grid.set(x, 4, zMid + 1, style.slabBottom);
  }
  // Walkway support columns
  for (let x = bx1 + 3; x <= bx2 - 3; x += 4) {
    for (let y = 1; y <= 3; y++) {
      grid.set(x, y, zMid - 1, style.fence);
      grid.set(x, y, zMid + 1, style.fence);
    }
  }

  // Stall grid — 2 rows, north and south of walkway
  const stallItems = [
    'minecraft:apple', 'minecraft:bread', 'minecraft:emerald',
    'minecraft:iron_ingot', 'minecraft:book', 'minecraft:golden_apple',
    'minecraft:diamond', 'minecraft:potion',
  ];
  // Expanded stall goods — more workstation variety
  const stallGoods = [
    'minecraft:barrel', 'minecraft:crafting_table', 'minecraft:anvil', 'minecraft:cauldron',
    'minecraft:fletching_table', 'minecraft:loom', 'minecraft:composter', 'minecraft:smoker',
  ];
  // Flower pots for stall corner decoration
  const stallFlowers = [
    'minecraft:potted_poppy', 'minecraft:potted_dandelion', 'minecraft:potted_blue_orchid',
    'minecraft:potted_allium', 'minecraft:potted_cornflower', 'minecraft:potted_red_tulip',
  ];
  let stallIdx = 0;
  for (const stallRow of [bz1 + 3, bz2 - 3]) {
    for (let sx = bx1 + 3; sx <= bx2 - 5; sx += 6) {
      // Stall posts
      for (let y = 1; y <= 3; y++) {
        grid.set(sx, y, stallRow, style.fence);
        grid.set(sx + 3, y, stallRow, style.fence);
      }
      // Slab roof
      grid.fill(sx, 4, stallRow - 1, sx + 3, 4, stallRow + 1, style.slabBottom);

      // Awnings on alternating stalls — second-story slab extension with support
      if (stallIdx % 2 === 0) {
        const awningZ = stallRow < zMid ? stallRow - 2 : stallRow + 2;
        if (grid.inBounds(sx, 5, awningZ)) {
          grid.fill(sx, 5, Math.min(stallRow, awningZ), sx + 3, 5, Math.max(stallRow, awningZ), style.slabBottom);
          // Support posts for awning
          grid.set(sx, 4, awningZ, style.fence);
          grid.set(sx + 3, 4, awningZ, style.fence);
        }
      }

      // Counter / display table
      grid.set(sx + 1, 1, stallRow, style.fence);
      grid.set(sx + 1, 2, stallRow, style.carpet);
      grid.set(sx + 2, 1, stallRow, style.fence);
      grid.set(sx + 2, 2, stallRow, style.carpet);
      // Display items
      grid.addChest(sx + 1, 1, stallRow + 1, 'north', [
        { slot: 0, id: stallItems[stallIdx % stallItems.length], count: 32 },
      ]);
      // Varied stall goods on counter
      grid.set(sx + 1, 3, stallRow, stallGoods[stallIdx % stallGoods.length]);
      // Lantern
      grid.set(sx + 2, 3, stallRow, style.lantern);

      // Flower pots at stall corners
      if (grid.inBounds(sx, 1, stallRow - 1))
        grid.set(sx, 1, stallRow - 1, stallFlowers[stallIdx % stallFlowers.length]);
      if (grid.inBounds(sx + 3, 1, stallRow + 1))
        grid.set(sx + 3, 1, stallRow + 1, stallFlowers[(stallIdx + 1) % stallFlowers.length]);

      stallIdx++;
    }
  }

  // Seating benches — stair blocks along central walkway, every 6 blocks
  for (let x = bx1 + 4; x <= bx2 - 4; x += 6) {
    // North-facing bench on south side of walkway
    if (grid.inBounds(x, 1, zMid + 2))
      grid.set(x, 1, zMid + 2, 'minecraft:oak_stairs[facing=north]');
    // South-facing bench on north side of walkway
    if (grid.inBounds(x, 1, zMid - 2))
      grid.set(x, 1, zMid - 2, 'minecraft:oak_stairs[facing=south]');
  }

  // Well/fountain in center
  grid.fill(xMid - 1, 0, zMid - 1, xMid + 1, 0, zMid + 1, 'minecraft:stone_bricks');
  grid.set(xMid, 0, zMid, 'minecraft:water_cauldron[level=3]');
  for (const [wx, wz] of [[xMid - 1, zMid - 1], [xMid + 1, zMid - 1],
                            [xMid - 1, zMid + 1], [xMid + 1, zMid + 1]]) {
    grid.set(wx, 1, wz, style.fence);
    grid.set(wx, 2, wz, style.fence);
  }
  grid.fill(xMid - 1, 3, zMid - 1, xMid + 1, 3, zMid + 1, style.slabBottom);
  grid.set(xMid, 2, zMid, 'minecraft:chain');
  grid.set(xMid, 1, zMid, style.lanternFloor);

  // Path from gates to center
  for (let z = bz1 + 1; z <= bz2 - 1; z++) {
    grid.set(xMid, 0, z, 'minecraft:polished_deepslate');
  }

  // Corner lanterns
  grid.set(bx1 + 1, 1, bz1 + 1, style.lanternFloor);
  grid.set(bx2 - 1, 1, bz1 + 1, style.lanternFloor);
  grid.set(bx1 + 1, 1, bz2 - 1, style.lanternFloor);
  grid.set(bx2 - 1, 1, bz2 - 1, style.lanternFloor);

  // Banners at gates
  grid.set(xMid - 2, 3, bz1, style.bannerS);
  grid.set(xMid + 1, 3, bz1, style.bannerS);
  grid.set(xMid - 2, 3, bz2, style.bannerN);
  grid.set(xMid + 1, 3, bz2, style.bannerN);

  // Perimeter banners — decorative banners on fence posts every 8 blocks
  for (let x = bx1 + 4; x <= bx2 - 4; x += 8) {
    if (grid.inBounds(x, 2, bz1)) grid.set(x, 2, bz1, style.bannerS);
    if (grid.inBounds(x, 2, bz2)) grid.set(x, 2, bz2, style.bannerN);
  }

  // ── Marketplace detail — carpet path accents + hanging chains + trees ──
  // Carpet accent pattern along main walkway
  const carpetTypes = [
    'minecraft:red_carpet', 'minecraft:orange_carpet',
    'minecraft:yellow_carpet', 'minecraft:light_blue_carpet',
  ];
  for (let x = bx1 + 2; x <= bx2 - 2; x += 2) {
    const ci = Math.abs(x - xMid) % carpetTypes.length;
    if (grid.inBounds(x, 1, zMid) && grid.get(x, 1, zMid) === 'minecraft:air')
      grid.set(x, 1, zMid, carpetTypes[ci]);
  }
  // Hanging chain lanterns along covered walkway
  for (let x = bx1 + 5; x <= bx2 - 5; x += 4) {
    if (grid.inBounds(x, 3, zMid)) {
      grid.set(x, 3, zMid, 'minecraft:chain');
      if (grid.inBounds(x, 2, zMid) && grid.get(x, 2, zMid) === 'minecraft:air')
        grid.set(x, 2, zMid, style.lantern);
    }
  }
  // Small trees at plaza corners for shade
  for (const [tx, tz] of [[bx1 + 2, bz1 + 2], [bx2 - 2, bz2 - 2]] as [number, number][]) {
    if (grid.inBounds(tx, 1, tz)) placeTree(grid, tx, 1, tz, 'oak', 3);
  }
  // Potted plants along perimeter wall
  for (let x = bx1 + 2; x <= bx2 - 2; x += 5) {
    if (grid.inBounds(x, 2, bz1 + 1))
      grid.set(x, 2, bz1 + 1, 'minecraft:potted_cornflower');
    if (grid.inBounds(x, 2, bz2 - 1))
      grid.set(x, 2, bz2 - 1, 'minecraft:potted_allium');
  }

  return grid;
}
