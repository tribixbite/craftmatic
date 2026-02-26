/**
 * Tests for ESA WorldCover land cover query.
 */

import { describe, it, expect } from 'vitest';
import { queryLandCover } from '../web/src/ui/import-landcover.js';

describe('queryLandCover', () => {
  it('returns tree cover for a forested area', async () => {
    // Great Smoky Mountains — should be tree cover (10)
    const result = await queryLandCover(35.6131, -83.4895);
    expect(result.classValue).toBe(10);
    expect(result.label).toBe('Tree cover');
  }, 30000);

  it('returns built-up for Manhattan', async () => {
    const result = await queryLandCover(40.7128, -74.0060);
    expect(result.classValue).toBe(50);
    expect(result.label).toBe('Built-up');
  }, 30000);

  it('returns null for middle of ocean', async () => {
    const result = await queryLandCover(30.0, -50.0);
    // Ocean tiles may not exist → null, or may return water (80)
    if (result.classValue != null) {
      expect(result.classValue).toBe(80); // water
    }
  }, 30000);
});
