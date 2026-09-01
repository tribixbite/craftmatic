/** S3 gate: re-import an exported .schem through the REAL Upload-tab parser. */
import { readFileSync } from 'node:fs';
import { parseSchemFile } from '../web/src/engine/schem.ts';
const f = process.argv[2]!;
const b = readFileSync(f);
const grid = await parseSchemFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const counts = new Map<string, number>();
for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) for (let x = 0; x < grid.width; x++) {
  const bs = grid.get(x, y, z); if (bs !== 'minecraft:air') counts.set(bs, (counts.get(bs) ?? 0) + 1);
}
console.log(JSON.stringify({ file: f, dims: [grid.width, grid.height, grid.length],
  nonAir: [...counts.values()].reduce((a, c) => a + c, 0), palette: counts.size,
  top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) }, null, 1));
