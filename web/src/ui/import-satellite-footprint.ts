/**
 * Satellite footprint extraction — detect building footprint shape and
 * dimensions from the satellite tile composite using image processing.
 *
 * Approach:
 * 1. Sample pixels near building center to identify dominant roof color
 * 2. Threshold full image to create binary mask (roof-like vs background)
 * 3. Connected-component flood fill from center to isolate building
 * 4. Morphological cleanup (erode+dilate) to remove noise
 * 5. Compute oriented bounding box → width, length, rotation
 * 6. Classify shape by fill ratio + concavity analysis → rect/L/T/U
 *
 * At zoom 18, each pixel ≈ 0.6m at equator (varies with latitude).
 */

import type { FloorPlanShape } from '@craft/types/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FootprintResult {
  /** Detected floor plan shape */
  shape: FloorPlanShape;
  /** Building width in meters (shorter axis) */
  widthMeters: number;
  /** Building length in meters (longer axis) */
  lengthMeters: number;
  /** Rotation angle of longest axis in degrees (0 = north-south) */
  rotationDeg: number;
  /** Confidence score 0-1 (based on fill ratio, pixel count, etc.) */
  confidence: number;
  /** Binary mask of detected building footprint (for debug overlay) */
  mask: Uint8Array;
  /** Mask dimensions */
  maskWidth: number;
  maskHeight: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Meters per pixel at zoom 18 at the equator (Web Mercator) */
const BASE_MPP_Z18 = 0.5972;

/** Minimum building pixel count to consider valid (≈ 20 sqm at mid-latitudes) */
const MIN_BUILDING_PIXELS = 50;

/** Maximum building pixel count — reject if too large (probably terrain) */
const MAX_BUILDING_PIXELS = 40000;

/** Color distance threshold for roof-like pixels (squared RGB distance) */
const COLOR_THRESHOLD_SQ = 3000;

/** Analysis region radius from center (pixels) */
const ANALYSIS_RADIUS = 120;

/** Roof sample radius for initial color detection (pixels) */
const ROOF_SAMPLE_RADIUS = 30;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Meters per pixel at a given latitude for zoom 18 */
function metersPerPixel(lat: number): number {
  return BASE_MPP_Z18 * Math.cos((lat * Math.PI) / 180);
}

/** RGB to HSL (H in degrees 0-360, S/L in 0-1) */
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

/** Returns true if pixel is likely vegetation (green hue band) */
function isVegetation(h: number, s: number, l: number): boolean {
  return h >= 70 && h <= 170 && s > 0.12 && l > 0.08 && l < 0.75;
}

/** Returns true if pixel is likely road/pavement (desaturated, mid-lightness gray) */
function isPavement(s: number, l: number): boolean {
  return s < 0.08 && l > 0.2 && l < 0.55;
}

