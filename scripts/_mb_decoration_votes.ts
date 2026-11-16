/**
 * Learn which print a MECABRICKS head decoration is, and decide the print of every decorated head in the
 * Mecabricks conversions (generality census 2026-11-16, FIG-04 / PROC-19, TODO(mecabricks-head-decoration)).
 *
 * A Mecabricks scene names a printed head as its own element (`3626d1299` "Mini Head No.2552"); the converter
 * writes the plain mould, so every `MecabricksLDR` head drew the default face. clego's
 * `geograde/mb_head_decorations.py` re-runs the harvest's conversion and records, per shipped file, which type-1
 * line each decorated head became and its decoration id (the texture stem). Nothing in the scene names a BrickLink
 * or LDraw print (the library entry carries the element's name, its `reference` and the texture, measured over the
 * whole cache), so the print is learnt the way `_ldd_decoration_votes.ts` learns an old LDD decoration: the same
 * set's print-naming conversions vote through the face-transfer matcher (`scripts/decoration-votes.ts`).
 *
 * A head gets a print when:
 *   - VOTES: its decoration's tally passes `acceptVotes` (>= 2 sets agree, rivals <= 25 %, the smile from 5), or
 *   - OWN SET: no row passed, but the SAME set's donors matched it to one print, at least one of them a donor whose
 *     vocabulary holds every print (`FULL_VOCABULARY_DONOR`: a DBIX conversion, which is LEGO's own element data, or
 *     an IOModel2V2 conversion of a Studio file, built from BrickLink's catalogue), no donor of the set disagrees and
 *     no other set voted a different print. An OMR / LDR file can only place a print LDraw has, so its author
 *     draws the nearest one: 852751's `LDR` file gave "Wild West Wyldstyle" Leia's `3626bps0`, and six Star Wars
 *     `LDR` files gave their decorated heads the plain smile. Such a vote counts only toward the cross-set table.
 *     Every head of that decoration in the set takes it (the decoration is the element: one face).
 * A head whose own set votes against the accepted row is refused. A print LDraw draws (a donor part of the same
 * head mould, or the LDraw print a BrickLink id names, `printedHeadFor`) is written as a RENAME, any other as a
 * `0 !CRAFTMATIC HEAD_PRINT` meta.
 *
 * Usage: bun scripts/_mb_decoration_votes.ts --decorations=<clego>/geograde/mb_head_decorations.json
 *          [--out=scripts/mb-decoration-votes.json] [--plan=OUT.json] [--holdout=OUT.json] [set…]
 *   --plan     per shipped file, the line, decoration and print of every head to write (clego mb_head_prints.py)
 *   --holdout  precision: every set's own votes judged against the table the OTHER sets' votes give
 *   --names    also the print a head's NAME gives where its set's Rebrickable inventory holds it (mb-head-names.ts)
 *   --from-votes=<votes json>  re-decide from an earlier run's votes (`detail`) instead of running the matcher. Use
 *              it once files are written: a fresh pass would read the metas this plan wrote back as votes.
 * Offline: `CRAFTMATIC_LDRAW_MIRROR=off` in the ENVIRONMENT (read at import).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { faceKey } from '../web/src/engine/head-face.ts';
import { datSubstitutionFor, getDatText, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { printedHeadFor } from '../web/src/engine/ldraw-part-aliases.ts';
import { HEAD_PRINT_LDRAW } from '../web/src/engine/head-print-ldraw.ts';
import { partStem } from '../web/src/engine/part-id.ts';
import { loadRebrickableHeadData, nameChoice, type NameChoice } from './mb-head-names.ts';
import { CORPUS, acceptVotes, collectVotes, donorFilesBySet, setOfFile, tallyVotes, type DecorationVote, type VoteTally } from './decoration-votes.ts';

/** One decorated head of a shipped Mecabricks file, as clego `mb_head_decorations.py` records it. */
export interface MbHeadRow { decoration: string; part: string; at: [number, number, number]; line: number; name?: string; ref?: string; legacy?: boolean }
export interface MbDecorationsDoc { files: Record<string, { heads: MbHeadRow[] }> }

