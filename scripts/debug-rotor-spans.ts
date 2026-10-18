#!/usr/bin/env bun
/** Debug: print world-space AABB spans for rotor/propeller parts in helicopter sets. */

import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartDims, getPartShape } from '../web/src/engine/ldraw-part-dims.js';

const OMR_BASE = 'https://library.ldraw.org/library/omr';
const LDU_PER_STUD = 20;
const LDU_PER_PLATE = 8;
const LDU_PER_Y = 20; // cubic mode

const TARGET_PARTS = new Set(['30332', '2742', '4617b', '4617', '62743', '50943', '2507', '2508']);

async function analyzeSet(setNum: string) {
  const r = await fetch(`${OMR_BASE}/${setNum}.mpd`, {
    headers: { 'User-Agent': 'craftmatic-debug/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  const bricks = parseLDraw(text);
  const targets = bricks.filter(b => TARGET_PARTS.has(b.part.toLowerCase().replace('.dat', '')));

  console.log(`\n=== ${setNum}: ${targets.length} rotor/propeller parts ===`);
  for (const brick of targets) {
    const [sW, sH, sL] = getPartDims(brick.part);
    const shape = getPartShape(brick.part);
    const R = brick.rot ?? [1,0,0,0,1,0,0,0,1];

    const lxHalf = (sW - 1) / 2 * LDU_PER_STUD;
    const lzHalf = (sL - 1) / 2 * LDU_PER_STUD;
    const lyBot  = (sH - 1) * LDU_PER_PLATE;
    const lyHalf = lyBot / 2;
    const lyStart = shape === 'round' ? -lyHalf : 0;
    const lyEnd   = shape === 'round' ?  lyHalf : lyBot;

    let wxMin = Infinity, wxMax = -Infinity;
    let wyMin = Infinity, wyMax = -Infinity;
    let wzMin = Infinity, wzMax = -Infinity;

    for (const lx of lxHalf === 0 ? [0] : [-lxHalf, lxHalf]) {
      for (const ly of [lyStart, lyEnd]) {
        for (const lz of lzHalf === 0 ? [0] : [-lzHalf, lzHalf]) {
          const wx = R[0]*lx + R[1]*ly + R[2]*lz + brick.x;
          const wy = R[3]*lx + R[4]*ly + R[5]*lz + brick.y;
          const wz = R[6]*lx + R[7]*ly + R[8]*lz + brick.z;
          if (wx < wxMin) wxMin = wx; if (wx > wxMax) wxMax = wx;
          if (wy < wyMin) wyMin = wy; if (wy > wyMax) wyMax = wy;
          if (wz < wzMin) wzMin = wz; if (wz > wzMax) wzMax = wz;
        }
      }
    }

    const spanX = Math.round((wxMax - wxMin) / LDU_PER_STUD);
    const spanY = Math.round((wyMax - wyMin) / LDU_PER_Y); // cubic
    const spanZ = Math.round((wzMax - wzMin) / LDU_PER_STUD);
    const minSpan = Math.min(spanX, spanY, spanZ);
    let hub = 'Y (xz disc)';
    if (spanX === minSpan && spanX < spanY && spanX < spanZ) hub = 'X (yz disc)';
    else if (spanZ === minSpan && spanZ < spanX && spanZ < spanY) hub = 'Z (xy disc)';

    console.log(`  ${brick.part} dims=[${sW},${sH},${sL}] shape=${shape}`);
    console.log(`    R=[${R.map(v=>v.toFixed(1)).join(',')}]`);
    console.log(`    world: X=[${wxMin.toFixed(0)}..${wxMax.toFixed(0)}] Y=[${wyMin.toFixed(0)}..${wyMax.toFixed(0)}] Z=[${wzMin.toFixed(0)}..${wzMax.toFixed(0)}]`);
    console.log(`    cubic spans: X=${spanX}, Y=${spanY}, Z=${spanZ} → hub=${hub}`);
  }
}

await analyzeSet('60067-1');
await analyzeSet('6545-1');
await analyzeSet('8855-1');
