#!/usr/bin/env bun
/**
 * Pipeline iteration driver — the automation loop that keeps improving the
 * new pipeline until all goldens pass.
 *
 * Subcommands:
 *   bun scripts/iterate.ts --status              Print current state summary, exit 0.
 *   bun scripts/iterate.ts --bootstrap           Build every golden that lacks a state entry.
 *   bun scripts/iterate.ts --only <slug>         Rebuild one address.
 *   bun scripts/iterate.ts --worst               Rebuild the worst non-passing address.
 *   bun scripts/iterate.ts --all                 Rebuild every golden regardless of current state.
 *
 * Uses `scripts/build.ts` under the hood — delegates all actual pipeline work.
 * Writes results into `output/pipeline-state.json` (which the stop hook reads).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dir, '..');
const statePath = resolve(projectRoot, 'output/pipeline-state.json');
const goldensPath = resolve(projectRoot, 'output/goldens.json');
const outDir = resolve(projectRoot, 'output/pipeline');

// ─── Types ─────────────────────────────────────────────────────────────────

interface Golden {
  slug: string;
  address: string;
  notes?: string;
}

interface GoldensFile {
  goldens: Golden[];
}

type Status = 'pass' | 'fail-objective' | 'fail-consensus' | 'needs-human-review' | 'context-insufficient';

interface StateRecord {
  address: string;
  status: Status;
  lastRun: string;
  elapsedSec: number;
  attempts: number;
  recentFailureSignatures: string[];
  objective?: { failures?: string[] } | null;
  consensus?: { min?: number; median?: number; spread?: number; rounds?: number } | null;
  reason?: string;
}

interface StateFile {
  version?: string;
  addresses: Record<string, StateRecord>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function loadGoldens(): Golden[] {
  if (!existsSync(goldensPath)) {
    console.error(`Goldens file missing: ${goldensPath}`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(goldensPath, 'utf8')) as GoldensFile;
  return data.goldens;
}

function loadState(): StateFile {
  if (!existsSync(statePath)) return { version: 'v400', addresses: {} };
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as StateFile;
  } catch {
    return { version: 'v400', addresses: {} };
  }
}

/** Rank a state record by remediation urgency. Lower = worse. */
function statusRank(status: Status): number {
  switch (status) {
    case 'fail-objective': return 0;
    case 'fail-consensus': return 1;
    case 'needs-human-review': return 2;
    case 'context-insufficient': return 3;
    case 'pass': return 4;
  }
}

