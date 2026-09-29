#!/usr/bin/env bun
/**
 * new-set.ts — the craftmatic half of onboarding ONE newly released set.
 *
 * clego's `discovery/new_set.py <sku> --run` harvests the set from LEGO's
 * Builder service the moment its 3D model appears, grades it, lifts its entry
 * into both copies of the models index and publishes file + index to R2. At
 * that point the set is LIVE for the viewer (the worker serves R2), but three
 * things are still missing, and this script does them, in order, and proves
 * each one:
 *
 *   1. index copy   `web/public/lego-models-index.json` was rewritten by clego;
 *                   `--commit` commits and pushes it (the deploy then ships the
 *                   bundled fallback copy; the catalog is rebuilt on deploy too).
 *   2. live check   the live index lists the set, every model path answers 200,
 *                   and — with `--browser` — a real Chrome loads
 *                   `https://craftmatic.click/?tab=lego&set=<sku>` and the
 *                   viewer reports the model drawn (`scripts/_live_set_check.mjs`).
 *   3. the pack     `_playable_ref.ts` builds the rigged .mcaddon from the index's
 *                   first pick with the LEGO tab's label (`Name (sku-1)`, so the
 *                   pack's uuid equals the one the browser export would give and
 *                   every per-set canon keyed on the number applies), then the
 *                   gates: `_mcaddon_check.py`, `_render_fault_audit.ts`,
 *                   `_ix_passability.ts`, and the export report's substituted /
 *                   unresolved parts. A zip + sha256 is written for the phone.
 *
 *   bun scripts/new-set.ts 11390 [--out DIR] [--commit] [--browser] [--faces DIR]
 *                                [--skip-pack] [--label "Name (11390-1)"]
 *
 * Exit 0 when every step it ran passed, 2 when the set is not live yet (nothing
 * to build), 1 on any failed gate. Writes DIR/report.md and DIR/report.json.
 * The tree must be clean to build a pack (the pipeline stamp lands in the pack
 * name; a dirty tree can only say "dirty").
 *
 * — Opus 5.5
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { indexedTryOrder, type LegoModelsIndex, type IndexSetEntry } from '../web/src/engine/lego-sources.ts';

const argv = process.argv.slice(2);
const sku = argv.find(a => !a.startsWith('--'))?.replace(/-\d+$/, '');
if (!sku) { console.error('usage: bun scripts/new-set.ts <set number> [--out DIR] [--commit] [--browser] [--faces DIR] [--skip-pack] [--label "..."]'); process.exit(2); }
const opt = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = resolve(opt('out') ?? `output/new-set-${sku}`);
const COMMIT = argv.includes('--commit');
const BROWSER = argv.includes('--browser');
const SKIP_PACK = argv.includes('--skip-pack');
const FACES = opt('faces');
const LABEL_OVERRIDE = opt('label');
const CORPUS = 'C:/git/clego/lego_sets';
const LOCAL_INDEX = resolve('web/public/lego-models-index.json');
const PROD = process.env['PROD_BASE'] ?? 'https://craftmatic.click';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) craftmatic-new-set/1.0' };

mkdirSync(OUT, { recursive: true });

interface Step { name: string; ok: boolean | null; detail: string }
const steps: Step[] = [];
const step = (name: string, ok: boolean | null, detail: string): void => {
  steps.push({ name, ok, detail });
  console.log(`${ok === null ? '·' : ok ? 'OK ' : 'FAIL'} ${name}: ${detail}`);
};

/** Run a gate; its stdout is kept apart from stderr because the export's report is the JSON on stdout alone. */
const sh = (cmd: string, args: string[], label: string, timeoutMs = 20 * 60_000): { status: number | null; out: string; stdout: string } => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
  const stdout = r.stdout ?? '';
  const out = `${stdout}\n${r.stderr ?? ''}`;
  writeFileSync(`${OUT}/${label}.log`, out);
  return { status: r.status, out, stdout };
};

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? (await r.json()) as T : null;
  } catch { return null; }
}

// ── 1. the set in both indexes ───────────────────────────────────────────────
const local = JSON.parse(readFileSync(LOCAL_INDEX, 'utf8')) as LegoModelsIndex;
const entry: IndexSetEntry | undefined = local.sets[sku];
if (!entry?.models?.length) {
  step('local index', false, `${sku} is not in ${LOCAL_INDEX}; run clego discovery/new_set.py ${sku} --run first`);
  finish(2);
}
const localEntry = entry!;
const pick = localEntry.models[indexedTryOrder(localEntry.models, localEntry.parts)[0]!]!;
step('local index', true, `${sku} "${localEntry.name}" (${localEntry.year}, ${localEntry.parts} parts) -> first pick ${pick.src} ${pick.path}`);

