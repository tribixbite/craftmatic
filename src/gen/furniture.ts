/**
 * Furniture and decoration placement primitives.
 * Small-scale building elements for room furnishing.
 */

import { BlockGrid } from '../schem/types.js';
import type { StylePalette } from './styles.js';

/** Hang a chain+lantern chandelier from cy_top downward */
export function chandelier(grid: BlockGrid, cx: number, cyTop: number, cz: number, style: StylePalette, length = 2): void {
  for (let i = 0; i < length; i++) {
    grid.set(cx, cyTop - i, cz, 'minecraft:chain');
  }
  grid.set(cx, cyTop - length, cz, style.lantern);
}

/** Place a table (fence post with carpet on top) and chairs around it */
export function tableAndChairs(
  grid: BlockGrid, tx: number, ty: number, tz: number,
  style: StylePalette, facing: string = 'ns'
): void {
  grid.set(tx, ty, tz, style.fence);
  grid.set(tx, ty + 1, tz, style.carpet);
  if (facing.includes('n')) grid.set(tx, ty, tz - 1, style.chairS);
  if (facing.includes('s')) grid.set(tx, ty, tz + 1, style.chairN);
  if (facing.includes('e')) grid.set(tx + 1, ty, tz, style.chairW);
  if (facing.includes('w')) grid.set(tx - 1, ty, tz, style.chairE);
}

/** Place a long dining table with chairs on both sides */
export function longDiningTable(
  grid: BlockGrid, xStart: number, y: number, z: number,
  length: number, style: StylePalette, direction: 'z' | 'x' = 'z'
): void {
  if (direction === 'z') {
    for (let i = 0; i < length; i++) {
      grid.set(xStart, y, z + i, style.fence);
      grid.set(xStart, y + 1, z + i, style.tableSurface);
      if (i % 2 === 0) {
        grid.set(xStart, y + 2, z + i, style.candle);
      }
      grid.set(xStart - 1, y, z + i, style.chairE);
      grid.set(xStart + 1, y, z + i, style.chairW);
    }
  } else {
    for (let i = 0; i < length; i++) {
      grid.set(xStart + i, y, z, style.fence);
      grid.set(xStart + i, y + 1, z, style.tableSurface);
      if (i % 2 === 0) {
        grid.set(xStart + i, y + 2, z, style.candle);
      }
      grid.set(xStart + i, y, z - 1, style.chairS);
      grid.set(xStart + i, y, z + 1, style.chairN);
    }
  }
}

/** Line of bookshelves along a z-coordinate */
export function bookshelfWall(
  grid: BlockGrid, x1: number, yBase: number, z: number,
  x2: number, rows = 2
): void {
  const xMin = Math.min(x1, x2);
  const xMax = Math.max(x1, x2);
  for (let r = 0; r < rows; r++) {
    for (let x = xMin; x <= xMax; x++) {
      grid.set(x, yBase + r, z, 'minecraft:bookshelf');
    }
  }
}

/** Lay carpet over a rectangular floor area */
export function carpetArea(
  grid: BlockGrid, x1: number, y: number, z1: number,
  x2: number, z2: number, carpetType: string
): void {
  const xMin = Math.min(x1, x2), xMax = Math.max(x1, x2);
  const zMin = Math.min(z1, z2), zMax = Math.max(z1, z2);
  for (let z = zMin; z <= zMax; z++) {
    for (let x = xMin; x <= xMax; x++) {
      grid.set(x, y, z, carpetType);
    }
  }
}

/** Column of end rods for magical lighting */
export function endRodPillar(
  grid: BlockGrid, x: number, yBase: number, z: number, height = 4
): void {
  for (let i = 0; i < height; i++) {
    grid.set(x, yBase + i, z, 'minecraft:end_rod[facing=up]');
  }
}

/** Place a fireplace against a wall (z = wallZ) */
export function fireplace(
  grid: BlockGrid, cx: number, y: number, wallZ: number, style: StylePalette
): void {
  // Style-specific surround
  grid.fill(cx - 1, y, wallZ, cx + 1, y + 2, wallZ, style.fireplaceBlock);
  grid.set(cx, y, wallZ, 'minecraft:campfire[lit=true]'); // fire
  grid.set(cx, y + 1, wallZ, 'minecraft:air'); // opening
  grid.set(cx, y + 2, wallZ, style.fireplaceBlock); // mantle top
  grid.set(cx - 2, y, wallZ, style.fireplaceAccent);
  grid.set(cx + 2, y, wallZ, style.fireplaceAccent);
  // Mantle decorations
  grid.set(cx - 1, y + 3, wallZ, style.candle);
  grid.set(cx + 1, y + 3, wallZ, style.plant1);
}

