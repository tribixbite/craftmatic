/**
 * What source does the SITE actually load for a set?
 *
 * The auto-pick is `indexedTryOrder(models, catalogParts)[0]`, not `models[0]`
 * and certainly not whatever path a test happens to hardcode. Those drifted
 * apart and it cost a shipped pack: every 10261 test pinned
 * `IOModel2V2/10261.ldr` while the index's first pick is
 * `LDR/10261 Roller Coaster.mpd`, whose embedded parts defeated detection, so
 * the suite was green while the export users get was broken (`ce50c838`).
 *
 * Usage: bun scripts/_source_first_pick.ts <set…>
 *   bun scripts/_source_first_pick.ts 10261 10303 31084
 * Add --all to list every set whose first pick embeds prefixed parts.
 */
import { readFileSync } from 'node:fs';
import { indexedTryOrder } from '../web/src/engine/lego-sources.ts';
import type { IndexModel } from '../web/src/engine/lego-sources.ts';

const INDEX = 'C:/git/clego/lego-models-index.json';

interface IndexEntry { set?: string; id?: string; models?: IndexModel[]; parts?: number; catalogParts?: number; name?: string }

const raw = JSON.parse(readFileSync(INDEX, 'utf8')) as unknown;
// The index is an object keyed by set id, so the key IS the set number and
// `Object.values` alone would throw it away.
const byKey: Record<string, IndexEntry> = Array.isArray(raw)
  ? Object.fromEntries((raw as IndexEntry[]).map(entry => [String(entry.set ?? entry.id ?? ''), entry]))
  : ((raw as { sets?: Record<string, IndexEntry> }).sets ?? (raw as Record<string, IndexEntry>));
const entries: IndexEntry[] = Object.entries(byKey)
  .filter(([, entry]) => entry && typeof entry === 'object' && 'models' in entry)
  .map(([key, entry]) => ({ ...entry, set: entry.set ?? key }));

const keyOf = (entry: IndexEntry): string => String(entry.set ?? entry.id ?? '');

const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
const rows = entries.filter(entry => wanted.some(w => keyOf(entry) === w || keyOf(entry).startsWith(`${w}-`)));

if (!rows.length) {
  console.error(`no index entry matched ${wanted.join(', ')} (index has ${entries.length} entries)`);
  console.error(`first entry keys: ${Object.keys(entries[0] ?? {}).join(', ')}`);
  process.exit(2);
}

for (const entry of rows) {
  const models = entry.models ?? [];
  const order = indexedTryOrder(models, entry.catalogParts ?? entry.parts);
  const first = models[order[0] ?? 0];
  console.log(`${keyOf(entry)}  ${entry.name ?? ''}`);
  console.log(`  models: ${models.length}`);
  console.log(`  FIRST PICK: ${first?.src} :: ${first?.path}`);
  for (const [rank, index] of order.slice(0, 5).entries()) {
    const model = models[index];
    console.log(`    ${rank === 0 ? '->' : '  '} ${String(model?.src).padEnd(14)} ${model?.path}`);
  }
}
