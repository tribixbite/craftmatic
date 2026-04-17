import { describe, it, expect } from 'vitest';
import {
  evaluateGate,
  maxSpreadPerDim,
  median,
  scoreConsensus,
  type DimensionScores,
  type ModelFetchers,
  type ScoreConsensusInput,
} from './consensus.js';

function scores(c: number, f: number, m: number, o: number): DimensionScores {
  return { color: c, features: f, massing: m, overall: o };
}

function fixedFetchers(g: DimensionScores, c: DimensionScores, p: DimensionScores): ModelFetchers {
  return {
    gemini: async () => g,
    claude: async () => c,
    gpt5: async () => p,
  };
}

const RENDER_BYTES = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG magic
const REFS = [RENDER_BYTES];

function renderRound(): Promise<Uint8Array[]> {
  return Promise.resolve([RENDER_BYTES, RENDER_BYTES, RENDER_BYTES, RENDER_BYTES]);
}

describe('median', () => {
  it('handles odd-length arrays', () => {
    expect(median([1, 5, 9])).toBe(5);
  });
  it('handles even-length arrays', () => {
    expect(median([1, 3, 5, 9])).toBe(4);
  });
  it('returns 0 for empty', () => {
    expect(median([])).toBe(0);
  });
});

describe('maxSpreadPerDim', () => {
  it('picks worst single-dimension spread across models', () => {
    const g = scores(9, 9, 9, 9);
    const c = scores(7, 9, 9, 9);   // spread 2 on color
    const p = scores(9, 3, 9, 9);   // spread 6 on features
    expect(maxSpreadPerDim(g, c, p)).toBe(6);
  });
});

describe('evaluateGate', () => {
  it('pass when median≥8.5 AND min≥7 AND spread≤2', () => {
    const r = evaluateGate(scores(9, 8, 9, 9), scores(9, 7, 9, 9), scores(9, 9, 9, 9));
    expect(r.pass).toBe(true);
  });
  it('fail when median < 8.5', () => {
    const r = evaluateGate(scores(7, 7, 7, 7), scores(7, 7, 7, 7), scores(7, 7, 7, 7));
    expect(r.pass).toBe(false);
  });
  it('fail when min < 7', () => {
    const r = evaluateGate(scores(6, 9, 9, 9), scores(9, 9, 9, 9), scores(9, 9, 9, 9));
    expect(r.pass).toBe(false);
  });
  it('fail when spread > 2', () => {
    const r = evaluateGate(scores(9, 9, 9, 9), scores(5, 9, 9, 9), scores(9, 9, 9, 9));
    expect(r.pass).toBe(false);
    expect(r.spread).toBe(4);
  });
});

describe('scoreConsensus', () => {
  it('returns pass on round 1 when all models agree high', async () => {
    const input: ScoreConsensusInput = {
      renderRound,
      references: REFS,
      fetchers: fixedFetchers(
        scores(9, 9, 9, 9), scores(9, 8, 9, 9), scores(9, 9, 9, 9),
      ),
    };
    const r = await scoreConsensus(input);
    expect(r.status).toBe('pass');
    expect(r.rounds).toBe(1);
    expect(r.pass).toBe(true);
  });

  it('returns needs-human-review after maxRounds when spread > 2 persists', async () => {
    const input: ScoreConsensusInput = {
      renderRound,
      references: REFS,
      fetchers: fixedFetchers(
        scores(9, 9, 9, 9), scores(5, 5, 5, 5), scores(9, 9, 9, 9),
      ),
    };
    const r = await scoreConsensus(input);
    expect(r.status).toBe('needs-human-review');
    expect(r.rounds).toBe(3);
    expect(r.spread).toBeGreaterThan(2);
  });

  it('records all per-model scores in result', async () => {
    const input: ScoreConsensusInput = {
      renderRound,
      references: REFS,
      fetchers: fixedFetchers(
        scores(9, 9, 9, 9), scores(9, 9, 9, 9), scores(9, 9, 9, 9),
      ),
    };
    const r = await scoreConsensus(input);
    expect(r.gemini.color).toBe(9);
    expect(r.claude.color).toBe(9);
    expect(r.gpt5.color).toBe(9);
  });

  it('allows custom maxRounds', async () => {
    const input: ScoreConsensusInput = {
      renderRound,
      references: REFS,
      fetchers: fixedFetchers(
        scores(6, 6, 6, 6), scores(6, 6, 6, 6), scores(6, 6, 6, 6),
      ),
      maxRounds: 1,
    };
    const r = await scoreConsensus(input);
    expect(r.rounds).toBe(1);
    expect(r.status).toBe('needs-human-review');
  });

  it('retries with incremented round number', async () => {
    const rounds: number[] = [];
    const input: ScoreConsensusInput = {
      renderRound,
      references: REFS,
      fetchers: {
        gemini: async ({ round }) => { rounds.push(round); return scores(8, 8, 8, 8); },
        claude: async () => scores(8, 8, 8, 8),
        gpt5: async () => scores(8, 8, 8, 8),
      },
    };
    // median = 8 < 8.5, so all 3 rounds run
    await scoreConsensus(input);
    expect(rounds).toEqual([1, 2, 3]);
  });
});
