/**
 * Where a child would stand to touch something: a spot within reach of the
 * target where the player's box is free and stands on a floor, and from
 * whose eye the tap's ray picks THAT target first (no nearer entity box or
 * selectable block in the way). Searched on rings round the target's pick
 * point, nearest the player's current position first.
 *
 * No spot at all is a finding in itself: the target cannot be tapped by
 * anyone standing in the world (the tap-target-reachable invariant).
 */

import type { Vec3 } from '../core/vec.js';
import type { SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import { aimPoint, lookAt, pick } from '../input/touch.js';
import { PLAYER_EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH } from '../physics/body.js';
import { quirkValue } from '../quirks/registry.js';
import { raycastBlocks } from '../input/ray.js';

/** A standing spot and how far its eye is from the target's pick point. */
export interface ApproachSpot { feet: Vec3; distance: number; /** The point the child aims at from `feet` (the pick box nearest its eye). */ aim: Vec3 }

/** Whether the player's box stands free at `feet` on something solid within a sixteenth under it. */
export function standsAt(engine: SimEngine, dimension: string, feet: Vec3): boolean {
  const w = engine.dimension(dimension), h = PLAYER_WIDTH / 2;
  if (!w.isLoaded(feet.x, feet.z)) return false;
  if (w.overlapping({ x0: feet.x - h, y0: feet.y, z0: feet.z - h, x1: feet.x + h, y1: feet.y + PLAYER_HEIGHT, z1: feet.z + h }, 0.01)) return false;
  return !!w.overlapping({ x0: feet.x - h, y0: feet.y - 0.07, z0: feet.z - h, x1: feet.x + h, y1: feet.y - 0.001, z1: feet.z + h }, 0.0005);
}

/** The floor a player dropped at (x, z) from `fromY` stands on, if any within `depth`. */
export function floorBelow(engine: SimEngine, dimension: string, x: number, fromY: number, z: number, depth = 4): number | undefined {
  const w = engine.dimension(dimension);
  // The highest collision top under each of the box's corners and centre; the player stands on the highest.
  const h = PLAYER_WIDTH / 2 - 0.01;
  let top = -Infinity;
  for (const [dx, dz] of [[0, 0], [-h, -h], [h, -h], [-h, h], [h, h]] as const) top = Math.max(top, w.supportBelow(x + dx, fromY, z + dz, Math.ceil(depth) + 1));
  return top > fromY - depth ? top : undefined;
}

/** How far above and below the target's pick point a standing floor is searched (blocks): a child reaches up to a shelf and down to the floor. */
const APPROACH_LEVELS = { above: 3, below: 3 };

/**
 * Every floor a player can stand on in the column at (x, z) between `top` and `bottom`: the collision tops
 * `floorBelow` finds scanning down in half-block steps, deduplicated.
 */
function floorsIn(engine: SimEngine, dimension: string, x: number, z: number, top: number, bottom: number): number[] {
  const out: number[] = [];
  for (let from = top; from >= bottom; from -= 0.5) {
    const y = floorBelow(engine, dimension, x, from, z, 0.5);
    if (y !== undefined && !out.some(o => Math.abs(o - y) < 1e-6)) out.push(y);
  }
  return out;
}

/** How a spot is chosen. */
export interface ApproachOptions {
  /**
   * Prefer spots IN FRONT of the target: nothing solid (a collision box) between the eye and the point aimed
   * at, short of the last `SIGHT_MARGIN`. What a child does when a moving part answers "it is behind a wall
   * from here - step in front of it": it moves to where it sees the part, not merely to the next spot the
   * tap ray reaches through a collider (a collider has no selection box, so the ray passes it).
   */
  inFront?: boolean;
  /**
   * Spots where the child may NOT stand (the feet given): a door that answers "something is standing in the
   * door - step out to close it" is closed from outside its doorway, so the child steps out of the doorway's
   * closed cells before it taps again.
   */
  notWhere?: (feet: Vec3) => boolean;
}

/** The last stretch (blocks) of a sight line that is the target's own frame, never a wall. */
export const SIGHT_MARGIN = 0.5;

/** Whether nothing solid stands between `eye` and `aim`, short of the last `SIGHT_MARGIN`. */
export function sightClear(engine: SimEngine, dimension: string, eye: Vec3, aim: Vec3): boolean {
  const d = { x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z }, len = Math.hypot(d.x, d.y, d.z);
  if (len <= SIGHT_MARGIN) return true;
  return !raycastBlocks(engine.dimension(dimension), eye, d, len - SIGHT_MARGIN, { useCollision: true });
}

/**
 * Find a spot from which a tap picks `target`, skipping spots within a block of
 * `exclude` (ones already tried). Leaves the player where it was (it looks and
 * moves only to test), and returns the spot (with the point the child aims at
 * from there) or undefined.
 *
 * The rings are searched round the pick point nearest the player; at every ring
 * point EVERY floor from `APPROACH_LEVELS.above` over the pick point down to
 * `below` under the player's eye level is a candidate, and from each the child
 * aims at the pick box nearest its eye. Until 2026-09-30 only three floor heights
 * were tried, all a little under eye level with the pick point, so a part lying
 * on the floor the child stands on (31141's Turnable 1), or a part a child looks
 * down at from a plinth (71040's gate), had no spot at all.
 */
export function findApproach(engine: SimEngine, player: SimEntity, target: SimEntity, reach = quirkValue('tap-is-hit', 'reachBlocks') - 0.5, exclude: readonly Vec3[] = [], options: ApproachOptions = {}): ApproachSpot | undefined {
  return approachSpots(engine, player, target, reach, exclude, options, 1)[0];
}

/**
 * Every spot (up to `limit`, best first) from which a tap picks `target` - `findApproach`'s search, all of it:
 * a failed tap is judged over every spot a child could have tried (is the part hidden by the MODEL from all of
 * them?). Leaves the player where it was.
 */
export function approachSpots(engine: SimEngine, player: SimEntity, target: SimEntity, reach = quirkValue('tap-is-hit', 'reachBlocks') - 0.5, exclude: readonly Vec3[] = [], options: ApproachOptions = {}, limit = Infinity): ApproachSpot[] {
  const saved = { loc: { ...player.location }, rot: { ...player.rotation } };
  const a = aimPoint(player, target);
  const candidates: Array<ApproachSpot & { fromPlayer: number; clear?: boolean }> = [];
  for (const r of [1.2, 1.8, 2.5, 3.2, 4]) {
    if (r > reach) break;
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const x = a.x + Math.cos(ang) * r, z = a.z + Math.sin(ang) * r;
      for (const y of floorsIn(engine, player.dimension, x, z, a.y + APPROACH_LEVELS.above, a.y - PLAYER_EYE_HEIGHT - APPROACH_LEVELS.below)) {
        const feet = { x, y, z };
        if (!standsAt(engine, player.dimension, feet)) continue;
        player.location = feet;
        const aim = aimPoint(player, target), eye = player.headLocation();
        const d = Math.hypot(eye.x - aim.x, eye.y - aim.y, eye.z - aim.z);
        if (d > reach) continue;
        candidates.push({ feet, aim, distance: d, fromPlayer: Math.hypot(x - saved.loc.x, z - saved.loc.z), ...(options.inFront ? { clear: sightClear(engine, player.dimension, eye, aim) } : {}) });
      }
    }
  }
  // "Step in front of it": with `inFront`, spots from which nothing solid stands between the eye and the part come first.
  candidates.sort((p, q) => (options.inFront ? Number(!!q.clear) - Number(!!p.clear) : 0) || p.distance - q.distance || p.fromPlayer - q.fromPlayer);
  const found: ApproachSpot[] = [];
  for (const c of candidates) {
    if (found.length >= limit) break;
    if (exclude.some(e => Math.hypot(e.x - c.feet.x, e.z - c.feet.z) < 1)) continue;
    if (options.notWhere?.(c.feet)) continue;
    player.location = { ...c.feet };
    lookAt(player, c.aim);
    if (pick(engine, player).entity === target) found.push({ feet: c.feet, aim: c.aim, distance: c.distance });
  }
  player.location = saved.loc; player.rotation = saved.rot;
  return found;
}
