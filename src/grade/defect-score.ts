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
 * Penalty weights (total max = 10):
 *   height_truncated          -2  (moderate: massing truncation)
 *   neighbor_buildings_merged -2  (moderate: footprint contamination)
 *   false_positives_merged    -2  (moderate: footprint contamination)
 *   footprint_wrong_shape     -1  (minor: voxelization inherently approximates shapes)
 *   facade_holes_visible      -1  (minor: often false positive from DDA shadow stripes)
 *   floating_artifacts        -1  (minor: noise — common false positive from texture variation)
 *   !building_recognizable    -1  (minor: overall form + proportion assessment combined)
 *   !surface_detail_visible   -1  (minor: material quality)
 *
 * proportions_correct is retained in the checklist for diagnostics but
 * has zero scoring weight — it is redundant with building_recognizable
 * (if proportions are wildly wrong the building won't be recognizable)
 * and the VLM flags both together ~95% of the time, creating an
 * unjustified double-penalty. Even verified-good builds (flatiron 10/10)
 * get both flagged on ~33% of runs as false positives.
 */
export function scoreFromDefects(defects: DefectChecklist): number {
  let score = 10;
  if (defects.height_truncated)          score -= 2;
  if (defects.facade_holes_visible)      score -= 1;
  if (defects.floating_artifacts)        score -= 1;
  if (defects.neighbor_buildings_merged) score -= 2;
  if (defects.footprint_wrong_shape)     score -= 1;
  if (defects.false_positives_merged)    score -= 2;
  if (!defects.building_recognizable)    score -= 1;
  // proportions_correct: 0 penalty — redundant with building_recognizable (see comment above)
  if (!defects.surface_detail_visible)   score -= 1;
  return Math.max(0, score);
}
