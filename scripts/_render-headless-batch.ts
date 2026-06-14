#!/usr/bin/env bun
/**
 * Render satellite-colored views for all headless captures.
 * Fetches satellite imagery, renders with hillshade.
 */
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderSatelliteColored } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const tilesDir = join(resolve(import.meta.dir, '..'), 'output/tiles');

// Load API key
const dotenv = await Bun.file(resolve(import.meta.dir, '../.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) { console.error('No API key'); process.exit(1); }

interface Building {
  name: string;
  lat: number;
  lng: number;
  zoom: number;
}

const BUILDINGS: Building[] = [
  { name: 'tiles-dallas-headless',       lat: 32.8512, lng: -96.8277, zoom: 20 },
  { name: 'tiles-scottsdale-headless',    lat: 33.4877, lng: -111.926, zoom: 20 },
  { name: 'tiles-dallas2-headless',       lat: 32.8220, lng: -96.8085, zoom: 20 },
  { name: 'tiles-winnetka-headless',      lat: 42.1057, lng: -87.7325, zoom: 20 },
  { name: 'tiles-cambridge-headless',     lat: 42.3766, lng: -71.1227, zoom: 20 },
  { name: 'tiles-arlington-headless',     lat: 38.8824, lng: -77.1085, zoom: 20 },
  { name: 'tiles-bellaire-headless',      lat: 29.6931, lng: -95.4678, zoom: 20 },
  { name: 'tiles-artinstitute-headless',  lat: 41.8796, lng: -87.6237, zoom: 20 },
  { name: 'test-newton-headless',         lat: 42.3435, lng: -71.2215, zoom: 20 },
];

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;
const RESOLUTION = 4;
const SCALE = 6;

for (const b of BUILDINGS) {
  if (filterName && !b.name.includes(filterName)) continue;
  const schemPath = join(tilesDir, `${b.name}-v26.schem`);
  const outPath = join(tilesDir, `sv-${b.name}.jpg`);
  
  if (!existsSync(schemPath)) {
    console.log(`  ${b.name}: SKIP (no schem)`);
    continue;
  }
  
  console.log(`=== ${b.name} ===`);
  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length}`);
  
  // Fetch satellite image
  const satUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${b.lat},${b.lng}&zoom=${b.zoom}&size=640x640&maptype=satellite&key=${apiKey}`;
  const satResp = await fetch(satUrl);
  const satBuf = Buffer.from(await satResp.arrayBuffer());
  const satMeta = await sharp(satBuf).metadata();
  const satW = satMeta.width!;
  const satH = satMeta.height!;
  const satRgb = await sharp(satBuf).removeAlpha().raw().toBuffer();
  
  const pngBuf = await renderSatelliteColored(grid, satRgb, satW, satH, {
    resolution: RESOLUTION, lat: b.lat, zoom: b.zoom, scale: SCALE,
  });
  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  → ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)\n`);
}
console.log('Done!');
