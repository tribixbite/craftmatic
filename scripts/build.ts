#!/usr/bin/env bun
/**
 * New pipeline entry point — address → all artifacts.
 *
 * Usage:
 *   bun scripts/build.ts "175 5th Ave, New York, NY" --out output/pipeline/flatiron
 *
 * Produces:
 *   <slug>.print.glb       — watertight printable building
 *   <slug>.scene.glb       — building + environment (non-printable)
 *   <slug>.schem           — Minecraft voxel schematic
 *   <slug>.litematic       — Litematica schematic
 *   <slug>.verification.json — status + metrics
 *
 * Progress is logged to stderr; artifact paths to stdout.
 */

import { resolve, join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { FullVerificationReport } from '../src/pipeline/verify/report.js';
import { runPipeline } from '../src/pipeline/pipeline.js';
import { searchOSMBuilding } from '../src/gen/api/osm.js';
import { querySolarBuildingInsights } from '../src/gen/api/google-solar.js';
import { createGoogleSatelliteFetcher } from '../src/pipeline/capture/satellite.js';
import { writeSchematic } from '../src/schem/write.js';
import { writeLitematic } from '../src/schem/write-litematic.js';
import { summariseReport } from '../src/pipeline/verify/report.js';
import type { ContextFetchers } from '../src/pipeline/context/resolver.js';
import type { StreetViewFetchers } from '../src/pipeline/capture/streetview.js';

// ─── Arg parsing ───────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function popFlag(name: string): string | null {
  const i = argv.indexOf(name);
  if (i >= 0) {
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v ?? null;
  }
  return null;
}

const outDir = popFlag('--out') ?? popFlag('-o') ?? 'output/pipeline';
const address = argv.join(' ').trim();
if (!address) {
  console.error('Usage: bun scripts/build.ts "address" [--out dir]');
  process.exit(1);
}

// ─── Environment ──────────────────────────────────────────────────────────

const projectRoot = resolve(import.meta.dir, '..');
const envPath = join(projectRoot, '.env');
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const apiKey = process.env['GOOGLE_MAPS_API_KEY']
  ?? envText.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error('Error: GOOGLE_MAPS_API_KEY not set');
  process.exit(1);
}

const absOutDir = resolve(projectRoot, outDir);
mkdirSync(absOutDir, { recursive: true });

// ─── Fetcher wiring ────────────────────────────────────────────────────────

