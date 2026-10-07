/**
 * The requirements ledger (REQUIREMENTS.md) parser and checker.
 *
 * REQUIREMENTS.md is the master list of everything the user has asked for,
 * one row per requirement, each with a status and the automated checks that
 * would fail if it regressed. This module makes that list enforceable: a row
 * that claims a requirement is done must name at least one guard, and every
 * guard must point at something that exists. `test/requirements-ledger.test.ts`
 * runs it inside `bun run test`, so a renamed or deleted test that a DONE row
 * relies on fails the suite instead of silently orphaning the requirement.
 *
 * CLI: `bun scripts/requirements-ledger.ts [--open]` prints counts by status
 * (and, with `--open`, every row that is not done) and exits 1 on any problem.
 *
 * Guard syntax (one or more per cell, separated by `;`):
 *   - `test/<file>.test.ts :: <substring>` — the file exists and contains the
 *     substring (normally part of an `it()`/`describe()` name).
 *   - `sim:<case-or-scenario>` — the id appears in the simulator's regression
 *     set or scenario list (`web/src/sim/adapters/craftmatic/regressions.ts`,
 *     `scripts/sim.ts`).
 *   - `gate:<repo path>[ :: <substring>]` — a gate script (in `bun run test`,
 *     CI or the export checks) exists and, optionally, contains the substring.
 *   - `rule:<path>[ :: <substring>]` — for process rules: where the rule is
 *     written. Repo-relative paths are checked; `~/` paths (user-scoped files
 *     outside the repo) are accepted unchecked so CI on another machine passes.
 *   - `none` — no automated guard (allowed only for rows that are not DONE).
 * A trailing ` (corpus)` on any guard marks one that is skipped without the
 * local clego corpus or built packs, i.e. it does not protect anything on CI.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Statuses a row may carry. Anything starting `DONE` claims the requirement is met. */
export const LEDGER_STATUSES = [
  'DONE-DEVICE', // implemented and confirmed on a phone (Bedrock) or live/visually (web)
  'DONE-OFFLINE', // implemented and covered offline; never confirmed where the user plays
  'PARTIAL', // part of it exists
  'OPEN', // not done
  'REGRESSED', // was done, later reported broken and not yet re-fixed
  'WONTFIX', // decided against; the gap cell says where and why
] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/** One requirement row. */
export interface LedgerRow {
  id: string;
  requirement: string;
  status: LedgerStatus;
  implementation: string;
  guards: string[];
  device: string;
  gap: string;
  /** 1-based line in REQUIREMENTS.md, for error messages. */
  line: number;
}

/** A requirement id: an upper-case area prefix and a two- or three-digit number. */
const ID_PATTERN = /^[A-Z]+-\d{2,3}$/;

/** The column headers every ledger table must use, in this order. */
const HEADER = ['id', 'requirement', 'status', 'implementation', 'guards', 'device', 'gap'];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Split one markdown table row into trimmed cells (`| a | b |` -> ['a','b']). */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  // `\|` inside a cell is an escaped pipe, not a column break.
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * Parse every ledger table in the document. A ledger table is any markdown
 * table whose header row is exactly `HEADER`; other tables are ignored.
 */
export function parseLedger(markdown: string): { rows: LedgerRow[]; problems: string[] } {
  const rows: LedgerRow[] = [];
  const problems: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let inLedger = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) {
      inLedger = false;
      continue;
    }
    const row = cells(line);
    if (row.map((c) => c.toLowerCase()).join('|') === HEADER.join('|')) {
      inLedger = true;
      i++; // skip the |---| separator
      continue;
    }
    if (!inLedger) continue;
    if (row.length !== HEADER.length) {
      problems.push(`line ${i + 1}: expected ${HEADER.length} cells, found ${row.length}`);
      continue;
    }
    const [id, requirement, status, implementation, guardCell, device, gap] = row;
    // Ids are written in backticks for readability; strip them before checking.
    const bareId = id.replace(/`/g, '');
    const bareStatus = status.replace(/[`*]/g, '');
    if (!ID_PATTERN.test(bareId)) problems.push(`line ${i + 1}: bad id "${id}"`);
    if (!(LEDGER_STATUSES as readonly string[]).includes(bareStatus)) {
      problems.push(`line ${i + 1}: ${bareId} has unknown status "${status}"`);
      continue;
    }
    const guards = guardCell
      .split(';')
      .map((g) => g.trim().replace(/^`|`$/g, ''))
      .filter((g) => g.length > 0);
    rows.push({ id: bareId, requirement, status: bareStatus as LedgerStatus, implementation, guards, device, gap, line: i + 1 });
  }
  return { rows, problems };
}

