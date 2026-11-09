/**
 * Build the official-set fingerprint database from the LOCAL corpus (no Rebrickable, so no U10 dependency), or
 * measure the similarity distributions the verdict thresholds come from.
 *
 *   bun scripts/build-official-fingerprints.ts [--corpus <lego_sets>] [--index <index.json>] [--out <file.json>]
 *   bun scripts/build-official-fingerprints.ts --calibrate [--pairs 300] [--max-parts 3000] [--seed 1]
 *
 * Build mode fingerprints every text LDraw source (`.ldr` / `.mpd`) the index lists for a set and writes
 * `{ generated, entries: [{ setId, name, path, hash12, fingerprint }] }` (signatures base64, no placement cells).
 *
 * Calibrate mode prints percentile tables for three populations, measured over DISTINCT sets (a set with nine files
 * contributes its pairs once each, and the unit counts are printed beside the pair counts):
 *   same   different source files of ONE set (should score high);
 *   theme  files of two different sets whose numbers share their first two digits (a theme proxy: 75xxx Star Wars, 21xxx
 *          Ideas, 42xxx Technic ...; the index carries no theme field);
 *   other  files of two sets with different two-digit prefixes (unrelated).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { sourceHash12 } from '../web/src/engine/pipeline-version.ts';
import {
  compareFingerprints, fingerprintBricks, toStored, type Fingerprint, type Similarity,
} from '../web/src/engine/byom/fingerprint.ts';

/** Index sources that are text LDraw in the standard LDraw colour space (the screen compares like with like). */
const TEXT_SOURCES = new Set(['ldr', 'omr', 'hunt_archive', 'eurobricks', 'eb_topic_ldraw']);

interface IndexModel { src: string; path: string; hash: string; n: number; variant?: string }
interface Index { sets: Record<string, { name: string; models: IndexModel[] }> }

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const corpus = arg('corpus', 'C:/git/clego/lego_sets')!;
const indexPath = arg('index', 'web/public/lego-models-index.json')!;
const maxParts = Number(arg('max-parts', '3000'));

if (!existsSync(corpus)) { console.error(`corpus not found: ${corpus}`); process.exit(1); }
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Index;

/** Small deterministic PRNG (the calibration must reproduce). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const cache = new Map<string, Fingerprint | null>();
/** Fingerprint one corpus file as a QUERY (8 orientations) with placement cells; null when unreadable or too big. */
function load(path: string, orientations: boolean): Fingerprint | null {
  const key = `${path}|${orientations}`;
  if (cache.has(key)) return cache.get(key)!;
  const file = join(corpus, path);
  let fp: Fingerprint | null = null;
  if (existsSync(file)) {
    const bytes = new Uint8Array(readFileSync(file));
    const bricks = parseLDraw(new TextDecoder().decode(bytes));
    if (bricks.length > 0 && bricks.length <= maxParts) fp = fingerprintBricks(bricks, { hash12: sourceHash12(bytes), orientations });
  }
  cache.set(key, fp);
  return fp;
}

/** Text sources of a set, main models only (an OMR "B-model" is a different model of the same set). */
const textFiles = (id: string): IndexModel[] =>
  index.sets[id]!.models.filter((m) => TEXT_SOURCES.has(m.src) && !m.variant && /\.(ldr|mpd)$/i.test(m.path));

