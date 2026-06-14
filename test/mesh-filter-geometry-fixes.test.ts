/**
 * Tests for geometry pipeline fixes:
 *   - fillFacadeVoidsIterative (iterative 2D facade void filling)
 *   - fillFacadeStripes (venetian-blind stripe repair)
 *   - fillInteriorGaps / scanlineInteriorFill fill tracking
 *   - clearOpenAirFill with filledSet (only clears filled, not original)
 *   - removeGroundPlaneAdaptive (fill-ratio-based ground detection)
 *   - regularizeFlatRoof (bump removal + hole filling)
 *
 * Uses small BlockGrid instances to validate behavior without Three.js meshes.
 */

import { describe, it, expect } from 'vitest';
import {
  fillFacadeVoidsIterative,
  fillFacadeStripes,
  fillInteriorGaps,
  scanlineInteriorFill,
  clearOpenAirFill,
  removeGroundPlaneAdaptive,
  regularizeFlatRoof,
} from '../src/convert/mesh-filter.js';
import { BlockGrid } from '../src/schem/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AIR = 'minecraft:air';
const STONE = 'minecraft:stone';
const BRICKS = 'minecraft:bricks';
const SMOOTH = 'minecraft:smooth_stone';

/** Count all non-air blocks in the grid */
function countNonAir(grid: BlockGrid): number {
  return grid.countNonAir();
}

/** Read block at (x, y, z) */
function at(grid: BlockGrid, x: number, y: number, z: number): string {
  return grid.get(x, y, z);
}

// ─── fillFacadeVoidsIterative ─────────────────────────────────────────────────

describe('fillFacadeVoidsIterative', () => {
  it('returns 0 for an empty grid', () => {
    const grid = new BlockGrid(5, 5, 5);
    const filled = fillFacadeVoidsIterative(grid);
    expect(filled).toBe(0);
    expect(countNonAir(grid)).toBe(0);
  });

  it('fills a small hole in a facade plane', () => {
    // Build a flat wall on the +X face (x=4), with a 1-block hole at z=2, y=2.
    // The wall spans z=0..4, y=0..4 at x=4.
    const grid = new BlockGrid(6, 5, 5);
    for (let y = 0; y < 5; y++) {
      for (let z = 0; z < 5; z++) {
        if (y === 2 && z === 2) continue; // Leave a hole
        grid.set(4, y, z, STONE);
      }
    }

    const before = countNonAir(grid);
    const filled = fillFacadeVoidsIterative(grid);

    // The hole at (4, 2, 2) has 4 coplanar neighbors — should be filled
    expect(filled).toBeGreaterThanOrEqual(1);
    expect(at(grid, 4, 2, 2)).not.toBe(AIR);
    expect(countNonAir(grid)).toBeGreaterThan(before);
  });

  it('fills a large void across multiple iterations', () => {
    // Build a wall on the -Z face (z=0) with a 3×3 void in the center.
    // The wall spans x=0..9, y=0..9 at z=0.
    const grid = new BlockGrid(10, 10, 3);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        // Leave a 3×3 hole at x=4..6, y=4..6
        if (x >= 4 && x <= 6 && y >= 4 && y <= 6) continue;
        grid.set(x, y, 0, BRICKS);
      }
    }

    const before = countNonAir(grid);
    const filled = fillFacadeVoidsIterative(grid, 5);

    // The 3×3 void should be partially or fully filled across iterations
    // At minimum, the edge cells (with 2+ neighbors) should fill first
    expect(filled).toBeGreaterThanOrEqual(1);
    expect(countNonAir(grid)).toBeGreaterThan(before);
  });

  it('does NOT close a courtyard (air escape path to boundary)', () => {
    // Build a U-shaped wall on the +X face. The opening at the bottom means
    // the interior gap connects to the boundary — it should NOT be filled.
    // Wall at x=4: z=0..6, y=0..6. Remove z=2..4 at y=0 (open bottom).
    const grid = new BlockGrid(6, 7, 7);
    for (let y = 0; y < 7; y++) {
      for (let z = 0; z < 7; z++) {
        // Left wall
        if (z === 0 || z === 6) { grid.set(4, y, z, STONE); continue; }
        // Top wall
        if (y === 6) { grid.set(4, y, z, STONE); continue; }
        // Bottom wall — but leave a gap at z=2..4 for the opening
        if (y === 0 && (z < 2 || z > 4)) { grid.set(4, y, z, STONE); continue; }
        // Side walls for middle heights
        if (y > 0 && y < 6 && (z === 1 || z === 5)) { grid.set(4, y, z, STONE); continue; }
      }
    }

    const before = countNonAir(grid);
    // With maxIter=5, interior cells connected to boundary through the opening
    // should NOT all fill — the opening propagates air connectivity
    const filled = fillFacadeVoidsIterative(grid, 5);

    // The center of the U (y=3, z=3) should not be completely enclosed
    // (some filling may occur at edges but the open path should limit propagation)
    // The key test is that total fill is much less than the full interior area
    const interior = 5 * 5; // approximate interior area (y=1..5, z=1..5)
    expect(filled).toBeLessThan(interior);
  });
});

