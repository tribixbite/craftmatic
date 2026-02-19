/**
 * Tests for rooms, styles (createPalette), and structure primitives.
 * Complements generator.test.ts which tests integration-level generation.
 */

import { describe, it, expect } from 'vitest';
import { getStyle, getStyleNames, STYLES, type StylePalette } from '../src/gen/styles.js';
import { getRoomGenerator, getRoomTypes } from '../src/gen/rooms.js';
import { BlockGrid } from '../src/schem/types.js';
import {
  foundation, floor, exteriorWalls, timberColumns, timberBeams,
  windows, interiorWall, doorway, frontDoor, staircase,
  gabledRoof, chimney, wallTorches, porch,
} from '../src/gen/structures.js';
import type { RoomType, StyleName } from '../src/types/index.js';

// ─── Style Palette Tests ──────────────────────────────────────────────

describe('style registry', () => {
  it('getStyleNames returns all 9 styles', () => {
    const names = getStyleNames();
    expect(names).toHaveLength(9);
    expect(names).toContain('fantasy');
    expect(names).toContain('medieval');
    expect(names).toContain('modern');
    expect(names).toContain('gothic');
    expect(names).toContain('rustic');
    expect(names).toContain('steampunk');
    expect(names).toContain('elven');
    expect(names).toContain('desert');
    expect(names).toContain('underwater');
  });

  it('STYLES record has 9 entries', () => {
    expect(Object.keys(STYLES).length).toBe(9);
  });

  it('getStyle returns a valid palette for each style', () => {
    for (const name of getStyleNames()) {
      const palette = getStyle(name);
      expect(palette).toBeDefined();
      // Every palette must have required fields
      expect(palette.wall).toBeTruthy();
      expect(palette.floorGround).toBeTruthy();
      expect(palette.roofN).toBeTruthy();
      expect(palette.timber).toBeTruthy();
      expect(palette.window).toBeTruthy();
      expect(palette.doorLowerN).toBeTruthy();
      expect(palette.counterBlock).toBeTruthy();
      expect(palette.counterSlab).toBeTruthy();
    }
  });

  it('getStyle returns undefined for invalid style name', () => {
    const result = getStyle('nonexistent' as StyleName);
    expect(result).toBeUndefined();
  });
});

