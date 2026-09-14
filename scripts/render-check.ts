#!/usr/bin/env bun
/** Render 4 models with geometry mode and save PNGs for visual inspection. */
import { readFileSync } from 'fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { keepLargestComponent } from '../web/src/engine/ldraw-voxelizer.js';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const LDR = 'C:/git/clego/lego_sets/LDR';

const models = [
  '8653 Enzo Ferrari.mpd',
  '1924 Viking Line Ferry.ldr',
  '8010 Darth Vader.mpd',
  '8849 Tractor.ldr',
];

for (const file of models) {
  const name = file.replace(/\.(mpd|ldr)$/i, '');
  console.log(`\n=== ${name} ===`);
  const text = readFileSync(`${LDR}/${file}`, 'utf-8');
  const bricks = parseLDraw(text);
  const t0 = Date.now();
  const result = await voxelizeLDrawGeometry(bricks, undefined, { cubicScale: true });
  const cleaned = keepLargestComponent(result.grid);
  const { width: w, height: h, length: l } = result.grid;
  const blocks = result.grid.countNonAir();
  console.log(`  ${w}×${h}×${l} — ${blocks.toLocaleString()} blocks (${cleaned} debris removed) in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`  Fallback: ${result.fallbackPartCount}, Unmapped: ${result.unmappedColors.length ? result.unmappedColors.join(', ') : 'none'}, Flipped: ${result.wasFlipped}`);
}
