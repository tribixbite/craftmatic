/**
 * Driven vehicles' client-side motion: the wheels spin with the distance the
 * vehicle actually rolls, the front wheels steer with its turn rate, and the
 * body leans and squats - from the entity's own motion in Molang for a vehicle
 * the rider's client drives (a car, `input_ground_controlled`) or the server
 * moves (a hover rotorcraft), and from actor properties for one the
 * scripted-vehicle runtime teleports (a fixed-wing aircraft, a boat on its
 * swell), which knows its exact attitude.
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
import { floatActorProperty } from './bedrock-json.js';
import { COLLIDER_STATES, colliderBodyProbe, colliderFormKit, type ColliderBodyProbe, type EscapeOptions } from './collider-form.js';

declare const world: any;
declare const system: any;

/**
 * How a vehicle moves, for its animation (and its driver runtime): an aircraft
 * is a fixed wing or a rotor; a HOVER craft (a sail barge, a landspeeder, a
 * hovercraft) floats a fixed height over land and water alike; a FLYER is a
 * free-flying mount (11390's Flying Nimbus, set-canon.ts): the rotor's native
 * hover controller without its sound, flame or nose dip, hovering in place
 * when idle and bobbing gently.
 */
export type VehicleMotion = 'car' | 'boat' | 'plane' | 'rotor' | 'hover' | 'flyer';

/**
 * A flyer's idle bob, drawn by the client (Molang on the `body` bone, no
 * script): `AMPLITUDE_UNITS` geometry units (1/16 block) up and down over a
 * `DEGREES_PER_SECOND` sine, 120 = one breath every 3 s. A hover craft's bob
 * is the runtime's; a flyer is a native mount whose position the client owns.
 */
export const FLYER_BOB = { AMPLITUDE_UNITS: 1, DEGREES_PER_SECOND: 120 } as const;

const ROTOR_WORDS = /\b(helicopter|copter|heli|rotorcraft|gyrocopter|autogyro|drone|chopper|quadcopter)\b/i;
/**
 * Craft that float on repulsors or an air cushion instead of touching the
 * ground or displacing water. Jabba's Sail Barge is titled a "barge" but
 * hovers in the film (vehicle audit 2026-09-25: it shipped as a boat that
 * could not leave the water); a "speeder" is a hover bike, not a fixed wing.
 */
export const HOVER_WORDS = /\b(hover\w*|sail ?barge|land ?speeder|speeder(?: bike)?|pod ?racer|repulsor\w*|air ?cushion)\b/i;

/** The motion class of a playable kind: a hover title floats, an aircraft whose title names a rotorcraft hovers, any other flies on its wings. */
export function vehicleMotionOf(kind: 'car' | 'boat' | 'plane', label: string): VehicleMotion {
  if (HOVER_WORDS.test(label)) return 'hover';
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
}>> = {
  car: { rollPerYawRate: 0.045, rollMax: 4, pitchPerAccel: 0.35, pitchMax: 3, flightPath: false, noseDownPerSpeed: 0, steerPerYawRate: 0.35, steerMax: 28 },
  // A boat's lean, squat and swell come from the runtime (`boatStep`, the swell in `scriptedVehicleRuntime`) through the actor properties.
  boat: { rollPerYawRate: 0, rollMax: 0, pitchPerAccel: 0, pitchMax: 0, flightPath: false, noseDownPerSpeed: 0, steerPerYawRate: 0, steerMax: 0 },
  plane: { rollPerYawRate: -0.55, rollMax: 40, pitchPerAccel: 0, pitchMax: 30, flightPath: true, noseDownPerSpeed: 0, steerPerYawRate: 0.35, steerMax: 25 },
  rotor: { rollPerYawRate: -0.2, rollMax: 15, pitchPerAccel: 0, pitchMax: 14, flightPath: false, noseDownPerSpeed: 1.6, steerPerYawRate: 0, steerMax: 0 },
  // A hover craft's lean, pitch and bob come from the runtime (`carStep` on `HOVER`, the bob in `scriptedVehicleRuntime`).
  hover: { rollPerYawRate: 0, rollMax: 0, pitchPerAccel: 0, pitchMax: 0, flightPath: false, noseDownPerSpeed: 0, steerPerYawRate: 0, steerMax: 0 },
  // A flyer banks a little into a turn and keeps its nose level: a cloud has no nose to dip. Its bob is `FLYER_BOB`.
  flyer: { rollPerYawRate: -0.12, rollMax: 10, pitchPerAccel: 0, pitchMax: 0, flightPath: false, noseDownPerSpeed: 0, steerPerYawRate: 0, steerMax: 0 },
};

/** Round for Molang text, so the pack is stable byte for byte. */
const n = (v: number): string => String(Math.round(v * 10000) / 10000);

/**
 * The drive animation of one vehicle entity and the client-entity script lines
 * that feed it. `animations`/`animate`/`initialize`/`preAnimation` drop straight
 * into playable-addon's `ClientAnimations`; `file` is the resource pack's
 * `animations/<cid>.animation.json`.
 */
export function vehicleClientAnimation(cid: string, motion: VehicleMotion, wheels: readonly VehicleWheelBone[], scripted = motion === 'plane' || motion === 'boat' || motion === 'hover'): {
  id: string; file: unknown;
  client: { animations: Record<string, string>; animate: string[]; initialize: string[]; preAnimation: string[] };
} {
  const g = VEHICLE_BODY_MOTION[motion];
  const id = `animation.craftmatic.${cid}.drive`;
  const initialize = [
    'v.cm_wheel = 0.0;', 'v.cm_roll = 0.0;', 'v.cm_pitch = 0.0;', 'v.cm_steer = 0.0;',
    'v.cm_yaw_prev = q.body_y_rotation;', 'v.cm_yaw_rate = 0.0;', 'v.cm_speed_prev = 0.0;', 'v.cm_accel = 0.0;',
    'v.cm_dt = 0.05;', 'v.cm_dyaw = 0.0;', 'v.cm_dir = 1.0;',
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
  ];
  if (scripted) {
    // A car, a boat or a fixed wing is moved by the scripted-vehicle runtime
    // (teleports), which writes its exact attitude - a boat's with its swell -
    // and wheel roll: nose-up pitch is negative X, a bank to the right (a
    // right turn) lowers the right side, i.e. negative Z.
    preAnimation.push(
      `v.cm_pitch = -q.property('${FLIGHT_PROPS.pitch}');`,
      `v.cm_roll = -q.property('${FLIGHT_PROPS.bank}');`,
      `v.cm_wheel = q.property('${FLIGHT_PROPS.wheel}');`,
    );
  }
  // A flyer breathes: its body rises and falls `FLYER_BOB.AMPLITUDE_UNITS` on a slow sine of the entity's life time.
  if (motion === 'flyer') { initialize.push('v.cm_bob = 0.0;'); preAnimation.push(`v.cm_bob = math.sin(q.life_time * ${n(FLYER_BOB.DEGREES_PER_SECOND)}) * ${n(FLYER_BOB.AMPLITUDE_UNITS)};`); }
  const bones: Record<string, unknown> = { body: { rotation: ['v.cm_pitch', 0, 'v.cm_roll'], ...(motion === 'flyer' ? { position: [0, 'v.cm_bob', 0] } : {}) } };
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

// ─── Spaceship flight model (every scripted aircraft) ─────────────────────────

/**
 * Direct, spaceship-style control for every scripted aircraft (a fixed wing,
 * the X-wing, the Milano, any ship or spacecraft), in world blocks and
 * seconds. The user's words (2026-09-30): "more like spaceship less like
 * flight simulator ... there should be a way to go straight up or backwards".
 * Until then this was a flight model (take-off run, elevator pitch, stall,
 * landing) that a five-year-old on a touch phone could not fly. Now:
 *
 *   - the stick's forward/back is THRUST along the heading: forward up to
 *     `MAX_SPEED`, back straight BACKWARDS up to `REVERSE_SPEED`; hands off it
 *     slows to a stop (`BRAKE`) and HOVERS where it is - no stall, no glide,
 *     no take-off run, no lift that needs speed;
 *   - the stick's left/right TURNS it, at rest too (`TURN_RATE`);
 *   - Jump goes STRAIGHT UP (`CLIMB_SPEED`); Jump with the stick pulled back
 *     past `DESCEND_STICK`, or Jump pressed while the view looks down past
 *     `DIVE_PITCH_DEG` (the rider's camera, `VEHICLE_DYNAMIC.lookPitch`),
 *     goes STRAIGHT DOWN (`DESCEND_SPEED`) - the Nimbus's own "back + Jump"
 *     and "look down + Jump" (Sneak is the dismount and cannot be an input);
 *   - it settles onto the ground or water under it when it comes down there
 *     and lifts off again on Jump; on the ground it glides over a rise of up
 *     to `STEP_UP`;
 *   - with nobody aboard it brakes and sinks gently (`IDLE_SINK`) to the
 *     ground and parks, so an abandoned ship is never out of reach;
 *   - the body pitches with its climb and dive and banks into a turn
 *     (attitude only, drawn by the animation; nothing depends on it).
 *
 * A block in the way is the runtime's (`resolveMove`): a ship lifts itself
 * over a hill or a wall it is pushed into (`AUTO_CLIMB`), steps sideways round
 * a trunk it meets with a corner, and slides along a wall it meets at an
 * angle, instead of stopping dead.
 */
export const FLIGHT = {
  MAX_SPEED: 18, REVERSE_SPEED: 8, ACCEL: 12, BRAKE: 24,
  TURN_RATE: 80,
  CLIMB_SPEED: 8, DESCEND_SPEED: 8, VERTICAL_ACCEL: 24, IDLE_SINK: 3,
  AUTO_CLIMB: 8, STEP_UP: 1,
  /**
   * An empty ship sinking to park never comes down onto a player under its footprint (the rider who
   * just sneaked off and fell under it: the X-wing parked ON the child, Saga 30j s79, CMVT 15:28:07-11).
   * It holds `PARK_CLEARANCE` blocks over the head of anyone under it (a player is `PLAYER_HEIGHT`
   * tall, Minecraft's 1.8; the clearance is over a standing jump's 1.25) and sinks on when they walk out.
   */
  PLAYER_HEIGHT: 1.8, PARK_CLEARANCE: 1.5,
  PITCH_PER_CLIMB: 2.5, PITCH_PER_ACCEL: 0.8, PITCH_MAX: 20, BANK_PER_TURN: 0.25, BANK_MAX: 25, ATTITUDE_RATE: 60,
  /** Stick back past this (with Jump held) goes down instead of up. */
  DESCEND_STICK: -0.5,
  /** A view looking down past this many degrees when Jump is PRESSED goes down until Jump is let go. */
  DIVE_PITCH_DEG: 25,
  /** Sign of `inputInfo.getMovementVector().x` that means RIGHT (Minecraft's +x strafe is LEFT). */
  STICK_X_RIGHT: -1,
  /** Stick deflection under which an axis counts as centred. */
  DEADZONE: 0.15,
  /** Deflection that counts as FULL: a touch stick pushed to its rim reads 0.816 on the Pixel (2026-09-25). */
  STICK_FULL: 0.8,
} as const;
export type FlightParams = { readonly [K in keyof typeof FLIGHT]: number };

/**
 * One ship's state: world position, heading (degrees, Bedrock yaw), speed along
 * the heading (negative = backwards), vertical speed, whether it rests on the
 * ground, the attitude its animation shows, and the Jump latch (`jumpHeld`:
 * Jump was down last tick; `diving`: this press of Jump goes down).
 */
export interface FlightState { x: number; y: number; z: number; yaw: number; pitch: number; speed: number; vy: number; onGround: boolean; bank: number; jumpHeld: boolean; diving: boolean }
/**
 * The controlling rider's input this tick: the stick (`getMovementVector`,
 * forward = +y) and Jump; `rider` false = nobody aboard. `lookPitch` is where
 * the rider's VIEW looks (degrees, + = down), when a camera runtime reports it.
 */
export interface FlightInput { x: number; y: number; jump: boolean; rider: boolean; lookPitch?: number }
/** The ground under the ship: the top of the first solid or liquid block below (null: none within reach). */
export interface FlightTerrain { ground: number | null }
export type FlightEvent = 'takeoff' | 'landing';

/**
 * Advance one ship by `dt` seconds. Pure (the device runs this very text,
 * serialised into `scriptedVehicleRuntime`), so every behaviour above is
 * unit-tested off the device. Collisions are not here: the runtime sweeps
 * the footprint over the new pose and resolves it (`resolveMove`).
 */
export function flightStep(s: FlightState, input: FlightInput, terrain: FlightTerrain, P: FlightParams, dt: number): { state: FlightState; event?: FlightEvent } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const toward = (v: number, target: number, rate: number): number => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
  const dz = (v: number): number => (Math.abs(v) < P.DEADZONE ? 0 : Math.max(-1, Math.min(1, v / P.STICK_FULL)));
  const rider = input.rider;
  const right = dz(rider ? input.x : 0) * P.STICK_X_RIGHT;
  const stick = dz(rider ? input.y : 0);
  const jump = rider && input.jump;
  let event: FlightEvent | undefined;
  // Jump's direction is decided as it is PRESSED by the view (look down = down) and
  // held until it is let go; the stick pulled back while it is held also goes down.
  const pressed = jump && !s.jumpHeld;
  const lookDown = (input.lookPitch ?? 0) > P.DIVE_PITCH_DEG;
  const diving = jump && (pressed ? lookDown : s.diving);
  const backDown = jump && stick <= P.DESCEND_STICK;
  const down = diving || backDown;
  // Thrust along the heading: forward, or straight backwards; hands off it stops and hovers.
  // While the stick is pulled back to go DOWN it gives no reverse thrust.
  const thrust = backDown ? 0 : stick;
  const target = thrust > 0 ? thrust * P.MAX_SPEED : thrust * P.REVERSE_SPEED;
  const braking = thrust === 0 || (Math.abs(s.speed) > 0.1 && Math.sign(thrust) !== Math.sign(s.speed));
  const before = s.speed;
  const speed = toward(s.speed, target, (braking ? P.BRAKE : P.ACCEL) * dt);
  // Turn at any speed, at rest too: a ship pivots on the spot.
  const turnRate = right * P.TURN_RATE;
  let yaw = s.yaw + turnRate * dt;
  yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
  // Vertical: Jump up or down; hands off it holds its height; nobody aboard, it sinks gently and parks.
  const vTarget = jump ? (down ? -P.DESCEND_SPEED : P.CLIMB_SPEED) : rider ? 0 : -P.IDLE_SINK;
  let vy = toward(s.vy, vTarget, P.VERTICAL_ACCEL * dt);
  let onGround = s.onGround;
  if (onGround && vy > 0) { onGround = false; event = 'takeoff'; }
  const rad = yaw * Math.PI / 180;
  const x = s.x - Math.sin(rad) * speed * dt, z = s.z + Math.cos(rad) * speed * dt;
  let y = s.y + vy * dt;
  const g = terrain.ground;
  if (g !== null && y <= g) {
    // Down onto the ground or the water, or a rise under it while it rests there: it stands on it.
    if (!onGround && s.y > g + 0.01) event = 'landing';
    y = g; vy = 0; onGround = true;
  } else if (onGround && g !== null && g < s.y - 0.05) {
    // Off an edge while resting: it hovers there (a rider) or sinks on (nobody aboard).
    onGround = false;
  } else if (onGround && g === null) onGround = false;
  const accel = (speed - before) / dt;
  const pitch = toward(s.pitch, clamp(vy * P.PITCH_PER_CLIMB - accel * P.PITCH_PER_ACCEL, -P.PITCH_MAX, P.PITCH_MAX), P.ATTITUDE_RATE * dt);
  const bank = toward(s.bank, onGround ? 0 : clamp(turnRate * P.BANK_PER_TURN, -P.BANK_MAX, P.BANK_MAX), P.ATTITUDE_RATE * dt);
  return { state: { x, y, z, yaw, pitch, speed, vy, onGround, bank, jumpHeld: jump, diving }, ...(event ? { event } : {}) };
}

