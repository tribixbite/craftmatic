/**
 * Street View Image Analysis — 3-tier extraction pipeline.
 *
 * Tier 1: Zone-based color extraction (sharp, ~200ms, free)
 * Tier 2: Structural heuristics — story count, texture, roof pitch,
 *         symmetry, setback, fenestration (jimp/pure JS, ~400ms, free)
 * Tier 3: Claude Vision analysis (opt-in, ~$0.005/image)
 *
 * Requires: sharp (already a dep), jimp (pure JS, zero native deps).
 * Node/Bun-compatible — no browser APIs needed.
 */

import type { BlockState } from '../../types/index.js';
import type { FeatureFlags } from '../../types/index.js';
import {
  rgbToHsl, isGrass, isShadow, isGlare, isVegetationColor,
  rgbToWallBlock, rgbToRoofOverride, rgbToTrimBlock,
  dominantColor, dominantColorExcluding,
} from '../color-blocks.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Tier 1: Zone-based color extraction results */
export interface SvColorAnalysis {
  wallColor: { r: number; g: number; b: number };
  wallBlock: BlockState;
  roofColor: { r: number; g: number; b: number };
  roofOverride: { north: BlockState; south: BlockState; cap: BlockState };
  trimColor: { r: number; g: number; b: number };
  trimBlock: BlockState;
}

/** Tier 2 sub-analyses */
export interface StoryAnalysis {
  storyCount: number;
  floorBoundaries: number[];
  confidence: number;
}

export type TextureClass = 'brick' | 'stone' | 'wood_siding' | 'smooth' | 'shingle';

export interface TextureAnalysis {
  textureClass: TextureClass;
  entropy: number;
  suggestedBlock: BlockState;
  confidence: number;
}

export interface RoofPitchAnalysis {
  pitchDegrees: number;
  roofType: 'flat' | 'moderate' | 'steep';
  roofHeightOverride: number;
  confidence: number;
}

export interface SymmetryAnalysis {
  symmetryScore: number;
  isSymmetric: boolean;
  suggestedPlanShape: 'rectangle' | 'L' | 'T';
}

export interface SetbackAnalysis {
  lawnDepthRatio: number;
  hasVisibleDriveway: boolean;
  hasVisiblePath: boolean;
  suggestedFeatures: Partial<FeatureFlags>;
}

export interface FenestrationAnalysis {
  windowCount: number;
  windowWallRatio: number;
  suggestedSpacing: number;
  windowsPerFloor: number;
}

/** Tier 2: All structural heuristic results combined */
export interface SvStructuralAnalysis {
  stories: StoryAnalysis;
  texture: TextureAnalysis;
  roofPitch: RoofPitchAnalysis;
  symmetry: SymmetryAnalysis;
  setback: SetbackAnalysis;
  fenestration: FenestrationAnalysis;
}

/** Tier 3: Claude Vision analysis results */
export interface SvVisionAnalysis {
  doorStyle: string | null;
  doorPosition: 'center' | 'left' | 'right' | null;
  features: Partial<FeatureFlags>;
  architectureLabel: string | null;
  /** Constrained architectural style from VLM taxonomy */
  architectureStyle: string | null;
  /** Exterior wall material description */
  wallMaterial: string | null;
  /** Roof material description */
  roofMaterial: string | null;
  /** Human-readable wall color description (e.g. "white stucco", "red brick") */
  wallColorDescription: string | null;
  /** Human-readable roof color description (e.g. "dark gray shingle") */
  roofColorDescription: string | null;
  /** Roof shape from visual classification */
  roofShape: 'gable' | 'hip' | 'flat' | 'gambrel' | 'mansard' | 'shed' | null;
  hasGarage: boolean;
  hasShutters: boolean;
  exteriorDetail: string | null;
  confidence: number;
}

/** Combined result from all tiers */
export interface StreetViewAnalysis {
  colors: SvColorAnalysis | null;
  structure: SvStructuralAnalysis | null;
  vision: SvVisionAnalysis | null;
  imageUrl: string;
  isIndoor: boolean;
}

// ─── Image Download ──────────────────────────────────────────────────────────

/** Download an image URL and return raw RGBA pixel buffer + dimensions */
async function downloadImage(url: string): Promise<{
  pixels: Uint8Array;
  width: number;
  height: number;
} | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;

    const buffer = await resp.arrayBuffer();
    // Use sharp to decode to raw RGBA pixels
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(Buffer.from(buffer))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return {
      pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    };
  } catch (err) {
    console.warn('SV Analysis: image download/decode failed:', (err as Error).message);
    return null;
  }
}

// ─── Pre-check: Indoor Panorama Detection ────────────────────────────────────

