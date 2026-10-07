import { crc32 } from './zip-utils.js';

/** A decoded, non-interlaced 8-bit RGB or RGBA PNG. */
export interface PngRgb8 {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array;
}

const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const u32 = (b: Uint8Array, p: number): number => (((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0);
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Decode the PNG subset Bedrock MER maps use: non-interlaced 8-bit RGB/RGBA. */
export async function decodePngRgb8(bytes: Uint8Array): Promise<PngRgb8> {
  if (bytes.length < signature.length || signature.some((v, i) => bytes[i] !== v)) throw new Error('not a PNG');
  let p = 8, width = 0, height = 0, channels: 3 | 4 | 0 = 0, sawHeader = false, sawEnd = false, compressedLength = 0;
  const idat: Uint8Array[] = [];
  while (p + 12 <= bytes.length) {
    const length = u32(bytes, p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const start = p + 8, end = start + length;
    if (end + 4 > bytes.length) throw new Error(`truncated ${type || 'PNG'} chunk`);
    if (crc32(bytes.subarray(p + 4, end)) !== u32(bytes, end)) throw new Error(`${type || 'PNG'} chunk has an invalid CRC`);
    if (!sawHeader && type !== 'IHDR') throw new Error('IHDR must be the first PNG chunk');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw new Error(`invalid IHDR chunk (${sawHeader ? 'duplicate' : `${length} bytes`})`);
      sawHeader = true;
      width = u32(bytes, start); height = u32(bytes, start + 4);
      const depth = bytes[start + 8], color = bytes[start + 9], compression = bytes[start + 10], filter = bytes[start + 11], interlace = bytes[start + 12];
      if (depth !== 8 || (color !== 2 && color !== 6) || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error(`unsupported PNG format (depth ${depth}, color ${color}, interlace ${interlace})`);
      }
      channels = color === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      compressedLength += length;
      if (compressedLength > MAX_DECODED_BYTES) throw new Error(`PNG compressed data exceeds ${MAX_DECODED_BYTES} bytes`);
      idat.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error(`invalid IEND chunk (${length} bytes)`);
      sawEnd = true;
    }
    p = end + 4;
    if (type === 'IEND') break;
  }
  if (!width || !height || !channels || !idat.length || !sawEnd) throw new Error('PNG is missing IHDR, IDAT or IEND data');
  if (p !== bytes.length) throw new Error(`PNG has ${bytes.length - p} trailing bytes after IEND`);
  const stride = width * channels, expected = height * (stride + 1);
  if (!Number.isSafeInteger(expected) || expected > MAX_DECODED_BYTES) throw new Error(`PNG decoded size exceeds ${MAX_DECODED_BYTES} bytes`);
  const compressed = new Uint8Array(compressedLength);
  let at = 0;
  for (const b of idat) { compressed.set(b, at); at += b.length; }
  const reader = new Blob([compressed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const inflated = new Uint8Array(expected);
  let inflatedLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (inflatedLength + value.length > expected) throw new Error(`PNG scanlines exceed expected ${expected} bytes`);
      inflated.set(value, inflatedLength);
      inflatedLength += value.length;
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* Preserve the decode error. */ }
    throw error;
  } finally { reader.releaseLock(); }
  if (inflatedLength !== expected) throw new Error(`PNG scanlines have ${inflatedLength} bytes; expected ${expected}`);
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]!, src = y * (stride + 1) + 1, dst = y * stride;
    if (filter > 4) throw new Error(`unsupported PNG row filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const raw = inflated[src + x]!, left = x >= channels ? pixels[dst + x - channels]! : 0;
      const up = y ? pixels[dst + x - stride]! : 0;
      const upperLeft = y && x >= channels ? pixels[dst + x - stride - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      pixels[dst + x] = (raw + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

/** The image's one RGB value, or null when its RGB channels are non-uniform. */
export function uniformPngRgb(image: PngRgb8): [number, number, number] | null {
  const { channels, pixels } = image;
  const rgb: [number, number, number] = [pixels[0]!, pixels[1]!, pixels[2]!];
  for (let p = channels; p < pixels.length; p += channels) {
    if (pixels[p] !== rgb[0] || pixels[p + 1] !== rgb[1] || pixels[p + 2] !== rgb[2]) return null;
  }
  return rgb;
}
