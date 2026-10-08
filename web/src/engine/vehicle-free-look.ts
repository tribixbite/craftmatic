/**
 * Free look for a vehicle's rider (2026-09-30, the user's words: "all
 * vehicles should allow you to move the camera around instead of locking you
 * in place. If you stop moving camera it should semi gradually automatically
 * turn to point in the direction of travel (forward) while moving").
 *
 * A scripted vehicle's rider is watched from a script-driven chase camera
 * (`minecraft:free`, playable-addon.ts `vehicleCameraRuntime`) that used to
 * sit on the vehicle's tail whatever the rider did: the seat locked the
 * rider's yaw (`lock_rider_rotation: 0`) and the camera never read the
 * rider's look. Now the seat lets the rider turn (`SEAT_LOCK_DEG`, the
 * rideable component's own "no limit" value, as the coaster seats have it),
 * and the camera orbits the vehicle by an OFFSET this module keeps:
 *
 *   - a DRAG is read from the rider's reported look: its change since the
 *     last tick, net of what the vehicle's own turn explains. Whether the
 *     device carries a rider's yaw round with a turning vehicle is not
 *     measured for these seats (quirk `rider-free-look`, assumed): the coaster
 *     rider's reported yaw trails its car ~`RIDER_YAW_LAG_TICKS` (quirk
 *     `rider-yaw-lag`), so a carried yaw is compared with the vehicle's yaw
 *     that long ago, and the smaller of the two explanations (carried, or not
 *     carried) is taken as the drag - a steady turn reads as no drag either
 *     way, a finger on the screen reads as a drag either way;
 *   - the drag moves the camera's yaw and pitch offsets (pitch clamped from
 *     `PITCH_UP_MAX` up to `PITCH_DOWN_MAX` down);
 *   - after `IDLE_TICKS` with no drag, while the vehicle moves at least
 *     `MOVING_SPEED`, the offsets ease back to the vehicle's heading with the
 *     time constant `RECENTRE_SECONDS` (63 % in 0.6 s, 95 % in ~1.8 s), never
 *     slower than `MIN_STEP_DEG` a tick, so it finishes; at rest the view
 *     stays where the child left it. A new drag stops the ease at once.
 *
 * The offsets are the CAMERA's, not the player's: nothing here moves the
 * player, so the ease cannot fight the client over the rider's rotation.
 *
 * The cockpit view (hotbar slot 9) is a camera too (`cockpitCamera`), since
 * 2026-10-07: a free camera at the driver's eye, looking along the vehicle's
 * heading and nose turned by the same offsets, so a drag looks round and the
 * view eases back to the front (yaw AND pitch) exactly as the chase camera
 * does. It used to be the rider's own first person, its yaw eased with
 * `setRotation` - and on the Saga (26.52, round 30j) `setRotation` on a rider
 * of a lock-181 seat did nothing: CMCAM `riderYaw` held 11.9 through every
 * ease, the McLaren's view stayed 56 degrees off its nose and the X-wing's
 * kept the pitch it had (quirk `rider-free-look`). Entering either view
 * starts aligned with the nose (the runtime restarts the free look), and so
 * does a MOUNT: the device turns a mounting rider onto the seat's heading
 * over its first ticks, which is not a drag (`MOUNT_SETTLE_TICKS`; Saga 30k:
 * the chase camera opened wherever the player had been looking).
 */

