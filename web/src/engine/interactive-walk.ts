/**
 * Can a player actually walk through a doorway of a built pack? The offline
 * answer to "ensure the player can physically get past when open", measured
 * over the exact collider blocks the pack ships (`WalkWorld`, the runtime's own
 * re-lay arithmetic) plus the closed leaves the interactives runtime lays
 * (`ixClosedBlocks`, the runtime's own `layDoorway` state), with the walk
 * module's per-tick Minecraft player (0.6 x 1.8 box, step, jump, gravity).
 *
 * For one doorway at one size and turn: find a standable spot on each side
 * along the leaf's normal (1 to 4 blocks out, scaled), put the player on one
 * side and steer it at the other for up to `MAX_TICKS`, jumping when a move
 * is clipped. It PASSES when the player's feet cross the leaf plane by at
 * least `CROSS_MARGIN` blocks. With the door open that must happen (when the
 * opening is passable at that size); with it closed it must not.
 *
 * Pure: no Bedrock API, no DOM - vitest and a CLI (`scripts/_ix_passability.ts`) run it.
 */

import { ixClosedBlocks, ixWorldBlocks, type InteractiveRuntimeConfig } from './bedrock-interactives.js';
import { COLLIDER_KIT } from './collider-form.js';
import { PLAYER_WIDTH_BLOCKS } from './addon-scale.js';
import { NO_INPUT, WalkWorld, modelPointToWorld, playerBox, tickPlayer, type PlayerState, type SolidBox, type WalkWorldOptions } from './addon-walk.js';
import type { QuarterTurn, SourceCell, TreadBlock } from './bedrock-collider-scale.js';

/** Ticks the walk gets (10 s at 20 ticks/s): a 4-block approach, a jump or two. */
export const MAX_TICKS = 200;
/** Blocks past the leaf plane the feet must reach to count as through. */
export const CROSS_MARGIN = 0.7;
/** The route search's window around the doorway (blocks at 100 %, scaled with the size). */
const WINDOW_BLOCKS = 6;
/** The player's rise per move (a jump) and the deepest drop the route takes (blocks at 100 %, scaled). */
const JUMP_RISE = 1.25;
const MAX_DROP = 3;
/** Headroom the route needs over a floor: the player's height. */
const PLAYER_NEED = 1.8;
/** How close to a waypoint's column centre counts as there, and ticks without progress before the walk gives up. */
const WAYPOINT_REACH = 0.3;
const STALL_TICKS = 30;
/** How far (blocks at 100 %) a doorway column's floor may sit from the leaf's foot, and how far past the leaf plane an approach spot must be. */
const DOOR_FLOOR_SLACK = 1.0;
const SIDE_CLEARANCE = 0.9;
/**
 * How much of a column a clearance form must leave free along its thin axis
 * for the route to treat the column as open (blocks). With half a column free
 * the player (0.6) stands at the free part's centre leaning 0.05 into the next
 * column; the route also refuses a move across a face a form closes
 * (`acrossFace`), and the per-tick player is the judge. Measured over the 40
 * favourites (2026-09-25): 0.5 with the face test, 0 FAIL; without the face
 * test and aiming at column centres, a route ran through a door frame's thin
 * wall and read FAIL (42639 Door 1, 76417 Door 3 at 200 %).
 */
const ROOMY_FREE = 0.5;

export interface DoorwayWalkResult {
  index: number;
  label: string;
  sizePct: number;
  rotation: QuarterTurn;
  open: boolean;
  /** Whether the part is expected to be passable at this size (`passSize`). */
  passableAtSize: boolean;
  /**
   * 'passed': walked through; 'blocked': could not; 'no-approach': no
   * standable spot on one side; 'sealed': open, one side cannot reach the
   * doorway at all - the model has solid geometry there (a false door).
   */
  outcome: 'passed' | 'blocked' | 'no-approach' | 'sealed';
  /** Both directions tried; `passed` when either direction got through. */
  directions: Array<{ from: -1 | 1; outcome: 'passed' | 'blocked' | 'no-approach'; reason?: 'no-path' | 'no-spot' | 'physics' | 'one-way'; ticks: number; crossed: number; jumps?: number; start?: { x: number; y: number; z: number }; end?: { x: number; y: number; z: number } }>;
  /** The doorway's centre in world blocks from the pin, and the walk's normal. */
  centre: { x: number; y: number; z: number };
  normal: { x: number; z: number };
  /** The side (along `normal`) a player only DROPS into from the doorway: walked out, never back in past the jump. */
  oneWay?: -1 | 1;
}

/** Optional debugging record: each direction's route (column centres) and the player's feet per tick. */
export interface DoorwayWalkTrace {
  routes: Array<{ from: -1 | 1; way: Array<{ x: number; y: number; z: number }> }>;
  tracks: Array<{ from: -1 | 1; points: Array<{ x: number; y: number; z: number }> }>;
}

/** Everything the walk needs from a pack (a subset of `AddonPreviewModel`). */
export interface DoorwayWalkPack {
  cells: readonly SourceCell[];
  dims: { width: number; height: number; length: number };
  interactives: InteractiveRuntimeConfig;
  shippedTreads?: (sizePct: number, rotation: QuarterTurn) => readonly TreadBlock[] | undefined;
  /**
   * Build the walk world from the options the walk would use (default
   * `new WalkWorld`). A diagnostic walks the same doorway over another
   * world - the model's own part geometry (`scripts/_ix_sealed_causes.ts`) -
   * to tell a doorway the MODEL seals from one its colliders seal.
   */
  makeWorld?: (options: WalkWorldOptions) => WalkWorld;
}

