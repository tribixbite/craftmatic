#!/usr/bin/env bun
/**
 * iterate-category-grade.ts — Multi-category VLM grading orchestrator.
 *
 * For each test location: voxelize → render → score 7 categories → store results.
 * Uses the honest, neutral category prompts from src/grade/ (no leading questions).
 *
 * State persists to output/category-state.json for cross-session continuation.
 * Plateau detection: 3 consecutive iterations with <0.3 composite improvement → plateau.
 *
 * Usage:
 *   bun scripts/iterate-category-grade.ts [options]
 *
 * Options:
 *   --group old|new|extra|all    Location group (default: all)
 *   --only <key>                 Single location key
 *   --version <v>                Version tag (default: v400)
 *   --model <m>                  VLM model (default: gemini-2.5-pro)
 *   --runs <n>                   VLM runs per location (default: 3)
 *   --grade-only                 Skip voxelization, grade existing renders
 *   --scene                      Enable scene mode (roads, trees, paths)
 *   --recolor                    Enable semantic recolor (SV/satellite)
 *   --target <n>                 Target composite score (default: 9)
 *   --refresh-ref                Re-fetch reference images even if cached
 *
 * Requires: GOOGLE_API_KEY (for VLM) + GOOGLE_MAPS_API_KEY (for satellite/SV)
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { scoreCategories, type CategoryScoreInput, type CompositeScore } from '../src/grade/category-score.js';
import { ALL_LOCATIONS, getLocationsByGroup, type CategoryLocation, type LocationGroup } from '../src/grade/category-locations.js';
import type { CategoryScores, CategoryResult } from '../src/grade/parse-category-scores.js';
import type { ScoreCategory } from '../src/grade/category-prompts.js';

// ─── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getFlag(name: string, def: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : def;
}
function hasFlag(name: string): boolean { return args.includes(name); }

const version = getFlag('--version', 'v400');
const vlmModel = getFlag('--model', 'gemini-2.5-pro');
const vlmRuns = parseInt(getFlag('--runs', '3'), 10);
const gradeOnly = hasFlag('--grade-only');
const sceneMode = hasFlag('--scene');
const recolorMode = hasFlag('--recolor');
const group = getFlag('--group', 'all') as LocationGroup;
const onlyKey = getFlag('--only', '');
const targetScore = parseFloat(getFlag('--target', '9'));
const refreshRef = hasFlag('--refresh-ref');

// ─── API Keys ───────────────────────────────────────────────────────────────

const geminiApiKey = process.env.GOOGLE_API_KEY
  || process.env.GOOGLE_GEMINI_API_KEY
  || (existsSync('.env') ? readFileSync('.env', 'utf8').match(/GOOGLE_(?:GEMINI_)?API_KEY=(.+)/)?.[1]?.trim() : undefined);
if (!geminiApiKey) { console.error('No GOOGLE_API_KEY (for Gemini VLM grading)'); process.exit(1); }

const mapsApiKey = process.env.GOOGLE_MAPS_API_KEY
  || geminiApiKey;

// ─── Constants ──────────────────────────────────────────────────────────────

const DIR = 'output/tiles';
const REF_DIR = 'output/reference-data';
const STATE_PATH = 'output/category-state.json';
const MAX_PLATEAU_ITERS = 3;

// ─── State Types ────────────────────────────────────────────────────────────

interface CategoryGradeResult {
  /** Per-category scores from last grading */
  categories: CategoryScores;
  /** Weighted composite score */
  composite: number;
  /** Number of categories scored */
  scoredCount: number;
  /** Defects reported per category */
  defects: Record<string, string[]>;
}

