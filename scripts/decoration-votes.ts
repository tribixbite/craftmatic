/**
 * Learn which print a source's own head DECORATION id is, from the same sets' print-naming conversions (FIG-04).
 *
 * Two lineages place a printed head as its plain mould and keep the face only as an id of their own: an old LDD
 * `.lxf` (`decoration="59717"`, `ParsedBrick.lddDecoration`) and a Mecabricks scene (`3626d1299`, read back by
 * clego `geograde/mb_head_decorations.py`). Many of those sets also have a conversion that NAMES its prints (an OMR
 * model, an IOModel2V2 or DBIX conversion). The face-transfer matcher (`scripts/face-transfer.ts`, unambiguous,
 * mutual figure matches only) pairs a figure of the target with the same figure of that donor; each accepted pair
 * is a VOTE "decoration D is print P". A decoration becomes a row only when `VOTE_MIN_SETS` different sets agree
 * and the rival prints together hold at most `VOTE_MAX_RIVAL_SHARE` of its sets (`acceptVotes`; the same rule
 * `gen-ldd-print-map.py` applies to the LDD tally).
 */
import { existsSync, readdirSync } from 'node:fs';
import { faceKey } from '../web/src/engine/head-face.ts';
import { getDatText } from '../web/src/engine/ldraw-geometry.ts';
import { type LdrawPartMesh, type PartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { colourKeyFor, decideTransfers, figureMeshes, figureSignatures, printFitsHead } from './face-transfer.ts';
import { loadModelBricks } from './model-source.ts';

export const CORPUS = 'C:/git/clego/lego_sets';
/**
 * Folders whose files may NAME a head's print (the donors). `LDR/<set>_eurobricks.ldr` and `EurobricksLDR` are
 * conversions of an `.lxf` and name nothing it does not; the Studio `IO/<set>-1.io` files hold no assembled
 * figures (0 matches over 19 census sets), so neither is read.
 */
export const DONOR_DIRS = ['OMR', 'IOModel2V2', 'DbixConvV3', 'DbixConvV2', 'LDR'];
const SAME_LINEAGE = /_eurobricks/i;

/** A voted decoration needs this many DIFFERENT sets agreeing on its print... */
export const VOTE_MIN_SETS = 2;
/** ...and every rival print together holds at most this share of the winner's sets (a wrong face is worse). */
export const VOTE_MAX_RIVAL_SHARE = 0.25;
/**
 * The plain smile is what a model author draws when the real print is missing (75052 and 75053 both "voted" a
 * Star Wars face as 3626p01), so a vote for it counts only from this many sets.
 */
export const VOTE_PLACEHOLDER_PRINTS: Readonly<Record<string, number>> = { '3626p01': 5 };

/** The set number a corpus file name starts with (`7476_eurobricks.lxf`, `7476-1.mpd`, `7476 Iron Predator.ldr`). */
export const setOfFile = (name: string): string | null => /^(\d{3,7})(?=[-_. ]|$)/.exec(name)?.[1] ?? null;

/** One accepted pairing, the unit a vote is counted in. */
export interface DecorationVote {
  decoration: string; print: string; part?: string; set: string; target: string; donor: string; score: number;
  /** The target head's brick index, so a vote can be applied to the very head the matcher paired. */
  head?: number;
}

/** decoration -> print key -> the distinct sets that voted it and the donor part names (library prints) seen. */
export type VoteTally = Record<string, Record<string, { sets: string[]; parts: string[] }>>;

/** Corpus files per set number, from `dirs`, keeping names `keep` accepts (and only `only` sets when non-empty). */
export function filesBySet(dirs: readonly string[], keep: (name: string) => boolean, only: ReadonlySet<string> = new Set()): Map<string, string[]> {
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

/** The print-naming donors per set (`DONOR_DIRS`, text sources, the `.lxf` lineage left out). */
export const donorFilesBySet = (only: ReadonlySet<string> = new Set()): Map<string, string[]> =>
  filesBySet(DONOR_DIRS, f => /\.(ldr|mpd)$/i.test(f) && !SAME_LINEAGE.test(f), only);

export interface CollectOptions {
  /** Target files per set: the conversions whose heads carry a decoration id. */
  targets: Map<string, string[]>;
  /** Donor files per set (`donorFilesBySet`). */
  donors: Map<string, string[]>;
  /** Each decorated head's decoration id, by brick index, for one loaded target. */
  decorationsOf: (path: string, bricks: readonly ParsedBrick[]) => Map<number, string>;
  provider: PartGeometryProvider;
  /** Progress line every 25 sets. */
  log?: (line: string) => void;
}

export interface CollectResult { votes: DecorationVote[]; heads: number; decorated: number }

/**
 * Every vote the matcher accepts over the sets that have both a target and a donor. A set's donors are parsed
 * first: one whose donors name no print costs no target parse.
 */
export async function collectVotes(o: CollectOptions): Promise<CollectResult> {
  const log = o.log ?? (() => {});
  const sets = [...o.targets.keys()].filter(s => o.donors.has(s));
  const votes: DecorationVote[] = [];
  let heads = 0, decorated = 0;
  type Loaded = { bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh | null>; space: 'bl' | 'ldraw' };
  const loaded = new Map<string, Loaded | null>();
  const load = async (path: string): Promise<Loaded | null> => {
    if (loaded.has(path)) return loaded.get(path)!;
    let v: Loaded | null = null;
    try {
      const m = await loadModelBricks(`${CORPUS}/${path}`);
      v = { bricks: m.bricks, meshes: await figureMeshes(m.bricks, o.provider, getDatText), space: m.colorSpace };
    } catch (e) { log(`  unreadable ${path}: ${e instanceof Error ? e.message : String(e)}`); }
    loaded.set(path, v);
    return v;
  };
  for (const [i, set] of sets.entries()) {
    const named: Array<{ path: string; sigs: ReturnType<typeof figureSignatures>; space: 'bl' | 'ldraw' }> = [];
    for (const path of o.donors.get(set)!) {
      const d = await load(path);
      if (!d) continue;
      const sigs = figureSignatures(d.bricks, d.meshes, colourKeyFor(d.space, true));
      if (sigs.some(s => s.print)) named.push({ path, sigs, space: d.space });
    }
    loaded.clear();
    if (named.length) {
      for (const target of o.targets.get(set)!) {
        const t = await load(target);
        loaded.delete(target);
        if (!t) continue;
        const deco = o.decorationsOf(target, t.bricks);
        const tSigsExact = figureSignatures(t.bricks, t.meshes, colourKeyFor(t.space, true));
        heads += tSigsExact.length;
        decorated += tSigsExact.filter(s => deco.has(s.head)).length;
        if (!tSigsExact.some(s => deco.has(s.head))) continue;
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
            const decoration = deco.get(dec.head);
            if (!dec.print || !decoration) continue;
            votes.push({ decoration, print: faceKey(dec.print), ...(dec.part ? { part: dec.part } : {}), set, target, donor: donor.path, score: Number(dec.score!.toFixed(3)), head: dec.head });
          }
        }
      }
    }
    if ((i + 1) % 25 === 0) log(`  ${i + 1}/${sets.length} sets, ${votes.length} votes`);
  }
  return { votes, heads, decorated };
}

