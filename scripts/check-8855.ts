#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';

const r = await fetch('https://library.ldraw.org/library/omr/8855-1.mpd', {
  headers: { 'User-Agent': 'craftmatic-debug/1.0' },
  signal: AbortSignal.timeout(30_000),
});
const text = await r.text();
const bricks = parseLDraw(text);

const partCounts: Record<string, number> = {};
for (const b of bricks) {
  const p = b.part.toLowerCase().replace('.dat','');
  partCounts[p] = (partCounts[p] ?? 0) + 1;
}

console.log(`Total bricks: ${bricks.length}, Unique parts: ${Object.keys(partCounts).length}`);
console.log('\nParts with default dims [1,1,1]:');
const entries = Object.entries(partCounts).sort((a,b) => b[1]-a[1]);
for (const [part, count] of entries) {
  const dims = getPartDims(part + '.dat');
  const isDefault = dims[0] === 1 && dims[1] === 1 && dims[2] === 1;
  if (isDefault) {
    console.log(`  ${part} x${count} → [${dims}] *** DEFAULT ***`);
  }
}
console.log('\nAll parts with dims:');
for (const [part, count] of entries) {
  const dims = getPartDims(part + '.dat');
  console.log(`  ${part} x${count} → [${dims.join(',')}]`);
}
