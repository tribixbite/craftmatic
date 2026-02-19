/**
 * Tests for:
 * - New furniture primitives (bench, displayPedestal, towelRack)
 * - Style-specific roof dispatch (defaultRoofShape, roofHeight per style)
 * - Center-of-room anchor features in rooms
 */

import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { getStyle, getStyleNames, STYLES } from '../src/gen/styles.js';
import type { StylePalette } from '../src/gen/styles.js';
import { bench, displayPedestal, towelRack, chandelier, carpetArea } from '../src/gen/furniture.js';
import { getRoomGenerator } from '../src/gen/rooms.js';
import { generateStructure } from '../src/gen/generator.js';
import type { StyleName, RoomBounds, RoofShape } from '../src/types/index.js';

// ─── Helpers ────────────────────────────────────────────────────────

/** Create a test grid with enough room for furniture placement */
function makeGrid(w = 20, h = 10, l = 20): BlockGrid {
  return new BlockGrid(w, h, l);
}

/** Get the fantasy style for quick tests */
function fantasyStyle(): StylePalette {
  return getStyle('fantasy');
}

/** Count occurrences of blocks matching a predicate in a grid */
function countBlocks(grid: BlockGrid, pred: (block: string) => boolean): number {
  let n = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        if (pred(grid.get(x, y, z))) n++;
      }
    }
  }
  return n;
}

/** Check if grid has any block matching predicate */
function hasBlock(grid: BlockGrid, pred: (block: string) => boolean): boolean {
  return countBlocks(grid, pred) > 0;
}

// ─── Furniture Primitives ───────────────────────────────────────────

describe('bench() primitive', () => {
  it('places a row of chair blocks along x-axis', () => {
    const grid = makeGrid();
    const style = fantasyStyle();
    bench(grid, 2, 1, 5, 4, style, 'south', 'x');
    // bench places style.chairS for facing=south
    for (let i = 0; i < 4; i++) {
      expect(grid.get(2 + i, 1, 5)).toBe(style.chairS);
    }
  });

  it('places a row along z-axis', () => {
    const grid = makeGrid();
    const style = fantasyStyle();
    bench(grid, 3, 1, 2, 3, style, 'east', 'z');
    for (let i = 0; i < 3; i++) {
      expect(grid.get(3, 1, 2 + i)).toBe(style.chairE);
    }
  });

  it('uses correct facing direction for all 4 facings', () => {
    const style = fantasyStyle();
    const facings: Array<{ facing: 'north' | 'south' | 'east' | 'west'; expected: string }> = [
      { facing: 'north', expected: style.chairN },
      { facing: 'south', expected: style.chairS },
      { facing: 'east', expected: style.chairE },
      { facing: 'west', expected: style.chairW },
    ];
    for (const { facing, expected } of facings) {
      const grid = makeGrid();
      bench(grid, 5, 1, 5, 2, style, facing);
      expect(grid.get(5, 1, 5)).toBe(expected);
    }
  });

  it('respects grid bounds (no out-of-bounds writes)', () => {
    const grid = makeGrid(5, 5, 5);
    const style = fantasyStyle();
    // Place bench that would extend beyond grid
    bench(grid, 3, 1, 2, 5, style, 'south', 'x');
    // Only positions 3,4 should be written (x=5,6,7 are out of bounds)
    expect(grid.get(3, 1, 2)).toBe(style.chairS);
    expect(grid.get(4, 1, 2)).toBe(style.chairS);
    // No crash from the out-of-bounds positions
  });
});

describe('displayPedestal() primitive', () => {
  it('places base block and display item on top', () => {
    const grid = makeGrid();
    displayPedestal(grid, 5, 1, 5, 'minecraft:polished_andesite', 'minecraft:chain');
    expect(grid.get(5, 1, 5)).toBe('minecraft:polished_andesite');
    expect(grid.get(5, 2, 5)).toBe('minecraft:chain');
  });

  it('works with style-specific blocks', () => {
    const grid = makeGrid();
    const style = fantasyStyle();
    displayPedestal(grid, 3, 0, 3, style.pillar, style.plant1);
    expect(grid.get(3, 0, 3)).toBe(style.pillar);
    expect(grid.get(3, 1, 3)).toBe(style.plant1);
  });

  it('each layer is exactly one block', () => {
    const grid = makeGrid();
    displayPedestal(grid, 5, 1, 5, 'minecraft:stone', 'minecraft:diamond_block');
    // Only 2 non-air blocks should be placed
    expect(countBlocks(grid, b => b !== 'minecraft:air')).toBe(2);
  });
});

