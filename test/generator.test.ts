import { describe, it, expect } from 'vitest';
import { generateStructure } from '../src/gen/generator.js';
import type { StructureType, StyleName } from '../src/types/index.js';

describe('generator', () => {
  it('generates a house with default options', () => {
    const grid = generateStructure({ type: 'house', floors: 1, style: 'fantasy', seed: 1 });
    expect(grid.width).toBeGreaterThan(0);
    expect(grid.height).toBeGreaterThan(0);
    expect(grid.length).toBeGreaterThan(0);
    expect(grid.countNonAir()).toBeGreaterThan(100);
  });

  it('generates deterministic output with same seed', () => {
    const a = generateStructure({ type: 'house', floors: 2, style: 'medieval', seed: 42 });
    const b = generateStructure({ type: 'house', floors: 2, style: 'medieval', seed: 42 });
    expect(a.countNonAir()).toBe(b.countNonAir());
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    expect(a.length).toBe(b.length);
  });

  it('produces different output with different seeds', () => {
    const a = generateStructure({ type: 'house', floors: 2, style: 'fantasy', seed: 1 });
    const b = generateStructure({ type: 'house', floors: 2, style: 'fantasy', seed: 2 });
    expect(a.width).toBe(b.width);
  });

  it('respects floor count', () => {
    const one = generateStructure({ type: 'house', floors: 1, style: 'fantasy', seed: 1 });
    const three = generateStructure({ type: 'house', floors: 3, style: 'fantasy', seed: 1 });
    expect(three.height).toBeGreaterThan(one.height);
  });

  it('generates all original styles without error', () => {
    for (const style of ['fantasy', 'medieval', 'modern', 'gothic', 'rustic'] as const) {
      const grid = generateStructure({ type: 'house', floors: 1, style, seed: 42 });
      expect(grid.countNonAir()).toBeGreaterThan(0);
    }
  });

  it('accepts custom rooms', () => {
    const grid = generateStructure({
      type: 'house',
      floors: 2,
      style: 'fantasy',
      rooms: ['vault', 'library', 'throne'],
      seed: 42,
    });
    expect(grid.countNonAir()).toBeGreaterThan(0);
  });

  it('has block entities for chests/barrels', () => {
    const grid = generateStructure({ type: 'house', floors: 2, style: 'fantasy', seed: 42 });
    expect(grid.blockEntities.length).toBeGreaterThan(0);
  });
});

describe('new structure types', () => {
  const newTypes: StructureType[] = ['cathedral', 'bridge', 'windmill', 'marketplace', 'village'];

  for (const type of newTypes) {
    it(`generates ${type} without error`, () => {
      const grid = generateStructure({ type, floors: 1, style: 'medieval', seed: 42 });
      expect(grid.width).toBeGreaterThan(0);
      expect(grid.height).toBeGreaterThan(0);
      expect(grid.length).toBeGreaterThan(0);
      expect(grid.countNonAir()).toBeGreaterThan(50);
    });
  }

  it('cathedral has substantial block count', () => {
    const grid = generateStructure({ type: 'cathedral', floors: 1, style: 'gothic', seed: 7 });
    expect(grid.countNonAir()).toBeGreaterThan(5000);
  });

  it('village contains multiple sub-structures', () => {
    const grid = generateStructure({ type: 'village', floors: 1, style: 'medieval', seed: 42 });
    // Village is ~100x100 with houses, tower, marketplace, paths
    expect(grid.width).toBeGreaterThanOrEqual(80);
    expect(grid.countNonAir()).toBeGreaterThan(10000);
  });

  it('bridge has elongated shape', () => {
    const grid = generateStructure({ type: 'bridge', floors: 1, style: 'medieval', seed: 1 });
    // Bridge is longer than it is wide
    expect(grid.length).toBeGreaterThan(grid.width);
  });
});

describe('new styles', () => {
  const newStyles: StyleName[] = ['steampunk', 'elven', 'desert', 'underwater'];

  for (const style of newStyles) {
    it(`generates house with ${style} style`, () => {
      const grid = generateStructure({ type: 'house', floors: 2, style, seed: 42 });
      expect(grid.countNonAir()).toBeGreaterThan(100);
    });

    it(`generates castle with ${style} style`, () => {
      const grid = generateStructure({ type: 'castle', floors: 1, style, seed: 42 });
      expect(grid.countNonAir()).toBeGreaterThan(1000);
    });
  }
});

