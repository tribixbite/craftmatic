/**
 * Unit tests for the .io ZIP reader and its decryption paths.
 *
 * The Studio .io loader (ROADMAP.md #1) decodes three intricate, unguarded
 * formats: stored DEFLATE, legacy ZipCrypto, and WinZip AES-256. These tests
 * build the encrypted fixtures with Node's *own* crypto primitives (PBKDF2 +
 * AES-256-ECB of a little-endian counter) — an independent oracle — so they
 * verify the project's hand-rolled AES actually decrypts correctly, not merely
 * that it round-trips against itself.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { extractFile, extractMatching, listZipEntries } from '../web/src/engine/zip-utils.js';
import { extractIoLDraw, extractIoModel } from '../web/src/engine/io-extractor.js';

const PW = 'soho0909';

// ─── ZIP local-entry builders ────────────────────────────────────────────────

/** Build one ZIP local-file record (no central directory — extractFile scans locals). */
function localEntry(opts: {
  name: string;
  method: number; // stored compression method written into the header
  data: Buffer; // already-compressed/encrypted bytes
  flags?: number;
  extra?: Buffer;
}): Buffer {
  const nameBytes = Buffer.from(opts.name, 'utf-8');
  const extra = opts.extra ?? Buffer.alloc(0);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); // local file signature
  h.writeUInt16LE(20, 4); // version needed
  h.writeUInt16LE(opts.flags ?? 0, 6); // general purpose flags
  h.writeUInt16LE(opts.method, 8); // compression method
  h.writeUInt16LE(0, 10); // mod time
  h.writeUInt16LE(0, 12); // mod date
  h.writeUInt32LE(0, 14); // crc-32 (extractFile ignores it)
  h.writeUInt32LE(opts.data.length, 18); // compressed size
  h.writeUInt32LE(opts.data.length, 22); // uncompressed size (unused here)
  h.writeUInt16LE(nameBytes.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, nameBytes, extra, opts.data]);
}

/** WinZip AES extra field (0x9901) declaring AES-256 + the real compression method. */
function aesExtra(realMethod: number): Buffer {
  const e = Buffer.alloc(11);
  e.writeUInt16LE(0x9901, 0); // header id
  e.writeUInt16LE(7, 2); // data size
  e.writeUInt16LE(2, 4); // vendor version (AE-2)
  e.write('AE', 6, 'latin1'); // vendor id
  e.writeUInt8(3, 8); // strength: 3 = AES-256
  e.writeUInt16LE(realMethod, 9); // actual compression method
  return e;
}

