#!/usr/bin/env bun
/**
 * Debug script: print world-space AABB spans for all 32019/86652 parts in 42049-1.
 * Helps diagnose round mask axis selection.
 */

import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims } from '../web/src/engine/ldraw-part-dims.js';

const OMR_BASE = 'https://library.ldraw.org/library/omr';
const LDU_PER_STUD = 20;
const LDU_PER_PLATE = 8;
const TARGET_PARTS = new Set(['32019', '86652', '2742', '32016']);

async function main() {
  const r = await fetch(`${OMR_BASE}/42049-1.mpd`, {
    headers: { 'User-Agent': 'craftmatic-debug/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) { console.error('Failed to fetch MPD:', r.status); return; }
  const mpdText = await r.text();
  console.log(`Fetched MPD: ${(mpdText.length/1024).toFixed(0)}KB`);

  const bricks = parseLDraw(mpdText);
  const tireParts = bricks.filter(b => TARGET_PARTS.has(b.part.toLowerCase().replace('.dat','')));
  console.log(`Found ${tireParts.length} tire/wheel parts\n`);

  for (const brick of tireParts) {
    const [sW, sH, sL] = getPartDims(brick.part);
    const R = brick.rot ?? [1,0,0,0,1,0,0,0,1];

    const lxHalf = (sW - 1) / 2 * LDU_PER_STUD;
    const lzHalf = (sL - 1) / 2 * LDU_PER_STUD;
    const lyBot  = (sH - 1) * LDU_PER_PLATE;
    const lyHalf = lyBot / 2;

    let wxMin = Infinity, wxMax = -Infinity;
    let wyMin = Infinity, wyMax = -Infinity;
    let wzMin = Infinity, wzMax = -Infinity;

    for (const lx of [-lxHalf, lxHalf]) {
      for (const ly of [-lyHalf, lyHalf]) {
        for (const lz of [-lzHalf, lzHalf]) {
          const wx = R[0]*lx + R[1]*ly + R[2]*lz + brick.x;
          const wy = R[3]*lx + R[4]*ly + R[5]*lz + brick.y;
          const wz = R[6]*lx + R[7]*ly + R[8]*lz + brick.z;
          if (wx < wxMin) wxMin = wx; if (wx > wxMax) wxMax = wx;
          if (wy < wyMin) wyMin = wy; if (wy > wyMax) wyMax = wy;
          if (wz < wzMin) wzMin = wz; if (wz > wzMax) wzMax = wz;
        }
      }
    }

    const spanX = (wxMax - wxMin) / LDU_PER_STUD;
    const spanY = (wyMax - wyMin) / LDU_PER_STUD; // in studs
    const spanZ = (wzMax - wzMin) / LDU_PER_STUD;
    const shortest = Math.min(spanX, spanY, spanZ);
    let axis = 'Y (disc horizontal)';
    if (spanX < spanY && spanX < spanZ) axis = 'X (yz disc = circular from side/front)';
    else if (spanZ < spanX && spanZ < spanY) axis = 'Z (xy disc = circular from above)';

    const gSpanX = Math.round((wxMax - wxMin) / LDU_PER_STUD);
    const gSpanY_cubic = Math.round((wyMax - wyMin) / LDU_PER_STUD);
    const gSpanZ = Math.round((wzMax - wzMin) / LDU_PER_STUD);

    console.log(`  Part ${brick.part} at (${brick.x.toFixed(0)}, ${brick.y.toFixed(0)}, ${brick.z.toFixed(0)})`);
    console.log(`    dims=[${sW},${sH},${sL}]  R=[${R.map(v=>v.toFixed(1)).join(',')}]`);
    console.log(`    world AABB: X=[${wxMin.toFixed(0)}..${wxMax.toFixed(0)}] Y=[${wyMin.toFixed(0)}..${wyMax.toFixed(0)}] Z=[${wzMin.toFixed(0)}..${wzMax.toFixed(0)}]`);
    console.log(`    spans (studs): X=${spanX.toFixed(1)}, Y=${spanY.toFixed(1)}, Z=${spanZ.toFixed(1)}`);
    console.log(`    cubic grid spans: X=${gSpanX}, Y=${gSpanY_cubic}, Z=${gSpanZ}`);
    console.log(`    → hub axis: ${axis}`);
    console.log('');
  }
}

main().catch(console.error);