/**
 * Check if the image appears to be an indoor panorama using multi-factor
 * scoring: sky presence (top zone), foliage/tree canopy (top zone), and
 * road/pavement evidence (bottom zone). A single sky-pixel check produces
 * false positives when trees obscure the sky on outdoor images.
 */
/** @internal Exported for unit testing */
export function isIndoorPanorama(pixels: Uint8Array, w: number, h: number): boolean {
  // ── Top zone: sky + foliage detection ──────────────────────────────
  const topBound = Math.floor(h * 0.15); // top 15%
  let topTotal = 0;
  let skyPixels = 0;
  let foliagePixels = 0;

  for (let y = 0; y < topBound; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const [hue, sat, lum] = rgbToHsl(r, g, b);
      topTotal++;

      // Sky: blue hue, moderate saturation, not too dark
      if (hue >= 180 && hue <= 250 && sat > 0.15 && lum > 0.3) {
        skyPixels++;
      }
      // Also count very bright unsaturated pixels as "sky" (overcast/hazy)
      else if (lum > 0.75 && sat < 0.15) {
        skyPixels++;
      }
      // Foliage: green hue with decent saturation (tree canopy, not ceiling)
      if (hue >= 60 && hue <= 170 && sat > 0.15 && lum > 0.1 && lum < 0.8) {
        foliagePixels++;
      }
    }
  }

  if (topTotal === 0) return false;
  const skyRatio = skyPixels / topTotal;
  const foliageRatio = foliagePixels / topTotal;

  // Sufficient sky → clearly outdoor
  if (skyRatio >= 0.05) return false;

  // Low sky but significant foliage → trees obscuring sky, still outdoor
  if (foliageRatio > 0.15) return false;

  // ── Bottom zone: road/pavement detection (strong outdoor signal) ───
  const bottomStart = Math.floor(h * 0.85); // bottom 15%
  let bottomTotal = 0;
  let roadPixels = 0;

  for (let y = bottomStart; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const [, sat, lum] = rgbToHsl(r, g, b);
      bottomTotal++;
      // Road/pavement: desaturated gray, moderate brightness
      if (sat < 0.2 && lum > 0.15 && lum < 0.65) {
        roadPixels++;
      }
    }
  }

  const roadRatio = bottomTotal > 0 ? roadPixels / bottomTotal : 0;
  // Road/pavement visible in bottom → outdoor (roads don't exist indoors)
  if (roadRatio > 0.3) return false;

  // No sky, no foliage, no road → likely indoor
  return true;
}

// ─── Tier 1: Zone-based Color Extraction ─────────────────────────────────────

/** @internal Exported for unit testing */
export function extractColors(
  pixels: Uint8Array, w: number, h: number,
): SvColorAnalysis | null {
  // Zone definitions for 640×480 (or proportional)
  const roofStartY = 0;
  const roofEndY = Math.floor(h * 0.25);                // top 25%
  const wallStartY = Math.floor(h * 0.25);
  const wallEndY = Math.floor(h * 0.65);                // middle 40%
  const wallStartX = Math.floor(w * 0.15);              // center 70%
  const wallEndX = Math.floor(w * 0.85);
  const trimStartX = Math.floor(w * 0.03);              // edge strips
  const trimEndXLeft = Math.floor(w * 0.15);
  const trimStartXRight = Math.floor(w * 0.85);
  const trimEndXRight = Math.floor(w * 0.97);

  // Roof zone — full width, top 25%
  const roofColor = dominantColor(pixels, roofStartY, roofEndY, w);

  // Wall zone — center portion, middle 40%
  let wallColor = dominantColor(pixels, wallStartY, wallEndY, w, wallStartX, wallEndX);

  // Trim zone — left + right edge strips of the wall region
  // Combine both edge strips by sampling left then right
  const trimColorLeft = dominantColor(pixels, wallStartY, wallEndY, w, trimStartX, trimEndXLeft);
  const trimColorRight = dominantColor(pixels, wallStartY, wallEndY, w, trimStartXRight, trimEndXRight);

  // Use whichever trim zone had more signal, fall back to the other
  const trimColor = trimColorLeft ?? trimColorRight;

  if (!wallColor) return null; // Can't determine anything without wall color

  // Reject if dominant wall color is vegetation — building is likely occluded by trees.
  // Try secondary extraction excluding green hues before falling back to null.
  if (isVegetationColor(wallColor.r, wallColor.g, wallColor.b)) {
    const VEGETATION_HUE: [number, number][] = [[60, 170]];
    const secondary = dominantColorExcluding(
      pixels, wallStartY, wallEndY, w, wallStartX, wallEndX, VEGETATION_HUE,
    );
    if (secondary && !isVegetationColor(secondary.r, secondary.g, secondary.b)) {
      console.warn('SV color analysis: vegetation bypass — using secondary non-green color');
      // Replace wallColor with secondary extraction for downstream mapping
      wallColor = secondary;
    } else {
      console.warn('SV color analysis: wall zone dominated by vegetation — skipping color override');
      return null;
    }
  }

  // Map to Minecraft blocks
  const wallBlock = rgbToWallBlock(wallColor.r, wallColor.g, wallColor.b);
  const roofOverride = roofColor
    ? rgbToRoofOverride(roofColor.r, roofColor.g, roofColor.b)
    : rgbToRoofOverride(100, 100, 100); // default gray roof
  const trimBlock = trimColor
    ? rgbToTrimBlock(trimColor.r, trimColor.g, trimColor.b)
    : rgbToTrimBlock(200, 200, 200); // default light trim

  return {
    wallColor,
    wallBlock,
    roofColor: roofColor ?? { r: 100, g: 100, b: 100 },
    roofOverride,
    trimColor: trimColor ?? { r: 200, g: 200, b: 200 },
    trimBlock,
  };
}