/** Squared RGB distance between two colors */
function colorDistSq(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

// ─── Core Algorithm ─────────────────────────────────────────────────────────

/**
 * Extract building footprint from satellite canvas.
 *
 * @param canvas   768x768 satellite composite canvas
 * @param centerX  Building center X on canvas (crosshair position)
 * @param centerY  Building center Y on canvas (crosshair position)
 * @param lat      Property latitude (for meter scale calculation)
 * @returns Footprint result with shape, dimensions, and confidence, or null
 */
export function extractFootprint(
  canvas: HTMLCanvasElement,
  centerX: number,
  centerY: number,
  lat: number,
): FootprintResult | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const mpp = metersPerPixel(lat);

  // Define analysis region (square around center, clamped to canvas)
  const r = ANALYSIS_RADIUS;
  const x0 = Math.max(0, Math.floor(centerX - r));
  const y0 = Math.max(0, Math.floor(centerY - r));
  const x1 = Math.min(canvas.width, Math.ceil(centerX + r));
  const y1 = Math.min(canvas.height, Math.ceil(centerY + r));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const imageData = ctx.getImageData(x0, y0, w, h);
  const data = imageData.data;

  // ── Step 1: Sample roof color from small region around center ─────────
  const roofColor = sampleRoofColor(data, w, h, centerX - x0, centerY - y0);
  if (!roofColor) return null;

  // ── Step 2: Create binary mask — pixels similar to roof color ─────────
  const rawMask = new Uint8Array(w * h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const idx = (py * w + px) * 4;
      const rr = data[idx], gg = data[idx + 1], bb = data[idx + 2];

      // Filter out obvious non-building pixels first
      const [hh, ss, ll] = rgbToHsl(rr, gg, bb);
      if (isVegetation(hh, ss, ll)) continue;
      if (isPavement(ss, ll)) continue;
      if (ll < 0.08 || ll > 0.95) continue; // shadows / glare

      // Check color similarity to detected roof
      const dist = colorDistSq(rr, gg, bb, roofColor.r, roofColor.g, roofColor.b);
      if (dist <= COLOR_THRESHOLD_SQ) {
        rawMask[py * w + px] = 1;
      }
    }
  }

  // ── Step 3: Flood fill from center to isolate building ────────────────
  const cx = Math.round(centerX - x0);
  const cy = Math.round(centerY - y0);
  const buildingMask = floodFillFrom(rawMask, w, h, cx, cy);

  // Count building pixels
  let pixelCount = 0;
  for (let i = 0; i < buildingMask.length; i++) {
    if (buildingMask[i]) pixelCount++;
  }

  if (pixelCount < MIN_BUILDING_PIXELS) return null;
  if (pixelCount > MAX_BUILDING_PIXELS) return null;

  // ── Step 4: Morphological cleanup (close small gaps, then erode noise) ─
  const cleaned = morphClose(buildingMask, w, h, 2);
  const final = morphOpen(cleaned, w, h, 1);

  // Recount after cleanup
  pixelCount = 0;
  for (let i = 0; i < final.length; i++) {
    if (final[i]) pixelCount++;
  }
  if (pixelCount < MIN_BUILDING_PIXELS) return null;

  // ── Step 5: Compute oriented bounding box ─────────────────────────────
  const obb = computeOBB(final, w, h);
  if (!obb) return null;

  // Convert pixel dimensions to meters
  const dim1 = obb.width * mpp;
  const dim2 = obb.height * mpp;
  const widthMeters = Math.min(dim1, dim2);
  const lengthMeters = Math.max(dim1, dim2);

  // Rotation: angle of the longest axis from north (Y-axis)
  let rotationDeg = obb.angle * (180 / Math.PI);
  // Normalize to 0-180 (building orientation is symmetric)
  rotationDeg = ((rotationDeg % 180) + 180) % 180;

  // ── Step 6: Classify shape ────────────────────────────────────────────
  const shape = classifyShape(final, w, h, obb);

  // ── Confidence score ──────────────────────────────────────────────────
  const areaMeters = pixelCount * mpp * mpp;
  const bboxArea = widthMeters * lengthMeters;
  const fillRatio = bboxArea > 0 ? areaMeters / bboxArea : 0;

  // Higher confidence when: reasonable fill ratio, enough pixels, compact shape
  let confidence = 0.5;
  if (fillRatio > 0.5 && fillRatio < 0.99) confidence += 0.2;
  if (pixelCount > 200) confidence += 0.15;
  if (widthMeters > 5 && lengthMeters > 5) confidence += 0.15;
  confidence = Math.min(1, confidence);

  return {
    shape,
    widthMeters: Math.round(widthMeters * 10) / 10,
    lengthMeters: Math.round(lengthMeters * 10) / 10,
    rotationDeg: Math.round(rotationDeg),
    confidence: Math.round(confidence * 100) / 100,
    mask: final,
    maskWidth: w,
    maskHeight: h,
  };
}

// ─── Step 1: Roof Color Sampling ────────────────────────────────────────────

/**
 * Sample dominant color from small circular region around building center.
 * Filters vegetation/pavement, then finds most common hue cluster.
 */
function sampleRoofColor(
  data: Uint8ClampedArray,
  w: number, h: number,
  cx: number, cy: number,
): { r: number; g: number; b: number } | null {
  const r2 = ROOF_SAMPLE_RADIUS * ROOF_SAMPLE_RADIUS;
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  const py0 = Math.max(0, Math.floor(cy - ROOF_SAMPLE_RADIUS));
  const py1 = Math.min(h, Math.ceil(cy + ROOF_SAMPLE_RADIUS));
  const px0 = Math.max(0, Math.floor(cx - ROOF_SAMPLE_RADIUS));
  const px1 = Math.min(w, Math.ceil(cx + ROOF_SAMPLE_RADIUS));

  for (let py = py0; py < py1; py++) {
    for (let px = px0; px < px1; px++) {
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy > r2) continue;

      const idx = (py * w + px) * 4;
      const rr = data[idx], gg = data[idx + 1], bb = data[idx + 2];
      const [hh, ss, ll] = rgbToHsl(rr, gg, bb);

      // Skip vegetation, pavement, shadows, glare
      if (isVegetation(hh, ss, ll)) continue;
      if (isPavement(ss, ll)) continue;
      if (ll < 0.08 || ll > 0.95) continue;

      rSum += rr;
      gSum += gg;
      bSum += bb;
      count++;
    }
  }

  if (count < 20) return null;
  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count),
  };
}

