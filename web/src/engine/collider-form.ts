/**
 * The FORMS a collider block can take, and the one function that turns any set
 * of boxes inside a block into the form that contains them (design:
 * docs/bedrock-interactivity.md, "Clearance: colliders pulled back to the
 * geometry").
 *
 * A collider block used to be one box over the WHOLE footprint, `lo..hi`
 * sixteenths high. A form adds a horizontal SHAPE - a band a quarter-block
 * multiple wide along x or z - so a wall's collider is the wall's thickness,
 * not the block:
 *
 *   v = 0            `craftmatic:collider`       full footprint, lo..hi (unchanged)
 *   kind 0 (wall)    `craftmatic:collider_w<s>`  shape s, lo..hi
 *   kind 1 (floor)   `craftmatic:collider_f<s>`  full lo..hi, then shape s from hi to the block top
 *   kind 2 (ceiling) `craftmatic:collider_c<s>`  shape s from the block bottom to lo, then full lo..hi
 *
 * Every form uses the same two states (`craftmatic:lo`, `craftmatic:hi`), so a
 * form is (variant, lo, hi) and a block is one of 43 ids. Bedrock allows a
 * collision box anywhere inside the block (origin -8,0,-8 to 8,16,8) and, since
 * format 1.26.0, an array of up to 16 boxes (Microsoft Learn,
 * minecraft:collision_box); a state holds at most 16 values, so shapes are ids
 * rather than a third state (43 x 256 registered permutations, 136 condition
 * entries each, instead of one block with 43 x 256 states and 5,848 entries).
 *
 * `colliderFormKit` is PLAIN JavaScript with no outside reference: the pack's
 * runtimes (the Brick Wand's re-lay, the doorway runtime) receive it
 * serialised with `.toString()` exactly as the build, the walk harness and the
 * tests use it, so there is one implementation of "which blocks does a cell
 * lay at this size and turn".
 */

/** A box inside one block, sixteenths: [x0, x1, y0, y1, z0, z1], each pair ascending. */
export type Box16 = [number, number, number, number, number, number];

/** One collider variant: its block id, kind (0 wall, 1 floor + wall, 2 wall + ceiling) and horizontal shape. */
export interface ColliderVariant { id: string; kind: 0 | 1 | 2; shape: number }

/** A collider block's form: variant index (0 = the full-footprint `craftmatic:collider`) and its lo/hi states. */
export interface ColliderForm { v: number; lo: number; hi: number }

/** The kit (see the module header). */
export interface ColliderFormKit {
  /** Horizontal shapes, sixteenths [x0, x1, z0, z1]; index 0 is the full footprint. */
  SHAPES: ReadonlyArray<readonly [number, number, number, number]>;
  /** Variant table, index = the `v` of a form. */
  VARIANTS: readonly ColliderVariant[];
  /** Variant index of a block id, or -1 when it is not a collider. */
  variantOf(id: string): number;
  /** The boxes a form's collision box consists of. */
  formBoxes(v: number, lo: number, hi: number): Box16[];
  /** The form of least volume containing every box (null for none); a full-footprint result is always v = 0. */
  cover(boxes: ReadonlyArray<readonly number[]>): ColliderForm | null;
  /** The form turned by a quarter turn about the vertical (the wand's placement turn). */
  turnForm(form: ColliderForm, r: number): ColliderForm;
  /**
   * The world pieces one grid cell lays at wand factor `f` and quarter turn
   * `r`: `emit(wx, wy, wz, box)` for every world block (relative to the
   * anchor) the cell's form reaches, with the part of the form in that block
   * (sixteenths, rounded outward). The columns a cell owns are the re-lay's
   * (`cellColumns`: centre rule at f >= 1, any overlap below); rows follow the
   * continuous scale. Below 100 % a piece is widened to the full footprint
   * (several cells share a block there).
   */
  cellPieces(x: number, y: number, z: number, v: number, lo: number, hi: number, dims: { width: number; length: number }, f: number, r: number, emit: (wx: number, wy: number, wz: number, box: Box16) => void): void;
  /**
   * Set a world block to a form. When the form's block cannot be resolved (a
   * world where an older pack's definitions win and the form ids do not
   * exist) it lays the FULL collider over the form's vertical extent instead:
   * a wall that is too thick, never a missing one. `resolve` is
   * `BlockPermutation.resolve`. Returns false when it fell back.
   */
  lay(block: { setPermutation(p: unknown): void }, form: ColliderForm, loState: string, hiState: string, resolve: (id: string, states: Record<string, number>) => unknown): boolean;
}

