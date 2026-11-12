/**
 * Finding a DROP TOWER or a SKY SWING in a model (BIZ-20): found from the geometry and the library
 * descriptions, never from set numbers, as slides and lifts are (bedrock-rides.ts).
 *
 * WHAT IS ONE. A MAST: a column of support parts (`isLiftGuideDescription`: Support / Pillar / Column)
 * stacked over one footprint, at least `TOWER_MIN_LDU` tall; and a RING of rider seats at one height round it
 * (a seat mould `isSeat`, or a hanging swing seat `isSwingSeat`), `MIN_SEATS`-`MAX_SEATS` of them at the same
 * distance from the mast axis. Hanging swing seats make a swing; any other seat makes a drop tower.
 *
 * THE CAR is the ring: the seats and every part that touches them or each other (growing outward, never into
 * the mast, never further than `CAR_REACH_LDU` past the farthest seat from the axis). It leaves the shell and
 * moves as one entity (a lift car's mechanism, playable-addon.ts); a part wider than the ring that the car
 * touches (the base the ring stands on) is left in the shell by that radius bound.
 *
 * THE PATH of every seat (`FunfairSeatPath`, LDraw points): its pan at the foot, its pan at the top (the car
 * rises until its highest part is `TOP_CLEAR_LDU` under the mast top), and the mast AXIS at the top height. The
 * runtime needs nothing else: the group is the seats that share an axis, the ring radius and azimuth are read
 * off the path, and the placement turns and sizes all three points like any ride path (`PlacementActor.ridePath`).
 * `exitLdu` is where the rider steps off, outside the ring at its foot.
 *
 * TODO(swing-chairs): a swing's chairs are part of the rigid car; the riders swing outward on their invisible
 * seats, so a drawn chair stays with the ring while its rider hangs out past it. Per-chair entities need a roll
 * (an entity cannot roll; a pitch animation about the tangent could) and the chain parts; left for the polished version.
 */

import type { ParsedBrick } from '../ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from '../ldraw-part-geometry.js';
import { isSeat } from '../ldraw-entity-compiler.js';
import { isSwingSeat, seatPanLocalY } from '../bedrock-scene-actors.js';
import { isLiftGuideDescription } from '../bedrock-rides.js';

/** Every tuned number of the detection, with its unit. */
export const FUNFAIR_DETECT = {
  /** A mast is at least this tall, LDU (about 22 blocks at the model's scale: a shorter column is a pillar). */
  TOWER_MIN_LDU: 1200,
  /** Mast parts of one column stand within this of each other's centre, LDU. */
  MAST_CENTRE_TOL_LDU: 20,
  /** Mast parts are stacked within this vertical gap of each other, LDU (a plate). */
  MAST_GAP_LDU: 16,
  /** A ring seat is at least this far from the axis, LDU (a seat on the mast itself is not on a ring). */
  RING_MIN_LDU: 40,
  /** A ring seat is at most this far from the axis, LDU. */
  RING_MAX_LDU: 800,
  /** Seats of one ring stand at this fraction of the mean radius of each other. */
  RING_RADIUS_TOL: 0.15,
  /** Seats of one ring are at one height, within this, LDU. */
  RING_LEVEL_TOL_LDU: 12,
  /** A ring has at least this many seats (a single seat has no axis to turn about: it is a chair). */
  MIN_SEATS: 2,
  /** A ring has at most this many seats. */
  MAX_SEATS: 24,
  /** Parts closer than this touch, LDU. */
  TOUCH_LDU: 2,
  /** The car reaches this far past the farthest seat from the axis, LDU. */
  CAR_REACH_LDU: 100,
  /** A car has at most this many parts. */
  CAR_MAX_PARTS: 160,
  /** The car stops this far under the mast top, LDU (a brick). */
  TOP_CLEAR_LDU: 24,
  /** A ride rises at least this far, LDU, or it is a ring on a short stub. */
  MIN_RISE_LDU: 600,
  /** The riders step off this far outside the ring's seats, LDU. */
  EXIT_OUT_LDU: 100,
} as const;

