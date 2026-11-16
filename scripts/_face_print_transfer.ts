/**
 * Carry head print ids onto a set's first-pick source from the same set's other conversions (audit 2026-11-15 A-10,
 * TODO(face-source-transfer); the matching rule is `scripts/face-transfer.ts`).
 *
 * Usage: bun scripts/_face_print_transfer.ts [set…] [--json=OUT] [--write=DIR]
 *   (no sets)    the 40 favourites
 *   --json=OUT   every decision per set: accepted (head, print, donor, score) and refused (head, reason)
 *   --write=DIR  write each patched first pick to DIR/<its corpus path>, a `0 !CRAFTMATIC HEAD_PRINT <id>` line
 *                inserted before every accepted head. Only a FLAT text source is written (each head's type-1 line
 *                found once by part and position); an `.io`/`.lxf` first pick, or a head inside a submodel, is
 *                reported, never written.
 * Reads the corpus and libraries as a CLI build does (Studio's install, then clego's `ldraw_ref/`). Offline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setLDrawRoot, getDatText } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, descriptionOf, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { ldrawColorToBlock } from '../web/src/engine/ldraw-colors.ts';
import { studioColorToBlock } from '../web/src/engine/studio-colors.ts';
import { indexedTryOrder } from '../web/src/engine/lego-sources.ts';
import { FAVOURITES, readModelsIndex } from './favourite-sets.ts';
import { loadModelBricks } from './model-source.ts';
import { decideTransfers, figureSignatures, printFitsHead, type FigureSig } from './face-transfer.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync('C:/git/clego/ldraw_ref')) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';
process.env.CRAFTMATIC_LDRAW_MIRROR ??= 'off';
const CORPUS = 'C:/git/clego/lego_sets';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sets = argv.filter(a => !a.startsWith('--'));
const index = readModelsIndex();
const provider = createPartGeometryProvider();

/** Description words of the parts a figure group can hold; only these are meshed (a 7,000-part set has ~20 heads). */
const FIGURE_WORDS = /minifig|mini ?doll|minifigure|torso|hair|head|helmet|hat\b|cap\b|hood|hips|legs?\b|arm|hand|wig|bigfig|figure|skirt/i;

async function meshesFor(bricks: ParsedBrick[]): Promise<Map<string, LdrawPartMesh | null>> {
  const meshes = new Map<string, LdrawPartMesh | null>();
  for (const b of bricks) {
    if (meshes.has(b.part)) continue;
    const text = await getDatText(b.part);
    meshes.set(b.part, text !== null && FIGURE_WORDS.test(descriptionOf(text)) ? await provider.getPartMesh(b.part) : null);
  }
  return meshes;
}

interface Loaded { path: string; bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh | null>; space: 'bl' | 'ldraw' }
async function load(path: string): Promise<Loaded | null> {
  const file = `${CORPUS}/${path}`;
  if (!existsSync(file)) return null;
  const m = await loadModelBricks(file);
  return { path, bricks: m.bricks, meshes: await meshesFor(m.bricks), space: m.colorSpace };
}

/** Exact colour codes within one colour space; Minecraft block names across two (the common, coarser space). */
const colourKeyFor = (space: 'bl' | 'ldraw', exact: boolean) => (c: number): string =>
  exact ? `c${c}` : (space === 'bl' ? studioColorToBlock(c) : ldrawColorToBlock(c));

interface Accepted { head: number; part: string; at: [number, number, number]; print: string; donor: string; score: number; rename?: string }
interface Refused { head: number; part: string; reason: string }
const report: Record<string, { first: string; heads: number; plain: number; accepted: Accepted[]; refused: Refused[]; written?: string; note?: string }> = {};

