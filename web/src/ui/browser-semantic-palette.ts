/**
 * Browser-side semantic palette resolution — fetches SV facade colors and
 * satellite roof color, then resolves a SemanticPalette for the voxelizer pipeline.
 *
 * This is the browser equivalent of the CLI's `resolveSemanticPaletteFromAPIs()`
 * in voxelize-glb.ts. All image decoding uses Canvas2D (no sharp dependency).
 *
 * Data flow:
 * 1. OSM tags + polygon already fetched by building-bounds.ts
 * 2. SV multi-heading images fetched via queryMultiHeadingSV (pure fetch)
 * 3. Each SV image analyzed via analyzeStreetViewBrowser (Canvas2D)
 * 4. Satellite image fetched + sampled via OffscreenCanvas
 * 5. resolveSemanticPalette() called with merged data
 */

import type { SemanticPalette } from '@craft/convert/semantic-palette.js';
import { resolveSemanticPalette } from '@craft/convert/semantic-palette.js';
import { queryMultiHeadingSV, type SvFacadeImage } from '@craft/gen/api/google-streetview.js';
import { rgbToWallBlock, rgbToLab } from '@craft/gen/color-blocks.js';
import { computeSatelliteZoom, metersPerPixel } from '@craft/shared/satellite-zoom.js';
import type { OSMBuildingData } from '@ui/import-osm.js';
import type { SolarBuildingData } from '@craft/gen/api/google-solar.js';
import type { BuildingBounds } from '@ui/building-bounds.js';
import { analyzeStreetViewBrowser } from '@ui/import-sv-analysis.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrowserSemanticData {
  /** OSM building footprint polygon (lat/lon pairs) */
  osmPolygon?: { lat: number; lon: number }[];
  /** Raw OSM tags for the building */
  osmTags?: Record<string, string>;
  /** Resolved semantic palette (wall + roof materials from SV/satellite/OSM) */
  semanticPalette?: SemanticPalette;
  /** Estimated building height in meters */
  knownHeightM?: number;
  /** MBR alignment data for OSM polygon alignment */
  buildingAlignment?: { rotationDeg: number; mbrWidth: number; mbrDepth: number };
}

/** Google Static Maps max image size for standard (free) usage */
const SAT_IMAGE_SIZE = 640;

// ─── SV Multi-Angle Color Merge ─────────────────────────────────────────────

interface FacadeColor {
  faceName: string;
  wallColor: { r: number; g: number; b: number } | null;
  pixelCount: number;
}

/**
 * Fetch multi-heading SV images and extract merged wall color via Canvas2D.
 * Browser equivalent of CLI's extractMultiAngleColors() — uses
 * analyzeStreetViewBrowser() per facade instead of sharp-based extractColors().
 */
