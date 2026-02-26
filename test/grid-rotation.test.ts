/**
 * Tests for BlockGrid CW90 rotation and facing property transformation.
 */

import { describe, it, expect } from 'vitest';
import { rotateFacingCW90, rotateGridCW90 } from '../src/gen/gen-utils.js';
import { BlockGrid } from '../src/schem/types.js';

// ─── rotateFacingCW90 ───────────────────────────────────────────────────────

describe('rotateFacingCW90', () => {
  it('rotates north → east', () => {
    expect(rotateFacingCW90('minecraft:oak_stairs[facing=north]'))
      .toBe('minecraft:oak_stairs[facing=east]');
  });

  it('rotates east → south', () => {
    expect(rotateFacingCW90('minecraft:oak_stairs[facing=east]'))
      .toBe('minecraft:oak_stairs[facing=south]');
  });

  it('rotates south → west', () => {
    expect(rotateFacingCW90('minecraft:oak_stairs[facing=south]'))
      .toBe('minecraft:oak_stairs[facing=west]');
  });

  it('rotates west → north', () => {
    expect(rotateFacingCW90('minecraft:oak_stairs[facing=west]'))
      .toBe('minecraft:oak_stairs[facing=north]');
  });

  it('handles doors with multiple properties', () => {
    expect(rotateFacingCW90('minecraft:oak_door[facing=north,half=lower,hinge=left,open=false]'))
      .toBe('minecraft:oak_door[facing=east,half=lower,hinge=left,open=false]');
  });

  it('rotates axis=x → axis=z', () => {
    expect(rotateFacingCW90('minecraft:oak_log[axis=x]'))
      .toBe('minecraft:oak_log[axis=z]');
  });

  it('rotates axis=z → axis=x', () => {
    expect(rotateFacingCW90('minecraft:oak_log[axis=z]'))
      .toBe('minecraft:oak_log[axis=x]');
  });

  it('preserves axis=y', () => {
    expect(rotateFacingCW90('minecraft:oak_log[axis=y]'))
      .toBe('minecraft:oak_log[axis=y]');
  });

  it('leaves non-directional blocks unchanged', () => {
    expect(rotateFacingCW90('minecraft:stone_bricks')).toBe('minecraft:stone_bricks');
    expect(rotateFacingCW90('minecraft:air')).toBe('minecraft:air');
  });

  it('preserves stair shape properties during rotation', () => {
    expect(rotateFacingCW90('minecraft:oak_stairs[facing=north,shape=outer_right]'))
      .toBe('minecraft:oak_stairs[facing=east,shape=outer_right]');
  });

  it('full 360° cycle returns original', () => {
    const original = 'minecraft:oak_stairs[facing=north,half=bottom]';
    let block = original;
    for (let i = 0; i < 4; i++) block = rotateFacingCW90(block);
    expect(block).toBe(original);
  });
});

// ─── rotateGridCW90 ─────────────────────────────────────────────────────────

describe('rotateGridCW90', () => {
  it('swaps width and length dimensions', () => {
    const grid = new BlockGrid(5, 3, 10);
    const rotated = rotateGridCW90(grid);
    expect(rotated.width).toBe(10);  // old length
    expect(rotated.length).toBe(5);  // old width
    expect(rotated.height).toBe(3);  // unchanged
  });

  it('rotates block positions correctly', () => {
    // Place a block at (0, 0, 0) — northwest corner
    const grid = new BlockGrid(4, 2, 6);
    grid.set(0, 0, 0, 'minecraft:stone');

    const rotated = rotateGridCW90(grid);
    // CW90: (0, 0, 0) → (5, 0, 0) — northeast corner of new grid
    expect(rotated.get(5, 0, 0)).toBe('minecraft:stone');
    // Original position should be air
    expect(rotated.get(0, 0, 0)).toBe('minecraft:air');
  });

  it('rotates southeast corner block', () => {
    const grid = new BlockGrid(4, 2, 6);
    // Southeast corner: (3, 0, 5)
    grid.set(3, 0, 5, 'minecraft:stone');

    const rotated = rotateGridCW90(grid);
    // CW90: (3, 0, 5) → (0, 0, 3)
    expect(rotated.get(0, 0, 3)).toBe('minecraft:stone');
  });

  it('rotates facing properties of placed blocks', () => {
    const grid = new BlockGrid(4, 2, 4);
    grid.set(2, 1, 0, 'minecraft:oak_stairs[facing=north]');

    const rotated = rotateGridCW90(grid);
    // Block at (2, 1, 0) → (3, 1, 2) with facing=east
    expect(rotated.get(3, 1, 2)).toBe('minecraft:oak_stairs[facing=east]');
  });

  it('rotates block entities', () => {
    const grid = new BlockGrid(4, 4, 6);
    grid.addSign(1, 2, 3, 'north', ['Hello', 'World', '', '']);

    const rotated = rotateGridCW90(grid);
    expect(rotated.blockEntities.length).toBe(1);
    const be = rotated.blockEntities[0];
    // Position (1, 2, 3) → (2, 2, 1)
    expect(be.pos).toEqual([2, 2, 1]);
    // Sign text preserved
    expect(be.text).toEqual(['Hello', 'World', '', '']);
  });

  it('four rotations return to original layout', () => {
    const grid = new BlockGrid(4, 3, 4);
    grid.set(0, 0, 0, 'minecraft:oak_stairs[facing=north]');
    grid.set(3, 0, 3, 'minecraft:stone_bricks');
    grid.set(1, 2, 2, 'minecraft:oak_log[axis=x]');

    let rotated = grid;
    for (let i = 0; i < 4; i++) rotated = rotateGridCW90(rotated);

    // Dimensions restored (4x4 is square so width/length unchanged)
    expect(rotated.width).toBe(grid.width);
    expect(rotated.length).toBe(grid.length);

    // Blocks restored to original positions with original facing
    expect(rotated.get(0, 0, 0)).toBe('minecraft:oak_stairs[facing=north]');
    expect(rotated.get(3, 0, 3)).toBe('minecraft:stone_bricks');
    expect(rotated.get(1, 2, 2)).toBe('minecraft:oak_log[axis=x]');
  });

  it('handles non-square grids through 4 rotations', () => {
    const grid = new BlockGrid(3, 2, 7);
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(2, 1, 6, 'minecraft:oak_stairs[facing=south]');

    let rotated = grid;
    for (let i = 0; i < 4; i++) rotated = rotateGridCW90(rotated);

    expect(rotated.width).toBe(3);
    expect(rotated.length).toBe(7);
    expect(rotated.get(0, 0, 0)).toBe('minecraft:stone');
    expect(rotated.get(2, 1, 6)).toBe('minecraft:oak_stairs[facing=south]');
  });

  it('preserves Y positions unchanged', () => {
    const grid = new BlockGrid(3, 5, 3);
    for (let y = 0; y < 5; y++) {
      grid.set(1, y, 1, `minecraft:stone`);
    }

    const rotated = rotateGridCW90(grid);
    // Center of a 3x3 grid stays at center after rotation
    for (let y = 0; y < 5; y++) {
      expect(rotated.get(1, y, 1)).toBe('minecraft:stone');
    }
  });
});
