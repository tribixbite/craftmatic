/**
 * Tests for NLCD Tree Canopy Cover API client.
 */

import { describe, it, expect } from 'vitest';
import { queryNlcdCanopy } from '../web/src/ui/import-nlcd.js';

describe('queryNlcdCanopy', () => {
  it('returns canopy percentage for a forested US location', async () => {
    // Great Smoky Mountains — high canopy cover expected
    const result = await queryNlcdCanopy(35.6131, -83.4895);
    expect(result.canopyCoverPct).not.toBeNull();
    if (result.canopyCoverPct != null) {
      expect(result.canopyCoverPct).toBeGreaterThan(50);
      expect(result.canopyCoverPct).toBeLessThanOrEqual(99);
    }
  }, 15000);

  it('returns low canopy for an urban location', async () => {
    // Downtown Manhattan — very low canopy expected
    const result = await queryNlcdCanopy(40.7128, -74.0060);
    expect(result.canopyCoverPct).not.toBeNull();
    if (result.canopyCoverPct != null) {
      expect(result.canopyCoverPct).toBeLessThan(30);
    }
  }, 15000);

  it('returns null for a location outside CONUS', async () => {
    // Middle of the Atlantic Ocean
    const result = await queryNlcdCanopy(30.0, -50.0);
    expect(result.canopyCoverPct).toBeNull();
  }, 15000);
});
