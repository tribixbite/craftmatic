/**
 * Satellite roof color sampling via Google Static Maps API.
 *
 * Fetches a top-down satellite image at the given coordinates, samples
 * the center 30% for average roof color, and returns the nearest
 * Minecraft wall block.
 */

import { rgbToWallBlock } from '../gen/color-blocks.js';
import sharp from 'sharp';
import { resolve, join } from 'node:path';

/**
 * Fetch satellite image and sample average roof color within the building footprint.
 * Returns the nearest Minecraft block for the observed roof and wall colors.
 * Requires Google Maps API key in .env and building coordinates.
 */
export async function sampleSatelliteRoof(
  lat: number, lng: number,
): Promise<{ roofBlock: string; roofRgb: [number, number, number] } | null> {
  // Read API key from .env
  const projectRoot = resolve(import.meta.dir, '..');
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
    // Satellite top-down view (zoom 20 ≈ 0.12m/px) — accurate roof color
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=20&size=256x256&maptype=satellite&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) { console.log(`  Satellite: HTTP ${res.status}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height;

    // Sample center 30% of image for roof color
    const margin = Math.floor(w * 0.35);
    let rR = 0, rG = 0, rB = 0, rN = 0;
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const i = (y * w + x) * 3;
        rR += data[i]; rG += data[i + 1]; rB += data[i + 2];
        rN++;
      }
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

    console.log(`  Satellite roof: rgb(${roofR},${roofG},${roofB}) sat=${(roofSat*100).toFixed(0)}%→${roofBlock.replace('minecraft:', '')}`);
    return { roofBlock, roofRgb: [roofR, roofG, roofB] };
  } catch (e) {
    console.log(`  Satellite color: ${(e as Error).message}`);
    return null;
  }
}
