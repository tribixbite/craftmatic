#!/usr/bin/env bun
/**
 * render-clego-front.ts — clego LDR → FRONT-ELEVATION PNG (Y is the vertical
 * screen axis), so upright-ness is read directly (the isometric bridge
 * foreshortens height). Reuses the same voxelizer as render-clego.ts.
 *
 *   bun scripts/render-clego-front.ts <in.ldr> <out.png> [face:auto|north|south|east|west]
 */
import { readFileSync, writeFileSync } from 'fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { keepLargestComponent } from '../web/src/engine/ldraw-voxelizer.js';
import { renderFrontElevation } from '../src/render/png-renderer.js';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const inArg = process.argv[2];
const outPath = process.argv[3];
const face = (process.argv[4] ?? 'auto') as 'north' | 'south' | 'east' | 'west' | 'auto';

if (!inArg || !outPath) {
  console.error('usage: bun scripts/render-clego-front.ts <in.ldr> <out.png> [face]');
  process.exit(1);
}

const bricks = parseLDraw(readFileSync(inArg, 'utf-8'));
if (bricks.length === 0) { console.error('no bricks'); process.exit(1); }

const result = await voxelizeLDrawGeometry(bricks, undefined, { cubicScale: true });
keepLargestComponent(result.grid);
const { width: w, height: h, length: l } = result.grid;
console.log(`  voxels ${w}×${h}×${l} (front-elevation, face=${face})`);

const maxDim = Math.max(w, h, l);
const scale = maxDim > 120 ? 4 : maxDim > 60 ? 6 : 8;
const png = await renderFrontElevation(result.grid, { scale, face });
writeFileSync(outPath, png);
console.log(`→ ${outPath} (${(png.length / 1024).toFixed(0)} KB)`);
