import { describe, it, expect } from 'vitest';
import { encodeVarint, decodeVarint, decodeAllVarints } from '../src/schem/varint.js';

describe('varint', () => {
  it('encodes single-byte values', () => {
    expect(encodeVarint(0)).toEqual([0]);
    expect(encodeVarint(1)).toEqual([1]);
    expect(encodeVarint(127)).toEqual([127]);
  });

  it('encodes multi-byte values', () => {
    expect(encodeVarint(128)).toEqual([0x80, 0x01]);
    expect(encodeVarint(255)).toEqual([0xff, 0x01]);
    expect(encodeVarint(300)).toEqual([0xac, 0x02]);
  });

  it('decodes single-byte values', () => {
    const buf = new Uint8Array([42]);
    const [value, bytesRead] = decodeVarint(buf, 0);
    expect(value).toBe(42);
    expect(bytesRead).toBe(1);
  });

  it('decodes multi-byte values', () => {
    const buf = new Uint8Array([0x80, 0x01]);
    const [value, bytesRead] = decodeVarint(buf, 0);
    expect(value).toBe(128);
    expect(bytesRead).toBe(2);
  });

  it('roundtrips arbitrary values', () => {
    for (const val of [0, 1, 127, 128, 255, 300, 1000, 16383, 16384]) {
      const encoded = encodeVarint(val);
      const buf = new Uint8Array(encoded);
      const [decoded] = decodeVarint(buf, 0);
      expect(decoded).toBe(val);
    }
  });

  it('decodes all varints from a buffer', () => {
    // Encode [0, 1, 128, 300] into a single buffer
    const bytes = [...encodeVarint(0), ...encodeVarint(1), ...encodeVarint(128), ...encodeVarint(300)];
    const buf = new Uint8Array(bytes);
    const result = decodeAllVarints(buf, 4);
    expect(result).toEqual([0, 1, 128, 300]);
  });
});