/** Place a bed (2-block structure) */
export function placeBed(
  grid: BlockGrid, x: number, y: number, z: number,
  facing: 'north' | 'south', color: string = 'red'
): void {
  if (facing === 'south') {
    grid.set(x, y, z, `minecraft:${color}_bed[facing=south,part=foot]`);
    grid.set(x, y, z + 1, `minecraft:${color}_bed[facing=south,part=head]`);
  } else {
    grid.set(x, y, z, `minecraft:${color}_bed[facing=north,part=foot]`);
    grid.set(x, y, z - 1, `minecraft:${color}_bed[facing=north,part=head]`);
  }
}

/** Place a console/side table (fence + carpet top + decoration) */
export function sideTable(
  grid: BlockGrid, x: number, y: number, z: number,
  style: StylePalette, decoration?: string
): void {
  grid.set(x, y, z, style.fence);
  grid.set(x, y + 1, z, style.tableSurface);
  if (decoration) {
    grid.set(x, y + 2, z, decoration);
  }
}

/** Place a storage corner (barrels + chest + crate stack) */
export function storageCorner(
  grid: BlockGrid, x: number, y: number, z: number,
  _style: StylePalette, facing: 'north' | 'south' | 'east' | 'west' = 'north'
): void {
  grid.addBarrel(x, y, z, 'up', [
    { slot: 0, id: 'minecraft:string', count: 16 },
    { slot: 1, id: 'minecraft:leather', count: 8 },
  ]);
  grid.addBarrel(x, y + 1, z, 'up', []);
  const dx = facing === 'east' ? 1 : facing === 'west' ? -1 : 0;
  const dz = facing === 'south' ? 1 : facing === 'north' ? -1 : 0;
  if (grid.inBounds(x + dx, y, z + dz))
    grid.addChest(x + dx, y, z + dz, facing, [
      { slot: 0, id: 'minecraft:torch', count: 32 },
    ]);
}

/** Place wall shelves (trapdoors as shelves with items) */
export function wallShelf(
  grid: BlockGrid, x: number, y: number, z: number,
  facing: 'north' | 'south' | 'east' | 'west', items: string[]
): void {
  grid.set(x, y, z, `minecraft:spruce_trapdoor[facing=${facing},half=top,open=true]`);
  if (items.length > 0 && grid.inBounds(x, y + 1, z)) {
    grid.set(x, y + 1, z, items[0]);
  }
}

/** Place an L-shaped couch arrangement */
export function couchSet(
  grid: BlockGrid, x: number, y: number, z: number,
  style: StylePalette, corner: 'ne' | 'nw' | 'se' | 'sw' = 'nw'
): void {
  // L-shaped sofa: 3 blocks on one axis, 2 on the other
  const facingH = corner.includes('n') ? style.chairN : style.chairS;
  const facingV = corner.includes('w') ? style.chairE : style.chairW;
  const dxDir = corner.includes('w') ? 1 : -1;
  const dzDir = corner.includes('n') ? 1 : -1;

  // Horizontal run (3 blocks)
  for (let i = 0; i < 3; i++) {
    if (grid.inBounds(x + dxDir * i, y, z))
      grid.set(x + dxDir * i, y, z, facingH);
  }
  // Vertical run (2 blocks, forming the L)
  for (let i = 1; i <= 2; i++) {
    if (grid.inBounds(x, y, z + dzDir * i))
      grid.set(x, y, z + dzDir * i, facingV);
  }
}

/** Place a weapon/armor display (armor stand area with items) */
export function armorDisplay(
  grid: BlockGrid, x: number, y: number, z: number
): void {
  grid.set(x, y, z, 'minecraft:polished_andesite');
  grid.set(x, y + 1, z, 'minecraft:armor_stand');
}

