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
 *     alongside; the player steps off onto that floor beside the shaft;
 *   - an ORBIT (a flyer mount's companion, bedrock-flyer.ts): the seat carries
 *     the set's own FIGURE, not a player, round a closed loop the export wrote
 *     (`orbitPathLdu`) at `ORBIT_SPEED`, for ever, with the mount's own entity
 *     (the cloud) moved alongside as a lift's car is; nobody sits on it (its
 *     seat admits figures only) and a figure knocked off is put back on. It
 *     starts by itself once placed - no rider begins it.
 * Speeds are blocks per second at 100 % and scale with the wand size, so a ride
 * takes the same time at every size.
 *
 * WHAT IS A SLIDE. A part whose description starts `Slide ` (the playground
 * moulds 28387, 11267, 27976, ...). Its chute is read from the part's TOP
 * surface: the highest face over each 4-LDU cell of its footprint. The chute's
 * side walls stand over its bed, so a cell with a cell `SLIDE_RIM_LDU` lower
 * within `SLIDE_RIM_REACH_LDU` is a RIM and is dropped: what is left is the
 * bed the rider slides on. Banded by height, each band's centroid is a point
 * of the running line, which descends monotonically from the top of the chute
 * to its foot, so the bands order it. Reading the rims too put 10788's rider
 * on top of its side walls, 30 LDU over the bed at the top (Saga, 2026-09-29).
 *
 * WHAT IS A LIFT. The set's own ELEVATOR PLATFORM (a mould its library
 * description names so: 3863 "Brick 2 x 4 x 5 ... Runners for Channels and
 * Elevator Platform"), running in a COLUMN: the frames and supports stacked
 * over (or under) the platform's footprint, contiguous within
 * `LIFT_COLUMN_GAP_LDU` (10788: four `Door Frame 3 x 6 x 6 with Inside
 * Grooves` whose grooves take the platform's runners). The car is the platform
 * and what stands on it; the rider stands on its lowest wide top surface (the
 * platform, not the runner block behind it). Its stops are the floors that
 * meet the column's sides (flat parts within `LIFT_FLOOR_REACH_LDU`,
 * `LIFT_MIN_FLOOR_AREA_LDU2` at a level) at which the whole car stays inside the
 * column. Until 2026-09-29 a lift was "a car standing on two supports", and
 * 10788's only such car was the top of its shaft's back wall: the cat-eared
 * cap flew over the roof while the pink platform never moved.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';
import { ESCAPE_OPTIONS, colliderBodyProbe, colliderFormKit, type ColliderBodyProbe, type EscapeOptions } from './collider-form.js';
import { COLLIDER_HI_STATE, COLLIDER_LO_STATE } from './bedrock-building-shell.js';
import { hopKit, type HopKit, type HopKitConfig } from './bedrock-ride-hop.js';

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
  /** A ride's planned terminal point is lifted this far before finding a free standing spot, blocks. */
  SETDOWN_LIFT_BLOCKS: 0.05,
  /** How far sideways a ride set-down searches for a free standing spot, blocks at 100 %. */
  SETDOWN_REACH_BLOCKS: 2,
  /** How far below a ride terminal its set-down may find a floor, blocks. */
  SETDOWN_DROP_BLOCKS: 3,
  /** A top-surface cell with a cell at least this much lower nearby is a chute's rim, not its bed, LDU (10788's rails stand 30-38 over the bed). */
  SLIDE_RIM_LDU: 12,
  /** How far the rim test looks for that lower cell, LDU: two cells, so a chute falling less than 1.5 LDU per LDU keeps its own downhill cells. */
  SLIDE_RIM_REACH_LDU: 8,
  /** Parts of a lift's column are stacked within this vertical gap of each other and of the car, LDU (a plate). */
  LIFT_COLUMN_GAP_LDU: 16,
  /** A column carries the car at least this far, LDU (two storeys of 3 bricks: less is a shelf, not a lift). */
  LIFT_MIN_TRAVEL_LDU: 144,
  /** A car may stand this far past the column's top or foot at a stop, LDU (a brick of runner above the last groove). */
  LIFT_COLUMN_SLACK_LDU: 24,
  /** What stands on the car belongs to it while it stays this close to the car's footprint, LDU. */
  LIFT_SHAFT_MARGIN_LDU: 24,
  /** A car has at most this many parts. */
  LIFT_CAR_MAX_PARTS: 80,
  /** The rider stands on the car's top surface cells within this of its most common height, LDU (the platform, not the runner block). */
  LIFT_PLATFORM_BAND_LDU: 8,
  /** A floor meets the shaft when a floor part lies within this of its side, LDU. */
  LIFT_FLOOR_REACH_LDU: 40,
  /** A floor part is a flat part at most this thick, LDU: a plate, a tile, a 2/3 brick (10788's rooms stand on 2629 "Brick, Modified 8 x 16 x 2/3"). */
  LIFT_FLOOR_MAX_THICK_LDU: 16,
  /** Storeys are at least this far apart, LDU (3 bricks). */
  LIFT_MIN_STOREY_LDU: 72,
  /** A lift serves at most this many storeys (more is a tower's frame, not a dollhouse). */
  LIFT_MAX_STOPS: 6,
  /** A storey has at least this much floor at the shaft's sides, LDU² (4 x 4 studs: a room's floor, not a shelf or a rim of tiles). */
  LIFT_MIN_FLOOR_AREA_LDU2: 6400,
  /** Floor parts at one level: heights within this, LDU. */
  LIFT_LEVEL_TOL_LDU: 4,
  /** A rider steps off this far past the shaft's edge, LDU (past a 20-LDU side wall into the room). */
  LIFT_EXIT_STEP_LDU: 50,
  /** Along the shaft's side the step-off point is searched this far apart for a floor under it, LDU (half a stud). */
  LIFT_EXIT_SEARCH_LDU: 10,
  /** The floor a rider steps onto may lie this far under the storey's rim tiles, LDU (a brick). */
  LIFT_EXIT_DROP_LDU: 24,
  /** The step-off point lies at least this far inside the floor part under it, LDU (a player's half width, 0.3 blocks). */
  LIFT_EXIT_INSET_LDU: 16,
  /** The step-off point has this much clear height over its floor, LDU (a player, 1.8 blocks). */
  LIFT_EXIT_HEADROOM_LDU: 96,
  /** The step-off point is searched out to this far past the shaft's edge, LDU (three studs more than the first step). */
  LIFT_EXIT_REACH_LDU: 60,
  /** Speed of the car, blocks/s at 100 %. */
  LIFT_SPEED: 1.5,
  /** Speed of a companion's orbit, blocks/s at 100 %: a stroll's pace, so a child can watch and follow it. */
  ORBIT_SPEED: 3,
  /** An orbit seat with nobody on it looks this far (blocks at 100 %) for its own figure to put back on. */
  ORBIT_RESEAT_REACH: 8,
  /** Ticks between two re-seat attempts (a figure a player is holding on to is not fought for every tick). */
  ORBIT_RESEAT_TICKS: 40,
  /** Ticks between two scans for placed orbit seats not yet running (a placement, a reload). */
  ORBIT_ADOPT_TICKS: 20,
  /** Half the chord the orbit's yaw is read over, blocks: a central difference along the loop, so the facing turns smoothly between points. */
  ORBIT_YAW_CHORD: 0.5,
  /** Parts closer than this touch, LDU. */
  TOUCH_LDU: 2,
} as const;