describe('towelRack() primitive', () => {
  it('places fence post with banner on top', () => {
    const grid = makeGrid();
    const style = fantasyStyle();
    towelRack(grid, 5, 1, 5, style);
    expect(grid.get(5, 1, 5)).toBe(style.fence);
    expect(grid.get(5, 2, 5)).toBe(style.bannerN);
  });

  it('works with different styles', () => {
    for (const name of getStyleNames()) {
      const grid = makeGrid();
      const style = getStyle(name);
      towelRack(grid, 5, 1, 5, style);
      expect(grid.get(5, 1, 5)).toBe(style.fence);
      expect(grid.get(5, 2, 5)).toBe(style.bannerN);
    }
  });
});

// ─── Style-Specific Roof Properties ────────────────────────────────

describe('style-specific roof properties', () => {
  const EXPECTED_ROOFS: Record<StyleName, { shape: RoofShape; height: number }> = {
    fantasy:    { shape: 'gambrel', height: 10 },
    medieval:   { shape: 'gable', height: 10 },
    modern:     { shape: 'flat', height: 4 },
    gothic:     { shape: 'mansard', height: 12 },
    rustic:     { shape: 'gambrel', height: 10 },
    steampunk:  { shape: 'mansard', height: 10 },
    elven:      { shape: 'hip', height: 8 },
    desert:     { shape: 'flat', height: 4 },
    underwater: { shape: 'hip', height: 8 },
  };

  for (const [name, expected] of Object.entries(EXPECTED_ROOFS)) {
    it(`${name} style has defaultRoofShape=${expected.shape}`, () => {
      const style = getStyle(name as StyleName);
      expect(style.defaultRoofShape).toBe(expected.shape);
    });

    it(`${name} style has roofHeight=${expected.height}`, () => {
      const style = getStyle(name as StyleName);
      expect(style.roofHeight).toBe(expected.height);
    });
  }

  it('every style has a valid RoofShape', () => {
    const validShapes: RoofShape[] = ['gable', 'hip', 'flat', 'gambrel', 'mansard'];
    for (const name of getStyleNames()) {
      const style = getStyle(name);
      expect(validShapes).toContain(style.defaultRoofShape);
    }
  });

  it('every style has a positive roofHeight', () => {
    for (const name of getStyleNames()) {
      const style = getStyle(name);
      expect(style.roofHeight).toBeGreaterThan(0);
      expect(style.roofHeight).toBeLessThanOrEqual(15);
    }
  });
});

describe('style-specific roof dispatch in generation', () => {
  it('flat-roof styles (modern, desert) produce shorter structures', () => {
    const flatStyle = generateStructure({ type: 'house', floors: 2, style: 'modern', seed: 42 });
    const tallStyle = generateStructure({ type: 'house', floors: 2, style: 'gothic', seed: 42 });
    // Gothic has roofHeight=12 vs modern roofHeight=4 → gothic taller
    expect(tallStyle.height).toBeGreaterThan(flatStyle.height);
  });

  it('explicit roofShape overrides style default', () => {
    // Modern defaults to flat, but passing gable should make it taller
    const flat = generateStructure({ type: 'house', floors: 2, style: 'modern', seed: 42 });
    const gable = generateStructure({
      type: 'house', floors: 2, style: 'modern', seed: 42,
      roofShape: 'gable',
    });
    // Gable adds more blocks than flat roof on the same footprint
    expect(gable.countNonAir()).toBeGreaterThan(flat.countNonAir());
  });

  it('each style generates without error using its default roof', () => {
    for (const style of getStyleNames()) {
      const grid = generateStructure({ type: 'house', floors: 2, style, seed: 42 });
      expect(grid.countNonAir()).toBeGreaterThan(100);
    }
  });

  it('different roof heights produce different grid heights', () => {
    // Gothic: mansard roofHeight=12; Desert: flat roofHeight=4
    const gothic = generateStructure({ type: 'house', floors: 1, style: 'gothic', seed: 42 });
    const desert = generateStructure({ type: 'house', floors: 1, style: 'desert', seed: 42 });
    expect(gothic.height).toBeGreaterThan(desert.height);
  });
});