// ─── Tier 2: Structural Heuristics ───────────────────────────────────────────

// --- 2a. Story count via horizontal projection ---

/**
 * Convert pixels to grayscale and compute Sobel edge magnitude.
 * Returns a Float32Array of per-pixel edge magnitudes for a given zone.
 */
/** @internal Exported for unit testing */
export function sobelEdges(
  pixels: Uint8Array, w: number,
  startY: number, endY: number, startX: number, endX: number,
): { magnitudes: Float32Array; zoneW: number; zoneH: number } {
  const zoneW = endX - startX;
  const zoneH = endY - startY;
  // Grayscale luminance
  const gray = new Float32Array(zoneW * zoneH);
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * w + x) * 4;
      // Rec. 601 luma
      gray[(y - startY) * zoneW + (x - startX)] =
        0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
    }
  }

  // Sobel 3×3 kernel
  const magnitudes = new Float32Array(zoneW * zoneH);
  for (let y = 1; y < zoneH - 1; y++) {
    for (let x = 1; x < zoneW - 1; x++) {
      const tl = gray[(y - 1) * zoneW + (x - 1)];
      const tc = gray[(y - 1) * zoneW + x];
      const tr = gray[(y - 1) * zoneW + (x + 1)];
      const ml = gray[y * zoneW + (x - 1)];
      const mr = gray[y * zoneW + (x + 1)];
      const bl = gray[(y + 1) * zoneW + (x - 1)];
      const bc = gray[(y + 1) * zoneW + x];
      const br = gray[(y + 1) * zoneW + (x + 1)];

      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      magnitudes[y * zoneW + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return { magnitudes, zoneW, zoneH };
}

/** @internal Exported for unit testing */
export function detectStories(
  pixels: Uint8Array, w: number, h: number,
): StoryAnalysis {
  // Analyze wall zone: middle 60% vertically, center 70% horizontally
  const startY = Math.floor(h * 0.10);
  const endY = Math.floor(h * 0.70);
  const startX = Math.floor(w * 0.15);
  const endX = Math.floor(w * 0.85);

  const { magnitudes, zoneW, zoneH } = sobelEdges(pixels, w, startY, endY, startX, endX);

  // Horizontal projection: sum edge intensity per row
  const rowSums = new Float32Array(zoneH);
  for (let y = 0; y < zoneH; y++) {
    let sum = 0;
    for (let x = 0; x < zoneW; x++) {
      sum += magnitudes[y * zoneW + x];
    }
    rowSums[y] = sum / zoneW; // normalize by width
  }

  // Smooth with 5px moving average
  const smoothed = new Float32Array(zoneH);
  for (let y = 2; y < zoneH - 2; y++) {
    smoothed[y] = (rowSums[y - 2] + rowSums[y - 1] + rowSums[y] + rowSums[y + 1] + rowSums[y + 2]) / 5;
  }

  // Find peaks and valleys via threshold
  const mean = smoothed.reduce((a, b) => a + b, 0) / zoneH;
  const threshold = mean * 1.3; // peaks are 30% above average

  // Group consecutive above-threshold rows into peak clusters
  const peaks: number[] = [];
  let inPeak = false;
  let peakStart = 0;
  for (let y = 0; y < zoneH; y++) {
    if (smoothed[y] > threshold && !inPeak) {
      inPeak = true;
      peakStart = y;
    } else if ((smoothed[y] <= threshold || y === zoneH - 1) && inPeak) {
      inPeak = false;
      peaks.push(Math.floor((peakStart + y) / 2));
    }
  }

  // Find valleys (floor boundaries) between peaks
  const boundaries: number[] = [];
  for (let i = 0; i < peaks.length - 1; i++) {
    let minVal = Infinity;
    let minY = 0;
    for (let y = peaks[i]; y <= peaks[i + 1]; y++) {
      if (smoothed[y] < minVal) {
        minVal = smoothed[y];
        minY = y;
      }
    }
    boundaries.push(startY + minY);
  }

  // Story count = number of distinct peak clusters, clamped 1-5
  const storyCount = Math.max(1, Math.min(5, peaks.length > 0 ? peaks.length : 1));

  // Confidence based on peak/valley clarity
  const peakVals = peaks.map(p => smoothed[p]);
  const avgPeak = peakVals.length > 0 ? peakVals.reduce((a, b) => a + b, 0) / peakVals.length : 0;
  const confidence = Math.min(1, peaks.length > 1
    ? Math.min(1, (avgPeak - mean) / (mean + 1) * 0.5)
    : 0.3);

  return { storyCount, floorBoundaries: boundaries, confidence };
}

// --- 2b. Wall texture classification via visual entropy ---

/** @internal Exported for unit testing */
export function classifyTexture(
  pixels: Uint8Array, w: number, h: number,
): TextureAnalysis {
  const startY = Math.floor(h * 0.25);
  const endY = Math.floor(h * 0.65);
  const startX = Math.floor(w * 0.25);
  const endX = Math.floor(w * 0.75);

  const { magnitudes, zoneW, zoneH } = sobelEdges(pixels, w, startY, endY, startX, endX);

  // Compute variance of edge magnitudes (visual entropy)
  const n = zoneW * zoneH;
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += magnitudes[i];
    sumSq += magnitudes[i] * magnitudes[i];
  }
  const mean = sum / n;
  const variance = (sumSq / n) - (mean * mean);

  // Classify by entropy thresholds
  let textureClass: TextureClass;
  let suggestedBlock: BlockState;
  let confidence: number;

  if (variance > 800) {
    // High texture: brick, stone, or shingle
    // Check hue to distinguish brick (warm) from stone (cool)
    const wallColor = dominantColor(pixels, startY, endY, w, startX, endX);
    if (wallColor) {
      const [hue, sat] = rgbToHsl(wallColor.r, wallColor.g, wallColor.b);
      if (hue >= 0 && hue <= 40 && sat > 0.15) {
        textureClass = 'brick';
        suggestedBlock = 'minecraft:bricks';
      } else if (sat < 0.12) {
        textureClass = 'stone';
        suggestedBlock = 'minecraft:stone_bricks';
      } else {
        textureClass = 'shingle';
        suggestedBlock = 'minecraft:spruce_planks';
      }
    } else {
      textureClass = 'brick';
      suggestedBlock = 'minecraft:bricks';
    }
    confidence = Math.min(1, variance / 1500);
  } else if (variance > 300) {
    textureClass = 'wood_siding';
    suggestedBlock = 'minecraft:oak_planks';
    confidence = Math.min(1, (variance - 300) / 500 * 0.5 + 0.4);
  } else {
    textureClass = 'smooth';
    suggestedBlock = 'minecraft:smooth_quartz';
    confidence = Math.min(1, (300 - variance) / 300 * 0.5 + 0.4);
  }

  return { textureClass, entropy: variance, suggestedBlock, confidence };
}

// --- 2c. Roof pitch estimation ---

/** @internal Exported for unit testing */
export function estimateRoofPitch(
  pixels: Uint8Array, w: number, h: number,
): RoofPitchAnalysis {
  // Analyze top 30% for diagonal edges
  const startY = 0;
  const endY = Math.floor(h * 0.30);
  const startX = Math.floor(w * 0.10);
  const endX = Math.floor(w * 0.90);

  const { magnitudes, zoneW, zoneH } = sobelEdges(pixels, w, startY, endY, startX, endX);

  // Threshold strong edges (top 20% of magnitudes)
  let maxMag = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    if (magnitudes[i] > maxMag) maxMag = magnitudes[i];
  }
  const edgeThreshold = maxMag * 0.3;

  // Simplified Hough-like voting for diagonal angles
  // Check angles: 15°, 22.5°, 30°, 37.5°, 45°, 52.5°, 60°, 75°
  const angleBins = [15, 22.5, 30, 37.5, 45, 52.5, 60, 75];
  const votes = new Float32Array(angleBins.length);
  const WALK_LEN = 15; // pixels to walk along each direction

  for (let y = 2; y < zoneH - 2; y++) {
    for (let x = 2; x < zoneW - 2; x++) {
      if (magnitudes[y * zoneW + x] < edgeThreshold) continue;

      // For each angle, walk along the direction and count edge pixels
      for (let ai = 0; ai < angleBins.length; ai++) {
        const rad = angleBins[ai] * Math.PI / 180;
        const dx = Math.cos(rad);
        const dy = -Math.sin(rad); // negative because y increases downward
        let count = 0;
        for (let step = 1; step <= WALK_LEN; step++) {
          const nx = Math.round(x + dx * step);
          const ny = Math.round(y + dy * step);
          if (nx < 0 || nx >= zoneW || ny < 0 || ny >= zoneH) break;
          if (magnitudes[ny * zoneW + nx] >= edgeThreshold) count++;
        }
        votes[ai] += count;
      }
    }
  }

  // Find strongest diagonal angle
  let bestAngle = 0;
  let bestVotes = 0;
  // Also track horizontal/vertical votes for comparison
  let horizontalVotes = 0;

  for (let ai = 0; ai < angleBins.length; ai++) {
    if (votes[ai] > bestVotes) {
      bestVotes = votes[ai];
      bestAngle = angleBins[ai];
    }
  }

  // Count roughly horizontal edges (0° and 90°) for flat roof detection
  // Re-scan for horizontal edges specifically
  for (let y = 2; y < zoneH - 2; y++) {
    for (let x = 2; x < zoneW - WALK_LEN; x++) {
      if (magnitudes[y * zoneW + x] < edgeThreshold) continue;
      let hCount = 0;
      for (let step = 1; step <= WALK_LEN; step++) {
        if (magnitudes[y * zoneW + x + step] >= edgeThreshold) hCount++;
      }
      horizontalVotes += hCount;
    }
  }

  // Determine roof type
  let roofType: 'flat' | 'moderate' | 'steep';
  let roofHeightOverride: number;
  let pitchDegrees: number;

  // If horizontal edges dominate diagonal ones → flat roof
  if (horizontalVotes > bestVotes * 2) {
    roofType = 'flat';
    roofHeightOverride = 0.3;
    pitchDegrees = 5;
  } else if (bestAngle <= 30) {
    roofType = 'moderate';
    roofHeightOverride = 0.5;
    pitchDegrees = bestAngle;
  } else {
    roofType = 'steep';
    roofHeightOverride = 0.8;
    pitchDegrees = bestAngle;
  }

  const totalVotes = votes.reduce((a, b) => a + b, 0) + horizontalVotes;
  const confidence = totalVotes > 0 ? Math.min(1, bestVotes / (totalVotes * 0.3)) * 0.7 : 0.2;

  return { pitchDegrees, roofType, roofHeightOverride, confidence };
}

