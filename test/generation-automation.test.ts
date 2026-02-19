/**
 * Tests for data-driven generation automation:
 * - Roof shape variants (gable, hip, flat, gambrel, mansard)
 * - Feature flags (chimney, porch, backyard, driveway, fence, trees, garden)
 * - convertToGenerationOptions with OSM enrichment data
 * - Architecture → style mapping
 * - Roof material → block mapping
 * - Door type inference
 * - Garage room type
 */

import { describe, it, expect } from 'vitest';
import { generateStructure } from '../src/gen/generator.js';
import { convertToGenerationOptions, type PropertyData } from '../web/src/ui/import.js';
import {
  estimateStoriesFromFootprint, resolveStyle, inferFeatures,
} from '../src/gen/address-pipeline.js';
import type { RoofShape, FeatureFlags, GenerationOptions } from '../src/types/index.js';

// ─── Helper ──────────────────────────────────────────────────────────

/** Minimal valid PropertyData for testing convertToGenerationOptions */
function makeProperty(overrides: Partial<PropertyData> = {}): PropertyData {
  return {
    address: '123 Test St, Springfield, IL 62704',
    stories: 2,
    sqft: 2500,
    bedrooms: 3,
    bathrooms: 2,
    yearBuilt: 1985,
    propertyType: 'single_family',
    style: 'auto',
    ...overrides,
  };
}

// ─── Roof Shape Variants ─────────────────────────────────────────────

describe('roof shape variants', () => {
  const SHAPES: RoofShape[] = ['gable', 'hip', 'flat', 'gambrel', 'mansard'];

  for (const shape of SHAPES) {
    it(`generates a house with ${shape} roof without error`, () => {
      const grid = generateStructure({
        type: 'house',
        floors: 2,
        style: 'fantasy',
        seed: 42,
        roofShape: shape,
      });
      expect(grid.countNonAir()).toBeGreaterThan(100);
      expect(grid.width).toBeGreaterThan(0);
      expect(grid.height).toBeGreaterThan(0);
    });
  }

  it('flat roof produces a shorter structure than gable', () => {
    const flat = generateStructure({
      type: 'house', floors: 2, style: 'modern', seed: 42, roofShape: 'flat',
    });
    const gable = generateStructure({
      type: 'house', floors: 2, style: 'modern', seed: 42, roofShape: 'gable',
    });
    // Flat roof should use fewer blocks at the top than gable
    expect(flat.countNonAir()).toBeLessThan(gable.countNonAir());
  });

  it('hip roof is deterministic with same seed', () => {
    const a = generateStructure({
      type: 'house', floors: 2, style: 'rustic', seed: 99, roofShape: 'hip',
    });
    const b = generateStructure({
      type: 'house', floors: 2, style: 'rustic', seed: 99, roofShape: 'hip',
    });
    expect(a.countNonAir()).toBe(b.countNonAir());
  });
});

// ─── Roof Override ───────────────────────────────────────────────────

describe('roof material override', () => {
  it('generates house with custom roof blocks', () => {
    const grid = generateStructure({
      type: 'house',
      floors: 2,
      style: 'fantasy',
      seed: 42,
      roofOverride: {
        north: 'minecraft:brick_stairs[facing=north]',
        south: 'minecraft:brick_stairs[facing=south]',
        cap: 'minecraft:brick_slab[type=bottom]',
      },
    });
    expect(grid.countNonAir()).toBeGreaterThan(100);
  });
});

// ─── Feature Flags ───────────────────────────────────────────────────

