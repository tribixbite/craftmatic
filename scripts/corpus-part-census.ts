/**
 * Corpus part census for the master-add-on audit.
 *
 * Walks every set's `models[0]` in the shipped index
 * (web/public/lego-models-index.json), parses it with the repo's own parsers
 * (LDraw .ldr/.mpd, .io via extractIoModel, .lxf via the CLI's DOM shim) and
 * records, per LDraw part id, how many placements and how many sets use it.
 * Also records per-set placement / distinct-part counts and the full placement
 * list for one set (71043) so an assembly manifest can be sized.
 *
 * Run from C:/git/craftmatic:  bun scripts/corpus-part-census.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { normPartId, printBaseId } from '../web/src/engine/ldraw-part-geometry.ts';

const ROOT = 'C:/git/clego/lego_sets/';
const OUT = process.env.CENSUS_OUT ?? 'output/master-addon-audit/corpus-part-census.json';
const MANIFEST_SET = process.env.MANIFEST_SET ?? '71043';

// ── DOM shim + public-asset fetch for the .lxf parser (copied from scripts/_playable_ref.ts) ──
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
function installPublicAssetFetch(): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/')) {
      const body = readFileSync(`C:/git/craftmatic/web/public${url}`, 'utf8');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
}
installXmlDomShim();
installPublicAssetFetch();
const { parseLxfWithDiagnostics } = await import('../web/src/engine/lxf-parser.ts');

async function loadBricks(path: string): Promise<ParsedBrick[]> {
  const full = ROOT + path;
  if (/\.lxf(ml)?$/i.test(path)) {
    const b = readFileSync(full);
    const parsed = await parseLxfWithDiagnostics(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    return parsed.bricks;
  }
  let text: string;
  if (/\.io$/i.test(path)) {
    const b = readFileSync(full);
    const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    text = io.text;
  } else text = readFileSync(full, 'utf8');
  return parseLDrawDocument(synthesizeLSynth(text).text).bricks;
}

/** True when a 3x3 matrix is a signed permutation within tolerance (one of the 24 proper / 48 improper axis-aligned rotations). */
function isSignedPermutation(rot: number[] | undefined, tol = 0.01): boolean {
  if (!rot) return true;
  for (let r = 0; r < 3; r++) {
    let ones = 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.abs(rot[r * 3 + c]!);
      if (Math.abs(v - 1) < tol) ones++;
      else if (v > tol) return false;
    }
    if (ones !== 1) return false;
  }
  return true;
}

interface PartStat { placements: number; sets: number }
const index = JSON.parse(readFileSync('C:/git/craftmatic/web/public/lego-models-index.json', 'utf8')) as {
  sets: Record<string, { name: string; parts: number; models: Array<{ src: string; path: string; n: number }> }>;
};
const parts = new Map<string, PartStat>();
const bases = new Map<string, PartStat>();
const pairs = new Map<string, number>(); // `part|colour` -> placements, for the block-permutation count
let alignedTotal = 0; let placementsTotal = 0;
const triples = new Map<string, number>(); // `part|rotcode|colour` over AXIS-ALIGNED placements: the block types a colour-as-type block route needs
const rotCode = (rot: number[] | undefined): string => rot ? rot.map(v => Math.abs(v) < 0.01 ? '0' : v > 0 ? '+' : '-').join('') : 'I';
const perSet: Record<string, { src: string; placements: number; distinct: number; distinctBase: number; aligned: number; colours: number; ids?: Record<string, number> }> = {};
const failures: Record<string, string> = {};
let manifest: { placements: Array<{ part: string; color: number; x: number; y: number; z: number; rot: number[] | null }> } | null = null;

const ids = Object.keys(index.sets);
const t0 = Date.now();
let done = 0;
for (const id of ids) {
  const set = index.sets[id]!;
  const m = set.models[0];
  if (!m) continue;
  let bricks: ParsedBrick[];
  try { bricks = await loadBricks(m.path); } catch (e) { failures[id] = `${m.path}: ${(e as Error).message}`; continue; }
  const seenPart = new Set<string>(); const seenBase = new Set<string>(); const colours = new Set<number>();
  let aligned = 0;
  for (const b of bricks) {
    const p = normPartId(b.part);
    const base = printBaseId(p) ?? p;
    colours.add(b.color);
    if (isSignedPermutation(b.rot)) aligned++;
    pairs.set(`${p}|${b.color}`, (pairs.get(`${p}|${b.color}`) ?? 0) + 1);
    if (isSignedPermutation(b.rot)) { const k = `${p}|${rotCode(b.rot)}|${b.color}`; triples.set(k, (triples.get(k) ?? 0) + 1); }
    const ps = parts.get(p) ?? { placements: 0, sets: 0 };
    ps.placements++; if (!seenPart.has(p)) { ps.sets++; seenPart.add(p); }
    parts.set(p, ps);
    const bs = bases.get(base) ?? { placements: 0, sets: 0 };
    bs.placements++; if (!seenBase.has(base)) { bs.sets++; seenBase.add(base); }
    bases.set(base, bs);
  }
  alignedTotal += aligned; placementsTotal += bricks.length;
  perSet[id] = { src: m.src, placements: bricks.length, distinct: seenPart.size, distinctBase: seenBase.size, aligned, colours: colours.size };
  if (process.env.CENSUS_IDS) { const c: Record<string, number> = {}; for (const b of bricks) { const p = normPartId(b.part); c[p] = (c[p] ?? 0) + 1; } perSet[id]!.ids = c; }
  if (id === MANIFEST_SET) {
    manifest = { placements: bricks.map(b => ({ part: normPartId(b.part), color: b.color, x: b.x, y: b.y, z: b.z, rot: b.rot ?? null })) };
  }
  done++;
  if (done % 500 === 0) console.error(`${done}/${ids.length} sets, ${parts.size} distinct ids, ${Math.round((Date.now() - t0) / 1000)} s`);
}
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  sets: done, failures,
  parts: Object.fromEntries(parts), bases: Object.fromEntries(bases), perSet, manifest,
  pairs: pairs.size, alignedTotal, placementsTotal, triples: triples.size,
  pairsByPart: process.env.CENSUS_PAIRS ? Object.fromEntries(pairs) : undefined, triplesByKey: process.env.CENSUS_PAIRS ? Object.fromEntries(triples) : undefined,
}));
console.error(`done: ${done} sets, ${Object.keys(failures).length} failures, ${parts.size} distinct part ids, ${bases.size} distinct base ids, ${Math.round((Date.now() - t0) / 1000)} s -> ${OUT}`);
