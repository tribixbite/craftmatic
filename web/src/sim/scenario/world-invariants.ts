/**
 * The world's invariants (package D, 2026-10-08), run with the core ones in
 * every scenario:
 *
 *   no-entity-overlap   two bodies the device keeps apart never overlap: a mob
 *                       (a player, a figure) and an entity with
 *                       `minecraft:is_collidable` (quirk
 *                       `entity-collidable-solid`; physics/body-systems.ts
 *                       makes such an entity a solid box). Entities without it
 *                       pass through each other on the device as here (a car
 *                       through a figure is the MODEL's behaviour, not a
 *                       fault), so only collidable pairs are judged. Riders and
 *                       their mounts are never a pair.
 */

import type { SimEntity } from '../entity/entity.js';
import type { Box } from '../core/vec.js';
import { isCollidable } from '../physics/body-systems.js';
import type { Invariant } from './invariants.js';

/** How deep (blocks, in every axis) two boxes must interpenetrate before it counts: the sweep's own epsilon is far smaller; a tick's push can leave a hundredth. */
export const OVERLAP_SLACK = 0.05;

const overlapDepth = (a: Box, b: Box): number => Math.min(a.x1 - b.x0, b.x1 - a.x0, a.y1 - b.y0, b.y1 - a.y0, a.z1 - b.z0, b.z1 - a.z0);

/** A body the device would collide with a collidable entity: a player, or a mob whose physics collides. */
const isMover = (e: SimEntity): boolean => e.isPlayer || (e.physics().collision && 'minecraft:collision_box' in e.components);

/** The pairs (mover, collidable) that overlap by more than `OVERLAP_SLACK`, with how deep. */
export function overlappingSolidPairs(entities: Iterable<SimEntity>): Array<{ mover: SimEntity; solid: SimEntity; depth: number }> {
  const all = [...entities].filter(e => e.valid);
  const solids = all.filter(isCollidable);
  if (!solids.length) return [];
  const out: Array<{ mover: SimEntity; solid: SimEntity; depth: number }> = [];
  for (const s of solids) for (const m of all) {
    if (m === s || !isMover(m) || m.dimension !== s.dimension || m.ridingOn === s || s.ridingOn === m || (m.ridingOn && m.ridingOn === s.ridingOn)) continue;
    const depth = overlapDepth(m.aabb(), s.aabb());
    if (depth > OVERLAP_SLACK) out.push({ mover: m, solid: s, depth });
  }
  return out;
}

/** The world invariants. */
export function worldInvariants(): Invariant[] {
  return [{
    id: 'no-entity-overlap',
    description: 'a mob never interpenetrates an entity with minecraft:is_collidable (quirk entity-collidable-solid)',
    tick(ctx) {
      for (const p of overlappingSolidPairs(ctx.engine.loadedEntities())) {
        ctx.report({ invariant: 'no-entity-overlap', message: `${p.mover.isPlayer ? 'the player' : p.mover.typeId} is ${Math.round(p.depth * 100) / 100} blocks inside the collidable ${p.solid.typeId}`, evidence: { mover: p.mover.typeId, solid: p.solid.typeId, at: { ...p.mover.location }, solidAt: { ...p.solid.location } } });
      }
    },
  }];
}
