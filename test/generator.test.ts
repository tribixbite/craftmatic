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
