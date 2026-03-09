#!/usr/bin/env bun
/** Render tiles schems as JPEGs for grading. */
import { join } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior } from '../src/render/png-renderer.js';

// Disable libvips thread pool — deadlocks on Android ARM64 (bionic libc)
sharp.concurrency(1);

const TILES_DIR = '/data/data/com.termux/files/home/git/craftmatic/output/tiles';

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
    const tile = 4;
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${blocks} blocks, ${grid.palette.size} materials, tile=${tile})`);

    console.log(`  starting render...`);
    const t0 = Date.now();
    const pngBuf = await renderExterior(grid, { tile });
    const t1 = Date.now();
    console.log(`  render: ${t1-t0}ms (${(pngBuf.length/1024).toFixed(0)}KB PNG)`);

    console.log(`  starting sharp jpeg...`);
    const jpgBuf = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
    const t2 = Date.now();
    console.log(`  sharp: ${t2-t1}ms`);

    await writeFile(outPath, jpgBuf);
    console.log(`  → ${(jpgBuf.length / 1024).toFixed(0)}KB JPG`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone.');
