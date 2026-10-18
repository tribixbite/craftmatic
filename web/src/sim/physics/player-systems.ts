/**
 * The engine systems that move PLAYERS and what they ride, each tick:
 *
 *   players   each player's queued touch drag first (input/drag.ts, routed
 *             by the control scheme), then the per-tick player (`tickPlayer`)
 *             over the dimension's voxels from the held controls; a riding
 *             player instead drives its mount (native hover controller) or
 *             dismounts on a sneak;
 *   mounts    native hover mounts (`free_camera_controlled` + hover movement,
 *             a flyer's or rotorcraft's controller) at the device-measured
 *             speeds (quirks `hover-controller-speed`, `hover-climb-descend`,
 *             `hover-descend-needs-jump`), moved in 4-tick bursts (quirk
 *             `native-mount-bursts`);
 *   riders    a newly seated player's yaw snapped onto the heading (quirk
 *             `mount-snaps-rider-yaw`), then every rider back on its seat
 *             after its mount moved, a player on a lock-181 seat turned round
 *             with its vehicle `rider-yaw-lag` ticks late (the carry that spun
 *             the Nimbus, Saga 30l).
 *
 * Split out of `systems.ts` (which keeps the bodies: mobs and effects) so the
 * input/client work and the world/body work edit different files.
 */