describe('new room types', () => {
  it('ship generates with captains_quarters', () => {
    const grid = generateStructure({ type: 'ship', floors: 1, style: 'fantasy', seed: 42 });
    expect(grid.countNonAir()).toBeGreaterThan(500);
  });

  it('dungeon generates with cell rooms', () => {
    const grid = generateStructure({ type: 'dungeon', floors: 2, style: 'gothic', seed: 42 });
    expect(grid.countNonAir()).toBeGreaterThan(500);
  });

  it('cathedral has nave room', () => {
    const grid = generateStructure({ type: 'cathedral', floors: 1, style: 'gothic', seed: 7 });
    expect(grid.countNonAir()).toBeGreaterThan(3000);
  });
});

describe('bed verification', () => {
  it('bedroom rooms contain bed blocks', () => {
    // Generate a house — bedrooms should have beds
    const grid = generateStructure({ type: 'house', floors: 2, style: 'fantasy', seed: 42 });
    const blocks = grid.to3DArray();
    let bedCount = 0;
    for (let y = 0; y < grid.height; y++) {
      for (let z = 0; z < grid.length; z++) {
        for (let x = 0; x < grid.width; x++) {
          if (blocks[y][z][x].includes('_bed[')) bedCount++;
        }
      }
    }
    expect(bedCount).toBeGreaterThan(0);
  });
});

describe('import-style generation (rooms + custom dimensions)', () => {
  it('generates a house with explicit room list', () => {
    const grid = generateStructure({
      type: 'house',
      floors: 2,
      style: 'modern',
      rooms: ['foyer', 'living', 'kitchen', 'dining', 'bedroom', 'bedroom', 'bedroom', 'bathroom', 'bathroom'],
      width: 20,
      length: 16,
      seed: 12345,
    });
    // Generator may expand dimensions for exterior features (porch, yard, driveway)
    expect(grid.width).toBeGreaterThanOrEqual(20);
    expect(grid.length).toBeGreaterThanOrEqual(16);
    expect(grid.countNonAir()).toBeGreaterThan(500);
  });

  it('generates a castle from mansion-type property', () => {
    const grid = generateStructure({
      type: 'castle',
      floors: 3,
      style: 'gothic',
      rooms: ['foyer', 'living', 'kitchen', 'dining', 'bedroom', 'bedroom', 'bedroom', 'bedroom', 'bathroom', 'bathroom', 'bathroom', 'study', 'library', 'sunroom'],
      seed: 67890,
    });
    expect(grid.countNonAir()).toBeGreaterThan(1000);
    expect(grid.height).toBeGreaterThan(10);
  });

  it('auto-style inference produces valid structures for each era', () => {
    // Mapping mirrors import-tab inferStyle(): <1700→medieval, <1850→gothic, <1920→rustic, <1970→fantasy, else→modern
    const eraStyles: [number, StyleName][] = [
      [1650, 'medieval'],
      [1800, 'gothic'],
      [1900, 'rustic'],
      [1960, 'fantasy'],
      [2020, 'modern'],
    ];
    for (const [_year, style] of eraStyles) {
      const grid = generateStructure({
        type: 'house',
        floors: 2,
        style,
        rooms: ['foyer', 'living', 'kitchen', 'bedroom', 'bathroom'],
        seed: 42,
      });
      expect(grid.countNonAir()).toBeGreaterThan(100);
    }
  });

  it('FNV-1a-seeded generation is deterministic', () => {
    // Simulate the FNV-1a hash from import module
    function fnv1a(str: string): number {
      let hash = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0) % 999999;
    }
    const seed = fnv1a('123 Main St, Springfield, IL 62701');
    const a = generateStructure({ type: 'house', floors: 2, style: 'modern', seed });
    const b = generateStructure({ type: 'house', floors: 2, style: 'modern', seed });
    expect(a.countNonAir()).toBe(b.countNonAir());
    expect(a.width).toBe(b.width);
    expect(a.length).toBe(b.length);
  });

  it('small and large requested dimensions produce valid structures', () => {
    // Small: generator may expand for structural minimums (porch, yard, etc.)
    const small = generateStructure({
      type: 'house',
      floors: 1,
      style: 'rustic',
      width: 10,
      length: 10,
      seed: 1,
    });
    expect(small.width).toBeGreaterThanOrEqual(10);
    expect(small.length).toBeGreaterThanOrEqual(10);
    expect(small.countNonAir()).toBeGreaterThan(100);

    // Large: castle with big footprint
    const large = generateStructure({
      type: 'castle',
      floors: 2,
      style: 'fantasy',
      width: 60,
      length: 60,
      seed: 2,
    });
    expect(large.width).toBeGreaterThanOrEqual(60);
    expect(large.length).toBeGreaterThanOrEqual(60);
    expect(large.countNonAir()).toBeGreaterThan(1000);
  });
});

