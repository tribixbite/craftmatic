#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';

async function auditModel(modelUrl: string, modelName: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${modelName}`);
  console.log(`${'='.repeat(70)}\n`);
  
  const r = await fetch(modelUrl, {
    headers: { 'User-Agent': 'craftmatic-debug/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  const bricks = parseLDraw(text);

  const partCounts: Record<string, number> = {};
  const fallbackParts: Record<string, number> = {};

  for (const b of bricks) {
    const p = b.part.toLowerCase().replace('.dat','');
    partCounts[p] = (partCounts[p] ?? 0) + 1;
    
    const dims = getPartDims(p+'.dat');
    if (dims[0] === 1 && dims[1] === 1 && dims[2] === 1) {
      fallbackParts[p] = (fallbackParts[p] ?? 0) + 1;
    }
  }

  const fallbackTotal = Object.values(fallbackParts).reduce((a,b) => a+b, 0);
  const totalParts = bricks.length;
  
  console.log(`Total bricks: ${totalParts}`);
  console.log(`Total fallback instances: ${fallbackTotal} (${(fallbackTotal/totalParts*100).toFixed(1)}%)`);
  
  console.log('\n\nTop 10 FALLBACK parts (1×1×1):');
  Object.entries(fallbackParts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,10)
    .forEach(([p,c], idx) => {
      console.log(`  ${(idx+1).toString().padStart(2)}. ${p.padEnd(14)} x${c.toString().padStart(3)}`);
    });

  console.log('\n\nTop 20 parts by count (with dims):');
  Object.entries(partCounts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,20)
    .forEach(([p,c], idx) => {
      const dims = getPartDims(p+'.dat');
      const isFallback = dims[0] === 1 && dims[1] === 1 && dims[2] === 1 ? ' *** FALLBACK ***' : '';
      console.log(`  ${(idx+1).toString().padStart(2)}. ${p.padEnd(14)} x${c.toString().padStart(3)} → [${dims[0]},${dims[1]},${dims[2]}]${isFallback}`);
    });
}

await auditModel('https://library.ldraw.org/library/omr/60067-1.mpd', 'Model 60067-1 (Helicopter Pursuit)');
await auditModel('https://library.ldraw.org/library/omr/8855-1.mpd', 'Model 8855-1 (Prop Plane)');
await auditModel('https://library.ldraw.org/library/omr/42049-1.mpd', 'Model 42049-1 (Mine Loader)');