// --- 2d. Facade symmetry analysis ---

/** @internal Exported for unit testing */
export function analyzeSymmetry(
  pixels: Uint8Array, w: number, h: number,
): SymmetryAnalysis {
  const startY = Math.floor(h * 0.20);
  const endY = Math.floor(h * 0.70);
  const startX = Math.floor(w * 0.10);
  const endX = Math.floor(w * 0.90);

  const { magnitudes, zoneW, zoneH } = sobelEdges(pixels, w, startY, endY, startX, endX);

  // Compare left/right halves: per-row edge density correlation
  const halfW = Math.floor(zoneW / 2);
  let sumLR = 0, sumLL = 0, sumRR = 0;
  let meanL = 0, meanR = 0;

  // Compute per-row edge sums for left and right halves
  const leftRowSums = new Float32Array(zoneH);
  const rightRowSums = new Float32Array(zoneH);

  for (let y = 0; y < zoneH; y++) {
    let lSum = 0, rSum = 0;
    for (let x = 0; x < halfW; x++) {
      lSum += magnitudes[y * zoneW + x];
      rSum += magnitudes[y * zoneW + (zoneW - 1 - x)]; // mirror from right
    }
    leftRowSums[y] = lSum / halfW;
    rightRowSums[y] = rSum / halfW;
    meanL += leftRowSums[y];
    meanR += rightRowSums[y];
  }

  meanL /= zoneH;
  meanR /= zoneH;

  // Pearson correlation coefficient
  for (let y = 0; y < zoneH; y++) {
    const dl = leftRowSums[y] - meanL;
    const dr = rightRowSums[y] - meanR;
    sumLR += dl * dr;
    sumLL += dl * dl;
    sumRR += dr * dr;
  }

  const denom = Math.sqrt(sumLL * sumRR);
  const symmetryScore = denom > 0 ? Math.max(0, sumLR / denom) : 0;

  const isSymmetric = symmetryScore > 0.6;
  let suggestedPlanShape: 'rectangle' | 'L' | 'T';
  if (symmetryScore > 0.7) {
    suggestedPlanShape = 'rectangle';
  } else if (symmetryScore > 0.4) {
    suggestedPlanShape = 'T';
  } else {
    suggestedPlanShape = 'L';
  }

  return { symmetryScore, isSymmetric, suggestedPlanShape };
}

