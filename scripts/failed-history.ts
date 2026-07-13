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
 * The stamp `preserveFailedReport` appends: `new Date().toISOString()` with ':'
 * and '.' replaced by '-', e.g. `2026-07-13T02-10-15-123Z`, plus `.json`.
 * Anchoring on this exact shape is what separates a slug's own archives from a
 * SIBLING slug's — including numeric ones. Slugs are lowercased address strings
 * (`build.ts`), so the uppercase `T`/`Z` here can never appear in one; and a
 * leading `\d{4}-` cannot be spoofed by a `tower` vs `tower-2` split (the
 * remainder there is `2-2026-…`, not `2026-…`). The old "char after `<slug>-`
 * is a digit" heuristic mis-claimed exactly those numeric-sibling files.
 */
const ISO_STAMP_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

/** True when `file` is a failed-report archive belonging to EXACTLY `slug`. */
export function isFailedArchiveFor(slug: string, file: string): boolean {
  const prefix = `${slug}-`;
  return file.startsWith(prefix) && ISO_STAMP_FILE.test(file.slice(prefix.length));
}

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
 * ones. Returns the filenames removed. Uses `isFailedArchiveFor` so a slug that
 * is a prefix of another (`geisel` vs `geisel-east`, or `tower` vs `tower-2`)
 * never prunes across slugs.
 */
export function pruneFailedHistory(failedDir: string, slug: string, keep: number): string[] {
  const entries = readdirSync(failedDir)
    .filter(f => isFailedArchiveFor(slug, f))
    .sort(); // ISO stamps sort chronologically ascending — oldest first
  const removed: string[] = [];
  const excess = entries.length - Math.max(0, keep);
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