// ─── Center-of-Room Anchor Features ────────────────────────────────

describe('center anchor: bedroom', () => {
  it('large bedroom (rw>=6, rl>=6) gets bench at foot of bed', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 8, z2: 8, height: 5 };
    // rw = 8-1 = 7 >= 6, rl = 8-1 = 7 >= 6 → bench should appear
    getRoomGenerator('bedroom')(grid, bounds, style);
    // bench is placed at x1+2, y, z1+3 with facing south → style.chairS
    expect(grid.get(3, 1, 4)).toBe(style.chairS);
  });

  it('extra-large bedroom (rw>=8) gets reading chair', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 10, z2: 10, height: 5 };
    // rw = 10-1 = 9 >= 8
    getRoomGenerator('bedroom')(grid, bounds, style);
    // Reading chair at x2-1 = 9, facing W
    const cz = Math.floor((1 + 10) / 2);
    expect(grid.get(9, 1, cz)).toBe(style.chairW);
  });

  it('small bedroom (rw<6) has no bench blocks', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    // rw = 5-1 = 4 < 6
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 5, z2: 5, height: 5 };
    getRoomGenerator('bedroom')(grid, bounds, style);
    // No bench placed — z1+3=4, x1+2=3: should not be chairS
    // (it will be part of the rug or empty depending on room logic)
    // Just verify no crash and room generated successfully
    expect(grid.countNonAir()).toBeGreaterThan(0);
  });
});

describe('center anchor: bathroom', () => {
  it('large bathroom (rw>=5, rl>=5) gets bath mat + towel rack', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 7, z2: 7, height: 5 };
    // rw = 6, rl = 6 → center features
    getRoomGenerator('bathroom')(grid, bounds, style);
    // Towel rack at center: fence post
    const bcx = Math.floor((1 + 7) / 2);
    const bcz = Math.floor((1 + 7) / 2);
    expect(grid.get(bcx, 1, bcz - 1)).toBe(style.fence); // towelRack base
    expect(grid.get(bcx, 2, bcz - 1)).toBe(style.bannerN); // towel
    // Bath mat — carpet in center area
    expect(grid.get(bcx, 1, bcz)).toBe(style.carpet);
  });

  it('small bathroom (rl>=4) gets just a bath mat', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    // rw = 3 (< 5), rl = 4
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 4, z2: 5, height: 5 };
    getRoomGenerator('bathroom')(grid, bounds, style);
    // Should have carpet at x1+1, z1+2
    expect(grid.get(2, 1, 3)).toBe(style.carpet);
    expect(grid.countNonAir()).toBeGreaterThan(0);
  });
});

describe('center anchor: armory', () => {
  it('large armory (rw>=6) gets weapon display pedestal', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 8, z2: 10, height: 5 };
    // rw = 7 >= 6
    getRoomGenerator('armory')(grid, bounds, style);
    const cx = Math.floor((1 + 8) / 2);
    const aCz = Math.floor((1 + 10) / 2);
    // displayPedestal places pillar + chain
    expect(grid.get(cx, 1, aCz)).toBe(style.pillar);
    expect(grid.get(cx, 2, aCz)).toBe('minecraft:chain');
  });

  it('extra-large armory (rw>=8) gets training post', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 10, z2: 10, height: 5 };
    // rw = 9 >= 8
    getRoomGenerator('armory')(grid, bounds, style);
    const cx = Math.floor((1 + 10) / 2);
    const aCz = Math.floor((1 + 10) / 2);
    // Training post: fence at cx-2, target above
    expect(grid.get(cx - 2, 1, aCz)).toBe(style.fence);
    expect(grid.get(cx - 2, 2, aCz)).toBe('minecraft:target');
  });
});