/** Every free-look number (physics spec §9). */
export const FREE_LOOK = {
  /** A scripted vehicle seat's `lock_rider_rotation`: the component's default and "no limit" (181: more than a half turn either way). */
  SEAT_LOCK_DEG: 181,
  /** Ticks with no drag before the view starts back toward the heading (1 s). */
  IDLE_TICKS: 20,
  /** Time constant of the ease back, seconds: 63 % of the way in this, 95 % in three times it. */
  RECENTRE_SECONDS: 0.6,
  /** Slowest ease back, degrees a tick, so it settles instead of creeping. */
  MIN_STEP_DEG: 0.15,
  /** Moving at least this fast (blocks/s) is travelling; slower, the view stays where the child left it. */
  MOVING_SPEED: 0.5,
  /** A look change under this many degrees in a tick is noise, not a drag (a drag reads ~0.21 degrees per pixel, pinball 2026-09-25). */
  DRAG_EPS_DEG: 0.4,
  /** Furthest the view may be dragged UP over the vehicle's own pitch (degrees): further puts a chase camera under the ground. */
  PITCH_UP_MAX: 35,
  /** Furthest the view may be dragged DOWN (degrees): a look straight down onto the vehicle. */
  PITCH_DOWN_MAX: 70,
  /** Ticks a carried rider's reported yaw trails its vehicle (quirk `rider-yaw-lag`). */
  RIDER_YAW_LAG_TICKS: 6,
  /**
   * Ticks the cockpit camera's pose trails the server's vehicle: the client
   * draws a script-moved entity behind the server, and a camera on the
   * server's own schedule rides AHEAD of the drawn seat. Measured on the
   * Saga (26.52, round 30k, `output/device-round-2026-10-07k/saga/notes.md`
   * item 5): at the coaster's 1.5 (`COASTER_RIDER_VIEW.tickLag`, with the
   * same 0.1 s ease) the McLaren's eye sat 2.3-3.0 blocks ahead of its seat
   * at 43 mph (over the front of the hood: the eye is 0.22 ahead of the
   * origin, the nose 3.49) and the X-wing's 2-3 blocks up its nose at
   * 40 mph; at rest both were on the seat. Lead = speed x missing lag
   * (`cockpitEyeLead`), so the readings put the lag that keeps the eye on
   * the drawn seat at 3.9-4.6 ticks (McLaren) and 3.7-4.9 (X-wing)
   * (`cockpitLagFromLead`); 4 is inside both, on the low side (a residual
   * lead of at most 0.6 tick, 0.6 block at 43 mph, rather than an eye
   * dropped behind the driver). Quirk `cockpit-draw-lag`: the simulator's
   * vehicle course fails a cockpit camera that leads the drawn seat.
   */
  COCKPIT_TICK_LAG: 4,
  /** The cockpit camera's ease, seconds (the coaster's measured `COASTER_RIDER_VIEW.ease`; `COCKPIT_TICK_LAG` was measured with it). */
  COCKPIT_EASE_SECONDS: 0.1,
  /** Poses of the vehicle kept per rider for the cockpit camera's lag (ticks; more than `COCKPIT_TICK_LAG` + 1). */
  COCKPIT_HISTORY: 6,
  /** The cockpit camera's pitch is kept inside this (degrees): `setCamera` throws past ±90 (Pixel 26.51). */
  COCKPIT_PITCH_MAX: 89,
  /** The chase camera's wall test marches the line from the vehicle's pivot in steps of this, blocks. */
  CHASE_WALL_STEP: 0.25,
  /** A wall on that line pulls the camera in to this short of it, blocks (the near plane stays out of the texture). */
  CHASE_WALL_MARGIN: 0.3,
  /**
   * Ticks after a mount during which a change of the rider's look is the
   * SEAT's, not a drag: the device turns a mounting rider's yaw onto the
   * vehicle's within the first ~4-12 ticks (quirk `mount-snaps-rider-yaw`;
   * Saga 30k CMCAM `riderYaw` 0 -> -180 and -128 -> -180 on a vehicle at
   * -180, 54.8 -> -82.8 -> -90 on one at -90), and the free look read that
   * turn as a drag of up to 180 degrees, so the chase camera opened wherever
   * the player had been looking (facing the rider, s32/s50) until a slot
   * switch restarted it. The look is re-read each tick until the turn has
   * landed (`MOUNT_ALIGN_TICKS` ticks within `MOUNT_ALIGN_DEG` of the
   * heading) or this runs out; a drag in that first second is not read.
   */
  MOUNT_SETTLE_TICKS: 20,
  /** The rider's yaw within this of the vehicle's (degrees) is the seat's turn landed (30k: 18.3 on a vehicle at 19). */
  MOUNT_ALIGN_DEG: 3,
  /** Consecutive ticks within `MOUNT_ALIGN_DEG` that end the settle early. */
  MOUNT_ALIGN_TICKS: 2,
} as const;
export type FreeLookParams = { readonly [K in keyof typeof FREE_LOOK]: number };

