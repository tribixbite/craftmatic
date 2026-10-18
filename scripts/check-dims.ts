#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';

for (const setNum of ['42049-1', '60067-1', '6545-1', '1472-1']) {
  const r = await fetch(`https://library.ldraw.org/library/omr/${setNum}.mpd`, {
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
  const defaultParts = Object.entries(partCounts)
    .filter(([p]) => { const d = getPartDims(p+'.dat'); return d[0]===1&&d[1]===1&&d[2]===1; })
    .sort((a,b)=>b[1]-a[1]);
  const totalDefault = defaultParts.reduce((s,[,c])=>s+c,0);
  console.log(`\n${setNum}: ${bricks.length} bricks, ${defaultParts.length} unique parts with default [1,1,1] (${totalDefault} total bricks)`);
  for (const [p, c] of defaultParts.slice(0, 15)) console.log(`  ${p} x${c}`);
}
