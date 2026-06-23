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
import { searchOSMBuilding, searchOSMBuildingParts } from '../src/gen/api/osm.js';
import { querySolarBuildingInsights } from '../src/gen/api/google-solar.js';
import { createGoogleSatelliteFetcher } from '../src/pipeline/capture/satellite.js';
import { writeSchematic } from '../src/schem/write.js';
import { writeLitematic } from '../src/schem/write-litematic.js';
import { summariseReport } from '../src/pipeline/verify/report.js';
import type { ContextFetchers } from '../src/pipeline/context/resolver.js';
import type { StreetViewFetchers } from '../src/pipeline/capture/streetview.js';
import { createGeminiScorer, singleModelFetchers } from '../src/pipeline/verify/gemini-scorer.js';
import { createClaudeScorer } from '../src/pipeline/verify/claude-scorer.js';
import { createGpt5Scorer } from '../src/pipeline/verify/gpt5-scorer.js';
import { createOpenRouterScorer } from '../src/pipeline/verify/openrouter-scorer.js';
import { createLocalVlmScorer } from '../src/pipeline/verify/local-vlm-scorer.js';
import type { ModelFetchers, ModelScoreFn } from '../src/pipeline/verify/consensus.js';
import type { RunPipelineOptions } from '../src/pipeline/pipeline.js';

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
const slugOverride = popFlag('--slug');
const tileTimeoutSec = parseInt(popFlag('--tile-timeout') ?? '0', 10);
const consensusMode = popFlag('--consensus'); // 'gemini' | null — future: 'all'
const resolutionFlag = popFlag('--resolution');
const maxDimFlag = popFlag('--max-dim');
const tilesGlbPath = popFlag('--tiles-glb');
const skipTiles = argv.includes('--skip-tiles');
if (skipTiles) argv.splice(argv.indexOf('--skip-tiles'), 1);
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

const geminiKey = process.env['GOOGLE_GEMINI_API_KEY']
  ?? process.env['GEMINI_API_KEY']
  ?? envText.match(/(?:GOOGLE_)?GEMINI_API_KEY=(.+)/)?.[1]?.trim();

const claudeKey = process.env['ANTHROPIC_API_KEY']
  ?? envText.match(/ANTHROPIC_API_KEY=(.+)/)?.[1]?.trim();

const openaiKey = process.env['OPENAI_API_KEY']
  ?? envText.match(/OPENAI_API_KEY=(.+)/)?.[1]?.trim();

const openrouterKey = process.env['OPENROUTER_API_KEY']
  ?? envText.match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
const openrouterModel = process.env['OPENROUTER_MODEL']
  ?? envText.match(/OPENROUTER_MODEL=(.+)/)?.[1]?.trim()
  ?? 'qwen/qwen-2.5-vl-72b-instruct';

const localVlmUrl = process.env['LOCAL_VLM_URL']
  ?? envText.match(/LOCAL_VLM_URL=(.+)/)?.[1]?.trim();
const localVlmModel = process.env['LOCAL_VLM_MODEL']
  ?? envText.match(/LOCAL_VLM_MODEL=(.+)/)?.[1]?.trim()
  ?? 'Qwen/Qwen2.5-VL-72B-Instruct-AWQ';

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
  osm: async (lat, lng) => {
    // Manual polygon overrides (output/polygon-overrides.json) take
    // precedence over OSM lookup. Useful for addresses where OSM has
    // no building polygon (suburban residential — 240-highland) or
    // wrong/stale data.
    const slug = slugOverride ?? address.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
    const overridePath = resolve(projectRoot, 'output/polygon-overrides.json');
    if (existsSync(overridePath)) {
      try {
        const ovr = JSON.parse(readFileSync(overridePath, 'utf8')) as {
          overrides?: Record<string, {
            polygon: Array<{ lat: number; lon: number }>;
            heightM?: number;
            levels?: number;
            buildingColour?: string;
            roofColour?: string;
            roofShape?: string;
            material?: string;
          }>;
        };
        const o = ovr.overrides?.[slug];
        if (o && o.polygon && o.polygon.length >= 3) {
          // Polygon dimensions are recomputed by the resolver from MBR
          // when needed — overrides just supply the polygon + tags.
          const tags: Record<string, string> = {};
          if (o.heightM) tags['height'] = String(o.heightM);
          if (o.levels) tags['building:levels'] = String(o.levels);
          if (o.buildingColour) tags['building:colour'] = o.buildingColour;
          if (o.roofColour) tags['roof:colour'] = o.roofColour;
          if (o.roofShape) tags['roof:shape'] = o.roofShape;
          if (o.material) tags['building:material'] = o.material;
          tags['building'] = 'yes';
          tags['source'] = 'craftmatic-polygon-override';
          console.error(`  [polygon-override] using ${slug} from polygon-overrides.json (${o.polygon.length} verts)`);
          return {
            polygon: o.polygon,
            widthMeters: 0,
            lengthMeters: 0,
            widthBlocks: 0,
            lengthBlocks: 0,
            levels: o.levels,
            buildingColour: o.buildingColour,
            roofColour: o.roofColour,
            roofShape: o.roofShape,
            material: o.material,
            footprintAreaSqm: 0,
            tags,
          };
        }
      } catch (e) {
        console.error(`warn: polygon-overrides.json parse error: ${(e as Error).message}`);
      }
    }
    return searchOSMBuilding(lat, lng, 50);
  },
  osmSiblings: async () => [], // follow-up: OSM building neighbour query
  osmBuildingParts: async (lat, lng, radius) => {
    const parts = await searchOSMBuildingParts(lat, lng, radius);
    return parts.map(p => ({
      polygon: p.polygon,
      heightM: p.heightM,
      levels: p.levels,
      buildingColour: p.buildingColour,
      roofColour: p.roofColour,
      roofShape: p.roofShape,
      tags: p.tags,
    }));
  },
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

