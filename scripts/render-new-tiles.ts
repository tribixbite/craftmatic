#!/usr/bin/env bun
/** Render the new browser-captured tiles schems as JPEGs for grading. */
import { join } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior } from '../src/render/png-renderer.js';

const TILES_DIR = '/data/data/com.termux/files/home/git/craftmatic/output/tiles';
const tile = 4;

const SCHEMS = [
  'sf-v3', 'newton-v3', 'sanjose-v3', 'walpole-v3', 'byron-v3', 'vinalhaven-v3',
  'suttonsbay-v3', 'losangeles-v3', 'seattle-v3', 'austin-v3', 'minneapolis-v3',
  'charleston-v3',
];

for (const name of SCHEMS) {
  const schemPath = join(TILES_DIR, `${name}.schem`);
  const outPath = join(TILES_DIR, `${name}.jpg`);
  try {
    const grid = await parseToGrid(schemPath);
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks, ${grid.palette.size} materials)`);
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