/** Score cut-offs the calibration reports the population share above. */
const THRESHOLD_GRID = [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function table(label: string, sims: Similarity[], units: number): void {
  console.log(`\n${label}: ${sims.length} pairs over ${units} distinct sets`);
  console.log('metric      min    p05    p25    p50    p75    p95    max');
  const rows: Array<[string, (s: Similarity) => number | null]> = [
    ['score', (s) => s.score], ['inventory', (s) => s.inventory], ['layout', (s) => s.layout],
    ['cosine', (s) => s.cosine], ['placeIoU', (s) => s.placementIoU],
  ];
  for (const [name, get] of rows) {
    const v = sims.map(get).filter((x): x is number => x !== null).sort((a, b) => a - b);
    console.log(`${name.padEnd(10)} ${[0, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999].map((p) => percentile(v, p).toFixed(3)).join('  ')}`);
  }
  const scores = sims.map((s) => s.score);
  console.log('share with score >= ' + THRESHOLD_GRID.map((t) => `${t}: ${(100 * scores.filter((x) => x >= t).length / Math.max(1, scores.length)).toFixed(1)}%`).join('  '));
}

function calibrate(): void {
  const pairsWanted = Number(arg('pairs', '300'));
  const random = rng(Number(arg('seed', '1')));
  const ids = Object.keys(index.sets).filter((id) => textFiles(id).length > 0).sort();
  const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
  const sims = (pairs: Array<[string, string]>): Similarity[] => pairs.flatMap(([pa, pb]) => {
    const a = load(pa, true), b = load(pb, false);
    if (!a || !b) return [];
    const sim = compareFingerprints(a, b);
    if (process.argv.includes('--verbose')) {
      console.log(`${sim.score.toFixed(2)} inv=${sim.inventory.toFixed(2)} lay=${sim.layout.toFixed(2)} cos=${sim.cosine.toFixed(2)} n=${a.count}/${b.count} ${pa} | ${pb}`);
    }
    return [sim];
  });

  // same set: every pair of distinct-hash files, at most 3 pairs per set, sets in a seeded order.
  const same: Array<[string, string]> = [];
  const sameSets = new Set<string>();
  for (const id of ids) {
    const files = textFiles(id).filter((m, i, all) => all.findIndex((o) => o.hash === m.hash) === i);
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length && same.length < pairsWanted * 3; j++) {
      if (sameSets.size >= pairsWanted && !sameSets.has(id)) continue;
      if (files[i]!.n > maxParts || files[j]!.n > maxParts) continue;
      same.push([files[i]!.path, files[j]!.path]); sameSets.add(id);
    }
  }
  // theme / other: random pairs of different sets, one random file each.
  const small = ids.filter((id) => textFiles(id).some((m) => m.n <= maxParts));
  const prefix = (id: string): string => id.slice(0, 2);
  const draw = (wantSame: boolean): Array<[string, string, string, string]> => {
    const out: Array<[string, string, string, string]> = [];
    for (let guard = 0; out.length < pairsWanted && guard < pairsWanted * 200; guard++) {
      const a = pick(small), b = pick(small);
      if (a === b || (prefix(a) === prefix(b)) !== wantSame) continue;
      const fa = pick(textFiles(a).filter((m) => m.n <= maxParts)), fb = pick(textFiles(b).filter((m) => m.n <= maxParts));
      out.push([fa.path, fb.path, a, b]);
    }
    return out;
  };
  const theme = draw(true), other = draw(false);
  const units = (rows: Array<[string, string, string, string]>): number => new Set(rows.flatMap((r) => [r[2], r[3]])).size;

  const sameSims = sims(same);
  table('same set, different source files', sameSims, sameSets.size);
  // Files of one set by different authors are often DIFFERENT models (24 vs 44 parts): the size-matched subset
  // (part counts within 20 %) is the "same design in another format" population the screen must catch.
  const matched = same.filter(([pa, pb]) => {
    const a = load(pa, true)!, b = load(pb, false)!;
    return a && b && Math.min(a.count, b.count) / Math.max(a.count, b.count) >= 0.8;
  });
  table('same set, size-matched files (part counts within 20 %)', sims(matched), new Set(matched.map(([pa]) => pa.replace(/\D+/g, ' ').trim().split(' ')[0])).size);
  table('same theme (shared 2-digit prefix), different sets', sims(theme.map((r) => [r[0], r[1]])), units(theme));
  table('unrelated (different prefix), different sets', sims(other.map((r) => [r[0], r[1]])), units(other));
}

function build(): void {
  const out = arg('out', 'output/official-fingerprints.json')!;
  const entries: unknown[] = [];
  for (const id of Object.keys(index.sets).sort()) {
    for (const m of textFiles(id)) {
      const fp = load(m.path, false);
      if (fp) entries.push({ setId: id, name: index.sets[id]!.name, path: m.path, hash12: fp.hash12, fingerprint: toStored(fp) });
    }
  }
  writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), maxParts, entries }));
  console.log(`${entries.length} fingerprints of ${new Set(entries.map((e) => (e as { setId: string }).setId)).size} sets -> ${out}`);
}

if (process.argv.includes('--calibrate')) calibrate(); else build();
