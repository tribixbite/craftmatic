#!/usr/bin/env bun
import { parseToGrid } from '../src/schem/parse.js';

const files = [
  'output/tiles/flatiron-v73.schem',
  'output/tiles/montgomery-v73c.schem',
  'output/tiles/willis-v73c.schem',
  'output/tiles/flatroof-portland-v73c.schem',
  'output/tiles/lyon-v73c.schem',
  'output/tiles/sanremo-v73c.schem',
];

for (const f of files) {
  const grid = await parseToGrid(f);
  const blocks = new Map<string, number>();
  for (let y = 0; y < grid.height; y++) {
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') blocks.set(b, (blocks.get(b) || 0) + 1);
      }
    }
  }
  const sorted = [...blocks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const total = [...blocks.values()].reduce((a, b) => a + b, 0);
  const fillPct = (total * 100 / (grid.width * grid.height * grid.length)).toFixed(0);
  console.log(`=== ${f.split('/').pop()} ===`);
  console.log(`  ${grid.width}x${grid.height}x${grid.length} | ${grid.palette.size} types | ${total} solid (${fillPct}%)`);
  console.log(`  Top: ${sorted.map(([b, c]) => b.replace('minecraft:', '') + '(' + c + ')').join(', ')}`);
}
