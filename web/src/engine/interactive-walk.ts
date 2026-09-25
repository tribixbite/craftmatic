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
import { NO_INPUT, WalkWorld, modelPointToWorld, playerBox, tickPlayer, type PlayerState, type SolidBox } from './addon-walk.js';
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
  directions: Array<{ from: -1 | 1; outcome: 'passed' | 'blocked' | 'no-approach'; reason?: 'no-path' | 'no-spot' | 'physics'; ticks: number; crossed: number; jumps?: number; start?: { x: number; y: number; z: number }; end?: { x: number; y: number; z: number } }>;
  /** The doorway's centre in world blocks from the pin, and the walk's normal. */
  centre: { x: number; y: number; z: number };
  normal: { x: number; z: number };
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
  return { tops, moves, standAt };
}

type GraphNode = { x: number; z: number; t: number; prev: GraphNode | null };
const nodeKey = (n: { x: number; z: number; t: number }): string => `${n.x},${n.z},${Math.round(n.t * 16)}`;

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
    const w = new WalkWorld({ cells: pack.cells, dims: pack.dims, sizePct, rotation, treads: 'shipped', ...(pack.shippedTreads ? { shippedTreads: pack.shippedTreads } : {}) });
    const items = lifted ? cfg.items.map((it, i) => group.has(i) ? { ...it, blocking: [] } : it) : cfg.items;
    w.setOverlayBlocks(ixClosedBlocks(items, pack.dims, f, rotation, i => group.has(i) ? groupOpen : openOthers));
    return w;
  };
  const passableAtSize = item.passSize !== undefined && item.passSize > 0 && sizePct >= item.passSize;
  // The doorway: the leaf's closed blocks at this size and turn.
  const own = [...ixWorldBlocks(item.blocking, pack.dims, f, rotation, COLLIDER_KIT).entries()].map(([key, span]) => { const [x, y, z] = key.split(',').map(Number) as [number, number, number]; return { x, y, z, lo: span[0], hi: span[1] }; });
  const centre = own.length
    ? { x: own.reduce((a, b) => a + b.x + 0.5, 0) / own.length, y: Math.min(...own.map(b => b.y + b.lo / 16)), z: own.reduce((a, b) => a + b.z + 0.5, 0) / own.length }
    : { x: 0, y: 0, z: 0 };
  const n = turnDirection({ x: item.normal?.[0] ?? 0, z: item.normal?.[2] ?? 1 }, pack.dims, rotation);
  const base = { index, label: item.label, sizePct, rotation, open, passableAtSize, centre, normal: n };
  if (!own.length) return { ...base, outcome: 'no-approach', directions: [] };
  const doorColumns = new Set(own.map(b => `${b.x},${b.z}`));
  const R = Math.ceil(WINDOW_BLOCKS * k);
  const window = { x0: Math.floor(centre.x) - R, x1: Math.floor(centre.x) + R, z0: Math.floor(centre.z) - R, z1: Math.floor(centre.z) + R };
  const side = (node: { x: number; z: number }): number => (node.x + 0.5 - centre.x) * n.x + (node.z + 0.5 - centre.z) * n.z;
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
    if (s <= -SIDE_CLEARANCE * k && !near['-1']) { near['-1'] = node; continue; }
    if (s >= SIDE_CLEARANCE * k && !near['1']) { near['1'] = node; continue; }
    // Two-way moves only (an approach spot must be one a player can walk INTO
    // the doorway from), and only along the CORRIDOR straight through the
    // doorway: a spot reached by leaving the doorway sideways and going round
    // its jamb is not a way through this door.
    for (const m of og.moves(node.x, node.z, node.t, true)) {
      if (Math.abs(lateral({ x: m.x + 0.5, z: m.z + 0.5 })) > halfSpan) continue;
      const key = nodeKey(m);
      if (seenOpen.has(key)) continue;
      seenOpen.add(key);
      queue.push({ ...m, prev: node });
    }
  }
  const spotOf = (node: GraphNode | undefined): PlayerState | undefined => {
    if (!node) return undefined;
    const at = og.standAt(node.x, node.z, node.t);
    return settle(openWorld, at.x, node.t + 0.01, at.z, 0.25);
  };
  const spots = { '-1': spotOf(near['-1']), '1': spotOf(near['1']) };
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
    const atDoor = (m: { x: number; z: number; t: number }): boolean => doorColumns.has(`${m.x},${m.z}`) && Math.abs(m.t - centre.y) <= DOOR_FLOOR_SLACK * k;
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
    const a = near[String(from) as '-1' | '1']!, b = near[String(-from) as '-1' | '1']!;
    const along = (p: { x: number; z: number }): number => ((p.x - centre.x) * n.x + (p.z - centre.z) * n.z) * -from;
    const way = route(a, b);
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
      jump = (r.collided.x || r.collided.z) && s.onGround; if (jump) jumps++;
      // The feet crossed the leaf plane this tick: was it inside the doorway?
      if (before < 0 && along(s) >= 0 && Math.abs(lateral(s)) <= halfSpan && s.y <= centre.y + DOOR_FLOOR_SLACK * k) throughSpan = true;
      trace?.tracks.at(-1)!.points.push({ x: Math.round(s.x * 100) / 100, y: Math.round(s.y * 100) / 100, z: Math.round(s.z * 100) / 100 });
      best = Math.max(best, along(s));
      if (best >= CROSS_MARGIN && w >= waypoints.length - 1) break;
      if (l < lastDist - 1e-3) { lastDist = l; stall = 0; } else if (++stall > STALL_TICKS) break;
    }
    const passed = best >= CROSS_MARGIN && throughSpan;
    directions.push({ from, outcome: passed ? 'passed' : 'blocked', ...(passed ? {} : { reason: 'physics' as const }), ticks, jumps, crossed: r2(best), start: { x: r2(start.x), y: r2(start.y), z: r2(start.z) }, end: { x: r2(s.x), y: r2(s.y), z: r2(s.z) } });
  }
  const outcome = directions.some(d => d.outcome === 'passed') ? 'passed' : directions.some(d => d.outcome === 'blocked') ? 'blocked' : 'no-approach';
  return { ...base, outcome, directions };
}