/**
 * Build the kit. `bands` replaces the quarter-block bands (sixteenths, each
 * used along x and along z) - only for measuring what another vocabulary would
 * do (`scripts/_ix_sealed_causes.ts --kit8`); the pack's block ids are the
 * default's, and the runtimes build it with none.
 */
export function colliderFormKit(bands?: ReadonlyArray<readonly [number, number]>): ColliderFormKit {
  const BANDS = bands ?? [[0, 4], [0, 8], [0, 12], [4, 16], [8, 16], [12, 16], [4, 12]];
  const SHAPES: Array<[number, number, number, number]> = [[0, 16, 0, 16]];
  for (const b of BANDS) SHAPES.push([b[0]!, b[1]!, 0, 16]);
  for (const b of BANDS) SHAPES.push([0, 16, b[0]!, b[1]!]);
  const TAG = ['w', 'f', 'c'];
  const VARIANTS: ColliderVariant[] = [{ id: 'craftmatic:collider', kind: 0, shape: 0 }];
  for (let k = 0; k < 3; k++) for (let s = 1; s < SHAPES.length; s++) VARIANTS.push({ id: 'craftmatic:collider_' + TAG[k] + s, kind: k as 0 | 1 | 2, shape: s });
  const byId: Record<string, number> = {};
  VARIANTS.forEach((d, i) => { byId[d.id] = i; });
  const vid = (kind: number, s: number): number => s === 0 ? 0 : 1 + kind * (SHAPES.length - 1) + (s - 1);
  const area = (s: number): number => (SHAPES[s]![1] - SHAPES[s]![0]) * (SHAPES[s]![3] - SHAPES[s]![2]);
  /** The smallest shape containing a footprint (ties: lowest index). */
  const smallest = (x0: number, x1: number, z0: number, z1: number): number => {
    let best = 0;
    for (let s = 1; s < SHAPES.length; s++) {
      const q = SHAPES[s]!;
      if (q[0] <= x0 && q[1] >= x1 && q[2] <= z0 && q[3] >= z1 && area(s) < area(best)) best = s;
    }
    return best;
  };
  const formBoxes = (v: number, lo: number, hi: number): Box16[] => {
    const d = VARIANTS[v]!, q = SHAPES[d.shape]!;
    if (d.kind === 0) return [[q[0], q[1], lo, hi, q[2], q[3]]];
    if (d.kind === 1) return hi < 16 ? [[0, 16, lo, hi, 0, 16], [q[0], q[1], hi, 16, q[2], q[3]]] : [[0, 16, lo, hi, 0, 16]];
    return lo > 0 ? [[q[0], q[1], 0, lo, q[2], q[3]], [0, 16, lo, hi, 0, 16]] : [[0, 16, lo, hi, 0, 16]];
  };
  const cover = (boxes: ReadonlyArray<readonly number[]>): ColliderForm | null => {
    let Y0 = 16, Y1 = 0, bx0 = 16, bx1 = 0, bz0 = 16, bz1 = 0, any = false;
    for (const b of boxes) {
      if (!(b[1]! > b[0]! && b[3]! > b[2]! && b[5]! > b[4]!)) continue;
      any = true;
      if (b[2]! < Y0) Y0 = b[2]!;
      if (b[3]! > Y1) Y1 = b[3]!;
      if (b[0]! < bx0) bx0 = b[0]!;
      if (b[1]! > bx1) bx1 = b[1]!;
      if (b[4]! < bz0) bz0 = b[4]!;
      if (b[5]! > bz1) bz1 = b[5]!;
    }
    if (!any) return null;
    const s0 = smallest(bx0, bx1, bz0, bz1);
    let best: ColliderForm = { v: vid(0, s0), lo: Y0, hi: Y1 };
    let bestVol = area(s0) * (Y1 - Y0);
    /** The footprint bbox of the boxes' parts within the span [a, b). */
    const within = (a: number, b: number): [number, number, number, number] | null => {
      let x0 = 16, x1 = 0, z0 = 16, z1 = 0, hit = false;
      for (const q of boxes) {
        if (!(q[1]! > q[0]! && q[3]! > q[2]! && q[5]! > q[4]!) || q[3]! <= a || q[2]! >= b) continue;
        hit = true;
        if (q[0]! < x0) x0 = q[0]!;
        if (q[1]! > x1) x1 = q[1]!;
        if (q[4]! < z0) z0 = q[4]!;
        if (q[5]! > z1) z1 = q[5]!;
      }
      return hit ? [x0, x1, z0, z1] : null;
    };
    // Floor + wall: full band Y0..m, shape m..16 (only when the geometry reaches the block top).
    if (Y1 === 16) for (let m = Y0 + 1; m <= 15; m++) {
      const up = within(m, 16);
      if (!up) continue;
      const s = smallest(up[0], up[1], up[2], up[3]);
      if (s === 0) continue;
      const vol = 256 * (m - Y0) + area(s) * (16 - m);
      if (vol < bestVol) { bestVol = vol; best = { v: vid(1, s), lo: Y0, hi: m }; }
    }
    // Wall + ceiling: shape 0..m, full band m..Y1 (only when the geometry reaches the block bottom).
    if (Y0 === 0) for (let m = 1; m < Y1; m++) {
      const down = within(0, m);
      if (!down) continue;
      const s = smallest(down[0], down[1], down[2], down[3]);
      if (s === 0) continue;
      const vol = area(s) * m + 256 * (Y1 - m);
      if (vol < bestVol) { bestVol = vol; best = { v: vid(2, s), lo: m, hi: Y1 }; }
    }
    return best;
  };
  /** A footprint box turned: the cell index turns as `cellAt` in the re-lay, so do its sixteenths. */
  const turnXZ = (x0: number, x1: number, z0: number, z1: number, r: number): [number, number, number, number] => {
    if (r === 90) return [16 - z1, 16 - z0, x0, x1];
    if (r === 180) return [16 - x1, 16 - x0, 16 - z1, 16 - z0];
    if (r === 270) return [z0, z1, 16 - x1, 16 - x0];
    return [x0, x1, z0, z1];
  };
  const turnForm = (form: ColliderForm, r: number): ColliderForm => {
    if (form.v === 0 || !r) return form;
    const d = VARIANTS[form.v]!, q = SHAPES[d.shape]!;
    const t = turnXZ(q[0], q[1], q[2], q[3], r);
    const s = smallest(t[0], t[1], t[2], t[3]);
    return { v: vid(d.kind, s), lo: form.lo, hi: form.hi };
  };
  const cols = (i: number, f: number): [number, number] => {
    const a = i * f, b = (i + 1) * f;
    if (f < 1) return [Math.floor(a), Math.max(Math.floor(a), Math.ceil(b) - 1)];
    return [Math.ceil(a - 0.5), Math.max(Math.ceil(a - 0.5), Math.ceil(b - 0.5) - 1)];
  };
  const cellPieces: ColliderFormKit['cellPieces'] = (x, y, z, v, lo, hi, dims, f, r, emit) => {
    const rc = r === 90 ? { x: dims.length - 1 - z, z: x } : r === 180 ? { x: dims.width - 1 - x, z: dims.length - 1 - z } : r === 270 ? { x: z, z: dims.width - 1 - x } : { x, z };
    const cx = cols(rc.x, f), cz = cols(rc.z, f), nx = cx[1] - cx[0] + 1, nz = cz[1] - cz[0] + 1;
    for (const b of formBoxes(v, lo, hi)) {
      const t = f < 1 ? [0, 16, 0, 16] : turnXZ(b[0], b[1], b[4], b[5], r);
      const wy0 = (y + b[2] / 16) * f, wy1 = (y + b[3] / 16) * f;
      const xa = cx[0] + t[0]! / 16 * nx, xb = cx[0] + t[1]! / 16 * nx, za = cz[0] + t[2]! / 16 * nz, zb = cz[0] + t[3]! / 16 * nz;
      for (let wy = Math.floor(wy0); wy < Math.ceil(wy1); wy++) {
        // The row arithmetic is the re-lay's, verbatim, so a full cell lays exactly what it always did.
        const l = Math.max(0, Math.min(15, Math.floor((wy0 - wy) * 16)));
        const h = Math.max(l + 1, Math.min(16, Math.ceil((wy1 - wy) * 16)));
        for (let wx = cx[0]; wx <= cx[1]; wx++) {
          const ux0 = Math.max(xa, wx) - wx, ux1 = Math.min(xb, wx + 1) - wx;
          if (ux1 - ux0 <= 1e-9) continue;
          const px0 = Math.max(0, Math.floor(ux0 * 16 + 1e-9)), px1 = Math.min(16, Math.ceil(ux1 * 16 - 1e-9));
          for (let wz = cz[0]; wz <= cz[1]; wz++) {
            const uz0 = Math.max(za, wz) - wz, uz1 = Math.min(zb, wz + 1) - wz;
            if (uz1 - uz0 <= 1e-9) continue;
            const pz0 = Math.max(0, Math.floor(uz0 * 16 + 1e-9)), pz1 = Math.min(16, Math.ceil(uz1 * 16 - 1e-9));
            emit(wx, wy, wz, [px0, Math.max(px0 + 1, px1), l, h, pz0, Math.max(pz0 + 1, pz1)]);
          }
        }
      }
    }
  };
  const lay: ColliderFormKit['lay'] = (block, form, loState, hiState, resolve) => {
    try {
      block.setPermutation(resolve(VARIANTS[form.v]!.id, { [loState]: form.lo, [hiState]: form.hi }));
      return true;
    } catch (e) {
      if (!form.v) throw e;
      const boxes = formBoxes(form.v, form.lo, form.hi);
      block.setPermutation(resolve(VARIANTS[0]!.id, { [loState]: Math.min(...boxes.map(b => b[2])), [hiState]: Math.max(...boxes.map(b => b[3])) }));
      return false;
    }
  };
  return { SHAPES, VARIANTS, variantOf: (id: string): number => (id in byId ? byId[id]! : -1), formBoxes, cover, turnForm, cellPieces, lay };
}

