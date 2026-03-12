#!/usr/bin/env bun
/**
 * Create v68 grading composites: satellite reference | isometric render
 * Side-by-side comparison images for Gemini VLM grading.
 */
import { writeFile, readFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import sharp from 'sharp';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const renderDir = join(tilesDir, 'render-v68');
const gradeDir = join(tilesDir, 'grade-v68');
await mkdir(gradeDir, { recursive: true });

// Read API key from .env
let apiKey: string | undefined;
try {
  const dotenv = await readFile(join(projectRoot, '.env'), 'utf8');
  apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
} catch { /* no .env */ }
if (!apiKey) { console.error('No GOOGLE_MAPS_API_KEY in .env'); process.exit(1); }

interface Building {
  name: string;
  lat: number;
  lng: number;
  label: string;
}

const BUILDINGS: Building[] = [
  { name: 'noe', lat: 37.7604, lng: -122.4314, label: '450 Noe St, SF' },
  { name: 'green', lat: 37.7954, lng: -122.4332, label: '2390 Green St, SF' },
  { name: 'francisco', lat: 37.8005, lng: -122.4382, label: '2340 Francisco St, SF' },
  { name: 'beach', lat: 37.8031, lng: -122.4397, label: '2130 Beach St, SF' },
  { name: 'chestnut', lat: 37.8007, lng: -122.4378, label: '2001 Chestnut St, SF' },
  { name: 'dakota', lat: 40.7766, lng: -73.9762, label: 'The Dakota, NYC' },
  { name: 'sentinel', lat: 37.7978, lng: -122.4068, label: 'Sentinel Building, SF' },
];

for (const bldg of BUILDINGS) {
  console.log(`\n=== ${bldg.label} ===`);

  // Fetch satellite reference (zoom 19 for wider building context)
  const satUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${bldg.lat},${bldg.lng}&zoom=19&size=400x400&maptype=satellite&key=${apiKey}`;
  const satRes = await fetch(satUrl);
  if (!satRes.ok) { console.log(`  Satellite: HTTP ${satRes.status}`); continue; }
  const satBuf = Buffer.from(await satRes.arrayBuffer());
  const satImg = sharp(satBuf).resize(400, 400);

  // Load isometric render
  const isoPath = join(renderDir, `iso-${bldg.name}.jpg`);
  const isoBuf = await readFile(isoPath);
  // Resize iso to match satellite height, preserving aspect ratio
  const isoMeta = await sharp(isoBuf).metadata();
  const isoH = 400;
  const isoW = Math.round((isoMeta.width! / isoMeta.height!) * isoH);
  const isoImg = sharp(isoBuf).resize(isoW, isoH, { fit: 'contain', background: { r: 30, g: 30, b: 30 } });

  // Composite side by side: [satellite | isometric]
  const totalW = 400 + isoW + 10; // 10px gap
  const composite = sharp({
    create: { width: totalW, height: 400, channels: 3, background: { r: 30, g: 30, b: 30 } }
  }).composite([
    { input: await satImg.toBuffer(), left: 0, top: 0 },
    { input: await isoImg.toBuffer(), left: 410, top: 0 },
  ]);

  const outPath = join(gradeDir, `${bldg.name}.jpg`);
  await composite.jpeg({ quality: 88 }).toFile(outPath);
  console.log(`  → ${outPath}`);

  if (typeof Bun !== 'undefined') Bun.gc(true);
}

console.log('\nDone! Check output/tiles/grade-v68/');