interface LocationState {
  key: string;
  name: string;
  /** History of composite scores (for plateau detection) */
  compositeHistory: number[];
  /** Latest grading result */
  latestGrade: CategoryGradeResult | null;
  /** Average of multiple VLM runs */
  averageGrade: CategoryGradeResult | null;
  /** Number of VLM runs for average */
  runCount: number;
  /** Version tag when last graded */
  lastVersion: string;
  /** ISO timestamp of last grade */
  lastGraded: string;
  /** Whether this location has plateaued */
  plateaued: boolean;
  /** Lowest-scoring categories (for fix targeting) */
  worstCategories: string[];
}

interface CategoryState {
  version: string;
  timestamp: string;
  target: number;
  model: string;
  passing: number;
  total: number;
  locations: Record<string, LocationState>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Run a shell command, return stdout+stderr. Throws on non-zero exit. */
async function run(cmd: string, timeoutMs = 300_000): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', cmd], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timer);
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`  CMD FAILED (${code}): ${cmd}\n  ${stderr.slice(0, 500)}`);
    throw new Error(`Command failed: ${cmd}`);
  }
  return stdout + stderr;
}

/** Ensure reference data exists for a location (SV + satellite images) */
async function ensureReferenceData(loc: CategoryLocation): Promise<{
  svImages: string[];
  satelliteImage: string;
}> {
  const refDir = join(REF_DIR, loc.key);
  const svPaths = ['front', 'right', 'rear', 'left']
    .map(face => join(refDir, `sv-${face}.jpg`))
    .filter(p => existsSync(p));
  const satPath = join(refDir, 'satellite.jpg');

  // If reference data is missing, try to fetch it
  if (svPaths.length === 0 || !existsSync(satPath) || refreshRef) {
    console.log(`  Fetching reference data for ${loc.key}...`);
    try {
      await run(
        `bun scripts/fetch-reference-data.ts --only ${loc.key}${refreshRef ? ' --refresh' : ''}`,
        60_000,
      );
    } catch (e) {
      console.warn(`  Reference data fetch failed: ${(e as Error).message}`);
    }
    // Re-check after fetch
    const newSvPaths = ['front', 'right', 'rear', 'left']
      .map(face => join(refDir, `sv-${face}.jpg`))
      .filter(p => existsSync(p));
    return {
      svImages: newSvPaths,
      satelliteImage: existsSync(satPath) ? satPath : '',
    };
  }

  return { svImages: svPaths, satelliteImage: existsSync(satPath) ? satPath : '' };
}

/** Voxelize a building, return schem path + grid dimensions */
async function voxelize(loc: CategoryLocation): Promise<{
  schem: string; gridWidth: number; gridHeight: number; gridLength: number;
}> {
  if (!loc.glb || !existsSync(loc.glb)) {
    throw new Error(`No GLB model: ${loc.glb ?? 'undefined'}`);
  }

  // MUST use absolute path for -o — voxelizer resolves relative to its own cwd
  const schem = resolve(`${DIR}/${loc.key}-${version}.schem`);
  const flagParts = [
    'bun scripts/voxelize-glb.ts', `"${loc.glb}"`, '--auto',
    '--coords', `"${loc.coords}"`,
    '--mask-dilate', String(loc.maskDilate),
    '--gamma', '0.4',
  ];
  if (sceneMode || loc.sceneMode) flagParts.push('--scene');
  if (recolorMode) flagParts.push('--recolor');
  if (loc.resolution > 0) flagParts.push('-r', String(loc.resolution));
  if (loc.osmId) flagParts.push('--osm-id', loc.osmId);
  // Shell-quote each extraFlag value so '#' hex colors aren't treated as bash comments
  const quotedExtraFlags = loc.extraFlags.map(f =>
    f.startsWith('#') || f.includes(' ') ? `"${f}"` : f,
  );
  flagParts.push('-o', `"${schem}"`, ...quotedExtraFlags);

  console.log(`  Voxelizing: ${loc.key} (r=${loc.resolution}, dilate=${loc.maskDilate})`);
  const out = await run(flagParts.join(' '), 2_400_000);

  let gridWidth = 0, gridHeight = 0, gridLength = 0;
  for (const line of out.split('\n')) {
    const gridMatch = line.match(/Grid:\s*(\d+)x(\d+)x(\d+)/);
    if (gridMatch) {
      gridWidth = parseInt(gridMatch[1], 10);
      gridHeight = parseInt(gridMatch[2], 10);
      gridLength = parseInt(gridMatch[3], 10);
    }
  }
  console.log(`  Grid: ${gridWidth}×${gridHeight}×${gridLength}`);
  return { schem, gridWidth, gridHeight, gridLength };
}

