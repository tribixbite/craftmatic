/**
 * Minimal ZIP reader with ZipCrypto + WinZip-AES decryption.
 * Parses local file headers to locate and extract a named file.
 * DEFLATE inflate uses native DecompressionStream('deflate-raw').
 */

import { decryptWinzipAes } from './aes-zip';

// ─── CRC32 ───────────────────────────────────────────────────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32byte(crc: number, byte: number): number {
  return (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
}

// ─── ZipCrypto ───────────────────────────────────────────────────────────────

function initKeys(password: string): Uint32Array {
  const keys = new Uint32Array([0x12345678, 0x23456789, 0x34567890]);
  for (let i = 0; i < password.length; i++) updateKeys(keys, password.charCodeAt(i));
  return keys;
}

function updateKeys(keys: Uint32Array, byte: number): void {
  keys[0] = crc32byte(keys[0], byte);
  keys[1] = (Math.imul(keys[1] + (keys[0] & 0xff), 0x08088405) + 1) >>> 0;
  keys[2] = crc32byte(keys[2], keys[1] >>> 24);
}

function decryptByte(keys: Uint32Array, encByte: number): number {
  const temp = (keys[2] & 0xffff) | 2;
  const keyByte = ((Math.imul(temp, temp ^ 1) >>> 8)) & 0xff;
  const plain = encByte ^ keyByte;
  updateKeys(keys, plain);
  return plain;
}

function decryptData(data: Uint8Array, password: string): Uint8Array {
  const keys = initKeys(password);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = decryptByte(keys, data[i]);
  return out;
}

// ─── DEFLATE ─────────────────────────────────────────────────────────────────

async function inflate(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressed as Uint8Array<ArrayBuffer>);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }

  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

// ─── ZIP local file header parser ────────────────────────────────────────────

const SIG_LOCAL = 0x04034b50;

/**
 * Find the WinZip AES extra field (header id 0x9901) within a local header's
 * extra area and return the AES strength (1/2/3) + the real compression method.
 */
function parseAesExtra(
  bytes: Uint8Array,
  extraStart: number,
  extraLen: number,
): { strength: number; method: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  let i = extraStart;
  const end = extraStart + extraLen;
  while (i + 4 <= end) {
    const id = view.getUint16(i, true);
    const size = view.getUint16(i + 2, true);
    if (id === 0x9901 && size >= 7) {
      const strength = bytes[i + 8];          // after vendorVer(2) + vendorId(2)
      const method = view.getUint16(i + 9, true);
      return { strength, method };
    }
    i += 4 + size;
  }
  return null;
}

/**
 * Scan ZIP buffer for a local file entry with the given name (case-insensitive).
 * Returns the decompressed file contents.
 * Pass `password` for ZipCrypto-encrypted entries.
 */
export async function extractFile(
  buffer: ArrayBuffer,
  filename: string,
  password?: string,
): Promise<ArrayBuffer> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const target = filename.toLowerCase();

  let pos = 0;
  while (pos + 30 < bytes.length) {
    if (view.getUint32(pos, true) !== SIG_LOCAL) { pos++; continue; }

    const flags       = view.getUint16(pos + 6,  true);
    const method      = view.getUint16(pos + 8,  true);
    const compSize    = view.getUint32(pos + 18, true);
    const fnLen       = view.getUint16(pos + 26, true);
    const extraLen    = view.getUint16(pos + 28, true);

    const fnStart = pos + 30;
    const name = new TextDecoder().decode(bytes.subarray(fnStart, fnStart + fnLen));
    const extraStart = fnStart + fnLen;
    const dataStart = extraStart + extraLen;

    if (name.toLowerCase() === target) {
      const encrypted = (flags & 1) !== 0;
      let effectiveMethod = method;
      let compressed = bytes.subarray(dataStart, dataStart + compSize);

      if (method === 99) {
        // WinZip AES — actual compression method lives in the 0x9901 extra field.
        if (!password) throw new Error(`File "${filename}" is AES-encrypted but no password given`);
        const aes = parseAesExtra(bytes, extraStart, extraLen);
        if (!aes) throw new Error(`File "${filename}" missing AES extra field`);
        const decrypted = await decryptWinzipAes(compressed, password, aes.strength);
        compressed = decrypted as Uint8Array<ArrayBuffer>;
        effectiveMethod = aes.method;
      } else if (encrypted) {
        if (!password) throw new Error(`File "${filename}" is encrypted but no password given`);
        const decrypted = decryptData(compressed, password);
        // skip 12-byte ZipCrypto encryption header
        compressed = decrypted.subarray(12) as Uint8Array<ArrayBuffer>;
      }

      if (effectiveMethod === 0) return (compressed.buffer as ArrayBuffer).slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
      if (effectiveMethod === 8) return (await inflate(compressed)).buffer as ArrayBuffer;
      throw new Error(`Unsupported compression method ${effectiveMethod}`);
    }

    pos = dataStart + compSize;
    // If data descriptor present (bit 3), skip 12 or 16 bytes
    if (flags & 8) pos += (view.getUint32(pos, true) === 0x08074b50) ? 16 : 12;
  }

  throw new Error(`File "${filename}" not found in ZIP`);
}
