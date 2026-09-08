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

/**
 * Is `b` the same MATERIAL as `a`, only carrying a partial shape?
 * `minecraft:sandstone` → `minecraft:sandstone_slab[type=bottom]` is a shape
 * refinement; `minecraft:sandstone` → `minecraft:white_concrete` is a recolour.
 * Written as a suffix rule over the vanilla naming (see engine/block-shapes.ts).
 */
const SHAPE_SUFFIXES = ['_slab', '_stairs', '_wall', '_fence', '_pane'];
function isShapeRefinement(a: string, b: string): boolean {
  const base = b.replace(/\[.*$/, '');
  for (const suffix of SHAPE_SUFFIXES) {
    if (!base.endsWith(suffix)) continue;
    const stem = base.slice(0, -suffix.length);
    return [stem, `${stem}s`, `${stem}_planks`, `${stem}_block`].includes(a);
  }
  return false;
}

/**
 * The two semantic elements whose material is FIXED (`iron_bars` is a dark gray
 * and `ladder` is oak), so they cannot be derived from the cell's own block the
 * way a pane or a fence can. Counted apart from both refinements and recolours,
 * because they are honestly a bit of each — see engine/part-elements.ts.
 */
const FIXED_ELEMENTS = ['minecraft:iron_bars', 'minecraft:ladder'];
function isFixedElement(b: string): boolean {
  const base = b.replace(/\[.*$/, '');
  return FIXED_ELEMENTS.includes(base);
}

let gained = 0, lost = 0, recolored = 0, shaped = 0, unshaped = 0, same = 0, elements = 0;
const gainedBy = new Map<string, number>();
const lostBy = new Map<string, number>();
const shapedBy = new Map<string, number>();
const elementsBy = new Map<string, number>();
const recoloredBy = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
  const a = at(A, x, y, z), b = at(B, x, y, z);
  if (a === b) { if (a !== AIR) same++; continue; }
  if (a === AIR) { gained++; bump(gainedBy, b); }
  else if (b === AIR) { lost++; bump(lostBy, a); }
  else if (isShapeRefinement(a, b)) { shaped++; bump(shapedBy, `${a} → ${b}`); }
  else if (isFixedElement(b)) { elements++; bump(elementsBy, `${a} → ${b}`); }
  // A full cube where the BEFORE side had a shape is a regression, counted apart.
  else if (isShapeRefinement(b, a)) { unshaped++; bump(recoloredBy, `${a} → ${b}`); }
  else { recolored++; bump(recoloredBy, `${a} → ${b}`); }
}

const top = (m: Map<string, number>) => [...m.entries()].sort((p, q) => q[1] - p[1]).slice(0, 6);
console.log(JSON.stringify({
  before: { file: aPath, dims: [A.width, A.height, A.length] },
  after:  { file: bPath, dims: [B.width, B.height, B.length] },
  unchangedSolid: same, gained, lost, recolored, shaped, unshaped, elements,
  gainedBy: top(gainedBy), lostBy: top(lostBy),
  shapedBy: top(shapedBy), elementsBy: top(elementsBy), recoloredBy: top(recoloredBy),
}, null, 1));
