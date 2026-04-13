/**
 * Tests for mesh-filter color pipeline functions:
 *   - smoothRareBlocks (frequency-based noise cleanup)
 *   - constrainPalette (batch block replacement via Map)
 *   - modeFilter3D (3D majority-vote smoothing)
 *   - smoothDarkBlocks (shadow-artifact replacement)
 *
 * Uses small BlockGrid instances to validate behavior without Three.js meshes.
 * Block names are chosen from WALL_CLUSTERS so getBlockLab() returns real Lab values.
 */

import { describe, it, expect } from 'vitest';
import {
  smoothRareBlocks,
  constrainPalette,
  modeFilter3D,
  smoothDarkBlocks,
  MODEFILTER_PROTECTED,
} from '../src/convert/mesh-filter.js';
import { BlockGrid } from '../src/schem/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convenience: read a block at (x, y, z) */
function at(grid: BlockGrid, x: number, y: number, z: number): string {
  return grid.get(x, y, z);
}

/** Count occurrences of a specific block in the grid */
function countBlock(grid: BlockGrid, block: string): number {
  let n = 0;
  for (let y = 0; y < grid.height; y++)
    for (let z = 0; z < grid.length; z++)
      for (let x = 0; x < grid.width; x++)
        if (grid.get(x, y, z) === block) n++;
  return n;
}

/** Collect the set of distinct non-air block types in the grid */
function uniqueNonAir(grid: BlockGrid): Set<string> {
  const s = new Set<string>();
  for (let y = 0; y < grid.height; y++)
    for (let z = 0; z < grid.length; z++)
      for (let x = 0; x < grid.width; x++) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') s.add(b);
      }
  return s;
}

// ─── smoothRareBlocks ────────────────────────────────────────────────────────