/** Brick index -> its decorated head row, by part stem and position (to 1e-3 LDU) - clego's own test for the line. */
export function attachDecorations(bricks: readonly ParsedBrick[], heads: readonly MbHeadRow[]): Map<number, MbHeadRow> {
  const out = new Map<number, MbHeadRow>();
  for (const h of heads) {
    const stem = partStem(h.part).toLowerCase();
    const hits = bricks.flatMap((b, i) => (partStem(b.part).toLowerCase() === stem
      && Math.abs(b.x - h.at[0]) < 1e-3 && Math.abs(b.y - h.at[1]) < 1e-3 && Math.abs(b.z - h.at[2]) < 1e-3 ? [i] : []));
    if (hits.length === 1) out.set(hits[0]!, h);
  }
  return out;
}

/** A vote placed on one head of one shipped file (`line`, clego's line index). */
export type HeadVote = DecorationVote & { line: number };

/**
 * Votes a shipped file already carries: a decorated head whose line is preceded by a `0 !CRAFTMATIC HEAD_PRINT`
 * meta, written there by `_face_print_transfer.ts` from the same set's donors (76269, 2026-11-15). The matcher
 * skips a head that names a print, so without these the transfer's evidence would not count for its decoration.
 */
export function carriedVotes(set: string, file: string, text: string, heads: readonly MbHeadRow[]): HeadVote[] {
  const lines = text.split(/\r?\n/);
  const out: HeadVote[] = [];
  for (const h of heads) {
    const m = /^0 !CRAFTMATIC HEAD_PRINT (\S+)/.exec(lines[h.line - 1] ?? '');
    if (m) out.push({ decoration: h.decoration, print: faceKey(m[1]!), set, target: file, donor: 'HEAD_PRINT already in the file', score: 1, line: h.line });
  }
  return out;
}

/** The head mould family a part belongs to: a rename never crosses it (3626 / 3626b / 3626c and their prints). */
export const headMould = (part: string): string => {
  const s = partStem(part).toLowerCase().replace(/^bl_/, '');
  if (/^3626/.test(s)) return '3626';
  return /^(\d+)/.exec(s)?.[1] ?? s;
};

/** What to write on one head: the print key, and the library part to rename to when LDraw draws it. */
export interface HeadPrintChoice { print: string; rename?: string }

/**
 * A BrickLink-style print name (`3626cpb1993`): IOModel2V2 / Studio sources place these and craftmatic's alias
 * ladder reads them, but no LDraw library ships the file, so clego's geograde and any stock LDraw tool count it
 * missing (CLAUDE.md "A head's print id rides on a META line"). Never a rename target.
 */
const BRICKLINK_NAME = /^(?:3626[bc]?|28621)pb\d/i;

/**
 * The part a print is DRAWN by on a head of `headPart`'s mould: a donor's library part of the same mould first
 * (the hollow-stud `3626c` print before a `3626b` one: every Mecabricks head after 2008 is the `3626v2` mould),
 * else the LDraw print a BrickLink id names (`printedHeadFor`); else no rename, and a meta carries the print.
 * `exact(name)` says the library holds that very file (not an alias of it).
 */
export function chooseHeadPrint(headPart: string, print: string, donorParts: readonly string[], exact: (part: string) => boolean = () => true): HeadPrintChoice {
  const mould = headMould(headPart);
  const ok = (p: string): boolean => headMould(p) === mould && !BRICKLINK_NAME.test(partStem(p)) && exact(`${partStem(p)}.dat`);
  const donor = [...donorParts].sort((a, b) => Number(/^3626c/i.test(partStem(b))) - Number(/^3626c/i.test(partStem(a)))).find(ok);
  if (donor) return { print, rename: `${partStem(donor)}.dat` };
  const ldraw = /^3626pb\d+[a-z]?$/.test(print) ? printedHeadFor(print) : undefined;
  if (ldraw && ok(ldraw)) return { print, rename: `${ldraw}.dat` };
  // An LDraw-named print key (`3626p8k`, from a donor whose part was another mould): the same print on this mould.
  const lp = /^3626(p(?!b\d)[0-9a-z]+)$/.exec(print);
  if (lp && mould === '3626') for (const m of ['3626c', '3626b']) if (ok(`${m}${lp[1]}`)) return { print, rename: `${m}${lp[1]}.dat` };
  return { print };
}

