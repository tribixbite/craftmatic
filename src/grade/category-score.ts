/**
 * category-score.ts — Multi-category VLM scoring for building quality assessment.
 *
 * Sends a composite image set (reference SV + satellite + voxel renders) to
 * Gemini with an honest, neutral prompt. Returns per-category 0-10 scores
 * for colors, features, layout, walking paths, pavement, vegetation, dimensions.
 *
 * Usage:
 *   const result = await scoreCategories({
 *     svImages: ['path/to/sv-front.jpg', 'path/to/sv-right.jpg'],
 *     satelliteImage: 'path/to/satellite.jpg',
 *     isoImage: 'path/to/voxel-iso.jpg',
 *     frontImage: 'path/to/voxel-front.jpg',
 *     topdownImage: 'path/to/voxel-topdown.jpg',
 *     sceneMode: false,
 *     knownDimensions: { widthM: 40, depthM: 25, heightM: 87 },
 *     apiKey: process.env.GOOGLE_GEMINI_API_KEY,
 *   });
 */

import { readFileSync, existsSync } from 'node:fs';
import { buildCategoryPrompt, CATEGORY_WEIGHTS } from './category-prompts.js';
import { parseCategoryResponse, computeComposite, type CompositeScore } from './parse-category-scores.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CategoryScoreInput {
  /** Street View reference image paths (1-4 facade angles) */
  svImages: string[];
  /** Satellite/aerial reference image path */
  satelliteImage: string;
  /** Voxel isometric render path */
  isoImage: string;
  /** Voxel front elevation render path */
  frontImage: string;
  /** Voxel top-down render path */
  topdownImage: string;
  /** Whether scene features (roads, trees) are present */
  sceneMode: boolean;
  /** Known building dimensions for proportions scoring */
  knownDimensions?: { widthM: number; depthM: number; heightM?: number };
  /** Google Gemini API key */
  apiKey: string;
  /** VLM model to use (default: gemini-2.5-pro) */
  model?: string;
  /** Temperature (default: 0.0 for deterministic scoring) */
  temperature?: number;
}

// Re-export for consumers
export type { CompositeScore, CategoryScores, CategoryResult } from './parse-category-scores.js';
export type { ScoreCategory } from './category-prompts.js';
export { ALL_CATEGORIES, SCENE_ONLY_CATEGORIES, CATEGORY_WEIGHTS } from './category-prompts.js';

// ─── Gemini API Types ───────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content: { parts: Array<{ text?: string }> };
  }>;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Load an image file as a base64 Gemini inline data part.
 * Returns null if the file doesn't exist or can't be read.
 */
function loadImagePart(path: string): GeminiPart | null {
  if (!existsSync(path)) return null;
  try {
    const data = readFileSync(path);
    const ext = path.split('.').pop()?.toLowerCase() ?? 'jpg';
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
    return { inlineData: { mimeType, data: data.toString('base64') } };
  } catch {
    return null;
  }
}

/**
 * Score a building's voxel model across 7 categories using VLM comparison
 * against Street View + satellite reference images.
 *
 * Returns per-category scores + weighted composite. Returns null on API failure.
 */
export async function scoreCategories(
  input: CategoryScoreInput,
): Promise<CompositeScore | null> {
  const model = input.model ?? 'gemini-2.5-pro';
  const temperature = input.temperature ?? 0.0;

  // Build multi-part request: prompt + all images
  const parts: GeminiPart[] = [];

  // Add prompt text
  const prompt = buildCategoryPrompt(input.sceneMode, input.knownDimensions);
  parts.push({ text: prompt });

  // Add SV reference images (labeled)
  for (let i = 0; i < input.svImages.length; i++) {
    const part = loadImagePart(input.svImages[i]);
    if (part) {
      parts.push({ text: `Street View facade ${i + 1}:` });
      parts.push(part);
    }
  }

  // Add satellite reference
  const satPart = loadImagePart(input.satelliteImage);
  if (satPart) {
    parts.push({ text: 'Satellite reference:' });
    parts.push(satPart);
  }

  // Add voxel renders
  const isoPart = loadImagePart(input.isoImage);
  if (isoPart) {
    parts.push({ text: 'Voxel model — isometric view:' });
    parts.push(isoPart);
  }

  const frontPart = loadImagePart(input.frontImage);
  if (frontPart) {
    parts.push({ text: 'Voxel model — front elevation:' });
    parts.push(frontPart);
  }

  const tdPart = loadImagePart(input.topdownImage);
  if (tdPart) {
    parts.push({ text: 'Voxel model — top-down view:' });
    parts.push(tdPart);
  }

  // Call Gemini API
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${input.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature,
            maxOutputTokens: 16384,
            // Enable thinking tokens for structured reasoning
            ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 8192 } } : {}),
          },
        }),
      },
    );

    if (!res.ok) {
      console.error(`  Category grade API error: HTTP ${res.status} ${res.statusText}`);
      return null;
    }

    const json = await res.json() as GeminiResponse;
    const responseText = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';

    if (!responseText) {
      console.error('  Category grade: empty response from VLM');
      return null;
    }

    // Parse structured response into category scores
    const scores = parseCategoryResponse(responseText, input.sceneMode);
    return computeComposite(scores, CATEGORY_WEIGHTS);
  } catch (err) {
    console.error(`  Category grade failed: ${(err as Error).message}`);
    return null;
  }
}