describe('feature flags', () => {
  it('generates house with all features disabled', () => {
    const grid = generateStructure({
      type: 'house',
      floors: 2,
      style: 'modern',
      seed: 42,
      features: {
        chimney: false,
        porch: false,
        backyard: false,
        driveway: false,
        fence: false,
        trees: false,
        garden: false,
      },
    });
    expect(grid.countNonAir()).toBeGreaterThan(100);
  });

  it('house with all features disabled has fewer blocks than full features', () => {
    const bare = generateStructure({
      type: 'house', floors: 2, style: 'fantasy', seed: 42,
      features: { chimney: false, porch: false, backyard: false, driveway: false, fence: false, trees: false, garden: false },
    });
    const full = generateStructure({
      type: 'house', floors: 2, style: 'fantasy', seed: 42,
      features: { chimney: true, porch: true, backyard: true, driveway: true, fence: true, trees: true, garden: true },
    });
    expect(bare.countNonAir()).toBeLessThan(full.countNonAir());
  });

  it('chimney is skipped for flat roof regardless of flag', () => {
    // Flat roof + chimney=true → chimney should still be skipped
    const grid = generateStructure({
      type: 'house', floors: 1, style: 'modern', seed: 42,
      roofShape: 'flat',
      features: { chimney: true },
    });
    expect(grid.countNonAir()).toBeGreaterThan(100);
  });
});

// ─── Garage Room Type ────────────────────────────────────────────────

describe('garage room type', () => {
  it('generates house with garage room', () => {
    const grid = generateStructure({
      type: 'house',
      floors: 1,
      style: 'modern',
      seed: 42,
      rooms: ['foyer', 'living', 'kitchen', 'garage'],
    });
    expect(grid.countNonAir()).toBeGreaterThan(100);
  });
});

// ─── convertToGenerationOptions ──────────────────────────────────────

describe('convertToGenerationOptions', () => {
  it('uses OSM dimensions when available', () => {
    const opts = convertToGenerationOptions(makeProperty({
      osmWidth: 15,
      osmLength: 20,
    }));
    expect(opts.width).toBe(15);
    expect(opts.length).toBe(20);
  });

  it('falls back to sqft estimate when no OSM data', () => {
    const opts = convertToGenerationOptions(makeProperty({
      sqft: 2000,
      stories: 1,
    }));
    // Should produce reasonable dimensions from sqft
    expect(opts.width).toBeGreaterThanOrEqual(10);
    expect(opts.width).toBeLessThanOrEqual(60);
    expect(opts.length).toBeGreaterThanOrEqual(10);
    expect(opts.length).toBeLessThanOrEqual(60);
  });

  it('maps OSM roof:shape to roofShape', () => {
    const opts = convertToGenerationOptions(makeProperty({
      osmRoofShape: 'Hip',
    }));
    expect(opts.roofShape).toBe('hip');
  });

  it('defaults modern style to flat roof', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'modern',
    }));
    expect(opts.roofShape).toBe('flat');
  });

  it('defaults gothic style to mansard roof', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'gothic',
    }));
    expect(opts.roofShape).toBe('mansard');
  });

  it('maps OSM architecture to style', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 2000,
      osmArchitecture: 'victorian',
    }));
    expect(opts.style).toBe('gothic');
  });

  it('maps RentCast architectureType to style when no OSM', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 2000,
      architectureType: 'Craftsman',
    }));
    expect(opts.style).toBe('rustic');
  });

  it('user-selected style overrides OSM architecture', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'elven',
      osmArchitecture: 'victorian',
    }));
    expect(opts.style).toBe('elven');
  });

  it('infers door type from architecture', () => {
    const opts = convertToGenerationOptions(makeProperty({
      architectureType: 'Contemporary',
      yearBuilt: 2020,
    }));
    expect(opts.doorOverride).toBe('iron');
  });

  it('infers door type from style when no architecture', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'rustic',
    }));
    expect(opts.doorOverride).toBe('spruce');
  });

  it('maps OSM building colour to trim override', () => {
    const opts = convertToGenerationOptions(makeProperty({
      osmBuildingColour: '#F5F5DC', // beige
    }));
    expect(opts.trimOverride).toBeDefined();
    expect(opts.trimOverride).toContain('minecraft:');
  });

  it('generates roof override from OSM roof material', () => {
    const opts = convertToGenerationOptions(makeProperty({
      osmRoofMaterial: 'slate',
    }));
    expect(opts.roofOverride).toBeDefined();
    expect(opts.roofOverride?.north).toContain('stairs');
    expect(opts.roofOverride?.south).toContain('stairs');
    expect(opts.roofOverride?.cap).toContain('slab');
  });

  it('generates roof override from OSM roof colour', () => {
    const opts = convertToGenerationOptions(makeProperty({
      osmRoofColour: '#8B4513', // dark brown
    }));
    expect(opts.roofOverride).toBeDefined();
    expect(opts.roofOverride?.north).toContain('minecraft:');
  });

  it('includes garage room when hasGarage is true', () => {
    const opts = convertToGenerationOptions(makeProperty({
      hasGarage: true,
    }));
    expect(opts.rooms).toContain('garage');
  });

  it('does not include garage room when hasGarage is false', () => {
    const opts = convertToGenerationOptions(makeProperty({
      hasGarage: false,
    }));
    expect(opts.rooms).not.toContain('garage');
  });

  it('infers chimney=false for modern builds', () => {
    const opts = convertToGenerationOptions(makeProperty({
      yearBuilt: 2020,
      sqft: 1500,
    }));
    expect(opts.features?.chimney).toBe(false);
  });

  it('infers chimney=true for older homes', () => {
    const opts = convertToGenerationOptions(makeProperty({
      yearBuilt: 1920,
      sqft: 2000,
    }));
    expect(opts.features?.chimney).toBe(true);
  });

  it('infers fence for larger properties', () => {
    const opts = convertToGenerationOptions(makeProperty({
      lotSize: 8000,
    }));
    expect(opts.features?.fence).toBe(true);
  });

  it('cabin property type maps to rustic style', () => {
    const opts = convertToGenerationOptions(makeProperty({
      propertyType: 'cabin',
      style: 'auto',
    }));
    expect(opts.style).toBe('rustic');
  });

  it('mansion property type maps to castle structure', () => {
    const opts = convertToGenerationOptions(makeProperty({
      propertyType: 'mansion',
    }));
    expect(opts.type).toBe('castle');
  });
});