/** A decision for one decorated head. */
export type HeadDecision =
  | ({ line: number; decoration: string; basis: 'votes' | 'own set' | 'name' } & HeadPrintChoice)
  | { line: number; decoration: string; refused: string };

/**
 * Donor lineages whose part vocabulary holds EVERY print: DBIX conversions (LEGO's element and decoration data)
 * and IOModel2V2 conversions of Studio files (BrickLink's catalogue). OMR / LDR files are limited to LDraw's printed
 * parts, so a print there may be the author's nearest stand-in.
 */
export const FULL_VOCABULARY_DONOR = /^(DbixConv\w*|IOModel2V2)\//;

/** The prints the matcher paired one head with, and those from full-vocabulary donors. */
export interface OwnVotes { any: Set<string>; full: Set<string>; parts: Map<string, Set<string>> }

/** `${file}|${line}` -> the votes cast on that very head. */
export function ownVotesOf(votes: readonly HeadVote[]): Map<string, OwnVotes> {
  const out = new Map<string, OwnVotes>();
  for (const v of votes) {
    const k = `${v.target}|${v.line}`;
    const o = out.get(k) ?? { any: new Set<string>(), full: new Set<string>(), parts: new Map<string, Set<string>>() };
    o.any.add(v.print);
    if (FULL_VOCABULARY_DONOR.test(v.donor)) o.full.add(v.print);
    if (v.part) o.parts.set(v.print, (o.parts.get(v.print) ?? new Set<string>()).add(v.part));
    out.set(k, o);
  }
  return out;
}

/**
 * Every decorated head's decision for one shipped file, given the accepted table (decoration -> print and its
 * donor parts), the tally and the votes cast on each head (`ownVotesOf`). In order:
 *   - donors that paired this head with DIFFERENT prints: refused;
 *   - a full-vocabulary donor paired it with P (and no donor said otherwise): P, `own set` - a direct match of this
 *     very figure, which wins over the table: a Mecabricks author may give one decoration to several faces
 *     (10354's DBIX conversion pairs three heads wearing 3626d1195 with three different prints);
 *   - the decoration's accepted row T: T, `votes`, unless an LDraw-limited donor paired this head with another;
 *   - else refused.
 * Pure: the plan, the holdout and the guard tests all call this.
 */
export function decideHeads(
  file: string, heads: readonly MbHeadRow[], table: ReadonlyMap<string, { print: string; parts: readonly string[] }>, tally: VoteTally,
  own: ReadonlyMap<string, OwnVotes>, exact: (part: string) => boolean = () => true,
  byName?: (head: MbHeadRow) => NameChoice,
): HeadDecision[] {
  return heads.map(h => {
    const at = { line: h.line, decoration: h.decoration };
    const mine = own.get(`${file}|${h.line}`);
    if (mine && mine.any.size > 1) return { ...at, refused: `donors pair this head with ${[...mine.any].join('/')}` };
    const direct = mine ? [...mine.any][0]! : undefined;
    if (direct && mine!.full.has(direct)) {
      return { ...at, basis: 'own set' as const, ...chooseHeadPrint(h.part, direct, [...(mine!.parts.get(direct) ?? [])], exact) };
    }
    const named = byName?.(h);
    const accepted = table.get(h.decoration);
    if (accepted) {
      if (named && 'print' in named && faceKey(named.print) !== faceKey(accepted.print)) {
        return { ...at, refused: `its name gives ${named.print} (${named.part}), table ${accepted.print}` };
      }
      if (direct && direct !== accepted.print) return { ...at, refused: `an LDraw-limited donor pairs it with ${direct}, table ${accepted.print}` };
      return { ...at, basis: 'votes' as const, ...chooseHeadPrint(h.part, accepted.print, accepted.parts, exact) };
    }
    // The name, held by the set's own inventory (`nameChoice`): element identity, which beats an LDraw-limited
    // donor's nearest-print stand-in.
    if (named && 'print' in named) return { ...at, basis: 'name' as const, ...chooseHeadPrint(h.part, named.print, named.ldraw ? [named.ldraw] : [], exact) };
    if (direct) return { ...at, refused: `paired with ${direct} only by an LDraw-limited donor` };
    const row = tally[h.decoration];
    return { ...at, refused: row ? `no accepted row (${Object.keys(row).join('/')})` : 'no vote' };
  });
}

