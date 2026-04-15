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

  let prompt = `You are evaluating a Minecraft voxel model of a real building.

You will see reference images and voxel model renders:
- Street View facade photos (1-4 angles of the real building)
- Satellite overhead photo (real building outlined or centered)
- Isometric view of the voxel model
- Front elevation of the voxel model
- Top-down view of the voxel model

${dimText}

For each category below, carefully compare the voxel model against the reference images. List specific defects you observe, then assign a score from 0 to 10 (0 = completely wrong, 10 = excellent match).

1. COLORS: Compare wall, roof, and trim material colors in the voxel model to the Street View photos. Are the dominant hues correct? Is the roof color accurate vs satellite? Do windows/glass appear as appropriate materials?
   Defects to check: wrong wall color, wrong roof color, monochrome gray when building is colored, glass appearing as solid blocks.

2. FEATURES: Check for architectural features visible in Street View: windows, doors, cornices, setbacks, balconies, columns. Are they represented or missing? Are proportions of feature placement reasonable?
   Defects to check: no visible windows, missing setbacks/steps, no door indication, missing prominent features (towers, domes, arches).

3. LAYOUT: Compare the top-down silhouette of the voxel model to the satellite overhead. Does the footprint shape match? Are wings, courtyards, and irregular shapes preserved?
   Defects to check: wrong outline shape, missing building wings, filled-in courtyards, footprint rotated or mirrored, extra structures attached.
`;

  if (sceneMode) {
    prompt += `
4. WALKING_PATHS: Check for sidewalks, entry paths, and walkways around the building. Are they present and in approximately correct positions relative to the building?
   Defects to check: no paths visible, paths in wrong positions, missing main entry path.

5. PAVEMENT: Check for roads, parking areas, and plazas. Are they present with appropriate materials (gray/dark blocks for asphalt, lighter for concrete)?
   Defects to check: no road visible, wrong road material, missing parking lot, road in wrong position.

6. VEGETATION: Check for trees, shrubs, and lawns. Are they present and in approximately correct density and positions?
   Defects to check: no trees where satellite shows trees, wrong tree density, missing lawn areas, vegetation inside building.
`;
  }

  prompt += `
${sceneMode ? '7' : '4'}. DIMENSIONS: Compare the building's width-to-depth-to-height proportions. Does the voxel model appear to have correct relative proportions? Is the height reasonable?
   Defects to check: height clearly truncated, building too wide/narrow relative to depth, wrong aspect ratio.

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
