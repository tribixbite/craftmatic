/**
 * Loading a model source and face art in a CLI script, the same way the LEGO tab does: shared by
 * `_playable_ref.ts` (the pack build) and `_face_census.ts` (which heads a favourite names and what face each gets),
 * so the census reads exactly the bricks the build exports.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts } from '../web/src/engine/ldraw-geometry.ts';

/**
 * Decode an 8-bit, non-interlaced RGB/RGBA PNG (what `gen-face-art.py` writes)
 * to RGBA. Anything else is refused by name rather than misread.
 */
export function decodePngRgba(bytes: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8, width = 0, height = 0, colourType = 0;
  const idat: Buffer[] = [];
  while (at < bytes.length) {
    const len = bytes.readUInt32BE(at), type = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colourType = data[9]!;
      if (data[8] !== 8 || data[12] !== 0 || (colourType !== 6 && colourType !== 2)) throw new Error(`unsupported PNG (depth ${data[8]}, colour ${colourType}, interlace ${data[12]})`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const bpp = colourType === 6 ? 4 : 3, stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= bpp ? px[y * stride + x - bpp]! : 0, b = y ? px[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  if (bpp === 4) return { width, height, rgba: px };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) { rgba.set(px.subarray(i * 3, i * 3 + 3), i * 4); rgba[i * 4 + 3] = 255; }
  return { width, height, rgba };
}

// ── Bun shims for the `.lxf` path ──────────────────────────────────────
/**
 * The smallest XML DOM `lxf-parser.ts` actually uses: `querySelectorAll(tag)`
 * over descendants, `querySelector(tag)` and `getAttribute(name)`. LXFML is
 * machine-generated (double-quoted attributes, no CDATA, no namespaces), so a
 * tag-level tokenizer is exact for it — and the part count is checked against
 * the model's own placement total, which would expose any miss.
 */
export function installXmlDomShim(): void {
  if (typeof (globalThis as { DOMParser?: unknown }).DOMParser !== 'undefined') return;
  interface XmlNode { tag: string; attrs: Record<string, string>; children: XmlNode[] }
  const wrap = (n: XmlNode) => ({
    getAttribute: (name: string): string | null => n.attrs[name] ?? null,
    querySelectorAll: (tag: string) => descendants(n, tag).map(wrap),
    querySelector: (tag: string) => { const hit = descendants(n, tag)[0]; return hit ? wrap(hit) : null; },
    get textContent(): string { return ''; },
  });
  const descendants = (n: XmlNode, tag: string): XmlNode[] => {
    const out: XmlNode[] = [];
    const walk = (x: XmlNode) => { for (const c of x.children) { if (c.tag === tag) out.push(c); walk(c); } };
    walk(n);
    return out;
  };
  const TAG = /<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  const ATTR = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
    parseFromString(xml: string) {
      // Comments, the XML declaration and DOCTYPE carry no elements.
      const src = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[^>]*>/gi, '');
      const root: XmlNode = { tag: '#document', attrs: {}, children: [] };
      const stack: XmlNode[] = [root];
      TAG.lastIndex = 0;
      for (let m = TAG.exec(src); m; m = TAG.exec(src)) {
        const [, closing, tag, attrText, selfClose] = m;
        if (closing) {
          if (stack.length > 1 && stack[stack.length - 1]!.tag === tag) stack.pop();
          continue;
        }
        const attrs: Record<string, string> = {};
        ATTR.lastIndex = 0;
        for (let a = ATTR.exec(attrText ?? ''); a; a = ATTR.exec(attrText ?? '')) attrs[a[1]!] = a[2]!;
        const node: XmlNode = { tag: tag!, attrs, children: [] };
        stack[stack.length - 1]!.children.push(node);
        if (!selfClose) stack.push(node);
      }
      return wrap(root);
    }
  };
}

/** Serve the parser's `/ldd-*.json` table fetches from `web/public/`. */
export function installPublicAssetFetch(): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/')) {
      const body = readFileSync(`web/public${url}`, 'utf8');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
}

/** Decoded face art, one entry per `<print id>.png` in a directory (route 2, `scripts/gen-face-art.py`). */
export function readFaceArtDir(dir: string): Array<[string, { width: number; height: number; rgba: Uint8Array }]> {
  return readdirSync(dir).filter(n => /^[0-9a-z]+\.png$/i.test(n))
    .map(n => [n.replace(/\.png$/i, ''), decodePngRgba(readFileSync(join(dir, n)))] as [string, { width: number; height: number; rgba: Uint8Array }]);
}

/** A loaded model: its placements and how the library was seeded for it. */
export interface LoadedModel {
  bricks: ParsedBrick[];
  colorSpace: 'bl' | 'ldraw';
  /** Embedded / custom part texts seeded into the shared cache (they beat the library, as in the viewer). */
  seeded: number;
}

// ── Load the model (same paths as the LEGO tab) ──────────────────────────────
/** Parse `.lxf`, `.io`, `.mpd` or `.ldr` bytes into placements, seeding embedded part texts. */
export async function loadModelBricks(file: string, sourceBytes: Buffer = readFileSync(file)): Promise<LoadedModel> {
  if (/\.lxf(ml)?$/i.test(file)) {
    // `.lxf` is LDD XML in a ZIP. The browser reaches it through
    // `parseLxfWithDiagnostics`, which wants a DOM and fetches its two alignment
    // tables over HTTP — neither exists under Bun, so both are shimmed here (and
    // only here: the engine is untouched).
    installXmlDomShim();
    installPublicAssetFetch();
    const { parseLxfWithDiagnostics, describeLxfDiagnostics } = await import('../web/src/engine/lxf-parser.ts');
    const b = sourceBytes;
    const parsed = await parseLxfWithDiagnostics(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    );
    console.error(`  lxf: ${describeLxfDiagnostics(parsed.diagnostics) ?? 'no alignment notes'}`);
    return { bricks: parsed.bricks, colorSpace: 'ldraw', seeded: 0 };
  }
  let text: string;
  let colorSpace: 'bl' | 'ldraw' = 'ldraw';
  let customParts = new Map<string, string>();
  if (/\.io$/i.test(file)) {
    const b = sourceBytes;
    const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    text = io.text;
    colorSpace = io.colorSpace === 'bl' ? 'bl' : 'ldraw';
    customParts = io.customParts;
  } else {
    text = sourceBytes.toString('utf8');
  }
  const doc = parseLDrawDocument(synthesizeLSynth(text).text);
  // Embedded part definitions beat the library, exactly as the viewer seeds the Worker.
  const seeded = seedDatTexts([...embeddedPartTexts(doc), ...customParts]);
  return { bricks: doc.bricks, colorSpace, seeded };
}
