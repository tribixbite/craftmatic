#!/usr/bin/env bun
/**
 * fetch-reference-data.ts — Fetch and cache SV + satellite reference images
 * for all category-grading test locations.
 *
 * Downloads multi-heading Street View images and satellite imagery for each
 * location. Skips existing files (cache-friendly). Respects API rate limits.
 *
 * SV camera strategy (auto-computed, no manual overrides needed):
 *   For each of 4 cardinal directions, a camera is placed viewDistM outside
 *   the building and aimed at the building center with heading and FOV computed
 *   from the actual panorama position. This avoids the "shot from inside the
 *   building" problem of the old center-based approach.
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

// Prefer GOOGLE_MAPS_API_KEY — it has SV/Static Maps APIs enabled.
// GOOGLE_API_KEY is typically the Gemini key without Maps APIs.
const apiKey = process.env.GOOGLE_MAPS_API_KEY
  || process.env.GOOGLE_API_KEY
  || (existsSync('.env') ? readFileSync('.env', 'utf8').match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim() : undefined)
  || (existsSync('.env') ? readFileSync('.env', 'utf8').match(/GOOGLE_API_KEY=(.+)/)?.[1]?.trim() : undefined);

if (!apiKey) {
  console.error('Error: GOOGLE_MAPS_API_KEY or GOOGLE_API_KEY required');
  process.exit(1);
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_DIR = 'output/reference-data';
const SV_SIZE = 640;
const SAT_SIZE = 640;
/** Rate limit delay between API calls (ms) */
const API_DELAY = 500;

// ─── Geo helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parse "lat,lng" coords string */
function parseCoords(coords: string): { lat: number; lng: number } {
  const [lat, lng] = coords.split(',').map(Number);
  return { lat, lng };
}

/** Meters → degrees latitude (constant everywhere) */
function metersToDegLat(m: number): number {
  return m / 111111;
}

/** Meters → degrees longitude (varies with latitude) */
function metersToDegLon(m: number, lat: number): number {
  return m / (111111 * Math.cos(lat * Math.PI / 180));
}

/** Great-circle distance in metres (Haversine) */
function haversineDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Bearing (degrees, clockwise from north) from one point to another */
function computeBearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const lat1 = fromLat * Math.PI / 180;
  const lat2 = toLat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ─── Building size resolution ────────────────────────────────────────────────

interface BuildingExtent {
  /** East-West ground extent in metres */
  widthM: number;
  /** North-South ground extent in metres */
  depthM: number;
  /** Bounding-box diagonal in metres */
  diagonalM: number;
  /** Data source used */
  source: 'solar' | 'config';
}

/**
 * Resolve the actual building ground footprint using the Solar API bounding box.
 * Falls back to the config extentM hint if the API is unavailable or returns no data.
 *
 * The Solar API returns the solar-panel bounding box, which closely matches the
 * roof footprint. For most buildings this is the best freely-available size estimate.
 */
async function resolveBuildingExtent(
  lat: number, lng: number, fallbackExtentM: number,
): Promise<BuildingExtent> {
  try {
    const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest`
      + `?location.latitude=${lat}&location.longitude=${lng}`
      + `&requiredQuality=LOW&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (resp.ok) {
      const data = await resp.json() as {
        boundingBox?: {
          sw: { latitude: number; longitude: number };
          ne: { latitude: number; longitude: number };
        };
      };
      const box = data?.boundingBox;
      if (box?.sw && box?.ne) {
        const widthM = haversineDistanceM(
          box.sw.latitude, box.sw.longitude,
          box.sw.latitude, box.ne.longitude,
        );
        const depthM = haversineDistanceM(
          box.sw.latitude, box.sw.longitude,
          box.ne.latitude, box.sw.longitude,
        );
        const diagonalM = Math.sqrt(widthM ** 2 + depthM ** 2);
        console.log(`  BuildingExtent: solar bbox ${widthM.toFixed(0)}m × ${depthM.toFixed(0)}m (diag ${diagonalM.toFixed(0)}m)`);
        return { widthM, depthM, diagonalM, source: 'solar' };
      }
    }
  } catch (_e) { /* fall through to config fallback */ }

  // Fallback: treat extentM as both width and depth (worst-case square)
  const diagonalM = fallbackExtentM * Math.SQRT2;
  console.log(`  BuildingExtent: config hint ${fallbackExtentM}m (diag ${diagonalM.toFixed(0)}m)`);
  return { widthM: fallbackExtentM, depthM: fallbackExtentM, diagonalM, source: 'config' };
}

/**
 * Compute camera standoff distance from actual building extent.
 *
 * Rule: camera is placed at half-diagonal + 20m margin, minimum 50m.
 * This guarantees cameras are clearly outside even irregular/large footprints.
 *
 * Example:
 *   Guggenheim  40m config → solar bbox ~50×35m, diag ~61m → viewDist = max(30.5+20, 50) = 50m  ✓
 *   FBI HQ      100m config → solar bbox ~200×100m, diag 224m → viewDist = max(112+20, 50) = 132m ✓
 *   Chrysler    40m config → solar bbox ~40×40m, diag ~57m → viewDist = max(28.5+20, 50) = 50m  ✓
 */
function computeViewDistM(extent: BuildingExtent): number {
  return Math.max(extent.diagonalM / 2 + 20, 50);
}

// ─── SV API helpers ─────────────────────────────────────────────────────────