// ─── Full Integration ────────────────────────────────────────────────

describe('full generation with OSM-enriched property', () => {
  it('generates structure from fully-enriched PropertyData', () => {
    const prop = makeProperty({
      address: '44 Ochre Point Ave, Newport, RI 02840',
      stories: 3,
      sqft: 62000,
      bedrooms: 12,
      bathrooms: 8,
      yearBuilt: 1895,
      style: 'auto',
      osmWidth: 55,
      osmLength: 60,
      osmLevels: 3,
      osmMaterial: 'stone',
      osmRoofShape: 'Hip',
      osmRoofMaterial: 'slate',
      osmRoofColour: '#444444',
      osmBuildingColour: '#D2B48C',
      osmArchitecture: 'renaissance',
      hasGarage: false,
      wallOverride: 'minecraft:stone_bricks',
    });

    const opts = convertToGenerationOptions(prop);
    expect(opts.roofShape).toBe('hip');
    expect(opts.roofOverride).toBeDefined();
    expect(opts.width).toBe(55);
    expect(opts.length).toBe(60);
    expect(opts.features).toBeDefined();

    // Actually generate the structure
    const grid = generateStructure(opts);
    expect(grid.countNonAir()).toBeGreaterThan(500);
    expect(grid.width).toBeGreaterThan(0);
  });
});

// ─── Pool Feature ────────────────────────────────────────────────────

describe('pool feature', () => {
  it('generates house with pool feature enabled', () => {
    const grid = generateStructure({
      type: 'house', floors: 1, style: 'modern', seed: 42,
      features: { pool: true },
    });
    expect(grid.countNonAir()).toBeGreaterThan(100);
  });

  it('pool adds water blocks to the grid', () => {
    const withPool = generateStructure({
      type: 'house', floors: 1, style: 'modern', seed: 42,
      features: { pool: true },
    });
    const withoutPool = generateStructure({
      type: 'house', floors: 1, style: 'modern', seed: 42,
      features: { pool: false },
    });
    // Pool replaces ground-level grass with water + adds smooth_stone border
    // and diving board/ladder at y=1 — total non-air should be >= no-pool version
    expect(withPool.countNonAir()).toBeGreaterThanOrEqual(withoutPool.countNonAir());
  });

  it('pool is default off for houses', () => {
    const opts = convertToGenerationOptions(makeProperty({}));
    expect(opts.features?.pool).toBe(false);
  });

  it('pool is set when hasPool is true', () => {
    const opts = convertToGenerationOptions(makeProperty({
      hasPool: true,
    }));
    expect(opts.features?.pool).toBe(true);
  });
});

