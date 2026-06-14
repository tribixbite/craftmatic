/**
 * Tests for semantic-palette.ts — OSM tag + metadata → Minecraft material palette.
 *
 * Validates the priority chain:
 *   1. OSM building:colour (skip if gray)
 *   2. OSM building:material
 *   3. Height + type → glass curtain wall
 *   4. null (no override)
 *
 * Also validates applySemanticPalette grid replacement logic.
 */

import { describe, it, expect } from 'vitest';
import { resolveSemanticPalette, applySemanticPalette, type SemanticPalette } from '../src/convert/semantic-palette.js';
import { BlockGrid } from '../src/schem/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Blocks the code considers gray photogrammetry monotone — candidates for override */
const GRAY_FAMILY = new Set<string>([
  'minecraft:andesite',
  'minecraft:polished_andesite',
  'minecraft:smooth_stone',
  'minecraft:stone',
  'minecraft:light_gray_concrete',
  'minecraft:gray_concrete',
  'minecraft:polished_deepslate',
  'minecraft:gravel',
  'minecraft:cobblestone',
  'minecraft:stone_bricks',
]);

/** Glass block variants that applySemanticPalette must preserve */
const GLASS_BLOCKS = new Set<string>([
  'minecraft:glass',
  'minecraft:glass_pane',
  'minecraft:gray_stained_glass',
  'minecraft:light_gray_stained_glass',
  'minecraft:white_stained_glass',
  'minecraft:black_stained_glass',
  'minecraft:blue_stained_glass',
  'minecraft:cyan_stained_glass',
  'minecraft:light_blue_stained_glass',
]);

/** Create a small 5x5x5 BlockGrid filled with a given block type */
function makeGrid(fillBlock: string = 'minecraft:andesite'): BlockGrid {
  const grid = new BlockGrid(5, 5, 5);
  // Fill all cells with the given block
  for (let y = 0; y < 5; y++) {
    for (let z = 0; z < 5; z++) {
      for (let x = 0; x < 5; x++) {
        grid.set(x, y, z, fillBlock);
      }
    }
  }
  return grid;
}

// ─── resolveSemanticPalette ──────────────────────────────────────────────────