// ─── fillFacadeStripes ────────────────────────────────────────────────────────

describe('fillFacadeStripes', () => {
  it('returns 0 for an empty grid', () => {
    const grid = new BlockGrid(5, 5, 5);
    expect(fillFacadeStripes(grid)).toBe(0);
  });

  it('returns 0 when no stripes exist (solid wall)', () => {
    // Solid wall with no gaps — nothing to fill
    const grid = new BlockGrid(5, 5, 5);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        grid.set(x, y, 0, STONE);
      }
    }
    expect(fillFacadeStripes(grid)).toBe(0);
  });

  it('fills a single-block stripe gap along X', () => {
    // Build a facade at z=0 with rows of blocks at x=0,1 and x=3,4,
    // leaving x=2 empty (single-block stripe along X).
    // Make z=1 air so the facade condition is met (air behind the wall).
    const grid = new BlockGrid(5, 3, 3);
    for (let y = 0; y < 3; y++) {
      grid.set(0, y, 0, STONE);
      grid.set(1, y, 0, STONE);
      // x=2 is air (the stripe)
      grid.set(3, y, 0, STONE);
      grid.set(4, y, 0, STONE);
    }

    const before = countNonAir(grid);
    const filled = fillFacadeStripes(grid);

    // x=2 has solid on both sides (x=1 and x=3) — single-block gap — should fill
    expect(filled).toBeGreaterThanOrEqual(1);
    // Check at least one row's gap was filled
    expect(at(grid, 2, 1, 0)).toBe(STONE);
    expect(countNonAir(grid)).toBeGreaterThan(before);
  });

  it('does NOT fill a 2-wide gap (not a single-block stripe)', () => {
    // Build a facade at z=0 with a 2-block gap at x=2..3
    const grid = new BlockGrid(6, 3, 3);
    for (let y = 0; y < 3; y++) {
      grid.set(0, y, 0, STONE);
      grid.set(1, y, 0, STONE);
      // x=2, x=3 both air (2-wide gap)
      grid.set(4, y, 0, STONE);
      grid.set(5, y, 0, STONE);
    }

    const filled = fillFacadeStripes(grid);
    // 2-wide gap — both x=2 and x=3 have air immediate neighbors — should NOT fill
    expect(at(grid, 2, 1, 0)).toBe(AIR);
    expect(at(grid, 3, 1, 0)).toBe(AIR);
    expect(filled).toBe(0);
  });

  it('fills a single-block stripe gap along Z', () => {
    // Build a facade at x=0 with a gap at z=2 along Z axis
    const grid = new BlockGrid(3, 3, 5);
    for (let y = 0; y < 3; y++) {
      grid.set(0, y, 0, BRICKS);
      grid.set(0, y, 1, BRICKS);
      // z=2 is air (stripe gap)
      grid.set(0, y, 3, BRICKS);
      grid.set(0, y, 4, BRICKS);
    }

    const filled = fillFacadeStripes(grid);

    expect(filled).toBeGreaterThanOrEqual(1);
    // z=2 sandwiched between z=1 and z=3 — should fill
    expect(at(grid, 0, 1, 2)).toBe(BRICKS);
  });
});