/** A model-frame direction turned by the placement's quarter turn (the translation cancels). */
function turnDirection(d: { x: number; z: number }, dims: { width: number; height: number; length: number }, r: QuarterTurn): { x: number; z: number } {
  const a = modelPointToWorld({ x: 0, y: 0, z: 0 }, dims, 1, r), b = modelPointToWorld({ x: d.x, y: 0, z: d.z }, dims, 1, r);
  const x = b.x - a.x, z = b.z - a.z, l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

/** Whether a player box with feet at (x, y, z) overlaps any solid. */
export function boxFree(world: WalkWorld, x: number, y: number, z: number): boolean {
  const box = playerBox({ x, y, z });
  for (const s of world.solidsNear(box, 0, 0, 0)) {
    if (s.ground) { if (y < -1e-6) return false; continue; }
    if (box.x1 > s.x0 + 1e-7 && box.x0 < s.x1 - 1e-7 && box.y1 > s.y0 + 1e-7 && box.y0 < s.y1 - 1e-7 && box.z1 > s.z0 + 1e-7 && box.z0 < s.z1 - 1e-7) return false;
  }
  return true;
}

/** How far ahead (blocks) `jumpHelps` looks for what stopped a move. */
const JUMP_PROBE = 0.3;

/**
 * Whether a jump helps a player on the ground moving along (dx, dz), a unit
 * direction: the box a short reach ahead is blocked at the feet and free a
 * jump up (a sill, a step, a raised floor). A wall that runs up past the jump
 * is slid along, not jumped at - a real player brushing a jamb keeps walking.
 * The walks jumped on ANY clipped move, so a doorway approached at a slant
 * with a wall beside it (31141's 45-degree Door 4, a floor stepping down to
 * the sill beside a wall) jumped through the leaf plane and counted as not
 * walked through at the doorway's floor.
 */
export function jumpHelps(world: WalkWorld, s: PlayerState, dx: number, dz: number): boolean {
  const ax = s.x + dx * JUMP_PROBE, az = s.z + dz * JUMP_PROBE;
  return !boxFree(world, ax, s.y + 1e-3, az) && boxFree(world, ax, s.y + JUMP_RISE + 1e-3, az);
}

/** Settle a player dropped at (x, y, z): tick with no input until it rests; undefined if it falls more than `maxDrop`. */
function settle(world: WalkWorld, x: number, y: number, z: number, maxDrop: number): PlayerState | undefined {
  let s: PlayerState = { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 };
  for (let i = 0; i < 40; i++) {
    s = tickPlayer(world, s, NO_INPUT).state;
    if (s.onGround) break;
  }
  if (!s.onGround || y - s.y > maxDrop) return undefined;
  return s;
}

/** The local surface graph over one world: columns within a window, the tops a player can stand on, and 4-connected moves between them. */
function surfaceGraph(world: WalkWorld, window: { x0: number; x1: number; z0: number; z1: number }, k: number) {
  /**
   * The boxes that fill a column for the ROUTE: a clearance form's box
   * (collider-form.ts, a wall pulled back to its geometry) that leaves at
   * least `ROOMY_FREE` of the column free along its thin axis does not - the
   * player's centre can stand in the free part - and it is no floor either.
   * The per-tick player then collides with the real boxes, so the route is a
   * guide and the physics is the judge.
   */
  const filling = (x: number, z: number): SolidBox[] => world.boxesInColumn(x, z).filter(b => {
    const freeX = Math.max(b.x0 - x, x + 1 - b.x1), freeZ = Math.max(b.z0 - z, z + 1 - b.z1);
    return !((b.z1 - b.z0 >= 1 - 1e-6 && freeX >= ROOMY_FREE - 1e-6) || (b.x1 - b.x0 >= 1 - 1e-6 && freeZ >= ROOMY_FREE - 1e-6));
  });
  const clear = (x: number, z: number, y0: number, y1: number): boolean => filling(x, z).every(b => b.y1 <= y0 + 1e-6 || b.y0 >= y1 - 1e-6);
  const topsCache = new Map<string, number[]>();
  const tops = (x: number, z: number): number[] => {
    const key = `${x},${z}`;
    let t = topsCache.get(key);
    if (t) return t;
    const boxes = filling(x, z);
    t = [0, ...boxes.map(b => b.y1)].filter(y => clear(x, z, y, y + PLAYER_NEED)).filter(y => y > 0 || boxes.every(b => b.y0 >= PLAYER_NEED - 1e-6 || b.y1 <= 1e-6));
    topsCache.set(key, t);
    return t;
  };
  /**
   * Neighbour surfaces a player can move to from (x, z, t): a jump up, any
   * drop within reach (`twoWay`: only moves the player could also make BACK,
   * a rise or a drop within the jump), both columns clear at the higher floor.
   */
  const moves = (x0: number, z0: number, t0: number, twoWay = false): Array<{ x: number; z: number; t: number }> => {
    const out: Array<{ x: number; z: number; t: number }> = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const x = x0 + dx, z = z0 + dz;
      if (x < window.x0 || x > window.x1 || z < window.z0 || z > window.z1) continue;
      for (const t of tops(x, z)) {
        const rise = t - t0;
        if (rise > JUMP_RISE + 1e-6 || -rise > (twoWay ? JUMP_RISE + 1e-6 : MAX_DROP * k)) continue;
        const hi = Math.max(t, t0);
        if (!clear(x, z, hi, hi + PLAYER_NEED) || !clear(x0, z0, hi, hi + PLAYER_NEED)) continue;
        // A drop falls through the neighbour column from the origin's height to its floor: that span must be
        // free too (`ScaledColliderGrid.canMove`'s rule) - or a route steps off a roof through the ceiling below
        // (42663's Door 1 at 200 %, once clearance gave its far side an approach).
        if (t < t0 && !clear(x, z, t, t0 + PLAYER_NEED)) continue;
        if (!acrossFace(x0, z0, x, z, hi)) continue;
        out.push({ x, z, t });
      }
    }
    return out;
  };
  /**
   * The part of a column a clearance form leaves free over the player's body
   * at floor `t`: `[ax, bx]` along x and `[az, bz]` along z, column-relative
   * (the whole column when no form stands there). The route only counts
   * columns whose free part is at least `ROOMY_FREE` wide (`filling`).
   */
  const freePart = (x: number, z: number, t: number): { ax: number; bx: number; az: number; bz: number } => {
    let ax = 0, bx = 1, az = 0, bz = 1;
    for (const b of world.boxesInColumn(x, z)) {
      if (b.y1 <= t + 1e-6 || b.y0 >= t + PLAYER_NEED - 1e-6) continue;
      if (b.z1 - b.z0 >= 1 - 1e-6 && b.x1 - b.x0 < 1 - 1e-6) {
        const l = b.x0 - x, r = b.x1 - x;
        if (l >= 1 - r) bx = Math.min(bx, l); else ax = Math.max(ax, r);
      } else if (b.x1 - b.x0 >= 1 - 1e-6 && b.z1 - b.z0 < 1 - 1e-6) {
        const l = b.z0 - z, r = b.z1 - z;
        if (l >= 1 - r) bz = Math.min(bz, l); else az = Math.max(az, r);
      }
    }
    return { ax, bx, az, bz };
  };
  /** Where a player stands in a column at floor `t`: the centre of its free part. */
  const standAt = (x: number, z: number, t: number): { x: number; z: number } => {
    const f = freePart(x, z, t);
    return { x: x + (f.bx > f.ax ? (f.ax + f.bx) / 2 : 0.5), z: z + (f.bz > f.az ? (f.az + f.bz) / 2 : 0.5) };
  };
  /**
   * Whether a player can cross the face between two neighbouring columns at
   * height `t`: a wall pulled back to the shared face (a thin wall right on
   * the boundary) closes it however roomy each column is, and side by side
   * the two free parts must overlap by a player's width. Without this a
   * route ran straight through a door frame's thin wall (42639's Door 1).
   */
  const acrossFace = (x0: number, z0: number, x1: number, z1: number, t: number): boolean => {
    const a = freePart(x0, z0, t), b = freePart(x1, z1, t);
    const W = PLAYER_WIDTH_BLOCKS;
    if (x1 > x0) return a.bx >= 1 - 1e-6 && b.ax <= 1e-6 && Math.min(a.bz, b.bz) - Math.max(a.az, b.az) >= W - 1e-6;
    if (x1 < x0) return a.ax <= 1e-6 && b.bx >= 1 - 1e-6 && Math.min(a.bz, b.bz) - Math.max(a.az, b.az) >= W - 1e-6;
    if (z1 > z0) return a.bz >= 1 - 1e-6 && b.az <= 1e-6 && Math.min(a.bx, b.bx) - Math.max(a.ax, b.ax) >= W - 1e-6;
    return a.az <= 1e-6 && b.bz >= 1 - 1e-6 && Math.min(a.bx, b.bx) - Math.max(a.ax, b.ax) >= W - 1e-6;
  };
  return { tops, moves, standAt, freePart };
}

