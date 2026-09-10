/**
 * Bedrock `.mcstructure` + `.mcpack` round-trip.
 *
 * The gate here is that the bytes are decoded by an INDEPENDENT little-endian
 * NBT reader (`prismarine-nbt` in `little` mode), not by our own code — the same
 * discipline as the palette lint (S5): a writer checked only against its own
 * reader is self-consistent and can still be wrong in a way that only Minecraft
 * sees. Specifically pinned here:
 *
 *   • the container: little-endian, uncompressed, NO file header (unlike
 *     `level.dat`), unnamed root compound;
 *   • the exact tag tree, names and TYPES — `upside_down_bit` must be a byte and
 *     `weirdo_direction` an int, or the permutation is unresolvable in-game;
 *   • the cell order, against the format documentation's own 2×3×4 example
 *     (`index = x*sizeY*sizeZ + y*sizeZ + z`, Z fastest). Getting this wrong
 *     transposes the whole model, which no palette check would notice;
 *   • tiling: a grid over Bedrock's 64×384×64 structure limit is split, each
 *     piece trimmed to its own contents, and REASSEMBLING every decoded piece at
 *     its recorded offset reproduces the source grid cell for cell.
 */

import { describe, it, expect } from 'vitest';
import { parseUncompressed } from 'prismarine-nbt';
import { BlockGrid } from '../src/schem/types.js';
import {
  encodeMcstructureTile, planStructureTiles,
  BEDROCK_BLOCK_VERSION, BEDROCK_MAX_TILE, MCSTRUCTURE_FORMAT_VERSION,
} from '../web/src/engine/mcstructure-encode.js';
import { buildMcpack, deterministicUuid, exportVersion, toBedrockIdentifier, PACK_NAMESPACE } from '../web/src/engine/mcpack.js';
import { listZipEntries, extractFile } from '../web/src/engine/zip-utils.js';

/** Decode `.mcstructure` bytes with the third-party little-endian NBT reader. */
async function decode(bytes: Uint8Array) {
  const nbt = await parseUncompressed(Buffer.from(bytes), 'little');
  return nbt as unknown as {
    type: string; name: string;
    value: Record<string, { type: string; value: unknown }>;
  };
}

interface DecodedStructure {
  size: number[];
  origin: number[];
  layers: number[][];
  palette: Array<{ name: string; states: Record<string, { type: string; value: unknown }>; version: number }>;
  formatVersion: number;
  entitiesEmpty: boolean;
  hasBlockPositionData: boolean;
}

async function decodeStructure(bytes: Uint8Array): Promise<DecodedStructure> {
  const root = await decode(bytes);
  expect(root.type).toBe('compound');
  expect(root.name).toBe('');                 // root compound is unnamed
  const r = root.value;
  const structure = (r['structure']!.value as Record<string, { type: string; value: unknown }>);
  const indices = structure['block_indices']!.value as { type: string; value: Array<{ type: string; value: number[] }> };
  const palette = ((structure['palette']!.value as Record<string, { value: unknown }>)['default']!
    .value as Record<string, { type: string; value: unknown }>);
  const blockPalette = palette['block_palette']!.value as { type: string; value: Array<Record<string, { type: string; value: unknown }>> };
  const entities = structure['entities']!.value as { type: string; value: unknown[] };

  return {
    formatVersion: r['format_version']!.value as number,
    size: (r['size']!.value as { value: number[] }).value,
    origin: (r['structure_world_origin']!.value as { value: number[] }).value,
    layers: indices.value.map(l => l.value),
    palette: blockPalette.value.map(entry => ({
      name: entry['name']!.value as string,
      states: entry['states']!.value as Record<string, { type: string; value: unknown }>,
      version: entry['version']!.value as number,
    })),
    entitiesEmpty: (entities.value as unknown[]).length === 0,
    hasBlockPositionData: 'block_position_data' in palette,
  };
}

