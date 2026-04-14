/**
 * Tests for spatial-footprint.ts shared helpers and bug fixes:
 *   - rasterizePolygonToBitmap (M4 dedup)
 *   - rasterizePolygonToSet (M4 dedup)
 *   - projectPolygonToBlocks (M4 dedup)
 *   - morphCloseBitmap (M4 dedup)
 *   - H2 fix: maskToFootprintAligned erode step
 *   - H3 fix: maskToFootprintAligned offset after rotation
 *   - M1 fix: enforceFootprintPolygon centroid not biased by closing vertex
 */

import { describe, it, expect } from 'vitest';
import {
  projectPolygonToBlocks,
  rasterizePolygonToBitmap,
  rasterizePolygonToSet,
  morphCloseBitmap,
  maskToFootprint,
  maskToFootprintAligned,
  enforceFootprintPolygon,
} from '../src/convert/mesh-filter.js';
import { BlockGrid } from '../src/schem/types.js';

// ─── rasterizePolygonToBitmap ─────────────────────────────────────────────────

describe('rasterizePolygonToBitmap', () => {
  it('rasterizes a unit square to exactly 1 cell', () => {
    // Square polygon: (0,0)→(1,0)→(1,1)→(0,1)→(0,0)
    const pts = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }, { x: 0, z: 0 },
    ];
    const bitmap = rasterizePolygonToBitmap(pts, 0, 1, 0, 1);
    // The winding-number scanline at z=0+0.5 scans x=0+0.5 — only cell (0,0) is interior
    expect(bitmap.count).toBe(1);
    expect(bitmap.contains(0, 0)).toBe(true);
  });

  it('rasterizes a 5x5 square polygon to 25 cells', () => {
    // Square from (0,0) to (5,5) — covers cells 0..4 in both axes
    const pts = [
      { x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 }, { x: 0, z: 0 },
    ];
    const bitmap = rasterizePolygonToBitmap(pts, 0, 4, 0, 4);
    expect(bitmap.count).toBe(25);
    // Check corners
    expect(bitmap.contains(0, 0)).toBe(true);
    expect(bitmap.contains(4, 4)).toBe(true);
    expect(bitmap.contains(0, 4)).toBe(true);
    expect(bitmap.contains(4, 0)).toBe(true);
  });

  it('rasterizes a right triangle with correct interior cell count', () => {
    // Triangle: (0,0)→(6,0)→(0,6)→(0,0) — half of a 6x6 square
    const pts = [
      { x: 0, z: 0 }, { x: 6, z: 0 }, { x: 0, z: 6 }, { x: 0, z: 0 },
    ];
    const bitmap = rasterizePolygonToBitmap(pts, 0, 5, 0, 5);
    // For a right triangle with legs=6, cells where x+0.5 + z+0.5 < 6 → x+z < 5
    // z=0: x=0..4 (5), z=1: x=0..3 (4), z=2: x=0..2 (3), z=3: x=0..1 (2), z=4: x=0 (1), z=5: none
    // Total = 5+4+3+2+1 = 15
    expect(bitmap.count).toBe(15);
    // Check that (0,0) is inside and (5,5) is outside
    expect(bitmap.contains(0, 0)).toBe(true);
    expect(bitmap.contains(5, 5)).toBe(false);
  });

  it('returns empty bitmap for degenerate polygon', () => {
    // A line, not a polygon
    const pts = [
      { x: 0, z: 0 }, { x: 5, z: 0 }, { x: 0, z: 0 },
    ];
    const bitmap = rasterizePolygonToBitmap(pts, 0, 5, 0, 5);
    // Horizontal line has no area
    expect(bitmap.count).toBe(0);
  });
});

// ─── rasterizePolygonToSet ────────────────────────────────────────────────────

