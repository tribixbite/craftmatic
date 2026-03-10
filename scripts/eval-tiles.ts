#!/usr/bin/env bun
/**
 * Automated tiles voxelization evaluation via Gemini VLM.
 *
 * For each address:
 * 1. Fetch satellite image from Google Static Maps
 * 2. Load the isometric render (.jpg)
 * 3. Send both images to Gemini for unbiased comparison
 * 4. Collect scores and identify improvements
 *
 * Usage: bun scripts/eval-tiles.ts [version]
 * Default version: v7
 */
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const VERSION = process.argv[2] || 'v7';
const TILES_DIR = '/data/data/com.termux/files/home/git/craftmatic/output/tiles';
const EVAL_DIR = '/data/data/com.termux/files/home/git/craftmatic/output/tiles/eval';

// 12 grading locations with geocode coordinates
const LOCATIONS: { key: string; address: string; lat: number; lng: number }[] = [
  { key: 'sf', address: '2340 Francisco St, San Francisco, CA', lat: 37.8005, lng: -122.4382 },
  { key: 'newton', address: '240 Highland St, Newton, MA', lat: 42.3295, lng: -71.2105 },
  { key: 'sanjose', address: '525 S Winchester Blvd, San Jose, CA', lat: 37.3127, lng: -121.9480 },
  { key: 'walpole', address: '13 Union St, Walpole, NH', lat: 43.0767, lng: -72.4309 },
  { key: 'byron', address: '2431 72nd St SW, Byron Center, MI', lat: 42.8064, lng: -85.7252 },
  { key: 'vinalhaven', address: '216 Zekes Point Rd, Vinalhaven, ME', lat: 44.0521, lng: -68.8020 },
  { key: 'suttonsbay', address: '5835 S Bridget Rose Ln, Suttons Bay, MI', lat: 44.9038, lng: -85.6490 },
  { key: 'losangeles', address: '2607 Glendower Ave, Los Angeles, CA', lat: 34.1103, lng: -118.2808 },
  { key: 'seattle', address: '4810 SW Ledroit Pl, Seattle, WA', lat: 47.5551, lng: -122.3876 },
  { key: 'austin', address: '8504 Long Canyon Dr, Austin, TX', lat: 30.3456, lng: -97.8005 },
  { key: 'minneapolis', address: '2730 Ulysses St NE, Minneapolis, MN', lat: 45.0235, lng: -93.2225 },
  { key: 'charleston', address: '41 Legare St, Charleston, SC', lat: 32.7716, lng: -79.9377 },
];

// Fetch satellite image from Google Static Maps
async function fetchSatellite(loc: typeof LOCATIONS[0]): Promise<string> {
  const outPath = join(EVAL_DIR, `${loc.key}-satellite.jpg`);
  if (existsSync(outPath)) return outPath;

  // Read API key from localStorage format (same as craftmatic web app)
  const keyFile = '/data/data/com.termux/files/home/.craftmatic-google-key';
  let apiKey = '';
  if (existsSync(keyFile)) {
    apiKey = (await readFile(keyFile, 'utf-8')).trim();
  }
  if (!apiKey) {
    // Try environment variable
    apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
  }
  if (!apiKey) {
    console.error(`  No Google Maps API key found. Create ${keyFile} or set GOOGLE_MAPS_API_KEY`);
    return '';
  }

  const zoom = 20;
  const size = '400x400';
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${loc.lat},${loc.lng}&zoom=${zoom}&size=${size}&maptype=satellite&key=${apiKey}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`  Satellite fetch failed: ${resp.status} ${resp.statusText}`);
    return '';
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(outPath, buf);
  return outPath;
}

// Encode image to base64 data URI for Gemini
async function imageToBase64(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString('base64');
}

// Main eval loop
async function main() {
  await mkdir(EVAL_DIR, { recursive: true });

  console.log(`Evaluating tiles ${VERSION} — ${LOCATIONS.length} locations\n`);

  const results: { key: string; address: string; score: number; feedback: string }[] = [];

  for (const loc of LOCATIONS) {
    const renderPath = join(TILES_DIR, `${loc.key}-${VERSION}.jpg`);
    if (!existsSync(renderPath)) {
      console.log(`${loc.key}: SKIP — no render at ${renderPath}`);
      results.push({ key: loc.key, address: loc.address, score: 0, feedback: 'No render available' });
      continue;
    }

    console.log(`${loc.key}: ${loc.address}`);

    // Fetch satellite
    const satPath = await fetchSatellite(loc);
    if (!satPath) {
      results.push({ key: loc.key, address: loc.address, score: 0, feedback: 'No satellite image' });
      continue;
    }

    // Encode both images
    const renderB64 = await imageToBase64(renderPath);
    const satB64 = await imageToBase64(satPath);

    // Output image paths for PAL MCP evaluation (will be called by the orchestrator)
    console.log(`  satellite: ${satPath}`);
    console.log(`  render: ${renderPath}`);
    console.log(`  render_b64_len: ${renderB64.length}`);
    console.log(`  sat_b64_len: ${satB64.length}`);
    results.push({ key: loc.key, address: loc.address, score: -1, feedback: 'pending eval' });
  }

  // Write eval state for orchestrator
  const statePath = join(EVAL_DIR, `eval-${VERSION}.json`);
  await writeFile(statePath, JSON.stringify({ version: VERSION, locations: results }, null, 2));
  console.log(`\nWrote eval state: ${statePath}`);
  console.log('Ready for Gemini evaluation via PAL MCP');
}

main().catch(console.error);