describe('resolveSemanticPalette', () => {
  it('returns null when no OSM tags are present', () => {
    const result = resolveSemanticPalette({}, 0);
    expect(result).toBeNull();
  });

  it('returns null when only irrelevant tags are present', () => {
    const result = resolveSemanticPalette({ building: 'yes', name: 'Test Building' }, 0);
    expect(result).toBeNull();
  });

  it('returns sandstone-family palette for Flatiron colour #CBC7AC', () => {
    // #CBC7AC = RGB(203, 199, 172) — warm tan/limestone
    const result = resolveSemanticPalette({ 'building:colour': '#CBC7AC' }, 87);
    expect(result).not.toBeNull();
    expect(result!.source).toContain('building:colour');
    // The primary block should be a sandstone variant (tan/beige palette region)
    // rgbToWallBlock maps this to smooth_sandstone or sandstone
    expect(result!.wallBlocks.length).toBeGreaterThanOrEqual(1);
    const hasSandstone = result!.wallBlocks.some(
      b => b.includes('sandstone') || b.includes('birch') || b.includes('end_stone'),
    );
    expect(hasSandstone).toBe(true);
    // wallColor should be set from the parsed hex
    expect(result!.wallColor).toEqual({ r: 203, g: 199, b: 172 });
  });

  it('returns null for gray colour #888A99 (maps to GRAY_FAMILY)', () => {
    // #888A99 = RGB(136, 138, 153) — blue-gray, maps to andesite/polished_andesite
    // resolveSemanticPalette should skip gray colours (diversity would decrease)
    const result = resolveSemanticPalette({ 'building:colour': '#888A99' }, 30);
    expect(result).toBeNull();
  });

  it('returns null for grey named colour', () => {
    // "gray" maps to RGB(128, 128, 128) → andesite → GRAY_FAMILY → skip
    const result = resolveSemanticPalette({ 'building:colour': 'gray' }, 10);
    expect(result).toBeNull();
  });

  it('returns glass curtain wall for 60m office building', () => {
    const result = resolveSemanticPalette({ building: 'office' }, 60);
    expect(result).not.toBeNull();
    expect(result!.source).toContain('glass curtain wall');
    expect(result!.wallBlocks).toContain('minecraft:white_stained_glass');
    expect(result!.wallBlocks).toContain('minecraft:light_gray_stained_glass');
    expect(result!.glassBlock).toBe('minecraft:white_stained_glass');
  });

  it('returns glass curtain wall for 65m building with type=yes (height heuristic)', () => {
    // Height > 60m triggers glass regardless of type
    const result = resolveSemanticPalette({ building: 'yes' }, 65);
    expect(result).not.toBeNull();
    expect(result!.source).toContain('glass curtain wall');
    expect(result!.wallBlocks).toContain('minecraft:white_stained_glass');
  });

  it('does NOT return glass for 55m building with type=yes (below 60m threshold)', () => {
    // Height 55m < 60m, type=yes is not a commercial type, so no glass
    const result = resolveSemanticPalette({ building: 'yes' }, 55);
    expect(result).toBeNull();
  });

  it('returns glass for 45m hotel (commercial type, >40m threshold)', () => {
    const result = resolveSemanticPalette({ building: 'hotel' }, 45);
    expect(result).not.toBeNull();
    expect(result!.source).toContain('glass curtain wall');
  });

  it('returns concrete palette for material=concrete', () => {
    const result = resolveSemanticPalette({ 'building:material': 'concrete' }, 15);
    expect(result).not.toBeNull();
    expect(result!.source).toContain('material=concrete');
    expect(result!.wallBlocks).toContain('minecraft:white_concrete');
    expect(result!.wallBlocks).toContain('minecraft:light_gray_concrete');
  });

  it('returns brick palette for material=brick', () => {
    const result = resolveSemanticPalette({ 'building:material': 'brick' }, 12);
    expect(result).not.toBeNull();
    expect(result!.source).toContain('material=brick');
    expect(result!.wallBlocks).toContain('minecraft:bricks');
  });

  it('colour takes priority over material (both present)', () => {
    // When both colour and material are present, colour drives primary block
    // but material adds variety options
    const result = resolveSemanticPalette({
      'building:colour': 'beige',
      'building:material': 'stone',
    }, 10);
    expect(result).not.toBeNull();
    expect(result!.source).toContain('building:colour');
    expect(result!.source).toContain('material=stone');
    // Palette should include blocks from both colour match + stone material
    expect(result!.wallBlocks.length).toBeGreaterThan(1);
  });

  it('handles roof:colour tag', () => {
    const result = resolveSemanticPalette({
      'building:colour': 'cream',
      'roof:colour': '#8B4513',
    }, 10);
    expect(result).not.toBeNull();
    // Roof colour should be parsed
    expect(result!.roofColor).toEqual({ r: 139, g: 69, b: 19 });
    expect(result!.roofBlocks).toBeDefined();
    expect(result!.roofBlocks!.length).toBeGreaterThanOrEqual(1);
  });

  it('returns modern commercial default for 35m retail building', () => {
    // 35m > 30m threshold, retail is a qualifying type
    const result = resolveSemanticPalette({ building: 'retail' }, 35);
    expect(result).not.toBeNull();
    expect(result!.source).toContain('modern commercial default');
    expect(result!.wallBlocks).toContain('minecraft:light_gray_concrete');
  });
});

// ─── applySemanticPalette ────────────────────────────────────────────────────

