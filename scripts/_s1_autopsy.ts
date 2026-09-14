/** Autopsy a .schem: list every palette entry with its block count. */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseSchematic } from '../src/schem/parse';

const path = process.argv[2];
const data = await parseSchematic(path);
console.log(`file      : ${path}`);
console.log(`size      : ${(readFileSync(path).length / 1024).toFixed(0)} KiB gz`);
console.log(`dims      : ${data.width} x ${data.height} x ${data.length}`);

const counts = new Map<string, number>();
const inv = new Map<number, string>();
for (const [name, id] of Object.entries(data.palette as Record<string, number>)) inv.set(id, name);
for (const id of data.blockData) counts.set(inv.get(id) ?? `?${id}`, (counts.get(inv.get(id) ?? `?${id}`) ?? 0) + 1);

const rows = [...counts.entries()].filter(([b]) => !/minecraft:air/.test(b)).sort((a, b) => b[1] - a[1]);
const total = rows.reduce((a, [, n]) => a + n, 0);
console.log(`palette   : ${Object.keys(data.palette).length} entries, ${total.toLocaleString()} non-air blocks\n`);
let glass = 0;
for (const [b, n] of rows) {
  const g = /glass/.test(b);
  if (g) glass += n;
  console.log(`  ${g ? 'GLASS ' : '      '}${b.padEnd(38)} ${String(n).padStart(9)}  ${(100 * n / total).toFixed(1)}%`);
}
console.log(`\ntranslucent/glass blocks: ${glass.toLocaleString()} / ${total.toLocaleString()} = ${(100 * glass / total).toFixed(1)}%`);