/** One rider's free look: the camera's yaw and pitch offsets over the vehicle's own (degrees; pitch + = down), ticks since the last drag, and what the last tick read. */
export interface FreeLookState {
  yaw: number; pitch: number; idle: number;
  lastPlayerYaw?: number; lastPlayerPitch?: number; lastRel?: number;
  /** The vehicle's yaw over the last `RIDER_YAW_LAG_TICKS` + 1 ticks, oldest first. */
  vehicleYaws: number[];
  /** Ticks of a mount's settle left (`MOUNT_SETTLE_TICKS`): while above 0 a look change is the seat's turn, not a drag. */
  settle?: number;
  /** Consecutive settle ticks with the rider's yaw on the heading (`MOUNT_ALIGN_TICKS` of them end the settle). */
  aligned?: number;
}
/** One tick's reading: the rider's reported look and the vehicle's yaw and speed. */
export interface FreeLookInput { playerYaw: number; playerPitch: number; vehicleYaw: number; speed: number }

/**
 * A fresh free look: centred, idle. `settleTicks` > 0 on a MOUNT
 * (`MOUNT_SETTLE_TICKS`), so the seat's turn of the rider is not read as a
 * drag; a switch of view starts with none (that turn is long over).
 */
export function freeLookStart(settleTicks = 0): FreeLookState { return { yaw: 0, pitch: 0, idle: 0, vehicleYaws: [], ...(settleTicks > 0 ? { settle: settleTicks, aligned: 0 } : {}) }; }

/**
 * Advance one rider's free look by a tick of `dt` seconds. Pure (serialised
 * into the camera runtime); returns the new state, whether the rider dragged
 * this tick and whether the view is easing back.
 */
export function freeLookStep(s: FreeLookState, input: FreeLookInput, P: FreeLookParams, dt: number): { state: FreeLookState; dragging: boolean; recentring: boolean } {
  const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const yaws = [...s.vehicleYaws, input.vehicleYaw].slice(-(Math.max(0, Math.round(P.RIDER_YAW_LAG_TICKS)) + 1));
  const lagged = yaws[0]!;
  const rel = wrap(input.playerYaw - lagged);
  // A mount's settle: the device is turning the rider onto the seat's heading. Re-read the look (no drag, the
  // view on the nose) until that turn has landed for `MOUNT_ALIGN_TICKS` ticks, the first reading included,
  // or the settle runs out.
  if ((s.settle ?? 0) > 0) {
    const aligned = Math.abs(wrap(input.playerYaw - input.vehicleYaw)) <= P.MOUNT_ALIGN_DEG ? (s.aligned ?? 0) + 1 : 0;
    const settle = aligned >= P.MOUNT_ALIGN_TICKS ? 0 : (s.settle ?? 0) - 1;
    return { state: { yaw: 0, pitch: 0, idle: 0, vehicleYaws: yaws, lastPlayerYaw: input.playerYaw, lastPlayerPitch: input.playerPitch, lastRel: rel, settle, aligned }, dragging: false, recentring: false };
  }
  if (s.lastPlayerYaw === undefined || s.lastPlayerPitch === undefined || s.lastRel === undefined) {
    return { state: { ...s, vehicleYaws: yaws, lastPlayerYaw: input.playerYaw, lastPlayerPitch: input.playerPitch, lastRel: rel }, dragging: false, recentring: false };
  }
  // The rider's look changed by `dAbs` in the world and by `dRel` against the (lagged) vehicle: if the
  // device carries the rider round with the vehicle a turn moves dAbs and not dRel, if it does not a turn
  // moves dRel and not dAbs - the smaller is what the finger did.
  const dAbs = wrap(input.playerYaw - s.lastPlayerYaw);
  const dRel = wrap(rel - s.lastRel);
  const dYaw = Math.abs(dRel) < Math.abs(dAbs) ? dRel : dAbs;
  const dPitch = input.playerPitch - s.lastPlayerPitch;
  const dragYaw = Math.abs(dYaw) > P.DRAG_EPS_DEG, dragPitch = Math.abs(dPitch) > P.DRAG_EPS_DEG;
  let yaw = s.yaw, pitch = s.pitch, idle = s.idle, recentring = false;
  if (dragYaw || dragPitch) {
    if (dragYaw) yaw = wrap(yaw + dYaw);
    if (dragPitch) pitch = clamp(pitch + dPitch, -P.PITCH_UP_MAX, P.PITCH_DOWN_MAX);
    idle = 0;
  } else {
    idle = s.idle + 1;
    if (idle >= P.IDLE_TICKS && Math.abs(input.speed) >= P.MOVING_SPEED && (yaw !== 0 || pitch !== 0)) {
      recentring = true;
      const k = 1 - Math.exp(-dt / P.RECENTRE_SECONDS);
      const ease = (v: number): number => (Math.abs(v) <= P.MIN_STEP_DEG ? 0 : v - Math.sign(v) * Math.max(Math.abs(v) * k, P.MIN_STEP_DEG));
      yaw = ease(yaw);
      pitch = ease(pitch);
    }
  }
  return {
    state: { yaw, pitch, idle, vehicleYaws: yaws, lastPlayerYaw: input.playerYaw, lastPlayerPitch: input.playerPitch, lastRel: rel },
    dragging: dragYaw || dragPitch, recentring,
  };
}

