/**
 * Tests for Litematica .litematic write + parse round-trip.
 * Verifies that BlockGrid → .litematic → BlockGrid produces matching results.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlockGrid } from '../src/schem/types.js';
import { writeLitematic, encodeLitematicNBT } from '../src/schem/write-litematic.js';
import { parseLitematic, parseLitematicToGrid } from '../src/schem/parse-litematic.js';

// Write temp file in test dir — /tmp is EACCES on Termux glibc
const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_FILE = join(__dirname, '.test-litematic-roundtrip.litematic');

afterEach(() => {
  // Clean up temp file
  if (existsSync(TMP_FILE)) unlinkSync(TMP_FILE);
});

describe('write-litematic', () => {
  describe('encodeLitematicNBT', () => {
    it('produces non-empty bytes for a simple grid', () => {
      const grid = new BlockGrid(3, 3, 3);
      grid.set(1, 1, 1, 'minecraft:stone');
      const bytes = encodeLitematicNBT(grid);
      // Must produce valid NBT bytes (starts with TAG_Compound = 0x0A)
      expect(bytes.length).toBeGreaterThan(50);
      expect(bytes[0]).toBe(0x0A); // TAG_Compound
    });
  });

  describe('writeLitematic + parseLitematicToGrid round-trip', () => {
    it('round-trips a simple grid', async () => {
      const grid = new BlockGrid(4, 3, 5);
      grid.set(0, 0, 0, 'minecraft:stone');
      grid.set(1, 1, 1, 'minecraft:oak_planks');
      grid.set(3, 2, 4, 'minecraft:glass');

      writeLitematic(grid, TMP_FILE);
      expect(existsSync(TMP_FILE)).toBe(true);

      const parsed = await parseLitematicToGrid(TMP_FILE);
      expect(parsed.width).toBe(4);
      expect(parsed.height).toBe(3);
      expect(parsed.length).toBe(5);
      expect(parsed.get(0, 0, 0)).toBe('minecraft:stone');
      expect(parsed.get(1, 1, 1)).toBe('minecraft:oak_planks');
      expect(parsed.get(3, 2, 4)).toBe('minecraft:glass');
      // Air positions remain air
      expect(parsed.get(2, 2, 2)).toBe('minecraft:air');
    });

    it('round-trips block states with properties', async () => {
      const grid = new BlockGrid(3, 3, 3);
      grid.set(0, 0, 0, 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
      grid.set(1, 0, 0, 'minecraft:oak_log[axis=y]');
      grid.set(2, 0, 0, 'minecraft:chest[facing=west]');

      writeLitematic(grid, TMP_FILE);
      const parsed = await parseLitematicToGrid(TMP_FILE);

      expect(parsed.get(0, 0, 0)).toBe('minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
      expect(parsed.get(1, 0, 0)).toBe('minecraft:oak_log[axis=y]');
      expect(parsed.get(2, 0, 0)).toBe('minecraft:chest[facing=west]');
    });

    it('round-trips a large palette', async () => {
      const grid = new BlockGrid(5, 5, 5);
      const blocks = [
        'minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block',
        'minecraft:oak_planks', 'minecraft:spruce_planks', 'minecraft:birch_planks',
        'minecraft:cobblestone', 'minecraft:stone_bricks', 'minecraft:glass',
        'minecraft:oak_log[axis=y]', 'minecraft:oak_log[axis=x]',
      ];
      // Fill grid with diverse palette
      for (let y = 0; y < 5; y++) {
        for (let z = 0; z < 5; z++) {
          for (let x = 0; x < 5; x++) {
            const idx = (y * 25 + z * 5 + x) % blocks.length;
            grid.set(x, y, z, blocks[idx]);
          }
        }
      }

      writeLitematic(grid, TMP_FILE, { name: 'test-palette' });
      const parsed = await parseLitematicToGrid(TMP_FILE);

      expect(parsed.width).toBe(5);
      expect(parsed.height).toBe(5);
      expect(parsed.length).toBe(5);

      // Verify all blocks match
      for (let y = 0; y < 5; y++) {
        for (let z = 0; z < 5; z++) {
          for (let x = 0; x < 5; x++) {
            expect(parsed.get(x, y, z)).toBe(grid.get(x, y, z));
          }
        }
      }
    });

    it('round-trips an all-air grid', async () => {
      const grid = new BlockGrid(2, 2, 2);

      writeLitematic(grid, TMP_FILE);
      const parsed = await parseLitematicToGrid(TMP_FILE);

      expect(parsed.width).toBe(2);
      expect(parsed.height).toBe(2);
      expect(parsed.length).toBe(2);
      expect(parsed.countNonAir()).toBe(0);
    });

    it('preserves region metadata via parseLitematic', async () => {
      const grid = new BlockGrid(3, 4, 5);
      grid.set(1, 2, 3, 'minecraft:stone');

      writeLitematic(grid, TMP_FILE, {
        name: 'test-region',
        author: 'test-author',
      });

      const regions = await parseLitematic(TMP_FILE);
      expect(regions.length).toBe(1);
      expect(regions[0].name).toBe('test-region');
      expect(regions[0].width).toBe(3);
      expect(regions[0].height).toBe(4);
      expect(regions[0].length).toBe(5);
      expect(regions[0].grid.get(1, 2, 3)).toBe('minecraft:stone');
    });
  });
});
