#!/usr/bin/env bun
import { resolve, join } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior } from '../src/render/png-renderer.js';
const DIR = resolve(import.meta.dir, '..', 'output/tiles');
const tile = 6;
const targets = process.argv.slice(2);
for (const name of targets) {
  try {
    const grid = await parseToGrid(join(DIR, `${name}.schem`));
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);
    const isoPng = await renderExterior(grid, { tile });
    const isoJpg = await sharp(isoPng).jpeg({ quality: 90 }).toBuffer();
    await writeFile(join(DIR, `${name}-iso.jpg`), isoJpg);
    console.log(`  ${(isoJpg.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
