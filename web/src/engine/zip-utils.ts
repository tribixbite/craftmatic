/**
 * Minimal ZIP reader with ZipCrypto decryption.
 * Parses local file headers to locate and extract a named file.
 * DEFLATE inflate uses native DecompressionStream('deflate-raw').
 */

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

  writer.write(compressed);
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
    const dataStart = fnStart + fnLen + extraLen;

    if (name.toLowerCase() === target) {
      const encrypted = (flags & 1) !== 0;
      let compressed = bytes.subarray(dataStart, dataStart + compSize);

      if (encrypted) {
        if (!password) throw new Error(`File "${filename}" is encrypted but no password given`);
        const decrypted = decryptData(compressed, password);
        // skip 12-byte encryption header
        compressed = decrypted.subarray(12);
      }

      if (method === 0) return compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
      if (method === 8) return (await inflate(compressed)).buffer;
      throw new Error(`Unsupported compression method ${method}`);
    }

    pos = dataStart + compSize;
    // If data descriptor present (bit 3), skip 12 or 16 bytes
    if (flags & 8) pos += (view.getUint32(pos, true) === 0x08074b50) ? 16 : 12;
  }

  throw new Error(`File "${filename}" not found in ZIP`);
}