/** The fine route's lattice step (blocks): an eighth of a block, twice the resolution of a clearance form's quarter bands. */
const LATTICE_STEP = 1 / 8;
/** How far past the leaf plane (blocks at 100 %, scaled with the size) the fine route searches, both ways. */
const LATTICE_REACH = 3;

/** A lattice position across the doorway's corridor: `a` steps along the normal, `l` steps across it, `t` the floor it stands on. */
interface LatticeNode { a: number; l: number; t: number; prev: LatticeNode | null }

/**
 * The FINE route over a walk world's exact boxes: a 1/8-block lattice across
 * the doorway's corridor (the leaf's span less half a player, straight along
 * the leaf's normal, `LATTICE_REACH` blocks both ways). The column graph
 * (`surfaceGraph`) reasons about one column at a time, so a passage that
 * straddles a column boundary - a 0.85-block gap between two thin walls, each
 * column less than half free - is invisible to it: 21318's Door 1 and 41732's
 * Door 3 read SEALED / ONE-WAY over colliders a 0.6 x 1.8 box sweeps through
 * (`scripts/_ix_sealed_causes.ts`, 2026-09-29). The walk falls back to this
 * lattice only where the column graph finds no approach or no route, and the
 * per-tick player is still the judge of every route it proposes.
 *
 * A move steps one lattice point along or across, onto the highest free
 * support within a jump (`JUMP_RISE`) up and `drop` down, and the player's
 * box must be free at the higher of the two floors at both ends (a jump's head
 * room, a drop's step off the edge). It crosses the leaf's plane only in the
 * doorway (within a quarter block of the plane, within `slack` of the
 * doorway's floor), as the column searches (`crossesAtDoor`).
 */
