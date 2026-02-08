import { describe, it, expect } from 'vitest';
import { NBTWriter, TAG } from '../src/nbt/writer.js';

describe('NBTWriter', () => {
  it('writes a compound with a string tag', () => {
    const w = new NBTWriter();
    // Root compound
    w.writeTagHeader(TAG.COMPOUND, '');
    // String tag inside
    w.writeTagHeader(TAG.STRING, 'hello');
    w.writeString('world');
    // End compound
    w.writeEnd();

    const bytes = w.getBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // NBT compound starts with tag type 10
    expect(bytes[0]).toBe(10);
  });

  it('writes numeric types', () => {
    const w = new NBTWriter();
    w.writeTagHeader(TAG.COMPOUND, '');
    w.writeTagHeader(TAG.BYTE, 'b');
    w.writeByte(42);
    w.writeTagHeader(TAG.SHORT, 's');
    w.writeShort(1000);
    w.writeTagHeader(TAG.INT, 'i');
    w.writeInt(100000);
    w.writeTagHeader(TAG.LONG, 'l');
    w.writeLong(BigInt(1234567890));
    w.writeEnd();

    const bytes = w.getBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(20);
  });

  it('writes byte arrays', () => {
    const w = new NBTWriter();
    w.writeTagHeader(TAG.COMPOUND, '');
    w.writeTagHeader(TAG.BYTE_ARRAY, 'data');
    w.writeByteArray(new Uint8Array([1, 2, 3, 4, 5]));
    w.writeEnd();

    const bytes = w.getBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('writes int arrays', () => {
    const w = new NBTWriter();
    w.writeTagHeader(TAG.COMPOUND, '');
    w.writeTagHeader(TAG.INT_ARRAY, 'offsets');
    w.writeIntArray([10, 20, 30]);
    w.writeEnd();

    const bytes = w.getBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('writes nested compounds', () => {
    const w = new NBTWriter();
    w.writeTagHeader(TAG.COMPOUND, '');
    w.writeTagHeader(TAG.COMPOUND, 'nested');
    w.writeTagHeader(TAG.STRING, 'key');
    w.writeString('value');
    w.writeEnd(); // end nested
    w.writeEnd(); // end root

    const bytes = w.getBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    // Should start with compound (10) and contain nested compound
    expect(bytes[0]).toBe(10);
  });

  it('tracks size correctly', () => {
    const w = new NBTWriter();
    expect(w.size).toBe(0);
    w.writeByte(1);
    expect(w.size).toBe(1);
    w.writeShort(100);
    expect(w.size).toBe(3);
    w.writeInt(1000);
    expect(w.size).toBe(7);
  });
});
