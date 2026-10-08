/**
 * The engine systems that move BODIES each tick:
 *
 *   entities  mobs under `minecraft:physics` gravity (`tickBody`), moved by
 *             the velocity scripts give them (`applyImpulse`);
 *   effects   effect durations tick down;
 *
 * and, through `installPlayerSystems` (`player-systems.ts`), the players, the
 * native hover mounts and the riders.
 *
 * Falls are tracked for every body (`SimEntity.fall`, `shared.ts` `trackFall`):
 * a landing emits the engine's `landed` event with the distance and whether
 * slow falling was on.
 */

import { ORDER, type SimEngine } from '../core/engine.js';
import { tickBody } from './body.js';
import type { ControlState } from '../input/controls.js';
import { installPlayerSystems, isHoverMount } from './player-systems.js';
import { stateOf, trackFall } from './shared.js';

// The player-side exports moved to `player-systems.ts`; re-exported for the modules that read them here.
export { DISMOUNT_FALLBACK_LIFT, DISMOUNT_FLOOR_ABOVE, DISMOUNT_FLOOR_BELOW, DISMOUNT_OFFSETS, dismountReference, isHoverMount, setDownRider } from './player-systems.js';

/** Install the motion systems on an engine; the controls are the input module's. */
export function installPhysics(engine: SimEngine, controls: ControlState): void {
  installPlayerSystems(engine, controls);

  engine.addSystem({
    name: 'entities', order: ORDER.entities, tick(en) {
      for (const e of en.loadedEntities()) {
        if (e.isPlayer || e.ridingOn || isHoverMount(e)) continue;
        const ph = e.physics();
        const moving = e.velocity.x !== 0 || e.velocity.y !== 0 || e.velocity.z !== 0;
        if (!ph.gravity && !moving) continue;
        const dims = { width: e.collisionSize().width, height: e.collisionSize().height };
        if (ph.collision) {
          const r = tickBody(en.dimension(e.dimension), stateOf(e), dims, ph.gravity);
          e.location = { x: r.state.x, y: r.state.y, z: r.state.z };
          e.velocity = { x: r.state.vx, y: r.state.vy, z: r.state.vz };
          e.onGround = r.state.onGround;
        } else {
          e.location = { x: e.location.x + e.velocity.x, y: e.location.y + e.velocity.y, z: e.location.z + e.velocity.z };
          e.velocity = { x: e.velocity.x * 0.91, y: ph.gravity ? (e.velocity.y - 0.08) * 0.98 : e.velocity.y * 0.98, z: e.velocity.z * 0.91 };
        }
        trackFall(en, e);
      }
    },
  });

  engine.addSystem({
    name: 'effects', order: ORDER.effects, tick(en) {
      for (const e of en.entities.values()) for (const [id, fx] of e.effects) { if (--fx.duration <= 0) e.effects.delete(id); }
    },
  });
}
