#!/usr/bin/env bun
/**
 * Render satellite-colored top-down views for replacement building schematics.
 * These are candidates to replace low-scoring buildings in the v26 evaluation set.
 *
 * Usage: bun scripts/render-replacements.ts [--name=flatiron]
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
  schemFile: string;
}

// Replacement candidates — all voxelized at r=4
const BUILDINGS: Building[] = [
  { name: 'flatiron',    lat: 40.7411, satFile: 'flatiron-satellite',    zoom: 20, schemFile: 'flatiron-v26.schem' },
  { name: 'stpatricks',  lat: 40.7585, satFile: 'st-patricks-satellite', zoom: 20, schemFile: 'stpatricks-v26.schem' },
  { name: 'baker',       lat: 37.8003, satFile: 'baker-3170-satellite',  zoom: 20, schemFile: 'baker-v26.schem' },
  { name: 'green',       lat: 37.7983, satFile: 'green-2390-satellite',  zoom: 20, schemFile: 'green-v26.schem' },
];

const RESOLUTION = 4;

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const b of BUILDINGS) {
  if (filterName && b.name !== filterName) continue;

  const schemPath = join(tilesDir, b.schemFile);
  const satPath = join(tilesDir, `${b.satFile}.jpg`);
  const outPath = join(tilesDir, `${b.name}-v26-sathill-td.jpg`);

  if (!existsSync(schemPath)) {
    console.log(`  ${b.name}: SKIP (no schem at ${b.schemFile})`);
    continue;
  }
  if (!existsSync(satPath)) {
    console.log(`  ${b.name}: SKIP (no satellite at ${b.satFile}.jpg)`);
    continue;
  }

  console.log(`=== ${b.name} (z${b.zoom}, r=4) ===`);

  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

  const satMeta = await sharp(satPath).metadata();
  const satW = satMeta.width!;
  const satH = satMeta.height!;
  const satRgb = await sharp(satPath).removeAlpha().raw().toBuffer();

  // scale=6 for r=4 grids (same as v26 batch)
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

console.log('Done! Replacement renders in output/tiles/');
