/**
 * RGB-to-Minecraft-block palette mapping — shared between the CLI pipeline
 * (address-pipeline.ts) and the web satellite viewer (import-color.ts).
 *
 * Consolidates wall, roof, and trim palettes with CIE-Lab perceptual distance
 * matching plus HSL pixel filters for non-building pixel rejection.
 *
 * CIE-Lab delta-E is used instead of RGB Euclidean distance because Lab
 * perceptually matches human color perception — equal delta-E values represent
 * equal perceived color differences regardless of hue region.
 */

import type { BlockState, RGB } from '../types/index.js';

// ─── HSL Helpers ─────────────────────────────────────────────────────────────

/** RGB (0-255 each) → HSL (H in degrees 0-360, S/L in 0-1) */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
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

// ─── Pixel Filters ───────────────────────────────────────────────────────────
// Reject non-building pixels from zone samples before hue bucketing.

/** Green vegetation band: hue 80-160°, moderate saturation, not too dark/bright */
export function isGrass(h: number, s: number, l: number): boolean {
  return h >= 80 && h <= 160 && s > 0.15 && l > 0.1 && l < 0.7;
}

/** Blue sky or water: hue 180-250°, moderate saturation */
export function isSkyOrWater(h: number, s: number, l: number): boolean {
  return h >= 180 && h <= 250 && s > 0.2 && l > 0.2;
}

/** Deep shadows or asphalt: very low luminance */
export function isShadow(l: number): boolean {
  return l < 0.15;
}

/** Overexposed / specular glare: very high luminance */
export function isGlare(l: number): boolean {
  return l > 0.92;
}

/** Returns true if the pixel should be excluded from building color analysis */
export function isNonBuilding(r: number, g: number, b: number): boolean {
  const [h, s, l] = rgbToHsl(r, g, b);
  return isGrass(h, s, l) || isSkyOrWater(h, s, l) || isShadow(l) || isGlare(l);
}

// ─── Wall Palette ────────────────────────────────────────────────────────────
// ~20 entries covering common residential exteriors mapped to Minecraft blocks.

export const WALL_PALETTE: { block: BlockState; rgb: RGB }[] = [
  // Whites / Lights
  { block: 'minecraft:white_concrete', rgb: [207, 213, 214] },
  { block: 'minecraft:smooth_quartz', rgb: [235, 229, 222] },
  { block: 'minecraft:iron_block', rgb: [222, 222, 222] },
  // Grays
  { block: 'minecraft:light_gray_concrete', rgb: [160, 160, 160] },
  { block: 'minecraft:stone', rgb: [125, 125, 125] },
  { block: 'minecraft:stone_bricks', rgb: [122, 122, 122] },
  { block: 'minecraft:gray_concrete', rgb: [76, 81, 84] },
  // Warm tones (brick, terracotta)
  { block: 'minecraft:bricks', rgb: [150, 97, 83] },
  { block: 'minecraft:terracotta', rgb: [152, 94, 68] },
  { block: 'minecraft:red_nether_bricks', rgb: [68, 4, 7] },
  // Wood tones
  { block: 'minecraft:oak_planks', rgb: [162, 130, 78] },
  { block: 'minecraft:birch_planks', rgb: [192, 175, 121] },
  { block: 'minecraft:spruce_planks', rgb: [114, 85, 48] },
  { block: 'minecraft:dark_oak_planks', rgb: [67, 43, 20] },
  { block: 'minecraft:jungle_planks', rgb: [160, 115, 80] },
  // Sandy / cream
  { block: 'minecraft:sandstone', rgb: [216, 203, 155] },
  { block: 'minecraft:smooth_sandstone', rgb: [223, 214, 170] },
  // Colored concrete (for painted facades)
  { block: 'minecraft:yellow_concrete', rgb: [241, 175, 21] },
  { block: 'minecraft:light_blue_concrete', rgb: [58, 175, 217] },
  { block: 'minecraft:cyan_concrete', rgb: [21, 119, 136] },
];

// ─── Roof Palette ────────────────────────────────────────────────────────────
// Materials that support stair+slab variants for pitched roofs (~13 entries).
// `base` is the material root — stairs/slabs are derived as `${base}_stairs`, `${base}_slab`.

export const ROOF_PALETTE: { base: string; rgb: RGB }[] = [
  { base: 'dark_oak', rgb: [60, 42, 22] },
  { base: 'spruce', rgb: [115, 85, 49] },
  { base: 'oak', rgb: [162, 130, 78] },
  { base: 'birch', rgb: [192, 175, 121] },
  { base: 'brick', rgb: [150, 74, 58] },
  { base: 'stone_brick', rgb: [128, 128, 128] },
  { base: 'sandstone', rgb: [216, 200, 157] },
  { base: 'cobblestone', rgb: [100, 100, 100] },
  { base: 'deepslate_tile', rgb: [54, 54, 62] },
  { base: 'blackstone', rgb: [34, 28, 32] },
  { base: 'prismarine', rgb: [76, 127, 115] },
  { base: 'nether_brick', rgb: [44, 21, 26] },
  { base: 'red_sandstone', rgb: [186, 99, 29] },
];

