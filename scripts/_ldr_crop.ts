/**
 * Write the placements of an LDraw source that fall inside a box as a flat
 * `.ldr`, for a close look at one room, one door or one piece of furniture
 * in the viewer (`node scripts/_shoot_set.mjs <out.ldr> <out.png>`): a
 * whole-model render hides a chair behind three floors of wall.
 *
 * Usage: bun scripts/_ldr_crop.ts <model.ldr|.mpd> <out.ldr> <x0,y0,z0> <x1,y1,z1> [--mark=<x,y,z>]
 *   A placement is kept when its origin lies inside the box (LDraw units,
 *   LDraw axes: Y is DOWN). --mark adds a bright-red 1 x 1 round plate at a
 *   point (a seat surface, a hinge line) so it can be found in the render.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';

const [src, out, a, b] = process.argv.slice(2).filter(x => !x.startsWith('--'));
if (!src || !out || !a || !b) { console.error('usage: bun scripts/_ldr_crop.ts <model> <out.ldr> <x0,y0,z0> <x1,y1,z1> [--mark=x,y,z]'); process.exit(64); }
const lo = a.split(',').map(Number), hi = b.split(',').map(Number);
const min = lo.map((v, i) => Math.min(v, hi[i]!)), max = lo.map((v, i) => Math.max(v, hi[i]!));
const doc = parseLDrawDocument(readFileSync(src, 'utf8'));
const lines = ['0 Crop of ' + src.replace(/\\/g, '/').split('/').pop(), `0 Name: ${out.replace(/\\/g, '/').split('/').pop()}`];
let kept = 0;
for (const p of doc.bricks) {
  if (p.x < min[0]! || p.x > max[0]! || p.y < min[1]! || p.y > max[1]! || p.z < min[2]! || p.z > max[2]!) continue;
  const r = p.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  lines.push(`1 ${p.color} ${p.x} ${p.y} ${p.z} ${r.join(' ')} ${p.part}`);
  kept++;
}
for (const m of process.argv.filter(x => x.startsWith('--mark='))) {
  const [x, y, z] = m.slice(7).split(',').map(Number);
  lines.push(`1 4 ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 4073.dat`);
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${kept} of ${doc.bricks.length} placements -> ${out}`);
