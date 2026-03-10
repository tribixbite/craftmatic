#!/usr/bin/env bun
import sharp from 'sharp';
import { writeFile, mkdir } from 'fs/promises';
import { parseToGrid } from '../src/schem/parse.js';
import { renderTopDown } from '../src/render/png-renderer.js';
import { join } from 'path';

sharp.concurrency(1);
const projectRoot = join(import.meta.dir, '..');
const outDir = join(projectRoot, 'output/tiles/compare');
await mkdir(outDir, { recursive: true });

const versions = [
  ['guggenheim-headless-v26', 'v26-fill'],
  ['guggenheim-headless-v26-nofill', 'v26-nofill'],
  ['guggenheim-headless-v26-osm', 'v26-osm-after-fill'],
];

for (const [schem, label] of versions) {
  const path = join(projectRoot, 'output/tiles', schem + '.schem');
  try {
    const grid = await parseToGrid(path);
    const nonAir = grid.countNonAir();
    console.log(`${label}: ${grid.width}x${grid.height}x${grid.length} = ${nonAir} blocks`);
    const png = await renderTopDown(grid, { scale: 4 });
    const jpg = await sharp(png).jpeg({ quality: 85 }).toBuffer();
    await writeFile(join(outDir, `td-guggenheim-${label}.jpg`), jpg);
    console.log(`  -> ${(jpg.length / 1024).toFixed(0)}KB`);
  } catch (e) {
    console.log(`${label}: ${(e as Error).message}`);
  }
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('Done!');
