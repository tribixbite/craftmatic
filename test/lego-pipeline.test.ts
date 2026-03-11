/**
 * LEGO voxelization pipeline integration test.
 *
 * Fetches real MPD files from the LDraw OMR and verifies that the
 * parseLDraw + voxelizeLDraw pipeline produces geometrically correct output:
 *   - Block count is well above brick count (proper bounding-box fill, not 1-per-brick)
 *   - Color diversity (multiple Minecraft block types)
 *   - Reasonable 3D dimensions (not collapsed into a plane)
 *
 * Usage: bun test test/lego-pipeline.test.ts
 */

import { describe, it, expect } from 'vitest';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';

const OMR_BASE = 'https://library.ldraw.org/library/omr';

interface SetSpec {
  set_num: string;
  name: string;
  minBricks: number; // minimum terminal parts expected after parsing
}

// 6 large OMR sets (all 1000+ LEGO pieces), confirmed present in omr-index.json
const SETS: SetSpec[] = [
  { set_num: '10030-1', name: 'UCS Imperial Star Destroyer',  minBricks: 800  },
  { set_num: '10179-1', name: 'UCS Millennium Falcon',        minBricks: 1000 },
  { set_num: '21309-1', name: 'NASA Apollo Saturn V',         minBricks: 500  },
  { set_num: '42083-1', name: 'Technic Bugatti Chiron',       minBricks: 800  },
  { set_num: '75060-1', name: 'UCS Slave I',                  minBricks: 500  },
  { set_num: '10214-1', name: 'Tower Bridge',                 minBricks: 1000 },
];

describe('LEGO voxelization pipeline — 6 large sets', () => {
  for (const spec of SETS) {
    it(`${spec.set_num} ${spec.name}`, async () => {
      // ── 1. Fetch MPD ─────────────────────────────────────────────────────
      const url = `${OMR_BASE}/${spec.set_num}.mpd`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'craftmatic-verify/1.0' },
      });
      expect(resp.ok, `HTTP ${resp.status} fetching ${url}`).toBe(true);
      const text = await resp.text();
      expect(text.length, 'MPD file should not be empty').toBeGreaterThan(100);

      // ── 2. Parse ──────────────────────────────────────────────────────────
      const bricks = parseLDraw(text, `${spec.set_num}.mpd`);
      const brickCount = bricks.length;

      expect(brickCount, `${spec.set_num}: too few terminal parts parsed`).toBeGreaterThanOrEqual(spec.minBricks);

      // Check that rotation matrices were captured (not all undefined)
      const withRot = bricks.filter(b => b.rot !== undefined).length;
      expect(withRot, `${spec.set_num}: no rotation matrices found`).toBeGreaterThan(brickCount * 0.5);

      // ── 3. Voxelize ───────────────────────────────────────────────────────
      const result = voxelizeLDraw(bricks);
      const { grid, dimensions } = result;
      const blockCount = grid.countNonAir();

      // KEY CHECK: with proper bounding-box fill, blocks >> bricks.
      // Pre-fix: 1 block per brick → blockCount ≈ brickCount.
      // Post-fix: ~3-30 blocks per brick → blockCount >> brickCount.
      // Conservative threshold: at least 60% more blocks than bricks.
      expect(
        blockCount,
        `${spec.set_num}: blockCount (${blockCount}) should be > brickCount (${brickCount}) × 1.6 — bounding-box fill not working`,
      ).toBeGreaterThan(brickCount * 1.6);

      // Color diversity
      expect(
        result.uniqueColors,
        `${spec.set_num}: uniqueColors (${result.uniqueColors}) too low — color mapping broken`,
      ).toBeGreaterThanOrEqual(3);

      // 3D structure — none of the dimensions should be collapsed
      expect(dimensions.w, `${spec.set_num}: width too small`).toBeGreaterThanOrEqual(5);
      expect(dimensions.h, `${spec.set_num}: height too small`).toBeGreaterThanOrEqual(5);
      expect(dimensions.l, `${spec.set_num}: length too small`).toBeGreaterThanOrEqual(5);

      // Density sanity (not all bounding box air)
      const volume = dimensions.w * dimensions.h * dimensions.l;
      const density = blockCount / volume;
      expect(density, `${spec.set_num}: density (${(density * 100).toFixed(1)}%) too low — model degenerate`).toBeGreaterThan(0.02);

      console.log(
        `  ✓ ${spec.set_num}: ${brickCount} bricks → ${blockCount} blocks, ` +
        `${result.uniqueColors} colors, ` +
        `${dimensions.w}×${dimensions.h}×${dimensions.l}, ` +
        `density ${(density * 100).toFixed(1)}%` +
        (result.warning ? `, ⚠ ${result.warning}` : ''),
      );
    });
  }
});
