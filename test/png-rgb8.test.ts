import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePngRgb8, uniformPngRgb } from '../web/src/engine/png-rgb8.js';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number): Uint8Array => Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n);
const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const chunk = (name: string, data: Uint8Array): Uint8Array => {
  const body = join(new TextEncoder().encode(name), data);
  return join(u32(data.length), body, u32(crc32(body)));
};
const png = (width: number, height: number, colorType: 2 | 6, filtered: Uint8Array): Uint8Array => join(
  Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
  chunk('IHDR', join(u32(width), u32(height), Uint8Array.of(8, colorType, 0, 0, 0))),
  chunk('IDAT', new Uint8Array(deflateSync(filtered))),
  chunk('IEND', new Uint8Array()),
);
describe('decodePngRgb8', () => {
  it('decodes RGB8 filters 1-4 and identifies non-uniform material data', async () => {
    const rows = [
      Uint8Array.of(10, 20, 30, 40, 50, 60),
      Uint8Array.of(12, 25, 33, 41, 49, 65),
      Uint8Array.of(100, 80, 60, 50, 30, 10),
      Uint8Array.of(101, 79, 70, 55, 31, 9),
      Uint8Array.of(130, 180, 90, 160, 80, 10),
    ];
    // Precomputed bytes, rather than an encoder repeating the decoder's
    // predictor logic. The final RGB pixel selects upper-left, left and up
    // respectively in Paeth, and negative residuals wrap modulo 256.
    const filtered = Uint8Array.of(
      1, 10, 20, 30, 30, 30, 30,
      2, 2, 5, 3, 1, 255, 5,
      3, 94, 68, 44, 236, 222, 204,
      4, 1, 255, 10, 5, 1, 255,
      4, 29, 101, 20, 59, 156, 1,
    );
    const image = await decodePngRgb8(png(2, 5, 2, filtered));
    expect(image).toMatchObject({ width: 2, height: 5, channels: 3 });
    expect([...image.pixels]).toEqual(rows.flatMap(row => [...row]));
    expect(uniformPngRgb(image)).toBeNull();
  });

  it('rejects a validly framed image before allocating an oversized decode', async () => {
    await expect(decodePngRgb8(png(20_000, 20_000, 2, new Uint8Array()))).rejects.toThrow(/decoded size exceeds/);
  });

  it('cancels a stream that inflates beyond the IHDR dimensions', async () => {
    await expect(decodePngRgb8(png(1, 1, 2, Uint8Array.of(0, 1, 2, 3, 4)))).rejects.toThrow(/exceed expected/);
  });
});