// ─── Trim Palette ────────────────────────────────────────────────────────────
// Corner boards, window frames, shutters, pilasters.

export const TRIM_PALETTE: { block: BlockState; rgb: RGB }[] = [
  { block: 'minecraft:white_concrete', rgb: [255, 255, 255] },
  { block: 'minecraft:light_gray_concrete', rgb: [160, 160, 160] },
  { block: 'minecraft:dark_oak_log', rgb: [60, 42, 22] },
  { block: 'minecraft:spruce_log', rgb: [115, 85, 49] },
  { block: 'minecraft:oak_log', rgb: [170, 136, 78] },
  { block: 'minecraft:birch_log', rgb: [196, 187, 153] },
  { block: 'minecraft:quartz_pillar', rgb: [235, 229, 222] },
  { block: 'minecraft:sandstone', rgb: [216, 200, 157] },
  { block: 'minecraft:stone_bricks', rgb: [128, 128, 128] },
  { block: 'minecraft:deepslate_bricks', rgb: [54, 54, 62] },
  { block: 'minecraft:stripped_dark_oak_log', rgb: [96, 76, 49] },
  { block: 'minecraft:stripped_spruce_log', rgb: [115, 89, 52] },
];

// ─── CIE-Lab Color Space ─────────────────────────────────────────────────────
// CIE-Lab provides perceptually uniform color distances. Two colors with the
// same delta-E look equally different to humans regardless of hue region.
// This matters for block matching: RGB Euclidean over-weights green channel
// and treats blues/purples as closer than they appear.

/** sRGB → linear RGB (inverse gamma) */
function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Linear RGB → CIE XYZ (D65 illuminant) */
function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  // sRGB to XYZ matrix (D65 reference white)
  return [
    rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375,
    rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750,
    rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041,
  ];
}

// D65 reference white point
const D65_X = 0.95047;
const D65_Y = 1.00000;
const D65_Z = 1.08883;

/** CIE XYZ → Lab nonlinear transform */
function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116;
}

/** Convert sRGB (0-255) to CIE-Lab (L: 0-100, a/b: ~-128 to 128) */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = rgbToXyz(r, g, b);
  const fx = labF(x / D65_X);
  const fy = labF(y / D65_Y);
  const fz = labF(z / D65_Z);
  return [
    116 * fy - 16,        // L*
    500 * (fx - fy),      // a*
    200 * (fy - fz),      // b*
  ];
}

/**
 * CIE76 delta-E: Euclidean distance in Lab space.
 * Perceptually uniform — delta-E of 2.3 is "just noticeable difference".
 * Returns squared distance (no sqrt) since we only compare magnitudes.
 */
export function deltaESq(
  l1: number, a1: number, b1: number,
  l2: number, a2: number, b2: number,
): number {
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return dl * dl + da * da + db * db;
}

// Pre-compute Lab values for all palette entries (avoids repeated conversion)
let _wallLab: [number, number, number][] | null = null;
let _roofLab: [number, number, number][] | null = null;
let _trimLab: [number, number, number][] | null = null;

function getWallLab(): [number, number, number][] {
  if (!_wallLab) _wallLab = WALL_PALETTE.map(e => rgbToLab(...e.rgb));
  return _wallLab;
}
function getRoofLab(): [number, number, number][] {
  if (!_roofLab) _roofLab = ROOF_PALETTE.map(e => rgbToLab(...e.rgb));
  return _roofLab;
}
function getTrimLab(): [number, number, number][] {
  if (!_trimLab) _trimLab = TRIM_PALETTE.map(e => rgbToLab(...e.rgb));
  return _trimLab;
}

// ─── Distance Matching ──────────────────────────────────────────────────────

/** Euclidean RGB distance squared — used as fallback in dominantColor hue bucketing */
export function colorDistSq(r: number, g: number, b: number, ref: RGB): number {
  const dr = r - ref[0];
  const dg = g - ref[1];
  const db = b - ref[2];
  return dr * dr + dg * dg + db * db;
}

