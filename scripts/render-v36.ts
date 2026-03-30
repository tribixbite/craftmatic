#!/usr/bin/env bun
/**
 * Render v36 batch .schem files as exterior JPEG images for VLM grading.
 * Usage: bun scripts/render-v36.ts [--tile=4] [--name=pentagon]
 */
import { resolve, join } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior } from '../src/render/png-renderer.js';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const TILES_DIR = join(PROJECT_ROOT, 'output/tiles');
const tile = parseInt(process.argv.find(a => a.startsWith('--tile='))?.split('=')[1] ?? '4');
const nameFilter = process.argv.find(a => a.startsWith('--name='))?.split('=')[1];

const BUILDINGS = [
  'esb', 'chrysler', 'transamerica', 'flatiron', 'guggenheim', 'pentagon',
  'uscapitol', 'stpatricks', 'mitdome', 'geisel', 'dakota', 'sentinel',
];

const VERSION = process.argv.find(a => a.startsWith('--version='))?.split('=')[1] ?? 'v36';

for (const name of BUILDINGS) {
  if (nameFilter && !name.includes(nameFilter)) continue;

  const schemPath = join(TILES_DIR, `${name}-${VERSION}.schem`);
  const outPath = join(TILES_DIR, `${name}-${VERSION}.jpg`);

  try {
    const grid = await parseToGrid(schemPath);
    console.log(`${name}: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

    const pngBuf = await renderExterior(grid, { tile });
    const jpgBuf = await sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
    await writeFile(outPath, jpgBuf);
    console.log(`  → ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }

  // GC hint between renders to avoid OOM on ARM
  if (typeof Bun !== 'undefined') Bun.gc(true);
}

console.log('\nDone.');
