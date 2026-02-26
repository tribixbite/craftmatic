/**
 * Tests for Meta/WRI canopy height COG query.
 */

import { describe, it, expect } from 'vitest';
import { queryCanopyHeight } from '../web/src/ui/import-canopy-height.js';

describe('queryCanopyHeight', () => {
  it('returns tall trees in Great Smoky Mountains', async () => {
    const result = await queryCanopyHeight(35.6131, -83.4895);
    expect(result.heightMeters).not.toBeNull();
    if (result.heightMeters != null) {
      expect(result.heightMeters).toBeGreaterThan(5);
      expect(result.heightMeters).toBeLessThan(60);
    }
  }, 30000);

  it('returns null for middle of ocean', async () => {
    const result = await queryCanopyHeight(30.0, -50.0);
    expect(result.heightMeters).toBeNull();
  }, 30000);

  it('returns low/null for downtown Manhattan', async () => {
    const result = await queryCanopyHeight(40.7128, -74.0060);
    // Dense urban area — very low or null canopy
    if (result.heightMeters != null) {
      expect(result.heightMeters).toBeLessThan(15);
    }
  }, 30000);
});
