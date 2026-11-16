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
 * Usage: bun scripts/_favorites_export_sweep.ts [set…] [--out DIR] [--keep] [--geometry DIR] [--with-gabby] [--with-regressions] [--faces=DIR]
 *   Each pack is built under the LEGO tab's label (`Name (set-1)`) and written as `<set>-<name words>.mcaddon`,
 *   the stem the regression set looks for, so `bun scripts/sim.ts DIR --scenario=regressions` tests this build.
 *   --with-gabby  also build the Gabby's Dollhouse sets.
 *   --with-regressions  also build every pack the regression set names (`newStem`): its sets beyond the favourites
 *                 (the Gabby sets, 7140 X-wing) and its fixture packs (`FIXTURE_PACKS`: nimbus-fixture).
 *   --faces=DIR   pass face art to every export (`_playable_ref.ts --faces=`; local builds only).
 *   --keep      do not re-export a set whose .mcaddon is already in DIR.
 *   --geometry  also write each set's part geometry per collider cell to
 *               DIR/<set>.json (`_ix_cell_geometry.ts`), the truth
 *               `_ix_sealed_causes.ts` walks a sealed doorway over.
 * Output: DIR/<stem>.mcaddon, DIR/<stem>.json, DIR/summary.json.
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { firstPickSource, legoTabLabel, packStem, readModelsIndex, sweepTargets } from './favourite-sets.ts';
import { coarsenedShareOf, type EntityContentDiag } from './pack-content.ts';

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const OUT = outIndex >= 0 ? argv[outIndex + 1]! : 'output/bedrock-entity-qa/favorites-sweep';
const KEEP = argv.includes('--keep');
const WITH_GABBY = argv.includes('--with-gabby');
const WITH_REGRESSIONS = argv.includes('--with-regressions');
const FACES = argv.find(a => a.startsWith('--faces='));
const geometryIndex = argv.indexOf('--geometry');
const GEOMETRY = geometryIndex >= 0 ? argv[geometryIndex + 1]! : undefined;
if (GEOMETRY) mkdirSync(GEOMETRY, { recursive: true });
const targets = argv.filter(a => !a.startsWith('--') && a !== OUT && a !== GEOMETRY);
const sets = readModelsIndex();

mkdirSync(OUT, { recursive: true });

interface GrainSummary {
  entity: string; requested: number; coarsest: number; fits: boolean;
  fidelity: number; fidelityAtRequested: number; placementsAtGrain: Record<string, number>;
  cuboids: number; cuboidsAtRequested: number; budget: number;
}
interface Row {
  set: string; name: string; label: string; stem: string; src: string; path: string;
  ok: boolean; valid: boolean | null; bytes: number; seconds: number;
  entities: number; error?: string; validation?: string;
  warnings: string[]; grains: GrainSummary[];
  /** Share of placements NOT at the requested grain — the close-up fidelity cost. */
  coarsenedShare: number | null;
}

const rows: Row[] = [];

// The regression set's stems, loaded only when asked for (it pulls in the simulator's adapters).
const regressionStems = WITH_REGRESSIONS ? (await import('../web/src/sim/adapters/craftmatic/regressions.ts')).REGRESSIONS.map(c => c.newStem) : undefined;
const plan = sweepTargets({ sets: targets, withGabby: WITH_GABBY, ...(regressionStems ? { regressionStems } : {}) });
for (const stem of plan.unknown) console.log(`${stem}: a regression stem that names neither a set nor a fixture (FIXTURE_PACKS) - not built`);
const wantedStems = new Set(regressionStems ?? []);