// ─── Step 3: Flood Fill ─────────────────────────────────────────────────────

/**
 * Flood fill from center point on the binary mask.
 * Returns a new mask containing only the connected component touching center.
 * If center pixel is not set, expands search in spiral pattern to find nearest set pixel.
 */
function floodFillFrom(
  mask: Uint8Array, w: number, h: number,
  startX: number, startY: number,
): Uint8Array {
  const out = new Uint8Array(w * h);

  // Find nearest set pixel if center isn't set (spiral search, max 15px radius)
  let sx = startX, sy = startY;
  if (!mask[sy * w + sx]) {
    let found = false;
    for (let radius = 1; radius <= 15 && !found; radius++) {
      for (let dy = -radius; dy <= radius && !found; dy++) {
        for (let dx = -radius; dx <= radius && !found; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const nx = startX + dx, ny = startY + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && mask[ny * w + nx]) {
            sx = nx; sy = ny; found = true;
          }
        }
      }
    }
    if (!found) return out;
  }

  // BFS flood fill
  const stack: number[] = [sx, sy];
  out[sy * w + sx] = 1;

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;

    // 4-connected neighbors
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (out[ni] || !mask[ni]) continue;
      out[ni] = 1;
      stack.push(nx, ny);
    }
  }

  return out;
}

// ─── Step 4: Morphological Operations ───────────────────────────────────────

/** Dilate binary mask by radius (square structuring element) */
function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            out[ny * w + nx] = 1;
          }
        }
      }
    }
  }
  return out;
}

/** Erode binary mask by radius (square structuring element) */
function erode(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let allSet = true;
      for (let dy = -radius; dy <= radius && allSet; dy++) {
        for (let dx = -radius; dx <= radius && allSet; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h || !mask[ny * w + nx]) {
            allSet = false;
          }
        }
      }
      if (allSet) out[y * w + x] = 1;
    }
  }
  return out;
}

/** Morphological close (dilate then erode) — fills small gaps */
function morphClose(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return erode(dilate(mask, w, h, radius), w, h, radius);
}

/** Morphological open (erode then dilate) — removes small noise */
function morphOpen(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  return dilate(erode(mask, w, h, radius), w, h, radius);
}

// ─── Step 5: Oriented Bounding Box ──────────────────────────────────────────

interface OBB {
  /** Center X in mask coords */
  cx: number;
  /** Center Y in mask coords */
  cy: number;
  /** Width of OBB in pixels (may not be the shorter axis) */
  width: number;
  /** Height of OBB in pixels */
  height: number;
  /** Rotation angle in radians (angle of first principal axis from X-axis) */
  angle: number;
}

/**
 * Compute oriented bounding box using PCA on building pixel coordinates.
 * Projects all set pixels onto principal axes to find tightest-fitting rectangle.
 */
function computeOBB(mask: Uint8Array, w: number, h: number): OBB | null {
  // Collect building pixel coordinates
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        xs.push(x);
        ys.push(y);
      }
    }
  }

  const n = xs.length;
  if (n < MIN_BUILDING_PIXELS) return null;

  // Compute centroid
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i];
    cy += ys[i];
  }
  cx /= n;
  cy /= n;

  // Compute covariance matrix [cxx, cxy; cxy, cyy]
  let cxx = 0, cxy = 0, cyy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  cxx /= n;
  cxy /= n;
  cyy /= n;

  // Eigenvalue decomposition of 2x2 symmetric matrix
  // Principal angle via atan2
  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);

  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  // Project all points onto principal axes
  let minU = Infinity, maxU = -Infinity;
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    const u = dx * cosA + dy * sinA;
    const v = -dx * sinA + dy * cosA;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  return {
    cx,
    cy,
    width: maxU - minU,
    height: maxV - minV,
    angle,
  };
}

// ─── Step 6: Shape Classification ───────────────────────────────────────────

