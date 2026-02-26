/**
 * Tests for USDA Plant Hardiness Zone lookup and tree palette mapping.
 */

import { describe, it, expect } from 'vitest';
import { queryHardinessZone, hardinessToTreePalette } from '../web/src/ui/import-hardiness.js';

describe('queryHardinessZone', () => {
  it('returns a valid zone for a known US ZIP', async () => {
    // Nashville, TN area — Zone 7a or 7b
    const result = await queryHardinessZone('37201');
    expect(result.zone).not.toBeNull();
    expect(result.zone).toMatch(/^[0-9]+[ab]?$/);
  }, 10000);

  it('returns null for an invalid ZIP', async () => {
    const result = await queryHardinessZone('00000');
    expect(result.zone).toBeNull();
  }, 10000);

  it('returns null for a non-numeric string', async () => {
    const result = await queryHardinessZone('abcde');
    expect(result.zone).toBeNull();
  });
});

describe('hardinessToTreePalette', () => {
  it('returns spruce + birch for very cold zones', () => {
    const palette = hardinessToTreePalette('3a');
    expect(palette).toContain('spruce');
    expect(palette).toContain('birch');
    expect(palette).not.toContain('jungle');
  });

  it('returns mixed palette for moderate zones', () => {
    const palette = hardinessToTreePalette('6b');
    expect(palette).toContain('oak');
  });

  it('returns tropical trees for hot zones', () => {
    const palette = hardinessToTreePalette('10a');
    expect(palette).toContain('jungle');
    expect(palette).toContain('acacia');
  });

  it('returns default palette for null zone', () => {
    const palette = hardinessToTreePalette(null);
    expect(palette).toContain('oak');
    expect(palette).toContain('birch');
  });
});
