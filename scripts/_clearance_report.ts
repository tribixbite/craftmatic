/**
 * The clearance CALCULATOR (docs/bedrock-interactivity.md, "Clearance:
 * colliders pulled back to the geometry"): per set, how much of the model a
 * player reaches on foot and how many of its rooms and doorways, from the
 * colliders a pack ships - before clearance and after, at 100 % and at the
 * wand's sizes.
 *
 * Usage: bun scripts/_clearance_report.ts <after dir> --before=<before dir>
 *          [--sizes=100,150,200,300,400] [--sets=76417,76457] [--json=out.json] [--md=out.md]
 * Both directories are `_favorites_export_sweep.ts` outputs (`<set>.mcaddon`).
 *
 * What it measures, over the exact world the pack lays (`WalkWorld`: the
 * re-lay at that size, turn 0, its shipped treads, every clearance form as its
 * own boxes; every doorway OPEN where it is passable at that size, closed
 * otherwise, as the runtime lays it):
 *
 * - REACH: standing spots a 0.6 x 1.8 player walks to from the ground around
 *   the model. A spot is a point on a lattice (a quarter block, half a block
 *   at 300 % and over) and a surface under it with the player's box free
 *   above; a move goes to a neighbouring lattice point up at most a jump
 *   (1.25, with the arc clear) or down any drop, the body free at the higher
 *   of the two heights. `area` is the reached spots inside the footprint in
 *   square blocks, divided by the size factor squared so sizes compare at
 *   100 % scale.
 * - ROOMS: the footprint's standing spots grouped into flat regions (moves of
 *   at most a step, 9/16, up or down); a room is a region of at least one
 *   square block (100 % scale), and it is REACHED when the walk reaches any
 *   spot of it.
 * - DOORWAYS: the passability walk's verdicts (`interactive-walk.ts`), turn 0.
 *
 * It is a measure of the collider world, the thing clearance changes; it does
 * not know which rooms a person would call rooms.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadAddonPreviewModel, treadBlocksAt, type AddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';
import { WalkWorld, type SolidBox } from '../web/src/engine/addon-walk.ts';
import { ixClosedBlocks } from '../web/src/engine/bedrock-interactives.ts';
import { verdictOf, walkThroughDoorway, type Verdict } from '../web/src/engine/interactive-walk.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const afterDir = process.argv.slice(2).find(a => !a.startsWith('--'));
const beforeDir = flag('before');
if (!afterDir || !beforeDir) { console.error('usage: bun scripts/_clearance_report.ts <after dir> --before=<before dir> [--sizes=100,150,200,300,400] [--sets=..] [--json=] [--md=]'); process.exit(2); }
const sizes = (flag('sizes') ?? '100,150,200,300,400').split(',').map(Number);
const only = flag('sets')?.split(',');

const PLAYER_HALF = 0.3, PLAYER_H = 1.8, JUMP = 1.25, STEP = 9 / 16, EPS = 1e-6;

interface Measure { area: number; rooms: number; roomsReached: number; spots: number }
interface DoorCounts { OK: number; SMALL: number; FAIL: number; 'NO-APPROACH': number; SEALED: number; STEP: number }

/** Reach and rooms over one pack at one size (turn 0). */
function measure(model: AddonPreviewModel, sizePct: number): Measure {
  const f = sizePct / 100, r: QuarterTurn = 0;
  const world = new WalkWorld({ cells: model.cells, dims: model.dims, sizePct, rotation: r, treads: 'shipped', shippedTreads: (s, q) => treadBlocksAt(model, s, q) });
  if (model.interactives) world.setOverlayBlocks(ixClosedBlocks(model.interactives.items, model.dims, f, r, () => true));
  const W = world.width, L = world.length;
  const step = sizePct >= 300 ? 0.5 : 0.25;
  const per = 1 / step, pad = 1;
  const NX = Math.ceil((W + 2 * pad) * per), NZ = Math.ceil((L + 2 * pad) * per);
  const pointX = (i: number): number => -pad + (i + 0.5) * step, pointZ = (j: number): number => -pad + (j + 0.5) * step;
  const colCache = new Map<number, SolidBox[]>();
  const column = (cx: number, cz: number): SolidBox[] => {
    const k = (cx + 4) * 100003 + (cz + 4);
    let c = colCache.get(k);
    if (!c) colCache.set(k, c = world.boxesInColumn(cx, cz));
    return c;
  };
  /** Solids a player box at (x, z) could touch, from the up-to-four columns under its footprint. */
  const near = (x: number, z: number): SolidBox[] => {
    const out: SolidBox[] = [];
    for (let cx = Math.floor(x - PLAYER_HALF); cx <= Math.floor(x + PLAYER_HALF - EPS); cx++)
      for (let cz = Math.floor(z - PLAYER_HALF); cz <= Math.floor(z + PLAYER_HALF - EPS); cz++) out.push(...column(cx, cz));
    return out.filter(b => b.x1 > x - PLAYER_HALF + EPS && b.x0 < x + PLAYER_HALF - EPS && b.z1 > z - PLAYER_HALF + EPS && b.z0 < z + PLAYER_HALF - EPS);
  };
  const nearCache: SolidBox[][] = new Array(NX * NZ);
  const nearAt = (i: number, j: number): SolidBox[] => nearCache[i * NZ + j] ??= near(pointX(i), pointZ(j));
  const free = (boxes: readonly SolidBox[], y0: number, y1: number): boolean => boxes.every(b => b.y1 <= y0 + EPS || b.y0 >= y1 - EPS);
  // Standing spots per lattice point: surfaces (box tops and the ground) with the player's box free above.
  const tops: number[][] = new Array(NX * NZ);
  for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
    const bs = nearAt(i, j);
    const cand = new Set<number>([0, ...bs.map(b => b.y1)]);
    tops[i * NZ + j] = [...cand].filter(t => free(bs, t, t + PLAYER_H)).sort((a, b) => a - b);
  }
  const inside = (i: number, j: number): boolean => { const x = pointX(i), z = pointZ(j); return x >= 0 && z >= 0 && x < W && z < L; };
  // Node ids: (lattice index, surface index).
  const offset = new Int32Array(NX * NZ + 1);
  for (let k = 0; k < NX * NZ; k++) offset[k + 1] = offset[k]! + tops[k]!.length;
  const N = offset[NX * NZ]!;
  const heightOf = (node: number): number => { let lo = 0, hi = NX * NZ; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (offset[m]! <= node) lo = m; else hi = m; } return tops[lo]![node - offset[lo]!]!; };
  const neighbours = (i: number, j: number, t: number, maxRise: number, maxDrop: number, visit: (node: number) => void): void => {
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
      const k = ni * NZ + nj;
      tops[k]!.forEach((t2, s) => {
        const rise = t2 - t;
        if (rise > maxRise + EPS || -rise > maxDrop + EPS) return;
        const hi = Math.max(t, t2);
        // The body at the higher height, over both points (a jump's arc: over the origin too).
        if (!free(nearAt(i, j), hi, hi + PLAYER_H) || !free(nearAt(ni, nj), hi, hi + PLAYER_H)) return;
        visit(offset[k]! + s);
      });
    }
  };
  // Reach from the ground ring outside the footprint.
  const reached = new Uint8Array(N);
  const queue: number[] = [];
  for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
    if (inside(i, j)) continue;
    const k = i * NZ + j;
    tops[k]!.forEach((t, s) => { if (t === 0) { reached[offset[k]! + s] = 1; queue.push(offset[k]! + s); } });
  }
  const latticeOf = (node: number): number => { let lo = 0, hi = NX * NZ; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (offset[m]! <= node) lo = m; else hi = m; } return lo; };
  for (let h = 0; h < queue.length; h++) {
    const node = queue[h]!, k = latticeOf(node), i = Math.floor(k / NZ), j = k % NZ;
    neighbours(i, j, heightOf(node), JUMP * 1, Infinity, n => { if (!reached[n]) { reached[n] = 1; queue.push(n); } });
  }
  // Rooms: flat regions inside the footprint.
  const room = new Int32Array(N).fill(-1);
  const sizesOf: number[] = [], reachedRoom: boolean[] = [];
  for (let k = 0; k < NX * NZ; k++) {
    const i = Math.floor(k / NZ), j = k % NZ;
    if (!inside(i, j)) continue;
    for (let s = 0; s < tops[k]!.length; s++) {
      const start = offset[k]! + s;
      if (room[start]! >= 0 || tops[k]![s] === 0) continue;
      const id = sizesOf.length;
      sizesOf.push(0); reachedRoom.push(false);
      const q = [start]; room[start] = id;
      for (let h = 0; h < q.length; h++) {
        const node = q[h]!, kk = latticeOf(node), ii = Math.floor(kk / NZ), jj = kk % NZ;
        sizesOf[id]!++;
        if (reached[node]) reachedRoom[id] = true;
        neighbours(ii, jj, heightOf(node), STEP, STEP, n => { const nk = latticeOf(n); if (room[n]! < 0 && inside(Math.floor(nk / NZ), nk % NZ) && heightOf(n) !== 0) { room[n] = id; q.push(n); } });
      }
    }
  }
  const cellArea = step * step / (f * f);
  let spots = 0;
  for (let k = 0; k < NX * NZ; k++) {
    const i = Math.floor(k / NZ), j = k % NZ;
    if (!inside(i, j)) continue;
    for (let s = 0; s < tops[k]!.length; s++) if (reached[offset[k]! + s]) spots++;
  }
  const minRoom = 1 / cellArea;
  const rooms = sizesOf.filter(n => n >= minRoom).length;
  const roomsReached = sizesOf.filter((n, id) => n >= minRoom && reachedRoom[id]).length;
  return { area: Math.round(spots * cellArea * 10) / 10, rooms, roomsReached, spots };
}

