#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';

async function detailedAudit(modelUrl: string, modelName: string) {
  const r = await fetch(modelUrl, {
    headers: { 'User-Agent': 'craftmatic-debug/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  const bricks = parseLDraw(text);

  const fallbackParts: Record<string, number> = {};

  for (const b of bricks) {
    const p = b.part.toLowerCase().replace('.dat','');
    const dims = getPartDims(p+'.dat');
    if (dims[0] === 1 && dims[1] === 1 && dims[2] === 1) {
      fallbackParts[p] = (fallbackParts[p] ?? 0) + 1;
    }
  }

  console.log(`\n${modelName}\n`);
  const top5 = Object.entries(fallbackParts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5);
    
  top5.forEach(([p, count]) => {
    console.log(`  • ${p.padEnd(16)} (×${count})`);
  });
}

await detailedAudit('https://library.ldraw.org/library/omr/60067-1.mpd', '60067-1 (Helicopter Pursuit)');
await detailedAudit('https://library.ldraw.org/library/omr/8855-1.mpd', '8855-1 (Prop Plane)');
await detailedAudit('https://library.ldraw.org/library/omr/42049-1.mpd', '42049-1 (Mine Loader)');
