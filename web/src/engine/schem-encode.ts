/**
 * .schem / .litematic byte encoders — pure data, no THREE and no DOM, so the
 * export Web Worker (engine/schem-worker.ts) can import them without pulling
 * the whole viewer bundle in.
 *
 * Byte sinks are growable Uint8Arrays (ByteWriter) rather than per-byte
 * `number[]`s: at the 30M-cell export cap the old accumulation peaked at
 * 1.33 GB RSS for a 0.2 MB output file (the reported mobile OOM). Output bytes
 * are unchanged — see test/schem-export.test.ts and the S3 byte-identity gate.
 */

import pako from 'pako';
import type { BlockGrid } from '@craft/schem/types.js';
import { encodeBitPackedStates, decomposeBlockState, calcBitsPerEntry } from '@craft/schem/litematic-encode.js';
import { ByteWriter } from './byte-writer.js';

/**
 * Encode a BlockGrid as gzipped .schem bytes (no file download).
 *
 * Assembled through a growable Uint8Array (ByteWriter) rather than a
 * per-byte `number[]` — see byte-writer.ts for the measured memory reason.
 * Output bytes are unchanged.
 */
export function encodeSchemBytes(grid: BlockGrid): Uint8Array {
  // Reuse exportSchem logic but return bytes instead of triggering download
  const { width, height, length } = grid;
  const palette = grid.palette;
  const paletteEntries: Array<[string, number]> = [];
  for (const [blockState, id] of palette) paletteEntries.push([blockState, id]);
  const blockData = grid.encodeBlockData();
  const parts = new ByteWriter(blockData.length + 4096);
  const enc = new TextEncoder();
  const wb = (v: number) => { parts.u8(v); };
  const ws = (v: number) => { parts.u16(v); };
  const wi = (v: number) => { parts.u32(v); };
  const wstr = (s: string) => { parts.nbtString(s, enc); };
  const wba = (a: Uint8Array) => { wi(a.length); parts.bytes(a); };

  wb(10); wstr('Schematic');
  wb(3); wstr('Version'); wi(2);
  wb(3); wstr('DataVersion'); wi(3700);
  wb(2); wstr('Width'); ws(width);
  wb(2); wstr('Height'); ws(height);
  wb(2); wstr('Length'); ws(length);
  wb(10); wstr('Palette');
  for (const [bs, id] of paletteEntries) { wb(3); wstr(bs); wi(id); }
  wb(0); // end palette
  wb(3); wstr('PaletteMax'); wi(paletteEntries.length);
  wb(7); wstr('BlockData'); wba(blockData);
  wb(10); wstr('Metadata');
  wb(3); wstr('WEOffsetX'); wi(0);
  wb(3); wstr('WEOffsetY'); wi(0);
  wb(3); wstr('WEOffsetZ'); wi(0);
  wb(0); // end metadata
  wb(11); wstr('Offset'); wi(3); wi(0); wi(0); wi(0);
  wb(9); wstr('BlockEntities'); wb(10); wi(0);
  wb(0); // end root

  return pako.gzip(parts.toUint8Array());
}

/**
 * Encode a BlockGrid as gzipped .litematic bytes (no file download).
 *
 * Same NBT layout as before; the byte sink is a growable Uint8Array and the
 * per-cell palette indices live in a Uint16Array instead of a `number[]`
 * (30M-cell exports allocated ~240 MB for that array alone).
 */