/** The accepted table of a tally (`acceptVotes`), as a map. */
export const acceptedTable = (tally: VoteTally): Map<string, { print: string; parts: string[] }> =>
  new Map(acceptVotes(tally).flatMap(v => ('print' in v ? [[v.decoration, { print: v.print, parts: v.parts }] as const] : [])));

/** Leave-one-set-out precision: each set's own votes judged against the table every OTHER set's votes give. */
export function holdout(votes: readonly DecorationVote[]): { agree: number; disagree: number; noRow: number; rows: Array<{ set: string; decoration: string; own: string; table: string | null }> } {
  const sets = [...new Set(votes.map(v => v.set))];
  const rows: Array<{ set: string; decoration: string; own: string; table: string | null }> = [];
  let agree = 0, disagree = 0, noRow = 0;
  for (const s of sets) {
    const table = acceptedTable(tallyVotes(votes.filter(v => v.set !== s)));
    const mine = new Map<string, Set<string>>();
    for (const v of votes) if (v.set === s) mine.set(v.decoration, (mine.get(v.decoration) ?? new Set()).add(v.print));
    for (const [d, prints] of mine) {
      if (prints.size !== 1) continue;
      const own = [...prints][0]!;
      const t = table.get(d)?.print ?? null;
      if (t === null) noRow++; else if (faceKey(t) === faceKey(own)) agree++; else disagree++;
      rows.push({ set: s, decoration: d, own, table: t });
    }
  }
  return { agree, disagree, noRow, rows };
}