export type Verdict = 'OK' | 'SMALL' | 'FAIL' | 'NO-APPROACH' | 'SEALED' | 'STEP';
/**
 * The verdict for one doorway at one size and turn, from its open and closed
 * walks; `okAt100` says whether the same doorway passed at 100 % (a doorway
 * that passes there but has no approach at a bigger size lost it to a riser
 * that grew past the jump: STEP, the access recommendation's "doors versus
 * stairs" tension, not a door fault).
 */
export function verdictOf(open: DoorwayWalkResult, closed: DoorwayWalkResult, okAt100 = false): Verdict {
  if (closed.outcome === 'passed') return 'FAIL';
  if (open.outcome === 'sealed') return okAt100 && open.sizePct > 100 ? 'STEP' : 'SEALED';
  if (open.outcome === 'no-approach' || closed.outcome === 'no-approach') return 'NO-APPROACH';
  if (open.passableAtSize) return open.outcome === 'passed' ? 'OK' : 'FAIL';
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
  const sealed = labels('SEALED');
  if (sealed.length) parts.push(`${sealed.join(', ')} open${sealed.length === 1 ? 's' : ''} onto the model's own solid geometry or a drop: it swings, but there is nowhere to walk.`);
  const small = items.filter((_, i) => verdicts[i] === 'SMALL');
  if (small.length) parts.push(`Too small at 100 percent: ${small.map(it => `${it.label} (passable from ${it.passSize ? `${it.passSize} percent` : 'no size'})`).join(', ')}.`);
  if (labels('NO-APPROACH').length) parts.push(`${labels('NO-APPROACH').join(', ')}: nowhere to stand on one side.`);
  if (labels('FAIL').length) parts.push(`${labels('FAIL').join(', ')}: failed the walk.`);
  return { verdicts, note: parts.join(' ') };
}
