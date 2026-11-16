/**
 * Learn which print an OLD LDD decoration id is, from the corpus itself (generality census 2026-11-16, FIG-04).
 *
 * An LDD `.lxf` places every minifig head as design 3626 with the face as a `decoration` id (`59717`). Studio's
 * `ldraw.xml` names 12 such head decorations, the DBIX element tables name none of the old ones (their decoration
 * ids are a different, 7-digit space), so the corpus's 4,491 decorated head placements in 3,647 `.lxf` files drew
 * the default face: 216 distinct decorations, no table. Many of those sets also have a conversion that NAMES its
 * prints (an OMR model, an IOModel2V2 or DBIX conversion). The face-transfer matcher (`scripts/face-transfer.ts`,
 * unambiguous, mutual figure matches only) pairs a figure of the `.lxf` with the same figure of that source; each
 * accepted pair is a VOTE "decoration D is print P". `gen-ldd-print-map.py` turns a decoration into a `d:` row only
 * when at least `VOTE_MIN_SETS` different sets agree and the rival prints together hold at most
 * `VOTE_MAX_RIVAL_SHARE` of its sets.
 *
 * Usage: bun scripts/_ldd_decoration_votes.ts [--out=scripts/ldd-decoration-votes.json] [--limit=N] [set…]
 * Offline: run with `CRAFTMATIC_LDRAW_MIRROR=off` in the ENVIRONMENT (ldraw-geometry.ts reads it at import, before
 * any line here runs, so setting it below does not stop prod fetches - a run without it sat on HTTPS for 15 minutes).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { faceKey } from '../web/src/engine/head-face.ts';
import { getDatText, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { colourKeyFor, decideTransfers, figureMeshes, figureSignatures, printFitsHead } from './face-transfer.ts';
import { loadModelBricks } from './model-source.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync('C:/git/clego/ldraw_ref')) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';
process.env.CRAFTMATIC_LDRAW_MIRROR ??= 'off';
const CORPUS = 'C:/git/clego/lego_sets';
/** Folders of LDD `.lxf` files (the targets). */
const LXF_DIRS = ['Eurobricks', 'LXF', 'EurobricksTopicLDD', 'EurobricksLDD'];
/**
 * Folders whose files may NAME a head's print (the donors). `LDR/<set>_eurobricks.ldr` and `EurobricksLDR` are
 * conversions of the same `.lxf` and name nothing it does not; the Studio `IO/<set>-1.io` files hold no assembled
 * figures (0 matches over 19 census sets), so neither is read.
 */
const DONOR_DIRS = ['OMR', 'IOModel2V2', 'DbixConvV3', 'DbixConvV2', 'LDR'];
const SAME_LINEAGE = /_eurobricks/i;

/** The set number a corpus file name starts with (`7476_eurobricks.lxf`, `7476-1.mpd`, `7476 Iron Predator.ldr`). */
export const setOfFile = (name: string): string | null => /^(\d{3,7})(?=[-_. ]|$)/.exec(name)?.[1] ?? null;

/** One accepted pairing, the unit a vote is counted in. */
export interface DecorationVote { decoration: string; print: string; part?: string; set: string; lxf: string; donor: string; score: number }

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = new Set(argv.filter(a => !a.startsWith('--')));
const limit = Number(opt('limit') ?? Infinity);
const outPath = opt('out') ?? 'scripts/ldd-decoration-votes.json';

