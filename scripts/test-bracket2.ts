#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartShape, getPartDims } from '../web/src/engine/ldraw-part-dims.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC = join(import.meta.dir, '..', 'web', 'public');
const raw = readFileSync(join(PUBLIC, '21309-1.mpd'), 'utf8');
const bricks = parseLDraw(raw);

// Analyze all bracket instances and their orientation
const byPart = new Map<string, { total: number; spanYGt0: number }>();
for (const b of bricks) {
  if (getPartShape(b.part) !== 'bracket') continue;
  const key = b.part.replace(/\.dat$/i,'');
  const R = b.rot ?? [1,0,0,0,1,0,0,0,1];
  const [sW, sH, sL] = getPartDims(b.part);
  
  // Approximate span Y after rotation using the same logic as voxelizer
  const LDU_PER_PLATE = 8, LDU_PER_STUD = 20;
  const lxHalf = (sW-1)/2*LDU_PER_STUD, lzHalf = (sL-1)/2*LDU_PER_STUD, lyBot = (sH-1)*LDU_PER_PLATE;
  let wyMin=Infinity, wyMax=-Infinity;
  for (const lx of [-lxHalf, lxHalf]) for (const ly of [0, lyBot]) for (const lz of [-lzHalf, lzHalf]) {
    const wy = R[3]*lx + R[4]*ly + R[5]*lz;
    if (wy < wyMin) wyMin=wy; if (wy > wyMax) wyMax=wy;
  }
  const gyMin = Math.round(-wyMax/LDU_PER_PLATE);
  const gyMax = Math.round(-wyMin/LDU_PER_PLATE);
  const spanY = gyMax - gyMin;
  
  const ex = byPart.get(key);
  if (ex) { ex.total++; if (spanY > 0) ex.spanYGt0++; }
  else byPart.set(key, { total: 1, spanYGt0: spanY > 0 ? 1 : 0 });
}

for (const [part, { total, spanYGt0 }] of byPart.entries()) {
  console.log(`${part}: total=${total}, spanY>0=${spanYGt0} (can be masked), spanY=0=${total-spanYGt0} (horizontal, no masking)`);
}
