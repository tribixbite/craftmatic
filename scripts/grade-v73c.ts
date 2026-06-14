#!/usr/bin/env bun
/**
 * Grade composites for v73c buildings (peaked roof test).
 * 3-panel: satellite (rotated to match voxel grid) | top-down | isometric
 */
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const gradeDir = join(tilesDir, 'grade-v73c');
await mkdir(gradeDir, { recursive: true });

let apiKey = '';
try {
  const dotenv = await Bun.file(join(projectRoot, '.env')).text();
  apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim() ?? '';
} catch { /* no .env */ }

const BUILDINGS: Record<string, { lat: number; lng: number; enuDeg: number }> = {
  flatiron:            { lat: 40.7411,   lng: -73.9897,   enuDeg: 51 },
  montgomery:          { lat: 37.7954,   lng: -122.4029,  enuDeg: 39 },
  willis:              { lat: 41.8789,   lng: -87.6359,   enuDeg: 50 },
  'flatroof-portland': { lat: 45.5235,   lng: -122.6827,  enuDeg: 0 },
  'flatroof-sandiego': { lat: 32.7158,   lng: -117.1672,  enuDeg: 27 },
};

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;
const H = 300;

for (const [name, coords] of Object.entries(BUILDINGS)) {
  if (filterName && name !== filterName) continue;
  // v73c renders for peaked-roof builds; fall back to v73 for flatiron
  let renderDir = join(tilesDir, 'render-v73c');
  if (!existsSync(join(renderDir, `iso-${name}.jpg`))) {
    renderDir = join(tilesDir, 'render-v73');
  }
  const isoPath = join(renderDir, `iso-${name}.jpg`);
  const topPath = join(renderDir, `top-${name}.jpg`);
  if (!existsSync(isoPath)) { console.log(`${name}: SKIP (no render)`); continue; }

  console.log(`=== ${name} ===`);

  const satUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${coords.lat},${coords.lng}&zoom=20&size=400x400&maptype=satellite&key=${apiKey}`;
  const satRes = await fetch(satUrl);
  if (!satRes.ok) { console.log(`  satellite: HTTP ${satRes.status}`); continue; }
  const satBuf = Buffer.from(await satRes.arrayBuffer());
  const satImg = await sharp(satBuf)
    .rotate(coords.enuDeg, { background: { r: 22, g: 22, b: 28, alpha: 1 } })
    .resize(H, H, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();

  let topImg: Buffer;
  if (existsSync(topPath)) {
    topImg = await sharp(await readFile(topPath))
      .resize({ height: H, withoutEnlargement: false })
      .jpeg({ quality: 90 })
      .toBuffer();
  } else {
    topImg = await sharp({ create: { width: H, height: H, channels: 3, background: { r: 22, g: 22, b: 28 } } })
      .jpeg({ quality: 90 }).toBuffer();
  }
  const topMeta = await sharp(topImg).metadata();
  const topW = topMeta.width ?? H;

  const isoImg = await sharp(await readFile(isoPath))
    .resize({ height: H, withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();
  const isoMeta = await sharp(isoImg).metadata();
  const isoW = isoMeta.width ?? H;

  const totalW = H + topW + isoW;
  const composite = await sharp({
    create: { width: totalW, height: H, channels: 3, background: { r: 22, g: 22, b: 28 } },
  })
    .composite([
      { input: satImg, left: 0, top: 0 },
      { input: topImg, left: H, top: 0 },
      { input: isoImg, left: H + topW, top: 0 },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();

  await writeFile(join(gradeDir, `${name}.jpg`), composite);
  console.log(`  -> ${(composite.length / 1024).toFixed(0)}KB (${totalW}x${H})`);
}
console.log('\nDone!');
