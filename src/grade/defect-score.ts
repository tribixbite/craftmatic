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
  /** True if large unrelated structures are attached to the building */
  false_positives_merged: boolean;
  /** True if facade has visible material variation, not uniform gray */
  surface_detail_visible: boolean;
  // Removed zero-weight fields (v313): footprint_wrong_shape, building_recognizable,
  // proportions_correct — VLM hallucinated these on 33-60% of verified-good builds.
  // Removing saves ~30% VLM output tokens per grading call.
}

/**
 * Compute a deterministic 0-10 score from a binary defect checklist.
 *
 * Penalty weights (total max = 7):
 *   neighbor_buildings_merged -2  (critical: footprint contamination)
 *   false_positives_merged    -2  (critical: footprint contamination)
 *   height_truncated          -1  (minor: Google Tiles LOD limitation)
 *   facade_holes_visible      -1  (minor: often false positive from DDA shadow stripes)
 *   floating_artifacts        -1  (minor: noise — common false positive from texture variation)
 *   !surface_detail_visible   -1  (minor: material quality)
 *
 * Removed zero-weight fields (v313):
 *   footprint_wrong_shape: VLM flagged 6/10 verified-good builds — systematic voxel artifact.
 *   building_recognizable: subjective meta-judgment, ~33% false-positive.
 *   proportions_correct: redundant with building_recognizable (95% co-occurrence).
 */
export function scoreFromDefects(defects: DefectChecklist): number {
  let score = 10;
  if (defects.height_truncated)          score -= 1;
  if (defects.facade_holes_visible)      score -= 1;
  if (defects.floating_artifacts)        score -= 1;
  if (defects.neighbor_buildings_merged) score -= 2;
  if (defects.false_positives_merged)    score -= 2;
  if (!defects.surface_detail_visible)   score -= 1;
  return Math.max(0, score);
}
