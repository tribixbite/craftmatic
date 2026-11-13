/**
 * The release pack icon (RB, BIZ-24 / BIZ-54): a 256x256 PNG per product, the same file in both packs.
 *
 * Microsoft's validator (`mct validate`, rule CPACKICON:101) wants a `pack_icon.png` in EVERY pack, square and a power
 * of two up to 256. The dev pack ships a 16x16 stud swatch in its resource pack only; a release ships this instead.
 *
 * The mark is our own and deliberately generic: a rounded tile carrying a 2 x 2 grid of round studs, tinted from a
 * hash of the product's namespace so two products do not share an icon. It is NOT the LEGO logo and not set art.
 *
 * Determinism (two builds of one commit must give the identical archive, D-03): the pixels come from integer hashing,
 * `+ - * /` and `Math.sqrt` only (IEEE-754 exact, unlike `Math.sin` / `Math.pow`, which engines may round differently),
 * and the PNG is assembled here from an injected raw-DEFLATE compressor (`PackProfile.deflate`).
 */
import { crc32 } from '../zip-utils.js';
import { encodePngRgba } from '../lego-resource-pack.js';

/** Edge length of the icon in pixels (the largest size the validator accepts). */
export const PACK_ICON_SIZE = 256;

/** Raw DEFLATE compressor (`PackProfile.deflate`), or absent for stored blocks (a ~262 KB file). */
export type RawDeflate = (data: Uint8Array) => Uint8Array;

/** FNV-1a over the UTF-16 code units: a stable 32-bit hash of a string. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** HSV (`h` in [0, 6), `s`, `v` in [0, 1]) to 0-255 RGB, by piecewise-linear arithmetic only. */
function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

/** Signed distance from `(x, y)` to a rounded rectangle centred at the origin (negative inside). */
function roundedBoxDistance(x: number, y: number, halfW: number, halfH: number, radius: number): number {
  const qx = Math.abs(x) - (halfW - radius);
  const qy = Math.abs(y) - (halfH - radius);
  const outside = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2);
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Coverage in [0, 1] of a shape whose signed distance is `d`, over a one-pixel soft edge. */
const coverage = (d: number): number => Math.max(0, Math.min(1, 0.5 - d));

/** The icon's RGBA pixels for a namespace. Pure: the same namespace always gives the same bytes. */
export function packIconRgba(namespace: string): Uint8Array {
  const size = PACK_ICON_SIZE;
  const hash = fnv1a(namespace);
  const hue = (hash % 360) / 60;
  const tile = hsv(hue, 0.72, 0.86);
  const rim = hsv(hue, 0.8, 0.6);
  const stud = hsv(hue, 0.5, 0.97);
  const studShade = hsv(hue, 0.78, 0.7);
  const rgba = new Uint8Array(size * size * 4);
  const half = size / 2;
  const studOffset = 54;
  const studRadius = 40;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px + 0.5 - half;
      const y = py + 0.5 - half;
      const tileCover = coverage(roundedBoxDistance(x, y, 120, 120, 36));
      if (tileCover === 0) continue;
      // The tile: a darker rim fading to the face colour over 10 px, lit from the top left.
      const inner = -roundedBoxDistance(x, y, 120, 120, 36);
      const rimMix = Math.max(0, Math.min(1, 1 - inner / 10));
      let colour: [number, number, number] = [0, 1, 2].map(i => tile[i]! + (rim[i]! - tile[i]!) * rimMix) as [number, number, number];
      // The studs: the nearest of the four centres, a shaded disc with a lit upper-left crescent.
      const cx = x < 0 ? -studOffset : studOffset;
      const cy = y < 0 ? -studOffset : studOffset;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const studCover = coverage(dist - studRadius);
      if (studCover > 0) {
        const light = Math.max(0, Math.min(1, 0.5 - (dx + dy) / (2.4 * studRadius)));
        const face: [number, number, number] = [0, 1, 2].map(i => studShade[i]! + (stud[i]! - studShade[i]!) * light) as [number, number, number];
        colour = [0, 1, 2].map(i => colour[i]! + (face[i]! - colour[i]!) * studCover) as [number, number, number];
      }
      const at = (py * size + px) * 4;
      rgba[at] = Math.round(colour[0]);
      rgba[at + 1] = Math.round(colour[1]);
      rgba[at + 2] = Math.round(colour[2]);
      rgba[at + 3] = Math.round(tileCover * 255);
    }
  }
  return rgba;
}

const u32be = (n: number): Uint8Array => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, c => c.charCodeAt(0));

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([ascii(type), data]);
  return concat([u32be(data.length), body, u32be(crc32(body))]);
}

/** Adler-32 of `data` (the zlib trailer). */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const v of data) { a = (a + v) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/**
 * The icon for a namespace as PNG bytes. With `deflate` the IDAT is a real zlib stream (a few KB); without it the
 * shared stored-block encoder is used (valid, ~262 KB), which a release build never does: `PackProfile.deflate` is
 * always injected there.
 */
export function packIconPng(namespace: string, deflate?: RawDeflate): Uint8Array {
  const rgba = packIconRgba(namespace);
  if (!deflate) return encodePngRgba(PACK_ICON_SIZE, PACK_ICON_SIZE, rgba);
  const rowBytes = PACK_ICON_SIZE * 4;
  // Filter type 1 (Sub) on every row: the tile's flat runs become zeros, which DEFLATE shrinks well.
  const raw = new Uint8Array(PACK_ICON_SIZE * (1 + rowBytes));
  for (let y = 0; y < PACK_ICON_SIZE; y++) {
    const row = y * (1 + rowBytes);
    raw[row] = 1;
    for (let i = 0; i < rowBytes; i++) raw[row + 1 + i] = (rgba[y * rowBytes + i]! - (i >= 4 ? rgba[y * rowBytes + i - 4]! : 0)) & 255;
  }
  const zlib = concat([Uint8Array.of(0x78, 0xda), deflate(raw), u32be(adler32(raw))]);
  return concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', concat([u32be(PACK_ICON_SIZE), u32be(PACK_ICON_SIZE), Uint8Array.of(8, 6, 0, 0, 0)])),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array()),
  ]);
}
