#!/usr/bin/env bun
/**
 * Render satellite-colored top-down views for v26 schematics (r=4).
 * Uses the same satellite color + hillshade approach as v20, but on
 * higher-resolution (4 blocks/meter) voxel grids.
 *
 * Usage: bun scripts/render-v26-test.ts [--name=newton]
 */
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderSatelliteColored } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const tilesDir = join(resolve(import.meta.dir, '..'), 'output/tiles');

interface Building {
  name: string;
  lat: number;
  satFile: string;
  zoom: number;
}

// All 12 buildings — z21 only for SF, z20 for rest
const BUILDINGS: Building[] = [
  { name: 'sf',          lat: 37.8011, satFile: 'v21-satellite', zoom: 21 },
  { name: 'newton',      lat: 42.3435, satFile: 'v12-satellite', zoom: 20 },
  { name: 'sanjose',     lat: 37.3183, satFile: 'v12-satellite', zoom: 20 },
  { name: 'walpole',     lat: 43.0775, satFile: 'v12-satellite', zoom: 20 },
  { name: 'byron',       lat: 42.8350, satFile: 'v12-satellite', zoom: 20 },
  { name: 'vinalhaven',  lat: 44.1172, satFile: 'v12-satellite', zoom: 20 },
  { name: 'suttonsbay',  lat: 44.8946, satFile: 'v12-satellite', zoom: 20 },
  { name: 'losangeles',  lat: 34.1162, satFile: 'v12-satellite', zoom: 20 },
  { name: 'seattle',     lat: 47.5389, satFile: 'v12-satellite', zoom: 20 },
  { name: 'austin',      lat: 30.3714, satFile: 'v12-satellite', zoom: 20 },
  { name: 'minneapolis', lat: 45.0180, satFile: 'v12-satellite', zoom: 20 },
  { name: 'charleston',  lat: 32.7744, satFile: 'v12-satellite', zoom: 20 },
];

const RESOLUTION = 4; // v26 = 4 blocks/meter

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const b of BUILDINGS) {
  if (filterName && b.name !== filterName) continue;

  const schemPath = join(tilesDir, `${b.name}-v26.schem`);
  const satPath = join(tilesDir, `${b.name}-${b.satFile}.jpg`);
  const outPath = join(tilesDir, `${b.name}-v26-sathill-td.jpg`);

  if (!existsSync(schemPath)) {
    console.log(`  ${b.name}: SKIP (no v26 schem)`);
    continue;
  }
  if (!existsSync(satPath)) {
    console.log(`  ${b.name}: SKIP (no satellite)`);
    continue;
  }

  console.log(`=== ${b.name} (z${b.zoom}, r=4) ===`);

  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

  const satMeta = await sharp(satPath).metadata();
  const satW = satMeta.width!;
  const satH = satMeta.height!;
  const satRgb = await sharp(satPath).removeAlpha().raw().toBuffer();

  // Use scale=6 for r=4 grids (slightly smaller blocks since there are more of them)
  const pngBuf = await renderSatelliteColored(grid, satRgb, satW, satH, {
    resolution: RESOLUTION,
    lat: b.lat,
    zoom: b.zoom,
    scale: 6,
  });

  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  → ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)\n`);
}

console.log('Done! v26 satellite-colored renders in output/tiles/');
