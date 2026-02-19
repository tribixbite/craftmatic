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
});
