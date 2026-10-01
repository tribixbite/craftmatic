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
 * player, so the ease cannot fight the client over the rider's rotation. The
 * cockpit view (hotbar slot 9, the rider's own first person) has no camera to
 * offset; there the runtime eases the rider's own yaw with `setRotation`
 * (pinball measured it applies yaw, not pitch, on a seated player) and
 * reports the yaw it set as `selfYaw`, so its own turn is not read as a drag.
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
} as const;
export type FreeLookParams = { readonly [K in keyof typeof FREE_LOOK]: number };

/** One rider's free look: the camera's yaw and pitch offsets over the vehicle's own (degrees; pitch + = down), ticks since the last drag, and what the last tick read. */
export interface FreeLookState {
  yaw: number; pitch: number; idle: number;
  lastPlayerYaw?: number; lastPlayerPitch?: number; lastRel?: number;
  /** The vehicle's yaw over the last `RIDER_YAW_LAG_TICKS` + 1 ticks, oldest first. */
  vehicleYaws: number[];
}
/**
 * One tick's reading: the rider's reported look, the vehicle's yaw and speed,
 * and `selfYaw`, the yaw change this runtime itself put on the rider last
 * tick (the cockpit view's ease), which is not a drag.
 */
export interface FreeLookInput { playerYaw: number; playerPitch: number; vehicleYaw: number; speed: number; selfYaw?: number }

/** A fresh free look: centred, idle. */
export function freeLookStart(): FreeLookState { return { yaw: 0, pitch: 0, idle: 0, vehicleYaws: [] }; }

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
  if (s.lastPlayerYaw === undefined || s.lastPlayerPitch === undefined || s.lastRel === undefined) {
    return { state: { ...s, vehicleYaws: yaws, lastPlayerYaw: input.playerYaw, lastPlayerPitch: input.playerPitch, lastRel: rel }, dragging: false, recentring: false };
  }
  const self = input.selfYaw ?? 0;
  // The rider's look changed by `dAbs` in the world and by `dRel` against the (lagged) vehicle: if the
  // device carries the rider round with the vehicle a turn moves dAbs and not dRel, if it does not a turn
  // moves dRel and not dAbs - the smaller is what the finger did.
  const dAbs = wrap(input.playerYaw - s.lastPlayerYaw - self);
  const dRel = wrap(rel - s.lastRel - self);
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
