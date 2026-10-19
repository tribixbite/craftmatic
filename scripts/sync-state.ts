#!/usr/bin/env bun
/**
 * Re-sync `output/pipeline-state.json` from each build's on-disk
 * `<slug>.verification.json` — repairs records lost to the (now-fixed)
 * concurrent-merge race. A slug's state is replaced only when the artifact's
 * lastRun is NEWER than the state record's; attempts/failure-signature
 * history is preserved.
 *
 * Usage: bun scripts/sync-state.ts
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { FullVerificationReport } from '../src/pipeline/verify/report.js';

const projectRoot = resolve(import.meta.dir, '..');
const stateFile = join(projectRoot, 'output/pipeline-state.json');
const pipeDir = join(projectRoot, 'output/pipeline');

interface StateShape {
  version?: string;
  addresses: Record<string, Record<string, unknown> & { lastRun?: string }>;
}
const state: StateShape = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8')) as StateShape
  : { version: 'v400', addresses: {} };
if (!state.addresses) state.addresses = {};

// Builds write FLAT `output/pipeline/<slug>.verification.json`; a legacy
// per-slug subdirectory layout also exists. The original loop only probed
// the subdirectory form, so it synced 0 records against every current
// artifact. Collect slug → newest artifact path across both layouts.
const artifactPaths = new Map<string, string>();
for (const entry of readdirSync(pipeDir)) {
  if (entry.endsWith('.verification.json')) {
    artifactPaths.set(entry.slice(0, -'.verification.json'.length), join(pipeDir, entry));
  } else {
    const nested = join(pipeDir, entry, `${entry}.verification.json`);
    if (!artifactPaths.has(entry) && existsSync(nested)) artifactPaths.set(entry, nested);
  }
}

let updated = 0;
for (const [slug, vPath] of artifactPaths) {
  const report = JSON.parse(readFileSync(vPath, 'utf8')) as FullVerificationReport;
  const prev = state.addresses[slug];
  if (prev?.lastRun && report.lastRun <= prev.lastRun) continue;
  state.addresses[slug] = {
    ...(prev ?? { address: slug, attempts: 0, recentFailureSignatures: [], elapsedSec: 0 }),
    status: report.status,
    lastRun: report.lastRun,
    objective: report.objective,
    consensus: report.consensus,
    provenance: report.provenance,
    crossCheck: report.crossCheck,
    defectScore: report.defectScore,
    synthesisPath: report.synthesisPath ?? null,
    resolution: report.resolution ?? null,
  };
  updated++;
  console.error(`synced ${slug} ← ${report.lastRun}`);
}
const tmp = `${stateFile}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(state, null, 2));
renameSync(tmp, stateFile);
console.error(`updated ${updated} records`);
