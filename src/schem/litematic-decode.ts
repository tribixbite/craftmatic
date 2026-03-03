/**
 * Shared Litematica decode utilities — pure math, zero platform deps.
 * Importable by both server (prismarine-nbt) and browser (custom nbt.ts).
 *
 * Litematica stores block palette indices as bit-packed entries within a
 * LongArray (BigInt64Array). Each entry uses `bitsPerEntry` bits, and
 * entries can span two longs. This module decodes those packed states
 * and reconstructs full block state strings from palette NBT entries.
 */

/**
 * Decode bit-packed palette indices from a Litematica LongArray.
 *
 * Litematica packing: bitsPerEntry = max(2, ceil(log2(paletteSize))).
 * Entry at linear index `i` starts at bit `i * bitsPerEntry`.
 * Entries may span two 64-bit longs.
 *
 * @param blockStates  The raw LongArray from NBT (BigInt64Array)
 * @param bitsPerEntry Bits per palette index
 * @param totalBlocks  Expected number of blocks (width * height * length)
 * @returns Array of palette indices (0-based)
 */
export function decodeBitPackedStates(
  blockStates: BigInt64Array,
  bitsPerEntry: number,
  totalBlocks: number,
): number[] {
  const result: number[] = new Array(totalBlocks);
  const mask = (1n << BigInt(bitsPerEntry)) - 1n;
  // BigInt64Array stores signed values; >> is arithmetic shift (sign-extends).
  // Convert to unsigned before shifting to avoid corruption when bit 63 is set.
  const U64_MASK = (1n << 64n) - 1n;

  for (let i = 0; i < totalBlocks; i++) {
    const bitIndex = i * bitsPerEntry;
    const longIndex = Math.floor(bitIndex / 64);
    const bitOffset = bitIndex % 64;

    // Convert signed i64 to unsigned before right-shifting
    const unsignedLong = blockStates[longIndex] & U64_MASK;
    let value = (unsignedLong >> BigInt(bitOffset)) & mask;

    // Entry spans two longs — read remaining bits from next long
    if (bitOffset + bitsPerEntry > 64 && longIndex + 1 < blockStates.length) {
      const bitsFromFirst = 64 - bitOffset;
      const unsignedNext = blockStates[longIndex + 1] & U64_MASK;
      const remaining = unsignedNext & ((1n << BigInt(bitsPerEntry - bitsFromFirst)) - 1n);
      value |= remaining << BigInt(bitsFromFirst);
    }

    result[i] = Number(value & mask);
  }

  return result;
}

/**
 * Reconstruct a full Minecraft block state string from a Litematica palette entry.
 * Litematica stores palette as `{ Name: "minecraft:oak_stairs", Properties: { facing: "north", half: "bottom" } }`.
 *
 * @param name       Block name (e.g. "minecraft:oak_stairs")
 * @param properties Optional block state properties (sorted alphabetically by key)
 * @returns Full block state string (e.g. "minecraft:oak_stairs[facing=north,half=bottom]")
 */
export function reconstructBlockState(
  name: string,
  properties?: Record<string, string>,
): string {
  if (!properties || Object.keys(properties).length === 0) {
    return name;
  }
  // Sort properties alphabetically for deterministic output (matches MC convention)
  const sorted = Object.keys(properties).sort();
  const propStr = sorted.map(k => `${k}=${properties[k]}`).join(',');
  return `${name}[${propStr}]`;
}

/**
 * Calculate bits-per-entry for a Litematica palette.
 * Litematica uses a minimum of 2 bits per entry.
 */
export function calcBitsPerEntry(paletteSize: number): number {
  return Math.max(2, Math.ceil(Math.log2(paletteSize)));
}
