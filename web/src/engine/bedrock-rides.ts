/**
 * Rides a set's own play features give: a PLAYGROUND SLIDE the player slides
 * down, and a LIFT whose car carries the player between the floors of a
 * dollhouse. Both are found from the geometry and the library descriptions,
 * never from set numbers (first met on Gabby's Dollhouse, 2026-09-26: every one
 * of the five sets has a slide; 10788 has a lift).
 *
 * ONE RUNTIME FOR BOTH (`ridesRuntime`, serialised into `scripts/rides.js`): an
 * invisible rideable seat stands where the ride starts; when a player sits, the
 * runtime carries the seat (and the player with it, as the coaster carries its
 * riders: `tryTeleport` of the ridden entity) along a polyline written on the
 * seat at placement time in WORLD coordinates (`bedrock-placement-pack.ts`
 * turns the model-frame path with the placement's own turn and size), then sets
 * the player down at the end:
 *   - a slide: from the chute's top to its foot, speeding up from `SLIDE_V0`
 *     by `SLIDE_ACCEL` to `SLIDE_VMAX`, off the end with a little way to go;
 *     the seat then returns to the top;
 *   - a lift: from the car's stop to the next floor (up to the top, then back
 *     down) at `LIFT_SPEED`, with the car's own entity (its exact bricks) moved
 *     alongside; the player steps off onto that floor beside the shaft.
 * Speeds are blocks per second at 100 % and scale with the wand size, so a ride
 * takes the same time at every size.
 *
 * WHAT IS A SLIDE. A part whose description starts `Slide ` (the playground
 * moulds 28387, 11267, 27976, ...). Its chute is read from the part's TOP
 * surface: the highest face over each 4-LDU cell of its footprint, banded by
 * height; each band's centroid is a point of the running line, which descends
 * monotonically from the top of the chute to its foot, so the bands order it.
 *
 * WHAT IS A LIFT. A shaft of tall slim upright GUIDES (`Support 2 x 2 x 13`,
 * pillars, poles, beams at least `LIFT_MIN_GUIDE_LDU` tall) with a CAR: a
 * cluster of parts standing on or among at least two guides, inside and
 * covering their footprint (plus what stands on it over the shaft). Contact
 * with the building does not disqualify it: a car touches the structure at the
 * stop it stands at. Its stops are the floors that meet
 * the shaft's sides (plates and tiles within `LIFT_FLOOR_REACH_LDU`, at least
 * two at a level), and the car's own level.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';

/** Every tuned number of the rides, with its unit. */
export const RIDE = {
  /** A slide must fall at least this far top to foot, LDU (a shorter "slide" is a ramp or a decoration). */
  SLIDE_MIN_DROP_LDU: 24,
  /** Cell of the top-surface map a chute is read from, LDU. */
  SLIDE_CELL_LDU: 4,
  /** Height of one band of the chute, LDU; a slide is cut into 4-16 bands. */
  SLIDE_BAND_LDU: 12,
  /** Past the chute's foot the rider is set down this far along its last direction, LDU. */
  SLIDE_RUNOUT_LDU: 24,
  /** Speed the rider leaves the top at, blocks/s at 100 %. */
  SLIDE_V0: 2,
  /** Speed gained per second down the chute, blocks/s². */
  SLIDE_ACCEL: 6,
  /** Fastest a rider slides, blocks/s. */
  SLIDE_VMAX: 8,
  /** Ticks the seat waits at the foot before it returns to the top. */
  SLIDE_RETURN_TICKS: 10,
  /** A guide stands at least this tall, LDU (8 bricks: a storey). */
  LIFT_MIN_GUIDE_LDU: 192,
  /** A guide's footprint is no wider than this, LDU (a 2 x 2 support is 40). */
  LIFT_MAX_GUIDE_WIDTH_LDU: 48,
  /** Guides this close (centre to centre, LDU) belong to one shaft: a car up to six studs across between its rails. */
  LIFT_GUIDE_GROUP_LDU: 120,
  /** The shaft reaches this far beyond its guides' footprint, LDU. */
  LIFT_SHAFT_MARGIN_LDU: 24,
  /** A car may stand this far above the guides' top, LDU (it rides ON them). */
  LIFT_CAR_ABOVE_LDU: 240,
  /** A car has at least / at most this many parts. */
  LIFT_CAR_MIN_PARTS: 3,
  LIFT_CAR_MAX_PARTS: 80,
  /** A shaft has at least this many guides (a single post is a lamp or a pillar). */
  LIFT_MIN_GUIDES: 2,
  /** A car covers at least this share of its guides' footprint (a car, not a bracket on one post). */
  LIFT_CAR_MIN_COVER: 0.6,
  /** A floor meets the shaft when a plate or tile lies within this of its side, LDU. */
  LIFT_FLOOR_REACH_LDU: 40,
  /** Storeys are at least this far apart, LDU (3 bricks). */
  LIFT_MIN_STOREY_LDU: 72,
  /** A lift serves at most this many storeys (more is a tower's frame, not a dollhouse). */
  LIFT_MAX_STOPS: 6,
  /** A storey has at least this many floor parts at the shaft's sides. */
  LIFT_MIN_FLOOR_PARTS: 3,
  /** Floor parts at one level: heights within this, LDU. */
  LIFT_LEVEL_TOL_LDU: 4,
  /** A rider steps off this far past the shaft's edge, LDU (past a 20-LDU side wall into the room). */
  LIFT_EXIT_STEP_LDU: 50,
  /** Speed of the car, blocks/s at 100 %. */
  LIFT_SPEED: 1.5,
  /** Parts closer than this touch, LDU. */
  TOUCH_LDU: 2,
} as const;

