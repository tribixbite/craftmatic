#!/usr/bin/env bun
/**
 * Render v73c voxelized buildings — isometric + top-down views.
 * v73c: peaked roof + boundary preservation
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
const outDir = join(tilesDir, 'render-v73c');
await mkdir(outDir, { recursive: true });

const BUILDINGS = [
  'flatiron', 'montgomery', 'willis',
  'chrysler', 'transamerica', 'guggenheim', 'artinstitute',
];
const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const name of BUILDINGS) {
  if (filterName && name !== filterName) continue;
  // v73c uses same schem as v73 for flatiron (no peaked roof needed),
  // but peaked-roof versions for others
  let schemPath = join(tilesDir, `${name}-v73c.schem`);
  if (!existsSync(schemPath)) {
    schemPath = join(tilesDir, `${name}-v73.schem`);
  }
  if (!existsSync(schemPath)) { console.log(`${name}: SKIP (no schem)`); continue; }
  console.log(`\n=== ${name} ===`);
  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length} | Palette: ${grid.palette.size}`);

  // Use tile=3 for large grids (chrysler), tile=3 for normal
  const tile = Math.max(grid.width, grid.length) > 100 ? 2 : 3;
  const isoPng = await renderExterior(grid, { tile });
  const isoJpg = await sharp(isoPng).jpeg({ quality: 90 }).toBuffer();
  await writeFile(join(outDir, `iso-${name}.jpg`), isoJpg);
  console.log(`  -> iso: ${(isoJpg.length / 1024).toFixed(0)}KB`);

  const topScale = Math.max(grid.width, grid.length) > 100 ? 2 : 4;
  const topPng = await renderTopDown(grid, { scale: topScale });
  const topJpg = await sharp(topPng).jpeg({ quality: 90 }).toBuffer();
  await writeFile(join(outDir, `top-${name}.jpg`), topJpg);
  console.log(`  -> top: ${(topJpg.length / 1024).toFixed(0)}KB`);

  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone!');
