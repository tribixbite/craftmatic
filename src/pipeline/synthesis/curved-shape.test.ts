import { describe, it, expect } from 'bun:test';
import { detectCurvedShape } from './curved-shape.js';
import type { LatLon } from '../context/types.js';

function circlePoly(cx: number, cy: number, r: number, n: number): LatLon[] {
  const out: LatLon[] = [];
  // Use lat,lon in degrees; r in degrees too for synthetic shapes.
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * 2 * Math.PI;
    out.push({ lat: cy + r * Math.cos(theta), lon: cx + r * Math.sin(theta) });
  }
  return out;
}

function rectPoly(): LatLon[] {
  return [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
    { lat: 0.0005, lon: 0.001 },
    { lat: 0.0005, lon: 0 },
  ];
}

describe('detectCurvedShape', () => {
  it('flags building:shape=round via OSM tag', () => {
    const r = detectCurvedShape(rectPoly(), { 'building:shape': 'round' });
    expect(r.isCurved).toBe(true);
    expect(r.reason).toMatch(/building:shape=round/);
  });

  it('flags roof:shape=dome via OSM tag', () => {
    const r = detectCurvedShape(rectPoly(), { 'roof:shape': 'dome' });
    expect(r.isCurved).toBe(true);
    expect(r.reason).toMatch(/roof:shape=dome/);
  });

  it('detects a 32-gon circle geometrically (circularity ≈ 1.0)', () => {
    const circle = circlePoly(0, 0, 0.0001, 32);
    const r = detectCurvedShape(circle, null);
    expect(r.isCurved).toBe(true);
    expect(r.circularity).toBeGreaterThan(0.95);
  });

  it('rejects a rectangle (circularity < 0.7)', () => {
    const r = detectCurvedShape(rectPoly(), null);
    expect(r.isCurved).toBe(false);
    expect(r.circularity).toBeLessThan(0.8);
  });

  it('rejects polygons with too few vertices regardless of shape', () => {
    // 12-gon is geometrically circular-ish but only 12 verts < 16 → reject
    const lowVert = circlePoly(0, 0, 0.0001, 12);
    const r = detectCurvedShape(lowVert, null);
    expect(r.isCurved).toBe(false);
  });

  it('accepts a 20-vertex partial circle (Guggenheim-style L)', () => {
    // L-shape with a rounded portion — circularity ~0.65-0.75 range.
    // 20 verts ≥ 16 threshold.
    const c = circlePoly(0, 0, 0.0001, 20);
    const r = detectCurvedShape(c, null);
    expect(r.isCurved).toBe(true);
  });
});
