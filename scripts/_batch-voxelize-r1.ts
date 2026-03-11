#!/usr/bin/env bun
/**
 * Batch voxelize headless captures at r=1 with OSM polygon masking.
 * r=1 produces recognizable building shapes (~20s each) vs r=4 blobs (~20min each).
 */
import { resolve, join, basename } from 'path';
import { existsSync } from 'fs';
import { $ } from 'bun';

const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');

interface Building {
  glb: string;
  lat: number;
  lng: number;
}

const BUILDINGS: Building[] = [
  // Residential headless
  { glb: 'tiles-dallas-headless',       lat: 32.8512, lng: -96.8277 },
  { glb: 'tiles-scottsdale-headless',   lat: 33.4877, lng: -111.926 },
  { glb: 'tiles-dallas2-headless',      lat: 32.8220, lng: -96.8085 },
  { glb: 'tiles-winnetka-headless',     lat: 42.1057, lng: -87.7325 },
  { glb: 'tiles-cambridge-headless',    lat: 42.3766, lng: -71.1227 },
  { glb: 'tiles-arlington-headless',    lat: 38.8824, lng: -77.1085 },
  { glb: 'tiles-bellaire-headless',     lat: 29.6931, lng: -95.4678 },
  { glb: 'tiles-artinstitute-headless', lat: 41.8796, lng: -87.6237 },
  { glb: 'test-newton-headless',        lat: 42.3435, lng: -71.2215 },
  // Landmark headless
  { glb: 'geisel-headless',        lat: 32.8812, lng: -117.2376 },
  { glb: 'guggenheim-headless',    lat: 40.7830, lng: -73.9590 },
  { glb: 'mitdome-headless',       lat: 42.3594, lng: -71.0928 },
  { glb: 'willistower-headless',   lat: 41.8789, lng: -87.6358 },
  { glb: 'pentagon-headless',      lat: 38.8719, lng: -77.0563 },
  { glb: 'chicago-loop-headless',  lat: 41.8827, lng: -87.6233 },
  { glb: 'transamerica-headless',  lat: 37.7952, lng: -122.4028 },
  { glb: 'uscapitol-headless',     lat: 38.8899, lng: -77.0091 },
  { glb: 'applepark-headless',     lat: 37.3346, lng: -122.0090 },
  { glb: 'gettycenter-headless',   lat: 34.0781, lng: -118.4741 },
  { glb: 'rosebowl-headless',      lat: 34.1614, lng: -118.1676 },
  { glb: 'nyc-ansonia-headless',   lat: 40.7806, lng: -73.9816 },
  { glb: 'nyc-apthorp-headless',   lat: 40.7835, lng: -73.9770 },
];

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;
const forceArg = process.argv.includes('--force');
const resolution = parseInt(process.argv.find(a => a.startsWith('--res='))?.split('=')[1] || '1');

let completed = 0;
let skipped = 0;

for (const b of BUILDINGS) {
  if (filterName && !b.glb.includes(filterName)) continue;

  const glbPath = join(tilesDir, `${b.glb}.glb`);
  const schemPath = join(tilesDir, `${b.glb}-v27.schem`);

  if (!existsSync(glbPath)) {
    console.log(`  SKIP: ${b.glb} (no GLB)`);
    skipped++;
    continue;
  }
  if (existsSync(schemPath) && !forceArg) {
    console.log(`  EXISTS: ${b.glb}`);
    skipped++;
    continue;
  }

  console.log(`\n=== ${b.glb} (r=${resolution}, coords=${b.lat},${b.lng}) ===`);
  const t0 = performance.now();

  const result = Bun.spawnSync([
    process.execPath, 'scripts/voxelize-glb.ts',
    glbPath,
    '-r', String(resolution), '-m', 'surface',
    '--generic', '--fill',
    '--mode-passes', '2',
    '--smooth-pct', '0.03',
    '--no-enu',
    '--coords', `${b.lat},${b.lng}`,
    '-o', schemPath,
  ], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = result.stdout.toString();
  // Print key lines only
  for (const line of output.split('\n')) {
    if (line.includes('Grid:') || line.includes('Blocks:') || line.includes('Wrote:') ||
        line.includes('OSM mask') || line.includes('Ground plane') || line.includes('fill') ||
        line.includes('Palette:') && line.includes('minecraft:')) {
      console.log(`  ${line.trim()}`);
    }
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`  Time: ${elapsed}s`);
  completed++;

  if (typeof Bun !== 'undefined') Bun.gc(true);
}

console.log(`\nBatch complete: ${completed} voxelized, ${skipped} skipped`);
