#!/usr/bin/env bun
import { parseToGrid } from '../src/schem/parse.js';
import { resolve } from 'path';

const file = process.argv[2] ?? 'output/tiles/dakota-v71-test.schem';
const grid = await parseToGrid(resolve(file));
const { width, height, length } = grid;
console.log(`Grid: ${width}x${height}x${length}`);

// Build height map — topmost non-air Y per column
const heightMap: number[][] = [];
for (let z = 0; z < length; z++) {
  heightMap[z] = [];
  for (let x = 0; x < width; x++) {
    let topY = -1;
    for (let y = height - 1; y >= 0; y--) {
      if (grid.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
    }
    heightMap[z][x] = topY;
  }
}

// Print top-down ASCII: # = tall (>30), o = mid (15-30), . = low (1-14), _ = empty
console.log('\n--- Top-Down Height Map ---');
for (let z = 0; z < length; z++) {
  let row = '';
  for (let x = 0; x < width; x++) {
    const h = heightMap[z][x];
    if (h < 0) row += ' ';
    else if (h >= 30) row += '#';
    else if (h >= 15) row += 'o';
    else if (h >= 1) row += '.';
    else row += '_';
  }
  console.log(`${String(z).padStart(2)}: ${row.trimEnd()}`);
}

// Count columns by height bucket
const buckets = new Map<string, number>();
for (let z = 0; z < length; z++) {
  for (let x = 0; x < width; x++) {
    const h = heightMap[z][x];
    let label: string;
    if (h < 0) label = 'empty';
    else if (h < 5) label = '0-4';
    else if (h < 10) label = '5-9';
    else if (h < 15) label = '10-14';
    else if (h < 20) label = '15-19';
    else if (h < 25) label = '20-24';
    else if (h < 30) label = '25-29';
    else if (h < 35) label = '30-34';
    else if (h < 40) label = '35-39';
    else label = '40+';
    buckets.set(label, (buckets.get(label) ?? 0) + 1);
  }
}
console.log('\n--- Height Distribution ---');
for (const [label, count] of [...buckets.entries()].sort()) {
  console.log(`  ${label}: ${count} columns`);
}

// Count courtyard columns — columns surrounded by tall neighbors but themselves short/empty
let courtyardCols = 0;
const courtyardPositions: string[] = [];
for (let z = 2; z < length - 2; z++) {
  for (let x = 2; x < width - 2; x++) {
    const h = heightMap[z][x];
    if (h >= 20) continue; // Already tall
    // Check 4 cardinal neighbors at distance 2
    const neighbors = [heightMap[z-2][x], heightMap[z+2][x], heightMap[z][x-2], heightMap[z][x+2]];
    const tallNeighbors = neighbors.filter(n => n >= 25).length;
    if (tallNeighbors >= 3) {
      courtyardCols++;
      courtyardPositions.push(`(${x},${z}) h=${h}`);
    }
  }
}
console.log(`\nPotential courtyard columns (short, surrounded by tall): ${courtyardCols}`);
if (courtyardPositions.length > 0 && courtyardPositions.length <= 30) {
  courtyardPositions.forEach(p => console.log(`  ${p}`));
}
