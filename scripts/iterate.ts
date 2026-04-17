#!/usr/bin/env bun
/**
 * Iterate pipeline state — scans output/pipeline-state.json, picks the worst
 * non-terminal status, and prints a recommended action.
 *
 * Consumed by humans or by an outer driver. Does NOT invoke `scripts/build.ts`
 * itself — printing the address lets the caller decide whether to retry.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
const statePath = resolve(projectRoot, 'output/pipeline-state.json');

if (!existsSync(statePath)) {
  console.log('no state file — run `bun scripts/build.ts "<address>"` first');
  process.exit(0);
}

interface StateRecord {
  readonly status: 'pass' | 'fail-objective' | 'fail-consensus' | 'needs-human-review' | 'context-insufficient';
  readonly objective?: { readonly failures?: readonly string[] } | null;
  readonly consensus?: { readonly min?: number; readonly median?: number; readonly spread?: number; readonly rounds?: number } | null;
  readonly reason?: string;
}

const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
  addresses: Record<string, StateRecord>;
};
const addresses = state.addresses ?? {};
const slugs = Object.keys(addresses);
if (slugs.length === 0) {
  console.log('state file empty');
  process.exit(0);
}

// Counters
const counts: Record<string, string[]> = {
  'pass': [], 'fail-objective': [], 'fail-consensus': [],
  'needs-human-review': [], 'context-insufficient': [],
};
for (const slug of slugs) {
  const rec = addresses[slug];
  const bucket = counts[rec.status] ?? (counts[rec.status] = []);
  bucket.push(slug);
}

// Summary
console.log(`Summary (${slugs.length} addresses):`);
for (const status of ['pass', 'fail-objective', 'fail-consensus', 'needs-human-review', 'context-insufficient']) {
  const list = counts[status] ?? [];
  if (list.length > 0) console.log(`  ${status}: ${list.length} (${list.slice(0, 3).join(', ')}${list.length > 3 ? '…' : ''})`);
}

// Worst recommendation
const priorityOrder = ['fail-objective', 'fail-consensus', 'needs-human-review', 'context-insufficient'];
for (const status of priorityOrder) {
  const list = counts[status] ?? [];
  if (list.length === 0) continue;
  const worst = list[0];
  const rec = addresses[worst];
  console.log(`\nWorst: ${worst} (${status})`);
  if (status === 'fail-objective' && rec.objective?.failures?.length) {
    console.log(`  failures: ${rec.objective.failures.join('; ')}`);
    console.log(`  action: rebuild — bun scripts/build.ts "<address>"`);
  } else if (status === 'fail-consensus' && rec.consensus) {
    console.log(`  consensus min=${rec.consensus.min} median=${rec.consensus.median} spread=${rec.consensus.spread}`);
    console.log(`  action: re-render + re-grade — bun scripts/build.ts "<address>"`);
  } else if (status === 'needs-human-review') {
    console.log('  action: manual inspection — VLMs disagree');
  } else if (status === 'context-insufficient') {
    console.log(`  reason: ${rec.reason ?? 'unknown'}`);
    console.log('  action: add OSM polygon manually or skip this address');
  }
  break;
}

process.exit(0);
