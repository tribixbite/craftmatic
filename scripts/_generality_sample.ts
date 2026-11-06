/**
 * Picks a deterministic, theme-spread sample of sets OUTSIDE the favourites, for the generality census
 * (GEN-01, TASKS-BEDROCK-ADDON.md "Generality census"): do doors, seats, slides and vehicles found from parts
 * work for ANY set, or only for the 40 favourites every check was tuned on?
 *
 * The models index carries no theme, so the spread is by set-number family (the first two digits track
 * LEGO's theme ranges: 10 Icons, 21 Ideas/Architecture, 31 Creator, 41/42 Friends/Technic, 60 City,
 * 7x licensed lines). Each family gets an equal share, sets inside a family are ordered by a hash of the
 * stem (stable across runs, not alphabetical), and only sets a phone could hold are taken.
 *
 * Usage: bun scripts/_generality_sample.ts [--n=200] [--min-parts=150] [--max-parts=4000] [--min-year=2005] [--out=<file>]
 * Prints one set number per line (or writes them to --out).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FAVOURITES, GABBY_SETS } from './favourite-sets.js';

const INDEX = 'C:/git/clego/lego-models-index.json';
const argv = process.argv.slice(2);
const num = (name: string, fallback: number): number => {
  const a = argv.find(x => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : fallback;
};
const N = num('n', 200), MIN_PARTS = num('min-parts', 150), MAX_PARTS = num('max-parts', 4000), MIN_YEAR = num('min-year', 2005);
const OUT = argv.find(x => x.startsWith('--out='))?.slice(6);

interface IndexSet { name?: string; year?: string; parts?: number; models?: unknown[] }
const sets = (JSON.parse(readFileSync(INDEX, 'utf8')) as { sets: Record<string, IndexSet> }).sets;
const excluded = new Set<string>([...FAVOURITES, ...GABBY_SETS]);

/** Stable pseudo-random order inside a family: sha1 of the stem. */
const key = (stem: string): string => createHash('sha1').update(stem).digest('hex');

const families = new Map<string, string[]>();
for (const [stem, s] of Object.entries(sets)) {
  if (!/^\d{4,6}$/.test(stem) || excluded.has(stem) || !s.models?.length) continue;
  const parts = s.parts ?? 0, year = Number(s.year ?? 0);
  if (parts < MIN_PARTS || parts > MAX_PARTS || year < MIN_YEAR) continue;
  const fam = stem.slice(0, 2);
  if (!families.has(fam)) families.set(fam, []);
  families.get(fam)!.push(stem);
}
for (const list of families.values()) list.sort((a, b) => key(a).localeCompare(key(b)));

// Round-robin over families so a large family (City, Star Wars) cannot crowd out the small ones.
const order = [...families.keys()].sort();
const picked: string[] = [];
for (let round = 0; picked.length < N; round++) {
  let any = false;
  for (const fam of order) {
    const list = families.get(fam)!;
    if (round < list.length && picked.length < N) { picked.push(list[round]!); any = true; }
  }
  if (!any) break;
}
const text = picked.join('\n') + '\n';
if (OUT) writeFileSync(OUT, text); else process.stdout.write(text);
console.error(`picked ${picked.length} of ${[...families.values()].reduce((n, l) => n + l.length, 0)} eligible sets in ${order.length} families`);
