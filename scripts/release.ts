#!/usr/bin/env bun
/**
 * release.ts: the one release command (plan D 3.3).
 *
 *   bun scripts/release.ts init-product <id>
 *   bun scripts/release.ts prepare <product> [--version x.y.z] [--out <dir>] [--strict]
 *
 * `init-product` (X-01) mints a product's frozen Bedrock identity ONCE: five random v4 uuids, written to
 * release/products/<id>.json with `namespace: null` (the brand is undecided, U1); it refuses to overwrite.
 *
 * `prepare` (D-08) builds a release OFFLINE in a NEW git worktree of the current commit and runs every gate:
 *   preconditions (clean tracked tree, releasable product, rising version, toolchain pins), identity (X-01),
 *   the X-02 profile build, official-library mode (X-04, `assertOfficialLibrary()` called explicitly because the
 *   pipeline turns its error into a warning), the licence gate, the namespace rewrite (X-03), notices and credits
 *   (X-04/X-05), the forbidden-terms lint (X-05), the curated changelog (D-06), the deterministic zip (D-03), the
 *   release validator (X-06), the budget (M06), the Script API audit (M15) and `mct validate`.
 * It writes <out>/{dist/*, SHA256SUMS, release.json, validation.json, CHANGELOG.md, NOTICE.txt, CREDITS-LDRAW.txt,
 * channels/*, APPROVAL.md}. It contains NO upload code and runs no tag, push or deploy: APPROVAL.md lists every
 * outward action, unchecked, for the user.
 *
 * Stages whose dependency is not merged (M03, M07, M14) are recorded as `skipped` with the reason (never passed),
 * and a gate that could not run (a missing EULA) is `not-run`. Both are listed as OPEN gates in APPROVAL.md.
 *
 * The worktree is NEVER removed (the project forbids recursive deletes): each run takes a new
 * `release-<product>-<version>-<n>` folder and prints its path. `--out` must not already hold files.
 *
 * Environment:
 *   CRAFTMATIC_RELEASE_ROOT       repo root (tests use a throwaway repo)
 *   CRAFTMATIC_RELEASE_DATA       release data root (default <root>/release); a non-default root marks the run FIXTURE
 *   CRAFTMATIC_RELEASE_WORKTREES  folder for the build worktrees (default <root>/.worktrees)
 *   CRAFTMATIC_LDRAW_REF          the local LDraw mirror (official/, unofficial/, _archives/)
 *   CRAFTMATIC_RELEASE_MCT=skip-for-test   record the mct gate as not-run without starting bunx (test runs only)
 *
 * TODO(d08-finalize): `finalize`, `verify` and `status` (plan D 3.3) are not implemented yet.
 * TODO(d08-io): the build step reads `.ldr` / `.mpd` text models only; `.io` and `.lxf` sources need the loaders
 *   `_playable_ref.ts` carries inline (extract them to a shared module first).
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PRODUCT_ID_PATTERN, parseProduct, validateProduct } from '../web/src/release/product.js';
import { sha256Hex, sha256sumsText } from '../web/src/release/checksums.js';
import {
  applyWaivers, approvalItems, channelStub, CHANNELS, openGates, pendingGates, preconditionProblems, profileProblems, renderApproval, renderNotice,
  resolveVersion, type ApprovalAction, type Gate, type GateWaiver, type ValidationFile,
} from '../web/src/release/prepare.js';
import { formatSemVer, toManifestTriple } from '../web/src/release/semver.js';
import type { IdentityLedgerEntry, ProductRecord, ReleasedVersion, SemVer } from '../web/src/release/types.js';

const ROOT = resolve(process.env.CRAFTMATIC_RELEASE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

/** Script module versions the dev pack manifest declares today (engine/mcpack.ts), pinned for release builds. */
// TODO(X-02): read these from one shared constant once the profile seam lands; they are copied from mcpack.ts:240-241 and :224.
const SCRIPT_MODULES = { server: '2.9.0', serverUi: '2.1.0' };
const MIN_ENGINE_VERSION: [number, number, number] = [1, 26, 40];

/** `my-pack` -> `MyPack`. */
const pascal = (id: string): string => id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

