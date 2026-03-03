/**
 * Shared Litematica encode utilities — pure math, zero platform deps.
 * Reverse of litematic-decode.ts. Encodes palette indices into bit-packed
 * LongArray format and decomposes block state strings into name + properties.
 */

import { calcBitsPerEntry } from './litematic-decode.js';

/**
 * Encode palette indices into a bit-packed BigInt64Array (Litematica format).
 *
 * Reverse of decodeBitPackedStates. Each entry uses `bitsPerEntry` bits,
 * starting at bit `i * bitsPerEntry`. Entries may span two 64-bit longs.
 *
 * @param indices      Array of palette indices (0-based)
 * @param bitsPerEntry Bits per palette index (use calcBitsPerEntry)
 * @returns Packed BigInt64Array suitable for NBT LongArray
 */
export function encodeBitPackedStates(
  indices: number[],
  bitsPerEntry: number,
): BigInt64Array {
  const totalBits = indices.length * bitsPerEntry;
  const longCount = Math.ceil(totalBits / 64);
  const longs = new BigInt64Array(longCount);
  const mask = (1n << BigInt(bitsPerEntry)) - 1n;

  for (let i = 0; i < indices.length; i++) {
    const value = BigInt(indices[i]) & mask;
    const bitIndex = i * bitsPerEntry;
    const longIndex = Math.floor(bitIndex / 64);
    const bitOffset = bitIndex % 64;

    // Write bits into the current long
    longs[longIndex] |= value << BigInt(bitOffset);

    // If entry spans two longs, write remaining bits into the next long
    if (bitOffset + bitsPerEntry > 64 && longIndex + 1 < longCount) {
      const bitsWritten = 64 - bitOffset;
      longs[longIndex + 1] |= value >> BigInt(bitsWritten);
    }
  }

  return longs;
}

/**
 * Decompose a full Minecraft block state string into name + properties.
 * Reverse of reconstructBlockState from litematic-decode.ts.
 *
 * Examples:
 *   "minecraft:stone" → { name: "minecraft:stone", properties: undefined }
 *   "minecraft:oak_stairs[facing=north,half=bottom]"
 *     → { name: "minecraft:oak_stairs", properties: { facing: "north", half: "bottom" } }
 *
 * @param blockState Full block state string
 * @returns Decomposed name and optional properties map
 */
export function decomposeBlockState(
  blockState: string,
): { name: string; properties: Record<string, string> | undefined } {
  const bracketIdx = blockState.indexOf('[');
  if (bracketIdx === -1) {
    return { name: blockState, properties: undefined };
  }

  const name = blockState.slice(0, bracketIdx);
  // Extract between [ and ] (strip trailing ] if present)
  const propsStr = blockState.slice(bracketIdx + 1, blockState.endsWith(']') ? -1 : undefined);
  if (!propsStr) {
    return { name, properties: undefined };
  }

  const properties: Record<string, string> = {};
  for (const pair of propsStr.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      properties[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }

  return { name, properties: Object.keys(properties).length > 0 ? properties : undefined };
}

export { calcBitsPerEntry };