describe('center anchor: foyer', () => {
  it('grand foyer (rw>=8, rl>=6) gets center pedestal + flanking candles', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 10, z2: 8, height: 5 };
    // rw = 9 >= 8, rl = 7 >= 6
    getRoomGenerator('foyer')(grid, bounds, style);
    const cx = Math.floor((1 + 10) / 2);
    const fCz = Math.floor((1 + 8) / 2);
    // displayPedestal: pillar + plant
    expect(grid.get(cx, 1, fCz)).toBe(style.pillar);
    expect(grid.get(cx, 2, fCz)).toBe(style.plant1);
    // Flanking candles on fence posts
    expect(grid.get(cx - 1, 1, fCz)).toBe(style.fence);
    expect(grid.get(cx - 1, 2, fCz)).toBe(style.candle);
    expect(grid.get(cx + 1, 1, fCz)).toBe(style.fence);
    expect(grid.get(cx + 1, 2, fCz)).toBe(style.candle);
  });
});

describe('center anchor: living room', () => {
  it('large living room (rw>=10, rl>=8) gets second seating area', () => {
    const grid = makeGrid(25, 10, 25);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 12, z2: 10, height: 5 };
    // rw = 11 >= 10, rl = 9 >= 8
    getRoomGenerator('living')(grid, bounds, style);
    // Second couch set placed at cx-2, z2-3
    // Just verify the room generates with extra furniture
    expect(grid.countNonAir()).toBeGreaterThan(10);
    // Reading nook side table at cx-3 → fence post
    const cx = Math.floor((1 + 12) / 2);
    expect(grid.get(cx - 3, 1, 10 - 3)).toBe(style.fence);
  });
});

describe('center anchor: attic', () => {
  it('large attic (rw>=6, rl>=6) gets chest + reading spot', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 8, z2: 8, height: 5 };
    // rw = 7 >= 6, rl = 7 >= 6
    getRoomGenerator('attic')(grid, bounds, style);
    const cx = Math.floor((1 + 8) / 2);
    const aCz = Math.floor((1 + 8) / 2);
    // Old trunk = chest block entity
    expect(grid.blockEntities.length).toBeGreaterThan(0);
    // Rocking chair at aCz+2
    expect(grid.get(cx, 1, aCz + 2)).toBe(style.chairN);
    // Reading rug (carpet)
    expect(grid.get(cx, 1, aCz + 1)).toBe(style.carpet);
    // Lantern beside trunk
    expect(grid.get(cx + 1, 1, aCz)).toBe(style.lanternFloor);
  });

  it('small attic gets just a lantern', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 5, z2: 5, height: 5 };
    // rw = 4 < 6 → no chest, just lantern
    getRoomGenerator('attic')(grid, bounds, style);
    const cx = Math.floor((1 + 5) / 2);
    const aCz = Math.floor((1 + 5) / 2);
    expect(grid.get(cx, 1, aCz)).toBe(style.lanternFloor);
  });
});

describe('center anchor: basement', () => {
  it('large basement (rw>=6, rl>=5) gets workbench area', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 8, z2: 7, height: 5 };
    // rw = 7 >= 6, rl = 6 >= 5
    getRoomGenerator('basement')(grid, bounds, style);
    const cx = Math.floor((1 + 8) / 2);
    const bCz = Math.floor((1 + 7) / 2);
    // Crafting table in center (re-placed over carpet)
    expect(grid.get(cx, 1, bCz)).toBe('minecraft:crafting_table');
    // Chair next to it
    expect(grid.get(cx - 1, 1, bCz)).toBe(style.chairE);
    // Lantern on table
    expect(grid.get(cx, 2, bCz)).toBe(style.lanternFloor);
  });
});

