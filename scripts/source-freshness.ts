#!/usr/bin/env bun
/**
 * source-freshness.ts — the CI half of the model-source freshness pipeline.
 *
 * The catalog (Rebrickable) is rebuilt on every deploy, so NEW sets appear in
 * the LEGO tab's search the week they are released. The MODEL INDEX is not:
 * it is generated in the clego repo from a 1.8 GB local corpus and published
 * to R2 by hand. The gap between the two is exactly the class of bug the user
 * hit with 40975-1 (Mini Hogwarts Castle, 2026): searchable, but no model.
 *
 * This script measures that gap on a schedule and says which sourceless sets a
 * KNOWN channel could supply a model for TODAY, so the local harvest run has a
 * work list instead of a guess:
 *
 *   catalog (fresh)  ∖  model index (published)   = sourceless
 *   sourceless  ∩  DBIX skulist                   = harvestable now (LXFML)
 *   sourceless  ∩  OMR set list                   = harvestable now (LDraw)
 *   the rest                                      = no known channel
 *
 * Reads the artifacts `bun run prebuild` already produces (lego-catalog.json,
 * omr-index.json) and fetches the live model index + the live DBIX SKU list.
 *
 *   bun scripts/source-freshness.ts                   # report to stdout + JSON
 *   bun scripts/source-freshness.ts --summary $GITHUB_STEP_SUMMARY
 *
 * Writes web/public/source-freshness.json (the app does not read it; it is the
 * committed artifact whose diff makes the weekly change reviewable).
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PUB = resolve(import.meta.dir, '../web/public');
const OUT = resolve(PUB, 'source-freshness.json');

const INDEX_URL = process.env.MODEL_INDEX_URL ?? 'https://craftmatic.click/lego-models-index.json';
const DBIX_SKULIST = 'https://api.prod.dbix.i.lego.com/api/v1/BuildingInstructions/skulist';

/** `40975-1` → `40975`; the model index is keyed without the revision. */
const baseNum = (s: string) => s.replace(/-\d+$/, '');

interface CatalogSet { set_num: string; name: string; year: number; num_parts: number }

// ── inputs ───────────────────────────────────────────────────────────────────

function readCatalog(): CatalogSet[] {
  const p = resolve(PUB, 'lego-catalog.json');
  if (!existsSync(p)) throw new Error(`missing ${p} — run 'bun run prebuild:lego' first`);
  return JSON.parse(readFileSync(p, 'utf8')).sets as CatalogSet[];
}

function readOmr(): Set<string> {
  const p = resolve(PUB, 'omr-index.json');
  if (!existsSync(p)) return new Set();
  const list = JSON.parse(readFileSync(p, 'utf8')) as string[];
  return new Set(list.map(baseNum));
}

async function fetchJson<T>(url: string, label: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'craftmatic-source-freshness' } });
    if (!r.ok) { console.warn(`[freshness] ${label}: HTTP ${r.status}`); return null; }
    return (await r.json()) as T;
  } catch (e) {
    console.warn(`[freshness] ${label}: ${(e as Error).message}`);
    return null;
  }
}

async function modelIndexSets(): Promise<{ sets: Set<string>; generated: string; from: string }> {
  const live = await fetchJson<{ generated: string; sets: Record<string, unknown> }>(INDEX_URL, 'model index');
  if (live?.sets) return { sets: new Set(Object.keys(live.sets)), generated: live.generated, from: INDEX_URL };
  // Fall back to the repo copy so the job still reports something useful when
  // the worker route is down — it just measures a possibly staler index.
  const local = JSON.parse(readFileSync(resolve(PUB, 'lego-models-index.json'), 'utf8'));
  return { sets: new Set(Object.keys(local.sets)), generated: local.generated, from: 'web/public (fallback)' };
}

async function dbixSkus(): Promise<Set<string>> {
  const l = await fetchJson<(string | null)[]>(DBIX_SKULIST, 'DBIX skulist');
  return new Set((l ?? []).filter(Boolean).map(String));
}

// ── report ───────────────────────────────────────────────────────────────────

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };

const catalog = readCatalog();
const omr = readOmr();
const [{ sets: indexed, generated, from }, dbix] = await Promise.all([modelIndexSets(), dbixSkus()]);

/** Sets worth a model: real builds, not merch/promo stubs. */
const buildable = catalog.filter(s => (s.num_parts ?? 0) >= 10);
const sourceless = buildable.filter(s => !indexed.has(baseNum(s.set_num)));

const viaDbix = sourceless.filter(s => dbix.has(baseNum(s.set_num)));
const viaOmr = sourceless.filter(s => omr.has(baseNum(s.set_num)) && !dbix.has(baseNum(s.set_num)));
const viaNone = sourceless.filter(s => !dbix.has(baseNum(s.set_num)) && !omr.has(baseNum(s.set_num)));

const recent = (s: CatalogSet) => s.year >= new Date().getFullYear() - 1;
const byYear = (a: CatalogSet, b: CatalogSet) => b.year - a.year || b.num_parts - a.num_parts;

const report = {
  generated: new Date().toISOString().slice(0, 19).replace('T', ' '),
  model_index: { source: from, generated, sets: indexed.size },
  catalog: { sets: catalog.length, buildable: buildable.length },
  channels: { dbix_skulist: dbix.size, omr_sets: omr.size },
  sourceless: {
    total: sourceless.length,
    recent: sourceless.filter(recent).length,
    harvestable_dbix: viaDbix.length,
    harvestable_omr: viaOmr.length,
    no_known_channel: viaNone.length,
  },
  // The work list a local harvest run consumes. Capped so the committed diff
  // stays readable; the counts above are the complete picture.
  harvest_dbix: viaDbix.sort(byYear).slice(0, 400).map(s => s.set_num),
  harvest_omr: viaOmr.sort(byYear).slice(0, 400).map(s => s.set_num),
  recent_no_channel: viaNone.filter(recent).sort(byYear).slice(0, 200)
    .map(s => `${s.set_num} ${s.name} (${s.year}, ${s.num_parts}p)`),
};

writeFileSync(OUT, JSON.stringify(report, null, 1));

const md = [
  `### Model-source freshness — ${report.generated}`,
  '',
  `Model index: **${indexed.size}** sets (generated ${generated}, from ${from}).`,
  `Catalog: **${catalog.length}** sets, **${buildable.length}** buildable (≥10 parts).`,
  '',
  '| bucket | sets |',
  '|---|---:|',
  `| buildable sets with NO indexed model | **${sourceless.length}** |`,
  `| …of those, released in the last 2 years | ${report.sourceless.recent} |`,
  `| …harvestable from DBIX today (in skulist) | **${viaDbix.length}** |`,
  `| …harvestable from LDraw OMR today | **${viaOmr.length}** |`,
  `| …no known channel | ${viaNone.length} |`,
  '',
  viaDbix.length
    ? `Run in clego to close the DBIX column:\n\n\`\`\`\npython discovery/dbix_refresh.py --run\npython build_model_index.py\npython sync_models_r2.py\n\`\`\`\n`
    : 'No DBIX backlog — the corpus is level with the skulist.\n',
  '<details><summary>Newest sets with no model at all</summary>\n',
  ...report.recent_no_channel.slice(0, 40).map(l => `- ${l}`),
  '\n</details>',
].join('\n');

console.log(md);
const summary = arg('--summary') ?? process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary, md + '\n');
console.log(`\nwrote ${OUT}`);
