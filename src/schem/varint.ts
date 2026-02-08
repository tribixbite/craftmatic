/**
 * Varint encoding/decoding for Sponge Schematic BlockData.
 * Uses the same variable-length integer format as Minecraft protocol.
 */

/** Encode a non-negative integer as a varint byte sequence */
export function encodeVarint(value: number): number[] {
  const result: number[] = [];
  while (true) {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    result.push(byte);
    if (value === 0) break;
  }
  return result;
}

/** Decode a varint from a buffer at the given offset. Returns [value, bytesRead]. */
export function decodeVarint(data: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (true) {
    if (offset + bytesRead >= data.length) {
      throw new Error(`Varint extends beyond buffer at offset ${offset}`);
    }
    const byte = data[offset + bytesRead];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) {
      throw new Error(`Varint too large at offset ${offset}`);
    }
  }
  return [result, bytesRead];
}

/**
 * Decode all varints from a block data buffer.
 * Returns an array of palette indices, one per block.
 */
export function decodeAllVarints(data: Uint8Array, expectedCount: number): number[] {
  const result: number[] = [];
  let offset = 0;
  for (let i = 0; i < expectedCount; i++) {
    const [value, bytesRead] = decodeVarint(data, offset);
    result.push(value);
    offset += bytesRead;
  }
  return result;
}