function bySet(dirs: readonly string[], keep: (name: string) => boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of dirs) {
    if (!existsSync(`${CORPUS}/${d}`)) continue;
    for (const f of readdirSync(`${CORPUS}/${d}`).sort()) {
      const s = setOfFile(f);
      if (!s || !keep(f) || (only.size && !only.has(s))) continue;
      out.set(s, [...(out.get(s) ?? []), `${d}/${f}`]);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const provider = createPartGeometryProvider();
  const lxfs = bySet(LXF_DIRS, f => /\.lxf$/i.test(f));
  const donors = bySet(DONOR_DIRS, f => /\.(ldr|mpd)$/i.test(f) && !SAME_LINEAGE.test(f));
  const sets = [...lxfs.keys()].filter(s => donors.has(s)).slice(0, limit);
  console.log(`${lxfs.size} sets with an .lxf, ${sets.length} with a donor that may name prints`);
  const votes: DecorationVote[] = [];
  let lxfHeads = 0, decorated = 0;
  const loaded = new Map<string, { bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh | null>; space: 'bl' | 'ldraw' } | null>();
  const load = async (path: string) => {
    if (loaded.has(path)) return loaded.get(path)!;
    let v: { bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh | null>; space: 'bl' | 'ldraw' } | null = null;
    try {
      const m = await loadModelBricks(`${CORPUS}/${path}`);
      v = { bricks: m.bricks, meshes: await figureMeshes(m.bricks, provider, getDatText), space: m.colorSpace };
    } catch (e) { console.log(`  unreadable ${path}: ${e instanceof Error ? e.message : String(e)}`); }
    loaded.set(path, v);
    return v;
  };
  for (const [i, set] of sets.entries()) {
    // Donors first: a set whose donors name no print costs no .lxf parse.
    const named: Array<{ path: string; sigs: ReturnType<typeof figureSignatures>; space: 'bl' | 'ldraw' }> = [];
    for (const path of donors.get(set)!) {
      const d = await load(path);
      if (!d) continue;
      const sigs = figureSignatures(d.bricks, d.meshes, colourKeyFor(d.space, true));
      if (sigs.some(s => s.print)) named.push({ path, sigs, space: d.space });
    }
    loaded.clear();
    if (!named.length) continue;
    for (const lxf of lxfs.get(set)!) {
      const t = await load(lxf);
      loaded.delete(lxf);
      if (!t) continue;
      const decoOf = (head: number): string | undefined => t.bricks[head]!.lddDecoration;
      const tSigsExact = figureSignatures(t.bricks, t.meshes, colourKeyFor(t.space, true));
      lxfHeads += tSigsExact.length;
      decorated += tSigsExact.filter(s => decoOf(s.head)).length;
      if (!tSigsExact.some(s => decoOf(s.head))) continue;
      for (const donor of named) {
        const exact = donor.space === t.space;
        const tSigs = exact ? tSigsExact : figureSignatures(t.bricks, t.meshes, colourKeyFor(t.space, false));
        // Donor signatures were built exact; rebuild coarse when the spaces differ.
        let dSigs = donor.sigs;
        if (!exact) {
          const d = await load(donor.path);
          if (!d) continue;
          dSigs = figureSignatures(d.bricks, d.meshes, colourKeyFor(d.space, false));
          loaded.delete(donor.path);
        }
        for (const dec of decideTransfers(tSigs, dSigs, (h, p) => printFitsHead(t.bricks[h]!.part, p))) {
          const decoration = decoOf(dec.head);
          if (!dec.print || !decoration) continue;
          votes.push({ decoration, print: faceKey(dec.print), ...(dec.part ? { part: dec.part } : {}), set, lxf, donor: donor.path, score: Number(dec.score!.toFixed(3)) });
        }
      }
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${sets.length} sets, ${votes.length} votes`);
  }
  // Tally per decoration: distinct SETS per print (a set's two .lxf files or two donors are one piece of evidence).
  const tally: Record<string, Record<string, { sets: string[]; parts: string[] }>> = {};
  for (const v of votes) {
    const row = (tally[v.decoration] ??= {});
    const cell = (row[v.print] ??= { sets: [], parts: [] });
    if (!cell.sets.includes(v.set)) cell.sets.push(v.set);
    if (v.part && !cell.parts.includes(v.part)) cell.parts.push(v.part);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({
    generated: 'bun scripts/_ldd_decoration_votes.ts', lxfHeads, decorated, votes: votes.length,
    tally: Object.fromEntries(Object.entries(tally).sort(([a], [b]) => a.localeCompare(b))),
    detail: votes,
  }, null, 1)}\n`);
  console.log(`${lxfHeads} heads in the .lxf files read, ${decorated} with an unprinted decoration; ${votes.length} votes over ${Object.keys(tally).length} decorations -> ${outPath}`);
}

if ((import.meta as { main?: boolean }).main) await main();
