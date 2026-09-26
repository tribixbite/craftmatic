/**
 * Print the app's pick for every set in a models index, or diff two indexes.
 *
 * The pick is exactly what the LEGO tab loads first: `bestIndexedModel()` from
 * `web/src/engine/lego-sources.ts`, so a source round can prove whether any
 * published file changed what a user sees.
 *
 *   bun scripts/_index_picks.ts <index.json>                 # {set: path} JSON on stdout
 *   bun scripts/_index_picks.ts <old.json> <new.json>         # changed picks only
 *   bun scripts/_index_picks.ts <index.json> --author <dir>   # picks whose file header names a converter
 *
 * `--author <lego_sets dir>` reads each pick's first 12 lines from the corpus
 * and groups the picks by their `0 Author:` / `0 !LINEAGE` line.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bestIndexedModel, type LegoModelsIndex } from '../web/src/engine/lego-sources.ts';

/** Pick per set for one index file. */
function picks(indexPath: string): Record<string, string> {
  const idx = JSON.parse(readFileSync(indexPath, 'utf8')) as LegoModelsIndex;
  const out: Record<string, string> = {};
  for (const setNum of Object.keys(idx.sets)) {
    const m = bestIndexedModel(idx, setNum);
    if (m) out[setNum] = m.path;
  }
  return out;
}

/** The converter a corpus file names in its header, or '' when none. */
function authorOf(file: string): string {
  if (!existsSync(file) || !/\.(ldr|mpd|dat)$/i.test(file)) return '';
  const head = readFileSync(file, 'utf8').split(/\r?\n/, 12);
  const line = head.find(l => /^0 (Author:|!LINEAGE)/.test(l));
  return line ? line.replace(/^0 /, '').trim() : '';
}

const [a, b, c] = process.argv.slice(2);
if (!a) {
  console.error('usage: bun scripts/_index_picks.ts <index.json> [<new.json> | --author <lego_sets dir>]');
  process.exit(2);
}
const first = picks(a);
if (b === '--author') {
  const dir = c ?? 'C:/git/clego/lego_sets';
  const groups: Record<string, string[]> = {};
  for (const [setNum, path] of Object.entries(first)) {
    (groups[authorOf(join(dir, path))] ??= []).push(`${setNum}:${path}`);
  }
  console.log(JSON.stringify(groups, null, 1));
} else if (b) {
  const second = picks(b);
  const changed = Object.keys({ ...first, ...second })
    .filter(s => first[s] !== second[s])
    .map(s => ({ set: s, old: first[s] ?? null, new: second[s] ?? null }));
  console.log(JSON.stringify({ sets: Object.keys(second).length, changed }, null, 1));
} else {
  console.log(JSON.stringify(first));
}
