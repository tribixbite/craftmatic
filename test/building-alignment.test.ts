import { describe, it, expect } from 'vitest';
import { computeBuildingAlignment } from '../src/convert/building-alignment.js';

describe('computeBuildingAlignment', () => {
  it('computes MBR for axis-aligned rectangle', () => {
    const polygon = [
      { lat: 40.0001, lon: -74.0001 },
      { lat: 40.0001, lon: -73.9999 },
      { lat: 39.9999, lon: -73.9999 },
      { lat: 39.9999, lon: -74.0001 },
    ];
    const result = computeBuildingAlignment(polygon, 40.0, -74.0);
    expect(result.rotationDeg % 90).toBeCloseTo(0, 0);
    expect(result.mbrWidth).toBeGreaterThan(0);
    expect(result.mbrDepth).toBeGreaterThan(0);
    expect(result.osmPolygon).toEqual(polygon);
  });

  it('detects 45° rotated square', () => {
    // Use scale-corrected offsets so the projected polygon is a true square in meters.
    // dLon must be dLat / cos(lat) so that east-west and north-south extents are equal.
    const centerLat = 40.7484;
    const centerLon = -73.9857;
    const dLat = 0.0002;
    const dLon = dLat / Math.cos(centerLat * Math.PI / 180);
    const polygon = [
      { lat: centerLat + dLat, lon: centerLon },
      { lat: centerLat, lon: centerLon + dLon },
      { lat: centerLat - dLat, lon: centerLon },
      { lat: centerLat, lon: centerLon - dLon },
    ];
    const result = computeBuildingAlignment(polygon, centerLat, centerLon);
    expect(result.rotationDeg).toBeCloseTo(45, 5);
  });

  it('computes MBR for Flatiron-like triangle', () => {
    const polygon = [
      { lat: 40.7411, lon: -73.9897 },
      { lat: 40.7414, lon: -73.9893 },
      { lat: 40.7409, lon: -73.9891 },
    ];
    const result = computeBuildingAlignment(polygon, 40.741, -73.9894);
    expect(result.mbrWidth).toBeGreaterThan(result.mbrDepth);
    expect(result.rotationRad).toBeCloseTo(result.rotationDeg * Math.PI / 180, 6);
    expect(result.primaryFaceAzimuth).toBeDefined();
  });

  it('handles degenerate polygon (< 3 points) gracefully', () => {
    const polygon = [
      { lat: 40.0, lon: -74.0 },
      { lat: 40.0001, lon: -74.0 },
    ];
    const result = computeBuildingAlignment(polygon, 40.0, -74.0);
    expect(result.rotationDeg).toBeDefined();
    expect(result.mbrWidth).toBeGreaterThanOrEqual(0);
  });

  it('includes center and polygon in result', () => {
    const polygon = [
      { lat: 40.0001, lon: -74.0001 },
      { lat: 40.0001, lon: -73.9999 },
      { lat: 39.9999, lon: -73.9999 },
    ];
    const result = computeBuildingAlignment(polygon, 40.0, -74.0);
    expect(result.center).toEqual({ lat: 40.0, lon: -74.0 });
    expect(result.osmPolygon).toEqual(polygon);
  });
});
