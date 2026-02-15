/**
 * Satellite canvas color extraction — detect dominant building color
 * from the satellite tile composite and map it to the closest Minecraft
 * wall block material. No API key required; runs entirely on canvas pixels.
 */

import type { BlockState, RGB } from '@craft/types/index.js';

/** Wall material candidates with their average in-game RGB */
const WALL_MATERIALS: { block: BlockState; rgb: RGB }[] = [
  { block: 'minecraft:white_concrete', rgb: [207, 213, 214] },
  { block: 'minecraft:stone_bricks', rgb: [122, 122, 122] },
  { block: 'minecraft:bricks', rgb: [150, 97, 83] },
  { block: 'minecraft:oak_planks', rgb: [162, 130, 78] },
  { block: 'minecraft:spruce_planks', rgb: [114, 85, 48] },
  { block: 'minecraft:birch_planks', rgb: [192, 175, 121] },
  { block: 'minecraft:dark_oak_planks', rgb: [67, 43, 20] },
  { block: 'minecraft:sandstone', rgb: [216, 203, 155] },
  { block: 'minecraft:terracotta', rgb: [152, 94, 68] },
  { block: 'minecraft:iron_block', rgb: [222, 222, 222] },
];

/** RGB → HSL conversion (H in degrees, S/L in 0-1) */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;

  return [h, s, l];
}

/** Returns true if HSL values indicate grass/vegetation (green hue band) */
function isGrass(h: number, s: number, l: number): boolean {
  return h >= 80 && h <= 160 && s > 0.15 && l > 0.1 && l < 0.7;
}

/** Returns true if HSL values indicate sky or water (blue hue band) */
function isSkyOrWater(h: number, s: number, l: number): boolean {
  return h >= 180 && h <= 250 && s > 0.2 && l > 0.2;
}

/** Returns true if the pixel is too dark (shadows / asphalt) */
function isShadow(l: number): boolean {
  return l < 0.15;
}

/** Returns true if the pixel is too bright (glare / overexposed) */
function isGlare(l: number): boolean {
  return l > 0.92;
}

/**
 * Extract dominant building color from the satellite canvas.
 * Samples pixels in a circular region around the crosshair, filters out
 * vegetation, sky/water, shadows, and glare, then clusters remaining pixels
 * by hue bucket and returns the average RGB of the largest cluster.
 *
 * @param canvas  The 768x768 satellite composite canvas
 * @param centerX Crosshair X position on the canvas
 * @param centerY Crosshair Y position on the canvas
 * @param radius  Sampling radius in pixels (default 50)
 * @returns Average RGB of dominant building color, or null if too few valid pixels
 */
export function extractBuildingColor(
  canvas: HTMLCanvasElement,
  centerX: number,
  centerY: number,
  radius = 50,
): { r: number; g: number; b: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Clamp sampling region to canvas bounds
  const x0 = Math.max(0, Math.floor(centerX - radius));
  const y0 = Math.max(0, Math.floor(centerY - radius));
  const x1 = Math.min(canvas.width, Math.ceil(centerX + radius));
  const y1 = Math.min(canvas.height, Math.ceil(centerY + radius));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const imageData = ctx.getImageData(x0, y0, w, h);
  const data = imageData.data;
  const r2 = radius * radius;

  // Hue buckets: 12 bins of 30° each (0-29, 30-59, ... 330-359)
  // Plus a "gray" bucket for desaturated pixels (S < 0.1)
  const NUM_HUE_BINS = 12;
  const buckets: { rSum: number; gSum: number; bSum: number; count: number }[] = [];
  for (let i = 0; i <= NUM_HUE_BINS; i++) {
    buckets.push({ rSum: 0, gSum: 0, bSum: 0, count: 0 });
  }

  let totalValid = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // Circular mask
      const dx = (x0 + px) - centerX;
      const dy = (y0 + py) - centerY;
      if (dx * dx + dy * dy > r2) continue;

      const idx = (py * w + px) * 4;
      const rr = data[idx];
      const gg = data[idx + 1];
      const bb = data[idx + 2];

      const [hh, ss, ll] = rgbToHsl(rr, gg, bb);

      // Filter out non-building pixels
      if (isGrass(hh, ss, ll)) continue;
      if (isSkyOrWater(hh, ss, ll)) continue;
      if (isShadow(ll)) continue;
      if (isGlare(ll)) continue;

      totalValid++;

      // Desaturated pixels go to gray bucket (index NUM_HUE_BINS)
      let bucketIdx: number;
      if (ss < 0.1) {
        bucketIdx = NUM_HUE_BINS;
      } else {
        bucketIdx = Math.floor(hh / 30) % NUM_HUE_BINS;
      }

      buckets[bucketIdx].rSum += rr;
      buckets[bucketIdx].gSum += gg;
      buckets[bucketIdx].bSum += bb;
      buckets[bucketIdx].count++;
    }
  }

  // Need at least 50 valid pixels to be confident
  if (totalValid < 50) return null;

  // Find the largest bucket
  let maxBucket = buckets[0];
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i].count > maxBucket.count) {
      maxBucket = buckets[i];
    }
  }

  if (maxBucket.count === 0) return null;

  return {
    r: Math.round(maxBucket.rSum / maxBucket.count),
    g: Math.round(maxBucket.gSum / maxBucket.count),
    b: Math.round(maxBucket.bSum / maxBucket.count),
  };
}

