/**
 * Where a mini-doll's face features sit, MEASURED on the library's printed doll
 * heads - the numbers the default doll face (`MINIDOLL_DEFAULT_FACE`,
 * head-face.ts) is drawn from, and a PNG of each print for the eye.
 *
 * Every `92198p*` / `92240p*` print framed like its plain mould is rasterised
 * face-on (`rasterizeHeadFace`, the same raster the pack draws). Its ink is
 * split into connected blobs; the two largest dark blobs at the same height
 * are the eyes, the widest ink below them the mouth. Reported per print and as
 * medians, as fractions of the head's whole front bounds, so the default face
 * lands where real prints put their features whatever grain the head compiles at.
 *
 * Usage: bun scripts/_doll_face_measure.ts <out-dir> [--limit=N]
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { rasterizeHeadFace, type FaceImage } from '../web/src/engine/head-face.ts';

const CLEGO = 'C:/git/clego';
setLDrawRoot(`${CLEGO}/extracted/studio_release/app/ldraw`);
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync(`${CLEGO}/ldraw_ref`)) process.env.CRAFTMATIC_LDRAW_REF = `${CLEGO}/ldraw_ref`;
const out = process.argv[2];
if (!out) { console.error('usage: bun scripts/_doll_face_measure.ts <out-dir>'); process.exit(2); }
mkdirSync(out, { recursive: true });
const limit = Number(process.argv.find(a => a.startsWith('--limit='))?.slice(8) ?? 1e9);

/** A minimal RGBA PNG writer (evidence images only). */
function png(width: number, height: number, rgba: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

interface Blob { n: number; x0: number; x1: number; y0: number; y1: number; cx: number; cy: number; lum: number }
function blobs(img: FaceImage): Blob[] {
  const { width: w, height: h, rgba } = img;
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || rgba[s * 4 + 3]! < 128) continue;
    const stack = [s]; seen[s] = 1;
    const b: Blob = { n: 0, x0: w, x1: 0, y0: h, y1: 0, cx: 0, cy: 0, lum: 0 };
    while (stack.length) {
      const p = stack.pop()!; const x = p % w, y = (p - x) / w;
      b.n++; b.cx += x; b.cy += y; b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y);
      b.lum += 0.299 * rgba[p * 4]! + 0.587 * rgba[p * 4 + 1]! + 0.114 * rgba[p * 4 + 2]!;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !seen[q] && rgba[q * 4 + 3]! >= 128) { seen[q] = 1; stack.push(q); }
      }
    }
    b.cx /= b.n; b.cy /= b.n; b.lum /= b.n;
    out.push(b);
  }
  return out;
}

const dirs = [`${CLEGO}/ldraw_ref/official/parts`, `${CLEGO}/ldraw_ref/unofficial/parts`];
const names = [...new Set(dirs.flatMap(d => existsSync(d) ? readdirSync(d) : []).filter(n => /^(92198|92240)p[0-9a-z]+\.dat$/i.test(n) && !/c\d\d/i.test(n)))].sort().slice(0, limit);
const provider = createPartGeometryProvider();
const plain = { '92198': await provider.getPartMesh('92198.dat'), '92240': await provider.getPartMesh('92240.dat') };
const rows: Array<Record<string, unknown>> = [];
for (const name of names) {
  const mesh = await provider.getPartMesh(name);
  const base = plain[name.slice(0, 5) as '92198' | '92240'];
  if (!mesh || !base) continue;
  // Same frame as the plain mould (the print map's own acceptance test).
  if (mesh.bounds.min.some((v, i) => Math.abs(v - base.bounds.min[i]!) > 0.6) || mesh.bounds.max.some((v, i) => Math.abs(v - base.bounds.max[i]!) > 0.6)) continue;
  const img = rasterizeHeadFace(mesh);
  if (!img) continue;
  writeFileSync(`${out}/${name.replace(/\.dat$/i, '')}.png`, png(img.width, img.height, img.rgba));
  // Fractions of the head's whole FRONT bounds (the raster's own rect): a doll's mouth sits below
  // the 80 %-width headBodyRect, so that rect cannot place it.
  const body = img.rect;
  const fx = (px: number): number => (px + 0.5) / img.width;
  const fy = (py: number): number => (py + 0.5) / img.height;
  const bs = blobs(img).filter(b => b.n >= 6);
  // Eyes: the two largest blobs whose centres share a height (within 12 % of the body) and sit either side of the middle.
  const mid = (body.x0 + body.x1) / 2;
  let eyes: [Blob, Blob] | null = null;
  const big = [...bs].sort((a, b) => b.n - a.n).slice(0, 8);
  for (let i = 0; i < big.length && !eyes; i++) for (let j = i + 1; j < big.length && !eyes; j++) {
    const a = big[i]!, b = big[j]!;
    const ax = img.rect.x0 + a.cx / 4, bx = img.rect.x0 + b.cx / 4;
    if (Math.abs(fy(a.cy) - fy(b.cy)) < 0.12 && (ax - mid) * (bx - mid) < 0) eyes = ax < bx ? [a, b] : [b, a];
  }
  const below = eyes ? bs.filter(b => fy(b.cy) > Math.max(fy(eyes![0].cy), fy(eyes![1].cy)) + 0.15) : [];
  const mouth = below.sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0];
  rows.push({
    name, body: [body.x0, body.x1, body.y0, body.y1].map(v => +v.toFixed(2)),
    eyes: eyes ? eyes.map(e => ({ cx: +fx(e.cx).toFixed(3), cy: +fy(e.cy).toFixed(3), w: +((e.x1 - e.x0 + 1) / 4 / (body.x1 - body.x0)).toFixed(3), h: +((e.y1 - e.y0 + 1) / 4 / (body.y1 - body.y0)).toFixed(3) })) : null,
    mouth: mouth ? { cx: +fx(mouth.cx).toFixed(3), cy: +fy(mouth.cy).toFixed(3), w: +((mouth.x1 - mouth.x0 + 1) / 4 / (body.x1 - body.x0)).toFixed(3), h: +((mouth.y1 - mouth.y0 + 1) / 4 / (body.y1 - body.y0)).toFixed(3) } : null,
  });
}
const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const withEyes = rows.filter(r => r.eyes) as Array<{ eyes: Array<{ cx: number; cy: number; w: number; h: number }>; mouth: { cx: number; cy: number; w: number; h: number } | null }>;
const summary = {
  prints: rows.length, withEyes: withEyes.length,
  eyeDx: med(withEyes.map(r => (r.eyes[1]!.cx - r.eyes[0]!.cx) / 2)), eyeCy: med(withEyes.map(r => (r.eyes[0]!.cy + r.eyes[1]!.cy) / 2)),
  eyeW: med(withEyes.flatMap(r => r.eyes.map(e => e.w))), eyeH: med(withEyes.flatMap(r => r.eyes.map(e => e.h))),
  mouthCy: med(withEyes.filter(r => r.mouth).map(r => r.mouth!.cy)), mouthW: med(withEyes.filter(r => r.mouth).map(r => r.mouth!.w)), mouthH: med(withEyes.filter(r => r.mouth).map(r => r.mouth!.h)),
};
writeFileSync(`${out}/measure.json`, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
