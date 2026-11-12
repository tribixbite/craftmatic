/**
 * release-mctools.ts — run Microsoft's Minecraft Creator Tools validator (`mct validate`) over a release pack and
 * turn its output into one typed report (X-06, BIZ-24 / BIZ-54, package MCT).
 *
 *   bun scripts/release-mctools.ts <pack.mcaddon | pack.zip | project-dir> [--json]
 *
 * What it does: unzips an archive into a NEW temp folder laid out as mct expects (`behavior_packs/<pack>`,
 * `resource_packs/<pack>`), runs `mct validate main` and `mct validate addon` over it (each into its own output
 * folder) and parses the `<project>.csv` each writes into `{ errors, warnings, rules }`. The CSV is the structured
 * output: the console prints only `Error: ...` lines without rule ids.
 *
 * HOW mct is launched (MCT, 2026-11-12): `bunx @minecraft/creator-tools@0.21.0` crashes at start-up with
 * `Cannot read properties of undefined (reading 'ReactCurrentOwner')`: its `ink@5` needs react 18 as a PEER, and a
 * fresh bunx tree resolves react 19. `tools/mct/package.json` pins `@minecraft/creator-tools` AND `react@18.3.1`
 * with its own `bun.lock`; this script runs `bun install --frozen-lockfile` there when `node_modules` is missing and
 * starts the CLI with `node` (the CLI is an ESM bin; ink is verified under node 25 here, CI installs the same tree).
 *
 * It NEVER accepts Microsoft's EULA: when mct reports that the EULA is not accepted the result is
 * `{ status: 'not-run', reason: 'needs user EULA acceptance ...' }` and the user runs `eula` once themselves (U13).
 * 0.21.0 did not ask for it on `validate` (2026-11-12). A failed launch (a broken dependency tree) is also `not-run`
 * with the reason, so a release gate can tell "validator found errors" from "validator could not run".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

/** The one place the validator version is pinned (docs/plans/README.md X-06). */
export const MCTOOLS_VERSION = '0.21.0';
export const MCTOOLS_PACKAGE = `@minecraft/creator-tools@${MCTOOLS_VERSION}`;
/** The validation suites run, in order: `main` (most checks) and `addon` (packaging / cooperative add-on checks). */
export const MCT_SUITES = ['main', 'addon'] as const;
/** The pinned install: package + the react 18 its ink needs (see the header). */
export const MCT_TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'mct');

export type MctSeverity = 'error' | 'warning';

export interface MctRule {
  /** Rule id as mct prints it (e.g. `ENTITY_NO_DESCRIPTION`), or `unknown` when a line carries none. */
  id: string;
  severity: MctSeverity;
  message: string;
}

export type MctReport =
  | { status: 'ran'; errors: number; warnings: number; rules: MctRule[] }
  | { status: 'not-run'; reason: string };

/** What a process run returned: injected so tests never spawn bunx. */
export interface MctRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The text of every `*.csv` report the run wrote (the structured output). Absent for a run that wrote none. */
  csv?: string[];
}
export type MctRunner = (args: string[], cwd: string) => MctRunResult;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * True when mct output says the EULA has not been accepted. We never accept it for the user.
 * mct's message names the EULA and tells the user how to accept it.
 */
export function needsEula(text: string): boolean {
  return /\bEULA\b/i.test(text) && /(not (yet )?accepted|must (first )?accept|accept the|requires? acceptance|run .*\beula\b)/i.test(text);
}

/**
 * Parse `mct validate` CONSOLE output, the fallback when no CSV was written. Verified against the real 0.21.0
 * recording (test/fixtures/mctools-output.txt): a finding is `Error: <message>` (or `Warning: <message>`), with no
 * rule id; `Error: Test Fail: Found N errors in X check` is a per-test summary of the lines after it, not a finding.
 */