describe('.mcstructure container', () => {
  it('is uncompressed little-endian NBT with no file header', async () => {
    const g = new BlockGrid(1, 1, 1);
    g.set(0, 0, 0, 'minecraft:stone');
    const [tile] = planStructureTiles(g, 'one');
    const { bytes } = encodeMcstructureTile(g, tile!);

    // Not gzip (Java .schem is), and the very first bytes ARE the root tag:
    // 0x0A = TAG_Compound, then a little-endian uint16 name length of 0.
    expect(bytes[0]).not.toBe(0x1f);
    expect(bytes[0]).toBe(0x0a);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[2]).toBe(0x00);
    expect(bytes[3]).toBe(0x03);                 // TAG_Int, the first child
  });

  it('writes the documented tag tree', async () => {
    const g = new BlockGrid(2, 2, 2);
    g.set(0, 0, 0, 'minecraft:white_concrete');
    const [tile] = planStructureTiles(g, 'tree');
    const s = await decodeStructure(encodeMcstructureTile(g, tile!).bytes);

    expect(s.formatVersion).toBe(MCSTRUCTURE_FORMAT_VERSION);
    expect(s.origin).toEqual([0, 0, 0]);
    expect(s.entitiesEmpty).toBe(true);
    expect(s.hasBlockPositionData).toBe(true);   // present, empty
    expect(s.layers).toHaveLength(2);            // exactly two layers, always
    for (const entry of s.palette) expect(entry.version).toBe(BEDROCK_BLOCK_VERSION);
  });

  it('sizes both index layers to the volume and voids the second', async () => {
    const g = new BlockGrid(3, 4, 5);
    g.set(0, 0, 0, 'minecraft:stone');
    g.set(2, 3, 4, 'minecraft:stone');
    const [tile] = planStructureTiles(g, 'layers');
    const s = await decodeStructure(encodeMcstructureTile(g, tile!).bytes);

    expect(s.size).toEqual([3, 4, 5]);
    const volume = 3 * 4 * 5;
    expect(s.layers[0]).toHaveLength(volume);
    expect(s.layers[1]).toHaveLength(volume);
    // Layer 1 is the waterlogging layer; we never use it, so every cell is a
    // void (-1) rather than air, which would place a block.
    expect(new Set(s.layers[1]!)).toEqual(new Set([-1]));
  });
});

describe('cell ordering', () => {
  it('matches the format documentation\'s 2x3x4 example (Z fastest)', async () => {
    // The wiki states a 2x3x4 structure's 24 values are the blocks at
    // 0 0 0, 0 0 1, 0 0 2, 0 0 3, 0 1 0, … 1 2 3.
    const g = new BlockGrid(2, 3, 4);
    g.set(0, 0, 0, 'minecraft:white_concrete');   // index 0
    g.set(0, 1, 2, 'minecraft:red_concrete');     // 0*12 + 1*4 + 2 = 6
    g.set(1, 2, 3, 'minecraft:black_concrete');   // 1*12 + 2*4 + 3 = 23
    const [tile] = planStructureTiles(g, 'order');
    const s = await decodeStructure(encodeMcstructureTile(g, tile!).bytes);

    const at = (i: number) => s.palette[s.layers[0]![i]!]!.name;
    expect(at(0)).toBe('minecraft:white_concrete');
    expect(at(6)).toBe('minecraft:red_concrete');
    expect(at(23)).toBe('minecraft:black_concrete');
    // Everything else is air — placing the structure clears its own box rather
    // than leaving terrain inside the model.
    expect(at(1)).toBe('minecraft:air');
    expect(s.layers[0]).toHaveLength(24);
  });

  it('reproduces every cell of an asymmetric grid', async () => {
    // Distinct block per cell, so ANY index permutation shows up.
    const [w, h, l] = [5, 3, 7];
    const colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink'];
    const g = new BlockGrid(w, h, l);
    const expected = new Map<string, string>();
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < l; z++) {
      const block = `minecraft:${colors[(x * 3 + y * 5 + z * 7) % colors.length]}_concrete`;
      g.set(x, y, z, block);
      expected.set(`${x},${y},${z}`, block);
    }
    const [tile] = planStructureTiles(g, 'dense');
    const s = await decodeStructure(encodeMcstructureTile(g, tile!).bytes);

    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < l; z++) {
      const idx = x * (h * l) + y * l + z;
      expect(s.palette[s.layers[0]![idx]!]!.name, `${x},${y},${z}`)
        .toBe(expected.get(`${x},${y},${z}`));
    }
  });
});

