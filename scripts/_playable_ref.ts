/**
 * Bedrock entity gate: export a model to a playable `.mcaddon` through the REAL
 * shared pipeline (engine/schem-pipeline.ts, the code the LEGO tab's Worker
 * runs) against the local LDraw library, then print the entity diagnostics
 * and the archive's sha256.
 *
 * Usage: bun scripts/_playable_ref.ts <model.io|.mpd|.ldr> [out.mcaddon]
 *          [--quality=balanced|high|ultra] [--mode=auto|car|plane|boat]
 *          [--facing=auto|+x|-x|+z|-z] [--label=<text>] [--no-pbr] [--camera=orbit|boom] [--main-only]
 *          [--buildings=bricks|blocks]   (bricks: the building as a brick-accurate shell entity over colliders)
 *          [--scale=auto|0.25|0.5|0.75|1|1.5|2|3|4]   (model scale as a multiplier of the minifig scale, engine/addon-scale.ts)
 *          [--lod=none|hull] [--lod-distance=N]   (default hull: a resident per-colour surface hull the client draws past N; engine/bedrock-lod-hull.ts)
 *          [--faces=<dir>]   (face art for heads no LDraw library prints: <part>.png per head, scripts/gen-face-art.py)
 *          [--figure-collision-height=N]   (experimental override for a figure NPC's minecraft:collision_box.height, default computed/clamped 1.0-1.8; device-919 roaming experiment)
 *
 * Output defaults to output/bedrock-entity-qa/<stem>.mcaddon (gitignored).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { seedFaceArt } from '../web/src/engine/head-face.ts';
import { createHash } from 'node:crypto';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.ts';
import { planResolution, planResolutionAtCell, spanOfBricks, DEFAULT_SCHEM_SETTINGS } from '../web/src/engine/schem-settings.ts';
import { planAddonScale, type AddonScaleChoice } from '../web/src/engine/addon-scale.ts';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.ts';
import { modelExportStem } from '../web/src/engine/export-name.ts';
import { sourceHash12, type SourceProvenance } from '../web/src/engine/pipeline-version.ts';
import { computePipelineStamp } from './pipeline-stamp.ts';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
setLDrawRoot(LDRAW_ROOT);

/**
 * Decode an 8-bit, non-interlaced RGB/RGBA PNG (what `gen-face-art.py` writes)
 * to RGBA. Anything else is refused by name rather than misread.
 */
