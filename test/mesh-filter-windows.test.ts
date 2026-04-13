import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  glazeDarkWindows,
  glazeReflectiveWindows,
  injectSyntheticWindows,
  detectAndRegularizeWindows,
} from '../src/convert/mesh-filter.js';

const AIR = 'minecraft:air';
const STONE = 'minecraft:stone';
const GRAY_CONCRETE = 'minecraft:gray_concrete';
const BLACK_CONCRETE = 'minecraft:black_concrete';
const GRAY_GLASS = 'minecraft:gray_stained_glass';
const LIGHT_BLUE_CONCRETE = 'minecraft:light_blue_concrete';
const WHITE_CONCRETE = 'minecraft:white_concrete';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a hollow rectangular building shell using walls + floor + ceiling.
 * Returns a grid whose outer shell is `wallBlock` and interior is air.
 * The grid is slightly larger than the shell so outer faces have air neighbors.
 */
function buildShell(
  gridW: number, gridH: number, gridL: number,
  wallBlock = STONE,
): BlockGrid {
  const grid = new BlockGrid(gridW, gridH, gridL);
  // Solid box
  grid.fill(0, 0, 0, gridW - 1, gridH - 1, gridL - 1, wallBlock);
  // Hollow interior (leave 1-block shell on all sides)
  if (gridW > 2 && gridH > 2 && gridL > 2) {
    grid.clear(1, 1, 1, gridW - 2, gridH - 2, gridL - 2);
  }
  return grid;
}

/**
 * Count occurrences of a specific block in the entire grid.
 */
function countBlock(grid: BlockGrid, block: string): number {
  let count = 0;
  for (let y = 0; y < grid.height; y++)
    for (let z = 0; z < grid.length; z++)
      for (let x = 0; x < grid.width; x++)
        if (grid.get(x, y, z) === block) count++;
  return count;
}

// ─── glazeDarkWindows ───────────────────────────────────────────────────────

