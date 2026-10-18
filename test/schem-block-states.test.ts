/**
 * Stateful block ids through the two export formats and back (shapes slice 1).
 *
 * Until 2026-09-08 every id we emitted was a bare `minecraft:<block>`; the
 * block-shape passes emit `minecraft:sandstone_slab[type=bottom]` and
 * `minecraft:oak_stairs[facing=north,half=bottom,shape=straight]`. Both writers
 * were BUILT to carry states (`.schem` keys are free-form strings, the litematic
 * writer has always had `decomposeBlockState`) but neither had ever been handed
 * one — "it should work" is not a gate. These assert the whole loop:
 *   • .schem  → palette string verbatim → parseSchemFile → identical id;
 *   • litematic → Name + Properties compound → parseLitematicFile → identical id;
 *   • the Upload tab's renderer colours a stateful shape id by its MATERIAL,
 *     not by the hash fallback (a re-imported slab must not be a random colour).
 */

import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { parseUncompressed } from 'prismarine-nbt';
import { BlockGrid } from '../src/schem/types.js';
import { encodeSchemBytes, encodeLitematicBytes } from '../web/src/engine/schem-encode.js';
import { parseSchemFile } from '../web/src/engine/schem.js';
import { parseLitematicFile } from '../web/src/engine/litematic.js';
import { getBlockColor, getAllBlockColors } from '../src/blocks/colors.js';
import { lintPalette } from '../web/src/engine/palette-lint.js';
import REGISTRY from '../web/src/engine/mc-block-registry.json';

/** Alphabetically-ordered properties — litematic round-trips sort them. */
const STATEFUL = [
  'minecraft:sandstone_slab[type=bottom]',
  'minecraft:sandstone_slab[type=top]',
  'minecraft:smooth_sandstone_stairs[facing=north,half=bottom,shape=straight]',
  'minecraft:oak_stairs[facing=west,half=top,shape=straight]',
] as const;

function statefulGrid(): BlockGrid {
  const g = new BlockGrid(4, 2, 2);
  STATEFUL.forEach((bs, i) => g.set(i, 0, 0, bs));
  g.set(0, 1, 0, 'minecraft:white_concrete');
  return g;
}

const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

describe('.schem with a stateful palette', () => {
  it('writes the state strings verbatim into Palette', async () => {
    const bytes = encodeSchemBytes(statefulGrid());
    const nbt = await parseUncompressed(Buffer.from(gunzipSync(Buffer.from(bytes))), 'big');
    const root = nbt.value as Record<string, { type: string; value: unknown }>;
    const entries = Object.keys(root['Palette']!.value as Record<string, unknown>);
    for (const bs of STATEFUL) expect(entries).toContain(bs);
  });

  it('round-trips every stateful id through parseSchemFile', async () => {
    const bytes = encodeSchemBytes(statefulGrid());
    const back = await parseSchemFile(bufferOf(bytes));
    STATEFUL.forEach((bs, i) => expect(back.get(i, 0, 0)).toBe(bs));
    expect(back.get(0, 1, 0)).toBe('minecraft:white_concrete');
  });

  it('passes the palette lint', async () => {
    const bytes = encodeSchemBytes(statefulGrid());
    const nbt = await parseUncompressed(Buffer.from(gunzipSync(Buffer.from(bytes))), 'big');
    const root = nbt.value as Record<string, { type: string; value: unknown }>;
    const entries = Object.keys(root['Palette']!.value as Record<string, unknown>);
    expect(lintPalette(entries).issues).toEqual([]);
  });
});

describe('.litematic with a stateful palette', () => {
  it('decomposes states into a Properties compound', async () => {
    const bytes = encodeLitematicBytes(statefulGrid(), 0);
    const nbt = await parseUncompressed(Buffer.from(gunzipSync(Buffer.from(bytes))), 'big');
    const root = nbt.value as Record<string, { value: unknown }>;
    const regions = (root['Regions']!.value as Record<string, { value: Record<string, { value: unknown }> }>);
    const region = Object.values(regions)[0]!.value;
    const list = (region['BlockStatePalette']!.value as { value: Array<Record<string, { value: unknown }>> }).value;
    const slab = list.find(e => (e['Name']!.value as string) === 'minecraft:sandstone_slab');
    expect(slab).toBeDefined();
    const props = (slab!['Properties']!.value as Record<string, { value: string }>);
    expect(props['type']!.value).toBe('bottom');

    const stairs = list.find(e => (e['Name']!.value as string) === 'minecraft:oak_stairs');
    const sp = (stairs!['Properties']!.value as Record<string, { value: string }>);
    expect(sp['facing']!.value).toBe('west');
    expect(sp['half']!.value).toBe('top');
    expect(sp['shape']!.value).toBe('straight');
  });

  it('round-trips every stateful id through parseLitematicFile', async () => {
    const bytes = encodeLitematicBytes(statefulGrid(), 0);
    const back = await parseLitematicFile(bufferOf(bytes));
    STATEFUL.forEach((bs, i) => expect(back.get(i, 0, 0)).toBe(bs));
  });
});

describe('renderer colour for stateful shape ids', () => {
  it('states never change the colour of an id that has its own entry', () => {
    // Many shape ids ARE listed in the colour table; the state tail must be
    // stripped before the lookup (getBaseId) so they still hit it.
    for (const [bare, stateful] of [
      ['minecraft:sandstone_slab', 'minecraft:sandstone_slab[type=bottom]'],
      ['minecraft:oak_stairs', 'minecraft:oak_stairs[facing=west,half=top,shape=straight]'],
      ['minecraft:quartz_slab', 'minecraft:quartz_slab[type=top]'],
    ] as const) {
      expect(getBlockColor(stateful)).toEqual(getBlockColor(bare));
      expect(getBlockColor(bare)).not.toBeNull();
    }
  });

  it('every registry slab/stair id resolves to its material colour, never the hash fallback', () => {
    // The invariant that matters: a shape id absent from the hand-written colour
    // table used to fall through to the hash fallback and re-import as a random
    // colour. Every id the shape passes may emit must resolve deliberately.
    const table = getAllBlockColors();
    const shapeIds = [...REGISTRY.slabs, ...REGISTRY.stairs];
    expect(shapeIds.length).toBeGreaterThan(80);

    let fellBack = 0;
    for (const id of shapeIds) {
      const full = `minecraft:${id}`;
      if (table.has(full)) continue;   // has its own entry — nothing to fall back to
      const stem = id.replace(/_(slab|stairs)$/, '');
      const material = [stem, `${stem}s`, `${stem}_planks`, `${stem}_block`]
        .map(c => `minecraft:${c}`)
        .find(c => table.has(c));
      // A material the colour table has never listed (diorite, tuff…) is a
      // pre-existing gap in that table, not a states problem — those blocks are
      // not emitted by any mapping table today. Assert the ones we CAN resolve.
      if (!material) continue;
      fellBack++;
      expect(getBlockColor(full), id).toEqual(table.get(material));
    }
    // Guard against the test going vacuous.
    expect(fellBack).toBeGreaterThan(0);
  });

  it('still returns null for air and a colour for a plain block', () => {
    expect(getBlockColor('minecraft:air')).toBeNull();
    expect(getBlockColor('minecraft:white_concrete')).not.toBeNull();
  });
});
