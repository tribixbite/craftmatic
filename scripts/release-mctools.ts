/**
 * release-mctools.ts — run Microsoft's Minecraft Creator Tools validator (`mct validate`) over a release pack and
 * turn its output into one typed report (X-06, BIZ-24 / BIZ-54).
 *
 *   bun scripts/release-mctools.ts <pack.mcaddon | pack.zip | project-dir> [--json]
 *
 * What it does: unzips an archive into a NEW temp folder laid out as mct expects (`behavior_packs/<pack>`,
 * `resource_packs/<pack>`), runs `bunx @minecraft/creator-tools@<MCTOOLS_VERSION> validate -i <dir> -o <report dir>`
 * and parses the output into `{ errors, warnings, rules }`.
 *
 * It NEVER accepts Microsoft's EULA: when mct reports that the EULA is not accepted the result is
 * `{ status: 'not-run', reason: 'needs user EULA acceptance ...' }` and the user runs `eula` once themselves (U13).
 * A failed `bunx` (network, a broken dependency tree) is also `not-run` with the reason, so a release gate can tell
 * "validator found errors" from "validator could not run". It does not refuse on the Node version: the package
 * declares no `engines`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

/** The one place the validator version is pinned (docs/plans/README.md X-06). */
export const MCTOOLS_VERSION = '0.21.0';
export const MCTOOLS_PACKAGE = `@minecraft/creator-tools@${MCTOOLS_VERSION}`;

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
 * Parse `mct validate` console output. Recognised forms (case-insensitive):
 *  - a rule line `ERROR [RULE_ID] message`, `Warning: RULE_ID - message`, `error RULE_ID: message`;
 *  - a summary `3 errors, 1 warning` (or `Errors: 3` / `Warnings: 1`), which wins over the line count when present
 *    because mct may print each rule once with a count.
 * TODO(mct-format): verified against a hand-written fixture only; the live 0.21.0 run has not got past `bunx`
 * (see X-06 report) so the real line format is unconfirmed. Re-record test/fixtures/mctools-output.txt after U13.
 */
export function parseMctOutput(raw: string): { errors: number; warnings: number; rules: MctRule[] } {
  const text = raw.replace(ANSI, '');
  const rules: MctRule[] = [];
  const lineRe = /^\s*[-*•]?\s*\[?(error|warn(?:ing)?)\]?\s*[:\-]?\s*(.+?)\s*$/i;
  // A rule id is upper-case with digits/underscores; it is bracketed or followed by ":" / "-".
  const idRe = /^(?:\[([A-Z][A-Z0-9_]{2,})\]\s*[:\-]?|([A-Z][A-Z0-9_]{2,})\s*[:\-])\s*(.+)$/;
  for (const line of text.split(/\r?\n/)) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const rest = m[2]!;
    // A summary line ("Errors: 3") is not a rule: its remainder is only a number.
    if (/^\d+$/.test(rest)) continue;
    const idm = idRe.exec(rest);
    rules.push({
      id: idm ? (idm[1] ?? idm[2]!) : 'unknown',
      severity: m[1]!.toLowerCase() === 'error' ? 'error' : 'warning',
      message: idm ? idm[3]! : rest,
    });
  }
  const counted = (word: string): number | null => {
    const a = new RegExp(`(\\d+)\\s+${word}s?\\b`, 'i').exec(text);
    const b = new RegExp(`\\b${word}s?\\s*[:=]\\s*(\\d+)`, 'i').exec(text);
    const hit = a?.[1] ?? b?.[1];
    return hit === undefined ? null : Number(hit);
  };
  const errors = counted('error') ?? rules.filter((r) => r.severity === 'error').length;
  const warnings = counted('warning') ?? rules.filter((r) => r.severity === 'warning').length;
  return { errors, warnings, rules };
}

/** Turn one finished mct process into a report. Pure: all policy about EULA / launch failure lives here. */
export function reportFromRun(run: MctRunResult): MctReport {
  const combined = `${run.stdout}\n${run.stderr}`;
  if (needsEula(combined)) {
    return {
      status: 'not-run',
      reason: `needs user EULA acceptance: the user runs \`bunx ${MCTOOLS_PACKAGE} eula\` once (U13); this tool never accepts it`,
    };
  }
  const parsed = parseMctOutput(run.stdout);
  const sawSummary = /\d+\s+errors?\b|\berrors?\s*[:=]\s*\d+/i.test(run.stdout) || parsed.rules.length > 0;
  if (!sawSummary && run.exitCode !== 0) {
    const firstError = combined.replace(ANSI, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => /error|cannot|failed|ENOENT/i.test(l));
    return { status: 'not-run', reason: `mct did not run (exit ${run.exitCode})${firstError ? `: ${firstError}` : ''}` };
  }
  if (!sawSummary) {
    // Exit 0 and no findings printed: a clean run (mct prints nothing for a project without issues).
    return { status: 'ran', errors: 0, warnings: 0, rules: [] };
  }
  return { status: 'ran', ...parsed };
}

/** The real runner: `bunx <pinned package> <args>`. */
export const bunxRunner: MctRunner = (args, cwd) => {
  const r = spawnSync('bunx', [MCTOOLS_PACKAGE, ...args], { cwd, encoding: 'utf-8', shell: process.platform === 'win32', timeout: 10 * 60_000 });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
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

/** Validate a pack archive or project folder. `run` is injectable for tests. */
export function validateRelease(input: string, run: MctRunner = bunxRunner, baseDir: string = tmpdir()): MctReport {
  const abs = resolve(input);
  if (!existsSync(abs)) return { status: 'not-run', reason: `input not found: ${abs}` };
  const project = statSync(abs).isDirectory() ? abs : unpackForMct(abs, baseDir);
  const reportDir = mkdtempSync(join(baseDir, 'release-mctools-out-')); // mct writes reports to ./out by default
  return reportFromRun(run(['validate', '-i', project, '-o', reportDir], baseDir));
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