/** Find the closest wall block to an observed RGB color (CIE-Lab perceptual match) */
export function rgbToWallBlock(r: number, g: number, b: number): BlockState {
  const [l, a, b_] = rgbToLab(r, g, b);
  const labs = getWallLab();
  let bestIdx = 0;
  let bestDist = deltaESq(l, a, b_, labs[0][0], labs[0][1], labs[0][2]);
  for (let i = 1; i < labs.length; i++) {
    const dist = deltaESq(l, a, b_, labs[i][0], labs[i][1], labs[i][2]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return WALL_PALETTE[bestIdx].block;
}

/**
 * Find the closest roof material to an observed RGB color.
 * Returns a full roofOverride object with north/south stair blocks and a cap slab.
 */
export function rgbToRoofOverride(r: number, g: number, b: number): {
  north: BlockState;
  south: BlockState;
  cap: BlockState;
} {
  const [l, a, b_] = rgbToLab(r, g, b);
  const labs = getRoofLab();
  let bestIdx = 0;
  let bestDist = deltaESq(l, a, b_, labs[0][0], labs[0][1], labs[0][2]);
  for (let i = 1; i < labs.length; i++) {
    const dist = deltaESq(l, a, b_, labs[i][0], labs[i][1], labs[i][2]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  const best = ROOF_PALETTE[bestIdx];
  return {
    north: `minecraft:${best.base}_stairs[facing=north]`,
    south: `minecraft:${best.base}_stairs[facing=south]`,
    cap: `minecraft:${best.base}_slab[type=bottom]`,
  };
}

/** Find the closest trim block to an observed RGB color (CIE-Lab perceptual match) */
export function rgbToTrimBlock(r: number, g: number, b: number): BlockState {
  const [l, a, b_] = rgbToLab(r, g, b);
  const labs = getTrimLab();
  let bestIdx = 0;
  let bestDist = deltaESq(l, a, b_, labs[0][0], labs[0][1], labs[0][2]);
  for (let i = 1; i < labs.length; i++) {
    const dist = deltaESq(l, a, b_, labs[i][0], labs[i][1], labs[i][2]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return TRIM_PALETTE[bestIdx].block;
}

// ─── Hue Bucketing ───────────────────────────────────────────────────────────
// Cluster pixels into 12 hue bins (30° each) plus a gray bucket for desaturated
// pixels. Returns the average RGB of the largest bucket.

const NUM_HUE_BINS = 12;

/**
 * Cluster an array of RGBA pixel data by hue, filtering non-building pixels.
 * Returns the average RGB of the dominant hue cluster, or null if < 50 valid pixels.
 *
 * @param pixels  Raw RGBA pixel data (4 bytes per pixel)
 * @param start   Byte offset to start sampling from
 * @param end     Byte offset to stop sampling at
 * @param stride  Byte stride between rows (width × 4), or 0 to treat as contiguous
 * @param rowStart Starting pixel column within each row (0 for full-width sampling)
 * @param rowEnd  Ending pixel column within each row (width for full-width sampling)
 * @param width   Image width in pixels (needed when stride > 0)
 */
export function dominantColor(
  pixels: Uint8Array | Buffer,
  startRow: number,
  endRow: number,
  width: number,
  colStart = 0,
  colEnd = width,
): { r: number; g: number; b: number } | null {
  // 12 hue bins + 1 gray bucket
  const buckets: { rSum: number; gSum: number; bSum: number; count: number }[] = [];
  for (let i = 0; i <= NUM_HUE_BINS; i++) {
    buckets.push({ rSum: 0, gSum: 0, bSum: 0, count: 0 });
  }

  let totalValid = 0;

  for (let y = startRow; y < endRow; y++) {
    for (let x = colStart; x < colEnd; x++) {
      const idx = (y * width + x) * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];

      const [h, s, l] = rgbToHsl(r, g, b);

      // Reject non-building pixels
      if (isGrass(h, s, l)) continue;
      if (isSkyOrWater(h, s, l)) continue;
      if (isShadow(l)) continue;
      if (isGlare(l)) continue;

      totalValid++;

      // Desaturated → gray bucket (index NUM_HUE_BINS)
      const bucketIdx = s < 0.1 ? NUM_HUE_BINS : Math.floor(h / 30) % NUM_HUE_BINS;
      buckets[bucketIdx].rSum += r;
      buckets[bucketIdx].gSum += g;
      buckets[bucketIdx].bSum += b;
      buckets[bucketIdx].count++;
    }
  }

  if (totalValid < 50) return null;

  // Find largest bucket
  let maxBucket = buckets[0];
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i].count > maxBucket.count) maxBucket = buckets[i];
  }

  if (maxBucket.count === 0) return null;

  return {
    r: Math.round(maxBucket.rSum / maxBucket.count),
    g: Math.round(maxBucket.gSum / maxBucket.count),
    b: Math.round(maxBucket.bSum / maxBucket.count),
  };
}
