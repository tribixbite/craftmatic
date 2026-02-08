import { describe, it, expect } from 'vitest';
import { parseBlockState, getBaseId, getBlockName, isAir, isTransparent, isSolidBlock, getFacing } from '../src/blocks/registry.js';

describe('block registry', () => {
  describe('parseBlockState', () => {
    it('parses simple block states', () => {
      const result = parseBlockState('minecraft:stone');
      expect(result.name).toBe('stone');
      expect(result.id).toBe('minecraft:stone');
      expect(result.properties).toEqual({});
    });

    it('parses block states with properties', () => {
      const result = parseBlockState('minecraft:oak_stairs[facing=north,half=bottom]');
      expect(result.name).toBe('oak_stairs');
      expect(result.id).toBe('minecraft:oak_stairs');
      expect(result.properties).toEqual({ facing: 'north', half: 'bottom' });
    });

    it('handles missing namespace', () => {
      const result = parseBlockState('stone');
      expect(result.name).toBe('stone');
      expect(result.id).toBe('stone');
    });
  });

  describe('getBaseId', () => {
    it('strips properties and namespace', () => {
      expect(getBaseId('minecraft:oak_stairs[facing=north]')).toBe('minecraft:oak_stairs');
      expect(getBaseId('minecraft:stone')).toBe('minecraft:stone');
    });
  });

  describe('getBlockName', () => {
    it('returns the block name without namespace', () => {
      expect(getBlockName('minecraft:dark_oak_planks')).toBe('dark_oak_planks');
      expect(getBlockName('minecraft:stone[variant=granite]')).toBe('stone');
    });
  });

  describe('isAir', () => {
    it('recognizes air blocks', () => {
      expect(isAir('minecraft:air')).toBe(true);
      expect(isAir('minecraft:cave_air')).toBe(true);
      expect(isAir('minecraft:void_air')).toBe(true);
    });

    it('rejects non-air blocks', () => {
      expect(isAir('minecraft:stone')).toBe(false);
      expect(isAir('minecraft:glass')).toBe(false);
    });
  });

  describe('isTransparent', () => {
    it('identifies transparent blocks', () => {
      expect(isTransparent('minecraft:glass')).toBe(true);
      expect(isTransparent('minecraft:glass_pane')).toBe(true);
      expect(isTransparent('minecraft:torch')).toBe(true);
    });

    it('identifies opaque blocks', () => {
      expect(isTransparent('minecraft:stone')).toBe(false);
      expect(isTransparent('minecraft:oak_planks')).toBe(false);
    });
  });

  describe('isSolidBlock', () => {
    it('identifies solid blocks', () => {
      expect(isSolidBlock('minecraft:stone')).toBe(true);
      expect(isSolidBlock('minecraft:oak_planks')).toBe(true);
    });

    it('rejects non-solid blocks', () => {
      expect(isSolidBlock('minecraft:air')).toBe(false);
      expect(isSolidBlock('minecraft:torch')).toBe(false);
      expect(isSolidBlock('minecraft:glass')).toBe(false);
    });
  });

  describe('getFacing', () => {
    it('extracts facing from block state', () => {
      expect(getFacing('minecraft:chest[facing=east]')).toBe('east');
      expect(getFacing('minecraft:oak_stairs[facing=north,half=bottom]')).toBe('north');
    });

    it('returns undefined for blocks without facing', () => {
      expect(getFacing('minecraft:stone')).toBeUndefined();
    });
  });
});
