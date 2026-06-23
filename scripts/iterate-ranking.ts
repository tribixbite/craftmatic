/**
 * Remediation ranking for the iterate loop.
 *
 * The loop used to pick the next golden to rebuild by STATUS enum + attempt
 * count only — it ignored the deterministic quality signals the verifier now
 * produces (`defectScore`, the height cross-check) and the failed-report
 * history. This module ranks candidates on those signals instead, and reads the
 * immutable failed-history (#5) to classify each build's trend so the loop can
 * tell a real regression from non-deterministic noise:
 *
 *   • regressing  — defectScore trending down  → fix first
 *   • improving   — trending up                → runs are paying off, keep going
 *   • plateau     — flat                       → needs a code change, not more runs
 *   • oscillating — bouncing                   → tile-capture noise; more runs won't converge
 *
 * VLM consensus is demoted to a final tie-break: the deterministic defectScore
 * is the primary intra-status key.
 *
 * Node-only (reads failed-history via `node:fs`) — lives in `scripts/`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Status =
  | 'pass' | 'fail-objective' | 'fail-consensus'
  | 'needs-human-review' | 'context-insufficient';

export type TrendKind = 'new' | 'regressing' | 'improving' | 'plateau' | 'oscillating';

/** The subset of a pipeline-state record used for ranking. */
export interface RankRecord {
  readonly slug: string;
  readonly status: Status;
  readonly attempts: number;
  /** Deterministic 0-10 defect score; null when absent (older records). */
  readonly defectScore: number | null;
  /** VLM consensus median; demoted to the final tie-break. */
  readonly consensusMedian: number | null;
}

export interface RankedCandidate {
  readonly record: RankRecord;
  readonly trend: TrendKind;
  /** Chronological defectScore history (oldest→newest) from failed-history. */
  readonly scores: readonly number[];
}

// Status remediation order (lower = more urgent). Hard objective failures first.
const STATUS_RANK: Record<Status, number> = {
  'fail-objective': 0,
  'fail-consensus': 1,
  'needs-human-review': 2,
  'context-insufficient': 3,
  'pass': 4,
};

export function statusRank(s: Status): number {
  return STATUS_RANK[s];
}

// Trend "try-first" order: fix regressions first; an improving build still
// benefits from another run; a fresh build is unknown; a plateau/oscillator
// won't converge with more runs, so they go last.
const TREND_RANK: Record<TrendKind, number> = {
  regressing: 0,
  improving: 1,
  new: 2,
  plateau: 3,
  oscillating: 4,
};

export function trendRank(t: TrendKind): number {
  return TREND_RANK[t];
}

/** |Δ| below this counts as flat (not a real move). */
const PLATEAU_EPS = 0.3;
/** Consider only the most recent N scored runs when classifying a trend. */
const TREND_WINDOW = 6;

/**
 * Classify a chronological defectScore series (oldest→newest) into a trend.
 * Two or more direction changes (ignoring sub-`PLATEAU_EPS` jitter) ⇒
 * oscillating; otherwise net movement decides regressing/improving/plateau.
 */
export function classifyTrend(scores: readonly number[]): TrendKind {
  const s = scores.slice(-TREND_WINDOW);
  if (s.length < 2) return 'new';

  let signChanges = 0;
  let lastSign = 0;
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1];
    if (Math.abs(d) < PLATEAU_EPS) continue;
    const sign = d > 0 ? 1 : -1;
    if (lastSign !== 0 && sign !== lastSign) signChanges++;
    lastSign = sign;
  }
  if (signChanges >= 2) return 'oscillating';

  const net = s[s.length - 1] - s[0];
  if (net <= -PLATEAU_EPS) return 'regressing';
  if (net >= PLATEAU_EPS) return 'improving';
  return 'plateau';
}

/**
 * Read the chronological defectScore series for a slug from the failed-history
 * archive (`<failedDir>/<slug>-<iso>.json`). The year-digit guard (matching
 * pruneFailedHistory) keeps a prefix slug from reading another's files.
 */
export function readFailedScores(failedDir: string, slug: string): number[] {
  if (!existsSync(failedDir)) return [];
  const prefix = `${slug}-`;
  const files = readdirSync(failedDir)
    .filter(f =>
      f.startsWith(prefix) &&
      f.endsWith('.json') &&
      /^\d/.test(f.slice(prefix.length)),
    )
    .sort(); // ISO stamps sort chronologically ascending

  const scores: number[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(failedDir, f), 'utf8')) as {
        defectScore?: { score?: number } | null;
      };
      const sc = r.defectScore?.score;
      if (typeof sc === 'number') scores.push(sc);
    } catch {
      // Skip an unreadable/partial archive entry.
    }
  }
  return scores;
}

/**
 * Comparator — lower sorts first (more urgent to rebuild). Order of keys:
 * status band → trend → deterministic defectScore (worse first) → fewer
 * attempts → VLM consensus median (LAST resort, demoted).
 */
export function compareRemediation(a: RankedCandidate, b: RankedCandidate): number {
  const byStatus = statusRank(a.record.status) - statusRank(b.record.status);
  if (byStatus !== 0) return byStatus;

  const byTrend = trendRank(a.trend) - trendRank(b.trend);
  if (byTrend !== 0) return byTrend;

  const da = a.record.defectScore ?? 10;
  const db = b.record.defectScore ?? 10;
  if (da !== db) return da - db;

  if (a.record.attempts !== b.record.attempts) return a.record.attempts - b.record.attempts;

  const ca = a.record.consensusMedian ?? 10;
  const cb = b.record.consensusMedian ?? 10;
  return ca - cb;
}

/**
 * Build ranked candidates (worst/most-urgent first) from state records, reading
 * each slug's failed-history to classify its trend.
 */
export function rankCandidates(
  records: readonly RankRecord[],
  failedDir: string,
): RankedCandidate[] {
  const candidates: RankedCandidate[] = records.map(record => {
    const scores = readFailedScores(failedDir, record.slug);
    return { record, trend: classifyTrend(scores), scores };
  });
  candidates.sort(compareRemediation);
  return candidates;
}