/** Render iso + topdown + front elevation JPEGs from schem */
async function renderViews(loc: CategoryLocation, schem: string): Promise<{
  iso: string; topdown: string; front: string;
}> {
  const iso = schem.replace('.schem', '-iso.jpg');
  const topdown = schem.replace('.schem', '-topdown.jpg');
  const front = schem.replace('.schem', '-front.jpg');

  const tile = loc.resolution >= 2 ? 8 : 10;
  const scale = loc.resolution >= 2 ? 10 : 12;

  console.log(`  Rendering: iso (tile=${tile}) + topdown (scale=${scale}) + front`);
  await run(`bun scripts/_render-one.ts "${schem}" "${iso}" --tile ${tile}`);
  await run(`bun scripts/_render-topdown.ts "${schem}" "${topdown}" --scale ${scale}`);
  await run(`bun scripts/_render-front.ts "${schem}" "${front}" --scale ${scale}`);

  return { iso, topdown, front };
}

/** Grade one location with the 7-category VLM scorer */
async function gradeLocation(
  loc: CategoryLocation,
  svImages: string[],
  satelliteImage: string,
  renders: { iso: string; topdown: string; front: string },
  knownDimensions?: { widthM: number; depthM: number; heightM?: number },
): Promise<CompositeScore | null> {
  const input: CategoryScoreInput = {
    svImages,
    satelliteImage,
    isoImage: renders.iso,
    frontImage: renders.front,
    topdownImage: renders.topdown,
    sceneMode: sceneMode || loc.sceneMode,
    knownDimensions,
    apiKey: geminiApiKey!,
    model: vlmModel,
    temperature: 0.0,
  };

  return scoreCategories(input);
}

/** Average multiple CompositeScore results into a single summary */
function averageGrades(grades: CompositeScore[]): CategoryGradeResult {
  const catNames: ScoreCategory[] = [
    'colors', 'features', 'layout', 'walking_paths', 'pavement', 'vegetation', 'dimensions',
  ];

  const avgCategories: CategoryScores = {
    colors: null, features: null, layout: null,
    walking_paths: null, pavement: null, vegetation: null, dimensions: null,
  };
  const allDefects: Record<string, string[]> = {};

  for (const cat of catNames) {
    const results = grades
      .map(g => g.categories[cat])
      .filter((r): r is CategoryResult => r !== null);
    if (results.length === 0) continue;

    const avgScore = Math.round(
      (results.reduce((s, r) => s + r.score, 0) / results.length) * 10,
    ) / 10;
    // Collect all unique defects across runs
    const defectSet = new Set<string>();
    for (const r of results) {
      for (const d of r.defects) defectSet.add(d);
    }
    avgCategories[cat] = { score: avgScore, defects: [...defectSet] };
    allDefects[cat] = [...defectSet];
  }

  const avgComposite = grades.length > 0
    ? Math.round((grades.reduce((s, g) => s + g.composite, 0) / grades.length) * 10) / 10
    : 0;
  const scoredCount = catNames.filter(c => avgCategories[c] !== null).length;

  return { categories: avgCategories, composite: avgComposite, scoredCount, defects: allDefects };
}

/** Identify the worst-scoring categories for a location */
function findWorstCategories(grade: CategoryGradeResult, threshold = 9): string[] {
  const worst: { cat: string; score: number }[] = [];
  for (const [cat, result] of Object.entries(grade.categories)) {
    if (result && result.score < threshold) {
      worst.push({ cat, score: result.score });
    }
  }
  return worst.sort((a, b) => a.score - b.score).map(w => `${w.cat}(${w.score})`);
}