// ─── Boats ─────────────────────────────────────────────────────────────────────

/**
 * A boat on the water, run by the same script as the aircraft. Measured on
 * the Pixel (GameTest, 2026-09-25, 10365): the camel controller the boats used
 * (`input_ground_controlled` + `minecraft:buoyant`) floats but crawls at
 * 1.6-1.8 blocks/s on water whatever its movement value, and 1.26.30 rejects
 * the buoyant component's `simulate_fluid_physics`. So a boat is scripted:
 *
 *   - the stick's forward/back is the THROTTLE (forward up to `MAX_SPEED`,
 *     back slows it and then reverses at up to `REVERSE_SPEED`; hands off it
 *     coasts down on the water's drag);
 *   - left/right is the RUDDER, which bites with speed (a boat turns by moving
 *     water past its rudder) but keeps `RUDDER_AT_REST` of its bite at a
 *     standstill so a docked boat can still be pointed out;
 *   - Jump is a BOOST (`BOOST_SPEED` while held, cooling down after
 *     `BOOST_SECONDS`);
 *   - it rides the water's surface `DRAFT` deep, stops at a shore it runs
 *     into (beached: only reverse gets it off), and falls onto whatever is
 *     below when there is no water under it.
 */
export const BOAT = {
  MAX_SPEED: 8, BOOST_SPEED: 12, REVERSE_SPEED: 2.5, ACCEL: 3, BRAKE: 5, WATER_DRAG: 1.2, LAND_FRICTION: 12,
  TURN_RATE: 50, RUDDER_AT_REST: 0.35, RUDDER_SPEED: 4,
  BOOST_SECONDS: 3, BOOST_COOLDOWN: 4,
  DRAFT: 0.3, GRAVITY: 20,
  LEAN_PER_TURN: 0.12, LEAN_MAX: 7, SQUAT_PER_ACCEL: 1.2, SQUAT_MAX: 6,
  STICK_X_RIGHT: -1, DEADZONE: 0.15, STICK_FULL: 0.8,
} as const;
/** Every boat constant as a number (a per-type draft overrides `DRAFT`). */
export type BoatParams = { readonly [K in keyof typeof BOAT]: number };

/** One boat's state: position, heading, speed along the heading (negative = astern), the boost timers, and the attitude its animation shows. */
export interface BoatState { x: number; y: number; z: number; yaw: number; speed: number; vy: number; afloat: boolean; boost: number; cooldown: number; pitch: number; bank: number }
/** The water under and ahead of a boat: the water's surface under it (null: none), the top of the ground under it, and whether land stands at the waterline ahead or astern. */
export interface BoatWater { surface: number | null; ground: number | null; shoreAhead: boolean; shoreAstern: boolean }
export type BoatEvent = 'beached' | 'boost' | 'launched';

/** Advance one boat by `dt` seconds (pure; the device runs this text). */
export function boatStep(s: BoatState, input: FlightInput, water: BoatWater, P: BoatParams, dt: number): { state: BoatState; event?: BoatEvent } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const toward = (v: number, target: number, rate: number): number => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
  const dz = (v: number): number => (Math.abs(v) < P.DEADZONE ? 0 : Math.max(-1, Math.min(1, v / P.STICK_FULL)));
  const right = dz(input.rider ? input.x : 0) * P.STICK_X_RIGHT;
  const throttle = dz(input.rider ? input.y : 0);
  let event: BoatEvent | undefined;
  const afloat = water.surface !== null;
  let { speed, boost, cooldown, vy } = s;
  cooldown = Math.max(0, cooldown - dt);
  boost = Math.max(0, boost - dt);
  if (input.rider && input.jump && afloat && boost <= 0 && cooldown <= 0) { boost = P.BOOST_SECONDS; cooldown = P.BOOST_SECONDS + P.BOOST_COOLDOWN; event = 'boost'; }
  const top = boost > 0 ? P.BOOST_SPEED : P.MAX_SPEED;
  const before = speed;
  if (afloat) {
    const target = throttle > 0 ? throttle * top : throttle < 0 ? throttle * P.REVERSE_SPEED : 0;
    // Throttle toward the target; against the motion it brakes; hands off the water's drag slows it.
    const rate = throttle === 0 ? P.WATER_DRAG : Math.sign(target - speed) !== Math.sign(speed) && speed !== 0 ? P.BRAKE : P.ACCEL * (boost > 0 ? 2 : 1);
    speed = toward(speed, target, rate * dt);
  } else {
    // Aground: it slides to a halt; reverse only works with water astern.
    speed = toward(speed, throttle < 0 && !water.shoreAstern ? throttle * 1 : 0, P.LAND_FRICTION * dt);
  }
  if (water.shoreAhead && speed > 0) { speed = 0; event = 'beached'; }
  if (water.shoreAstern && speed < 0) speed = 0;
  const bite = clamp(Math.abs(speed) / P.RUDDER_SPEED, P.RUDDER_AT_REST, 1) * (afloat ? 1 : 0);
  // Astern the rudder turns the stern: the bow swings the other way.
  const turnRate = right * P.TURN_RATE * bite * (speed < -0.1 ? -1 : 1);
  let yaw = s.yaw + turnRate * dt;
  yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
  const rad = yaw * Math.PI / 180;
  let x = s.x - Math.sin(rad) * speed * dt, z = s.z + Math.cos(rad) * speed * dt, y = s.y;
  if (afloat) { y = water.surface! - P.DRAFT; vy = 0; }
  else if (water.ground !== null && s.y + vy * dt <= water.ground) { y = water.ground; vy = 0; }
  else { vy -= P.GRAVITY * dt; y = s.y + vy * dt; }
  if (afloat && !s.afloat && s.vy < -1) event = 'launched';
  const accel = (speed - before) / dt;
  const bank = toward(s.bank, clamp(turnRate * Math.abs(speed) / P.MAX_SPEED * P.LEAN_PER_TURN * 10, -P.LEAN_MAX, P.LEAN_MAX), 20 * dt);
  const pitch = toward(s.pitch, clamp(accel * P.SQUAT_PER_ACCEL, -P.SQUAT_MAX, P.SQUAT_MAX), 10 * dt);
  return { state: { x, y, z, yaw, speed, vy, afloat, boost, cooldown, pitch, bank }, ...(event ? { event } : {}) };
}

// ─── Cars ──────────────────────────────────────────────────────────────────────

/**
 * A car on the ground, run by the same script as the boats and aircraft.
 * Measured on the Pixel (real rider, 2026-09-25): the camel controller the
 * cars used (`input_ground_controlled`) cannot be steered by a touch stick.
 * Under `player_relative` - the scheme that made the stick turn the rider -
 * the rider's yaw turned by itself about 36 degrees every 4 ticks with the
 * stick held straight, and the car drove full circles in every camera mode;
 * under the default and `player_relative_strafe` schemes it drove straight
 * but the stick's left/right slid it SIDEWAYS without turning it; and it
 * stopped dead the moment the stick was released. So a car is scripted:
 *
 *   - the stick's forward/back is throttle and brake, then reverse from a
 *     stop; hands off it coasts down (`COAST`); with nobody aboard it brakes (`BRAKE`);
 *   - left/right steers, with full lock by `STEER_FULL_SPEED` and less of it
 *     at speed (`STEER_FADE`), reversed when backing up; at a standstill it
 *     PIVOTS slowly on the spot (`PIVOT_RATE`), so a car nosed into a corner
 *     or wedged between two walls can always be turned out of it;
 *   - Jump is a short boost (`BOOST_SPEED` for `BOOST_SECONDS`, then
 *     `BOOST_COOLDOWN`);
 *   - it follows the ground: up a step of at most `STEP_UP` (eased at
 *     `CLIMB_RATE`), off an edge it falls, and in water it crawls at
 *     `WATER_SPEED`; the body pitches with the slope under its wheels.
 *
 * Walls are the runtime's (`resolveMove`, since 2026-09-30): a car pushed
 * into a wall of up to `RISE_MAX` + `STEP_UP` scrambles up it at `CLIMB_RATE`
 * and holds that height for up to `CLIMB_HOLD_TICKS` while it drives on
 * (out of a two-block pit, onto a kerb of blocks), steps sideways round a
 * trunk it meets with a corner, and slides along a wall it meets at an
 * angle. A higher wall stops it; reverse or the pivot turns it away.
 */
export const CAR = {
  MAX_SPEED: 19, REVERSE_SPEED: 5, ACCEL: 7, BRAKE: 14, COAST: 2.5,
  BOOST_SPEED: 26, BOOST_SECONDS: 1.5, BOOST_COOLDOWN: 3,
  STEER_RATE: 110, STEER_FULL_SPEED: 5, STEER_FADE: 12, PIVOT_RATE: 45,
  STEP_UP: 1.05, CLIMB_RATE: 6, GRAVITY: 20, WATER_SPEED: 2,
  RISE_MAX: 1.1, CLIMB_HOLD_TICKS: 40,
  LEAN_PER_TURN: 0.04, LEAN_MAX: 4, SQUAT_PER_ACCEL: 0.35, SQUAT_MAX: 3,
  STICK_X_RIGHT: -1, DEADZONE: 0.15, STICK_FULL: 0.8,
} as const;
/** Every car constant as a number. */
export type CarParams = { readonly [K in keyof typeof CAR]: number };

/** One car's state: position, heading, speed along the heading (negative = reversing), vertical speed, the boost timers, and the attitude its animation shows. */
export interface CarState { x: number; y: number; z: number; yaw: number; speed: number; vy: number; onGround: boolean; boost: number; cooldown: number; pitch: number; bank: number }
/** The ground the car stands on: the top of the solid ground under its centre, nose and tail (null: none within reach), whether its wheels are in water, and its wheelbase (blocks). */
export interface CarTerrain { ground: number | null; groundFront: number | null; groundRear: number | null; inWater: boolean; wheelbase: number }
export type CarEvent = 'boost' | 'landed';

/** Advance one car by `dt` seconds (pure; the device runs this text). */
export function carStep(s: CarState, input: FlightInput, terrain: CarTerrain, P: CarParams, dt: number): { state: CarState; event?: CarEvent } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const toward = (v: number, target: number, rate: number): number => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
  const dz = (v: number): number => (Math.abs(v) < P.DEADZONE ? 0 : Math.max(-1, Math.min(1, v / P.STICK_FULL)));
  const right = dz(input.rider ? input.x : 0) * P.STICK_X_RIGHT;
  const throttle = dz(input.rider ? input.y : 0);
  let event: CarEvent | undefined;
  let { speed, boost, cooldown, vy, onGround, y } = s;
  cooldown = Math.max(0, cooldown - dt);
  boost = Math.max(0, boost - dt);
  if (input.rider && input.jump && onGround && boost <= 0 && cooldown <= 0) { boost = P.BOOST_SECONDS; cooldown = P.BOOST_SECONDS + P.BOOST_COOLDOWN; event = 'boost'; }
  const before = speed;
  let turnRate = 0;
  if (onGround) {
    const top = terrain.inWater ? P.WATER_SPEED : boost > 0 ? P.BOOST_SPEED : P.MAX_SPEED;
    const target = throttle > 0 ? throttle * top : throttle < 0 ? Math.max(throttle * P.REVERSE_SPEED, -top) : 0;
    // Against the motion the stick brakes first; hands off it coasts down.
    const braking = throttle !== 0 && Math.abs(speed) > 0.1 && Math.sign(throttle) !== Math.sign(speed);
    // Nobody aboard (the rider got out at speed): the brakes, not a coast. An empty time machine
    // coasted 200 blocks from 91 mph on the Pixel (2026-09-25) and left the loaded terrain.
    const rate = throttle === 0 ? (input.rider ? P.COAST : P.BRAKE) : braking ? P.BRAKE : P.ACCEL * (boost > 0 ? 2 : 1);
    speed = toward(speed, target, rate * dt);
    // Steering bites with speed (full lock by STEER_FULL_SPEED), fades at speed, and reverses backing up;
    // near a standstill the pivot takes over, so a stopped car still turns (out of a corner or a wedge).
    const slow = clamp(Math.abs(speed) / P.STEER_FULL_SPEED, 0, 1);
    const bite = slow / (1 + Math.abs(speed) / P.STEER_FADE);
    turnRate = right * Math.max(P.STEER_RATE * bite, P.PIVOT_RATE * (1 - slow)) * (speed < -0.1 ? -1 : 1);
  }
  let yaw = s.yaw + turnRate * dt;
  yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
  const rad = yaw * Math.PI / 180;
  let x = s.x - Math.sin(rad) * speed * dt, z = s.z + Math.cos(rad) * speed * dt;
  const g = terrain.ground;
  if (onGround && g !== null && g >= y - 0.05) {
    // On the ground, or a step under the centre: ease up onto it.
    y = g > y ? Math.min(g, y + P.CLIMB_RATE * dt) : g;
    vy = 0;
  } else {
    // Off an edge (or spawned above the ground): fall until it lands.
    vy -= P.GRAVITY * dt;
    y = y + vy * dt;
    if (g !== null && y <= g) { y = g; vy = 0; if (!onGround) event = 'landed'; onGround = true; } else onGround = false;
    if (g === null) onGround = false;
  }
  const accel = (speed - before) / dt;
  // Pitch: the slope under the wheels (nose up positive), plus a squat on the throttle.
  const slope = terrain.groundFront !== null && terrain.groundRear !== null && terrain.wheelbase > 0
    ? Math.atan2(terrain.groundFront - terrain.groundRear, terrain.wheelbase) * 180 / Math.PI : 0;
  const pitch = toward(s.pitch, clamp(slope + clamp(accel * P.SQUAT_PER_ACCEL, -P.SQUAT_MAX, P.SQUAT_MAX), -30, 30), 60 * dt);
  // Body roll leans OUT of a turn: a right turn lowers the left side (negative bank).
  const bank = toward(s.bank, clamp(-turnRate * P.LEAN_PER_TURN * Math.min(1, Math.abs(speed) / P.STEER_FULL_SPEED), -P.LEAN_MAX, P.LEAN_MAX), 20 * dt);
  return { state: { x, y, z, yaw, speed, vy, onGround, boost, cooldown, pitch, bank }, ...(event ? { event } : {}) };
}

