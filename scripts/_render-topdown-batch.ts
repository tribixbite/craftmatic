#!/usr/bin/env bun
/**
 * Batch render top-down Minecraft-textured views for VLM evaluation.
 * These show actual voxel blocks with textures and height shading.
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
const outDir = join(tilesDir, 'topdown');

await mkdir(outDir, { recursive: true });

// Buildings to render
const SCHEMS = [
  'geisel-headless-v26',
  'guggenheim-headless-v26',
  'mitdome-headless-v26',
  'willistower-headless-v26',
  'pentagon-headless-v26',
  'chicago-loop-headless-v26',
  'test-newton-headless-v26',
  'tiles-arlington-headless-v26',
  'tiles-artinstitute-headless-v26',
  'tiles-dallas2-headless-v26',
  'nyc-ansonia-headless-v26',
  'nyc-apthorp-headless-v26',
  'applepark-headless-v26',
  // Browser captures
  'noe-v26',
  'chrysler-v26',
  'dakota-v26',
  'stpatricks-v26',
  'flatroof-nashville-v26',
  'flatroof-miami-v26',
];

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;
const forceArg = process.argv.includes('--force');

for (const name of SCHEMS) {
  if (filterName && !name.includes(filterName)) continue;

  const schemPath = join(tilesDir, `${name}.schem`);
  if (!existsSync(schemPath)) {
    console.log(`  ${name}: SKIP (no schem)`);
    continue;
  }

  const outPath = join(outDir, `td-${name}.jpg`);
  if (existsSync(outPath) && !forceArg) {
    console.log(`  ${name}: EXISTS`);
    continue;
  }

  const grid = await parseToGrid(schemPath);
  console.log(`\n=== ${name} === Grid: ${grid.width}x${grid.height}x${grid.length}`);

  // Render at scale=6 with textures (not flat)
  const pngBuf = await renderTopDown(grid, { scale: 6 });
  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  → ${(jpgBuf.length / 1024).toFixed(0)}KB`);

  if (typeof Bun !== 'undefined') Bun.gc(true);
}
console.log('\nDone!');
