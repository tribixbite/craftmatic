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

  it('deducts 3 for height_truncated', () => {
    expect(scoreFromDefects(makeChecklist({ height_truncated: true }))).toBe(7);
  });

  it('deducts 2 for facade_holes_visible', () => {
    expect(scoreFromDefects(makeChecklist({ facade_holes_visible: true }))).toBe(8);
  });

  it('deducts 2 for floating_artifacts', () => {
    expect(scoreFromDefects(makeChecklist({ floating_artifacts: true }))).toBe(8);
  });

  it('deducts 2 for neighbor_buildings_merged', () => {
    expect(scoreFromDefects(makeChecklist({ neighbor_buildings_merged: true }))).toBe(8);
  });

  it('deducts 2 for footprint_wrong_shape', () => {
    expect(scoreFromDefects(makeChecklist({ footprint_wrong_shape: true }))).toBe(8);
  });

  it('deducts 2 for false_positives_merged', () => {
    expect(scoreFromDefects(makeChecklist({ false_positives_merged: true }))).toBe(8);
  });

  it('deducts 3 when building_recognizable is false', () => {
    expect(scoreFromDefects(makeChecklist({ building_recognizable: false }))).toBe(7);
  });

  it('deducts 1 when proportions_correct is false', () => {
    expect(scoreFromDefects(makeChecklist({ proportions_correct: false }))).toBe(9);
  });

  it('deducts 1 when surface_detail_visible is false', () => {
    expect(scoreFromDefects(makeChecklist({ surface_detail_visible: false }))).toBe(9);
  });

  it('accumulates penalties: height + not-recognizable = 4 points off', () => {
    expect(scoreFromDefects(makeChecklist({
      height_truncated:      true, // -3
      building_recognizable: false, // -3
    }))).toBe(4);
  });

  it('accumulates all minor defects', () => {
    expect(scoreFromDefects(makeChecklist({
      proportions_correct:    false, // -1
      surface_detail_visible: false, // -1
    }))).toBe(8);
  });

  it('never goes below 0 even with all defects', () => {
    const worst: DefectChecklist = {
      height_truncated:          true,  // -3
      facade_holes_visible:      true,  // -2
      floating_artifacts:        true,  // -2
      neighbor_buildings_merged: true,  // -2
      footprint_wrong_shape:     true,  // -2
      false_positives_merged:    true,  // -2
      building_recognizable:     false, // -3
      proportions_correct:       false, // -1
      surface_detail_visible:    false, // -1
    };
    // Total penalties = 18, but clamped to 0
    expect(scoreFromDefects(worst)).toBe(0);
  });

  it('typical partially-good build: shape ok but surface missing', () => {
    expect(scoreFromDefects(makeChecklist({
      surface_detail_visible: false, // -1
      proportions_correct:    false, // -1
    }))).toBe(8);
  });

  it('typical bad build: wrong shape + not recognizable', () => {
    expect(scoreFromDefects(makeChecklist({
      footprint_wrong_shape:  true,  // -2
      building_recognizable:  false, // -3
    }))).toBe(5);
  });
});
