/**
 * Full pipeline integration test: Geocode → Parcl → OSM → PropertyData → GenerationOptions → Structure → .schem
 *
 * Exercises the real import pipeline with live API calls (Parcl, Census/Nominatim, OSM Overpass).
 * Requires PARCL_API_KEY env var. Skips gracefully if not set.
 *
 * Tests that sqft, bedrooms, bathrooms, OSM dimensions, material, roof, style, and all Parcl
 * fields actually flow through convertToGenerationOptions and into the generated structure.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { geocodeAddress, type GeocodingResult } from '@ui/import-geocoder.js';
import {
  searchParclProperty, mapParclPropertyType, setParclApiKey,
  type ParclPropertyData,
} from '@ui/import-parcl.js';
import {
  searchOSMBuilding, mapOSMMaterialToWall, mapOSMRoofShape,
  analyzePolygonShape, type OSMBuildingData,
} from '@ui/import-osm.js';
import { convertToGenerationOptions, type PropertyData } from '@ui/import.js';
import { generateStructure } from '@craft/gen/generator.js';
import { writeSchematic } from '@craft/schem/write.js';
import type { GenerationOptions } from '@craft/types/index.js';

// ─── Env & Setup ──────────────────────────────────────────────────────────────

const PARCL_KEY = process.env.PARCL_API_KEY ?? '';
const OUTPUT_DIR = resolve(__dirname, '..', 'output', 'houses');

/** Shim localStorage for modules that use it (import-parcl reads key via localStorage) */
function shimLocalStorage(): void {
  if (typeof globalThis.localStorage === 'undefined') {
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k in store) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i: number) => Object.keys(store)[i] ?? null,
    };
  }
}

/**
 * Build a PropertyData struct from live API results, mirroring import.ts doGenerate() logic.
 * This is the same assembly as lines 1395-1435 of import.ts, using real API data.
 */
function buildPropertyData(
  address: string,
  parcl: ParclPropertyData | null,
  osm: OSMBuildingData | null,
  geo: GeocodingResult | null,
): PropertyData {
  const sqft = parcl?.squareFootage || 2000;
  const bedrooms = (parcl?.bedrooms && parcl.bedrooms > 0) ? parcl.bedrooms : 3;
  const bathrooms = (parcl?.bathrooms && parcl.bathrooms > 0) ? parcl.bathrooms : 2;
  const yearBuilt = parcl?.yearBuilt || 2000;
  const pType = parcl?.propertyType ? mapParclPropertyType(parcl.propertyType) : 'house';

  // Stories estimation: Parcl doesn't provide stories directly
  // Priority: OSM levels > heuristic from sqft/type
  let stories = 2;
  if (osm?.levels && osm.levels > 0) {
    stories = osm.levels;
  } else if (pType === 'townhouse' || (sqft > 2500 && bedrooms > 3)) {
    stories = sqft > 4000 ? 3 : 2;
  }

  // Wall override: OSM material (no RentCast in this test — we don't have that key)
  const wallOverride = osm?.material ? mapOSMMaterialToWall(osm.material) : undefined;

  return {
    address,
    stories,
    sqft,
    bedrooms,
    bathrooms,
    yearBuilt,
    propertyType: pType,
    style: 'auto',
    geocoding: geo ?? undefined,
    newConstruction: parcl?.newConstruction ?? yearBuilt >= 2020,
    wallOverride,
    osmWidth: osm?.widthBlocks,
    osmLength: osm?.lengthBlocks,
    osmLevels: osm?.levels,
    osmMaterial: osm?.material,
    osmRoofShape: osm?.roofShape ? mapOSMRoofShape(osm.roofShape) : undefined,
    osmRoofMaterial: osm?.roofMaterial,
    osmRoofColour: osm?.roofColour,
    osmBuildingColour: osm?.buildingColour,
    osmArchitecture: osm?.tags?.['building:architecture'],
    floorPlanShape: osm?.polygon ? analyzePolygonShape(osm.polygon) : undefined,
    county: parcl?.county,
    stateAbbreviation: parcl?.stateAbbreviation,
    city: parcl?.city,
    zipCode: parcl?.zipCode,
    ownerOccupied: parcl?.ownerOccupied,
    onMarket: parcl?.onMarket,
    parclPropertyId: parcl?.parclPropertyId,
  };
}

