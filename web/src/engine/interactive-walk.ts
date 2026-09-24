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
import { NO_INPUT, WalkWorld, modelPointToWorld, playerBox, tickPlayer, type PlayerState } from './addon-walk.js';
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
  directions: Array<{ from: -1 | 1; outcome: 'passed' | 'blocked' | 'no-approach'; reason?: 'no-path' | 'physics'; ticks: number; crossed: number; start?: { x: number; y: number; z: number }; end?: { x: number; y: number; z: number } }>;
  /** The doorway's centre in world blocks from the pin, and the walk's normal. */
  centre: { x: number; y: number; z: number };
  normal: { x: number; z: number };
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
function boxFree(world: WalkWorld, x: number, y: number, z: number): boolean {
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

/** Walk one doorway (by its index in `pack.interactives.items`) at a size and turn, open or closed. */
export function walkThroughDoorway(pack: DoorwayWalkPack, index: number, sizePct: number, rotation: QuarterTurn, open: boolean, openOthers = false): DoorwayWalkResult {
  const cfg = pack.interactives, item = cfg.items[index]!;
  const f = sizePct / 100, k = Math.max(1, f);
  const world = new WalkWorld({ cells: pack.cells, dims: pack.dims, sizePct, rotation, treads: 'shipped', ...(pack.shippedTreads ? { shippedTreads: pack.shippedTreads } : {}) });
  // A double door's leaves open together (`shares`, the runtime's group).
  const group = new Set([index, ...item.shares]);
  world.setOverlayBlocks(ixClosedBlocks(cfg.items, pack.dims, f, rotation, i => group.has(i) ? open : openOthers));
  const passableAtSize = item.passSize !== undefined && item.passSize > 0 && sizePct >= item.passSize;
  // The doorway: the leaf's closed blocks at this size and turn.
  const own = [...ixWorldBlocks(item.blocking, pack.dims, f, rotation).entries()].map(([key, span]) => { const [x, y, z] = key.split(',').map(Number) as [number, number, number]; return { x, y, z, lo: span[0], hi: span[1] }; });
  const centre = own.length
    ? { x: own.reduce((a, b) => a + b.x + 0.5, 0) / own.length, y: Math.min(...own.map(b => b.y + b.lo / 16)), z: own.reduce((a, b) => a + b.z + 0.5, 0) / own.length }
    : { x: 0, y: 0, z: 0 };
  const n = turnDirection({ x: item.normal?.[0] ?? 0, z: item.normal?.[2] ?? 1 }, pack.dims, rotation);
  const base = { index, label: item.label, sizePct, rotation, open, passableAtSize, centre, normal: n };
  if (!own.length) return { ...base, outcome: 'no-approach', directions: [] };
  const doorColumns = new Set(own.map(b => `${b.x},${b.z}`));

  // ── The local surface graph: columns within the window, the tops a player can stand on.
  const R = Math.ceil(WINDOW_BLOCKS * k);
  const cx0 = Math.floor(centre.x) - R, cx1 = Math.floor(centre.x) + R, cz0 = Math.floor(centre.z) - R, cz1 = Math.floor(centre.z) + R;
  const clear = (x: number, z: number, y0: number, y1: number): boolean => world.boxesInColumn(x, z).every(b => b.y1 <= y0 + 1e-6 || b.y0 >= y1 - 1e-6);
  const topsCache = new Map<string, number[]>();
  const tops = (x: number, z: number): number[] => {
    const key = `${x},${z}`;
    let t = topsCache.get(key);
    if (t) return t;
    const boxes = world.boxesInColumn(x, z);
    t = [0, ...boxes.map(b => b.y1)].filter(y => clear(x, z, y, y + PLAYER_NEED)).filter(y => y > 0 || boxes.every(b => b.y0 >= PLAYER_NEED - 1e-6 || b.y1 <= 1e-6));
    topsCache.set(key, t);
    return t;
  };
  const surf = (x: number, z: number, y: number): string => `${x},${z},${Math.round(y * 16)}`;
  const nearestTop = (x: number, z: number, y: number): number | undefined => {
    let best: number | undefined, d = Infinity;
    for (const t of tops(x, z)) if (Math.abs(t - y) < d && t <= y + 0.1) { d = Math.abs(t - y); best = t; }
    return best;
  };
  /**
   * Breadth-first path of column centres from `a` to `b` that crosses a
   * doorway column; with no `b`, to the first doorway column (does this side
   * reach the doorway at all?).
   */
  const path = (a: PlayerState, b?: PlayerState): Array<{ x: number; y: number; z: number }> | null => {
    const ax = Math.floor(a.x), az = Math.floor(a.z), bx = b ? Math.floor(b.x) : NaN, bz = b ? Math.floor(b.z) : NaN;
    const at = nearestTop(ax, az, a.y), bt = b ? nearestTop(bx, bz, b.y) : 0;
    if (at === undefined || bt === undefined) return null;
    type Node = { x: number; z: number; t: number; door: boolean; prev: Node | null };
    const seen = new Set<string>();
    const queue: Node[] = [{ x: ax, z: az, t: at, door: doorColumns.has(`${ax},${az}`), prev: null }];
    seen.add(`${surf(ax, az, at)}:${queue[0]!.door}`);
    for (let h = 0; h < queue.length; h++) {
      const node = queue[h]!;
      if (node.door && (!b || (node.x === bx && node.z === bz && Math.abs(node.t - bt) < 1e-6))) {
        const out: Array<{ x: number; y: number; z: number }> = [];
        for (let p: Node | null = node; p; p = p.prev) out.unshift({ x: p.x + 0.5, y: p.t, z: p.z + 0.5 });
        return out;
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = node.x + dx, z = node.z + dz;
        if (x < cx0 || x > cx1 || z < cz0 || z > cz1) continue;
        for (const t of tops(x, z)) {
          const rise = t - node.t;
          if (rise > JUMP_RISE + 1e-6 || -rise > MAX_DROP * k) continue;
          const hi = Math.max(t, node.t);
          // The move: both columns clear at the higher of the two floors (a jump also needs its own column clear up there).
          if (!clear(x, z, hi, hi + PLAYER_NEED) || !clear(node.x, node.z, hi, hi + PLAYER_NEED)) continue;
          const door = node.door || doorColumns.has(`${x},${z}`);
          const key = `${surf(x, z, t)}:${door}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push({ x, z, t, door, prev: node });
        }
      }
    }
    return null;
  };

  /** A standable spot on side `side` (+1 along the normal, -1 against it), nearest the doorway first. */
  const spot = (side: 1 | -1): PlayerState | undefined => {
    for (let d = 1.0 * k; d <= 4.0 * k + 1e-9; d += 0.25) {
      const x = centre.x + n.x * d * side, z = centre.z + n.z * d * side;
      for (let lift = 0; lift <= 1.5 * k; lift += 1 / 16) {
        const y = centre.y + lift + 0.01;
        if (!boxFree(world, x, y, z)) continue;
        const s = settle(world, x, y, z, 1.6 * k);
        if (s) return s;
        break;
      }
    }
    return undefined;
  };
  const sides: Array<-1 | 1> = [-1, 1];
  const spots = new Map<number, PlayerState | undefined>(sides.map(side => [side, spot(side)]));
  const directions: DoorwayWalkResult['directions'] = [];
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  // A doorway that one side cannot reach even OPEN opens onto solid model
  // geometry there (a door set into rock, a false door): sealed by the model,
  // not by the door. Judged with the door open.
  if (open && sides.some(side => { const p = spots.get(side); return !p || !path(p); })) {
    return { ...base, outcome: 'sealed', directions: sides.map(side => ({ from: side, outcome: 'no-approach' as const, ticks: 0, crossed: 0 })) };
  }
  for (const from of sides) {
    const start = spots.get(from), goal = spots.get(-from as -1 | 1);
    if (!start || !goal) { directions.push({ from, outcome: 'no-approach', ticks: 0, crossed: 0 }); continue; }
    const along = (p: { x: number; z: number }): number => ((p.x - centre.x) * n.x + (p.z - centre.z) * n.z) * -from;
    const route = path(start, goal);
    if (!route) { directions.push({ from, outcome: 'blocked', reason: 'no-path', ticks: 0, crossed: r2(along(start)), start: { x: r2(start.x), y: r2(start.y), z: r2(start.z) } }); continue; }
    // Follow the route's column centres with the per-tick player, then the goal itself.
    const waypoints = [...route.slice(1, -1), { x: goal.x, y: goal.y, z: goal.z }];
    let s: PlayerState = { ...start, tick: 0 };
    let jump = false, best = -Infinity, ticks = 0, w = 0, stall = 0, lastDist = Infinity;
    for (; ticks < MAX_TICKS && w < waypoints.length; ticks++) {
      const target = waypoints[w]!;
      const dx = target.x - s.x, dz = target.z - s.z, l = Math.hypot(dx, dz);
      if (l < WAYPOINT_REACH) { w++; stall = 0; lastDist = Infinity; continue; }
      const r = tickPlayer(world, s, { move: { x: dx / l, z: dz / l }, jump, sneak: false });
      s = r.state;
      jump = (r.collided.x || r.collided.z) && s.onGround;
      best = Math.max(best, along(s));
      if (best >= CROSS_MARGIN && w >= waypoints.length - 1) break;
      if (l < lastDist - 1e-3) { lastDist = l; stall = 0; } else if (++stall > STALL_TICKS) break;
    }
    const passed = best >= CROSS_MARGIN;
    directions.push({ from, outcome: passed ? 'passed' : 'blocked', ...(passed ? {} : { reason: 'physics' as const }), ticks, crossed: r2(best), start: { x: r2(start.x), y: r2(start.y), z: r2(start.z) }, end: { x: r2(s.x), y: r2(s.y), z: r2(s.z) } });
  }
  const outcome = directions.some(d => d.outcome === 'passed') ? 'passed' : directions.some(d => d.outcome === 'blocked') ? 'blocked' : 'no-approach';
  return { ...base, outcome, directions };
}
