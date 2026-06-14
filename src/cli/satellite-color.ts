/**
 * Satellite roof color sampling via Google Static Maps API.
 *
 * Fetches a top-down satellite image at the given coordinates, dynamically
 * computing zoom level from building dimensions so the entire footprint
 * is visible. Samples the center region for average roof color and returns
 * the nearest Minecraft wall block.
 */

import { rgbToWallBlock } from '../gen/color-blocks.js';
import { computeSatelliteZoom, metersPerPixel } from '../shared/satellite-zoom.js';
import sharp from 'sharp';
import { resolve, join } from 'node:path';

/** Google Static Maps max image size for standard (free) usage */
const SAT_IMAGE_SIZE = 640;

/**
 * Fetch satellite image and sample average roof color within the building footprint.
 * Returns the nearest Minecraft block for the observed roof and wall colors.
 * Requires Google Maps API key in .env and building coordinates.
 *
 * @param lat  Building center latitude
 * @param lng  Building center longitude
 * @param buildingExtentM  Max footprint dimension in meters (for zoom calculation).
 *                         If omitted, defaults to zoom 19 (~60m coverage).
 */
export async function sampleSatelliteRoof(
  lat: number, lng: number,
  buildingExtentM?: number,
): Promise<{ roofBlock: string; roofRgb: [number, number, number]; zoom: number } | null> {
  // Read API key from .env at project root
  const projectRoot = resolve(import.meta.dir, '../..');
  let apiKey: string | undefined;
  try {
    const dotenv = await Bun.file(join(projectRoot, '.env')).text();
    apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
  } catch (err) { console.warn('.env load failed:', (err as Error).message); }
  if (!apiKey) {
    console.log('  Satellite color: no API key, skipping');
    return null;
  }

  try {
    // Compute zoom: fit entire building + context into image
    const zoom = buildingExtentM
      ? computeSatelliteZoom(buildingExtentM, lat, SAT_IMAGE_SIZE)
      : 19; // Default z19 covers ~60m at mid-latitudes — fits most buildings
    const mpp = metersPerPixel(zoom, lat);
    const coverageM = SAT_IMAGE_SIZE * mpp;
    console.log(`  Satellite: zoom=${zoom} (${coverageM.toFixed(0)}m coverage, ${mpp.toFixed(2)}m/px)`);

    const url = `https://maps.googleapis.com/maps/api/staticmap`
      + `?center=${lat},${lng}&zoom=${zoom}&size=${SAT_IMAGE_SIZE}x${SAT_IMAGE_SIZE}`
      + `&maptype=satellite&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) { console.log(`  Satellite: HTTP ${res.status}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height;

    // Sample center 50% of image (margin 25% each side) — captures most of the
    // roof while excluding street/parking edges. Previous 30% was too tight.
    const margin = Math.floor(w * 0.25);
    let rR = 0, rG = 0, rB = 0, rN = 0;
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const i = (y * w + x) * 3;
        const pr = data[i], pg = data[i + 1], pb = data[i + 2];

        // Reject non-roof pixels: vegetation (green), shadow (very dark),
        // sky/water (bright blue), glare (near-white)
        const pMax = Math.max(pr, pg, pb);
        const pMin = Math.min(pr, pg, pb);
        const lum = (pr + pg + pb) / 3;

        // Shadow: very dark pixels are likely shadow, not roof
        if (lum < 30) continue;
        // Glare: very bright near-white pixels (reflections, markings)
        if (lum > 245) continue;

        // Vegetation: green-dominant with moderate saturation
        if (pg > pr && pg > pb) {
          const sat = pMax > 0 ? (pMax - pMin) / pMax : 0;
          if (sat > 0.20 && pg > 80) continue;
        }

        rR += pr; rG += pg; rB += pb;
        rN++;
      }
    }

    if (rN < 100) {
      console.log(`  Satellite: only ${rN} valid roof pixels — too few, skipping`);
      return null;
    }

    const roofR = Math.round(rR / rN), roofG = Math.round(rG / rN), roofB = Math.round(rB / rN);
    let roofBlock = rgbToWallBlock(roofR, roofG, roofB);

    // v70: Force gray satellite colors to neutral blocks — prevents warm-toned
    // stone_bricks/terracotta from appearing on gray roofs. Satellite imagery
    // of gray roofs (concrete, slate, asphalt) has very low saturation.
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

    console.log(`  Satellite roof: rgb(${roofR},${roofG},${roofB}) sat=${(roofSat*100).toFixed(0)}% → ${roofBlock.replace('minecraft:', '')} (${rN} pixels sampled)`);
    return { roofBlock, roofRgb: [roofR, roofG, roofB], zoom };
  } catch (e) {
    console.log(`  Satellite color: ${(e as Error).message}`);
    return null;
  }
}
