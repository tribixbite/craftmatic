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
import {
  rankCandidates,
  isBlockedOnConsensus,
  type Status,
  type RankRecord,
  type RankedCandidate,
} from './iterate-ranking.js';

const projectRoot = resolve(import.meta.dir, '..');
const statePath = resolve(projectRoot, 'output/pipeline-state.json');
const goldensPath = resolve(projectRoot, 'output/goldens.json');
const outDir = resolve(projectRoot, 'output/pipeline');
const failedDir = resolve(projectRoot, 'output/failed');

// ─── Types ─────────────────────────────────────────────────────────────────

interface Golden {
  slug: string;
  address: string;
  notes?: string;
}

interface GoldensFile {
  goldens: Golden[];
}

interface StateRecord {
  address: string;
  status: Status;
  lastRun: string;
  elapsedSec: number;
  attempts: number;
  recentFailureSignatures: string[];
  objective?: { footprintIoU?: number; heightErr?: number; watertight?: boolean; failures?: string[] } | null;
  consensus?: { min?: number; median?: number; spread?: number; rounds?: number } | null;
  /** Deterministic defect score (Roadmap #4) — primary intra-status rank key. */
  defectScore?: { score?: number; penalties?: string[] } | null;
  /** Independent height cross-check (Roadmap #3). */
  crossCheck?: { truncationSuspected?: boolean; maxDisagreement?: number; ok?: boolean } | null;
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

/** Project a state record into the ranking subset (deterministic signals). */
function toRankRecord(slug: string, rec: StateRecord): RankRecord {
  return {
    slug,
    status: rec.status,
    attempts: rec.attempts,
    defectScore: rec.defectScore?.score ?? null,
    consensusMedian: rec.consensus?.median ?? null,
  };
}

/** Terminal statuses are skipped — rebuilding can't change them. */
function isRemediable(rec: StateRecord | undefined): rec is StateRecord {
  return Boolean(rec)
    && rec!.status !== 'pass'
    && rec!.status !== 'needs-human-review'
    && rec!.status !== 'context-insufficient';
}

/**
 * VLM credential presence — the same check `runBuild` uses to decide whether
 * `--consensus gemini` can be wired. The queue must agree with the builder:
 * if the builder can't score consensus, a consensus-only failure can't be
 * remediated by rebuilding.
 */
function hasVlmKey(): boolean {
  return Boolean(process.env['GOOGLE_GEMINI_API_KEY'] ?? process.env['GEMINI_API_KEY']);
}

/**
 * Ranked remediation queue (worst/most-urgent first). Ranks on deterministic
 * defectScore + failed-history trend, with VLM consensus only as a final
 * tie-break (see `iterate-ranking.ts`). Records blocked on missing VLM
 * credentials are excluded — rebuilding them reproduces the identical report.
 */
function remediationQueue(state: StateFile, goldens: Golden[]): RankedCandidate[] {
  const vlm = hasVlmKey();
  const records = goldens
    .filter(g => isRemediable(state.addresses[g.slug]))
    .map(g => toRankRecord(g.slug, state.addresses[g.slug]))
    .filter(r => !isBlockedOnConsensus(r, vlm));
  return rankCandidates(records, failedDir);
}

/** Slugs excluded from the queue because consensus can't run without a key. */
function blockedOnConsensus(state: StateFile, goldens: Golden[]): string[] {
  const vlm = hasVlmKey();
  return goldens
    .filter(g => isRemediable(state.addresses[g.slug]))
    .map(g => toRankRecord(g.slug, state.addresses[g.slug]))
    .filter(r => isBlockedOnConsensus(r, vlm))
    .map(r => r.slug);
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
      const defect = rec.defectScore?.score != null ? `defect=${rec.defectScore.score.toFixed(1)} ` : '';
      const trunc = rec.crossCheck?.truncationSuspected ? 'trunc ' : '';
      console.log(`  ${s.padEnd(16)} ${rec.status.padEnd(22)} attempts=${rec.attempts} ${defect}${trunc}— ${failStr}`);
    }
  }

  // Ranked remediation queue — the order --worst will walk (worst first).
  const queue = remediationQueue(state, goldens);
  if (queue.length > 0) {
    console.log(`\n─── Remediation queue (worst first) ───`);
    for (const c of queue) {
      const defect = c.record.defectScore != null ? c.record.defectScore.toFixed(1) : '-';
      console.log(`  ${c.record.slug.padEnd(16)} ${c.record.status.padEnd(18)} trend=${c.trend.padEnd(11)} defect=${defect} attempts=${c.record.attempts}`);
    }
  }

  const blocked = blockedOnConsensus(state, goldens);
  if (blocked.length > 0) {
    console.log(`\n─── Blocked awaiting VLM credentials (${blocked.length}) ───`);
    console.log(`  ${blocked.join(', ')}`);
    console.log(`  Objective gates pass; consensus never ran (no GEMINI_API_KEY).`);
    console.log(`  Rebuilding cannot change these — set a key, then rerun --worst.`);
  }
}

function pickWorst(state: StateFile, goldens: Golden[]): RankedCandidate | null {
  const queue = remediationQueue(state, goldens);
  return queue[0] ?? null;
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
  const top = pickWorst(state, goldens);
  if (!top) {
    const blocked = blockedOnConsensus(state, goldens);
    if (blocked.length > 0) {
      console.log(`nothing actionable: ${blocked.length} slug(s) blocked awaiting VLM credentials (${blocked.join(', ')})`);
    } else {
      console.log('no non-passing / non-terminal addresses — all goldens pass or require human review');
    }
    summarise(state, goldens);
    process.exit(0);
  }
  const g = goldens.find(x => x.slug === top.record.slug);
  if (!g) {
    console.error(`internal: ranked slug ${top.record.slug} not in goldens`);
    process.exit(1);
  }
  const defect = top.record.defectScore != null ? top.record.defectScore.toFixed(1) : '-';
  console.error(`worst: ${g.slug} (${top.record.status}, trend=${top.trend}, defect=${defect}, ${top.record.attempts} attempts)`);
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