// ─── Hover craft ───────────────────────────────────────────────────────────────

/**
 * A hover craft (a sail barge, a landspeeder, a hovercraft) is a car that
 * floats: the same `carStep`, fed the top of whatever is under it - ground OR
 * water - plus `RIDE_HEIGHT`, so it crosses a lake and a beach alike. It
 * glides (a low `COAST`), steers gently, floats over anything up to
 * `STEP_UP` (a block and a half), and sinks slowly off an edge (`GRAVITY`).
 * No wheels roll. Chosen to read as the sail barge of the film: a slow, heavy
 * glide, not a sports car.
 */
export const HOVER = {
  MAX_SPEED: 12, REVERSE_SPEED: 4, ACCEL: 4, BRAKE: 8, COAST: 1.2,
  BOOST_SPEED: 18, BOOST_SECONDS: 2, BOOST_COOLDOWN: 4,
  STEER_RATE: 70, STEER_FULL_SPEED: 2, STEER_FADE: 20, PIVOT_RATE: 40,
  STEP_UP: 1.6, CLIMB_RATE: 3, GRAVITY: 6, WATER_SPEED: 12,
  RISE_MAX: 1, CLIMB_HOLD_TICKS: 40,
  LEAN_PER_TURN: 0.08, LEAN_MAX: 6, SQUAT_PER_ACCEL: 0.8, SQUAT_MAX: 4,
  STICK_X_RIGHT: -1, DEADZONE: 0.15, STICK_FULL: 0.8,
  /** Height the hull floats above the ground or the water, blocks. */
  RIDE_HEIGHT: 1,
} as const;
/** Every hover constant as a number: the car's plus `RIDE_HEIGHT`. */
export type HoverParams = CarParams & { readonly RIDE_HEIGHT: number };

// ─── Swept footprint (collision) ───────────────────────────────────────────────

/**
 * The swept-footprint collision test every scripted vehicle runs after its
 * step. Before 2026-09-25 the runtime probed only the centre line (the ground
 * under the vehicle and one block ahead of its nose), so a wingtip, a wide
 * hull or a car's corner passed straight through a tree trunk or a pier.
 *
 *   - `SPACING`: the most two probe points on the perimeter or vertically
 *     through the clear band are apart, blocks. Under one block, so a trunk
 *     or a one-block tree crown cannot slip between two probes.
 *   - `MAX_POINTS`: perimeter probes at most; a bigger vehicle spreads them
 *     (a 36-block barge's 100-block perimeter still gets 0.9 spacing).
 *   - `SWEEP_STEP`: the most a probe point travels between two tested poses,
 *     blocks, so a 32 blocks/s aircraft (1.6 blocks a tick) cannot jump a trunk.
 *   - `MAX_SUBSTEPS`: poses tested per tick at most.
 */
export const FOOTPRINT = { SPACING: 0.9, MAX_POINTS: 128, SWEEP_STEP: 0.8, MAX_SUBSTEPS: 4 } as const;
export type FootprintParams = { readonly [K in keyof typeof FOOTPRINT]: number };

/** Where a vehicle is for the footprint test: its reference point (the model's base centre), heading and nose-up pitch, degrees (Bedrock yaw). */
export interface FootprintPose { x: number; y: number; z: number; yaw: number; pitch: number }
/**
 * A vehicle's footprint: half its length (along the nose) and half its width,
 * blocks, and the band of heights above the reference point that must stay
 * clear (`lo` above what it may climb or float over, `hi` its roof).
 */
export interface VehicleFootprint { halfLength: number; halfWidth: number; lo: number; hi: number }

/**
 * Sweep a vehicle's footprint from one pose to the next and report the first
 * probe that ENTERS a solid block: a point is blocked only when it is solid
 * at the new pose and was not at the old one, so a vehicle spawned half in a
 * wall can still drive out of it. Pure (the device runs this text; `solid`
 * is its block lookup), so it is unit-tested off the device.
 */
export function sweepFootprint(from: FootprintPose, to: FootprintPose, fp: VehicleFootprint, solid: (x: number, y: number, z: number) => boolean, P: FootprintParams): { blocked: boolean; checks: number; at?: [number, number, number] } {
  const L = Math.max(0.05, fp.halfLength), W = Math.max(0.05, fp.halfWidth);
  const rad = (d: number): number => d * Math.PI / 180;
  const pointAt = (pose: FootprintPose, a: number, s: number, h: number): [number, number, number] => {
    const r = rad(pose.yaw), fx = -Math.sin(r), fz = Math.cos(r);
    // The vehicle's right (a right turn raises yaw): (-cos, -sin) in Bedrock's frame.
    const rx = -Math.cos(r), rz = -Math.sin(r);
    // Pitched, the band tilts about its LOW end: nose up raises the nose and
    // leaves the tail at the base (an aircraft rotates on its main gear; tilted
    // about its centre the Milano's tail dipped into the runway at 12 degrees and
    // every take-off roll "crashed", Pixel GameTest 2026-09-25); nose down the
    // other way round.
    const lift = Math.max(0, a * Math.tan(rad(Math.max(-60, Math.min(60, pose.pitch)))));
    return [pose.x + fx * a + rx * s, pose.y + lift + h, pose.z + fz * a + rz * s];
  };
  let dyaw = to.yaw - from.yaw;
  while (dyaw > 180) dyaw -= 360;
  while (dyaw < -180) dyaw += 360;
  const span = Math.max(0, fp.hi - fp.lo);
  const levels: number[] = [];
  // Four samples over a tall ship left multi-block gaps (the Milano crossed
  // a tree crown for 28 ticks). Keep height spacing independent of hull size.
  const nLevels = Math.max(1, Math.ceil(span / P.SPACING) + 1);
  for (let k = 0; k < nLevels; k++) levels.push(fp.lo + (nLevels === 1 ? 0 : span * k / (nLevels - 1)));
  // Perimeter probes as (along, side) offsets, each edge at <= SPACING, with the
  // edge's outward normal, and the heights each is probed at. Only the boundary
  // that enters NEW space is probed - a point moving inward (or along its edge)
  // sweeps space the vehicle itself covered, which was clear:
  //   - a point moving OUTWARD horizontally (the bow straight ahead, the half of
  //     the perimeter that swings outward in a turn): its whole face, every level;
  //   - any other point whose height changes (falling, rising, pitching): only
  //     the face that leads vertically - the band's FLOOR level going down, its
  //     ROOF level going up. The rest of its column was the vehicle's own. Skipping
  //     these points let a car descending a hill drop its rear band into the
  //     ledge behind it (42172 course); probing them at every level multiplied a
  //     cruising Milano's probes nine-fold (2,376 a tick, 8,040 at 2x, where the
  //     Pixel measured 890 probes at 20-24 ms of a 50 ms tick, world 924,
  //     2026-09-25). `scripts/_sweep_checks.ts` prints the counts per move.
  const perimeter = 4 * (L + W);
  const spacing = Math.max(P.SPACING, perimeter / P.MAX_POINTS);
  const allLevels = levels, floorLevel = [levels[0]!], roofLevel = [levels[levels.length - 1]!];
  const offsets: Array<[number, number, number[]]> = [];
  /** The levels the boundary point (a, s) with outward normal (na, ns) must be probed at, or undefined for none. */
  const leading = (a: number, s: number, na: number, ns: number): number[] | undefined => {
    const p0 = pointAt(from, a, s, 0), p1 = pointAt(to, a, s, 0);
    const r = rad(from.yaw), fx = -Math.sin(r), fz = Math.cos(r), rx = -Math.cos(r), rz = -Math.sin(r);
    const nx = fx * na + rx * ns, nz = fz * na + rz * ns;
    if ((p1[0] - p0[0]) * nx + (p1[2] - p0[2]) * nz > 1e-6) return allLevels;
    const dy = p1[1] - p0[1];
    return dy < -1e-6 ? floorLevel : dy > 1e-6 ? roofLevel : undefined;
  };
  const edge = (a0: number, s0: number, a1: number, s1: number, na: number, ns: number): void => {
    const n = Math.max(1, Math.ceil(Math.hypot(a1 - a0, s1 - s0) / spacing));
    for (let k = 0; k <= n; k++) {
      const a = a0 + (a1 - a0) * k / n, s = s0 + (s1 - s0) * k / n;
      const at = leading(a, s, na, ns);
      if (at) offsets.push([a, s, at]);
    }
  };
  edge(L, -W, L, W, 1, 0); edge(L, W, -L, W, 0, 1); edge(-L, W, -L, -W, -1, 0); edge(-L, -W, L, -W, 0, -1);
  const travel = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) + Math.abs(rad(dyaw)) * Math.hypot(L, W);
  const steps = Math.min(P.MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / P.SWEEP_STEP)));
  // `checks` is the number of target boundary samples tested. It intentionally
  // does not count the old-pose confirmation or the lazy occupancy-cache
  // lookups, so telemetry remains comparable across overlap outcomes.
  let checks = 0;
  let occupiedAtFrom: Set<string> | undefined;
  const cellKey = (p: readonly number[]): string => `${Math.floor(p[0]!)}:${Math.floor(p[1]!)}:${Math.floor(p[2]!)}`;
  const originalOccupiedCells = (): Set<string> => {
    if (occupiedAtFrom) return occupiedAtFrom;
    occupiedAtFrom = new Set<string>();
    // Every probed point's whole column at the old pose: "already occupied" means by any of the old boundary.
    for (const [a, s] of offsets) for (const h of levels) {
      const p = pointAt(from, a, s, h);
      if (solid(p[0], p[1], p[2])) occupiedAtFrom.add(cellKey(p));
    }
    return occupiedAtFrom;
  };
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const pose: FootprintPose = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t, yaw: from.yaw + dyaw * t, pitch: from.pitch + (to.pitch - from.pitch) * t };
    for (const [a, s, at] of offsets) for (const h of at) {
      const p = pointAt(pose, a, s, h);
      checks++;
      if (!solid(p[0], p[1], p[2])) continue;
      const q = pointAt(from, a, s, h);
      if (solid(q[0], q[1], q[2])) continue;
      // A source-placed vehicle may start partly inside the model it was
      // extracted from. While it rises and moves out, a trailing point may
      // enter a voxel another part of the original boundary already occupied.
      // Permit no new occupied voxel: a new crown or ceiling still blocks.
      if (p[1] > q[1] + 1e-6 && originalOccupiedCells().has(cellKey(p))) continue;
      return { blocked: true, checks, at: p };
    }
  }
  return { blocked: false, checks };
}

// ─── Collision response: never stuck ───────────────────────────────────────────