/** Detect plateau: 3+ consecutive composites within 0.3 of each other */
function isPlateaued(history: number[]): boolean {
  if (history.length < MAX_PLATEAU_ITERS) return false;
  const recent = history.slice(-MAX_PLATEAU_ITERS);
  const minVal = Math.min(...recent);
  const maxVal = Math.max(...recent);
  return (maxVal - minVal) < 0.3;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let locations = getLocationsByGroup(group);
  if (onlyKey) {
    locations = locations.filter(l => l.key === onlyKey);
    if (locations.length === 0) {
      console.error(`Unknown key: ${onlyKey}. Available: ${ALL_LOCATIONS.map(l => l.key).join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n=== iterate-category-grade ${version} | ${locations.length} locations | ${vlmRuns} runs | ${vlmModel} ===`);
  console.log(`Target: ${targetScore}/10 composite | Scene: ${sceneMode} | Recolor: ${recolorMode}\n`);

  // Load or init state
  let state: CategoryState;
  if (existsSync(STATE_PATH)) {
    state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    state.version = version;
    state.timestamp = new Date().toISOString();
    state.model = vlmModel;
  } else {
    state = {
      version, timestamp: new Date().toISOString(),
      target: targetScore, model: vlmModel,
      passing: 0, total: locations.length,
      locations: {},
    };
  }

  let passing = 0;

  for (const loc of locations) {
    console.log(`\n── ${loc.name} (${loc.key}) ──`);

    // Check if plateaued
    const existing = state.locations[loc.key];
    if (existing?.plateaued && !refreshRef) {
      console.log(`  PLATEAUED — skipping (composite history: [${existing.compositeHistory.join(', ')}])`);
      if (existing.averageGrade && existing.averageGrade.composite >= targetScore) passing++;
      continue;
    }

    // Step 1: Ensure reference data (SV + satellite)
    const refData = await ensureReferenceData(loc);
    if (refData.svImages.length === 0 && !refData.satelliteImage) {
      console.warn(`  No reference images available — skipping`);
      continue;
    }
    console.log(`  Reference: ${refData.svImages.length} SV + ${refData.satelliteImage ? '1 satellite' : 'no satellite'}`);

    // Step 2: Voxelize (or use existing renders)
    let renders: { iso: string; topdown: string; front: string };
    const schem = resolve(`${DIR}/${loc.key}-${version}.schem`);
    const defaultRenders = {
      iso: schem.replace('.schem', '-iso.jpg'),
      topdown: schem.replace('.schem', '-topdown.jpg'),
      front: schem.replace('.schem', '-front.jpg'),
    };

    if (!gradeOnly && loc.glb && existsSync(loc.glb)) {
      try {
        const voxResult = await voxelize(loc);
        renders = await renderViews(loc, voxResult.schem);
      } catch (e) {
        console.error(`  Voxelize/render failed: ${(e as Error).message}`);
        // Try existing renders
        if (existsSync(defaultRenders.iso)) {
          console.log(`  Using existing renders`);
          renders = defaultRenders;
        } else {
          continue;
        }
      }
    } else if (existsSync(defaultRenders.iso) && existsSync(defaultRenders.topdown)) {
      console.log(`  Using existing renders (grade-only or no GLB)`);
      renders = defaultRenders;
    } else {
      console.log(`  SKIP: no GLB model and no existing renders`);
      continue;
    }

    // Step 3: Build known dimensions from extent
    const knownDimensions = loc.extentM
      ? { widthM: loc.extentM, depthM: loc.extentM * 0.7 }
      : undefined;

    // Step 4: Grade N times with VLM
    console.log(`  Grading (${vlmRuns} runs, ${vlmModel}, temp=0.0)...`);
    const grades: CompositeScore[] = [];
    for (let i = 0; i < vlmRuns; i++) {
      const result = await gradeLocation(
        loc, refData.svImages, refData.satelliteImage, renders, knownDimensions,
      );
      if (result) {
        grades.push(result);
        const cats = Object.entries(result.categories)
          .filter(([, r]) => r !== null)
          .map(([c, r]) => `${c}=${r!.score}`)
          .join(' ');
        console.log(`    Run ${i + 1}/${vlmRuns}: composite=${result.composite} | ${cats}`);
      } else {
        console.log(`    Run ${i + 1}/${vlmRuns}: FAILED`);
      }
      // Rate limiting
      if (i < vlmRuns - 1) await Bun.sleep(5000);
    }

    if (grades.length === 0) {
      console.error(`  All VLM runs failed — skipping`);
      continue;
    }

    // Step 5: Average results
    const avgGrade = averageGrades(grades);
    const worstCats = findWorstCategories(avgGrade, targetScore);

    console.log(`  Average composite: ${avgGrade.composite}/10 (${avgGrade.scoredCount} categories)`);
    if (worstCats.length > 0) {
      console.log(`  Worst: ${worstCats.join(', ')}`);
    } else {
      console.log(`  All categories >= ${targetScore}`);
    }

    // Step 6: Update state
    const locState: LocationState = {
      key: loc.key,
      name: loc.name,
      compositeHistory: [...(existing?.compositeHistory ?? []), avgGrade.composite],
      latestGrade: avgGrade,
      averageGrade: avgGrade,
      runCount: grades.length,
      lastVersion: version,
      lastGraded: new Date().toISOString(),
      plateaued: false,
      worstCategories: worstCats,
    };

    // Check plateau
    if (isPlateaued(locState.compositeHistory)) {
      locState.plateaued = true;
      console.log(`  PLATEAU DETECTED: last ${MAX_PLATEAU_ITERS} composites within 0.3`);
    }

    if (avgGrade.composite >= targetScore) {
      passing++;
      console.log(`  PASS (>= ${targetScore})`);
    } else {
      console.log(`  FAIL (${avgGrade.composite} < ${targetScore})`);
    }

    state.locations[loc.key] = locState;

    // Save state after each location (crash resilience)
    state.passing = passing;
    state.total = locations.length;
    state.timestamp = new Date().toISOString();
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  }

  // ── Final Summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Category Grade Summary: ${passing}/${locations.length} passing (target: ${targetScore}/10)`);
  console.log(`${'═'.repeat(60)}`);

  // Per-location table
  const header = 'Location'.padEnd(22) + 'Comp'.padStart(6) + 'Col'.padStart(6)
    + 'Feat'.padStart(6) + 'Lay'.padStart(6) + 'Dim'.padStart(6)
    + (sceneMode ? 'Walk'.padStart(6) + 'Pave'.padStart(6) + 'Veg'.padStart(6) : '')
    + '  Status';
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const loc of locations) {
    const ls = state.locations[loc.key];
    if (!ls?.averageGrade) {
      console.log(`${loc.key.padEnd(22)}  (no data)`);
      continue;
    }
    const g = ls.averageGrade;
    const cats = g.categories;
    const catScore = (r: CategoryResult | null) => r ? r.score.toFixed(1).padStart(5) : '  ---';
    const status = g.composite >= targetScore ? 'PASS'
      : ls.plateaued ? 'PLATEAU'
      : `FAIL [${ls.worstCategories.slice(0, 2).join(', ')}]`;

    console.log(
      loc.key.padEnd(22)
      + g.composite.toFixed(1).padStart(6)
      + catScore(cats.colors) + catScore(cats.features) + catScore(cats.layout) + catScore(cats.dimensions)
      + (sceneMode ? catScore(cats.walking_paths) + catScore(cats.pavement) + catScore(cats.vegetation) : '')
      + `  ${status}`,
    );
  }

  console.log(`\nState saved: ${STATE_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
