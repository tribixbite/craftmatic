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
 * The spots a dismounted player is tried at, in the device's order, as (dx, dz) blocks from the SEAT
 * ENTITY's point (quirk `dismount-free-spot`, Pixel GameTest 2026-09-30, runs 2 and 3): world -z, +z,
 * then the diagonals (+x -z), (+x +z), (-x +z). A ring with +-z walled took (+x -z) even with +-x open,
 * so the plain x sides come after the diagonals. TODO(dismount-order): (-x -z), (+x 0) and (-x 0) were
 * never reached by a probe; their places here are a guess.
 */
export const DISMOUNT_OFFSETS: ReadonlyArray<readonly [number, number]> = [[0, -1], [0, 1], [1, -1], [1, 1], [-1, 1], [-1, -1], [1, 0], [-1, 0]];
/**
 * How far above / below the seat entity's point a candidate's floor may lie. Measured: a floor 0.3 under
 * the seat point and a slab top 0.2 over it were taken, a block top 0.7 over it and a floor 1.3 under it
 * were not. TODO(dismount-floor): the bounds are inside those brackets, not measured exactly.
 */
export const DISMOUNT_FLOOR_ABOVE = 0.5;
export const DISMOUNT_FLOOR_BELOW = 1;
/** With every candidate refused, the rider is put at the seat entity's point this far up (it then falls). */
export const DISMOUNT_FALLBACK_LIFT = 0.2;

/**
 * Put a PLAYER that left a seat (a sneak, `ejectRider`, `/ride stop_riding`) where the device puts it
 * (quirk `dismount-free-spot`): on the floor of the first free candidate one block from the seat
 * entity (`DISMOUNT_OFFSETS`), its box free there; else at the seat entity's point 0.2 up. The device
 * does this even in the open (run 2: an open seat's rider was set one block to -z), and even when the
 * rider sat inside a block (a seat sunk 0.1-0.3 into the floor, a block over the seat).
 */
export function setDownRider(p: SimEntity, mount: SimEntity, world: VoxelWorld): void {
  const h = PLAYER_WIDTH / 2, eps = 0.001;
  const boxAt = (q: { x: number; y: number; z: number }) => ({ x0: q.x - h, y0: q.y, z0: q.z - h, x1: q.x + h, y1: q.y + PLAYER_HEIGHT, z1: q.z + h });
  const ref = mount.location;
  const standAt = (x: number, z: number): { x: number; y: number; z: number } | undefined => {
    let top = -Infinity;
    for (const [dx, dz] of [[0, 0], [-h + 0.01, -h + 0.01], [h - 0.01, -h + 0.01], [-h + 0.01, h - 0.01], [h - 0.01, h - 0.01]] as const) top = Math.max(top, world.supportBelow(x + dx, ref.y + DISMOUNT_FLOOR_ABOVE, z + dz, 3));
    if (!(top >= ref.y - DISMOUNT_FLOOR_BELOW - eps)) return undefined;
    const q = { x, y: top, z };
    return world.overlapping(boxAt(q), eps) ? undefined : q;
  };
  for (const [dx, dz] of DISMOUNT_OFFSETS) {
    const q = standAt(ref.x + dx, ref.z + dz);
    if (q) { p.location = q; p.onGround = true; return; }
  }
  p.location = { x: ref.x, y: ref.y + DISMOUNT_FALLBACK_LIFT, z: ref.z };
  p.onGround = false;
}

/**
 * The push out of blocks a PLAYER gets while its box overlaps a solid (quirk `teleport-into-floor`,
 * Pixel GameTest 2026-09-30, `output/gametest-quirks-0930/run1/`). It is never lifted: the sweep
 * ignores a solid the box already overlaps (`clipY`), so it falls through to the surface under its
 * feet. Sideways, its velocity on the one axis whose move frees the box soonest is SET to
 * `pushBlocksPerTick` toward the free side, every tick it still overlaps; the rest is the ordinary
 * friction (the device drifted 0.12-0.34 past the point where it came free). A move that would put
 * the box into another solid, or needs more than `maxPushBlocks`, is not a candidate: a player in
 * the middle of a 3 x 3 pad (1.8 blocks from free) was not pushed at all.
 */