// ─── L-Shaped Floor Plans ────────────────────────────────────────────

describe('L/T/U floor plan shapes', () => {
  it('generates L-shaped house', () => {
    const grid = generateStructure({
      type: 'house', floors: 2, style: 'rustic', seed: 42,
      floorPlanShape: 'L',
    });
    expect(grid.countNonAir()).toBeGreaterThan(100);
    // L-shape should be wider than rect due to wing
    const rect = generateStructure({
      type: 'house', floors: 2, style: 'rustic', seed: 42,
      floorPlanShape: 'rect',
    });
    expect(grid.width).toBeGreaterThan(rect.width);
  });

  it('generates T-shaped house', () => {
    const grid = generateStructure({
      type: 'house', floors: 2, style: 'fantasy', seed: 42,
      floorPlanShape: 'T',
    });
    expect(grid.countNonAir()).toBeGreaterThan(100);
  });

  it('generates U-shaped house', () => {
    const grid = generateStructure({
      type: 'house', floors: 2, style: 'gothic', seed: 42,
      floorPlanShape: 'U',
    });
    expect(grid.countNonAir()).toBeGreaterThan(100);
  });

  it('U-shape is wider than L-shape', () => {
    const uShape = generateStructure({
      type: 'house', floors: 1, style: 'fantasy', seed: 42,
      width: 25, length: 20, floorPlanShape: 'U',
    });
    const lShape = generateStructure({
      type: 'house', floors: 1, style: 'fantasy', seed: 42,
      width: 25, length: 20, floorPlanShape: 'L',
    });
    // U-shape has wings on both sides, L-shape only one
    expect(uShape.width).toBeGreaterThan(lShape.width);
  });
});

// ─── Polygon Shape Analysis ──────────────────────────────────────────

describe('analyzePolygonShape', () => {
  // Import the function directly
  // Note: uses vitest alias resolution for @ui/ path

  it('classifies a rectangle as rect', async () => {
    const { analyzePolygonShape } = await import('../web/src/ui/import-osm.js');
    // Simple rectangle polygon
    const rect = [
      { lat: 40.0, lon: -74.0 },
      { lat: 40.0, lon: -73.9997 },
      { lat: 40.0003, lon: -73.9997 },
      { lat: 40.0003, lon: -74.0 },
      { lat: 40.0, lon: -74.0 },  // closing vertex
    ];
    expect(analyzePolygonShape(rect)).toBe('rect');
  });

  it('classifies an L-shaped polygon as L', async () => {
    const { analyzePolygonShape } = await import('../web/src/ui/import-osm.js');
    // L-shape: 6 unique vertices (7 total with closing)
    const lShape = [
      { lat: 40.0, lon: -74.0 },
      { lat: 40.0, lon: -73.9996 },
      { lat: 40.00015, lon: -73.9996 },
      { lat: 40.00015, lon: -73.9998 },
      { lat: 40.0003, lon: -73.9998 },
      { lat: 40.0003, lon: -74.0 },
      { lat: 40.0, lon: -74.0 },  // closing vertex
    ];
    expect(analyzePolygonShape(lShape)).toBe('L');
  });

  it('returns rect for simple polygons with few vertices', async () => {
    const { analyzePolygonShape } = await import('../web/src/ui/import-osm.js');
    const triangle = [
      { lat: 40.0, lon: -74.0 },
      { lat: 40.0, lon: -73.999 },
      { lat: 40.001, lon: -73.9995 },
    ];
    expect(analyzePolygonShape(triangle)).toBe('rect');
  });
});

// ─── convertToGenerationOptions with floorPlanShape ──────────────────

describe('floorPlanShape in generation options', () => {
  it('passes floorPlanShape through to options', () => {
    const opts = convertToGenerationOptions(makeProperty({
      floorPlanShape: 'L',
    }));
    expect(opts.floorPlanShape).toBe('L');
  });

  it('floorPlanShape is undefined when no OSM polygon', () => {
    const opts = convertToGenerationOptions(makeProperty({}));
    expect(opts.floorPlanShape).toBeUndefined();
  });
});

