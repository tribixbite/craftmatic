/**
 * Browser-compatible Street View image analysis — extracts wall/roof/trim
 * colors from a Street View image URL using Canvas2D pixel access.
 *
 * Reuses the same zone-based color extraction logic as the CLI's
 * streetview-analysis.ts, but loads images via <img> + Canvas instead of sharp.
 *
 * This is the critical missing piece: without it, adding a Google SV API key
 * shows the image but never feeds color data into the material resolver.
 */

import {
  rgbToHsl, isVegetationColor,
  rgbToWallBlock, rgbToRoofOverride, rgbToTrimBlock,
  dominantColor, dominantColorExcluding,
} from '@craft/gen/color-blocks.js';
import type { BlockState } from '@craft/types/index.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BrowserSvColorResult {
  wallBlock: BlockState;
  roofOverride: { north: BlockState; south: BlockState; cap: BlockState };
  trimBlock: BlockState;
  wallColor: { r: number; g: number; b: number };
  roofColor: { r: number; g: number; b: number };
  trimColor: { r: number; g: number; b: number };
}

// ─── Image Loading ─────────────────────────────────────────────────────────

/** Load a Street View image URL and extract RGBA pixels via Canvas2D */
async function loadImagePixels(url: string): Promise<{
  pixels: Uint8Array;
  width: number;
  height: number;
} | null> {
  try {
    // Load image via blob fetch (avoids CORS tainting from <img> direct load)
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) return null;

    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return null; }

    ctx.drawImage(bitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();

    return {
      pixels: new Uint8Array(imgData.data.buffer),
      width: bitmap.width,
      height: bitmap.height,
    };
  } catch (err) {
    console.warn('SV browser analysis: image load failed:', (err as Error).message);
    return null;
  }
}

// ─── Indoor Detection ──────────────────────────────────────────────────────

/**
 * Multi-factor indoor panorama detection: sky + foliage (top zone) +
 * road/pavement (bottom zone). Prevents false positives when trees
 * obscure the sky on outdoor images.
 */
function isIndoor(pixels: Uint8Array, w: number, h: number): boolean {
  // ── Top zone: sky + foliage ────────────────────────────────────────
  const topBound = Math.floor(h * 0.15);
  let topTotal = 0;
  let sky = 0;
  let foliage = 0;

  for (let y = 0; y < topBound; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const [hue, sat, lum] = rgbToHsl(r, g, b);
      topTotal++;
      if (hue >= 180 && hue <= 250 && sat > 0.15 && lum > 0.3) {
        sky++;
      } else if (lum > 0.75 && sat < 0.15) {
        sky++;
      }
      if (hue >= 60 && hue <= 170 && sat > 0.15 && lum > 0.1 && lum < 0.8) {
        foliage++;
      }
    }
  }

  if (topTotal === 0) return false;
  if (sky / topTotal >= 0.05) return false;          // sufficient sky → outdoor
  if (foliage / topTotal > 0.15) return false;        // tree canopy → outdoor

  // ── Bottom zone: road/pavement ─────────────────────────────────────
  const bottomStart = Math.floor(h * 0.85);
  let bottomTotal = 0;
  let road = 0;
  for (let y = bottomStart; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const [, sat, lum] = rgbToHsl(r, g, b);
      bottomTotal++;
      if (sat < 0.2 && lum > 0.15 && lum < 0.65) road++;
    }
  }
  if (bottomTotal > 0 && road / bottomTotal > 0.3) return false; // road → outdoor

  return true;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Analyze a Street View image URL in the browser — extracts wall, roof,
 * and trim colors using zone-based sampling identical to the CLI pipeline.
 *
 * Returns null if the image can't be loaded or is an indoor panorama.
 */
export async function analyzeStreetViewBrowser(
  svUrl: string,
): Promise<BrowserSvColorResult | null> {
  const img = await loadImagePixels(svUrl);
  if (!img) return null;

  const { pixels, width, height } = img;

  // Skip indoor panoramas
  if (isIndoor(pixels, width, height)) return null;

  // Zone-based color extraction (mirrors streetview-analysis.ts extractColors)
  const roofColor = dominantColor(pixels, 0, Math.floor(height * 0.25), width);
  let wallColor = dominantColor(
    pixels,
    Math.floor(height * 0.25), Math.floor(height * 0.65),
    width,
    Math.floor(width * 0.15), Math.floor(width * 0.85),
  );
  const trimLeft = dominantColor(
    pixels,
    Math.floor(height * 0.25), Math.floor(height * 0.65),
    width,
    Math.floor(width * 0.03), Math.floor(width * 0.15),
  );
  const trimRight = dominantColor(
    pixels,
    Math.floor(height * 0.25), Math.floor(height * 0.65),
    width,
    Math.floor(width * 0.85), Math.floor(width * 0.97),
  );
  const trimColor = trimLeft ?? trimRight;

  if (!wallColor) return null;

  // Reject if wall zone is dominated by vegetation (tree-occluded building).
  // Try secondary extraction excluding green hues before falling back to null.
  if (isVegetationColor(wallColor.r, wallColor.g, wallColor.b)) {
    const wallStartY = Math.floor(height * 0.25);
    const wallEndY = Math.floor(height * 0.65);
    const wallStartX = Math.floor(width * 0.15);
    const wallEndX = Math.floor(width * 0.85);
    const VEGETATION_HUE: [number, number][] = [[60, 170]];
    const secondary = dominantColorExcluding(
      pixels, wallStartY, wallEndY, width, wallStartX, wallEndX, VEGETATION_HUE,
    );
    if (secondary && !isVegetationColor(secondary.r, secondary.g, secondary.b)) {
      console.warn('SV color analysis: vegetation bypass — using secondary non-green color');
      wallColor = secondary;
    } else {
      console.warn('SV color analysis: wall zone dominated by vegetation — skipping');
      return null;
    }
  }

  const wallBlock = rgbToWallBlock(wallColor.r, wallColor.g, wallColor.b);
  const roofOverride = roofColor
    ? rgbToRoofOverride(roofColor.r, roofColor.g, roofColor.b)
    : rgbToRoofOverride(100, 100, 100);
  const trimBlock = trimColor
    ? rgbToTrimBlock(trimColor.r, trimColor.g, trimColor.b)
    : rgbToTrimBlock(200, 200, 200);

  return {
    wallBlock,
    roofOverride,
    trimBlock,
    wallColor,
    roofColor: roofColor ?? { r: 100, g: 100, b: 100 },
    trimColor: trimColor ?? { r: 200, g: 200, b: 200 },
  };
}
