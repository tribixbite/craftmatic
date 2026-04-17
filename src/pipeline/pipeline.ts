/**
 * Top-level pipeline orchestrator.
 *
 * Implementation wired in Chunk 9 of the rearchitecture plan.
 * See: docs/superpowers/plans/2026-04-17-pipeline-rearchitecture.md
 */

import type { VerificationReport } from './verify/types.js';

export interface RunPipelineOptions {
  /** Geocoded address or coordinates (one is required). */
  readonly address?: string;
  readonly coords?: { lat: number; lng: number };
  /** Output directory for artifacts (.print.glb, .scene.glb, .schem, .litematic, .verification.json). */
  readonly outDir: string;
  /** Google Maps / Solar / SV API key. */
  readonly apiKey: string;
  /** Optional progress callback. */
  readonly onProgress?: (stage: string, message: string) => void;
}

export interface RunPipelineResult {
  readonly slug: string;
  readonly artifacts: {
    readonly printGlb: string;
    readonly sceneGlb: string;
    readonly schem: string;
    readonly litematic: string;
  };
  readonly report: VerificationReport;
}

export async function runPipeline(_opts: RunPipelineOptions): Promise<RunPipelineResult> {
  throw new Error('runPipeline not yet implemented — see Chunk 9 of plan');
}