/**
 * What the runtime does when the swept footprint blocks a move (2026-09-30:
 * "it's too easy to get fully stuck in place by hills / blocks"). Until then a
 * blocked move stopped the vehicle dead where it stood, whatever the angle -
 * a car brushing a wall at 10 degrees, a wingtip clipping a trunk, a ship
 * nosing into a grassy slope all froze. Now the move is tried again in these
 * shapes, the first clear one taken:
 *
 *   - `climb`: the move raised by the runtime's climb allowance (a ship lifts
 *     itself over a hill or a wall it is pushed into; a car scrambles onto a
 *     kerb), forward progress kept;
 *   - `deflect`: when only ONE half of the footprint (left or right of the
 *     centre line, each swept on its own) meets the block - a trunk or a post
 *     met with a corner or a wingtip - the move stepped sideways away from it
 *     by `DEFLECT_SHARE` of its length (at least `MIN_SIDESTEP`), forward
 *     progress kept, or that sidestep alone where the forward part is still
 *     blocked. A SHIP (`climbFirst`) deflects only when the block is NARROW -
 *     the solid cells joined to the hit cell in its own horizontal plane
 *     (8-connected) number at most `NARROW_CELLS`: a trunk, a post, a pole, a
 *     tree's crown, never a wall or a hill of any shape - and lifts over
 *     everything else. Until 2026-10-07 the halves alone decided, and a wall
 *     met 19 degrees off square meets one half first: the X-wing flown into a
 *     2-high hill or a 10-high wall "deflected" sideways along it, 0.63 blocks
 *     a tick, for 13-50 blocks and never lifted (Saga 30j, CMVT 15:19:25-31,
 *     15:21:04-09, 15:22:15-17); the simulator's course met every wall
 *     square-on, where both halves block, and passed. A ground vehicle has
 *     no lift, and a sidestep along a wall met at an angle is its way along
 *     (the McLaren's slide-along, Saga 30j): it keeps the halves' rule;
 *   - `slide`: one world axis of the move only (Minecraft's walls run along
 *     the axes), else the move turned up to `GLANCE_MAX_DEG` toward a slanted
 *     wall's line and shortened by the cosine; the speed scaled by the share
 *     of the move it keeps - along a wall met at an angle;
 *   - `rise`: straight up by the climb allowance where it stands (the face of
 *     a wall too high to climb in one move) - only while the move PUSHES
 *     (`MIN_PROGRESS` of horizontal travel): a turn on the spot never rises.
 *     Until 2026-10-07 it did, so the X-wing turned with its tail against a
 *     post climbed 4-6 blocks to the post's top (Saga 30j, CMVT 15:17:11,
 *     15:22:49);
 *   - `pivot`: a turn on the spot whose swing meets a block turns instead
 *     about the END that met it (the hit's side of the centre: the tail
 *     against a post stays put and the nose swings; a nose against a wall,
 *     the tail), so a ship parked against something can still be turned;
 *   - `blocked`: none is clear. The vertical move and the turn are kept when
 *     they are clear on their own, so a vehicle against a wall still turns
 *     away and still comes down.
 *
 * `climbFirst` orders a ship's tries climb, deflect, rise, slide (over a
 * hill or a slanted wall rather than along it, round a trunk); a ground
 * vehicle deflects and slides first, then climbs and rises; the pivot comes
 * last in either (nothing else applies to a pure turn). A candidate that
 * moves less than `MIN_PROGRESS` is skipped. Pure, serialised; `sweep` is
 * `sweepFootprint`, passed in (a serialised function references nothing
 * outside itself).
 */
export const MOVE = { DEFLECT_SHARE: 0.7, MIN_SIDESTEP: 0.1, MIN_PROGRESS: 0.002, GLANCE_STEP_DEG: 20, GLANCE_MAX_DEG: 60, GLANCE_PROBE: 1.5, NARROW_CELLS: 12 } as const;
export type MoveParams = { readonly [K in keyof typeof MOVE]: number };
export type MoveResolution = 'clear' | 'climb' | 'deflect' | 'slide' | 'rise' | 'pivot' | 'blocked';

export function resolveMove(
  from: FootprintPose, to: FootprintPose, fp: VehicleFootprint, solid: (x: number, y: number, z: number) => boolean,
  P: FootprintParams, M: MoveParams, opts: { climb: number; climbFirst: boolean }, sweep: typeof sweepFootprint,
): { pose: FootprintPose; how: MoveResolution; kept: number; checks: number; at?: [number, number, number] } {
  let checks = 0;
  const clear = (p: FootprintPose): { ok: boolean; at?: [number, number, number] } => {
    const r = sweep(from, p, fp, solid, P);
    checks += r.checks;
    return r.blocked ? { ok: false, ...(r.at ? { at: r.at } : {}) } : { ok: true };
  };
  const first = clear(to);
  if (first.ok) return { pose: to, how: 'clear', kept: 1, checks };
  const at = first.at;
  const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
  let dyaw = to.yaw - from.yaw;
  while (dyaw > 180) dyaw -= 360;
  while (dyaw < -180) dyaw += 360;
  const progress = (p: FootprintPose): number => (len > 1e-9 ? ((p.x - from.x) * dx + (p.z - from.z) * dz) / (len * len) : 0);
  const tryClimb = (): FootprintPose | undefined => {
    if (!(opts.climb > 0) || len < M.MIN_PROGRESS) return undefined;
    const p = { ...to, y: to.y + opts.climb };
    return clear(p).ok ? p : undefined;
  };
  /** A pose moved `s` blocks along its own right (Bedrock: (-cos yaw, -sin yaw)). */
  const aside = (p: FootprintPose, s: number): FootprintPose => {
    const r = p.yaw * Math.PI / 180;
    return { ...p, x: p.x - Math.cos(r) * s, z: p.z - Math.sin(r) * s };
  };
  /**
   * Whether the block met is NARROW: the solid cells joined to the hit cell in its own horizontal
   * plane (8-connected, so a diagonal of blocks is one wall) number at most `NARROW_CELLS`. A trunk
   * (1), a 2x2 pillar, a 3x3 crown are; a wall or a hill of any shape or angle is not. Cell reads
   * only, no sweep: the runtime caches a tick's block lookups.
   */
  const narrow = (): boolean => {
    if (!at) return false;
    const y = at[1];
    const seen = new Set<string>([`${Math.floor(at[0])},${Math.floor(at[2])}`]);
    const queue: Array<[number, number]> = [[Math.floor(at[0]), Math.floor(at[2])]];
    while (queue.length) {
      const [cx, cz] = queue.pop()!;
      for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
        if (!ddx && !ddz) continue;
        const nx = cx + ddx, nz = cz + ddz, key = `${nx},${nz}`;
        if (seen.has(key) || !solid(nx + 0.5, y, nz + 0.5)) continue;
        seen.add(key);
        if (seen.size > M.NARROW_CELLS) return false;
        queue.push([nx, nz]);
      }
    }
    return true;
  };
  const tryDeflect = (): FootprintPose | undefined => {
    // A ship steps round a NARROW block only (it lifts over everything else); a ground vehicle has no lift,
    // and a sidestep along a wall met at an angle is its way along (the McLaren's slide-along, Saga 30j).
    if (len < M.MIN_PROGRESS || (opts.climbFirst && !narrow())) return undefined;
    // Which half meets the block: each half of the footprint swept on its own (centred a quarter width out).
    const halfFp = { ...fp, halfWidth: fp.halfWidth / 2 }, q = fp.halfWidth / 2;
    const blockedHalf = (s: number): boolean => { const r = sweep(aside(from, s), aside(to, s), halfFp, solid, P); checks += r.checks; return r.blocked; };
    const right = blockedHalf(q), left = blockedHalf(-q);
    // Both halves: a wall across the way (a slide's or a climb's); neither: nothing to step round.
    if (right === left) return undefined;
    const shift = (right ? -1 : 1) * M.DEFLECT_SHARE * Math.max(len, M.MIN_SIDESTEP);
    for (const p of [aside(to, shift), aside({ ...to, x: from.x, z: from.z }, shift)]) if (clear(p).ok) return p;
    return undefined;
  };
  const trySlide = (): FootprintPose | undefined => {
    const axes: Array<[number, FootprintPose]> = [
      [Math.abs(dx), { ...to, z: from.z }],
      [Math.abs(dz), { ...to, x: from.x }],
    ];
    axes.sort((a, b) => b[0] - a[0]);
    for (const [moved, p] of axes) if (moved >= M.MIN_PROGRESS && clear(p).ok) return p;
    // A wall across the way at a SLANT (a diagonal of blocks): one EDGE of the footprint has more room ahead
    // than the other (its outer quarter swept on its own up to `GLANCE_PROBE` blocks along the move: whole
    // halves both reach the diagonal's middle cells and read the same); the move is
    // turned toward the roomier side, `GLANCE_STEP_DEG` at a time up to `GLANCE_MAX_DEG`, shortened by the
    // cosine - the share of the push a real scrape along it keeps. A wall square across the way leaves both
    // halves the same room: no glance, so a car nosed into a wall does not crawl sideways along it.
    if (len < M.MIN_PROGRESS) return undefined;
    const ux = dx / len, uz = dz / len;
    const edgeFp = { ...fp, halfWidth: fp.halfWidth / 4 }, q = fp.halfWidth * 0.75;
    const room = (s: number): number => {
      let best = 0;
      for (let f = M.GLANCE_PROBE / 4; f <= M.GLANCE_PROBE + 1e-9; f += M.GLANCE_PROBE / 4) {
        const r = sweep(aside(from, s), aside({ ...from, x: from.x + ux * f, z: from.z + uz * f }, s), edgeFp, solid, P);
        checks += r.checks;
        if (r.blocked) break;
        best = f;
      }
      return best;
    };
    const right = room(q), left = room(-q);
    if (Math.abs(right - left) < M.GLANCE_PROBE / 4 - 1e-9) return undefined;
    // The vehicle's right in the world (Bedrock: (-cos yaw, -sin yaw)); turn the move toward the roomier half.
    const ry = from.yaw * Math.PI / 180, rx = -Math.cos(ry), rz = -Math.sin(ry), toward = right > left ? 1 : -1;
    for (let deg = M.GLANCE_STEP_DEG; deg <= M.GLANCE_MAX_DEG + 1e-9; deg += M.GLANCE_STEP_DEG) {
      const t = deg * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
      const turned = [1, -1].map(sgn => ({ x: (dx * c - dz * sn * sgn) * c, z: (dx * sn * sgn + dz * c) * c }))
        .filter(d => (d.x * rx + d.z * rz) * toward > 0);
      for (const d of turned) {
        const p = { ...to, x: from.x + d.x, z: from.z + d.z };
        if (clear(p).ok) return p;
      }
    }
    // Pinned by a stair corner of the diagonal (every turned move meets it): edge sideways toward the room.
    const step = toward * Math.max(M.DEFLECT_SHARE * len, M.MIN_SIDESTEP);
    const side = { ...to, x: from.x + rx * step, z: from.z + rz * step };
    return clear(side).ok ? side : undefined;
  };
  const tryRise = (): FootprintPose | undefined => {
    // Only a PUSH rises (the face of a wall ahead): a turn on the spot against a post is not a reason to go up.
    if (!(opts.climb > 0) || len < M.MIN_PROGRESS) return undefined;
    const p = { x: from.x, y: from.y + opts.climb, z: from.z, yaw: from.yaw, pitch: to.pitch };
    return clear(p).ok ? p : undefined;
  };
  const tryPivot = (): FootprintPose | undefined => {
    if (len >= M.MIN_PROGRESS || Math.abs(dyaw) < 1e-3 || !at) return undefined;
    // Which end met the block: the hit's offset along the heading. The turn is retried about that end
    // (it stays where it is; the other end swings), i.e. the centre moves from end + L·f0 to end + L·f1.
    const r0 = from.yaw * Math.PI / 180, r1 = to.yaw * Math.PI / 180;
    const f0x = -Math.sin(r0), f0z = Math.cos(r0), f1x = -Math.sin(r1), f1z = Math.cos(r1);
    const end = (at[0] - from.x) * f0x + (at[2] - from.z) * f0z < 0 ? -1 : 1;
    const L = Math.max(0.05, fp.halfLength);
    const p = { ...to, x: from.x + end * L * (f0x - f1x), z: from.z + end * L * (f0z - f1z) };
    return clear(p).ok ? p : undefined;
  };
  // A ship goes OVER what it meets (climb, then up the face) before it scrapes along it; a trunk met with a
  // wingtip is still stepped round first. A ground vehicle steps round and slides before it scrambles up.
  // A pure turn reaches none of those (each needs a push) and pivots.
  const order: Array<[MoveResolution, () => FootprintPose | undefined]> = opts.climbFirst
    ? [['climb', tryClimb], ['deflect', tryDeflect], ['rise', tryRise], ['slide', trySlide], ['pivot', tryPivot]]
    : [['deflect', tryDeflect], ['slide', trySlide], ['climb', tryClimb], ['rise', tryRise], ['pivot', tryPivot]];
  for (const [how, attempt] of order) {
    const p = attempt();
    if (p) return { pose: p, how, kept: how === 'slide' ? Math.max(0, Math.min(1, progress(p))) : how === 'rise' || how === 'pivot' ? 0 : 1, checks, ...(at ? { at } : {}) };
  }
  // Blocked: keep the turn and the vertical move where they are clear on their own.
  const fallbacks: FootprintPose[] = [
    { x: from.x, y: to.y, z: from.z, yaw: to.yaw, pitch: to.pitch },
    { x: from.x, y: to.y, z: from.z, yaw: from.yaw, pitch: to.pitch },
    { x: from.x, y: from.y, z: from.z, yaw: to.yaw, pitch: to.pitch },
  ];
  for (const p of fallbacks) if (clear(p).ok) return { pose: p, how: 'blocked', kept: 0, checks, ...(at ? { at } : {}) };
  return { pose: { ...from, pitch: to.pitch }, how: 'blocked', kept: 0, checks, ...(at ? { at } : {}) };
}

// ─── Headlights ────────────────────────────────────────────────────────────────

/**
 * Real light ahead of a driven vehicle at night, instead of the night vision
 * the riders used to get: ONE invisible light block (`minecraft:light_block_<LEVEL>`)
 * held `AHEAD` blocks in front of the nose at `HEIGHT` above the base, moved
 * when the vehicle crosses into a new cell (at most every `EVERY_TICKS`), and
 * removed when the rider leaves, the vehicle parks for `PARK_TICKS`, or day
 * comes. The cell is written to the vehicle's `craftmatic:headlight` dynamic
 * property, so a light left by a closed world is removed on the next load.
 * Only an AIR cell takes the light; a block in the way keeps the old one.
 * Night is the time of day from `DUSK` to `DAWN` (Minecraft ticks, 0 = sunrise).
 */
export const HEADLIGHTS = { LEVEL: 14, AHEAD: 2, HEIGHT: 1, EVERY_TICKS: 2, PARK_TICKS: 100, DUSK: 12500, DAWN: 23500 } as const;
export type HeadlightParams = { readonly [K in keyof typeof HEADLIGHTS]: number };

/** Whether it is dark enough for headlights at this time of day (0-24000). */
export function isNightTime(timeOfDay: number, P: HeadlightParams): boolean {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  return t >= P.DUSK && t < P.DAWN;
}

