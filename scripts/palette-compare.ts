import { parseToGrid } from '../src/schem/parse.js';

const file = process.argv[2];
const grid = await parseToGrid(file);
const counts = new Map<string, number>();
for (let y = 0; y < grid.height; y++) {
  for (let z = 0; z < grid.length; z++) {
    for (let x = 0; x < grid.width; x++) {
      const b = grid.get(x, y, z);
      if (b !== 'minecraft:air') {
        counts.set(b, (counts.get(b) || 0) + 1);
      }
    }
  }
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
let total = 0;
for (const [, c] of sorted) total += c;
console.log(`${file}: ${sorted.length} unique blocks, ${total} total`);
for (const [block, count] of sorted.slice(0, 20)) {
  console.log(`  ${(count * 100 / total).toFixed(1)}% ${block.replace('minecraft:', '')} (${count})`);
}