function pushOutOfBlocks(p: SimEntity, world: VoxelWorld): void {
  const h = PLAYER_WIDTH / 2, eps = 1e-3;
  const box = { x0: p.location.x - h, y0: p.location.y, z0: p.location.z - h, x1: p.location.x + h, y1: p.location.y + PLAYER_HEIGHT, z1: p.location.z + h };
  const inside = world.solidsNear(box, 0, 0, 0).filter(s => !s.unloaded && box.x1 > s.x0 + eps && box.x0 < s.x1 - eps && box.y1 > s.y0 + eps && box.y0 < s.y1 - eps && box.z1 > s.z0 + eps && box.z0 < s.z1 - eps);
  if (!inside.length) return;
  const push = quirkValue('teleport-into-floor', 'pushBlocksPerTick'), maxPush = quirkValue('teleport-into-floor', 'maxPushBlocks');
  let best: { axis: 'x' | 'z'; sign: number; d: number } | undefined;
  for (const [axis, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]] as const) {
    const d = Math.max(...inside.map(s => axis === 'x' ? (sign > 0 ? s.x1 - box.x0 : box.x1 - s.x0) : (sign > 0 ? s.z1 - box.z0 : box.z1 - s.z0)));
    if (d > maxPush || (best && d >= best.d)) continue;
    const dx = axis === 'x' ? sign * (d + eps) : 0, dz = axis === 'z' ? sign * (d + eps) : 0;
    if (world.overlapping({ x0: box.x0 + dx, y0: box.y0, z0: box.z0 + dz, x1: box.x1 + dx, y1: box.y1, z1: box.z1 + dz }, eps)) continue;
    best = { axis, sign, d };
  }
  if (!best) return;
  p.velocity = best.axis === 'x' ? { ...p.velocity, x: best.sign * push } : { ...p.velocity, z: best.sign * push };
}

/** Whether an entity is a native hover mount (the rotorcraft / flyer controller). */
export function isHoverMount(e: SimEntity): boolean {
  return 'minecraft:free_camera_controlled' in e.components && ('minecraft:movement.hover' in e.components || 'minecraft:can_fly' in e.components);
}

/** Install the motion systems on an engine; the controls are the input module's. */
export function installPhysics(engine: SimEngine, controls: ControlState): void {
  /** Players whose last move decided an auto-jump (`PlayerControls.autoJump`): they jump on the next tick. */
  const autoJumpPending = new Map<string, boolean>();
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
            setDownRider(p, mount, en.dimension(p.dimension));
            en.emit('dismounted', { rider: p, mount, cause: 'sneak' });
          }
          continue;
        }
        const world = en.dimension(p.dimension);
        if (!world.isLoaded(p.location.x, p.location.z)) continue;
        // A flying player hangs where it is (SimEntity.flying; its flight movement is not modelled).
        if (p.flying) { p.velocity = { x: 0, y: 0, z: 0 }; p.onGround = false; p.fall = undefined; continue; }
        pushOutOfBlocks(p, world);
        const move = stickToWorld(c, p.rotation.y);
        // Auto-jump decides after a move and jumps on the next tick: the decision is carried between ticks here.
        const r = tickPlayer(world, { ...stateOf(p), autoJumpPending: autoJumpPending.get(p.id) ?? false }, { move, jump: c.jump, sneak: c.sneak, sprint: c.sprint, slowFalling: hasEffect(p, 'slow_falling'), autoJump: !!c.autoJump });
        if (r.state.autoJumpPending) autoJumpPending.set(p.id, true); else autoJumpPending.delete(p.id);
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
          // A native mount turns to its rider's look; a scripted vehicle (flying speed 0) is turned by its
          // script alone, whatever its rider looks at (quirk `rider-free-look`, assumed).
          if (fs > 0) m.rotation.y = driver.rotation.y;
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