/** Place a rug with border pattern */
export function rugWithBorder(
  grid: BlockGrid, x1: number, y: number, z1: number,
  x2: number, z2: number, main: string, border: string
): void {
  for (let x = x1; x <= x2; x++) {
    for (let z = z1; z <= z2; z++) {
      const isEdge = x === x1 || x === x2 || z === z1 || z === z2;
      grid.set(x, y, z, isEdge ? border : main);
    }
  }
}

/** Place a painting/map wall decoration (item frames) */
export function wallDecoration(
  grid: BlockGrid, x: number, y: number, z: number,
  _facing: 'north' | 'south' | 'east' | 'west', block: string
): void {
  grid.set(x, y, z, block);
}

/** Place a telescope — end rod pillar with amethyst cluster on top */
export function telescope(
  grid: BlockGrid, x: number, yBase: number, z: number, height = 3
): void {
  for (let i = 0; i < height; i++) {
    grid.set(x, yBase + i, z, 'minecraft:end_rod[facing=up]');
  }
  grid.set(x, yBase + height, z, 'minecraft:amethyst_cluster[facing=up]');
}

/** Place a set of plates on a table surface (stone pressure plates) */
export function plateSet(
  grid: BlockGrid, x1: number, y: number, z: number,
  count: number, direction: 'x' | 'z' = 'x'
): void {
  for (let i = 0; i < count; i++) {
    const px = direction === 'x' ? x1 + i : x1;
    const pz = direction === 'z' ? z + i : z;
    if (grid.inBounds(px, y, pz)) {
      grid.set(px, y, pz, 'minecraft:stone_pressure_plate');
    }
  }
}

/** Place a map/navigation table — cartography table with lantern */
export function mapTable(
  grid: BlockGrid, x: number, y: number, z: number,
  style: StylePalette
): void {
  grid.set(x, y, z, 'minecraft:cartography_table');
  grid.set(x, y + 1, z, style.lanternFloor);
}

/** Place a parameterized light fixture — chain + light source variant */
export function lightFixture(
  grid: BlockGrid, x: number, yTop: number, z: number,
  chainLen: number, source: 'lantern' | 'candle' | 'end_rod' | 'soul_lantern' = 'lantern'
): void {
  for (let i = 0; i < chainLen; i++) {
    grid.set(x, yTop - i, z, 'minecraft:chain');
  }
  const sourceBlock: Record<string, string> = {
    lantern: 'minecraft:lantern[hanging=true]',
    candle: 'minecraft:candle[candles=4,lit=true]',
    end_rod: 'minecraft:end_rod[facing=down]',
    soul_lantern: 'minecraft:soul_lantern[hanging=true]',
  };
  grid.set(x, yTop - chainLen, z, sourceBlock[source]);
}

/** Place a ship steering wheel (fence post + open trapdoor) */
export function steeringWheel(
  grid: BlockGrid, x: number, y: number, z: number,
  facing: 'north' | 'south' | 'east' | 'west' = 'south'
): void {
  grid.set(x, y, z, 'minecraft:oak_fence');
  grid.set(x, y + 1, z, `minecraft:dark_oak_trapdoor[facing=${facing},half=top,open=true]`);
}

/** Place a bench (row of stairs) with optional storage underneath */
export function bench(
  grid: BlockGrid, x: number, y: number, z: number,
  length: number, style: StylePalette,
  facing: 'north' | 'south' | 'east' | 'west' = 'south',
  direction: 'x' | 'z' = 'x'
): void {
  const chair = facing === 'north' ? style.chairN :
                facing === 'south' ? style.chairS :
                facing === 'east' ? style.chairE : style.chairW;
  for (let i = 0; i < length; i++) {
    const bx = direction === 'x' ? x + i : x;
    const bz = direction === 'z' ? z + i : z;
    if (grid.inBounds(bx, y, bz)) grid.set(bx, y, bz, chair);
  }
}

/** Place a display pedestal — base block with item on top */
export function displayPedestal(
  grid: BlockGrid, x: number, y: number, z: number,
  baseBlock: string, displayItem: string
): void {
  grid.set(x, y, z, baseBlock);
  grid.set(x, y + 1, z, displayItem);
}

/** Place a towel rack — fence post with banner as towel */
export function towelRack(
  grid: BlockGrid, x: number, y: number, z: number,
  style: StylePalette
): void {
  grid.set(x, y, z, style.fence);
  grid.set(x, y + 1, z, style.bannerN);
}