describe('applySemanticPalette', () => {
  it('replaces gray blocks with palette blocks', () => {
    const grid = makeGrid('minecraft:andesite');
    const palette: SemanticPalette = {
      wallBlocks: ['minecraft:bricks'],
      source: 'test',
    };

    const replaced = applySemanticPalette(grid, palette);
    expect(replaced).toBeGreaterThan(0);

    // Every non-air block should now be bricks (andesite was in GRAY_FAMILY)
    let brickCount = 0;
    for (let y = 0; y < 5; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          const block = grid.get(x, y, z);
          if (block === 'minecraft:bricks') brickCount++;
        }
      }
    }
    expect(brickCount).toBe(5 * 5 * 5); // All blocks replaced
  });

  it('preserves glass blocks (never overrides glass)', () => {
    const grid = new BlockGrid(5, 5, 5);
    // Fill with mix of andesite and glass
    for (let y = 0; y < 5; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          // Alternate: even x = andesite, odd x = glass
          if (x % 2 === 0) {
            grid.set(x, y, z, 'minecraft:andesite');
          } else {
            grid.set(x, y, z, 'minecraft:white_stained_glass');
          }
        }
      }
    }

    const palette: SemanticPalette = {
      wallBlocks: ['minecraft:bricks'],
      source: 'test',
    };
    applySemanticPalette(grid, palette);

    // Glass blocks should be untouched
    for (let y = 0; y < 5; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          const block = grid.get(x, y, z);
          if (x % 2 === 1) {
            expect(block).toBe('minecraft:white_stained_glass');
          }
        }
      }
    }
  });

  it('preserves blocks not in GRAY_FAMILY', () => {
    const grid = new BlockGrid(5, 5, 5);
    // Fill with non-gray blocks (bricks, terracotta, oak_planks)
    const nonGray = ['minecraft:bricks', 'minecraft:terracotta', 'minecraft:oak_planks'];
    for (let y = 0; y < 5; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          grid.set(x, y, z, nonGray[(x + z) % nonGray.length]);
        }
      }
    }

    const palette: SemanticPalette = {
      wallBlocks: ['minecraft:white_concrete'],
      source: 'test',
    };
    const replaced = applySemanticPalette(grid, palette);

    // Non-gray blocks should NOT be replaced by the primary pass
    // (checkerboard smoothing pass may replace some if boundary conditions trigger,
    // but non-gray blocks surrounded by other non-gray blocks should stay)
    // Verify original non-gray blocks are still present
    let nonGrayCount = 0;
    for (let y = 0; y < 5; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          const block = grid.get(x, y, z);
          if (nonGray.includes(block)) nonGrayCount++;
        }
      }
    }
    // All blocks should still be from the original set (no gray blocks to replace)
    expect(nonGrayCount).toBe(5 * 5 * 5);
    expect(replaced).toBe(0);
  });

  it('returns 0 when grid has only air', () => {
    const grid = new BlockGrid(5, 5, 5);
    const palette: SemanticPalette = {
      wallBlocks: ['minecraft:bricks'],
      source: 'test',
    };
    const replaced = applySemanticPalette(grid, palette);
    expect(replaced).toBe(0);
  });

  it('applies roof blocks to top layers and wall blocks to lower layers', () => {
    // Build a 5x10x5 grid to have meaningful roof/wall separation
    const grid = new BlockGrid(5, 10, 5);
    for (let y = 0; y < 10; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          grid.set(x, y, z, 'minecraft:andesite');
        }
      }
    }

    const palette: SemanticPalette = {
      wallBlocks: ['minecraft:bricks'],
      roofBlocks: ['minecraft:dark_prismarine'],
      source: 'test',
    };

    const replaced = applySemanticPalette(grid, palette);
    expect(replaced).toBeGreaterThan(0);

    // Bottom layer should be wall material (bricks)
    const bottomBlock = grid.get(2, 0, 2);
    expect(bottomBlock).toBe('minecraft:bricks');

    // Top layer should be roof material
    const topBlock = grid.get(2, 9, 2);
    expect(topBlock).toBe('minecraft:dark_prismarine');
  });
});
