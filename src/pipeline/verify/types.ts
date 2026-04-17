/**
 * VerificationReport + ObjectiveResult + ConsensusResult types.
 * Full definitions wired in Chunk 8 per spec §Stage 9 / Stage 10 canonical state record.
 *
 * Status enum kept minimal here for orchestrator typing during scaffold phase.
 */

export type PipelineStatus =
  | 'pass'
  | 'fail-objective'
  | 'fail-consensus'
  | 'needs-human-review'
  | 'context-insufficient';

export interface VerificationReport {
  readonly status: PipelineStatus;
  readonly lastRun: string;
  // Full shape materialized in Chunk 8.
  readonly [key: string]: unknown;
}
