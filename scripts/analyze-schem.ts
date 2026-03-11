/**
 * Quick schem block distribution analyzer.
 * Usage: bun scripts/analyze-schem.ts <file.schem>
 */
import { parseToGrid } from '../src/schem/parse.js';

const path = process.argv[2];
if (!path) { console.error('Usage: bun scripts/analyze-schem.ts <file.schem>'); process.exit(1); }

const grid = await parseToGrid(path);
const counts = new Map<string, number>();
for (let y = 0; y < grid.height; y++)
  for (let z = 0; z < grid.length; z++)
    for (let x = 0; x < grid.width; x++) {
      const b = grid.get(x, y, z);
      if (b !== 'minecraft:air') counts.set(b, (counts.get(b) || 0) + 1);
    }
const total = [...counts.values()].reduce((a, b) => a + b, 0);
[...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([block, count]) => {
    const pct = (count / total * 100).toFixed(1);
    console.log(`${pct.padStart(5)}%  ${count.toString().padStart(5)}  ${block}`);
  });
console.log(`\nTotal non-air: ${total}`);
console.log(`Unique blocks: ${counts.size}`);
console.log(`Grid: ${grid.width}x${grid.height}x${grid.length}`);