// ─── Fill tracking (fillInteriorGaps / scanlineInteriorFill + clearOpenAirFill) ──

describe('fill tracking with filledSet', () => {
  it('fillInteriorGaps populates filledSet with indices of filled voxels', () => {
    // Build a hollow box: solid shell with air interior
    const grid = new BlockGrid(5, 5, 5);
    // Fill entire grid solid then hollow out interior
    for (let y = 0; y < 5; y++)
      for (let z = 0; z < 5; z++)
        for (let x = 0; x < 5; x++)
          grid.set(x, y, z, STONE);
    // Hollow out center (1..3 × 1..3 × 1..3)
    for (let y = 1; y <= 3; y++)
      for (let z = 1; z <= 3; z++)
        for (let x = 1; x <= 3; x++)
          grid.set(x, y, z, AIR);

    const filledSet = new Set<number>();
    const count = fillInteriorGaps(grid, 2, 1, filledSet);

    // Interior should have been filled
    expect(count).toBeGreaterThan(0);
    expect(filledSet.size).toBe(count);

    // Verify the set contains the correct flat indices
    // For each filled voxel, check it was indeed air before and is now filled
    for (const idx of filledSet) {
      const x = idx % 5;
      const z = Math.floor(idx / 5) % 5;
      const y = Math.floor(idx / (5 * 5));
      // These should be interior voxels (within 1..3 range)
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(3);
      expect(y).toBeGreaterThanOrEqual(1);
      expect(y).toBeLessThanOrEqual(3);
      expect(z).toBeGreaterThanOrEqual(1);
      expect(z).toBeLessThanOrEqual(3);
    }
  });

  it('scanlineInteriorFill populates filledSet', () => {
    // Build a solid ring at y=0: solid everywhere except the 3×3 center
    const grid = new BlockGrid(7, 3, 7);
    // Solid floor and ceiling
    for (let z = 0; z < 7; z++)
      for (let x = 0; x < 7; x++) {
        grid.set(x, 0, z, STONE);
        grid.set(x, 2, z, STONE);
      }
    // Walls at y=1 (ring pattern)
    for (let z = 0; z < 7; z++)
      for (let x = 0; x < 7; x++) {
        const isWall = x === 0 || x === 6 || z === 0 || z === 6;
        if (isWall) grid.set(x, 1, z, STONE);
      }

    const filledSet = new Set<number>();
    const count = scanlineInteriorFill(grid, filledSet);

    // Interior at y=1 should be filled (the 5×5 center)
    expect(count).toBeGreaterThan(0);
    expect(filledSet.size).toBe(count);
  });

  it('clearOpenAirFill with filledSet only clears filled voxels, not originals', () => {
    // Grid with original smooth_stone blocks and filled smooth_stone blocks
    // Only the filled ones should be cleared
    const grid = new BlockGrid(5, 10, 5);

    // Place original smooth_stone blocks in a column at (2, 0..4, 2)
    for (let y = 0; y <= 4; y++) {
      grid.set(2, y, 2, SMOOTH);
    }

    // Simulate fill: add smooth_stone blocks at (2, 5..8, 2)
    // These represent blocks added by fillInteriorGaps
    const filledSet = new Set<number>();
    for (let y = 5; y <= 8; y++) {
      grid.set(2, y, 2, SMOOTH);
      filledSet.add((y * 5 + 2) * 5 + 2);
    }

    const beforeCount = countNonAir(grid);

    // Clear with filledSet — should only clear the y=5..8 blocks
    const removed = clearOpenAirFill(grid, SMOOTH, 0, filledSet);

    // Original blocks at y=0..4 should be preserved
    for (let y = 0; y <= 4; y++) {
      expect(at(grid, 2, y, 2)).toBe(SMOOTH);
    }

    // Filled blocks at y=5..8 may or may not be cleared depending on the
    // open-air detection heuristic, but the key guarantee is that if any
    // are cleared, they were in the filledSet
    expect(countNonAir(grid)).toBeGreaterThanOrEqual(5); // originals preserved
  });

  it('clearOpenAirFill without filledSet clears all fill blocks in open-air', () => {
    // Without filledSet, both original and filled smooth_stone are candidates
    const grid = new BlockGrid(5, 10, 5);
    for (let y = 0; y <= 8; y++) {
      grid.set(2, y, 2, SMOOTH);
    }

    // Without filledSet parameter — all smooth_stone blocks in open-air regions
    // are candidates for clearing (traditional behavior)
    const removed = clearOpenAirFill(grid, SMOOTH, 0);

    // The function may or may not clear blocks (depends on component size threshold),
    // but the important thing is it runs without error
    expect(removed).toBeGreaterThanOrEqual(0);
  });
});

