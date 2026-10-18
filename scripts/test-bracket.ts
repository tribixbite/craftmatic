#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartShape, getPartDims } from '../web/src/engine/ldraw-part-dims.js';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC = join(import.meta.dir, '..', 'web', 'public');

// Count brackets in Saturn V before voxelization
const raw = readFileSync(join(PUBLIC, '21309-1.mpd'), 'utf8');
const bricks = parseLDraw(raw);

let bracketCount = 0;
for (const b of bricks) {
  const shape = getPartShape(b.part);
  if (shape === 'bracket') {
    bracketCount++;
    const dims = getPartDims(b.part);
    const rot = b.rot ?? [1,0,0,0,1,0,0,0,1];
    const R4 = rot[4];
    const R8 = rot[8];
    const R2 = rot[2];
    // dims are [sW, sH, sL]
    const sW = dims[0], sH = dims[1], sL = dims[2];
    const spanX_unrot = sW - 1;
    const spanY_unrot = sH - 1;
    const spanZ_unrot = sL - 1;
    console.log(`  ${b.part} dims=[${dims}] R4=${R4.toFixed(2)} R8=${R8.toFixed(2)} spanY_after_rot_approx=${spanY_unrot}`);
    if (bracketCount >= 5) { console.log('  ... (truncated)'); break; }
  }
}
console.log(`\nTotal bracket bricks in Saturn V: (first 5 shown)`);

// Test with a simple synthetic MPD containing a single bracket
const syntheticMPD = `0 Test
0 NOSUBMODEL
1 0 0 0 0 1 0 0 0 1 0 0 0 1 99207.dat
`;
const testBricks = parseLDraw(syntheticMPD);
console.log('\nSynthetic bracket test:');
for (const b of testBricks) {
  const dims = getPartDims(b.part);
  const shape = getPartShape(b.part);
  console.log(`  part=${b.part} dims=[${dims}] shape=${shape}`);
}
const result = voxelizeLDraw(testBricks, () => 'stone');
console.log(`  blocks in synthetic: ${result.grid.countNonAir()}`);