/** One export: the source, the pack, its label; the row's fields the build fills. */
interface Build { set: string; name: string; label: string; stem: string; src: string; path: string; file: string }
const builds: Build[] = [];
for (const set of plan.sets) {
  const entry = sets[set];
  const pick = firstPickSource(entry);
  if (!entry || !pick) { console.log(`${set}: not in index`); continue; }
  const stem = packStem(set, entry.name);
  // A regression case looks for its pack by stem: a set the index names differently is built, but the case will miss it.
  if (regressionStems && !wantedStems.has(stem) && [...wantedStems].some(w => w.startsWith(`${set}-`))) console.log(`${set}: built as ${stem}, but the regression set names ${[...wantedStems].filter(w => w.startsWith(`${set}-`)).join(', ')}`);
  builds.push({ set, name: entry.name ?? '', label: legoTabLabel(set, entry.name), stem, src: String(pick.model.src), path: pick.model.path, file: pick.file });
}
for (const f of plan.fixtures) builds.push({ set: f.stem, name: f.label, label: f.label, stem: f.stem, src: 'fixture', path: f.file, file: f.file });

for (const b of builds) {
  const { set, label, stem, file } = b;
  const pack = `${OUT}/${stem}.mcaddon`;
  const row: Row = {
    set, name: b.name, label, stem, src: b.src, path: b.path,
    ok: false, valid: null, bytes: 0, seconds: 0, entities: 0, warnings: [], grains: [], coarsenedShare: null,
  };

  if (!existsSync(file)) { row.error = `source missing: ${file}`; rows.push(row); console.log(`${set}: ${row.error}`); continue; }
  if (KEEP && existsSync(pack)) { row.ok = true; row.bytes = statSync(pack).size; rows.push(row); console.log(`${set}: kept`); continue; }

  const started = Date.now();
  // NOT `shell: true`: on Windows that joins argv into one command line, so a
  // first-pick path containing spaces (`LDR/10261 Roller Coaster.mpd`) is split
  // and the export dies with ENOENT on a truncated name.
  const build = GEOMETRY ? ['scripts/_ix_cell_geometry.ts', `${GEOMETRY}/${set}.json`] : ['scripts/_playable_ref.ts'];
  const run = spawnSync('bun', [...build, file, pack, `--label=${label}`, ...(FACES ? [FACES] : [])], {
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
  writeFileSync(`${OUT}/${stem}.json`, run.stdout);

  try {
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'))) as {
      warnings?: string[]; entities?: Record<string, { grainPlan?: GrainSummary & Record<string, unknown> }>;
    };
    row.warnings = report.warnings ?? [];
    const entities = report.entities ?? {};
    row.entities = Object.keys(entities).length;
    for (const [name, diag] of Object.entries(entities)) {
      const plan = diag.grainPlan;
      if (!plan) continue;
      const at = plan.placementsAtGrain ?? {};
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
    row.coarsenedShare = coarsenedShareOf(entities as Record<string, EntityContentDiag>);
  } catch (e) {
    row.error = `report parse: ${e instanceof Error ? e.message : String(e)}`;
  }

  const check = spawnSync('python', ['scripts/_mcaddon_check.py', pack], { encoding: 'utf8' });
  const text = `${check.stdout}\n${check.stderr}`;
  row.valid = /^OK\s/m.test(text) && !/^FAIL\s/m.test(text);
  if (!row.valid) row.validation = text.split('\n').filter(l => /FAIL|!!/.test(l)).join(' | ').slice(0, 400);

  rows.push(row);
  console.log(`${stem}: ${row.valid ? 'OK  ' : 'FAIL'} ${String(row.bytes).padStart(8)} bytes  ${String(row.entities).padStart(3)} entities  ${row.seconds}s  coarsened ${row.coarsenedShare === null ? '-' : `${(row.coarsenedShare * 100).toFixed(0)}%`}${row.validation ? `  ${row.validation}` : ''}`);
}

const failures = rows.filter(r => !r.ok || r.valid === false);
writeFileSync(`${OUT}/summary.json`, JSON.stringify({
  exported: rows.filter(r => r.ok).length, failed: failures.length, rows,
}, null, 1));

console.log(`\n${rows.filter(r => r.ok).length}/${rows.length} exported, ${failures.length} problem(s)`);
for (const row of failures) console.log(`  ${row.set}: ${row.error ?? row.validation}`);
console.log(`wrote ${OUT}/summary.json`);