/** Read a repo file once per check run. */
function makeReader(root: string): (rel: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (rel) => {
    if (!cache.has(rel)) {
      const abs = path.resolve(root, rel);
      // A directory guard (a tool folder) only has to exist; it reads as empty text.
      if (!existsSync(abs)) cache.set(rel, undefined);
      // Test names escape quotes (`set\'s` inside '...'); match them unescaped.
      else cache.set(rel, statSync(abs).isDirectory() ? '' : readFileSync(abs, 'utf8').replace(/\\(['"`])/g, '$1'));
    }
    return cache.get(rel);
  };
}

/** Where a `sim:` guard may be declared. */
const SIM_SOURCES = ['web/src/sim/adapters/craftmatic/regressions.ts', 'scripts/sim.ts'];

/** Check one guard; returns a problem description or undefined when it holds. */
export function checkGuard(guard: string, read: (rel: string) => string | undefined): string | undefined {
  if (guard === 'none') return undefined;
  // `(corpus)` marks a guard that skips without the local clego corpus or
  // built packs: it still protects the requirement on a dev box, not on CI.
  const bare = guard.replace(/\s*\(corpus\)\s*$/i, '');
  const [target, needle] = bare.split('::').map((s) => s.trim());
  if (target.startsWith('sim:')) {
    const id = target.slice(4).trim();
    return SIM_SOURCES.some((f) => read(f)?.includes(id)) ? undefined : `sim guard "${id}" not found in ${SIM_SOURCES.join(' / ')}`;
  }
  let file = target;
  if (target.startsWith('gate:') || target.startsWith('rule:')) file = target.slice(5).trim();
  else if (!target.startsWith('test/')) return `unrecognised guard "${guard}" (use test/…, sim:, gate:, rule: or none)`;
  // A user-scoped rule lives outside the repo; it cannot be checked on CI.
  if (target.startsWith('rule:') && file.startsWith('~/')) return undefined;
  const text = read(file);
  if (text === undefined) return `guard file missing: ${file}`;
  if (needle && !text.includes(needle)) return `"${needle}" not found in ${file}`;
  return undefined;
}

/** Every problem with the ledger: parse errors, duplicate ids, unguarded DONE rows, dangling guards. */
export function checkLedger(markdown: string, root: string = REPO_ROOT): { rows: LedgerRow[]; problems: string[] } {
  const { rows, problems } = parseLedger(markdown);
  const read = makeReader(root);
  const seen = new Map<string, number>();
  for (const row of rows) {
    const first = seen.get(row.id);
    if (first !== undefined) problems.push(`line ${row.line}: duplicate id ${row.id} (first at line ${first})`);
    else seen.set(row.id, row.line);
    const real = row.guards.filter((g) => g !== 'none');
    if (row.status.startsWith('DONE') && real.length === 0) {
      problems.push(`line ${row.line}: ${row.id} is ${row.status} but names no guard — add a test or downgrade it`);
    }
    for (const guard of row.guards) {
      const problem = checkGuard(guard, read);
      if (problem) problems.push(`line ${row.line}: ${row.id}: ${problem}`);
    }
  }
  return { rows, problems };
}

/** Load and check REQUIREMENTS.md from the repo root. */
export function checkRepoLedger(root: string = REPO_ROOT): { rows: LedgerRow[]; problems: string[] } {
  return checkLedger(readFileSync(path.join(root, 'REQUIREMENTS.md'), 'utf8'), root);
}

if (import.meta.main) {
  const { rows, problems } = checkRepoLedger();
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  console.log(`${rows.length} requirements: ${[...counts].map(([s, n]) => `${s} ${n}`).join(', ')}`);
  if (process.argv.includes('--open')) {
    for (const r of rows.filter((r) => !r.status.startsWith('DONE'))) console.log(`${r.id}\t${r.status}\t${r.requirement}`);
  }
  for (const p of problems) console.error(`PROBLEM ${p}`);
  process.exit(problems.length ? 1 : 0);
}
