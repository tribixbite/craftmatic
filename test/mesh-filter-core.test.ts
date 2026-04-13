/**
 * Tests for core mesh-filter.ts grid operations:
 *   - morphClose3D (dilate-erode gap filling)
 *   - removeIsolatedVoxels (noise cleanup)
 *   - fillFacadeHoles (single-block facade patching)
 *
 * Uses small BlockGrid instances to validate behavior without Three.js meshes.
 */

import { describe, it, expect } from 'vitest';
import { morphClose3D, removeIsolatedVoxels, fillFacadeHoles } from '../src/convert/mesh-filter.js';
import { BlockGrid } from '../src/schem/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Count all non-air blocks in the grid */
function countNonAir(grid: BlockGrid): number {
  return grid.countNonAir();
}

/** Get block at position (convenience wrapper for assertions) */
function at(grid: BlockGrid, x: number, y: number, z: number): string {
  return grid.get(x, y, z);
}

// ─── morphClose3D ────────────────────────────────────────────────────────────

describe('morphClose3D', () => {
  it('fills a 1-block gap between two solid walls', () => {
    // 5-wide grid, Y=1 high, Z=1 deep: solid at x=0,1 and x=3,4, gap at x=2
    const grid = new BlockGrid(5, 1, 1);
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 0, 0, 'minecraft:stone');
    // x=2 is air (the gap)
    grid.set(3, 0, 0, 'minecraft:stone');
    grid.set(4, 0, 0, 'minecraft:stone');

    const before = countNonAir(grid);
    expect(before).toBe(4);

    const filled = morphClose3D(grid, 1);

    // The gap at x=2 should now be filled (dilate fills it, erode keeps it
    // because it has solid neighbors on both sides making it interior)
    expect(at(grid, 2, 0, 0)).toBe('minecraft:stone');
    expect(countNonAir(grid)).toBeGreaterThanOrEqual(before);
    expect(filled).toBeGreaterThanOrEqual(1);
  });

  it('preserves existing blocks (does not remove originals during close)', () => {
    // A solid 3x3x3 cube should not lose any blocks from morphological close
    const grid = new BlockGrid(3, 3, 3);
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        for (let x = 0; x < 3; x++) {
          grid.set(x, y, z, 'minecraft:stone');
        }
      }
    }

    const originalCount = countNonAir(grid);
    expect(originalCount).toBe(27);

    morphClose3D(grid, 1);

    // All original blocks must still be present (erode only removes dilated voxels)
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        for (let x = 0; x < 3; x++) {
          expect(at(grid, x, y, z)).toBe('minecraft:stone');
        }
      }
    }
    expect(countNonAir(grid)).toBe(27);
  });

  it('handles empty grid without error', () => {
    const grid = new BlockGrid(5, 5, 5);
    // Entirely air — should not throw or modify anything
    const filled = morphClose3D(grid, 1);
    expect(filled).toBe(0);
    expect(countNonAir(grid)).toBe(0);
  });

  it('handles single-block grid without error', () => {
    const grid = new BlockGrid(1, 1, 1);
    grid.set(0, 0, 0, 'minecraft:stone');
    const filled = morphClose3D(grid, 1);
    // Single block has no gaps to fill, should stay as-is
    expect(at(grid, 0, 0, 0)).toBe('minecraft:stone');
    expect(filled).toBe(0);
  });

  it('respects maxY parameter (only processes layers below limit)', () => {
    // 5x5x5 grid: gap at y=2, and gap at y=4. maxY=3 should only fill y=2 gap.
    const grid = new BlockGrid(3, 5, 3);
    // Solid walls at y=1 and y=3
    for (let z = 0; z < 3; z++) {
      for (let x = 0; x < 3; x++) {
        grid.set(x, 1, z, 'minecraft:stone');
        grid.set(x, 3, z, 'minecraft:stone');
      }
    }
    // y=2 has a gap between y=1 and y=3 walls

    morphClose3D(grid, 1, 3);

    // y=2 gap might be filled (within maxY=3 processing range)
    // y=4 should remain air (above maxY limit)
    expect(at(grid, 1, 4, 1)).toBe('minecraft:air');
  });
});

// ─── removeIsolatedVoxels ────────────────────────────────────────────────────

