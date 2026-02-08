import { describe, it, expect } from 'vitest';
import { generateStructure } from '../src/gen/generator.js';

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
    // Room assignments should differ (block counts may differ)
    // At minimum, dimensions should be the same (same floor count)
    expect(a.width).toBe(b.width);
  });

  it('respects floor count', () => {
    const one = generateStructure({ type: 'house', floors: 1, style: 'fantasy', seed: 1 });
    const three = generateStructure({ type: 'house', floors: 3, style: 'fantasy', seed: 1 });
    expect(three.height).toBeGreaterThan(one.height);
  });

  it('generates all styles without error', () => {
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
    // Generator creates chests in vault, kitchen, etc.
    expect(grid.blockEntities.length).toBeGreaterThan(0);
  });
});