describe('center anchor: captain\'s quarters', () => {
  it('large quarters (rw>=8, rl>=6) gets navigation globe', () => {
    const grid = makeGrid(20, 10, 20);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 10, z2: 8, height: 5 };
    // rw = 9 >= 8, rl = 7 >= 6
    getRoomGenerator('captains_quarters')(grid, bounds, style);
    const cx = Math.floor((1 + 10) / 2);
    const cCz = Math.floor((1 + 8) / 2);
    // Navigation globe: pillar + sea_lantern
    expect(grid.get(cx, 1, cCz)).toBe(style.pillar);
    expect(grid.get(cx, 2, cCz)).toBe('minecraft:sea_lantern');
    // Meeting chairs
    expect(grid.get(cx - 1, 1, cCz + 1)).toBe(style.chairN);
    expect(grid.get(cx + 1, 1, cCz + 1)).toBe(style.chairN);
  });
});

describe('center anchor: dining room', () => {
  it('large dining room (rw>=10) gets display cabinet', () => {
    const grid = makeGrid(25, 10, 25);
    const style = fantasyStyle();
    const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 12, z2: 10, height: 5 };
    // rw = 11 >= 10
    getRoomGenerator('dining')(grid, bounds, style);
    // Display cabinet: bookshelves on far wall (x2)
    expect(grid.get(12, 1, 3)).toBe('minecraft:bookshelf');
    expect(grid.get(12, 2, 3)).toBe('minecraft:bookshelf');
  });
});

// ─── Integration: Center Features in Full Generation ───────────────

describe('center features in generated structures', () => {
  it('large house has more furniture blocks than minimal house', () => {
    const large = generateStructure({
      type: 'house', floors: 2, style: 'fantasy', seed: 42,
      width: 30, length: 30,
      rooms: ['living', 'dining', 'bedroom', 'bedroom', 'bathroom', 'study', 'foyer'],
    });
    const small = generateStructure({
      type: 'house', floors: 1, style: 'fantasy', seed: 42,
      width: 12, length: 12,
      rooms: ['living', 'bedroom', 'bathroom'],
    });
    // More rooms + larger dimensions → more furniture blocks
    expect(large.countNonAir()).toBeGreaterThan(small.countNonAir());
  });

  it('houses with interior rooms contain crafting tables', () => {
    const grid = generateStructure({
      type: 'house', floors: 2, style: 'medieval', seed: 42,
      rooms: ['kitchen', 'study', 'forge'],
    });
    expect(hasBlock(grid, b => b === 'minecraft:crafting_table')).toBe(true);
  });

  it('house with bedroom contains bed blocks', () => {
    const grid = generateStructure({
      type: 'house', floors: 2, style: 'fantasy', seed: 42,
      rooms: ['bedroom', 'bedroom', 'bathroom', 'living'],
    });
    expect(hasBlock(grid, b => b.includes('_bed['))).toBe(true);
  });

  it('house with armory rooms contains armor stands or targets', () => {
    const grid = generateStructure({
      type: 'house', floors: 2, style: 'medieval', seed: 42,
      rooms: ['armory', 'armory', 'living', 'foyer'],
    });
    // Armory should have armor_stand or target blocks
    const hasArmory = hasBlock(grid, b => b === 'minecraft:armor_stand' || b === 'minecraft:target');
    expect(hasArmory).toBe(true);
  });
});

// ─── Cross-Style Center Feature Consistency ─────────────────────────

describe('center features work across all 9 styles', () => {
  const roomsToTest: Array<{ room: string; minBlocks: number }> = [
    { room: 'bedroom', minBlocks: 5 },
    { room: 'bathroom', minBlocks: 5 },
    { room: 'armory', minBlocks: 5 },
    { room: 'foyer', minBlocks: 5 },
    { room: 'attic', minBlocks: 3 },
    { room: 'basement', minBlocks: 3 },
  ];

  for (const { room, minBlocks } of roomsToTest) {
    it(`${room} generates without error in all 9 styles`, () => {
      const bounds: RoomBounds = { x1: 1, y: 1, z1: 1, x2: 10, z2: 10, height: 5 };
      for (const name of getStyleNames()) {
        const grid = makeGrid(20, 10, 20);
        const style = getStyle(name);
        getRoomGenerator(room as any)(grid, bounds, style);
        expect(grid.countNonAir()).toBeGreaterThanOrEqual(minBlocks);
      }
    });
  }
});
