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
      grid.set(xStart, y + 1, z + i, 'minecraft:white_carpet');
      // Candle every other spot
      if (i % 2 === 0) {
        grid.set(xStart, y + 2, z + i, 'minecraft:candle[candles=3,lit=true]');
      }
      // Chairs on both sides
      grid.set(xStart - 1, y, z + i, style.chairE);
      grid.set(xStart + 1, y, z + i, style.chairW);
    }
  } else {
    for (let i = 0; i < length; i++) {
      grid.set(xStart + i, y, z, style.fence);
      grid.set(xStart + i, y + 1, z, 'minecraft:white_carpet');
      if (i % 2 === 0) {
        grid.set(xStart + i, y + 2, z, 'minecraft:candle[candles=3,lit=true]');
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
  grid: BlockGrid, cx: number, y: number, wallZ: number, _style: StylePalette
): void {
  // Brick surround
  grid.fill(cx - 1, y, wallZ, cx + 1, y + 2, wallZ, 'minecraft:bricks');
  grid.set(cx, y, wallZ, 'minecraft:campfire[lit=true]'); // fire
  grid.set(cx, y + 1, wallZ, 'minecraft:air'); // opening
  grid.set(cx, y + 2, wallZ, 'minecraft:bricks'); // mantle top
  grid.set(cx - 2, y, wallZ, 'minecraft:nether_bricks');
  grid.set(cx + 2, y, wallZ, 'minecraft:nether_bricks');
  // Mantle decorations
  grid.set(cx - 1, y + 3, wallZ, 'minecraft:candle[candles=3,lit=true]');
  grid.set(cx + 1, y + 3, wallZ, 'minecraft:potted_wither_rose');
}

/** Place a bed (2-block structure) */
export function placeBed(
  grid: BlockGrid, x: number, y: number, z: number,
  facing: 'north' | 'south', color: 'red' | 'blue' | 'cyan' = 'red'
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
  grid.set(x, y + 1, z, 'minecraft:white_carpet');
  if (decoration) {
    grid.set(x, y + 2, z, decoration);
  }
}
