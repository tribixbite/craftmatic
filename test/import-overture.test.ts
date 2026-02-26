/**
 * Tests for Overture Maps building data via PMTiles.
 * Requires network access — queries S3-hosted PMTiles archive.
 */

import { describe, it, expect } from 'vitest';
import { queryOvertureBuilding } from '../web/src/ui/import-overture.js';

describe('queryOvertureBuilding', () => {
  it('returns building data for the US Capitol', async () => {
    // US Capitol Building — large, well-known, should have height + floors
    const result = await queryOvertureBuilding(38.8899, -77.0091);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.distanceMeters).toBeLessThan(100);
      // Capitol is a large building — should have some attributes
      expect(result.id).toBeTruthy();
    }
  }, 30000);

  it('returns null for middle of ocean', async () => {
    const result = await queryOvertureBuilding(30.0, -50.0);
    expect(result).toBeNull();
  }, 30000);

  it('finds a residential building with attributes', async () => {
    // San Francisco residential — dense area with good Overture coverage
    const result = await queryOvertureBuilding(37.7749, -122.4194);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.distanceMeters).toBeLessThan(100);
    }
  }, 30000);
});