/** Doorway verdicts at one size, turn 0. */
function doorways(model: AddonPreviewModel, sizePct: number): DoorCounts {
  const counts: DoorCounts = { OK: 0, SMALL: 0, FAIL: 0, 'NO-APPROACH': 0, SEALED: 0, STEP: 0 };
  const cfg = model.interactives;
  if (!cfg) return counts;
  const pack = { cells: model.cells, dims: model.dims, interactives: cfg, shippedTreads: (s: number, r: QuarterTurn) => treadBlocksAt(model, s, r) };
  cfg.items.forEach((it, i) => {
    if (it.passSize === undefined || !it.blocking.length) return;
    const open = walkThroughDoorway(pack, i, sizePct, 0, true), closed = walkThroughDoorway(pack, i, sizePct, 0, false);
    const ok100 = sizePct > 100 && walkThroughDoorway(pack, i, 100, 0, true).outcome === 'passed';
    counts[verdictOf(open, closed, ok100) as Verdict]++;
  });
  return counts;
}

const load = async (file: string): Promise<AddonPreviewModel> => { const b = readFileSync(file); return loadAddonPreviewModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); };
interface Row { set: string; size: number; before: Measure & { doors: DoorCounts }; after: Measure & { doors: DoorCounts }; forms: number }
const rows: Row[] = [];
for (const name of readdirSync(afterDir).filter(n => n.endsWith('.mcaddon')).sort()) {
  const set = name.replace(/\.mcaddon$/, '');
  if (only && !only.includes(set)) continue;
  if (!existsSync(join(beforeDir, name))) { console.log(`${set}: no before pack`); continue; }
  const [b, a] = [await load(join(beforeDir, name)), await load(join(afterDir, name))];
  const forms = a.cells.filter(c => c.v).length;
  for (const size of sizes) {
    const row: Row = { set, size, before: { ...measure(b, size), doors: doorways(b, size) }, after: { ...measure(a, size), doors: doorways(a, size) }, forms };
    rows.push(row);
    const d = (m: Row['before']): string => `area ${m.area} rooms ${m.roomsReached}/${m.rooms} doors OK ${m.doors.OK} SEALED ${m.doors.SEALED}${m.doors.FAIL ? ` FAIL ${m.doors.FAIL}` : ''}`;
    console.log(`${set.padEnd(7)} @${String(size).padEnd(3)} forms ${String(forms).padStart(5)} | before ${d(row.before)} | after ${d(row.after)}`);
  }
}
const json = flag('json');
if (json) writeFileSync(json, JSON.stringify(rows, null, 1));
const md = flag('md');
if (md) {
  const lines = ['| set | size | forms | reach before (blocks²) | reach after | rooms reached before | after | doorways OK before | after | SEALED before | after | FAIL after |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.set} | ${r.size} % | ${r.forms} | ${r.before.area} | ${r.after.area} | ${r.before.roomsReached}/${r.before.rooms} | ${r.after.roomsReached}/${r.after.rooms} | ${r.before.doors.OK} | ${r.after.doors.OK} | ${r.before.doors.SEALED} | ${r.after.doors.SEALED} | ${r.after.doors.FAIL} |`);
  writeFileSync(md, lines.join('\n') + '\n');
}
for (const size of sizes) {
  const at = rows.filter(r => r.size === size);
  const sum = (pick: (r: Row) => number): number => Math.round(at.reduce((n, r) => n + pick(r), 0) * 10) / 10;
  console.log(`TOTAL @${size} %: reach ${sum(r => r.before.area)} -> ${sum(r => r.after.area)} blocks², rooms reached ${sum(r => r.before.roomsReached)} -> ${sum(r => r.after.roomsReached)} of ${sum(r => r.before.rooms)} -> ${sum(r => r.after.rooms)}, doorways OK ${sum(r => r.before.doors.OK)} -> ${sum(r => r.after.doors.OK)}, SEALED ${sum(r => r.before.doors.SEALED)} -> ${sum(r => r.after.doors.SEALED)}, FAIL ${sum(r => r.before.doors.FAIL)} -> ${sum(r => r.after.doors.FAIL)}`);
}