export type RideKind = 'slide' | 'lift';

export interface SceneRide {
  kind: RideKind;
  /** Short name for the seat's name tag. */
  label: string;
  /** The part the ride was read from (the slide mould, or the lift's first guide). */
  part: string;
  /**
   * LDraw points. A slide: its running line, top to foot, then the run-out.
   * A lift: the car's floor centre at each stop, lowest first (the car keeps
   * the height over each storey the source stands it at).
   */
  pathLdu: Vec3[];
  /** A lift: where a rider steps off at each stop (on the floor beside the shaft), LDraw; parallel to `pathLdu`. */
  exitsLdu?: Vec3[];
  /** A lift: the stop the car stands at in the source. */
  startStop?: number;
  /** A lift: the car's placements (its own moving entity, out of the shell). */
  carBricks?: ParsedBrick[];
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const toWorld = (b: ParsedBrick, v: Vec3): Vec3 => {
  const m = b.rot ?? IDENTITY;
  return [b.x + m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], b.y + m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], b.z + m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
};
const stripped = (d: string): string => d.replace(/^[~=_]+\s*/, '');

/** A playground slide mould by its library description. */
export function isSlideDescription(description: string): boolean {
  return /^Slide\s/i.test(stripped(description));
}

/**
 * A slim upright part a lift car can run on: a solid support column or pillar.
 * Frame members are NOT guides - Technic beams (10303's coaster frame), girder
 * and lattice supports (10341's launch tower) read as "lifts" in the
 * favourites sweep (2026-09-26) and are excluded.
 */
export function isLiftGuideDescription(description: string): boolean {
  const d = stripped(description);
  return /^(Support|Pillar|Column)\b/i.test(d) && !/\b(Girder|Lattice|Truss|Crane|Triangular)\b/i.test(d);
}

interface Box { min: Vec3; max: Vec3 }

function worldBox(b: ParsedBrick, mesh: LdrawPartMesh): Box {
  const { min: lo, max: hi } = mesh.bounds;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    const w = toWorld(b, [x, y, z]);
    for (let i = 0; i < 3; i++) { if (w[i]! < min[i]!) min[i] = w[i]!; if (w[i]! > max[i]!) max[i] = w[i]!; }
  }
  return { min, max };
}

