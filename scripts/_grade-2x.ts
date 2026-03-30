#!/usr/bin/env bun
/**
 * Grade composites for 2x resolution buildings.
 * Reuses satellite from grade-v71, combines with 2x renders.
 */
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const gradeDir = join(tilesDir, 'grade-v71');
await mkdir(gradeDir, { recursive: true });

const apiKey = (() => {
  try {
    const dotenv = require('fs').readFileSync(join(projectRoot, '.env'), 'utf8');
    return dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim() ?? '';
  } catch { return ''; }
})();

// 2x buildings to grade — reuse same satellite coords/rotation as 1x
const BUILDINGS: Record<string, { lat: number; lng: number; enuDeg: number }> = {
  'flatiron-2x':   { lat: 40.7411, lng: -73.9897,  enuDeg: 51 },
  'sentinel-2x':   { lat: 37.7957, lng: -122.4067, enuDeg: 39 },
  'montgomery-2x': { lat: 37.7954, lng: -122.4029, enuDeg: 39 },
  'chestnut-2x':   { lat: 37.8007, lng: -122.4378, enuDeg: 37 },
};

const H = 300;
const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const [name, coords] of Object.entries(BUILDINGS)) {
  if (filterName && name !== filterName) continue;
  // 2x renders use the "-v71-2x" suffix
  const schemName = name.replace('-2x', '-v71-2x');
  const isoPath = join(tilesDir, 'render-v71', `iso-${schemName}.jpg`);
  const topPath = join(tilesDir, 'render-v71', `top-${schemName}.jpg`);
  if (!existsSync(isoPath)) { console.log(`${name}: SKIP (no iso at ${isoPath})`); continue; }

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