export function encodeLitematicBytes(grid: BlockGrid, timestampSec?: number): Uint8Array {
  const { width, height, length } = grid;
  const nonAirCount = grid.countNonAir();
  const totalVolume = width * height * length;
  const timestamp = BigInt(timestampSec ?? Math.floor(Date.now() / 1000));
  const regionName = 'craftmatic';

  // Build inline NBT (same pattern as exportSchem — raw binary, no server deps)
  const parts = new ByteWriter(totalVolume + 4096);
  const encoder = new TextEncoder();

  function writeByte(v: number) { parts.u8(v); }
  function writeInt(v: number) { parts.u32(v); }
  function writeLong(v: bigint) { parts.i64(v); }
  function writeString(s: string) { parts.nbtString(s, encoder); }
  function writeTagHeader(tagType: number, name: string) {
    writeByte(tagType);
    writeString(name);
  }
  function writeEnd() { writeByte(0); }

  // NBT tag type constants (TAG_BYTE omitted — unused by this writer)
  const TAG_INT = 3, TAG_LONG = 4, TAG_STRING = 8;
  const TAG_LIST = 9, TAG_COMPOUND = 10, TAG_LONG_ARRAY = 12;

  // Root compound
  writeTagHeader(TAG_COMPOUND, '');

  // MinecraftDataVersion + Version
  writeTagHeader(TAG_INT, 'MinecraftDataVersion'); writeInt(3700);
  writeTagHeader(TAG_INT, 'Version'); writeInt(5);

  // Metadata
  writeTagHeader(TAG_COMPOUND, 'Metadata');
  writeTagHeader(TAG_STRING, 'Name'); writeString(regionName);
  writeTagHeader(TAG_STRING, 'Author'); writeString('craftmatic');
  writeTagHeader(TAG_STRING, 'Description'); writeString('');
  writeTagHeader(TAG_INT, 'RegionCount'); writeInt(1);
  writeTagHeader(TAG_LONG, 'TimeCreated'); writeLong(timestamp);
  writeTagHeader(TAG_LONG, 'TimeModified'); writeLong(timestamp);
  writeTagHeader(TAG_INT, 'TotalBlocks'); writeInt(nonAirCount);
  writeTagHeader(TAG_INT, 'TotalVolume'); writeInt(totalVolume);
  writeTagHeader(TAG_COMPOUND, 'EnclosingSize');
  writeTagHeader(TAG_INT, 'x'); writeInt(width);
  writeTagHeader(TAG_INT, 'y'); writeInt(height);
  writeTagHeader(TAG_INT, 'z'); writeInt(length);
  writeEnd(); // EnclosingSize
  writeEnd(); // Metadata

  // Regions
  writeTagHeader(TAG_COMPOUND, 'Regions');
  writeTagHeader(TAG_COMPOUND, regionName);

  // Position + Size
  writeTagHeader(TAG_COMPOUND, 'Position');
  writeTagHeader(TAG_INT, 'x'); writeInt(0);
  writeTagHeader(TAG_INT, 'y'); writeInt(0);
  writeTagHeader(TAG_INT, 'z'); writeInt(0);
  writeEnd();
  writeTagHeader(TAG_COMPOUND, 'Size');
  writeTagHeader(TAG_INT, 'x'); writeInt(width);
  writeTagHeader(TAG_INT, 'y'); writeInt(height);
  writeTagHeader(TAG_INT, 'z'); writeInt(length);
  writeEnd();

  // Build palette (air at index 0) and collect indices in Litematica XZY order
  const paletteMap = new Map<string, number>();
  const paletteList: string[] = [];
  paletteMap.set('minecraft:air', 0);
  paletteList.push('minecraft:air');

  // Grid palette index → litematic palette index (built lazily, same order as
  // the old per-cell string lookup because the XZY traversal order is the same).
  const remap = new Int32Array(grid.palette.size + 1).fill(-1);
  const indices = new Uint16Array(totalVolume);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const gid = grid.getIndex(x, y, z);
        let idx = remap[gid]!;
        if (idx < 0) {
          const bs = grid.blockStateFromIndex(gid);
          const existing = paletteMap.get(bs);
          if (existing === undefined) {
            idx = paletteList.length;
            paletteMap.set(bs, idx);
            paletteList.push(bs);
          } else {
            idx = existing;
          }
          remap[gid] = idx;
        }
        indices[x + z * width + y * width * length] = idx;
      }
    }
  }

  // BlockStatePalette
  writeTagHeader(TAG_LIST, 'BlockStatePalette');
  writeByte(TAG_COMPOUND);
  writeInt(paletteList.length);
  for (const blockState of paletteList) {
    const { name, properties } = decomposeBlockState(blockState);
    writeTagHeader(TAG_STRING, 'Name'); writeString(name);
    if (properties) {
      writeTagHeader(TAG_COMPOUND, 'Properties');
      for (const [key, val] of Object.entries(properties)) {
        writeTagHeader(TAG_STRING, key); writeString(val);
      }
      writeEnd();
    }
    writeEnd(); // palette entry
  }

  // BlockStates (bit-packed LongArray)
  const bitsPerEntry = calcBitsPerEntry(paletteList.length);
  const packed = encodeBitPackedStates(indices, bitsPerEntry);
  writeTagHeader(TAG_LONG_ARRAY, 'BlockStates');
  writeInt(packed.length);
  for (const v of packed) writeLong(v);

  // Empty lists (TileEntities, Entities, PendingBlockTicks, PendingFluidTicks)
  for (const listName of ['TileEntities', 'Entities', 'PendingBlockTicks', 'PendingFluidTicks']) {
    writeTagHeader(TAG_LIST, listName);
    writeByte(TAG_COMPOUND);
    writeInt(0);
  }

  writeEnd(); // region
  writeEnd(); // Regions
  writeEnd(); // root

  return pako.gzip(parts.toUint8Array());
}

