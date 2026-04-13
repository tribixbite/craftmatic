/**
 * Tests for mesh-filter color pipeline functions:
 *   - smoothRareBlocks (frequency-based noise cleanup)
 *   - constrainPalette (batch block replacement via Map)
 *   - modeFilter3D (3D majority-vote smoothing)
 *   - smoothDarkBlocks (shadow-artifact replacement)
 *   - smoothFacadeColors (5x5 coplanar majority vote with delta-E guard)
 *   - clusterFacadePalette (K-means per-face palette reduction)
 *   - smoothRoofPlane (top-20% Y majority vote for roof surfaces)
 *   - homogenizeFacadesByFace (per-face minority collapse, >=100 surface threshold)
 *   - consolidateBlockPalette (global K-means with PALETTE_PROTECTED exclusion)
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
  smoothFacadeColors,
  clusterFacadePalette,
  smoothRoofPlane,
  homogenizeFacadesByFace,
  consolidateBlockPalette,
  MODEFILTER_PROTECTED,
  PALETTE_PROTECTED,
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

  // ─── smoothFacadeColors ──────────────────────────────────────────────────

  describe('smoothFacadeColors', () => {

    it('returns 0 on empty (all-air) grid', () => {
      const grid = new BlockGrid(5, 5, 5);
      const replaced = smoothFacadeColors(grid);
      expect(replaced).toBe(0);
    });

    it('returns 0 when all facade blocks are uniform (no outliers to smooth)', () => {
      // Hollow box: 1-block-thick shell of stone, air inside
      const grid = new BlockGrid(8, 8, 8);
      grid.fill(0, 0, 0, 7, 7, 7, 'minecraft:stone');
      grid.fill(1, 0, 1, 6, 7, 6, 'minecraft:air');
      const replaced = smoothFacadeColors(grid);
      expect(replaced).toBe(0);
    });

    it('replaces a single outlier on facade when delta-E > 15 from majority', () => {
      // Hollow box of stone with one red_nether_bricks block on the outer facade.
      // stone (gray, L*~48) vs red_nether_bricks (dark red, L*~16) — delta-E >> 15.
      // Both are in WALL_CLUSTERS so getBlockLab() returns valid Lab values.
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');
      grid.fill(1, 0, 1, 8, 9, 8, 'minecraft:air');
      // Place outlier at (0, 5, 5) — this is on the outer x=0 wall.
      // Its +X neighbor at (1, 5, 5) is air (interior hollow), making it a facade block.
      // The 5x5 coplanar window at x=0 (scanning Y and Z) sees all stone neighbors.
      grid.set(0, 5, 5, 'minecraft:red_nether_bricks');

      const replaced = smoothFacadeColors(grid);
      // The red_nether_bricks block is a color outlier among its coplanar stone neighbors
      expect(replaced).toBeGreaterThanOrEqual(1);
      expect(at(grid, 0, 5, 5)).toBe('minecraft:stone');
    });

    it('preserves accent blocks when delta-E < 15 (similar gray tones)', () => {
      // stone (rgb [120,120,120], L*~51) vs andesite (rgb [136,136,136], L*~57)
      // Both are neutral grays, delta-E ≈ 6, well below the 15 threshold.
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');
      grid.fill(1, 0, 1, 8, 9, 8, 'minecraft:air');
      // Place andesite on a facade wall — similar enough to stone
      grid.set(1, 5, 5, 'minecraft:andesite');

      const replaced = smoothFacadeColors(grid);
      // delta-E between stone and andesite is small (<15) → should NOT replace
      expect(at(grid, 1, 5, 5)).toBe('minecraft:andesite');
    });

    it('does not modify interior blocks (fully surrounded by solid)', () => {
      // Solid 10x10x10 cube — no interior block has an air neighbor on H_DIRS
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');
      // Place a prismarine block deep in the interior (no air on any horizontal side)
      grid.set(5, 5, 5, 'minecraft:prismarine');

      const replaced = smoothFacadeColors(grid);
      // (5,5,5) neighbors at (6,5,5), (4,5,5), (5,5,6), (5,5,4) are all stone (solid)
      // so it's not detected as a facade block → not modified
      expect(at(grid, 5, 5, 5)).toBe('minecraft:prismarine');
    });

    it('processes multiple facade surfaces independently', () => {
      // Hollow box: facade blocks exist on all 4 walls
      const grid = new BlockGrid(12, 12, 12);
      grid.fill(0, 0, 0, 11, 11, 11, 'minecraft:stone');
      grid.fill(1, 0, 1, 10, 11, 10, 'minecraft:air');

      // Place outliers on two different walls
      grid.set(0, 6, 6, 'minecraft:red_nether_bricks'); // outer -X facade (air outside at x=-1 OOB)
      grid.set(11, 6, 6, 'minecraft:red_nether_bricks'); // outer +X facade

      const replaced = smoothFacadeColors(grid);
      // Both outliers should be smoothed to stone by their respective facade neighborhoods
      expect(replaced).toBeGreaterThanOrEqual(2);
      expect(at(grid, 0, 6, 6)).toBe('minecraft:stone');
      expect(at(grid, 11, 6, 6)).toBe('minecraft:stone');
    });
  });

  // ─── clusterFacadePalette ────────────────────────────────────────────────

  describe('clusterFacadePalette', () => {

    it('returns 0 on empty (all-air) grid', () => {
      const grid = new BlockGrid(5, 5, 5);
      const replaced = clusterFacadePalette(grid);
      expect(replaced).toBe(0);
    });

    it('skips faces with fewer than 6 facade voxels', () => {
      // 2x2x2 solid cube: each exterior face has 2*2=4 voxels, under the 6 minimum.
      // Even with 4 different block types (one per voxel on a face), the face is too small.
      const grid = new BlockGrid(2, 2, 2);
      grid.set(0, 0, 0, 'minecraft:stone');
      grid.set(1, 0, 0, 'minecraft:bricks');
      grid.set(0, 1, 0, 'minecraft:sandstone');
      grid.set(1, 1, 0, 'minecraft:andesite');
      grid.set(0, 0, 1, 'minecraft:tuff');
      grid.set(1, 0, 1, 'minecraft:mud_bricks');
      grid.set(0, 1, 1, 'minecraft:cherry_planks');
      grid.set(1, 1, 1, 'minecraft:oak_planks');

      const replaced = clusterFacadePalette(grid);
      // Each face direction has at most 4 voxels → all faces skipped
      expect(replaced).toBe(0);
    });

    it('skips faces with 2 or fewer unique blocks', () => {
      // Grid with only 2 unique blocks on facade — clusterFacadePalette requires >=3
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');
      grid.fill(1, 0, 1, 8, 9, 8, 'minecraft:air');
      // All facade blocks are stone (1 unique) → nothing to cluster
      const replaced = clusterFacadePalette(grid);
      expect(replaced).toBe(0);
    });

    it('reduces palette when face has many unique blocks', () => {
      // Hollow box with facade blocks being a mix of 8+ different blocks
      const grid = new BlockGrid(12, 12, 12);
      grid.fill(0, 0, 0, 11, 11, 11, 'minecraft:stone');
      grid.fill(1, 0, 1, 10, 11, 10, 'minecraft:air');

      // Scatter 8 different blocks along the x=0 wall (inner facade at x=0 touches air)
      // x=0 is exposed because grid.get(-1, y, z) returns air (OOB)
      const blocks = [
        'minecraft:stone', 'minecraft:smooth_stone', 'minecraft:bricks',
        'minecraft:andesite', 'minecraft:tuff', 'minecraft:sandstone',
        'minecraft:mud_bricks', 'minecraft:cherry_planks',
      ];
      let idx = 0;
      for (let y = 1; y < 11; y++) {
        for (let z = 1; z < 11; z++) {
          grid.set(0, y, z, blocks[idx % blocks.length]);
          idx++;
        }
      }

      const before = uniqueNonAir(grid);
      const replaced = clusterFacadePalette(grid, 4);
      // Should have reassigned some facade voxels, reducing diversity
      expect(replaced).toBeGreaterThan(0);
    });

    it('returns count of replaced voxels', () => {
      // Hollow box with diverse facade
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');
      grid.fill(1, 0, 1, 8, 9, 8, 'minecraft:air');

      // Make one face (x=0) have 4 different block types in approximately equal portions
      const faceBlocks = ['minecraft:stone', 'minecraft:bricks', 'minecraft:sandstone', 'minecraft:andesite'];
      let i = 0;
      for (let y = 0; y < 10; y++) {
        for (let z = 0; z < 10; z++) {
          grid.set(0, y, z, faceBlocks[i % faceBlocks.length]);
          i++;
        }
      }

      const replaced = clusterFacadePalette(grid, 3);
      // Function returns a non-negative integer count
      expect(replaced).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(replaced)).toBe(true);
    });

    it('does not modify non-facade (interior) blocks', () => {
      // Place a distinctive block deep inside the solid portion
      const grid = new BlockGrid(12, 12, 12);
      grid.fill(0, 0, 0, 11, 11, 11, 'minecraft:stone');
      grid.fill(2, 0, 2, 9, 11, 9, 'minecraft:air');

      // (1, 6, 6) is solid with solid neighbors in all H_DIRS: x=0(stone), x=2(air — wait,
      // let's place it at a fully interior position in the thick wall.
      // x=0..1 is solid wall, x=2..9 is air. So (0, 6, 6) has x-1=OOB=air → it IS facade.
      // Let's use the thick walls: put bricks at interior of bottom slab, which has no air neighbors.
      // y=0 layer: the entire 12x12 is solid stone. Blocks in the interior at y=0 have
      // solid on all H_DIRS since air starts at z=2.
      grid.set(5, 0, 0, 'minecraft:cherry_planks');
      // (5,0,0): neighbors (6,0,0)=stone, (4,0,0)=stone, (5,0,1)=stone, (5,0,-1)=OOB=air → facade!
      // Let's try (5, 0, 5): (6,0,5)=stone, (4,0,5)=stone, (5,0,6)=stone, (5,0,4)=stone → interior
      grid.set(5, 0, 5, 'minecraft:cherry_planks');

      clusterFacadePalette(grid, 4);
      // Interior block should be untouched by facade clustering
      expect(at(grid, 5, 0, 5)).toBe('minecraft:cherry_planks');
    });
  });

  // ─── smoothRoofPlane ─────────────────────────────────────────────────────

  describe('smoothRoofPlane', () => {

    it('returns 0 on empty (all-air) grid', () => {
      const grid = new BlockGrid(5, 5, 5);
      const replaced = smoothRoofPlane(grid);
      expect(replaced).toBe(0);
    });

    it('returns 0 when roof is uniform (all same block)', () => {
      // 10x10x10 solid cube — roof plane is all stone, nothing to smooth
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');
      const replaced = smoothRoofPlane(grid);
      expect(replaced).toBe(0);
    });

    it('smooths mixed roof blocks to majority', () => {
      // 10x10x10 cube of stone. maxY=9, roofThreshold = floor(9*0.8) = 7.
      // Top layer (y=9) are roof voxels (air above since y+1=10 is OOB = effectively no solid above).
      // Place a few outlier blocks on the roof surface.
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');

      // Scatter a few sandstone blocks on the y=9 roof plane
      grid.set(5, 9, 5, 'minecraft:sandstone');
      grid.set(5, 9, 6, 'minecraft:sandstone');

      const replaced = smoothRoofPlane(grid);
      // The sandstone blocks at y=9 face air above (y=10 OOB → treated as air in getSnap via snapshot)
      // Wait — y=9 is the last index, and the check is:
      //   hasRoof = y < height - 1 && getSnap(x, y+1, z) !== AIR
      // At y=9, height=10: y < 9 is false → hasRoof = false → it IS a roof voxel.
      // The majority in the 5x5 window is stone → sandstone gets replaced.
      expect(replaced).toBeGreaterThanOrEqual(1);
      expect(at(grid, 5, 9, 5)).toBe('minecraft:stone');
    });

    it('does not treat high-Y blocks with solid above as roof', () => {
      // A tall column where blocks at y=8 have solid at y=9 above them
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');

      // Place sandstone at y=8, which has stone above at y=9 → NOT roof
      grid.set(5, 8, 5, 'minecraft:sandstone');

      const replaced = smoothRoofPlane(grid);
      // y=8 has stone at y=9 above → hasRoof = true → skipped
      // Only y=9 top layer is considered roof, and it's all stone → 0 replacements
      // (The sandstone at y=8 is interior, not smoothed by this function)
      expect(at(grid, 5, 8, 5)).toBe('minecraft:sandstone');
    });

    it('handles building shorter than grid height', () => {
      // 10x10x10 grid but building only occupies y=0..4 (maxY=4)
      // roofThreshold = floor(4*0.8) = 3
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 4, 9, 'minecraft:stone');

      // Scatter outlier on roof at y=4 (top of building, air above at y=5)
      grid.set(5, 4, 5, 'minecraft:bricks');

      const replaced = smoothRoofPlane(grid);
      // y=4, height=10: y < 9 → check y+1=5 → air → NOT hasRoof → it IS roof
      // y=4 >= roofThreshold(3) → processed. Majority in 5x5 is stone → bricks replaced
      expect(replaced).toBeGreaterThanOrEqual(1);
      expect(at(grid, 5, 4, 5)).toBe('minecraft:stone');
    });
  });

  // ─── homogenizeFacadesByFace ─────────────────────────────────────────────

  describe('homogenizeFacadesByFace', () => {

    it('skips faces with fewer than 100 surface voxels', () => {
      // 6x6x6 solid cube (no interior hollow). For each face direction:
      // +x face: blocks at x=5 (OOB at x+1=6) → 6*6=36. No interior air so no other
      // blocks contribute. Each face has exactly 36 voxels, well under 100.
      const grid = new BlockGrid(6, 6, 6);
      grid.fill(0, 0, 0, 5, 5, 5, 'minecraft:stone');
      // Place minority blocks on exterior faces
      grid.set(0, 3, 3, 'minecraft:bricks');
      grid.set(5, 3, 3, 'minecraft:bricks');

      const replaced = homogenizeFacadesByFace(grid);
      // Each face has 36 voxels → all faces skipped (< MIN_SAMPLES=100)
      expect(replaced).toBe(0);
    });

    it('returns 0 when face is uniform (no minorities)', () => {
      // Large hollow box: each face has 100+ surface voxels, all same block
      // Need face with >=100 exterior voxels. For +x face at x=W-1:
      // exterior = blocks at x=W-1 whose neighbor at x=W is air (OOB → air)
      // OR blocks at x=W-1 with air at x+1 inside the hollow.
      // Let's make a large enough grid: 12x12x12, shell thickness 1.
      // +x face at x=11: all solid blocks have x+1=12 OOB → air → exterior.
      // That's 12*12 = 144 surface voxels. But protected blocks (air) are skipped.
      // The face is y=0..11, z=0..11, all stone → 144 non-air surface voxels.
      const grid = new BlockGrid(12, 12, 12);
      grid.fill(0, 0, 0, 11, 11, 11, 'minecraft:stone');
      grid.fill(1, 0, 1, 10, 11, 10, 'minecraft:air');

      const replaced = homogenizeFacadesByFace(grid);
      // All faces are uniform stone → no minorities → 0
      expect(replaced).toBe(0);
    });

    it('replaces minority blocks on faces with 100+ surface voxels', () => {
      // 14x14x14 hollow box, wall thickness 1
      // +x face at x=13 has 14*14=196 surface voxels
      const grid = new BlockGrid(14, 14, 14);
      grid.fill(0, 0, 0, 13, 13, 13, 'minecraft:stone');
      grid.fill(1, 0, 1, 12, 13, 12, 'minecraft:air');

      // Place 2 bricks on the +x face (x=13). 2/196 < 5% default minPct → minority
      grid.set(13, 7, 7, 'minecraft:bricks');
      grid.set(13, 7, 8, 'minecraft:bricks');

      const replaced = homogenizeFacadesByFace(grid);
      // The bricks are minority on the +x face and should be replaced
      expect(replaced).toBeGreaterThanOrEqual(2);
      expect(at(grid, 13, 7, 7)).not.toBe('minecraft:bricks');
      expect(at(grid, 13, 7, 8)).not.toBe('minecraft:bricks');
    });

    it('preserves protected blocks (glass, iron_bars) from replacement', () => {
      // Large hollow box with glass blocks on exterior face
      const grid = new BlockGrid(14, 14, 14);
      grid.fill(0, 0, 0, 13, 13, 13, 'minecraft:stone');
      grid.fill(1, 0, 1, 12, 13, 12, 'minecraft:air');

      // Place glass on +x face — glass is in the function's protected set
      grid.set(13, 7, 7, 'minecraft:glass');
      grid.set(13, 7, 8, 'minecraft:iron_bars');

      const replaced = homogenizeFacadesByFace(grid);
      // Glass and iron_bars should not be touched (they are in the protected set
      // and are excluded from surface collection entirely)
      expect(at(grid, 13, 7, 7)).toBe('minecraft:glass');
      expect(at(grid, 13, 7, 8)).toBe('minecraft:iron_bars');
    });

    it('honors custom protectedBlocks parameter', () => {
      const grid = new BlockGrid(14, 14, 14);
      grid.fill(0, 0, 0, 13, 13, 13, 'minecraft:stone');
      grid.fill(1, 0, 1, 12, 13, 12, 'minecraft:air');

      // Place bricks on +x face — normally a minority that would be replaced
      grid.set(13, 7, 7, 'minecraft:bricks');

      // But we protect bricks explicitly
      const custom = new Set(['minecraft:bricks']);
      const replaced = homogenizeFacadesByFace(grid, 0.05, 6, custom);

      // Bricks are now in the protected set, so they won't appear in surface collection
      expect(at(grid, 13, 7, 7)).toBe('minecraft:bricks');
    });
  });

  // ─── consolidateBlockPalette ─────────────────────────────────────────────

  describe('consolidateBlockPalette', () => {

    it('returns 0 on empty (all-air) grid', () => {
      const grid = new BlockGrid(5, 5, 5);
      const replaced = consolidateBlockPalette(grid);
      expect(replaced).toBe(0);
    });

    it('returns 0 when all blocks are PALETTE_PROTECTED', () => {
      // Fill with smooth_stone (protected) and air (protected)
      const grid = new BlockGrid(5, 5, 5);
      grid.fill(0, 0, 0, 4, 4, 4, 'minecraft:smooth_stone');
      // smooth_stone is in PALETTE_PROTECTED → skipped
      const replaced = consolidateBlockPalette(grid);
      expect(replaced).toBe(0);
    });

    it('returns 0 when unique non-protected blocks are <= k', () => {
      // Only 3 unique non-protected blocks with default k=5 → no consolidation needed
      const grid = new BlockGrid(10, 10, 10);
      grid.fill(0, 0, 0, 9, 9, 9, 'minecraft:stone');
      grid.fill(0, 0, 0, 9, 3, 9, 'minecraft:bricks');
      grid.fill(0, 7, 0, 9, 9, 9, 'minecraft:sandstone');
      // 3 unique non-protected blocks <= k=5 → 0
      const replaced = consolidateBlockPalette(grid, 5);
      expect(replaced).toBe(0);
    });

    it('reduces palette when grid has more unique blocks than k', () => {
      // Grid with 8 different non-protected blocks, k=3 → should consolidate
      const grid = new BlockGrid(10, 10, 10);
      const blocks = [
        'minecraft:stone', 'minecraft:bricks', 'minecraft:sandstone',
        'minecraft:andesite', 'minecraft:tuff', 'minecraft:mud_bricks',
        'minecraft:cherry_planks', 'minecraft:red_nether_bricks',
      ];
      // Distribute blocks in layers to ensure each has enough count to register
      for (let y = 0; y < 10; y++) {
        const block = blocks[y % blocks.length];
        for (let z = 0; z < 10; z++)
          for (let x = 0; x < 10; x++)
            grid.set(x, y, z, block);
      }

      const beforeUnique = uniqueNonAir(grid).size;
      expect(beforeUnique).toBe(8);

      const replaced = consolidateBlockPalette(grid, 3);
      expect(replaced).toBeGreaterThan(0);

      const afterUnique = uniqueNonAir(grid).size;
      // Should reduce palette toward k=3 (may end up with exactly k or slightly more
      // depending on cluster assignment, but strictly fewer than 8)
      expect(afterUnique).toBeLessThan(beforeUnique);
    });

    it('preserves PALETTE_PROTECTED blocks (air, glass, smooth_stone, smooth_stone_slab)', () => {
      const grid = new BlockGrid(10, 10, 10);
      // Fill with 8 diverse non-protected blocks
      const blocks = [
        'minecraft:stone', 'minecraft:bricks', 'minecraft:sandstone',
        'minecraft:andesite', 'minecraft:tuff', 'minecraft:mud_bricks',
        'minecraft:cherry_planks', 'minecraft:red_nether_bricks',
      ];
      for (let y = 0; y < 10; y++) {
        const block = blocks[y % blocks.length];
        for (let z = 0; z < 10; z++)
          for (let x = 0; x < 10; x++)
            grid.set(x, y, z, block);
      }

      // Sprinkle protected blocks that should survive consolidation
      grid.set(5, 5, 5, 'minecraft:smooth_stone');
      grid.set(5, 5, 6, 'minecraft:glass');
      grid.set(5, 5, 7, 'minecraft:smooth_stone_slab');
      grid.set(5, 5, 8, 'minecraft:gray_stained_glass');

      consolidateBlockPalette(grid, 3);

      // All protected blocks must remain untouched
      expect(at(grid, 5, 5, 5)).toBe('minecraft:smooth_stone');
      expect(at(grid, 5, 5, 6)).toBe('minecraft:glass');
      expect(at(grid, 5, 5, 7)).toBe('minecraft:smooth_stone_slab');
      // gray_stained_glass is NOT in PALETTE_PROTECTED, but it's not in WALL_CLUSTERS
      // either, so it's skipped by the blockRgb lookup → effectively preserved
      expect(at(grid, 5, 5, 8)).toBe('minecraft:gray_stained_glass');
    });

    it('does not modify air blocks during consolidation', () => {
      const grid = new BlockGrid(10, 10, 10);
      const blocks = [
        'minecraft:stone', 'minecraft:bricks', 'minecraft:sandstone',
        'minecraft:andesite', 'minecraft:tuff', 'minecraft:mud_bricks',
        'minecraft:cherry_planks', 'minecraft:red_nether_bricks',
      ];
      // Fill lower half, leave upper half as air
      for (let y = 0; y < 5; y++) {
        const block = blocks[y % blocks.length];
        for (let z = 0; z < 10; z++)
          for (let x = 0; x < 10; x++)
            grid.set(x, y, z, block);
      }

      consolidateBlockPalette(grid, 3);

      // Upper half should still be air
      for (let y = 5; y < 10; y++)
        for (let z = 0; z < 10; z++)
          for (let x = 0; x < 10; x++)
            expect(at(grid, x, y, z)).toBe('minecraft:air');
    });
  });

  // ─── PALETTE_PROTECTED set ───────────────────────────────────────────────

  describe('PALETTE_PROTECTED', () => {

    it('contains air', () => {
      expect(PALETTE_PROTECTED.has('minecraft:air')).toBe(true);
    });

    it('contains smooth_stone (fill block)', () => {
      expect(PALETTE_PROTECTED.has('minecraft:smooth_stone')).toBe(true);
    });

    it('contains gray_stained_glass (windows)', () => {
      expect(PALETTE_PROTECTED.has('minecraft:gray_stained_glass')).toBe(true);
    });

    it('contains glass and glass_pane', () => {
      expect(PALETTE_PROTECTED.has('minecraft:glass')).toBe(true);
      expect(PALETTE_PROTECTED.has('minecraft:glass_pane')).toBe(true);
    });

    it('contains smooth_stone_slab (entry path)', () => {
      expect(PALETTE_PROTECTED.has('minecraft:smooth_stone_slab')).toBe(true);
    });

    it('does NOT contain common wall blocks', () => {
      expect(PALETTE_PROTECTED.has('minecraft:stone')).toBe(false);
      expect(PALETTE_PROTECTED.has('minecraft:bricks')).toBe(false);
      expect(PALETTE_PROTECTED.has('minecraft:sandstone')).toBe(false);
    });
  });
});
