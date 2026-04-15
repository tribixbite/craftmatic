#!/usr/bin/env bun
/**
 * fetch-reference-data.ts — Fetch and cache SV + satellite reference images
 * for all category-grading test locations.
 *
 * Downloads multi-heading Street View images and satellite imagery for each
 * location. Skips existing files (cache-friendly). Respects API rate limits.
 *
 * Usage:
 *   bun scripts/fetch-reference-data.ts [--group old|new|extra|all] [--refresh] [--only <key>]
 *
 * Requires: GOOGLE_API_KEY or GOOGLE_MAPS_API_KEY environment variable.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_LOCATIONS, getLocationsByGroup, type CategoryLocation, type LocationGroup } from '../src/grade/category-locations.js';
import { computeSatelliteZoom } from '../src/shared/satellite-zoom.js';

// ─── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getFlag(name: string, def: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
}
function hasFlag(name: string): boolean { return args.includes(name); }

const group = getFlag('--group', 'all') as LocationGroup;
const refresh = hasFlag('--refresh');
const onlyKey = getFlag('--only', '');

// ─── API Key ────────────────────────────────────────────────────────────────

const apiKey = process.env.GOOGLE_API_KEY
  || process.env.GOOGLE_MAPS_API_KEY
  || (existsSync('.env') ? readFileSync('.env', 'utf8').match(/GOOGLE_(?:MAPS_)?API_KEY=(.+)/)?.[1]?.trim() : undefined);

if (!apiKey) {
  console.error('Error: GOOGLE_API_KEY or GOOGLE_MAPS_API_KEY required');
  process.exit(1);
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_DIR = 'output/reference-data';
const SV_SIZE = 640;
const SAT_SIZE = 640;
/** Rate limit delay between API calls (ms) */
const API_DELAY = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parse "lat,lng" coords string */
function parseCoords(coords: string): { lat: number; lng: number } {
  const [lat, lng] = coords.split(',').map(Number);
  return { lat, lng };
}

/** Fetch SV metadata to get pano ID and camera position */
async function fetchSvMetadata(
  lat: number, lng: number,
): Promise<{ panoId: string; panoLat: number; panoLng: number } | null> {
  const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${apiKey}`;
  const resp = await fetch(metaUrl, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) return null;
  const data = await resp.json() as { status: string; pano_id?: string; location?: { lat: number; lng: number } };
  if (data.status !== 'OK' || !data.pano_id || !data.location) return null;
  return { panoId: data.pano_id, panoLat: data.location.lat, panoLng: data.location.lng };
}

/** Compute bearing from camera to building center */
function computeBearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const lat1 = fromLat * Math.PI / 180;
  const lat2 = toLat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/** Build SV image URL for a specific heading */
function buildSvUrl(panoId: string, heading: number, fov: number): string {
  return `https://maps.googleapis.com/maps/api/streetview`
    + `?size=${SV_SIZE}x${SV_SIZE}&pano=${panoId}&heading=${heading.toFixed(1)}`
    + `&pitch=15&fov=${fov}&key=${apiKey}`;
}

/** Download an image to disk, skip if exists and not refreshing */
async function downloadImage(url: string, destPath: string, label: string): Promise<boolean> {
  if (!refresh && existsSync(destPath)) {
    return true; // already cached
  }
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      console.error(`  ${label}: HTTP ${resp.status}`);
      return false;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(destPath, buf);
    console.log(`  ${label}: ${(buf.length / 1024).toFixed(0)}KB → ${destPath}`);
    return true;
  } catch (e) {
    console.error(`  ${label}: ${(e as Error).message}`);
    return false;
  }
}

// ─── Per-Location Fetcher ───────────────────────────────────────────────────

interface FetchResult {
  key: string;
  svCount: number;
  hasSatellite: boolean;
  hasSatelliteHires: boolean;
  error?: string;
}

