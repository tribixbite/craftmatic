/**
 * category-prompts.ts — Per-category VLM prompt templates for multi-category scoring.
 *
 * Each prompt is honest and neutral — no leading questions, no bias.
 * Defect-checklist style: "list specific defects, then score 0-10".
 */

// ─── Category Definitions ───────────────────────────────────────────────────

export type ScoreCategory =
  | 'colors'
  | 'features'
  | 'layout'
  | 'walking_paths'
  | 'pavement'
  | 'vegetation'
  | 'dimensions';

export const ALL_CATEGORIES: ScoreCategory[] = [
  'colors', 'features', 'layout', 'walking_paths',
  'pavement', 'vegetation', 'dimensions',
];

/** Categories that require scene mode (environment around the building) */
export const SCENE_ONLY_CATEGORIES: Set<ScoreCategory> = new Set([
  'walking_paths', 'pavement', 'vegetation',
]);

/** Category weights for composite score calculation */
export const CATEGORY_WEIGHTS: Record<ScoreCategory, number> = {
  colors: 1.0,
  features: 1.0,
  layout: 1.5,
  walking_paths: 0.5,
  pavement: 0.5,
  vegetation: 0.5,
  dimensions: 1.0,
};

// ─── Prompt Templates ───────────────────────────────────────────────────────

/**
 * Build the full VLM prompt for multi-category scoring.
 *
 * The prompt is structured as a single request that scores all applicable
 * categories at once, reducing API calls. Scene-only categories are included
 * only when sceneMode is true.
 *
 * @param sceneMode  Whether scene features (roads, trees, paths) are present
 * @param knownDimensions  Optional known building dimensions for DIMENSIONS category
 */
export function buildCategoryPrompt(
  sceneMode: boolean,
  knownDimensions?: { widthM: number; depthM: number; heightM?: number },
): string {
  const dimText = knownDimensions
    ? `Known dimensions: ~${knownDimensions.widthM.toFixed(0)}m wide × ${knownDimensions.depthM.toFixed(0)}m deep${knownDimensions.heightM ? ` × ${knownDimensions.heightM.toFixed(0)}m tall` : ''}.`
    : 'Dimensions are unknown — score based on visual proportions only.';

  let prompt = `You are evaluating a Minecraft voxel model of a real building. The model is built at approximately 1-2 blocks per meter resolution — individual blocks are ~1m cubes. At this scale, fine architectural details (individual window panes, ornamental molding, thin railings) CANNOT be represented. Score based on what IS achievable at this resolution.

You will see reference images and voxel model renders:
- Street View facade photos (1-4 angles of the real building — may show scaffolding, vehicles, or other temporary obstructions; ignore those)
- Satellite overhead photo (real building outlined or centered)
- Isometric view of the voxel model
- Front elevation of the voxel model
- Top-down view of the voxel model

${dimText}

SCORING CALIBRATION (use this scale consistently):
- 9-10: Excellent for a voxel model. Building is clearly recognizable. Correct overall form and character.
- 7-8: Good. Recognizable with minor inaccuracies. Acceptable voxel approximation.
- 5-6: Mediocre. Generally right shape but notable errors in this category.
- 3-4: Poor. Significant errors that make this aspect hard to recognize.
- 0-2: Wrong. This aspect bears little resemblance to the real building.

For each category below, list specific defects, then assign a score 0-10:

1. COLORS: Compare the DOMINANT wall and roof hue of the voxel model to the reference photos. Is the overall color palette recognizably similar? A voxel model using tan/beige blocks for a tan stone building scores well even without texture variation. Score the broad hue match, not fine texture.
   Defects: completely wrong wall hue, completely wrong roof hue, monochrome gray when building is distinctly colored, no color differentiation between wall/roof/trim.

2. FEATURES: At 1-2 block/m resolution, evaluate LARGE-SCALE massing features only: major setbacks, step-backs, towers, spires, domes, wings, deep recesses, and large projections. Do NOT penalize: missing individual windows, doors, thin cornices, railings, or ornamental details — these are below the model's resolution. Do NOT penalize: surface noise, holes, or erosion artifacts — score those under LAYOUT instead. A building with correct overall stepped massing and major projections scores 8-9 even without window detail.
   Defects: missing major setback/step-back that changes the building's silhouette, missing tower/dome/spire, completely flat box when reference shows stepped form, missing large wing or projection.

3. LAYOUT: Compare the top-down silhouette of the voxel model to the satellite overhead. Does the footprint shape match? Are the overall proportions (length vs width) correct? Are distinctive shape features preserved (triangular, L-shaped, curved, etc.)? IMPORTANT: Voxel models inherently have stairstepped/jagged edges on diagonal and curved surfaces — this is a normal voxel artifact, NOT holes or damage. Only count as defects: genuinely missing large sections (>10% of building area), wrong overall shape, or missing wings/courtyards.
   Defects: wrong overall outline shape, genuinely missing building wings or sections, filled-in courtyards, footprint rotated or mirrored.
`;

  if (sceneMode) {
    prompt += `
4. WALKING_PATHS: Check for sidewalks, entry paths, and walkways around the building. Are they present in approximately correct positions?
   Defects: no paths visible, paths in wrong positions, missing main entry path.

5. PAVEMENT: Check for roads, parking areas, and plazas. Are they present with distinguishable materials?
   Defects: no road visible, missing parking lot, road in wrong position.

6. VEGETATION: Check for trees, shrubs, and lawns at approximately correct density and positions.
   Defects: no trees where satellite shows trees, wrong tree density, missing lawn areas.
`;
  }

  prompt += `
${sceneMode ? '7' : '4'}. DIMENSIONS: Compare the building's width-to-depth-to-height PROPORTIONS. Does the voxel model have correct relative proportions? IMPORTANT: Google 3D Tiles source data frequently truncates building tops — if height is cut off, score 6-7 (not lower) since this is a known data source limitation, not a model defect. Only score 0-3 if proportions are completely wrong (e.g., building is twice as wide as it should be).
   Defects: height truncated by more than 50%, width-to-depth ratio visibly wrong, building oriented in wrong direction.

Respond with ONLY a JSON object in this exact format (no explanation):
{
  "colors": { "score": N, "defects": ["specific defect 1", ...] },
  "features": { "score": N, "defects": ["specific defect 1", ...] },
  "layout": { "score": N, "defects": ["specific defect 1", ...] },${sceneMode ? `
  "walking_paths": { "score": N, "defects": ["specific defect 1", ...] },
  "pavement": { "score": N, "defects": ["specific defect 1", ...] },
  "vegetation": { "score": N, "defects": ["specific defect 1", ...] },` : ''}
  "dimensions": { "score": N, "defects": ["specific defect 1", ...] }
}`;

  return prompt;
}
