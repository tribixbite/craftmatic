/**
 * Local VLM scorer — thin wrapper over an OpenAI-compatible endpoint
 * served by vLLM, llama.cpp's `--server`, TGI, or similar. Works with
 * any backend that exposes `POST /v1/chat/completions` with multimodal
 * content (text + image_url data URIs).
 *
 * Recommended setup for dual NVIDIA RTX 3090 (48GB combined):
 *
 *   pip install vllm
 *   vllm serve Qwen/Qwen2.5-VL-72B-Instruct-AWQ \
 *     --tensor-parallel-size 2 \
 *     --gpu-memory-utilization 0.92 \
 *     --max-model-len 8192 \
 *     --port 8000
 *
 * Why Qwen2.5-VL-72B-AWQ:
 *   • ~40GB at AWQ 4-bit — fits two 3090s with KV cache headroom
 *   • Independent training from Gemini/Claude/GPT-5 → useful spread
 *   • Strong vision encoder, scores comparable to closed-source VLMs
 *   • Free + offline (no API costs or rate limits)
 *
 * Alternatives:
 *   • OpenGVLab/InternVL3-78B-AWQ — different research lab, different blind spots
 *   • mistralai/Pixtral-Large-Instruct-2411 — needs 4x 3090 for full precision
 *   • Qwen/Qwen2-VL-72B-Instruct-AWQ — older, well-tested
 *   • openbmb/MiniCPM-V-2_6 — fits one 3090, ~10x faster, weaker
 *
 * Most local servers accept an arbitrary API key string (used for
 * tenancy isolation). We send a dummy key by default but accept
 * override for security-conscious setups.
 */
import { createGpt5Scorer } from './gpt5-scorer.js';
import type { ModelScoreFn } from './consensus.js';

export interface LocalVlmScorerOptions {
  /**
   * URL of the OpenAI-compatible endpoint root, including /v1.
   * vLLM default: http://localhost:8000/v1
   * llama.cpp server: http://localhost:8080/v1
   */
  readonly baseUrl: string;
  /** Model id as registered with the local server. */
  readonly model: string;
  /** Optional auth token (vLLM accepts any non-empty string by default). */
  readonly apiKey?: string;
  readonly temperature?: number;
  readonly log?: (msg: string) => void;
}

export function createLocalVlmScorer(opts: LocalVlmScorerOptions): ModelScoreFn {
  return createGpt5Scorer({
    apiKey: opts.apiKey ?? 'local-no-auth',
    model: opts.model,
    temperature: opts.temperature,
    log: opts.log,
    baseUrl: opts.baseUrl,
  });
}