/** The block cell the headlight stands in: `AHEAD` past the nose along the heading, `HEIGHT` above the base. */
export function headlightCell(x: number, y: number, z: number, yaw: number, noseReach: number, P: HeadlightParams): [number, number, number] {
  const r = yaw * Math.PI / 180, d = noseReach + P.AHEAD;
  return [Math.floor(x - Math.sin(r) * d), Math.floor(y + P.HEIGHT), Math.floor(z + Math.cos(r) * d)];
}

// ─── The scripted-vehicle runtime (cars, hover craft, boats and aircraft) ──────

/** Actor properties the vehicle runtime writes and a scripted vehicle's drive animation reads. */
export const FLIGHT_PROPS = { pitch: 'craftmatic:fl_pitch', bank: 'craftmatic:fl_bank', wheel: 'craftmatic:fl_wheel' } as const;

/** `description.properties` of a scripted vehicle (float literals: see bedrock-json.ts). */
export function flightProperties(): Record<string, unknown> {
  return {
    [FLIGHT_PROPS.pitch]: floatActorProperty([-90, 90], 0),
    [FLIGHT_PROPS.bank]: floatActorProperty([-90, 90], 0),
    [FLIGHT_PROPS.wheel]: floatActorProperty([0, 100000], 0),
  };
}

/**
 * Test and tuning hook: `/scriptevent craftmatic:flight_input {"x":0,"y":-1,"jump":true,"ticks":40}`
 * drives every scripted vehicle (or the one whose entity `id` is given) as if
 * its rider held that input. Measured on the Pixel (2026-09-25): a GameTest
 * simulated player's stick never reaches `inputInfo` (every sample read
 * 0, 0 while it drove), so the device test drives a scripted vehicle this way.
 * The rail runtime (`bedrock-coaster.ts`) listens to the SAME event for a
 * driven train: `y` is its stick, `id` any of its cars.
 */
export const FLIGHT_INPUT_EVENT = 'craftmatic:flight_input';
/** `/scriptevent craftmatic:vehicle_telemetry on|off`: one `CMVT {json}` content-log line per scripted or driven vehicle per second. */
export const VEHICLE_TELEMETRY_EVENT = 'craftmatic:vehicle_telemetry';
/**
 * Dynamic properties another runtime may set on a scripted vehicle: its top
 * speed in blocks/s (the time machine raises it to its armed speed), a line
 * appended to the HUD (the time circuit's state), the cell of its headlight,
 * and `hold`: its rider HOPPED onto another mount (bedrock-ride-hop.ts), so
 * an aircraft hovers where it was left and a car, hover craft or boat stops,
 * until a rider is aboard again. `lookPitch`: where the driver's VIEW looks
 * (degrees, + = down), written every tick by the camera runtime
 * (vehicle-free-look.ts) - a ship's Jump pressed while it looks down goes down.
 */
export const VEHICLE_DYNAMIC = { topSpeed: 'craftmatic:top_speed', hud: 'craftmatic:vehicle_hud', headlight: 'craftmatic:headlight', hold: 'craftmatic:hop_hold', lookPitch: 'craftmatic:look_pitch' } as const;

/**
 * Where a player who gets off a scripted vehicle is set down (SEAT-05; `vehicleEgress`, run by
 * `scriptedVehicleRuntime` the tick after it sees a rider gone). Bedrock sets the rider down about its SEAT
 * (quirk `dismount-near-seat`): off 76286 at 200 % on the ground that was ~10 blocks up, inside the drawn
 * hull, and the player fell ~9 blocks (Pixel round 30l, `output/device-round-2026-10-07l/pixel/notes.md`
 * item 5, `62b`). So the runtime moves the player to a walkable floor BESIDE the hull at the vehicle's own
 * ground level:
 *   - `MARGIN` 0.5: blocks of clearance between the hull's footprint and the body (0.3 half wide), so the
 *     set-down is clear of the drawn hull, not grazing it;
 *   - `SPACING` 1: blocks between candidate spots round the footprint (a body is 0.6 wide; a gap a body fits
 *     through is never stepped over);
 *   - `MAX_CANDIDATES` 64: spots tried, nearest the seat first - the driver's own side - a 400 % ship's whole
 *     ring is ~270, and each spot costs a walk-exit probe on the one tick of the dismount;
 *   - `ABOVE_BASE` 1 / `DROP` 3: a spot's floor lies at most a block over the vehicle's base and at most the
 *     no-damage fall (the rides' `SETDOWN_DROP_BLOCKS`) under it: the ground the vehicle stands on, never a
 *     balcony at the seat's height nor a pit;
 *   - `AIRBORNE_BLOCKS` 3: a vehicle with no ground or water within this under its base is in the air; its
 *     rider is put beside the hull at the seat's height and floats down under slow falling for
 *     `SLOW_FALL_TICKS` 600 (30 s covers a 90-block drop at ~3 blocks/s; the flyer's own float,
 *     `FLYER.DISMOUNT_SLOW_FALL_TICKS`);
 *   - `NATIVE_REACH` 2: blocks (times the vehicle's scale) from the seat beyond which the player was moved on
 *     purpose (a `/tp`, a hop's set-down) and is left alone, as `SEAT_EGRESS.NATIVE_REACH_BLOCKS`.
 */
export const VEHICLE_EGRESS = { MARGIN: 0.5, SPACING: 1, MAX_CANDIDATES: 64, ABOVE_BASE: 1, DROP: 3, AIRBORNE_BLOCKS: 3, SLOW_FALL_TICKS: 600, NATIVE_REACH: 2 } as const;
export type VehicleEgressParams = typeof VEHICLE_EGRESS;

/** A world point, blocks. */
interface EgressPoint { x: number; y: number; z: number }

/** What `vehicleEgress` needs to know about the vehicle and the player (world blocks, the vehicle at its wand size). */
export interface VehicleEgressInput {
  /** The vehicle's origin and Bedrock yaw (degrees; 0 faces +Z). */
  pose: { x: number; y: number; z: number; yaw: number };
  /** Its footprint: half length along the nose, half width, height - already times its scale. */
  halfLength: number; halfWidth: number; height: number;
  /** Its `minecraft:scale` (the native reach scales with it). */
  scale: number;
  /** Where the rider's feet were while seated (the tick before). */
  seat: EgressPoint;
  /** Where the player is now (Bedrock's own set-down). */
  current: EgressPoint;
  /** No ground or water within `AIRBORNE_BLOCKS` under the base. */
  airborne: boolean;
  /** Afloat on water (a boat's waterline height, else undefined). */
  waterline?: number | undefined;
}

/** The world probes `vehicleEgress` asks (the runtime builds them from its block reads and the collider body probe). */
export interface VehicleEgressProbe {
  /** The highest floor top under a body standing at (x, z), at most `top` and at least `top - depth`; null for none. */
  floor(x: number, z: number, top: number, depth: number): number | null;
  /** Whether a player's body (0.6 x 1.8) with its feet at `q` meets nothing solid. */
  free(q: EgressPoint): boolean;
  /** Whether `q` (on its floor, or falling at most `fall` onto one) has a walking exit (`ColliderBodyProbe.hasWalkExit`). */
  walkExit(q: EgressPoint, fall: number): boolean;
  /** Whether the body at `q` stands in water (its feet or head). */
  wet(q: EgressPoint): boolean;
  /** The collider body probe's last-resort way out from `from` (`ColliderBodyProbe.escape`), or undefined. */
  escape(from: EgressPoint): EgressPoint | undefined;
}

/**
 * How a set-down was decided: `native` Bedrock's own spot was already outside the hull and walkable; `moved`
 * the player went somewhere on purpose (left alone); `beside` a walkable floor beside the hull; `escape` the
 * body probe's flood or exterior; `plain` a floor beside the hull the walk-exit probe could not confirm (it
 * reads a plant as a block); `float` the vehicle is in the air (beside it, slow falling); `swim` afloat with
 * no shore beside it (beside it, at the waterline); `none` nothing found (left where Bedrock put it).
 */
export type VehicleEgressHow = 'native' | 'moved' | 'beside' | 'escape' | 'plain' | 'float' | 'swim' | 'none';

/**
 * SERIALISED (into `scripts/vehicles.js`, an argument of `scriptedVehicleRuntime`). Where a player who left a
 * scripted vehicle should stand: never inside the hull (its footprint, under its top), never a fall past
 * `DROP`, beside the vehicle at its ground level, the spot nearest the seat first. Pure: the world is read
 * through `probe`. The hull is an entity, which no block probe sees, so "outside the hull" is the footprint
 * test here; the spots are on a ring `MARGIN` + half a body outside it.
 */
export function vehicleEgress(input: VehicleEgressInput, probe: VehicleEgressProbe, P: VehicleEgressParams): { at: EgressPoint; how: VehicleEgressHow } {
  const BODY_HALF = 0.3;
  const { pose, seat, current } = input;
  const rad = pose.yaw * Math.PI / 180, fx = -Math.sin(rad), fz = Math.cos(rad), rx = -Math.cos(rad), rz = -Math.sin(rad);
  const k = Math.max(1, input.scale);
  // Moved on purpose (a /tp out of the seat, another runtime's set-down): not ours to correct.
  const reach = P.NATIVE_REACH * k;
  if (Math.hypot(current.x - seat.x, current.z - seat.z) > reach + Math.max(input.halfLength, input.halfWidth) || current.y > seat.y + reach) return { at: current, how: 'moved' };
  /** Inside the hull: within its footprint and under its top (under the hull counts: it parks there). */
  const inHull = (q: EgressPoint): boolean => {
    const dx = q.x - pose.x, dz = q.z - pose.z;
    return Math.abs(dx * fx + dz * fz) < input.halfLength + BODY_HALF && Math.abs(dx * rx + dz * rz) < input.halfWidth + BODY_HALF && q.y < pose.y + input.height;
  };
  if (!inHull(current) && !input.airborne && !probe.wet(current) && probe.walkExit(current, P.DROP)) return { at: current, how: 'native' };
  // The ring of spots round the footprint, in the vehicle's frame (a along the nose, b along its right), nearest the seat first.
  const L = input.halfLength + P.MARGIN + BODY_HALF, W = input.halfWidth + P.MARGIN + BODY_HALF;
  const ring: Array<{ x: number; z: number; d: number }> = [];
  const add = (a: number, b: number): void => {
    const x = pose.x + fx * a + rx * b, z = pose.z + fz * a + rz * b;
    if (ring.some(q => Math.abs(q.x - x) < 1e-6 && Math.abs(q.z - z) < 1e-6)) return;
    ring.push({ x, z, d: Math.hypot(x - seat.x, z - seat.z) });
  };
  const nA = Math.max(1, Math.ceil(2 * L / P.SPACING)), nB = Math.max(1, Math.ceil(2 * W / P.SPACING));
  for (let i = 0; i <= nA; i++) { const a = -L + 2 * L * i / nA; add(a, W); add(a, -W); }
  for (let i = 0; i <= nB; i++) { const b = -W + 2 * W * i / nB; add(L, b); add(-L, b); }
  ring.sort((p, q) => p.d - q.d);
  const spots = ring.slice(0, Math.max(1, P.MAX_CANDIDATES));
  const nearest = spots[0]!;
  if (input.airborne) {
    // In the air: beside the hull at the seat's height (never inside it, never under it where it parks), floating down.
    const q = { x: nearest.x, y: seat.y, z: nearest.z };
    return { at: probe.free(q) ? q : current, how: 'float' };
  }
  const top = pose.y + P.ABOVE_BASE, depth = P.ABOVE_BASE + P.DROP;
  const standAt = (s: { x: number; z: number }): EgressPoint | undefined => {
    const y = probe.floor(s.x, s.z, top, depth);
    if (y === null) return undefined;
    const q = { x: s.x, y, z: s.z };
    return probe.free(q) && !probe.wet(q) ? q : undefined;
  };
  // 1. A walkable floor beside the hull, the spot nearest the seat first.
  const stands: EgressPoint[] = [];
  for (const s of spots) {
    const q = standAt(s);
    if (!q) continue;
    if (probe.walkExit(q, 0)) return { at: q, how: 'beside' };
    stands.push(q);
  }
  // 2. Afloat with no shore beside it: in the water beside the hull, at its waterline.
  if (input.waterline !== undefined) {
    const q = { x: nearest.x, y: input.waterline, z: nearest.z };
    return { at: probe.free(q) ? q : current, how: 'swim' };
  }
  // 3. Walled in beside it (a car in a garage): the body probe's walk-connected flood, else the model's exterior.
  const out = probe.escape({ x: nearest.x, y: pose.y, z: nearest.z });
  if (out && !inHull(out) && !probe.wet(out)) return { at: out, how: 'escape' };
  // 4. A floor beside it that the walk-exit probe could not confirm (it reads a plant as a block).
  if (stands.length) return { at: stands[0]!, how: 'plain' };
  return { at: current, how: 'none' };
}

/** One scripted vehicle type as the runtime sees it. */
export interface ScriptedVehicleType {
  mode: 'plane' | 'boat' | 'car' | 'hover';
  /** Half its length (where its bow or nose is probed), blocks at scale 1. */
  noseReach: number;
  /** Half its width, blocks at scale 1 (the footprint's side). */
  halfWidth: number;
  /** Its height, blocks at scale 1 (the top of the footprint band). */
  height: number;
  /** A boat's keel depth under the surface, blocks. */
  draft?: number;
  /** Per-type overrides of the car (or hover) constants, e.g. the time machine's top speed. */
  car?: Partial<Record<keyof typeof CAR, number>>;
}

/** What the scripted-vehicle runtime is told about the pack. */
export interface ScriptedVehicleConfig {
  /** Every scripted vehicle type. */
  types: Record<string, ScriptedVehicleType>;
  flight: FlightParams;
  boat: BoatParams;
  car: CarParams;
  hover: HoverParams;
  footprint: FootprintParams;
  move: MoveParams;
  headlights: HeadlightParams;
  props: typeof FLIGHT_PROPS;
  dynamic: typeof VEHICLE_DYNAMIC;
  /** The building shell's collider block: its `lo`/`hi` states are the solid span in sixteenths (bedrock-building-shell.ts). */
  colliders?: { block: string; loState: string; hiState: string } | undefined;
  inputEvent: string;
  telemetryEvent: string;
  /** Where a rider who gets off is set down (`VEHICLE_EGRESS`); absent in a hand-built test config: no set-down. */
  egress?: VehicleEgressParams | undefined;
  /** The collider body probe's last-resort bounds (`ESCAPE_OPTIONS`), for a set-down walled in beside the hull. */
  escape?: EscapeOptions | undefined;
}

