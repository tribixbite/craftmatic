/**
 * Gemini VLM scorer — implements the `ModelScoreFn` interface used by
 * `scoreConsensus` (Stage 9b). Sends renders + references to Gemini and
 * parses per-dimension scores for color / features / massing / overall.
 *
 * Also exports `singleModelFetchers()` — a `ModelFetchers` factory that wires
 * the same scorer to all three slots (gemini / claude / gpt5) with a
 * round-keyed in-flight promise cache so a single VLM call serves all three
 * parallel fetches. This is the pragmatic stand-in when we only have the
 * Gemini API key and don't want to pay 3× per round.
 *
 * With all three fetchers returning identical scores, `evaluateGate.spread`
 * is always 0 → the gate reduces to `median ≥ 8.5 AND min ≥ 7` on the four
 * Gemini dimensions.
 */
import type {
  DimensionScores,
  ModelFetchers,
  ModelScoreFn,
} from './consensus.js';

// ─── Gemini REST types ─────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

// ─── Prompt ────────────────────────────────────────────────────────────────

export const SCORER_PROMPT = `
You are evaluating a Minecraft voxel model of a real building against reference photos.

The first images are voxel-model renders (isometric, front elevation, top-down, cutaway).
The images after "Reference:" are real-world references (Street View facades + satellite).

Score the voxel model on four dimensions, each 0-10:

1. COLOR     — does the palette (walls, roof, trim) match the reference?
2. FEATURES  — windows, doors, setbacks, cornices, parapets, massing details?
3. MASSING   — footprint shape and overall proportions (height : width : depth)?
4. OVERALL   — your holistic impression of how recognisable the building is.

Be honest and specific. Do not grade on a curve. A generic extruded box with flat roof
scores ≤ 4 on massing regardless of how many blocks it contains.

Respond with STRICT JSON only (no markdown fences, no prose):
{"color": <0-10>, "features": <0-10>, "massing": <0-10>, "overall": <0-10>}
`.trim();

// ─── Parsing ───────────────────────────────────────────────────────────────

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  return candidate.slice(first, last + 1);
}

function clamp01to10(n: unknown): number {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? parseFloat(n) : NaN;
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(10, v));
}

export function parseDimensionScores(text: string): DimensionScores | null {
  const raw = extractJson(text);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      color: clamp01to10(obj.color),
      features: clamp01to10(obj.features),
      massing: clamp01to10(obj.massing),
      overall: clamp01to10(obj.overall),
    };
  } catch {
    return null;
  }
}

// ─── Gemini scorer ─────────────────────────────────────────────────────────

export interface GeminiScorerOptions {
  readonly apiKey: string;
  /** VLM model (default: gemini-2.5-pro). */
  readonly model?: string;
  /** Generation temperature (default: 0.0 deterministic). */
  readonly temperature?: number;
  /** Optional error logger (stderr). */
  readonly log?: (msg: string) => void;
}

/**
 * Build a `ModelScoreFn` that calls the Gemini REST API with inline images.
 * On any parse/API failure, returns zeros so the gate fails cleanly instead
 * of throwing and crashing the whole pipeline run.
 */
export function createGeminiScorer(opts: GeminiScorerOptions): ModelScoreFn {
  const model = opts.model ?? 'gemini-2.5-pro';
  const temperature = opts.temperature ?? 0.0;
  const log = opts.log ?? ((m: string): void => { console.error(m); });

  return async ({ renders, references, round }) => {
    const parts: GeminiPart[] = [{ text: SCORER_PROMPT }];

    // Voxel model renders (label each so the VLM doesn't confuse them)
    const labels = ['Voxel model — isometric:', 'Voxel model — front elevation:',
                    'Voxel model — top-down:', 'Voxel model — cutaway:'];
    for (let i = 0; i < renders.length; i++) {
      parts.push({ text: labels[i] ?? `Voxel model — view ${i + 1}:` });
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: Buffer.from(renders[i]).toString('base64'),
        },
      });
    }

    // References
    if (references.length > 0) parts.push({ text: 'Reference:' });
    for (let i = 0; i < references.length; i++) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: Buffer.from(references[i]).toString('base64'),
        },
      });
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${opts.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature,
            maxOutputTokens: 16384,
            ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 4096 } } : {}),
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        log(`  [consensus r${round}] Gemini HTTP ${res.status} ${res.statusText}`);
        return { color: 0, features: 0, massing: 0, overall: 0 };
      }
      const json = await res.json() as GeminiResponse;
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      const scores = parseDimensionScores(text);
      if (!scores) {
        log(`  [consensus r${round}] Gemini response unparseable (${text.length} chars): ${text.slice(0, 300)}`);
        return { color: 0, features: 0, massing: 0, overall: 0 };
      }
      if (process.env['CRAFTMATIC_LOG_CONSENSUS']) {
        log(`  [consensus r${round}] raw: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
      }
      return scores;
    } catch (err) {
      log(`  [consensus r${round}] Gemini call failed: ${(err as Error).message}`);
      return { color: 0, features: 0, massing: 0, overall: 0 };
    }
  };
}

// ─── Median-of-N sampling ─────────────────────────────────────────────────

/**
 * Wrap a scorer so each round samples the model N times and returns the
 * per-dimension MEDIAN. Gemini at temperature 0 still drifts run-to-run on
 * identical images (observed min 7.0 / 6.0 / 7.0 across three pennzoil
 * runs) — enough to flip the `min ≥ 7` release gate on borderline builds.
 * Samples run concurrently; a failed sample contributes zeros, and the
 * median of 3 tolerates one such outlier.
 */
export function medianOfN(scorer: ModelScoreFn, n = 3): ModelScoreFn {
  return async (input) => {
    const samples = await Promise.all(
      Array.from({ length: Math.max(1, n) }, () => scorer(input)),
    );
    const dim = (k: keyof DimensionScores): number => {
      const vs = samples.map(s => s[k]).sort((a, b) => a - b);
      const m = vs.length;
      return m % 2 === 1 ? vs[(m - 1) / 2] : (vs[m / 2 - 1] + vs[m / 2]) / 2;
    };
    return { color: dim('color'), features: dim('features'), massing: dim('massing'), overall: dim('overall') };
  };
}

// ─── Single-model fan-out ─────────────────────────────────────────────────

/**
 * Wrap a single `ModelScoreFn` so the same result is returned from all three
 * slots in `ModelFetchers`, without paying 3× the API cost per round.
 *
 * The shared in-flight promise is keyed by round number — it resets between
 * rounds so the scorer is re-called on each re-render.
 */
export function singleModelFetchers(scorer: ModelScoreFn): ModelFetchers {
  let lastRound = -1;
  let inFlight: Promise<DimensionScores> | null = null;
  const shared: ModelScoreFn = async (input) => {
    if (input.round !== lastRound) {
      lastRound = input.round;
      inFlight = scorer(input);
    } else if (!inFlight) {
      inFlight = scorer(input);
    }
    return inFlight;
  };
  return { gemini: shared, claude: shared, gpt5: shared };
}
