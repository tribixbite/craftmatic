/**
 * WinZip AES decryption for ZIP entries (compression method 99).
 *
 * BrickLink Studio .io files from older / "early access" builds encrypt their
 * model.ldr with AES-256 (WinZip AE-2) under the password "soho0909", rather
 * than the legacy ZipCrypto used by other exports. Without this, those .io
 * files fail to load (issue: ".io doesn't load properly").
 *
 * Format (per the WinZip AES spec, AE-1/AE-2):
 *   entry data = salt[saltLen] | pwVerify[2] | ciphertext | authCode[10]
 *   saltLen / keyLen = 8/16 (AES-128), 12/24 (AES-192), 16/32 (AES-256)
 *   key material = PBKDF2-HMAC-SHA1(password, salt, 1000 iters,
 *                                   2*keyLen + 2 bytes)
 *                = encKey[keyLen] | authKey[keyLen] | pwVerify[2]
 *   cipher = AES-CTR with a 16-byte LITTLE-ENDIAN counter starting at 1
 *            (note: NOT Web Crypto's big-endian CTR — hence the hand-rolled
 *            block cipher below).
 *
 * We verify the 2-byte password check value, then CTR-decrypt. The HMAC
 * authentication code is not checked (we only need the plaintext).
 */

// ─── AES block cipher (encrypt-only; CTR needs only the forward direction) ────

const SBOX = (() => {
  const s = new Uint8Array(256);
  const rotl8 = (x: number, n: number) => ((x << n) | (x >>> (8 - n))) & 0xff;
  let p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0)) & 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    q &= 0xff;
    s[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();

function subWord(w: number): number {
  return (
    (SBOX[(w >>> 24) & 0xff] << 24) |
    (SBOX[(w >>> 16) & 0xff] << 16) |
    (SBOX[(w >>> 8) & 0xff] << 8) |
    SBOX[w & 0xff]
  ) >>> 0;
}

function rotWord(w: number): number {
  return ((w << 8) | (w >>> 24)) >>> 0;
}

interface AesKey { w: Uint32Array; nr: number; }

function expandKey(key: Uint8Array): AesKey {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint32Array(4 * (nr + 1));
  for (let i = 0; i < nk; i++) {
    w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  }
  let rcon = 0x01;
  for (let i = nk; i < w.length; i++) {
    let t = w[i - 1];
    if (i % nk === 0) {
      t = (subWord(rotWord(t)) ^ (rcon << 24)) >>> 0;
      rcon = (rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0);
      rcon &= 0xff;
    } else if (nk > 6 && i % nk === 4) {
      t = subWord(t);
    }
    w[i] = (w[i - nk] ^ t) >>> 0;
  }
  return { w, nr };
}

const xtime = (x: number) => ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff;

/** Encrypt one 16-byte block in place into `out`. */
function encryptBlock(key: AesKey, input: Uint8Array, out: Uint8Array): void {
  const { w, nr } = key;
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = input[i];
  // AddRoundKey (round 0)
  addRoundKey(s, w, 0);
  for (let round = 1; round < nr; round++) {
    subBytes(s);
    shiftRows(s);
    mixColumns(s);
    addRoundKey(s, w, round);
  }
  subBytes(s);
  shiftRows(s);
  addRoundKey(s, w, nr);
  out.set(s);
}

function addRoundKey(s: Uint8Array, w: Uint32Array, round: number): void {
  for (let c = 0; c < 4; c++) {
    const k = w[round * 4 + c];
    s[c * 4] ^= (k >>> 24) & 0xff;
    s[c * 4 + 1] ^= (k >>> 16) & 0xff;
    s[c * 4 + 2] ^= (k >>> 8) & 0xff;
    s[c * 4 + 3] ^= k & 0xff;
  }
}

function subBytes(s: Uint8Array): void {
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
}

function shiftRows(s: Uint8Array): void {
  // state is column-major: byte at (row r, col c) = s[c*4 + r]
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      s[c * 4 + r] = t[((c + r) % 4) * 4 + r];
    }
  }
}

function mixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i]     = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    s[i + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    s[i + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    s[i + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}

// ─── WinZip AES-CTR ───────────────────────────────────────────────────────────

/** AES-CTR with a 16-byte little-endian counter starting at 1 (WinZip AE). */
function ctrDecrypt(encKey: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const key = expandKey(encKey);
  const out = new Uint8Array(ciphertext.length);
  const counter = new Uint8Array(16);
  const ks = new Uint8Array(16);
  const nblocks = Math.ceil(ciphertext.length / 16);
  for (let b = 0; b < nblocks; b++) {
    let n = b + 1;
    counter.fill(0);
    for (let i = 0; i < 16 && n > 0; i++) { counter[i] = n & 0xff; n = Math.floor(n / 256); }
    encryptBlock(key, counter, ks);
    const off = b * 16;
    const len = Math.min(16, ciphertext.length - off);
    for (let i = 0; i < len; i++) out[off + i] = ciphertext[off + i] ^ ks[i];
  }
  return out;
}

/**
 * Decrypt a WinZip-AES entry body. Returns the still-compressed bytes (caller
 * inflates per the real compression method from the AES extra field).
 * Throws on wrong password (via the 2-byte verification value).
 */
export async function decryptWinzipAes(
  entry: Uint8Array,
  password: string,
  strength: number, // 1=AES-128, 2=AES-192, 3=AES-256
): Promise<Uint8Array> {
  const saltLen = strength === 1 ? 8 : strength === 2 ? 12 : 16;
  const keyLen = strength === 1 ? 16 : strength === 2 ? 24 : 32;

  const salt = entry.subarray(0, saltLen);
  const pwVerify = entry.subarray(saltLen, saltLen + 2);
  const ciphertext = entry.subarray(saltLen + 2, entry.length - 10); // drop 10-byte auth code

  const pwBytes = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey('raw', pwBytes as Uint8Array<ArrayBuffer>, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations: 1000, hash: 'SHA-1' },
    baseKey,
    (2 * keyLen + 2) * 8,
  );
  const dk = new Uint8Array(bits);
  const encKey = dk.subarray(0, keyLen);
  const verify = dk.subarray(2 * keyLen, 2 * keyLen + 2);

  if (verify[0] !== pwVerify[0] || verify[1] !== pwVerify[1]) {
    throw new Error('WinZip AES: wrong password (verification mismatch)');
  }
  return ctrDecrypt(encKey, ciphertext);
}
