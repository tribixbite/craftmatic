#!/usr/bin/env bun
/**
 * Render v69 voxelized buildings (1 block/m with courtyard clearing).
 * Uses tile=4 for standard-res grids (~30-45 blocks per axis).
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
const outDir = join(tilesDir, 'render-v69');
await mkdir(outDir, { recursive: true });

const BUILDINGS = [
  'noe', 'green', 'francisco', 'beach', 'chestnut', 'dakota', 'sentinel',
];

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const name of BUILDINGS) {
  if (filterName && name !== filterName) continue;

  const schemPath = join(tilesDir, `${name}-v69.schem`);
  if (!existsSync(schemPath)) { console.log(`${name}: SKIP (no schem)`); continue; }

  console.log(`\n=== ${name} ===`);
  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length} | Palette: ${grid.palette.size}`);
  console.log(`  Blocks: ${[...grid.palette].filter(b => String(b) !== 'minecraft:air').map(b => String(b).replace('minecraft:', '')).join(', ')}`);

  // Isometric exterior render (tile=4 for standard-res grids)
  const isoPng = await renderExterior(grid, { tile: 4 });
  const isoJpg = await sharp(isoPng).jpeg({ quality: 90 }).toBuffer();
  await writeFile(join(outDir, `iso-${name}.jpg`), isoJpg);
  console.log(`  -> iso: ${(isoJpg.length / 1024).toFixed(0)}KB`);

  if (typeof Bun !== 'undefined') Bun.gc(true);
}

console.log('\nDone! Check output/tiles/render-v69/');