const live = await fetchJson<LegoModelsIndex>(`${PROD}/lego-models-index.json`, 90_000);
const liveEntry = live?.sets[sku];
if (!liveEntry) {
  step('live index', false, `${PROD}/lego-models-index.json does not list ${sku} (clego's publish step re-puts the index last; rerun new_set.py --run)`);
  finish(2);
}
let allLive = true;
const codes: Record<string, number | string> = {};
for (const m of liveEntry!.models) {
  try {
    const r = await fetch(`${PROD}/lego-models/${encodeURI(m.path)}`, { headers: UA, method: 'GET', signal: AbortSignal.timeout(60_000) });
    codes[m.path] = r.status;
    if (r.status !== 200) allLive = false;
  } catch (e) { codes[m.path] = e instanceof Error ? e.name : String(e); allLive = false; }
}
step('live models', allLive, JSON.stringify(codes));
if (!allLive) finish(2);

// ── 2. commit the index copy ─────────────────────────────────────────────────
const indexDirty = spawnSync('git', ['status', '--porcelain', '--', 'web/public/lego-models-index.json'], { encoding: 'utf8' }).stdout.trim() !== '';
if (indexDirty && COMMIT) {
  const add = spawnSync('git', ['add', 'web/public/lego-models-index.json'], { encoding: 'utf8' });
  const msg = `fix(index): ${sku} ${localEntry.name} published - ${liveEntry!.models.length} model(s), first pick ${pick.src}\n\nLifted by clego discovery/new_set.py; R2 and prod read back by scripts/new-set.ts.\n\n— Opus 5.5`;
  const commit = spawnSync('git', ['commit', '-m', msg, '--', 'web/public/lego-models-index.json'], { encoding: 'utf8' });
  const push = commit.status === 0 ? spawnSync('git', ['push'], { encoding: 'utf8' }) : null;
  const ok = add.status === 0 && commit.status === 0 && push?.status === 0;
  step('index commit', ok, ok ? (commit.stdout.split('\n')[0] ?? 'committed') + ' and pushed' : `${commit.stderr || commit.stdout}${push?.stderr ?? ''}`.trim().slice(0, 300));
} else {
  step('index commit', indexDirty ? null : true, indexDirty ? 'web/public/lego-models-index.json is modified and uncommitted; pass --commit (or commit it yourself) before building the pack' : 'index copy already committed');
}

// ── 3. the browser proves the render ─────────────────────────────────────────
if (BROWSER) {
  const shot = `${OUT}/live-${sku}.png`;
  const r = sh('node', ['scripts/_live_set_check.mjs', sku, '--out', shot, '--base', PROD], 'live-browser', 4 * 60_000);
  let detail = r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 400);
  try { const j = JSON.parse(r.out.slice(r.out.lastIndexOf('{'))); detail = `${j.ok ? 'drawn' : 'NOT drawn'} in ${j.seconds}s — badge "${j.badge}"${j.status ? ` — status "${j.status}"` : ''}${j.errors?.length ? ` — ${j.errors.length} console error(s)` : ''}; ${shot}`; } catch { /* keep the tail */ }
  step('live render', r.status === 0, detail);
} else {
  step('live render', null, 'skipped (pass --browser to load the set in Chrome against prod; needs node + playwright-core)');
}