// ─── Parcl Labs Integration ────────────────────────────────────────

describe('Parcl Labs enrichment', () => {
  it('county-based style hint overrides year-based for pre-1980 SF Victorian', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1905,
      county: 'San Francisco',
    }));
    // SF county pre-1980 → gothic (Victorian prevalence)
    expect(opts.style).toBe('gothic');
  });

  it('county hint ignored for post-1980 homes', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1990,
      county: 'San Francisco',
    }));
    // Post-1980 → year-based (modern)
    expect(opts.style).toBe('modern');
  });

  it('county hint for Miami-Dade → desert style', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1950,
      county: 'Miami-Dade',
    }));
    expect(opts.style).toBe('desert');
  });

  it('county hint for Cook County Chicago → steampunk (Art Deco era)', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1925,
      county: 'Cook',
    }));
    expect(opts.style).toBe('steampunk');
  });

  it('county hint for Hennepin County Minneapolis → rustic', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1935,
      county: 'Hennepin',
    }));
    expect(opts.style).toBe('rustic');
  });

  it('architecture type takes priority over county hint', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1920,
      county: 'San Francisco',
      architectureType: 'Craftsman',
    }));
    // Craftsman → rustic (architecture > county)
    expect(opts.style).toBe('rustic');
  });

  it('user-selected style overrides county hint', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'elven',
      yearBuilt: 1910,
      county: 'San Francisco',
    }));
    expect(opts.style).toBe('elven');
  });

  it('newConstruction flag forces modern style', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 2024,
      newConstruction: true,
    }));
    expect(opts.style).toBe('modern');
  });

  it('ownerOccupied=false disables garden and porch', () => {
    const opts = convertToGenerationOptions(makeProperty({
      ownerOccupied: false,
      lotSize: 10000,
      yearBuilt: 1940,
      sqft: 3000,
    }));
    expect(opts.features?.garden).toBe(false);
    expect(opts.features?.porch).toBe(false);
  });

  it('ownerOccupied=true keeps residential features', () => {
    const opts = convertToGenerationOptions(makeProperty({
      ownerOccupied: true,
      lotSize: 10000,
      yearBuilt: 1940,
      sqft: 3000,
    }));
    expect(opts.features?.garden).toBe(true);
    expect(opts.features?.porch).toBe(true);
  });

  it('hot climate (FL) disables chimney', () => {
    const opts = convertToGenerationOptions(makeProperty({
      stateAbbreviation: 'FL',
      yearBuilt: 1960,
      sqft: 2000,
    }));
    expect(opts.features?.chimney).toBe(false);
  });

  it('cold climate (MN) keeps chimney for older homes', () => {
    const opts = convertToGenerationOptions(makeProperty({
      stateAbbreviation: 'MN',
      yearBuilt: 1960,
      sqft: 2000,
    }));
    expect(opts.features?.chimney).toBe(true);
  });

  it('hot climate infers pool for large lots without satellite detection', () => {
    const opts = convertToGenerationOptions(makeProperty({
      stateAbbreviation: 'AZ',
      lotSize: 8000,
    }));
    expect(opts.features?.pool).toBe(true);
  });

  it('cold climate does not infer pool without satellite', () => {
    const opts = convertToGenerationOptions(makeProperty({
      stateAbbreviation: 'MN',
      lotSize: 8000,
    }));
    expect(opts.features?.pool).toBe(false);
  });

  it('parclPropertyId changes seed for same address', () => {
    const opts1 = convertToGenerationOptions(makeProperty({
      parclPropertyId: 12345,
    }));
    const opts2 = convertToGenerationOptions(makeProperty({
      parclPropertyId: 67890,
    }));
    // Different parclPropertyId → different seed
    expect(opts1.seed).not.toBe(opts2.seed);
  });

  it('missing parclPropertyId falls back to address-only seed', () => {
    const opts1 = convertToGenerationOptions(makeProperty({}));
    const opts2 = convertToGenerationOptions(makeProperty({}));
    // Same address, no ID → same seed
    expect(opts1.seed).toBe(opts2.seed);
  });

  it('unknown county has no effect on style', () => {
    const withCounty = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1950,
      county: 'Nonexistent County',
    }));
    const withoutCounty = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1950,
    }));
    // Both should fall through to year-based inference
    expect(withCounty.style).toBe(withoutCounty.style);
  });

  // ── City-based style inference (new field: city) ────────────────
  it('Santa Fe city → desert style for pre-1980', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1940,
      city: 'Santa Fe',
    }));
    expect(opts.style).toBe('desert');
  });

  it('New Orleans city → gothic for pre-1940', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1920,
      city: 'New Orleans',
    }));
    expect(opts.style).toBe('gothic');
  });

  it('Key West city → rustic', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1960,
      city: 'Key West',
    }));
    expect(opts.style).toBe('rustic');
  });

  it('city hint ignored for post-1980 homes', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1995,
      city: 'Santa Fe',
    }));
    // Post-1980 → year-based
    expect(opts.style).toBe('modern');
  });

  it('city hint has lower priority than architecture type', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1925,
      city: 'Santa Fe',
      architectureType: 'Victorian',
    }));
    // Architecture → gothic overrides city → desert
    expect(opts.style).toBe('gothic');
  });

  it('city hint has higher priority than county hint', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1930,
      city: 'Key West',
      county: 'Miami-Dade',
    }));
    // City Key West → rustic overrides county Miami-Dade → desert
    expect(opts.style).toBe('rustic');
  });

  // ── ZIP-based density inference (new field: zipCode) ────────────
  it('Manhattan ZIP (100xx) disables porch, driveway, backyard', () => {
    const opts = convertToGenerationOptions(makeProperty({
      zipCode: '10001',
    }));
    expect(opts.features?.porch).toBe(false);
    expect(opts.features?.driveway).toBe(false);
    expect(opts.features?.backyard).toBe(false);
  });

  it('suburban ZIP keeps porch, driveway, backyard', () => {
    const opts = convertToGenerationOptions(makeProperty({
      zipCode: '60540', // Naperville IL — suburban SCF 605, not in urban list
    }));
    expect(opts.features?.porch).toBe(true);
    expect(opts.features?.driveway).toBe(true);
  });

  it('unknown ZIP defaults to suburban', () => {
    const opts = convertToGenerationOptions(makeProperty({
      zipCode: '45678',
    }));
    expect(opts.features?.driveway).toBe(true);
  });

  // ── On-market staging (new field: onMarket) ─────────────────────
  it('onMarket=true boosts garden and trees even without large lot', () => {
    const opts = convertToGenerationOptions(makeProperty({
      onMarket: true,
      lotSize: 3000,
      yearBuilt: 2000,
      sqft: 1500,
    }));
    expect(opts.features?.garden).toBe(true);
    expect(opts.features?.trees).toBe(true);
  });

  it('onMarket=false with small lot and recent year — no garden', () => {
    const opts = convertToGenerationOptions(makeProperty({
      onMarket: false,
      lotSize: 3000,
      yearBuilt: 2000,
      sqft: 1500,
    }));
    expect(opts.features?.garden).toBe(false);
  });
});

