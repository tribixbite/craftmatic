/**
 * The engine systems where BODIES MEET each other, and what a mob's body
 * does in water:
 *
 *   pushes     two overlapping bodies that may both be pushed by entities (a
 *              player, or an entity with `minecraft:pushable_by_entity`: the
 *              figures) are pushed apart, each by up to 0.05 block a tick
 *              (quirk `entity-push-soft`, ASSUMED: Java Edition's
 *              `Entity.push`; Bedrock's is closed and unmeasured - the
 *              `quirk_push` GameTest probe measures it);
 *   solids     an entity with `minecraft:is_collidable` is a SOLID box to the
 *              mobs moving against it (Microsoft Learn: "Allows other mobs to
 *              have vertical and horizontal collisions with this mob ... both
 *              mobs must have a minecraft:collision_box"; quirk
 *              `entity-collidable-solid`): its realised box joins the world's
 *              solids (`VoxelWorld.entitySolids`), so the one integrator stops
 *              a figure or a player at it. No pack ships one today.
 *
 * Who never pushes: a body riding another, a body carrying riders (Java's
 * `isVehicle`), and anything that is not pushable itself - the shells, doors,
 * seats and vehicles declare only `pushable_by_block`. The device agrees with
 * that much: figures live inside their shell's (model-sized) collision box
 * and are not expelled from it (Pixel GameTest 2026-09-25: 0 figures leave).
 *
 * `bodyFluid` is a mob's water response for `tickBody` (physics/body.ts):
 * `minecraft:behavior.float` swims up, `minecraft:buoyant` floats.
 */

import type { SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import type { Box } from '../core/vec.js';
import type { WorldSolid } from '../world/voxel-world.js';
import { quirkValue } from '../quirks/registry.js';
import type { BodyFluid } from './body.js';

/** The pushes system's order: after the mobs moved (`ORDER.entities` 30), before riders are put back on their seats (`ORDER.riders` 40). */
export const PUSHES_ORDER = 35;

/** Whether an entity can be pushed by other entities: a player, or a type declaring `minecraft:pushable_by_entity` with a body the physics moves. */
export function pushableByEntity(e: SimEntity): boolean {
  if (e.isPlayer) return true;
  return 'minecraft:pushable_by_entity' in e.components && e.physics().collision;
}

/** Whether an entity is solid to other mobs (`minecraft:is_collidable` with a collision box). */
export function isCollidable(e: SimEntity): boolean {
  return 'minecraft:is_collidable' in e.components && 'minecraft:collision_box' in e.components;
}

/** A mob's water response (`tickBody`'s `fluid`). */
export function bodyFluid(e: SimEntity): BodyFluid {
  const b = e.components['minecraft:buoyant'] as { base_buoyancy?: number } | undefined;
  return {
    ...('minecraft:behavior.float' in e.components ? { floats: true } : {}),
    ...(b ? { buoyancy: typeof b.base_buoyancy === 'number' ? b.base_buoyancy : 1 } : {}),
  };
}

const overlaps = (a: Box, b: Box, eps = 1e-6): boolean => a.x1 > b.x0 + eps && a.x0 < b.x1 - eps && a.y1 > b.y0 + eps && a.y0 < b.y1 - eps && a.z1 > b.z0 + eps && a.z0 < b.z1 - eps;

/** Whether two bodies are on the same mount, or one carries the other (they never push or block each other). */
function linked(a: SimEntity, b: SimEntity): boolean {
  return a.ridingOn === b || b.ridingOn === a || (!!a.ridingOn && a.ridingOn === b.ridingOn);
}

/**
 * One tick of the soft push between every overlapping pair of pushable bodies (quirk `entity-push-soft`): along the
 * larger horizontal axis gap d (blocks, at least 0.01), each pushable body of the pair gets `pushPerTick` x
 * min(1, 1/sqrt(d)) along the line between their feet, away from the other, added to its velocity (Java's
 * `Entity.push`, which `LivingEntity.pushEntities` calls for every pushable entity a mob's box overlaps). A body
 * riding or carrying riders is not pushed.
 */
export function pushBodies(bodies: readonly SimEntity[], pushPerTick = quirkValue('entity-push-soft', 'pushPerTick')): number {
  let pushes = 0;
  const live = bodies.filter(e => e.valid && pushableByEntity(e) && !e.ridingOn);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!, b = live[j]!;
      if (a.dimension !== b.dimension || linked(a, b) || !overlaps(a.aabb(), b.aabb())) continue;
      let dx = b.location.x - a.location.x, dz = b.location.z - a.location.z;
      let d = Math.max(Math.abs(dx), Math.abs(dz));
      if (d < 0.01) continue;
      d = Math.sqrt(d);
      dx /= d; dz /= d;
      const f = Math.min(1, 1 / d) * pushPerTick;
      dx *= f; dz *= f;
      if (!a.riderList().length) a.velocity = { x: a.velocity.x - dx, y: a.velocity.y, z: a.velocity.z - dz };
      if (!b.riderList().length) b.velocity = { x: b.velocity.x + dx, y: b.velocity.y, z: b.velocity.z + dz };
      pushes++;
    }
  }
  return pushes;
}

/** The collidable entities, listed once per tick (a solids query runs many times a tick per body). */
const collidableCache = new WeakMap<SimEngine, { tick: number; list: SimEntity[] }>();
function collidables(engine: SimEngine): SimEntity[] {
  let c = collidableCache.get(engine);
  if (!c || c.tick !== engine.tick) {
    c = { tick: engine.tick, list: [...engine.entities.values()].filter(e => e.valid && isCollidable(e)) };
    collidableCache.set(engine, c);
  }
  return c.list;
}

/** The solid boxes of the collidable entities of a dimension near a region (the world's `entitySolids` hook). */
export function collidableSolids(engine: SimEngine, dimension: string, region: Box): WorldSolid[] {
  const out: WorldSolid[] = [];
  for (const e of collidables(engine)) {
    if (!e.valid || e.dimension !== dimension) continue;
    const b = e.aabb();
    // The box a mover queries with IS its own box when it is collidable itself: never a wall to itself.
    if (Math.abs(b.x0 - region.x0) < 1e-6 && Math.abs(b.y0 - region.y0) < 1e-6 && Math.abs(b.z0 - region.z0) < 1e-6 && Math.abs(b.x1 - region.x1) < 1e-6 && Math.abs(b.z1 - region.z1) < 1e-6) continue;
    if (b.x1 < region.x0 || b.x0 > region.x1 || b.y1 < region.y0 || b.y0 > region.y1 || b.z1 < region.z0 || b.z0 > region.z1) continue;
    out.push({ ...b, entity: e.id });
  }
  return out;
}

/** Install the bodies systems on an engine: the soft push, and collidable entities as the dimensions' solids. */
export function installBodySystems(engine: SimEngine): void {
  engine.addSystem({ name: 'pushes', order: PUSHES_ORDER, tick: en => { pushBodies(en.loadedEntities()); } });
  // Every dimension created from now on, and every one already made, asks the engine for its collidable entities.
  engine.onDimension(w => { w.entitySolids = region => collidableSolids(engine, w.id, region); });
}