export function parseMctOutput(raw: string): { errors: number; warnings: number; rules: MctRule[] } {
  const rules: MctRule[] = [];
  for (const line of raw.replace(ANSI, '').split(/\r?\n/)) {
    const m = /^\s*(error|warning):\s*(.+?)\s*$/i.exec(line);
    if (!m || /^test (fail|success)\b/i.test(m[2]!)) continue;
    rules.push({ id: 'unknown', severity: m[1]!.toLowerCase() === 'error' ? 'error' : 'warning', message: m[2]! });
  }
  return { errors: rules.filter((r) => r.severity === 'error').length, warnings: rules.filter((r) => r.severity === 'warning').length, rules };
}

/**
 * Parse one `mct validate` CSV report. Header `Test,TestId,Type,Item,Message,Data,Path`; `Type` is one of `Error`,
 * `Warning`, `Recommendation`, `Info`, `Test fail`, `Test success`, `Unknown`. Only Error and Warning rows are findings
 * (`Test fail` just repeats a count). The rule id is `<Test>:<TestId>`. The Data cell is NOT quoted and may hold
 * commas (`1,21,30`), so the row is matched from both ends: leading fields and the quoted Message, trailing quoted
 * Path. Message and Path are folded into one text, plus Data when it carries a value.
 */
export function parseMctCsv(csv: string): { errors: number; warnings: number; rules: MctRule[] } {
  const rules: MctRule[] = [];
  const rowRe = /^([A-Z0-9_]+),(\d+),"(Error|Warning)","[^"]*","((?:[^"]|"")*)",(.*?),"([^"]*)",?\s*$/;
  for (const line of csv.split(/\r?\n/)) {
    const m = rowRe.exec(line);
    if (!m) continue;
    const [, test, id, type, message, data, path] = m;
    const msg = [message!.replace(/""/g, '"'), data!.replace(/^"|"$/g, '')].filter(Boolean).join(': ');
    rules.push({
      id: `${test}:${id}`,
      severity: type === 'Error' ? 'error' : 'warning',
      message: path ? `${msg} (${path})` : msg,
    });
  }
  return { errors: rules.filter((r) => r.severity === 'error').length, warnings: rules.filter((r) => r.severity === 'warning').length, rules };
}

/** Turn finished mct process(es) into a report. Pure: all policy about EULA / launch failure lives here. */
export function reportFromRun(run: MctRunResult): MctReport {
  const combined = `${run.stdout}\n${run.stderr}`;
  if (needsEula(combined)) {
    return {
      status: 'not-run',
      reason: `needs user EULA acceptance: the user runs \`bunx ${MCTOOLS_PACKAGE} eula\` once (U13); this tool never accepts it`,
    };
  }
  const csvText = (run.csv ?? []).join('\n');
  // mct exits 4 when it found errors, so the exit code alone cannot tell "found errors" from "did not run": a report
  // (CSV or an `Error:` line) means it ran.
  const parsed = csvText ? parseMctCsv(csvText) : parseMctOutput(run.stdout);
  if (!csvText && parsed.rules.length === 0 && run.exitCode !== 0) {
    const firstError = combined.replace(ANSI, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => /error|cannot|failed|ENOENT/i.test(l));
    return { status: 'not-run', reason: `mct did not run (exit ${run.exitCode})${firstError ? `: ${firstError}` : ''}` };
  }
  return { status: 'ran', ...parsed };
}

/** The pinned CLI entry inside tools/mct (the package bin, `cli/index.mjs`). */
const MCT_CLI = join(MCT_TOOL_DIR, 'node_modules', '@minecraft', 'creator-tools', 'cli', 'index.mjs');

/**
 * The real runner: installs tools/mct from its lockfile when needed, runs the CLI with `node`, and collects every CSV
 * report from the `-o` folder. A failed install is returned as a non-zero run so it becomes `not-run`.
 */
