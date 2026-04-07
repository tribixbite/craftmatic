import { describe, it, expect } from 'vitest';
import { scoreFromDefects, type DefectChecklist } from '../src/grade/defect-score.js';

/** Helper: create a checklist with all-good defaults, then override specific fields */
function makeChecklist(overrides: Partial<DefectChecklist> = {}): DefectChecklist {
  return {
    height_truncated:          false,
    facade_holes_visible:      false,
    floating_artifacts:        false,
    neighbor_buildings_merged: false,
    footprint_wrong_shape:     false,
    false_positives_merged:    false,
    building_recognizable:     true,
    proportions_correct:       true,
    surface_detail_visible:    true,
    ...overrides,
  };
}

describe('scoreFromDefects', () => {
  it('returns 10 for a perfect build (no defects, all positives)', () => {
    expect(scoreFromDefects(makeChecklist())).toBe(10);
  });

  it('deducts 1 for height_truncated', () => {
    expect(scoreFromDefects(makeChecklist({ height_truncated: true }))).toBe(9);
  });

  it('deducts 1 for facade_holes_visible', () => {
    expect(scoreFromDefects(makeChecklist({ facade_holes_visible: true }))).toBe(9);
  });

  it('deducts 1 for floating_artifacts', () => {
    expect(scoreFromDefects(makeChecklist({ floating_artifacts: true }))).toBe(9);
  });

  it('deducts 2 for neighbor_buildings_merged', () => {
    expect(scoreFromDefects(makeChecklist({ neighbor_buildings_merged: true }))).toBe(8);
  });

  it('footprint_wrong_shape has zero weight (voxels are inherently blocky)', () => {
    expect(scoreFromDefects(makeChecklist({ footprint_wrong_shape: true }))).toBe(10);
  });

  it('deducts 2 for false_positives_merged', () => {
    expect(scoreFromDefects(makeChecklist({ false_positives_merged: true }))).toBe(8);
  });

  it('building_recognizable has zero weight (subjective meta-judgment)', () => {
    expect(scoreFromDefects(makeChecklist({ building_recognizable: false }))).toBe(10);
  });

  it('proportions_correct has zero weight (redundant with recognizable)', () => {
    expect(scoreFromDefects(makeChecklist({ proportions_correct: false }))).toBe(10);
  });

  it('deducts 1 when surface_detail_visible is false', () => {
    expect(scoreFromDefects(makeChecklist({ surface_detail_visible: false }))).toBe(9);
  });

  it('accumulates penalties: height + facade_holes = 2 points off', () => {
    expect(scoreFromDefects(makeChecklist({
      height_truncated:      true, // -1
      facade_holes_visible:  true, // -1
    }))).toBe(8);
  });

  it('accumulates all minor defects', () => {
    expect(scoreFromDefects(makeChecklist({
      height_truncated:       true,  // -1
      surface_detail_visible: false, // -1
    }))).toBe(8);
  });

  it('never goes below 0 even with all defects', () => {
    const worst: DefectChecklist = {
      height_truncated:          true,  // -1
      facade_holes_visible:      true,  // -1
      floating_artifacts:        true,  // -1
      neighbor_buildings_merged: true,  // -2
      footprint_wrong_shape:     true,  // 0 (zero-weight)
      false_positives_merged:    true,  // -2
      building_recognizable:     false, // 0 (zero-weight)
      proportions_correct:       false, // 0 (zero-weight)
      surface_detail_visible:    false, // -1
    };
    // Total penalties = 8, 10-8 = 2, clamped to 2
    expect(scoreFromDefects(worst)).toBe(2);
  });

  it('typical partially-good build: surface missing only', () => {
    expect(scoreFromDefects(makeChecklist({
      surface_detail_visible: false, // -1
    }))).toBe(9);
  });

  it('typical bad build: neighbors merged + false positives', () => {
    expect(scoreFromDefects(makeChecklist({
      neighbor_buildings_merged: true, // -2
      false_positives_merged:    true, // -2
    }))).toBe(6);
  });
});
