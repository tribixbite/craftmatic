#!/usr/bin/env bun
import sharp from 'sharp';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { parseToGrid } from '../src/schem/parse.js';
import { renderTopDown } from '../src/render/png-renderer.js';
import { join } from 'path';

sharp.concurrency(1);
const projectRoot = join(import.meta.dir, '..');
const outDir = join(projectRoot, 'output/tiles/compare');
await mkdir(outDir, { recursive: true });

const variants = [
  // Guggenheim variants
  ['guggenheim-headless-v26', 'guggenheim-v26-r4-fill'],
  ['guggenheim-headless-v27', 'guggenheim-v27-r4-osm'],
  ['guggenheim-headless-v27-r2', 'guggenheim-v27-r2-osm'],
  ['guggenheim-headless-v27-r1', 'guggenheim-v27-r1-osm'],
  // MIT Dome variants
  ['mitdome-headless-v26', 'mitdome-v26-r4-fill'],
  ['mitdome-headless-v27-r1', 'mitdome-v27-r1-osm'],
];

for (const [schem, label] of variants) {
  const path = join(projectRoot, 'output/tiles', schem + '.schem');
  if (!existsSync(path)) { console.log(`${label}: SKIP`); continue; }
  const grid = await parseToGrid(path);
  const nonAir = grid.countNonAir();
  const maxDim = Math.max(grid.width, grid.length);
  const scale = maxDim < 60 ? 10 : maxDim < 120 ? 6 : 4;
  console.log(`${label}: ${grid.width}x${grid.height}x${grid.length} = ${nonAir} blocks (scale=${scale})`);
  const png = await renderTopDown(grid, { scale });
  const jpg = await sharp(png).jpeg({ quality: 85 }).toBuffer();
  await writeFile(join(outDir, `td-${label}.jpg`), jpg);
  console.log(`  -> ${(jpg.length / 1024).toFixed(0)}KB`);
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('Done!');
