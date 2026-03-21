import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { severStreetFurniture } from '../src/convert/mesh-filter.js';

const STONE = 'minecraft:stone';

describe('severStreetFurniture', () => {
  it('removes disconnected pole outside footprint', () => {
    const grid = new BlockGrid(20, 20, 20);
    // Fill main building (x=5-14, z=5-14, y=0-19)
    for (let y = 0; y < 20; y++)
      for (let x = 5; x < 15; x++)
        for (let z = 5; z < 15; z++)
          grid.set(x, y, z, STONE);
    // Add pole at (1, 0-14, 1) — outside footprint, connected at ground
    for (let y = 0; y < 15; y++)
      grid.set(1, y, 1, STONE);
    // Connect pole to building at y=0
    grid.set(2, 0, 1, STONE);
    grid.set(3, 0, 1, STONE);
    grid.set(4, 0, 1, STONE);

    const removed = severStreetFurniture(grid, 1);
    expect(removed).toBeGreaterThan(0);
    // Pole should be gone
    expect(grid.get(1, 10, 1)).toBe('minecraft:air');
    // Building should remain
    expect(grid.get(10, 10, 10)).toBe('minecraft:stone');
  });

  it('preserves building voxels inside OSM footprint mask', () => {
    const grid = new BlockGrid(10, 20, 10);
    // Narrow 2-block wide building
    for (let y = 0; y < 20; y++)
      for (let x = 4; x < 6; x++)
        for (let z = 0; z < 10; z++)
          grid.set(x, y, z, STONE);

    // OSM polygon covers the building footprint
    const osmPoly = [
      { lat: 0.0001, lon: -0.0001 },
      { lat: 0.0001, lon: 0.0001 },
      { lat: -0.0001, lon: 0.0001 },
      { lat: -0.0001, lon: -0.0001 },
    ];
    const removed = severStreetFurniture(grid, 1, osmPoly, 0, 0);
    // Narrow building preserved — it's inside the OSM polygon
    expect(grid.get(5, 10, 5)).toBe('minecraft:stone');
  });

  it('uses aspect-ratio fallback when no OSM polygon', () => {
    const grid = new BlockGrid(20, 20, 20);
    // Main building 10x10x10
    for (let y = 0; y < 10; y++)
      for (let x = 5; x < 15; x++)
        for (let z = 5; z < 15; z++)
          grid.set(x, y, z, STONE);
    // Very tall thin pole: 1x18x1 (aspect > 8)
    for (let y = 0; y < 18; y++)
      grid.set(0, y, 0, STONE);

    const removed = severStreetFurniture(grid, 1);
    expect(removed).toBeGreaterThan(0);
    expect(grid.get(0, 10, 0)).toBe('minecraft:air');
  });
});
