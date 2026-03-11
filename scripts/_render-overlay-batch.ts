#!/usr/bin/env bun
/**
 * Batch render voxel footprint overlays on satellite images for VLM evaluation.
 * Uses OSM polygon masking + dynamic ground plane detection for accurate building isolation.
 */
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderFootprintOverlay } from '../src/render/png-renderer.js';
import { searchOSMBuilding } from '../src/gen/api/osm.js';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const outDir = join(tilesDir, 'overlay');

await mkdir(outDir, { recursive: true });

const dotenv = await Bun.file(join(projectRoot, '.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) { console.error('No API key'); process.exit(1); }

interface Building {
  schem: string;
  lat: number;
  lng: number;
  zoom: number;
}

const BUILDINGS: Building[] = [
  // Headless landmarks
  { schem: 'geisel-headless-v26',           lat: 32.8812, lng: -117.2376, zoom: 20 },
  { schem: 'guggenheim-headless-v26',       lat: 40.7830, lng: -73.9590,  zoom: 20 },
  { schem: 'mitdome-headless-v26',          lat: 42.3594, lng: -71.0928,  zoom: 20 },
  { schem: 'willistower-headless-v26',      lat: 41.8789, lng: -87.6358,  zoom: 19 },
  { schem: 'pentagon-headless-v26',         lat: 38.8719, lng: -77.0563,  zoom: 19 },
  { schem: 'chicago-loop-headless-v26',     lat: 41.8827, lng: -87.6233,  zoom: 20 },
  { schem: 'test-newton-headless-v26',      lat: 42.3435, lng: -71.2215,  zoom: 20 },
  { schem: 'tiles-arlington-headless-v26',  lat: 38.8824, lng: -77.1085,  zoom: 20 },
  { schem: 'tiles-artinstitute-headless-v26', lat: 41.8796, lng: -87.6237, zoom: 20 },
  { schem: 'tiles-dallas2-headless-v26',    lat: 32.8220, lng: -96.8085,  zoom: 20 },
  { schem: 'transamerica-headless-v26',     lat: 37.7952, lng: -122.4028, zoom: 19 },
  { schem: 'uscapitol-headless-v26',        lat: 38.8899, lng: -77.0091,  zoom: 19 },
  // Browser captures
  { schem: 'noe-v26',                       lat: 37.7604, lng: -122.4314, zoom: 21 },
  { schem: 'chrysler-v26',                  lat: 40.7516, lng: -73.9755,  zoom: 19 },
  { schem: 'dakota-v26',                    lat: 40.7766, lng: -73.9762,  zoom: 20 },
  { schem: 'stpatricks-v26',               lat: 40.7585, lng: -73.9760,  zoom: 20 },
  { schem: 'flatroof-nashville-v26',        lat: 36.1627, lng: -86.7744,  zoom: 20 },
];

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;
const forceArg = process.argv.includes('--force');
const noOsmArg = process.argv.includes('--no-osm');

// Satellite image cache
const satCache = new Map<string, { rgb: Buffer; w: number; h: number }>();

for (const b of BUILDINGS) {
  if (filterName && !b.schem.includes(filterName)) continue;

  const schemPath = join(tilesDir, `${b.schem}.schem`);
  if (!existsSync(schemPath)) {
    console.log(`  ${b.schem}: SKIP (no schem)`);
    continue;
  }

  const outPath = join(outDir, `ov-${b.schem}.jpg`);
  if (existsSync(outPath) && !forceArg) {
    console.log(`  ${b.schem}: EXISTS`);
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

  // Fetch OSM building polygon for masking
  let osmPolygon: { lat: number; lon: number }[] | undefined;
  if (!noOsmArg) {
    try {
      const osmData = await searchOSMBuilding(b.lat, b.lng, 100);
      if (osmData?.polygon && osmData.polygon.length >= 3) {
        osmPolygon = osmData.polygon;
        console.log(`  OSM: ${osmPolygon.length} vertices, ${osmData.widthMeters.toFixed(0)}x${osmData.lengthMeters.toFixed(0)}m`);
      } else {
        console.log(`  OSM: no polygon found`);
      }
    } catch (e) {
      console.log(`  OSM: query failed (${(e as Error).message})`);
    }
  }

  const pngBuf = await renderFootprintOverlay(grid, sat.rgb, sat.w, sat.h, {
    resolution: 4, lat: b.lat, lng: b.lng, zoom: b.zoom,
    osmPolygon,
  });
  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  → ${(jpgBuf.length / 1024).toFixed(0)}KB`);

  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone!');