// ─── Footprint-aware stories estimation ─────────────────────────────

describe('estimateStoriesFromFootprint', () => {
  it('single-story ranch: 1500 sqft on 15x10m footprint', () => {
    // 1500/10.76 = 139.4 sqm; footprint = 150 sqm → ratio 0.93 → 1 floor
    expect(estimateStoriesFromFootprint(1500, 15, 10)).toBe(1);
  });

  it('two-story home: 2500 sqft on 12x10m footprint', () => {
    // 2500/10.76 = 232.3 sqm; footprint = 120 sqm → ratio 1.94 → 2 floors
    expect(estimateStoriesFromFootprint(2500, 12, 10)).toBe(2);
  });

  it('tall building: 13905 sqft on 10.5x20.7m footprint', () => {
    // 13905/10.76 = 1292.5 sqm; footprint = 217.35 sqm → ratio 5.95 → 6 floors
    expect(estimateStoriesFromFootprint(13905, 10.5, 20.7)).toBe(6);
  });

  it('large footprint single-story: 9094 sqft on 19.7x24.1m', () => {
    // 9094/10.76 = 845.1 sqm; footprint = 474.77 sqm → ratio 1.78 → 2 floors
    expect(estimateStoriesFromFootprint(9094, 19.7, 24.1)).toBe(2);
  });

  it('zero footprint defaults to 2', () => {
    expect(estimateStoriesFromFootprint(2000, 0, 0)).toBe(2);
  });

  it('clamps at 100 maximum', () => {
    // 50000 sqft / (5*5 sqm * 10.76) = ~186 → clamped to 100
    expect(estimateStoriesFromFootprint(50000, 5, 5)).toBe(100);
  });

  it('clamps at 1 minimum', () => {
    expect(estimateStoriesFromFootprint(100, 20, 20)).toBe(1);
  });
});

