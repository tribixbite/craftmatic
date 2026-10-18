#!/usr/bin/env bun
/**
 * render-clego.ts — clego→craftmatic RENDER BRIDGE.
 *
 * Renders a clego reconstruction .ldr (or several merged .ldr files) to an
 * isometric PNG using craftmatic's REAL .dat part geometry, so the silhouette
 * reflects actual piece shapes — NOT bounding boxes.
 *
 * Pipeline (reuses craftmatic functions, no parallel renderer):
 *   parseLDraw            → ParsedBrick[]   (web/src/engine/ldraw-parser)
 *   voxelizeLDrawGeometry → BlockGrid       (web/src/engine/ldraw-geometry, cubicScale)
 *                                            resolves real .dat meshes from the
 *                                            clego LDraw library and ray-casts them
 *   keepLargestComponent  → drop debris     (web/src/engine/ldraw-voxelizer)
 *   renderExterior        → isometric PNG   (src/render/png-renderer)
 *
 * Colors flow LDraw color id → Minecraft block (ldrawColorToBlock, the voxelizer
 * default) → RGB (renderExterior's getBlockColor). Good enough for a visual read.
 *
 * Usage:
 *   bun scripts/render-clego.ts <in.ldr>[,<in2.ldr>,...] <out.png> [title]
 *
 * The first arg may be a comma-separated list to merge multiple .ldr files
 * (e.g. a truth model split across submodel files) into one grid.
 */
import { readFileSync, writeFileSync } from 'fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { keepLargestComponent } from '../web/src/engine/ldraw-voxelizer.js';
import { renderExterior } from '../src/render/png-renderer.js';

// Point geometry resolution at the local clego LDraw parts library.
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const inArg = process.argv[2];
const outPath = process.argv[3];
const title = process.argv[4] ?? '';

if (!inArg || !outPath) {
  console.error('usage: bun scripts/render-clego.ts <in.ldr>[,<in2.ldr>...] <out.png> [title]');
  process.exit(1);
}

const inPaths = inArg.split(',').map(s => s.trim()).filter(Boolean);

// Parse + merge bricks from every input file.
const bricks = inPaths.flatMap(p => {
  const text = readFileSync(p, 'utf-8');
  const b = parseLDraw(text);
  console.log(`  ${p}: ${b.length} bricks`);
  return b;
});

if (bricks.length === 0) {
  console.error('No bricks parsed — nothing to render.');
  process.exit(1);
}

const t0 = Date.now();
// cubicScale → 1 LDU-stud cell in X/Z/Y (uniform voxels, the render-check default).
const result = await voxelizeLDrawGeometry(bricks, undefined, { cubicScale: true });
const debris = keepLargestComponent(result.grid);
const { width: w, height: h, length: l } = result.grid;
const blocks = result.grid.countNonAir();
console.log(
  `  voxels ${w}×${h}×${l} — ${blocks.toLocaleString()} cells ` +
  `(${debris} debris removed) in ${((Date.now() - t0) / 1000).toFixed(1)}s; ` +
  `fallback parts: ${result.fallbackPartCount}` +
  (result.warning ? ` — ${result.warning}` : ''),
);

// Isometric 3/4 view. tile auto-shrinks to MAX_DIM inside renderExterior, so
// big sets are handled (downscaled) rather than producing huge images.
const maxDim = Math.max(w, h, l);
const tile = maxDim > 220 ? 6 : maxDim > 120 ? 9 : 14;
const png = await renderExterior(result.grid, { tile });
writeFileSync(outPath, png);
console.log(`→ ${outPath} (${(png.length / 1024).toFixed(0)} KB)${title ? `  [${title}]` : ''}`);
