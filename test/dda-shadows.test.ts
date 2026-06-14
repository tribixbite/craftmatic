import { describe, it, expect } from 'vitest';
import { computeShadow } from '../src/render/png-renderer.js';
import { BlockGrid } from '../src/schem/types.js';

const STONE = 'minecraft:stone';

describe('computeShadow', () => {
  it('returns 1.0 (no shadow) for top surface with clear sky', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 0, 2, STONE);
    const shadow = computeShadow(grid, 2, 0, 2, 'up');
    expect(shadow).toBe(1.0);
  });

  it('returns shadow factor for block under overhang', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 0, 2, STONE);
    grid.set(3, 1, 3, STONE); // in shadow ray path [1,1,1]
    const shadow = computeShadow(grid, 2, 0, 2, 'up');
    expect(shadow).toBeLessThan(1.0);
    expect(shadow).toBeCloseTo(0.6, 1);
  });

  it('offsets ray origin along face normal to avoid self-intersection', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 2, 2, STONE);
    const shadow = computeShadow(grid, 2, 2, 2, '+x');
    expect(shadow).toBe(1.0);
  });
});