/**
 * Classify building shape by analyzing how the footprint fills its OBB.
 *
 * Method: divide the OBB into quadrants and check fill density per quadrant.
 * - Rect: all quadrants roughly equal fill (>30% each)
 * - L-shape: one quadrant is mostly empty (<15% fill)
 * - T-shape: two adjacent quadrants have low fill
 * - U-shape: two non-adjacent quadrants have low fill, or 3+ low fill
 */
function classifyShape(
  mask: Uint8Array, w: number, h: number,
  obb: OBB,
): FloorPlanShape {
  const { cx, cy, width: obbW, height: obbH, angle } = obb;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  // Divide OBB into 2x2 grid of quadrants
  // Quadrant (i,j): i=0 is left half of U-axis, i=1 is right; j=0 is bottom V, j=1 is top
  const quadCounts = [0, 0, 0, 0]; // [topLeft, topRight, bottomLeft, bottomRight]
  let totalCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      totalCount++;

      const dx = x - cx;
      const dy = y - cy;
      const u = dx * cosA + dy * sinA;
      const v = -dx * sinA + dy * cosA;

      const qi = u >= 0 ? 1 : 0; // left/right
      const qj = v >= 0 ? 1 : 0; // top/bottom
      quadCounts[qj * 2 + qi]++;
    }
  }

  if (totalCount === 0) return 'rect';

  // Compute fill ratio per quadrant (relative to expected 25% each)
  const expected = totalCount / 4;
  const ratios = quadCounts.map(c => c / expected);

  // Count quadrants with low fill (< 50% of expected)
  const lowFillThreshold = 0.5;
  const lowQuadrants = ratios.filter(r => r < lowFillThreshold).length;

  // Also check overall fill ratio of building area vs OBB area
  const obbAreaPx = obbW * obbH;
  const overallFill = obbAreaPx > 0 ? totalCount / obbAreaPx : 1;

  // High fill ratio = rectangular
  if (overallFill > 0.82) return 'rect';

  // Very low fill = complex shape
  if (overallFill < 0.45) return 'U';

  // Classify by number of empty quadrants
  if (lowQuadrants === 0) return 'rect';
  if (lowQuadrants === 1) return 'L';

  // 2 empty quadrants: check if adjacent (T) or opposite (U)
  if (lowQuadrants === 2) {
    const lowIdxs: number[] = [];
    ratios.forEach((r, i) => { if (r < lowFillThreshold) lowIdxs.push(i); });

    // Adjacent pairs: (0,1), (2,3), (0,2), (1,3) — diagonal = (0,3), (1,2)
    const [a, b] = lowIdxs;
    const isDiagonal = (a === 0 && b === 3) || (a === 1 && b === 2);
    return isDiagonal ? 'U' : 'T';
  }

  return 'U'; // 3+ empty quadrants
}

// ─── Debug Overlay ──────────────────────────────────────────────────────────

/**
 * Draw the detected footprint mask as a colored overlay on the satellite canvas.
 * Useful for visual debugging / UI display of the detected shape.
 */
export function drawFootprintOverlay(
  canvas: HTMLCanvasElement,
  result: FootprintResult,
  centerX: number,
  centerY: number,
  color = 'rgba(88, 242, 101, 0.3)',
  strokeColor = 'rgba(88, 242, 101, 0.8)',
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const r = ANALYSIS_RADIUS;
  const x0 = Math.max(0, Math.floor(centerX - r));
  const y0 = Math.max(0, Math.floor(centerY - r));

  // Draw filled overlay for building pixels
  ctx.fillStyle = color;
  for (let y = 0; y < result.maskHeight; y++) {
    for (let x = 0; x < result.maskWidth; x++) {
      if (result.mask[y * result.maskWidth + x]) {
        ctx.fillRect(x0 + x, y0 + y, 1, 1);
      }
    }
  }

  // Draw outline by finding edge pixels (building pixel with non-building neighbor)
  ctx.fillStyle = strokeColor;
  for (let y = 1; y < result.maskHeight - 1; y++) {
    for (let x = 1; x < result.maskWidth - 1; x++) {
      if (!result.mask[y * result.maskWidth + x]) continue;
      // Check 4-neighbors — if any is empty, this is an edge
      const idx = y * result.maskWidth + x;
      if (
        !result.mask[idx - 1] || !result.mask[idx + 1] ||
        !result.mask[idx - result.maskWidth] || !result.mask[idx + result.maskWidth]
      ) {
        ctx.fillRect(x0 + x, y0 + y, 1, 1);
      }
    }
  }
}
