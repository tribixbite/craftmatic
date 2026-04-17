#!/usr/bin/env bun
/**
 * Headless Google 3D Tiles downloader + GLB exporter — thin CLI over the
 * pure `captureTiles()` function in `src/pipeline/capture/tiles.ts`.
 *
 * This script stays around as a debug tool during the rearchitecture.
 * Production workflows use `scripts/build.ts` (added in Chunk 9).
 *
 * Usage:
 *   bun scripts/tiles-headless.ts "240 Highland St, Newton, MA" -r 50 -o output/tiles/test.glb
 *   bun scripts/tiles-headless.ts --lat=42.3435 --lng=-71.2092 -r 50 -o output/tiles/test.glb
 */

import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

import { computeBuildingAlignment } from '../src/convert/building-alignment.js';
import { searchOSMBuilding } from '../src/gen/api/osm.js';
import { captureTiles } from '../src/pipeline/capture/tiles.js';

// ─── CLI parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const addressParts: string[] = [];
let lat: number | null = null;
let lng: number | null = null;
let radius = 50;
let outputPath = '';
let timeout = 120_000;
let cameraMode: 'ortho' | 'perspective' | 'street' = 'ortho';
let multiAngle = false;
let buildingHeight = 0;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--lat=')) lat = parseFloat(a.split('=')[1]);
  else if (a.startsWith('--lng=')) lng = parseFloat(a.split('=')[1]);
  else if (a === '-r' || a === '--radius') radius = parseInt(args[++i]);
  else if (a.startsWith('-r') && a.length > 2) radius = parseInt(a.slice(2));
  else if (a === '-o' || a === '--output') outputPath = args[++i];
  else if (a === '-t' || a === '--timeout') timeout = parseInt(args[++i]) * 1000;
  else if (a === '--multi-angle') multiAngle = true;
  else if (a === '--height' && i + 1 < args.length) buildingHeight = parseFloat(args[++i]);
  else if (a.startsWith('--height=')) buildingHeight = parseFloat(a.split('=')[1]);
  else if (a === '--camera' && i + 1 < args.length) {
    const mode = args[++i];
    if (mode === 'ortho' || mode === 'perspective' || mode === 'street') cameraMode = mode;
    else { console.error(`Unknown camera mode: ${mode}`); process.exit(1); }
  } else if (!a.startsWith('-')) {
    addressParts.push(a);
  }
}
const address = addressParts.join(' ');

if (!address && (lat === null || lng === null)) {
  console.error('Usage: bun scripts/tiles-headless.ts "address" -r 50 -o output.glb');
  console.error('   or: bun scripts/tiles-headless.ts --lat=42.3 --lng=-71.2 -r 50 -o output.glb');
  process.exit(1);
}

// ─── API key ───────────────────────────────────────────────────────────────

const projectRoot = resolve(import.meta.dir, '..');
const envPath = resolve(projectRoot, '.env');
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const apiKey = process.env['GOOGLE_MAPS_API_KEY']
  ?? envText.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error('Error: GOOGLE_MAPS_API_KEY not set (env or .env file)');
  process.exit(1);
}

// ─── Geocode if needed ────────────────────────────────────────────────────

if (!lat || !lng) {
  console.log(`Geocoding: ${address}`);
  const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const geoResp = await fetch(geoUrl);
  const geoData = await geoResp.json() as { results: Array<{ geometry: { location: { lat: number; lng: number } }; formatted_address: string }> };
  if (!geoData.results?.length) {
    console.error('Geocoding failed:', JSON.stringify(geoData));
    process.exit(1);
  }
  lat = geoData.results[0].geometry.location.lat;
  lng = geoData.results[0].geometry.location.lng;
  console.log(`  → ${geoData.results[0].formatted_address} (${lat}, ${lng})`);
}

if (!outputPath) {
  const slug = address ? address.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) : `${lat!.toFixed(4)}-${lng!.toFixed(4)}`;
  outputPath = resolve(projectRoot, `output/tiles/tiles-${slug}.glb`);
} else {
  outputPath = resolve(projectRoot, outputPath);
}

// ─── Optional OSM alignment lookup ────────────────────────────────────────

let rotationDeg: number | null = null;
try {
  const osmResult = await searchOSMBuilding(lat!, lng!, 150);
  if (osmResult?.polygon && osmResult.polygon.length >= 3) {
    const align = computeBuildingAlignment(osmResult.polygon, lat!, lng!);
    rotationDeg = align.rotationDeg;
    console.log(`Building alignment: ${align.rotationDeg.toFixed(1)}° MBR ${align.mbrWidth.toFixed(0)}×${align.mbrDepth.toFixed(0)}m`);
  }
} catch {
  console.warn('OSM alignment lookup failed — using default camera angles');
}

// ─── Delegate to pipeline ──────────────────────────────────────────────────

console.log(`\nTarget: lat=${lat}, lng=${lng}, radius=${radius}m`);
console.log(`Output: ${outputPath}`);
console.log(`Camera: ${cameraMode}${buildingHeight ? ` height=${buildingHeight}m` : ''}`);

const effectiveHeight = buildingHeight || 60;
const bandHeight = 100;
const numBands = Math.max(1, Math.ceil(effectiveHeight / bandHeight));

const startTime = Date.now();
const evidence = await captureTiles({
  center: { lat: lat!, lng: lng! },
  radiusM: radius,
  errorTarget: multiAngle ? 2.0 : 4.0,
  verticalBands: multiAngle ? numBands : 0,
  cameraMode,
  expectedHeightM: effectiveHeight,
  rotationDeg,
  apiKey,
  projectRoot,
  outputPath,
  timeoutMs: timeout,
  onProgress: ({ message }) => console.log(`  ${message}`),
});
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// ─── Report ────────────────────────────────────────────────────────────────

const { measuredBbox } = evidence;
const size = {
  x: measuredBbox.max.x - measuredBbox.min.x,
  y: measuredBbox.max.y - measuredBbox.min.y,
  z: measuredBbox.max.z - measuredBbox.min.z,
};
console.log(`\nDone in ${elapsed}s`);
console.log(`  meshes:      ${evidence.meshCount}`);
console.log(`  bbox:        ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} m`);
console.log(`  truncated:   ${evidence.truncated}`);
console.log(`  no coverage: ${evidence.noCoverage}`);
console.log(`  GLB path:    ${evidence.glbPath}`);
console.log(`  heightmap:   ${evidence.heightmapWidth} × ${evidence.heightmapLength}`);

if (evidence.noCoverage) {
  console.error('\nNo meshes captured. Possible issues:');
  console.error('  - API key may not have 3D Tiles enabled');
  console.error('  - Location may not have 3D coverage');
  console.error('  - Radius too small or errorTarget too high');
  process.exit(1);
}

console.log(`\nFeed to the voxelizer:`);
console.log(`  bun scripts/voxelize-glb.ts ${outputPath} -r 4 -m surface --generic --fill -o output/tiles/result.schem`);
