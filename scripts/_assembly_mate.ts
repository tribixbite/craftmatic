/**
 * Can two sub-assemblies that were laid out side by side be MATED back into
 * one model, without being told how?
 *
 * 76417 Gringotts ships in every source as two assemblies standing apart at the
 * same height — the white bank (2,867 parts) and the dark rock vault (1,511) —
 * and nothing in LEGO's own instruction file carries a placement transform for
 * them (see the memory note). The box art shows one tall tower, so the join
 * exists physically even though no file states it.
 *
 * This searches for it the way the bricks themselves decide: the translation
 * that puts the two in CONTACT over the largest area while never letting them
 * interpenetrate. Only whole-stud translations in X/Z and whole-plate in Y are
 * considered, because a LEGO join is on that lattice.
 *
 * It reports the best few candidates with their scores, so a weak or ambiguous
 * result is visible as such rather than being applied as if it were certain.
 * Nothing is written: this measures whether the join is recoverable.
 *
 * Usage: bun scripts/_assembly_mate.ts <model.ldr> [--window 60] [--top 5]
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh, type Vec3 } from '../web/src/engine/ldraw-part-geometry.ts';
import { connectedClusters } from '../web/src/engine/ldraw-entity-compiler.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const argv = process.argv.slice(2);
const num = (flag: string, fallback: number): number => {
  const i = argv.indexOf(flag);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
/** Half-width of the X/Z search, in studs. */
const WINDOW = num('--window', 60);
const TOP = num('--top', 5);
const file = argv.find(a => !a.startsWith('--') && !/^\d+$/.test(a))!;

const STUD = 20, PLATE = 8;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const bricks = parseLDrawDocument(readFileSync(file, 'utf8')).bricks;
const provider = createPartGeometryProvider({});
const meshes = new Map<string, LdrawPartMesh | null>();
await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));

const boxOf = (brick: typeof bricks[number]): { min: Vec3; max: Vec3 } => {
  const mesh = meshes.get(brick.part);
  const R = brick.rot ?? IDENTITY;
  const t: Vec3 = [brick.x, brick.y, brick.z];
  if (!mesh?.bounds?.min) return { min: t, max: t };
  const { min, max } = mesh.bounds;
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const corner of [[min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
    [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]]] as Vec3[]) {
    for (let a = 0; a < 3; a++) {
      const v = R[a * 3]! * corner[0] + R[a * 3 + 1]! * corner[1] + R[a * 3 + 2]! * corner[2] + t[a]!;
      lo[a] = Math.min(lo[a]!, v); hi[a] = Math.max(hi[a]!, v);
    }
  }
  return { min: lo, max: hi };
};

const boxes = bricks.map(boxOf);
const groups = connectedClusters(boxes);
if (groups.length < 2) { console.log('one piece: nothing to mate'); process.exit(0); }

/** Occupancy on the LEGO lattice: X/Z per stud, Y per plate. */
function occupancyOf(group: readonly number[]): Set<number> {
  const cells = new Set<number>();
  for (const index of group) {
    const b = boxes[index]!;
    const x0 = Math.floor(b.min[0]! / STUD), x1 = Math.ceil(b.max[0]! / STUD);
    const y0 = Math.floor(b.min[1]! / PLATE), y1 = Math.ceil(b.max[1]! / PLATE);
    const z0 = Math.floor(b.min[2]! / STUD), z1 = Math.ceil(b.max[2]! / STUD);
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) {
      cells.add(((x + 1024) * 4096 + (y + 1024)) * 4096 + (z + 1024));
    }
  }
  return cells;
}

const key = (x: number, y: number, z: number): number => ((x + 1024) * 4096 + (y + 1024)) * 4096 + (z + 1024);
const unkey = (k: number): [number, number, number] =>
  [Math.floor(k / (4096 * 4096)) - 1024, (Math.floor(k / 4096) % 4096) - 1024, (k % 4096) - 1024];