// ─── Consensus wiring (optional) ──────────────────────────────────────────
//
// Only wired when --consensus=gemini is passed AND a Gemini key is available.
// References come from output/reference-data/<slug>/ when that dir exists —
// the same images fetch-reference-data.ts populates for category-grading.

function loadReferencesForSlug(slugGuess: string): Uint8Array[] {
  const refDir = resolve(projectRoot, 'output/reference-data', slugGuess);
  if (!existsSync(refDir)) return [];
  const refs: Uint8Array[] = [];
  // Up to 4 SV angles + 1 satellite
  for (const name of ['sv-front.jpg', 'sv-right.jpg', 'sv-rear.jpg', 'sv-left.jpg', 'satellite.jpg']) {
    const p = join(refDir, name);
    if (existsSync(p)) refs.push(new Uint8Array(readFileSync(p)));
  }
  return refs;
}

/**
 * Build the per-slot ModelFetchers. `--consensus` accepts:
 *   gemini      — Gemini for all 3 slots (legacy fan-out, spread always 0)
 *   multi/all   — mix Gemini/Claude/GPT-5 from env keys; uncovered slots
 *                 fall back to Gemini
 *   local       — local vLLM (LOCAL_VLM_URL + LOCAL_VLM_MODEL) + Gemini +
 *                 OpenRouter/Claude/GPT-5 where available
 *   openrouter  — OpenRouter (OPENROUTER_API_KEY + OPENROUTER_MODEL) +
 *                 Gemini + others
 *
 * For real spread on dual RTX 3090s, run a local Qwen2.5-VL-72B via vLLM
 * and set LOCAL_VLM_URL=http://localhost:8000/v1 — see local-vlm-scorer.ts
 * for the recommended `vllm serve` command.
 */
function buildModelFetchers(): { models: ModelFetchers; mode: string } | null {
  if (!geminiKey) return null;
  const gemini: ModelScoreFn = createGeminiScorer({ apiKey: geminiKey });
  if (consensusMode === 'gemini') {
    return { models: singleModelFetchers(gemini), mode: 'gemini-fanout' };
  }

  // Pick best available per slot. Slot 2 = Claude (or local-vlm or openrouter
  // as fallback). Slot 3 = GPT-5 (or openrouter or local-vlm as fallback).
  // Slot 1 always Gemini. Uncovered slots fall back to Gemini.
  const localVlm: ModelScoreFn | null = localVlmUrl
    ? createLocalVlmScorer({ baseUrl: localVlmUrl, model: localVlmModel })
    : null;
  const openrouter: ModelScoreFn | null = openrouterKey
    ? createOpenRouterScorer({
        apiKey: openrouterKey,
        model: openrouterModel,
        referer: 'https://github.com/tribixbite/craftmatic',
        title: 'craftmatic',
      })
    : null;

  // Resolve slot 2 (defaults to Claude > local > openrouter > gemini)
  let claude: ModelScoreFn = gemini;
  let claudeName = 'gemini';
  if (claudeKey) { claude = createClaudeScorer({ apiKey: claudeKey }); claudeName = 'claude'; }
  else if (localVlm) { claude = localVlm; claudeName = `local(${localVlmModel.split('/').pop()})`; }
  else if (openrouter) { claude = openrouter; claudeName = `openrouter(${openrouterModel})`; }

  // Resolve slot 3 (defaults to GPT-5 > openrouter > local > gemini)
  let gpt5: ModelScoreFn = gemini;
  let gpt5Name = 'gemini';
  if (openaiKey) { gpt5 = createGpt5Scorer({ apiKey: openaiKey }); gpt5Name = 'gpt5'; }
  else if (openrouter && claudeName !== `openrouter(${openrouterModel})`) {
    gpt5 = openrouter; gpt5Name = `openrouter(${openrouterModel})`;
  }
  else if (localVlm && claudeName !== `local(${localVlmModel.split('/').pop()})`) {
    gpt5 = localVlm; gpt5Name = `local(${localVlmModel.split('/').pop()})`;
  }

  // If no extra scorers configured at all → fan-out
  if (claudeName === 'gemini' && gpt5Name === 'gemini') {
    return { models: singleModelFetchers(gemini), mode: 'gemini-fanout' };
  }

  return { models: { gemini, claude, gpt5 }, mode: `multi(gemini,${claudeName},${gpt5Name})` };
}

