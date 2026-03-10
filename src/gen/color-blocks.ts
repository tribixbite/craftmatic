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

/**
 * Post-extraction check: is the dominant color likely vegetation rather than building?
 * Broader than isGrass (which filters individual pixels) — catches olive, dark green,
 * and muted foliage tones that survive per-pixel filtering when building is fully occluded.
 * Use on the final extracted wall/roof color to decide if the result is trustworthy.
 */
export function isVegetationColor(r: number, g: number, b: number): boolean {
  const [h, s] = rgbToHsl(r, g, b);
  // Green–olive band: hue 60-170°, saturation >10% (more permissive than isGrass)
  // This catches dark foliage (austin: 83,87,55) and cedar (seattle: 77,86,54)
  return h >= 60 && h <= 170 && s > 0.10;
}

// ─── Wall Palette ────────────────────────────────────────────────────────────
// Multi-option color clusters — inspired by arnis DEFINED_COLORS pattern.
// Each entry has a reference RGB and 1-4 block options. The closest color
// cluster is found via CIE-Lab delta-E, then a block is picked from its options.
// This gives visual variety: two similarly-colored buildings get different blocks.

/** Single-block entry (backward compat) */
export interface WallPaletteEntry { block: BlockState; rgb: RGB }

/** Multi-option color cluster — multiple plausible blocks per reference color */
export interface ColorCluster { rgb: RGB; options: BlockState[] }

export const WALL_CLUSTERS: ColorCluster[] = [
  // ── Whites / Creams ──────────────────────────────────────────────────────────
  // Pure white: marble, painted brick, modern stucco
  { rgb: [235, 235, 235], options: ['minecraft:smooth_quartz', 'minecraft:white_concrete', 'minecraft:quartz_block'] },
  // Cool white: weathered painted siding
  { rgb: [207, 213, 214], options: ['minecraft:white_concrete', 'minecraft:smooth_quartz'] },
  // Warm off-white / beige stucco — fills critical gap for common building facades
  { rgb: [215, 210, 200], options: ['minecraft:white_terracotta', 'minecraft:smooth_sandstone'] },

  // ── Tans / Sandy / Limestone ─────────────────────────────────────────────────
  { rgb: [223, 214, 170], options: ['minecraft:smooth_sandstone', 'minecraft:sandstone'] },
  { rgb: [216, 203, 155], options: ['minecraft:sandstone', 'minecraft:smooth_sandstone', 'minecraft:end_stone_bricks'] },
  { rgb: [192, 175, 121], options: ['minecraft:birch_planks', 'minecraft:stripped_birch_log'] },
  { rgb: [191, 147, 42], options: ['minecraft:smooth_sandstone', 'minecraft:sandstone'] },
  // Aged limestone / shadowed plaster
  { rgb: [165, 150, 115], options: ['minecraft:sandstone', 'minecraft:smooth_sandstone', 'minecraft:birch_planks'] },
  { rgb: [140, 128, 98], options: ['minecraft:sandstone', 'minecraft:smooth_sandstone', 'minecraft:end_stone_bricks'] },

  // ── Earth / Brownstone ───────────────────────────────────────────────────────
  // Light brownstone — NYC/Chicago facades
  { rgb: [152, 94, 68], options: ['minecraft:terracotta', 'minecraft:brown_terracotta'] },
  // Medium brownstone
  { rgb: [122, 92, 66], options: ['minecraft:brown_terracotta', 'minecraft:terracotta', 'minecraft:polished_granite'] },
  // Dark brownstone
  { rgb: [110, 70, 50], options: ['minecraft:brown_terracotta', 'minecraft:polished_granite'] },
  // Very dark earth
  { rgb: [57, 41, 35], options: ['minecraft:brown_terracotta', 'minecraft:brown_concrete'] },

  // ── Reds / Brick ─────────────────────────────────────────────────────────────
  // Orange-red brick — classic facades
  { rgb: [233, 107, 57], options: ['minecraft:bricks', 'minecraft:terracotta'] },
  { rgb: [150, 97, 83], options: ['minecraft:bricks', 'minecraft:terracotta'] },
  { rgb: [159, 82, 36], options: ['minecraft:brown_terracotta', 'minecraft:bricks', 'minecraft:polished_granite'] },
  // Dark red / aged brick
  { rgb: [142, 33, 33], options: ['minecraft:red_concrete', 'minecraft:red_terracotta'] },
  { rgb: [68, 4, 7], options: ['minecraft:red_nether_bricks', 'minecraft:nether_bricks'] },

  // ── Grays / Concrete / Stone ─────────────────────────────────────────────────
  // Light concrete
  { rgb: [170, 170, 170], options: ['minecraft:light_gray_concrete', 'minecraft:smooth_stone'] },
  // Medium stone — even spacing across L* axis for shadow tolerance
  { rgb: [130, 130, 130], options: ['minecraft:stone', 'minecraft:stone_bricks', 'minecraft:andesite'] },
  // Blue-gray / slate
  { rgb: [112, 108, 138], options: ['minecraft:gray_terracotta', 'minecraft:polished_andesite'] },
  // Dark concrete — NO glass (creates transparent holes in solid walls)
  { rgb: [80, 80, 84], options: ['minecraft:gray_concrete', 'minecraft:polished_deepslate'] },

  // ── Darks / Industrial ───────────────────────────────────────────────────────
  // Removed blackstone + deepslate_bricks: photogrammetry bakes ambient occlusion
  // as near-black pixels that snap to these, creating "termite damage" noise across
  // building facades. Darkest allowed is gray_concrete (L*≈34). Real buildings
  // rarely have pitch-black materials — dark shadows should clamp to medium gray.

  // ── Wood Tones ───────────────────────────────────────────────────────────────
  { rgb: [162, 130, 78], options: ['minecraft:oak_planks', 'minecraft:stripped_oak_log'] },
  { rgb: [160, 115, 80], options: ['minecraft:jungle_planks', 'minecraft:stripped_jungle_log'] },
  { rgb: [114, 85, 48], options: ['minecraft:spruce_planks', 'minecraft:stripped_spruce_log'] },
  { rgb: [67, 43, 20], options: ['minecraft:dark_oak_planks', 'minecraft:stripped_dark_oak_log'] },

  // ── Painted Accents ──────────────────────────────────────────────────────────
  { rgb: [241, 175, 21], options: ['minecraft:yellow_concrete', 'minecraft:yellow_terracotta'] },
  { rgb: [76, 127, 153], options: ['minecraft:light_blue_terracotta', 'minecraft:cyan_terracotta'] },
  { rgb: [58, 175, 217], options: ['minecraft:light_blue_concrete', 'minecraft:light_blue_terracotta'] },
  { rgb: [21, 119, 136], options: ['minecraft:cyan_concrete', 'minecraft:cyan_terracotta'] },
  { rgb: [73, 91, 36], options: ['minecraft:green_concrete', 'minecraft:green_terracotta'] },
  { rgb: [213, 159, 145], options: ['minecraft:pink_terracotta', 'minecraft:white_terracotta'] },
];

