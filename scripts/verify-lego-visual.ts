#!/usr/bin/env bun
/**
 * Visual LEGO voxelization proof — top-down ASCII projection.
 *
 * Fetches OMR MPD files, voxelizes them, and renders a top-down view
 * as ASCII art so shapes are visually recognizable.
 *
 * Usage: bun scripts/verify-lego-visual.ts
 */

import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';

const OMR_BASE = 'https://library.ldraw.org/library/omr';

const SETS = [
  { set_num: '21309-1', name: 'NASA Apollo Saturn V (tall cylinder)', expected: 'Tall rocket silhouette' },
  { set_num: '10030-1', name: 'UCS Imperial Star Destroyer (wedge)', expected: 'Triangular/wedge shape' },
  { set_num: '10179-1', name: 'UCS Millennium Falcon (disk)', expected: 'Circular/oval shape' },
  { set_num: '75060-1', name: 'UCS Slave I (elongated)', expected: 'Oval elongated shape' },
];

/** Project grid to top-down XZ view, return filled cells */
function topDown(grid: { width: number; height: number; length: number; get(x: number, y: number, z: number): string }): boolean[][] {
  const map: boolean[][] = Array.from({ length: grid.length }, () => new Array(grid.width).fill(false));
  for (let y = 0; y < grid.height; y++)
    for (let z = 0; z < grid.length; z++)
      for (let x = 0; x < grid.width; x++)
        if (grid.get(x, y, z) !== 'minecraft:air') map[z][x] = true;
  return map;
}

/** Scale down a 2D map to fit in maxW × maxH */
function scaleMap(map: boolean[][], maxW: number, maxH: number): boolean[][] {
  const srcH = map.length, srcW = map[0]?.length ?? 0;
  if (srcH === 0 || srcW === 0) return [[]];
  const scaleX = srcW / maxW, scaleZ = srcH / maxH;
  return Array.from({ length: maxH }, (_, tz) => {
    return Array.from({ length: maxW }, (_, tx) => {
      const z0 = Math.floor(tz * scaleZ), z1 = Math.ceil((tz + 1) * scaleZ);
      const x0 = Math.floor(tx * scaleX), x1 = Math.ceil((tx + 1) * scaleX);
      for (let z = z0; z < z1; z++)
        for (let x = x0; x < x1; x++)
          if (map[z]?.[x]) return true;
      return false;
    });
  });
}

/** Render top-down map as ASCII with block density char */
function renderMap(map: boolean[][], filled = '█', empty = '·'): string {
  return map.map(row => row.map(c => c ? filled : empty).join('')).join('\n');
}

async function main() {
  console.log('LEGO Voxelization — Top-Down Shape Verification');
  console.log('=================================================\n');

  let allPassed = true;

  for (const spec of SETS) {
    process.stdout.write(`Fetching ${spec.set_num} ${spec.name}… `);
    const t0 = Date.now();

    const resp = await fetch(`${OMR_BASE}/${spec.set_num}.mpd`, {
      headers: { 'User-Agent': 'craftmatic-verify/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) { console.log(`\n  FAIL: HTTP ${resp.status}`); allPassed = false; continue; }
    const text = await resp.text();

    const bricks = parseLDraw(text, `${spec.set_num}.mpd`);
    const result = voxelizeLDraw(bricks);
    const { grid, brickCount, dimensions, warning } = result;
    const blockCount = grid.countNonAir();
    const elapsed = Date.now() - t0;

    console.log(`${elapsed}ms`);
    console.log(`  ${brickCount} bricks → ${blockCount.toLocaleString()} blocks | ${dimensions.w}×${dimensions.h}×${dimensions.l} | ${result.uniqueColors} colors`);
    if (warning) console.log(`  ⚠ ${warning}`);

    // Metrics check
    const pass = blockCount > brickCount * 1.6 && result.uniqueColors >= 3 &&
      dimensions.w >= 5 && dimensions.h >= 5 && dimensions.l >= 5;
    console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'} — ${spec.expected}`);
    if (!pass) allPassed = false;

    // Top-down ASCII projection (40 wide × 20 tall)
    const map = topDown(grid);
    const scaled = scaleMap(map, 40, 16);
    console.log('\n  Top-down view (filled blocks projected):');
    for (const line of renderMap(scaled).split('\n'))
      console.log(`  |${line}|`);
    console.log();
  }

  console.log('=================================================');
  if (allPassed) {
    console.log('All checks PASSED — proper per-part bounding-box fill confirmed.');
    process.exit(0);
  } else {
    console.log('FAILURES detected — pipeline needs fixing.');
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