/** Per decoration: distinct SETS per print (a set's two targets or two donors are one piece of evidence). */
export function tallyVotes(votes: readonly DecorationVote[]): VoteTally {
  const tally: VoteTally = {};
  for (const v of votes) {
    const row = (tally[v.decoration] ??= {});
    const cell = (row[v.print] ??= { sets: [], parts: [] });
    if (!cell.sets.includes(v.set)) cell.sets.push(v.set);
    if (v.part && !cell.parts.includes(v.part)) cell.parts.push(v.part);
  }
  return Object.fromEntries(Object.entries(tally).sort(([a], [b]) => a.localeCompare(b)));
}

/** A decoration's accepted print, with the donor part names that drew it, or why it is refused. */
export type VoteVerdict =
  | { decoration: string; print: string; sets: number; rivals: number; parts: string[] }
  | { decoration: string; refused: string; sets: number; rivals: number };

/**
 * The rule a tally row must pass to become a print (the same rule `gen-ldd-print-map.py` applies to the LDD
 * tally): the winner in at least `VOTE_MIN_SETS` sets (`VOTE_PLACEHOLDER_PRINTS` for the smile), the rivals in at
 * most `VOTE_MAX_RIVAL_SHARE` of that.
 */
export function acceptVotes(tally: VoteTally, minSets = VOTE_MIN_SETS): VoteVerdict[] {
  const out: VoteVerdict[] = [];
  for (const [decoration, prints] of Object.entries(tally)) {
    const ranked = Object.entries(prints).sort((a, b) => b[1].sets.length - a[1].sets.length || a[0].localeCompare(b[0]));
    const [key, win] = ranked[0]!;
    const n = win.sets.length;
    const rivals = ranked.slice(1).reduce((s, [, r]) => s + r.sets.length, 0);
    const need = Math.max(minSets, VOTE_PLACEHOLDER_PRINTS[key] ?? 0);
    if (n < need) out.push({ decoration, refused: `${n} of ${need} sets for ${key}`, sets: n, rivals });
    else if (rivals > VOTE_MAX_RIVAL_SHARE * n) out.push({ decoration, refused: `contested: ${key} in ${n} sets, rivals in ${rivals}`, sets: n, rivals });
    else out.push({ decoration, print: key, sets: n, rivals, parts: win.parts });
  }
  return out;
}
