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
  /** True if building footprint outline clearly differs from satellite reference */
  footprint_wrong_shape: boolean;
  /** True if width/depth/height proportions reasonably match the reference */
  proportions_correct: boolean;
}

/**
 * Compute a deterministic 0-10 score from a binary defect checklist.
 *
 * Penalty/bonus weights (total max penalty = 8, max bonus = 0.5):
 *   neighbor_buildings_merged -2    (critical: footprint contamination)
 *   false_positives_merged    -2    (critical: footprint contamination)
 *   height_truncated          -1    (minor: Google Tiles LOD limitation)
 *   facade_holes_visible      -1    (minor: often false positive from DDA shadow stripes)
 *   floating_artifacts        -1    (minor: noise — common false positive from texture variation)
 *   !surface_detail_visible   -1    (minor: material quality)
 *   footprint_wrong_shape     -0.3  (low weight: VLM over-flags on blocky 1 block/m voxels)
 *   !proportions_correct      -0.3  (low weight: most voxel builds at 1 block/m fail this)
 */
export function scoreFromDefects(defects: DefectChecklist): number {
  let score = 10;
  if (defects.height_truncated)          score -= 1;
  if (defects.facade_holes_visible)      score -= 1;
  if (defects.floating_artifacts)        score -= 1;
  if (defects.neighbor_buildings_merged) score -= 2;
  if (defects.false_positives_merged)    score -= 2;
  if (!defects.surface_detail_visible)   score -= 1;
  if (defects.footprint_wrong_shape)     score -= 0.3;
  if (!defects.proportions_correct)      score -= 0.3;
  return Math.max(0, Math.round(score * 10) / 10);
}