import { ORDER, type SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import { quirkValue } from '../quirks/registry.js';
import { PLAYER_EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH, TICKS_PER_SECOND, moveBox, tickPlayer } from './body.js';
import type { VoxelWorld } from '../world/voxel-world.js';
import { stickToWorld, type ControlState } from '../input/controls.js';
import { hasEffect, stateOf, trackFall, wrapDeg } from './shared.js';
import { applyPendingDrag } from '../input/drag.js';

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
 * The point a dismount's search runs about (quirk `dismount-near-seat`): the rider's SEAT - recovered from
 * where the rider sat, its feet `PLAYER_EYE_HEIGHT - eyeAboveSeat` under the seat (`SimEntity.placeRider`) -
 * raised to the seat entity's point where the seat sits under it. On every measured scenery seat (the
 * moulded `seatBehavior`, its seat 0.3 under the entity) that IS the seat entity's point, as
 * `dismount-free-spot` was measured; on a vehicle whose seat is high in a big hull it is the seat (Pixel 30l:
 * off 76286 at 200 % the player fell ~9 blocks from the seat's height, not from the ground at its origin).
 * TODO(dismount-ref): the horizontal order about a vehicle seat is assumed to be the scenery seat's.
 */
export function dismountReference(p: SimEntity, mount: SimEntity): { x: number; y: number; z: number } {
  const m = mount.location;
  if (!p.isPlayer) return { ...m };
  const seatY = p.location.y + PLAYER_EYE_HEIGHT - quirkValue('rider-eye-above-seat', 'eyeAboveSeatBlocks');
  return { x: p.location.x, y: Math.max(m.y, seatY), z: p.location.z };
}

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
  const ref = dismountReference(p, mount);
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

/**
 * The mount snap (quirk `mount-snaps-rider-yaw`, modelled since 2026-10-08): the yaw OFFSET a PLAYER has from the
 * mount's heading when it is first seen seated is taken out over the next ticks - `snapSharePerTick` of what is
 * left each tick, the rest at `snapTicksMax` - and the pitch is kept. It is the offset at mounting that is removed,
 * not every later look change: a drag made during those ticks stays (whether the device's client fights a finger
 * through its snap is not measured), and the vehicle's own turns reach the rider by the carry (`rider-yaw-lag`).
 * Any seat, however the rider got on (a hold, `addRider`, `/ride`): the riders system watches who sits where rather
 * than hooking `SimEntity.addRider`, so a script mount and a scenario's direct `addRider` meet the same snap. Saga
 * 30k: the free look read the device's snap as a 180-degree drag until `FREE_LOOK.MOUNT_SETTLE_TICKS`.
 */
function snapNewRiders(en: SimEngine, seatedOn: Map<string, { mount: string; ticks: number; left: number }>): void {
  const share = quirkValue('mount-snaps-rider-yaw', 'snapSharePerTick'), last = Math.round(quirkValue('mount-snaps-rider-yaw', 'snapTicksMax'));
  for (const p of en.players) {
    const m = p.valid ? p.ridingOn : undefined;
    if (!m) { seatedOn.delete(p.id); continue; }
    const rec = seatedOn.get(p.id);
    const s = rec && rec.mount === m.id ? { ...rec, ticks: rec.ticks + 1 } : { mount: m.id, ticks: 0, left: wrapDeg(m.rotation.y - p.rotation.y) };
    if (s.ticks <= last && s.left !== 0) {
      const step = s.ticks === last ? s.left : s.left * share;
      p.rotation = { x: p.rotation.x, y: wrapDeg(p.rotation.y + step) };
      s.left -= step;
    }
    seatedOn.set(p.id, s);
  }
}

/** Install the player, mount and rider systems on an engine; the controls are the input module's. */
export function installPlayerSystems(engine: SimEngine, controls: ControlState): void {
  /** Players whose last move decided an auto-jump (`PlayerControls.autoJump`): they jump on the next tick. */
  const autoJumpPending = new Map<string, boolean>();
  engine.addSystem({
    name: 'players', order: ORDER.players, tick(en) {
      for (const p of en.players) {
        if (!p.valid) continue;
        // The client's look arrives with its input: a queued touch drag turns the look (or only the camera orbit)
        // before anything moves, routed by the control scheme (input/drag.ts, quirk `control-scheme-drag-to-camera`).
        applyPendingDrag(en, controls, p);
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

  /** Each native mount's move not yet applied: the controller's server position moves every `burstTicks` ticks. */
  const burstMove = new Map<string, { x: number; y: number; z: number }>();
  engine.addSystem({
    name: 'mounts', order: ORDER.mounts, tick(en) {
      const burst = Math.max(1, Math.round(quirkValue('native-mount-bursts', 'burstTicks')));
      for (const id of [...burstMove.keys()]) if (!en.entities.get(id)?.valid) burstMove.delete(id);
      for (const m of en.loadedEntities()) {
        if (!isHoverMount(m)) continue;
        const driver = m.riders[0];
        const fs = (m.components['minecraft:flying_speed'] as { value?: number } | undefined)?.value ?? 0.1;
        let vx = 0, vy = 0, vz = 0;
        if (driver?.valid && driver.isPlayer) {
          const c = controls.get(driver.id);
          // A native mount turns toward its rider's reported look by a share of the offset a tick (quirk
          // `hover-turn-chase`: 0.144, the Nimbus's 6.5 degrees a tick at a 45-degree offset); a scripted vehicle
          // (flying speed 0) is turned by its script alone, whatever its rider looks at (quirk `rider-free-look`).
          if (fs > 0) m.rotation.y = wrapDeg(m.rotation.y + wrapDeg(driver.rotation.y - m.rotation.y) * quirkValue('hover-turn-chase', 'offsetShareTurnedPerTick'));
          // The measured fit holds between the measured values (0.09, 0.3); a flying speed of 0 (a scripted
          // vehicle's native speed) does not move the mount natively (physics spec §4.6).
          const speed = fs > 0 ? (quirkValue('hover-controller-speed', 'blocksPerSecondPerFlyingSpeed') * fs + quirkValue('hover-controller-speed', 'offsetBlocksPerSecond')) / TICKS_PER_SECOND : 0;
          const mag = Math.min(1, Math.hypot(c.forward, c.strafe));
          // The stick acts in the MOUNT's frame - forward along the body's heading, right to its right - never the
          // rider's look (quirk `hover-stick-body-frame`, Saga 30m: look 107, body 0, forward flew 13 degrees off the
          // body and 94 off the look). Until 2026-10-08 the simulator flew along the look (a vanilla Happy Ghast
          // ASSUMED), and the 30m Nimbus, whose body a `carried` verdict never turns, steered here and not on the phone.
          if (mag > 0) { const w = stickToWorld(c, m.rotation.y); const l = Math.hypot(w.x, w.z) || 1; vx = w.x / l * speed * mag; vz = w.z / l * speed * mag; }
          if (c.jump) {
            // Jump drives `vertical_movement_action`: +climb, or -descend when the descend group is in (quirk `hover-descend-needs-jump`).
            const action = (m.components['minecraft:vertical_movement_action'] as { vertical_velocity?: number } | undefined)?.vertical_velocity ?? 0;
            vy = action > 0 ? quirkValue('hover-climb-descend', 'climbBlocksPerSecond') / TICKS_PER_SECOND : action < 0 ? -quirkValue('hover-climb-descend', 'descendBlocksPerSecond') / TICKS_PER_SECOND : 0;
          }
        }
        // The server position moves in BURSTS (quirk `native-mount-bursts`, modelled since 2026-10-08): the
        // controller's move is summed and applied on the world ticks divisible by `burstTicks`, so a script reading
        // the mount sees it stand, then jump; its yaw chase above stays per tick.
        const acc = burstMove.get(m.id) ?? { x: 0, y: 0, z: 0 };
        acc.x += vx; acc.y += vy; acc.z += vz;
        if (!acc.x && !acc.y && !acc.z) { burstMove.delete(m.id); continue; }
        if (en.tick % burst !== 0) { burstMove.set(m.id, acc); continue; }
        burstMove.delete(m.id);
        const world = en.dimension(m.dimension);
        const { width, height } = m.collisionSize();
        const box = { x0: m.location.x - width / 2, y0: m.location.y, z0: m.location.z - width / 2, x1: m.location.x + width / 2, y1: m.location.y + height, z1: m.location.z + width / 2 };
        const r = m.physics().collision ? moveBox(world, box, { dx: acc.x, dy: acc.y, dz: acc.z }, false) : { dx: acc.x, dy: acc.y, dz: acc.z };
        m.location = { x: m.location.x + r.dx, y: m.location.y + r.dy, z: m.location.z + r.dz };
      }
    },
  });

  /**
   * Each ridden entity's yaw over the last `rider-yaw-lag` + 2 ticks (oldest first), for the carry: the device
   * turns a lock-181 seat's rider round with its vehicle, `rider-yaw-lag` ticks late.
   */
  const yawTrail = new Map<string, number[]>();
  /** Each seated PLAYER's mount and the ticks since it was first seen on it, for the mount snap. */
  const seatedOn = new Map<string, { mount: string; ticks: number; left: number }>();
  engine.addSystem({
    name: 'riders', order: ORDER.riders, tick(en) {
      const lag = Math.max(0, Math.round(quirkValue('rider-yaw-lag', 'ticks')));
      snapNewRiders(en, seatedOn);
      for (const id of [...yawTrail.keys()]) { const e = en.entities.get(id); if (!e?.valid || !e.riders.length) yawTrail.delete(id); }
      for (const e of en.entities.values()) {
        if (!e.valid || !e.riders.length) continue;
        // The carry (quirk `rider-yaw-lag`, modelled since 2026-10-08): a PLAYER on a seat whose
        // `lock_rider_rotation` is not 0 is turned by the vehicle's own turn of `lag` ticks ago, whoever turned
        // the vehicle (the hover controller's chase, a script's teleport or setRotation) - the client turns the
        // rider with the drawn vehicle. On the Saga one swipe then spun the Nimbus for 40 s: its controller chased
        // a look that was carried round with it (`hover-turn-chase`).
        const trail = yawTrail.get(e.id) ?? [];
        trail.push(e.rotation.y);
        while (trail.length > lag + 2) trail.shift();
        yawTrail.set(e.id, trail);
        if (trail.length === lag + 2) {
          const turned = wrapDeg(trail[1]! - trail[0]!);
          if (turned !== 0) {
            const seats = e.rideable()?.seats ?? [];
            e.riders.forEach((r, i) => {
              if (!r?.valid || !r.isPlayer) return;
              const lock = seats[Math.min(i, Math.max(0, seats.length - 1))]?.lockRiderRotation;
              if (lock !== 0) r.rotation.y = wrapDeg(r.rotation.y + turned);
            });
          }
        }
        e.placeRiders();
      }
    },
  });
}
