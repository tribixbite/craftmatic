/**
 * Driven vehicles' client-side motion: the wheels spin with the distance the
 * vehicle actually rolls, the front wheels steer with its turn rate, and the
 * body leans, squats and (on water) bobs - all from the entity's own motion in
 * Molang, so it works the same for a vehicle the rider's client drives
 * (`input_ground_controlled`, client-authoritative), one the server moves (a
 * hover aircraft) and one a script teleports (the fixed-wing flight model).
 *
 * The rig is the compiler's (`CompileLdrawEntityOptions.vehicleRig`): every
 * bone hangs under `body`, each road wheel on its own `wheel_<n>` bone at its
 * axle. Angles follow the entity geometry's convention (the compiler's
 * `rotation = (-a, -b, c)` of a right-handed render frame, nose -Z, right +X):
 *
 *   - bone X +θ turns the top of a wheel toward the nose = rolling FORWARD,
 *     and lowers the nose of the body (so nose-UP is negative X);
 *   - bone Y +θ turns the nose to the vehicle's RIGHT;
 *   - bone Z +θ lifts the right side, i.e. rolls the body to its LEFT.
 *
 * Bedrock yaw grows clockwise seen from above (0 faces +Z, 90 faces -X), so a
 * rising `q.body_y_rotation` is a turn to the RIGHT. Molang trigonometry is in
 * degrees and every `v.` variable is set in `initialize` (an unset variable is
 * an error on every frame - pinball, 2026-09-24).
 */
import type { VehicleWheelBone } from './ldraw-entity-compiler.js';

/** How a vehicle moves, for its animation (and its driver runtime): an aircraft is a fixed wing or a rotor. */
export type VehicleMotion = 'car' | 'boat' | 'plane' | 'rotor';

const ROTOR_WORDS = /\b(helicopter|copter|heli|rotorcraft|gyrocopter|autogyro|drone|chopper|quadcopter)\b/i;

/** The motion class of a playable kind: an aircraft whose title names a rotorcraft hovers, any other flies on its wings. */
export function vehicleMotionOf(kind: 'car' | 'boat' | 'plane', label: string): VehicleMotion {
  if (kind !== 'plane') return kind;
  return ROTOR_WORDS.test(label) ? 'rotor' : 'plane';
}

/** The lean/pitch/steer gains of each motion class, degrees per unit. Chosen to read on screen, not to model a suspension. */
export const VEHICLE_BODY_MOTION: Readonly<Record<VehicleMotion, {
  /** Roll per degree/second of yaw rate (positive = lean OUTWARD, a car's body roll; negative = bank INTO the turn). */
  rollPerYawRate: number; rollMax: number;
  /** Nose-up per block/s² of forward acceleration (a car squats; a boat's bow rises). */
  pitchPerAccel: number; pitchMax: number;
  /** Aircraft: nose follows the flight path angle; a rotorcraft instead dips its nose with forward speed. */
  flightPath: boolean; noseDownPerSpeed: number;
  /** Front wheels steer by this many degrees per degree/second of yaw rate, up to `steerMax`. */
  steerPerYawRate: number; steerMax: number;
  /** Water bob (only while `q.is_in_water`): roll, pitch in degrees and heave in model units (1/16 block). */
  bobRoll: number; bobPitch: number; bobHeave: number;
}>> = {
  car: { rollPerYawRate: 0.045, rollMax: 4, pitchPerAccel: 0.35, pitchMax: 3, flightPath: false, noseDownPerSpeed: 0, steerPerYawRate: 0.35, steerMax: 28, bobRoll: 0, bobPitch: 0, bobHeave: 0 },
  boat: { rollPerYawRate: 0.06, rollMax: 6, pitchPerAccel: 0.5, pitchMax: 5, flightPath: false, noseDownPerSpeed: 0, steerPerYawRate: 0, steerMax: 0, bobRoll: 2.2, bobPitch: 1.4, bobHeave: 1.5 },
  plane: { rollPerYawRate: -0.55, rollMax: 40, pitchPerAccel: 0, pitchMax: 30, flightPath: true, noseDownPerSpeed: 0, steerPerYawRate: 0.35, steerMax: 25, bobRoll: 0, bobPitch: 0, bobHeave: 0 },
  rotor: { rollPerYawRate: -0.2, rollMax: 15, pitchPerAccel: 0, pitchMax: 14, flightPath: false, noseDownPerSpeed: 1.6, steerPerYawRate: 0, steerMax: 0, bobRoll: 0, bobPitch: 0, bobHeave: 0 },
};

/** Round for Molang text, so the pack is stable byte for byte. */
const n = (v: number): string => String(Math.round(v * 10000) / 10000);

/**
 * The drive animation of one vehicle entity and the client-entity script lines
 * that feed it. `animations`/`animate`/`initialize`/`preAnimation` drop straight
 * into playable-addon's `ClientAnimations`; `file` is the resource pack's
 * `animations/<cid>.animation.json`.
 */
