#!/usr/bin/env bun
/** Render v4 tiles schems as JPEGs for grading. */
import { join } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior } from '../src/render/png-renderer.js';

const TILES_DIR = '/data/data/com.termux/files/home/git/craftmatic/output/tiles';

// Process only the schem name passed as argv, or all v4 if none
const arg = process.argv[2];
const SCHEMS = arg ? [arg] : [
  'sf-v5', 'newton-v5', 'sanjose-v5', 'walpole-v5', 'byron-v5', 'vinalhaven-v5',
  'suttonsbay-v5', 'losangeles-v5', 'seattle-v5', 'austin-v5', 'minneapolis-v5',
  'charleston-v5',
];

for (const name of SCHEMS) {
  const schemPath = join(TILES_DIR, `${name}.schem`);
  const outPath = join(TILES_DIR, `${name}.jpg`);
  try {
    const grid = await parseToGrid(schemPath);
    const blocks = grid.countNonAir();
    // Adaptive tile size based on block count to prevent ARM render hang
    const tile = 2;  // Fixed tile=2 for ARM stability
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${blocks} blocks, ${grid.palette.size} materials, tile=${tile})`);
    const pngBuf = await renderExterior(grid, { tile });
    const jpgBuf = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
    await writeFile(outPath, jpgBuf);
    console.log(`  → ${(jpgBuf.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone.');
