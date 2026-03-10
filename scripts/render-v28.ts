#!/usr/bin/env bun
/**
 * Render v28 (r=6) schematics with satellite coloring.
 * Uses resolution=6 for correct coordinate mapping.
 * Usage: bun scripts/render-v28.ts [--name=dakota]
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

// r=6 voxelized buildings
const BUILDINGS: Building[] = [
  { name: 'dakota',      lat: 40.7764, satFile: 'dakota-satellite',         zoom: 20 },
  { name: 'minneapolis', lat: 45.0180, satFile: 'minneapolis-v12-satellite', zoom: 20 },
  { name: 'esb',         lat: 40.7484, satFile: 'esb-satellite',            zoom: 20 },
];

const RESOLUTION = 6; // r=6 = 6 blocks/meter
const SCALE = 6; // render scale per block

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const b of BUILDINGS) {
  if (filterName && b.name !== filterName) continue;

  const schemPath = join(tilesDir, `${b.name}-v28.schem`);
  const satPath = join(tilesDir, `${b.satFile}.jpg`);
  const outPath = join(tilesDir, `${b.name}-v28-sathill-td.jpg`);

  if (!existsSync(schemPath)) {
    console.log(`  ${b.name}: SKIP (no v28 schem)`);
    continue;
  }
  if (!existsSync(satPath)) {
    console.log(`  ${b.name}: SKIP (no satellite at ${b.satFile}.jpg)`);
    continue;
  }

  console.log(`=== ${b.name} (z${b.zoom}, r=6, scale=${SCALE}) ===`);

  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

  const satMeta = await sharp(satPath).metadata();
  const satW = satMeta.width!;
  const satH = satMeta.height!;
  const satRgb = await sharp(satPath).removeAlpha().raw().toBuffer();

  const pngBuf = await renderSatelliteColored(grid, satRgb, satW, satH, {
    resolution: RESOLUTION,
    lat: b.lat,
    zoom: b.zoom,
    scale: SCALE,
  });

  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  -> ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)\n`);
}

console.log('Done! v28 (r=6) renders in output/tiles/');
