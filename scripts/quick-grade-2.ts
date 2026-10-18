#!/usr/bin/env bun
/** Quick test: geometry-voxelize two problem models and report stats. */
import { readFileSync } from 'fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const LDR = 'C:/git/clego/lego_sets/LDR';

const models = [
  { file: '8010 Darth Vader.mpd', name: 'Darth Vader' },
  { file: '1924 Viking Line Ferry.ldr', name: 'Viking Ferry' },
];

for (const m of models) {
  console.log(`\n=== ${m.name} ===`);
  const text = readFileSync(`${LDR}/${m.file}`, 'utf-8');
  const bricks = parseLDraw(text);
  console.log(`  Parsed: ${bricks.length} bricks`);
  const t0 = Date.now();
  const result = await voxelizeLDrawGeometry(bricks, undefined, { cubicScale: true });
  const { width: w, height: h, length: l } = result.grid;
  const blocks = result.grid.countNonAir();
  console.log(`  ${w}×${h}×${l} — ${blocks.toLocaleString()} blocks in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`  Fallback: ${result.fallbackPartCount}, Unmapped colors: ${result.unmappedColors.length ? result.unmappedColors.join(', ') : 'none'}`);
}