const [aGroup, bGroup] = [groups[0]!, groups[1]!];
const aCells = occupancyOf(aGroup), bCells = occupancyOf(bGroup);
const aList = [...aCells].map(unkey), bList = [...bCells].map(unkey);
console.log(`${file.split(/[\\/]/).at(-1)}`);
console.log(`  piece A ${aGroup.length} parts, ${aCells.size} cells; piece B ${bGroup.length} parts, ${bCells.size} cells`);

/**
 * Score a translation of piece B: contacts are B cells vertically adjacent to
 * an A cell; any shared cell is interpenetration and disqualifies outright,
 * because two bricks cannot occupy the same space.
 */
function score(dx: number, dy: number, dz: number): { contacts: number; overlap: number } {
  let contacts = 0, overlap = 0;
  for (const [x, y, z] of bList) {
    const px = x + dx, py = y + dy, pz = z + dz;
    if (aCells.has(key(px, py, pz))) { overlap++; if (overlap > 0) return { contacts: 0, overlap }; }
    if (aCells.has(key(px, py - 1, pz)) || aCells.has(key(px, py + 1, pz))) contacts++;
  }
  return { contacts, overlap };
}

// A LEGO join is on the lattice, and the two pieces stand at the same height in
// the source, so the interesting vertical offsets are the ones that stack them.
const aY = aList.reduce((r, c) => [Math.min(r[0], c[1]), Math.max(r[1], c[1])] as [number, number], [Infinity, -Infinity]);
const bY = bList.reduce((r, c) => [Math.min(r[0], c[1]), Math.max(r[1], c[1])] as [number, number], [Infinity, -Infinity]);
// LDraw Y is DOWN: B sits UNDER A when B's top meets A's bottom.
const stackDy = aY[1] - bY[0];

// The pieces stand ~115 studs apart, so a window centred on ZERO never reaches
// the join. Centre it on the translation that aligns their footprint centres.
const centreOf = (list: Array<[number, number, number]>, axis: number): number => {
  let lo = Infinity, hi = -Infinity;
  for (const c of list) { lo = Math.min(lo, c[axis]!); hi = Math.max(hi, c[axis]!); }
  return (lo + hi) / 2;
};
const baseDx = Math.round(centreOf(aList, 0) - centreOf(bList, 0));
const baseDz = Math.round(centreOf(aList, 2) - centreOf(bList, 2));

const results: Array<{ dx: number; dy: number; dz: number; contacts: number }> = [];
for (let dy = stackDy - 4; dy <= stackDy + 4; dy++) {
  for (let dx = baseDx - WINDOW; dx <= baseDx + WINDOW; dx++) {
    for (let dz = baseDz - WINDOW; dz <= baseDz + WINDOW; dz++) {
      const s = score(dx, dy, dz);
      if (s.overlap || !s.contacts) continue;
      results.push({ dx, dy, dz, contacts: s.contacts });
    }
  }
}
results.sort((a, b) => b.contacts - a.contacts);

console.log(`  searched dy=${stackDy}+/-4 plates, dx=${baseDx}+/-${WINDOW}, dz=${baseDz}+/-${WINDOW} studs (centred on footprint alignment)`);
if (!results.length) { console.log('  NO translation puts them in contact without interpenetration.'); process.exit(0); }
console.log(`  ${results.length} contact-making translations; best:`);
for (const r of results.slice(0, TOP)) {
  console.log(`    dx ${String(r.dx).padStart(4)} studs  dy ${String(r.dy).padStart(4)} plates  dz ${String(r.dz).padStart(4)} studs  -> ${r.contacts} contact cells`);
}
const best = results[0]!, runnerUp = results[1];
if (runnerUp) {
  const margin = (best.contacts - runnerUp.contacts) / best.contacts;
  console.log(`  best beats the next by ${(margin * 100).toFixed(0)} % - ${margin > 0.2 ? 'a clear winner' : 'AMBIGUOUS, do not apply without another signal'}`);
}
