/**
 * Stage 9 — multi-VLM subjective polish gate.
 *
 * Runs after objective gates pass. Submits 4 renders of the synthesized
 * building + reference SV/satellite to multiple VLMs, aggregates scores,
 * enforces `median ≥ 8.5 AND min ≥ 7 AND spread ≤ 2` release gate.
 *
 * Up to 3 rounds; if spread > 2 persists, terminal state
 * `needs-human-review` (no infinite loop).
 *
 * Dependency-injected model fetchers so unit tests don't need API keys.
 */

export type ConsensusDimension = 'color' | 'features' | 'massing' | 'overall';

export interface DimensionScores {
  readonly color: number;
  readonly features: number;
  readonly massing: number;
  readonly overall: number;
}

export type ModelName = 'gemini' | 'claude' | 'gpt5';

export interface ModelScoreFn {
  (input: {
    /** 4 views of the synthesized building as JPEG/PNG bytes. */
    readonly renders: readonly Uint8Array[];
    /** Reference SV + satellite images as JPEG/PNG bytes. */
    readonly references: readonly Uint8Array[];
    /** Round number (1-3). Passed so models know whether they're re-scoring
     * after a re-render. */
    readonly round: number;
  }): Promise<DimensionScores>;
}

export interface ModelFetchers {
  readonly gemini: ModelScoreFn;
  readonly claude: ModelScoreFn;
  readonly gpt5: ModelScoreFn;
}

export interface RenderRoundFn {
  /** Produces 4 rendered views for the given round. Round 2+3 rotate angles. */
  (round: number): Promise<Uint8Array[]>;
}

// ─── Consensus result shape ────────────────────────────────────────────────

export type ConsensusStatus = 'pass' | 'fail' | 'needs-human-review';

export interface ConsensusResult {
  readonly status: ConsensusStatus;
  readonly rounds: number;
  readonly gemini: DimensionScores;
  readonly claude: DimensionScores;
  readonly gpt5: DimensionScores;
  readonly min: number;
  readonly median: number;
  /** Max per-dimension spread across models. */
  readonly spread: number;
  readonly pass: boolean;
}

// ─── Math helpers ──────────────────────────────────────────────────────────

function allScores(r: ConsensusResult | Omit<ConsensusResult, 'status' | 'rounds'>): number[] {
  return [
    ...Object.values(r.gemini), ...Object.values(r.claude), ...Object.values(r.gpt5),
  ];
}

function median(vals: readonly number[]): number {
  const sorted = [...vals].sort((a, b) => a - b);
  const n = sorted.length;
  return n === 0 ? 0 : n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[(n - 1) / 2];
}

function maxSpreadPerDim(g: DimensionScores, c: DimensionScores, p: DimensionScores): number {
  const dims: ConsensusDimension[] = ['color', 'features', 'massing', 'overall'];
  let max = 0;
  for (const d of dims) {
    const vs = [g[d], c[d], p[d]];
    const s = Math.max(...vs) - Math.min(...vs);
    if (s > max) max = s;
  }
  return max;
}

function evaluateGate(
  gemini: DimensionScores,
  claude: DimensionScores,
  gpt5: DimensionScores,
): { min: number; median: number; spread: number; pass: boolean } {
  const all = [...Object.values(gemini), ...Object.values(claude), ...Object.values(gpt5)];
  const minScore = Math.min(...all);
  const med = median(all);
  const spread = maxSpreadPerDim(gemini, claude, gpt5);
  const pass = med >= 8.5 && minScore >= 7 && spread <= 2;
  return { min: minScore, median: med, spread, pass };
}

// ─── Main orchestrator ─────────────────────────────────────────────────────

export interface ScoreConsensusInput {
  readonly renderRound: RenderRoundFn;
  readonly references: readonly Uint8Array[];
  readonly fetchers: ModelFetchers;
  /** Max rounds before returning needs-human-review. Default 3. */
  readonly maxRounds?: number;
}

export async function scoreConsensus(input: ScoreConsensusInput): Promise<ConsensusResult> {
  const maxRounds = input.maxRounds ?? 3;
  let last!: ConsensusResult;

  for (let round = 1; round <= maxRounds; round++) {
    const renders = await input.renderRound(round);
    const [gemini, claude, gpt5] = await Promise.all([
      input.fetchers.gemini({ renders, references: input.references, round }),
      input.fetchers.claude({ renders, references: input.references, round }),
      input.fetchers.gpt5({ renders, references: input.references, round }),
    ]);
    const gate = evaluateGate(gemini, claude, gpt5);
    const resp: ConsensusResult = {
      status: gate.pass ? 'pass' : (round === maxRounds ? 'needs-human-review' : 'fail'),
      rounds: round,
      gemini, claude, gpt5,
      min: gate.min, median: gate.median, spread: gate.spread,
      pass: gate.pass,
    };
    last = resp;
    if (gate.pass || round === maxRounds) return resp;
    // Non-terminal fail — continue to next round with re-render
  }
  return last;
}

// ─── Exported helpers for reporting ─────────────────────────────────────────

export { allScores, median, maxSpreadPerDim, evaluateGate };
