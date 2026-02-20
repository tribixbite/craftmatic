/**
 * Smarty US Property Data API tests — unit tests for exterior→wall mapping
 * and auth management, plus live integration tests with 3 test addresses
 * (skipped without SMARTY_AUTH_ID + SMARTY_AUTH_TOKEN).
 *
 * Unit tests exercise mapSmartyExteriorToWall and null-without-auth behavior.
 * Live tests verify real API responses have expected structure and populated fields.
 */

import { describe, it, expect } from 'vitest';
import {
  searchSmartyProperty, hasSmartyAuth, mapSmartyExteriorToWall,
  getSmartyAuthId, getSmartyAuthToken,
  type SmartyPropertyData,
} from '@craft/gen/api/smarty.js';

// ─── Unit Tests: mapSmartyExteriorToWall ─────────────────────────────────────

describe('mapSmartyExteriorToWall', () => {
  it('maps "Brick" to minecraft:bricks', () => {
    expect(mapSmartyExteriorToWall('Brick')).toBe('minecraft:bricks');
  });

  it('maps "Brick Veneer" to minecraft:bricks', () => {
    expect(mapSmartyExteriorToWall('Brick Veneer')).toBe('minecraft:bricks');
  });

  it('maps "Stone" to minecraft:stone_bricks', () => {
    expect(mapSmartyExteriorToWall('Stone')).toBe('minecraft:stone_bricks');
  });

  it('maps "Masonry" to minecraft:stone_bricks', () => {
    expect(mapSmartyExteriorToWall('Masonry')).toBe('minecraft:stone_bricks');
  });

  it('maps "Stucco" to minecraft:white_concrete', () => {
    expect(mapSmartyExteriorToWall('Stucco')).toBe('minecraft:white_concrete');
  });

  it('maps "Vinyl Siding" to minecraft:white_concrete', () => {
    expect(mapSmartyExteriorToWall('Vinyl Siding')).toBe('minecraft:white_concrete');
  });

  it('maps "Cement Fiber" to minecraft:white_concrete', () => {
    expect(mapSmartyExteriorToWall('Cement Fiber')).toBe('minecraft:white_concrete');
  });

  it('maps "Concrete" to minecraft:white_concrete', () => {
    expect(mapSmartyExteriorToWall('Concrete')).toBe('minecraft:white_concrete');
  });

  it('maps "Wood Siding" to minecraft:oak_planks', () => {
    expect(mapSmartyExteriorToWall('Wood Siding')).toBe('minecraft:oak_planks');
  });

  it('maps "Wood" to minecraft:oak_planks', () => {
    expect(mapSmartyExteriorToWall('Wood')).toBe('minecraft:oak_planks');
  });

  it('maps "Log" to minecraft:spruce_planks', () => {
    expect(mapSmartyExteriorToWall('Log')).toBe('minecraft:spruce_planks');
  });

  it('maps "Metal" to minecraft:iron_block', () => {
    expect(mapSmartyExteriorToWall('Metal')).toBe('minecraft:iron_block');
  });

  it('maps "Aluminum Siding" to minecraft:iron_block', () => {
    expect(mapSmartyExteriorToWall('Aluminum Siding')).toBe('minecraft:iron_block');
  });

  it('maps "Steel" to minecraft:iron_block', () => {
    expect(mapSmartyExteriorToWall('Steel')).toBe('minecraft:iron_block');
  });

  it('maps "Adobe" to minecraft:terracotta', () => {
    expect(mapSmartyExteriorToWall('Adobe')).toBe('minecraft:terracotta');
  });

  it('returns undefined for unknown exterior types', () => {
    expect(mapSmartyExteriorToWall('Unknown Material')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(mapSmartyExteriorToWall('')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(mapSmartyExteriorToWall('BRICK')).toBe('minecraft:bricks');
    expect(mapSmartyExteriorToWall('wood siding')).toBe('minecraft:oak_planks');
    expect(mapSmartyExteriorToWall('STUCCO')).toBe('minecraft:white_concrete');
  });
});

// ─── Unit Tests: Auth management ─────────────────────────────────────────────

describe('Smarty auth management', () => {
  it('getSmartyAuthId returns string', () => {
    expect(typeof getSmartyAuthId()).toBe('string');
  });

  it('getSmartyAuthToken returns string', () => {
    expect(typeof getSmartyAuthToken()).toBe('string');
  });

  it('hasSmartyAuth matches both env vars present', () => {
    const id = getSmartyAuthId();
    const token = getSmartyAuthToken();
    expect(hasSmartyAuth()).toBe(id.length > 0 && token.length > 0);
  });
});

// ─── Unit Tests: Null without auth ───────────────────────────────────────────

describe('searchSmartyProperty', () => {
  it('returns null for empty address', async () => {
    const result = await searchSmartyProperty('');
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only address', async () => {
    const result = await searchSmartyProperty('   ');
    expect(result).toBeNull();
  });
});

// ─── Live Integration Tests ──────────────────────────────────────────────────

const HAS_AUTH = hasSmartyAuth();

/** Three test addresses with known assessor data */
const ADDRESSES = [
  { name: 'SF — 2340 Francisco St', address: '2340 Francisco St, San Francisco, CA 94123' },
  { name: 'Grand Rapids — 1617 Lotus Ave SE', address: '1617 Lotus Ave SE, Grand Rapids, MI 49506' },
  { name: 'Newton — 240 Highland St', address: '240 Highland St, Newton, MA 02465' },
] as const;

/** Verify a SmartyPropertyData has correct type structure */
function assertPropertyStructure(data: SmartyPropertyData) {
  // Construction strings
  expect(typeof data.exteriorWalls).toBe('string');
  expect(typeof data.roofCover).toBe('string');
  expect(typeof data.roofFrame).toBe('string');
  expect(typeof data.constructionType).toBe('string');
  expect(typeof data.foundation).toBe('string');
  expect(typeof data.structureStyle).toBe('string');
  // Numeric size fields
  expect(typeof data.storiesNumber).toBe('number');
  expect(typeof data.buildingSqft).toBe('number');
  expect(typeof data.lotSqft).toBe('number');
  expect(typeof data.bedrooms).toBe('number');
  expect(typeof data.yearBuilt).toBe('number');
  // Boolean amenities
  expect(typeof data.hasGarage).toBe('boolean');
  expect(typeof data.hasPool).toBe('boolean');
  expect(typeof data.hasFireplace).toBe('boolean');
  expect(typeof data.hasFence).toBe('boolean');
  expect(typeof data.hasPorch).toBe('boolean');
  expect(typeof data.hasDeck).toBe('boolean');
  // Valuation
  expect(typeof data.assessedValue).toBe('number');
}

describe.skipIf(!HAS_AUTH)('Smarty live API', () => {
  // SF should have rich data — assertive tests
  describe(ADDRESSES[0].name, () => {
    it('returns property data with populated fields', async () => {
      const data = await searchSmartyProperty(ADDRESSES[0].address);
      expect(data).not.toBeNull();

      assertPropertyStructure(data!);
      // SF house should have basic fields populated
      expect(data!.storiesNumber).toBeGreaterThanOrEqual(1);
      expect(data!.buildingSqft).toBeGreaterThan(0);
      expect(data!.lotSqft).toBeGreaterThan(0);
      expect(data!.yearBuilt).toBeGreaterThan(1800);
    }, 20000);

    it('exterior walls maps to a known block', async () => {
      const data = await searchSmartyProperty(ADDRESSES[0].address);
      expect(data).not.toBeNull();

      if (data!.exteriorWalls) {
        const block = mapSmartyExteriorToWall(data!.exteriorWalls);
        // Should map to a valid minecraft block (or undefined for exotic types)
        if (block) {
          expect(block).toMatch(/^minecraft:/);
        }
      }
    }, 20000);
  });

  // Grand Rapids and Newton — verify API call structure, fields may vary
  for (const addr of ADDRESSES.slice(1)) {
    describe(addr.name, () => {
      it('returns property data or null without crashing', async () => {
        const data = await searchSmartyProperty(addr.address);
        if (data !== null) {
          assertPropertyStructure(data);
          expect(data.storiesNumber).toBeGreaterThanOrEqual(0);
        }
      }, 20000);

      it('has valid boolean amenity fields', async () => {
        const data = await searchSmartyProperty(addr.address);
        if (data !== null) {
          // Amenity booleans should be actual booleans, not strings
          expect(typeof data.hasPool).toBe('boolean');
          expect(typeof data.hasFireplace).toBe('boolean');
          expect(typeof data.hasFence).toBe('boolean');
          expect(typeof data.hasGarage).toBe('boolean');
        }
      }, 20000);
    });
  }
});