/** The kit, built once for the engine (the runtimes build their own from the serialised source). */
export const COLLIDER_KIT: ColliderFormKit = colliderFormKit();

/** Number of collider variants (43): block ids the pack defines. */
export const COLLIDER_VARIANT_COUNT = COLLIDER_KIT.VARIANTS.length;

/** The bounds of `ColliderBodyProbe.escape`, blocks unless named otherwise (`ESCAPE` gives the shipped values). */
export interface EscapeOptions {
  /** How far from `from` the flood's seeds may lie: points the body steps out to from where it sat. */
  seedReach: number;
  /** How far from `from` the flood walks. */
  radius: number;
  /** Lattice points the flood visits at most (its cost bound: the escape runs inside one game tick). */
  maxNodes: number;
  /** How far a walk may drop onto a floor below (a fall without damage). */
  drop: number;
  /** How far out the exterior rays reach. */
  exteriorReach: number;
  /** How far over `from` an exterior floor must be open to the sky, and how far below `from` it may lie. */
  headroom: number;
  depth: number;
}

/**
 * The shipped escape bounds (§9 of docs/physics-architecture.md). `SEED_REACH` is the ride set-down reach
 * (`RIDE.SETDOWN_REACH_BLOCKS`, 10797's nearest landing is 2 blocks from its terminal); `RADIUS` 16 covers a
 * 400 % room (a 4-block room at 100 %); `MAX_NODES` 600 half-block cells is a 12 x 12-block floor, a few tens of
 * thousands of cached block reads on the one tick a dismount fails; `DROP` 3 is the no-damage fall the rides use;
 * `EXTERIOR_REACH` 64 is past the half-width of the widest favourite at 400 % (10326's 31 blocks x 4 / 2);
 * `HEADROOM` 32 / `DEPTH` 96 span every favourite's height at 400 % above and below a seat.
 */
