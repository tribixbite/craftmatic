/**
 * Little-endian NBT, as Bedrock writes `.mcstructure` files (uncompressed, no
 * header). Returns plain JavaScript values: compounds are objects, lists and
 * arrays are arrays, longs are bigints. Enough for structures; nothing here
 * writes NBT (web/src/engine/mcstructure-encode.ts does).
 */

export type NbtValue = number | bigint | string | NbtValue[] | { [key: string]: NbtValue } | Int8Array | Int32Array | BigInt64Array;

const TAG = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 } as const;

/** Parse a little-endian NBT document; returns the root compound's value (its name is dropped). */
export function readNbtLE(bytes: Uint8Array): Record<string, NbtValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder();
  let o = 0;
  const str = (): string => { const n = view.getUint16(o, true); o += 2; const s = utf8.decode(bytes.subarray(o, o + n)); o += n; return s; };
  const payload = (tag: number): NbtValue => {
    switch (tag) {
      case TAG.BYTE: { const v = view.getInt8(o); o += 1; return v; }
      case TAG.SHORT: { const v = view.getInt16(o, true); o += 2; return v; }
      case TAG.INT: { const v = view.getInt32(o, true); o += 4; return v; }
      case TAG.LONG: { const v = view.getBigInt64(o, true); o += 8; return v; }
      case TAG.FLOAT: { const v = view.getFloat32(o, true); o += 4; return v; }
      case TAG.DOUBLE: { const v = view.getFloat64(o, true); o += 8; return v; }
      case TAG.BYTE_ARRAY: { const n = view.getInt32(o, true); o += 4; const v = new Int8Array(bytes.buffer.slice(bytes.byteOffset + o, bytes.byteOffset + o + n)); o += n; return v; }
      case TAG.STRING: return str();
      case TAG.LIST: {
        const t = view.getUint8(o); o += 1;
        const n = view.getInt32(o, true); o += 4;
        // Lists of ints are the bulk of a structure (block_indices): read them as a typed array.
        if (t === TAG.INT) { const v = new Int32Array(n); for (let i = 0; i < n; i++, o += 4) v[i] = view.getInt32(o, true); return Array.from(v); }
        const out: NbtValue[] = [];
        for (let i = 0; i < n; i++) out.push(payload(t));
        return out;
      }
      case TAG.COMPOUND: {
        const out: Record<string, NbtValue> = {};
        for (;;) {
          const t = view.getUint8(o); o += 1;
          if (t === TAG.END) return out;
          const name = str();
          out[name] = payload(t);
        }
      }
      case TAG.INT_ARRAY: { const n = view.getInt32(o, true); o += 4; const v = new Int32Array(n); for (let i = 0; i < n; i++, o += 4) v[i] = view.getInt32(o, true); return v; }
      case TAG.LONG_ARRAY: { const n = view.getInt32(o, true); o += 4; const v = new BigInt64Array(n); for (let i = 0; i < n; i++, o += 8) v[i] = view.getBigInt64(o, true); return v; }
      default: throw new Error(`NBT: unknown tag ${tag} at ${o}`);
    }
  };
  const rootTag = view.getUint8(o); o += 1;
  if (rootTag !== TAG.COMPOUND) throw new Error(`NBT: root is tag ${rootTag}, not a compound`);
  str();
  return payload(TAG.COMPOUND) as Record<string, NbtValue>;
}
