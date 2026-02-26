#!/usr/bin/env bun
/**
 * Render comparison images from existing comparison-data.json.
 * Runs one address at a time with GC hints to avoid OOM on ARM devices.
 * Usage: bun scripts/render-comparison-images.ts [--key=sf] [--tile=6]
 */
import { resolve, join } from 'path';
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import sharp from 'sharp';
import { convertToGenerationOptions, type PropertyData } from '../src/gen/address-pipeline.js';
import { generateStructure } from '../src/gen/generator.js';
import { renderExterior, renderCutawayIso, renderFloorDetail } from '../src/render/png-renderer.js';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const OUT_DIR = join(PROJECT_ROOT, 'output/comparison');
const WEB_DIR = join(PROJECT_ROOT, 'web/public/comparison');

// Parse args
const keyFilter = process.argv.find(a => a.startsWith('--key='))?.split('=')[1];
const tile = parseInt(process.argv.find(a => a.startsWith('--tile='))?.split('=')[1] ?? '6');

async function toJpeg(pngBuf: Buffer): Promise<Buffer> {
  return sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
}

await mkdir(OUT_DIR, { recursive: true });
await mkdir(WEB_DIR, { recursive: true });

const json = JSON.parse(await readFile(join(OUT_DIR, 'comparison-data.json'), 'utf-8'));

for (const entry of json) {
  if (keyFilter && entry.key !== keyFilter) continue;

  console.log(`\n=== ${entry.key}: ${entry.address} ===`);

  for (const tier of entry.tiers) {
    // Reconstruct PropertyData minimally for generation
    const prop: Partial<PropertyData> = {
      ...tier.property,
      address: entry.address,
    };
    const opts = convertToGenerationOptions(prop as PropertyData);
    // Override with stored options to ensure identical output
    Object.assign(opts, tier.genOptions);

    console.log(`  [${tier.tier}] ${opts.style} ${opts.floors}f ${opts.width}x${opts.length}`);

    const grid = generateStructure(opts);
    console.log(`    Grid: ${grid.width}x${grid.height}x${grid.length}`);

    // Exterior
    const extBuf = await renderExterior(grid, { tile });
    const extFile = tier.views.exterior;
    const extJpeg = await toJpeg(extBuf);
    await writeFile(join(OUT_DIR, extFile), extJpeg);
    await copyFile(join(OUT_DIR, extFile), join(WEB_DIR, extFile));
    console.log(`    + ${extFile} (${(extJpeg.length / 1024).toFixed(0)}KB)`);

    // Cutaway + floor plans
    for (let f = 0; f < Math.min(opts.floors, 9); f++) {
      const cutBuf = await renderCutawayIso(grid, f, { tile });
      const cutFile = `${entry.key}-${tier.tier}_cutaway_${f}.jpg`;
      const cutJpeg = await toJpeg(cutBuf);
      await writeFile(join(OUT_DIR, cutFile), cutJpeg);
      await copyFile(join(OUT_DIR, cutFile), join(WEB_DIR, cutFile));

      const floorBuf = await renderFloorDetail(grid, f, { scale: Math.max(8, tile * 2) });
      const floorFile = `${entry.key}-${tier.tier}_floor_${f}.jpg`;
      const floorJpeg = await toJpeg(floorBuf);
      await writeFile(join(OUT_DIR, floorFile), floorJpeg);
      await copyFile(join(OUT_DIR, floorFile), join(WEB_DIR, floorFile));
    }
    console.log(`    + ${opts.floors * 2} cutaway/floor images`);

    // Hint GC between tiers
    if (typeof Bun !== 'undefined' && Bun.gc) Bun.gc(true);
  }
}

console.log('\n+ Image rendering complete');
