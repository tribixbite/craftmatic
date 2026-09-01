/**
 * Palette lint (S5) — external-viewer compatibility, caught offline.
 *
 * A .schem's palette is just strings; our own importer round-trips whatever we
 * write, so a typo'd block id ("minecraft:white_concreet") survives every
 * internal test and only shows up as a missing/pink block in WorldEdit,
 * Litematica or schemat.io. This asserts:
 *   • every block id in the shipped colour tables is a real Minecraft block,
 *   • a real exported .schem's Palette (read back with prismarine-nbt) is
 *     entirely `minecraft:<known id>`,
 *   • a deliberately typo'd entry IS caught (the lint isn't vacuous).
 */

import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { parseUncompressed } from 'prismarine-nbt';
import { BlockGrid } from '../src/schem/types.js';
import { encodeSchemBytes } from '../web/src/engine/schem-encode.js';
import { lintPalette, knownBlockIds } from '../web/src/engine/palette-lint.js';
import { LDRAW_COLOR_TO_BLOCK } from '../web/src/engine/ldraw-colors.js';
import { STUDIO_COLOR_TO_BLOCK } from '../web/src/engine/studio-colors.js';
import { ldrawColorToBlock } from '../web/src/engine/ldraw-colors.js';
import { studioColorToBlock } from '../web/src/engine/studio-colors.js';
import { BLOCK_PROFILES } from '../web/src/engine/block-profiles.js';

describe('mapping tables', () => {
  it('every LDraw colour maps to a real Minecraft block', () => {
    const r = lintPalette(Object.values(LDRAW_COLOR_TO_BLOCK));
    expect(r.issues).toEqual([]);
    expect(r.checked).toBeGreaterThan(100);
  });

  it('every Studio/BrickLink colour maps to a real Minecraft block', () => {
    const r = lintPalette(Object.values(STUDIO_COLOR_TO_BLOCK));
    expect(r.issues).toEqual([]);
    expect(r.checked).toBeGreaterThan(100);
  });

  it('the unmapped-colour fallbacks are real blocks', () => {
    // Ids that are in neither table → the deliberately boring grey fallback.
    const r = lintPalette([ldrawColorToBlock(999999), studioColorToBlock(999999)]);
    expect(r.issues).toEqual([]);
  });

  it('every profile light block is a real block', () => {
    const r = lintPalette(BLOCK_PROFILES.map(p => p.lightBlock));
    expect(r.issues).toEqual([]);
  });
});

describe('exported .schem palette', () => {
  it('emits only minecraft:<known id> entries', async () => {
    // A synthetic grid touching several colour families + the light block.
    const g = new BlockGrid(4, 4, 4);
    g.set(0, 0, 0, ldrawColorToBlock(15)); // LDraw White
    g.set(1, 0, 0, ldrawColorToBlock(0));  // Black
    g.set(2, 0, 0, ldrawColorToBlock(4));  // Red
    g.set(3, 0, 0, ldrawColorToBlock(36)); // Trans-Red → stained glass
    g.set(0, 1, 0, studioColorToBlock(11)); // Studio Black
    g.set(1, 1, 0, BLOCK_PROFILES[0]!.lightBlock);
    g.set(2, 1, 0, 'minecraft:iron_block');

    const bytes = encodeSchemBytes(g);
    const nbt = await parseUncompressed(Buffer.from(gunzipSync(Buffer.from(bytes))), 'big');
    const root = nbt.value as Record<string, { type: string; value: unknown }>;
    const palette = (root['Palette']!.value as Record<string, unknown>);
    const entries = Object.keys(palette);

    expect(entries.length).toBeGreaterThan(1);
    expect(entries).toContain('minecraft:air');
    const r = lintPalette(entries);
    expect(r.issues).toEqual([]);
  });
});

describe('the lint itself', () => {
  it('catches a typo, a bad namespace and a bare id', () => {
    const r = lintPalette([
      'minecraft:white_concreet',   // typo
      'mynecraft:white_concrete',   // wrong namespace
      'white_concrete',             // no namespace
      'minecraft:',                 // malformed
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues.map(i => i.reason)).toEqual([
      'unknown-block', 'bad-namespace', 'missing-namespace', 'malformed',
    ]);
  });

  it('accepts block states with properties', () => {
    expect(lintPalette(['minecraft:oak_log[axis=y]']).ok).toBe(true);
  });

  it('knows the 16-colour families and the light sources', () => {
    const ids = knownBlockIds();
    for (const c of ['white', 'light_gray', 'magenta', 'black']) {
      expect(ids.has(`${c}_concrete`)).toBe(true);
      expect(ids.has(`${c}_stained_glass`)).toBe(true);
      expect(ids.has(`${c}_wool`)).toBe(true);
    }
    expect(ids.has('glowstone')).toBe(true);
    expect(ids.has('sea_lantern')).toBe(true);
    expect(ids.has('definitely_not_a_block')).toBe(false);
  });
});
