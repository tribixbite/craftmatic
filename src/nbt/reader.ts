/**
 * NBT binary reader for parsing .schem files.
 * Uses prismarine-nbt as the primary parsing engine for robustness,
 * with a lightweight fallback for simple operations.
 */

import { parse as parseNbt } from 'prismarine-nbt';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/** Parsed NBT tag value types */
export type NBTValue =
  | number
  | bigint
  | string
  | Uint8Array
  | Int32Array
  | NBTValue[]
  | NBTCompound;

export interface NBTCompound {
  [key: string]: { type: string; value: NBTValue };
}

/**
 * Parse an NBT file (gzip-compressed or raw) into a JS object.
 * Returns the parsed root compound tag.
 */
export async function parseNBTFile(filepath: string): Promise<NBTCompound> {
  const raw = readFileSync(filepath);

  // Decompress if gzipped (first two bytes are 0x1f 0x8b)
  let data: Buffer;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    data = gunzipSync(raw);
  } else {
    data = Buffer.from(raw);
  }

  const result = await parseNbt(data);
  return result.parsed as unknown as NBTCompound;
}

/**
 * Parse raw NBT buffer (already decompressed) into a JS object.
 */
export async function parseNBTBuffer(data: Buffer): Promise<NBTCompound> {
  const result = await parseNbt(data);
  return result.parsed as unknown as NBTCompound;
}

/**
 * Helper to extract a typed value from an NBT compound.
 * Handles prismarine-nbt's { type, value } wrapper format.
 */
export function getNBTValue<T>(compound: NBTCompound, key: string): T | undefined {
  const entry = compound[key];
  if (!entry) return undefined;
  return entry.value as T;
}

/**
 * Read and decompress a .schem file, returning the raw buffer.
 */
export function readSchemFile(filepath: string): Buffer {
  const raw = readFileSync(filepath);
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    return gunzipSync(raw);
  }
  return Buffer.from(raw);
}
