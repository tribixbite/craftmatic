/**
 * parse-category-scores.ts — Extract and validate multi-category scores
 * from VLM JSON responses.
 *
 * Handles markdown fencing, partial responses, and out-of-range values.
 */

import type { ScoreCategory } from './category-prompts.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CategoryResult {
  score: number;       // 0-10
  defects: string[];   // List of specific defects observed
}

export interface CategoryScores {
  colors: CategoryResult | null;
  features: CategoryResult | null;
  layout: CategoryResult | null;
  walking_paths: CategoryResult | null;
  pavement: CategoryResult | null;
  vegetation: CategoryResult | null;
  dimensions: CategoryResult | null;
}

export interface CompositeScore {
  /** Individual category scores */
  categories: CategoryScores;
  /** Weighted composite score (0-10) */
  composite: number;
  /** Number of categories that were scored */
  scoredCount: number;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse a VLM response into structured category scores.
 *
 * Handles:
 * - Markdown code fences (```json ... ```)
 * - Missing categories (returns null for those)
 * - Out-of-range scores (clamps to 0-10)
 * - Malformed JSON (returns all nulls)
 */
export function parseCategoryResponse(
  text: string,
  sceneMode: boolean,
): CategoryScores {
  const empty: CategoryScores = {
    colors: null,
    features: null,
    layout: null,
    walking_paths: null,
    pavement: null,
    vegetation: null,
    dimensions: null,
  };

  // Strip markdown code fences if present
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Extract JSON object from response (may have leading/trailing text)
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objMatch) return empty;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return empty;
  }

  const categories: ScoreCategory[] = [
    'colors', 'features', 'layout', 'dimensions',
    ...(sceneMode ? ['walking_paths', 'pavement', 'vegetation'] as ScoreCategory[] : []),
  ];

  for (const cat of categories) {
    const entry = parsed[cat];
    if (!entry || typeof entry !== 'object') continue;

    const obj = entry as Record<string, unknown>;
    const rawScore = typeof obj.score === 'number' ? obj.score : parseFloat(String(obj.score ?? ''));
    if (isNaN(rawScore)) continue;

    const score = Math.max(0, Math.min(10, Math.round(rawScore * 10) / 10));
    const defects = Array.isArray(obj.defects)
      ? obj.defects.filter((d): d is string => typeof d === 'string')
      : [];

    empty[cat] = { score, defects };
  }

  return empty;
}

// ─── Composite Score ────────────────────────────────────────────────────────

/**
 * Compute a weighted composite score from individual category scores.
 *
 * @param categories  Individual category scores (nulls excluded from calculation)
 * @param weights     Per-category weights (default: CATEGORY_WEIGHTS from prompts)
 */
export function computeComposite(
  categories: CategoryScores,
  weights: Record<ScoreCategory, number>,
): CompositeScore {
  let totalWeight = 0;
  let weightedSum = 0;
  let scoredCount = 0;

  for (const [cat, result] of Object.entries(categories) as [ScoreCategory, CategoryResult | null][]) {
    if (!result) continue;
    const w = weights[cat] ?? 1.0;
    weightedSum += result.score * w;
    totalWeight += w;
    scoredCount++;
  }

  const composite = totalWeight > 0
    ? Math.round((weightedSum / totalWeight) * 10) / 10
    : 0;

  return { categories, composite, scoredCount };
}