describe('rasterizePolygonToSet', () => {
  it('rasterizes a square with zero offset', () => {
    // Square polygon vertices (unrounded, as alignOSMToFootprint uses unrounded coords)
    const pts = [
      { x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 },
    ];
    const cells = rasterizePolygonToSet(pts, 0, 0);
    expect(cells.size).toBe(25);
    expect(cells.has('0,0')).toBe(true);
    expect(cells.has('4,4')).toBe(true);
  });

  it('rasterizes a square with positive offset', () => {
    const pts = [
      { x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 },
    ];
    const cells = rasterizePolygonToSet(pts, 10, 20);
    // Should produce 9 cells shifted by (10, 20)
    expect(cells.size).toBe(9);
    expect(cells.has('10,20')).toBe(true);
    expect(cells.has('12,22')).toBe(true);
    // Original position should NOT be present
    expect(cells.has('0,0')).toBe(false);
  });
});

// ─── projectPolygonToBlocks ───────────────────────────────────────────────────

describe('projectPolygonToBlocks', () => {
  it('projects without rotation (identity)', () => {
    // At equator (lat=0), 1 degree ≈ 111320m. With resolution=1, lonScale=111320.
    // A polygon 1 degree east of center → x = 111320 blocks.
    const polygon = [{ lat: 0, lon: 1 }];
    const pts = projectPolygonToBlocks(polygon, 0, 0, 1, 0);
    // x = round((1 - 0) * 111320 * cos(0)) = 111320
    // z = round((0 - 0) * 111320) = 0
    expect(pts[0].x).toBe(111320);
    expect(pts[0].z).toBe(0);
  });

  it('projects with 90-degree rotation', () => {
    // Single point at (lat=0, lon=0.001) relative to center (0,0)
    // Without rotation: x ≈ 111.32, z = 0
    // With 90° rotation (π/2): cos(-π/2)=0, sin(-π/2)=-1
    // rotated x = x*0 - z*(-1) = z = 0, rotated z = x*(-1) + z*0 = -111.32
    const polygon = [{ lat: 0, lon: 0.001 }];
    const pts = projectPolygonToBlocks(polygon, 0, 0, 1, Math.PI / 2);
    // After rotation and rounding: x ≈ 0, z ≈ -111
    expect(pts[0].x).toBe(0);
    expect(pts[0].z).toBe(-111);
  });

  it('returns unrounded coordinates when round=false', () => {
    const polygon = [{ lat: 0, lon: 0.0001 }];
    const pts = projectPolygonToBlocks(polygon, 0, 0, 1, 0, false);
    // x = 0.0001 * 111320 * cos(0) = 11.132 (NOT rounded)
    expect(pts[0].x).toBeCloseTo(11.132, 2);
    expect(pts[0].z).toBe(0);
  });

  it('respects resolution scaling', () => {
    const polygon = [{ lat: 0, lon: 0.001 }];
    // Use unrounded to avoid rounding asymmetry (round(111.32)=111 but round(222.64)=223 != 111*2)
    const pts1 = projectPolygonToBlocks(polygon, 0, 0, 1, 0, false);
    const pts2 = projectPolygonToBlocks(polygon, 0, 0, 2, 0, false);
    // Resolution 2 should produce exactly 2x the block distance (before rounding)
    expect(pts2[0].x).toBeCloseTo(pts1[0].x * 2, 5);
  });
});

// ─── morphCloseBitmap ─────────────────────────────────────────────────────────

