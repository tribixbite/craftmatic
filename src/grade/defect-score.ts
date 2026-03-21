/**
 * defect-score.ts — Binary defect checklist scoring for the v300 grading pipeline.
 *
 * Each boolean field represents a defect (true = bad) or quality signal (true = good).
 * scoreFromDefects() maps the checklist to a deterministic 0-10 score,
 * eliminating VLM score variance inherent in continuous rating prompts.
 */

/** Binary defect checklist populated by VLM grading with DEFECT_PROMPT */
export interface DefectChecklist {
  /** True if building appears cut off / much shorter than reference */
  height_truncated: boolean;
  /** True if walls have swiss-cheese holes or missing patches */
  facade_holes_visible: boolean;
  /** True if there are floating blocks, disconnected pieces, or noise */
  floating_artifacts: boolean;
  /** True if adjacent buildings are merged into the target */
  neighbor_buildings_merged: boolean;
  /** True if footprint shape doesn't match satellite outline */
  footprint_wrong_shape: boolean;
  /** True if large unrelated structures are attached to the building */
  false_positives_merged: boolean;
  /** True if someone familiar with this building would identify it */
  building_recognizable: boolean;
  /** True if width/height/depth ratios roughly match the reference */
  proportions_correct: boolean;
  /** True if facade has visible material variation, not uniform gray */
  surface_detail_visible: boolean;
}

/**
 * Compute a deterministic 0-10 score from a binary defect checklist.
 *
 * Penalty weights:
 *   height_truncated          -3  (severe: destroys massing identity)
 *   !building_recognizable    -3  (severe: build fails primary objective)
 *   facade_holes_visible      -2  (moderate: structural integrity)
 *   floating_artifacts        -2  (moderate: noise pollution)
 *   neighbor_buildings_merged -2  (moderate: footprint contamination)
 *   footprint_wrong_shape     -2  (moderate: shape accuracy)
 *   false_positives_merged    -2  (moderate: footprint contamination)
 *   !proportions_correct      -1  (minor: proportional accuracy)
 *   !surface_detail_visible   -1  (minor: material quality)
 */
export function scoreFromDefects(defects: DefectChecklist): number {
  let score = 10;
  if (defects.height_truncated)          score -= 3;
  if (defects.facade_holes_visible)      score -= 2;
  if (defects.floating_artifacts)        score -= 2;
  if (defects.neighbor_buildings_merged) score -= 2;
  if (defects.footprint_wrong_shape)     score -= 2;
  if (defects.false_positives_merged)    score -= 2;
  if (!defects.building_recognizable)    score -= 3;
  if (!defects.proportions_correct)      score -= 1;
  if (!defects.surface_detail_visible)   score -= 1;
  return Math.max(0, score);
}
