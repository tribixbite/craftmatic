/**
 * The engine systems that MOVE things each tick:
 *
 *   players   the per-tick player (`tickPlayer`) over the dimension's voxels,
 *             from the held controls; a riding player instead drives its
 *             mount (native hover controller) or dismounts on a sneak;
 *   mounts    native hover mounts (`free_camera_controlled` + hover movement,
 *             a flyer's or rotorcraft's controller) at the device-measured
 *             speeds (quirks `hover-controller-speed`, `hover-climb-descend`,
 *             `hover-descend-needs-jump`);
 *   entities  mobs under `minecraft:physics` gravity (`tickBody`), moved by
 *             the velocity scripts give them (`applyImpulse`);
 *   riders    every rider back on its seat after its mount moved;
 *   effects   effect durations tick down.
 *
 * Falls are tracked for every body (`SimEntity.fall`): a landing emits the
 * engine's `landed` event with the distance and whether slow falling was on.
 */

import { ORDER, type SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import { quirkValue } from '../quirks/registry.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH, TICKS_PER_SECOND, moveBox, tickBody, tickPlayer, type PlayerState } from './body.js';
import type { VoxelWorld } from '../world/voxel-world.js';
import { stickToWorld, type ControlState } from '../input/controls.js';

const stateOf = (e: SimEntity): PlayerState => ({ x: e.location.x, y: e.location.y, z: e.location.z, vx: e.velocity.x, vy: e.velocity.y, vz: e.velocity.z, onGround: e.onGround, sneaking: false, tick: 0 });
const hasEffect = (e: SimEntity, id: string): boolean => e.effects.has(id) || e.effects.has(`minecraft:${id}`);

/** Track a body's fall after it moved; emits `landed` when it touches down after a drop. */
function trackFall(engine: SimEngine, e: SimEntity): void {
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

/**
 * Where a rider that got off stands (quirk `dismount-free-spot`, ASSUMED): where it was when its box is free;
 * else stood on the highest floor under its head height, where it was or on rings out to 2 blocks (at most 3
 * under its feet). Without this a low car's rider (seat 0.1-0.3 under the
 * grass top: 42172, 10796's cars) was left inside the ground, which the device does not do.
 */
function dismountSpot(p: SimEntity, world: VoxelWorld): void {
  const h = PLAYER_WIDTH / 2;
  const boxAt = (q: { x: number; y: number; z: number }) => ({ x0: q.x - h, y0: q.y, z0: q.z - h, x1: q.x + h, y1: q.y + PLAYER_HEIGHT, z1: q.z + h });
  if (!world.overlapping(boxAt(p.location), 0.001)) return;
  const standAt = (x: number, z: number): { x: number; y: number; z: number } | undefined => {
    let top = -Infinity;
    for (const [dx, dz] of [[0, 0], [-h + 0.01, -h + 0.01], [h - 0.01, -h + 0.01], [-h + 0.01, h - 0.01], [h - 0.01, h - 0.01]] as const) top = Math.max(top, world.supportBelow(x + dx, p.location.y + PLAYER_HEIGHT, z + dz, 5));
    if (!(top > p.location.y - 3)) return undefined;
    const q = { x, y: top, z };
    return world.overlapping(boxAt(q), 0.001) ? undefined : q;
  };
  let q = standAt(p.location.x, p.location.z);
  for (let r = 0.5; !q && r <= 2 + 1e-9; r += 0.5) for (let k = 0; k < 16 && !q; k++) q = standAt(p.location.x + Math.cos(k * Math.PI / 8) * r, p.location.z + Math.sin(k * Math.PI / 8) * r);
  if (q) { p.location = q; p.onGround = true; }
}

/** Whether an entity is a native hover mount (the rotorcraft / flyer controller). */
export function isHoverMount(e: SimEntity): boolean {
  return 'minecraft:free_camera_controlled' in e.components && ('minecraft:movement.hover' in e.components || 'minecraft:can_fly' in e.components);
}

/** Install the motion systems on an engine; the controls are the input module's. */
export function installPhysics(engine: SimEngine, controls: ControlState): void {
  engine.addSystem({
    name: 'players', order: ORDER.players, tick(en) {
      for (const p of en.players) {
        if (!p.valid) continue;
        const c = controls.get(p.id);
        const sneakEdge = controls.takeSneakEdge(p.id);
        if (p.ridingOn) {
          // Sneak dismounts a rider (quirk `sneak-dismounts`); there is no dismount event for scripts.
          if (sneakEdge) {
            const mount = p.ridingOn;
            mount.removeRider(p);
            p.velocity = { x: 0, y: 0, z: 0 };
            p.onGround = false;
            dismountSpot(p, en.dimension(p.dimension));
            en.emit('dismounted', { rider: p, mount, cause: 'sneak' });
          }
          continue;
        }
        const world = en.dimension(p.dimension);
        if (!world.isLoaded(p.location.x, p.location.z)) continue;
        const move = stickToWorld(c, p.rotation.y);
        const r = tickPlayer(world, stateOf(p), { move, jump: c.jump, sneak: c.sneak, sprint: c.sprint, slowFalling: hasEffect(p, 'slow_falling') });
        p.location = { x: r.state.x, y: r.state.y, z: r.state.z };
        p.velocity = { x: r.state.vx, y: r.state.vy, z: r.state.vz };
        p.onGround = r.state.onGround;
        trackFall(en, p);
      }
    },
  });

  engine.addSystem({
    name: 'mounts', order: ORDER.mounts, tick(en) {
      for (const m of en.loadedEntities()) {
        if (!isHoverMount(m)) continue;
        const driver = m.riders[0];
        const fs = (m.components['minecraft:flying_speed'] as { value?: number } | undefined)?.value ?? 0.1;
        let vx = 0, vy = 0, vz = 0;
        if (driver?.valid && driver.isPlayer) {
          const c = controls.get(driver.id);
          m.rotation.y = driver.rotation.y;
          // The measured fit holds between the measured values (0.09, 0.3); a flying speed of 0 (a scripted
          // vehicle's native speed) does not move the mount natively (physics spec §4.6).
          const speed = fs > 0 ? (quirkValue('hover-controller-speed', 'blocksPerSecondPerFlyingSpeed') * fs + quirkValue('hover-controller-speed', 'offsetBlocksPerSecond')) / TICKS_PER_SECOND : 0;
          const mag = Math.min(1, Math.hypot(c.forward, c.strafe));
          if (mag > 0) { const w = stickToWorld(c, driver.rotation.y); const l = Math.hypot(w.x, w.z) || 1; vx = w.x / l * speed * mag; vz = w.z / l * speed * mag; }
          if (c.jump) {
            // Jump drives `vertical_movement_action`: +climb, or -descend when the descend group is in (quirk `hover-descend-needs-jump`).
            const action = (m.components['minecraft:vertical_movement_action'] as { vertical_velocity?: number } | undefined)?.vertical_velocity ?? 0;
            vy = action > 0 ? quirkValue('hover-climb-descend', 'climbBlocksPerSecond') / TICKS_PER_SECOND : action < 0 ? -quirkValue('hover-climb-descend', 'descendBlocksPerSecond') / TICKS_PER_SECOND : 0;
          }
        }
        if (!vx && !vy && !vz) continue;
        const world = en.dimension(m.dimension);
        const { width, height } = m.collisionSize();
        const box = { x0: m.location.x - width / 2, y0: m.location.y, z0: m.location.z - width / 2, x1: m.location.x + width / 2, y1: m.location.y + height, z1: m.location.z + width / 2 };
        const r = m.physics().collision ? moveBox(world, box, { dx: vx, dy: vy, dz: vz }, false) : { dx: vx, dy: vy, dz: vz };
        m.location = { x: m.location.x + r.dx, y: m.location.y + r.dy, z: m.location.z + r.dz };
      }
    },
  });

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
    name: 'riders', order: ORDER.riders, tick(en) {
      for (const e of en.entities.values()) if (e.valid && e.riders.length) e.placeRiders();
    },
  });

  engine.addSystem({
    name: 'effects', order: ORDER.effects, tick(en) {
      for (const e of en.entities.values()) for (const [id, fx] of e.effects) { if (--fx.duration <= 0) e.effects.delete(id); }
    },
  });
}

