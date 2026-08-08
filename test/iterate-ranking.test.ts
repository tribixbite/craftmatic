import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyTrend,
  readFailedScores,
  compareRemediation,
  rankCandidates,
  statusRank,
  trendRank,
  isBlockedOnConsensus,
  type RankRecord,
  type RankedCandidate,
  type Status,
} from '../scripts/iterate-ranking.js';

describe('classifyTrend', () => {
  it('returns new for <2 points', () => {
    expect(classifyTrend([])).toBe('new');
    expect(classifyTrend([7])).toBe('new');
  });
  it('detects a monotonic decline as regressing', () => {
    expect(classifyTrend([9, 8, 7, 6])).toBe('regressing');
  });
  it('detects a monotonic rise as improving', () => {
    expect(classifyTrend([6, 7, 8, 9])).toBe('improving');
  });
  it('treats sub-threshold jitter as a plateau', () => {
    expect(classifyTrend([8, 8.1, 7.9, 8.05])).toBe('plateau');
  });
  it('detects bouncing as oscillating', () => {
    expect(classifyTrend([9, 5, 9, 5])).toBe('oscillating');
  });
  it('only considers the most recent window', () => {
    // Early low score is dropped by the 6-wide window; recent 6 are flat → plateau
    // (without windowing the net 2→8 rise would read as improving).
    expect(classifyTrend([2, 8, 8, 8, 8, 8, 8])).toBe('plateau');
  });
});

describe('readFailedScores', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cm-rank-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeReport(slug: string, second: number, score: number | null): void {
    const stamp = `2026-06-24T10-00-${String(second).padStart(2, '0')}-000Z`;
    const body = score == null ? { defectScore: null } : { defectScore: { score } };
    writeFileSync(join(dir, `${slug}-${stamp}.json`), JSON.stringify(body));
  }

  it('returns [] for a missing dir', () => {
    expect(readFailedScores(join(dir, 'nope'), 'flatiron')).toEqual([]);
  });
  it('reads defectScores in chronological order, skipping null', () => {
    writeReport('flatiron', 2, 7);
    writeReport('flatiron', 0, 9);
    writeReport('flatiron', 1, null);
    expect(readFailedScores(dir, 'flatiron')).toEqual([9, 7]);
  });
  it('does not read a prefix-colliding slug', () => {
    writeReport('geisel', 0, 9);
    writeReport('geisel-east', 0, 3);
    expect(readFailedScores(dir, 'geisel')).toEqual([9]);
  });
  it('does not read a NUMERIC-suffixed sibling slug (tower vs tower-2)', () => {
    // The old `/^\d/` guard mis-claimed this: `tower-2-…`'s remainder starts
    // with a digit, so `tower` wrongly ingested another building's score.
    writeReport('tower', 0, 9);
    writeReport('tower-2', 0, 3);
    expect(readFailedScores(dir, 'tower')).toEqual([9]);
  });
});

describe('compareRemediation', () => {
  const cand = (
    over: Partial<RankRecord>, trend: RankedCandidate['trend'] = 'new',
  ): RankedCandidate => ({
    record: { slug: 's', status: 'fail-objective', attempts: 1, defectScore: 8, consensusMedian: 9, ...over },
    trend, scores: [],
  });

  it('orders hard objective failures before consensus failures', () => {
    const a = cand({ status: 'fail-objective', defectScore: 9 });
    const b = cand({ status: 'fail-consensus', defectScore: 1 });
    expect(compareRemediation(a, b)).toBeLessThan(0); // a first despite higher defect
  });
  it('within a status, fixes regressing before oscillating', () => {
    const a = cand({}, 'regressing');
    const b = cand({}, 'oscillating');
    expect(compareRemediation(a, b)).toBeLessThan(0);
    expect(trendRank('oscillating')).toBeGreaterThan(trendRank('regressing'));
  });
  it('within status+trend, worse defectScore sorts first', () => {
    const a = cand({ defectScore: 5 });
    const b = cand({ defectScore: 8 });
    expect(compareRemediation(a, b)).toBeLessThan(0);
  });
  it('uses consensus median only as the last tie-break', () => {
    const a = cand({ defectScore: 7, attempts: 1, consensusMedian: 5 });
    const b = cand({ defectScore: 7, attempts: 1, consensusMedian: 9 });
    expect(compareRemediation(a, b)).toBeLessThan(0); // lower consensus first, only here
  });
  it('stays a total order when a defectScore is NaN', () => {
    // A NaN score must not leak NaN out of the subtraction (which breaks V8's
    // sort). It coerces to the 10 fallback (least urgent), so the finite 8 wins.
    const a = cand({ defectScore: NaN });
    const b = cand({ defectScore: 8 });
    expect(compareRemediation(a, b)).toBeGreaterThan(0);
    expect(compareRemediation(b, a)).toBeLessThan(0);
    expect(Number.isFinite(compareRemediation(a, b))).toBe(true);
  });
});

describe('rankCandidates', () => {
  it('sorts worst-first and attaches trend', () => {
    const records: RankRecord[] = [
      { slug: 'a', status: 'fail-consensus', attempts: 3, defectScore: 9, consensusMedian: 7 },
      { slug: 'b', status: 'fail-objective', attempts: 1, defectScore: 4, consensusMedian: null },
    ];
    const ranked = rankCandidates(records, join(tmpdir(), 'cm-rank-none-XXXX'));
    expect(ranked[0].record.slug).toBe('b'); // fail-objective ranks first
    expect(ranked.map(r => r.record.slug)).toEqual(['b', 'a']);
  });
});

describe('statusRank', () => {
  it('orders pass last and fail-objective first', () => {
    const order: Status[] = ['fail-objective', 'fail-consensus', 'needs-human-review', 'context-insufficient', 'pass'];
    const ranks = order.map(statusRank);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y)); // already ascending
  });
});

describe('isBlockedOnConsensus', () => {
  const base: RankRecord = {
    slug: 'guggenheim', status: 'fail-consensus', attempts: 53,
    defectScore: 10, consensusMedian: null,
  };
  it('blocks fail-consensus with no scores and no key (the 53-attempt loop)', () => {
    expect(isBlockedOnConsensus(base, false)).toBe(true);
  });
  it('remediable when a VLM key is available', () => {
    expect(isBlockedOnConsensus(base, true)).toBe(false);
  });
  it('remediable when consensus actually ran and scored low', () => {
    expect(isBlockedOnConsensus({ ...base, consensusMedian: 6.5 }, false)).toBe(false);
  });
  it('fail-objective is never consensus-blocked', () => {
    expect(isBlockedOnConsensus({ ...base, status: 'fail-objective' }, false)).toBe(false);
  });
});
