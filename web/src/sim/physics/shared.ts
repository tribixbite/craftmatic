/**
 * Small helpers the motion systems share (`systems.ts` for bodies, `player-systems.ts` for players, mounts
 * and riders): an entity's body state for the integrator, a yaw wrap, an effect test and the fall tracker.
 */

import type { SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import type { PlayerState } from './body.js';

/** An entity's body state, as the integrator (`tickPlayer`, `tickBody`) reads it. */
export const stateOf = (e: SimEntity): PlayerState => ({ x: e.location.x, y: e.location.y, z: e.location.z, vx: e.velocity.x, vy: e.velocity.y, vz: e.velocity.z, onGround: e.onGround, sneaking: false, tick: 0 });
/** A yaw into (-180, 180]. */
export const wrapDeg = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
/** Whether an effect (with or without its `minecraft:` namespace) is on an entity. */
export const hasEffect = (e: SimEntity, id: string): boolean => e.effects.has(id) || e.effects.has(`minecraft:${id}`);

/** Track a body's fall after it moved; emits `landed` when it touches down after a drop. */
export function trackFall(engine: SimEngine, e: SimEntity): void {
  const slow = hasEffect(e, 'slow_falling');
  if (!e.onGround) {
    if (!e.fall) e.fall = { startY: e.location.y, slowFell: slow };
    else { e.fall.startY = Math.max(e.fall.startY, e.location.y); e.fall.slowFell ||= slow; }
    return;
  }
  if (e.fall) {
    const d = e.fall.startY - e.location.y;
    if (d > 0.05) engine.emit('landed', { entity: e, fallDistance: d, slowFell: e.fall.slowFell || slow, at: { ...e.location } });
    e.fall = undefined;
  }
}
