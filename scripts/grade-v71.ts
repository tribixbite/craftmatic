#!/usr/bin/env bun
/**
 * Create satellite|top-down|isometric composite grading images for v71.
 * 3-panel layout: satellite (footprint context) | top-down (footprint shape) | isometric (3D form)
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

// ENU horizontal rotation angles from voxelization output (degrees).
// Used to rotate the top-down voxel render back to satellite orientation
// so VLM can directly compare footprints without mental rotation.
// ENU rotation angles — PCA-optimal, used to rotate top-down back to north-up
const BUILDINGS: Record<string, { lat: number; lng: number; enuDeg: number }> = {
  green:     { lat: 37.7966, lng: -122.4393, enuDeg: 0 },    // snapped from 14°
  dakota:    { lat: 40.7764, lng: -73.9762,  enuDeg: 90 },   // snapped from 75°
  sentinel:  { lat: 37.7957, lng: -122.4067, enuDeg: 39 },
  francisco: { lat: 37.7990, lng: -122.4372, enuDeg: 39 },
  beach:     { lat: 37.8004, lng: -122.4365, enuDeg: 40 },
  chestnut:  { lat: 37.8007, lng: -122.4378, enuDeg: 37 },
  flatiron:  { lat: 40.7411, lng: -73.9897,  enuDeg: 51 },
};

let apiKey = '';
try {
  const dotenv = await Bun.file(join(projectRoot, '.env')).text();
  apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim() ?? '';
} catch { /* no .env */ }

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

const H = 300; // Panel height

for (const [name, coords] of Object.entries(BUILDINGS)) {
  if (filterName && name !== filterName) continue;
  const isoPath = join(tilesDir, 'render-v71', `iso-${name}.jpg`);
  const topPath = join(tilesDir, 'render-v71', `top-${name}.jpg`);
  if (!existsSync(isoPath)) { console.log(`${name}: SKIP (no render)`); continue; }

  console.log(`=== ${name} ===`);

  // Satellite at zoom 20, rotated to match voxel grid orientation.
  // Rotating satellite by +enuDeg aligns building walls in both images,
  // giving VLM the best direct comparison (both show same orientation).
  const satUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${coords.lat},${coords.lng}&zoom=20&size=400x400&maptype=satellite&key=${apiKey}`;
  const satRes = await fetch(satUrl);
  if (!satRes.ok) { console.log(`  satellite: HTTP ${satRes.status}`); continue; }
  const satBuf = Buffer.from(await satRes.arrayBuffer());
  const satImg = await sharp(satBuf)
    .rotate(coords.enuDeg, { background: { r: 22, g: 22, b: 28, alpha: 1 } })
    .resize(H, H, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();

  // Top-down plan view — NO rotation, shown in voxel grid orientation.
  // Satellite is rotated to match instead.
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

  // Isometric 3D view
  const isoImg = await sharp(await readFile(isoPath))
    .resize({ height: H, withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();
  const isoMeta = await sharp(isoImg).metadata();
  const isoW = isoMeta.width ?? H;

  // 3-panel composite: satellite | top-down | isometric
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
