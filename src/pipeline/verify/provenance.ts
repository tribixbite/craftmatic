/**
 * Provenance summary for the verification report.
 *
 * Stage 6 (fusion) resolves every field as `Evidence<T> = {value, source,
 * confidence}`, but the verification report historically dropped that on the
 * floor. Surfacing it makes a build's score EXPLAINABLE: a low colour score on
 * a building whose wall colour is `inferred/0.20` is a data gap, not a pipeline
 * regression — so the iterate loop can stop chasing data-limited buildings.
 * Adapted from Tekton's provenance toggle / evidence-class audit.
 *
 * Pure: a deterministic projection of `JointEvidence` → a compact, serialisable
 * summary embedded in `FullVerificationReport` and persisted to
 * `pipeline-state.json`.
 */

import type { JointEvidence, EvidenceSource, Evidence } from '../fusion/types.js';
import type { Lab } from '../context/types.js';

/** One reconciled field's chain of custody, summarised for the report. */
export interface FieldProvenance {
  /** Stable field key: 'footprint' | 'height' | 'levels' | 'wall' | 'roof' | 'roofShape'. */
  readonly field: string;
  /** Compact human-readable rendering of the resolved value. */
  readonly value: string;
  readonly source: EvidenceSource;
  /** 0-1; 1 = authoritative data, 0 = pure default. */
  readonly confidence: number;
}

export interface ProvenanceSummary {
  readonly fields: readonly FieldProvenance[];
  /** Lowest-confidence field — the weakest link in this reconstruction. */
  readonly weakest: FieldProvenance | null;
  /** Mean confidence across the summarised fields (0-1). */
  readonly meanConfidence: number;
}

function labSummary(palette: readonly Lab[]): string {
  if (palette.length === 0) return 'none';
  const [L, a, b] = palette[0];
  const extra = palette.length > 1 ? ` +${palette.length - 1}` : '';
  return `lab(${Math.round(L)},${Math.round(a)},${Math.round(b)})${extra}`;
}

/** Build one FieldProvenance from an Evidence wrapper + a value formatter. */
function field<T>(key: string, ev: Evidence<T>, fmt: (v: T) => string): FieldProvenance {
  return { field: key, value: fmt(ev.value), source: ev.source, confidence: ev.confidence };
}

/**
 * Project the fused evidence into a per-field provenance summary. Covers the six
 * fields that dominate a build's visual fidelity (footprint, height, levels,
 * wall/roof palette, roof shape); per-facade windows / cornice / entry are
 * intentionally omitted to keep the report compact.
 */
export function summariseProvenance(ev: JointEvidence): ProvenanceSummary {
  const fields: FieldProvenance[] = [
    field('footprint', ev.footprint, (p) => `${p.length} pts`),
    field('height', ev.heightM, (h) => `${h.toFixed(1)}m`),
    field('levels', ev.levels, (n) => `${n}`),
    field('wall', ev.wallPalette, labSummary),
    field('roof', ev.roofPalette, labSummary),
    field('roofShape', ev.roofShape, (s) => `${s}`),
  ];

  let weakest: FieldProvenance | null = null;
  let sum = 0;
  for (const f of fields) {
    sum += f.confidence;
    if (weakest === null || f.confidence < weakest.confidence) weakest = f;
  }
  const meanConfidence = fields.length > 0 ? sum / fields.length : 0;
  return { fields, weakest, meanConfidence };
}
