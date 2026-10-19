/**
 * Claude VLM scorer — implements `ModelScoreFn` for the Anthropic Messages
 * API. Uses the same prompt as the Gemini scorer so cross-model comparisons
 * stay apples-to-apples.
 *
 * Direct REST calls (no SDK) keep the bundle slim and work in browser
 * contexts. Authentication via `x-api-key` header.
 */
import type { DimensionScores, ModelScoreFn } from './consensus.js';
import { parseDimensionScores, SCORER_PROMPT } from './gemini-scorer.js';

interface ClaudeContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg';
    data: string;
  };
}

interface ClaudeResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
}

export interface ClaudeScorerOptions {
  readonly apiKey: string;
  /** Anthropic model id (default: claude-opus-4-7). */
  readonly model?: string;
  readonly temperature?: number;
  readonly log?: (msg: string) => void;
}

export function createClaudeScorer(opts: ClaudeScorerOptions): ModelScoreFn {
  const model = opts.model ?? 'claude-opus-4-7';
  const temperature = opts.temperature ?? 0.0;
  const log = opts.log ?? ((m: string): void => { console.error(m); });
  const zeros: DimensionScores = { color: 0, features: 0, massing: 0, overall: 0 };

  return async ({ renders, references, round }) => {
    const content: ClaudeContent[] = [{ type: 'text', text: SCORER_PROMPT }];

    const labels = ['Voxel model — isometric:', 'Voxel model — front elevation:',
                    'Voxel model — top-down:', 'Voxel model — cutaway:'];
    for (let i = 0; i < renders.length; i++) {
      content.push({ type: 'text', text: labels[i] ?? `Voxel model — view ${i + 1}:` });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from(renders[i]).toString('base64'),
        },
      });
    }
    if (references.length > 0) content.push({ type: 'text', text: 'Reference:' });
    for (let i = 0; i < references.length; i++) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: Buffer.from(references[i]).toString('base64'),
        },
      });
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          temperature,
          messages: [{ role: 'user', content }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        log(`  [consensus r${round}] Claude HTTP ${res.status} ${res.statusText}`);
        return zeros;
      }
      const json = await res.json() as ClaudeResponse;
      if (json.error) {
        log(`  [consensus r${round}] Claude API error: ${json.error.message}`);
        return zeros;
      }
      const text = json.content?.find(c => c.type === 'text')?.text ?? '';
      const scores = parseDimensionScores(text);
      if (!scores) {
        log(`  [consensus r${round}] Claude response unparseable: ${text.slice(0, 300)}`);
        return zeros;
      }
      if (process.env['CRAFTMATIC_LOG_CONSENSUS']) {
        log(`  [consensus r${round}] claude raw: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
      }
      return scores;
    } catch (err) {
      log(`  [consensus r${round}] Claude call failed: ${(err as Error).message}`);
      return zeros;
    }
  };
}
