#!/usr/bin/env bun
/**
 * Render v73b voxelized buildings — isometric + top-down views.
 * v73b: no-glaze + boundary-preserving smoothing
 */
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior, renderTopDown } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const outDir = join(tilesDir, 'render-v73b');
await mkdir(outDir, { recursive: true });

const BUILDINGS = ['flatiron', 'montgomery', 'sentinel'];
const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const name of BUILDINGS) {
  if (filterName && name !== filterName) continue;
  const schemPath = join(tilesDir, `${name}-v73b.schem`);
  if (!existsSync(schemPath)) { console.log(`${name}: SKIP (no schem)`); continue; }
  console.log(`\n=== ${name} ===`);
  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length} | Palette: ${grid.palette.size}`);

  const isoPng = await renderExterior(grid, { tile: 3 });
  const isoJpg = await sharp(isoPng).jpeg({ quality: 90 }).toBuffer();
  await writeFile(join(outDir, `iso-${name}.jpg`), isoJpg);
  console.log(`  -> iso: ${(isoJpg.length / 1024).toFixed(0)}KB`);

  const topPng = await renderTopDown(grid, { scale: 4 });
  const topJpg = await sharp(topPng).jpeg({ quality: 90 }).toBuffer();
  await writeFile(join(outDir, `top-${name}.jpg`), topJpg);
  console.log(`  -> top: ${(topJpg.length / 1024).toFixed(0)}KB`);

  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone!');
