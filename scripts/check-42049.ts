#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';

const r = await fetch('https://library.ldraw.org/library/omr/42049-1.mpd', {
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
console.log(`Total bricks: ${bricks.length}`);
console.log('\nTop 20 parts by count:');
Object.entries(partCounts).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([p,c]) => {
  const dims = getPartDims(p+'.dat');
  const vol = dims[0]*dims[1]*dims[2];
  console.log(`  ${p} x${c} → [${dims}] vol=${vol} totalVol=${vol*c}`);
});