/** AES-CTR with the WinZip little-endian counter (start = 1), via Node AES-256-ECB. */
function aesCtrLE(encKey: Buffer, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  const nblocks = Math.ceil(data.length / 16);
  for (let b = 0; b < nblocks; b++) {
    const counter = Buffer.alloc(16);
    let n = b + 1;
    for (let i = 0; i < 16 && n > 0; i++) { counter[i] = n & 0xff; n = Math.floor(n / 256); }
    const c = crypto.createCipheriv('aes-256-ecb', encKey, null);
    c.setAutoPadding(false);
    const ks = Buffer.concat([c.update(counter), c.final()]);
    const off = b * 16;
    const len = Math.min(16, data.length - off);
    for (let i = 0; i < len; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

/** Build a WinZip-AES-256 .io-style ZIP holding one entry. */
function aesZip(name: string, content: Buffer, realMethod: number, password = PW): ArrayBuffer {
  const body = realMethod === 8 ? zlib.deflateRawSync(content) : content;
  const salt = Buffer.from('0123456789abcdef', 'latin1'); // fixed 16-byte salt → deterministic
  const dk = crypto.pbkdf2Sync(password, salt, 1000, 2 * 32 + 2, 'sha1'); // 66 bytes
  const encKey = dk.subarray(0, 32);
  const authKey = dk.subarray(32, 64);
  const pwVerify = dk.subarray(64, 66);
  const cipher = aesCtrLE(encKey, body);
  const authCode = crypto.createHmac('sha1', authKey).update(cipher).digest().subarray(0, 10);
  const entryData = Buffer.concat([salt, pwVerify, cipher, authCode]);
  const rec = localEntry({ name, method: 99, data: entryData, flags: 1, extra: aesExtra(realMethod) });
  return rec.buffer.slice(rec.byteOffset, rec.byteOffset + rec.byteLength);
}

/** Build a plain (unencrypted) ZIP from one or more entries. */
function plainZip(entries: { name: string; content: Buffer; deflate?: boolean }[]): ArrayBuffer {
  const recs = entries.map((e) =>
    e.deflate
      ? localEntry({ name: e.name, method: 8, data: zlib.deflateRawSync(e.content) })
      : localEntry({ name: e.name, method: 0, data: e.content }),
  );
  const buf = Buffer.concat(recs);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ─── Legacy ZipCrypto (PKWARE) encryptor — independent oracle from the spec ───

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc1 = (crc: number, b: number) => (CRC[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;

function zipCryptoEncrypt(body: Buffer, password: string): Buffer {
  const keys = new Uint32Array([0x12345678, 0x23456789, 0x34567890]);
  const upd = (b: number) => {
    keys[0] = crc1(keys[0], b);
    keys[1] = (Math.imul(keys[1] + (keys[0] & 0xff), 0x08088405) + 1) >>> 0;
    keys[2] = crc1(keys[2], keys[1] >>> 24);
  };
  for (let i = 0; i < password.length; i++) upd(password.charCodeAt(i));
  // 12-byte encryption header (skipped on decrypt) + body, encrypted as one stream.
  const plain = Buffer.concat([Buffer.alloc(12), body]);
  const out = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) {
    const temp = (keys[2] & 0xffff) | 2;
    const keyByte = (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
    out[i] = plain[i] ^ keyByte;
    upd(plain[i]); // ZipCrypto feeds the *plaintext* byte back into the keys
  }
  return out;
}

/** Build a legacy ZipCrypto-encrypted ZIP holding one entry. */
function zipCryptoZip(name: string, content: Buffer, deflate: boolean, password = PW): ArrayBuffer {
  const body = deflate ? zlib.deflateRawSync(content) : content;
  const rec = localEntry({
    name,
    method: deflate ? 8 : 0,
    data: zipCryptoEncrypt(body, password),
    flags: 1, // encrypted bit
  });
  return rec.buffer.slice(rec.byteOffset, rec.byteOffset + rec.byteLength);
}

const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

// ─── extractFile: plain paths ────────────────────────────────────────────────

describe('extractFile — stored & DEFLATE', () => {
  it('returns stored (method 0) bytes verbatim', async () => {
    const zip = plainZip([{ name: 'model.ldr', content: Buffer.from('1 4 0 0 0 hello') }]);
    expect(dec(await extractFile(zip, 'model.ldr'))).toBe('1 4 0 0 0 hello');
  });

  it('inflates DEFLATE (method 8) entries', async () => {
    const text = 'STEP\n'.repeat(500); // compressible payload that spans inflate chunks
    const zip = plainZip([{ name: 'model.ldr', content: Buffer.from(text), deflate: true }]);
    expect(dec(await extractFile(zip, 'model.ldr'))).toBe(text);
  });

  it('matches entry names case-insensitively', async () => {
    const zip = plainZip([{ name: 'Model.LDR', content: Buffer.from('x') }]);
    expect(dec(await extractFile(zip, 'model.ldr'))).toBe('x');
  });

  it('throws when the named entry is absent', async () => {
    const zip = plainZip([{ name: 'other.txt', content: Buffer.from('x') }]);
    await expect(extractFile(zip, 'model.ldr')).rejects.toThrow(/not found/i);
  });
});

// ─── extractFile: WinZip AES-256 ─────────────────────────────────────────────

describe('extractFile — WinZip AES-256 (method 99)', () => {
  it('decrypts a stored-inside AES entry (validates hand-rolled AES vs Node oracle)', async () => {
    const plain = '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 STEP\n';
    const zip = aesZip('model.ldr', Buffer.from(plain), 0);
    expect(dec(await extractFile(zip, 'model.ldr', PW))).toBe(plain);
  });

  it('decrypts an AES entry whose inner method is DEFLATE', async () => {
    const plain = 'AES+DEFLATE roundtrip\n'.repeat(200);
    const zip = aesZip('model.ldr', Buffer.from(plain), 8);
    expect(dec(await extractFile(zip, 'model.ldr', PW))).toBe(plain);
  });

  it('decrypts payloads that are not a whole number of 16-byte blocks', async () => {
    const plain = 'x'.repeat(37); // 2 full blocks + 5 bytes
    const zip = aesZip('model.ldr', Buffer.from(plain), 0);
    expect(dec(await extractFile(zip, 'model.ldr', PW))).toBe(plain);
  });

  it('rejects a wrong password via the 2-byte verification value', async () => {
    const zip = aesZip('model.ldr', Buffer.from('secret'), 0);
    await expect(extractFile(zip, 'model.ldr', 'wrongpw')).rejects.toThrow(/wrong password/i);
  });

  it('throws if an AES entry is hit without a password', async () => {
    const zip = aesZip('model.ldr', Buffer.from('secret'), 0);
    await expect(extractFile(zip, 'model.ldr')).rejects.toThrow(/AES-encrypted/i);
  });
});

// ─── extractFile: legacy ZipCrypto ───────────────────────────────────────────

describe('extractFile — legacy ZipCrypto', () => {
  it('decrypts a stored ZipCrypto entry', async () => {
    const plain = '1 7 0 0 0 1 0 0 0 1 0 0 0 1 3002.dat\n';
    const zip = zipCryptoZip('model2.ldr', Buffer.from(plain), false);
    expect(dec(await extractFile(zip, 'model2.ldr', PW))).toBe(plain);
  });

  it('decrypts a ZipCrypto entry whose inner method is DEFLATE', async () => {
    const plain = '0 STEP\n1 7 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat\n'.repeat(100);
    const zip = zipCryptoZip('model2.ldr', Buffer.from(plain), true);
    expect(dec(await extractFile(zip, 'model2.ldr', PW))).toBe(plain);
  });

  it('throws if a ZipCrypto entry is hit without a password', async () => {
    const zip = zipCryptoZip('model2.ldr', Buffer.from('secret'), false);
    await expect(extractFile(zip, 'model2.ldr')).rejects.toThrow(/encrypted/i);
  });
});

// ─── extractIoLDraw: candidate selection ─────────────────────────────────────

describe('extractIoLDraw — model candidate selection', () => {
  it('returns model.ldr when it contains brick (type-1) lines', async () => {
    const zip = plainZip([
      { name: 'model.ldr', content: Buffer.from(`1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n`) },
      { name: 'model2.ldr', content: Buffer.from('0 should not be used\n') },
    ]);
    const text = await extractIoLDraw(zip);
    expect(text).toContain('3001.dat');
  });

  it('falls through to model2.ldr when model.ldr has no type-1 lines', async () => {
    const zip = plainZip([
      { name: 'model.ldr', content: Buffer.from('0 FILE main\n0 just comments\n') },
      { name: 'model2.ldr', content: Buffer.from(`1 7 0 0 0 1 0 0 0 1 0 0 0 1 3002.dat\n`) },
    ]);
    const text = await extractIoLDraw(zip);
    expect(text).toContain('3002.dat');
  });

  it('throws when no LDraw model is present', async () => {
    const zip = plainZip([{ name: 'notes.txt', content: Buffer.from('nothing here') }]);
    await expect(extractIoLDraw(zip)).rejects.toThrow(/No LDraw model/i);
  });
});

// ─── listZipEntries / extractMatching / extractIoModel (CustomParts) ─────────

describe('zip entry enumeration + .io CustomParts extraction', () => {
  const BRICK_LINE = '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n';

  it('listZipEntries returns every local entry name', () => {
    const zip = plainZip([
      { name: 'model.ldr', content: Buffer.from(BRICK_LINE) },
      { name: 'CustomParts/m123_456.dat', content: Buffer.from('3 16 0 0 0 1 0 0 0 0 1\n') },
      { name: 'thumbnail.png', content: Buffer.from([1, 2, 3]) },
    ]);
    expect(listZipEntries(zip)).toEqual(['model.ldr', 'CustomParts/m123_456.dat', 'thumbnail.png']);
  });

  it('extractMatching pulls only predicate-matching entries', async () => {
    const zip = plainZip([
      { name: 'model.ldr', content: Buffer.from(BRICK_LINE) },
      { name: 'CustomParts/a.dat', content: Buffer.from('AAA'), deflate: true },
      { name: 'CustomParts/collider/a.col', content: Buffer.from('COL') },
    ]);
    const got = await extractMatching(zip, n => /^CustomParts\/.*\.dat$/.test(n));
    expect([...got.keys()]).toEqual(['CustomParts/a.dat']);
    expect(dec(got.get('CustomParts/a.dat'))).toBe('AAA');
  });

  it('extractIoModel returns the model text plus CustomParts keyed by relative path', async () => {
    // Mirrors the real Studio layout: custom m-parts at the root of
    // CustomParts/ and bundled primitives under CustomParts/p/(48/).
    const zip = plainZip([
      { name: 'model.ldr', content: Buffer.from(BRICK_LINE) },
      { name: 'CustomParts/m3659da88_2019920_072931.dat', content: Buffer.from('0 custom part\n3 16 0 0 0 1 0 0 0 0 1\n'), deflate: true },
      { name: 'CustomParts/p/48/1-12edge.dat', content: Buffer.from('2 24 0 0 0 1 0 0\n') },
      { name: 'CustomParts/collider/m3659da88_2019920_072931.col', content: Buffer.from('ignored') },
      { name: 'thumbnail.png', content: Buffer.from([0x89, 0x50]) },
    ]);
    const m = await extractIoModel(zip);
    expect(m.text).toContain('3001.dat');
    expect([...m.customParts.keys()].sort()).toEqual([
      'm3659da88_2019920_072931.dat',
      'p/48/1-12edge.dat',
    ]);
    expect(m.customParts.get('p/48/1-12edge.dat')).toBe('2 24 0 0 0 1 0 0\n');
  });

  it('extractIoModel returns an empty map when the archive has no CustomParts', async () => {
    const zip = plainZip([{ name: 'model.ldr', content: Buffer.from(BRICK_LINE) }]);
    const m = await extractIoModel(zip);
    expect(m.customParts.size).toBe(0);
  });
});