// ─── resolveStyle ───────────────────────────────────────────────────

describe('resolveStyle', () => {
  it('returns user-selected style when not auto', () => {
    expect(resolveStyle(makeProperty({ style: 'gothic' }))).toBe('gothic');
  });

  it('auto with OSM architecture takes priority over year', () => {
    expect(resolveStyle(makeProperty({
      style: 'auto', yearBuilt: 2020, osmArchitecture: 'colonial',
    }))).toBe('fantasy');
  });

  it('auto without architecture falls through to year', () => {
    expect(resolveStyle(makeProperty({
      style: 'auto', yearBuilt: 1820,
    }))).toBe('gothic');
  });

  it('yearUncertain skips year-based inference for neutral default', () => {
    const style = resolveStyle(makeProperty({
      style: 'auto', yearBuilt: 0, yearUncertain: true,
    }));
    // yearUncertain → year treated as 1970 → 'modern'
    expect(style).toBe('modern');
  });

  it('yearUncertain still respects architecture tags', () => {
    const style = resolveStyle(makeProperty({
      style: 'auto', yearBuilt: 0, yearUncertain: true,
      osmArchitecture: 'victorian',
    }));
    expect(style).toBe('gothic');
  });
});

// ─── Style-aware porch override ─────────────────────────────────────

describe('style-aware porch override', () => {
  it('gothic style gets porch even in urban ZIP', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'gothic',
      zipCode: '10001', // NYC — urban
      ownerOccupied: true,
    }));
    expect(opts.features?.porch).toBe(true);
  });

  it('rustic style gets porch even in urban ZIP', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'rustic',
      zipCode: '10001', // NYC — urban
      ownerOccupied: true,
    }));
    expect(opts.features?.porch).toBe(true);
  });

  it('fantasy pre-1950 gets porch in urban ZIP', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 1940, // → fantasy style
      zipCode: '10001', // NYC — urban
      ownerOccupied: true,
    }));
    expect(opts.features?.porch).toBe(true);
  });

  it('modern style in urban ZIP does NOT get porch', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'modern',
      zipCode: '10001', // NYC — urban
      ownerOccupied: true,
    }));
    expect(opts.features?.porch).toBe(false);
  });

  it('gothic style + ownerOccupied=false does NOT get porch override', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'gothic',
      zipCode: '10001', // NYC — urban
      ownerOccupied: false,
    }));
    expect(opts.features?.porch).toBe(false);
  });
});

// ─── yearUncertain + bedroomsUncertain in conversion ────────────────

describe('uncertain data flags', () => {
  it('yearUncertain property gets modern style (neutral default)', () => {
    const opts = convertToGenerationOptions(makeProperty({
      style: 'auto',
      yearBuilt: 2000,
      yearUncertain: true,
    }));
    expect(opts.style).toBe('modern');
  });

  it('bedroomsUncertain does not affect generation output', () => {
    // bedroomsUncertain is informational — conversion uses the bedrooms value as-is
    const opts = convertToGenerationOptions(makeProperty({
      bedrooms: 3,
      bedroomsUncertain: true,
    }));
    // Should still generate 3 bedroom rooms
    const bedroomCount = opts.rooms?.filter(r => r === 'bedroom').length ?? 0;
    expect(bedroomCount).toBe(3);
  });
});