describe('removeIsolatedVoxels', () => {
  it('removes a voxel with 0 face-neighbors', () => {
    // Single isolated block in the center of a 5x5x5 grid
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 2, 2, 'minecraft:stone');

    const removed = removeIsolatedVoxels(grid, 1);
    expect(removed).toBe(1);
    expect(at(grid, 2, 2, 2)).toBe('minecraft:air');
  });

  it('removes a voxel with 1 face-neighbor (maxNeighbors=1 default)', () => {
    // Two adjacent blocks — each has exactly 1 face-neighbor
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 2, 2, 'minecraft:stone');
    grid.set(3, 2, 2, 'minecraft:stone');

    const removed = removeIsolatedVoxels(grid, 1);
    // Both blocks have exactly 1 neighbor, so both should be removed
    expect(removed).toBe(2);
    expect(at(grid, 2, 2, 2)).toBe('minecraft:air');
    expect(at(grid, 3, 2, 2)).toBe('minecraft:air');
  });

  it('preserves a voxel with 2+ face-neighbors', () => {
    // L-shape: 3 blocks in a row — middle block has 2 neighbors
    const grid = new BlockGrid(5, 5, 5);
    grid.set(1, 2, 2, 'minecraft:stone');
    grid.set(2, 2, 2, 'minecraft:stone'); // center — 2 neighbors
    grid.set(3, 2, 2, 'minecraft:stone');

    const removed = removeIsolatedVoxels(grid, 1);
    // Center block has 2 neighbors (>1) → preserved
    // End blocks each have 1 neighbor (<=1) → removed
    expect(at(grid, 2, 2, 2)).toBe('minecraft:stone');
    expect(removed).toBe(2);
  });

  it('preserves blocks in a dense cluster (all have 2+ neighbors)', () => {
    // 3x3x1 solid slab — every interior block has 3-4 neighbors
    const grid = new BlockGrid(5, 5, 5);
    for (let x = 1; x <= 3; x++) {
      for (let z = 1; z <= 3; z++) {
        grid.set(x, 2, z, 'minecraft:stone');
      }
    }
    // Center (2,2,2) has 4 face-neighbors in XZ plane
    // Edges have 2-3 each. Corners have 2 each.
    const beforeCount = countNonAir(grid);

    const removed = removeIsolatedVoxels(grid, 1);

    // Interior/center block should survive (4 neighbors in-plane + 0 in Y)
    expect(at(grid, 2, 2, 2)).toBe('minecraft:stone');
    // Edge blocks with 2+ neighbors survive too
    expect(at(grid, 2, 2, 1)).toBe('minecraft:stone');
    // Corner blocks have exactly 2 neighbors → preserved (2 > maxNeighbors=1)
    expect(at(grid, 1, 2, 1)).toBe('minecraft:stone');
    // No blocks should be removed (all have ≥2 neighbors)
    expect(removed).toBe(0);
    expect(countNonAir(grid)).toBe(beforeCount);
  });

  it('handles empty grid without error', () => {
    const grid = new BlockGrid(3, 3, 3);
    const removed = removeIsolatedVoxels(grid);
    expect(removed).toBe(0);
  });

  it('maxNeighbors=0 only removes blocks with zero neighbors', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 2, 2, 'minecraft:stone'); // isolated — 0 neighbors
    grid.set(0, 0, 0, 'minecraft:stone'); // at corner — 0 in-bounds neighbors
    grid.set(1, 0, 0, 'minecraft:stone'); // has 1 neighbor (0,0,0)

    const removed = removeIsolatedVoxels(grid, 0);
    // (2,2,2) has 0 neighbors → removed
    // (0,0,0) has 1 neighbor (1,0,0) → NOT removed (1 > 0)
    // (1,0,0) has 1 neighbor (0,0,0) → NOT removed (1 > 0)
    expect(removed).toBe(1);
    expect(at(grid, 2, 2, 2)).toBe('minecraft:air');
    expect(at(grid, 0, 0, 0)).toBe('minecraft:stone');
    expect(at(grid, 1, 0, 0)).toBe('minecraft:stone');
  });
});

// ─── fillFacadeHoles ─────────────────────────────────────────────────────────

