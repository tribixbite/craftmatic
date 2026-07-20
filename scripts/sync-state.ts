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

let updated = 0;
for (const slug of readdirSync(pipeDir)) {
  const vPath = join(pipeDir, slug, `${slug}.verification.json`);
  if (!existsSync(vPath)) continue;
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
