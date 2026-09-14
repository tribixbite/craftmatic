#!/usr/bin/env bun
/** Quick test: geometry-voxelize one model and report stats. */
import { readFileSync } from 'fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';

// Point to local LDraw library for CLI usage
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const LDR_DIR = 'C:/git/clego/lego_sets/LDR';
const models = [
  '8849 Tractor.ldr',
  '1924 Viking Line Ferry.ldr',
  '6986 Mission Commander.mpd',
];

for (const file of models) {
  const path = `${LDR_DIR}/${file}`;
  console.log(`\n=== ${file} ===`);
  try {
    const text = readFileSync(path, 'utf-8');
    const bricks = parseLDraw(text);
    console.log(`  Parsed: ${bricks.length} bricks`);

    const t0 = Date.now();
    const result = await voxelizeLDrawGeometry(bricks, undefined, { cubicScale: true });
    const dt = Date.now() - t0;

    const { width: w, height: h, length: l } = result.grid;
    const blocks = result.grid.countNonAir();
    console.log(`  Voxelized: ${w}×${h}×${l} — ${blocks.toLocaleString()} blocks in ${(dt/1000).toFixed(1)}s`);
    console.log(`  Fallback parts: ${result.fallbackPartCount}`);
    console.log(`  Unmapped colors: ${result.unmappedColors.length > 0 ? result.unmappedColors.join(', ') : 'none'}`);
    console.log(`  Flipped: ${result.wasFlipped ? 'YES' : 'no'}`);
  } catch (e) {
    console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}