/** One tick of the vehicle as the cockpit camera reads it: position (blocks), yaw (Bedrock) and nose pitch (degrees, + = down, the camera's sign). */
export interface CockpitPose { x: number; y: number; z: number; yaw: number; pitch: number }

/**
 * The cockpit view's camera (hotbar slot 9): a free camera at the driver's
 * eye, looking along the vehicle's heading and nose turned by the free-look
 * offsets. Pure (serialised into the camera runtime).
 *
 * `poses` are the vehicle's last ticks, oldest first; the camera shows the
 * pose `lag` ticks back (fractions interpolated, yaw the short way round;
 * fewer poses than that: the oldest), because the client draws the vehicle
 * behind the server (`COCKPIT_TICK_LAG`). `eye` is the driver's eye in the
 * vehicle's frame at 100 % (x across, y up, z toward the nose - the
 * rideable seat's frame), scaled by the vehicle's `size` as the seat is
 * (cockpit-seat.ts `seatPositionAt`: the eye stays on the scaled driver's
 * eye). The pitch is clamped to `pitchMax` (`setCamera` refuses past 90).
 * TODO(cockpit-pitch): the eye is carried by the heading only; a pitched
 * ship's drawn cockpit turns about its bone pivot, which this does not know.
 */
export function cockpitCamera(poses: readonly CockpitPose[], lag: number, eye: readonly [number, number, number], size: number, offset: { yaw: number; pitch: number }, pitchMax: number): { location: { x: number; y: number; z: number }; rotation: { x: number; y: number } } | null {
  if (!poses.length) return null;
  const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
  const t = Math.max(0, poses.length - 1 - Math.max(0, lag));
  const i = Math.floor(t), j = Math.min(poses.length - 1, i + 1), f = t - i;
  const a = poses[i]!, b = poses[j]!;
  const yaw = a.yaw + wrap(b.yaw - a.yaw) * f;
  const pose = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, pitch: a.pitch + (b.pitch - a.pitch) * f };
  // The seat frame turned by the yaw: Bedrock yaw 0 faces +z, its forward is (-sin, cos), its x axis (cos, sin).
  const r = yaw * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  const ex = eye[0] * size, ey = eye[1] * size, ez = eye[2] * size;
  return {
    location: { x: pose.x + ex * c - ez * sn, y: pose.y + ey, z: pose.z + ex * sn + ez * c },
    rotation: { x: Math.max(-pitchMax, Math.min(pitchMax, pose.pitch + offset.pitch)), y: wrap(yaw + offset.yaw) },
  };
}

/**
 * Blocks the cockpit eye is drawn AHEAD of the drawn seat (negative: behind
 * it) at `speedBlocksPerSecond`, for a camera on the vehicle's pose
 * `lagTicks` back when the device draws the vehicle `drawLagTicks` behind
 * the pose such a camera shows at lag 0 (quirk `cockpit-draw-lag`, measured
 * with the 0.1 s ease). Lead = speed x missing lag, a tick being 1/20 s.
 */
export function cockpitEyeLead(speedBlocksPerSecond: number, lagTicks: number, drawLagTicks: number): number {
  return speedBlocksPerSecond / 20 * (drawLagTicks - lagTicks);
}

/**
 * The lag that would have put the eye on the drawn seat, from one device
 * reading: the camera showed the pose `lagTicks` back and the eye was seen
 * `leadBlocks` ahead of the seat at `speedBlocksPerSecond` (the inverse of
 * `cockpitEyeLead`). A reading at rest says nothing: it returns `lagTicks`.
 */
export function cockpitLagFromLead(lagTicks: number, speedBlocksPerSecond: number, leadBlocks: number): number {
  return speedBlocksPerSecond > 0 ? lagTicks + leadBlocks / (speedBlocksPerSecond / 20) : lagTicks;
}
