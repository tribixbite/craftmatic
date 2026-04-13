/**
 * Tests for defect-score.ts — binary defect checklist scoring.
 *
 * Penalty weights:
 *   neighbor_buildings_merged -2    (critical)
 *   false_positives_merged    -2    (critical)
 *   height_truncated          -1    (minor)
 *   facade_holes_visible      -1    (minor)
 *   floating_artifacts        -1    (minor)
 *   !surface_detail_visible   -1    (minor)
 *   footprint_wrong_shape      0    (zero-weighted, collected for diagnostics)
 *   !proportions_correct       0    (zero-weighted, collected for diagnostics)
 *   Max total penalty = 8, min possible score = 2
 */

import { describe, it, expect } from 'vitest';
import { scoreFromDefects, type DefectChecklist } from '../src/grade/defect-score.js';

/** Helper: create a checklist with all-good defaults, then override specific fields */
function makeChecklist(overrides: Partial<DefectChecklist> = {}): DefectChecklist {
  return {
    height_truncated:          false,
    facade_holes_visible:      false,
    floating_artifacts:        false,
    neighbor_buildings_merged: false,
    false_positives_merged:    false,
    surface_detail_visible:    true,
    footprint_wrong_shape:     false,
    proportions_correct:       true,
    ...overrides,
  };
}

describe('scoreFromDefects', () => {
  // ── Perfect and worst-case ─────────────────────────────────────────────────

  it('returns 10 for a perfect build (no defects, all positives)', () => {
    expect(scoreFromDefects(makeChecklist())).toBe(10);
  });

  it('worst-case scores 2 (all weighted defects active, penalty = 8)', () => {
    const worst: DefectChecklist = {
      height_truncated:          true,  // -1
      facade_holes_visible:      true,  // -1
      floating_artifacts:        true,  // -1
      neighbor_buildings_merged: true,  // -2
      false_positives_merged:    true,  // -2
      surface_detail_visible:    false, // -1
      footprint_wrong_shape:     true,  // 0 (zero-weighted)
      proportions_correct:       false, // 0 (zero-weighted)
    };
    expect(scoreFromDefects(worst)).toBe(2);
  });

  it('never goes below 0', () => {
    const worst: DefectChecklist = {
      height_truncated:          true,
      facade_holes_visible:      true,
      floating_artifacts:        true,
      neighbor_buildings_merged: true,
      false_positives_merged:    true,
      surface_detail_visible:    false,
      footprint_wrong_shape:     true,
      proportions_correct:       false,
    };
    expect(scoreFromDefects(worst)).toBeGreaterThanOrEqual(0);
  });

  // ── Individual minor defects (-1 each) ─────────────────────────────────────

  it('deducts 1 for height_truncated', () => {
    expect(scoreFromDefects(makeChecklist({ height_truncated: true }))).toBe(9);
  });

  it('deducts 1 for facade_holes_visible', () => {
    expect(scoreFromDefects(makeChecklist({ facade_holes_visible: true }))).toBe(9);
  });

  it('deducts 1 for floating_artifacts', () => {
    expect(scoreFromDefects(makeChecklist({ floating_artifacts: true }))).toBe(9);
  });

  it('deducts 1 when surface_detail_visible is false', () => {
    expect(scoreFromDefects(makeChecklist({ surface_detail_visible: false }))).toBe(9);
  });

  // ── Individual critical defects (-2 each) ──────────────────────────────────

  it('deducts 2 for neighbor_buildings_merged', () => {
    expect(scoreFromDefects(makeChecklist({ neighbor_buildings_merged: true }))).toBe(8);
  });

  it('deducts 2 for false_positives_merged', () => {
    expect(scoreFromDefects(makeChecklist({ false_positives_merged: true }))).toBe(8);
  });

  // ── Zero-weighted fields (collected but no scoring impact) ─────────────────

  it('footprint_wrong_shape has zero scoring impact', () => {
    expect(scoreFromDefects(makeChecklist({ footprint_wrong_shape: true }))).toBe(10);
  });

  it('proportions_correct=false has zero scoring impact', () => {
    expect(scoreFromDefects(makeChecklist({ proportions_correct: false }))).toBe(10);
  });

  it('both zero-weighted fields together have no impact', () => {
    expect(scoreFromDefects(makeChecklist({
      footprint_wrong_shape: true,
      proportions_correct:   false,
    }))).toBe(10);
  });

  // ── Accumulated penalties ──────────────────────────────────────────────────

  it('accumulates penalties: height + facade_holes = 2 points off', () => {
    expect(scoreFromDefects(makeChecklist({
      height_truncated:      true, // -1
      facade_holes_visible:  true, // -1
    }))).toBe(8);
  });

  it('accumulates all minor defects: 4 points off', () => {
    expect(scoreFromDefects(makeChecklist({
      height_truncated:       true,  // -1
      facade_holes_visible:   true,  // -1
      floating_artifacts:     true,  // -1
      surface_detail_visible: false, // -1
    }))).toBe(6);
  });

  it('both critical defects: 4 points off', () => {
    expect(scoreFromDefects(makeChecklist({
      neighbor_buildings_merged: true, // -2
      false_positives_merged:    true, // -2
    }))).toBe(6);
  });

  it('1 critical + 1 minor = 3 points off → 7', () => {
    expect(scoreFromDefects(makeChecklist({
      neighbor_buildings_merged: true, // -2
      floating_artifacts:        true, // -1
    }))).toBe(7);
  });

  it('1 critical + all 4 minors = 6 points off → 4', () => {
    expect(scoreFromDefects(makeChecklist({
      false_positives_merged:    true,  // -2
      height_truncated:          true,  // -1
      facade_holes_visible:      true,  // -1
      floating_artifacts:        true,  // -1
      surface_detail_visible:    false, // -1
    }))).toBe(4);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('surface_detail_visible=true does NOT deduct (positive signal)', () => {
    expect(scoreFromDefects(makeChecklist({ surface_detail_visible: true }))).toBe(10);
  });

  it('score is deterministic (same input → same output)', () => {
    const input = makeChecklist({
      height_truncated: true,
      neighbor_buildings_merged: true,
    });
    const score1 = scoreFromDefects(input);
    const score2 = scoreFromDefects(input);
    const score3 = scoreFromDefects(input);
    expect(score1).toBe(score2);
    expect(score2).toBe(score3);
    expect(score1).toBe(7); // -1 + -2 = 3 off
  });

  it('zero-weighted fields do not change accumulated score', () => {
    const withoutZeroWeight = scoreFromDefects(makeChecklist({
      height_truncated: true,       // -1
      facade_holes_visible: true,   // -1
    }));
    const withZeroWeight = scoreFromDefects(makeChecklist({
      height_truncated: true,       // -1
      facade_holes_visible: true,   // -1
      footprint_wrong_shape: true,  // 0
      proportions_correct: false,   // 0
    }));
    expect(withoutZeroWeight).toBe(withZeroWeight);
    expect(withoutZeroWeight).toBe(8);
  });
});