async function main(): Promise<void> {
  setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
  if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync('C:/git/clego/ldraw_ref')) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const decoPath = opt('decorations');
  if (!decoPath) throw new Error('--decorations=<clego>/geograde/mb_head_decorations.json is required');
  const only = new Set(argv.filter(a => !a.startsWith('--')));
  const outPath = opt('out') ?? 'scripts/mb-decoration-votes.json';
  const doc = JSON.parse(readFileSync(decoPath, 'utf8')) as MbDecorationsDoc;
  const targets = new Map<string, string[]>();
  for (const f of Object.keys(doc.files)) {
    const s = setOfFile(f.split('/').pop()!);
    if (!s || (only.size && !only.has(s))) continue;
    targets.set(s, [...(targets.get(s) ?? []), f]);
  }
  // `--from-votes`: the votes an earlier run wrote (its `detail`), so the plan can be re-decided without the
  // matcher's minutes-long pass; the run that wrote them read the same corpus.
  const fromVotes = opt('from-votes');
  let r: { heads: number; decorated: number; votes: HeadVote[] };
  if (fromVotes) {
    const prev = JSON.parse(readFileSync(fromVotes, 'utf8')) as { heads: number; decorated: number; detail: HeadVote[] };
    const keep = (v: HeadVote): boolean => { const s = setOfFile(v.target.split('/').pop()!); return !!s && targets.has(s); };
    r = { heads: prev.heads, decorated: prev.decorated, votes: prev.detail.filter(keep) };
    console.log(`${r.votes.length} votes read from ${fromVotes}`);
  } else {
    const donors = donorFilesBySet(only);
    console.log(`${targets.size} sets with decorated Mecabricks heads, ${[...targets.keys()].filter(s => donors.has(s)).length} with a donor that may name prints`);
    // brick index -> clego line, per target file, so each vote lands on the head the matcher paired.
    const lineOf = new Map<string, Map<number, number>>();
    const collected = await collectVotes({
      targets, donors, provider: createPartGeometryProvider(), log: l => console.log(l),
      decorationsOf: (path, bricks) => {
        const rows = attachDecorations(bricks, doc.files[path]!.heads);
        lineOf.set(path, new Map([...rows].map(([i, h]) => [i, h.line])));
        return new Map([...rows].map(([i, h]) => [i, h.decoration]));
      },
    });
    r = {
      ...collected,
      votes: collected.votes.flatMap((v): HeadVote[] => {
        const line = v.head === undefined ? undefined : lineOf.get(v.target)?.get(v.head);
        return line === undefined ? [] : [{ ...v, line }];
      }),
    };
    // Votes the files already carry (heads printed by an earlier transfer), in every target set, donors or not.
    for (const [s, files] of targets) {
      for (const f of files) {
        const path = `${CORPUS}/${f}`;
        if (existsSync(path)) r.votes.push(...carriedVotes(s, f, readFileSync(path, 'utf8'), doc.files[f]!.heads));
      }
    }
  }
  const tally = tallyVotes(r.votes);
  const verdicts = acceptVotes(tally);
  if (!fromVotes || opt('out')) mkdirSync(dirname(outPath), { recursive: true });
  if (!fromVotes || opt('out')) writeFileSync(outPath, `${JSON.stringify({
    generated: 'bun scripts/_mb_decoration_votes.ts', heads: r.heads, decorated: r.decorated, votes: r.votes.length,
    accepted: verdicts.filter(v => 'print' in v).length, tally, verdicts, detail: r.votes,
  }, null, 1)}\n`);
  console.log(`${r.heads} heads read in sets with donors, ${r.decorated} decorated; ${r.votes.length} votes over ${Object.keys(tally).length} decorations, ${verdicts.filter(v => 'print' in v).length} accepted${!fromVotes || opt('out') ? ` -> ${outPath}` : ''}`);

  const hold = opt('holdout');
  if (hold) {
    const h = holdout(r.votes);
    writeFileSync(hold, `${JSON.stringify(h, null, 1)}\n`);
    console.log(`holdout: ${h.agree} agree, ${h.disagree} disagree, ${h.noRow} with no row from the other sets -> ${hold}`);
  }
  const planPath = opt('plan');
  if (planPath) {
    const table = acceptedTable(tally);
    const own = ownVotesOf(r.votes);
    // Which candidate rename targets the library holds as THAT file (an alias would make the rename a guess).
    const names = new Set<string>();
    for (const c of Object.values(tally)) {
      for (const [key, p] of Object.entries(c)) {
        for (const n of p.parts) names.add(`${partStem(n)}.dat`);
        const lp = /^3626(p(?!b\d)[0-9a-z]+)$/.exec(key);
        if (lp) for (const m of ['3626c', '3626b']) names.add(`${m}${lp[1]}.dat`);
      }
    }
    for (const k of Object.keys(HEAD_PRINT_LDRAW)) names.add(`${HEAD_PRINT_LDRAW[k]}.dat`);
    // `--names`: the print a head's own name gives where its set's inventory holds that part (mb-head-names.ts).
    const rb = argv.includes('--names') ? loadRebrickableHeadData() : undefined;
    if (rb) for (const f of Object.values(rb.printMap)) if (f.endsWith('.dat')) names.add(f);
    const exactSet = new Set<string>();
    for (const n of names) if ((await getDatText(n)) !== null && !datSubstitutionFor(n)) exactSet.add(n.toLowerCase());
    const exact = (part: string): boolean => exactSet.has(part.toLowerCase());
    const plan: Record<string, HeadDecision[]> = {};
    const count = { votes: 0, own: 0, name: 0, refused: 0, renamed: 0, meta: 0 };
    for (const [f, v] of Object.entries(doc.files)) {
      const s = setOfFile(f.split('/').pop()!);
      if (!s || (only.size && !only.has(s))) continue;
      const d = decideHeads(f, v.heads, table, tally, own, exact, rb ? (h => nameChoice(h, s, rb)) : undefined);
      for (const x of d) {
        if ('refused' in x) { count.refused++; continue; }
        if (x.basis === 'votes') count.votes++; else if (x.basis === 'name') count.name++; else count.own++;
        if (x.rename) count.renamed++; else count.meta++;
      }
      if (d.some(x => !('refused' in x))) plan[f] = d;
    }
    writeFileSync(planPath, `${JSON.stringify({ generated: 'bun scripts/_mb_decoration_votes.ts --plan', count, files: plan }, null, 1)}\n`);
    console.log(`plan: ${count.votes} heads by votes, ${count.own} by their own set, ${count.name} by their name (${count.renamed} renames, ${count.meta} metas), ${count.refused} refused, ${Object.keys(plan).length} files -> ${planPath}`);
  }
}

if ((import.meta as { main?: boolean }).main) await main();