describe('fillFacadeHoles', () => {
  it('fills a 1-block hole with 4+ solid face-neighbors', () => {
    // Create a cross pattern: solid blocks above, below, left, right of center
    // Center at (2,2,2) is air, surrounded by 4 face-neighbors in XZ plane
    const grid = new BlockGrid(5, 5, 5);
    grid.set(1, 2, 2, 'minecraft:bricks'); // -X
    grid.set(3, 2, 2, 'minecraft:bricks'); // +X
    grid.set(2, 2, 1, 'minecraft:bricks'); // -Z
    grid.set(2, 2, 3, 'minecraft:bricks'); // +Z
    // (2,2,2) has 4 solid face-neighbors → should be filled

    const filled = fillFacadeHoles(grid, 4, 1);
    expect(filled).toBe(1);
    expect(at(grid, 2, 2, 2)).toBe('minecraft:bricks');
  });

  it('fills hole and picks the most common neighbor block', () => {
    // 4 solid face-neighbors: 3 are bricks, 1 is stone → should fill with bricks
    const grid = new BlockGrid(5, 5, 5);
    grid.set(1, 2, 2, 'minecraft:bricks');
    grid.set(3, 2, 2, 'minecraft:bricks');
    grid.set(2, 2, 1, 'minecraft:bricks');
    grid.set(2, 2, 3, 'minecraft:stone');
    // Also add above/below to get 5+ neighbors
    grid.set(2, 1, 2, 'minecraft:bricks');
    grid.set(2, 3, 2, 'minecraft:stone');

    fillFacadeHoles(grid, 4, 1);
    // Most common neighbor is bricks (4 out of 6)
    expect(at(grid, 2, 2, 2)).toBe('minecraft:bricks');
  });

  it('does NOT fill air with only 3 solid face-neighbors (below threshold)', () => {
    // 3 solid neighbors — below minSolid=4 default
    const grid = new BlockGrid(5, 5, 5);
    grid.set(1, 2, 2, 'minecraft:stone');
    grid.set(3, 2, 2, 'minecraft:stone');
    grid.set(2, 2, 1, 'minecraft:stone');
    // Only 3 neighbors — not enough

    const filled = fillFacadeHoles(grid, 4, 1);
    expect(filled).toBe(0);
    expect(at(grid, 2, 2, 2)).toBe('minecraft:air');
  });

  it('does NOT fill interior air (open courtyard pattern)', () => {
    // Build a hollow box: walls on all sides but large interior air volume
    // The interior air cells have at most 2-3 solid face-neighbors
    // (they face other air cells on the open sides)
    const grid = new BlockGrid(7, 5, 7);

    // Build a hollow rectangle — walls at edges, air inside
    for (let y = 0; y < 5; y++) {
      for (let z = 0; z < 7; z++) {
        for (let x = 0; x < 7; x++) {
          const isWall = x === 0 || x === 6 || z === 0 || z === 6;
          if (isWall) {
            grid.set(x, y, z, 'minecraft:stone');
          }
        }
      }
    }

    // Interior point (3, 2, 3): has 0 solid face-neighbors in XZ (all interior air)
    // Has 2 solid face-neighbors in Y (floor+ceiling at y=0 doesn't exist... actually
    // it does have solid neighbors above/below if walls go full height).
    // Actually: (3,2,3) neighbors are (2,2,3)=air, (4,2,3)=air, (3,2,2)=air, (3,2,4)=air
    // Plus (3,1,3)=air and (3,3,3)=air. So 0 solid neighbors → should NOT be filled.
    const filled = fillFacadeHoles(grid, 4, 1);

    // Interior must remain air
    expect(at(grid, 3, 2, 3)).toBe('minecraft:air');
    expect(at(grid, 2, 2, 2)).toBe('minecraft:air');
    expect(at(grid, 4, 2, 4)).toBe('minecraft:air');
  });

  it('handles empty grid without error', () => {
    const grid = new BlockGrid(5, 5, 5);
    const filled = fillFacadeHoles(grid, 4, 1);
    expect(filled).toBe(0);
  });

  it('single pass does not cascade fills', () => {
    // Two adjacent air blocks, each needing the other to be filled first
    // With maxPasses=1, at most one pass occurs — cascade should not happen
    const grid = new BlockGrid(7, 1, 1);
    // Solid at x=0,1 and x=4,5,6 — gap at x=2 and x=3
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 0, 0, 'minecraft:stone');
    grid.set(4, 0, 0, 'minecraft:stone');
    grid.set(5, 0, 0, 'minecraft:stone');
    grid.set(6, 0, 0, 'minecraft:stone');

    // Neither x=2 nor x=3 has 4+ solid face-neighbors (only 1 each in X direction)
    const filled = fillFacadeHoles(grid, 4, 1);
    expect(filled).toBe(0);
  });

  it('fills with minSolid=5 only when 5+ neighbors are solid', () => {
    // Create a voxel surrounded by 5 solid face-neighbors
    const grid = new BlockGrid(5, 5, 5);
    grid.set(1, 2, 2, 'minecraft:stone'); // -X
    grid.set(3, 2, 2, 'minecraft:stone'); // +X
    grid.set(2, 2, 1, 'minecraft:stone'); // -Z
    grid.set(2, 2, 3, 'minecraft:stone'); // +Z
    grid.set(2, 1, 2, 'minecraft:stone'); // -Y
    // 5 solid neighbors → should be filled at minSolid=5

    const filled = fillFacadeHoles(grid, 5, 1);
    expect(filled).toBe(1);
    expect(at(grid, 2, 2, 2)).toBe('minecraft:stone');
  });
});
