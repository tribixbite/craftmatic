#!/usr/bin/env bun
/**
 * Render v47 .schem files as isometric + top-down JPEG pairs for VLM grading.
 * Usage: bun scripts/render-v47.ts [--tile=4]
 */
import { resolve, join } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior } from '../src/render/png-renderer.js';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const TILES_DIR = join(PROJECT_ROOT, 'output/tiles');
const tile = parseInt(process.argv.find(a => a.startsWith('--tile='))?.split('=')[1] ?? '4');

// Comprehensive v47 rendering — all categories
const TARGETS = [
  // NYC landmarks
  'esb-v47', 'chrysler-v47', 'flatiron-v47', 'stpatricks-v47', 'dakota-v47', 'ansonia-v47',
  // Other landmarks
  'pentagon-v47', 'willistower-v47', 'uscapitol-v47', 'guggenheim-v47',
  'transamerica-v47', 'sentinel-v47', 'rosebowl-v47', 'applepark-v47',
  // Residential / mixed
  'francisco-v47', 'noe-v47', 'charleston-v47', 'austin-v47',
  'seattle-v47', 'winchester-v47', 'baker-v47', 'newton-v47',
  // Headless captures
  'chicagoloop-v47', 'mitdome-v47', 'sanremo-v47', 'artinstitute-v47',
];

for (const name of TARGETS) {
  const schemPath = join(TILES_DIR, `${name}.schem`);

  try {
    const grid = await parseToGrid(schemPath);
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

    // Isometric render
    const isoPng = await renderExterior(grid, { tile });
    const isoJpg = await sharp(isoPng).jpeg({ quality: 85 }).toBuffer();
    const isoPath = join(TILES_DIR, `${name}-iso.jpg`);
    await writeFile(isoPath, isoJpg);
    console.log(`  iso: ${(isoJpg.length / 1024).toFixed(0)}KB`);

    // Top-down render
    const tdPng = await renderExterior(grid, { tile, topDown: true });
    const tdJpg = await sharp(tdPng).jpeg({ quality: 85 }).toBuffer();
    const tdPath = join(TILES_DIR, `${name}-td.jpg`);
    await writeFile(tdPath, tdJpg);
    console.log(`  td: ${(tdJpg.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }

  // GC hint between renders to avoid OOM on ARM
  if (typeof Bun !== 'undefined') Bun.gc(true);
}

console.log('\nDone.');
