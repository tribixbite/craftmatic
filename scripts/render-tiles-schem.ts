#!/usr/bin/env bun
/**
 * Render .schem files from tiles voxelization as exterior JPEG images.
 * Usage: bun scripts/render-tiles-schem.ts [--tile=4]
 */
import { resolve, join, basename } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior } from '../src/render/png-renderer.js';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const TILES_DIR = join(PROJECT_ROOT, 'output/tiles');
const tile = parseInt(process.argv.find(a => a.startsWith('--tile='))?.split('=')[1] ?? '4');

// Only render our freshly voxelized .schem files (not old comparison ones)
const TARGET_SCHEMS = [
  'noe-450', 'francisco-2340', 'green-2390', 'chestnut-2001',
  'beach-2130', 'baker-3170', 'lyon-3601', 'montgomery-600',
  'sentinel', 'esb', 'flatiron', 'chrysler', 'st-patricks', 'dakota',
];

for (const name of TARGET_SCHEMS) {
  const schemPath = join(TILES_DIR, `${name}.schem`);
  const outPath = join(TILES_DIR, `${name}.jpg`);

  try {
    const grid = await parseToGrid(schemPath);
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

    const pngBuf = await renderExterior(grid, { tile });
    const jpgBuf = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
    await writeFile(outPath, jpgBuf);
    console.log(`  → ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }

  // GC hint between renders to avoid OOM on ARM
  if (typeof Bun !== 'undefined') Bun.gc(true);
}

console.log('\nDone.');