/**
 * Runs in the pack: one pure step per tick for every scripted vehicle
 * (`carStep` for a car, `carStep` on `HOVER` for a hover craft, `flightStep`
 * for a ship, `boatStep` for a boat), the swept footprint over the new pose
 * and its collision response (`resolveMove`: climb, deflect, slide, rise),
 * then a teleport to it (the rider rides along, as on the coaster: 20 Hz
 * teleports are interpolated by the client) and the attitude written to the
 * actor properties its drive animation reads. Nobody aboard: a ship brakes
 * and sinks gently to the ground, a boat drifts to a stop, a car brakes;
 * parked, they stay put. The HUD shows speed and what to do next; at night a
 * light block runs ahead of the nose (`HEADLIGHTS`).
 *
 * Block probes read a SOLID SPAN per block: a collider block's `lo..hi`
 * sixteenths, a bottom slab's lower half, a top slab's upper half, a full
 * block otherwise; plants, torches, snow layers and light blocks are passed.
 */
export function scriptedVehicleRuntime(config: ScriptedVehicleConfig, flight: typeof flightStep, boat: typeof boatStep, car: typeof carStep, sweep: typeof sweepFootprint, night: typeof isNightTime, lightCell: typeof headlightCell, resolve: typeof resolveMove, egress?: typeof vehicleEgress, body?: ColliderBodyProbe): void {
  const F = config.flight, B = config.boat, C = config.car, H = config.hover, FP = config.footprint, MV = config.move, HL = config.headlights, DYN = config.dynamic;
  const COL = config.colliders;
  const typeIds = Object.keys(config.types);
  const states = new Map<string, any>();
  const overrides = new Map<string, { x: number; y: number; jump: boolean; ticks: number }>();
  let telemetry = false;
  const MPH = 2.236936;
  /** Ticks a new driver sees the controls hint in the action bar (5 s); then only the speed and any warning. */
  const HUD_HINT_TICKS = 100;
  /** Ticks after a climb or a rise the HUD still says the vehicle is lifting over (two of its 4-tick writes). */
  const HUD_LIFT_TICKS = 8;
  const dims = (): any[] => ['overworld', 'nether', 'the_end'].flatMap(id => { try { return [world.getDimension(id)]; } catch { return []; } });
  // Plants, torches, snow layers and light blocks are passed through; everything else solid is ground.
  const PASSABLE = /(^|:)(air|cave_air|void_air|light_block.*|short_grass|tall_grass|grass|fern|large_fern|.*_flower|dandelion|poppy|torch|.*_torch|snow_layer|vine|seagrass|kelp|kelp_plant|lily_pad)$/;
  /** One tick's block lookups, by cell: a probe band re-reads the same cells many times. */
  let cells = new Map<string, any>();
  const blockOf = (dim: any, x: number, y: number, z: number): any => {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const key = `${dim.id}|${bx},${by},${bz}`;
    if (cells.has(key)) return cells.get(key);
    let b: any;
    try { b = dim.getBlock({ x: bx, y: by, z: bz }); } catch { b = undefined; }
    cells.set(key, b);
    return b;
  };
  const isWater = (b: any): boolean => !!b && (b.isLiquid === true || /water/.test(String(b.typeId)));
  /** The solid span of a block as fractions of its cell [lo, hi], or null (passable, air or water). */
  const spanOf = (b: any): [number, number] | null => {
    if (!b || b.isAir || isWater(b)) return null;
    const id = String(b.typeId);
    if (PASSABLE.test(id)) return null;
    if (COL && id === COL.block) {
      let lo = 0, hi = 16;
      try { lo = Number(b.permutation.getState(COL.loState)); hi = Number(b.permutation.getState(COL.hiState)); } catch { /* full */ }
      return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo / 16, hi / 16] : [0, 1];
    }
    if (/_slab$/.test(id)) {
      let half = '';
      try { half = String(b.permutation.getState('minecraft:vertical_half')); } catch { /* a double slab */ }
      if (half === 'bottom') return [0, 0.5];
      if (half === 'top') return [0.5, 1];
    }
    return [0, 1];
  };
  /** Whether a point is inside a block's solid span. */
  const solidAt = (dim: any, x: number, y: number, z: number): boolean => {
    const s = spanOf(blockOf(dim, x, y, z));
    if (!s) return false;
    const f = y - Math.floor(y);
    return f >= s[0] && f < s[1];
  };
  /**
   * The top of the first solid span scanning down from the cell holding `y`,
   * within `depth` blocks (null: none, or unloaded). With water counted
   * (`water`), a water block's surface stops the scan too: an aircraft lands
   * on either, a hover craft floats over either.
   */
  const topBelow = (dim: any, x: number, y: number, z: number, depth: number, water: boolean): number | null => {
    const top = Math.floor(y);
    for (let by = top; by >= top - depth; by--) {
      const b = blockOf(dim, x, by, z);
      if (!b) return null;
      if (water && isWater(b)) return by + 0.9;
      const s = spanOf(b);
      if (s) return by + s[1];
    }
    return null;
  };
  const solidTop = (dim: any, x: number, y: number, z: number, depth: number): number | null => topBelow(dim, x, y, z, depth, false);
  /**
   * The ground under a vehicle whose base is at `footY`: scanning down from a step's
   * height over the base, a span whose top is a climbable step or lower is the ground; a
   * higher span whose underside is over the base is an OVERHANG it passes under, not
   * ground; a higher span the base is inside is a wall, reported by its top. With water
   * counted, a water block's surface is ground too (a ship settles on it, a hover craft
   * floats over it). Null: nothing within `depth`, or unloaded. Reading an overhang's
   * top as ground turned into "no ground": 10797's doll car (1 block tall) drove under a
   * collider and fell through the world to y -104 (Saga, 2026-09-29).
   */
  const groundUnder = (dim: any, px: number, pz: number, footY: number, stepUp: number, depth: number, water: boolean): number | null => {
    const top = Math.floor(footY + stepUp + 0.2);
    for (let by = top; by >= top - depth; by--) {
      const b = blockOf(dim, px, by, pz);
      if (!b) return null;
      if (water && isWater(b)) return by + 0.9;
      const s = spanOf(b);
      if (!s) continue;
      const lo = by + s[0], hi = by + s[1];
      if (hi <= footY + stepUp + 1e-6 || lo <= footY + 0.05) return hi;
    }
    return null;
  };
  /**
   * A boat's water: the surface under it (the top of the highest water block
   * within a block of its WATERLINE, origin + draft), the ground under it,
   * land at the waterline ahead / astern. The window follows the waterline,
   * not the origin: a hull whose keel sits over hanging parts (10365's stand
   * posts) carries a draft of several blocks, and a window at its origin would
   * start under the surface and read a deeper block as the top.
   */
  const waterAt = (dim: any, st: any, reach: number, draft: number): any => {
    const rad = st.yaw * Math.PI / 180, fx = -Math.sin(rad), fz = Math.cos(rad);
    let surface: number | null = null;
    const waterline = st.y + draft;
    for (let by = Math.floor(waterline + 1); by >= Math.floor(waterline - 2); by--) { if (isWater(blockOf(dim, st.x, by, st.z))) { surface = by + 0.9; break; } }
    const line = surface ?? st.y + draft;
    const landAt = (d: number): boolean => { const px = st.x + fx * d, pz = st.z + fz * d; return solidAt(dim, px, line - 0.1, pz) || solidAt(dim, px, line + 0.4, pz); };
    return { surface, ground: surface === null ? solidTop(dim, st.x, st.y + 0.5, st.z, 48) : null, shoreAhead: landAt(reach + 0.3), shoreAstern: landAt(-(reach + 0.3)) };
  };
  /** Remove the light a vehicle holds (only if it is still a light block: never someone's block placed since). */
  const clearLight = (e: any, st: any): void => {
    let at: string | undefined = st?.light;
    if (!at) { try { const v = e.getDynamicProperty(DYN.headlight); if (typeof v === 'string' && v) at = v; } catch { /* none */ } }
    if (!at) return;
    const [x, y, z] = at.split(',').map(Number);
    try {
      const b = e.dimension.getBlock({ x, y, z });
      if (b && /light_block/.test(String(b.typeId))) b.setType('minecraft:air');
    } catch { /* unloaded: the property keeps it for the next load */ return; }
    if (st) st.light = undefined;
    try { e.setDynamicProperty(DYN.headlight, undefined); } catch { /* gone */ }
  };
  /** Move the light to `cell` (air only). */
  const placeLight = (e: any, st: any, cell: [number, number, number]): void => {
    const key = cell.join(',');
    if (st.light === key) return;
    let b: any;
    try { b = e.dimension.getBlock({ x: cell[0], y: cell[1], z: cell[2] }); } catch { return; }
    if (!b || !(b.isAir || /light_block/.test(String(b.typeId)))) return;
    clearLight(e, st);
    try { b.setType(`minecraft:light_block_${HL.LEVEL}`); }
    catch { try { e.dimension.runCommand(`setblock ${cell[0]} ${cell[1]} ${cell[2]} light_block ["block_light_level"=${HL.LEVEL}]`); } catch { return; } }
    st.light = key;
    try { e.setDynamicProperty(DYN.headlight, key); } catch { /* unsaved */ }
  };
  system.afterEvents.scriptEventReceive.subscribe((ev: any) => {
    if (ev.id === config.telemetryEvent) { telemetry = String(ev.message || '').trim() !== 'off'; console.warn(`CMVT ${JSON.stringify({ telemetry })}`); return; }
    if (ev.id !== config.inputEvent) return;
    let m: any;
    try { m = JSON.parse(ev.message || '{}'); } catch { return; }
    for (const dim of dims()) for (const t of typeIds) {
      let list: any[] = [];
      try { list = dim.getEntities({ type: t }); } catch { continue; }
      for (const e of list) if (!m.id || e.id === m.id) overrides.set(e.id, { x: Number(m.x) || 0, y: Number(m.y) || 0, jump: !!m.jump, ticks: Math.max(1, Number(m.ticks) || 20) });
    }
  }, { namespaces: ['craftmatic'] });
  /** A rider as last seen aboard: the vehicle, where the rider's feet were, the vehicle's pose, scale and type. */
  interface Aboard { player: any; vid: string; dim: any; seat: { x: number; y: number; z: number }; pose: { x: number; y: number; z: number; yaw: number }; k: number; type: string }
  /**
   * Players aboard a scripted vehicle last tick, by id (SEAT-05). A player missing from every vehicle's riders
   * this tick got off (there is no dismount event, quirk `no-dismount-event`) and is set down by `setDown`.
   */
  const aboard = new Map<string, Aboard>();
  /** This tick's riders (player ids) and every vehicle's pose as last read. */
  let seen = new Set<string>();
  const poses = new Map<string, { x: number; y: number; z: number; yaw: number }>();
  /**
   * Put a player who got off a vehicle on a walkable floor beside it (`vehicleEgress`): Bedrock sets the rider
   * down about its seat, which in a big hull is high up and inside it (Pixel 30l: ~9 blocks off 76286 at 200 %).
   */
  const setDown = (rec: Aboard): void => {
    const E = config.egress, kind = config.types[rec.type];
    if (!E || !egress || !kind) return;
    const p = rec.player;
    try { if (p.isValid === false || (typeof p.isValid === 'function' && !p.isValid())) return; } catch { return; }
    let riding: any;
    try { riding = p.getComponent('minecraft:riding')?.entityRidingOn; } catch { riding = undefined; }
    // On another mount already: a hop (bedrock-ride-hop.ts) or a seat of its own choosing.
    if (riding) return;
    let current: { x: number; y: number; z: number };
    try { const l = p.location; current = { x: l.x, y: l.y, z: l.z }; } catch { return; }
    const dim = rec.dim, k = rec.k, pose = poses.get(rec.vid) ?? rec.pose;
    const vs = states.get(rec.vid);
    const afloat = kind.mode === 'boat' && !!vs?.afloat;
    const isWet = (q: { x: number; y: number; z: number }): boolean => isWater(blockOf(dim, q.x, q.y + 0.2, q.z)) || isWater(blockOf(dim, q.x, q.y + 1.6, q.z));
    // TODO(egress-plants): the collider body probe reads any non-air block - a short grass or a flower - as a
    // full block, so on a planted lawn a spot's floor can read a block high (the player then drops that block) and
    // its walk exit can fail (`vehicleEgress` then falls back to `plain`, a floor beside the hull). The fix belongs
    // in `colliderBodyProbe` (collider-form.ts),
    // shared with the seats, rides and doors.
    const probe = {
      floor: (x: number, z: number, top: number, depth: number): number | null => {
        if (body) { try { return body.floorTop(dim, x, z, top, depth) ?? null; } catch { return null; } }
        return solidTop(dim, x, top, z, Math.ceil(depth));
      },
      free: (q: { x: number; y: number; z: number }): boolean => {
        try { return body ? body.bodyFree(dim, q) : !solidAt(dim, q.x, q.y + 0.1, q.z) && !solidAt(dim, q.x, q.y + 1, q.z) && !solidAt(dim, q.x, q.y + 1.7, q.z); } catch { return false; }
      },
      walkExit: (q: { x: number; y: number; z: number }, fall: number): boolean => { try { return !!body && body.hasWalkExit(dim, q, fall); } catch { return false; } },
      wet: isWet,
      escape: (from: { x: number; y: number; z: number }): { x: number; y: number; z: number } | undefined => {
        if (!body || !config.escape) return undefined;
        try { return body.escape(dim, from, config.escape)?.at; } catch { return undefined; }
      },
    };
    const res = egress({
      pose, halfLength: kind.noseReach * k, halfWidth: kind.halfWidth * k, height: kind.height * k, scale: k,
      seat: rec.seat, current,
      airborne: groundUnder(dim, pose.x, pose.z, pose.y, 0.5, E.AIRBORNE_BLOCKS, true) === null,
      // A boat afloat: its waterline (origin + draft), the swimmer's feet half a block under it.
      waterline: afloat ? pose.y + (kind.draft ?? B.DRAFT) * k - 0.5 : undefined,
    }, probe, E);
    if (res.how === 'native' || res.how === 'moved' || res.how === 'none') {
      if (res.how === 'none') console.warn(`[craftmatic vehicle] no safe set-down for ${p.id} off ${rec.type}; left where Bedrock put it at ${current.x},${current.y},${current.z}`);
      else if (telemetry) console.warn(`CMVT ${JSON.stringify({ dismount: res.how, type: rec.type, at: current })}`);
      return;
    }
    let moved = false;
    try { moved = p.tryTeleport(res.at, { dimension: dim, checkForBlocks: true, keepVelocity: false }) === true; } catch { moved = false; }
    if (!moved) { try { p.teleport(res.at, { dimension: dim, keepVelocity: false }); moved = true; } catch { moved = false; } }
    // In the air: float down beside the hull (no fall damage), as off the flyer's cloud.
    if (moved && res.how === 'float') { try { p.addEffect('slow_falling', E.SLOW_FALL_TICKS, { amplifier: 0, showParticles: false }); } catch { /* no effect */ } }
    if (telemetry) console.warn(`CMVT ${JSON.stringify({ dismount: res.how, type: rec.type, from: current, at: res.at, moved })}`);
  };
  let tick = 0, busyMs = 0, busyTicks = 0;
  system.runInterval(() => {
    tick++;
    cells = new Map();
    seen = new Set();
    const started = Date.now();
    let isNight = false;
    try { isNight = night(world.getTimeOfDay(), HL); } catch { /* no clock */ }
    for (const dim of dims()) {
      // One query per dimension for every scripted type (per type, 60367's seven vehicle types made 21 queries a tick).
      let list: any[] = [];
      try { list = dim.getEntities({ families: ['craftmatic_vehicle'] }); } catch { continue; }
      for (const e of list) {
        const type = String(e.typeId), kind = config.types[type];
        if (!kind) continue;
        let loc: any, rot: any;
        try { loc = e.location; rot = e.getRotation(); } catch { continue; }
        let st = states.get(e.id);
        if (!st || Math.hypot(loc.x - st.x, loc.z - st.z) > 3 || Math.abs(loc.y - st.y) > 3) {
          // First sight, or moved by something else (the wand, a /tp, a test, a time jump): start from where it stands.
          const light = st?.light;
          if (kind.mode === 'plane') {
            const g = groundUnder(dim, loc.x, loc.z, loc.y, 0.5, 4, true);
            const onGround = g !== null && Math.abs(loc.y - g) < 1;
            st = { x: loc.x, y: onGround ? g : loc.y, z: loc.z, yaw: rot.y, pitch: 0, speed: 0, vy: 0, onGround, bank: 0, jumpHeld: false, diving: false, wheel: 0 };
          } else if (kind.mode === 'car' || kind.mode === 'hover') {
            st = { x: loc.x, y: loc.y, z: loc.z, yaw: rot.y, speed: 0, vy: 0, onGround: true, boost: 0, cooldown: 0, pitch: 0, bank: 0, wheel: 0 };
          } else {
            st = { x: loc.x, y: loc.y, z: loc.z, yaw: rot.y, speed: 0, vy: 0, afloat: false, boost: 0, cooldown: 0, pitch: 0, bank: 0, wheel: 0 };
          }
          st.light = light;
          st.parked = 0;
          // The wand's size (`minecraft:scale`) scales the footprint and the probes.
          let scale = 1;
          try { const s = Number(e.getComponent('minecraft:scale')?.value); if (Number.isFinite(s) && s > 0) scale = s; } catch { /* unscaled */ }
          st.scale = scale;
        }
        const k = st.scale || 1;
        let riders: any[] = [];
        try { riders = e.getComponent('minecraft:rideable')?.getRiders?.() ?? []; } catch { /* none */ }
        const driver = riders.find((r: any) => r && r.typeId === 'minecraft:player');
        // Who is aboard, and where they sit: a player missing next tick got off (`setDown`).
        poses.set(e.id, { x: loc.x, y: loc.y, z: loc.z, yaw: rot.y });
        for (const r of riders) {
          if (!r || r.typeId !== 'minecraft:player') continue;
          let at: any;
          try { at = r.location; } catch { continue; }
          seen.add(r.id);
          aboard.set(r.id, { player: r, vid: e.id, dim, seat: { x: at.x, y: at.y, z: at.z }, pose: { x: loc.x, y: loc.y, z: loc.z, yaw: rot.y }, k, type });
        }
        const input: { x: number; y: number; jump: boolean; rider: boolean; lookPitch?: number } = { x: 0, y: 0, jump: false, rider: !!driver };
        if (driver) {
          try { const v = driver.inputInfo?.getMovementVector?.(); input.x = v?.x ?? 0; input.y = v?.y ?? 0; } catch { /* no input */ }
          try { input.jump = !!(driver.isJumping || driver.inputInfo?.getButtonState?.('Jump') === 'Pressed'); } catch { /* no input */ }
          // Where the driver's VIEW looks (the camera runtime's free look), else the rider's own pitch.
          if (kind.mode === 'plane') {
            let look: unknown;
            try { look = e.getDynamicProperty(DYN.lookPitch); } catch { /* none */ }
            if (typeof look === 'number' && Number.isFinite(look)) input.lookPitch = look;
            else { try { input.lookPitch = Number(driver.getRotation().x) || 0; } catch { /* none */ } }
          }
        }
        const o = overrides.get(e.id);
        if (o) { input.x = o.x; input.y = o.y; input.jump = o.jump; input.rider = true; if (--o.ticks <= 0) overrides.delete(e.id); }
        // Left by a HOP (its rider flew or drove into another mount, bedrock-ride-hop.ts): an aircraft
        // hovers where it was left, holding its state (a rider back aboard flies on at the speed it had);
        // a car, hover craft or boat stops where it is. A rider aboard again ends the hold.
        let held = false;
        try { held = e.getDynamicProperty(DYN.hold) === true; } catch { /* none */ }
        if (held && input.rider) { try { e.setDynamicProperty(DYN.hold, undefined); } catch { /* gone */ } held = false; }
        if (held) {
          if (kind.mode === 'plane') { states.set(e.id, st); continue; }
          st.speed = 0;
          if (st.vy !== undefined) st.vy = 0;
          try { e.setDynamicProperty(DYN.hold, undefined); } catch { /* gone */ }
        }
        const noseReach = kind.noseReach * k;
        // Headlights: a driver at night, moving or lately moved.
        st.parked = Math.abs(st.speed) > 0.2 || Math.abs(input.y) > 0.15 ? 0 : (st.parked || 0) + 1;
        if (isNight && input.rider && st.parked < HL.PARK_TICKS && kind.mode !== 'plane') {
          if (tick % HL.EVERY_TICKS === 0) placeLight(e, st, lightCell(st.x, st.y, st.z, st.yaw, noseReach, HL));
        } else if (st.light || (tick % 40 === 0 && !input.rider)) clearLight(e, st);
        const rad = st.yaw * Math.PI / 180, fx = -Math.sin(rad), fz = Math.cos(rad);
        const reach = noseReach + 0.5;
        // Terrain that is not loaded (no block to read under the vehicle or at its nose) is not
        // "no ground": hold still until it loads. An empty car ran off the loaded area on the
        // Pixel and fell 250 blocks through the unread ground (2026-09-25).
        if (!blockOf(dim, st.x, st.y - 0.5, st.z) || !blockOf(dim, st.x + fx * reach, st.y, st.z + fz * reach)) {
          st.speed = 0;
          if (st.vy !== undefined) st.vy = 0;
          states.set(e.id, st);
          continue;
        }
        let r: any, ground: number | null = null;
        let fp: { halfLength: number; halfWidth: number; lo: number; hi: number } | undefined;
        // The collision response's climb allowance this tick (blocks) and its order (`resolveMove`).
        let climb = 0, climbFirst = false;
        if (kind.mode === 'plane') {
          // Parked, nobody at the controls: nothing to integrate.
          if (!input.rider && st.onGround && Math.abs(st.speed) < 0.05) { states.set(e.id, st); continue; }
          ground = groundUnder(dim, st.x, st.z, st.y, F.STEP_UP, st.onGround ? 3 : 48, true);
          r = flight(st, input, { ground }, F, 0.05);
          // Nobody aboard and sinking to park: never down onto a player under its footprint (the rider who
          // just sneaked off fell straight under it and the X-wing parked ON the child, Saga 30j s79). It
          // holds `PARK_CLEARANCE` over the highest head under it, level, and sinks on when they walk out.
          if (!input.rider && r.state.y < st.y) {
            let players: any[] = [];
            try { players = dim.getPlayers(); } catch { /* none */ }
            const L = noseReach, W = kind.halfWidth * k, rx = -Math.cos(rad), rz = -Math.sin(rad);
            let floor: number | null = null;
            for (const p of players) {
              let pl: any;
              try { pl = p.location; } catch { continue; }
              const dx = pl.x - st.x, dz = pl.z - st.z;
              // Under the hull: within the footprint (a step of margin) and below the base. Standing on it is not under it.
              if (Math.abs(dx * fx + dz * fz) > L + 0.5 || Math.abs(dx * rx + dz * rz) > W + 0.5 || pl.y >= st.y) continue;
              const top = pl.y + F.PLAYER_HEIGHT + F.PARK_CLEARANCE;
              floor = floor === null ? top : Math.max(floor, top);
            }
            if (floor !== null && r.state.y < floor) {
              // Hold where it is (never lifted by someone walking under a lower hull), level, still to sink.
              r.state.y = Math.min(st.y, floor); r.state.vy = 0; r.state.onGround = false;
              r.state.pitch = st.pitch < 0 ? Math.min(0, st.pitch + F.ATTITUDE_RATE * 0.05) : Math.max(0, st.pitch - F.ATTITUDE_RATE * 0.05);
            }
          }
          r.state.wheel = st.wheel + (r.state.onGround ? r.state.speed * 0.05 * 57.2958 : 0);
          // The whole airframe must clear, on the ground too: a ship lifts itself over a step (`resolveMove`'s climb)
          // rather than sliding its hull through it. A band that skipped the step's height on the ground let half the
          // Milano's hull through a one-block step, and points already inside were then never counted aloft (the
          // sweep blocks only on ENTERING a solid; simulator vehicle course, 2026-09-30).
          fp = { halfLength: noseReach, halfWidth: kind.halfWidth * k, lo: 0.1, hi: Math.max(0.2, kind.height * k - 0.1) };
          // A ship pushed into a hill or a wall lifts itself over it (a rider's ship only: an empty one sinks to park).
          if (input.rider) { climb = F.AUTO_CLIMB * 0.05; climbFirst = true; }
        } else if (kind.mode === 'car' || kind.mode === 'hover') {
          // Parked, nobody at the wheel, on the ground: nothing to integrate.
          if (!input.rider && st.onGround && Math.abs(st.speed) < 0.02) { states.set(e.id, st); continue; }
          const hover = kind.mode === 'hover';
          const base: any = hover ? H : C;
          // Per-type overrides (the time machine's top speed), then the live top speed another runtime set.
          let P: any = kind.car ? { ...base, ...kind.car } : base;
          try { const top = Number(e.getDynamicProperty(DYN.topSpeed)); if (Number.isFinite(top) && top > 0) P = { ...P, MAX_SPEED: top, BOOST_SPEED: Math.max(P.BOOST_SPEED, top) }; } catch { /* none */ }
          const lift = hover ? H.RIDE_HEIGHT : 0;
          const noseX = st.x + fx * reach, noseZ = st.z + fz * reach, tailX = st.x - fx * reach, tailZ = st.z - fz * reach;
          // What it stands on: SOLID ground for a car (water is not a road); ground or water for a hover craft, plus its ride height.
          // Scanning down from a step's height over its base, a span whose top is a climbable
          // step or lower is the ground; a higher span whose underside is over the base is an
          // OVERHANG the car passes under, not ground; a higher span the base is inside is a
          // wall, reported by its top. Reading an overhang's top as "a wall under the centre"
          // turned into "no ground": 10797's doll car (1 block tall) drove under a collider
          // and fell through the world to y -104 (Saga, 2026-09-29).
          const footY = st.y - lift;
          const below = (px: number, pz: number, depth: number): number | null => {
            const g = groundUnder(dim, px, pz, footY, P.STEP_UP, depth, hover);
            return g === null ? null : g + lift;
          };
          ground = below(st.x, st.z, st.onGround ? 4 : 48);
          const groundFront = below(noseX, noseZ, 4), groundRear = below(tailX, tailZ, 4);
          // Scrambling up a wall (`resolveMove` climbed or rose last tick): while the stick still pushes,
          // the car HOLDS the height it climbed to until its wheels find ground there - its centre is
          // still over the pit or the road it climbed out of - for at most `CLIMB_HOLD_TICKS`.
          const pushing = Math.abs(input.y) >= P.DEADZONE;
          const standing = ground !== null && ground >= st.y - 0.05;
          // Letting go ends a climb (and a spent one: the next push may try again); standing on ground
          // again ends it too, and a new climb counts its height from there.
          if (!pushing) st.climbSpent = false;
          if (st.climbHold > 0 && (!pushing || standing)) st.climbHold = 0;
          if (standing) st.climbBase = undefined;
          const holding = st.climbHold > 0;
          r = car(st, input, {
            // A wall under the centre (the base inside a solid) is not "no ground": it holds its height; nor is
            // the drop under a car still scrambling over a wall's top.
            ground: ground !== null && ground - st.y > P.STEP_UP ? st.y : holding && (ground === null || ground < st.y) ? st.y : ground,
            groundFront, groundRear,
            inWater: !hover && isWater(blockOf(dim, st.x, st.y + 0.2, st.z)), wheelbase: 2 * reach,
          }, P, 0.05);
          // A car pushed into a wall scrambles up it, to `RISE_MAX` over where it started climbing - once
          // per push: a wall still in the way at the top is too high, and it drops back (`climbSpent`).
          // The last step is cut to what is left of `RISE_MAX`, so the climb ends exactly there (three whole steps of
          // 0.3 stopped 42172 at 0.9, its band's bottom a float's width inside a two-block kerb's top, simulator 2026-09-30).
          const left = P.RISE_MAX - (st.y - (st.climbBase ?? st.y));
          if (pushing && !st.climbSpent && left > 0.01) climb = Math.min(P.CLIMB_RATE * 0.05, left);
          // Signed distance rolled, as degrees of a one-block wheel (wrapped into the property's range).
          r.state.wheel = hover ? 0 : (((st.wheel + (r.state.onGround ? r.state.speed * 0.05 * 57.2958 : 0)) % 100000) + 100000) % 100000;
          fp = { halfLength: noseReach, halfWidth: kind.halfWidth * k, lo: P.STEP_UP - lift + 0.05, hi: Math.max(P.STEP_UP - lift + 0.1, kind.height * k - 0.1) };
        } else {
          const draft = (kind.draft ?? B.DRAFT) * k;
          const w = waterAt(dim, st, noseReach, draft);
          r = boat(st, input, w, { ...B, DRAFT: draft }, 0.05);
          r.state.wheel = 0;
          // From just above the waterline: a bank, a pier or a moored hull alongside.
          fp = { halfLength: noseReach, halfWidth: kind.halfWidth * k, lo: draft + 0.05, hi: Math.max(draft + 0.5, Math.min(kind.height * k, draft + 3)) };
        }
        const ns = r.state;
        // The swept footprint and its response: a corner, a wingtip or the hull's side meeting a block is
        // not a dead stop - the move climbs, steps round, slides along or rises (`resolveMove`); only a
        // move none of those clears is blocked.
        let sweepChecks = 0, how = 'clear';
        if (fp && (Math.hypot(ns.x - st.x, ns.z - st.z) > 1e-4 || Math.abs(ns.yaw - st.yaw) > 1e-3 || Math.abs(ns.y - st.y) > 1e-4)) {
          const solid = (x: number, y: number, z: number): boolean => solidAt(dim, x, y, z);
          // A ship's band tilts with its nose (an airframe pitched up clears what is under its tail); a car's and a
          // hover craft's stays LEVEL: a car pitched nose-up on a kerb's edge would let its nose pass while its
          // body between the wheels went through the edge (42172 on a two-block kerb, simulator 2026-09-30).
          const tilt = kind.mode === 'plane' || kind.mode === 'boat';
          const from = { x: st.x, y: st.y, z: st.z, yaw: st.yaw, pitch: tilt ? st.pitch || 0 : 0 };
          const res = resolve(from, { x: ns.x, y: ns.y, z: ns.z, yaw: ns.yaw, pitch: tilt ? ns.pitch || 0 : 0 }, fp, solid, FP, MV, { climb, climbFirst }, sweep);
          sweepChecks = res.checks;
          how = res.how;
          if (how !== 'clear') {
            if (Math.abs(res.pose.y - ns.y) > 1e-6 && ns.vy !== undefined) ns.vy = 0;
            ns.x = res.pose.x; ns.y = res.pose.y; ns.z = res.pose.z; ns.yaw = res.pose.yaw;
            ns.speed = how === 'slide' ? ns.speed * res.kept : how === 'climb' || how === 'deflect' ? ns.speed : 0;
            if (how === 'blocked') r.event = kind.mode === 'boat' ? 'beached' : 'blocked';
            r.hit = res.at;
          }
        }
        // A car that climbed or rose this tick holds that height while it drives on (`CLIMB_HOLD_TICKS`).
        // Blocked at the top of a climb: the wall is too high; the hold ends (it drops back) and the push is spent.
        if (kind.mode === 'car' || kind.mode === 'hover') {
          const spent = how === 'blocked' && (!!st.climbSpent || climb > 0 || (st.climbHold || 0) > 0);
          if (how === 'climb' || how === 'rise') { ns.climbBase = st.climbBase ?? st.y; ns.climbHold = (kind.mode === 'hover' ? H : C).CLIMB_HOLD_TICKS; }
          else { ns.climbHold = spent ? 0 : Math.max(0, (st.climbHold || 0) - 1); ns.climbBase = st.climbBase; }
          // Spent stays spent while the stick still pushes and the car has not got anywhere: dropped back from a wall
          // too high, it must not bob up it again and again; backing off, turning away or letting go clears it.
          ns.climbSpent = spent || (!!st.climbSpent && Math.hypot(ns.x - st.x, ns.z - st.z) < 0.05);
        }
        states.set(e.id, ns);
        ns.light = st.light; ns.parked = st.parked; ns.scale = st.scale; ns.how = how;
        // The last tick it climbed or rose: the HUD (written every 4 ticks) shows "LIFTING OVER" for the
        // `HUD_LIFT_TICKS` after one, so a rise that alternates with a creep is not sampled away (the X-wing lifted
        // over a hill with no hint drawn once, simulator 2026-10-07).
        ns.lifting = how === 'climb' || how === 'rise' ? tick : st.lifting;
        // Ticks the current driver has been aboard (the controls hint shows only at first).
        ns.aboard = driver ? (st.aboard || 0) + 1 : 0;
        // A boat rides a gentle swell and a hover craft bobs on its cushion (drawn only: the state keeps the calm line).
        const afloat = kind.mode === 'boat' && ns.afloat;
        const bob = kind.mode === 'hover' && ns.onGround;
        const swell = afloat ? { heave: Math.sin(tick * 0.16) * 0.04, roll: Math.sin(tick * 0.11) * 2, pitch: Math.sin(tick * 0.13) * 1.2 }
          : bob ? { heave: Math.sin(tick * 0.12) * 0.08, roll: Math.sin(tick * 0.07) * 1, pitch: Math.sin(tick * 0.09) * 0.6 } : { heave: 0, roll: 0, pitch: 0 };
        try { e.teleport({ x: ns.x, y: ns.y + swell.heave, z: ns.z }, { rotation: { x: 0, y: ns.yaw }, keepVelocity: false }); } catch { /* unloaded */ }
        try { e.setProperty(config.props.pitch, Math.max(-90, Math.min(90, ns.pitch + swell.pitch))); } catch { /* not declared */ }
        try { e.setProperty(config.props.bank, Math.max(-90, Math.min(90, ns.bank + swell.roll))); } catch { /* not declared */ }
        try { e.setProperty(config.props.wheel, ns.wheel % 100000); } catch { /* not declared */ }
        if (r.event) {
          // Soft sounds: a five-year-old bumps into things all the time (no explosion for a ship that meets a wall).
          const sound = r.event === 'blocked' ? 'random.anvil_land' : r.event === 'beached' ? 'dig.sand' : r.event === 'boost' || r.event === 'launched' ? 'random.splash' : 'random.orb';
          // A held stick against a wall would repeat the thud every tick: once per contact.
          if (r.event !== st.lastEvent || tick - (st.lastEventTick || 0) > 20) {
            try { e.dimension.playSound(sound, { x: ns.x, y: ns.y, z: ns.z }, { volume: r.event === 'blocked' ? 0.4 : 0.7 }); } catch { /* no sound */ }
            ns.lastEventTick = tick;
          } else ns.lastEventTick = st.lastEventTick;
          ns.lastEvent = r.event;
        } else { ns.lastEvent = undefined; ns.lastEventTick = st.lastEventTick; }
        // Where the rider's eye and feet are, relative to the vehicle's origin in its own frame
        // (right, up, forward): measures the seated eye height the seat plan assumes (cockpit-seat.ts).
        let riderAt: Record<string, number> | null = null;
        if (telemetry && tick % 20 === 0 && driver) {
          try {
            const at = e.location, head = driver.getHeadLocation(), feet = driver.location;
            const yr = (e.getRotation().y) * Math.PI / 180, cx = Math.cos(yr), sx = Math.sin(yr);
            const local = (p: any): [number, number] => { const dx = p.x - at.x, dz = p.z - at.z; return [Math.round((dx * cx + dz * sx) * 100) / 100, Math.round((-dx * sx + dz * cx) * 100) / 100]; };
            const [hx, hz] = local(head), [fx2, fz2] = local(feet);
            riderAt = { eyeX: hx, eyeY: Math.round((head.y - at.y) * 100) / 100, eyeZ: hz, feetX: fx2, feetY: Math.round((feet.y - at.y) * 100) / 100, feetZ: fz2 };
          } catch { riderAt = null; }
        }
        if (telemetry && tick % 20 === 0) console.warn(`CMVT ${JSON.stringify({ type, id: e.id, t: tick, riderAt, x: Math.round(ns.x * 100) / 100, y: Math.round(ns.y * 100) / 100, z: Math.round(ns.z * 100) / 100, yaw: Math.round(ns.yaw), speed: Math.round(ns.speed * 100) / 100, vy: ns.vy === undefined ? null : Math.round(ns.vy * 100) / 100, pitch: Math.round(ns.pitch), input, event: r.event ?? null, how, hit: r.hit ?? null, rider: !!driver, light: ns.light ?? null, night: isNight, sweepChecks, msPerTick: busyTicks ? Math.round(busyMs / busyTicks * 100) / 100 : 0 })}`);
        if (driver && tick % 4 === 0) {
          let hud: string;
          if (kind.mode === 'plane') {
            const alt = ground === null ? '--' : String(Math.max(0, Math.round(ns.y - ground)));
            // The controls hint only at first (the bar covers the middle of a phone's screen); then what it is doing.
            const going = ns.vy > 0.5 ? ' §a[UP]§r' : ns.vy < -0.5 && input.rider ? ' §a[DOWN]§r' : '';
            const hint = ns.aboard < HUD_HINT_TICKS ? '§7[STICK: FLY + TURN · JUMP: UP · BACK + JUMP: DOWN · DRAG: LOOK]§r'
              : r.event === 'blocked' ? '§c[BLOCKED: TURN OR BACK UP]§r' : tick - (ns.lifting ?? -HUD_LIFT_TICKS) < HUD_LIFT_TICKS ? '§e[LIFTING OVER]§r' : '';
            hud = `§lFLY§r §e${(Math.abs(ns.speed) * MPH).toFixed(0)} mph${ns.speed < -0.1 ? ' §c[BACK]' : ''}§r · §bALT ${alt}§r${going}${hint ? ` · ${hint}` : ''}`;
          } else if (kind.mode === 'car' || kind.mode === 'hover') {
            // The controls hint only for the first `HUD_HINT_TICKS` aboard: the bar sits across the middle
            // of a phone's screen, over the car the chase camera frames (Gabby's doll cars, Saga 2026-09-29).
            const hint = r.event === 'blocked' ? '§c[BLOCKED: TURN OR BACK UP]§r' : tick - (ns.lifting ?? -HUD_LIFT_TICKS) < HUD_LIFT_TICKS ? '§e[CLIMBING]§r' : ns.boost > 0 ? '§a[BOOST]§r' : ns.cooldown > 0 ? `§8[BOOST ${ns.cooldown.toFixed(1)}s]§r` : ns.aboard < HUD_HINT_TICKS ? '§7[STICK: DRIVE + STEER · JUMP: BOOST · DRAG: LOOK]§r' : '';
            hud = `§l${kind.mode === 'hover' ? 'HOVER' : 'CAR'}§r §e${(Math.abs(ns.speed) * MPH).toFixed(0)} mph${ns.speed < -0.1 ? ' §c[REV]' : ''}§r${hint ? ` · ${hint}` : ''}`;
          } else {
            const hint = !ns.afloat ? '§c[AGROUND: STICK BACK]§r' : r.event === 'beached' || ns.speed === 0 && input.y > 0.15 ? '§c[SHORE AHEAD]§r' : ns.boost > 0 ? '§a[BOOST]§r' : ns.cooldown > 0 ? `§8[BOOST ${ns.cooldown.toFixed(1)}s]§r` : ns.aboard < HUD_HINT_TICKS ? '§7[STICK: THROTTLE + RUDDER · JUMP: BOOST · DRAG: LOOK]§r' : '';
            hud = `§lBOAT§r §e${(Math.abs(ns.speed) * MPH).toFixed(0)} mph${ns.speed < -0.1 ? ' §c[ASTERN]' : ''}§r${hint ? ` · ${hint}` : ''}`;
          }
          if (ns.light) hud += ' · §e[LIGHTS]§r';
          try { const extra = e.getDynamicProperty(DYN.hud); if (typeof extra === 'string' && extra) hud += ` · ${extra}`; } catch { /* none */ }
          for (const rr of riders) { try { rr.onScreenDisplay?.setActionBar?.(hud); } catch { /* not a player */ } }
        }
      }
    }
    // Riders who got off since the last tick: set down beside their vehicle.
    for (const [pid, rec] of aboard) {
      if (seen.has(pid)) continue;
      aboard.delete(pid);
      setDown(rec);
    }
    busyMs += Date.now() - started; busyTicks++;
    if (busyTicks >= 20) { busyMs = busyMs / busyTicks; busyTicks = 1; }
  }, 1);
}

/** `scripts/vehicles.js`: the runtime with the pure models' and helpers' own text. */
export function scriptedVehicleScript(config: ScriptedVehicleConfig): string {
  // The collider body probe the seats and rides use, over this pack's collider states: the set-down's floors, room and walk exits.
  const probe = `(${colliderBodyProbe.toString()})((${colliderFormKit.toString()})(), ${JSON.stringify(config.colliders?.loState ?? COLLIDER_STATES.lo)}, ${JSON.stringify(config.colliders?.hiState ?? COLLIDER_STATES.hi)})`;
  return `import { world, system } from "@minecraft/server";\n(${scriptedVehicleRuntime.toString()})(${JSON.stringify(config)}, ${flightStep.toString()}, ${boatStep.toString()}, ${carStep.toString()}, ${sweepFootprint.toString()}, ${isNightTime.toString()}, ${headlightCell.toString()}, ${resolveMove.toString()}, ${vehicleEgress.toString()}, ${probe});\n`;
}
