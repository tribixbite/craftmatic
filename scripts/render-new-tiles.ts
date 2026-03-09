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
  'sf-v6', 'newton-v6', 'sanjose-v6', 'walpole-v6', 'byron-v6', 'vinalhaven-v6',
  'suttonsbay-v6', 'losangeles-v6', 'seattle-v6', 'austin-v6', 'minneapolis-v6',
  'charleston-v6',
];

for (const name of SCHEMS) {
  const schemPath = join(TILES_DIR, `${name}.schem`);
  const outPath = join(TILES_DIR, `${name}.jpg`);
  try {
    const grid = await parseToGrid(schemPath);
    const blocks = grid.countNonAir();
    // tile=1 for >20K blocks on ARM to avoid texture atlas hang; timeout 30s per render
    const tile = blocks > 20000 ? 1 : 2;
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${blocks} blocks, ${grid.palette.size} materials, tile=${tile})`);
    const pngBuf = await Promise.race([
      renderExterior(grid, { tile }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('render timeout 30s')), 30000)),
    ]);
    const jpgBuf = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
    await writeFile(outPath, jpgBuf);
    console.log(`  → ${(jpgBuf.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone.');
