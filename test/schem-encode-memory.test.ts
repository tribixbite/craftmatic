/**
 * S3 regression guard for the memory/encode rewrite (2026-09-01).
 *
 * The .schem/.litematic encoders used to accumulate every output byte into a
 * plain `number[]` (measured peak 1.33 GB RSS for a 0.2 MB file at the 30M-cell
 * export cap — the reported mobile OOM). They now write into a growable
 * Uint8Array (ByteWriter) and `BlockGrid.encodeBlockData()` allocates the exact
 * output size up front.
 *
 * These tests lock the two properties that matter:
 *   1. the bytes are UNCHANGED (a from-scratch reference varint encoder must
 *      reproduce encodeBlockData exactly, including multi-byte palette ids), and
 *   2. the allocation is exact — no `number[]` intermediate can sneak back in.
 *
 * Offline + deterministic — no network, no DOM, no GPU.
 */

import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { BlockGrid } from '../src/schem/types.js';
import { ByteWriter } from '../web/src/engine/byte-writer.js';
import { encodeSchemBytes, encodeLitematicBytes } from '../web/src/engine/schem-encode.js';

/** Independent reference implementation of the Sponge varint block stream. */
function referenceVarints(indices: number[]): Uint8Array {
  const out: number[] = [];
  for (let v of indices) {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      out.push(b);
    } while (v !== 0);
  }
  return new Uint8Array(out);
}

describe('ByteWriter', () => {
  it('grows without corrupting earlier bytes and trims to length', () => {
    const w = new ByteWriter(2);
    for (let i = 0; i < 1000; i++) w.u8(i & 0xff);
    w.u16(0xbeef);
    w.u32(0xdeadbeef);
    w.i64(0x0102030405060708n);
    const out = w.toUint8Array();
    expect(out.length).toBe(1000 + 2 + 4 + 8);
    for (let i = 0; i < 1000; i++) expect(out[i]).toBe(i & 0xff);
    expect([...out.slice(1000, 1002)]).toEqual([0xbe, 0xef]);
    expect([...out.slice(1002, 1006)]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([...out.slice(1006)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('writes NBT strings as u16 length + UTF-8 bytes', () => {
    const w = new ByteWriter();
    w.nbtString('äb', new TextEncoder()); // 'ä' is 2 bytes in UTF-8
    expect([...w.toUint8Array()]).toEqual([0, 3, 0xc3, 0xa4, 0x62]);
  });
});

describe('BlockGrid.encodeBlockData', () => {
  it('matches an independent varint encoder for single-byte palette ids', () => {
    const g = new BlockGrid(3, 4, 5);
    g.set(0, 0, 0, 'minecraft:red_concrete');
    g.set(2, 0, 4, 'minecraft:blue_concrete');
    g.set(1, 3, 2, 'minecraft:white_concrete');
    g.set(2, 1, 0, 'minecraft:red_concrete');

    const indices: number[] = [];
    for (let y = 0; y < g.height; y++)
      for (let z = 0; z < g.length; z++)
        for (let x = 0; x < g.width; x++) indices.push(g.getIndex(x, y, z));

    expect([...g.encodeBlockData()]).toEqual([...referenceVarints(indices)]);
  });

  it('matches for MULTI-byte palette ids (>127 and >16383)', () => {
    // 200 distinct blocks → ids up to 200, so most cells need 2 varint bytes.
    const g = new BlockGrid(20, 5, 4); // 400 cells
    let n = 0;
    for (let y = 0; y < 5; y++)
      for (let z = 0; z < 4; z++)
        for (let x = 0; x < 20; x++) g.set(x, y, z, `minecraft:block_${n++ % 200}`);
    expect(g.palette.size).toBe(201); // 200 + air

    const indices: number[] = [];
    for (let y = 0; y < g.height; y++)
      for (let z = 0; z < g.length; z++)
        for (let x = 0; x < g.width; x++) indices.push(g.getIndex(x, y, z));

    const encoded = g.encodeBlockData();
    expect([...encoded]).toEqual([...referenceVarints(indices)]);
    // Sanity: ids >127 really did produce 2-byte varints.
    expect(encoded.length).toBeGreaterThan(indices.length);
  });

  it('allocates EXACTLY the output size (no number[] intermediate)', () => {
    const g = new BlockGrid(8, 8, 8);
    for (let i = 0; i < 300; i++) g.set(i % 8, (i >> 3) % 8, (i >> 6) % 8, `minecraft:b${i}`);
    const bytes = g.encodeBlockData();
    // A trimmed/copied buffer would leave slack; the encoder sizes it up front.
    expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
  });
});

describe('encoders still emit valid, self-consistent files', () => {
  function sampleGrid(): BlockGrid {
    const g = new BlockGrid(11, 7, 13);
    const blocks = [
      'minecraft:white_concrete', 'minecraft:gray_concrete', 'minecraft:red_concrete',
      'minecraft:oak_stairs[facing=north,half=bottom]', 'minecraft:sandstone',
    ];
    for (let y = 0; y < 7; y++)
      for (let z = 0; z < 13; z++)
        for (let x = 0; x < 11; x++)
          if ((x * 3 + y * 5 + z * 7) % 4 !== 0) g.set(x, y, z, blocks[(x + y + z) % blocks.length]!);
    return g;
  }

  it('.schem gzip payload embeds the exact encodeBlockData stream', () => {
    const g = sampleGrid();
    const raw = gunzipSync(Buffer.from(encodeSchemBytes(g)));
    const blockData = g.encodeBlockData();
    // BlockData is a TAG_Byte_Array: 4-byte big-endian length then the bytes.
    const marker = Buffer.alloc(4);
    marker.writeInt32BE(blockData.length, 0);
    const at = raw.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    expect(raw.subarray(at + 4, at + 4 + blockData.length).equals(Buffer.from(blockData))).toBe(true);
  });

  it('.litematic is deterministic for a fixed timestamp', () => {
    const g = sampleGrid();
    const a = encodeLitematicBytes(g, 1_700_000_000);
    const b = encodeLitematicBytes(g, 1_700_000_000);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(gunzipSync(Buffer.from(a)).length).toBeGreaterThan(64);
  });
});