async function extractBrowserMultiAngleColors(
  svImages: SvFacadeImage[],
  log: (msg: string) => void,
): Promise<{ wallColor: { r: number; g: number; b: number }; wallBlock: string; confidence: number } | null> {
  const facades: FacadeColor[] = [];

  // Analyze each facade image in parallel (Canvas2D, no sharp)
  const results = await Promise.allSettled(
    svImages.map(async (img) => {
      const result = await analyzeStreetViewBrowser(img.imageUrl);
      return { faceName: img.faceName, heading: img.heading, result };
    }),
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { faceName, heading, result } = r.value;
    if (result) {
      const { wallColor } = result;
      const wMax = Math.max(wallColor.r, wallColor.g, wallColor.b);
      const wMin = Math.min(wallColor.r, wallColor.g, wallColor.b);
      const sat = wMax > 0 ? (wMax - wMin) / wMax : 0;
      // Estimate wall pixel count (center 70% × middle 40% of 640×640 image)
      const wallPixels = Math.floor(640 * 0.7) * Math.floor(640 * 0.4);

      facades.push({
        faceName,
        wallColor: sat >= 0.05 ? wallColor : null,
        pixelCount: sat >= 0.05 ? wallPixels : 0,
      });

      const label = sat >= 0.05
        ? `rgb(${wallColor.r},${wallColor.g},${wallColor.b}) sat=${(sat * 100).toFixed(0)}%`
        : `SKIPPED (sat=${(sat * 100).toFixed(0)}%)`;
      log(`  SV ${faceName} (${heading.toFixed(0)}°): ${label}`);
    } else {
      facades.push({ faceName, wallColor: null, pixelCount: 0 });
      log(`  SV ${faceName}: no wall color / indoor / failed`);
    }
  }

  // Filter to facades with valid wall colors
  const valid = facades.filter(f => f.wallColor !== null);
  if (valid.length === 0) return null;

  // Weighted merge by pixel count
  let totalWeight = 0;
  let wR = 0, wG = 0, wB = 0;
  for (const f of valid) {
    const w = f.pixelCount || 1;
    wR += f.wallColor!.r * w;
    wG += f.wallColor!.g * w;
    wB += f.wallColor!.b * w;
    totalWeight += w;
  }
  const mergedR = Math.round(wR / totalWeight);
  const mergedG = Math.round(wG / totalWeight);
  const mergedB = Math.round(wB / totalWeight);

  // Inter-facade agreement via CIE-Lab delta-E
  const mergedLab = rgbToLab(mergedR, mergedG, mergedB);
  let maxDeltaE = 0;
  for (const f of valid) {
    const fLab = rgbToLab(f.wallColor!.r, f.wallColor!.g, f.wallColor!.b);
    const dL = mergedLab[0] - fLab[0];
    const da = mergedLab[1] - fLab[1];
    const db = mergedLab[2] - fLab[2];
    const dE = Math.sqrt(dL * dL + da * da + db * db);
    if (dE > maxDeltaE) maxDeltaE = dE;
  }
  // confidence: deltaE=0 → 1.0, deltaE=30 → 0.5, deltaE=60+ → ~0
  const confidence = Math.max(0, 1.0 - maxDeltaE / 60);

  const wallBlock = rgbToWallBlock(mergedR, mergedG, mergedB);
  log(`  SV merged: rgb(${mergedR},${mergedG},${mergedB}) → ${wallBlock.replace('minecraft:', '')} (${valid.length} facades, conf=${confidence.toFixed(2)})`);

  return { wallColor: { r: mergedR, g: mergedG, b: mergedB }, wallBlock, confidence };
}

// ─── Satellite Roof Sampling (Canvas2D) ─────────────────────────────────────

/**
 * Fetch satellite image and sample roof color via OffscreenCanvas.
 * Browser port of src/cli/satellite-color.ts — identical sampling logic,
 * replaces sharp decode with createImageBitmap + OffscreenCanvas.
 */
