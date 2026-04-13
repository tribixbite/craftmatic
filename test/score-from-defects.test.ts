/**
 * Tests for defect-score.ts — binary defect checklist scoring.
 *
 * Updated for v315 interface: 8 fields (re-added footprint_wrong_shape, proportions_correct at reduced weight).
 * Penalty weights:
 *   neighbor_buildings_merged -2    (critical)
 *   false_positives_merged    -2    (critical)
 *   height_truncated          -1    (minor)
 *   facade_holes_visible      -1    (minor)
 *   floating_artifacts        -1    (minor)
 *   !surface_detail_visible   -1    (minor)
 *   footprint_wrong_shape     -0.3  (low weight: VLM over-flags on blocky voxels)
 *   !proportions_correct      -0.3  (low weight: most voxel builds at 1 block/m fail this)
 *   Max total penalty = 8.6, min possible score = 1.4
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

  it('worst-case scores 1.4 (all defects active, total penalty = 8.6)', () => {
    const worst: DefectChecklist = {
      height_truncated:          true,  // -1
      facade_holes_visible:      true,  // -1
      floating_artifacts:        true,  // -1
      neighbor_buildings_merged: true,  // -2
      false_positives_merged:    true,  // -2
      surface_detail_visible:    false, // -1
      footprint_wrong_shape:     true,  // -0.3
      proportions_correct:       false, // -0.3
    };
    // Total penalties = 1+1+1+2+2+1+0.3+0.3 = 8.6, 10-8.6 = 1.4
    expect(scoreFromDefects(worst)).toBe(1.4);
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
    const score = scoreFromDefects(worst);
    expect(score).toBeGreaterThanOrEqual(0);
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

  // ── Low-weight fields (-0.3 each) ──────────────────────────────────────────

  it('deducts 0.3 for footprint_wrong_shape', () => {
    expect(scoreFromDefects(makeChecklist({ footprint_wrong_shape: true }))).toBe(9.7);
  });

  it('deducts 0.3 when proportions_correct is false', () => {
    expect(scoreFromDefects(makeChecklist({ proportions_correct: false }))).toBe(9.7);
  });

  it('both low-weight defects together deduct 0.6', () => {
    expect(scoreFromDefects(makeChecklist({
      footprint_wrong_shape: true,
      proportions_correct:   false,
    }))).toBe(9.4);
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

  it('typical partially-good build: surface missing only → 9', () => {
    expect(scoreFromDefects(makeChecklist({
      surface_detail_visible: false, // -1
    }))).toBe(9);
  });

  it('typical bad build: neighbors + false positives merged → 6', () => {
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

  it('accumulates 2 minor defects: height + surface = 2 off', () => {
    expect(scoreFromDefects(makeChecklist({
      height_truncated:       true,  // -1
      surface_detail_visible: false, // -1
    }))).toBe(8);
  });

  it('minor + low-weight: height(-1) + wrong footprint(-0.3) = 1.3 off → 8.7', () => {
    expect(scoreFromDefects(makeChecklist({
      height_truncated:      true, // -1
      footprint_wrong_shape: true, // -0.3
    }))).toBe(8.7);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('surface_detail_visible=true does NOT deduct (positive signal)', () => {
    expect(scoreFromDefects(makeChecklist({ surface_detail_visible: true }))).toBe(10);
  });

  it('proportions_correct=true does NOT deduct (positive signal)', () => {
    expect(scoreFromDefects(makeChecklist({ proportions_correct: true }))).toBe(10);
  });

  it('all defects false + all positives true = perfect 10', () => {
    const perfect: DefectChecklist = {
      height_truncated:          false,
      facade_holes_visible:      false,
      floating_artifacts:        false,
      neighbor_buildings_merged: false,
      false_positives_merged:    false,
      surface_detail_visible:    true,
      footprint_wrong_shape:     false,
      proportions_correct:       true,
    };
    expect(scoreFromDefects(perfect)).toBe(10);
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

  it('1 critical + all 4 minors = 6 points off → 4', () => {
    expect(scoreFromDefects(makeChecklist({
      false_positives_merged:    true,  // -2
      height_truncated:          true,  // -1
      facade_holes_visible:      true,  // -1
      floating_artifacts:        true,  // -1
      surface_detail_visible:    false, // -1
    }))).toBe(4);
  });

  it('1 critical + all minors + both low-weight = 6.6 off → 3.4', () => {
    expect(scoreFromDefects(makeChecklist({
      false_positives_merged:    true,  // -2
      height_truncated:          true,  // -1
      facade_holes_visible:      true,  // -1
      floating_artifacts:        true,  // -1
      surface_detail_visible:    false, // -1
      footprint_wrong_shape:     true,  // -0.3
      proportions_correct:       false, // -0.3
    }))).toBe(3.4);
  });
});