function doorwayLattice(world: WalkWorld, centre: { x: number; y: number; z: number }, n: { x: number; z: number }, halfSpan: number, k: number, slack: number, avoid: (x: number, z: number) => boolean = () => false, beside: (x: number, z: number) => boolean = () => false) {
  const u = { x: -n.z, z: n.x };
  const reach = Math.ceil(LATTICE_REACH * k / LATTICE_STEP);
  const lat = Math.floor(Math.max(0, halfSpan - PLAYER_WIDTH_BLOCKS / 2) / LATTICE_STEP);
  const at = (a: number, l: number): { x: number; z: number } => ({ x: centre.x + (n.x * a + u.x * l) * LATTICE_STEP, z: centre.z + (n.z * a + u.z * l) * LATTICE_STEP });
  const half = PLAYER_WIDTH_BLOCKS / 2;
  /** Solid tops under the player's footprint at (x, z) within [y0, y1], and the ground plane (0). */
  const tops = (x: number, z: number, y0: number, y1: number): number[] => {
    const box = { x0: x - half, x1: x + half, y0, y1, z0: z - half, z1: z + half };
    const out = new Set<number>([0]);
    for (const s of world.solidsNear(box, 0, 0, 0)) {
      if (s.ground || s.x1 <= box.x0 + 1e-7 || s.x0 >= box.x1 - 1e-7 || s.z1 <= box.z0 + 1e-7 || s.z0 >= box.z1 - 1e-7) continue;
      if (s.y1 >= y0 - 1e-6 && s.y1 <= y1 + 1e-6) out.add(Math.round(s.y1 * 16) / 16);
    }
    return [...out].filter(t => t >= y0 - 1e-6 && t <= y1 + 1e-6).sort((p, q) => q - p);
  };
  /** Where a player stepping from height `y` into (x, z) stands: the highest free support within a jump up and `drop` down. */
  const land = (x: number, z: number, y: number, drop: number): number | undefined => {
    for (const t of tops(x, z, y - drop, y + JUMP_RISE)) if (boxFree(world, x, t + 1e-3, z)) return t;
    return undefined;
  };
  const key = (m: { a: number; l: number; t: number }): string => `${m.a},${m.l},${Math.round(m.t * 16)}`;
  /** A lattice node in the doorway: at the leaf plane (a quarter block either side), standing within `slack` of its floor. */
  const atDoor = (m: { a: number; t: number }): boolean => Math.abs(m.a * LATTICE_STEP) <= 0.25 + 1e-9 && Math.abs(m.t - centre.y) <= slack + 1e-6;
  /** The lattice moves out of `node`: `drop` the deepest step down, `outward` only away from the leaf plane and never up. */
  const moves = (node: LatticeNode, drop: number, outward = false): LatticeNode[] => {
    const out: LatticeNode[] = [];
    const from = at(node.a, node.l);
    for (const [da, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const a = node.a + da, l = node.l + dl;
      if (Math.abs(a) > reach || Math.abs(l) > lat) continue;
      if (outward && Math.abs(a) < Math.abs(node.a)) continue;
      const p = at(a, l);
      const t = land(p.x, p.z, node.t, drop);
      if (t === undefined || (outward && t > node.t + 1e-6)) continue;
      if (Math.sign(a) !== Math.sign(node.a) && !atDoor(node) && !atDoor({ a, t })) continue;
      const hi = Math.max(t, node.t);
      if (!boxFree(world, from.x, hi + 1e-3, from.z) || !boxFree(world, p.x, hi + 1e-3, p.z)) continue;
      out.push({ a, l, t, prev: node });
    }
    return out;
  };
  /** Lattice nodes at the leaf plane (one step either side of it) whose floor is within `slack` of the doorway's floor. */
  const starts = (slack: number): LatticeNode[] => {
    const out: LatticeNode[] = [];
    for (let l = -lat; l <= lat; l++) for (const a of [0, 1, -1]) {
      const p = at(a, l);
      for (const t of tops(p.x, p.z, centre.y - slack, centre.y + slack)) {
        if (!boxFree(world, p.x, t + 1e-3, p.z)) continue;
        out.push({ a, l, t, prev: null });
        break;
      }
    }
    return out;
  };
  /**
   * Breadth-first from `from` over moves of at most `drop` down (only those
   * `keep` takes); `accept` ends the search at the first node it takes
   * (returned), undefined when none.
   */
  const search = (from: readonly LatticeNode[], drop: number, accept: (m: LatticeNode) => boolean, outward = false, keep: (m: LatticeNode) => boolean = () => true): LatticeNode | undefined => {
    const seen = new Set(from.map(key));
    const q = [...from];
    for (let h = 0; h < q.length; h++) {
      const node = q[h]!;
      if (accept(node)) return node;
      for (const m of moves(node, drop, outward)) {
        if (!keep(m)) continue;
        const kk = key(m);
        if (seen.has(kk)) continue;
        seen.add(kk);
        q.push(m);
      }
    }
    return undefined;
  };
  /** The lattice node nearest a world point standing on floor `y`. */
  const snap = (p: { x: number; y: number; z: number }): LatticeNode => ({
    a: Math.round(((p.x - centre.x) * n.x + (p.z - centre.z) * n.z) / LATTICE_STEP),
    l: Math.max(-lat, Math.min(lat, Math.round(((p.x - centre.x) * u.x + (p.z - centre.z) * u.z) / LATTICE_STEP))),
    t: Math.round(p.y * 16) / 16, prev: null,
  });
  /**
   * A route from `a` to `b` THROUGH the doorway (world points along the path,
   * every third lattice point and the last), or null: it must pass a lattice
   * point at the leaf plane (within a quarter block) standing within `slack`
   * of the doorway's floor - the column route's `atDoor` - or a route under a
   * raised doorway (the ground under 42670's house at 200 %) would count.
   */
  const route = (a: LatticeNode, b: LatticeNode, drop: number): Array<{ x: number; y: number; z: number }> | null => {
    type R = LatticeNode & { door: boolean };
    const first: R = { ...a, prev: null, door: atDoor(a) };
    const seen = new Set([`${key(first)}:${first.door}`]);
    const q: R[] = [first];
    let end: R | undefined;
    for (let h = 0; h < q.length && !end; h++) {
      const node = q[h]!;
      if (node.door && node.a === b.a && node.l === b.l && Math.abs(node.t - b.t) <= 1 / 16 + 1e-6) { end = node; break; }
      for (const m of moves(node, drop)) {
        const door = node.door || atDoor(m);
        const kk = `${key(m)}:${door}`;
        if (seen.has(kk)) continue;
        seen.add(kk);
        q.push({ ...m, door });
      }
    }
    if (!end) return null;
    const path: LatticeNode[] = [];
    for (let p: LatticeNode | null = end; p; p = p.prev) path.unshift(p);
    return path.filter((_, i) => i % 3 === 0 || i === path.length - 1).map(m => { const p = at(m.a, m.l); return { x: p.x, y: m.t, z: p.z }; });
  };
  /**
   * Whether a player standing at `node` can go ON from there: a two-way
   * lattice walk (rises and drops within the jump) that never comes nearer
   * the leaf's plane, never enters an avoided column (a leaf's), and reaches
   * a point a whole block away. A node with none is a dead end: 910004's
   * Door 3 opens onto a 0.75-block alcove between the leaf and a step up
   * under the ceiling's edge (furniture a stud inside the door), where the
   * walk stood and called the doorway OK while the room beyond was never
   * reached (Saga round 2026-09-29c). The result is memoised per node.
   */
  const continued = new Map<string, boolean>();
  const continues = (node: LatticeNode): boolean => {
    const k0 = key(node);
    const memo = continued.get(k0);
    if (memo !== undefined) return memo;
    const from = at(node.a, node.l), a0 = Math.abs(node.a), sgn = Math.sign(node.a);
    if (beside(Math.floor(from.x), Math.floor(from.z))) { continued.set(k0, true); return true; }
    const ok = search([{ ...node, prev: null }], JUMP_RISE, m => {
      const p = at(m.a, m.l);
      return Math.hypot(p.x - from.x, p.z - from.z) >= 1 - 1e-9;
    }, false, m => Math.abs(m.a) >= a0 && Math.sign(m.a) === sgn && !avoid(Math.floor(at(m.a, m.l).x), Math.floor(at(m.a, m.l).z))) !== undefined;
    continued.set(k0, ok);
    return ok;
  };
  return { at, starts, search, snap, route, continues };
}

type GraphNode = { x: number; z: number; t: number; prev: GraphNode | null };
const nodeKey = (n: { x: number; z: number; t: number }): string => `${n.x},${n.z},${Math.round(n.t * 16)}`;

/** A doorway at a size and turn: the leaf's closed blocks (`own`), their centre (its floor the lowest closed bottom) and the walk's normal. */
function doorwayGeometry(pack: DoorwayWalkPack, item: InteractiveRuntimeConfig['items'][number], f: number, rotation: QuarterTurn) {
  const own = [...ixWorldBlocks(item.blocking, pack.dims, f, rotation, COLLIDER_KIT).entries()].map(([key, span]) => { const [x, y, z] = key.split(',').map(Number) as [number, number, number]; return { x, y, z, lo: span[0], hi: span[1] }; });
  const centre = own.length
    ? { x: own.reduce((a, b) => a + b.x + 0.5, 0) / own.length, y: Math.min(...own.map(b => b.y + b.lo / 16)), z: own.reduce((a, b) => a + b.z + 0.5, 0) / own.length }
    : { x: 0, y: 0, z: 0 };
  const n = turnDirection({ x: item.normal?.[0] ?? 0, z: item.normal?.[2] ?? 1 }, pack.dims, rotation);
  return { own, centre, n };
}

/** Walk one doorway (by its index in `pack.interactives.items`) at a size and turn, open or closed. */
export function walkThroughDoorway(pack: DoorwayWalkPack, index: number, sizePct: number, rotation: QuarterTurn, open: boolean, openOthers = false, trace?: DoorwayWalkTrace): DoorwayWalkResult {
  const cfg = pack.interactives, item = cfg.items[index]!;
  const f = sizePct / 100, k = Math.max(1, f);
  // A double door's leaves open together (`pairs`, the runtime's group).
  const group = new Set([index, ...(item.pairs ?? [])]);
  /**
   * The walk world with the doorway's group in `groupOpen` (the runtime's
   * state: an opening too small at this size stays laid) - or, with
   * `lifted`, with the group's leaves gone whatever their size: where a
   * player would stand to use the doorway is a property of the model, not of
   * whether it is big enough yet, so the approach is found in that world.
   */
  const worldFor = (groupOpen: boolean, lifted = false): WalkWorld => {
    const options: WalkWorldOptions = { cells: pack.cells, dims: pack.dims, sizePct, rotation, treads: 'shipped', ...(pack.shippedTreads ? { shippedTreads: pack.shippedTreads } : {}) };
    const w = pack.makeWorld ? pack.makeWorld(options) : new WalkWorld(options);
    const items = lifted ? cfg.items.map((it, i) => group.has(i) ? { ...it, blocking: [] } : it) : cfg.items;
    w.setOverlayBlocks(ixClosedBlocks(items, pack.dims, f, rotation, i => group.has(i) ? groupOpen : openOthers));
    return w;
  };
  const passableAtSize = item.passSize !== undefined && item.passSize > 0 && sizePct >= item.passSize;
  // The doorway: the leaf's closed blocks at this size and turn.
  const { own, centre, n } = doorwayGeometry(pack, item, f, rotation);
  const base = { index, label: item.label, sizePct, rotation, open, passableAtSize, centre, normal: n };
  if (!own.length) return { ...base, outcome: 'no-approach', directions: [] };
  const doorColumns = new Set(own.map(b => `${b.x},${b.z}`));
  /** Every column a leaf of this doorway's group (a double door's partner too) fills while closed. */
  const groupColumns = new Set([...group].flatMap(g => [...ixWorldBlocks(cfg.items[g]!.blocking, pack.dims, f, rotation, COLLIDER_KIT).keys()].map(key => { const [x, , z] = key.split(','); return `${x},${z}`; })));
  const R = Math.ceil(WINDOW_BLOCKS * k);
  const window = { x0: Math.floor(centre.x) - R, x1: Math.floor(centre.x) + R, z0: Math.floor(centre.z) - R, z1: Math.floor(centre.z) + R };
  const side = (node: { x: number; z: number }): number => (node.x + 0.5 - centre.x) * n.x + (node.z + 0.5 - centre.z) * n.z;
  /** A column node IN the doorway: one of its closed columns, standing within the slack of its floor. */
  const atDoor = (m: { x: number; z: number; t: number }): boolean => doorColumns.has(`${m.x},${m.z}`) && Math.abs(m.t - centre.y) <= DOOR_FLOOR_SLACK * k;
  /**
   * Whether a move between two column nodes stays on one side of the leaf's
   * plane or crosses it IN the doorway: every search here crosses the plane
   * only there. Without this, the approach walk reached the far side of
   * 42670's raised Door 3 at 400 % by going down its stairs and under it on
   * the ground, and the walk then called that doorway passable.
   */
  const crossesAtDoor = (from: { x: number; z: number; t: number }, to: { x: number; z: number; t: number }): boolean =>
    Math.sign(side(to)) === Math.sign(side(from)) || atDoor(to) || atDoor(from);
  const r2 = (v: number): number => Math.round(v * 100) / 100;

  // Through the DOORWAY, not round the end of a free-standing leaf: the
  // crossing must be within the doorway's span (its closed blocks along the
  // leaf, plus half a player).
  const u = { x: -n.z, z: n.x };
  const lateral = (p: { x: number; z: number }): number => (p.x - centre.x) * u.x + (p.z - centre.z) * u.z;
  const halfSpan = Math.max(...own.map(b => Math.abs(lateral({ x: b.x + 0.5, z: b.z + 0.5 })))) + 0.5 + 0.3;

  // ── The approach, found with the doorway OPEN: a breadth-first walk out of
  // the doorway's own columns; the nearest surface at least `SIDE_CLEARANCE`
  // past the leaf plane on each side is where a player stands to go through.
  const openWorld = worldFor(true, true);
  const og = surfaceGraph(openWorld, window, k);
  /**
   * The columns every OTHER doorway's closed leaf fills: a spot beside one
   * goes on through that door (a vestibule between two doors, 10022's
   * passenger car; the other door is closed in this walk's world).
   */
  const otherDoorColumns = new Set<string>();
  cfg.items.forEach((it, i) => {
    if (group.has(i) || it.passSize === undefined) return;
    for (const key of ixWorldBlocks(it.blocking, pack.dims, f, rotation, COLLIDER_KIT).keys()) { const [x, , z] = key.split(','); otherDoorColumns.add(`${x},${z}`); }
  });
  const besideOtherDoor = (x: number, z: number): boolean => otherDoorColumns.has(`${x + 1},${z}`) || otherDoorColumns.has(`${x - 1},${z}`) || otherDoorColumns.has(`${x},${z + 1}`) || otherDoorColumns.has(`${x},${z - 1}`);
  /**
   * Whether a player standing on `node` can go ON from there: a two-way move
   * to a column that is no leaf's and no nearer the leaf's plane (onward or
   * sideways - a corridor along the wall, a balcony). A spot with none is a
   * dead end, not an approach: 910004's Door 3 opens onto a 0.75-block
   * alcove between the leaf and a step up under the ceiling's edge (furniture
   * a stud inside the door); the walk stood there and called the doorway OK
   * while the room beyond was never reached (Saga round 2026-09-29c).
   */
  const continues = (node: GraphNode): boolean => {
    if (besideOtherDoor(node.x, node.z)) return true;
    const s0 = side(node), a0 = Math.abs(s0);
    return og.moves(node.x, node.z, node.t, true).some(m => !groupColumns.has(`${m.x},${m.z}`) && Math.sign(side(m)) === Math.sign(s0) && Math.abs(side(m)) >= a0 - 1e-6);
  };
  const starts: GraphNode[] = [];
  for (const key of doorColumns) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    for (const t of og.tops(x, z)) if (Math.abs(t - centre.y) <= DOOR_FLOOR_SLACK * k) starts.push({ x, z, t, prev: null });
  }
  const seenOpen = new Set(starts.map(nodeKey));
  const queue = [...starts];
  const near: Record<'-1' | '1', GraphNode | undefined> = { '-1': undefined, '1': undefined };
  for (let h = 0; h < queue.length && !(near['-1'] && near['1']); h++) {
    const node = queue[h]!;
    const s = side(node);
    // An approach is a spot in FRONT of the doorway: within a jump of its floor. The corridor walk can climb a
    // staircase to a roof over the door (42663's van at 200 %, once clearance opened its side), and a roof
    // is not where a player stands to walk through a door.
    // Nor is a column a leaf of the doorway fills while closed: a leaf turned off the grid spans columns
    // along its normal, and a double door's partner stands beside it (76269's Door 2); a player put there
    // stands inside the closed door.
    // And a spot a player can go on from (`continues`): a dead-end alcove is searched past, not stood in.
    const level = Math.abs(node.t - centre.y) <= JUMP_RISE * k + 1e-6 && !groupColumns.has(`${node.x},${node.z}`);
    if (level && s <= -SIDE_CLEARANCE * k && !near['-1'] && continues(node)) { near['-1'] = node; continue; }
    if (level && s >= SIDE_CLEARANCE * k && !near['1'] && continues(node)) { near['1'] = node; continue; }
    // Two-way moves only (an approach spot must be one a player can walk INTO
    // the doorway from), and only along the CORRIDOR straight through the
    // doorway: a spot reached by leaving the doorway sideways and going round
    // its jamb is not a way through this door.
    for (const m of og.moves(node.x, node.z, node.t, true)) {
      if (!crossesAtDoor(node, m)) continue;
      if (Math.abs(lateral({ x: m.x + 0.5, z: m.z + 0.5 })) > halfSpan) continue;
      const key = nodeKey(m);
      if (seenOpen.has(key)) continue;
      seenOpen.add(key);
      queue.push({ ...m, prev: node });
    }
  }
  // A side no two-way move reaches may still be reached by stepping DOWN out of
  // the doorway (a bus door over the road, a stoop over the street): a player
  // walks out there but cannot climb back past the jump. That side is found
  // with one-way moves (drops within `MAX_DROP`) and the doorway is walked
  // only from the other side (`oneWay`). The device walked 41395's Door 1 out
  // of the bus (GameTest 2026-09-25) where the offline walk had called it sealed.
  let oneWay: -1 | 1 | undefined;
  if (!!near['-1'] !== !!near['1']) {
    const missing: '-1' | '1' = near['-1'] ? '1' : '-1';
    const seen = new Set(starts.map(nodeKey));
    const q = [...starts];
    for (let h = 0; h < q.length; h++) {
      const node = q[h]!;
      const s = side(node);
      if ((missing === '-1' ? s <= -SIDE_CLEARANCE * k : s >= SIDE_CLEARANCE * k) && continues(node)) { near[missing] = node; oneWay = Number(missing) as -1 | 1; break; }
      for (const m of og.moves(node.x, node.z, node.t)) {
        if (!crossesAtDoor(node, m)) continue;
        // Outward only, down or level: a rise on the way out would be a two-way move the first pass had.
        if (Math.abs(lateral({ x: m.x + 0.5, z: m.z + 0.5 })) > halfSpan || m.t > node.t + 1e-6) continue;
        const key = nodeKey(m);
        if (seen.has(key)) continue;
        seen.add(key);
        q.push({ ...m, prev: node });
      }
    }
  }
  /**
   * Where the player stands on an approach node: the first of the free part's
   * centre, the column's centre, and the free part's two ends (a player's
   * half-width in) whose box is clear in the open world AND with every leaf
   * closed. A spot overlapping the closed leaf is not an approach: a player
   * put there overlaps the door, and Minecraft lets a body walk out of a
   * block it already overlaps - the device's simulated player walked through
   * 910004's closed Door 3 from such a spot (GameTest 2026-09-25).
   */
  const closedWorld = worldFor(false);
  const spotOf = (node: GraphNode | undefined): PlayerState | undefined => {
    if (!node) return undefined;
    const f = og.freePart(node.x, node.z, node.t), H = PLAYER_WIDTH_BLOCKS / 2 + 0.01;
    const xs = [node.x + (f.ax + f.bx) / 2, node.x + 0.5, node.x + f.ax + H, node.x + f.bx - H];
    const zs = [node.z + (f.az + f.bz) / 2, node.z + 0.5, node.z + f.az + H, node.z + f.bz - H];
    for (const x of xs) for (const z of zs) {
      if (!boxFree(openWorld, x, node.t + 0.01, z) || !boxFree(closedWorld, x, node.t + 0.01, z)) continue;
      const s = settle(openWorld, x, node.t + 0.01, z, 0.25);
      if (s && boxFree(closedWorld, s.x, s.y, s.z)) return s;
    }
    return undefined;
  };
  const spots: Record<'-1' | '1', PlayerState | undefined> = { '-1': spotOf(near['-1']), '1': spotOf(near['1']) };
  // ── The fine approach (`doorwayLattice`), where the column graph found no
  // spot on a side: the same rules (two-way first, a side reached one-way
  // only by dropping past the jump, a spot clear with every leaf closed and
  // not in a closed leaf's column) over the exact boxes.
  const fineLattice = doorwayLattice(openWorld, centre, n, halfSpan, k, DOOR_FLOOR_SLACK * k, (x, z) => groupColumns.has(`${x},${z}`), besideOtherDoor);
  const fineNear: Record<'-1' | '1', LatticeNode | undefined> = { '-1': undefined, '1': undefined };
  // A side the column graph reached only one-way is tried two-way on the lattice as well.
  const columnOneWay = oneWay;
  if (columnOneWay) spots[String(columnOneWay) as '-1' | '1'] = undefined;
  if (!spots['-1'] || !spots['1']) {
    const fineStarts = fineLattice.starts(DOOR_FLOOR_SLACK * k);
    /** A lattice approach on side `sd`: the spot a player stands on there, or undefined. */
    const fineSpot = (m: LatticeNode, sd: -1 | 1): PlayerState | undefined => {
      if (m.a * LATTICE_STEP * sd < SIDE_CLEARANCE * k - 1e-9 || Math.abs(m.t - centre.y) > JUMP_RISE * k + 1e-6) return undefined;
      const q = fineLattice.at(m.a, m.l);
      if (groupColumns.has(`${Math.floor(q.x)},${Math.floor(q.z)}`) || !boxFree(closedWorld, q.x, m.t + 0.01, q.z)) return undefined;
      // As the column approach: a spot a player can go on from, not a dead-end alcove.
      if (!fineLattice.continues(m)) return undefined;
      const st = settle(openWorld, q.x, m.t + 0.01, q.z, 0.25);
      return st && boxFree(closedWorld, st.x, st.y, st.z) ? st : undefined;
    };
    for (const sd of [-1, 1] as const) {
      const key = String(sd) as '-1' | '1';
      if (spots[key]) continue;
      let found = fineLattice.search(fineStarts, JUMP_RISE, m => !!fineSpot(m, sd));
      if (found && columnOneWay === sd) oneWay = undefined;
      else if (!found && columnOneWay === sd) { spots[key] = spotOf(near[key]); continue; }
      // The other side still reached two-way: this one may be a drop out of the doorway.
      if (!found && spots[String(-sd) as '-1' | '1']) {
        found = fineLattice.search(fineStarts, MAX_DROP * k, m => !!fineSpot(m, sd), true);
        if (found) oneWay = sd;
      }
      if (found) { fineNear[key] = found; spots[key] = fineSpot(found, sd); }
    }
  }
  if (!spots['-1'] || !spots['1']) {
    // One side cannot reach the doorway at all, open: the model put solid
    // geometry or a drop there (a door set into rock, a false door).
    return {
      ...base, outcome: starts.length ? 'sealed' : 'no-approach',
      directions: (['-1', '1'] as const).map(sd => ({ from: Number(sd) as -1 | 1, outcome: spots[sd] ? 'passed' as const : 'no-approach' as const, ...(spots[sd] ? {} : { reason: 'no-spot' as const }), ticks: 0, crossed: 0, ...(spots[sd] ? { start: { x: r2(spots[sd]!.x), y: r2(spots[sd]!.y), z: r2(spots[sd]!.z) } } : {}) })),
    };
  }

  // ── The walk, in the world of the state asked for.
  const world = open && passableAtSize ? openWorld : worldFor(open);
  const g = world === openWorld ? og : surfaceGraph(world, window, k);
  /** A route from `a` to `b` through a doorway column, over `g`. */
  const route = (a: GraphNode, b: GraphNode): Array<{ x: number; y: number; z: number }> | null => {
    type N = GraphNode & { door: boolean };
    const first: N = { x: a.x, z: a.z, t: a.t, prev: null, door: atDoor(a) };
    const seen = new Set([`${nodeKey(first)}:${first.door}`]);
    const q: N[] = [first];
    for (let h = 0; h < q.length; h++) {
      const node = q[h]!;
      if (node.door && node.x === b.x && node.z === b.z && Math.abs(node.t - b.t) < 1e-6) {
        const out: Array<{ x: number; y: number; z: number }> = [];
        for (let p: GraphNode | null = node; p; p = p.prev) { const at = g.standAt(p.x, p.z, p.t); out.unshift({ x: at.x, y: p.t, z: at.z }); }
        return out;
      }
      for (const m of g.moves(node.x, node.z, node.t)) {
        // Along the corridor straight through the doorway, as the approach: a route that touches the
        // doorway's column and then goes round the building (42670's raised Door 3 at 400 % turned 90)
        // is no way through this door.
        if (Math.abs(lateral({ x: m.x + 0.5, z: m.z + 0.5 })) > halfSpan) continue;
        if (!crossesAtDoor(node, m)) continue;
        const door = node.door || atDoor(m);
        const key = `${nodeKey(m)}:${door}`;
        if (seen.has(key)) continue;
        seen.add(key);
        q.push({ ...m, prev: node, door });
      }
    }
    return null;
  };
  const directions: DoorwayWalkResult['directions'] = [];
  for (const from of [-1, 1] as const) {
    const start = spots[String(from) as '-1' | '1']!, goal = spots[String(-from) as '-1' | '1']!;
    const a = near[String(from) as '-1' | '1'], b = near[String(-from) as '-1' | '1'];
    const along = (p: { x: number; z: number }): number => ((p.x - centre.x) * n.x + (p.z - centre.z) * n.z) * -from;
    // From the side a player only drops into, the way back in is over the jump: not walked.
    if (oneWay === from) { directions.push({ from, outcome: 'blocked', reason: 'one-way', ticks: 0, crossed: r2(along(start)), start: { x: r2(start.x), y: r2(start.y), z: r2(start.z) } }); continue; }
    // The column route, or where it finds none (or a side's approach came from the lattice) the fine route between the two spots.
    let way = a && b ? route(a, b) : null;
    if (!way) {
      const fl = world === openWorld ? fineLattice : doorwayLattice(world, centre, n, halfSpan, k, DOOR_FLOOR_SLACK * k);
      way = fl.route(fineNear[String(from) as '-1' | '1'] ?? fl.snap(start), fineNear[String(-from) as '-1' | '1'] ?? fl.snap(goal), MAX_DROP * k);
    }
    if (!way) { directions.push({ from, outcome: 'blocked', reason: 'no-path', ticks: 0, crossed: r2(along(start)), start: { x: r2(start.x), y: r2(start.y), z: r2(start.z) } }); continue; }
    // Follow the route's column centres with the per-tick player, then the goal itself.
    const waypoints = [...way.slice(1, -1), { x: goal.x, y: goal.y, z: goal.z }];
    if (trace) { trace.routes.push({ from, way }); trace.tracks.push({ from, points: [] }); }
    let s: PlayerState = { ...start, tick: 0 };
    let jump = false, best = -Infinity, ticks = 0, w = 0, stall = 0, lastDist = Infinity, throughSpan = false, jumps = 0;
    for (; ticks < MAX_TICKS && w < waypoints.length; ticks++) {
      const target = waypoints[w]!;
      const dx = target.x - s.x, dz = target.z - s.z, l = Math.hypot(dx, dz);
      if (l < WAYPOINT_REACH) { w++; stall = 0; lastDist = Infinity; continue; }
      const before = along(s);
      const r = tickPlayer(world, s, { move: { x: dx / l, z: dz / l }, jump, sneak: false });
      s = r.state;
      jump = (r.collided.x || r.collided.z) && s.onGround && jumpHelps(world, s, dx / l, dz / l); if (jump) jumps++;
      // The feet crossed the leaf plane this tick: was it inside the doorway?
      // At the doorway's level: within the slack of its floor, above as below (not under a raised doorway).
      if (before < 0 && along(s) >= 0 && Math.abs(lateral(s)) <= halfSpan && Math.abs(s.y - centre.y) <= DOOR_FLOOR_SLACK * k) throughSpan = true;
      trace?.tracks.at(-1)!.points.push({ x: Math.round(s.x * 100) / 100, y: Math.round(s.y * 100) / 100, z: Math.round(s.z * 100) / 100 });
      best = Math.max(best, along(s));
      if (best >= CROSS_MARGIN && w >= waypoints.length - 1) break;
      if (l < lastDist - 1e-3) { lastDist = l; stall = 0; } else if (++stall > STALL_TICKS) break;
    }
    const passed = best >= CROSS_MARGIN && throughSpan;
    directions.push({ from, outcome: passed ? 'passed' : 'blocked', ...(passed ? {} : { reason: 'physics' as const }), ticks, jumps, crossed: r2(best), start: { x: r2(start.x), y: r2(start.y), z: r2(start.z) }, end: { x: r2(s.x), y: r2(s.y), z: r2(s.z) } });
  }
  const outcome = directions.some(d => d.outcome === 'passed') ? 'passed' : directions.some(d => d.outcome === 'blocked') ? 'blocked' : 'no-approach';
  return { ...base, outcome, directions, ...(oneWay ? { oneWay } : {}) };
}

