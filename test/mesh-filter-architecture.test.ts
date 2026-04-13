/**
 * Architecture fix tests for mesh-filter pipeline.
 *
 * Validates:
 * - Grid snapshot/restore utilities (snapshotGridBlocks, restoreGridBlocks)
 * - Vegetation block list consistency (single source of truth)
 * - K-means determinism (consolidateBlockPalette)
 * - CCL is the single implementation (labelConnectedComponents)
 */

import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  snapshotGridBlocks,
  restoreGridBlocks,
  labelConnectedComponents,
  consolidateBlockPalette,
  stripVegetation,
  VEGETATION_BLOCKS,
} from '../src/convert/mesh-filter.js';
import { VEGETATION_BLOCKS as VEGETATION_BLOCKS_VOXELIZER } from '../src/convert/voxelizer.js';

// ─── Grid Snapshot Utilities ──────────────────────────────────────────────────

describe('snapshotGridBlocks', () => {
  it('captures all non-air blocks with correct count', () => {
    const grid = new BlockGrid(4, 3, 4);
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 1, 1, 'minecraft:oak_planks');
    grid.set(3, 2, 3, 'minecraft:glass');

    const snap = snapshotGridBlocks(grid);
    expect(snap.count).toBe(3);
    expect(snap.width).toBe(4);
    expect(snap.height).toBe(3);
    expect(snap.length).toBe(4);
    expect(snap.blocks.size).toBe(3);
  });

  it('returns empty snapshot for all-air grid', () => {
    const grid = new BlockGrid(5, 5, 5);
    const snap = snapshotGridBlocks(grid);
    expect(snap.count).toBe(0);
    expect(snap.blocks.size).toBe(0);
  });

  it('stores correct block values at flat indices', () => {
    const grid = new BlockGrid(3, 3, 3);
    grid.set(2, 1, 0, 'minecraft:stone');
    // Flat index = (y * length + z) * width + x = (1 * 3 + 0) * 3 + 2 = 11
    const snap = snapshotGridBlocks(grid);
    expect(snap.blocks.get(11)).toBe('minecraft:stone');
  });
});

describe('restoreGridBlocks', () => {
  it('restores grid to snapshot state after modification', () => {
    const grid = new BlockGrid(4, 4, 4);
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 1, 1, 'minecraft:oak_planks');
    grid.set(2, 2, 2, 'minecraft:glass');

    const snap = snapshotGridBlocks(grid);

    // Modify the grid (simulates destructive operation)
    grid.set(0, 0, 0, 'minecraft:air');
    grid.set(1, 1, 1, 'minecraft:air');
    grid.set(3, 3, 3, 'minecraft:dirt');
    expect(grid.get(0, 0, 0)).toBe('minecraft:air');

    // Restore
    restoreGridBlocks(grid, snap);
    expect(grid.get(0, 0, 0)).toBe('minecraft:stone');
    expect(grid.get(1, 1, 1)).toBe('minecraft:oak_planks');
    expect(grid.get(2, 2, 2)).toBe('minecraft:glass');
    // Blocks added AFTER snapshot ARE cleared by restore (full revert)
    expect(grid.get(3, 3, 3)).toBe('minecraft:air');
  });

  it('throws when grid dimensions changed', () => {
    const grid1 = new BlockGrid(4, 4, 4);
    grid1.set(0, 0, 0, 'minecraft:stone');
    const snap = snapshotGridBlocks(grid1);

    const grid2 = new BlockGrid(5, 4, 4); // Different width
    expect(() => restoreGridBlocks(grid2, snap)).toThrow('Grid dimensions changed');
  });

  it('handles empty snapshot gracefully', () => {
    const grid = new BlockGrid(3, 3, 3);
    grid.set(1, 1, 1, 'minecraft:dirt');
    const emptySnap = snapshotGridBlocks(new BlockGrid(3, 3, 3));

    // Restoring empty snapshot clears all blocks (empty grid = all air)
    restoreGridBlocks(grid, emptySnap);
    expect(grid.get(1, 1, 1)).toBe('minecraft:air');
  });
});

// ─── Vegetation Block Consistency ─────────────────────────────────────────────

