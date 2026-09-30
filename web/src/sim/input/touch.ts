/**
 * A child's touch screen, as the device measured it:
 *
 *   - a TAP is a ray from the eye along the view; it picks the first entity
 *     box it meets (custom hit test, else collision box) unless a block with a
 *     selection box is nearer, and fires `entityHitEntity` (quirks `tap-is-hit`,
 *     `no-selection-box-passes-taps`); colliders have no selection box, so the
 *     ray passes them;
 *   - a HOLD of ~0.5 s on an entity fires `playerInteractWithEntity` (after
 *     the cancelable before-event) and mounts a vanilla rideable the player's
 *     family may ride (quirk `hold-is-interact`);
 *   - the move stick, Jump and Sneak are held controls (`controls.ts`); Sneak
 *     dismounts a rider (quirk `sneak-dismounts`, applied by the physics);
 *   - using an item fires `itemUse`.
 *
 * The functions here act at once; the scenario runner spaces them in ticks.
 */

import { lookAngles, viewDirection, type Vec3 } from '../core/vec.js';
import type { SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import { quirkValue } from '../quirks/registry.js';
import { pickBoxes, raycastBlocks, raycastEntities } from './ray.js';

/** What a tap or hold hit. */
export interface TouchResult {
  /** The entity picked, or undefined. */
  entity?: SimEntity;
  /** A block that stopped the ray first (nearer than any entity), `x,y,z typeId`. */
  blockedBy?: string;
  distance?: number;
}

/** Turn the player to look at a point. */
export function lookAt(player: SimEntity, target: Vec3): void {
  const h = player.headLocation();
  const a = lookAngles({ x: target.x - h.x, y: target.y - h.y, z: target.z - h.z });
  player.rotation = { x: a.pitch, y: a.yaw };
}

/** The centre of an entity's nearest pick box (where a child's finger lands on it). */
export function aimPoint(player: SimEntity, target: SimEntity): Vec3 {
  const h = player.headLocation();
  let best: Vec3 | undefined, bestD = Infinity;
  for (const b of pickBoxes(target)) {
    const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 };
    const d = Math.hypot(c.x - h.x, c.y - h.y, c.z - h.z);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ?? target.location;
}

/** What the player's view ray picks within reach. */
export function pick(engine: SimEngine, player: SimEntity, reach = quirkValue('tap-is-hit', 'reachBlocks')): TouchResult {
  const eye = player.headLocation(), dir = viewDirection(player.rotation.y, player.rotation.x);
  const world = engine.dimension(player.dimension);
  const hits = raycastEntities(engine.loadedEntities(player.dimension), eye, dir, reach, player).filter(h => h.entity !== player.ridingOn);
  const block = raycastBlocks(world, eye, dir, reach, { includePassable: true });
  const first = hits[0];
  if (block && (!first || block.distance < first.distance)) return { blockedBy: `${block.x},${block.y},${block.z} ${world.permutationAt(block.x, block.y, block.z).typeId}`, distance: block.distance };
  return first ? { entity: first.entity, distance: first.distance } : {};
}

/** A tap: pick, then `entityHitEntity` on the entity picked. Aims at `target` first when given. */
export function tap(engine: SimEngine, player: SimEntity, target?: SimEntity): TouchResult {
  if (target) lookAt(player, aimPoint(player, target));
  const r = pick(engine, player);
  if (r.entity) engine.emit('entityHitEntity', { damagingEntity: player, hitEntity: r.entity });
  return r;
}

/**
 * The END of a hold on an entity: the interact. `before` runs the cancelable
 * before-event (the script host's); when not cancelled, a vanilla rideable
 * the player may ride takes it as a rider, then the after-event fires.
 */
export function interact(engine: SimEngine, player: SimEntity, target: SimEntity, before?: (player: SimEntity, target: SimEntity) => boolean): { mounted: boolean; cancelled: boolean } {
  if (before?.(player, target)) return { mounted: false, cancelled: true };
  let mounted = false;
  const r = target.rideable();
  if (r && (!r.familyTypes.length || r.familyTypes.includes('player')) && !player.ridingOn) mounted = target.addRider(player, engine.tick).ok;
  engine.emit('playerInteractWithEntity', { player, target });
  return { mounted, cancelled: false };
}

/** Use the held item (the wand): `itemUse`. */
export function useItem(engine: SimEngine, player: SimEntity, itemTypeId: string): void {
  engine.emit('itemUse', { source: player, itemTypeId });
}
