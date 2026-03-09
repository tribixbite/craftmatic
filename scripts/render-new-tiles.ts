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
  'sf-v4', 'newton-v4', 'sanjose-v4', 'walpole-v4', 'byron-v4', 'vinalhaven-v4',
  'suttonsbay-v4', 'losangeles-v4', 'seattle-v4', 'austin-v4', 'minneapolis-v4',
  'charleston-v4',
];

for (const name of SCHEMS) {
  const schemPath = join(TILES_DIR, `${name}.schem`);
  const outPath = join(TILES_DIR, `${name}.jpg`);
  try {
    const grid = await parseToGrid(schemPath);
    const blocks = grid.countNonAir();
    // Adaptive tile size based on block count to prevent ARM render hang
    const tile = blocks > 60000 ? 2 : blocks > 30000 ? 3 : 4;
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