// ── 4. the pack ──────────────────────────────────────────────────────────────
if (!SKIP_PACK) {
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim();
  if (dirty) {
    step('pack', false, `the tree is dirty; commit first (the pipeline stamp in the pack name would read "dirty"):\n${dirty.split('\n').slice(0, 8).join('\n')}`);
    finish(1);
  }
  const source = `${CORPUS}/${pick.path}`;
  if (!existsSync(source)) { step('pack', false, `source missing: ${source}`); finish(1); }
  // The LEGO tab's label: `Name (sku-1)`; the pack uuid follows it, and any
  // per-set canon keys on the number inside it.
  const label = LABEL_OVERRIDE ?? `${localEntry.name || sku} (${sku}-1)`;
  const pack = `${OUT}/${sku}.mcaddon`;
  const args = ['scripts/_playable_ref.ts', source, pack, `--label=${label}`];
  if (FACES) args.push(`--faces=${FACES}`);
  const started = Date.now();
  const build = sh('bun', args, 'export', 45 * 60_000);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (build.status !== 0 || !existsSync(pack)) {
    step('pack', false, `export exited ${build.status} after ${seconds}s: ${build.out.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
    finish(1);
  }
  // The report is the JSON object on STDOUT (what _favorites_export_sweep.ts
  // reads); a parse failure is a failed gate, not an empty report - an empty
  // report would read as "0 unresolved parts".
  let report: Record<string, unknown> | null = null;
  try { report = JSON.parse(build.stdout.slice(build.stdout.indexOf('{'))) as Record<string, unknown>; } catch { report = null; }
  if (!report) { step('pack', false, `the export printed no parsable report on stdout (see ${OUT}/export.log)`); finish(1); }
  writeFileSync(`${OUT}/${sku}.export.json`, JSON.stringify(report, null, 1));
  // Part resolution is reported PER ENTITY (shell, each figure, each vehicle):
  // `unresolvedParts`, `substitutedParts` and `aabbFallbackParts` lists under
  // `entities.<id>`. Summed here; the names are kept for the report.
  type EntityDiag = { unresolvedParts?: string[]; substitutedParts?: unknown[]; aabbFallbackParts?: string[] };
  const entityDiags = Object.entries((report['entities'] as Record<string, EntityDiag> | undefined) ?? {});
  const unresolved = entityDiags.flatMap(([, d]) => d.unresolvedParts ?? []);
  const substituted = entityDiags.reduce((n, [, d]) => n + (d.substitutedParts?.length ?? 0), 0);
  const aabb = entityDiags.flatMap(([, d]) => d.aabbFallbackParts ?? []);
  const warnings = (report['warnings'] as string[] | undefined) ?? [];
  const entities = entityDiags.length;
  step('pack', true, `${pack} (${(statSync(pack).size / 1024 / 1024).toFixed(1)} MB, ${entities} entities, ${seconds}s, label "${label}")`);
  step('parts resolved', unresolved.length === 0 && aabb.length === 0,
    `${unresolved.length} unresolved${unresolved.length ? ` (${[...new Set(unresolved)].slice(0, 8).join(', ')})` : ''}, ${aabb.length} drawn as boxes${aabb.length ? ` (${[...new Set(aabb)].slice(0, 8).join(', ')})` : ''}, ${substituted} substituted over ${entities} entities${warnings.length ? `; ${warnings.length} warning(s)` : ''}`);

  const check = sh('python', ['scripts/_mcaddon_check.py', pack], 'mcaddon-check');
  const checkOk = /^OK\s/m.test(check.out) && !/^FAIL\s/m.test(check.out);
  step('mcaddon check', checkOk, checkOk ? 'OK' : check.out.split('\n').filter(l => /FAIL|!!/.test(l)).join(' | ').slice(0, 400));

  const faults = sh('bun', ['scripts/_render_fault_audit.ts', `--json=${OUT}/render-faults.json`, pack], 'render-faults');
  step('render faults', faults.status === 0, faults.out.trim().split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 400));

  const pass = sh('bun', ['scripts/_ix_passability.ts', pack, `--json=${OUT}/passability.json`], 'passability');
  const passLines = pass.out.split('\n').filter(l => /\b(OK|FAIL|SMALL|SEALED|STEP|NO-APPROACH)\b/.test(l));
  const fails = passLines.filter(l => /\bFAIL\b/.test(l)).length;
  step('passability', pass.status === 0, `${passLines.length} doorway checks, ${fails} FAIL (exit ${pass.status})`);

  // Zip + sha256 for the phone (one archive per round, the user's rule).
  const stamp = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const zip = `${OUT}/craftmatic-${sku}-${stamp}.zip`;
  const z = spawnSync('python', ['-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.write(sys.argv[2], sys.argv[3]); z.close()`, zip, pack, `${sku}.mcaddon`], { encoding: 'utf8' });
  if (z.status === 0) {
    const sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
    writeFileSync(`${zip}.sha256`, `${sha}  ${zip.split(/[\\/]/).pop()}\n`);
    step('zip', true, `${zip} sha256 ${sha}`);
  } else step('zip', false, z.stderr.slice(0, 300));
}

finish(steps.some(s => s.ok === false) ? 1 : 0);

function finish(code: number): never {
  const md = [
    `# New set ${sku} — ${localEntry?.name ?? ''}`, '',
    `Run ${new Date().toISOString()} against ${PROD}; output ${OUT}`, '',
    '| step | result | detail |', '|---|---|---|',
    ...steps.map(s => `| ${s.name} | ${s.ok === null ? 'skipped' : s.ok ? 'OK' : 'FAIL'} | ${s.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '',
    code === 0 ? 'Every step that ran passed.' : code === 2 ? 'Not live yet — nothing built.' : 'A gate failed; see the logs beside this report.',
    '',
  ].join('\n');
  writeFileSync(`${OUT}/report.md`, md);
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ sku, prod: PROD, steps, exit: code }, null, 1));
  console.log(`\nwrote ${OUT}/report.md (exit ${code})`);
  process.exit(code);
}
