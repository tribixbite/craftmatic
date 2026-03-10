#!/usr/bin/env bun
/**
 * Batch render satellite-colored views for ALL v26 schems (browser + headless).
 * Geocodes addresses to fetch satellite imagery, renders at scale=6 and scale=10.
 */
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderSatelliteColored, renderSatelliteHiRes } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');

// Load API key
const dotenv = await Bun.file(join(projectRoot, '.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) { console.error('No API key'); process.exit(1); }

interface Building {
  schem: string;      // schem filename without extension
  lat: number;
  lng: number;
  zoom: number;
  scales: number[];   // render at these scales
}

// All buildings with coordinates and satellite zoom
const BUILDINGS: Building[] = [
  // === Browser captures ===
  { schem: 'esb-v26',        lat: 40.7484, lng: -73.9857, zoom: 19, scales: [6, 10] },
  { schem: 'chrysler-v26',   lat: 40.7516, lng: -73.9755, zoom: 19, scales: [6, 10] },
  { schem: 'flatiron-v26',   lat: 40.7411, lng: -73.9897, zoom: 20, scales: [6, 10] },
  { schem: 'stpatricks-v26', lat: 40.7585, lng: -73.9760, zoom: 20, scales: [6, 10] },
  { schem: 'dakota-v26',     lat: 40.7766, lng: -73.9762, zoom: 20, scales: [6, 10] },
  { schem: 'sentinel-v26',   lat: 37.7598, lng: -122.4148, zoom: 20, scales: [6, 10] },
  { schem: 'green-v26',      lat: 37.7954, lng: -122.4332, zoom: 20, scales: [6, 10] },
  { schem: 'noe-v26',        lat: 37.7604, lng: -122.4314, zoom: 21, scales: [6, 10] },
  { schem: 'sf-v26',         lat: 37.7604, lng: -122.4314, zoom: 21, scales: [6] },  // 450 Noe duplicate
  { schem: 'newton-v26',     lat: 42.3435, lng: -71.2215, zoom: 20, scales: [6, 10] },
  { schem: 'walpole-v26',    lat: 43.0658, lng: -72.4312, zoom: 20, scales: [6, 10] },
  { schem: 'losangeles-v26', lat: 34.1057, lng: -118.3006, zoom: 20, scales: [6, 10] },
  { schem: 'sanjose-v26',    lat: 37.3170, lng: -121.9502, zoom: 20, scales: [6, 10] },
  { schem: 'vinalhaven-v26', lat: 44.0579, lng: -68.8107, zoom: 20, scales: [6, 10] },
  { schem: 'seattle-v26',    lat: 47.5320, lng: -122.3830, zoom: 20, scales: [6, 10] },
  { schem: 'charleston-v26', lat: 32.7742, lng: -79.9303, zoom: 20, scales: [6, 10] },
  { schem: 'austin-v26',     lat: 30.3700, lng: -97.8280, zoom: 20, scales: [6, 10] },
  { schem: 'baker-v26',      lat: 37.7930, lng: -122.4470, zoom: 20, scales: [6, 10] },
  { schem: 'byron-v26',      lat: 42.8237, lng: -85.7280, zoom: 20, scales: [6, 10] },
  { schem: 'minneapolis-v26', lat: 44.9938, lng: -93.2128, zoom: 20, scales: [6, 10] },
  { schem: 'suttonsbay-v26', lat: 44.9744, lng: -85.6498, zoom: 20, scales: [6, 10] },
  // === Headless captures ===
  { schem: 'tiles-dallas-headless-v26',       lat: 32.8512, lng: -96.8277, zoom: 20, scales: [6] },
  { schem: 'tiles-scottsdale-headless-v26',   lat: 33.4877, lng: -111.926, zoom: 20, scales: [6] },
  { schem: 'tiles-dallas2-headless-v26',      lat: 32.8220, lng: -96.8085, zoom: 20, scales: [6] },
  { schem: 'tiles-winnetka-headless-v26',     lat: 42.1057, lng: -87.7325, zoom: 20, scales: [6] },
  { schem: 'tiles-cambridge-headless-v26',    lat: 42.3766, lng: -71.1227, zoom: 20, scales: [6] },
  { schem: 'tiles-arlington-headless-v26',    lat: 38.8824, lng: -77.1085, zoom: 20, scales: [6] },
  { schem: 'tiles-bellaire-headless-v26',     lat: 29.6931, lng: -95.4678, zoom: 20, scales: [6] },
  { schem: 'tiles-artinstitute-headless-v26', lat: 41.8796, lng: -87.6237, zoom: 20, scales: [6] },
  { schem: 'test-newton-headless-v26',        lat: 42.3435, lng: -71.2215, zoom: 20, scales: [6] },
  // === Flat-roof commercial headless ===
  { schem: 'flatroof-miami-v26',        lat: 25.7930, lng: -80.1375, zoom: 20, scales: [6] },
  { schem: 'flatroof-phoenix-v26',      lat: 33.4800, lng: -112.0740, zoom: 20, scales: [6] },
  { schem: 'flatroof-houston-v26',      lat: 29.7365, lng: -95.4613, zoom: 20, scales: [6] },
  { schem: 'flatroof-sandiego-v26',     lat: 32.7157, lng: -117.1611, zoom: 20, scales: [6] },
  { schem: 'flatroof-portland-v26',     lat: 45.5235, lng: -122.6812, zoom: 20, scales: [6] },
  { schem: 'flatroof-nashville-v26',    lat: 36.1627, lng: -86.7744, zoom: 20, scales: [6] },
  { schem: 'flatroof-tampa-v26',        lat: 27.9478, lng: -82.4584, zoom: 20, scales: [6] },
  { schem: 'flatroof-raleigh-v26',      lat: 35.7796, lng: -78.6382, zoom: 20, scales: [6] },
  { schem: 'flatroof-atlanta-v26',      lat: 33.7590, lng: -84.3880, zoom: 20, scales: [6] },
  { schem: 'flatroof-charlotte-v26',    lat: 35.2271, lng: -80.8431, zoom: 20, scales: [6] },
  // === NYC urban headless ===
  { schem: 'nyc-apthorp-headless-v26',  lat: 40.7835, lng: -73.9770, zoom: 20, scales: [6] },
  { schem: 'nyc-ansonia-headless-v26',  lat: 40.7806, lng: -73.9816, zoom: 20, scales: [6] },
  { schem: 'chicago-loop-headless-v26', lat: 41.8827, lng: -87.6233, zoom: 20, scales: [6] },
];

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;
const scaleArg = process.argv.find(a => a.startsWith('--scale='));
const filterScale = scaleArg ? parseInt(scaleArg.split('=')[1]) : null;
const hiresMode = process.argv.includes('--hires');
const RESOLUTION = 4;

// Satellite image cache (same lat/lng/zoom → reuse)
const satCache = new Map<string, { rgb: Buffer; w: number; h: number }>();

for (const b of BUILDINGS) {
  if (filterName && !b.schem.includes(filterName)) continue;

  const schemPath = join(tilesDir, `${b.schem}.schem`);
  if (!existsSync(schemPath)) {
    console.log(`  ${b.schem}: SKIP (no schem)`);
    continue;
  }

  const grid = await parseToGrid(schemPath);
  console.log(`\n=== ${b.schem} === Grid: ${grid.width}x${grid.height}x${grid.length}`);

  // Fetch satellite image (cached)
  const satKey = `${b.lat},${b.lng},${b.zoom}`;
  let sat = satCache.get(satKey);
  if (!sat) {
    const satUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${b.lat},${b.lng}&zoom=${b.zoom}&size=640x640&maptype=satellite&key=${apiKey}`;
    const satBuf = Buffer.from(await (await fetch(satUrl)).arrayBuffer());
    const satMeta = await sharp(satBuf).metadata();
    const satRgb = await sharp(satBuf).removeAlpha().raw().toBuffer();
    sat = { rgb: satRgb, w: satMeta.width!, h: satMeta.height! };
    satCache.set(satKey, sat);
  }

  for (const scale of b.scales) {
    if (filterScale && scale !== filterScale) continue;
    const suffix = scale === 6 ? '' : `-s${scale}`;
    const outPath = join(tilesDir, `sv-${b.schem}${suffix}.jpg`);

    // Skip if already exists
    if (existsSync(outPath)) {
      console.log(`  scale=${scale}: EXISTS (${outPath})`);
      continue;
    }

    const pngBuf = await renderSatelliteColored(grid, sat.rgb, sat.w, sat.h, {
      resolution: RESOLUTION, lat: b.lat, zoom: b.zoom, scale,
    });
    const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
    await writeFile(outPath, jpgBuf);
    console.log(`  scale=${scale} → ${(jpgBuf.length / 1024).toFixed(0)}KB`);
  }

  // Hi-res render: satellite pixel resolution with voxel heightmap hillshade
  if (hiresMode) {
    const hiresPath = join(tilesDir, `sv-${b.schem}-hires.jpg`);
    if (existsSync(hiresPath)) {
      console.log(`  hires: EXISTS`);
    } else {
      const pngBuf = await renderSatelliteHiRes(grid, sat.rgb, sat.w, sat.h, {
        resolution: RESOLUTION, lat: b.lat, zoom: b.zoom,
      });
      const jpgBuf = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
      await writeFile(hiresPath, jpgBuf);
      console.log(`  hires → ${(jpgBuf.length / 1024).toFixed(0)}KB`);
    }
  }

  // GC between renders
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone!');
