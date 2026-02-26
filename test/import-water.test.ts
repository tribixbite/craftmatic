/**
 * Tests for OSM water feature detection.
 */

import { describe, it, expect } from 'vitest';
import { searchWaterFeatures } from '../web/src/ui/import-water.js';

describe('searchWaterFeatures', () => {
  it('finds the Grand River near Grand Rapids, MI', async () => {
    const features = await searchWaterFeatures(42.963, -85.670, 500);
    expect(features.length).toBeGreaterThan(0);
    const river = features.find(f => f.name?.includes('Grand'));
    expect(river).toBeDefined();
  }, 40000);

  it('returns empty for middle of ocean', async () => {
    const features = await searchWaterFeatures(30.0, -50.0, 200);
    expect(features).toEqual([]);
  }, 40000);

  it('finds Central Park lake in NYC', async () => {
    // The Reservoir / Jacqueline Kennedy Onassis Reservoir
    const features = await searchWaterFeatures(40.7855, -73.9631, 300);
    expect(features.length).toBeGreaterThan(0);
    expect(features.some(f => f.type === 'water' || f.type === 'lake' || f.type === 'reservoir')).toBe(true);
  }, 40000);
});
