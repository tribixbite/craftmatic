#!/usr/bin/env bun
/**
 * Download higher-zoom satellite images for weak buildings.
 * v12 satellites were all zoom 20. Some buildings need tighter zoom
 * to reduce tree canopy contamination and improve building isolation.
 */
import { resolve, join } from 'path';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import sharp from 'sharp';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const TILES_DIR = join(PROJECT_ROOT, 'output/tiles');

// Try multiple key sources
let API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
if (!API_KEY) {
  const keyFile = join(PROJECT_ROOT, '.google-api-key');
  if (existsSync(keyFile)) API_KEY = (await readFile(keyFile, 'utf-8')).trim();
}
if (!API_KEY) {
  console.error('Set GOOGLE_MAPS_API_KEY env var or create .google-api-key');
  process.exit(1);
}

interface Building {
  name: string;
  lat: number;
  lng: number;
  zoom: number;
}

// Buildings that scored <=4 in v20, with optimized zoom levels
// Higher zoom = tighter crop = less tree/context contamination
const BUILDINGS: Building[] = [
  // Austin: zoom 21 to see roof through tree gaps
  { name: 'austin', lat: 30.3714, lng: -97.8206, zoom: 21 },
  // SuttonsBay: zoom 21 for tighter building isolation
  { name: 'suttonsbay', lat: 44.8946, lng: -85.6412, zoom: 21 },
  // SF: zoom 21 to reduce urban context bleed
  { name: 'sf', lat: 37.8011, lng: -122.4439, zoom: 21 },
  // Charleston: zoom 21 tighter
  { name: 'charleston', lat: 32.7744, lng: -79.9345, zoom: 21 },
  // SanJose: zoom 20 (already tight enough, problem is complexity)
  { name: 'sanjose', lat: 37.3183, lng: -121.9511, zoom: 20 },
  // Byron: zoom 21 (probably still tree-covered)
  { name: 'byron', lat: 42.8350, lng: -85.7236, zoom: 21 },
  // Seattle: zoom 21
  { name: 'seattle', lat: 47.5389, lng: -122.3942, zoom: 21 },
];

for (const b of BUILDINGS) {
  const outPath = join(TILES_DIR, `${b.name}-v21-satellite.jpg`);
  if (existsSync(outPath)) {
    console.log(`  ${b.name}: cached`);
    continue;
  }

  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${b.lat},${b.lng}&zoom=${b.zoom}&size=640x640&maptype=satellite&key=${API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`  ${b.name}: ERROR ${resp.status}`);
    continue;
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const jpg = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpg);
  console.log(`  ${b.name}: z${b.zoom} ${(jpg.length / 1024).toFixed(0)}KB`);
}
console.log('Done.');