/** How far out (blocks at 100 %, scaled) a column line starts from the leaf's plane on each side. */
export const LINE_OUT = 1.5;
/**
 * How far from the leaf's plane (blocks at 100 %, scaled) a fall on a line
 * counts as the DOORWAY's hole: the leaf's own column and the one beside it
 * on each side. Further out is the model's ground (a stoop's edge, a roof
 * gate's parapet: 41732's Door 3 stands a block from a 2.7-block step down
 * to the street, 76417's Gate 1 two blocks from the roof's edge).
 */
export const HOLE_REACH = 1.0;

/** One straight walk through a doorway along one of its columns, from one side. */
export interface DoorwayColumnLine {
  /** The leaf column (world blocks from the pin) and the side the walk starts on (along the normal). */
  column: { x: number; z: number };
  from: -1 | 1;
  /** Where the player settled to start, or null when it found no floor within `MAX_DROP` (a pit). */
  start: { x: number; y: number; z: number } | null;
  end: { x: number; y: number; z: number };
  /** The lowest the feet went on the line, and how far that is under the doorway's floor (positive = down). */
  lowest: number;
  drop: number;
  /** The same within `HOLE_REACH` of the leaf's plane: the doorway's own fall. */
  dropNear: number;
  /** Whether the feet crossed the leaf plane by `CROSS_MARGIN` going the right way. */
  crossed: boolean;
}