const consensusOpt: RunPipelineOptions['consensus'] = (() => {
  if (!consensusMode) return undefined;
  const built = buildModelFetchers();
  if (!built) {
    console.error('warn: --consensus requires GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY');
    return undefined;
  }
  const slugGuess = slugOverride ?? address.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
  const references = loadReferencesForSlug(slugGuess);
  if (references.length === 0) {
    console.error(`warn: no reference images at output/reference-data/${slugGuess}/ — consensus will run without references`);
  }
  console.error(`  [consensus] mode=${built.mode}`);
  return {
    models: built.models,
    references,
    maxRounds: 1, // deterministic synthesis → re-scoring is no-op; save API calls
  };
})();

// ─── Run pipeline ──────────────────────────────────────────────────────────

const injectedTiles = tilesGlbPath !== null
  ? (await import('../src/pipeline/capture/tiles-from-glb.js')).buildTileEvidenceFromGlbFile({
      path: resolve(tilesGlbPath),
      // Stage 3 normally uses profile.tiles.expectedHeightM. The injected
      // path doesn't have that yet (profile is computed inside runPipeline)
      // so we pass 0 — `isHeightTruncated` only flags truncation when
      // measured << expected, so 0 disables the truncation flag. Caller
      // should provide a known-good GLB.
      expectedHeightM: 0,
    })
  : undefined;

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
  tileTimeoutMs: tileTimeoutSec > 0 ? tileTimeoutSec * 1000 : undefined,
  skipTiles,
  injectedTiles,
  consensus: consensusOpt,
  voxel: {
    ...(resolutionFlag !== null ? { resolution: parseFloat(resolutionFlag) } : {}),
    ...(maxDimFlag !== null ? { maxDimension: parseInt(maxDimFlag, 10) } : {}),
  },
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

// ─── Write artifacts ───────────────────────────────────────────────────────

const slug = slugOverride ?? result.slug;
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

  // Bootstrap reference-data/<slug>/ from the live SV+satellite captures so
  // the next consensus run has real images to compare against. Only fills
  // missing files — never overwrites user-curated references.
  saveReferenceDataIfMissing(slug, result.artifacts);
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

// ─── Reference-data bootstrap ──────────────────────────────────────────────

/**
 * Write the live SV + satellite captures into output/reference-data/<slug>/
 * so future consensus rebuilds (and the category-grade loop) have reference
 * images without a separate fetch pass. Only writes files that don't
 * already exist — human-curated refs in output/reference-data/ remain
 * authoritative.
 */
function saveReferenceDataIfMissing(
  slug: string,
  artifacts: NonNullable<Awaited<ReturnType<typeof runPipeline>>['artifacts']>,
): void {
  const refDir = resolve(projectRoot, 'output/reference-data', slug);
  mkdirSync(refDir, { recursive: true });
  // SV facades: map by heading to canonical names. The pipeline captures
  // front/right/rear/left via facadeEdge; pick 4 distinct-heading facades.
  const svNames = ['sv-front.jpg', 'sv-right.jpg', 'sv-rear.jpg', 'sv-left.jpg'];
  const svFacades = artifacts.captures.sv;
  for (let i = 0; i < Math.min(svFacades.length, svNames.length); i++) {
    const dst = join(refDir, svNames[i]);
    if (!existsSync(dst)) {
      writeFileSync(dst, Buffer.from(svFacades[i].imageBytes));
    }
  }
  // Satellite
  const sat = artifacts.captures.satellite;
  if (sat) {
    const satDst = join(refDir, 'satellite.jpg');
    if (!existsSync(satDst)) writeFileSync(satDst, Buffer.from(sat.imageBytes));
  }
}

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
  provenance: FullVerificationReport['provenance'];
  crossCheck: FullVerificationReport['crossCheck'];
  defectScore: FullVerificationReport['defectScore'];
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
    provenance: report.provenance,
    crossCheck: report.crossCheck,
    defectScore: report.defectScore,
    ...(report.reason ? { reason: report.reason } : {}),
  };

  state.addresses[slug] = record;
  writeFileSync(path, JSON.stringify(state, null, 2));
}