function decodePngRgba(bytes: Buffer): { width: number; height: number; rgba: Uint8Array } {
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

// `--faces=<dir>`: face ART (route 2, `scripts/gen-face-art.py`) for heads no
// LDraw library prints, one `<part>.png` per head name (`3626cpb3484.png`).
// The compiler draws it on the head as a texture (engine/head-face.ts).
const facesDir = process.argv.find(a => a.startsWith('--faces='))?.slice('--faces='.length);
if (facesDir) {
  const art = readdirSync(facesDir).filter(n => /^[0-9a-z]+\.png$/i.test(n))
    .map(n => [n.replace(/\.png$/i, ''), decodePngRgba(readFileSync(join(facesDir, n)))] as [string, { width: number; height: number; rgba: Uint8Array }]);
  console.error(`[faces] seeded ${seedFaceArt(art)} face art from ${facesDir}`);
}

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = positional[0];
if (!file) { console.error('usage: bun scripts/_playable_ref.ts <model> [out.mcaddon] [--quality=…] [--mode=…] [--facing=…] [--label=…] [--no-pbr]'); process.exit(2); }
const quality = (flag('quality') ?? 'balanced') as 'balanced' | 'high' | 'ultra';
const vehicleMode = (flag('mode') ?? 'auto') as 'auto' | 'car' | 'plane' | 'boat' | 'static';
const vehicleFacing = (flag('facing') ?? 'auto') as 'auto' | '+x' | '-x' | '+z' | '-z';
const cameraStyle = (flag('camera') ?? 'orbit') as 'orbit' | 'boom';
const setMatch = /(\d{4,6})(?:-\d)?/.exec(basename(file));
// `setNum` — NOT `setNumber`: the misspelt key was silently dropped (scripts/ is
// outside both tsconfigs, so no excess-property check caught it) and every
// Hogwarts set exported as the bare stem `Hogwarts`, pack id `hogwarts`.
const stem = modelExportStem({ name: flag('label') ?? basename(file).replace(/\.[^.]+$/, ''), setNum: setMatch?.[0] });
const label = flag('label') ?? basename(file).replace(/\.[^.]+$/, '');
const out = positional[1] ?? `output/bedrock-entity-qa/${stem}.mcaddon`;
mkdirSync(out.replace(/[\\/][^\\/]*$/, ''), { recursive: true });

// ── Bun shims for the `.lxf` path ──────────────────────────────────────
/**
 * The smallest XML DOM `lxf-parser.ts` actually uses: `querySelectorAll(tag)`
 * over descendants, `querySelector(tag)` and `getAttribute(name)`. LXFML is
 * machine-generated (double-quoted attributes, no CDATA, no namespaces), so a
 * tag-level tokenizer is exact for it — and the part count is checked against
 * the model's own placement total, which would expose any miss.
 */
function installXmlDomShim(): void {
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
function installPublicAssetFetch(): void {
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

// ── Load the model (same paths as the LEGO tab) ──────────────────────────────
let colorSpace: 'bl' | 'ldraw' = 'ldraw';
let customParts = new Map<string, string>();
let seeded = 0;
let bricks: ParsedBrick[];
// Pack provenance (engine/pipeline-version.ts): the source file's sha256/12 —
// the model index's convention, over the bytes on disk — and the pipeline
// stamp computed from THIS working tree (the browser gets it injected by Vite).
const sourceBytes = readFileSync(file);
const sourceProvenance: SourceProvenance = { file: basename(file), hash: sourceHash12(sourceBytes), origin: 'cli', path: file, ...(setMatch ? { setNum: setMatch[0] } : {}) };
const { closure: _closure, ...pipelineStamp } = computePipelineStamp();
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
  bricks = parsed.bricks;
  console.error(`  lxf: ${describeLxfDiagnostics(parsed.diagnostics) ?? 'no alignment notes'}`);
} else {
  let text: string;
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
  seeded = seedDatTexts([...embeddedPartTexts(doc), ...customParts]);
  bricks = doc.bricks;
}

// One plan drives the block cell AND the entity scale (ui/schem-export.ts does the same).
const scalePlan = planAddonScale(bricks, (flag('scale') as AddonScaleChoice | undefined) ?? 'auto', label);
const resolutionFlag = flag('resolution') as 'auto' | 'minifig' | undefined;
const plan = resolutionFlag && resolutionFlag !== 'auto' && resolutionFlag !== 'minifig'
  ? planResolution(spanOfBricks(bricks), resolutionFlag)
  : planResolutionAtCell(spanOfBricks(bricks), scalePlan.lduPerBlock);
const modelScale = Math.round(LDU_PER_BLOCK / plan.cellLDU * 1000) / 1000;
console.error(`  scale: ${scalePlan.reason} (cell ${Math.round(plan.cellLDU * 100) / 100} LDU, ${modelScale}x)`);
const t0 = Date.now();
const result = await runSchemPipeline({
  source: { kind: 'bricks', bricks, colorSpace, options: { cellLDU: plan.cellLDU, maxDim: 700 } },
  format: 'mcaddon',
  packStem: stem,
  packLabel: label,
  profile: DEFAULT_SCHEM_SETTINGS.profile,
  lightFill: false,
  shapes: false,
  vehicleMode,
  vehicleFacing,
  entityQuality: quality,
  cameraStyle,
  mainVehicleOnly: process.argv.includes('--main-only'),
  buildingFidelity: (flag('buildings') ?? 'bricks') as 'bricks' | 'blocks',
  modelScale,
  lod: (flag('lod') ?? 'hull') as 'none' | 'hull',
  ...(flag('lod-distance') ? { lodDistance: Number(flag('lod-distance')) } : {}),
  ...(flag('figure-collision-height') ? { figureCollisionHeight: Number(flag('figure-collision-height')) } : {}),
  pipelineStamp,
  sourceProvenance,
}, (phase, pct) => { if (process.env.VERBOSE) console.error(`  ${phase}${pct !== undefined ? ` ${pct}%` : ''}`); });
const ms = Date.now() - t0;

writeFileSync(out, result.bytes!);

// ── Pull the diagnostics back out of the archive (proves they shipped) ───────
const { extractFile, listZipEntries } = await import('../web/src/engine/zip-utils.ts');
const bytes = result.bytes!;
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const entries = listZipEntries(buffer);
const diagName = entries.find(e => e.endsWith('/craftmatic-diagnostics.json'));
const diagnostics = diagName ? JSON.parse(new TextDecoder().decode(await extractFile(buffer, diagName))) : null;
// The pack NAMES as Minecraft shows them and the provenance record, read back
// from the archive rather than echoed from the inputs.
const readJson = async (suffix: string): Promise<any> => { const name = entries.find(e => e.endsWith(suffix)); return name ? JSON.parse(new TextDecoder().decode(await extractFile(buffer, name))) : null; };
const bpManifest = await readJson('_BP/manifest.json'), rpManifest = await readJson('_RP/manifest.json');
const provenance = await readJson('/craftmatic-provenance.json');

console.log(JSON.stringify({
  file, stem, label, bricks: bricks.length, embeddedParts: seeded, colorSpace, quality, vehicleMode, vehicleFacing,
  scale: { choice: scalePlan.choice, scale: modelScale, cue: scalePlan.cue, cellLDU: plan.cellLDU, reason: scalePlan.reason },
  packNames: { bp: bpManifest?.header?.name ?? null, rp: rpManifest?.header?.name ?? null, version: bpManifest?.header?.version ?? null },
  provenance,
  components: result.mcpack?.components ?? [],
  warnings: result.mcpack?.warnings ?? [],
  entities: diagnostics?.entities ?? null,
  // The measured walk-through size, read back OUT of the pack's own
  // craftmatic-diagnostics.json - so this prints what shipped, not what the
  // pipeline returned in memory. It is a recommendation: `scale` above is what
  // the pack was actually exported at.
  access: diagnostics?.access ?? null,
  lod: diagnostics?.lod ?? null,
  coaster: diagnostics?.coaster ?? null,
  packBudget: diagnostics?.pack ?? null,
  geoFiles: entries.filter(e => /\.geo\.json$/.test(e)),
  textureSets: entries.filter(e => /\.texture_set\.json$/.test(e)),
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  ms,
  out,
}, null, 1));