/** Fetch SV metadata to get pano ID and actual camera position */
async function fetchSvMetadata(
  lat: number, lng: number,
): Promise<{ panoId: string; panoLat: number; panoLng: number } | null> {
  const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata`
    + `?location=${lat},${lng}&source=outdoor&key=${apiKey}`;
  const resp = await fetch(metaUrl, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) return null;
  const data = await resp.json() as {
    status: string; pano_id?: string; location?: { lat: number; lng: number };
  };
  if (data.status !== 'OK' || !data.pano_id || !data.location) return null;
  return { panoId: data.pano_id, panoLat: data.location.lat, panoLng: data.location.lng };
}

/** Build SV image URL from panorama ID, exact heading, and FOV */
function buildSvUrl(panoId: string, heading: number, fov: number, pitch = 10): string {
  return `https://maps.googleapis.com/maps/api/streetview`
    + `?size=${SV_SIZE}x${SV_SIZE}&pano=${panoId}`
    + `&heading=${heading.toFixed(1)}&pitch=${pitch}&fov=${fov}`
    + `&key=${apiKey}`;
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

// ─── SV camera auto-positioning ─────────────────────────────────────────────

/**
 * Compute 4 camera query positions (N/S/E/W) offset from building centre by viewDistM.
 * viewDistM is derived from the actual building extent (Solar API bbox or config hint).
 */
function getSvQueryPositions(
  lat: number, lng: number, viewDistM: number,
): Array<{ name: string; qLat: number; qLng: number }> {
  const dLat = metersToDegLat(viewDistM);
  const dLon = metersToDegLon(viewDistM, lat);
  return [
    { name: 'north', qLat: lat + dLat, qLng: lng },
    { name: 'south', qLat: lat - dLat, qLng: lng },
    { name: 'east',  qLat: lat,         qLng: lng + dLon },
    { name: 'west',  qLat: lat,         qLng: lng - dLon },
  ];
}

/**
 * Compute vertical pitch for the SV shot: tilt up slightly for tall buildings.
 * pitch = 0 (horizontal) for short buildings, up to +20° for skyscrapers.
 */
function computePitch(extentM: number): number {
  // Assumes camera is viewDistM away; half the building height is extentM/4 (rough estimate)
  if (extentM <= 20) return 5;
  if (extentM <= 50) return 10;
  if (extentM <= 100) return 15;
  return 20;
}

// ─── Per-Location Fetcher ───────────────────────────────────────────────────

interface FetchResult {
  key: string;
  svCount: number;
  hasSatellite: boolean;
  hasSatelliteHires: boolean;
  error?: string;
}

interface SvShotMeta {
  side: string;
  qLat: number; qLng: number;     // query position (where we asked for a pano)
  panoLat: number; panoLng: number; // actual pano position returned by API
  panoDistM: number;               // distance from pano to building centre
  heading: number;                 // camera heading (toward building centre)
  fov: number;                     // computed field of view
  pitch: number;
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

  const extentM = loc.extentM ?? 40;

  // ── Fetch SV facade images (4 cardinal sides, auto-positioned) ──
  console.log(`\n${loc.name} (${loc.key}):`);
  try {
    // Resolve actual building ground extent from Solar API (or fall back to config hint).
    // This drives the camera standoff distance so cameras are always outside the building.
    const buildingExtent = await resolveBuildingExtent(lat, lng, extentM);
    await sleep(API_DELAY);
    const viewDistM = computeViewDistM(buildingExtent);
    console.log(`  ViewDist: ${viewDistM.toFixed(0)}m (from ${buildingExtent.source})`);

    const sides = getSvQueryPositions(lat, lng, viewDistM);
    const pitch = computePitch(extentM);
    const svMeta: SvShotMeta[] = [];

    for (const side of sides) {
      const meta = await fetchSvMetadata(side.qLat, side.qLng);
      await sleep(API_DELAY);
      if (!meta) {
        console.log(`  SV ${side.name}: no coverage`);
        continue;
      }

      // Heading: from panorama position → building centre
      const heading = computeBearing(meta.panoLat, meta.panoLng, lat, lng);

      // FOV: computed from the building's actual largest dimension and pano-to-centre distance.
      // Use 65% of the largest facade dimension as the target visible half-width.
      const panoDist = haversineDistanceM(meta.panoLat, meta.panoLng, lat, lng);
      const largestDim = Math.max(buildingExtent.widthM, buildingExtent.depthM);
      const halfWidth = largestDim * 0.65;
      const rawFov = 2 * Math.atan2(halfWidth, Math.max(20, panoDist)) * 180 / Math.PI;
      const fov = Math.min(110, Math.max(60, Math.round(rawFov)));

      const url = buildSvUrl(meta.panoId, heading, fov, pitch);
      const path = join(dir, `sv-${side.name}.jpg`);
      const ok = await downloadImage(url, path, `SV ${side.name} (h=${heading.toFixed(0)}° fov=${fov}° d=${panoDist.toFixed(0)}m)`);
      if (ok) {
        result.svCount++;
        svMeta.push({
          side: side.name,
          qLat: side.qLat, qLng: side.qLng,
          panoLat: meta.panoLat, panoLng: meta.panoLng,
          panoDistM: panoDist,
          heading, fov, pitch,
        });
      }
    }

    // Save per-side SV metadata for debugging / VLM prompt generation
    if (svMeta.length > 0) {
      writeFileSync(join(dir, 'sv-meta.json'), JSON.stringify({
        buildingCoords: { lat, lng },
        extentM,
        buildingExtent,
        viewDistM,
        shots: svMeta,
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
    writeFileSync(join(dir, 'satellite-meta.json'), JSON.stringify({ zoom, lat, lng }, null, 2));
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
  console.log('SV strategy: 4 offset cameras (N/S/E/W) at max(40m, extentM*0.9), auto-computed heading+FOV');

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