describe('block states in the encoded file', () => {
  it('writes each state with the NBT type Bedrock expects', async () => {
    const g = new BlockGrid(4, 1, 1);
    g.set(0, 0, 0, 'minecraft:oak_stairs[facing=south,half=top,shape=straight]');
    g.set(1, 0, 0, 'minecraft:sandstone_slab[type=top]');
    g.set(2, 0, 0, 'minecraft:ladder[facing=east,waterlogged=false]');
    g.set(3, 0, 0, 'minecraft:lantern[hanging=true,waterlogged=false]');
    const [tile] = planStructureTiles(g, 'states');
    const s = await decodeStructure(encodeMcstructureTile(g, tile!).bytes);

    const byName = new Map(s.palette.map(p => [p.name, p]));
    const stairs = byName.get('minecraft:oak_stairs')!;
    // An int written as a byte (or vice versa) makes the permutation
    // unresolvable and the block falls back to its default orientation.
    expect(stairs.states['weirdo_direction']).toEqual({ type: 'int', value: 2 });
    expect(stairs.states['upside_down_bit']).toEqual({ type: 'byte', value: 1 });

    expect(byName.get('minecraft:sandstone_slab')!.states['minecraft:vertical_half'])
      .toEqual({ type: 'string', value: 'top' });
    expect(byName.get('minecraft:ladder')!.states['facing_direction'])
      .toEqual({ type: 'int', value: 5 });
    expect(byName.get('minecraft:lantern')!.states['hanging'])
      .toEqual({ type: 'byte', value: 1 });
  });
});

describe('tiling to Bedrock\'s structure limit', () => {
  it('keeps a small model as one structure', () => {
    const g = new BlockGrid(10, 10, 10);
    g.set(5, 5, 5, 'minecraft:stone');
    const tiles = planStructureTiles(g, 'small');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.name).toBe('small');        // no grid suffix on a single tile
  });

  it('never exceeds 64x384x64', () => {
    const g = new BlockGrid(200, 40, 150);
    for (let x = 0; x < 200; x += 3) for (let z = 0; z < 150; z += 3) g.set(x, 10, z, 'minecraft:stone');
    for (const t of planStructureTiles(g, 'big')) {
      expect(t.width).toBeLessThanOrEqual(BEDROCK_MAX_TILE.x);
      expect(t.height).toBeLessThanOrEqual(BEDROCK_MAX_TILE.y);
      expect(t.length).toBeLessThanOrEqual(BEDROCK_MAX_TILE.z);
    }
  });

  it('drops empty tiles and trims the rest to their contents', () => {
    // Blocks only in the far corner: one tile, trimmed tight, not 8 tiles of air.
    const g = new BlockGrid(130, 20, 130);
    g.set(128, 15, 129, 'minecraft:stone');
    g.set(129, 16, 129, 'minecraft:stone');
    const tiles = planStructureTiles(g, 't', { x: 64, y: 384, z: 64 });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({
      x: 128, y: 15, z: 129, width: 2, height: 2, length: 1, nonAir: 2,
    });
  });

  it('reassembles from the tiles cell for cell', async () => {
    // The real round trip: split, encode each piece, decode each piece with the
    // third-party reader, and rebuild the grid from the recorded offsets.
    const [w, h, l] = [40, 12, 35];
    const g = new BlockGrid(w, h, l);
    const expected = new Map<string, string>();
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) for (let z = 0; z < l; z++) {
      // A hollow-ish shape so tiles differ in occupancy and trimming bites.
      if ((x + y + z) % 4 !== 0) continue;
      const block = y < 6 ? 'minecraft:stone' : 'minecraft:oak_planks';
      g.set(x, y, z, block);
      expected.set(`${x},${y},${z}`, block);
    }
    // A deliberately small tile cap so this exercises multi-tile assembly.
    const tiles = planStructureTiles(g, 'reasm', { x: 16, y: 8, z: 16 });
    expect(tiles.length).toBeGreaterThan(8);

    const rebuilt = new Map<string, string>();
    for (const tile of tiles) {
      const s = await decodeStructure(encodeMcstructureTile(g, tile).bytes);
      expect(s.size).toEqual([tile.width, tile.height, tile.length]);
      for (let dx = 0; dx < tile.width; dx++) {
        for (let dy = 0; dy < tile.height; dy++) {
          for (let dz = 0; dz < tile.length; dz++) {
            const idx = dx * (tile.height * tile.length) + dy * tile.length + dz;
            const name = s.palette[s.layers[0]![idx]!]!.name;
            if (name === 'minecraft:air') continue;
            rebuilt.set(`${tile.x + dx},${tile.y + dy},${tile.z + dz}`, name);
          }
        }
      }
    }
    expect(rebuilt.size).toBe(expected.size);
    for (const [pos, block] of expected) expect(rebuilt.get(pos), pos).toBe(block);
  });
});