export const ESCAPE = { SEED_REACH: 2, RADIUS: 16, MAX_NODES: 600, DROP: 3, EXTERIOR_REACH: 64, HEADROOM: 32, DEPTH: 96 } as const;

/** `ESCAPE` as the probe's options. */
export const ESCAPE_OPTIONS: EscapeOptions = {
  seedReach: ESCAPE.SEED_REACH, radius: ESCAPE.RADIUS, maxNodes: ESCAPE.MAX_NODES, drop: ESCAPE.DROP,
  exteriorReach: ESCAPE.EXTERIOR_REACH, headroom: ESCAPE.HEADROOM, depth: ESCAPE.DEPTH,
};

/** What a runtime asks of a standing body over the pack's colliders (`colliderBodyProbe`). */
export interface ColliderBodyProbe {
  /** Whether a 0.6 x 1.8 body with its feet at `q` meets no collider form box and no other non-air block (unloaded counts as solid). */
  bodyFree(dim: any, q: { x: number; y: number; z: number }): boolean;
  /** The highest collision top under the body's footprint at (x, z), at most `fromY` and at least `fromY - depth`; undefined for none. */
  floorTop(dim: any, x: number, z: number, fromY: number, depth: number): number | undefined;
  /**
   * Whether `q` is a supported, body-free standing point with a swept one-block walking exit in one of the eight
   * compass directions. A body still in the air at `q` (a dismount set it a little up; it lands a tick or two
   * later) counts when it falls at most `fall` blocks (default 0), through a clear column, onto such a point.
   */
  hasWalkExit(dim: any, q: { x: number; y: number; z: number }, fall?: number): boolean;
  /**
   * Whether a body WALKS from `from` to `to` in a straight line: sampled every 1/8 block, each sample's floor within a
   * step up and `drop` down of the last and the body free on it. A start inside an obstruction (a seat in its chair,
   * a slide's run-out against bodywork) may first leave it; once free the line may not enter an obstruction again,
   * so a point beyond a wall is never reached THROUGH the wall. The end must be free.
   */
  routeClear(dim: any, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, drop: number): boolean;
  /**
   * The last-resort way out from `from` when no nearby point has a walk exit (`ESCAPE`): first the nearest standing
   * point WALK-CONNECTED to it (a breadth-first flood on a half-block lattice, every edge a `routeClear` walk, seeded
   * by the points within `seedReach` the body can step out to) that has a walk exit; else the model's EXTERIOR - the
   * nearest ring, along sixteen rays, holding a floor open to the sky over it with a walk exit at or under `from`'s
   * level, its lowest such floor (a roof over that level only when no ring has one). Undefined when neither exists
   * (an unloaded world, a void).
   */
  escape(dim: any, from: { x: number; y: number; z: number }, o: EscapeOptions): { at: { x: number; y: number; z: number }; how: 'walk' | 'exterior' } | undefined;
  /**
   * The nearest spot to `at` where a body stands FREE on a floor: the point itself lifted within a step
   * (9/16) out of a floor it sits in, else the nearest point on rings out to `reach` blocks (a floor within a
   * step over `at` down to `drop` under it). `at` itself when there is none.
   */
  settle(
    dim: any,
    at: { x: number; y: number; z: number },
    reach: number,
    drop: number,
    accept?: (q: { x: number; y: number; z: number }) => boolean,
  ): { x: number; y: number; z: number };
}