// --- 2e. Setback / lawn depth estimation ---

/** @internal Exported for unit testing */
export function analyzeSetback(
  pixels: Uint8Array, w: number, h: number,
): SetbackAnalysis {
  // Bottom 25% of image
  const startY = Math.floor(h * 0.75);
  const endY = h;
  const totalPixels = (endY - startY) * w;

  let greenCount = 0;
  let grayCount = 0;
  let brownCount = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const [hue, sat, lum] = rgbToHsl(r, g, b);

      if (isGrass(hue, sat, lum)) {
        greenCount++;
      } else if (sat < 0.12 && lum > 0.2 && lum < 0.7) {
        // Desaturated mid-tones → concrete/asphalt
        grayCount++;
      } else if (hue >= 20 && hue <= 50 && sat > 0.1 && lum > 0.1 && lum < 0.5) {
        // Brown tones → dirt path
        brownCount++;
      }
    }
  }

  const lawnDepthRatio = greenCount / totalPixels;
  const grayRatio = grayCount / totalPixels;
  const brownRatio = brownCount / totalPixels;

  const hasVisibleDriveway = grayRatio > 0.25;
  const hasVisiblePath = (grayRatio > 0.10 && grayRatio <= 0.25) || brownRatio > 0.15;

  // Suggest features based on bottom-zone analysis
  const suggestedFeatures: Partial<FeatureFlags> = {};
  if (lawnDepthRatio > 0.40) {
    suggestedFeatures.garden = true;
    suggestedFeatures.trees = true;
  }
  if (lawnDepthRatio > 0.15) {
    suggestedFeatures.fence = true;
  }
  if (hasVisibleDriveway) {
    suggestedFeatures.driveway = true;
  }

  return { lawnDepthRatio, hasVisibleDriveway, hasVisiblePath, suggestedFeatures };
}