/** One box stands on or hangs from the other: their footprints overlap (not just an edge) and they meet vertically. */
const stacked = (a: Box, b: Box): boolean => {
  const inset = 1;
  const xz = a.min[0] + inset < b.max[0] && b.min[0] + inset < a.max[0] && a.min[2] + inset < b.max[2] && b.min[2] + inset < a.max[2];
  return xz && (Math.abs(a.max[1] - b.min[1]) <= RIDE.TOUCH_LDU || Math.abs(b.max[1] - a.min[1]) <= RIDE.TOUCH_LDU || (a.min[1] < b.max[1] && b.min[1] < a.max[1]));
};
const touches = (a: Box, b: Box, tol: number): boolean =>
  a.min[0] <= b.max[0] + tol && b.min[0] <= a.max[0] + tol && a.min[1] <= b.max[1] + tol && b.min[1] <= a.max[1] + tol && a.min[2] <= b.max[2] + tol && b.min[2] <= a.max[2] + tol;

/**
 * A slide's running line in LDraw, top to foot, plus the run-out; null when the
 * part does not fall `SLIDE_MIN_DROP_LDU` (or has no geometry).
 */
export function slidePathLdu(b: ParsedBrick, mesh: LdrawPartMesh): Vec3[] | null {
  if (!mesh.triangles.length) return null;
  const cell = RIDE.SLIDE_CELL_LDU;
  const tris = mesh.triangles.map(t => [toWorld(b, t.a), toWorld(b, t.b), toWorld(b, t.c)] as const);
  const box = worldBox(b, mesh);
  const nx = Math.max(1, Math.ceil((box.max[0] - box.min[0]) / cell)), nz = Math.max(1, Math.ceil((box.max[2] - box.min[2]) / cell));
  // Top surface: the smallest LDraw y (highest) any face reaches over each cell's centre.
  const top = new Float64Array(nx * nz).fill(Infinity);
  for (const [a, p, c] of tris) {
    const x1 = p[0] - a[0], z1 = p[2] - a[2], x2 = c[0] - a[0], z2 = c[2] - a[2];
    const det = x1 * z2 - x2 * z1;
    if (Math.abs(det) < 1e-9) continue; // a vertical face meets no vertical line
    const i0 = Math.max(0, Math.floor((Math.min(a[0], p[0], c[0]) - box.min[0]) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(a[0], p[0], c[0]) - box.min[0]) / cell));
    const k0 = Math.max(0, Math.floor((Math.min(a[2], p[2], c[2]) - box.min[2]) / cell)), k1 = Math.min(nz - 1, Math.floor((Math.max(a[2], p[2], c[2]) - box.min[2]) / cell));
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
      const cx = box.min[0] + (i + 0.5) * cell, cz = box.min[2] + (k + 0.5) * cell;
      const px = cx - a[0], pz = cz - a[2];
      const u = (px * z2 - x2 * pz) / det, v = (x1 * pz - px * z1) / det;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const y = a[1] + u * (p[1] - a[1]) + v * (c[1] - a[1]);
      const j = i * nz + k;
      if (y < top[j]!) top[j] = y;
    }
  }
  let hi = Infinity, lo = -Infinity;
  for (const y of top) if (Number.isFinite(y)) { if (y < hi) hi = y; if (y > lo) lo = y; }
  if (!Number.isFinite(hi) || lo - hi < RIDE.SLIDE_MIN_DROP_LDU) return null;
  const bands = Math.max(4, Math.min(16, Math.round((lo - hi) / RIDE.SLIDE_BAND_LDU)));
  const sums = Array.from({ length: bands }, () => ({ x: 0, y: 0, z: 0, n: 0 }));
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const y = top[i * nz + k]!;
    if (!Number.isFinite(y)) continue;
    const band = Math.min(bands - 1, Math.floor((y - hi) / (lo - hi) * bands));
    const s = sums[band]!;
    s.x += box.min[0] + (i + 0.5) * cell; s.y += y; s.z += box.min[2] + (k + 0.5) * cell; s.n++;
  }
  const path: Vec3[] = sums.filter(s => s.n > 0).map(s => [s.x / s.n, s.y / s.n, s.z / s.n]);
  if (path.length < 2) return null;
  // The run-out: past the foot along the last horizontal direction.
  const a = path[path.length - 2]!, z = path[path.length - 1]!;
  const dx = z[0] - a[0], dz = z[2] - a[2], h = Math.hypot(dx, dz);
  if (h > 1e-6) path.push([z[0] + dx / h * RIDE.SLIDE_RUNOUT_LDU, z[1], z[2] + dz / h * RIDE.SLIDE_RUNOUT_LDU]);
  return path;
}