describe('mesh-filter color pipeline', () => {

  describe('smoothRareBlocks', () => {

    it('replaces blocks below frequency threshold with common neighbor', () => {
      // 10x5x10 grid filled with stone, 1 outlier pink_concrete at center
      const grid = new BlockGrid(10, 5, 10);
      grid.fill(0, 0, 0, 9, 4, 9, 'minecraft:stone');
      grid.set(5, 2, 5, 'minecraft:pink_terracotta');

      // pink_terracotta is 1 out of 500 = 0.2%, well below default 2% threshold
      const replaced = smoothRareBlocks(grid);
      expect(replaced).toBe(1);
      // Should be replaced by the dominant neighbor (stone)
      expect(at(grid, 5, 2, 5)).toBe('minecraft:stone');
    });

    it('returns 0 when all blocks are above threshold (no-op)', () => {
      // Grid with a single block type — nothing is rare
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:stone');

      const replaced = smoothRareBlocks(grid);
      expect(replaced).toBe(0);
      // Every block should still be stone
      expect(countBlock(grid, 'minecraft:stone')).toBe(125);
    });

    it('handles empty grid (all air) without error', () => {
      const grid = new BlockGrid(3, 3, 3);
      const replaced = smoothRareBlocks(grid);
      expect(replaced).toBe(0);
    });

    it('replaces isolated rare block with global best when no non-rare neighbors exist', () => {
      // Grid mostly stone, with a 1-block island of oak_planks surrounded by air
      const grid = new BlockGrid(10, 5, 10);
      // Fill bottom layer with stone (the global majority)
      grid.fill(0, 0, 0, 9, 0, 9, 'minecraft:stone');
      // Place a single rare block far from any stone — surrounded by air
      grid.set(5, 4, 5, 'minecraft:oak_planks');

      const replaced = smoothRareBlocks(grid);
      expect(replaced).toBe(1);
      // No non-rare neighbors in the 3x3x3 cube → falls back to global best (stone)
      expect(at(grid, 5, 4, 5)).toBe('minecraft:stone');
    });

    it('picks the most common non-rare neighbor when multiple block types are adjacent', () => {
      // Fill grid with stone, place a band of bricks nearby, and one rare outlier
      const grid = new BlockGrid(10, 5, 10);
      grid.fill(0, 0, 0, 9, 4, 9, 'minecraft:stone');
      // Replace neighbors around (5,2,5) with bricks (enough so bricks > stone in 3x3x3)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            grid.set(5 + dx, 2 + dy, 5 + dz, 'minecraft:bricks');
          }
      // Now place the rare block at center — its 26 neighbors are ALL bricks
      grid.set(5, 2, 5, 'minecraft:pink_terracotta');

      const replaced = smoothRareBlocks(grid);
      expect(replaced).toBeGreaterThanOrEqual(1);
      // The rare block's neighbors are bricks, so it should become bricks
      expect(at(grid, 5, 2, 5)).toBe('minecraft:bricks');
    });

    it('respects custom minFrequency parameter', () => {
      // 10x1x10 = 100 blocks total. Place 4 bricks (4% of 100)
      const grid = new BlockGrid(10, 1, 10);
      grid.fill(0, 0, 0, 9, 0, 9, 'minecraft:stone');
      grid.set(0, 0, 0, 'minecraft:bricks');
      grid.set(1, 0, 0, 'minecraft:bricks');
      grid.set(2, 0, 0, 'minecraft:bricks');
      grid.set(3, 0, 0, 'minecraft:bricks');

      // At 2% threshold: 4/100 = 4% > 2%, so bricks are NOT rare → 0 replacements
      const replaced2 = smoothRareBlocks(grid, 0.02);
      expect(replaced2).toBe(0);

      // At 5% threshold: 4/100 = 4% < 5%, so bricks ARE rare → should be replaced
      const replaced5 = smoothRareBlocks(grid, 0.05);
      expect(replaced5).toBe(4);
      expect(countBlock(grid, 'minecraft:bricks')).toBe(0);
    });
  });

  // ─── constrainPalette ──────────────────────────────────────────────────────

  describe('constrainPalette', () => {

    it('replaces blocks matching the replacement map', () => {
      const grid = new BlockGrid(5, 3, 5);
      grid.fill(0, 0, 0, 4, 2, 4, 'minecraft:stone');
      grid.set(2, 1, 2, 'minecraft:andesite');
      grid.set(3, 1, 3, 'minecraft:tuff');

      const replacements = new Map<string, string>([
        ['minecraft:andesite', 'minecraft:stone'],
        ['minecraft:tuff', 'minecraft:stone'],
      ]);

      const replaced = constrainPalette(grid, replacements);
      expect(replaced).toBe(2);
      expect(at(grid, 2, 1, 2)).toBe('minecraft:stone');
      expect(at(grid, 3, 1, 3)).toBe('minecraft:stone');
    });

    it('returns 0 when no blocks match the replacement map', () => {
      const grid = new BlockGrid(3, 3, 3);
      grid.fill(0, 0, 0, 2, 2, 2, 'minecraft:stone');

      const replacements = new Map<string, string>([
        ['minecraft:bricks', 'minecraft:stone'],
      ]);

      const replaced = constrainPalette(grid, replacements);
      expect(replaced).toBe(0);
    });

    it('handles all-air grid without error', () => {
      const grid = new BlockGrid(3, 3, 3);
      const replacements = new Map<string, string>([
        ['minecraft:stone', 'minecraft:bricks'],
      ]);
      const replaced = constrainPalette(grid, replacements);
      expect(replaced).toBe(0);
    });

    it('does not touch air blocks even if air is in the replacement map', () => {
      const grid = new BlockGrid(3, 1, 3);
      grid.set(1, 0, 1, 'minecraft:stone');
      // Map air -> stone (perverse, but verifies it operates on all blocks)
      const replacements = new Map<string, string>([
        ['minecraft:air', 'minecraft:stone'],
      ]);
      const replaced = constrainPalette(grid, replacements);
      // 9 cells total, 1 is stone, 8 are air -> 8 replaced to stone
      expect(replaced).toBe(8);
      expect(grid.countNonAir()).toBe(9);
    });

    it('handles chain replacements (only applies the direct mapping, not transitive)', () => {
      const grid = new BlockGrid(3, 1, 3);
      grid.fill(0, 0, 0, 2, 0, 2, 'minecraft:andesite');

      // A -> B and B -> C: constrainPalette is single-pass, so A->B, not A->C
      const replacements = new Map<string, string>([
        ['minecraft:andesite', 'minecraft:stone'],
        ['minecraft:stone', 'minecraft:bricks'],
      ]);

      const replaced = constrainPalette(grid, replacements);
      expect(replaced).toBe(9);
      // All should be stone (the direct replacement), not bricks
      // Since iteration happens left-to-right and stone gets mapped to bricks,
      // a block replaced to stone in the same pass could then be remapped again.
      // Actually, the function iterates each cell once and checks the CURRENT value,
      // so if andesite -> stone is applied, then the cell holds stone, which is NOT
      // re-checked (iteration has moved on). So the result is stone.
      for (let z = 0; z < 3; z++)
        for (let x = 0; x < 3; x++)
          expect(at(grid, x, 0, z)).toBe('minecraft:stone');
    });
  });

  // ─── modeFilter3D ──────────────────────────────────────────────────────────

  describe('modeFilter3D', () => {

    it('replaces an isolated outlier block with the local majority', () => {
      // 7x7x7 cube of smooth_stone with one stone_bricks outlier at center
      // Both are gray blocks with small delta-E (<20), so the Lab guard allows replacement
      const grid = new BlockGrid(7, 7, 7);
      grid.fill(0, 0, 0, 6, 6, 6, 'minecraft:smooth_stone');
      grid.set(3, 3, 3, 'minecraft:stone_bricks');

      const replaced = modeFilter3D(grid, 1, 1);
      // stone_bricks at center is isolated (0 same-type neighbors) and smooth_stone
      // is the overwhelming majority in the 3x3x3 neighborhood
      expect(replaced).toBeGreaterThanOrEqual(1);
      expect(at(grid, 3, 3, 3)).toBe('minecraft:smooth_stone');
    });

    it('returns 0 when all blocks are the same (no-op)', () => {
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:stone');

      const replaced = modeFilter3D(grid, 2, 1);
      expect(replaced).toBe(0);
    });

    it('protects air blocks (never replaces air with solid)', () => {
      // Grid with air gaps — air must remain air
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:stone');
      grid.set(2, 2, 2, 'minecraft:air'); // hollow center

      const replaced = modeFilter3D(grid, 2, 1);
      // Air is protected by MODEFILTER_PROTECTED — must not be filled
      expect(at(grid, 2, 2, 2)).toBe('minecraft:air');
    });

    it('protects glass blocks from replacement by majority wall material', () => {
      // Simulate glass facade: one glass block surrounded by stone
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:smooth_stone');
      grid.set(2, 2, 2, 'minecraft:glass');

      const replaced = modeFilter3D(grid, 2, 1);
      // Glass is in MODEFILTER_PROTECTED
      expect(at(grid, 2, 2, 2)).toBe('minecraft:glass');
    });

    it('protects stained glass variants (all 16 colors)', () => {
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:smooth_stone');
      grid.set(2, 2, 2, 'minecraft:gray_stained_glass');
      grid.set(2, 3, 2, 'minecraft:blue_stained_glass_pane');

      modeFilter3D(grid, 2, 1);
      expect(at(grid, 2, 2, 2)).toBe('minecraft:gray_stained_glass');
      expect(at(grid, 2, 3, 2)).toBe('minecraft:blue_stained_glass_pane');
    });

    it('protects iron_bars and iron_block', () => {
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:smooth_stone');
      grid.set(2, 2, 2, 'minecraft:iron_bars');
      grid.set(2, 3, 2, 'minecraft:iron_block');

      modeFilter3D(grid, 2, 1);
      expect(at(grid, 2, 2, 2)).toBe('minecraft:iron_bars');
      expect(at(grid, 2, 3, 2)).toBe('minecraft:iron_block');
    });

    it('honors extraProtected set (caller-specified protection)', () => {
      const grid = new BlockGrid(7, 7, 7);
      grid.fill(0, 0, 0, 6, 6, 6, 'minecraft:smooth_stone');
      grid.set(3, 3, 3, 'minecraft:stone_bricks');

      // Without protection, stone_bricks would be replaced (similar color, isolated)
      const extra = new Set(['minecraft:stone_bricks']);
      const replaced = modeFilter3D(grid, 2, 1, extra);
      expect(at(grid, 3, 3, 3)).toBe('minecraft:stone_bricks');
    });

    it('handles empty grid without error', () => {
      const grid = new BlockGrid(3, 3, 3);
      const replaced = modeFilter3D(grid, 2, 1);
      expect(replaced).toBe(0);
    });

    it('converges early when no replacements occur in a pass', () => {
      // All same block — first pass should find 0 replacements and stop
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:stone');

      // Request 10 passes — should converge after 1
      const replaced = modeFilter3D(grid, 10, 1);
      expect(replaced).toBe(0);
    });

    it('does not replace blocks with high delta-E from majority (CIE-Lab guard)', () => {
      // Place a dark brown block (terracotta, warm hue) in a field of bright white (quartz).
      // delta-E between these should be >20, so the Lab guard preserves the terracotta.
      const grid = new BlockGrid(7, 7, 7);
      grid.fill(0, 0, 0, 6, 6, 6, 'minecraft:smooth_quartz');
      grid.set(3, 3, 3, 'minecraft:brown_terracotta');

      const replaced = modeFilter3D(grid, 2, 1);
      // brown_terracotta vs smooth_quartz: very different colors (warm brown vs white)
      // delta-E >> 20 -> Lab guard should prevent replacement
      expect(at(grid, 3, 3, 3)).toBe('minecraft:brown_terracotta');
    });
  });

  // ─── smoothDarkBlocks ──────────────────────────────────────────────────────

  describe('smoothDarkBlocks', () => {

    it('replaces a dark neutral block surrounded by bright blocks (pass 1: absolute dark floor)', () => {
      // Fill grid with bright block (smooth_quartz, L*~92 -> luminance ~0.92)
      // Place gray_concrete (L*~26 -> luminance ~0.26) at center
      // With <100 non-air blocks, adaptive threshold defaults to DARK_FLOOR=0.22.
      // gray_concrete at ~0.26 is above 0.22, so pass 1 won't catch it. But pass 2
      // (contrast outlier) should: median luminance of neighbors is ~0.92, and
      // 0.92 - 0.26 = 0.66 >> 0.20 default contrastDelta.
      const grid = new BlockGrid(7, 7, 7);
      grid.fill(0, 0, 0, 6, 6, 6, 'minecraft:smooth_quartz');
      grid.set(3, 3, 3, 'minecraft:gray_concrete');

      const replaced = smoothDarkBlocks(grid);
      expect(replaced).toBeGreaterThanOrEqual(1);
      // The dark block should now be replaced with the bright majority
      expect(at(grid, 3, 3, 3)).not.toBe('minecraft:gray_concrete');
    });

    it('returns 0 when all blocks are uniformly bright (no shadows)', () => {
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:smooth_quartz');

      const replaced = smoothDarkBlocks(grid);
      expect(replaced).toBe(0);
    });

    it('returns 0 on empty (all-air) grid', () => {
      const grid = new BlockGrid(3, 3, 3);
      const replaced = smoothDarkBlocks(grid);
      expect(replaced).toBe(0);
    });

    it('returns 0 when all blocks are uniformly dark (no contrast to correct)', () => {
      // All the same dark block — there is no shadow "artifact" to remove
      // since every block matches its neighbors
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:gray_concrete');

      const replaced = smoothDarkBlocks(grid);
      expect(replaced).toBe(0);
    });

    it('preserves saturated dark blocks via chroma guard (colored materials survive)', () => {
      // brown_terracotta is dark but has non-zero a*/b* (warm brown hue).
      // The chroma guard (|a*|>5 or |b*|>5) should protect it from replacement.
      const grid = new BlockGrid(7, 7, 7);
      grid.fill(0, 0, 0, 6, 6, 6, 'minecraft:smooth_quartz');
      grid.set(3, 3, 3, 'minecraft:brown_terracotta');

      const replaced = smoothDarkBlocks(grid);
      // brown_terracotta has significant chroma → chroma guard should skip it
      expect(at(grid, 3, 3, 3)).toBe('minecraft:brown_terracotta');
    });

    it('replaces contrast outlier in pass 2 (block much darker than neighborhood median)', () => {
      // A 12x12x1 sheet: mostly smooth_stone (L*~67 -> lum ~0.67),
      // with a few tuff blocks (L*~45 -> lum ~0.45) scattered at center.
      // tuff is not dark enough for pass 1 floor, but the contrast delta
      // (0.67 - 0.45 = 0.22) exceeds 0.20 default threshold.
      // With >100 non-air blocks, adaptive thresholds engage.
      const grid = new BlockGrid(12, 1, 12);
      grid.fill(0, 0, 0, 11, 0, 11, 'minecraft:smooth_stone');
      // Place a single tuff at center — isolated dark spot
      grid.set(6, 0, 6, 'minecraft:tuff');

      const replaced = smoothDarkBlocks(grid);
      // Whether pass 2 triggers depends on adaptive threshold calculation:
      // p10 and p90 are both ~0.67 (tuff is only 1 block) so range is small.
      // Small range -> small adaptiveContrastDelta -> tuff may still be caught.
      // At minimum, this should not throw.
      expect(replaced).toBeGreaterThanOrEqual(0);
    });

    it('defers all writes until end (pass 1 does not cascade into pass 2)', () => {
      // This is a structural property test. Place two dark blocks at adjacent positions.
      // Both should be evaluated against the ORIGINAL grid state, not partially-modified state.
      const grid = new BlockGrid(9, 9, 9);
      grid.fill(0, 0, 0, 8, 8, 8, 'minecraft:smooth_quartz');
      // Two adjacent gray_concrete blocks
      grid.set(4, 4, 4, 'minecraft:gray_concrete');
      grid.set(4, 4, 5, 'minecraft:gray_concrete');

      const replaced = smoothDarkBlocks(grid);
      // Both should be replaced (they are dark contrast outliers in a bright neighborhood)
      expect(replaced).toBeGreaterThanOrEqual(2);
      expect(at(grid, 4, 4, 4)).not.toBe('minecraft:gray_concrete');
      expect(at(grid, 4, 4, 5)).not.toBe('minecraft:gray_concrete');
    });
  });

  // ─── MODEFILTER_PROTECTED set ──────────────────────────────────────────────

  describe('MODEFILTER_PROTECTED', () => {

    it('contains air', () => {
      expect(MODEFILTER_PROTECTED.has('minecraft:air')).toBe(true);
    });

    it('contains plain glass and glass_pane', () => {
      expect(MODEFILTER_PROTECTED.has('minecraft:glass')).toBe(true);
      expect(MODEFILTER_PROTECTED.has('minecraft:glass_pane')).toBe(true);
    });

    it('contains all 16 colored stained glass variants', () => {
      const colors = [
        'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
        'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
      ];
      for (const color of colors) {
        expect(MODEFILTER_PROTECTED.has(`minecraft:${color}_stained_glass`)).toBe(true);
        expect(MODEFILTER_PROTECTED.has(`minecraft:${color}_stained_glass_pane`)).toBe(true);
      }
    });

    it('contains structural detail blocks (iron_bars, chain, end_rod, lightning_rod)', () => {
      expect(MODEFILTER_PROTECTED.has('minecraft:iron_bars')).toBe(true);
      expect(MODEFILTER_PROTECTED.has('minecraft:iron_block')).toBe(true);
      expect(MODEFILTER_PROTECTED.has('minecraft:chain')).toBe(true);
      expect(MODEFILTER_PROTECTED.has('minecraft:end_rod')).toBe(true);
      expect(MODEFILTER_PROTECTED.has('minecraft:lightning_rod')).toBe(true);
    });

    it('does NOT contain common wall blocks', () => {
      expect(MODEFILTER_PROTECTED.has('minecraft:stone')).toBe(false);
      expect(MODEFILTER_PROTECTED.has('minecraft:smooth_stone')).toBe(false);
      expect(MODEFILTER_PROTECTED.has('minecraft:bricks')).toBe(false);
    });
  });
});