function runBuild(golden: Golden, extraFlags: string[] = [], localTiles = false): number {
  console.error(`\n━━━ ${golden.slug} — ${golden.address} ━━━`);
  // Enable Gemini VLM consensus unless the caller explicitly disabled it
  // with --no-consensus. Without it, goldens stall at status:fail-consensus
  // with consensus=null and the hook blocks the loop.
  const hasGeminiKey = Boolean(process.env['GOOGLE_GEMINI_API_KEY'] ?? process.env['GEMINI_API_KEY']);
  const consensusFlag = !extraFlags.includes('--no-consensus') && hasGeminiKey
    ? ['--consensus', 'gemini']
    : [];
  const localGlb = localTiles ? LOCAL_TILES_GLBS[golden.slug] : undefined;
  const localGlbFlag = localGlb ? ['--tiles-glb', resolve(projectRoot, localGlb)] : [];
  const result = spawnSync('bun', [
    resolve(projectRoot, 'scripts/build.ts'),
    golden.address,
    '--out', outDir,
    '--slug', golden.slug,
    // Cap tile capture at 60s — skyscrapers can hang indefinitely otherwise.
    // Partial captures fall through to cleaned-tiles / parametric paths.
    '--tile-timeout', '60',
    ...consensusFlag,
    ...localGlbFlag,
    ...extraFlags.filter((f) => f !== '--no-consensus'),
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

function summarise(state: StateFile, goldens: Golden[]): void {
  const slugs = goldens.map(g => g.slug);
  const ungraded = slugs.filter(s => !state.addresses[s]);

  // Count by status
  const byStatus: Record<string, string[]> = {
    pass: [], 'fail-objective': [], 'fail-consensus': [],
    'needs-human-review': [], 'context-insufficient': [],
  };
  for (const s of slugs) {
    const rec = state.addresses[s];
    if (rec) (byStatus[rec.status] ?? []).push(s);
  }

  console.log(`\n═══ Iteration Status ═══`);
  console.log(`  Goldens:            ${goldens.length}`);
  console.log(`  Ungraded:           ${ungraded.length}${ungraded.length ? ` — ${ungraded.join(', ')}` : ''}`);
  console.log(`  Passing:            ${byStatus['pass'].length} (${byStatus['pass'].join(', ') || '-'})`);
  console.log(`  Fail objective:     ${byStatus['fail-objective'].length} (${byStatus['fail-objective'].join(', ') || '-'})`);
  console.log(`  Fail consensus:     ${byStatus['fail-consensus'].length} (${byStatus['fail-consensus'].join(', ') || '-'})`);
  console.log(`  Needs human review: ${byStatus['needs-human-review'].length} (${byStatus['needs-human-review'].join(', ') || '-'})`);
  console.log(`  Context insuff.:    ${byStatus['context-insufficient'].length} (${byStatus['context-insufficient'].join(', ') || '-'})`);

  // Failure detail for each non-passing slug
  const nonPassing = slugs.filter(s => {
    const rec = state.addresses[s];
    return rec && rec.status !== 'pass';
  });
  if (nonPassing.length > 0) {
    console.log(`\n─── Failure detail ───`);
    for (const s of nonPassing) {
      const rec = state.addresses[s];
      const failStr = rec.objective?.failures?.slice(0, 2).join('; ')
        ?? (rec.consensus ? `consensus min=${rec.consensus.min} median=${rec.consensus.median}` : '-');
      console.log(`  ${s.padEnd(16)} ${rec.status.padEnd(22)} attempts=${rec.attempts} — ${failStr}`);
    }
  }
}

function pickWorst(state: StateFile, goldens: Golden[]): Golden | null {
  const candidates: Array<{ golden: Golden; rec: StateRecord }> = [];
  for (const g of goldens) {
    const rec = state.addresses[g.slug];
    if (!rec) continue;
    if (rec.status === 'pass') continue;
    if (rec.status === 'needs-human-review') continue; // terminal — skip
    if (rec.status === 'context-insufficient') continue; // terminal — skip
    candidates.push({ golden: g, rec });
  }
  if (candidates.length === 0) return null;
  // Sort by (status rank asc, then attempts asc so under-tried ones go first)
  candidates.sort((a, b) => {
    const byStatus = statusRank(a.rec.status) - statusRank(b.rec.status);
    if (byStatus !== 0) return byStatus;
    return a.rec.attempts - b.rec.attempts;
  });
  return candidates[0].golden;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function hasFlag(name: string): boolean { return argv.includes(name); }
function popArg(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const goldens = loadGoldens();
const state = loadState();

if (hasFlag('--status') || argv.length === 0) {
  summarise(state, goldens);
  process.exit(0);
}

// --fast: skip tile capture entirely → parametric synthesis directly from
// evidence. Useful for initial validation before paying the tile-API cost.
const fast = hasFlag('--fast');
const resOverride = popArg('--resolution');
const maxDimOverride = popArg('--max-dim');
const tilesGlbOverride = popArg('--tiles-glb');
const useLocalTiles = hasFlag('--local-tiles');
const extraBuildFlags = [
  ...(fast ? ['--skip-tiles'] : []),
  ...(resOverride !== null ? ['--resolution', resOverride] : []),
  ...(maxDimOverride !== null ? ['--max-dim', maxDimOverride] : []),
  ...(tilesGlbOverride !== null ? ['--tiles-glb', tilesGlbOverride] : []),
];

/**
 * Per-golden GLB lookup for `--local-tiles`. Maps slug to its locally-cached
 * photogrammetry capture. Used when Google 3D Tiles API is rate-limiting /
 * unstable, allowing the loop to iterate against the deterministic last-
 * known-good capture.
 */
const LOCAL_TILES_GLBS: Record<string, string> = {
  flatiron: 'output/tiles/tiles-flatiron-building-new-york-ny.glb',
  '240-highland': 'output/tiles/tiles-240-highland-st-newton-ma-02465.glb',
  pennzoil: 'output/tiles/pennzoil-new2.glb',
  guggenheim: 'output/tiles/guggenheim.glb',
  geisel: 'output/tiles/geisel-v200.glb',
};

if (hasFlag('--bootstrap')) {
  const targets = goldens.filter(g => !state.addresses[g.slug]);
  if (targets.length === 0) {
    console.log('bootstrap: all goldens already have state entries — nothing to do');
    summarise(state, goldens);
    process.exit(0);
  }
  console.log(`bootstrap: building ${targets.length} ungraded goldens${fast ? ' (fast, skip-tiles)' : ''}…`);
  let failed = 0;
  for (const g of targets) {
    const code = runBuild(g, extraBuildFlags, useLocalTiles);
    if (code !== 0) failed++;
  }
  summarise(loadState(), goldens);
  process.exit(failed > 0 ? 1 : 0);
}

if (hasFlag('--all')) {
  console.log(`rebuilding all ${goldens.length} goldens${fast ? ' (fast)' : ''}…`);
  let failed = 0;
  for (const g of goldens) {
    const code = runBuild(g, extraBuildFlags, useLocalTiles);
    if (code !== 0) failed++;
  }
  summarise(loadState(), goldens);
  process.exit(failed > 0 ? 1 : 0);
}

const only = popArg('--only');
if (only) {
  const g = goldens.find(x => x.slug === only);
  if (!g) {
    console.error(`Unknown slug: ${only}`);
    console.error(`Known: ${goldens.map(x => x.slug).join(', ')}`);
    process.exit(1);
  }
  const code = runBuild(g, extraBuildFlags, useLocalTiles);
  summarise(loadState(), goldens);
  process.exit(code);
}

if (hasFlag('--worst')) {
  const g = pickWorst(state, goldens);
  if (!g) {
    console.log('no non-passing / non-terminal addresses — all goldens pass or require human review');
    summarise(state, goldens);
    process.exit(0);
  }
  const rec = state.addresses[g.slug];
  console.error(`worst: ${g.slug} (${rec.status}, ${rec.attempts} attempts)`);
  const code = runBuild(g, extraBuildFlags, useLocalTiles);
  summarise(loadState(), goldens);
  process.exit(code);
}

console.error('Unknown or missing subcommand.\n');
console.error('Usage:');
console.error('  bun scripts/iterate.ts --status');
console.error('  bun scripts/iterate.ts --bootstrap');
console.error('  bun scripts/iterate.ts --only <slug>');
console.error('  bun scripts/iterate.ts --worst');
console.error('  bun scripts/iterate.ts --all');
process.exit(1);
