/**
 * Export every favourite set from the source the PICKER chooses, validate the
 * pack, and record what it cost and how faithful it is.
 *
 * This is the QA sweep over the population that matters: it exercises doors,
 * chairs, figures, vehicles, screens and coasters across real sources with
 * NUMERIC stems — the combination that hid the door-leaf identifier bug until
 * 31084 was built (`ee4f69d8`). It also collects each entity's grain plan, so
 * the close-up fidelity question ("round bricks read as squares at 2-5 blocks")
 * is answered with the measured share of placements the budget coarsened,
 * rather than by eye.
 *
 * Usage: bun scripts/_favorites_export_sweep.ts [set…] [--out DIR] [--keep]
 *   --keep  do not re-export a set whose .mcaddon is already in DIR.
 * Output: DIR/<set>.mcaddon, DIR/<set>.json, DIR/summary.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { indexedTryOrder, type IndexModel } from '../web/src/engine/lego-sources.ts';

const INDEX = 'C:/git/clego/lego-models-index.json';
const CORPUS = 'C:/git/clego/lego_sets';

const FAVOURITES = [
  '10261', '10303', '10326', '10337', '10341', '10354', '10365', '11371', '11374',
  '21061', '21063', '21318', '21360', '31141', '41395', '41703', '41732', '42172',
  '42639', '42652', '42663', '42670', '43267', '60380', '60446', '71040', '71043',
  '75397', '76269', '76286', '76417', '76419', '76435', '76457', '77092', '80049',
  '910004', '910032', '910047', '910049',
];

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const OUT = outIndex >= 0 ? argv[outIndex + 1]! : 'output/bedrock-entity-qa/favorites-sweep';
const KEEP = argv.includes('--keep');
const targets = argv.filter(a => !a.startsWith('--') && a !== OUT);
const sets = (JSON.parse(readFileSync(INDEX, 'utf8')) as {
  sets: Record<string, { name?: string; models?: IndexModel[]; parts?: number; catalogParts?: number }>;
}).sets;

mkdirSync(OUT, { recursive: true });

interface GrainSummary {
  entity: string; requested: number; coarsest: number; fits: boolean;
  fidelity: number; fidelityAtRequested: number; placementsAtGrain: Record<string, number>;
  cuboids: number; cuboidsAtRequested: number; budget: number;
}
interface Row {
  set: string; name: string; src: string; path: string;
  ok: boolean; valid: boolean | null; bytes: number; seconds: number;
  entities: number; error?: string; validation?: string;
  warnings: string[]; grains: GrainSummary[];
  /** Share of placements NOT at the requested grain — the close-up fidelity cost. */
  coarsenedShare: number | null;
}

const rows: Row[] = [];

for (const set of (targets.length ? targets : FAVOURITES)) {
  const entry = sets[set];
  if (!entry?.models?.length) { console.log(`${set}: not in index`); continue; }
  const model = entry.models[indexedTryOrder(entry.models, entry.catalogParts ?? entry.parts)[0]!]!;
  const file = `${CORPUS}/${model.path}`;
  const pack = `${OUT}/${set}.mcaddon`;
  const row: Row = {
    set, name: entry.name ?? '', src: String(model.src), path: model.path,
    ok: false, valid: null, bytes: 0, seconds: 0, entities: 0, warnings: [], grains: [], coarsenedShare: null,
  };

  if (!existsSync(file)) { row.error = `source missing: ${file}`; rows.push(row); console.log(`${set}: ${row.error}`); continue; }
  if (KEEP && existsSync(pack)) { row.ok = true; row.bytes = statSync(pack).size; rows.push(row); console.log(`${set}: kept`); continue; }

  const started = Date.now();
  // NOT `shell: true`: on Windows that joins argv into one command line, so a
  // first-pick path containing spaces (`LDR/10261 Roller Coaster.mpd`) is split
  // and the export dies with ENOENT on a truncated name.
  const run = spawnSync('bun', ['scripts/_playable_ref.ts', file, pack, `--label=${set}`], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  row.seconds = Math.round((Date.now() - started) / 100) / 10;

  if (run.status !== 0 || !existsSync(pack)) {
    row.error = (run.stderr || run.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
    rows.push(row);
    console.log(`${set}: EXPORT FAILED (${row.seconds}s) ${row.error}`);
    continue;
  }
  row.ok = true;
  row.bytes = statSync(pack).size;
  writeFileSync(`${OUT}/${set}.json`, run.stdout);

  try {
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))) as {
      warnings?: string[]; entities?: Record<string, { grainPlan?: GrainSummary & Record<string, unknown> }>;
    };
    row.warnings = report.warnings ?? [];
    const entities = report.entities ?? {};
    row.entities = Object.keys(entities).length;
    let planned = 0, coarsened = 0;
    for (const [name, diag] of Object.entries(entities)) {
      const plan = diag.grainPlan;
      if (!plan) continue;
      const at = plan.placementsAtGrain ?? {};
      const total = Object.values(at).reduce((sum, n) => sum + n, 0);
      planned += total;
      coarsened += total - (at[String(plan.requested ?? (plan as { requestedMicrocellLdu?: number }).requestedMicrocellLdu)] ?? 0);
      row.grains.push({
        entity: name,
        requested: (plan as { requestedMicrocellLdu?: number }).requestedMicrocellLdu ?? 0,
        coarsest: (plan as { coarsestMicrocellLdu?: number }).coarsestMicrocellLdu ?? 0,
        cuboids: Number((plan as { cuboids?: number }).cuboids ?? 0),
        cuboidsAtRequested: Number((plan as { cuboidsAtRequested?: number }).cuboidsAtRequested ?? 0),
        budget: Number((plan as { budget?: number }).budget ?? 0),
        fits: Boolean(plan.fits), fidelity: Number(plan.fidelity),
        fidelityAtRequested: Number(plan.fidelityAtRequested), placementsAtGrain: at,
      });
    }
    row.coarsenedShare = planned ? +(coarsened / planned).toFixed(4) : null;
  } catch (e) {
    row.error = `report parse: ${e instanceof Error ? e.message : String(e)}`;
  }

  const check = spawnSync('python', ['scripts/_mcaddon_check.py', pack], { encoding: 'utf8' });
  const text = `${check.stdout}\n${check.stderr}`;
  row.valid = /^OK\s/m.test(text) && !/^FAIL\s/m.test(text);
  if (!row.valid) row.validation = text.split('\n').filter(l => /FAIL|!!/.test(l)).join(' | ').slice(0, 400);

  rows.push(row);
  console.log(`${set}: ${row.valid ? 'OK  ' : 'FAIL'} ${String(row.bytes).padStart(8)} bytes  ${String(row.entities).padStart(3)} entities  ${row.seconds}s  coarsened ${row.coarsenedShare === null ? '-' : `${(row.coarsenedShare * 100).toFixed(0)}%`}${row.validation ? `  ${row.validation}` : ''}`);
}

const failures = rows.filter(r => !r.ok || r.valid === false);
writeFileSync(`${OUT}/summary.json`, JSON.stringify({
  exported: rows.filter(r => r.ok).length, failed: failures.length, rows,
}, null, 1));

console.log(`\n${rows.filter(r => r.ok).length}/${rows.length} exported, ${failures.length} problem(s)`);
for (const row of failures) console.log(`  ${row.set}: ${row.error ?? row.validation}`);
console.log(`wrote ${OUT}/summary.json`);
