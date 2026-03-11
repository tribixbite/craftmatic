#!/usr/bin/env bun
/**
 * Render satellite-colored top-down views for all v16 schematics.
 * Projects Google Static Maps satellite image colors onto voxel heightmap geometry.
 *
 * Two modes:
 * - Default: block-resolution render (8px per block, ~120×120 output)
 * - --hires: satellite-resolution render (1 satellite px = 1 output px, ~400×400)
 *
 * Usage: bun scripts/render-satellite-colored.ts [--name=newton] [--version=v25] [--hires]
 */
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderSatelliteColored, renderSatelliteHiRes } from '../src/render/png-renderer.js';

sharp.concurrency(1);

const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');

interface Building {
  name: string;
  lat: number;
  satellites: Record<string, { file: string; zoom: number }>;
}

// All 12 buildings with available satellite images at different zoom levels
const BUILDINGS: Building[] = [
  // v25: high-res satellite rendering (1:1 satellite px = output px)
  // z21 only for SF; z20 for all others
  { name: 'sf',          lat: 37.8011, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v21-satellite', zoom: 21 } } },
  { name: 'newton',      lat: 42.3435, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'sanjose',     lat: 37.3183, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'walpole',     lat: 43.0775, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'byron',       lat: 42.8350, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'vinalhaven',  lat: 44.1172, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'suttonsbay',  lat: 44.8946, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'losangeles',  lat: 34.1162, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'seattle',     lat: 47.5389, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'austin',      lat: 30.3714, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'minneapolis', lat: 45.0180, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
  { name: 'charleston',  lat: 32.7744, satellites: { v20: { file: 'v12-satellite', zoom: 20 }, v25: { file: 'v12-satellite', zoom: 20 } } },
];

const RESOLUTION = 3; // v16 was voxelized at 3 blocks/meter

// Parse args
const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;
const versionArg = process.argv.find(a => a.startsWith('--version='));
const version = versionArg ? versionArg.split('=')[1] : 'v25';
const hiresMode = process.argv.includes('--hires');

for (const b of BUILDINGS) {
  if (filterName && b.name !== filterName) continue;

  const schemPath = join(tilesDir, `${b.name}-v16.schem`);
  const satInfo = b.satellites[version] ?? b.satellites['v20'];
  const satPath = join(tilesDir, `${b.name}-${satInfo.file}.jpg`);
  const outPath = join(tilesDir, `${b.name}-${version}-sathill-td.jpg`);

  if (!existsSync(schemPath)) {
    console.log(`  ${b.name}: SKIP (no v16 schem)`);
    continue;
  }
  if (!existsSync(satPath)) {
    console.log(`  ${b.name}: SKIP (no satellite at ${satPath})`);
    continue;
  }

  console.log(`=== ${b.name} (z${satInfo.zoom}, ${hiresMode ? 'hires' : 'block-res'}) ===`);

  // Load schematic
  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

  // Load satellite image as raw RGB pixels
  const satMeta = await sharp(satPath).metadata();
  const satW = satMeta.width!;
  const satH = satMeta.height!;
  const satRgb = await sharp(satPath)
    .removeAlpha()
    .raw()
    .toBuffer();

  // Compute coverage info
  const DEG2RAD = Math.PI / 180;
  const metersPerPx = 156543.03392 * Math.cos(b.lat * DEG2RAD) / Math.pow(2, satInfo.zoom);
  const coverageM = satW * metersPerPx;
  const gridExtentM = Math.max(grid.width, grid.length) / RESOLUTION;
  console.log(`  Satellite: ${satW}x${satH}, coverage ${coverageM.toFixed(1)}m vs grid ${gridExtentM.toFixed(1)}m`);

  // Render satellite-colored top-down with hillshade
  const pngBuf = hiresMode
    ? await renderSatelliteHiRes(grid, satRgb, satW, satH, {
        resolution: RESOLUTION,
        lat: b.lat,
        zoom: satInfo.zoom,
      })
    : await renderSatelliteColored(grid, satRgb, satW, satH, {
        resolution: RESOLUTION,
        lat: b.lat,
        zoom: satInfo.zoom,
        scale: 8,
      });

  // Convert to JPEG
  const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
  await writeFile(outPath, jpgBuf);
  console.log(`  → ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)\n`);
}

console.log(`Done! ${version} satellite-colored renders in output/tiles/`);