export const mctRunner: MctRunner = (args, cwd) => {
  if (!existsSync(MCT_CLI)) {
    const inst = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: MCT_TOOL_DIR, encoding: 'utf-8', shell: process.platform === 'win32', timeout: 10 * 60_000 });
    if (inst.status !== 0 || !existsSync(MCT_CLI)) {
      return { exitCode: inst.status ?? -1, stdout: '', stderr: `bun install in ${MCT_TOOL_DIR} failed: ${inst.stderr ?? ''}${inst.error ? inst.error.message : ''}` };
    }
  }
  const r = spawnSync('node', [MCT_CLI, ...args], { cwd, encoding: 'utf-8', shell: process.platform === 'win32', timeout: 10 * 60_000 });
  const outDir = args[args.indexOf('-o') + 1];
  const csv = outDir && existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.csv')).map((f) => readFileSync(join(outDir, f), 'utf-8')) : [];
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`, csv };
};

/**
 * Unzip a `.mcaddon`/`.zip` into a NEW temp folder laid out as mct expects: each pack folder moves under
 * `behavior_packs/` or `resource_packs/` by its manifest's module type. Returns the project folder.
 */
export function unpackForMct(archive: string, baseDir: string = tmpdir()): string {
  const files = unzipSync(new Uint8Array(readFileSync(archive)));
  const roots = Object.keys(files).filter((n) => n.endsWith('manifest.json')).map((n) => n.slice(0, -'manifest.json'.length));
  const dest = mkdtempSync(join(baseDir, 'release-mctools-'));
  const kindOf = (root: string): 'behavior_packs' | 'resource_packs' => {
    const manifest = JSON.parse(new TextDecoder().decode(files[`${root}manifest.json`]!).replace(/^﻿/, ''));
    const types = new Set<string>((manifest.modules ?? []).map((m: { type: string }) => m.type));
    return types.has('resources') ? 'resource_packs' : 'behavior_packs';
  };
  roots.sort((a, b) => b.length - a.length); // deepest owner wins
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    const root = roots.find((r) => name.startsWith(r));
    if (root === undefined) continue;
    const packName = root.replace(/\/$/, '').split('/').pop() || (kindOf(root) === 'resource_packs' ? 'rp' : 'bp');
    const out = join(dest, kindOf(root), packName, name.slice(root.length));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
  }
  return dest;
}

/** Validate a pack archive or project folder with every suite and merge the findings. `run` is injectable for tests. */
export function validateRelease(input: string, run: MctRunner = mctRunner, baseDir: string = tmpdir()): MctReport {
  const abs = resolve(input);
  if (!existsSync(abs)) return { status: 'not-run', reason: `input not found: ${abs}` };
  const project = statSync(abs).isDirectory() ? abs : unpackForMct(abs, baseDir);
  const merged = { errors: 0, warnings: 0, rules: [] as MctRule[] };
  for (const suite of MCT_SUITES) {
    const reportDir = mkdtempSync(join(baseDir, `release-mctools-${suite}-`)); // a NEW folder per suite: reports never mix
    const one = reportFromRun(run(['validate', suite, '-i', project, '-o', reportDir], baseDir));
    if (one.status === 'not-run') return one;
    merged.errors += one.errors;
    merged.warnings += one.warnings;
    merged.rules.push(...one.rules);
  }
  return { status: 'ran', ...merged };
}

function main(argv: string[]): number {
  const input = argv.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('usage: bun scripts/release-mctools.ts <pack.mcaddon | pack.zip | project-dir> [--json]');
    return 2;
  }
  const report = validateRelease(input);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else if (report.status === 'not-run') console.log(`NOT-RUN  ${report.reason}`);
  else {
    console.log(`${report.errors === 0 ? 'OK  ' : 'FAIL'} mct ${MCTOOLS_VERSION}: ${report.errors} error(s), ${report.warnings} warning(s)`);
    for (const r of report.rules) console.log(`  ${r.severity.toUpperCase().padEnd(7)} ${r.id}: ${r.message}`);
  }
  // 0 = ran with no errors, 1 = errors, 3 = could not run (never silently green).
  return report.status === 'not-run' ? 3 : report.errors > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
