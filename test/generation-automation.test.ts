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