// --- 2f. Fenestration density ---

/** @internal Exported for unit testing */
export function analyzeFenestration(
  pixels: Uint8Array, w: number, h: number,
  storyCount: number,
): FenestrationAnalysis {
  // Wall zone: middle portion
  const startY = Math.floor(h * 0.20);
  const endY = Math.floor(h * 0.70);
  const startX = Math.floor(w * 0.10);
  const endX = Math.floor(w * 0.90);
  const zoneW = endX - startX;
  const zoneH = endY - startY;
  const zoneArea = zoneW * zoneH;

  // Detect dark rectangular patches (windows appear dark relative to wall)
  // First compute average wall brightness to set adaptive threshold
  let wallBrightSum = 0;
  let wallPixelCount = 0;
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * w + x) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const [, , lum] = rgbToHsl(r, g, b);
      if (!isShadow(lum) && !isGlare(lum)) {
        wallBrightSum += lum;
        wallPixelCount++;
      }
    }
  }
  const wallAvgBright = wallPixelCount > 0 ? wallBrightSum / wallPixelCount : 0.5;

  // Dark threshold: pixels significantly darker than wall average
  const darkThreshold = wallAvgBright * 0.55;

  // Create binary dark mask
  const mask = new Uint8Array(zoneW * zoneH);
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * w + x) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const [, , lum] = rgbToHsl(r, g, b);
      if (lum < darkThreshold && lum > 0.02) { // dark but not pure black (shadows)
        mask[(y - startY) * zoneW + (x - startX)] = 1;
      }
    }
  }

  // Simple connected-component labeling (4-connected)
  const labels = new Int32Array(zoneW * zoneH);
  let nextLabel = 1;
  const componentSizes: Map<number, { minX: number; maxX: number; minY: number; maxY: number; count: number }> = new Map();

  for (let y = 0; y < zoneH; y++) {
    for (let x = 0; x < zoneW; x++) {
      if (mask[y * zoneW + x] === 0) continue;
      if (labels[y * zoneW + x] > 0) continue;

      // BFS flood fill
      const label = nextLabel++;
      const queue: [number, number][] = [[x, y]];
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;

      while (queue.length > 0) {
        const [cx, cy] = queue.pop()!;
        if (cx < 0 || cx >= zoneW || cy < 0 || cy >= zoneH) continue;
        if (mask[cy * zoneW + cx] === 0) continue;
        if (labels[cy * zoneW + cx] > 0) continue;

        labels[cy * zoneW + cx] = label;
        count++;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        queue.push([cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]);
      }

      componentSizes.set(label, { minX, maxX, minY, maxY, count });
    }
  }

  // Filter components: window-like aspect ratio (0.3-3.0 H:W) and min size
  const minSize = Math.max(20, zoneArea * 0.001); // at least 0.1% of zone
  let windowCount = 0;
  let totalWindowArea = 0;

  for (const [, comp] of componentSizes) {
    const cw = comp.maxX - comp.minX + 1;
    const ch = comp.maxY - comp.minY + 1;
    const area = cw * ch;
    const ratio = ch / Math.max(1, cw);

    if (comp.count >= minSize && area >= minSize && ratio >= 0.3 && ratio <= 3.0) {
      windowCount++;
      totalWindowArea += area;
    }
  }

  const windowWallRatio = zoneArea > 0 ? totalWindowArea / zoneArea : 0;
  const windowsPerFloor = storyCount > 0 ? Math.round(windowCount / storyCount) : windowCount;

  // Map to window spacing
  let suggestedSpacing: number;
  if (windowWallRatio > 0.25 || windowsPerFloor >= 5) {
    suggestedSpacing = 2;
  } else if (windowWallRatio > 0.08 || windowsPerFloor >= 3) {
    suggestedSpacing = 3;
  } else {
    suggestedSpacing = 5;
  }

  return { windowCount, windowWallRatio, suggestedSpacing, windowsPerFloor };
}

