import { describe, it, expect } from 'vitest';
import { mapExteriorToWall } from '../web/src/ui/import-rentcast.js';

describe('mapExteriorToWall', () => {
  it('maps "Brick" to minecraft:bricks', () => {
    expect(mapExteriorToWall('Brick')).toBe('minecraft:bricks');
  });

  it('maps "Brick Veneer" to minecraft:bricks', () => {
    expect(mapExteriorToWall('Brick Veneer')).toBe('minecraft:bricks');
  });

  it('maps "Stone" to minecraft:stone_bricks', () => {
    expect(mapExteriorToWall('Stone')).toBe('minecraft:stone_bricks');
  });

  it('maps "Stucco" to minecraft:white_concrete', () => {
    expect(mapExteriorToWall('Stucco')).toBe('minecraft:white_concrete');
  });

  it('maps "Vinyl Siding" to minecraft:white_concrete', () => {
    expect(mapExteriorToWall('Vinyl Siding')).toBe('minecraft:white_concrete');
  });

  it('maps "Cement Fiber" to minecraft:white_concrete', () => {
    expect(mapExteriorToWall('Cement Fiber')).toBe('minecraft:white_concrete');
  });

  it('maps "Wood Siding" to minecraft:oak_planks', () => {
    expect(mapExteriorToWall('Wood Siding')).toBe('minecraft:oak_planks');
  });

  it('maps "Wood" to minecraft:oak_planks', () => {
    expect(mapExteriorToWall('Wood')).toBe('minecraft:oak_planks');
  });

  it('maps "Log" to minecraft:spruce_planks', () => {
    expect(mapExteriorToWall('Log')).toBe('minecraft:spruce_planks');
  });

  it('maps "Metal" to minecraft:iron_block', () => {
    expect(mapExteriorToWall('Metal')).toBe('minecraft:iron_block');
  });

  it('maps "Aluminum Siding" to minecraft:iron_block', () => {
    expect(mapExteriorToWall('Aluminum Siding')).toBe('minecraft:iron_block');
  });

  it('maps "Adobe" to minecraft:terracotta', () => {
    expect(mapExteriorToWall('Adobe')).toBe('minecraft:terracotta');
  });

  it('returns undefined for unknown exterior types', () => {
    expect(mapExteriorToWall('Unknown Material')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(mapExteriorToWall('')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(mapExteriorToWall('BRICK')).toBe('minecraft:bricks');
    expect(mapExteriorToWall('wood siding')).toBe('minecraft:oak_planks');
    expect(mapExteriorToWall('STUCCO')).toBe('minecraft:white_concrete');
  });
});