describe('createPalette derivation', () => {
  it('timber axis variants are derived correctly for log blocks', () => {
    // Styles using logs (e.g. fantasy uses dark_oak_log) should have axis variants
    const fantasy = getStyle('fantasy');
    expect(fantasy.timberX).toContain('axis=x');
    expect(fantasy.timberZ).toContain('axis=z');
    // Default timber should have axis=y or no axis
    expect(fantasy.timber).toMatch(/axis=y|_log/);
  });

  it('non-log timber blocks skip axis variants', () => {
    // Modern uses quartz_pillar which doesn't contain '_log',
    // so timberX/Z should equal the base timber (no axis suffix)
    const modern = getStyle('modern');
    expect(modern.timberX).toBe(modern.timber);
    expect(modern.timberZ).toBe(modern.timber);
  });

  it('roof facing variants are derived (north/south)', () => {
    const palette = getStyle('fantasy');
    expect(palette.roofN).toContain('facing=north');
    expect(palette.roofS).toContain('facing=south');
    // Both should be stairs of the same material
    const baseBlock = palette.roofN.split('[')[0];
    expect(palette.roofS).toContain(baseBlock);
  });

  it('door variants have correct half and facing combos', () => {
    const palette = getStyle('medieval');
    // Lower half doors
    expect(palette.doorLowerN).toContain('half=lower');
    expect(palette.doorLowerN).toContain('facing=north');
    expect(palette.doorLowerS).toContain('half=lower');
    expect(palette.doorLowerS).toContain('facing=south');
    // Upper half doors
    expect(palette.doorUpperN).toContain('half=upper');
    expect(palette.doorUpperN).toContain('facing=north');
    expect(palette.doorUpperS).toContain('half=upper');
    expect(palette.doorUpperS).toContain('facing=south');
  });

  it('chair variants have correct facing directions', () => {
    const palette = getStyle('gothic');
    expect(palette.chairN).toContain('facing=north');
    expect(palette.chairS).toContain('facing=south');
    expect(palette.chairE).toContain('facing=east');
    expect(palette.chairW).toContain('facing=west');
    // All should be stairs of the same type
    const baseBlock = palette.chairN.split('[')[0];
    expect(palette.chairS).toContain(baseBlock);
    expect(palette.chairE).toContain(baseBlock);
    expect(palette.chairW).toContain(baseBlock);
  });

  it('torch variants have correct facing directions', () => {
    const palette = getStyle('rustic');
    expect(palette.torchN).toContain('facing=north');
    expect(palette.torchS).toContain('facing=south');
    expect(palette.torchE).toContain('facing=east');
    expect(palette.torchW).toContain('facing=west');
  });

  it('slab variants have correct type (top/bottom)', () => {
    const palette = getStyle('elven');
    expect(palette.slabBottom).toContain('type=bottom');
    expect(palette.slabTop).toContain('type=top');
    // Same base material
    const baseBlock = palette.slabBottom.split('[')[0];
    expect(palette.slabTop).toContain(baseBlock);
  });

  it('banner variants have correct facing', () => {
    const palette = getStyle('steampunk');
    // Banners are wall_banner with facing= (not standing_banner with rotation=)
    expect(palette.bannerN).toContain('facing=north');
    expect(palette.bannerS).toContain('facing=south');
    expect(palette.bannerN).not.toBe(palette.bannerS);
  });

  it('styles produce mostly unique wall blocks', () => {
    const walls = new Set<string>();
    for (const name of getStyleNames()) {
      walls.add(getStyle(name).wall);
    }
    // 8 unique walls — fantasy and modern share minecraft:white_concrete
    expect(walls.size).toBe(8);
  });

  it('all derived fields are valid Minecraft block states', () => {
    for (const name of getStyleNames()) {
      const p = getStyle(name);
      // Check that derived fields have minecraft: prefix
      const derivedFields: (keyof StylePalette)[] = [
        'timberX', 'timberZ', 'roofN', 'roofS',
        'doorLowerN', 'doorLowerS', 'doorUpperN', 'doorUpperS',
        'chairN', 'chairS', 'chairE', 'chairW',
        'torchN', 'torchS', 'torchE', 'torchW',
        'slabBottom', 'slabTop', 'bannerN', 'bannerS',
      ];
      for (const field of derivedFields) {
        const value = p[field] as string;
        expect(value, `${name}.${field}`).toMatch(/^minecraft:/);
      }
    }
  });
});

// ─── Room Generator Tests ─────────────────────────────────────────────

describe('room generator registry', () => {
  it('getRoomTypes returns all expected room types', () => {
    const types = getRoomTypes();
    expect(types.length).toBeGreaterThanOrEqual(20);
    // Check key room types exist
    const expected: RoomType[] = [
      'bedroom', 'kitchen', 'dining', 'living', 'bathroom',
      'study', 'library', 'vault', 'armory', 'observatory',
      'lab', 'gallery', 'throne', 'forge', 'greenhouse',
      'foyer', 'captains_quarters', 'cell', 'nave', 'belfry',
      'attic', 'basement', 'sunroom', 'closet', 'laundry',
      'pantry', 'mudroom', 'garage',
    ];
    for (const room of expected) {
      expect(types, `missing room type: ${room}`).toContain(room);
    }
  });

  it('every room type has a registered generator function', () => {
    const types = getRoomTypes();
    for (const room of types) {
      const gen = getRoomGenerator(room);
      expect(gen, `no generator for room type: ${room}`).toBeDefined();
      expect(typeof gen).toBe('function');
    }
  });

  it('each room generator runs without error in a small grid', () => {
    const style = getStyle('fantasy');
    const types = getRoomTypes();

    for (const room of types) {
      const gen = getRoomGenerator(room);
      // Create a 10x10x10 grid with room bounds in the center
      const grid = new BlockGrid(12, 10, 12);
      const bounds = { x1: 1, y: 1, z1: 1, x2: 10, z2: 10, height: 4 };

      // Should not throw
      expect(() => gen(grid, bounds, style)).not.toThrow();

      // Generator should place at least some blocks
      const count = grid.countNonAir();
      expect(count, `room ${room} placed no blocks`).toBeGreaterThan(0);
    }
  });
});

