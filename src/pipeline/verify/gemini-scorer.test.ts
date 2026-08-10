import { describe, it, expect } from 'vitest';
import { parseDimensionScores, medianOfN } from './gemini-scorer.js';
import type { DimensionScores, ModelScoreFn } from './consensus.js';

describe('parseDimensionScores', () => {
  it('parses bare JSON', () => {
    expect(parseDimensionScores('{"color":8,"features":7,"massing":10,"overall":9}'))
      .toEqual({ color: 8, features: 7, massing: 10, overall: 9 });
  });
  it('parses fenced JSON with prose around it', () => {
    const text = 'Here are my scores:\n```json\n{"color": 3, "features": 1, "massing": 9, "overall": 4}\n```\nDone.';
    expect(parseDimensionScores(text)).toEqual({ color: 3, features: 1, massing: 9, overall: 4 });
  });
  it('clamps out-of-range and coerces strings', () => {
    expect(parseDimensionScores('{"color":"12","features":-3,"massing":"7.5","overall":null}'))
      .toEqual({ color: 10, features: 0, massing: 7.5, overall: 0 });
  });
  it('returns null on garbage', () => {
    expect(parseDimensionScores('no json here')).toBeNull();
  });
});

describe('medianOfN', () => {
  const seq = (scores: DimensionScores[]): ModelScoreFn => {
    let i = 0;
    return async () => scores[i++ % scores.length];
  };
  const dims = (n: number): DimensionScores => ({ color: n, features: n, massing: n, overall: n });

  it('takes the per-dimension median of 3 samples', async () => {
    const scorer = medianOfN(seq([dims(7), dims(6), dims(7)]), 3);
    const r = await scorer({ renders: [], references: [], round: 1 });
    expect(r).toEqual(dims(7)); // the 6.0 outlier no longer flips the gate
  });
  it('tolerates one zeroed (failed) sample', async () => {
    const scorer = medianOfN(seq([dims(8), dims(0), dims(8)]), 3);
    const r = await scorer({ renders: [], references: [], round: 1 });
    expect(r).toEqual(dims(8));
  });
  it('medians each dimension independently', async () => {
    const scorer = medianOfN(seq([
      { color: 2, features: 9, massing: 5, overall: 5 },
      { color: 4, features: 7, massing: 5, overall: 6 },
      { color: 9, features: 1, massing: 5, overall: 7 },
    ]), 3);
    const r = await scorer({ renders: [], references: [], round: 1 });
    expect(r).toEqual({ color: 4, features: 7, massing: 5, overall: 6 });
  });
});
