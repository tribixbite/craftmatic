import { describe, it, expect } from 'vitest';
import { generateStructure } from '../src/gen/generator.js';
import { mapColorToWall } from '../web/src/ui/import-color.js';
import { mapSmartyExteriorToWall as mapExteriorToWall } from '../src/gen/api/smarty.js';

describe('wallOverride enrichment pipeline', () => {
  it('generates a house with wallOverride from exterior type mapping', () => {
    const wall = mapExteriorToWall('Brick');
    expect(wall).toBe('minecraft:bricks');

    const grid = generateStructure({
      type: 'house',
      floors: 2,
      style: 'modern',
      seed: 42,
      wallOverride: wall,
    });

    expect(grid.countNonAir()).toBeGreaterThan(100);
  });

  it('generates a house with wallOverride from satellite color mapping', () => {
    // Simulated reddish-brown detected color
    const wall = mapColorToWall({ r: 155, g: 100, b: 85 });
    expect(wall).toBe('minecraft:bricks');

    const grid = generateStructure({
      type: 'house',
      floors: 2,
      style: 'rustic',
      seed: 99,
      wallOverride: wall,
    });

    expect(grid.countNonAir()).toBeGreaterThan(100);
  });

  it('exterior type wall takes priority over satellite color', () => {
    // Simulate: Smarty says "Brick", satellite detects a gray color
    const exteriorWall = mapExteriorToWall('Brick');
    const colorWall = mapColorToWall({ r: 125, g: 125, b: 125 });

    // Smarty should win — brick, not stone_bricks
    expect(exteriorWall).toBe('minecraft:bricks');
    expect(colorWall).toBe('minecraft:stone_bricks');

    // Priority chain: use exterior if available, else satellite color
    const finalWall = exteriorWall ?? colorWall;
    expect(finalWall).toBe('minecraft:bricks');
  });

  it('falls back to satellite color when exterior is unknown', () => {
    const exteriorWall = mapExteriorToWall('Unknown Material');
    const colorWall = mapColorToWall({ r: 218, g: 205, b: 158 });

    expect(exteriorWall).toBeUndefined();
    expect(colorWall).toBe('minecraft:sandstone');

    const finalWall = exteriorWall ?? colorWall;
    expect(finalWall).toBe('minecraft:sandstone');
  });
});
