/**
 * Live integration test — actually hits OSM Overpass API with 10 real
 * addresses of architecturally notable / luxury houses.
 *
 * These are real addresses found via web search. Each test verifies:
 * 1. OSM returns a building polygon (or gracefully returns null for rate limits)
 * 2. Dimensions are reasonable when data is returned
 * 3. Tags are properly parsed
 *
 * The client retries on 429/504 with exponential backoff.
 * A final summary test asserts that at least 7/10 returned real building data.
 */
import { describe, it, expect } from 'vitest';
import {
  searchOSMBuilding,
  haversineDistance,
  mapOSMMaterialToWall,
  mapOSMRoofShape,
  type OSMBuildingData,
} from '../web/src/ui/import-osm.js';

/** Delay to avoid Overpass rate limiting (free API, be polite) */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// 10 famous / architecturally notable houses with known coordinates
const TEST_PROPERTIES = [
  {
    name: 'Biltmore Estate',
    lat: 35.5409, lng: -82.5524,
    address: '1 Lodge St, Asheville, NC 28803',
    notes: 'Largest privately-owned house in USA, French Renaissance chateau',
  },
  {
    name: 'Fallingwater',
    lat: 39.9063, lng: -79.4681,
    address: '1491 Mill Run Rd, Mill Run, PA 15464',
    notes: 'Frank Lloyd Wright, cantilevered over waterfall, UNESCO',
  },
  {
    name: 'Hearst Castle',
    lat: 35.6852, lng: -121.1682,
    address: '750 Hearst Castle Rd, San Simeon, CA 93452',
    notes: 'Julia Morgan architect, 165 rooms',
  },
  {
    name: 'Winchester Mystery House',
    lat: 37.3184, lng: -121.9511,
    address: '525 S Winchester Blvd, San Jose, CA 95128',
    notes: '24,000 sqft Victorian, 161 rooms',
  },
  {
    name: 'The Breakers (Vanderbilt)',
    lat: 41.4700, lng: -71.2989,
    address: '44 Ochre Point Ave, Newport, RI 02840',
    notes: 'Italian Renaissance palazzo, 70 rooms',
  },
  {
    name: 'Gamble House (Greene & Greene)',
    lat: 34.1721, lng: -118.1614,
    address: '4 Westmoreland Pl, Pasadena, CA 91103',
    notes: 'Arts & Crafts masterpiece, 1908',
  },
  {
    name: 'Monticello (Thomas Jefferson)',
    lat: 38.0089, lng: -78.4533,
    address: '931 Thomas Jefferson Pkwy, Charlottesville, VA 22902',
    notes: 'Neoclassical, designed by Jefferson, UNESCO',
  },
  {
    name: 'Graceland (Elvis Presley)',
    lat: 35.0477, lng: -90.0261,
    address: '3764 Elvis Presley Blvd, Memphis, TN 38116',
    notes: 'Colonial Revival, 17,552 sqft',
  },
  {
    name: 'Vizcaya Museum (Miami)',
    lat: 25.7444, lng: -80.2103,
    address: '3251 S Miami Ave, Miami, FL 33129',
    notes: 'Italian Renaissance villa, 1916',
  },
  {
    name: 'Pittock Mansion (Portland)',
    lat: 45.5277, lng: -122.7163,
    address: '3229 NW Pittock Dr, Portland, OR 97210',
    notes: 'French Renaissance, 1914, 16,000 sqft',
  },
] as const;

// Track results across all tests for the summary assertion
const results: { name: string; found: boolean; data: OSMBuildingData | null }[] = [];

