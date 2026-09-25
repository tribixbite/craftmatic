/**
 * List the parts of a pinball model with their plane coordinates (u down the
 * table, w across, h above the floor), optionally filtered by LDraw colour
 * codes or by a plane window. Finds which part a device screenshot shows at a
 * spot (the orange ring and post of 2026-09-24 were found this way).
 *
 * Usage: bun scripts/_pinball_parts_near.ts <model.ldr> [--colors=25,182] [--u=a..b] [--w=a..b] [--h=a..b]
 */
import { readFileSync } from 'node:fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { partStem } from '../web/src/engine/part-id.ts';
import { detectPinballTable } from '../web/src/engine/pinball-table.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_pinball_parts_near.ts <model.ldr> [--colors=..] [--u=a..b] [--w=a..b] [--h=a..b]'); process.exit(64); }
const flag = (k: string): string | undefined => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const range = (k: string): [number, number] | undefined => {
  const v = flag(k);
  if (!v) return undefined;
  const [a, b] = v.split('..').map(Number);
  return [a!, b!];
};
const colors = flag('colors')?.split(',').map(Number);
const ur = range('u'), wr = range('w'), hr = range('h');

const bricks = parseLDraw(readFileSync(file, 'utf8'));
const provider = createPartGeometryProvider({});
const meshes = new Map<string, LdrawPartMesh | null>();
for (const b of bricks) {
  const stem = partStem(b.part);
  if (!meshes.has(stem)) meshes.set(stem, await provider.getPartMesh(`${stem}.dat`));
}
const table = detectPinballTable(bricks, meshes);
if (!table) { console.log('no pinball table'); process.exit(1); }
const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const flip = new Set(table.flippers.flatMap(f => f.bricks));
bricks.forEach((b, i) => {
  if (colors && !colors.includes(b.color)) return;
  const p = [b.x, b.y, b.z];
  const u = dot(p, table.axisU), w = dot(p, table.axisW), h = dot(p, table.axisN) - table.floorH;
  if (ur && (u < ur[0] || u > ur[1])) return;
  if (wr && (w < wr[0] || w > wr[1])) return;
  if (hr && (h < hr[0] || h > hr[1])) return;
  const m = meshes.get(partStem(b.part));
  const tag = flip.has(i) ? ' FLIPPER' : table.ballBricks.includes(i) ? ' BALL' : '';
  console.log(`#${i} ${partStem(b.part)} c${b.color} xyz ${[b.x, b.y, b.z].map(v => v.toFixed(0)).join(',')} u ${u.toFixed(0)} w ${w.toFixed(0)} h ${h.toFixed(0)}${tag}  ${m?.description ?? '?'}`);
});
