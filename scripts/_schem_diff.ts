/**
 * Content-level diff of two exported .schem files.
 *
 * The byte-identity gate (`scripts/_schem_ref.ts`) tells you the output MOVED;
 * this tells you whether it moved in the right direction. Both files are
 * re-imported through the REAL Upload-tab parser and compared cell by cell:
 * cells gained, cells lost, cells recoloured.
 *
 * Grids of different size are aligned at their origin (the export writes the
 * model's own bounding box, so a pass that only ADDS cells inside the hull
 * keeps the dims identical — a dims change is itself reported).
 *
 * Usage: bun scripts/_schem_diff.ts <before.schem> <after.schem>
 */
import { readFileSync } from 'node:fs';
import { parseSchemFile } from '../web/src/engine/schem.ts';

async function load(path: string) {
  const b = readFileSync(path);
  return parseSchemFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}

const [aPath, bPath] = process.argv.slice(2);
const A = await load(aPath!);
const B = await load(bPath!);

const W = Math.max(A.width, B.width), H = Math.max(A.height, B.height), L = Math.max(A.length, B.length);
const AIR = 'minecraft:air';
const at = (g: typeof A, x: number, y: number, z: number) =>
  (x < g.width && y < g.height && z < g.length) ? g.get(x, y, z) : AIR;

let gained = 0, lost = 0, recolored = 0, same = 0;
const gainedBy = new Map<string, number>();
const lostBy = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
  const a = at(A, x, y, z), b = at(B, x, y, z);
  if (a === b) { if (a !== AIR) same++; continue; }
  if (a === AIR) { gained++; bump(gainedBy, b); }
  else if (b === AIR) { lost++; bump(lostBy, a); }
  else recolored++;
}

const top = (m: Map<string, number>) => [...m.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6);
console.log(JSON.stringify({
  before: { file: aPath, dims: [A.width, A.height, A.length] },
  after:  { file: bPath, dims: [B.width, B.height, B.length] },
  unchangedSolid: same, gained, lost, recolored,
  gainedBy: top(gainedBy), lostBy: top(lostBy),
}, null, 1));