/** Exact `bun --version`, or null when bun cannot be run. */
function bunVersion(): string | null {
  const r = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Builds the new record. Stand-in fields are listed in `placeholders` (data, so `prepare` refuses while any remain). */
function mintProduct(id: string): ProductRecord {
  const bun = bunVersion();
  const lockPath = join(ROOT, 'bun.lock');
  if (bun === null) throw new Error('cannot run `bun --version`; the toolchain pin needs it');
  if (!existsSync(lockPath)) throw new Error(`no bun.lock at ${lockPath}; the toolchain pin needs it`);
  const stem = pascal(id);
  return {
    id,
    displayName: stem,
    tier: 'free',
    identity: {
      namespace: null,
      folderStem: stem,
      uuids: { bpHeader: randomUUID(), bpData: randomUUID(), bpScript: randomUUID(), rpHeader: randomUUID(), rpResources: randomUUID() },
    },
    placeholders: ['namespace', 'folderStem', 'displayName', 'publisher'],
    designs: [],
    toolchain: {
      bun,
      lockfileSha256: createHash('sha256').update(readFileSync(lockPath)).digest('hex'),
      // The pin is filled when the product is first prepared for real: `prepare` refuses a null archive hash.
      ldrawLibrary: { archive: 'complete.zip', sha256: null, root: 'ldraw_ref/official' },
      scriptModules: SCRIPT_MODULES,
      minEngineVersion: MIN_ENGINE_VERSION,
    },
    versions: [],
    publisher: null,
  };
}

function initProduct(id: string | undefined): number {
  if (!id || !PRODUCT_ID_PATTERN.test(id)) {
    console.error(`usage: release.ts init-product <id>   (id must match ${PRODUCT_ID_PATTERN})`);
    return 2;
  }
  const file = join(ROOT, 'release', 'products', `${id}.json`);
  if (existsSync(file)) {
    console.error(`product ${id} already exists at ${file}; identities are minted once and never overwritten`);
    return 1;
  }
  const record = mintProduct(id);
  const problems = validateProduct(record);
  if (problems.length > 0) throw new Error(`minted record is invalid: ${problems.join('; ')}`);
  mkdirSync(dirname(file), { recursive: true });
  // 'wx' fails if the file appeared since the check, so two racing mints cannot both win.
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  console.log(`minted ${file} (namespace null until U1)`);
  return 0;
}

/* ------------------------------------------------------------------------------------------------------------- */
/* prepare                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------- */

/** What a product's build needs beyond its registry record: `<data>/builds/<id>.json`. */
interface BuildSidecar {
  /** Source model, relative to the data root (`.ldr` / `.mpd`). */
  model: string;
  /** One player-facing sentence (lint-clean); the pack description and the README body. */
  summary: string;
  vehicleMode?: 'auto' | 'car' | 'plane' | 'boat' | 'static';
  quality?: 'balanced' | 'high' | 'ultra';
  buildings?: 'bricks' | 'blocks';
  scale?: string;
  lod?: 'none' | 'hull';
  mainOnly?: boolean;
  /** Extra listing / copy files (relative to the data root) the text lint must read. */
  copy?: string[];
}

/** The message `_make` receives (a JSON file path in argv). */
interface MakeSpec {
  product: ProductRecord;
  version: SemVer;
  dataRoot: string;
  build: BuildSidecar;
  ldrawRef: string;
  /** Output folder: dist/ and the notices are written here. */
  out: string;
  /** Commit time in epoch milliseconds: the one clock of the build. */
  clockMs: number;
}

/** What `_make` hands back. */
interface MakeResult {
  gates: Gate[];
  evidence: Record<string, unknown>;
  files: string[];
  /** Names of the zip artifacts inside `<out>/dist`. */
  artifacts: string[];
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** Run git in `cwd`; returns stdout (trimmed) or throws with git's own message. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** Where the local LDraw mirror lives (the same lookup `_playable_ref.ts` and vitest use). */
function ldrawRefDir(): string | null {
  // TODO(d08-ldraw-ref): drop the machine-specific fallback once the pinned official library is vendored.
  for (const dir of [process.env.CRAFTMATIC_LDRAW_REF, join(ROOT, 'ldraw_ref'), 'C:/git/clego/ldraw_ref']) {
    if (dir && existsSync(join(dir, 'official'))) return resolve(dir);
  }
  return null;
}

/** The first free `release-<product>-<version>-<n>` folder under `base` (never reused, never removed). */
function freshWorktreePath(base: string, product: string, version: string): string {
  for (let n = 1; ; n++) {
    const path = join(base, `release-${product}-${version}-${n}`);
    if (!existsSync(path)) return path;
  }
}

/** Run a script of the release worktree with bun; returns the process result with both streams as text. */
function runBun(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 20 * 60_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

const lastLines = (s: string, n = 6): string => s.trim().split(/\r?\n/).slice(-n).join(' | ');

/** `prepare <product>`: returns the process exit code. */
function prepare(productId: string | undefined, argv: string[]): number {
  if (!productId || !PRODUCT_ID_PATTERN.test(productId)) {
    console.error('usage: release.ts prepare <product> [--version x.y.z] [--out <dir>] [--strict]');
    return 2;
  }
  const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const dataRoot = resolve(process.env.CRAFTMATIC_RELEASE_DATA ?? join(ROOT, 'release'));
  const fixture = dataRoot !== resolve(join(ROOT, 'release'));
  const productFile = join(dataRoot, 'products', `${productId}.json`);
  if (!existsSync(productFile)) { console.error(`no product ${productId}: ${productFile} does not exist`); return 1; }
  const product = parseProduct(readFileSync(productFile, 'utf8'));
  const ledgerFile = join(dataRoot, 'identity-ledger.json');
  const ledger = existsSync(ledgerFile) ? readJson<IdentityLedgerEntry[]>(ledgerFile) : [];

  // ---- 1. preconditions -------------------------------------------------------------------------------------
  const version = resolveVersion(productId, ledger, flag('version'));
  const dirtyFiles = git(ROOT, 'status', '--porcelain', '--untracked-files=no').split(/\r?\n/).filter(Boolean).map(l => l.slice(3));
  const lockFile = join(ROOT, 'bun.lock');
  const ref = ldrawRefDir();
  const archive = ref ? join(ref, '_archives', product.toolchain.ldrawLibrary.archive) : null;
  const problems = preconditionProblems({
    product, ledger, version, dirtyFiles, bunVersion: bunVersion(),
    lockfileSha256: existsSync(lockFile) ? sha256Hex(readFileSync(lockFile)) : null,
    ldrawArchiveSha256: archive && existsSync(archive) ? sha256Hex(readFileSync(archive)) : null,
  });
  if (problems.length > 0) {
    console.error(`prepare ${productId} refused:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    return 1;
  }
  const versionText = formatSemVer(version);
  const buildFile = join(dataRoot, 'builds', `${productId}.json`);
  if (!existsSync(buildFile)) { console.error(`prepare ${productId} refused: no build description at ${buildFile}`); return 1; }
  const build = readJson<BuildSidecar>(buildFile);
  const out = resolve(flag('out') ?? process.env.CRAFTMATIC_RELEASE_OUT ?? join(ROOT, 'output', 'releases', productId, versionText));
  if (existsSync(out) && readdirSync(out).length > 0) { console.error(`prepare ${productId} refused: ${out} already holds files (nothing is overwritten or deleted; use --out <new folder>)`); return 1; }
  mkdirSync(out, { recursive: true });

  // ---- 2. a NEW worktree of the commit, never removed ------------------------------------------------------
  const commit = git(ROOT, 'rev-parse', 'HEAD');
  const commitSeconds = Number(git(ROOT, 'show', '-s', '--format=%ct', commit));
  const worktrees = resolve(process.env.CRAFTMATIC_RELEASE_WORKTREES ?? join(ROOT, '.worktrees'));
  mkdirSync(worktrees, { recursive: true });
  const wt = freshWorktreePath(worktrees, productId, versionText);
  git(ROOT, 'worktree', 'add', '--detach', wt, commit);
  console.log(`worktree ${wt} (commit ${commit}); it is left in place`);
  // The worktree has no node_modules: link the checkout's (the lockfile pin above proves they match the commit).
  if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(wt, 'node_modules'), 'junction');
  const wtData = fixture ? dataRoot : join(wt, 'release');

  // ---- 3. build + in-process gates, inside the worktree ----------------------------------------------------
  const spec: MakeSpec = { product, version, dataRoot: wtData, build, ldrawRef: ref!, out, clockMs: commitSeconds * 1000 };
  const specFile = join(out, '.make-spec.json');
  writeFileSync(specFile, JSON.stringify(spec));
  const make = runBun(wt, [join(wt, 'scripts', 'release.ts'), '_make', specFile], {
    CRAFTMATIC_RELEASE_ROOT: wt,
    CRAFTMATIC_LDRAW_LIBRARY: 'official',
    CRAFTMATIC_LDRAW_REF: ref!,
    CRAFTMATIC_LDRAW_MIRROR: 'off',
    SOURCE_DATE_EPOCH: String(commitSeconds),
  });
  const resultFile = join(out, 'make-result.json');
  if (!existsSync(resultFile)) { console.error(`build step crashed (exit ${make.status}): ${lastLines(make.stderr)}`); return 1; }
  const made = readJson<MakeResult>(resultFile);
  const gates: Gate[] = [...made.gates];
  const evidence: Record<string, unknown> = { ...made.evidence };
  const failed = (): boolean => gates.some(g => g.status === 'fail');

  // ---- 4. gates that run a tool over the finished archives -------------------------------------------------
  const dist = join(out, 'dist');
  const archives = made.artifacts.map(n => join(dist, n));
  if (!failed()) {
    const py = spawnSync('python', ['-I', join(wt, 'scripts', '_mcaddon_check.py'), '--release', ...archives], { cwd: wt, encoding: 'utf8' });
    const problemLines = py.stdout.split(/\r?\n/).filter(l => l.includes('!! ')).map(l => l.slice(l.indexOf('!! ') + 3));
    const waiversFile = join(fixture ? dataRoot : join(wt, 'release'), 'gate-waivers.json');
    const { uncovered, waived } = applyWaivers('release-validator', problemLines, existsSync(waiversFile) ? readJson<GateWaiver[]>(waiversFile) : []);
    const title = 'X-06 _mcaddon_check.py --release on .mcaddon and .zip';
    if (py.status === 0) gates.push({ id: 'release-validator', title, status: 'pass', detail: 'every archive passes the dev and release rules' });
    else if (problemLines.length === 0 || uncovered.length > 0) gates.push({ id: 'release-validator', title, status: 'fail', detail: (uncovered.length ? uncovered : [lastLines(py.stdout + (py.stderr ?? ''), 12)]).join('; ') });
    else gates.push({ id: 'release-validator', title, status: 'waived', detail: waived.map(w => `${w.problem} [waived: ${w.reason}]`).join('; ') });
    evidence['release-validator'] = py.stdout;
  }
  if (!failed()) {
    if (process.env.CRAFTMATIC_RELEASE_MCT === 'skip-for-test') {
      gates.push({ id: 'mct', title: 'mct validate (Minecraft Creator Tools)', status: 'not-run', detail: 'skipped by CRAFTMATIC_RELEASE_MCT=skip-for-test (test runs do not start bunx); run it for a real release (needs U13: the EULA)' });
    } else {
      const m = runBun(wt, [join(wt, 'scripts', 'release-mctools.ts'), archives[0]!, '--json'], {}, 15 * 60_000);
      let report: { status: string; errors?: number; warnings?: number; reason?: string } | null = null;
      try { report = JSON.parse(m.stdout) as typeof report; } catch { report = null; }
      if (!report) gates.push({ id: 'mct', title: 'mct validate', status: 'not-run', detail: `mct output was not JSON (exit ${m.status}): ${lastLines(m.stdout + m.stderr)}` });
      else if (report.status === 'not-run') gates.push({ id: 'mct', title: 'mct validate', status: 'not-run', detail: report.reason ?? 'mct did not run' });
      else gates.push({ id: 'mct', title: 'mct validate', status: (report.errors ?? 1) === 0 ? 'pass' : 'fail', detail: `${report.errors} error(s), ${report.warnings} warning(s)` });
      evidence.mct = report;
    }
  }
  if (!failed()) {
    const jsonFile = join(out, 'budget.json');
    const b = runBun(wt, [join(wt, 'scripts', '_marketplace_budget.ts'), archives[0]!, `--json=${jsonFile}`]);
    if (!existsSync(jsonFile)) gates.push({ id: 'budget', title: 'M06 runtime budget (standard tier)', status: 'fail', detail: `no budget report (exit ${b.status}): ${lastLines(b.stdout + b.stderr)}` });
    else {
      const [row] = readJson<Array<{ report: { verdict: 'pass' | 'fail' | 'incomplete'; runtimeReason?: string; rows: Array<{ metric: string; status: string }> } }>>(jsonFile);
      evidence.budget = row;
      const rows = row!.report.rows;
      const failedRows = rows.filter(r => r.status === 'fail').map(r => r.metric);
      gates.push({ id: 'budget', title: 'M06 static budget rows (standard tier)', status: failedRows.length ? 'fail' : 'pass', detail: failedRows.length ? `over the limit: ${failedRows.join(', ')}` : `${rows.filter(r => r.status === 'pass').length} rows within the limit` });
      const notMeasured = rows.filter(r => r.status === 'not-measured').map(r => r.metric);
      if (notMeasured.length) gates.push({ id: 'budget-runtime', title: 'M06 runtime rows (resident entities, script ms)', status: 'skipped', detail: `${notMeasured.join(', ')} not measured: ${row!.report.runtimeReason ?? 'the simulator could not place the pack'} (needs M14)` });
    }
  }
  if (!failed()) {
    const jsonFile = join(out, 'script-api.json');
    const a = runBun(wt, [join(wt, 'scripts', '_script_api_audit.ts'), archives[0]!, `--json=${jsonFile}`]);
    gates.push({ id: 'script-api', title: 'M15 stable Script API audit', status: a.status === 0 ? 'pass' : 'fail', detail: a.status === 0 ? 'no beta API, no beta module' : lastLines(a.stdout + a.stderr, 10) });
    if (existsSync(jsonFile)) evidence['script-api'] = readJson<unknown>(jsonFile);
  }
  gates.push(...pendingGates());

  const validation: ValidationFile = { product: productId, version: versionText, commit, fixture, gates, evidence };
  writeFileSync(join(out, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
  for (const g of gates) console.log(`${g.status.toUpperCase().padEnd(7)} ${g.id}: ${g.detail.slice(0, 200)}`);
  if (failed()) {
    console.error(`prepare ${productId} stopped: a gate failed (see ${join(out, 'validation.json')}). Worktree: ${wt}`);
    return 1;
  }

  // ---- 5. checksums, release.json, notices, channel stubs, approval sheet ----------------------------------
  const artifactFiles = made.artifacts.map(n => ({ name: `dist/${n}`, data: new Uint8Array(readFileSync(join(dist, n))) }));
  const notices = ['CHANGELOG.md', 'NOTICE.txt', 'CREDITS-LDRAW.txt'].map(n => ({ name: n, data: new Uint8Array(readFileSync(join(out, n))) }));
  const record: ReleasedVersion = {
    version, commit, tag: null, sourceDateEpoch: commitSeconds,
    artifacts: artifactFiles.map(f => ({ file: f.name, sha256: sha256Hex(f.data), bytes: f.data.length })),
    deviceEvidence: null,
  };
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(record, null, 2)}\n`);
  const actions = readJson<ApprovalAction[]>(join(wt, 'release', 'approval-actions.json'));
  const items = approvalItems(actions, { product: productId, version: versionText, commit });
  for (const channel of CHANNELS) {
    mkdirSync(join(out, 'channels', channel), { recursive: true });
    for (const [name, text] of Object.entries(channelStub(channel, items))) writeFileSync(join(out, 'channels', channel, name), text);
  }
  writeFileSync(join(out, 'APPROVAL.md'), renderApproval({ product: productId, version: versionText, commit, fixture, gates, items, artifacts: record.artifacts }));
  const sumInputs = [...artifactFiles, ...notices, ...['release.json', 'validation.json', 'APPROVAL.md'].map(n => ({ name: n, data: new Uint8Array(readFileSync(join(out, n))) }))];
  writeFileSync(join(out, 'SHA256SUMS'), sha256sumsText(sumInputs));

  const open = openGates(gates);
  console.log(`prepared ${productId} ${versionText} in ${out}`);
  console.log(`  worktree (left in place): ${wt}`);
  console.log(`  open gates: ${open.length}${open.length ? ` (${open.map(g => g.id).join(', ')})` : ''}; read APPROVAL.md before doing anything outward`);
  return argv.includes('--strict') && open.length > 0 ? 4 : 0;
}

/* ------------------------------------------------------------------------------------------------------------- */
/* _make: runs INSIDE the release worktree, so the bytes come from the commit's own code                          */
/* ------------------------------------------------------------------------------------------------------------- */

/** Build the pack and run the in-process gates; writes dist/, notices and make-result.json into `spec.out`. */
async function make(specFile: string): Promise<void> {
  const spec = readJson<MakeSpec>(specFile);
  const { product, version, build, out } = spec;
  const gates: Gate[] = [];
  const evidence: Record<string, unknown> = {};
  const writeResult = (artifacts: string[]): void => {
    writeFileSync(join(out, 'make-result.json'), JSON.stringify({ gates, evidence, files: [], artifacts } satisfies MakeResult, null, 1));
  };
  /** Record a gate; true when it passed (the caller stops at the first failure, as the plan says). */
  const record = (id: string, title: string, problems: string[], pass: string): boolean => {
    gates.push({ id, title, status: problems.length ? 'fail' : 'pass', detail: problems.length ? problems.slice(0, 12).join('; ') : pass });
    return problems.length === 0;
  };

  const { releaseBuildIdentity } = await import('../web/src/release/identity-ledger.js');
  const ledgerFile = join(spec.dataRoot, 'identity-ledger.json');
  const ledger = existsSync(ledgerFile) ? readJson<IdentityLedgerEntry[]>(ledgerFile) : [];
  let identity: ReturnType<typeof releaseBuildIdentity>['identity'];
  try { identity = releaseBuildIdentity(product, version, ledger).identity; }
  catch (e) { record('identity', 'X-01 frozen identity, version rises', [(e as Error).message], ''); return writeResult([]); }
  record('identity', 'X-01 frozen identity, version rises', [], `${identity.namespace}, ${formatSemVer(version)}, five registry uuids`);

  // The curated changelog is the source of the in-pack notes: no section for this version, no release (D-06).
  const { checkChangelog, parseChangelog, renderPackText } = await import('../web/src/release/changelog.js');
  const changelogText = readFileSync(join(spec.dataRoot, 'changelogs', `${product.id}.md`), 'utf8');
  const doc = parseChangelog(changelogText);
  const changelogProblems = checkChangelog(doc, product.versions.map(v => formatSemVer(v.version)));
  if (!doc.releases.some(r => r.version === formatSemVer(version))) changelogProblems.push(`no curated changelog section for ${formatSemVer(version)}`);
  if (!record('changelog', 'D-06 curated changelog has this version', changelogProblems, `section ${formatSemVer(version)} present, ${doc.releases.length} section(s) valid`)) return writeResult([]);

  // ---- the profile build (X-02), official library only (X-04) ----
  const { setLDrawLibraryMode, setLDrawRoot, assertOfficialLibrary, getPartSourceLedger, seedDatTexts } = await import('../web/src/engine/ldraw-geometry.js');
  const { embeddedPartTexts, parseLDrawDocument } = await import('../web/src/engine/ldraw-parser.js');
  const { synthesizeLSynth } = await import('../web/src/engine/lsynth.js');
  const { runSchemPipeline } = await import('../web/src/engine/schem-pipeline.js');
  const { planResolutionAtCell, spanOfBricks, DEFAULT_SCHEM_SETTINGS } = await import('../web/src/engine/schem-settings.js');
  const { planAddonScale } = await import('../web/src/engine/addon-scale.js');
  const { LDU_PER_BLOCK } = await import('../web/src/engine/lego-scale.js');
  const { withDisclaimer, disclaimerFile, disclaimerText, checkDisclaimer } = await import('../web/src/engine/pack-text/notices.js');
  const { playerStrings } = await import('../web/src/engine/pack-text/strings.js');
  const { lintPackFiles, lintText, DISCLAIMER_EXEMPTION } = await import('../web/src/engine/pack-text/lint.js');
  const { renderCredits } = await import('../web/src/engine/credits.js');
  const { licenceGate } = await import('../web/src/engine/part-source.js');
  const { optionsFromIdentity, rewritePack, assertNoResidual, findDanglingReferences } = await import('../web/src/engine/marketplace/rewrite.js');
  const { createZip, extractFile, listZipEntries } = await import('../web/src/engine/zip-utils.js');
  const pako = (await import('pako')).default;

  setLDrawLibraryMode('official');
  setLDrawRoot(join(spec.ldrawRef, 'official'));
  const modelFile = join(spec.dataRoot, build.model);
  if (!/\.(ldr|mpd)$/i.test(modelFile)) throw new Error(`prepare builds .ldr / .mpd models only (TODO d08-io): ${build.model}`);
  const ldrDoc = parseLDrawDocument(synthesizeLSynth(readFileSync(modelFile, 'utf8')).text);
  // Embedded sub-parts are caller-supplied text, so official mode will refuse any that a model carries (by design).
  seedDatTexts(embeddedPartTexts(ldrDoc));
  const bricks = ldrDoc.bricks;

  const creator = identity.namespace.split('_')[0]!;
  const summary = build.summary;
  const profile: import('../web/src/engine/pack-profile.js').PackProfile = {
    identity,
    version: toManifestTriple(version),
    clock: spec.clockMs,
    texts: {
      packName: product.displayName,
      bpDescription: withDisclaimer(summary),
      rpDescription: withDisclaimer(playerStrings.resourceDescription()),
      readme: `${product.displayName}\n\n${summary}\n\n${disclaimerText(product.publisher, { requirePublisher: true })}\nSee CREDITS.txt and CHANGELOG.txt.\n`,
      lang: {},
    },
    flags: { vanillaTextures: false, diagnostics: false, faceArt: false, devStamp: false, explicitOnly: true },
    deflate: (d: Uint8Array) => pako.deflateRaw(d, { level: 9 }),
  };
  const scalePlan = planAddonScale(bricks, (build.scale as Parameters<typeof planAddonScale>[1] | undefined) ?? 'auto', product.displayName, { packProfile: profile });
  const plan = planResolutionAtCell(spanOfBricks(bricks), scalePlan.lduPerBlock);
  const modelScale = Math.round(LDU_PER_BLOCK / plan.cellLDU * 1000) / 1000;
  const result = await runSchemPipeline({
    source: { kind: 'bricks', bricks, colorSpace: 'ldraw', options: { cellLDU: plan.cellLDU, maxDim: 700 } },
    format: 'mcaddon',
    packStem: identity.namespace.slice(creator.length + 1),
    packLabel: product.displayName,
    profile: DEFAULT_SCHEM_SETTINGS.profile,
    lightFill: false,
    shapes: false,
    vehicleMode: build.vehicleMode ?? 'auto',
    vehicleFacing: 'auto',
    entityQuality: build.quality ?? 'balanced',
    cameraStyle: 'orbit',
    mainVehicleOnly: build.mainOnly ?? false,
    buildingFidelity: build.buildings ?? 'bricks',
    modelScale,
    lod: build.lod ?? 'hull',
    packProfile: profile,
  }, () => undefined);
  if (!result.bytes) throw new Error('the pipeline returned no archive');
  const rawBuf = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength) as ArrayBuffer;
  let files: Array<{ name: string; data: Uint8Array }> = [];
  for (const name of listZipEntries(rawBuf)) if (!name.endsWith('/')) files.push({ name, data: new Uint8Array(await extractFile(rawBuf, name)) });

  if (!record('profile', 'X-02 profile: registry uuids, semver, world scope, no diagnostics', profileProblems(files, identity, version), `${files.length} files carry the frozen identity`)) return writeResult([]);

  // The pipeline turns an official-mode error into a warning; the gate calls it itself over everything resolved.
  let officialProblem: string[] = [];
  try { assertOfficialLibrary(); } catch (e) { officialProblem = [(e as Error).message]; }
  const ledgerEntries = getPartSourceLedger();
  evidence.partSources = ledgerEntries.length;
  if (!record('official-library', 'X-04 official-only library mode (assertOfficialLibrary)', officialProblem, `${ledgerEntries.length} part files, all from the official LDraw tree`)) return writeResult([]);
  const licence = licenceGate(ledgerEntries);
  const substituted = ledgerEntries.filter(e => e.kind === 'substituted');
  if (!record('licence', 'X-04 licence gate: every part CC BY LDraw.org, no alias served', [
    ...licence.offending.map(e => `${e.part}: ${e.kind} / ${e.licence ?? 'no licence line'}`),
    ...substituted.map(e => `${e.part}: served by alias ${e.servedAs}`),
  ], `${ledgerEntries.length} entries licensed, 0 substituted, 0 unresolved`)) return writeResult([]);

  // ---- the namespace rewrite (X-03) ----
  const rewritten = rewritePack(files, optionsFromIdentity(identity, creator));
  let residual: string[] = [];
  try { assertNoResidual(rewritten.report); } catch (e) { residual = [(e as Error).message]; }
  if (!record('rewrite', 'X-03 rewrite to the product namespace, zero craftmatic tokens', residual, `namespace ${rewritten.report.namespace}, ${rewritten.report.renamed.length} files moved`)) return writeResult([]);
  files = [...rewritten.files];
  const dangling = findDanglingReferences(files).map(d => `${d.file}: ${d.kind} ${d.ref}`);
  if (!record('references', 'X-03 every geometry, controller, animation and texture an entity names exists', dangling, 'no dangling references')) return writeResult([]);

  // ---- notices (X-05), credits (X-04), in-pack changelog (D-06) ----
  const bpRoot = files.map(f => f.name).find(n => /^[^/]+_BP\/manifest\.json$/.test(n))!.replace('manifest.json', '');
  const roots = [...new Set(files.filter(f => /(^|\/)manifest\.json$/.test(f.name)).map(f => f.name.replace('manifest.json', '')))];
  const enc = new TextEncoder();
  for (const root of roots) files.push(disclaimerFile(root, product.publisher, { requirePublisher: true }) as { name: string; data: Uint8Array });
  const credits = renderCredits(ledgerEntries);
  files.push({ name: `${bpRoot}CREDITS.txt`, data: enc.encode(credits) });
  files.push({ name: `${bpRoot}CHANGELOG.txt`, data: enc.encode(renderPackText(doc)) });
  if (!record('notices', 'X-05 the exact Mojang disclaimer and publisher block in both manifests, DISCLAIMER.txt and README', checkDisclaimer(files), 'disclaimer verbatim in every manifest, DISCLAIMER.txt and README')) return writeResult([]);

  // ---- the forbidden-terms lint over the pack AND every listing / copy file ----
  // Waivers are DATA of the product (`<data>/lint-exemptions.json`, each with a reason), reviewed with the product; none exists for a real product.
  const exemptionsFile = join(spec.dataRoot, 'lint-exemptions.json');
  const waivers: Array<{ id: string; rule: string; pattern: string; reason: string }> = existsSync(exemptionsFile) ? readJson(exemptionsFile) : [];
  evidence.lintExemptions = waivers;
  const exemptions = [DISCLAIMER_EXEMPTION, ...waivers];
  const lintFindings = lintPackFiles(files, { checkIds: true, exemptions }).map(f => `${f.file}:${f.line} ${f.ruleId} "${f.match}"`);
  const copyFiles = [...(build.copy ?? []), ...readdirSync(join(spec.dataRoot, 'copy', 'common')).map(n => `copy/common/${n}`)];
  for (const rel of copyFiles) {
    for (const f of lintText(readFileSync(join(spec.dataRoot, rel), 'utf8'), { exemptions })) lintFindings.push(`${rel}:${f.line} ${f.ruleId} "${f.match}"`);
  }
  lintFindings.push(...lintText(changelogText, { exemptions }).map(f => `changelog:${f.line} ${f.ruleId} "${f.match}"`));
  if (!record('text-lint', 'X-05 forbidden-terms lint over the pack, listing copy and changelog', lintFindings, `0 findings in ${files.length} pack files and ${copyFiles.length + 1} copy files${waivers.length ? `, ${waivers.length} explicit waiver(s): ${waivers.map(w => w.id).join(', ')}` : ''}`)) return writeResult([]);

  // ---- the deterministic zip (D-03) ----
  const zipOptions = { alwaysDeflate: true, deterministic: true, deflate: (d: Uint8Array) => pako.deflateRaw(d, { level: 9 }) };
  const bytes = await createZip(files, zipOptions);
  const again = await createZip([...files].reverse(), zipOptions);
  const slug = `${product.id}-${formatSemVer(version)}`;
  const dist = join(out, 'dist');
  mkdirSync(dist, { recursive: true });
  // The two pack folders sit at the archive root in both: the CurseForge "zip without a root folder" shape, so the
  // .zip is the same bytes as the .mcaddon under the name that channel accepts.
  writeFileSync(join(dist, `${slug}.mcaddon`), bytes);
  writeFileSync(join(dist, `${slug}.zip`), bytes);
  const outBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const names = listZipEntries(outBuf).filter(n => !n.endsWith('/'));
  const zipProblems: string[] = [];
  if (sha256Hex(bytes) !== sha256Hex(again)) zipProblems.push('the archive depends on entry order');
  if (names.length !== files.length) zipProblems.push(`${names.length} entries for ${files.length} files`);
  if (names.some(n => !n.includes('/'))) zipProblems.push('a file sits outside the two pack folders');
  for (const f of files) {
    const back = new Uint8Array(await extractFile(outBuf, f.name));
    if (sha256Hex(back) !== sha256Hex(f.data)) { zipProblems.push(`${f.name} does not round-trip`); break; }
  }
  if (!record('deterministic-zip', 'D-03 sorted entries, pako level 9, round trip, order independent', zipProblems, `${names.length} entries, sha256 ${sha256Hex(bytes).slice(0, 16)}...`)) return writeResult([]);

  // ---- the files that sit beside the archives ----
  writeFileSync(join(out, 'CHANGELOG.md'), changelogText);
  writeFileSync(join(out, 'NOTICE.txt'), renderNotice(product.publisher));
  writeFileSync(join(out, 'CREDITS-LDRAW.txt'), credits);
  writeResult([`${slug}.mcaddon`, `${slug}.zip`]);
}

/* ------------------------------------------------------------------------------------------------------------- */

const [command, arg, ...rest] = process.argv.slice(2);
try {
  if (command === 'init-product') process.exit(initProduct(arg));
  if (command === 'prepare') process.exit(prepare(arg, rest));
  if (command === '_make') { await make(arg!); process.exit(0); }
  console.error(`unknown command ${JSON.stringify(command)}; implemented: init-product, prepare (finalize/verify/status are TODO d08-finalize)`);
  process.exit(2);
} catch (e) {
  console.error((e as Error).stack ?? (e as Error).message);
  process.exit(1);
}
