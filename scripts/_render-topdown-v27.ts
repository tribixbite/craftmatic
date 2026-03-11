#!/usr/bin/env bun
/**
 * Render top-down MC-textured views for all v27 (r=1 with OSM mask) buildings.
 */
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderTopDown } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const outDir = join(tilesDir, 'topdown-v27');
await mkdir(outDir, { recursive: true });

// All v27 headless + browser v26 buildings
const SCHEMS = [
  // v27 headless (r=1 with OSM)
  'geisel-headless-v27',
  'guggenheim-headless-v27',
  'mitdome-headless-v27',
  'willistower-headless-v27',
  'pentagon-headless-v27',
  'chicago-loop-headless-v27',
  'test-newton-headless-v27',
  'tiles-arlington-headless-v27',
  'tiles-artinstitute-headless-v27',
  'tiles-dallas2-headless-v27',
  'transamerica-headless-v27',
  'uscapitol-headless-v27',
  'applepark-headless-v27',
  'nyc-ansonia-headless-v27',
  'nyc-apthorp-headless-v27',
  'tiles-cambridge-headless-v27',
  // Browser captures (r=4, building-specific pipeline)
  'noe-v26',
  'chrysler-v26',
  'dakota-v26',
  'stpatricks-v26',
  'flatroof-nashville-v26',
];

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;

for (const name of SCHEMS) {
  if (filterName && !name.includes(filterName)) continue;
  const schemPath = join(tilesDir, `${name}.schem`);
  if (!existsSync(schemPath)) { console.log(`  ${name}: SKIP`); continue; }

  const grid = await parseToGrid(schemPath);
  const nonAir = grid.countNonAir();
  if (nonAir < 200) { console.log(`  ${name}: SKIP (${nonAir} blocks too few)`); continue; }

  const maxDim = Math.max(grid.width, grid.length);
  const scale = maxDim < 60 ? 10 : maxDim < 120 ? 6 : maxDim < 200 ? 4 : 3;

  console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} = ${nonAir} blocks (scale=${scale})`);
  const png = await renderTopDown(grid, { scale });
  const jpg = await sharp(png).jpeg({ quality: 85 }).toBuffer();
  await writeFile(join(outDir, `td-${name}.jpg`), jpg);
  console.log(`  -> ${(jpg.length / 1024).toFixed(0)}KB`);
  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone!');
