#!/usr/bin/env bun
/** Download satellite images for all 12 v12 evaluation addresses. */
import { resolve, join } from 'path';
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import sharp from 'sharp';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const TILES_DIR = join(PROJECT_ROOT, 'output/tiles');

// Try multiple key sources
const API_KEY = process.env.GOOGLE_MAPS_API_KEY
  ?? process.env.GOOGLE_STREETVIEW_KEY
  ?? (() => {
    // Read from localStorage backup file if available
    try {
      const keyFile = join(PROJECT_ROOT, '.google-api-key');
      if (existsSync(keyFile)) return Bun.file(keyFile).text();
    } catch {}
    return '';
  })();

if (!API_KEY) {
  console.error('Set GOOGLE_MAPS_API_KEY env var');
  process.exit(1);
}

interface Building {
  name: string;
  address: string;
  zoom: number;
}

const BUILDINGS: Building[] = [
  { name: 'sf', address: '2340 Francisco St, San Francisco, CA 94123', zoom: 20 },
  { name: 'newton', address: '240 Highland St, Newton, MA 02465', zoom: 20 },
  { name: 'sanjose', address: '525 S Winchester Blvd, San Jose, CA 95128', zoom: 20 },
  { name: 'walpole', address: '13 Union St, Walpole, NH 03608', zoom: 20 },
  { name: 'byron', address: '2431 72nd St SW, Byron Center, MI 49315', zoom: 20 },
  { name: 'vinalhaven', address: '216 Zekes Point Rd, Vinalhaven, ME 04863', zoom: 20 },
  { name: 'suttonsbay', address: '5835 S Bridget Rose Ln, Suttons Bay, MI 49682', zoom: 20 },
  { name: 'losangeles', address: '2607 Glendower Ave, Los Angeles, CA 90027', zoom: 20 },
  { name: 'seattle', address: '4810 SW Ledroit Pl, Seattle, WA 98136', zoom: 20 },
  { name: 'austin', address: '8504 Long Canyon Dr, Austin, TX 78730', zoom: 20 },
  { name: 'minneapolis', address: '2730 Ulysses St NE, Minneapolis, MN 55418', zoom: 20 },
  { name: 'charleston', address: '41 Legare St, Charleston, SC 29401', zoom: 20 },
];

async function geocode(address: string): Promise<{ lat: number; lng: number }> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json() as { results: Array<{ geometry: { location: { lat: number; lng: number } } }> };
  if (!data.results?.length) throw new Error(`No geocode for: ${address}`);
  return data.results[0].geometry.location;
}

async function downloadSatellite(lat: number, lng: number, name: string, zoom: number): Promise<void> {
  const outPath = join(TILES_DIR, `${name}-v12-satellite.jpg`);
  if (existsSync(outPath)) {
    console.log(`  ${name}: cached`);
    return;
  }

  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=satellite&key=${API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Static maps ${resp.status}: ${await resp.text()}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const jpg = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpg);
  console.log(`  ${name}: ${(jpg.length / 1024).toFixed(0)}KB (${lat.toFixed(4)}, ${lng.toFixed(4)}, z${zoom})`);
}

for (const b of BUILDINGS) {
  try {
    const geo = await geocode(b.address);
    await downloadSatellite(geo.lat, geo.lng, b.name, b.zoom);
  } catch (err) {
    console.error(`  ${b.name} ERROR: ${(err as Error).message}`);
  }
}
console.log('Done.');
