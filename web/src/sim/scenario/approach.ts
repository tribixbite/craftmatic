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

/** A standing spot and how far its eye is from the target's pick point. */
export interface ApproachSpot { feet: Vec3; distance: number }

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

/**
 * Find a spot from which a tap picks `target`. Leaves the player where it was
 * (it looks and moves only to test), and returns the spot or undefined.
 */
export function findApproach(engine: SimEngine, player: SimEntity, target: SimEntity, reach = quirkValue('tap-is-hit', 'reachBlocks') - 0.5): ApproachSpot | undefined {
  const saved = { loc: { ...player.location }, rot: { ...player.rotation } };
  const a = aimPoint(player, target);
  const candidates: Array<ApproachSpot & { fromPlayer: number }> = [];
  for (const r of [1.2, 1.8, 2.5, 3.2, 4]) {
    if (r > reach) break;
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const x = a.x + Math.cos(ang) * r, z = a.z + Math.sin(ang) * r;
      for (const top of [a.y - PLAYER_EYE_HEIGHT + 1.2, a.y - PLAYER_EYE_HEIGHT + 0.2, a.y - 1]) {
        const y = floorBelow(engine, player.dimension, x, top, z, 4);
        if (y === undefined) continue;
        const feet = { x, y, z };
        if (!standsAt(engine, player.dimension, feet)) continue;
        const eye = { x, y: y + PLAYER_EYE_HEIGHT, z };
        const d = Math.hypot(eye.x - a.x, eye.y - a.y, eye.z - a.z);
        if (d > reach) continue;
        candidates.push({ feet, distance: d, fromPlayer: Math.hypot(x - saved.loc.x, z - saved.loc.z) });
      }
    }
  }
  candidates.sort((p, q) => p.distance - q.distance || p.fromPlayer - q.fromPlayer);
  let found: ApproachSpot | undefined;
  for (const c of candidates) {
    player.location = { ...c.feet };
    lookAt(player, a);
    if (pick(engine, player).entity === target) { found = { feet: c.feet, distance: c.distance }; break; }
  }
  player.location = saved.loc; player.rotation = saved.rot;
  return found;
}
