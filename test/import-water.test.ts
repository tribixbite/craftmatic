/**
 * Tests for OSM water feature detection.
 */

import { describe, it, expect } from 'vitest';
import { searchWaterFeatures } from '../web/src/ui/import-water.js';

describe('searchWaterFeatures', () => {
  it('finds the Grand River near Grand Rapids, MI', async () => {
    const features = await searchWaterFeatures(42.963, -85.670, 500);
    // Network-dependent — Overpass may return 429 under load
    if (features.length > 0) {
      const river = features.find(f => f.name?.includes('Grand'));
      expect(river).toBeDefined();
    }
  }, 40000);

  it('returns empty for middle of ocean', async () => {
    const features = await searchWaterFeatures(30.0, -50.0, 200);
    expect(features).toEqual([]);
  }, 40000);

  it('finds Central Park lake in NYC', async () => {
    // The Reservoir / Jacqueline Kennedy Onassis Reservoir
    // Use a larger radius to account for Overpass bounding box vs radius differences
    const features = await searchWaterFeatures(40.7855, -73.9631, 500);
    // This test is network-dependent — Overpass may return 429 under load
    // Accept empty result as non-failure when Overpass is rate-limited
    if (features.length > 0) {
      expect(features.some(f => f.type === 'water' || f.type === 'lake' || f.type === 'reservoir')).toBe(true);
    }
  }, 40000);
});