// Backward-compatible single-block palette (first option from each cluster)
export const WALL_PALETTE: WallPaletteEntry[] = WALL_CLUSTERS.map(c => ({
  block: c.options[0], rgb: c.rgb,
}));

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
  // De-weight lightness by 50% — Google 3D Tiles have baked shadows that
  // darken building materials. Minecraft's own lighting handles shadows, so
  // we should prioritize matching the base material hue/chroma over lightness.
  const dl = (l1 - l2) * 0.5;
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

/**
 * Find the closest wall block to an observed RGB color (CIE-Lab perceptual match).
 * When seed is provided, picks randomly from the matched cluster's options
 * (arnis DEFINED_COLORS pattern) for visual variety between similar buildings.
 */
export function rgbToWallBlock(r: number, g: number, b: number, seed?: number): BlockState {
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
  const cluster = WALL_CLUSTERS[bestIdx];
  if (seed != null && cluster.options.length > 1) {
    // Low-frequency spatial hash — variations happen in ~4-block patches (like
    // weathered stucco) instead of per-voxel static noise. The old per-voxel hash
    // generated high-frequency noise that modeFilter3D then had to erase.
    const coarseSeed = Math.floor((seed / 1000000) / 4) * 1000000 +
                       Math.floor(((seed % 1000000) / 1000) / 4) * 1000 +
                       Math.floor((seed % 1000) / 4);
    const idx = ((coarseSeed * 2654435761) >>> 0) % cluster.options.length;
    return cluster.options[idx];
  }
  return cluster.options[0];
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

/**
 * Extract dominant color with hue exclusion ranges.
 * Skips pixels whose hue falls within any excluded range, enabling
 * extraction of building color even when vegetation dominates the image.
 *
 * @param excludeHueRanges  Array of [minHue, maxHue] pairs (0-360) to exclude
 */
export function dominantColorExcluding(
  pixels: Uint8Array | Buffer,
  startRow: number,
  endRow: number,
  width: number,
  colStart: number,
  colEnd: number,
  excludeHueRanges: [number, number][],
): { r: number; g: number; b: number } | null {
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

      // Standard rejections
      if (isGrass(h, s, l)) continue;
      if (isSkyOrWater(h, s, l)) continue;
      if (isShadow(l)) continue;
      if (isGlare(l)) continue;

      // Hue exclusion — skip pixels in excluded ranges (only if saturated)
      if (s > 0.10) {
        let excluded = false;
        for (const [minH, maxH] of excludeHueRanges) {
          if (h >= minH && h <= maxH) { excluded = true; break; }
        }
        if (excluded) continue;
      }

      totalValid++;

      const bucketIdx = s < 0.1 ? NUM_HUE_BINS : Math.floor(h / 30) % NUM_HUE_BINS;
      buckets[bucketIdx].rSum += r;
      buckets[bucketIdx].gSum += g;
      buckets[bucketIdx].bSum += b;
      buckets[bucketIdx].count++;
    }
  }

  if (totalValid < 30) return null;  // Lower threshold since we're filtering more

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
