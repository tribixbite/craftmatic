/**
 * How much geometry would per-triangle colour actually change?
 *
 * The export resolver drops the colour code on every type-3/4 line, so a part
 * exports in ONE colour. This counts, over a real model's parts, how many
 * triangles carry an EXPLICIT colour (not 16 = inherit, not 24 = edge) — i.e.
 * how much of the surface is currently mis-coloured.
 *
 * Usage: bun scripts/_tri_color_survey.ts <model.io>
 */
import { readFileSync, existsSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';

const ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const file = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/76416-1.io';
const buf = readFileSync(file);
const io = await extractIoModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const bricks = parseLDraw(synthesizeLSynth(io.text).text);

const cache = new Map<string, string | null>();
function read(id: string): string | null {
  const key = id.split('\\').join('/').toLowerCase().replace(/\.dat$/i, '');
  if (cache.has(key)) return cache.get(key)!;
  const stem = key.split('/').pop()!;
  for (const p of [`${ROOT}/parts/${key}.dat`, `${ROOT}/p/${key}.dat`, `${ROOT}/parts/${stem}.dat`,
                   `${ROOT}/p/${stem}.dat`, `${ROOT}/parts/s/${stem}.dat`]) {
    if (existsSync(p)) { const t = readFileSync(p, 'utf-8'); cache.set(key, t); return t; }
  }
  cache.set(key, null);
  return null;
}

/** Triangles by colour class for one part, recursively (colour 16 = inherit). */
function scan(id: string, inherited: number, depth = 0, seen = new Set<string>()): [number, number] {
  if (depth > 8) return [0, 0];
  const key = id.toLowerCase().replace(/\.dat$/i, '');
  if (seen.has(key)) return [0, 0];
  const text = read(id);
  if (!text) return [0, 0];
  const next = new Set(seen); next.add(key);
  let total = 0, explicit = 0;
  for (const raw of text.split('\n')) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === '3' || t[0] === '4') {
      const n = t[0] === '4' ? 2 : 1;
      const c = +t[1]!;
      const eff = c === 16 ? inherited : c;
      total += n;
      if (eff !== inherited && eff !== 24) explicit += n;
    } else if (t[0] === '1' && t.length >= 15) {
      const c = +t[1]!;
      const [tt, ee] = scan(t.slice(14).join(' ').trim(), c === 16 ? inherited : c, depth + 1, next);
      total += tt; explicit += ee;
    }
  }
  return [total, explicit];
}

const per = new Map<string, [number, number]>();
let tris = 0, expl = 0, partsWithColor = 0;
const uniq = [...new Set(bricks.map(b => b.part))];
for (const part of uniq) {
  const r = scan(part, -1);
  per.set(part, r);
  if (r[1] > 0) partsWithColor++;
}
for (const b of bricks) { const r = per.get(b.part)!; tris += r[0]; expl += r[1]; }
console.log(JSON.stringify({
  file, bricks: bricks.length, uniqueParts: uniq.length,
  uniquePartsWithExplicitColour: partsWithColor,
  triangles: tris, explicitlyColouredTriangles: expl,
  pct: +(expl / Math.max(1, tris) * 100).toFixed(2),
  worstParts: [...per.entries()].filter(e => e[1][1] > 0)
    .sort((a, b) => b[1][1] - a[1][1]).slice(0, 8)
    .map(([p, [t, e]]) => `${p} ${e}/${t}`),
}, null, 1));
