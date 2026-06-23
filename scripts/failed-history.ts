/**
 * Immutable failed-report history.
 *
 * `pipeline-state.json` keeps only the LATEST record per slug — each run
 * overwrites the last, so there's no way to tell an oscillating build (noise)
 * from a monotonically-regressing one. Adapted from Tekton's preserved
 * `verifier-report.*.failed.json`: every non-pass run is appended to a
 * timestamped, immutable archive so the iterate loop (and a human) gain memory
 * across runs.
 *
 * Node-only (uses `node:fs`) — lives in `scripts/`, never imported by the
 * browser/pure-core `src/pipeline/`.
 */

import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FullVerificationReport } from '../src/pipeline/verify/report.js';

/** Archived failed reports retained per slug before the oldest are pruned. */
export const MAX_FAILED_PER_SLUG = 25;

/**
 * Append a non-pass report to `<failedDir>/<slug>-<iso>.json`, then prune to the
 * most recent `keep` per slug. Returns the written path, or `null` when the run
 * passed (nothing archived).
 */
export function preserveFailedReport(
  failedDir: string,
  slug: string,
  report: FullVerificationReport,
  keep: number = MAX_FAILED_PER_SLUG,
): string | null {
  if (report.status === 'pass') return null;
  mkdirSync(failedDir, { recursive: true });
  // ISO timestamps contain ':' and '.' — neither is a safe filename char.
  const stamp = report.lastRun.replace(/[:.]/g, '-');
  const file = join(failedDir, `${slug}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  pruneFailedHistory(failedDir, slug, keep);
  return file;
}

/**
 * Keep only the most recent `keep` `<slug>-<iso>.json` archives, deleting older
 * ones. Returns the filenames removed. The char after `<slug>-` must be a digit
 * (the ISO year) so a slug that is a prefix of another (e.g. `geisel` vs
 * `geisel-east`) does not prune across slugs.
 */
export function pruneFailedHistory(failedDir: string, slug: string, keep: number): string[] {
  const prefix = `${slug}-`;
  const entries = readdirSync(failedDir)
    .filter(f =>
      f.startsWith(prefix) &&
      f.endsWith('.json') &&
      /^\d/.test(f.slice(prefix.length)),
    )
    .sort(); // ISO stamps sort chronologically ascending — oldest first
  const removed: string[] = [];
  const excess = entries.length - keep;
  for (let i = 0; i < excess; i++) {
    try {
      rmSync(join(failedDir, entries[i]));
      removed.push(entries[i]);
    } catch {
      // Best-effort: a concurrent run may have removed it already.
    }
  }
  return removed;
}
