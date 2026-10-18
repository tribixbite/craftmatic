#!/usr/bin/env bun
/**
 * Debug script: show top parts by volume in a model from OMR
 */

import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';

const setNum = Bun.argv[2] || '60067-1';
const url = `https://library.ldraw.org/library/omr/${setNum}.mpd`;

console.log(`Fetching ${url}...`);
const res = await fetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const text = await res.text();

const bricks = parseLDraw(text);
console.log(`Parsed ${bricks.length} bricks`);

// Count parts and compute volumes
const partVolumes: Record<string, { count: number; dims: [number,number,number]; totalVol: number; partId: string }> = {};
for (const brick of bricks) {
  const raw = (brick as any).part as string;
  if (!raw) continue;
  // strip .dat suffix for getPartDims
  const id = raw.replace(/\.dat$/i, '');
  const dims = getPartDims(id);
  const vol = dims[0] * dims[1] * dims[2];
  if (!partVolumes[id]) {
    partVolumes[id] = { count: 0, dims: dims as [number,number,number], totalVol: 0, partId: raw };
  }
  partVolumes[id].count++;
  partVolumes[id].totalVol += vol;
}

// Sort by total volume descending
const sorted = Object.values(partVolumes).sort((a, b) => b.totalVol - a.totalVol);

console.log(`\nTop 30 parts by total voxel volume (setNum=${setNum}):`);
console.log(`${'partId'.padEnd(12)} ${'count'.padEnd(6)} ${'dims'.padEnd(16)} ${'perVol'.padEnd(8)} ${'totalVol'}`);
console.log('-'.repeat(70));
for (const p of sorted.slice(0, 30)) {
  const dimsStr = `[${p.dims.join(',')}]`;
  const perVol = p.dims[0] * p.dims[1] * p.dims[2];
  console.log(`${p.partId.padEnd(12)} ${String(p.count).padEnd(6)} ${dimsStr.padEnd(16)} ${String(perVol).padEnd(8)} ${p.totalVol}`);
}

// Also show parts where all dims are [1,1,1] (defaulted)
const defaulted = Object.values(partVolumes).filter(p => p.dims[0] === 1 && p.dims[1] === 1 && p.dims[2] === 1);
console.log(`\nParts defaulting to [1,1,1]: ${defaulted.length} unique, ${defaulted.reduce((s, p) => s + p.count, 0)} total bricks`);

// Show largest Y-span parts (likely causing tall superstructure)
const tallParts = Object.values(partVolumes).filter(p => p.dims[1] > 10).sort((a, b) => b.dims[1] - a.dims[1]);
if (tallParts.length > 0) {
  console.log(`\nParts with sH > 10 (tall, potentially causing height issues):`);
  for (const p of tallParts.slice(0, 15)) {
    const dimsStr = `[${p.dims.join(',')}]`;
    console.log(`  ${p.partId.padEnd(12)} ${String(p.count).padEnd(6)} ${dimsStr}`);
  }
}