/** Every slide in the placements, with its running line. */
export function findSlides(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>): SceneRide[] {
  const out: SceneRide[] = [];
  for (const b of bricks) {
    const m = meshes.get(b.part);
    if (!m || !isSlideDescription(m.description)) continue;
    const pathLdu = slidePathLdu(b, m);
    if (pathLdu) out.push({ kind: 'slide', label: 'Slide', part: b.part.replace(/\.dat$/i, ''), pathLdu });
  }
  return out;
}

/**
 * Every lift: a shaft of guides with a car inside it and at least two floors
 * meeting it. `exclude` are placements already taken (figures, vehicles).
 */
export function findLifts(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, exclude: ReadonlySet<ParsedBrick> = new Set(), trace?: (message: string) => void): SceneRide[] {
  const boxes = new Map<ParsedBrick, Box>();
  for (const b of bricks) { const m = meshes.get(b.part); if (m && m.triangles.length) boxes.set(b, worldBox(b, m)); }
  const guides = bricks.filter(b => {
    const m = meshes.get(b.part), box = boxes.get(b);
    if (!m || !box || exclude.has(b) || !isLiftGuideDescription(m.description)) return false;
    const h = box.max[1] - box.min[1];
    return h >= RIDE.LIFT_MIN_GUIDE_LDU && Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]) <= RIDE.LIFT_MAX_GUIDE_WIDTH_LDU;
  });
  // Group guides into shafts.
  const shafts: ParsedBrick[][] = [];
  for (const g of guides) {
    const gb = boxes.get(g)!, c: [number, number] = [(gb.min[0] + gb.max[0]) / 2, (gb.min[2] + gb.max[2]) / 2];
    const home = shafts.find(s => s.some(o => { const ob = boxes.get(o)!; return Math.hypot((ob.min[0] + ob.max[0]) / 2 - c[0], (ob.min[2] + ob.max[2]) / 2 - c[1]) <= RIDE.LIFT_GUIDE_GROUP_LDU; }));
    if (home) home.push(g); else shafts.push([g]);
  }
  const out: SceneRide[] = [];
  const isFloorPart = (b: ParsedBrick): boolean => /^(Plate|Tile)\b/i.test(stripped(meshes.get(b.part)?.description ?? ''));
  for (const shaft of shafts) {
    const gbs = shaft.map(g => boxes.get(g)!);
    const inner: Box = { min: [Math.min(...gbs.map(b => b.min[0])), Math.min(...gbs.map(b => b.min[1])), Math.min(...gbs.map(b => b.min[2]))], max: [Math.max(...gbs.map(b => b.max[0])), Math.max(...gbs.map(b => b.max[1])), Math.max(...gbs.map(b => b.max[2]))] };
    // The car runs in the guides' own footprint (10788's car spans exactly its
    // three supports); the shaft's walls stand beside it and are not the car.
    const t = RIDE.TOUCH_LDU;
    const shaftBox: Box = { min: [inner.min[0] - t, inner.min[1] - RIDE.LIFT_CAR_ABOVE_LDU, inner.min[2] - t], max: [inner.max[0] + t, inner.max[1], inner.max[2] + t] };
    const guideSet = new Set(shaft);
    // Candidates: wholly inside the shaft box, not a guide, not taken.
    const inside = bricks.filter(b => {
      const box = boxes.get(b);
      if (!box || guideSet.has(b) || exclude.has(b)) return false;
      return box.min[0] >= shaftBox.min[0] && box.max[0] <= shaftBox.max[0] && box.min[1] >= shaftBox.min[1] && box.max[1] <= shaftBox.max[1] && box.min[2] >= shaftBox.min[2] && box.max[2] <= shaftBox.max[2];
    });
    const insideSet = new Set(inside);
    const outside = bricks.filter(b => boxes.has(b) && !insideSet.has(b) && !guideSet.has(b));
    // Clusters of the candidates by touch.
    const parent = inside.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!; return i; };
    for (let i = 0; i < inside.length; i++) for (let j = i + 1; j < inside.length; j++)
      if (touches(boxes.get(inside[i]!)!, boxes.get(inside[j]!)!, RIDE.TOUCH_LDU)) parent[find(i)] = find(j);
    const groups = new Map<number, ParsedBrick[]>();
    inside.forEach((b, i) => { const r = find(i); const l = groups.get(r); if (l) l.push(b); else groups.set(r, [b]); });
    // The car: the largest cluster resting on or among the guides that nothing
    // outside the shaft stands on or hangs from (`stacked`); a wall beside it
    // (touching a side face) does not hold it - it slides past.
    // A part that reaches out of the footprint but rests only on the car (10788's
    // roof plate) is the car's; a pin in a guide's hole is the stop it rests on.
    const isPin = (b: ParsedBrick): boolean => /^Technic\s+(Pin|Axle Pin)\b/i.test(stripped(meshes.get(b.part)?.description ?? ''));
    const stackedOn = (o: ParsedBrick, among: readonly ParsedBrick[]): boolean => among.some(b => stacked(boxes.get(b)!, boxes.get(o)!));
    // Transitively: what stands on the car (and on that), while it stays over
    // the shaft (its box within `LIFT_SHAFT_MARGIN_LDU` of the guides); a part
    // reaching further is the building (a floor, a wall) and holds the car.
    const overShaft = (o: ParsedBrick): boolean => {
      const b = boxes.get(o)!, m = RIDE.LIFT_SHAFT_MARGIN_LDU;
      return b.min[0] >= inner.min[0] - m && b.max[0] <= inner.max[0] + m && b.min[2] >= inner.min[2] - m && b.max[2] <= inner.max[2] + m;
    };
    const absorb = (g: ParsedBrick[]): ParsedBrick[] => {
      const car = [...g], taken = new Set(g);
      for (let grew = true; grew;) {
        grew = false;
        for (const o of outside) {
          if (taken.has(o) || isPin(o) || !overShaft(o) || !stackedOn(o, car)) continue;
          car.push(o); taken.add(o); grew = true;
        }
      }
      return car;
    };
    // A car touches the structure at the stop it stands at (10788's rests on
    // the pins in its supports and meets the shaft's ceiling), so contact does
    // not disqualify one; what does is being a column rather than a car: a lift
    // shaft has at least `LIFT_MIN_GUIDES` guides and its car covers
    // `LIFT_CAR_MIN_COVER` of their footprint.
    const innerArea = Math.max(1, (inner.max[0] - inner.min[0]) * (inner.max[2] - inner.min[2]));
    const covers = (g: ParsedBrick[]): boolean => {
      const gb = g.map(b => boxes.get(b)!);
      const w = Math.min(inner.max[0], Math.max(...gb.map(b => b.max[0]))) - Math.max(inner.min[0], Math.min(...gb.map(b => b.min[0])));
      const d = Math.min(inner.max[2], Math.max(...gb.map(b => b.max[2]))) - Math.max(inner.min[2], Math.min(...gb.map(b => b.min[2])));
      return w > 0 && d > 0 && w * d >= RIDE.LIFT_CAR_MIN_COVER * innerArea;
    };
    const cars = shaft.length < RIDE.LIFT_MIN_GUIDES ? [] : [...groups.values()]
      .filter(g => g.length >= RIDE.LIFT_CAR_MIN_PARTS)
      .filter(g => g.some(b => shaft.some(s => touches(boxes.get(b)!, boxes.get(s)!, RIDE.TOUCH_LDU))))
      .map(absorb)
      .filter(g => g.length <= RIDE.LIFT_CAR_MAX_PARTS && covers(g))
      .sort((a, b) => b.length - a.length);
    trace?.(`shaft of ${shaft.length} guide(s) ${JSON.stringify(inner)}: ${inside.length} parts inside, clusters ${[...groups.values()].map(g => g.length).join(',')}, free cars ${cars.map(g => g.length).join(',')}`);
    if (trace) for (const g of groups.values()) {
      if (g.length < RIDE.LIFT_CAR_MIN_PARTS) continue;
      const tied = outside.filter(o => g.some(b => stacked(boxes.get(b)!, boxes.get(o)!)));
      trace(`  cluster ${g.map(b => `${b.part}@${b.y}`).join(' ')} | stacked with outside: ${tied.map(o => `${o.part}@${o.x},${o.y},${o.z}`).join(' ')}`);
    }
    const car = cars[0];
    if (!car) continue;
    const cb = car.map(b => boxes.get(b)!);
    const carBox: Box = { min: [Math.min(...cb.map(b => b.min[0])), Math.min(...cb.map(b => b.min[1])), Math.min(...cb.map(b => b.min[2]))], max: [Math.max(...cb.map(b => b.max[0])), Math.max(...cb.map(b => b.max[1])), Math.max(...cb.map(b => b.max[2]))] };
    // Floors meeting the shaft's sides: plate/tile tops within reach, outside the shaft, at least two per level.
    const reach = RIDE.LIFT_FLOOR_REACH_LDU;
    const tops: Array<{ y: number; x: number; z: number }> = [];
    for (const b of outside) {
      if (!isFloorPart(b)) continue;
      const box = boxes.get(b)!;
      const dx = Math.max(shaftBox.min[0] - box.max[0], box.min[0] - shaftBox.max[0], 0), dz = Math.max(shaftBox.min[2] - box.max[2], box.min[2] - shaftBox.max[2], 0);
      if (Math.hypot(dx, dz) > reach) continue;
      // The ground storey may lie below the guides' foot (10788's supports start a storey up).
      if (box.min[1] < shaftBox.min[1] - reach || box.min[1] > inner.max[1] + RIDE.LIFT_MIN_STOREY_LDU * 2) continue;
      tops.push({ y: box.min[1], x: (box.min[0] + box.max[0]) / 2, z: (box.min[2] + box.max[2]) / 2 });
    }
    tops.sort((a, b) => b.y - a.y); // lowest (largest LDraw y) first
    const levels: Array<{ y: number; exit: Vec3; n: number }> = [];
    for (const t of tops) {
      const lv = levels.find(l => Math.abs(l.y - t.y) <= RIDE.LIFT_LEVEL_TOL_LDU);
      if (lv) { lv.n++; continue; }
      // Step off through the side this floor meets, `LIFT_EXIT_STEP_LDU` past the shaft's edge (into the room, not onto its wall).
      const ox = t.x - (inner.min[0] + inner.max[0]) / 2, oz = t.z - (inner.min[2] + inner.max[2]) / 2;
      const exit: Vec3 = Math.abs(ox) >= Math.abs(oz)
        ? [ox > 0 ? shaftBox.max[0] + RIDE.LIFT_EXIT_STEP_LDU : shaftBox.min[0] - RIDE.LIFT_EXIT_STEP_LDU, t.y, (inner.min[2] + inner.max[2]) / 2]
        : [(inner.min[0] + inner.max[0]) / 2, t.y, oz > 0 ? shaftBox.max[2] + RIDE.LIFT_EXIT_STEP_LDU : shaftBox.min[2] - RIDE.LIFT_EXIT_STEP_LDU];
      levels.push({ y: t.y, exit, n: 1 });
    }
    // A storey is the best-populated level in each `LIFT_MIN_STOREY_LDU` window
    // (a floor's tiles, not the shelf plates between floors), with at least
    // `LIFT_MIN_FLOOR_PARTS` parts at the shaft's sides.
    const floors: typeof levels = [];
    for (const l of [...levels].sort((a, b) => b.n - a.n)) {
      if (l.n < RIDE.LIFT_MIN_FLOOR_PARTS || floors.some(f => Math.abs(f.y - l.y) < RIDE.LIFT_MIN_STOREY_LDU)) continue;
      floors.push(l);
    }
    const cx = (carBox.min[0] + carBox.max[0]) / 2, cz = (carBox.min[2] + carBox.max[2]) / 2;
    const carFloor = carBox.max[1];
    const stops = floors.map(f => ({ y: f.y, exit: f.exit }));
    stops.sort((a, b) => b.y - a.y);
    if (stops.length > RIDE.LIFT_MAX_STOPS) { trace?.(`${stops.length} stops: a tower, not a dollhouse lift`); continue; }
    trace?.(`car ${car.length} parts, floor ${carFloor}; levels ${levels.map(l => `${l.y}x${l.n}`).join(' ')}; stops ${stops.map(s => s.y).join(' ')}`);
    if (stops.length < 2) continue;
    // The car starts at the storey nearest where the source stands it; it keeps
    // its own height over that floor at every stop (the runtime moves it by the
    // storey's rise).
    let start = 0;
    stops.forEach((s, i) => { if (Math.abs(s.y - carFloor) < Math.abs(stops[start]!.y - carFloor)) start = i; });
    out.push({
      kind: 'lift', label: 'Lift', part: shaft[0]!.part.replace(/\.dat$/i, ''),
      // The seat stands on the car's own floor, which keeps its height over each storey.
      pathLdu: stops.map(s => [cx, s.y + (carFloor - stops[start]!.y), cz] as Vec3),
      exitsLdu: stops.map(s => s.exit),
      startStop: start < 0 ? 0 : start,
      carBricks: car,
    });
  }
  return out;
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface RideRuntimeConfig {
  /** The invisible rideable seat type every ride shares. */
  seatType: string;
  /** Per ride (the placement writes the index on its seat and car): kind and the car's type for a lift. */
  rides: Array<{ kind: RideKind; carType?: string; startStop?: number }>;
  constants: typeof RIDE;
}

