#!/usr/bin/env bun
import { writeFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderFootprintOverlay } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const outDir = join(tilesDir, 'overlay');
await mkdir(outDir, { recursive: true });

const dotenv = await Bun.file(join(projectRoot, '.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();

const grid = await parseToGrid(join(tilesDir, 'transamerica-headless-v26.schem'));
console.log('Grid:', grid.width, 'x', grid.height, 'x', grid.length);

const satUrl = `https://maps.googleapis.com/maps/api/staticmap?center=37.7952,-122.4028&zoom=19&size=640x640&maptype=satellite&key=${apiKey}`;
const satBuf = Buffer.from(await (await fetch(satUrl)).arrayBuffer());
const satMeta = await sharp(satBuf).metadata();
const satRgb = await sharp(satBuf).removeAlpha().raw().toBuffer();

// Default threshold (0.15)
const png1 = await renderFootprintOverlay(grid, satRgb, satMeta.width!, satMeta.height!, {
  resolution: 4, lat: 37.7952, zoom: 19,
});
await writeFile(join(outDir, 'ov-transamerica-headless-v26.jpg'),
  await sharp(png1).jpeg({ quality: 90 }).toBuffer());
console.log('Default threshold done');

// Higher threshold (0.4) — should exclude more ground
const png2 = await renderFootprintOverlay(grid, satRgb, satMeta.width!, satMeta.height!, {
  resolution: 4, lat: 37.7952, zoom: 19, heightThreshold: 0.4,
});
await writeFile(join(outDir, 'ov-transamerica-headless-v26-ht40.jpg'),
  await sharp(png2).jpeg({ quality: 90 }).toBuffer());
console.log('40% threshold done');

// Also re-render Dakota and Geisel with higher threshold
for (const [name, lat, zoom] of [
  ['dakota-v26', 40.7766, 20],
  ['geisel-headless-v26', 32.8812, 20],
  ['guggenheim-headless-v26', 40.7830, 20],
] as const) {
  const g = await parseToGrid(join(tilesDir, `${name}.schem`));
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},-${
    name.includes('dakota') ? '73.9762' : name.includes('geisel') ? '117.2376' : '73.9590'
  }&zoom=${zoom}&size=640x640&maptype=satellite&key=${apiKey}`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const meta = await sharp(buf).metadata();
  const rgb = await sharp(buf).removeAlpha().raw().toBuffer();

  const png = await renderFootprintOverlay(g, rgb, meta.width!, meta.height!, {
    resolution: 4, lat: lat as number, zoom: zoom as number, heightThreshold: 0.4,
  });
  await writeFile(join(outDir, `ov-${name}-ht40.jpg`),
    await sharp(png).jpeg({ quality: 90 }).toBuffer());
  console.log(`${name} ht40 done`);
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
