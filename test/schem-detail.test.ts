import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  applyDetailMaterials, DETAIL_MATERIALS, colorBaseOf, isAirState,
} from '../web/src/engine/schem-detail.js';

describe('schem-detail slope and stair smoothing', () => {
  it('correctly extracts color base', () => {
    expect(colorBaseOf('minecraft:white_concrete')).toBe('white');
    expect(colorBaseOf('red_wool')).toBe('red');
    expect(colorBaseOf('minecraft:black_terracotta[waterlogged=false]')).toBe('black');
    expect(colorBaseOf('minecraft:stone')).toBeNull();
  });

  it('recognizes air states', () => {
    expect(isAirState('minecraft:air')).toBe(true);
    expect(isAirState('minecraft:cave_air')).toBe(true);
    expect(isAirState('minecraft:void_air')).toBe(true);
    expect(isAirState(null)).toBe(true);
    expect(isAirState('minecraft:white_concrete')).toBe(false);
  });

  it('converts descending staircase steps into bottom stairs facing descent', () => {
    // 4 columns descending toward +X (east): x=0 (h=4), x=1 (h=3), x=2 (h=2), x=3 (h=1)
    const grid = new BlockGrid(4, 4, 1);
    const heights = [4, 3, 2, 1];
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < heights[x]!; y++) {
        grid.set(x, y, 0, 'minecraft:white_concrete');
      }
    }

    const stats = applyDetailMaterials(grid, { stairs: true });
    expect(stats.stairs).toBeGreaterThanOrEqual(2);
    expect(stats.byFacing['east']).toBeGreaterThanOrEqual(2);

    // x=1, y=2 should be a stair facing east
    const top1 = grid.get(1, 2, 0);
    expect(top1).toBe(`minecraft:${DETAIL_MATERIALS.white}_stairs[facing=east,half=bottom,shape=straight]`);
  });

  it('leaves flat plateau tops and solid interiors as full blocks', () => {
    // 3x2x3 solid concrete block
    const grid = new BlockGrid(3, 2, 3);
    grid.fill(0, 0, 0, 2, 1, 2, 'minecraft:gray_concrete');

    const stats = applyDetailMaterials(grid, { stairs: true });
    expect(stats.stairs).toBe(0);
    // Center-top block remains full concrete cube
    expect(grid.get(1, 1, 1)).toBe('minecraft:gray_concrete');
  });

  it('converts cantilever overhangs into upside-down (top-half) stairs', () => {
    // Underside stepping up toward +X
    const grid = new BlockGrid(4, 5, 1);
    const bottoms = [0, 1, 2, 3];
    for (let x = 0; x < 4; x++) {
      for (let y = bottoms[x]!; y <= 4; y++) {
        grid.set(x, y, 0, 'minecraft:yellow_concrete');
      }
    }

    const stats = applyDetailMaterials(grid, { stairs: true });
    expect(stats.stairs).toBeGreaterThanOrEqual(1);
    // Overhangs have half=top
    let foundTopStair = false;
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 5; y++) {
        if (grid.get(x, y, 0).includes('half=top')) foundTopStair = true;
      }
    }
    expect(foundTopStair).toBe(true);
  });

  it('caps flat single-height tops with bottom slabs when slabs option is enabled', () => {
    const grid = new BlockGrid(3, 2, 3);
    grid.fill(0, 0, 0, 2, 1, 2, 'minecraft:red_concrete');

    const stats = applyDetailMaterials(grid, { stairs: false, slabs: true });
    expect(stats.slabs).toBeGreaterThanOrEqual(1);
    expect(grid.get(1, 1, 1)).toBe(`minecraft:${DETAIL_MATERIALS.red}_slab[type=bottom]`);
  });
});