/** Euclidean RGB distance squared (no need for sqrt — only used for comparison) */
function colorDistSq(a: { r: number; g: number; b: number }, b: RGB): number {
  const dr = a.r - b[0];
  const dg = a.g - b[1];
  const db = a.b - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Map an RGB color to the closest Minecraft wall block material.
 * Uses Euclidean distance in RGB space against 10 predefined wall materials.
 */
export function mapColorToWall(rgb: { r: number; g: number; b: number }): BlockState {
  let best = WALL_MATERIALS[0];
  let bestDist = colorDistSq(rgb, best.rgb);

  for (let i = 1; i < WALL_MATERIALS.length; i++) {
    const dist = colorDistSq(rgb, WALL_MATERIALS[i].rgb);
    if (dist < bestDist) {
      bestDist = dist;
      best = WALL_MATERIALS[i];
    }
  }

  return best.block;
}

/**
 * Detect swimming pool from satellite imagery.
 * Scans a ring-shaped region around the building center (outside the building
 * footprint, within the property boundary) looking for cyan/turquoise pixels
 * that indicate a pool.
 *
 * @param canvas    The 768x768 satellite composite canvas
 * @param centerX   Building center X on canvas
 * @param centerY   Building center Y on canvas
 * @param innerR    Inner radius (skip building footprint), default 60px
 * @param outerR    Outer radius (property boundary estimate), default 120px
 * @param threshold Minimum percentage of cyan pixels to confirm pool (0-1), default 0.02
 * @returns true if a pool-like cluster of blue pixels is detected
 */
export function detectPool(
  canvas: HTMLCanvasElement,
  centerX: number,
  centerY: number,
  innerR = 60,
  outerR = 120,
  threshold = 0.02,
): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  // Sample the outer ring region
  const x0 = Math.max(0, Math.floor(centerX - outerR));
  const y0 = Math.max(0, Math.floor(centerY - outerR));
  const x1 = Math.min(canvas.width, Math.ceil(centerX + outerR));
  const y1 = Math.min(canvas.height, Math.ceil(centerY + outerR));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return false;

  const imageData = ctx.getImageData(x0, y0, w, h);
  const data = imageData.data;
  const innerR2 = innerR * innerR;
  const outerR2 = outerR * outerR;

  let totalRingPixels = 0;
  let cyanPixels = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const dx = (x0 + px) - centerX;
      const dy = (y0 + py) - centerY;
      const d2 = dx * dx + dy * dy;

      // Only sample the ring between inner and outer radius
      if (d2 < innerR2 || d2 > outerR2) continue;
      totalRingPixels++;

      const idx = (py * w + px) * 4;
      const rr = data[idx];
      const gg = data[idx + 1];
      const bb = data[idx + 2];

      const [hh, ss, ll] = rgbToHsl(rr, gg, bb);

      // Pool detection: cyan/turquoise hue band (160-220°), moderate-high saturation
      if (hh >= 160 && hh <= 220 && ss > 0.25 && ll > 0.25 && ll < 0.75) {
        cyanPixels++;
      }
    }
  }

  if (totalRingPixels < 100) return false;
  return (cyanPixels / totalRingPixels) >= threshold;
}

/** Exposed for testing — the wall material palette */
export const WALL_MATERIAL_PALETTE = WALL_MATERIALS;
