import { describe, it, expect } from 'bun:test';
import { sliceMeshAtY, extractBands } from './slice-extract.js';
import type { MeshSliceInput } from './slice-extract.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a simple axis-aligned box mesh from (min) to (max). 12 triangles.
 * Y is up; X/Z are horizontal. Vertices are interleaved xyz.
 */
function makeBox(min: [number, number, number], max: [number, number, number]): MeshSliceInput {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    // 8 corners
    x0, y0, z0,  x1, y0, z0,  x1, y0, z1,  x0, y0, z1,  // bottom 0..3
    x0, y1, z0,  x1, y1, z0,  x1, y1, z1,  x0, y1, z1,  // top    4..7
  ]);
  const indices = new Uint32Array([
    // bottom (CW from below)
    0, 2, 1,  0, 3, 2,
    // top
    4, 5, 6,  4, 6, 7,
    // -Z
    0, 1, 5,  0, 5, 4,
    // +Z
    3, 7, 6,  3, 6, 2,
    // -X
    0, 4, 7,  0, 7, 3,
    // +X
    1, 2, 6,  1, 6, 5,
  ]);
  return { positions, indices };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('sliceMeshAtY', () => {
  it('slices a 10×20×4 box at y=2 into one rectangle', () => {
    const box = makeBox([-5, 0, -2], [5, 4, 2]);
    const polys = sliceMeshAtY([box], 2);
    expect(polys.length).toBe(1);
    const p = polys[0];
    // Area should be ~ 10 × 4 = 40 m²
    expect(p.area).toBeGreaterThan(35);
    expect(p.area).toBeLessThan(45);
    // Centroid near origin
    expect(Math.abs(p.centroid.x)).toBeLessThan(0.5);
    expect(Math.abs(p.centroid.z)).toBeLessThan(0.5);
  });

  it('returns no polygons above the box', () => {
    const box = makeBox([-5, 0, -2], [5, 4, 2]);
    const polys = sliceMeshAtY([box], 5);
    expect(polys.length).toBe(0);
  });

  it('slices two disjoint towers into two polygons', () => {
    const towerA = makeBox([-15, 0, -5], [-5, 30, 5]);
    const towerB = makeBox([5, 0, -5], [15, 30, 5]);
    const polys = sliceMeshAtY([towerA, towerB], 15);
    expect(polys.length).toBe(2);
    // Each tower is 10×10 = 100 m²
    for (const p of polys) {
      expect(p.area).toBeGreaterThan(90);
      expect(p.area).toBeLessThan(110);
    }
  });
});

describe('extractBands', () => {
  it('produces a single band for a uniform tower', () => {
    const box = makeBox([-5, 0, -2], [5, 30, 2]);
    const bands = extractBands([box], { minY: 0, maxY: 30 }, { deltaY: 1 });
    expect(bands.length).toBe(1);
    expect(bands[0].polygons.length).toBe(1);
    expect(bands[0].y1 - bands[0].y0).toBeGreaterThan(25);
  });

  it('produces two bands for a setback (wide base + narrow top)', () => {
    // Base: 0-10m, 20×20. Top: 10-30m, 10×10 centred.
    const base = makeBox([-10, 0, -10], [10, 10, 10]);
    const top  = makeBox([-5,  10, -5],  [5,  30, 5]);
    const bands = extractBands([base, top], { minY: 0, maxY: 30 }, { deltaY: 1 });
    expect(bands.length).toBeGreaterThanOrEqual(2);
    // First band's polygon should be ~400 m² (20x20)
    const sortedBands = [...bands].sort((a, b) => a.y0 - b.y0);
    expect(sortedBands[0].polygons[0].area).toBeGreaterThan(350);
    // Last band's polygon should be ~100 m² (10x10)
    const last = sortedBands[sortedBands.length - 1];
    expect(last.polygons[0].area).toBeLessThan(150);
  });

  it('reports a single-poly → two-poly transition for split-tower buildings', () => {
    // Pennzoil-style: shared base 0-5m, then two trapezoidal towers above.
    const base = makeBox([-15, 0, -5], [15, 5, 5]);
    const towerA = makeBox([-15, 5, -5], [-2, 30, 5]);
    const towerB = makeBox([2, 5, -5], [15, 30, 5]);
    const bands = extractBands([base, towerA, towerB], { minY: 0, maxY: 30 }, { deltaY: 1 });
    // Should see a band with 1 polygon (base) and a band with 2 polygons (towers)
    const polyCounts = bands.map(b => b.polygons.length).sort();
    expect(polyCounts).toContain(1);
    expect(polyCounts).toContain(2);
  });
});