async function sampleSatelliteRoofBrowser(
  lat: number, lng: number, apiKey: string,
  buildingExtentM?: number,
  log: (msg: string) => void = console.log,
): Promise<{ roofBlock: string; roofRgb: [number, number, number]; zoom: number } | null> {
  try {
    const zoom = buildingExtentM
      ? computeSatelliteZoom(buildingExtentM, lat, SAT_IMAGE_SIZE)
      : 19;
    const mpp = metersPerPixel(zoom, lat);
    const coverageM = SAT_IMAGE_SIZE * mpp;
    log(`  Satellite: zoom=${zoom} (${coverageM.toFixed(0)}m coverage, ${mpp.toFixed(2)}m/px)`);

    const url = `https://maps.googleapis.com/maps/api/staticmap`
      + `?center=${lat},${lng}&zoom=${zoom}&size=${SAT_IMAGE_SIZE}x${SAT_IMAGE_SIZE}`
      + `&maptype=satellite&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) { log(`  Satellite: HTTP ${resp.status}`); return null; }

    // Decode image via Canvas2D (replaces sharp)
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return null; }
    ctx.drawImage(bitmap, 0, 0);
    const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();

    const pixels = imgData.data;
    const w = imgData.width, h = imgData.height;

    // Sample center 50% of image (margin 25% each side)
    const margin = Math.floor(w * 0.25);
    let rR = 0, rG = 0, rB = 0, rN = 0;
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const i = (y * w + x) * 4; // RGBA
        const pr = pixels[i], pg = pixels[i + 1], pb = pixels[i + 2];

        const pMax = Math.max(pr, pg, pb);
        const pMin = Math.min(pr, pg, pb);
        const lum = (pr + pg + pb) / 3;

        // Shadow rejection
        if (lum < 30) continue;
        // Glare rejection
        if (lum > 245) continue;
        // Vegetation rejection: green-dominant with moderate saturation
        if (pg > pr && pg > pb) {
          const sat = pMax > 0 ? (pMax - pMin) / pMax : 0;
          if (sat > 0.20 && pg > 80) continue;
        }

        rR += pr; rG += pg; rB += pb;
        rN++;
      }
    }

    if (rN < 100) {
      log(`  Satellite: only ${rN} valid roof pixels — too few, skipping`);
      return null;
    }

    const roofR = Math.round(rR / rN), roofG = Math.round(rG / rN), roofB = Math.round(rB / rN);
    let roofBlock = rgbToWallBlock(roofR, roofG, roofB);

    // Force gray satellite colors to neutral blocks (same as CLI)
    const roofMax = Math.max(roofR, roofG, roofB);
    const roofMin = Math.min(roofR, roofG, roofB);
    const roofSat = roofMax > 0 ? (roofMax - roofMin) / roofMax : 0;
    if (roofSat < 0.15) {
      const lum = (roofR + roofG + roofB) / 3;
      if (lum < 60) roofBlock = 'minecraft:polished_deepslate';
      else if (lum < 100) roofBlock = 'minecraft:gray_concrete';
      else if (lum < 140) roofBlock = 'minecraft:andesite';
      else if (lum < 180) roofBlock = 'minecraft:light_gray_concrete';
      else roofBlock = 'minecraft:smooth_stone';
    }

    log(`  Satellite roof: rgb(${roofR},${roofG},${roofB}) sat=${(roofSat * 100).toFixed(0)}% → ${roofBlock.replace('minecraft:', '')} (${rN} pixels sampled)`);
    return { roofBlock, roofRgb: [roofR, roofG, roofB], zoom };
  } catch (e) {
    log(`  Satellite color: ${(e as Error).message}`);
    return null;
  }
}

// ─── Main Resolver ──────────────────────────────────────────────────────────

/**
 * Resolve semantic data for the browser pipeline — fetches SV + satellite
 * colors, resolves semantic palette, extracts OSM polygon + tags.
 *
 * Call this after building bounds are resolved and grid is voxelized.
 * Pass the result to runPipeline() to enable SEMANTIC_RECOLOR, OSM_MASK, etc.
 *
 * @param lat       Building latitude
 * @param lng       Building longitude
 * @param apiKey    Google Maps API key (for SV + satellite)
 * @param osm       OSM building data from building-bounds.ts (may be null)
 * @param solar     Solar API data from building-bounds.ts (may be null)
 * @param bounds    Resolved building bounds (for extent calculations)
 * @param gridHeightM  Estimated building height from grid (maxSolidY / resolution)
 * @param log       Status logger for UI feedback
 */
export async function resolveBrowserSemanticData(
  lat: number, lng: number, apiKey: string,
  osm: OSMBuildingData | null,
  solar: SolarBuildingData | null,
  bounds: BuildingBounds | null,
  gridHeightM: number,
  log: (msg: string) => void = console.log,
): Promise<BrowserSemanticData> {
  const result: BrowserSemanticData = {};

  // Extract OSM polygon + tags
  if (osm) {
    result.osmPolygon = osm.polygon;
    result.osmTags = osm.tags;

    // MBR alignment from OSM dimensions (simple — no rotation for browser)
    if (osm.widthMeters > 2 && osm.lengthMeters > 2) {
      result.buildingAlignment = {
        rotationDeg: 0, // Browser doesn't compute ENU rotation
        mbrWidth: osm.widthMeters,
        mbrDepth: osm.lengthMeters,
      };
    }
  }

  // Estimate building height: grid-derived > OSM levels > Solar area heuristic
  const osmLevels = osm?.levels;
  const heightM = gridHeightM > 0
    ? gridHeightM
    : osmLevels
      ? osmLevels * 3.5
      : 0;
  if (heightM > 0) result.knownHeightM = heightM;

  const osmTags = osm?.tags ?? {};
  const buildingExtentM = bounds
    ? Math.max(bounds.widthM, bounds.lengthM)
    : undefined;

  // Phase A: Resolve base palette from OSM tags
  let palette = resolveSemanticPalette(osmTags, heightM);
  if (palette) {
    log(`  Semantic palette: ${palette.source}`);
  }

  // Phase B: SV multi-heading facade color (only when OSM didn't provide wallColor)
  if (!palette?.wallColor && apiKey) {
    try {
      log('  Fetching Street View facades...');
      const svImages = await queryMultiHeadingSV(lat, lng, buildingExtentM, apiKey);
      if (svImages.length > 0) {
        const multiResult = await extractBrowserMultiAngleColors(svImages, log);
        if (multiResult) {
          const { r, g, b } = multiResult.wallColor;
          const svMax = Math.max(r, g, b);
          const svMin = Math.min(r, g, b);
          const svSat = svMax > 0 ? (svMax - svMin) / svMax : 0;
          if (svSat < 0.10) {
            log(`  SV multi-angle wall: rgb(${r},${g},${b}) sat=${(svSat * 100).toFixed(0)}% — SKIPPED (too gray)`);
          } else {
            if (palette) {
              palette.wallColor = { r, g, b };
              palette.wallBlocks = [multiResult.wallBlock];
              palette.source += ' + SV multi-angle';
            } else {
              palette = { wallBlocks: [multiResult.wallBlock], wallColor: { r, g, b }, source: 'SV multi-angle' };
            }
          }
        }
      } else {
        log('  SV: no street view imagery available');
      }
    } catch (e) {
      log(`  SV: ${(e as Error).message}`);
    }
  }

  // Phase C: Satellite roof color
  if (apiKey) {
    try {
      log('  Fetching satellite imagery...');
      const satRoof = await sampleSatelliteRoofBrowser(lat, lng, apiKey, buildingExtentM, log);
      if (satRoof && palette) {
        palette.roofBlocks = [satRoof.roofBlock];
        palette.roofColor = { r: satRoof.roofRgb[0], g: satRoof.roofRgb[1], b: satRoof.roofRgb[2] };
        palette.source += ' + satellite roof';
      } else if (satRoof && !palette) {
        palette = {
          wallBlocks: [],
          roofBlocks: [satRoof.roofBlock],
          roofColor: { r: satRoof.roofRgb[0], g: satRoof.roofRgb[1], b: satRoof.roofRgb[2] },
          source: 'satellite roof only',
        };
      }
    } catch (e) {
      log(`  Satellite: ${(e as Error).message}`);
    }
  }

  if (palette) {
    result.semanticPalette = palette;
    log(`  Final palette: ${palette.source}`);
    log(`  Wall blocks: ${palette.wallBlocks.map(b => b.replace('minecraft:', '')).join(', ')}`);
    if (palette.roofBlocks) {
      log(`  Roof blocks: ${palette.roofBlocks.map(b => b.replace('minecraft:', '')).join(', ')}`);
    }
  } else {
    log('  No semantic palette resolved (photogrammetry colors only)');
  }

  return result;
}