// Run serially with 3s gaps to avoid Overpass rate limiting
describe('OSM Overpass live integration — 10 notable houses', () => {

  for (let i = 0; i < TEST_PROPERTIES.length; i++) {
    const prop = TEST_PROPERTIES[i];

    it(`${prop.name} — ${prop.address}`, async () => {
      // Polite delay between requests (skip for first test)
      if (i > 0) await sleep(3000);

      console.log(`\n  [${i + 1}/10] Querying OSM: ${prop.name} (${prop.lat}, ${prop.lng})`);

      // Use larger radius for landmark buildings (some are set back from road)
      const result = await searchOSMBuilding(prop.lat, prop.lng, 100);
      results.push({ name: prop.name, found: result !== null, data: result });

      if (result === null) {
        console.log(`    -> No building found (may not be mapped or rate limited)`);
        return;
      }

      // ── Log what we found ─────────────────────────────────────
      console.log(`    -> Polygon: ${result.polygon.length} vertices`);
      console.log(`    -> Dimensions: ${result.widthMeters}m x ${result.lengthMeters}m`);
      console.log(`    -> Blocks: ${result.widthBlocks} x ${result.lengthBlocks}`);
      const tagKeys = Object.keys(result.tags);
      console.log(`    -> Tags (${tagKeys.length}): ${tagKeys.join(', ')}`);
      if (result.levels) console.log(`    -> Levels: ${result.levels}`);
      if (result.material) console.log(`    -> Material: ${result.material} -> ${mapOSMMaterialToWall(result.material) ?? 'unmapped'}`);
      if (result.roofShape) console.log(`    -> Roof: ${result.roofShape} -> ${mapOSMRoofShape(result.roofShape)}`);
      if (result.buildingColour) console.log(`    -> Building colour: ${result.buildingColour}`);
      if (result.roofColour) console.log(`    -> Roof colour: ${result.roofColour}`);

      // ── Assertions ────────────────────────────────────────────
      // Polygon must have at least 3 vertices
      expect(result.polygon.length).toBeGreaterThanOrEqual(3);

      // Dimensions must be positive and reasonable for a real building
      expect(result.widthMeters).toBeGreaterThan(1);
      expect(result.lengthMeters).toBeGreaterThan(1);
      expect(result.widthMeters).toBeLessThan(500);
      expect(result.lengthMeters).toBeLessThan(500);

      // Block counts must be clamped to valid range (6-60)
      expect(result.widthBlocks).toBeGreaterThanOrEqual(6);
      expect(result.widthBlocks).toBeLessThanOrEqual(60);
      expect(result.lengthBlocks).toBeGreaterThanOrEqual(6);
      expect(result.lengthBlocks).toBeLessThanOrEqual(60);

      // Polygon centroid should be near the query point (within ~200m)
      const cLat = result.polygon.reduce((s, p) => s + p.lat, 0) / result.polygon.length;
      const cLon = result.polygon.reduce((s, p) => s + p.lon, 0) / result.polygon.length;
      const dist = haversineDistance(prop.lat, prop.lng, cLat, cLon);
      expect(dist).toBeLessThan(200);

      // Tags object must exist
      expect(result.tags).toBeDefined();
      expect(typeof result.tags).toBe('object');

      // If levels is set, must be reasonable
      if (result.levels !== undefined) {
        expect(result.levels).toBeGreaterThanOrEqual(1);
        expect(result.levels).toBeLessThanOrEqual(20);
      }

      // If material is set, mapping should produce a valid block
      if (result.material) {
        const mapped = mapOSMMaterialToWall(result.material);
        if (mapped) expect(mapped).toMatch(/^minecraft:/);
      }

      // If roofShape is set, normalization should be non-empty
      if (result.roofShape) {
        expect(mapOSMRoofShape(result.roofShape).length).toBeGreaterThan(0);
      }
    }, 30000); // 30s timeout (accounts for retries in the client)
  }

  // Summary: at least 7/10 should have returned actual building data
  it('summary: at least 7/10 addresses returned OSM building data', () => {
    const found = results.filter(r => r.found).length;
    const missed = results.filter(r => !r.found).map(r => r.name);
    console.log(`\n  === SUMMARY: ${found}/10 buildings found ===`);
    if (missed.length > 0) {
      console.log(`  Missed: ${missed.join(', ')}`);
    }
    expect(found).toBeGreaterThanOrEqual(7);
  });
});
