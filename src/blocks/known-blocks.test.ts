import { describe, it, expect } from 'vitest';
import { isKnownBlockState, findUnknownStates } from './known-blocks.js';
import { ROOF_PALETTE, roofBaseToFullBlock } from '../gen/color-blocks.js';

describe('isKnownBlockState', () => {
  it('accepts real blocks from all registry sources', () => {
    // texture list
    expect(isKnownBlockState('minecraft:deepslate_tiles')).toBe(true);
    expect(isKnownBlockState('minecraft:brown_concrete')).toBe(true);
    expect(isKnownBlockState('minecraft:clay')).toBe(true);
    // colour map only (no single texture file exists for slabs)
    expect(isKnownBlockState('minecraft:smooth_stone_slab[type=double]')).toBe(true);
    // air is always fine
    expect(isKnownBlockState('minecraft:air')).toBe(true);
  });

  it('rejects the invalid singular deepslate_tile (2026-07-18 regression)', () => {
    // This exact id was 22.9% of flatiron / 36.7% of guggenheim while every
    // geometry gate passed. It must never survive the palette gate again.
    expect(isKnownBlockState('minecraft:deepslate_tile')).toBe(false);
  });

  it('rejects made-up ids', () => {
    expect(isKnownBlockState('minecraft:definitely_not_a_block')).toBe(false);
  });
});

describe('findUnknownStates', () => {
  it('returns only the unknown states, deduplicated', () => {
    const states = [
      'minecraft:air', 'minecraft:stone', 'minecraft:deepslate_tile',
      'minecraft:deepslate_tile', 'minecraft:glass',
    ];
    expect(findUnknownStates(states)).toEqual(['minecraft:deepslate_tile']);
  });
  it('returns [] for a clean palette', () => {
    expect(findUnknownStates(['minecraft:air', 'minecraft:stone_bricks'])).toEqual([]);
  });
});

describe('every ROOF_PALETTE base maps to a known full block', () => {
  // The pipeline derives roof blocks as roofBaseToFullBlock(base) — if any
  // palette entry maps outside the registry, builds ship unknown ids again.
  for (const { base } of ROOF_PALETTE) {
    it(`${base} → valid`, () => {
      const full = roofBaseToFullBlock(base);
      expect(isKnownBlockState(full)).toBe(true);
    });
  }
});
