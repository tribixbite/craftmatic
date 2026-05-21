/**
 * OpenRouter scorer — thin wrapper over the OpenAI-compatible
 * `chat/completions` shape pointed at https://openrouter.ai/api/v1.
 * Provides single-endpoint access to dozens of VLMs (Claude, GPT-5,
 * Gemini, Qwen-VL, Llama-Vision, Pixtral, etc.) via one API key.
 *
 * Pick a model id from https://openrouter.ai/models — e.g.
 *   "anthropic/claude-opus-4"
 *   "openai/gpt-5"
 *   "qwen/qwen-2.5-vl-72b-instruct"
 *   "meta-llama/llama-3.2-90b-vision-instruct"
 *
 * Configure OPENROUTER_API_KEY and (optionally) OPENROUTER_REFERER /
 * OPENROUTER_TITLE — OpenRouter uses those for attribution but they're
 * not required.
 */
import { createGpt5Scorer } from './gpt5-scorer.js';
import type { ModelScoreFn } from './consensus.js';

export interface OpenRouterScorerOptions {
  readonly apiKey: string;
  /** OpenRouter model id (e.g. "qwen/qwen-2.5-vl-72b-instruct"). */
  readonly model: string;
  readonly temperature?: number;
  readonly log?: (msg: string) => void;
  /** Project URL for OpenRouter attribution. */
  readonly referer?: string;
  /** Human-readable project name for OpenRouter dashboard. */
  readonly title?: string;
}

export function createOpenRouterScorer(opts: OpenRouterScorerOptions): ModelScoreFn {
  return createGpt5Scorer({
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: opts.temperature,
    log: opts.log,
    baseUrl: 'https://openrouter.ai/api/v1',
    extraHeaders: {
      ...(opts.referer ? { 'HTTP-Referer': opts.referer } : {}),
      ...(opts.title ? { 'X-Title': opts.title } : {}),
    },
  });
}
