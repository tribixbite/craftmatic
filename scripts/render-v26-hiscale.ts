#!/usr/bin/env bun
/**
 * Render v26 schematics at higher scale (10px/block instead of 6) to test
 * whether larger output images improve VLM evaluation scores.
 *
 * Usage: bun scripts/render-v26-hiscale.ts [--name=minneapolis]
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

// Buildings to re-render at higher scale
const BUILDINGS: Building[] = [
  { name: 'minneapolis', lat: 45.0180, satFile: 'v12-satellite', zoom: 20 },
  { name: 'losangeles',  lat: 34.1162, satFile: 'v12-satellite', zoom: 20 },
  { name: 'sf',          lat: 37.8011, satFile: 'v21-satellite', zoom: 21 },
  { name: 'seattle',     lat: 47.5389, satFile: 'v12-satellite', zoom: 20 },
  { name: 'austin',      lat: 30.3714, satFile: 'v12-satellite', zoom: 20 },
  { name: 'charleston',  lat: 32.7744, satFile: 'v12-satellite', zoom: 20 },
];

const RESOLUTION = 4;
const SCALE = 10; // higher than v26's scale=6

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const b of BUILDINGS) {
  if (filterName && b.name !== filterName) continue;

  const schemPath = join(tilesDir, `${b.name}-v26.schem`);
  const satPath = join(tilesDir, `${b.name}-${b.satFile}.jpg`);
  const outPath = join(tilesDir, `${b.name}-v26-hiscale-td.jpg`);

  if (!existsSync(schemPath)) {
    console.log(`  ${b.name}: SKIP (no v26 schem)`);
    continue;
  }
  if (!existsSync(satPath)) {
    console.log(`  ${b.name}: SKIP (no satellite)`);
    continue;
  }

  console.log(`=== ${b.name} (z${b.zoom}, r=4, scale=${SCALE}) ===`);

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
  console.log(`  → ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)\n`);
}

console.log('Done! High-scale renders in output/tiles/');
