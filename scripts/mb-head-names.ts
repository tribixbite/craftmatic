/**
 * The print a Mecabricks head's NAME gives (generality census 2026-11-16, FIG-04 / PROC-19,
 * TODO(mecabricks-head-decoration)).
 *
 * Mecabricks names a decorated head with LEGO's element name, `Mini Head No.2552` (element 6221340, LEGO's
 * "MINI HEAD, NO. 2552"). Rebrickable numbers head prints with the same number: `3626cpr2552` is element 6221340
 * in clego's `elements.csv`. From the part the chain is the print map's own: each element's `e:` row (the LDraw
 * print) or `n:` row (the BrickLink id `3626pb<N>` when LDraw has none), `scripts/gen-ldd-print-map.py`.
 *
 * Measured over the heads a DBIX / IOModel2V2 donor matched (`scripts/mb-decoration-votes.json`, 2026-11-16):
 *   - the named part is in the set's own Rebrickable inventory: 69 agree, 7 disagree;
 *   - it is not: 0 agree, 29 disagree - an author who lacks the face picks a near one (a Catwoman head in a City
 *     police set, the 2015 Captain America in the 2021 Quinjet), so the name is the stand-in, not the set's face.
 * So a head takes the chain's print only when its set's inventory (with its minifigs) holds the named part, and
 * nothing ambiguous is written: two moulds' `pr<N>` both in the inventory with different faces, a part whose
 * elements give two faces, a part with no element or no print row.
 *
 * Rebrickable numbers each mould separately (`3626bpr0752` and `3626cpr0752` are different faces), which is the
 * other reason the inventory decides: it says which mould's numbering the set's head is.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { faceKey } from '../web/src/engine/head-face.ts';

/** Where the Rebrickable data lives (clego's offline export). */
export const CLEGO_ELEMENTS = 'C:/git/clego/elements.csv';
export const REBRICKABLE_TABLES = 'C:/git/clego/rebrickable_tables';

/** LEGO's element name of a printed head: `Mini Head No.2552`, `Minifig Head No. 1966`, `Mini Head "No. 1580"`. */
const HEAD_NUMBER = /^(?:(?:mini|minifig)\s+)?head[\s,]*"?no\.?\s*(\d+)"?$/i;

/** The element number in a Mecabricks head's name, or undefined for a description (`Mini Head - Moustache`). */
export function headNumberOf(name: string | undefined): number | undefined {
  const m = HEAD_NUMBER.exec((name ?? '').trim());
  return m ? Number(m[1]) : undefined;
}

/** Rebrickable's printed head moulds, the current hollow-stud one first. Each numbers its prints on its own. */
export const NAMED_HEAD_MOULDS = ['3626c', '3626b', '3626a', '28621'] as const;

/** What the chain reads. `inventoryOf(set)` holds the set's head parts (its minifigs' too), undefined if unknown. */
export interface RebrickableHeadData {
  parts: ReadonlySet<string>;
  elementsOf: ReadonlyMap<string, readonly string[]>;
  /** `web/public/ldd-print-map.json`: `e:<element>` -> LDraw print file, `n:<element>` -> print id. */
  printMap: Readonly<Record<string, string>>;
  inventoryOf: (set: string) => ReadonlySet<string> | undefined;
}