/**
 * The DEVICE's line, offline: walk the per-tick player straight through a
 * doorway along each of its leaf columns' centre lines, from `LINE_OUT` out
 * on each side (the door open, feet dropped onto whatever is there), and say
 * how far the feet fall under the doorway's floor on the way. The verdict
 * walk finds ONE approach and ONE route and stops at the first that passes;
 * a leaf two columns wide with a floor in front of one column and a pit in
 * front of the other reads OK from the floor while a player through the
 * other column falls - 10326's Door 1 on the Saga (round 2026-09-29c: 2.25
 * blocks down at the threshold, both ways, x 10.67 where the walk had
 * stood at x 11.5). A `drop` past the jump on an OK doorway is a HOLE the
 * verdict did not see; `scripts/_ix_passability.ts` prints it.
 */
export function doorwayColumnLines(pack: DoorwayWalkPack, index: number, sizePct: number, rotation: QuarterTurn): DoorwayColumnLine[] {
  const cfg = pack.interactives, item = cfg.items[index]!;
  const f = sizePct / 100, k = Math.max(1, f);
  const group = new Set([index, ...(item.pairs ?? [])]);
  const { own, centre, n } = doorwayGeometry(pack, item, f, rotation);
  if (!own.length) return [];
  // The open world with this doorway's group lifted (its leaves gone), every other doorway closed.
  const options: WalkWorldOptions = { cells: pack.cells, dims: pack.dims, sizePct, rotation, treads: 'shipped', ...(pack.shippedTreads ? { shippedTreads: pack.shippedTreads } : {}) };
  const world = pack.makeWorld ? pack.makeWorld(options) : new WalkWorld(options);
  world.setOverlayBlocks(ixClosedBlocks(cfg.items.map((it, i) => group.has(i) ? { ...it, blocking: [] } : it), pack.dims, f, rotation, i => group.has(i)));
  const columns = [...new Map(own.map(b => [`${b.x},${b.z}`, { x: b.x, z: b.z }])).values()];
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  const out: DoorwayColumnLine[] = [];
  for (const column of columns) for (const from of [-1, 1] as const) {
    const cx = column.x + 0.5, cz = column.z + 0.5;
    const along = (p: { x: number; z: number }): number => ((p.x - cx) * n.x + (p.z - cz) * n.z) * -from;
    const sx = cx + n.x * from * LINE_OUT * k, sz = cz + n.z * from * LINE_OUT * k;
    // Dropped where the player's box is FREE, up to a jump over the doorway's floor: dropped at the
    // doorway's floor into a step that tops out above it (76417's roof beside Gate 1 at 150 %, 0.5 up),
    // the box started inside the step, fell through it - the walker ignores a box it already overlaps -
    // and the line reported a 19-block HOLE no player can reach.
    let dropY = centre.y + 0.01;
    while (!boxFree(world, sx, dropY, sz) && dropY < centre.y + JUMP_RISE * k) dropY += 1 / 16;
    const settled = boxFree(world, sx, dropY, sz) ? settle(world, sx, dropY, sz, MAX_DROP * k + (dropY - centre.y)) : undefined;
    let s: PlayerState = settled ?? { x: sx, y: centre.y + 0.01, z: sz, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 };
    // A start that found no floor within `MAX_DROP` is a pit at least that deep.
    let lowest = settled ? s.y : centre.y - MAX_DROP * k, lowestNear = centre.y, best = -Infinity, jump = false, stall = 0, last = -Infinity;
    if (settled) for (let t = 0; t < MAX_TICKS; t++) {
      const r = tickPlayer(world, s, { move: { x: -from * n.x, z: -from * n.z }, jump, sneak: false });
      s = r.state;
      jump = (r.collided.x || r.collided.z) && s.onGround && jumpHelps(world, s, -from * n.x, -from * n.z);
      lowest = Math.min(lowest, s.y);
      const a = along(s);
      if (Math.abs(a) <= HOLE_REACH * k) lowestNear = Math.min(lowestNear, s.y);
      best = Math.max(best, a);
      if (a >= LINE_OUT * k) break;
      if (a > last + 1e-3) { last = a; stall = 0; } else if (++stall > STALL_TICKS) break;
    }
    out.push({ column, from, start: settled ? { x: r2(settled.x), y: r2(settled.y), z: r2(settled.z) } : null, end: { x: r2(s.x), y: r2(s.y), z: r2(s.z) }, lowest: r2(lowest), drop: r2(centre.y - lowest), dropNear: r2(centre.y - lowestNear), crossed: best >= CROSS_MARGIN });
  }
  return out;
}

