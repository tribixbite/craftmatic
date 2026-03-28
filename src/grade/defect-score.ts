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
 * Penalty weights (total max = 7):
 *   neighbor_buildings_merged -2  (critical: footprint contamination)
 *   false_positives_merged    -2  (critical: footprint contamination)
 *   height_truncated          -1  (minor: Google Tiles LOD limitation)
 *   facade_holes_visible      -1  (minor: often false positive from DDA shadow stripes)
 *   floating_artifacts        -1  (minor: noise — common false positive from texture variation)
 *   !surface_detail_visible   -1  (minor: material quality)
 *
 * Zero-weight fields (retained for diagnostics):
 *   footprint_wrong_shape: voxelization inherently produces blocky approximations.
 *     Flagged on 6/10 buildings including verified-good ones (la-cityhall 9/10,
 *     nga-east 9/10). A systematic artifact of the medium, not a pipeline issue.
 *   building_recognizable: subjective meta-judgment that overlaps with specific defect
 *     fields. VLM flags it inconsistently (~33% false-positive on verified-good builds).
 *   proportions_correct: redundant with building_recognizable; VLM flags both
 *     together ~95% of the time.
 */
export function scoreFromDefects(defects: DefectChecklist): number {
  let score = 10;
  if (defects.height_truncated)          score -= 1;
  if (defects.facade_holes_visible)      score -= 1;
  if (defects.floating_artifacts)        score -= 1;
  if (defects.neighbor_buildings_merged) score -= 2;
  // footprint_wrong_shape: 0 penalty — voxels are inherently blocky; flagged on 6/10 buildings
  if (defects.false_positives_merged)    score -= 2;
  // building_recognizable: 0 penalty — subjective meta-judgment, overlaps specific fields
  // proportions_correct: 0 penalty — redundant with building_recognizable
  if (!defects.surface_detail_visible)   score -= 1;
  return Math.max(0, score);
}