/**
 * The body probe a runtime builds from its collider kit and the collider blocks' state names. Self-contained
 * (it names only its arguments): the interactives and rides runtimes are handed its source, so a door that
 * steps a player out of its doorway and a ride that sets its rider down both put the body where it FITS - the
 * set-down points and step-outs had put players inside walls and floor slabs (simulator triage 2026-09-30).
 */
export function colliderBodyProbe(kit: ColliderFormKit, loState: string, hiState: string): ColliderBodyProbe {
  const HALF = 0.3, HEIGHT = 1.8, STEP = 9 / 16;
  // The walk exit (docs/physics-architecture.md §9, "Collider body probe"):
  //   FLOOR_TOLERANCE 1/16 - a body stands ON its floor within one collider sixteenth: forms and their tops are
  //     quantised to sixteenths, so a finer tolerance rejects a real floor and a coarser one accepts a hover;
  //   EXIT_DISTANCE 1 - the exit is a whole block: a half-block diagonal fits inside a sealed one-cell pocket
  //     when the start is near a corner (10796's slide pocket), a whole cell of walking does not;
  //   EXIT_SAMPLE 1/8 - the route is sampled far under the 0.6-block body width, so consecutive sampled bodies
  //     overlap and no wall, however thin, slips between two of them; and each 1/8 rise or fall is judged on
  //     its own against the 9/16 step, so a kerb is not averaged away.
  const FLOOR_TOLERANCE = 0.0625, EXIT_DISTANCE = 1, EXIT_SAMPLE = 0.125;
  /** The world boxes of the block at (bx, by, bz): a collider's form boxes, a full box for any other non-air block, [] for air; undefined when unloaded. */
  const boxesAt = (dim: any, bx: number, by: number, bz: number): Array<[number, number, number, number, number, number]> | undefined => {
    let b: any;
    try { b = dim.getBlock({ x: bx, y: by, z: bz }); } catch { b = undefined; }
    if (!b) return undefined;
    const v = kit.variantOf(b.typeId);
    if (v < 0) return b.isAir === false && b.isLiquid !== true ? [[bx, bx + 1, by, by + 1, bz, bz + 1]] : [];
    const lo = Number(b.permutation.getState(loState)), hi = Number(b.permutation.getState(hiState));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [[bx, bx + 1, by, by + 1, bz, bz + 1]];
    return kit.formBoxes(v, lo, hi).map(w => [bx + w[0] / 16, bx + w[1] / 16, by + w[2] / 16, by + w[3] / 16, bz + w[4] / 16, bz + w[5] / 16]);
  };
  const bodyFree = (dim: any, q: { x: number; y: number; z: number }): boolean => {
    const x0 = q.x - HALF, x1 = q.x + HALF, y0 = q.y + 0.01, y1 = q.y + HEIGHT, z0 = q.z - HALF, z1 = q.z + HALF;
    for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++) for (let by = Math.floor(y0); by <= Math.floor(y1); by++) for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) {
      const boxes = boxesAt(dim, bx, by, bz);
      if (!boxes) return false;
      for (const w of boxes) if (w[1] > x0 && w[0] < x1 && w[3] > y0 && w[2] < y1 && w[5] > z0 && w[4] < z1) return false;
    }
    return true;
  };
  const floorTop = (dim: any, x: number, z: number, fromY: number, depth: number): number | undefined => {
    const x0 = x - HALF, x1 = x + HALF, z0 = z - HALF, z1 = z + HALF;
    let top: number | undefined;
    for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++) for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) for (let by = Math.floor(fromY); by >= Math.floor(fromY - depth); by--) {
      const boxes = boxesAt(dim, bx, by, bz);
      if (!boxes) continue;
      for (const w of boxes) {
        if (!(w[1] > x0 && w[0] < x1 && w[5] > z0 && w[4] < z1)) continue;
        if (w[3] <= fromY + 1e-6 && w[3] >= fromY - depth - 1e-6 && (top === undefined || w[3] > top)) top = w[3];
      }
    }
    return top;
  };
  /**
   * Where a body at `q` comes to stand: `q` on its floor (within a sixteenth), else - for a body in the air - the
   * floor at most `fall` under it, the body free all the way down (checked a block at a time: the 1.8-block body
   * overlaps every step). Undefined for neither.
   */
  const landing = (dim: any, q: { x: number; y: number; z: number }, fall: number): { x: number; y: number; z: number } | undefined => {
    if (!bodyFree(dim, q)) return undefined;
    const support = floorTop(dim, q.x, q.z, q.y + FLOOR_TOLERANCE, FLOOR_TOLERANCE * 2);
    if (support !== undefined && Math.abs(support - q.y) <= FLOOR_TOLERANCE) return q;
    if (!(fall > 0)) return undefined;
    const top = floorTop(dim, q.x, q.z, q.y, fall);
    if (top === undefined) return undefined;
    for (let y = q.y - 1; y > top; y--) if (!bodyFree(dim, { x: q.x, y, z: q.z })) return undefined;
    const at = { x: q.x, y: top, z: q.z };
    return bodyFree(dim, at) ? at : undefined;
  };
  const hasWalkExit = (dim: any, q0: { x: number; y: number; z: number }, fall = 0): boolean => {
    const q = landing(dim, q0, fall);
    if (!q) return false;
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const samples = Math.ceil(EXIT_DISTANCE / EXIT_SAMPLE);
    for (const d of directions) {
      const n = Math.hypot(d[0]!, d[1]!);
      let y = q.y, open = true;
      for (let i = 1; i <= samples; i++) {
        const distance = Math.min(EXIT_DISTANCE, i * EXIT_SAMPLE);
        const x = q.x + d[0]! / n * distance, z = q.z + d[1]! / n * distance;
        const floor = floorTop(dim, x, z, y + STEP, STEP * 2);
        if (floor === undefined || Math.abs(floor - y) > STEP || !bodyFree(dim, { x, y: floor, z })) { open = false; break; }
        y = floor;
      }
      if (open) return true;
    }
    return false;
  };
  const routeClear = (dim: any, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, drop: number): boolean => {
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / EXIT_SAMPLE));
    let y = from.y, free = bodyFree(dim, from);
    for (let i = 1; i <= n; i++) {
      const x = from.x + (to.x - from.x) * i / n, z = from.z + (to.z - from.z) * i / n;
      const floor = floorTop(dim, x, z, y + STEP, STEP + drop);
      if (floor !== undefined && bodyFree(dim, { x, y: floor, z })) { y = floor; free = true; continue; }
      // Blocked here: still leaving the obstruction the start sat in, or a wall met after open floor.
      if (free) return false;
    }
    return free;
  };
  const escape = (dim0: any, from: { x: number; y: number; z: number }, o: EscapeOptions): { at: { x: number; y: number; z: number }; how: 'walk' | 'exterior' } | undefined => {
    // One escape reads the same blocks many times over: memoise them for this call only (the world may change by the next tick).
    const memo = new Map<string, any>();
    const dim = { getBlock: (p: { x: number; y: number; z: number }): any => {
      const k = `${p.x},${p.y},${p.z}`;
      if (memo.has(k)) return memo.get(k);
      let b: any;
      try { b = dim0.getBlock(p); } catch { b = undefined; }
      memo.set(k, b);
      return b;
    } };
    // 1. The walk-connected flood on a half-block lattice about `from`.
    const G = 0.5, R = Math.ceil(o.radius / G), S = o.seedReach / G;
    const standAt = (x: number, z: number, nearY: number): { x: number; y: number; z: number } | undefined => {
      const t = floorTop(dim, x, z, nearY + STEP, STEP + o.drop);
      if (t === undefined) return undefined;
      const q = { x, y: t, z };
      return bodyFree(dim, q) ? q : undefined;
    };
    const queue: Array<{ i: number; k: number; q: { x: number; y: number; z: number } }> = [];
    const seen = new Set<string>();
    const seeds: Array<{ i: number; k: number; d: number }> = [];
    for (let i = -Math.ceil(S); i <= Math.ceil(S); i++) for (let k = -Math.ceil(S); k <= Math.ceil(S); k++) {
      const d = Math.hypot(i, k);
      if (d <= S + 1e-9) seeds.push({ i, k, d });
    }
    seeds.sort((a, b) => a.d - b.d);
    for (const s of seeds) {
      const q = standAt(from.x + s.i * G, from.z + s.k * G, from.y);
      if (!q || !routeClear(dim, from, q, o.drop)) continue;
      seen.add(`${s.i},${s.k}`);
      queue.push({ i: s.i, k: s.k, q });
    }
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let head = 0; head < queue.length && head < o.maxNodes; head++) {
      const c = queue[head]!;
      if (hasWalkExit(dim, c.q)) return { at: c.q, how: 'walk' };
      for (const d of dirs) {
        const i = c.i + d[0]!, k = c.k + d[1]!, key = `${i},${k}`;
        if (seen.has(key) || Math.hypot(i, k) > R) continue;
        const q = standAt(from.x + i * G, from.z + k * G, c.q.y);
        if (!q || !routeClear(dim, c.q, q, o.drop)) continue;
        seen.add(key);
        queue.push({ i, k, q });
      }
    }
    // 2. The exterior: along sixteen rays, ring by ring, the highest floor under each column, open over it up to
    //    `headroom` above `from` (nothing of the model overhead), with a walk exit; the lowest of a ring's floors
    //    (the ground beside the model rather than a roof).
    const footprintBoxes = (x: number, z: number, by: number): number | undefined | null => {
      // The top of the highest box in block layer `by` under a body's footprint at (x, z); null for none; undefined unloaded.
      let top: number | null = null;
      for (let bx = Math.floor(x - HALF); bx <= Math.floor(x + HALF); bx++) for (let bz = Math.floor(z - HALF); bz <= Math.floor(z + HALF); bz++) {
        const boxes = boxesAt(dim, bx, by, bz);
        if (!boxes) return undefined;
        for (const w of boxes) if (w[1] > x - HALF && w[0] < x + HALF && w[5] > z - HALF && w[4] < z + HALF && (top === null || w[3] > top)) top = w[3];
      }
      return top;
    };
    const skyFloor = (x: number, z: number): number | undefined => {
      for (let by = Math.floor(from.y + o.headroom); by >= Math.floor(from.y - o.depth); by--) {
        const top = footprintBoxes(x, z, by);
        if (top === undefined) { if (by < from.y) return undefined; continue; } // unloaded overhead reads as sky; underfoot it is no floor
        if (top !== null) return top;
      }
      return undefined;
    };
    // A floor more than a step over `from` is a roof (the top of the very wall that sealed the pocket, at the first
    // ring): it is taken only when no ring out to `exteriorReach` holds a floor at or under the seat's level.
    let roof: { x: number; y: number; z: number } | undefined;
    for (let r = 1; r <= o.exteriorReach; r++) {
      let best: { x: number; y: number; z: number } | undefined;
      for (let a = 0; a < 16; a++) {
        const t = (a / 16) * Math.PI * 2, x = from.x + Math.cos(t) * r, z = from.z + Math.sin(t) * r;
        const y = skyFloor(x, z);
        if (y === undefined) continue;
        const q = { x, y, z };
        if (y > from.y + STEP) { if (!roof && hasWalkExit(dim, q)) roof = q; continue; }
        if ((!best || y < best.y) && hasWalkExit(dim, q)) best = q;
      }
      if (best) return { at: best, how: 'exterior' };
    }
    return roof ? { at: roof, how: 'exterior' } : undefined;
  };
  const settle = (
    dim: any,
    at: { x: number; y: number; z: number },
    reach: number,
    drop: number,
    accept?: (q: { x: number; y: number; z: number }) => boolean,
  ): { x: number; y: number; z: number } => {
    const standAt = (x: number, z: number): { x: number; y: number; z: number } | undefined => {
      const t = floorTop(dim, x, z, at.y + STEP, STEP + drop);
      if (t === undefined) return undefined;
      const q = { x, y: t, z };
      return bodyFree(dim, q) && (!accept || accept(q)) ? q : undefined;
    };
    const here = standAt(at.x, at.z);
    if (here) return here;
    for (let r = 0.25; r <= reach + 1e-9; r += 0.25) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const q = standAt(at.x + Math.cos(a) * r, at.z + Math.sin(a) * r);
        if (q) return q;
      }
    }
    return at;
  };
  return { bodyFree, floorTop, hasWalkExit, routeClear, escape, settle };
}

