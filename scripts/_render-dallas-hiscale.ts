#!/usr/bin/env bun
import { writeFile } from 'fs/promises';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderSatelliteColored } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const tilesDir = join(resolve(import.meta.dir, '..'), 'output/tiles');

const dotenv = await Bun.file(resolve(import.meta.dir, '../.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim()!;

const builds = [
  { name: 'tiles-dallas-headless', lat: 32.8512, lng: -96.8277, zoom: 20 },
  { name: 'tiles-winnetka-headless', lat: 42.1057, lng: -87.7325, zoom: 20 },
  { name: 'tiles-cambridge-headless', lat: 42.3766, lng: -71.1227, zoom: 20 },
  { name: 'tiles-bellaire-headless', lat: 29.6931, lng: -95.4678, zoom: 20 },
  { name: 'test-newton-headless', lat: 42.3435, lng: -71.2215, zoom: 20 },
];

for (const b of builds) {
  const schemPath = join(tilesDir, `${b.name}-v26.schem`);
  const outPath = join(tilesDir, `sv-${b.name}-s10.jpg`);
  
  if (!(await Bun.file(schemPath).exists())) {
    console.log(`  ${b.name}: SKIP`);
    continue;
  }
  
  console.log(`=== ${b.name} (scale=10) ===`);
  const grid = await parseToGrid(schemPath);
  
  const satUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${b.lat},${b.lng}&zoom=${b.zoom}&size=640x640&maptype=satellite&key=${apiKey}`;
  const satBuf = Buffer.from(await (await fetch(satUrl)).arrayBuffer());
  const satMeta = await sharp(satBuf).metadata();
  const satRgb = await sharp(satBuf).removeAlpha().raw().toBuffer();
  
  const pngBuf = await renderSatelliteColored(grid, satRgb, satMeta.width!, satMeta.height!, {
    resolution: 4, lat: b.lat, zoom: b.zoom, scale: 10,
  });
  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  → ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)\n`);
}