export type FunfairKind = 'drop' | 'swing';

/** One seat: its path (foot, top, axis at the top) and where its rider steps off, LDraw points. */
export interface FunfairSeatPath { pathLdu: Vec3[]; exitLdu: Vec3 }

export interface SceneFunfairRide {
  kind: FunfairKind;
  /** Short name for the seat name. */
  label: string;
  /** The mast's first part. */
  part: string;
  seats: FunfairSeatPath[];
  /** The ring: the seats and what carries them. */
  carBricks: ParsedBrick[];
}

interface Box { min: Vec3; max: Vec3 }
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const toWorld = (b: ParsedBrick, v: Vec3): Vec3 => {
  const m = b.rot ?? IDENTITY;
  return [b.x + m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], b.y + m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], b.z + m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
};
const worldBox = (b: ParsedBrick, mesh: LdrawPartMesh): Box => {
  const { min: lo, max: hi } = mesh.bounds;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    const w = toWorld(b, [x, y, z]);
    for (let i = 0; i < 3; i++) { if (w[i]! < min[i]!) min[i] = w[i]!; if (w[i]! > max[i]!) max[i] = w[i]!; }
  }
  return { min, max };
};
const stripped = (d: string): string => d.replace(/^[~=_]+\s*/, '');

/**
 * Every drop tower and sky swing in the placements. `exclude` are placements already taken (figures,
 * vehicles, other rides' cars).
 */