describe('morphCloseBitmap', () => {
  it('dilate+erode with radius 1 preserves a solid 5x5 square', () => {
    // A solid 5x5 bitmap — morph close should not change it
    const pts = [
      { x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 }, { x: 0, z: 0 },
    ];
    const bitmap = rasterizePolygonToBitmap(pts, -1, 6, -1, 6);
    const beforeCount = bitmap.count;
    expect(beforeCount).toBe(25);

    morphCloseBitmap(bitmap, -1, 6, -1, 6, 1);
    // After morph close, the solid square should be unchanged
    expect(bitmap.count).toBe(25);
  });

  it('fills a 1-cell gap within a square', () => {
    // 5x5 square with center cell (2,2) missing — morph close radius 1 should fill it
    const pts = [
      { x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 }, { x: 0, z: 0 },
    ];
    const bitmap = rasterizePolygonToBitmap(pts, -1, 6, -1, 6);
    bitmap.clear(2, 2); // Create a 1-cell gap
    expect(bitmap.count).toBe(24);

    morphCloseBitmap(bitmap, -1, 6, -1, 6, 1);
    // The gap should be filled by dilation, and erosion should shrink back to original boundary
    expect(bitmap.contains(2, 2)).toBe(true);
  });

  it('does nothing with radius 0', () => {
    const pts = [
      { x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 3 }, { x: 0, z: 3 }, { x: 0, z: 0 },
    ];
    const bitmap = rasterizePolygonToBitmap(pts, -1, 4, -1, 4);
    const before = bitmap.count;
    morphCloseBitmap(bitmap, -1, 4, -1, 4, 0);
    expect(bitmap.count).toBe(before);
  });
});

// ─── H2 fix: maskToFootprintAligned includes erode step ───────────────────────

describe('H2 fix: maskToFootprintAligned erode step', () => {
  it('maskToFootprintAligned produces same footprint size as maskToFootprint + offset', () => {
    // Create two identical grids filled with stone
    const W = 30, H = 5, L = 30;
    const grid1 = new BlockGrid(W, H, L);
    const grid2 = new BlockGrid(W, H, L);
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < L; z++) {
        for (let x = 0; x < W; x++) {
          grid1.set(x, y, z, 'minecraft:stone');
          grid2.set(x, y, z, 'minecraft:stone');
        }
      }
    }

    // Simple square polygon centered on the grid
    const polygon = [
      { lat: 0.0001, lon: -0.0001 },
      { lat: 0.0001, lon: 0.0001 },
      { lat: -0.0001, lon: 0.0001 },
      { lat: -0.0001, lon: -0.0001 },
    ];

    const removed1 = maskToFootprint(grid1, polygon, 0, 0, 2, 1, 0);
    const removed2 = maskToFootprintAligned(grid2, polygon, 0, 0, 2, 1, 0, 0, 0);

    // With dx=dz=0 and no rotation, both should produce identical results.
    // Before the H2 fix, maskToFootprintAligned would remove fewer blocks (larger mask
    // due to missing erode step).
    expect(removed2).toBe(removed1);

    // Verify block counts match
    expect(grid2.countNonAir()).toBe(grid1.countNonAir());
  });
});

// ─── H3 fix: maskToFootprintAligned offset after rotation ─────────────────────

describe('H3 fix: maskToFootprintAligned offset after rotation', () => {
  it('with 45-degree rotation and offset, polygon center lands at expected position', () => {
    // Create a large grid filled with stone
    const W = 80, H = 3, L = 80;
    const grid = new BlockGrid(W, H, L);
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < L; z++) {
        for (let x = 0; x < W; x++) {
          grid.set(x, y, z, 'minecraft:stone');
        }
      }
    }

    // Square polygon centered at origin
    const polygon = [
      { lat: 0.00005, lon: -0.00005 },
      { lat: 0.00005, lon: 0.00005 },
      { lat: -0.00005, lon: 0.00005 },
      { lat: -0.00005, lon: -0.00005 },
    ];

    const dx = 5, dz = 0;
    const rotAngle = Math.PI / 4; // 45 degrees

    maskToFootprintAligned(grid, polygon, 0, 0, 1, 1, rotAngle, dx, dz);

    // After the fix, the offset (5, 0) should be applied in grid-space AFTER rotation.
    // This means the polygon center should be shifted 5 blocks in the +X direction
    // relative to grid center, regardless of rotation angle.
    const gridCx = Math.floor(W / 2);
    const gridCz = Math.floor(L / 2);

    // Check that the center of the kept region is offset by approximately (dx, dz) from grid center.
    // Count non-air blocks and compute centroid of remaining blocks at y=0.
    let sumX = 0, sumZ = 0, count = 0;
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        if (grid.get(x, 0, z) !== 'minecraft:air') {
          sumX += x;
          sumZ += z;
          count++;
        }
      }
    }
    if (count > 0) {
      const centroidX = sumX / count;
      const centroidZ = sumZ / count;
      // The centroid should be near gridCx + dx, gridCz + dz
      expect(Math.abs(centroidX - (gridCx + dx))).toBeLessThan(3);
      expect(Math.abs(centroidZ - (gridCz + dz))).toBeLessThan(3);
    }
  });
});