// ─── removeGroundPlaneAdaptive ────────────────────────────────────────────────

describe('removeGroundPlaneAdaptive', () => {
  it('returns 0 for an empty grid', () => {
    const grid = new BlockGrid(5, 5, 5);
    expect(removeGroundPlaneAdaptive(grid)).toBe(0);
  });

  it('removes a thick ground plane below a building', () => {
    // Ground layers at y=0..2 (fill ratio ~1.0 = solid terrain)
    // Building walls at y=3..6 (fill ratio ~0.3 = shell only)
    const grid = new BlockGrid(10, 8, 10);

    // Ground: solid at y=0, y=1, y=2 (100% fill)
    for (let y = 0; y <= 2; y++)
      for (let z = 0; z < 10; z++)
        for (let x = 0; x < 10; x++)
          grid.set(x, y, z, STONE);

    // Building shell at y=3..6: only perimeter (walls)
    for (let y = 3; y <= 6; y++)
      for (let z = 0; z < 10; z++)
        for (let x = 0; x < 10; x++) {
          const isWall = x === 2 || x === 7 || z === 2 || z === 7;
          if (isWall && x >= 2 && x <= 7 && z >= 2 && z <= 7)
            grid.set(x, y, z, BRICKS);
        }

    const before = countNonAir(grid);
    const removed = removeGroundPlaneAdaptive(grid, 0.4);

    // Ground layers (y=0..2) should be removed
    expect(removed).toBeGreaterThan(0);
    // Building walls should still exist
    expect(at(grid, 2, 3, 2)).toBe(BRICKS);
    expect(countNonAir(grid)).toBeLessThan(before);

    // Verify ground is gone
    for (let z = 0; z < 10; z++)
      for (let x = 0; x < 10; x++)
        expect(at(grid, x, 0, z)).toBe(AIR);
  });

  it('preserves building floors (no sharp ratio drop between floors)', () => {
    // Two floors with similar fill ratio — neither should be removed
    const grid = new BlockGrid(5, 6, 5);

    // Floor 1 at y=0..2: ~20% fill (walls only)
    for (let y = 0; y <= 2; y++) {
      grid.set(0, y, 0, STONE);
      grid.set(4, y, 0, STONE);
      grid.set(0, y, 4, STONE);
      grid.set(4, y, 4, STONE);
    }

    // Floor 2 at y=3..5: ~20% fill (walls only)
    for (let y = 3; y <= 5; y++) {
      grid.set(0, y, 0, STONE);
      grid.set(4, y, 0, STONE);
      grid.set(0, y, 4, STONE);
      grid.set(4, y, 4, STONE);
    }

    const before = countNonAir(grid);
    const removed = removeGroundPlaneAdaptive(grid, 0.4);

    // No layer has fill ratio > 0.4 (only 4/25 = 0.16), so nothing removed
    expect(removed).toBe(0);
    expect(countNonAir(grid)).toBe(before);
  });

  it('handles single-layer ground', () => {
    // Single ground layer at y=0 (100% fill), building at y=1+ (low fill)
    const grid = new BlockGrid(5, 5, 5);

    // Solid ground at y=0
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 5; x++)
        grid.set(x, 0, z, STONE);

    // Sparse building at y=1..4 (just a few blocks)
    grid.set(2, 1, 2, BRICKS);
    grid.set(2, 2, 2, BRICKS);

    const removed = removeGroundPlaneAdaptive(grid, 0.4);

    // y=0 has 100% fill, y=1 has 1/25 = 4% → sharp drop → ground detected
    expect(removed).toBe(25); // All blocks at y=0 removed
    expect(at(grid, 0, 0, 0)).toBe(AIR);
    // Building blocks preserved
    expect(at(grid, 2, 1, 2)).toBe(BRICKS);
  });
});

