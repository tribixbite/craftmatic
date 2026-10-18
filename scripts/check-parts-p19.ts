import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';
import { readFileSync } from 'node:fs';

const models = [
  { name: '21309-1', path: './web/public/21309-1.mpd' },
  { name: '10030-1', path: './web/public/10030-1.mpd' },
  { name: '10179-1', path: './web/public/10179-1.mpd' },
];

const targets = new Set(['60219','22889','44126','93606','87080','85941','6629','4286','4287','6564','6565','11833','32278','41239','32525','40490','32524','32316','32523','44568','24299','2625','50990a','50990','62361']);

for (const { name, path } of models) {
  const bricks = parseLDraw(readFileSync(path, 'utf8'));
  const counts = new Map<string, number>();
  for (const b of bricks) {
    const bare = b.part.replace(/\.dat$/i, '').toLowerCase();
    counts.set(bare, (counts.get(bare)||0)+1);
  }
  const hits: {part: string, cnt: number, dims: number[], vol: number}[] = [];
  for (const [part, cnt] of counts) {
    if (!targets.has(part)) continue;
    const dims = getPartDims(part);
    const vol = dims[0] * dims[1] * dims[2] * cnt;
    hits.push({ part, cnt, dims, vol });
  }
  hits.sort((a,b)=>b.vol-a.vol);
  if (hits.length > 0) {
    console.log(`\n${name}:`);
    for (const h of hits) console.log(`  ${h.part.padEnd(12)} ×${String(h.cnt).padStart(3)}  dims=${JSON.stringify(h.dims).padEnd(12)}  total=${h.vol}`);
  }
}