describe('.mcpack', () => {
  const smallGrid = () => {
    const g = new BlockGrid(6, 4, 6);
    for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) g.set(x, 0, z, 'minecraft:white_concrete');
    g.set(3, 1, 3, 'minecraft:oak_stairs[facing=west,half=bottom,shape=straight]');
    return g;
  };

  it('is a zip with the manifest at the ROOT and structures under a namespace', async () => {
    const pack = await buildMcpack(smallGrid(), { stem: 'Colosseum-10276', label: 'Colosseum (10276)' });
    const entries = listZipEntries(pack.bytes.buffer.slice(
      pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer);

    // Minecraft requires exactly one manifest.json at the pack root — not in a
    // subfolder, which is the classic reason a .mcpack "does nothing".
    expect(entries).toContain('manifest.json');
    // An explicit namespace folder: a file placed directly in structures/ would
    // silently become `mystructure:<name>` instead.
    expect(entries).toContain(`structures/${PACK_NAMESPACE}/colosseum_10276.mcstructure`);
    expect(entries).toContain(`functions/${PACK_NAMESPACE}/colosseum_10276.mcfunction`);
    expect(entries).toContain(`functions/${pack.shortCommand.replace('/function ', '')}.mcfunction`);
    expect(entries).toContain('items/colosseum_10276_brick_wand.json');
    expect(entries).toContain('scripts/placement.js');
    expect(entries).toContain('README.txt');
    for (const e of entries) expect(e).not.toContain('\\');   // zip paths use /
  });

  it('declares a valid behavior-pack manifest', async () => {
    const pack = await buildMcpack(smallGrid(), { stem: 'Colosseum-10276', label: 'Colosseum (10276)' });
    const buf = pack.bytes.buffer.slice(
      pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const manifest = JSON.parse(new TextDecoder().decode(await extractFile(buf, 'manifest.json')));

    expect(manifest.format_version).toBe(2);
    expect(manifest.header.name).toBe('Colosseum (10276)');
    expect(manifest.header.version[0]).toBeGreaterThanOrEqual(2);
    expect(manifest.header.version).toEqual(manifest.modules[0].version);
    // Pinned to the oldest release that has every id we emit.
    expect(manifest.header.min_engine_version).toEqual([1, 26, 40]);
    // Structures/functions/items are data; the Brick Wand UI is a script.
    expect(manifest.modules).toHaveLength(2);
    expect(manifest.modules[0].type).toBe('data');
    expect(manifest.modules[1].type).toBe('script');
    expect(manifest.dependencies).toEqual([
      { module_name: '@minecraft/server', version: '2.9.0' },
      { module_name: '@minecraft/server-ui', version: '2.1.0' },
    ]);
    // Canonical UUID shape, and header/module must differ (manifest validation).
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(manifest.header.uuid).toMatch(uuidRe);
    expect(manifest.modules[0].uuid).toMatch(uuidRe);
    expect(manifest.header.uuid).not.toBe(manifest.modules[0].uuid);
  });

  it('ships a Brick Wand grant function while runtime metadata keeps every tile offset', async () => {
    const g = new BlockGrid(100, 10, 30);
    for (let x = 0; x < 100; x += 2) g.set(x, 4, 15, 'minecraft:stone');
    const pack = await buildMcpack(g, { stem: 'Wide-1' });
    expect(pack.tiles.length).toBeGreaterThan(1);

    const buf = pack.bytes.buffer.slice(
      pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const fn = new TextDecoder().decode(
      await extractFile(buf, `functions/${PACK_NAMESPACE}/wide_1.mcfunction`));

    expect(fn).toContain(`give @s ${pack.itemId} 1`);
    expect(fn).not.toContain('structure load');
    expect(pack.functionCommand).toBe(pack.shortCommand);
    expect(pack.shortCommand).toMatch(/^\/function b_[0-9a-f]{6}$/);

    const script = new TextDecoder().decode(await extractFile(buf, 'scripts/placement.js'));
    for (const t of pack.tiles) expect(script).toContain(JSON.stringify(t.identifier));
    expect(script).toContain('a miniature appears in front of you; the full-size boundary marks placement');
    expect(script).toContain('structure load ${t.identifier}');
  });

  it('refuses an empty model instead of shipping a pack that does nothing', async () => {
    await expect(buildMcpack(new BlockGrid(4, 4, 4), { stem: 'empty' }))
      .rejects.toThrow(/no blocks/i);
  });

  it('reports blocks with no Bedrock equivalent instead of hiding them', async () => {
    const g = new BlockGrid(2, 1, 1);
    g.set(0, 0, 0, 'minecraft:white_concrete');
    g.set(1, 0, 0, 'minecraft:totally_made_up_block');
    const pack = await buildMcpack(g, { stem: 'gap' });
    expect(pack.unmapped).toEqual(['minecraft:totally_made_up_block']);
    const buf = pack.bytes.buffer.slice(
      pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const readme = new TextDecoder().decode(await extractFile(buf, 'README.txt'));
    expect(readme).toContain('minecraft:totally_made_up_block');
  });
});

describe('pack identity', () => {
  it('orders compact export versions across component boundaries', () => {
    const epoch = Date.UTC(2026, 0, 1), second = 1_000, radix = 32_768;
    const versions = [
      exportVersion(epoch - 1),
      exportVersion(epoch),
      exportVersion(epoch + (radix - 1) * second),
      exportVersion(epoch + radix * second),
      exportVersion(epoch + (radix * radix - 1) * second),
      exportVersion(epoch + radix * radix * second),
    ];
    expect(versions).toEqual([
      [2, 0, 0], [2, 0, 0], [2, 0, 32_767],
      [2, 1, 0], [2, 32_767, 32_767], [3, 0, 0],
    ]);
    expect(versions.every(version => version.every(part => Number.isInteger(part) && part >= 0 && part <= 32_767))).toBe(true);
    const ordered = versions.slice(1).map(version => version[0] * radix * radix + version[1] * radix + version[2]);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(() => exportVersion(Number.NaN)).toThrow('finite');
  });

  it('is deterministic — the same set re-exports as the same pack', () => {
    const a = deterministicUuid('craftmatic.pack.header:Colosseum-10276');
    const b = deterministicUuid('craftmatic.pack.header:Colosseum-10276');
    expect(a).toBe(b);
  });

  it('differs per set, so two models do not overwrite each other', () => {
    const seen = new Set<string>();
    for (const stem of ['Colosseum-10276', 'Hogwarts-71043', 'Rivendell-10316', 'TreeHouse-21318']) {
      for (const salt of ['craftmatic.pack.header:', 'craftmatic.pack.module:']) {
        seen.add(deterministicUuid(salt + stem));
      }
    }
    expect(seen.size).toBe(8);
  });

  it('reduces a filename stem to a legal Bedrock identifier', () => {
    expect(toBedrockIdentifier('Colosseum-10276')).toBe('colosseum_10276');
    expect(toBedrockIdentifier('R2D2-75308')).toBe('r2d2_75308');
    expect(toBedrockIdentifier('!!!')).toBe('model');
    expect(toBedrockIdentifier('Tree House 21318-2')).toBe('tree_house_21318_2');
  });
});
