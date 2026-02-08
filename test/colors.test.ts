import { describe, it, expect } from 'vitest';
import { getBlockColor, FURNITURE_BLOCKS, LIGHT_BLOCKS, BED_BLOCKS, DOOR_BLOCKS } from '../src/blocks/colors.js';

describe('block colors', () => {
  it('returns null for air', () => {
    expect(getBlockColor('minecraft:air')).toBeNull();
  });

  it('returns colors for common blocks', () => {
    const stone = getBlockColor('minecraft:stone');
    expect(stone).not.toBeNull();
    expect(stone!.length).toBe(3);
    // Stone should be grayish
    expect(stone![0]).toBeGreaterThan(100);
    expect(stone![0]).toBeLessThan(180);
  });

  it('returns colors for blocks with properties', () => {
    const color = getBlockColor('minecraft:oak_stairs[facing=north]');
    expect(color).not.toBeNull();
  });

  it('handles prefix matching for variants', () => {
    const color = getBlockColor('minecraft:dark_oak_fence');
    expect(color).not.toBeNull();
  });

  it('generates fallback colors for unknown blocks', () => {
    const color = getBlockColor('minecraft:unknown_test_block_xyz');
    expect(color).not.toBeNull();
    expect(color!.length).toBe(3);
  });

  it('has furniture blocks set', () => {
    expect(FURNITURE_BLOCKS.has('minecraft:crafting_table')).toBe(true);
    expect(FURNITURE_BLOCKS.has('minecraft:anvil')).toBe(true);
  });

  it('has light blocks set', () => {
    expect(LIGHT_BLOCKS.has('minecraft:lantern')).toBe(true);
    expect(LIGHT_BLOCKS.has('minecraft:soul_lantern')).toBe(true);
    expect(LIGHT_BLOCKS.has('minecraft:glowstone')).toBe(true);
  });

  it('has bed blocks set', () => {
    expect(BED_BLOCKS.has('minecraft:red_bed')).toBe(true);
    expect(BED_BLOCKS.has('minecraft:blue_bed')).toBe(true);
  });

  it('has door blocks set', () => {
    expect(DOOR_BLOCKS.has('minecraft:oak_door')).toBe(true);
    expect(DOOR_BLOCKS.has('minecraft:iron_door')).toBe(true);
  });
});
