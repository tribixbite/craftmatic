#!/usr/bin/env bun
/**
 * Render satellite-colored top-down views for all v16 schematics.
 * Projects Google Static Maps satellite image colors onto voxel heightmap geometry.
 * Usage: bun scripts/render-satellite-colored.ts [--name=newton]
 */
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderSatelliteColored } from '../src/render/png-renderer.js';

sharp.concurrency(1);

const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');

interface Building {
  name: string;
  lat: number;
  zoom: number;
}

// All 12 buildings with their geocode lat and satellite zoom level
// All v12 satellites were fetched at zoom 20
const BUILDINGS: Building[] = [
  { name: 'sf',          lat: 37.8011, zoom: 20 },
  { name: 'newton',      lat: 42.3435, zoom: 20 },
  { name: 'sanjose',     lat: 37.3183, zoom: 20 },
  { name: 'walpole',     lat: 43.0775, zoom: 20 },
  { name: 'byron',       lat: 42.8350, zoom: 20 },
  { name: 'vinalhaven',  lat: 44.1172, zoom: 20 },
  { name: 'suttonsbay',  lat: 44.8946, zoom: 20 },
  { name: 'losangeles',  lat: 34.1162, zoom: 20 },
  { name: 'seattle',     lat: 47.5389, zoom: 20 },
  { name: 'austin',      lat: 30.3714, zoom: 20 },
  { name: 'minneapolis', lat: 45.0180, zoom: 20 },
  { name: 'charleston',  lat: 32.7744, zoom: 20 },
];

const RESOLUTION = 3; // v16 was voxelized at 3 blocks/meter

// Parse --name=X filter
const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const b of BUILDINGS) {
  if (filterName && b.name !== filterName) continue;

  const schemPath = join(tilesDir, `${b.name}-v16.schem`);
  const satPath = join(tilesDir, `${b.name}-v12-satellite.jpg`);
  const outPath = join(tilesDir, `${b.name}-v20-sathill-td.jpg`);

  if (!existsSync(schemPath)) {
    console.log(`  ${b.name}: SKIP (no v16 schem)`);
    continue;
  }
  if (!existsSync(satPath)) {
    console.log(`  ${b.name}: SKIP (no satellite image)`);
    continue;
  }

  console.log(`=== ${b.name} ===`);

  // Load schematic
  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

  // Load satellite image as raw RGB pixels
  const satMeta = await sharp(satPath).metadata();
  const satW = satMeta.width!;
  const satH = satMeta.height!;
  const satRgb = await sharp(satPath)
    .removeAlpha()
    .raw()
    .toBuffer();
  console.log(`  Satellite: ${satW}x${satH}`);

  // Compute coverage info for diagnostics
  const DEG2RAD = Math.PI / 180;
  const metersPerPx = 156543.03392 * Math.cos(b.lat * DEG2RAD) / Math.pow(2, b.zoom);
  const coverageM = satW * metersPerPx;
  const gridExtentM = Math.max(grid.width, grid.length) / RESOLUTION;
  console.log(`  Coverage: ${coverageM.toFixed(1)}m satellite vs ${gridExtentM.toFixed(1)}m grid`);

  // Render satellite-colored top-down
  const pngBuf = await renderSatelliteColored(grid, satRgb, satW, satH, {
    resolution: RESOLUTION,
    lat: b.lat,
    zoom: b.zoom,
    scale: 8,
  });

  // Convert to JPEG
  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  → ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)`);
  console.log('');
}

console.log('Done! Satellite-colored renders in output/tiles/');