export function vehicleClientAnimation(cid: string, motion: VehicleMotion, wheels: readonly VehicleWheelBone[]): {
  id: string; file: unknown;
  client: { animations: Record<string, string>; animate: string[]; initialize: string[]; preAnimation: string[] };
} {
  const g = VEHICLE_BODY_MOTION[motion];
  const id = `animation.craftmatic.${cid}.drive`;
  const initialize = [
    'v.cm_wheel = 0.0;', 'v.cm_roll = 0.0;', 'v.cm_pitch = 0.0;', 'v.cm_steer = 0.0;',
    'v.cm_yaw_prev = q.body_y_rotation;', 'v.cm_yaw_rate = 0.0;', 'v.cm_speed_prev = 0.0;', 'v.cm_accel = 0.0;',
    'v.cm_dt = 0.05;', 'v.cm_dyaw = 0.0;', 'v.cm_dir = 1.0;', 'v.cm_bob = 0.0;',
  ];
  const preAnimation = [
    'v.cm_dt = math.max(q.delta_time, 0.001);',
    // Yaw rate from the body yaw, unwrapped across ±180, smoothed (degrees per second; + = turning right).
    'v.cm_dyaw = q.body_y_rotation - v.cm_yaw_prev;',
    'v.cm_dyaw = v.cm_dyaw > 180 ? v.cm_dyaw - 360 : (v.cm_dyaw < -180 ? v.cm_dyaw + 360 : v.cm_dyaw);',
    'v.cm_yaw_prev = q.body_y_rotation;',
    'v.cm_yaw_rate = math.lerp(v.cm_yaw_rate, math.clamp(v.cm_dyaw / v.cm_dt, -360, 360), 0.15);',
    // Rolling direction: the motion's component along the heading (forward = (-sin yaw, cos yaw)).
    'v.cm_dir = (q.movement_direction(0) * -math.sin(q.body_y_rotation) + q.movement_direction(2) * math.cos(q.body_y_rotation)) < -0.2 ? -1.0 : 1.0;',
    // Distance rolled, as degrees of a one-block wheel; a wheel of radius r turns v.cm_wheel / r.
    'v.cm_wheel = v.cm_wheel + v.cm_dir * q.ground_speed * v.cm_dt * 57.2958;',
    'v.cm_accel = math.lerp(v.cm_accel, (q.ground_speed - v.cm_speed_prev) / v.cm_dt * v.cm_dir, 0.1);',
    'v.cm_speed_prev = q.ground_speed;',
    `v.cm_roll = math.lerp(v.cm_roll, math.clamp(v.cm_yaw_rate * ${n(g.rollPerYawRate)}, -${n(g.rollMax)}, ${n(g.rollMax)}), 0.12);`,
    g.flightPath
      // Nose up = negative X: along the flight path angle, clamped.
      ? `v.cm_pitch = math.lerp(v.cm_pitch, -math.clamp(math.atan2(q.vertical_speed, math.max(q.ground_speed, 1.0)), -${n(g.pitchMax)}, ${n(g.pitchMax)}), 0.12);`
      : g.noseDownPerSpeed
        ? `v.cm_pitch = math.lerp(v.cm_pitch, math.clamp(q.ground_speed * ${n(g.noseDownPerSpeed)}, 0, ${n(g.pitchMax)}), 0.08);`
        : `v.cm_pitch = math.lerp(v.cm_pitch, -math.clamp(v.cm_accel * ${n(g.pitchPerAccel)}, -${n(g.pitchMax)}, ${n(g.pitchMax)}), 0.12);`,
    `v.cm_steer = math.lerp(v.cm_steer, math.clamp(v.cm_yaw_rate * ${n(g.steerPerYawRate)}, -${n(g.steerMax)}, ${n(g.steerMax)}), 0.2);`,
    g.bobHeave ? 'v.cm_bob = q.is_in_water ? math.sin(q.life_time * 50) : 0.0;' : 'v.cm_bob = 0.0;',
  ];
  const bones: Record<string, unknown> = {
    body: {
      rotation: g.bobHeave
        ? [`v.cm_pitch + v.cm_bob * ${n(g.bobPitch)}`, 0, `v.cm_roll + (q.is_in_water ? math.sin(q.life_time * 37) * ${n(g.bobRoll)} : 0.0)`]
        : ['v.cm_pitch', 0, 'v.cm_roll'],
      ...(g.bobHeave ? { position: [0, `v.cm_bob * ${n(g.bobHeave)}`, 0] } : {}),
    },
  };
  for (const w of wheels) {
    const spin = `v.cm_wheel / ${n(Math.max(0.05, w.radiusBlocks))}`;
    bones[w.name] = { rotation: [spin, w.end === 1 && g.steerMax ? 'v.cm_steer' : 0, 0] };
  }
  return {
    id,
    file: { format_version: '1.8.0', animations: { [id]: { loop: true, bones } } },
    client: { animations: { drive: id }, animate: ['drive'], initialize, preAnimation },
  };
}
