/**
 * Where do zero-thickness part cuboids come from, and what does thickening
 * them cost?
 *
 * Compiles every distinct part of one model with TWO copies of
 * `ldraw-part-prototype.ts` (this tree's and another worktree's) at each grain
 * the planner can put a part at, and counts per part:
 *   - zero cuboids: an extent <= 1e-6 LDU on some axis;
 *   - why: the part's own bounds are flat on that axis ("planar part"), or the
 *     cell starts exactly ON the bounds' far face ("boundary cell": a triangle
 *     in the face plane marked the cell beyond it);
 *   - outside: cuboid volume the other build places beyond the part's bounds.
 *
 * Usage: bun scripts/_planar_cuboid_probe.ts <model.ldr|mpd> <other-tree-root> [--grains=2,4,8]
 * Output: a summary on stdout and output/planar-cuboid-probe.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import * as here from '../web/src/engine/ldraw-part-prototype.ts';

type Proto = typeof here;
type Vec3 = [number, number, number];

const [modelPath, otherRoot] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!modelPath || !otherRoot) throw new Error('usage: <model> <other-tree-root> [--grains=2,4,8]');
const grains = (process.argv.find(a => a.startsWith('--grains='))?.slice(9) ?? '2,4,8').split(',').map(Number);
const other: Proto = await import(pathToFileURL(join(otherRoot, 'web/src/engine/ldraw-part-prototype.ts')).href);

setLDrawRoot(process.env.CRAFTMATIC_LDRAW_REF ?? 'C:/git/clego/extracted/studio_release/app/ldraw');

// The parts the export places, resolved the way the export resolves them: the
// parser's placements, with the document's embedded `.dat` sections served first.
const doc = parseLDrawDocument(readFileSync(modelPath, 'utf8'));
const provider = createPartGeometryProvider({ document: doc });
const names = [...new Set(doc.bricks.map(b => b.part))];

const EPS = Number(process.argv.find(a => a.startsWith('--thin='))?.slice(7) ?? 1e-6);
const HOLLOW = process.argv.includes('--hollow');
interface Tally { cuboids: number; zero: number; planarPart: number; boundaryCell: number; outsideLdu3: number; outsideCuboids: number }
const blank = (): Tally => ({ cuboids: 0, zero: 0, planarPart: 0, boundaryCell: 0, outsideLdu3: 0, outsideCuboids: 0 });

function tally(t: Tally, cuboids: ReadonlyArray<{ min: Vec3; max: Vec3 }>, bmin: Vec3, bmax: Vec3): void {
  for (const c of cuboids) {
    t.cuboids++;
    let zeroAxis = -1;
    for (let a = 0; a < 3; a++) if (c.max[a]! - c.min[a]! <= EPS) zeroAxis = a;
    if (zeroAxis >= 0) {
      t.zero++;
      if (bmax[zeroAxis]! - bmin[zeroAxis]! <= EPS) t.planarPart++;
      else if (Math.abs(c.min[zeroAxis]! - bmax[zeroAxis]!) <= EPS) t.boundaryCell++;
    }
    // Volume of the cuboid outside the part's bounds, per axis overhang x the other two extents.
    let inside = 1;
    let whole = 1;
    for (let a = 0; a < 3; a++) {
      const ext = Math.max(0, c.max[a]! - c.min[a]!);
      const inExt = Math.max(0, Math.min(c.max[a]!, bmax[a]!) - Math.max(c.min[a]!, bmin[a]!));
      whole *= ext; inside *= inExt;
    }
    if (whole - inside > EPS) { t.outsideLdu3 += whole - inside; t.outsideCuboids++; }
  }
}

const sums: Record<string, { here: Tally; other: Tally }> = {};
const perPart: Array<{ part: string; grain: number; here: Tally; other: Tally }> = [];
let unresolved = 0;
for (const name of names) {
  const mesh = await provider.getPartMesh(name);
  if (!mesh?.triangles.length) { unresolved++; continue; }
  const { min, max } = mesh.bounds;
  for (const g of grains) {
    const q = here.resolveEntityQuality({ ...here.resolveEntityQuality('balanced'), microcellLdu: g });
    const a = blank(); const b = blank();
    tally(a, here.compilePartPrototype(mesh, q, { hollow: HOLLOW }).cuboids, [...min] as Vec3, [...max] as Vec3);
    tally(b, other.compilePartPrototype(mesh, q, { hollow: HOLLOW }).cuboids, [...min] as Vec3, [...max] as Vec3);
    const s = (sums[g] ??= { here: blank(), other: blank() });
    for (const k of Object.keys(a) as Array<keyof Tally>) { s.here[k] += a[k]; s.other[k] += b[k]; }
    if (a.zero || b.outsideCuboids) perPart.push({ part: name, grain: g, here: a, other: b });
  }
}

console.log(`${names.length} distinct parts, ${unresolved} unresolved`);
for (const [g, s] of Object.entries(sums)) {
  console.log(`grain ${g}: here cuboids ${s.here.cuboids} zero ${s.here.zero} (planar part ${s.here.planarPart}, boundary cell ${s.here.boundaryCell}) outside ${s.here.outsideCuboids}`
    + ` | other cuboids ${s.other.cuboids} zero ${s.other.zero} outside ${s.other.outsideCuboids} cuboids, ${s.other.outsideLdu3.toFixed(0)} LDU^3`);
}
const partsWithZero = new Set(perPart.filter(r => r.here.zero).map(r => r.part));
console.log(`parts with a zero cuboid here: ${partsWithZero.size}; examples: ${[...partsWithZero].slice(0, 12).join(', ')}`);
mkdirSync('output', { recursive: true });
writeFileSync('output/planar-cuboid-probe.json', JSON.stringify({ model: modelPath, otherRoot, sums, perPart }, null, 1));
