#!/usr/bin/env bun
/** Render tiles schems as JPEGs for grading.
 * Produces both isometric (iso) and top-down (td) renders.
 * Top-down matches satellite perspective for VLM grading. */
import { join } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior, renderTopDown } from '../src/render/png-renderer.js';

// Disable libvips thread pool — deadlocks on Android ARM64 (bionic libc)
sharp.concurrency(1);

const TILES_DIR = '/data/data/com.termux/files/home/git/craftmatic/output/tiles';

const arg = process.argv[2];
const SCHEMS = arg ? [arg] : [
  'sf-v11', 'newton-v11', 'sanjose-v11', 'walpole-v11', 'byron-v11', 'vinalhaven-v11',
  'suttonsbay-v11', 'losangeles-v11', 'seattle-v11', 'austin-v11', 'minneapolis-v11',
  'charleston-v11',
];

for (const name of SCHEMS) {
  const schemPath = join(TILES_DIR, `${name}.schem`);
  try {
    const grid = await parseToGrid(schemPath);
    const blocks = grid.countNonAir();
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${blocks} blocks, ${grid.palette.size} materials)`);

    // Top-down render (matches satellite perspective for grading)
    const tdPath = join(TILES_DIR, `${name}-td.jpg`);
    console.log(`  top-down render...`);
    const t0 = Date.now();
    const tdPng = await renderTopDown(grid, { scale: 8 });
    const t1 = Date.now();
    console.log(`  td render: ${t1-t0}ms (${(tdPng.length/1024).toFixed(0)}KB PNG)`);
    const tdJpg = await sharp(tdPng).jpeg({ quality: 85 }).toBuffer();
    await writeFile(tdPath, tdJpg);
    console.log(`  → ${(tdJpg.length / 1024).toFixed(0)}KB td JPG`);

    // Isometric render (3D overview)
    const isoPath = join(TILES_DIR, `${name}-iso.jpg`);
    console.log(`  iso render...`);
    const t2 = Date.now();
    const isoPng = await renderExterior(grid, { tile: 4 });
    const t3 = Date.now();
    console.log(`  iso render: ${t3-t2}ms (${(isoPng.length/1024).toFixed(0)}KB PNG)`);
    const isoJpg = await sharp(isoPng).jpeg({ quality: 85 }).toBuffer();
    await writeFile(isoPath, isoJpg);
    console.log(`  → ${(isoJpg.length / 1024).toFixed(0)}KB iso JPG`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone.');