/** The lines of an OK doorway whose feet fell past the jump within `HOLE_REACH` of the leaf: holes the verdict walk did not stand over. */
export function doorwayHoles(lines: readonly DoorwayColumnLine[], sizePct: number): DoorwayColumnLine[] {
  const k = Math.max(1, sizePct / 100);
  return lines.filter(l => l.dropNear > JUMP_RISE * k + 1e-6);
}

export type Verdict = 'OK' | 'ONE-WAY' | 'SMALL' | 'FAIL' | 'NO-APPROACH' | 'SEALED' | 'STEP';
/**
 * The verdict for one doorway at one size and turn, from its open and closed
 * walks; `okAt100` says whether the same doorway passed at 100 % (a doorway
 * that passes there but has no approach at a bigger size lost it to a riser
 * that grew past the jump: STEP, the access recommendation's "doors versus
 * stairs" tension, not a door fault). ONE-WAY: walked through from one side,
 * where the other is reached only by stepping down past the jump (a bus door
 * over the road): a player walks out and cannot climb back in there.
 */
export function verdictOf(open: DoorwayWalkResult, closed: DoorwayWalkResult, okAt100 = false): Verdict {
  if (closed.outcome === 'passed') return 'FAIL';
  if (open.outcome === 'sealed') return okAt100 && open.sizePct > 100 ? 'STEP' : 'SEALED';
  if (open.outcome === 'no-approach' || closed.outcome === 'no-approach') return 'NO-APPROACH';
  // A one-way doorway walked from its only approach and not through is sealed, not failed:
  // there is no second side to try (71043's microscale landing door at 150 percent).
  if (open.passableAtSize) return open.outcome === 'passed' ? (open.oneWay ? 'ONE-WAY' : 'OK') : open.oneWay ? 'SEALED' : 'FAIL';
  return open.outcome === 'passed' ? 'FAIL' : 'SMALL';
}