/** `slide` and `lift` are found from the geometry (below); an `orbit` is written by a flyer mount's companion (bedrock-flyer.ts). */
export type RideKind = 'slide' | 'lift' | 'orbit';

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

/**
 * A lift's car mould, named by its library description: an elevator (or lift)
 * platform. 3863 reads "Brick 2 x 4 x 5 with Hole for Worm Screw 6L, Runners
 * for Channels and Elevator Platform" in Studio's library and "Brick 2 x 4 x 5
 * with Platform and Hole for Worm Screw" in LDraw's 2026-04 update; both name it.
 */
export function isLiftCarDescription(description: string): boolean {
  const d = stripped(description);
  return /\b(Elevator|Lift)\s+Platform\b/i.test(d) || /\bwith\s+Platform\s+and\s+Hole\s+for\s+Worm\s+Screw\b/i.test(d);
}

/**
 * A part of the column a lift's car runs in: a guide (`isLiftGuideDescription`)
 * or a frame whose grooves take the car's runners (3417 "Door Frame 3 x 6 x 6
 * with Inside Grooves", BrickLink's `bl_3417` "FRAME 3X6X6 ... CUT OUT").
 * Only parts over the car's own footprint and stacked on its run are asked.
 */
export function isLiftColumnDescription(description: string): boolean {
  return isLiftGuideDescription(description) || /\bFrame\b/i.test(stripped(description));
}

/**
 * The top surface of triangles over a grid of `cell`-LDU columns spanning
 * `box` in X/Z: the smallest LDraw y (the highest point) any face reaches over
 * each cell's centre, Infinity where no face covers it.
 */