// ─── The blocks' definitions (the pack's `blocks/*.json`) ─────────────────────

/** The two states every collider form carries: its sixteenth span (the pack writer's `COLLIDER_LO_STATE` / `_HI_STATE`). */
export const COLLIDER_STATES = { lo: 'craftmatic:lo', hi: 'craftmatic:hi' } as const;

/**
 * A form box (sixteenths, world axes) as a Bedrock collision box: origin from
 * the block's bottom centre, pixels. **Bedrock MIRRORS a custom block's
 * collision-box x** (Pixel GameTest 2026-09-30, `quirk_bands`,
 * `output/gametest-quirks-0930/run2/cmgt.log` QBANDS): a box declared at
 * origin x -8, size 8 stands on the block's HIGH-x half in the world, while z
 * and y are as written. So a box on world x [x0, x1] is declared at origin x
 * `8 - x1`. Until this fix every x-banded clearance form (`_w1`..`_w7` and
 * the x-shaped `_f`/`_c` forms) stood on the wrong half of its block (quirk
 * `block-collision-x-mirrored`).
 */
export const collisionBox = (b: readonly number[]): { origin: number[]; size: number[] } => ({ origin: [8 - b[1]!, b[2]!, b[4]! - 8], size: [b[1]! - b[0]!, b[3]! - b[2]!, b[5]! - b[4]!] });

