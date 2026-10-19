/**
 * GPT-5 VLM scorer — implements `ModelScoreFn` for the OpenAI Chat
 * Completions API. Mirrors the Claude scorer; differences are header
 * shape (Authorization Bearer vs x-api-key) and the image payload format
 * (`image_url` with data URI vs `image` source/data).
 */
import type { DimensionScores, ModelScoreFn } from './consensus.js';
import { parseDimensionScores, SCORER_PROMPT } from './gemini-scorer.js';

interface OpenAIContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' };
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export interface Gpt5ScorerOptions {
  readonly apiKey: string;
  /** OpenAI model id (default: gpt-5). */
  readonly model?: string;
  readonly temperature?: number;
  readonly log?: (msg: string) => void;
  /**
   * Override the API endpoint. Default OpenAI direct; set to
   * `https://openrouter.ai/api/v1` for OpenRouter or
   * `http://localhost:8000/v1` for local vLLM. The Anthropic API is
   * NOT compatible — use createClaudeScorer for that.
   */
  readonly baseUrl?: string;
  /**
   * Extra request headers (OpenRouter wants HTTP-Referer + X-Title).
   */
  readonly extraHeaders?: Record<string, string>;
}

export function createGpt5Scorer(opts: Gpt5ScorerOptions): ModelScoreFn {
  const model = opts.model ?? 'gpt-5';
  const temperature = opts.temperature ?? 0.0;
  const log = opts.log ?? ((m: string): void => { console.error(m); });
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const zeros: DimensionScores = { color: 0, features: 0, massing: 0, overall: 0 };

  return async ({ renders, references, round }) => {
    const content: OpenAIContent[] = [{ type: 'text', text: SCORER_PROMPT }];

    const labels = ['Voxel model — isometric:', 'Voxel model — front elevation:',
                    'Voxel model — top-down:', 'Voxel model — cutaway:'];
    for (let i = 0; i < renders.length; i++) {
      content.push({ type: 'text', text: labels[i] ?? `Voxel model — view ${i + 1}:` });
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from(renders[i]).toString('base64')}`,
          detail: 'high',
        },
      });
    }
    if (references.length > 0) content.push({ type: 'text', text: 'Reference:' });
    for (let i = 0; i < references.length; i++) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${Buffer.from(references[i]).toString('base64')}`,
          detail: 'high',
        },
      });
    }

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...(opts.extraHeaders ?? {}),
      };
      const body: Record<string, unknown> = {
        model,
        temperature,
        messages: [{ role: 'user', content }],
      };
      // OpenAI uses max_completion_tokens; OpenRouter + vLLM use max_tokens.
      // Setting both is safe — each backend ignores the irrelevant key.
      body.max_completion_tokens = 1024;
      body.max_tokens = 1024;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log(`  [consensus r${round}] HTTP ${res.status} ${res.statusText} @ ${baseUrl}: ${text.slice(0, 200)}`);
        return zeros;
      }
      const json = await res.json() as OpenAIResponse;
      if (json.error) {
        log(`  [consensus r${round}] GPT-5 API error: ${json.error.message}`);
        return zeros;
      }
      const text = json.choices?.[0]?.message?.content ?? '';
      const scores = parseDimensionScores(text);
      if (!scores) {
        log(`  [consensus r${round}] GPT-5 response unparseable: ${text.slice(0, 300)}`);
        return zeros;
      }
      if (process.env['CRAFTMATIC_LOG_CONSENSUS']) {
        log(`  [consensus r${round}] gpt5 raw: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
      }
      return scores;
    } catch (err) {
      log(`  [consensus r${round}] GPT-5 call failed: ${(err as Error).message}`);
      return zeros;
    }
  };
}
