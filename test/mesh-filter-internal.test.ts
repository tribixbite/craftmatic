/**
 * Tests for mesh-filter _internal.ts helpers:
 *   - getBlockLab (CIE-Lab lookup from WALL_CLUSTERS)
 *   - blockLuminance (perceptual luminance with overrides)
 *   - findBrightNeighborMode (dominant bright neighbor search)
 *   - snapshotGrid / readSnap (flat snapshot helpers)
 *
 * Uses small BlockGrid instances to validate behavior without Three.js meshes.
 */

import { describe, it, expect } from 'vitest';
import {
  getBlockLab, blockLuminance, findBrightNeighborMode,
  snapshotGrid, readSnap, AIR,
} from '../src/convert/mesh-filter.js';
import { BlockGrid } from '../src/schem/types.js';

// ─── getBlockLab ─────────────────────────────────────────────────────────────

describe('mesh-filter _internal', () => {

  describe('getBlockLab', () => {
    it('returns Lab tuple for a known WALL_CLUSTERS block', () => {
      // smooth_quartz is in the first cluster: rgb [237, 230, 223]
      const lab = getBlockLab('minecraft:smooth_quartz');
      expect(lab).not.toBeNull();
      expect(lab!).toHaveLength(3);
      // L* for a near-white block should be high (>85)
      const [L, a, b] = lab!;
      expect(L).toBeGreaterThan(85);
      // a* and b* should be close to zero for a near-neutral color
      expect(Math.abs(a)).toBeLessThan(10);
      expect(Math.abs(b)).toBeLessThan(15);
    });

    it('returns Lab tuple for a dark block', () => {
      // gray_concrete: rgb [55, 58, 62] — should have low L*
      const lab = getBlockLab('minecraft:gray_concrete');
      expect(lab).not.toBeNull();
      const [L] = lab!;
      expect(L).toBeGreaterThan(10);
      expect(L).toBeLessThan(40);
    });

    it('returns the same Lab for all options in the same cluster', () => {
      // smooth_quartz and quartz_block share cluster rgb [237, 230, 223]
      const labA = getBlockLab('minecraft:smooth_quartz');
      const labB = getBlockLab('minecraft:quartz_block');
      expect(labA).not.toBeNull();
      expect(labB).not.toBeNull();
      expect(labA![0]).toBeCloseTo(labB![0], 5);
      expect(labA![1]).toBeCloseTo(labB![1], 5);
      expect(labA![2]).toBeCloseTo(labB![2], 5);
    });

    it('returns null for an unknown block not in any cluster', () => {
      expect(getBlockLab('minecraft:air')).toBeNull();
      expect(getBlockLab('minecraft:diamond_block')).toBeNull();
      expect(getBlockLab('minecraft:lava')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(getBlockLab('')).toBeNull();
    });

    it('returns Lab for blocks that appear in multiple clusters (first wins)', () => {
      // minecraft:sandstone appears in multiple clusters; getBlockLab should
      // return a consistent result (the first cluster encountered)
      const lab1 = getBlockLab('minecraft:sandstone');
      const lab2 = getBlockLab('minecraft:sandstone');
      expect(lab1).not.toBeNull();
      // Repeated calls return the same cached value
      expect(lab1![0]).toBe(lab2![0]);
      expect(lab1![1]).toBe(lab2![1]);
      expect(lab1![2]).toBe(lab2![2]);
    });

    it('returns brighter Lab for white blocks than for dark blocks', () => {
      const white = getBlockLab('minecraft:white_concrete');
      const dark = getBlockLab('minecraft:gray_concrete');
      expect(white).not.toBeNull();
      expect(dark).not.toBeNull();
      // white_concrete L* should be much higher than gray_concrete L*
      expect(white![0]).toBeGreaterThan(dark![0] + 30);
    });

    it('handles colored accent blocks', () => {
      // yellow_concrete: rgb [241, 175, 21] — should have positive b* (yellow)
      const lab = getBlockLab('minecraft:yellow_concrete');
      expect(lab).not.toBeNull();
      // Yellow has high b* in Lab space
      expect(lab![2]).toBeGreaterThan(40);
    });
  });

  // ─── blockLuminance ──────────────────────────────────────────────────────────

  describe('blockLuminance', () => {
    it('returns override value for glass', () => {
      expect(blockLuminance('minecraft:glass')).toBe(0.80);
      expect(blockLuminance('minecraft:glass_pane')).toBe(0.80);
    });

    it('returns override value for stained glass', () => {
      expect(blockLuminance('minecraft:black_stained_glass')).toBe(0.05);
      expect(blockLuminance('minecraft:gray_stained_glass')).toBe(0.25);
    });

    it('returns L*/100 for known blocks in WALL_CLUSTERS', () => {
      // smooth_quartz is near-white, L* ~ 92 → luminance ~ 0.92
      const lum = blockLuminance('minecraft:smooth_quartz');
      expect(lum).toBeGreaterThan(0.80);
      expect(lum).toBeLessThanOrEqual(1.0);
    });

    it('returns low luminance for dark blocks', () => {
      // gray_concrete: rgb [55, 58, 62] → L* ~ 25 → luminance ~ 0.25
      const lum = blockLuminance('minecraft:gray_concrete');
      expect(lum).toBeGreaterThan(0.10);
      expect(lum).toBeLessThan(0.40);
    });

    it('returns 0.5 for unknown blocks not in any palette', () => {
      expect(blockLuminance('minecraft:air')).toBe(0.5);
      expect(blockLuminance('minecraft:diamond_block')).toBe(0.5);
      expect(blockLuminance('minecraft:beacon')).toBe(0.5);
    });

    it('returns 0.5 for empty string (unknown)', () => {
      expect(blockLuminance('')).toBe(0.5);
    });

    it('overrides take priority over WALL_CLUSTERS lookup', () => {
      // glass and glass_pane have explicit overrides — even if they were
      // in WALL_CLUSTERS, the override should win
      const lum = blockLuminance('minecraft:glass');
      expect(lum).toBe(0.80);
    });

    it('returns values in [0, 1] range for all known blocks', () => {
      const testBlocks = [
        'minecraft:smooth_quartz', 'minecraft:white_concrete',
        'minecraft:stone_bricks', 'minecraft:gray_concrete',
        'minecraft:oak_planks', 'minecraft:bricks',
        'minecraft:sandstone', 'minecraft:dark_oak_planks',
        'minecraft:glass', 'minecraft:black_stained_glass',
      ];
      for (const block of testBlocks) {
        const lum = blockLuminance(block);
        expect(lum).toBeGreaterThanOrEqual(0);
        expect(lum).toBeLessThanOrEqual(1);
      }
    });

    it('white blocks are brighter than dark blocks', () => {
      const whiteLum = blockLuminance('minecraft:white_concrete');
      const darkLum = blockLuminance('minecraft:gray_concrete');
      expect(whiteLum).toBeGreaterThan(darkLum);
    });
  });

  // ─── findBrightNeighborMode ────────────────────────────────────────────────

  describe('findBrightNeighborMode', () => {
    it('returns null for an empty grid', () => {
      const grid = new BlockGrid(5, 5, 5);
      const result = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.3);
      expect(result).toBeNull();
    });

    it('returns the single bright neighbor when only one exists', () => {
      const grid = new BlockGrid(5, 5, 5);
      // Place a bright block adjacent to center (2,2,2)
      grid.set(3, 2, 2, 'minecraft:smooth_quartz'); // lum ~0.92
      const result = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.3);
      expect(result).toBe('minecraft:smooth_quartz');
    });

    it('returns the dominant (most frequent) bright block', () => {
      const grid = new BlockGrid(5, 5, 5);
      // Place 3 white_concrete and 1 smooth_quartz around center
      grid.set(1, 2, 2, 'minecraft:white_concrete');
      grid.set(3, 2, 2, 'minecraft:white_concrete');
      grid.set(2, 2, 1, 'minecraft:white_concrete');
      grid.set(2, 2, 3, 'minecraft:smooth_quartz');
      const result = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.3);
      expect(result).toBe('minecraft:white_concrete');
    });

    it('skips air blocks in neighborhood', () => {
      const grid = new BlockGrid(5, 5, 5);
      // Only air around center — should return null
      // (air is explicitly excluded)
      const result = findBrightNeighborMode(grid, 2, 2, 2, 2, 0.0);
      expect(result).toBeNull();
    });

    it('skips blocks below the luminance floor', () => {
      const grid = new BlockGrid(5, 5, 5);
      // gray_concrete has lum ~0.25, below a floor of 0.30
      grid.set(3, 2, 2, 'minecraft:gray_concrete');
      grid.set(1, 2, 2, 'minecraft:gray_concrete');
      const result = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.30);
      expect(result).toBeNull();
    });

    it('includes blocks above the luminance floor', () => {
      const grid = new BlockGrid(5, 5, 5);
      // gray_concrete lum ~0.25, with floor at 0.20 it should pass
      grid.set(3, 2, 2, 'minecraft:gray_concrete');
      const result = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.20);
      // blockLuminance for gray_concrete > 0.20, so it should be found
      expect(result).toBe('minecraft:gray_concrete');
    });

    it('excludes the center voxel itself from counting', () => {
      const grid = new BlockGrid(5, 5, 5);
      // Only the center has a block — neighbors are all air
      grid.set(2, 2, 2, 'minecraft:smooth_quartz');
      const result = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.0);
      // Center is excluded (dx=0,dy=0,dz=0 skip), so no neighbors found
      expect(result).toBeNull();
    });

    it('works with radius > 1 (searches larger neighborhood)', () => {
      const grid = new BlockGrid(7, 7, 7);
      // Place a block 2 steps away from center (3,3,3)
      grid.set(5, 3, 3, 'minecraft:bricks'); // 2 steps in +X
      // With radius=1 it should NOT be found
      expect(findBrightNeighborMode(grid, 3, 3, 3, 1, 0.0)).toBeNull();
      // With radius=2 it SHOULD be found
      const result = findBrightNeighborMode(grid, 3, 3, 3, 2, 0.0);
      expect(result).toBe('minecraft:bricks');
    });

    it('handles boundary conditions (center near grid edge)', () => {
      const grid = new BlockGrid(5, 5, 5);
      // Center at (0,0,0) — only positive-direction neighbors exist
      grid.set(1, 0, 0, 'minecraft:sandstone');
      const result = findBrightNeighborMode(grid, 0, 0, 0, 1, 0.0);
      expect(result).toBe('minecraft:sandstone');
    });

    it('handles center at max corner of grid', () => {
      const grid = new BlockGrid(5, 5, 5);
      // Center at (4,4,4) — only negative-direction neighbors exist
      grid.set(3, 4, 4, 'minecraft:oak_planks');
      const result = findBrightNeighborMode(grid, 4, 4, 4, 1, 0.0);
      expect(result).toBe('minecraft:oak_planks');
    });

    it('returns bright block when mixed bright and dark neighbors exist', () => {
      const grid = new BlockGrid(5, 5, 5);
      // 3 dark blocks and 2 bright blocks around center, floor filters dark ones
      grid.set(1, 2, 2, 'minecraft:gray_concrete'); // lum ~0.25
      grid.set(3, 2, 2, 'minecraft:gray_concrete'); // lum ~0.25
      grid.set(2, 1, 2, 'minecraft:gray_concrete'); // lum ~0.25
      grid.set(2, 3, 2, 'minecraft:white_concrete'); // lum ~0.83
      grid.set(2, 2, 3, 'minecraft:white_concrete'); // lum ~0.83
      // With lumFloor=0.30, only white_concrete passes
      const result = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.30);
      expect(result).toBe('minecraft:white_concrete');
    });

    it('searches the full 3D cube neighborhood (not just face-adjacent)', () => {
      const grid = new BlockGrid(5, 5, 5);
      // Place block at diagonal offset (1,1,1) from center (2,2,2)
      // This is a corner neighbor, not face-adjacent
      grid.set(3, 3, 3, 'minecraft:bricks');
      const result = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.0);
      // Diagonal neighbors are within radius=1 cube
      expect(result).toBe('minecraft:bricks');
    });

    it('uses lumFloor as strict > comparison (not >=)', () => {
      // blockLuminance for unknown blocks is exactly 0.5
      const grid = new BlockGrid(5, 5, 5);
      grid.set(3, 2, 2, 'minecraft:diamond_block'); // unknown → lum=0.5
      // Floor at exactly 0.5 — should NOT pass (condition is > lumFloor)
      const resultExact = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.5);
      expect(resultExact).toBeNull();
      // Floor at 0.49 — should pass
      const resultBelow = findBrightNeighborMode(grid, 2, 2, 2, 1, 0.49);
      expect(resultBelow).toBe('minecraft:diamond_block');
    });
  });

  // ─── snapshotGrid / readSnap ───────────────────────────────────────────────

  describe('snapshotGrid / readSnap', () => {
    it('snapshots an empty grid as all air', () => {
      const grid = new BlockGrid(3, 3, 3);
      const snap = snapshotGrid(grid);
      expect(snap).toHaveLength(27); // 3*3*3
      expect(snap.every(b => b === AIR)).toBe(true);
    });

    it('captures block positions accurately', () => {
      const grid = new BlockGrid(5, 5, 5);
      grid.set(2, 3, 1, 'minecraft:stone');
      grid.set(4, 0, 4, 'minecraft:bricks');

      const snap = snapshotGrid(grid);
      expect(readSnap(snap, grid, 2, 3, 1)).toBe('minecraft:stone');
      expect(readSnap(snap, grid, 4, 0, 4)).toBe('minecraft:bricks');
      expect(readSnap(snap, grid, 0, 0, 0)).toBe(AIR);
    });

    it('snapshot is independent of subsequent grid mutations', () => {
      const grid = new BlockGrid(3, 3, 3);
      grid.set(1, 1, 1, 'minecraft:stone');
      const snap = snapshotGrid(grid);

      // Mutate grid after snapshot
      grid.set(1, 1, 1, 'minecraft:bricks');
      grid.set(0, 0, 0, 'minecraft:oak_planks');

      // Snapshot should still reflect original state
      expect(readSnap(snap, grid, 1, 1, 1)).toBe('minecraft:stone');
      expect(readSnap(snap, grid, 0, 0, 0)).toBe(AIR);
    });

    it('handles non-cubic grids (width != height != length)', () => {
      const grid = new BlockGrid(10, 3, 7);
      grid.set(9, 2, 6, 'minecraft:sandstone');
      grid.set(0, 0, 0, 'minecraft:stone');

      const snap = snapshotGrid(grid);
      expect(snap).toHaveLength(10 * 3 * 7);
      expect(readSnap(snap, grid, 9, 2, 6)).toBe('minecraft:sandstone');
      expect(readSnap(snap, grid, 0, 0, 0)).toBe('minecraft:stone');
      expect(readSnap(snap, grid, 5, 1, 3)).toBe(AIR);
    });

    it('handles 1x1x1 grid', () => {
      const grid = new BlockGrid(1, 1, 1);
      grid.set(0, 0, 0, 'minecraft:stone');
      const snap = snapshotGrid(grid);
      expect(snap).toHaveLength(1);
      expect(readSnap(snap, grid, 0, 0, 0)).toBe('minecraft:stone');
    });
  });
});