/** Every (lo, hi) pair with lo < hi: 136 permutations, each laying variant `v`'s boxes. */
const colliderPermutations = (v = 0): unknown[] => {
  const out: unknown[] = [];
  for (let l = 0; l < 16; l++) for (let h = l + 1; h <= 16; h++) {
    const boxes = COLLIDER_KIT.formBoxes(v, l, h).map(collisionBox);
    out.push({
      condition: `q.block_state('${COLLIDER_STATES.lo}') == ${l} && q.block_state('${COLLIDER_STATES.hi}') == ${h}`,
      components: { 'minecraft:collision_box': boxes.length === 1 ? boxes[0] : boxes },
    });
  }
  return out;
};

/**
 * The behaviour-pack block definition of collider variant `v` (0: the
 * full-footprint `craftmatic:collider`; the others are the clearance forms).
 * A floor + wall or wall + ceiling form is two boxes, which Bedrock accepts as
 * an array from format 1.26.0 (Microsoft Learn, minecraft:collision_box), so
 * those blocks declare it; the others keep the format the collider has always
 * had. The pack ships exactly this; the walk worlds (addon-walk.ts) and the
 * simulator read their collision from it, so there is one reading of a form.
 */
export function colliderBlockDefinition(v = 0): unknown {
  const variant = COLLIDER_KIT.VARIANTS[v]!;
  const base = COLLIDER_KIT.formBoxes(v, 0, 16).map(collisionBox);
  return {
    format_version: variant.kind === 0 ? '1.21.40' : '1.26.0',
    'minecraft:block': {
      description: {
        identifier: variant.id,
        menu_category: { category: 'none' },
        states: {
          [COLLIDER_STATES.lo]: { values: { min: 0, max: 15 } },
          [COLLIDER_STATES.hi]: { values: { min: 1, max: 16 } },
        },
      },
      components: {
        'minecraft:geometry': 'minecraft:geometry.full_block',
        'minecraft:material_instances': { '*': { texture: 'craftmatic_collider', render_method: 'alpha_test', face_dimming: false, ambient_occlusion: false } },
        'minecraft:collision_box': base.length === 1 ? base[0] : base,
        'minecraft:selection_box': false,
        'minecraft:light_dampening': 0,
        'minecraft:destructible_by_mining': { seconds_to_destroy: 0.5 },
        'minecraft:destructible_by_explosion': false,
        'minecraft:friction': 0.6,
      },
      permutations: colliderPermutations(v),
    },
  };
}
