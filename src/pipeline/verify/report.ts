/**
 * Stage 9 — canonical VerificationReport shape.
 *
 * Matches the `status` enum the stop hook reads (spec §Stage 10). Hook branches
 * on `status`, never on derived `objective.pass` / `consensus.pass`.
 */

import type { PipelineStatus } from './types.js';
import type { ObjectiveResult } from './objective.js';
import type { ConsensusResult } from './consensus.js';
import type { ProvenanceSummary } from './provenance.js';
import { summariseProvenance } from './provenance.js';
import type { CrossCheckResult } from './cross-check.js';
import { crossCheckHeight } from './cross-check.js';
import type { JointEvidence } from '../fusion/types.js';
import type { BuildingContext } from '../context/types.js';

export interface FullVerificationReport {
  readonly status: PipelineStatus;
  readonly lastRun: string;
  readonly objective: ObjectiveResult | null;
  readonly consensus: ConsensusResult | null;
  /**
   * Per-field chain of custody from fusion (source + confidence for height,
   * footprint, wall/roof colour, etc.). `null` when no evidence was resolved
   * (e.g. `context-insufficient`). Makes a build's score explainable — a low
   * colour score on an `inferred/0.20` wall is a data gap, not a regression.
   */
  readonly provenance: ProvenanceSummary | null;
  /**
   * Independent height cross-check (measured-reality guard). Compares the built
   * height against survey sources that did not drive it; flags likely
   * photogrammetry truncation. Advisory — does NOT gate `status`. `null` when no
   * context/evidence was available.
   */
  readonly crossCheck: CrossCheckResult | null;
  /** Non-empty for `context-insufficient` status. */
  readonly reason?: string;
}

/**
 * Compose an objective result + optional consensus result into the canonical
 * state-record shape. Consumers write this to `output/pipeline-state.json`
 * keyed by address slug.
 */
export function composeReport(input: {
  readonly objective: ObjectiveResult;
  readonly consensus?: ConsensusResult;
  /** Fused evidence (Stage 6). When provided, its per-field provenance is
   *  summarised into the report; omit it and `provenance` is null. */
  readonly evidence?: JointEvidence;
  /** Refined context (Stage 2). With `evidence`, enables the independent
   *  height cross-check; omit either and `crossCheck` is null. */
  readonly ctx?: BuildingContext;
}): FullVerificationReport {
  const lastRun = new Date().toISOString();
  const provenance = input.evidence ? summariseProvenance(input.evidence) : null;
  const crossCheck = input.evidence && input.ctx
    ? crossCheckHeight(input.ctx, input.evidence)
    : null;

  if (!input.objective.pass) {
    return {
      status: 'fail-objective',
      lastRun,
      objective: input.objective,
      consensus: input.consensus ?? null,
      provenance,
      crossCheck,
    };
  }
  if (!input.consensus) {
    // Objective pass but consensus not yet run — treat as still failing a gate
    return {
      status: 'fail-consensus',
      lastRun,
      objective: input.objective,
      consensus: null,
      provenance,
      crossCheck,
    };
  }
  if (input.consensus.status === 'needs-human-review') {
    return {
      status: 'needs-human-review',
      lastRun,
      objective: input.objective,
      consensus: input.consensus,
      provenance,
      crossCheck,
    };
  }
  if (input.consensus.pass) {
    return {
      status: 'pass',
      lastRun,
      objective: input.objective,
      consensus: input.consensus,
      provenance,
      crossCheck,
    };
  }
  return {
    status: 'fail-consensus',
    lastRun,
    objective: input.objective,
    consensus: input.consensus,
    provenance,
    crossCheck,
  };
}

/**
 * Short single-line summary — used by the stop hook and iterate.ts for
 * telemetry.
 */
export function summariseReport(report: FullVerificationReport): string {
  const parts: string[] = [`status=${report.status}`];
  if (report.objective) {
    parts.push(
      `iou=${report.objective.footprintIoU.toFixed(2)}`,
      `h_err=${(report.objective.heightErr * 100).toFixed(0)}%`,
      `watertight=${report.objective.watertight}`,
      `voxels=${report.objective.voxelCount}`,
    );
    if (report.objective.failures.length > 0) {
      parts.push(`failures=[${report.objective.failures.join('|')}]`);
    }
  }
  if (report.consensus) {
    parts.push(
      `consensus_min=${report.consensus.min.toFixed(1)}`,
      `median=${report.consensus.median.toFixed(1)}`,
      `spread=${report.consensus.spread}`,
      `rounds=${report.consensus.rounds}`,
    );
  }
  if (report.provenance?.weakest) {
    const w = report.provenance.weakest;
    parts.push(
      `prov_weak=${w.field}/${w.source}/${w.confidence.toFixed(2)}`,
      `prov_mean=${report.provenance.meanConfidence.toFixed(2)}`,
    );
  }
  if (report.crossCheck && !report.crossCheck.ok) {
    parts.push(
      `xcheck=${report.crossCheck.truncationSuspected ? 'truncated' : 'disagree'}`,
      `xcheck_max=${(report.crossCheck.maxDisagreement * 100).toFixed(0)}%`,
    );
  }
  if (report.reason) parts.push(`reason="${report.reason}"`);
  return parts.join(' ');
}

/**
 * Standalone context-insufficient result — resolver throws, we catch and
 * convert to a report.
 */
export function contextInsufficientReport(reason: string): FullVerificationReport {
  return {
    status: 'context-insufficient',
    lastRun: new Date().toISOString(),
    objective: null,
    consensus: null,
    provenance: null,
    crossCheck: null,
    reason,
  };
}
