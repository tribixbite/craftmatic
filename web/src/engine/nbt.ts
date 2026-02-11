/**
 * Browser-compatible NBT (Named Binary Tag) parser.
 * Reads NBT binary format from ArrayBuffer/Uint8Array.
 * Used for parsing Minecraft .schem files in the browser.
 */

/** NBT tag type IDs */
export const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;

/** NBT value types */
export type NBTValue =
  | number
  | bigint
  | string
  | Uint8Array
  | Int32Array
  | BigInt64Array
  | NBTValue[]
  | NBTCompound;

export interface NBTCompound {
  [key: string]: NBTValue;
}

/** Safety limits for untrusted NBT data */
const MAX_ARRAY_LENGTH = 16 * 1024 * 1024; // 16M elements
const MAX_COMPOUND_DEPTH = 64;

/** Read cursor for tracking position in the byte stream */
class ReadCursor {
  offset = 0;
  depth = 0;
  constructor(readonly view: DataView) {}

  readByte(): number {
    return this.view.getInt8(this.offset++);
  }

  readShort(): number {
    const v = this.view.getInt16(this.offset);
    this.offset += 2;
    return v;
  }

  readInt(): number {
    const v = this.view.getInt32(this.offset);
    this.offset += 4;
    return v;
  }

  readLong(): bigint {
    const v = this.view.getBigInt64(this.offset);
    this.offset += 8;
    return v;
  }

  readFloat(): number {
    const v = this.view.getFloat32(this.offset);
    this.offset += 4;
    return v;
  }

  readDouble(): number {
    const v = this.view.getFloat64(this.offset);
    this.offset += 8;
    return v;
  }

  readString(): string {
    const length = this.view.getUint16(this.offset);
    this.offset += 2;
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return new TextDecoder('utf-8').decode(bytes);
  }

  readByteArray(): Uint8Array {
    const length = this.readInt();
    if (length < 0 || length > MAX_ARRAY_LENGTH) throw new Error(`ByteArray length out of bounds: ${length}`);
    const arr = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return new Uint8Array(arr); // copy to avoid detached buffer issues
  }

  readIntArray(): Int32Array {
    const length = this.readInt();
    if (length < 0 || length > MAX_ARRAY_LENGTH) throw new Error(`IntArray length out of bounds: ${length}`);
    const arr = new Int32Array(length);
    for (let i = 0; i < length; i++) {
      arr[i] = this.readInt();
    }
    return arr;
  }

  readLongArray(): BigInt64Array {
    const length = this.readInt();
    if (length < 0 || length > MAX_ARRAY_LENGTH) throw new Error(`LongArray length out of bounds: ${length}`);
    const arr = new BigInt64Array(length);
    for (let i = 0; i < length; i++) {
      arr[i] = this.readLong();
    }
    return arr;
  }
}

/** Read an NBT value by tag type */
function readTag(cursor: ReadCursor, tagType: number): NBTValue {
  switch (tagType) {
    case TAG.Byte: return cursor.readByte();
    case TAG.Short: return cursor.readShort();
    case TAG.Int: return cursor.readInt();
    case TAG.Long: return cursor.readLong();
    case TAG.Float: return cursor.readFloat();
    case TAG.Double: return cursor.readDouble();
    case TAG.ByteArray: return cursor.readByteArray();
    case TAG.String: return cursor.readString();
    case TAG.List: {
      const itemType = cursor.readByte();
      const length = cursor.readInt();
      if (length < 0 || length > MAX_ARRAY_LENGTH) throw new Error(`List length out of bounds: ${length}`);
      cursor.depth++;
      if (cursor.depth > MAX_COMPOUND_DEPTH) throw new Error('NBT nesting depth exceeded');
      const items: NBTValue[] = [];
      for (let i = 0; i < length; i++) {
        items.push(readTag(cursor, itemType));
      }
      cursor.depth--;
      return items;
    }
    case TAG.Compound: return readCompound(cursor);
    case TAG.IntArray: return cursor.readIntArray();
    case TAG.LongArray: return cursor.readLongArray();
    default: throw new Error(`Unknown NBT tag type: ${tagType}`);
  }
}

/** Read a compound tag (key-value pairs until TAG.End) */
function readCompound(cursor: ReadCursor): NBTCompound {
  cursor.depth++;
  if (cursor.depth > MAX_COMPOUND_DEPTH) throw new Error('NBT nesting depth exceeded');
  const result: NBTCompound = {};
  while (true) {
    const tagType = cursor.readByte();
    if (tagType === TAG.End) break;
    const name = cursor.readString();
    result[name] = readTag(cursor, tagType);
  }
  cursor.depth--;
  return result;
}

/**
 * Parse raw NBT data from an ArrayBuffer or Uint8Array.
 * Returns the root compound tag.
 */
export function parseNBT(data: ArrayBuffer | Uint8Array): { name: string; value: NBTCompound } {
  const buffer = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
  const view = new DataView(buffer);
  const cursor = new ReadCursor(view);

  const rootType = cursor.readByte();
  if (rootType !== TAG.Compound) {
    throw new Error(`Expected root compound tag (10), got ${rootType}`);
  }

  const name = cursor.readString();
  const value = readCompound(cursor);
  return { name, value };
}