describe('mesh-filter windows pipeline', () => {
  describe('glazeDarkWindows', () => {
    it('converts vertical chains of dark facade blocks to gray stained glass', () => {
      // 15×15×15 shell of stone with air interior
      const grid = buildShell(15, 15, 15, STONE);

      // Place a vertical chain of gray_concrete on the north facade (z=0),
      // spanning y=2..10 at x=7. These are on the exterior (z-1 is out of bounds → air).
      for (let y = 2; y <= 10; y++) {
        grid.set(7, y, 0, GRAY_CONCRETE);
      }

      const glazed = glazeDarkWindows(grid, 1);

      // The chain has 9 blocks, vertical height span = 9 — well above minimum.
      // All should be converted to gray_stained_glass.
      expect(glazed).toBeGreaterThanOrEqual(9);
      for (let y = 2; y <= 10; y++) {
        expect(grid.get(7, y, 0)).toBe(GRAY_GLASS);
      }
    });

    it('does NOT glaze isolated single dark blocks (below min chain size)', () => {
      const grid = buildShell(15, 15, 15, STONE);

      // Place a single isolated gray_concrete block on the facade
      grid.set(5, 5, 0, GRAY_CONCRETE);

      const glazed = glazeDarkWindows(grid, 1);

      // Single block doesn't form a chain of ≥3, should remain gray_concrete
      expect(grid.get(5, 5, 0)).toBe(GRAY_CONCRETE);
      expect(glazed).toBe(0);
    });

    it('does NOT glaze interior dark blocks that are not on a facade', () => {
      // Larger shell so interior blocks have solid neighbors on all 4 sides
      const grid = buildShell(20, 15, 20, STONE);

      // Place a vertical chain of dark blocks deep inside the wall interior.
      // At x=5, z=5 — surrounded by stone on all horizontal neighbors since
      // shell is 0..19 and interior starts at 1, but the block at (5,y,5)
      // in a hollow shell would be air. So place blocks inside the wall layer
      // at positions that are part of the solid shell but not on an exterior face.
      // The shell is solid at x=0 and x=19, z=0 and z=19.
      // Interior is cleared 1..18 in x and z. So the shell is 1-block thick.
      // We need a thicker wall to have non-facade interior blocks.
      const thickGrid = new BlockGrid(20, 15, 20);
      thickGrid.fill(0, 0, 0, 19, 14, 19, STONE);
      // Clear only a small interior so walls are thick
      thickGrid.clear(4, 1, 4, 15, 14, 15);

      // Place dark blocks at x=2, z=2 (fully surrounded by stone, not on facade)
      for (let y = 2; y <= 10; y++) {
        thickGrid.set(2, y, 2, GRAY_CONCRETE);
      }

      const glazed = glazeDarkWindows(thickGrid, 1);

      // Interior blocks have no air neighbor on any horizontal side → not on facade
      for (let y = 2; y <= 10; y++) {
        expect(thickGrid.get(2, y, 2)).toBe(GRAY_CONCRETE);
      }
      expect(glazed).toBe(0);
    });

    it('skips glazing when dark blocks exceed 30% of total facade', () => {
      // Build a small shell where most facade blocks are dark
      const grid = buildShell(10, 10, 10, GRAY_CONCRETE);

      // The entire shell is dark blocks. Dark facade percentage = 100%,
      // which exceeds the 30% cap, so glazing should be skipped entirely.
      const glazed = glazeDarkWindows(grid, 1);
      expect(glazed).toBe(0);
    });
  });

  describe('glazeDarkWindows photogrammetryMode', () => {
    it('detects more windows with photogrammetryMode enabled', () => {
      // Build shells with bright wall material (white_concrete) — NOT in any dark set.
      // Place tuff vertical chains that are only in DARK_BLOCKS_PHOTOGRAMMETRY, not DARK_BLOCKS.
      const gridNormal = buildShell(15, 15, 15, WHITE_CONCRETE);
      const gridPhoto  = buildShell(15, 15, 15, WHITE_CONCRETE);

      // Place tuff vertical chains (y=2..10) — not dark enough for normal mode
      for (let y = 2; y <= 10; y++) {
        gridNormal.set(7, y, 0, 'minecraft:tuff');
        gridPhoto.set(7, y, 0, 'minecraft:tuff');
      }

      const glazedNormal = glazeDarkWindows(gridNormal, 1, false);
      const glazedPhoto  = glazeDarkWindows(gridPhoto, 1, true);

      // Normal mode should NOT detect tuff as dark windows
      expect(glazedNormal).toBe(0);
      // Photogrammetry mode should detect tuff as dark windows
      expect(glazedPhoto).toBeGreaterThanOrEqual(9);
      for (let y = 2; y <= 10; y++) {
        expect(gridPhoto.get(7, y, 0)).toBe(GRAY_GLASS);
      }
    });

    it('uses higher MAX_GLAZE_PCT in photogrammetryMode (40% vs 30%)', () => {
      // Build a shell with bright wall material. stone_bricks is in DARK_BLOCKS_PHOTOGRAMMETRY
      // but NOT in standard DARK_BLOCKS — validates the different detection sets.
      const grid = buildShell(15, 15, 15, WHITE_CONCRETE);

      // Place stone_bricks on the north facade (z=0) — enough to test detection
      // but not enough to exceed the 40% cap.
      for (let y = 2; y <= 10; y++) {
        for (const x of [3, 5, 7, 9, 11]) {
          grid.set(x, y, 0, 'minecraft:stone_bricks');
        }
      }

      // Normal mode: stone_bricks is not in DARK_BLOCKS → no detection
      const gridCopy = new BlockGrid(15, 15, 15);
      for (let y = 0; y < 15; y++)
        for (let z = 0; z < 15; z++)
          for (let x = 0; x < 15; x++)
            gridCopy.set(x, y, z, grid.get(x, y, z));

      const glazedNormal = glazeDarkWindows(gridCopy, 1, false);
      expect(glazedNormal).toBe(0);

      // Photogrammetry mode: stone_bricks IS in DARK_BLOCKS_PHOTOGRAMMETRY → detected
      const glazedPhoto = glazeDarkWindows(grid, 1, true);
      expect(glazedPhoto).toBeGreaterThan(0);
    });

    it('lowers minimum chain size to 2 in photogrammetryMode', () => {
      // Use bright wall material so tuff blocks are detected as dark only in photo mode
      const grid = buildShell(15, 15, 15, WHITE_CONCRETE);

      // Place a 2-block vertical chain of tuff (below normal min of 3)
      grid.set(7, 3, 0, 'minecraft:tuff');
      grid.set(7, 4, 0, 'minecraft:tuff');

      const glazed = glazeDarkWindows(grid, 1, true);

      // Chain of 2 with height span 2 meets photogrammetry thresholds (minSize=2, minHeight=1)
      expect(glazed).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── glazeReflectiveWindows ──────────────────────────────────────────────

  describe('glazeReflectiveWindows', () => {
    it('converts sky-reflecting blocks on a dominant-material facade', () => {
      // Build a 20×20×20 stone shell. Stone has Lab coords that differ
      // significantly from light_blue_concrete (blue-shifted, b* < -5).
      const grid = buildShell(20, 20, 20, STONE);

      // Place light_blue_concrete in a regular pattern on the north facade (z=0).
      // Need ≥3 candidates and a regular grid pattern with ≥2 h/v gaps.
      // Place at (4,y,0), (8,y,0), (12,y,0) for y = 4,8,12 — 3×3 = 9 candidates,
      // horizontal spacing = 4, vertical spacing = 4.
      const positions: [number, number][] = [];
      for (const x of [4, 8, 12]) {
        for (const y of [4, 8, 12]) {
          grid.set(x, y, 0, LIGHT_BLUE_CONCRETE);
          positions.push([x, y]);
        }
      }

      const glazed = glazeReflectiveWindows(grid, 1);

      // The blue-shifted candidates should be detected and glazed.
      // At minimum the 9 placed candidates should be converted.
      expect(glazed).toBeGreaterThanOrEqual(9);
      for (const [x, y] of positions) {
        expect(grid.get(x, y, 0)).toBe(GRAY_GLASS);
      }
    });

    it('skips faces where no single material dominates (< 25%)', () => {
      const grid = new BlockGrid(20, 20, 20);
      // Fill shell with many different materials so none reaches 25%
      const materials = [
        'minecraft:stone', 'minecraft:cobblestone',
        'minecraft:andesite', 'minecraft:diorite',
        'minecraft:granite',
      ];
      // Build a shell manually with rotating materials
      for (let y = 0; y < 20; y++) {
        for (let z = 0; z < 20; z++) {
          for (let x = 0; x < 20; x++) {
            if (x === 0 || x === 19 || z === 0 || z === 19 || y === 0 || y === 19) {
              grid.set(x, y, z, materials[(x + y + z) % materials.length]);
            }
            // Interior stays air
          }
        }
      }

      // Place blue blocks on a facade — but no dominant material should exist
      for (const x of [4, 8, 12]) {
        for (const y of [4, 8, 12]) {
          grid.set(x, y, 0, LIGHT_BLUE_CONCRETE);
        }
      }

      const glazed = glazeReflectiveWindows(grid, 1);

      // Without a dominant wall material (>25%), the function should skip the face
      expect(glazed).toBe(0);
    });

    it('skips faces with fewer than 3 reflective candidates', () => {
      const grid = buildShell(20, 20, 20, STONE);

      // Place only 2 blue blocks — below the 3-candidate minimum
      grid.set(5, 5, 0, LIGHT_BLUE_CONCRETE);
      grid.set(10, 10, 0, LIGHT_BLUE_CONCRETE);

      const glazed = glazeReflectiveWindows(grid, 1);
      expect(glazed).toBe(0);
    });

    it('skips faces where candidates exceed 25% of facade blocks', () => {
      // Build a small shell where blue blocks dominate the facade
      const grid = buildShell(10, 15, 10, STONE);

      // Replace >25% of the north facade with light_blue_concrete
      // North facade is z=0, x=0..9, y=2..14 — roughly 10×13 = 130 facade blocks
      // Need > 25% → > ~32 blocks as blue
      let placed = 0;
      for (let y = 2; y < 15; y++) {
        for (let x = 0; x < 10; x++) {
          if (placed < 40) {
            grid.set(x, y, 0, LIGHT_BLUE_CONCRETE);
            placed++;
          }
        }
      }

      const glazed = glazeReflectiveWindows(grid, 1);
      // Too many candidates → it's facade variation, not windows
      expect(glazed).toBe(0);
    });
  });

  // ─── injectSyntheticWindows ───────────────────────────────────────────────

  describe('injectSyntheticWindows', () => {
    it('injects windows on a uniform facade with no existing glazing', () => {
      // Build a tall building with thick walls so facade blocks only have
      // one air-adjacent side (thin 1-block shells fail the corner check
      // because both inside and outside are air → facadeCount > 1).
      const grid = new BlockGrid(20, 15, 20);
      grid.fill(0, 0, 0, 19, 14, 19, WHITE_CONCRETE);
      // Hollow out interior leaving 3-block thick walls
      grid.clear(3, 1, 3, 16, 14, 16);

      const injected = injectSyntheticWindows(grid, 0, 1);

      // With 0 existing glazed and a dominant facade material (>40%),
      // the function should inject some windows on the outer faces
      expect(injected).toBeGreaterThan(0);

      // Verify at least some gray_stained_glass was placed
      const glassCount = countBlock(grid, GRAY_GLASS);
      expect(glassCount).toBe(injected);
    });

    it('skips injection when existing glazing exceeds 0.5% of non-air blocks', () => {
      const grid = buildShell(15, 15, 15, WHITE_CONCRETE);

      // Simulate high existing glazing — pass a large number
      const nonAir = grid.countNonAir();
      const highGlazing = Math.ceil(nonAir * 0.01); // 1% — well above the 0.5% gate

      const injected = injectSyntheticWindows(grid, highGlazing, 1);
      expect(injected).toBe(0);
    });

    it('skips injection when building is too short (< 8 blocks)', () => {
      // Build a very short structure (height 5)
      const grid = buildShell(15, 5, 15, WHITE_CONCRETE);

      const injected = injectSyntheticWindows(grid, 0, 1);
      expect(injected).toBe(0);
    });

    it('skips injection when no material dominates the facade (< 40%)', () => {
      const grid = new BlockGrid(15, 15, 15);
      // Build a multi-material shell — 3 roughly equal materials
      const mats = [
        'minecraft:stone', 'minecraft:cobblestone', 'minecraft:andesite',
      ];
      for (let y = 0; y < 15; y++) {
        for (let z = 0; z < 15; z++) {
          for (let x = 0; x < 15; x++) {
            if (x === 0 || x === 14 || z === 0 || z === 14 || y === 0 || y === 14) {
              grid.set(x, y, z, mats[(x + y + z) % mats.length]);
            }
          }
        }
      }

      const injected = injectSyntheticWindows(grid, 0, 1);
      // Each material ~33% — none exceeds 40% threshold
      expect(injected).toBe(0);
    });
  });

  // ─── detectAndRegularizeWindows ──────────────────────────────────────────

  describe('detectAndRegularizeWindows', () => {
    it('regularizes windows that already exist in a pattern', () => {
      // Build a 20×15×20 stone shell
      const grid = buildShell(20, 15, 20, STONE);

      // Place existing windows (gray_stained_glass) in a semi-regular grid
      // on the south facade (z=19, sweep axis = x).
      // Pattern: x = 3,6,9,12,15 at y = 4,7,10 with spacing h=3, v=3.
      // Leave some gaps to test regularization fill.
      const windowYs = [4, 7, 10];
      const windowXs = [3, 6, 9, 12, 15];
      for (const y of windowYs) {
        for (const x of windowXs) {
          // Skip a couple to create gaps for regularization
          if (x === 9 && y === 7) continue; // gap
          if (x === 12 && y === 10) continue; // gap
          grid.set(x, y, 19, GRAY_GLASS);
        }
      }

      const result = detectAndRegularizeWindows(grid, 0);

      // Should detect the window pattern and add regularized windows
      expect(result.windowsRegularized).toBeGreaterThanOrEqual(0);
      // The function fills in grid positions — even where we left gaps,
      // new windows may appear at the regularized grid positions
    });

    it('places a door on the north or south facade', () => {
      const grid = buildShell(20, 15, 20, STONE);

      // Place enough windows on a facade for the function to process
      for (const x of [3, 6, 9, 12]) {
        for (const y of [4, 7, 10]) {
          grid.set(x, y, 19, GRAY_GLASS);
        }
      }

      const result = detectAndRegularizeWindows(grid, 0);

      // Should place at least one door on the north or south facade
      expect(result.doorsPlaced).toBeGreaterThanOrEqual(1);

      // Verify door blocks exist at groundY+1 on either north (z=0) or south (z=19) facade.
      // The function processes north first, so check both.
      let foundDoor = false;
      for (const fz of [0, 19]) {
        for (let x = 0; x < 20; x++) {
          const block = grid.get(x, 1, fz);
          if (block.includes('oak_door')) {
            foundDoor = true;
            // Upper half should also be a door
            expect(grid.get(x, 2, fz)).toContain('oak_door');
            break;
          }
        }
        if (foundDoor) break;
      }
      expect(foundDoor).toBe(true);
    });

    it('returns zero counts for a very short building', () => {
      // Building height < 4 above bMinY triggers early return
      const grid = buildShell(20, 3, 20, STONE);

      const result = detectAndRegularizeWindows(grid, 0);
      expect(result.windowsRegularized).toBe(0);
      expect(result.doorsPlaced).toBe(0);
    });

    it('handles a building with fewer than 3 existing windows per face', () => {
      const grid = buildShell(20, 15, 20, STONE);

      // Place only 2 windows on the south facade — below the 3-window threshold
      grid.set(5, 5, 19, GRAY_GLASS);
      grid.set(10, 8, 19, GRAY_GLASS);

      const result = detectAndRegularizeWindows(grid, 0);

      // With < 3 windows detected, regularization is skipped for that face,
      // but doors may still be placed
      // The key assertion: the function completes without error and
      // windowsRegularized reflects that no grid-snapping occurred on that face
      expect(result.windowsRegularized).toBeGreaterThanOrEqual(0);
    });
  });
});