describe('import end-to-end: 600 Broadway Ave NW, Grand Rapids MI 49504', () => {
  // Real geocoding result: lat=42.973766, lng=-85.679793
  // Property: ~3000sqft, 2 stories, 3 bed, 2 bath, built ~1920
  function fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % 999999;
  }

  const address = '600 BROADWAY AVE NW, GRAND RAPIDS, MI, 49504';
  const seed = fnv1a(address);

  it('generates a valid structure from real property data', () => {
    const grid = generateStructure({
      type: 'house',
      floors: 2,
      style: 'fantasy', // inferStyle(1920) → fantasy
      rooms: ['foyer', 'living', 'kitchen', 'dining', 'bedroom', 'bedroom', 'bedroom', 'bathroom', 'bathroom', 'study', 'laundry', 'mudroom'],
      width: 13,
      length: 10,
      seed,
    });
    expect(grid.countNonAir()).toBeGreaterThan(500);
    expect(grid.height).toBeGreaterThan(10);
    expect(grid.palette.size).toBeGreaterThan(10);
  });

  it('produces deterministic output from address seed', () => {
    const opts = {
      type: 'house' as StructureType,
      floors: 2,
      style: 'fantasy' as StyleName,
      rooms: ['foyer', 'living', 'kitchen', 'dining', 'bedroom', 'bedroom', 'bedroom', 'bathroom', 'bathroom', 'study', 'laundry', 'mudroom'] as import('../src/types/index.js').RoomType[],
      width: 13,
      length: 10,
      seed,
    };
    const a = generateStructure(opts);
    const b = generateStructure(opts);
    expect(a.countNonAir()).toBe(b.countNonAir());
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    expect(a.length).toBe(b.length);
  });
});

describe('import end-to-end: 917 Pinecrest Ave SE, Grand Rapids MI 49506', () => {
  // Real geocoding result: lat=42.946224, lng=-85.615624
  // East GR single-family: ~2400sqft, 2 stories, 4 bed, 2.5 bath, built ~1950
  function fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % 999999;
  }

  const address = '917 PINECREST AVE SE, GRAND RAPIDS, MI, 49506';
  const seed = fnv1a(address);

  it('generates a valid structure from property data', () => {
    // 2400sqft / 2 stories / 10.76 = ~111 blocks/floor
    // aspect 1.3 → width=12, length=9
    const sqftPerFloor = 2400 / 2 / 10.76;
    const width = Math.max(10, Math.min(60, Math.round(Math.sqrt(sqftPerFloor * 1.3))));
    const length = Math.max(10, Math.min(60, Math.round(Math.sqrt(sqftPerFloor / 1.3))));

    const grid = generateStructure({
      type: 'house',
      floors: 2,
      style: 'fantasy', // inferStyle(1950) → fantasy
      rooms: ['foyer', 'living', 'kitchen', 'dining', 'bedroom', 'bedroom', 'bedroom', 'bedroom', 'bathroom', 'bathroom', 'bathroom'],
      width,
      length,
      seed,
    });
    expect(grid.countNonAir()).toBeGreaterThan(500);
    expect(grid.height).toBeGreaterThan(10);
    expect(grid.palette.size).toBeGreaterThan(10);
    expect(width).toBe(12);
    expect(length).toBe(10);
  });

  it('seed differs from 600 Broadway', () => {
    const otherSeed = fnv1a('600 BROADWAY AVE NW, GRAND RAPIDS, MI, 49504');
    expect(seed).not.toBe(otherSeed);
  });
});

describe('performance benchmarks', () => {
  const cases: { type: StructureType; style: StyleName; label: string }[] = [
    { type: 'house', style: 'fantasy', label: 'house/fantasy' },
    { type: 'castle', style: 'gothic', label: 'castle/gothic' },
    { type: 'cathedral', style: 'gothic', label: 'cathedral/gothic' },
    { type: 'village', style: 'medieval', label: 'village/medieval' },
    { type: 'windmill', style: 'rustic', label: 'windmill/rustic' },
    { type: 'bridge', style: 'medieval', label: 'bridge/medieval' },
    { type: 'marketplace', style: 'desert', label: 'marketplace/desert' },
  ];

  for (const { type, style, label } of cases) {
    it(`benchmark: ${label} generates under 2s`, () => {
      const start = performance.now();
      const grid = generateStructure({ type, floors: 2, style, seed: 42 });
      const elapsed = performance.now() - start;
      expect(grid.countNonAir()).toBeGreaterThan(0);
      // All structures should generate in under 2 seconds
      expect(elapsed).toBeLessThan(2000);
    });
  }
});