// ─── Structure Primitive Tests ────────────────────────────────────────

describe('structure primitives', () => {
  const style = getStyle('medieval');

  it('foundation places blocks at y=0', () => {
    const grid = new BlockGrid(20, 20, 20);
    // foundation(grid, x1, z1, x2, z2, style)
    foundation(grid, 2, 2, 14, 14, style);

    expect(grid.get(2, 0, 2)).not.toBe('minecraft:air');
    expect(grid.get(14, 0, 14)).not.toBe('minecraft:air');
    expect(grid.countNonAir()).toBeGreaterThan(0);
  });

  it('floor fills a level with floor blocks', () => {
    const grid = new BlockGrid(20, 20, 20);
    // floor(grid, x1, y, z1, x2, z2, style, isGround)
    floor(grid, 2, 1, 2, 14, 14, style, true);

    expect(grid.get(5, 1, 5)).not.toBe('minecraft:air');
    expect(grid.countNonAir()).toBeGreaterThan(10);
  });

  it('exteriorWalls builds walls along perimeter', () => {
    const grid = new BlockGrid(20, 20, 20);
    // exteriorWalls(grid, x1, y1, z1, x2, y2, z2, style)
    exteriorWalls(grid, 2, 1, 2, 14, 4, 14, style);

    expect(grid.get(2, 1, 2)).not.toBe('minecraft:air');
    expect(grid.get(14, 1, 14)).not.toBe('minecraft:air');
    // Interior should be air
    expect(grid.get(8, 2, 8)).toBe('minecraft:air');
    expect(grid.countNonAir()).toBeGreaterThan(20);
  });

  it('timberColumns places columns at positions', () => {
    const grid = new BlockGrid(20, 20, 20);
    // timberColumns(grid, positions, y1, y2, style)
    const positions: [number, number][] = [[2, 2], [14, 2], [2, 14], [14, 14]];
    timberColumns(grid, positions, 1, 4, style);

    expect(grid.get(2, 1, 2)).not.toBe('minecraft:air');
    expect(grid.get(14, 1, 14)).not.toBe('minecraft:air');
  });

  it('timberBeams places horizontal beams at a given y', () => {
    const grid = new BlockGrid(20, 20, 20);
    // timberBeams(grid, x1, y, z1, x2, z2, style)
    timberBeams(grid, 2, 4, 2, 14, 14, style);
    expect(grid.countNonAir()).toBeGreaterThan(0);
  });

  it('windows places glass in walls', () => {
    const grid = new BlockGrid(20, 20, 20);
    // Need walls first
    exteriorWalls(grid, 2, 1, 2, 14, 4, 14, style);
    // windows(grid, x1, z1, x2, z2, wy1, wy2, style, spacing)
    windows(grid, 2, 2, 14, 14, 2, 3, style, 3);

    const hasGlass = Array.from(grid.palette.keys()).some(b => b.includes('glass') || b.includes('pane'));
    expect(hasGlass).toBe(true);
  });

  it('interiorWall places a wall between rooms', () => {
    const grid = new BlockGrid(20, 20, 20);
    // interiorWall(grid, wallAxis, fixedPos, rangeStart, rangeEnd, y1, y2, style)
    interiorWall(grid, 'x', 8, 2, 14, 1, 4, style);
    expect(grid.countNonAir()).toBeGreaterThan(0);
    // Wall along X axis at z=8
    expect(grid.get(5, 1, 8)).not.toBe('minecraft:air');
  });

  it('doorway carves an opening in a wall', () => {
    const grid = new BlockGrid(20, 20, 20);
    interiorWall(grid, 'x', 8, 2, 14, 1, 4, style);
    const beforeCount = grid.countNonAir();
    // doorway(grid, x1, y1, z1, x2, y2, z2)
    doorway(grid, 5, 1, 8, 7, 2, 8);
    expect(grid.countNonAir()).toBeLessThan(beforeCount);
  });

  it('frontDoor places a door at ground level', () => {
    const grid = new BlockGrid(20, 20, 20);
    // frontDoor(grid, dx, y, wallZ, style, facing)
    frontDoor(grid, 8, 1, 2, style, 'south');
    const hasDoor = Array.from(grid.palette.keys()).some(b => b.includes('door'));
    expect(hasDoor).toBe(true);
  });

  it('staircase places blocks across multiple levels', () => {
    const grid = new BlockGrid(20, 20, 20);
    // staircase(grid, stairX, stairX2, startZ, baseY, nextFloorY, gridHeight)
    staircase(grid, 5, 7, 3, 1, 6, 20);

    expect(grid.countNonAir()).toBeGreaterThan(0);
    let maxY = 0;
    for (let y = 0; y < 20; y++) {
      for (let z = 0; z < 20; z++) {
        for (let x = 0; x < 20; x++) {
          if (grid.get(x, y, z) !== 'minecraft:air') maxY = Math.max(maxY, y);
        }
      }
    }
    expect(maxY).toBeGreaterThan(1);
  });

  it('gabledRoof places a roof structure', () => {
    const grid = new BlockGrid(30, 30, 30);
    // gabledRoof(grid, x1, z1, x2, z2, baseY, maxHeight, style)
    gabledRoof(grid, 2, 2, 14, 14, 5, 8, style);

    expect(grid.countNonAir()).toBeGreaterThan(10);
    const hasStairs = Array.from(grid.palette.keys()).some(b => b.includes('stairs'));
    expect(hasStairs).toBe(true);
  });

  it('chimney places a vertical column', () => {
    const grid = new BlockGrid(30, 30, 30);
    // chimney(grid, x, z, startY, topY) — no style, always bricks
    chimney(grid, 8, 8, 5, 10);
    expect(grid.countNonAir()).toBeGreaterThan(0);
    const hasBrick = Array.from(grid.palette.keys()).some(b => b.includes('brick'));
    expect(hasBrick).toBe(true);
  });

  it('wallTorches places torches inside walls', () => {
    const grid = new BlockGrid(20, 20, 20);
    exteriorWalls(grid, 2, 1, 2, 14, 4, 14, style);
    // wallTorches(grid, x1, z1, x2, z2, y, style, spacing)
    wallTorches(grid, 2, 2, 14, 14, 3, style, 4);

    const hasTorch = Array.from(grid.palette.keys()).some(b => b.includes('torch'));
    expect(hasTorch).toBe(true);
  });

  it('porch places a covered structure in front', () => {
    const grid = new BlockGrid(30, 30, 30);
    // porch(grid, cx, wallZ, width, storyH, style, direction)
    porch(grid, 8, 2, 10, 4, style, 'north');
    expect(grid.countNonAir()).toBeGreaterThan(5);
  });
});

// ─── Style-Specific Structure Integration ─────────────────────────────

describe('style-specific structure integration', () => {
  it('each style produces valid structures.ts output', () => {
    for (const name of getStyleNames()) {
      const style = getStyle(name);
      const grid = new BlockGrid(20, 20, 20);

      // Chain structure primitives with correct signatures
      foundation(grid, 2, 2, 14, 14, style);
      floor(grid, 2, 1, 2, 14, 14, style, true);
      exteriorWalls(grid, 2, 1, 2, 14, 4, 14, style);
      const corners: [number, number][] = [[2, 2], [14, 2], [2, 14], [14, 14]];
      timberColumns(grid, corners, 1, 4, style);

      expect(grid.countNonAir(), `${name} primitives`).toBeGreaterThan(20);
    }
  });
});
