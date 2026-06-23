import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { preserveFailedReport, pruneFailedHistory } from '../scripts/failed-history.js';
import type { FullVerificationReport } from '../src/pipeline/verify/report.js';

// Only status + lastRun matter to the archiver — cast a minimal report.
function report(status: FullVerificationReport['status'], lastRun: string): FullVerificationReport {
  return { status, lastRun } as unknown as FullVerificationReport;
}

function isoAtSecond(s: number): string {
  return `2026-06-23T10:00:${String(s).padStart(2, '0')}.000Z`;
}

let base: string;
let failedDir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cm-failed-'));
  failedDir = join(base, 'failed');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('preserveFailedReport', () => {
  it('archives nothing for a passing run', () => {
    const r = preserveFailedReport(failedDir, 'flatiron', report('pass', isoAtSecond(0)));
    expect(r).toBeNull();
    expect(existsSync(failedDir)).toBe(false);
  });

  it('writes a filesystem-safe timestamped file for a failing run', () => {
    const path = preserveFailedReport(failedDir, 'flatiron', report('fail-objective', isoAtSecond(1)));
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    const name = basename(path!);
    expect(name).toMatch(/^flatiron-/);
    expect(name.endsWith('.json')).toBe(true);
    expect(name).not.toContain(':'); // colons stripped from the ISO stamp
  });

  it('prunes to the most recent `keep` per slug', () => {
    for (let s = 0; s < 30; s++) {
      preserveFailedReport(failedDir, 'geisel', report('fail-consensus', isoAtSecond(s)), 25);
    }
    const files = readdirSync(failedDir).filter(f => f.startsWith('geisel-')).sort();
    expect(files.length).toBe(25);
    // Oldest five (seconds 00-04) pruned; 05 is now the earliest retained.
    expect(files[0]).toContain('10-00-05');
    expect(files.at(-1)).toContain('10-00-29');
  });
});

describe('pruneFailedHistory', () => {
  it('does not prune across a slug that is a prefix of another', () => {
    mkdirSync(failedDir, { recursive: true });
    // 3 records for `geisel`, 2 for `geisel-east`.
    for (const s of [0, 1, 2]) writeFileSync(join(failedDir, `geisel-${isoAtSecond(s).replace(/[:.]/g, '-')}.json`), '{}');
    for (const s of [0, 1]) writeFileSync(join(failedDir, `geisel-east-${isoAtSecond(s).replace(/[:.]/g, '-')}.json`), '{}');

    const removed = pruneFailedHistory(failedDir, 'geisel', 1);
    // Only `geisel-<year>...` entries are eligible (year digit guard), so the
    // two `geisel-east-...` files are untouched.
    expect(removed.every(f => /^geisel-\d/.test(f))).toBe(true);
    expect(readdirSync(failedDir).filter(f => f.startsWith('geisel-east-')).length).toBe(2);
    expect(readdirSync(failedDir).filter(f => /^geisel-\d/.test(f)).length).toBe(1);
  });
});
