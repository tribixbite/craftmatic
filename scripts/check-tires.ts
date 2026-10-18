#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';

const TIRE_PARTS = new Set(['32019', '86652', '6wheel', '24316', '24326']);
for (const setNum of ['42049-1', '8855-1', '60067-1', '6545-1', '1472-1', '10030-1']) {
  const r = await fetch(`https://library.ldraw.org/library/omr/${setNum}.mpd`, {
    headers: { 'User-Agent': 'craftmatic-debug/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  const bricks = parseLDraw(text);
  const tireParts = bricks.filter(b => TIRE_PARTS.has(b.part.toLowerCase().replace('.dat','')));
  console.log(`${setNum}: ${tireParts.map(b=>b.part).join(', ') || 'none'}`);
}