declare const world: any;
declare const system: any;

/**
 * The rides' runtime. Serialised whole into `scripts/rides.js` (`ridesScript`),
 * so it may use only its arguments and the Script API globals.
 */
function ridesRuntime(config: RideRuntimeConfig): void {
  const R = config.constants;
  const K = { index: 'craftmatic:ride', path: 'craftmatic:ride_path', exits: 'craftmatic:ride_exits', scale: 'craftmatic:ride_scale', stop: 'craftmatic:ride_stop', dir: 'craftmatic:ride_dir' };
  type P = { x: number; y: number; z: number };
  interface Run { seat: any; rider: any; kind: string; path: P[]; lens: number[]; s: number; end: number; v: number; f: number; car?: any; carOffset?: P; target?: number; exit?: P; done?: number; home?: P }
  const running = new Map<string, Run>();
  const read = (e: any, key: string): any => { try { return e.getDynamicProperty(key); } catch { return undefined; } };
  const parse = (s: any): P[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
  const lengths = (path: P[]): number[] => { const out = [0]; for (let i = 1; i < path.length; i++) out.push(out[i - 1]! + Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y, path[i]!.z - path[i - 1]!.z)); return out; };
  const at = (path: P[], lens: number[], s: number): { p: P; yaw: number } => {
    let i = 1;
    while (i < path.length - 1 && lens[i]! < s) i++;
    const a = path[i - 1]!, b = path[i]!, seg = Math.max(1e-6, lens[i]! - lens[i - 1]!);
    const t = Math.max(0, Math.min(1, (s - lens[i - 1]!) / seg));
    const yaw = Math.hypot(b.x - a.x, b.z - a.z) > 1e-6 ? Math.atan2(-(b.x - a.x), b.z - a.z) * 180 / Math.PI : 0;
    return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, yaw };
  };
  const say = (p: any, s: string): void => { try { p.onScreenDisplay.setActionBar(s); } catch { /* left */ } };
  const findCar = (seat: any, index: number, carType: string): any => {
    try {
      const near = seat.dimension.getEntities({ type: carType, location: seat.location, maxDistance: 16 });
      return near.find((e: any) => read(e, K.index) === index) ?? near[0];
    } catch { return undefined; }
  };
  const start = (seat: any, rider: any): void => {
    const index = read(seat, K.index);
    const ride = typeof index === 'number' ? config.rides[index] : undefined;
    if (!ride) return;
    const f = typeof read(seat, K.scale) === 'number' ? read(seat, K.scale) : 1;
    const pts = parse(read(seat, K.path));
    if (pts.length < 2) return;
    if (ride.kind === 'slide') {
      const lens = lengths(pts);
      running.set(seat.id, { seat, rider, kind: 'slide', path: pts, lens, s: 0, end: lens[lens.length - 1]!, v: R.SLIDE_V0 * f, f, home: pts[0] });
      say(rider, 'Wheee!');
      return;
    }
    // A lift: from its stop to the next floor, up to the top, then back down.
    const exits = parse(read(seat, K.exits));
    const n = pts.length;
    let stop = read(seat, K.stop); if (typeof stop !== 'number' || stop < 0 || stop >= n) stop = ride.startStop ?? 0;
    let dir = read(seat, K.dir); if (dir !== 1 && dir !== -1) dir = 1;
    if (stop + dir < 0 || stop + dir >= n) dir = -dir;
    const target = stop + dir;
    const from = pts[stop]!, to = pts[target]!;
    const car = ride.carType ? findCar(seat, index, ride.carType) : undefined;
    const carOffset = car ? { x: car.location.x - seat.location.x, y: car.location.y - seat.location.y, z: car.location.z - seat.location.z } : undefined;
    const path = [{ x: seat.location.x, y: seat.location.y, z: seat.location.z }, { x: seat.location.x + (to.x - from.x), y: seat.location.y + (to.y - from.y), z: seat.location.z + (to.z - from.z) }];
    const lens = lengths(path);
    try { seat.setDynamicProperty(K.dir, dir); } catch { /* gone */ }
    running.set(seat.id, { seat, rider, kind: 'lift', path, lens, s: 0, end: lens[1]!, v: R.LIFT_SPEED * f, f, car, carOffset, target, exit: exits[target] });
    say(rider, dir > 0 ? 'Going up' : 'Going down');
  };
  const finish = (run: Run): void => {
    let riders: any[] = [];
    try { riders = run.seat.getComponent('minecraft:rideable')?.getRiders?.() ?? []; } catch { /* gone */ }
    try { run.seat.getComponent('minecraft:rideable')?.ejectRiders?.(); } catch { /* gone */ }
    const last = run.path[run.path.length - 1]!;
    const off = run.kind === 'lift' && run.exit ? run.exit : last;
    for (const r of riders) { try { r.teleport({ x: off.x, y: off.y + 0.05, z: off.z }, { keepVelocity: false }); } catch { /* left */ } }
    if (run.kind === 'lift') { try { run.seat.setDynamicProperty(K.stop, run.target); } catch { /* gone */ } running.delete(run.seat.id); }
    else run.done = system.currentTick;
  };
  system.runInterval(() => {
    // New riders: anyone sitting on a ride seat that is not moving yet.
    for (const p of world.getAllPlayers()) {
      let seat: any;
      try { seat = p.getComponent('minecraft:riding')?.entityRidingOn; } catch { seat = undefined; }
      if (!seat || seat.typeId !== config.seatType || running.has(seat.id)) continue;
      start(seat, p);
    }
    for (const run of [...running.values()]) {
      // `isValid` is a method before @minecraft/server 2.0 and a property after (bedrock-coaster.ts reads both).
      const valid = typeof run.seat.isValid === 'function' ? run.seat.isValid() : run.seat.isValid;
      if (!valid) { running.delete(run.seat.id); continue; }
      if (run.done !== undefined) {
        // A slide's seat goes back to the top once its rider is off.
        if (system.currentTick - run.done >= R.SLIDE_RETURN_TICKS) {
          try { run.seat.tryTeleport(run.home, { keepVelocity: false, checkForBlocks: false }); } catch { /* unloaded */ }
          running.delete(run.seat.id);
        }
        continue;
      }
      if (run.kind === 'slide') run.v = Math.min(R.SLIDE_VMAX * run.f, run.v + R.SLIDE_ACCEL * run.f / 20);
      run.s = Math.min(run.end, run.s + run.v / 20);
      const { p, yaw } = at(run.path, run.lens, run.s);
      try { run.seat.tryTeleport(p, { keepVelocity: false, checkForBlocks: false, ...(run.kind === 'slide' ? { rotation: { x: 0, y: yaw } } : {}) }); } catch { /* unloaded: hold */ }
      if (run.car && run.carOffset) { try { run.car.tryTeleport({ x: p.x + run.carOffset.x, y: p.y + run.carOffset.y, z: p.z + run.carOffset.z }, { keepVelocity: false, checkForBlocks: false }); } catch { /* unloaded */ } }
      if (run.s >= run.end - 1e-6) finish(run);
    }
  }, 1);
}

export { ridesRuntime as _ridesRuntimeForTests };

/** `scripts/rides.js`: the config and the runtime. */
export function ridesScript(config: RideRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${ridesRuntime.toString()})(CONFIG);\n`;
}