async function fetchLocationData(loc: CategoryLocation): Promise<FetchResult> {
  const dir = join(BASE_DIR, loc.key);
  mkdirSync(dir, { recursive: true });

  const { lat, lng } = parseCoords(loc.coords);
  const result: FetchResult = { key: loc.key, svCount: 0, hasSatellite: false, hasSatelliteHires: false };

  // Write location config
  const configPath = join(dir, 'config.json');
  if (refresh || !existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      key: loc.key, name: loc.name, city: loc.city,
      coords: loc.coords, extentM: loc.extentM,
      resolution: loc.resolution, maskDilate: loc.maskDilate,
      osmId: loc.osmId, sceneMode: loc.sceneMode, archType: loc.archType,
    }, null, 2));
  }

  // ── Fetch SV facade images ──
  console.log(`\n${loc.name} (${loc.key}):`);
  try {
    const meta = await fetchSvMetadata(lat, lng);
    if (!meta) {
      console.log('  SV: no street view coverage');
    } else {
      const bearing = computeBearing(meta.panoLat, meta.panoLng, lat, lng);
      const fov = (loc.extentM && loc.extentM > 30) ? 110 : 90;

      // 4 cardinal headings relative to building bearing
      const faces = [
        { name: 'front', offset: 0 },
        { name: 'right', offset: 90 },
        { name: 'rear', offset: 180 },
        { name: 'left', offset: 270 },
      ];

      for (const face of faces) {
        const heading = (bearing + face.offset) % 360;
        const url = buildSvUrl(meta.panoId, heading, fov);
        const path = join(dir, `sv-${face.name}.jpg`);
        const ok = await downloadImage(url, path, `SV ${face.name} (${heading.toFixed(0)}°)`);
        if (ok) result.svCount++;
        await sleep(API_DELAY);
      }

      // Save metadata for debugging
      const svMetaPath = join(dir, 'sv-meta.json');
      writeFileSync(svMetaPath, JSON.stringify({
        panoId: meta.panoId, panoLat: meta.panoLat, panoLng: meta.panoLng,
        bearing: bearing.toFixed(1), fov,
      }, null, 2));
    }
  } catch (e) {
    console.error(`  SV: ${(e as Error).message}`);
    result.error = (e as Error).message;
  }

  // ── Fetch satellite image ──
  try {
    const zoom = loc.satZoom ?? (loc.extentM
      ? computeSatelliteZoom(loc.extentM, lat, SAT_SIZE)
      : 19);

    // Standard res (640×640)
    const satUrl = `https://maps.googleapis.com/maps/api/staticmap`
      + `?center=${lat},${lng}&zoom=${zoom}&size=${SAT_SIZE}x${SAT_SIZE}`
      + `&maptype=satellite&key=${apiKey}`;
    const satPath = join(dir, 'satellite.jpg');
    result.hasSatellite = await downloadImage(satUrl, satPath, `Satellite z${zoom}`);
    await sleep(API_DELAY);

    // Hi-res (scale=2 → 1280×1280)
    const satHiUrl = `https://maps.googleapis.com/maps/api/staticmap`
      + `?center=${lat},${lng}&zoom=${zoom}&size=${SAT_SIZE}x${SAT_SIZE}&scale=2`
      + `&maptype=satellite&key=${apiKey}`;
    const satHiPath = join(dir, 'satellite-hires.jpg');
    result.hasSatelliteHires = await downloadImage(satHiUrl, satHiPath, `Satellite z${zoom} hires`);
    await sleep(API_DELAY);

    // Save satellite config
    const satMetaPath = join(dir, 'satellite-meta.json');
    writeFileSync(satMetaPath, JSON.stringify({ zoom, lat, lng }, null, 2));
  } catch (e) {
    console.error(`  Satellite: ${(e as Error).message}`);
    result.error = (e as Error).message;
  }

  return result;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let locations = getLocationsByGroup(group);

  // Filter to specific key if --only is set
  if (onlyKey) {
    locations = locations.filter(l => l.key === onlyKey);
    if (locations.length === 0) {
      const keys = ALL_LOCATIONS.map(l => l.key).join(', ');
      console.error(`Unknown location key: ${onlyKey}\nAvailable: ${keys}`);
      process.exit(1);
    }
  }

  console.log(`Fetching reference data for ${locations.length} locations (group=${group})${refresh ? ' [REFRESH]' : ''}`);
  console.log(`Output: ${BASE_DIR}/\n`);

  const results: FetchResult[] = [];

  // Sequential to respect rate limits
  for (const loc of locations) {
    const result = await fetchLocationData(loc);
    results.push(result);
  }

  // Write manifest
  const manifest = {
    generated: new Date().toISOString(),
    group,
    locations: results.map(r => ({
      key: r.key,
      svImages: r.svCount,
      hasSatellite: r.hasSatellite,
      hasSatelliteHires: r.hasSatelliteHires,
      error: r.error,
    })),
  };
  writeFileSync(join(BASE_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Summary
  console.log('\n═══ Summary ═══');
  const totalSv = results.reduce((s, r) => s + r.svCount, 0);
  const totalSat = results.filter(r => r.hasSatellite).length;
  const errors = results.filter(r => r.error);
  console.log(`  ${results.length} locations processed`);
  console.log(`  ${totalSv} SV images (${(totalSv / results.length).toFixed(1)} avg/location)`);
  console.log(`  ${totalSat}/${results.length} satellite images`);
  if (errors.length > 0) {
    console.log(`  ${errors.length} errors:`);
    for (const e of errors) console.log(`    ${e.key}: ${e.error}`);
  }
  console.log(`\nManifest: ${BASE_DIR}/manifest.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