for (const set of sets.length ? sets : FAVOURITES) {
  const entry = index[set];
  const models = entry?.models ?? [];
  if (!models.length) continue;
  const order = indexedTryOrder(models, entry!.catalogParts ?? entry!.parts);
  const firstPath = models[order[0]!]!.path;
  const target = await load(firstPath);
  if (!target) { console.log(`${set}: first pick ${firstPath} missing`); continue; }
  const tSigsExact = new Map<string, FigureSig[]>();
  const accepted = new Map<number, Accepted>();
  const refusals = new Map<number, string[]>();
  const conflicts = new Set<number>();
  let plain = 0, heads = 0;
  for (const k of order.slice(1)) {
    const donor = await load(models[k]!.path);
    if (!donor) continue;
    const exact = donor.space === target.space;
    const key = `${exact}`;
    if (!tSigsExact.has(key)) tSigsExact.set(key, figureSignatures(target.bricks, target.meshes, colourKeyFor(target.space, exact)));
    const tSigs = tSigsExact.get(key)!;
    heads = tSigs.length;
    plain = tSigs.filter(s => !s.print).length;
    const dSigs = figureSignatures(donor.bricks, donor.meshes, colourKeyFor(donor.space, exact));
    if (!dSigs.some(s => s.print)) continue;
    for (const d of decideTransfers(tSigs, dSigs, (h, p) => printFitsHead(target.bricks[h]!.part, p))) {
      if (d.print) {
        const prev = accepted.get(d.head);
        if (prev && prev.print !== d.print) conflicts.add(d.head);
        else if (!prev) {
          const b = target.bricks[d.head]!;
          accepted.set(d.head, { head: d.head, part: b.part, at: [b.x, b.y, b.z], print: d.print, donor: donor.path, score: Number(d.score!.toFixed(3)), ...(d.part ? { rename: `${d.part}.dat` } : {}) });
        }
      } else {
        refusals.set(d.head, [...(refusals.get(d.head) ?? []), `${donor.path}: ${d.refused}`]);
      }
    }
  }
  for (const h of conflicts) { accepted.delete(h); refusals.set(h, [...(refusals.get(h) ?? []), 'donors disagree']); }
  const refused: Refused[] = [...refusals].filter(([h]) => !accepted.has(h))
    .map(([h, r]) => ({ head: h, part: target.bricks[h]!.part, reason: r.join(' | ') }));
  const rec: (typeof report)[string] = { first: firstPath, heads, plain, accepted: [...accepted.values()], refused };
  const out = opt('write');
  if (out && accepted.size) {
    if (!/\.(ldr|mpd|l3b)$/i.test(firstPath)) rec.note = 'first pick is not a text source: not written';
    else {
      const raw = readFileSync(`${CORPUS}/${firstPath}`, 'utf8');
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      const lines = raw.split(eol);
      const at = new Map<number, string>();
      const renamed = new Map<number, string>();
      let ok = true;
      for (const a of accepted.values()) {
        const hits = lines.map((l, i) => [l.trim().split(/\s+/), i] as const).filter(([t]) => t.length >= 15 && t[0] === '1'
          && t.slice(14).join(' ').toLowerCase() === a.part.toLowerCase()
          && Math.abs(Number(t[2]) - a.at[0]) < 1e-3 && Math.abs(Number(t[3]) - a.at[1]) < 1e-3 && Math.abs(Number(t[4]) - a.at[2]) < 1e-3);
        if (hits.length !== 1 || /HEAD_PRINT/.test(lines[hits[0]![1] - 1] ?? '')) { ok = false; rec.note = `head ${a.head} has ${hits.length} matching lines (or a HEAD_PRINT already): not written`; break; }
        // A library print is placed by NAME (the head mould family shares one origin); any other print rides on a meta.
        if (a.rename) {
          const t = hits[0]![0];
          renamed.set(hits[0]![1], [...t.slice(0, 14), a.rename].join(' '));
        } else at.set(hits[0]![1], `0 !CRAFTMATIC HEAD_PRINT ${a.print}`);
      }
      if (ok) {
        const patched = lines.flatMap((l, i) => at.has(i) ? [at.get(i)!, l] : [renamed.get(i) ?? l]);
        const dst = join(out, firstPath);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, patched.join(eol));
        rec.written = dst;
      }
    }
  }
  report[set] = rec;
  console.log(`${set.padEnd(7)} heads ${String(heads).padStart(3)} plain ${String(plain).padStart(3)} accepted ${String(accepted.size).padStart(3)} refused ${String(refused.length).padStart(3)}  ${firstPath}${rec.note ? '  [' + rec.note + ']' : ''}`);
}
const tot = (k: 'accepted' | 'refused'): number => Object.values(report).reduce((s, r) => s + r[k].length, 0);
console.log(`total accepted ${tot('accepted')} refused ${tot('refused')}`);
const json = opt('json');
if (json) writeFileSync(json, JSON.stringify(report, null, 1));