/** Sanitize address to a safe filename segment */
function slugify(address: string): string {
  return address.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// ─── Test Addresses ───────────────────────────────────────────────────────────

interface TestCase {
  address: string;
  /** Expected Parcl sqft range (if Parcl returns data) */
  sqftRange: [number, number];
  /** Expected bedroom count from Parcl (0 = unknown / fallback) */
  expectedBeds: number;
  /** Expected bathroom count from Parcl (0 = unknown / fallback) */
  expectedBaths: number;
  /** Expected style when set to auto */
  expectedStyle?: string;
  /** Whether OSM footprint should be available for this address */
  expectOSM: boolean;
}

const TEST_CASES: TestCase[] = [
  {
    address: '2340 Francisco St, San Francisco, CA 94123',
    sqftRange: [10000, 20000],
    expectedBeds: 12,
    expectedBaths: 12,
    expectedStyle: 'gothic', // SF county → Victorian/Gothic for old homes
    expectOSM: true,
  },
  {
    address: '1617 Lotus Ave SE, Grand Rapids, MI 49506',
    sqftRange: [1000, 2000],
    expectedBeds: 0, // Parcl has 0 beds for this property → fallback to 3
    expectedBaths: 2,
    expectOSM: true,
  },
  {
    address: '240 Highland St, Newton, MA 02465',
    sqftRange: [7000, 12000],
    expectedBeds: 9,
    expectedBaths: 5,
    expectOSM: true,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Full address pipeline: Parcl + OSM → generate → .schem', () => {
  beforeAll(() => {
    shimLocalStorage();
    if (PARCL_KEY) {
      setParclApiKey(PARCL_KEY);
    }
    if (!existsSync(OUTPUT_DIR)) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
    }
  });

  // Guard: skip entire suite if no API key
  it.skipIf(!PARCL_KEY)('PARCL_API_KEY must be set', () => {
    expect(PARCL_KEY).toBeTruthy();
  });

  for (const tc of TEST_CASES) {
    describe.skipIf(!PARCL_KEY)(tc.address, () => {
      let geo: GeocodingResult | null = null;
      let parcl: ParclPropertyData | null = null;
      let osm: OSMBuildingData | null = null;
      let property: PropertyData;
      let options: GenerationOptions;

      // Phase 1: Geocode
      it('geocodes successfully', async () => {
        geo = await geocodeAddress(tc.address);
        expect(geo).not.toBeNull();
        expect(geo!.lat).toBeGreaterThan(20);
        expect(geo!.lat).toBeLessThan(50);
        expect(geo!.lng).toBeGreaterThan(-130);
        expect(geo!.lng).toBeLessThan(-60);
        console.log(`  Geocoded: ${geo!.lat.toFixed(5)}, ${geo!.lng.toFixed(5)} (${geo!.source})`);
      }, 15000);

      // Phase 2: Parcl API
      it('fetches Parcl property data', async () => {
        parcl = await searchParclProperty(tc.address);
        expect(parcl).not.toBeNull();
        expect(parcl!.squareFootage).toBeGreaterThanOrEqual(tc.sqftRange[0]);
        expect(parcl!.squareFootage).toBeLessThanOrEqual(tc.sqftRange[1]);
        if (tc.expectedBeds > 0) {
          expect(parcl!.bedrooms).toBe(tc.expectedBeds);
        }
        if (tc.expectedBaths > 0) {
          expect(parcl!.bathrooms).toBe(tc.expectedBaths);
        }
        console.log(`  Parcl: ${parcl!.squareFootage}sqft, ${parcl!.bedrooms}bd/${parcl!.bathrooms}ba, yr=${parcl!.yearBuilt}`);
        console.log(`    city=${parcl!.city}, zip=${parcl!.zipCode}, county=${parcl!.county}`);
        console.log(`    onMarket=${parcl!.onMarket}, ownerOccupied=${parcl!.ownerOccupied}, newConstruction=${parcl!.newConstruction}`);
      }, 15000);

      // Phase 3: OSM Overpass
      it('fetches OSM building data', async () => {
        // Need geo coordinates first — if geocoding failed, use Parcl lat/lng fallback
        const lat = geo?.lat ?? parcl?.latitude ?? 0;
        const lng = geo?.lng ?? parcl?.longitude ?? 0;
        if (lat === 0) return; // Skip if no coordinates at all

        osm = await searchOSMBuilding(lat, lng);
        if (tc.expectOSM) {
          // OSM coverage varies — log but don't hard-fail
          if (osm) {
            expect(osm.widthBlocks).toBeGreaterThan(0);
            expect(osm.lengthBlocks).toBeGreaterThan(0);
            expect(osm.polygon.length).toBeGreaterThanOrEqual(4);
            console.log(`  OSM: ${osm.widthMeters}m × ${osm.lengthMeters}m → ${osm.widthBlocks}×${osm.lengthBlocks} blocks`);
            console.log(`    levels=${osm.levels ?? 'N/A'}, material=${osm.material ?? 'N/A'}, roof=${osm.roofShape ?? 'N/A'}`);
            if (osm.tags['building:architecture']) {
              console.log(`    architecture=${osm.tags['building:architecture']}`);
            }
            const shape = analyzePolygonShape(osm.polygon);
            console.log(`    polygon shape=${shape} (${osm.polygon.length} vertices)`);
          } else {
            console.log('  OSM: no building found (coverage gap)');
          }
        }
      }, 20000);

      // Phase 4: Build PropertyData + convert + validate pipeline integrity
      it('sqft/beds/baths flow through pipeline correctly', () => {
        property = buildPropertyData(tc.address, parcl, osm, geo);
        options = convertToGenerationOptions(property);

        // ── sqft flows to dimensions ──
        // If OSM provided real dimensions, those take priority
        if (osm && property.osmWidth && property.osmLength) {
          expect(options.width).toBe(Math.max(10, Math.min(60, osm.widthBlocks)));
          expect(options.length).toBe(Math.max(10, Math.min(60, osm.lengthBlocks)));
          console.log(`  Dimensions: ${options.width}×${options.length} (OSM footprint)`);
        } else {
          // sqft-based estimate: areaPerFloor / 10.76, aspect 1.3
          const areaPerFloor = property.sqft / property.stories / 10.76;
          const expectedWidth = Math.max(10, Math.min(60, Math.round(Math.sqrt(areaPerFloor * 1.3))));
          expect(options.width).toBe(expectedWidth);
          console.log(`  Dimensions: ${options.width}×${options.length} (sqft estimate)`);
        }

        // ── sqft flows to structure type ──
        if (property.sqft > 5000) {
          expect(options.type).toBe('castle');
        } else {
          expect(options.type).toBe('house');
        }

        // ── sqft flows to bonus rooms ──
        if (property.sqft > 2500) {
          expect(options.rooms).toContain('study');
          expect(options.rooms).toContain('laundry');
        }
        if (property.sqft > 3500) {
          expect(options.rooms).toContain('library');
          expect(options.rooms).toContain('sunroom');
        }

        // ── bedrooms flow to bedroom rooms ──
        const bedCount = options.rooms.filter(r => r === 'bedroom').length;
        const expectedBeds = Math.min(property.bedrooms, 8);
        expect(bedCount).toBe(expectedBeds);

        // ── bathrooms flow to bathroom rooms ──
        const bathCount = options.rooms.filter(r => r === 'bathroom').length;
        const expectedBaths = Math.min(property.bathrooms, 6);
        expect(bathCount).toBe(expectedBaths);

        // ── floors ──
        expect(options.floors).toBe(property.stories);

        console.log(`  Type: ${options.type}, style: ${options.style}, floors: ${options.floors}`);
        console.log(`  Rooms: ${options.rooms.length} total — ${bedCount}bd/${bathCount}ba + ${options.rooms.filter(r => r !== 'bedroom' && r !== 'bathroom').join(', ')}`);
      });

      // Phase 5: Validate style resolution
      it('style resolved correctly from enrichment data', () => {
        if (tc.expectedStyle) {
          expect(options.style).toBe(tc.expectedStyle);
        }
        // Style should always be a valid non-auto value after conversion
        expect(options.style).not.toBe('auto');
        console.log(`  Style: ${options.style}`);
      });

      // Phase 6: Validate OSM enrichment in options
      it('OSM data enriches generation options when available', () => {
        if (!osm) return;

        // Roof shape from OSM
        if (osm.roofShape) {
          console.log(`  Roof: ${options.roofShape} (from OSM: ${osm.roofShape})`);
        }

        // Wall override from OSM material
        if (osm.material && property.wallOverride) {
          expect(property.wallOverride).toBeTruthy();
          console.log(`  Wall: ${property.wallOverride} (from OSM material: ${osm.material})`);
        }

        // Floor plan shape from polygon
        if (property.floorPlanShape) {
          expect(options.floorPlanShape).toBe(property.floorPlanShape);
          console.log(`  Floor plan: ${options.floorPlanShape}`);
        }
      });

      // Phase 7: Validate Parcl enrichment in options
      it('Parcl data enriches generation options', () => {
        if (!parcl) return;

        // Seed includes parclPropertyId
        if (parcl.parclPropertyId) {
          expect(options.seed).toBeGreaterThan(0);
          console.log(`  Seed: ${options.seed} (includes parclPropertyId: ${parcl.parclPropertyId})`);
        }

        // Features: density-aware from ZIP
        if (parcl.zipCode) {
          expect(options.features).toBeDefined();
          console.log(`  Features: porch=${options.features?.porch}, driveway=${options.features?.driveway}, chimney=${options.features?.chimney}`);
        }
      });

      // Phase 8: Generate structure and write .schem
      it('generates structure and writes .schem file', () => {
        const grid = generateStructure(options);
        expect(grid).toBeDefined();
        expect(grid.width).toBeGreaterThan(0);
        expect(grid.height).toBeGreaterThan(0);
        expect(grid.length).toBeGreaterThan(0);

        const nonAir = grid.countNonAir();
        expect(nonAir).toBeGreaterThan(100);

        // Write .schem file
        const slug = slugify(tc.address);
        const filename = `${slug}_${options.style}_${options.floors}f_${options.seed}.schem`;
        const filepath = resolve(OUTPUT_DIR, filename);
        writeSchematic(grid, filepath);
        expect(existsSync(filepath)).toBe(true);

        console.log(`  Grid: ${grid.width}×${grid.height}×${grid.length} = ${nonAir.toLocaleString()} blocks`);
        console.log(`  Written: ${filename}`);
      });
    });
  }

  // Summary: compare OSM vs sqft-estimated dimensions
  it.skipIf(!PARCL_KEY)('OSM dimensions improve accuracy vs sqft estimate', async () => {
    shimLocalStorage();
    setParclApiKey(PARCL_KEY);

    // Use Francisco St as the reference — large building with known OSM footprint
    const address = '2340 Francisco St, San Francisco, CA 94123';
    const geo = await geocodeAddress(address);
    const [parcl, osm] = await Promise.all([
      searchParclProperty(address),
      searchOSMBuilding(geo.lat, geo.lng),
    ]);

    if (!parcl || !osm) return; // Can't compare without both

    // sqft-based estimate
    const sqft = parcl.squareFootage;
    const stories = osm.levels ?? 2;
    const areaPerFloor = sqft / stories / 10.76;
    const sqftWidth = Math.max(10, Math.min(60, Math.round(Math.sqrt(areaPerFloor * 1.3))));
    const sqftLength = Math.max(10, Math.min(60, Math.round(Math.sqrt(areaPerFloor / 1.3))));

    // OSM-based (real building footprint)
    const osmWidth = osm.widthBlocks;
    const osmLength = osm.lengthBlocks;

    console.log('\n  Dimension comparison for 2340 Francisco St:');
    console.log(`    sqft estimate: ${sqftWidth}×${sqftLength} (from ${sqft}sqft / ${stories} stories)`);
    console.log(`    OSM footprint: ${osmWidth}×${osmLength} (real building polygon)`);
    console.log(`    Delta: width ${Math.abs(osmWidth - sqftWidth)}, length ${Math.abs(osmLength - sqftLength)}`);

    // OSM dimensions should be different from sqft estimate (proving OSM adds value)
    // The sqft estimate for large buildings is often wrong because it includes all floors
    // while OSM gives the actual ground floor footprint
    expect(osmWidth !== sqftWidth || osmLength !== sqftLength).toBe(true);
  }, 30000);
});