/**
 * Walk every doorway of a pack at 100 %, turn 0, open and closed, and say in
 * one sentence how many a player can walk through - the number the wand
 * shows, so it is the walk's and not the leaf measurement's (the access
 * recommendation's "6/6 clear the passage" counts openings big enough, not
 * doorways a player can reach; 41732 read 6/6 there and 5 here).
 */
export function doorwayWalkSummary(pack: DoorwayWalkPack): { verdicts: Array<Verdict | undefined>; note?: string } {
  const items = pack.interactives.items;
  const verdicts: Array<Verdict | undefined> = items.map(() => undefined);
  items.forEach((it, i) => {
    if (it.passSize === undefined || !it.blocking.length) return;
    verdicts[i] = verdictOf(walkThroughDoorway(pack, i, 100, 0, true), walkThroughDoorway(pack, i, 100, 0, false));
  });
  const doorways = verdicts.filter(v => v !== undefined).length;
  if (!doorways) return { verdicts };
  const ok = verdicts.filter(v => v === 'OK').length;
  const labels = (v: Verdict): string[] => items.filter((_, i) => verdicts[i] === v).map(it => it.label);
  const parts = [`Doorways a player walks through at 100 percent over this pack's own blocks: ${ok} of ${doorways}.`];
  const oneWay = labels('ONE-WAY');
  if (oneWay.length) parts.push(`${oneWay.join(', ')}: walk out through ${oneWay.length === 1 ? 'it' : 'them'}, but the step back in is higher than a jump.`);
  const sealed = labels('SEALED');
  if (sealed.length) parts.push(`${sealed.join(', ')} open${sealed.length === 1 ? 's' : ''} onto the model's own solid geometry or a drop: it swings, but there is nowhere to walk.`);
  const small = items.filter((_, i) => verdicts[i] === 'SMALL');
  if (small.length) parts.push(`Too small at 100 percent: ${small.map(it => `${it.label} (passable from ${it.passSize ? `${it.passSize} percent` : 'no size'})`).join(', ')}.`);
  if (labels('NO-APPROACH').length) parts.push(`${labels('NO-APPROACH').join(', ')}: nowhere to stand on one side.`);
  if (labels('FAIL').length) parts.push(`${labels('FAIL').join(', ')}: failed the walk.`);
  return { verdicts, note: parts.join(' ') };
}