export function findFunfairRides(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, exclude: ReadonlySet<ParsedBrick> = new Set()): SceneFunfairRide[] {
  const D = FUNFAIR_DETECT;
  const boxes = new Map<ParsedBrick, Box>();
  for (const b of bricks) { const m = meshes.get(b.part); if (m && m.triangles.length && !exclude.has(b)) boxes.set(b, worldBox(b, m)); }
  const desc = (b: ParsedBrick): string => stripped(meshes.get(b.part)?.description ?? '');
  const centre = (box: Box): [number, number] => [(box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2];

  // Masts: support parts in one column (centres within a tolerance), chained vertically.
  const supports = bricks.filter(b => boxes.has(b) && isLiftGuideDescription(desc(b)));
  const columns: ParsedBrick[][] = [];
  for (const s of supports) {
    const [cx, cz] = centre(boxes.get(s)!);
    const col = columns.find(c => { const [x, z] = centre(boxes.get(c[0]!)!); return Math.hypot(x - cx, z - cz) <= D.MAST_CENTRE_TOL_LDU; });
    if (col) col.push(s); else columns.push([s]);
  }
  const out: SceneFunfairRide[] = [];
  const taken = new Set<ParsedBrick>();
  for (const col of columns) {
    // The tallest vertically-chained run of the column.
    const sorted = [...col].sort((a, b) => boxes.get(a)!.min[1] - boxes.get(b)!.min[1]);
    let best: ParsedBrick[] = [], run: ParsedBrick[] = [];
    for (const p of sorted) {
      const last = run[run.length - 1];
      if (last && boxes.get(p)!.min[1] - boxes.get(last)!.max[1] > D.MAST_GAP_LDU) run = [];
      run.push(p);
      const span = (r: ParsedBrick[]): number => boxes.get(r[r.length - 1]!)!.max[1] - boxes.get(r[0]!)!.min[1];
      if (span(run) > (best.length ? span(best) : 0)) best = [...run];
    }
    if (!best.length) continue;
    const mastTop = Math.min(...best.map(p => boxes.get(p)!.min[1])), mastFoot = Math.max(...best.map(p => boxes.get(p)!.max[1]));
    if (mastFoot - mastTop < D.TOWER_MIN_LDU) continue;
    const mastSet = new Set(best);
    const axis: [number, number] = [best.reduce((s, p) => s + centre(boxes.get(p)!)[0], 0) / best.length, best.reduce((s, p) => s + centre(boxes.get(p)!)[1], 0) / best.length];

    // The ring: seats round the axis, at one height and one radius.
    const seatCandidates = bricks.filter(b => {
      if (!boxes.has(b) || taken.has(b) || mastSet.has(b)) return false;
      const d = desc(b);
      if (!isSeat(b.part, d) && !isSwingSeat(d)) return false;
      const [cx, cz] = centre(boxes.get(b)!), r = Math.hypot(cx - axis[0], cz - axis[1]), box = boxes.get(b)!;
      return r >= D.RING_MIN_LDU && r <= D.RING_MAX_LDU && box.min[1] >= mastTop && box.max[1] <= mastFoot + D.RING_MAX_LDU;
    });
    const levels: ParsedBrick[][] = [];
    for (const s of seatCandidates) {
      const lv = levels.find(l => Math.abs(boxes.get(l[0]!)!.max[1] - boxes.get(s)!.max[1]) <= D.RING_LEVEL_TOL_LDU);
      if (lv) lv.push(s); else levels.push([s]);
    }
    const ring = levels.sort((a, b) => b.length - a.length)[0];
    if (!ring || ring.length < D.MIN_SEATS || ring.length > D.MAX_SEATS) continue;
    const radii = ring.map(s => { const [cx, cz] = centre(boxes.get(s)!); return Math.hypot(cx - axis[0], cz - axis[1]); });
    const meanR = radii.reduce((s, r) => s + r, 0) / radii.length;
    if (radii.some(r => Math.abs(r - meanR) > D.RING_RADIUS_TOL * meanR)) continue;
    const swing = ring.every(s => isSwingSeat(desc(s)));

    // The car: the seats and everything touching them or each other within the ring's reach.
    const reach = Math.max(...radii) + D.CAR_REACH_LDU, t = D.TOUCH_LDU;
    const car = [...ring], inCar = new Set(car);
    const touches = (a: Box, b: Box): boolean => [0, 1, 2].every(k => Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!) >= -t);
    for (let grew = true; grew && car.length < D.CAR_MAX_PARTS;) {
      grew = false;
      for (const o of bricks) {
        const ob = boxes.get(o);
        if (!ob || inCar.has(o) || mastSet.has(o) || taken.has(o)) continue;
        const [cx, cz] = centre(ob);
        if (Math.hypot(cx - axis[0], cz - axis[1]) > reach) continue;
        if (!car.some(c => touches(ob, boxes.get(c)!))) continue;
        car.push(o); inCar.add(o); grew = true;
      }
    }
    const carTop = Math.min(...car.map(c => boxes.get(c)!.min[1])), carFoot = Math.max(...car.map(c => boxes.get(c)!.max[1]));
    const shift = carTop - (mastTop + D.TOP_CLEAR_LDU);
    if (shift < D.MIN_RISE_LDU) continue;

    const seats: FunfairSeatPath[] = ring.map(s => {
      const m = meshes.get(s.part)!;
      // A seat mould's pan is one plate over its origin (4079); a hanging swing's is the face over its underside.
      const pan = isSeat(s.part, desc(s)) ? toWorld(s, [0, -8, 0]) : toWorld(s, [(m.bounds.min[0] + m.bounds.max[0]) / 2, seatPanLocalY(m, isSwingSeat(desc(s))), (m.bounds.min[2] + m.bounds.max[2]) / 2]);
      const top: Vec3 = [pan[0], pan[1] - shift, pan[2]];
      const dx = pan[0] - axis[0], dz = pan[2] - axis[1], r = Math.hypot(dx, dz) || 1;
      const exit: Vec3 = [axis[0] + dx / r * (r + D.EXIT_OUT_LDU), carFoot, axis[1] + dz / r * (r + D.EXIT_OUT_LDU)];
      return { pathLdu: [pan, top, [axis[0], top[1], axis[1]]], exitLdu: exit };
    });
    for (const c of car) taken.add(c);
    out.push({ kind: swing ? 'swing' : 'drop', label: swing ? 'Sky swing' : 'Drop tower', part: best[0]!.part.replace(/\.dat$/i, ''), seats, carBricks: car });
  }
  return out;
}