describe('vegetation block deduplication', () => {
  it('VEGETATION_BLOCKS is the same object in mesh-filter and voxelizer', () => {
    // The import from mesh-filter.ts re-exports the voxelizer.ts set.
    // They should be the exact same reference (not just equal sets).
    expect(VEGETATION_BLOCKS).toBe(VEGETATION_BLOCKS_VOXELIZER);
  });

  it('stripVegetation removes all VEGETATION_BLOCKS entries', () => {
    const grid = new BlockGrid(3, 1, 3);
    // Place one of each vegetation block type
    const vegBlocks = [...VEGETATION_BLOCKS];
    for (let i = 0; i < Math.min(vegBlocks.length, 9); i++) {
      grid.set(i % 3, 0, Math.floor(i / 3), vegBlocks[i]);
    }
    expect(grid.countNonAir()).toBeGreaterThan(0);

    const removed = stripVegetation(grid);
    expect(removed).toBeGreaterThan(0);
    expect(grid.countNonAir()).toBe(0);
  });

  it('stripVegetation preserves non-vegetation blocks', () => {
    const grid = new BlockGrid(3, 1, 3);
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 0, 0, 'minecraft:oak_planks');
    grid.set(2, 0, 0, 'minecraft:green_concrete'); // vegetation

    const removed = stripVegetation(grid);
    expect(removed).toBe(1);
    expect(grid.get(0, 0, 0)).toBe('minecraft:stone');
    expect(grid.get(1, 0, 0)).toBe('minecraft:oak_planks');
    expect(grid.get(2, 0, 0)).toBe('minecraft:air');
  });
});

// ─── K-Means Determinism ──────────────────────────────────────────────────────

describe('consolidateBlockPalette determinism', () => {
  it('produces identical output on repeated runs', () => {
    // Build a grid with many distinct block types to trigger clustering
    const grid1 = new BlockGrid(10, 10, 10);
    const grid2 = new BlockGrid(10, 10, 10);
    const blocks = [
      'minecraft:white_concrete', 'minecraft:light_gray_concrete',
      'minecraft:gray_concrete', 'minecraft:brown_terracotta',
      'minecraft:red_terracotta', 'minecraft:orange_terracotta',
      'minecraft:yellow_terracotta', 'minecraft:stone',
      'minecraft:smooth_stone', 'minecraft:andesite',
      'minecraft:diorite', 'minecraft:cobblestone',
    ];

    // Fill both grids identically with a deterministic pattern
    for (let y = 0; y < 10; y++) {
      for (let z = 0; z < 10; z++) {
        for (let x = 0; x < 10; x++) {
          const blockIdx = (x + y * 3 + z * 7) % blocks.length;
          grid1.set(x, y, z, blocks[blockIdx]);
          grid2.set(x, y, z, blocks[blockIdx]);
        }
      }
    }

    // Run consolidation (k=4 to force merging)
    const result1 = consolidateBlockPalette(grid1, 4);
    const result2 = consolidateBlockPalette(grid2, 4);

    expect(result1).toBe(result2);

    // Verify both grids are identical after consolidation
    for (let y = 0; y < 10; y++) {
      for (let z = 0; z < 10; z++) {
        for (let x = 0; x < 10; x++) {
          expect(grid1.get(x, y, z)).toBe(grid2.get(x, y, z));
        }
      }
    }
  });

  it('returns 0 when block count <= k', () => {
    const grid = new BlockGrid(5, 5, 5);
    // Only 2 block types — below default k=5
    for (let y = 0; y < 5; y++) {
      for (let z = 0; z < 5; z++) {
        for (let x = 0; x < 5; x++) {
          grid.set(x, y, z, x < 3 ? 'minecraft:stone' : 'minecraft:andesite');
        }
      }
    }
    const result = consolidateBlockPalette(grid, 5);
    expect(result).toBe(0);
  });
});

// ─── CCL Single Implementation ────────────────────────────────────────────────

describe('labelConnectedComponents', () => {
  it('finds single component in filled grid', () => {
    const grid = new BlockGrid(3, 3, 3);
    // Fill entire grid with stone
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        for (let x = 0; x < 3; x++) {
          grid.set(x, y, z, 'minecraft:stone');
        }
      }
    }
    const { count, sizes } = labelConnectedComponents(grid);
    expect(count).toBe(1);
    expect(sizes[1]).toBe(27);
  });

  it('finds two separate components', () => {
    const grid = new BlockGrid(5, 1, 1);
    grid.set(0, 0, 0, 'minecraft:stone');
    // gap at x=1,2 (air)
    grid.set(3, 0, 0, 'minecraft:stone');
    grid.set(4, 0, 0, 'minecraft:stone');

    const { count, sizes } = labelConnectedComponents(grid);
    expect(count).toBe(2);
    // One component of size 1, one of size 2
    const sortedSizes = sizes.slice(1).sort((a, b) => a - b);
    expect(sortedSizes).toEqual([1, 2]);
  });

  it('returns 0 components for empty grid', () => {
    const grid = new BlockGrid(3, 3, 3);
    const { count, labels } = labelConnectedComponents(grid);
    expect(count).toBe(0);
    // All labels should be 0 (air)
    for (let i = 0; i < labels.length; i++) {
      expect(labels[i]).toBe(0);
    }
  });

  it('uses 6-connectivity (face-adjacent only)', () => {
    const grid = new BlockGrid(3, 3, 3);
    // Place two blocks that are diagonal but not face-adjacent
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 1, 1, 'minecraft:stone');

    const { count } = labelConnectedComponents(grid);
    // Diagonal blocks should be separate components (6-connected, not 26)
    expect(count).toBe(2);
  });
});
