/**
 * Quick diagnostic for LEGO model voxelization issues.
 * Usage: bun scripts/diagnose-model.ts "C:/git/clego/lego_sets/LDR/8653 Enzo Ferrari.mpd"
 */
import { readFileSync } from 'fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims, hasDims } from '../web/src/engine/ldraw-part-dims.js';

const file = process.argv[2];
if (!file) { console.error('Usage: bun scripts/diagnose-model.ts <file>'); process.exit(1); }

const text = readFileSync(file, 'utf-8');
const bricks = parseLDraw(text);

console.log(`Parsed ${bricks.length} bricks`);

// Y distribution
const yVals = bricks.map(b => b.y);
const yMin = Math.min(...yVals);
const yMax = Math.max(...yVals);
const yAvg = yVals.reduce((a,b) => a+b, 0) / yVals.length;
console.log(`Y range: ${yMin.toFixed(0)} to ${yMax.toFixed(0)}, avg: ${yAvg.toFixed(1)}`);
console.log(`Auto-flip would trigger: ${yAvg < -20 ? 'YES' : 'NO'}`);

// Part frequency and dims
const partFreq = new Map<string, number>();
const partNoDims = new Map<string, number>();
for (const b of bricks) {
  const bare = b.part.replace(/\.dat$/i, '').toLowerCase();
  partFreq.set(bare, (partFreq.get(bare) ?? 0) + 1);
  if (!hasDims(b.part)) {
    partNoDims.set(bare, (partNoDims.get(bare) ?? 0) + 1);
  }
}

// Sort by frequency
const sorted = [...partFreq.entries()].sort((a,b) => b[1] - a[1]);
console.log(`\nTop 25 parts (${sorted.length} unique):`);
for (const [part, count] of sorted.slice(0, 25)) {
  const dims = getPartDims(part + '.dat');
  const has = hasDims(part + '.dat');
  console.log(`  ${part.padEnd(12)} ×${String(count).padStart(3)}  dims=[${dims}]${has ? '' : ' [FALLBACK 1,1,1]'}`);
}

// Parts missing dims
const missingParts = [...partNoDims.entries()].sort((a,b) => b[1] - a[1]);
if (missingParts.length > 0) {
  console.log(`\nParts with NO dims (${missingParts.length} unique, ${missingParts.reduce((s,[,c])=>s+c,0)} total):`);
  for (const [part, count] of missingParts.slice(0, 20)) {
    console.log(`  ${part.padEnd(12)} ×${count}`);
  }
}

// Color distribution
const colorFreq = new Map<number, number>();
for (const b of bricks) {
  colorFreq.set(b.color, (colorFreq.get(b.color) ?? 0) + 1);
}
const colorsSorted = [...colorFreq.entries()].sort((a,b) => b[1] - a[1]);
console.log(`\nColor distribution (${colorsSorted.length} unique):`);
for (const [color, count] of colorsSorted.slice(0, 10)) {
  console.log(`  color ${String(color).padStart(3)} ×${count}`);
}

// Bounding box analysis
const LDU_PER_STUD = 20;
const LDU_PER_PLATE = 8;
const xVals = bricks.map(b => b.x);
const zVals = bricks.map(b => b.z);
const xRange = Math.max(...xVals) - Math.min(...xVals);
const yRange = yMax - yMin;
const zRange = Math.max(...zVals) - Math.min(...zVals);
console.log(`\nWorld bounding box (LDU): X=${xRange.toFixed(0)} Y=${yRange.toFixed(0)} Z=${zRange.toFixed(0)}`);
console.log(`Approx studs: X=${(xRange/LDU_PER_STUD).toFixed(0)} Y_plates=${(yRange/LDU_PER_PLATE).toFixed(0)} Z=${(zRange/LDU_PER_STUD).toFixed(0)}`);
