import { describe, it, expect } from 'bun:test';
import { decomposePolygonByWaists } from './polygon-decompose.js';

// Build a "dumbbell" polygon — two 20×20m squares connected by a 3×3m
// neck. Decomposer should split at the neck into two squares.
function dumbbellPolygon() {
  // All in lat/lon degrees, scaled at lat=0 for clean metres math.
  // 1m ≈ 0.0000090° at lat 0 (north-south) and lat 0 longitude.
  const m = 0.0000090;
  // Left tower: x ∈ [-25, -5], y ∈ [-10, 10]
  // Neck: x ∈ [-5, 5], y ∈ [-1.5, 1.5]
  // Right tower: x ∈ [5, 25], y ∈ [-10, 10]
  // Walk perimeter CCW starting top-left
  return [
    { lat:  10 * m, lon: -25 * m },
    { lat:  10 * m, lon:  -5 * m },
    { lat: 1.5 * m, lon:  -5 * m },
    { lat: 1.5 * m, lon:   5 * m },
    { lat:  10 * m, lon:   5 * m },
    { lat:  10 * m, lon:  25 * m },
    { lat: -10 * m, lon:  25 * m },
    { lat: -10 * m, lon:   5 * m },
    { lat: -1.5 * m, lon:   5 * m },
    { lat: -1.5 * m, lon:  -5 * m },
    { lat: -10 * m, lon:  -5 * m },
    { lat: -10 * m, lon: -25 * m },
  ];
}

describe('decomposePolygonByWaists', () => {
  it('returns single polygon unchanged when no waist exists (Flatiron wedge)', () => {
    // Wedge: long narrow triangle, no opposing-edge waist
    const m = 0.0000090;
    const wedge = [
      { lat: 0, lon: -14 * m },        // wide base, west corner
      { lat: 0, lon:  14 * m },        // wide base, east corner
      { lat: 87 * m, lon: 0 },         // tip
    ];
    const result = decomposePolygonByWaists(wedge, { maxChordM: 8 });
    expect(result.length).toBe(1);
    expect(result[0].length).toBe(3);
  });

  it('splits a dumbbell polygon at its 3m neck', () => {
    const dumbbell = dumbbellPolygon();
    const result = decomposePolygonByWaists(dumbbell, { maxChordM: 5 });
    expect(result.length).toBe(2);
    // Each child should be roughly 20×20 = 400 m² (plus a bit of neck)
    // Sanity: vertex counts should add up
    const totalVerts = result.reduce((s, r) => s + r.length, 0);
    expect(totalVerts).toBeGreaterThanOrEqual(dumbbell.length);
  });

  it('respects maxDepth — does not over-decompose', () => {
    const dumbbell = dumbbellPolygon();
    const result = decomposePolygonByWaists(dumbbell, { maxChordM: 5, maxDepth: 0 });
    expect(result.length).toBe(1); // depth=0 → no splits at all
  });

  it('drops slivers under minChildAreaSqm', () => {
    const dumbbell = dumbbellPolygon();
    // Each tower is ~400 m². Set minArea > one tower → no split allowed.
    const result = decomposePolygonByWaists(dumbbell, { maxChordM: 5, minChildAreaSqm: 500 });
    expect(result.length).toBe(1);
  });

  it('rejects chord whose midpoint falls outside polygon (concave U-shape)', () => {
    // U-shape — two parallel arms with a gap between them. The chord
    // across the gap mouth is short but the midpoint is OUTSIDE the
    // polygon — should not split.
    const m = 0.0000090;
    const u = [
      { lat: -10 * m, lon: -20 * m },
      { lat: -10 * m, lon:  20 * m },
      { lat:  10 * m, lon:  20 * m },
      { lat:  10 * m, lon:   5 * m },
      { lat:  -5 * m, lon:   5 * m },
      { lat:  -5 * m, lon:  -5 * m },
      { lat:  10 * m, lon:  -5 * m },
      { lat:  10 * m, lon: -20 * m },
    ];
    const result = decomposePolygonByWaists(u, { maxChordM: 12 });
    expect(result.length).toBe(1); // chord across the U mouth is outside polygon
  });
});