/** Run all Tier 2 structural heuristics on the pixel buffer */
/** @internal Exported for unit testing */
export function analyzeStructure(
  pixels: Uint8Array, w: number, h: number,
): SvStructuralAnalysis {
  const stories = detectStories(pixels, w, h);
  const texture = classifyTexture(pixels, w, h);
  const roofPitch = estimateRoofPitch(pixels, w, h);
  const symmetry = analyzeSymmetry(pixels, w, h);
  const setback = analyzeSetback(pixels, w, h);
  const fenestration = analyzeFenestration(pixels, w, h, stories.storyCount);

  return { stories, texture, roofPitch, symmetry, setback, fenestration };
}

// ─── Tier 3: Claude Vision Analysis (opt-in) ─────────────────────────────────

/** Check if Anthropic API key is available */
/** Check if any supported vision API key is available (Anthropic or OpenRouter) */
export function hasVisionApiKey(): boolean {
  return (typeof process !== 'undefined'
    && !!(process.env?.ANTHROPIC_API_KEY || process.env?.OPENROUTER_API_KEY));
}

/** Determine which vision provider to use based on available API keys */
function getVisionProvider(): { provider: 'anthropic' | 'openrouter'; apiKey: string } | null {
  if (typeof process === 'undefined') return null;
  // Prefer Anthropic direct (lower latency), fall back to OpenRouter
  if (process.env?.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env?.OPENROUTER_API_KEY) {
    return { provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY };
  }
  return null;
}