const contextFetchers: ContextFetchers = {
  geocode: async (addr) => {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json() as {
      results: Array<{
        geometry: {
          location: { lat: number; lng: number };
          location_type: string;
          viewport?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
          bounds?: { northeast: { lat: number; lng: number }; southwest: { lat: number; lng: number } };
        };
        formatted_address: string;
        place_id: string;
      }>;
    };
    if (!data.results?.length) throw new Error('geocode: no results');
    const r = data.results[0];
    const latlon = (p: { lat: number; lng: number }) => ({ lat: p.lat, lon: p.lng });
    return {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      formattedAddress: r.formatted_address,
      placeId: r.place_id ?? null,
      locationType: (r.geometry.location_type as 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE') ?? 'APPROXIMATE',
      viewport: r.geometry.viewport
        ? { sw: latlon(r.geometry.viewport.southwest), ne: latlon(r.geometry.viewport.northeast) }
        : null,
      bounds: r.geometry.bounds
        ? { sw: latlon(r.geometry.bounds.southwest), ne: latlon(r.geometry.bounds.northeast) }
        : null,
    };
  },
  solar: async (lat, lng) => querySolarBuildingInsights(lat, lng, apiKey),
  osm: async (lat, lng) => searchOSMBuilding(lat, lng, 50),
  osmSiblings: async () => [], // follow-up: OSM building:part spatial query
  smarty: async () => null,    // follow-up: Smarty per-address lookup
};

const streetViewFetchers: StreetViewFetchers = {
  metadata: async (lat, lng) => {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&source=outdoor&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = await resp.json() as { status: string; pano_id?: string; location?: { lat: number; lng: number } };
    if (data.status !== 'OK' || !data.pano_id || !data.location) return null;
    return { panoId: data.pano_id, panoLat: data.location.lat, panoLng: data.location.lng };
  },
  image: async (panoId, heading, fov, pitch) => {
    const url = `https://maps.googleapis.com/maps/api/streetview?size=640x640&pano=${panoId}&heading=${heading.toFixed(1)}&pitch=${pitch}&fov=${fov}&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`SV image HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { bytes, width: 640, height: 640 };
  },
};

// ─── Run pipeline ──────────────────────────────────────────────────────────

const started = Date.now();
const result = await runPipeline({
  address,
  apiKey,
  projectRoot,
  fetchers: {
    context: contextFetchers,
    streetview: streetViewFetchers,
    satellite: createGoogleSatelliteFetcher(apiKey),
  },
  onProgress: ({ stage, message, ratio }) => {
    const r = typeof ratio === 'number' ? ` ${(ratio * 100).toFixed(0)}%` : '';
    console.error(`[${stage}${r}] ${message}`);
  },
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

// ─── Write artifacts ───────────────────────────────────────────────────────

const slug = result.slug;
const paths: Record<string, string> = {
  verification: join(absOutDir, `${slug}.verification.json`),
};

writeFileSync(paths.verification, JSON.stringify(result.report, null, 2));

// Merge into canonical pipeline-state.json (the file the stop hook reads)
const statePath = join(projectRoot, 'output/pipeline-state.json');
mergeStateRecord(statePath, slug, result.report, elapsed);

if (result.artifacts) {
  paths.printGlb = join(absOutDir, `${slug}.print.glb`);
  paths.sceneGlb = join(absOutDir, `${slug}.scene.glb`);
  paths.schem = join(absOutDir, `${slug}.schem`);
  paths.litematic = join(absOutDir, `${slug}.litematic`);

  writeFileSync(paths.printGlb, Buffer.from(result.artifacts.printGlbBytes));
  writeFileSync(paths.sceneGlb, Buffer.from(result.artifacts.sceneGlbBytes));
  writeSchematic(result.artifacts.voxelGrid, paths.schem);
  writeLitematic(result.artifacts.voxelGrid, paths.litematic, { name: slug });
}

// ─── Report ────────────────────────────────────────────────────────────────

console.error(`\nDone in ${elapsed}s — ${summariseReport(result.report)}`);
if (result.artifacts) {
  console.log(paths.printGlb);
  console.log(paths.sceneGlb);
  console.log(paths.schem);
  console.log(paths.litematic);
}
console.log(paths.verification);

process.exit(result.report.status === 'fail-objective' ? 1 : 0);

// ─── State merge + attempt tracking ────────────────────────────────────────

interface PipelineStateFile {
  version?: string;
  addresses: Record<string, PipelineStateRecord>;
}

interface PipelineStateRecord {
  address: string;
  status: FullVerificationReport['status'];
  lastRun: string;
  elapsedSec: number;
  attempts: number;
  recentFailureSignatures: string[];
  objective: FullVerificationReport['objective'];
  consensus: FullVerificationReport['consensus'];
  reason?: string;
}

/**
 * Compute a short signature for a failure — used by the hook's loop detector.
 *
 * Objective failures: canonicalise the first two `failures[]` entries so repeat
 * runs that fail the same gates cluster.
 * Consensus failures: include median + min (truncated) + worst dimension.
 * Others: the status enum.
 */
function failureSignature(report: FullVerificationReport): string {
  if (report.status === 'pass') return 'pass';
  if (report.status === 'fail-objective' && report.objective) {
    const tags = report.objective.failures.slice(0, 2).map(f => {
      // Strip numeric values so "IoU 0.71 < 0.85" and "IoU 0.73 < 0.85" collide.
      return f.replace(/[0-9.]+/g, '#').trim();
    });
    return `fail-objective:${tags.join('|')}`;
  }
  if (report.status === 'fail-consensus' && report.consensus) {
    const median = Math.round(report.consensus.median);
    const min = Math.round(report.consensus.min);
    return `fail-consensus:median=${median},min=${min}`;
  }
  return report.status;
}

function mergeStateRecord(
  path: string,
  slug: string,
  report: FullVerificationReport,
  elapsedSec: string,
): void {
  let state: PipelineStateFile = { version: 'v400', addresses: {} };
  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, 'utf8')) as PipelineStateFile;
      if (!state.addresses) state.addresses = {};
    } catch {
      // Corrupt state file — start fresh.
    }
  }

  const prev = state.addresses[slug];
  const sig = failureSignature(report);
  const attempts = (prev?.attempts ?? 0) + 1;
  const recent = [...(prev?.recentFailureSignatures ?? []), sig].slice(-5);

  const record: PipelineStateRecord = {
    address,
    status: report.status,
    lastRun: report.lastRun,
    elapsedSec: parseFloat(elapsedSec),
    attempts: report.status === 'pass' ? 0 : attempts, // reset on pass
    recentFailureSignatures: report.status === 'pass' ? [] : recent,
    objective: report.objective,
    consensus: report.consensus,
    ...(report.reason ? { reason: report.reason } : {}),
  };

  state.addresses[slug] = record;
  writeFileSync(path, JSON.stringify(state, null, 2));
}
