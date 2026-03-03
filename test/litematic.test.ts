/**
 * Tests for Litematica .litematic format decoding, encoding, and parsing.
 * Tests the shared decode/encode utilities (bit-packing, blockstate reconstruction/decomposition)
 * and the region merging logic.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeBitPackedStates, reconstructBlockState, calcBitsPerEntry,
} from '../src/schem/litematic-decode.js';
import {
  encodeBitPackedStates, decomposeBlockState,
} from '../src/schem/litematic-encode.js';
import { mergeRegionsToGrid, type LitematicRegion } from '../src/schem/parse-litematic.js';
import { BlockGrid } from '../src/schem/types.js';

describe('litematic-decode', () => {
  describe('calcBitsPerEntry', () => {
    it('returns minimum of 2 for small palettes', () => {
      expect(calcBitsPerEntry(1)).toBe(2);
      expect(calcBitsPerEntry(2)).toBe(2);
      expect(calcBitsPerEntry(3)).toBe(2);
      expect(calcBitsPerEntry(4)).toBe(2);
    });

    it('returns correct bits for larger palettes', () => {
      expect(calcBitsPerEntry(5)).toBe(3);
      expect(calcBitsPerEntry(8)).toBe(3);
      expect(calcBitsPerEntry(9)).toBe(4);
      expect(calcBitsPerEntry(16)).toBe(4);
      expect(calcBitsPerEntry(17)).toBe(5);
      expect(calcBitsPerEntry(256)).toBe(8);
    });
  });

  describe('decodeBitPackedStates', () => {
    it('decodes 2-bit entries from a single long', () => {
      // 4 entries at 2 bits each: [0, 1, 2, 3] = 0b11_10_01_00 = 0xE4
      const longs = new BigInt64Array([0xE4n]);
      const result = decodeBitPackedStates(longs, 2, 4);
      expect(result).toEqual([0, 1, 2, 3]);
    });

    it('decodes 4-bit entries from a single long', () => {
      // 4 entries at 4 bits: [5, 10, 3, 15] = 0xF_3_A_5 = 0xF3A5
      const longs = new BigInt64Array([0xF3A5n]);
      const result = decodeBitPackedStates(longs, 4, 4);
      expect(result).toEqual([5, 10, 3, 15]);
    });

    it('decodes entries spanning two longs', () => {
      // 3-bit entries: each long holds 21 entries with 1 bit leftover.
      // Pack entry at index 21 that spans long boundary.
      // Put known values at positions 0 and 21.
      const totalEntries = 22;
      const bitsPerEntry = 3;

      // Build packed data manually
      const longs = new BigInt64Array(2);
      // Entry 0 = 5 (0b101) at bit 0
      longs[0] = 5n;
      // Entry 21 spans bits 63-65: 1 bit in long[0] + 2 bits in long[1]
      // bit 63 of long[0] = bit 0 of entry 21
      // bits 0-1 of long[1] = bits 1-2 of entry 21
      // Value = 7 (0b111): bit 63 of long[0] = 1, bits 0-1 of long[1] = 0b11
      longs[0] |= (1n << 63n);
      longs[1] = 3n; // bits 0-1 = 0b11

      const result = decodeBitPackedStates(longs, bitsPerEntry, totalEntries);
      expect(result[0]).toBe(5);
      expect(result[21]).toBe(7);
    });

    it('handles single-entry palette (all same block)', () => {
      // Palette size 1 → bitsPerEntry = 2 (minimum), but all indices are 0
      const longs = new BigInt64Array([0n]);
      const result = decodeBitPackedStates(longs, 2, 4);
      expect(result).toEqual([0, 0, 0, 0]);
    });

    it('handles empty block count', () => {
      const longs = new BigInt64Array([0n]);
      const result = decodeBitPackedStates(longs, 2, 0);
      expect(result).toEqual([]);
    });
  });

  describe('reconstructBlockState', () => {
    it('returns bare name when no properties', () => {
      expect(reconstructBlockState('minecraft:stone')).toBe('minecraft:stone');
      expect(reconstructBlockState('minecraft:air', {})).toBe('minecraft:air');
    });

    it('appends sorted properties', () => {
      const result = reconstructBlockState('minecraft:oak_stairs', {
        half: 'bottom',
        facing: 'north',
        shape: 'straight',
      });
      expect(result).toBe('minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
    });

    it('handles single property', () => {
      expect(reconstructBlockState('minecraft:oak_log', { axis: 'y' }))
        .toBe('minecraft:oak_log[axis=y]');
    });

    it('handles undefined properties', () => {
      expect(reconstructBlockState('minecraft:stone', undefined))
        .toBe('minecraft:stone');
    });
  });
});

describe('litematic-encode', () => {
  describe('encodeBitPackedStates', () => {
    it('round-trips 2-bit entries', () => {
      const original = [0, 1, 2, 3];
      const packed = encodeBitPackedStates(original, 2);
      const decoded = decodeBitPackedStates(packed, 2, original.length);
      expect(decoded).toEqual(original);
    });

    it('round-trips 4-bit entries', () => {
      const original = [5, 10, 3, 15, 0, 7, 12, 1];
      const packed = encodeBitPackedStates(original, 4);
      const decoded = decodeBitPackedStates(packed, 4, original.length);
      expect(decoded).toEqual(original);
    });

    it('round-trips 3-bit entries spanning multiple longs', () => {
      // 30 entries at 3 bits = 90 bits = 2 longs needed
      const original = Array.from({ length: 30 }, (_, i) => i % 8);
      const packed = encodeBitPackedStates(original, 3);
      expect(packed.length).toBe(2); // ceil(90/64) = 2
      const decoded = decodeBitPackedStates(packed, 3, original.length);
      expect(decoded).toEqual(original);
    });

    it('round-trips entries that span long boundaries', () => {
      // 5-bit entries: 64/5 = 12.8 entries per long, so entry 12 spans boundary
      const original = Array.from({ length: 20 }, (_, i) => i % 32);
      const packed = encodeBitPackedStates(original, 5);
      const decoded = decodeBitPackedStates(packed, 5, original.length);
      expect(decoded).toEqual(original);
    });

    it('round-trips large palette (8-bit entries)', () => {
      const original = Array.from({ length: 100 }, (_, i) => i % 256);
      const packed = encodeBitPackedStates(original, 8);
      const decoded = decodeBitPackedStates(packed, 8, original.length);
      expect(decoded).toEqual(original);
    });

    it('handles empty input', () => {
      const packed = encodeBitPackedStates([], 2);
      expect(packed.length).toBe(0);
    });

    it('handles all-zero entries', () => {
      const original = [0, 0, 0, 0, 0];
      const packed = encodeBitPackedStates(original, 2);
      const decoded = decodeBitPackedStates(packed, 2, original.length);
      expect(decoded).toEqual(original);
    });
  });

  describe('decomposeBlockState', () => {
    it('decomposes bare name (no properties)', () => {
      const result = decomposeBlockState('minecraft:stone');
      expect(result).toEqual({ name: 'minecraft:stone', properties: undefined });
    });

    it('decomposes name with properties', () => {
      const result = decomposeBlockState('minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
      expect(result).toEqual({
        name: 'minecraft:oak_stairs',
        properties: { facing: 'north', half: 'bottom', shape: 'straight' },
      });
    });

    it('decomposes single property', () => {
      const result = decomposeBlockState('minecraft:oak_log[axis=y]');
      expect(result).toEqual({
        name: 'minecraft:oak_log',
        properties: { axis: 'y' },
      });
    });

    it('round-trips with reconstructBlockState', () => {
      const states = [
        'minecraft:stone',
        'minecraft:air',
        'minecraft:oak_stairs[facing=north,half=bottom,shape=straight]',
        'minecraft:oak_log[axis=y]',
        'minecraft:chest[facing=west]',
      ];
      for (const state of states) {
        const { name, properties } = decomposeBlockState(state);
        const reconstructed = reconstructBlockState(name, properties);
        expect(reconstructed).toBe(state);
      }
    });
  });
});

describe('mergeRegionsToGrid', () => {
  it('returns single region grid directly', () => {
    const grid = new BlockGrid(3, 3, 3);
    grid.set(1, 1, 1, 'minecraft:stone');

    const regions: LitematicRegion[] = [{
      name: 'test',
      position: { x: 0, y: 0, z: 0 },
      width: 3, height: 3, length: 3,
      grid,
    }];

    const merged = mergeRegionsToGrid(regions);
    expect(merged).toBe(grid); // Same reference for single region
    expect(merged.get(1, 1, 1)).toBe('minecraft:stone');
  });

  it('merges two non-overlapping regions', () => {
    const grid1 = new BlockGrid(2, 2, 2);
    grid1.set(0, 0, 0, 'minecraft:stone');

    const grid2 = new BlockGrid(2, 2, 2);
    grid2.set(0, 0, 0, 'minecraft:oak_planks');

    const regions: LitematicRegion[] = [
      { name: 'a', position: { x: 0, y: 0, z: 0 }, width: 2, height: 2, length: 2, grid: grid1 },
      { name: 'b', position: { x: 5, y: 0, z: 0 }, width: 2, height: 2, length: 2, grid: grid2 },
    ];

    const merged = mergeRegionsToGrid(regions);
    expect(merged.width).toBe(7); // 0..6
    expect(merged.get(0, 0, 0)).toBe('minecraft:stone');
    expect(merged.get(5, 0, 0)).toBe('minecraft:oak_planks');
    // Gap between regions is air
    expect(merged.get(3, 0, 0)).toBe('minecraft:air');
  });

  it('handles negative position offsets', () => {
    const grid1 = new BlockGrid(2, 2, 2);
    grid1.set(0, 0, 0, 'minecraft:stone');

    const grid2 = new BlockGrid(2, 2, 2);
    grid2.set(1, 1, 1, 'minecraft:dirt');

    const regions: LitematicRegion[] = [
      { name: 'a', position: { x: -2, y: 0, z: 0 }, width: 2, height: 2, length: 2, grid: grid1 },
      { name: 'b', position: { x: 0, y: 0, z: 0 }, width: 2, height: 2, length: 2, grid: grid2 },
    ];

    const merged = mergeRegionsToGrid(regions);
    expect(merged.width).toBe(4); // -2..1 → 4 wide
    // grid1's (0,0,0) is at merged (0,0,0) [offset = -2 - (-2) = 0]
    expect(merged.get(0, 0, 0)).toBe('minecraft:stone');
    // grid2's (1,1,1) is at merged (3,1,1) [offset = 0 - (-2) = 2, plus (1,1,1)]
    expect(merged.get(3, 1, 1)).toBe('minecraft:dirt');
  });
});