async function analyzeWithVision(imageUrl: string): Promise<SvVisionAnalysis | null> {
  const vp = getVisionProvider();
  if (!vp) return null;

  try {
    // Download the image for base64 encoding
    const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    const imageBuffer = await resp.arrayBuffer();
    const base64 = Buffer.from(imageBuffer).toString('base64');

    const prompt = `Analyze this Street View image of a residential building. Return ONLY valid JSON (no markdown, no explanation) with these fields:
{
  "doorStyle": "oak"|"dark_oak"|"spruce"|"birch"|"iron"|"acacia"|null,
  "doorPosition": "center"|"left"|"right"|null,
  "chimney": true|false,
  "porch": true|false,
  "garage": true|false,
  "fence": true|false,
  "shutters": true|false,
  "garden": true|false,
  "trees": true|false,
  "pool": false,
  "architectureStyle": "Colonial"|"Victorian"|"Craftsman"|"Mediterranean"|"Ranch"|"Tudor"|"Gothic"|"Modern"|"Desert"|"Farmhouse"|"Cape Cod"|"Art Deco"|"Prairie"|"Brownstone"|null,
  "wallMaterial": "brick"|"wood_siding"|"stone"|"stucco"|"concrete"|"vinyl"|"shingle"|"clapboard"|"log"|null,
  "roofMaterial": "asphalt_shingle"|"metal"|"clay_tile"|"slate"|"wood_shake"|"flat_membrane"|null,
  "roofShape": "gable"|"hip"|"flat"|"gambrel"|"mansard"|"shed"|null,
  "wallColorDescription": "brief color description e.g. 'white stucco', 'red brick'"|null,
  "roofColorDescription": "brief color description e.g. 'dark gray', 'terra cotta'"|null,
  "architectureLabel": "freeform style description or null",
  "exteriorDetail": "1-sentence description",
  "confidence": 0.0-1.0
}`;

    let responseText: string | null = null;

    if (vp.provider === 'anthropic') {
      // Anthropic Messages API (native)
      const visionResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': vp.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!visionResp.ok) {
        console.warn('SV Vision [Anthropic]: API error', visionResp.status, await visionResp.text());
        return null;
      }
      const result = await visionResp.json() as { content: { type: string; text: string }[] };
      responseText = result.content?.find(c => c.type === 'text')?.text ?? null;
    } else {
      // OpenRouter — OpenAI-compatible chat completions API
      const visionResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${vp.apiKey}`,
          'HTTP-Referer': 'https://github.com/tribixbite/craftmatic',
          'X-Title': 'Craftmatic',
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-5',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!visionResp.ok) {
        console.warn('SV Vision [OpenRouter]: API error', visionResp.status, await visionResp.text());
        return null;
      }
      const result = await visionResp.json() as {
        choices: { message: { content: string } }[];
      };
      responseText = result.choices?.[0]?.message?.content ?? null;
    }

    if (!responseText) return null;

    // Parse JSON from response — strip markdown fences if present
    let jsonStr = responseText.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const data = JSON.parse(jsonStr) as Record<string, unknown>;

    return {
      doorStyle: typeof data.doorStyle === 'string' ? data.doorStyle : null,
      doorPosition: (['center', 'left', 'right'] as const).includes(data.doorPosition as 'center')
        ? data.doorPosition as 'center' | 'left' | 'right'
        : null,
      features: {
        chimney: !!data.chimney,
        porch: !!data.porch,
        fence: !!data.fence,
        garden: !!data.garden,
        trees: !!data.trees,
        pool: !!data.pool,
      },
      architectureLabel: typeof data.architectureLabel === 'string' ? data.architectureLabel : null,
      architectureStyle: typeof data.architectureStyle === 'string' ? data.architectureStyle : null,
      wallMaterial: typeof data.wallMaterial === 'string' ? data.wallMaterial : null,
      roofMaterial: typeof data.roofMaterial === 'string' ? data.roofMaterial : null,
      roofShape: (typeof data.roofShape === 'string'
        && ['gable', 'hip', 'flat', 'gambrel', 'mansard', 'shed'].includes(data.roofShape)
        ? data.roofShape : null) as SvVisionAnalysis['roofShape'],
      wallColorDescription: typeof data.wallColorDescription === 'string' ? data.wallColorDescription : null,
      roofColorDescription: typeof data.roofColorDescription === 'string' ? data.roofColorDescription : null,
      hasGarage: !!data.garage,
      hasShutters: !!data.shutters,
      exteriorDetail: typeof data.exteriorDetail === 'string' ? data.exteriorDetail : null,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
    };
  } catch (err) {
    console.warn('SV Vision: analysis failed:', (err as Error).message);
    return null;
  }
}

// ─── Combined Entrypoint ─────────────────────────────────────────────────────

/**
 * Analyze a Street View image URL through all available tiers.
 * Tier 1 (colors) + Tier 2 (structure) always run.
 * Tier 3 (vision) only runs if a vision API key is set (ANTHROPIC_API_KEY or
 * OPENROUTER_API_KEY) and skipVision is false.
 *
 * @param imageUrl  Google Street View image URL (640×480)
 * @param skipVision  Force-skip Tier 3 even if API key is available
 */
export async function analyzeStreetView(
  imageUrl: string,
  skipVision = false,
): Promise<StreetViewAnalysis> {
  // Download and decode image
  const image = await downloadImage(imageUrl);
  if (!image) {
    return { colors: null, structure: null, vision: null, imageUrl, isIndoor: false };
  }

  const { pixels, width, height } = image;

  // Pre-check: is this an indoor panorama?
  const indoor = isIndoorPanorama(pixels, width, height);
  if (indoor) {
    console.warn('SV Analysis: image appears to be indoor panorama, skipping');
    return { colors: null, structure: null, vision: null, imageUrl, isIndoor: true };
  }

  // Tier 1 + Tier 2 run on the same pixel buffer (synchronous, fast)
  const colors = extractColors(pixels, width, height);
  const structure = analyzeStructure(pixels, width, height);

  // Tier 3 runs in parallel with local analysis if API key is available
  let vision: SvVisionAnalysis | null = null;
  if (!skipVision && hasVisionApiKey()) {
    vision = await analyzeWithVision(imageUrl);
  }

  return { colors, structure, vision, imageUrl, isIndoor: false };
}