/** Every Rebrickable head part numbered `n`: `<mould>pr<n>` zero-padded to four digits, in `NAMED_HEAD_MOULDS` order. */
export function namedPartCandidates(n: number, parts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of NAMED_HEAD_MOULDS) {
    for (const p of [`${m}pr${String(n).padStart(4, '0')}`, `${m}pr${n}`]) if (parts.has(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** A part's print: the face key (`faceKey`) and the LDraw print file's stem when LDraw draws it. */
export type PartPrint = { print: string; ldraw?: string } | { refused: string };

/** The one print every element of `part` names in the print map, or why there is none. */
export function printOfPart(part: string, data: RebrickableHeadData): PartPrint {
  const els = data.elementsOf.get(part) ?? [];
  if (!els.length) return { refused: `${part} has no element` };
  const prints = new Map<string, string | undefined>();
  for (const e of els) {
    const file = data.printMap[`e:${e}`];
    const id = data.printMap[`n:${e}`];
    if (file) {
      const stem = file.toLowerCase().replace(/\.dat$/, '');
      prints.set(faceKey(stem), stem);
    } else if (id) {
      const k = faceKey(id);
      if (!prints.has(k)) prints.set(k, undefined);
    }
  }
  if (!prints.size) return { refused: `no print row for ${part}'s elements (${els.join(', ')})` };
  if (prints.size > 1) return { refused: `${part}'s elements name ${[...prints.keys()].join(' / ')}` };
  const [[print, ldraw]] = [...prints];
  return ldraw ? { print, ldraw } : { print };
}

/** The print one decorated head's name gives in `set`, with the Rebrickable part it went through. */
export type NameChoice = { part: string; print: string; ldraw?: string } | { refused: string };

/** The head's name -> Rebrickable part held by the set's inventory -> its elements' one print; else refused. */
export function nameChoice(head: { name?: string }, set: string, data: RebrickableHeadData): NameChoice {
  const n = headNumberOf(head.name);
  if (n === undefined) return { refused: 'no element number in the name' };
  const cands = namedPartCandidates(n, data.parts);
  if (!cands.length) return { refused: `no Rebrickable head part numbered ${n}` };
  const inv = data.inventoryOf(set);
  if (!inv) return { refused: `no Rebrickable inventory for ${set}-1` };
  const held = cands.filter(p => inv.has(p));
  if (!held.length) return { refused: `${cands.join(' / ')} not in ${set}-1's inventory (a stand-in face)` };
  const prints = held.map(p => ({ part: p, ...printOfPart(p, data) }));
  const bad = prints.find(p => 'refused' in p);
  if (bad && 'refused' in bad) return { refused: bad.refused };
  const faces = new Set(prints.map(p => ('print' in p ? p.print : '')));
  if (faces.size > 1) return { refused: `${held.join(' / ')} are all in ${set}-1's inventory with different faces` };
  return prints[0] as NameChoice;
}

/** Rows of a small CSV (no quoted commas in the columns read before the first quoted one). */
function csvRows(text: string): string[][] {
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const row: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else cur += c;
    }
    row.push(cur);
    out.push(row);
  }
  return out;
}

const gz = (name: string): string[][] => csvRows(gunzipSync(readFileSync(`${REBRICKABLE_TABLES}/${name}`)).toString('utf8')).slice(1);

/** A head part Rebrickable lists (the moulds the chain can name). */
const HEAD_PART = /^(?:3626[abc]?|28621)pr/;

/** Load the chain's data from clego's offline Rebrickable export and craftmatic's print map. */
export function loadRebrickableHeadData(printMapPath = 'web/public/ldd-print-map.json'): RebrickableHeadData {
  const parts = new Set(gz('parts.csv.gz').map(r => r[0]!).filter(p => HEAD_PART.test(p)));
  const elementsOf = new Map<string, string[]>();
  for (const [el, part] of csvRows(readFileSync(CLEGO_ELEMENTS, 'utf8')).slice(1)) {
    if (el && part && parts.has(part)) elementsOf.set(part, [...(elementsOf.get(part) ?? []), el]);
  }
  // inventory id -> head parts; set (and minifig) number -> inventory ids; inventory id -> minifigs.
  const invOf = new Map<string, string[]>();
  for (const [id, , setNum] of gz('inventories.csv.gz')) invOf.set(setNum!, [...(invOf.get(setNum!) ?? []), id!]);
  const heads = new Map<string, Set<string>>();
  for (const [id, part] of gz('inventory_parts.csv.gz')) {
    if (HEAD_PART.test(part!)) (heads.get(id!) ?? heads.set(id!, new Set()).get(id!)!).add(part!);
  }
  const figs = new Map<string, string[]>();
  for (const [id, fig] of gz('inventory_minifigs.csv.gz')) figs.set(id!, [...(figs.get(id!) ?? []), fig!]);
  const inventoryOf = (set: string): ReadonlySet<string> | undefined => {
    const ids = invOf.get(`${set}-1`);
    if (!ids) return undefined;
    const out = new Set<string>();
    for (const id of ids) {
      for (const p of heads.get(id) ?? []) out.add(p);
      for (const fig of figs.get(id) ?? []) for (const fid of invOf.get(fig) ?? []) for (const p of heads.get(fid) ?? []) out.add(p);
    }
    return out;
  };
  const printMap = JSON.parse(readFileSync(printMapPath, 'utf8')) as Record<string, string>;
  return { parts, elementsOf, printMap, inventoryOf };
}

/** One head the precision check judged: the donor's print against the chain's, with the set's inventory verdict. */
export interface NameCheckRow { file: string; line: number; name: string; donor: string; truth: string; chain: string; part: string; inInventory: boolean }

/**
 * Precision of the name chain against the heads a donor matched (`scripts/mb-decoration-votes.json` `detail`):
 * per donor class (`full` = DBIX / IOModel2V2, `ldraw` = OMR / LDR, `meta` = a HEAD_PRINT already in the file),
 * agree / disagree for heads whose named part the set's inventory holds and for those it does not, counted once
 * per distinct head, donor class and print.
 * Usage: bun scripts/mb-head-names.ts --check --decorations=<clego>/geograde/mb_head_decorations.json
 *          [--votes=scripts/mb-decoration-votes.json] [--out=OUT.json]
 */
async function main(): Promise<void> {
  const { setOfFile } = await import('./decoration-votes.ts');
  const { FULL_VOCABULARY_DONOR } = await import('./_mb_decoration_votes.ts');
  const argv = process.argv.slice(2);
  const opt = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!argv.includes('--check') || !opt('decorations')) throw new Error('usage: --check --decorations=<json> [--votes=<json>] [--out=<json>]');
  const doc = JSON.parse(readFileSync(opt('decorations')!, 'utf8')) as { files: Record<string, { heads: Array<{ line: number; name?: string }> }> };
  const votes = (JSON.parse(readFileSync(opt('votes') ?? 'scripts/mb-decoration-votes.json', 'utf8')) as {
    detail: Array<{ target: string; line: number; print: string; donor: string }>;
  }).detail;
  const data = loadRebrickableHeadData();
  const rows: NameCheckRow[] = [];
  const tally: Record<string, number> = {};
  // One verdict per distinct (head, donor class, print): a head several files of one lineage voted for is one case.
  const seen = new Set<string>();
  for (const v of votes) {
    const h = doc.files[v.target]?.heads.find(x => x.line === v.line);
    if (!h) continue;
    const n = headNumberOf(h.name);
    if (n === undefined) continue;
    const set = setOfFile(v.target.split('/').pop()!) ?? '';
    const cls = FULL_VOCABULARY_DONOR.test(v.donor) ? 'full' : /^(OMR|LDR)\//.test(v.donor) ? 'ldraw' : 'meta';
    const key = `${v.target}|${v.line}|${cls}|${faceKey(v.print)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const inv = data.inventoryOf(set);
    // Judge the chain as `nameChoice` would pick its part, and, for heads it refuses for the inventory, as the
    // first numbered part with a print (what writing every name would have done).
    const held = namedPartCandidates(n, data.parts).filter(p => inv?.has(p));
    const pool = held.length ? held : namedPartCandidates(n, data.parts);
    const pick = pool.map(p => ({ p, r: printOfPart(p, data) })).find(x => 'print' in x.r);
    if (!pick || !('print' in pick.r)) continue;
    const ok = faceKey(pick.r.print) === faceKey(v.print);
    const k = `${cls} ${held.length ? 'in inventory' : 'not in inventory'} ${ok ? 'agree' : 'disagree'}`;
    tally[k] = (tally[k] ?? 0) + 1;
    rows.push({ file: v.target, line: v.line, name: h.name ?? '', donor: v.donor, truth: v.print, chain: pick.r.print, part: pick.p, inInventory: held.length > 0 });
  }
  for (const k of Object.keys(tally).sort()) console.log(`${k}: ${tally[k]}`);
  const out = opt('out');
  if (out) writeFileSync(out, `${JSON.stringify({ generated: 'bun scripts/mb-head-names.ts --check', tally, rows }, null, 1)}\n`);
}

if ((import.meta as { main?: boolean }).main) await main();