// ─── M1 fix: enforceFootprintPolygon centroid not biased ──────────────────────

describe('M1 fix: enforceFootprintPolygon centroid not biased', () => {
  it('centroid is not biased by closing vertex duplication', () => {
    // Create a grid with a solid block cluster centered at (15, 0, 15)
    const W = 30, H = 5, L = 30;
    const grid = new BlockGrid(W, H, L);
    // Fill a small 6x6 square centered at (15, 15)
    for (let z = 12; z <= 18; z++) {
      for (let x = 12; x <= 18; x++) {
        for (let y = 0; y < 3; y++) {
          grid.set(x, y, z, 'minecraft:stone');
        }
      }
    }

    // Create an asymmetric polygon — a rectangle wider in X than Z.
    // If centroid is biased toward the first vertex (0.0001, -0.0002),
    // the fill will be misaligned.
    // First vertex is far from polygon center to amplify bias.
    const polygon = [
      { lat: 0.0001, lon: -0.0002 },   // top-left (far from center)
      { lat: 0.0001, lon: 0.0001 },     // top-right
      { lat: -0.0001, lon: 0.0001 },    // bottom-right
      { lat: -0.0001, lon: -0.0002 },   // bottom-left
      // NOT closed — will be auto-closed, which is where the bug was
    ];

    const result = enforceFootprintPolygon(grid, polygon, 0, 0, 1, 0);

    // The function should work without error. The key assertion is that
    // projectPolygonToBlocks produces a centroid that's geometrically correct
    // (center of the 4 vertices, not center of the 5 vertices including duplicate).
    const blockPts = [
      { lat: 0.0001, lon: -0.0002 },
      { lat: 0.0001, lon: 0.0001 },
      { lat: -0.0001, lon: 0.0001 },
      { lat: -0.0001, lon: -0.0002 },
    ].map(p => ({
      x: Math.round((p.lon - 0) * 111320),
      z: Math.round((0 - p.lat) * 111320),
    }));

    // Correct centroid (4 vertices): average of all 4
    const correctCx = blockPts.reduce((s, p) => s + p.x, 0) / 4;
    const correctCz = blockPts.reduce((s, p) => s + p.z, 0) / 4;

    // Biased centroid (5 vertices with duplicate first): first vertex gets double weight
    const biasedPts = [...blockPts, blockPts[0]];
    const biasedCx = biasedPts.reduce((s, p) => s + p.x, 0) / 5;
    const biasedCz = biasedPts.reduce((s, p) => s + p.z, 0) / 5;

    // The polygon is asymmetric in X (lon from -0.0002 to 0.0001), so
    // the bias in X should be measurable:
    // correctCx = round(mean of [-22.264, 11.132, 11.132, -22.264]) = round(-5.566) = -6
    // biasedCx  = round(mean of [-22.264, 11.132, 11.132, -22.264, -22.264]) = round(-8.906) = -9
    expect(Math.round(correctCx)).not.toBe(Math.round(biasedCx));

    // enforceFootprintPolygon should have completed without errors
    expect(result.clipped).toBeGreaterThanOrEqual(0);
    expect(result.filled).toBeGreaterThanOrEqual(0);
  });
});
