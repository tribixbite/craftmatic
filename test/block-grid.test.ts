import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';

describe('BlockGrid', () => {
  it('creates a grid filled with air', () => {
    const grid = new BlockGrid(4, 3, 5);
    expect(grid.width).toBe(4);
    expect(grid.height).toBe(3);
    expect(grid.length).toBe(5);
    expect(grid.get(0, 0, 0)).toBe('minecraft:air');
    expect(grid.get(3, 2, 4)).toBe('minecraft:air');
  });

  it('sets and gets blocks', () => {
    const grid = new BlockGrid(10, 10, 10);
    grid.set(3, 5, 7, 'minecraft:stone');
    expect(grid.get(3, 5, 7)).toBe('minecraft:stone');
    expect(grid.get(3, 5, 6)).toBe('minecraft:air');
  });

  it('returns air for out-of-bounds coordinates', () => {
    const grid = new BlockGrid(5, 5, 5);
    expect(grid.get(-1, 0, 0)).toBe('minecraft:air');
    expect(grid.get(0, -1, 0)).toBe('minecraft:air');
    expect(grid.get(5, 0, 0)).toBe('minecraft:air');
    expect(grid.get(0, 5, 0)).toBe('minecraft:air');
  });

  it('fills a volume', () => {
    const grid = new BlockGrid(10, 10, 10);
    grid.fill(2, 2, 2, 5, 5, 5, 'minecraft:oak_planks');

    // Inside the fill
    expect(grid.get(2, 2, 2)).toBe('minecraft:oak_planks');
    expect(grid.get(4, 4, 4)).toBe('minecraft:oak_planks');

    // Outside the fill
    expect(grid.get(1, 2, 2)).toBe('minecraft:air');
    expect(grid.get(6, 2, 2)).toBe('minecraft:air');
  });

  it('builds walls (hollow box)', () => {
    const grid = new BlockGrid(10, 10, 10);
    grid.walls(0, 0, 0, 5, 5, 5, 'minecraft:stone_bricks');

    // Faces should be filled
    expect(grid.get(0, 0, 0)).toBe('minecraft:stone_bricks');
    expect(grid.get(5, 0, 0)).toBe('minecraft:stone_bricks');
    expect(grid.get(0, 5, 0)).toBe('minecraft:stone_bricks');

    // Interior should be air
    expect(grid.get(2, 2, 2)).toBe('minecraft:air');
    expect(grid.get(3, 3, 3)).toBe('minecraft:air');
  });

  it('tracks palette correctly', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 0, 0, 'minecraft:oak_planks');
    grid.set(2, 0, 0, 'minecraft:stone');

    expect(grid.palette.has('minecraft:air')).toBe(true);
    expect(grid.palette.has('minecraft:stone')).toBe(true);
    expect(grid.palette.has('minecraft:oak_planks')).toBe(true);
    expect(grid.palette.size).toBe(3);
  });

  it('counts non-air blocks', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 0, 0, 'minecraft:oak_planks');
    grid.set(2, 0, 0, 'minecraft:stone');
    expect(grid.countNonAir()).toBe(3);
  });

  it('encodes block data', () => {
    const grid = new BlockGrid(4, 4, 4);
    grid.set(0, 0, 0, 'minecraft:stone');
    grid.set(1, 0, 0, 'minecraft:oak_planks');
    grid.set(3, 3, 3, 'minecraft:glass');

    const encoded = grid.encodeBlockData();
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);
  });

  it('converts to 3D array', () => {
    const grid = new BlockGrid(3, 2, 4);
    grid.set(1, 0, 2, 'minecraft:stone');
    const arr = grid.to3DArray();

    // arr[y][z][x]
    expect(arr.length).toBe(2); // height
    expect(arr[0].length).toBe(4); // length
    expect(arr[0][0].length).toBe(3); // width
    expect(arr[0][2][1]).toBe('minecraft:stone');
    expect(arr[0][0][0]).toBe('minecraft:air');
  });
});