function topSurface(tris: ReadonlyArray<readonly [Vec3, Vec3, Vec3]>, box: Box, cell: number): { top: Float64Array; nx: number; nz: number } {
  const nx = Math.max(1, Math.ceil((box.max[0] - box.min[0]) / cell)), nz = Math.max(1, Math.ceil((box.max[2] - box.min[2]) / cell));
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
  return { top, nx, nz };
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


/**
 * A slide's running line in LDraw, top to foot, plus the run-out; null when the
 * part does not fall `SLIDE_MIN_DROP_LDU` (or has no geometry).
 */
export function slidePathLdu(b: ParsedBrick, mesh: LdrawPartMesh): Vec3[] | null {
  if (!mesh.triangles.length) return null;
  const cell = RIDE.SLIDE_CELL_LDU;
  const tris = mesh.triangles.map(t => [toWorld(b, t.a), toWorld(b, t.b), toWorld(b, t.c)] as const);
  const box = worldBox(b, mesh);
  const { top, nx, nz } = topSurface(tris, box, cell);
  // The bed: every covered cell but the rims (a cell with a much lower cell
  // beside it is the top of a side wall or rail over the bed).
  const reach = Math.max(1, Math.round(RIDE.SLIDE_RIM_REACH_LDU / cell));
  const bed = new Uint8Array(nx * nz);
  let bedCells = 0;
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const y = top[i * nz + k]!;
    if (!Number.isFinite(y)) continue;
    let rim = false;
    for (let di = -reach; di <= reach && !rim; di++) for (let dk = -reach; dk <= reach && !rim; dk++) {
      const ii = i + di, kk = k + dk;
      if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
      const o = top[ii * nz + kk]!;
      if (Number.isFinite(o) && o - y >= RIDE.SLIDE_RIM_LDU) rim = true; // LDraw y down: o lower by the rim height
    }
    if (!rim) { bed[i * nz + k] = 1; bedCells++; }
  }
  // A part with no rims at all (a plain ramp) is all bed.
  const onBed = (j: number): boolean => Number.isFinite(top[j]!) && (bedCells === 0 || bed[j] === 1);
  let hi = Infinity, lo = -Infinity;
  for (let j = 0; j < top.length; j++) if (onBed(j)) { const y = top[j]!; if (y < hi) hi = y; if (y > lo) lo = y; }
  if (!Number.isFinite(hi) || lo - hi < RIDE.SLIDE_MIN_DROP_LDU) return null;
  const bands = Math.max(4, Math.min(16, Math.round((lo - hi) / RIDE.SLIDE_BAND_LDU)));
  const sums = Array.from({ length: bands }, () => ({ x: 0, y: 0, z: 0, n: 0 }));
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const y = top[i * nz + k]!;
    if (!onBed(i * nz + k)) continue;
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
 * Every lift: the set's elevator platform (`isLiftCarDescription`) running in
 * a column of frames or guides over its footprint, with a stop at every floor
 * that meets the column and keeps the car inside it. `exclude` are placements
 * already taken (figures, vehicles).
 */
export function findLifts(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, exclude: ReadonlySet<ParsedBrick> = new Set(), trace?: (message: string) => void): SceneRide[] {
  const boxes = new Map<ParsedBrick, Box>();
  for (const b of bricks) { const m = meshes.get(b.part); if (m && m.triangles.length) boxes.set(b, worldBox(b, m)); }
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  // A floor part: flat and thin (a plate, a tile, a 2/3 brick), whatever its name.
  const isFloorPart = (b: ParsedBrick): boolean => { const box = boxes.get(b); return !!box && box.max[1] - box.min[1] <= RIDE.LIFT_FLOOR_MAX_THICK_LDU + 0.5; };
  const t = RIDE.TOUCH_LDU;
  const out: SceneRide[] = [];
  const taken = new Set<ParsedBrick>();
  for (const platform of bricks) {
    const pBox = boxes.get(platform);
    if (!pBox || exclude.has(platform) || taken.has(platform) || !isLiftCarDescription(desc(platform))) continue;
    // The column: frames and guides over the platform's footprint (half its
    // width in X or Z, and more than a touch in the other), stacked on its run.
    const overlap = (a: Box, b: Box, k: number): number => Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!);
    const overFootprint = (b: Box): boolean => {
      const ox = overlap(b, pBox, 0), oz = overlap(b, pBox, 2);
      const wx = pBox.max[0] - pBox.min[0], wz = pBox.max[2] - pBox.min[2];
      return (ox >= 0.5 * wx && oz > t) || (oz >= 0.5 * wz && ox > t);
    };
    const candidates = bricks.filter(b => b !== platform && !exclude.has(b) && boxes.has(b) && isLiftColumnDescription(desc(b)) && overFootprint(boxes.get(b)!));
    const column: ParsedBrick[] = [];
    let top = pBox.min[1], foot = pBox.max[1];
    for (let grew = true; grew;) {
      grew = false;
      for (const c of candidates) {
        if (column.includes(c)) continue;
        const cb = boxes.get(c)!;
        if (cb.max[1] < top - RIDE.LIFT_COLUMN_GAP_LDU || cb.min[1] > foot + RIDE.LIFT_COLUMN_GAP_LDU) continue;
        column.push(c); top = Math.min(top, cb.min[1]); foot = Math.max(foot, cb.max[1]); grew = true;
      }
    }
    trace?.(`platform ${platform.part} at ${platform.x},${platform.y},${platform.z}: column of ${column.length} (${column.map(c => c.part).join(' ')}), ${top}..${foot}`);
    if (!column.length || foot - top - (pBox.max[1] - pBox.min[1]) < RIDE.LIFT_MIN_TRAVEL_LDU) continue;
    const columnSet = new Set(column);
    // The car: the platform and what stands on it (transitively) over its footprint.
    const near = (b: Box): boolean => { const m = RIDE.LIFT_SHAFT_MARGIN_LDU; return b.min[0] >= pBox.min[0] - m && b.max[0] <= pBox.max[0] + m && b.min[2] >= pBox.min[2] - m && b.max[2] <= pBox.max[2] + m; };
    const car = [platform];
    for (let grew = true; grew && car.length < RIDE.LIFT_CAR_MAX_PARTS;) {
      grew = false;
      for (const o of bricks) {
        const ob = boxes.get(o);
        if (!ob || car.includes(o) || columnSet.has(o) || exclude.has(o) || !near(ob)) continue;
        // On the car: its foot on a car part's top (LDraw y down), footprints overlapping.
        if (!car.some(c => { const cb = boxes.get(c)!; return Math.abs(ob.max[1] - cb.min[1]) <= t && overlap(ob, cb, 0) > t && overlap(ob, cb, 2) > t; })) continue;
        car.push(o); grew = true;
      }
    }
    const cb = car.map(b => boxes.get(b)!);
    const carBox: Box = { min: [Math.min(...cb.map(b => b.min[0])), Math.min(...cb.map(b => b.min[1])), Math.min(...cb.map(b => b.min[2]))], max: [Math.max(...cb.map(b => b.max[0])), Math.max(...cb.map(b => b.max[1])), Math.max(...cb.map(b => b.max[2]))] };
    // Where the rider stands: the car's most common top-surface height (the
    // platform, not the runner block behind it), at the centroid of those cells.
    const cell = RIDE.SLIDE_CELL_LDU;
    const tris = car.flatMap(b => (meshes.get(b.part)?.triangles ?? []).map(tr => [toWorld(b, tr.a), toWorld(b, tr.b), toWorld(b, tr.c)] as const));
    const { top: surf, nx, nz } = topSurface(tris, carBox, cell);
    const counts = new Map<number, number>();
    for (const y of surf) if (Number.isFinite(y)) { const k = Math.round(y / cell); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const mode = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (!mode) continue;
    let sx = 0, sz = 0, sy = 0, n = 0;
    for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      const y = surf[i * nz + k]!;
      if (!Number.isFinite(y) || Math.abs(y - mode[0] * cell) > RIDE.LIFT_PLATFORM_BAND_LDU) continue;
      sx += carBox.min[0] + (i + 0.5) * cell; sz += carBox.min[2] + (k + 0.5) * cell; sy += y; n++;
    }
    const cx = sx / n, cz = sz / n, standY = sy / n;
    // The shaft the floors meet: the column and the car, in X/Z.
    const all = [...column.map(c => boxes.get(c)!), carBox];
    const shaftBox: Box = { min: [Math.min(...all.map(b => b.min[0])), top, Math.min(...all.map(b => b.min[2]))], max: [Math.max(...all.map(b => b.max[0])), foot, Math.max(...all.map(b => b.max[2]))] };
    const carSet = new Set(car);
    // Where a rider steps off at a floor: `LIFT_EXIT_STEP_LDU` past the shaft's
    // side (into the room, past its wall), level with the floor, and over a
    // part whose top IS that floor - beside the shaft first (along its whole side,
    // starting level with the car), then at its front or back. 10788's
    // platform stands out in front of the house, where there is no floor, and
    // its ground floor has tiles behind the shaft: the first tile found set the
    // rider behind the shaft's back wall.
    // The floor under a point: the highest part top from the floor's level down
    // to `LIFT_EXIT_DROP_LDU` under it (10788's rooms are 2629 "Brick, Modified
    // 8 x 16 x 2/3" 16 LDU under the rim tiles its storeys are counted by);
    // null when nothing is there.
    const floorAt = (x: number, y: number, z: number): number | null => {
      let best: number | null = null;
      for (const b of bricks) {
        const box = boxes.get(b);
        if (!box || carSet.has(b) || columnSet.has(b) || exclude.has(b)) continue;
        if (box.min[1] < y - RIDE.LIFT_LEVEL_TOL_LDU || box.min[1] > y + RIDE.LIFT_EXIT_DROP_LDU) continue;
        // Far enough inside the part for a player's half width, so the rider lands ON the floor, not at its edge.
        const i = RIDE.LIFT_EXIT_INSET_LDU;
        if (x < box.min[0] + i || x > box.max[0] - i || z < box.min[2] + i || z > box.max[2] - i) continue;
        if (best === null || box.min[1] < best) best = box.min[1];
      }
      return best;
    };
    const liftExit = (y: number): Vec3 => {
      const e = RIDE.LIFT_EXIT_STEP_LDU, step = RIDE.LIFT_EXIT_SEARCH_LDU;
      const scx = (shaftBox.min[0] + shaftBox.max[0]) / 2, scz = (shaftBox.min[2] + shaftBox.max[2]) / 2;
      /** Points along a line from `from` toward `to` (inclusive), `step` apart. */
      const along = (from: number, to: number): number[] => { const n = Math.max(1, Math.ceil(Math.abs(to - from) / step)); return Array.from({ length: n + 1 }, (_, i) => from + (to - from) * i / n); };
      // Out from the shaft's side in `LIFT_EXIT_SEARCH_LDU` steps up to `LIFT_EXIT_REACH_LDU`
      // past it, nearer first: beside it (X) at any distance, then at its front or back (Z).
      const outs = along(e, e + RIDE.LIFT_EXIT_REACH_LDU);
      const xDirs = cx < scx ? [-1, 1] : [1, -1], zDirs = cz < scz ? [-1, 1] : [1, -1];
      const candidates: Vec3[] = [];
      for (const o of outs) for (const d of xDirs) for (const z of along(cz, cz < scz ? shaftBox.max[2] : shaftBox.min[2])) candidates.push([d > 0 ? shaftBox.max[0] + o : shaftBox.min[0] - o, y, z]);
      for (const o of outs) for (const d of zDirs) for (const x of along(cx, cx < scx ? shaftBox.max[0] : shaftBox.min[0])) candidates.push([x, y, d > 0 ? shaftBox.max[2] + o : shaftBox.min[2] - o]);
      // Standing room over the floor there: no part in a player's column (10788's
      // first pick, 50 LDU into its ground-floor room, was inside a 2 x 4 brick).
      const clear = (x: number, f: number, z: number): boolean => {
        const r = RIDE.LIFT_EXIT_INSET_LDU, h = RIDE.LIFT_EXIT_HEADROOM_LDU;
        return !bricks.some(b => {
          const box = boxes.get(b);
          return !!box && !carSet.has(b) && !exclude.has(b) && box.max[1] > f - h + t && box.min[1] < f - t
            && box.max[0] > x - r && box.min[0] < x + r && box.max[2] > z - r && box.min[2] < z + r;
        });
      };
      for (const p of candidates) { const f = floorAt(p[0], p[1], p[2]); if (f !== null && clear(p[0], f, p[2])) return [p[0], f, p[2]]; }
      for (const p of candidates) { const f = floorAt(p[0], p[1], p[2]); if (f !== null) return [p[0], f, p[2]]; }
      return candidates[0]!;
    };
    // Floors meeting the shaft's sides: floor-part tops within reach, not the car's or the column's.
    const reach = RIDE.LIFT_FLOOR_REACH_LDU;
    const tops: Array<{ y: number; area: number }> = [];
    for (const b of bricks) {
      const box = boxes.get(b);
      if (!box || carSet.has(b) || columnSet.has(b) || !isFloorPart(b)) continue;
      const dx = Math.max(shaftBox.min[0] - box.max[0], box.min[0] - shaftBox.max[0], 0), dz = Math.max(shaftBox.min[2] - box.max[2], box.min[2] - shaftBox.max[2], 0);
      if (Math.hypot(dx, dz) > reach) continue;
      if (box.min[1] < top - reach || box.min[1] > foot + reach) continue;
      tops.push({ y: box.min[1], area: (box.max[0] - box.min[0]) * (box.max[2] - box.min[2]) });
    }
    tops.sort((a, b) => b.y - a.y); // lowest (largest LDraw y) first
    const levels: Array<{ y: number; area: number }> = [];
    for (const tp of tops) {
      const lv = levels.find(l => Math.abs(l.y - tp.y) <= RIDE.LIFT_LEVEL_TOL_LDU);
      if (lv) lv.area += tp.area; else levels.push({ y: tp.y, area: tp.area });
    }
    // A storey is the level with the most floor in each `LIFT_MIN_STOREY_LDU`
    // window (a room's floor, not the rim tiles under its edge: 10788's rooms
    // stand 16 LDU over the tiles that were counted as its storeys, so its car
    // stopped a third of a block under each floor), with at least
    // `LIFT_MIN_FLOOR_AREA_LDU2` of it at the shaft's sides.
    const floors: Array<{ y: number; area: number; exit: Vec3 }> = [];
    for (const l of [...levels].sort((a, b) => b.area - a.area)) {
      if (l.area < RIDE.LIFT_MIN_FLOOR_AREA_LDU2 || floors.some(f => Math.abs(f.y - l.y) < RIDE.LIFT_MIN_STOREY_LDU)) continue;
      floors.push({ ...l, exit: liftExit(l.y) });
    }
    if (!floors.length) { trace?.('no floor meets the column'); continue; }
    // The car starts at the floor nearest where it stands and keeps its height
    // over each floor; a floor it would leave the column at is not a stop
    // (10788's platform cannot reach the attic: its runner block would pass
    // the top frame).
    const start = floors.reduce((a, b) => (Math.abs(b.y - standY) < Math.abs(a.y - standY) ? b : a));
    const s = RIDE.LIFT_COLUMN_SLACK_LDU;
    const stops = floors.filter(f => {
      const shift = f.y - start.y;
      return carBox.min[1] + shift >= top - s && carBox.max[1] + shift <= foot + s;
    }).sort((a, b) => b.y - a.y);
    trace?.(`car ${car.length} part(s), stands at ${Math.round(standY)} over ${Math.round(cx)},${Math.round(cz)}; levels ${levels.map(l => `${l.y}:${Math.round(l.area)}`).join(' ')}; floors ${floors.map(f => f.y).join(' ')}; stops ${stops.map(f => f.y).join(' ')}`);
    if (stops.length < 2 || !stops.includes(start)) continue;
    if (stops.length > RIDE.LIFT_MAX_STOPS) { trace?.(`${stops.length} stops: a tower, not a dollhouse lift`); continue; }
    for (const b of car) taken.add(b);
    out.push({
      kind: 'lift', label: 'Lift', part: platform.part.replace(/\.dat$/i, ''),
      pathLdu: stops.map(f => [cx, standY + (f.y - start.y), cz] as Vec3),
      exitsLdu: stops.map(f => f.exit),
      startStop: stops.indexOf(start),
      carBricks: car,
    });
  }
  return out;
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface RideRuntimeConfig {
  /** The invisible rideable seat type every player ride (slide, lift) shares. */
  seatType: string;
  /**
   * Per ride (the placement writes the index on its seat and car): kind, the
   * car's type for a lift or an orbit's cloud, and for an orbit its own seat
   * type (figures only) and the figure type it carries and re-seats.
   */
  rides: Array<{ kind: RideKind; carType?: string; startStop?: number; seatType?: string; riderType?: string }>;
  constants: typeof RIDE;
  /** The hop kit's config (bedrock-ride-hop.ts): a slide's set-down boards a mountable parked at its foot. */
  hop?: HopKitConfig;
  /** The set-down's last resort (`ColliderBodyProbe.escape`); `ridesScript` fills `ESCAPE_OPTIONS` where a config lacks it. */
  escape?: EscapeOptions;
}

declare const world: any;
declare const system: any;

/**
 * The rides' runtime. Serialised whole into `scripts/rides.js` (`ridesScript`),
 * so it may use only its arguments and the Script API globals.
 */
function ridesRuntime(config: RideRuntimeConfig, body?: ColliderBodyProbe, hop?: HopKit): void {
  const R = config.constants;
  const K = { index: 'craftmatic:ride', path: 'craftmatic:ride_path', exits: 'craftmatic:ride_exits', scale: 'craftmatic:ride_scale', stop: 'craftmatic:ride_stop', dir: 'craftmatic:ride_dir' };
  type P = { x: number; y: number; z: number };
  interface Run {
    seat: any; rider: any; kind: string; path: P[]; lens: number[]; s: number; end: number; v: number; f: number; car?: any; carOffset?: P; target?: number; exit?: P; done?: number; home?: P;
    /** An orbit: the loop never ends, and its figure type is put back on when it is off. */
    loop?: boolean; riderType?: string; reseatAt?: number;
  }
  const running = new Map<string, Run>();
  const read = (e: any, key: string): any => { try { return e.getDynamicProperty(key); } catch { return undefined; } };
  const parse = (s: any): P[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
  const lengths = (path: P[]): number[] => { const out = [0]; for (let i = 1; i < path.length; i++) out.push(out[i - 1]! + Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y, path[i]!.z - path[i - 1]!.z)); return out; };
  const pointAt = (path: P[], lens: number[], s: number): P => {
    let i = 1;
    while (i < path.length - 1 && lens[i]! < s) i++;
    const a = path[i - 1]!, b = path[i]!, seg = Math.max(1e-6, lens[i]! - lens[i - 1]!);
    const t = Math.max(0, Math.min(1, (s - lens[i - 1]!) / seg));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  const yawOf = (a: P, b: P): number => Math.hypot(b.x - a.x, b.z - a.z) > 1e-6 ? Math.atan2(-(b.x - a.x), b.z - a.z) * 180 / Math.PI : 0;
  const at = (path: P[], lens: number[], s: number): { p: P; yaw: number } => {
    let i = 1;
    while (i < path.length - 1 && lens[i]! < s) i++;
    return { p: pointAt(path, lens, s), yaw: yawOf(path[i - 1]!, path[i]!) };
  };
  /** A loop: the point at `s` (wrapped) and the yaw of the chord `ORBIT_YAW_CHORD` either side of it, so the facing turns smoothly between the points. */
  const atLoop = (path: P[], lens: number[], s: number, chord: number): { p: P; yaw: number } => {
    const end = lens[lens.length - 1]!;
    const wrap = (v: number): number => ((v % end) + end) % end;
    return { p: pointAt(path, lens, wrap(s)), yaw: yawOf(pointAt(path, lens, wrap(s - chord)), pointAt(path, lens, wrap(s + chord))) };
  };
  const say = (p: any, s: string): void => { try { p.onScreenDisplay.setActionBar(s); } catch { /* left */ } };
  const findCar = (seat: any, index: number, carType: string): any => {
    try {
      const near = seat.dimension.getEntities({ type: carType, location: seat.location, maxDistance: 16 });
      return near.find((e: any) => read(e, K.index) === index) ?? near[0];
    } catch { return undefined; }
  };
  const ridersOf = (e: any): any[] => { try { return e.getComponent('minecraft:rideable')?.getRiders?.() ?? []; } catch { return []; } };
  /** An orbit runs from the moment its seat is found: its loop closed back to the first point, its cloud alongside, no rider needed. */
  const startOrbit = (seat: any, index: number, ride: RideRuntimeConfig['rides'][number]): void => {
    const f = typeof read(seat, K.scale) === 'number' ? read(seat, K.scale) : 1;
    const pts = parse(read(seat, K.path));
    if (pts.length < 3) return;
    const path = [...pts, pts[0]!];
    const lens = lengths(path);
    const car = ride.carType ? findCar(seat, index, ride.carType) : undefined;
    const carOffset = car ? { x: car.location.x - seat.location.x, y: car.location.y - seat.location.y, z: car.location.z - seat.location.z } : undefined;
    running.set(seat.id, { seat, rider: undefined, kind: 'orbit', path, lens, s: 0, end: lens[lens.length - 1]!, v: R.ORBIT_SPEED * f, f, car, carOffset, loop: true, ...(ride.riderType ? { riderType: ride.riderType } : {}), reseatAt: 0 });
  };
  /** Orbit seats placed (or reloaded) since the last scan, in every dimension a player is in. */
  const adoptOrbits = (): void => {
    const dims = new Map<string, any>();
    try { dims.set('overworld', world.getDimension('overworld')); } catch { /* none */ }
    try { for (const p of world.getAllPlayers()) if (p) dims.set(p.dimension.id, p.dimension); } catch { /* none */ }
    config.rides.forEach((ride, index) => {
      if (ride.kind !== 'orbit') return;
      for (const dim of dims.values()) {
        let seats: any[] = [];
        try { seats = dim.getEntities({ type: ride.seatType ?? config.seatType }); } catch { continue; }
        for (const seat of seats) if (!running.has(seat.id) && read(seat, K.index) === index) startOrbit(seat, index, ride);
      }
    });
  };
  /** An orbit's figure, knocked off or never seated: the nearest of its type not riding anything is put back on. */
  const reseat = (run: Run): void => {
    if (!run.riderType || system.currentTick < (run.reseatAt ?? 0)) return;
    run.reseatAt = system.currentTick + R.ORBIT_RESEAT_TICKS;
    try {
      const seat = run.seat, near = seat.dimension.getEntities({ type: run.riderType, location: seat.location, maxDistance: R.ORBIT_RESEAT_REACH * run.f });
      const free = near.find((e: any) => { try { return !e.getComponent('minecraft:riding'); } catch { return false; } });
      if (!free) return;
      try { free.teleport(seat.location); } catch { /* unloaded */ }
      seat.getComponent('minecraft:rideable')?.addRider?.(free);
    } catch { /* next time */ }
  };
  const start = (seat: any, rider: any): void => {
    const index = read(seat, K.index);
    const ride = typeof index === 'number' ? config.rides[index] : undefined;
    if (!ride || ride.kind === 'orbit') return;
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
    // Set down where the body FITS: the planned point lifted out of a floor it sits in, else the nearest free
    // standing spot within the bounded search (times the size). The planned points had put riders 0.2-0.34 inside floor
    // slabs (10788's lift exits, 41703's and 42652's slide feet) and the player then fell through (simulator
    // triage 2026-09-30). Without a probe (a test host) the planned point stands. The search reaches 2 blocks
    // (times the size) aside and a floor up to 3 blocks down - the most a player falls unhurt: 41395's slide foot
    // ends against the bus's bodywork, and the nearest room to stand is 1.25 blocks aside, at the foot's level.
    // Every candidate in that reach must be one the rider WALKS to from the terminal (`routeClear`: out of what
    // the terminal sits in, then never into a wall again): at 400 % the reach is 8 blocks and a point beyond a
    // wall was a set-down THROUGH it. With none, the last resort is the walk-connected flood, then the model's
    // exterior (`escape`), the scenery seats' own; only with neither does the planned point stand.
    const planned = { x: off.x, y: off.y + R.SETDOWN_LIFT_BLOCKS, z: off.z };
    let at = planned;
    if (body) {
      const dim = run.seat.dimension;
      try { at = body.settle(dim, planned, R.SETDOWN_REACH_BLOCKS * Math.max(1, run.f), R.SETDOWN_DROP_BLOCKS, q => body.routeClear(dim, planned, q, R.SETDOWN_DROP_BLOCKS)); } catch { at = planned; }
      if (at === planned && config.escape) { try { at = body.escape(dim, planned, { ...config.escape, seedReach: config.escape.seedReach * Math.max(1, run.f) })?.at ?? planned; } catch { at = planned; } }
    }
    // A HOP at a slide's foot (bedrock-ride-hop.ts): a mountable with a free seat parked where the rider is
    // set down (a car at the bottom of the slide, a coaster car, a chair) takes the rider instead - they slide
    // into it. Searched `HOP.SETDOWN_REACH_BLOCKS` about the set-down point (times the size, at least 1).
    const boarded = new Set<string>();
    if (hop && config.hop && run.kind === 'slide') {
      const reach = config.hop.constants.SETDOWN_REACH_BLOCKS * Math.max(1, run.f);
      for (const r of riders) {
        if (r?.typeId !== 'minecraft:player') continue;
        let target: any;
        try { target = hop.nearestAt(run.seat.dimension, at, reach, new Set([run.seat.id])); } catch { target = undefined; }
        if (target && hop.board(r, target)) boarded.add(r.id);
      }
    }
    for (const r of riders) { if (boarded.has(r.id)) continue; try { r.teleport(at, { keepVelocity: false }); } catch { /* left */ } }
    if (run.kind === 'lift') { try { run.seat.setDynamicProperty(K.stop, run.target); } catch { /* gone */ } running.delete(run.seat.id); }
    else run.done = system.currentTick;
  };
  const hasOrbits = config.rides.some(r => r.kind === 'orbit');
  system.runInterval(() => {
    // New riders: anyone sitting on a ride seat that is not moving yet.
    for (const p of world.getAllPlayers()) {
      let seat: any;
      try { seat = p.getComponent('minecraft:riding')?.entityRidingOn; } catch { seat = undefined; }
      if (!seat || seat.typeId !== config.seatType || running.has(seat.id)) continue;
      start(seat, p);
    }
    if (hasOrbits && system.currentTick % R.ORBIT_ADOPT_TICKS === 1) adoptOrbits();
    for (const run of [...running.values()]) {
      // `isValid` is a method before @minecraft/server 2.0 and a property after (bedrock-coaster.ts reads both).
      const valid = typeof run.seat.isValid === 'function' ? run.seat.isValid() : run.seat.isValid;
      if (!valid) { running.delete(run.seat.id); continue; }
      if (run.loop) {
        // An orbit: round and round; the seat faces along the loop and so does the figure on it.
        run.s += run.v / 20;
        if (run.s >= run.end) run.s -= run.end;
        const { p, yaw } = atLoop(run.path, run.lens, run.s, R.ORBIT_YAW_CHORD * run.f);
        try { run.seat.tryTeleport(p, { keepVelocity: false, checkForBlocks: false, rotation: { x: 0, y: yaw } }); } catch { /* unloaded: hold */ }
        if (run.car && run.carOffset) { try { run.car.tryTeleport({ x: p.x + run.carOffset.x, y: p.y + run.carOffset.y, z: p.z + run.carOffset.z }, { keepVelocity: false, checkForBlocks: false, rotation: { x: 0, y: yaw } }); } catch { /* unloaded */ } }
        const riders = ridersOf(run.seat);
        if (riders.length) { for (const r of riders) { try { r.setRotation({ x: 0, y: yaw }); } catch { /* a player keeps their look */ } } }
        else reseat(run);
        continue;
      }
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
  // A tap boards a ride. On a touch screen a tap is a HIT (`entityHitEntity`);
  // only a press held ~0.5 s is the interact that mounts a vanilla rideable
  // (measured on the Pixel, the add-on guide's pinball notes), so every seat a
  // child taps needs this handler. Two targets:
  //   - a lift's CAR: the rider is put on the car's own seat. The seat is
  //     invisible; a child taps the pink box they can see (10788, 2026-09-29);
  //   - the ride SEAT itself (a slide has no car): its box sits on the chute's
  //     top bed, where the child aims. Until 2026-09-29c a hit on it did
  //     nothing - 10788's slide boarded nobody over three taps on the Pixel
  //     while `/ride` on the same seat ran the chute. Colliders have no
  //     selection box, so the tap's ray reaches the seat inside them.
  const carRide = new Map<string, number>();
  config.rides.forEach((r, i) => { if (r.carType) carRide.set(r.carType, i); });
  const board = (player: any, target: any): void => {
    if (!player || player.typeId !== 'minecraft:player' || !target) return;
    let seat: any;
    if (target.typeId === config.seatType) {
      const index = read(target, K.index);
      const ride = typeof index === 'number' ? config.rides[index] : undefined;
      if (!ride || ride.kind === 'orbit') return; // an orbit's seat carries a figure, never a player (bedrock-flyer.ts gives the player a cloud)
      seat = target;
    } else {
      if (!carRide.has(target.typeId)) return;
      const index = typeof read(target, K.index) === 'number' ? read(target, K.index) : carRide.get(target.typeId);
      let seats: any[] = [];
      try { seats = target.dimension.getEntities({ type: config.seatType, location: target.location, maxDistance: 16 }); } catch { return; }
      seat = seats.find((s: any) => read(s, K.index) === index);
    }
    if (!seat || running.has(seat.id)) return;
    let rideable: any;
    try { rideable = seat.getComponent('minecraft:rideable'); } catch { return; }
    try { if ((rideable?.getRiders?.() ?? []).length) return; } catch { /* treat as free */ }
    let ok = false;
    try { ok = !!rideable?.addRider?.(player); } catch { ok = false; }
    if (!ok) {
      // A client that refuses addRider for a player: the ride command on this seat's spot.
      const l = seat.location;
      try { player.runCommand(`ride @s start_riding @e[type=${config.seatType},c=1,x=${l.x},y=${l.y},z=${l.z},r=1]`); } catch { /* left */ }
    }
  };
  try { world.afterEvents?.playerInteractWithEntity?.subscribe?.((ev: any) => board(ev.player, ev.target)); } catch { /* not in this API */ }
  try { world.afterEvents?.entityHitEntity?.subscribe?.((ev: any) => board(ev.damagingEntity, ev.hitEntity)); } catch { /* not in this API */ }
}

/** `scripts/rides.js`: the config and the runtime. */
export function ridesScript(config: RideRuntimeConfig): string {
  const hopArg = config.hop ? `, (${hopKit.toString()})(CONFIG.hop)` : '';
  // The set-down's last resort is the collider probe's own bound, filled where a config (an older pack's) lacks it.
  const shipped: RideRuntimeConfig = { ...config, escape: config.escape ?? ESCAPE_OPTIONS };
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(shipped)};\n(${ridesRuntime.toString()})(CONFIG, (${colliderBodyProbe.toString()})((${colliderFormKit.toString()})(), ${JSON.stringify(COLLIDER_LO_STATE)}, ${JSON.stringify(COLLIDER_HI_STATE)})${hopArg});\n`;
}
