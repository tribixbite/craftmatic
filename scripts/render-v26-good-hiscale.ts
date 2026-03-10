#!/usr/bin/env bun
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderSatelliteColored } from '../src/render/png-renderer.js';
sharp.concurrency(1);
const tilesDir = join(resolve(import.meta.dir, '..'), 'output/tiles');
const BUILDINGS = [
  { name: 'newton',  lat: 42.3435, satFile: 'v12-satellite', zoom: 20 },
  { name: 'walpole', lat: 43.0775, satFile: 'v12-satellite', zoom: 20 },
  { name: 'sanjose', lat: 37.3183, satFile: 'v12-satellite', zoom: 20 },
];
for (const b of BUILDINGS) {
  const schemPath = join(tilesDir, `${b.name}-v26.schem`);
  const satPath = join(tilesDir, `${b.name}-${b.satFile}.jpg`);
  const outPath = join(tilesDir, `${b.name}-v26-hiscale-td.jpg`);
  if (!existsSync(schemPath) || !existsSync(satPath)) { console.log(`${b.name}: SKIP`); continue; }
  console.log(`=== ${b.name} ===`);
  const grid = await parseToGrid(schemPath);
  const satMeta = await sharp(satPath).metadata();
  const satRgb = await sharp(satPath).removeAlpha().raw().toBuffer();
  const pngBuf = await renderSatelliteColored(grid, satRgb, satMeta.width!, satMeta.height!, {
    resolution: 4, lat: b.lat, zoom: b.zoom, scale: 10,
  });
  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  → ${(jpgBuf.length / 1024).toFixed(0)}KB`);
}