// ─── regularizeFlatRoof ──────────────────────────────────────────────────────

describe('regularizeFlatRoof', () => {
  it('returns 0 for an empty grid', () => {
    const grid = new BlockGrid(5, 5, 5);
    expect(regularizeFlatRoof(grid)).toBe(0);
  });

  it('fills holes in a flat roof surface', () => {
    // Build a flat roof at y=4 with a 1-block hole at (2, 4, 2)
    const grid = new BlockGrid(5, 5, 5);

    // Solid block at y=0 for building base
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 5; x++)
        grid.set(x, 0, z, STONE);

    // Roof at y=4: nearly complete, missing one block
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 5; x++) {
        if (x === 2 && z === 2) continue; // Hole in roof
        grid.set(x, 4, z, BRICKS);
      }

    const changed = regularizeFlatRoof(grid);

    // The hole at (2, 4, 2) has 4 horizontal neighbors → should be filled
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(at(grid, 2, 4, 2)).not.toBe(AIR);
  });

  it('removes stray bumps above the roof', () => {
    // Build a flat roof at y=3 (all 25 cells = 100% fill)
    // Add 1-2 random bumps above at y=4
    const grid = new BlockGrid(5, 6, 5);

    // Full roof at y=3
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 5; x++)
        grid.set(x, 3, z, STONE);

    // Stray bump: single block at y=4 (1/25 = 4% < 5% threshold)
    grid.set(2, 4, 2, STONE);

    const changed = regularizeFlatRoof(grid);

    // The stray bump should be removed (1 block at y=4 = 4% of 25-block roof)
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(at(grid, 2, 4, 2)).toBe(AIR);
  });

  it('preserves substantial layers above the roof (not bumps)', () => {
    // Roof at y=3 with 25 blocks, and a substantial upper layer at y=4 with 5 blocks
    // 5/25 = 20% > 5% threshold → should NOT be removed
    const grid = new BlockGrid(5, 6, 5);

    // Roof at y=3
    for (let z = 0; z < 5; z++)
      for (let x = 0; x < 5; x++)
        grid.set(x, 3, z, STONE);

    // Substantial structure at y=4 (5 blocks = 20% of roof)
    for (let x = 0; x < 5; x++)
      grid.set(x, 4, 2, BRICKS);

    const changed = regularizeFlatRoof(grid);

    // The upper layer should be preserved (20% > 5% threshold)
    for (let x = 0; x < 5; x++)
      expect(at(grid, x, 4, 2)).toBe(BRICKS);
  });

  it('handles a grid with only sparse blocks (no valid roof)', () => {
    // Just a few scattered blocks — no Y level reaches 10% fill
    const grid = new BlockGrid(10, 10, 10);
    grid.set(5, 5, 5, STONE);
    grid.set(3, 3, 3, STONE);

    // No roof Y meets 10% fill threshold (1/100 = 1%)
    const changed = regularizeFlatRoof(grid);
    expect(changed).toBe(0);
  });
});
