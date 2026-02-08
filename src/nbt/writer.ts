/**
 * NBT binary writer for Sponge Schematic v2 format.
 * Writes Big Endian NBT data compatible with Minecraft Java Edition.
 */

/** NBT tag type constants */
export const TAG = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
  LONG_ARRAY: 12,
} as const;

export type TagType = (typeof TAG)[keyof typeof TAG];

export class NBTWriter {
  private buf: number[];

  constructor() {
    this.buf = [];
  }

  /** Write a single byte (signed) */
  writeByte(v: number): void {
    // Convert to unsigned byte representation
    this.buf.push(v & 0xff);
  }

  /** Write a 16-bit big-endian signed short */
  writeShort(v: number): void {
    this.buf.push((v >> 8) & 0xff, v & 0xff);
  }

  /** Write a 32-bit big-endian signed int */
  writeInt(v: number): void {
    this.buf.push(
      (v >> 24) & 0xff,
      (v >> 16) & 0xff,
      (v >> 8) & 0xff,
      v & 0xff
    );
  }

  /** Write a 64-bit big-endian signed long (as two 32-bit halves) */
  writeLong(v: bigint): void {
    const hi = Number((v >> 32n) & 0xffffffffn);
    const lo = Number(v & 0xffffffffn);
    this.writeInt(hi);
    this.writeInt(lo);
  }

  /** Write a 32-bit big-endian float */
  writeFloat(v: number): void {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, false); // big endian
    for (let i = 0; i < 4; i++) this.buf.push(dv.getUint8(i));
  }

  /** Write a 64-bit big-endian double */
  writeDouble(v: number): void {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, false); // big endian
    for (let i = 0; i < 8; i++) this.buf.push(dv.getUint8(i));
  }

  /** Write a UTF-8 string (length-prefixed with short) */
  writeString(s: string): void {
    const encoded = new TextEncoder().encode(s);
    this.writeShort(encoded.length);
    for (const b of encoded) this.buf.push(b);
  }

  /** Write a tag header (tag type byte + name string) */
  writeTagHeader(tagType: TagType, name: string): void {
    this.writeByte(tagType);
    this.writeString(name);
  }

  /** Write a byte array (length-prefixed with int) */
  writeByteArray(data: Uint8Array | number[]): void {
    this.writeInt(data.length);
    for (const b of data) this.buf.push(b & 0xff);
  }

  /** Write an int array (length-prefixed with int) */
  writeIntArray(data: number[]): void {
    this.writeInt(data.length);
    for (const v of data) this.writeInt(v);
  }

  /** Write TAG_END (0) */
  writeEnd(): void {
    this.writeByte(TAG.END);
  }

  /** Get the accumulated bytes as a Uint8Array */
  getBytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }

  /** Get current buffer size in bytes */
  get size(): number {
    return this.buf.length;
  }
}
