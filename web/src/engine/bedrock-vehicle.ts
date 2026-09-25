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

declare const world: any;
declare const system: any;

/**
 * How a vehicle moves, for its animation (and its driver runtime): an aircraft
 * is a fixed wing or a rotor; a HOVER craft (a sail barge, a landspeeder, a
 * hovercraft) floats a fixed height over land and water alike.
 */
export type VehicleMotion = 'car' | 'boat' | 'plane' | 'rotor' | 'hover';

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
  const bones: Record<string, unknown> = { body: { rotation: ['v.cm_pitch', 0, 'v.cm_roll'] } };
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

// ─── Fixed-wing flight model ───────────────────────────────────────────────────

/**
 * Arcade flight for a fixed-wing aircraft, in world blocks and seconds. The
 * native Happy Ghast controller the aircraft used to ride on hovers: it has no
 * take-off speed, no stall and no landing, and its only vertical inputs were
 * Jump and looking up or down. This model is run by a script instead
 * (`scriptedVehicleRuntime`, one step per tick, the entity teleported like a coaster
 * car), and every number in it is here, in one place:
 *
 *   - Jump is the THROTTLE: hold it for full power. Let go and the engine
 *     settles at cruise power in the air (you never have to hold it to stay
 *     up), at approach power within `APPROACH_HEIGHT` of the ground (so
 *     pushing the nose down there lands rather than speeds up), and at idle on
 *     the ground, where the wheel brakes then slow you (`AUTO_BRAKE`).
 *   - The stick's forward/back is the ELEVATOR: back lifts the nose (climb),
 *     forward lowers it (dive); hands off, the nose eases back to level (or,
 *     climbing out on full power near the ground, to `CLIMB_OUT_PITCH`). On
 *     the ground, back with the throttle released is the brake; back at or
 *     above `ROTATE_SPEED` rotates the aircraft into the air (it also lifts
 *     off by itself at `AUTO_ROTATE` times that speed, so holding Jump alone
 *     takes off).
 *   - The stick's left/right banks and turns (and steers on the ground).
 *   - Below `STALL_SPEED` the wing stops lifting: the nose drops and it sinks
 *     until the speed is back. Touching down faster than `HARD_LANDING`
 *     downward is a hard landing; flying into a block is a crash (it stops).
 *
 * Speeds suit a minifig-scale model on a Minecraft map: 10 blocks/s to take
 * off (about 6 blocks of run at full power), about 23 at cruise, 32 at most.
 */
export const FLIGHT = {
  ROTATE_SPEED: 10, AUTO_ROTATE: 1.4, STALL_SPEED: 7, MAX_SPEED: 32,
  THRUST: 10, DRAG: 0.0111, GRAVITY: 9.8, SINK_MAX: 8,
  CRUISE_THROTTLE: 0.6, APPROACH_THROTTLE: 0.25, APPROACH_HEIGHT: 6, THROTTLE_UP: 0.8, THROTTLE_DOWN: 1.6,
  ROLL_FRICTION: 0.6, BRAKE: 6, AUTO_BRAKE: 5,
  PITCH_RATE: 45, PITCH_MAX: 40, PITCH_MIN: -40, LEVEL_RATE: 8, LIFTOFF_PITCH: 4, GROUND_PITCH_MAX: 12, CLIMB_OUT_PITCH: 10,
  STALL_PITCH: -25, STALL_DROP_RATE: 30,
  TURN_RATE: 55, TAXI_TURN: 60, BANK_PER_TURN: 0.55, BANK_MAX: 35,
  HARD_LANDING: 8, STEP_UP: 1,
  /** Sign of `inputInfo.getMovementVector().x` that means RIGHT (Minecraft's +x strafe is LEFT). */
  STICK_X_RIGHT: -1,
  /** Stick deflection under which an axis counts as centred. */
  DEADZONE: 0.15,
  /** Deflection that counts as FULL: a touch stick pushed to its rim reads 0.816 on the Pixel (2026-09-25). */
  STICK_FULL: 0.8,
} as const;
export type FlightParams = typeof FLIGHT;

/** One aircraft's flight state: world position, heading and nose angle (degrees, Bedrock yaw), airspeed, throttle 0..1, bank for the animation. */
export interface FlightState { x: number; y: number; z: number; yaw: number; pitch: number; speed: number; throttle: number; onGround: boolean; stalled: boolean; bank: number }
/** The controlling rider's input this tick: the stick (`getMovementVector`, forward = +y) and Jump; `rider` false = nobody aboard. */
export interface FlightInput { x: number; y: number; jump: boolean; rider: boolean }
/** The ground under and ahead of the aircraft: the top of the first solid or liquid block below (null: none within reach), and whether a block stands in its way. */
export interface FlightTerrain { ground: number | null; groundAhead: number | null; blocked: boolean }
export type FlightEvent = 'takeoff' | 'landing' | 'hard_landing' | 'crash' | 'stall';

/**
 * Advance one aircraft by `dt` seconds. Pure (the device runs this very text,
 * serialised into `scriptedVehicleRuntime`), so every behaviour above is unit-tested
 * off the device. Returns the new state and what happened, if anything.
 */
export function flightStep(s: FlightState, input: FlightInput, terrain: FlightTerrain, P: FlightParams, dt: number): { state: FlightState; event?: FlightEvent } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const toward = (v: number, target: number, rate: number): number => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
  const dz = (v: number): number => (Math.abs(v) < P.DEADZONE ? 0 : Math.max(-1, Math.min(1, v / P.STICK_FULL)));
  const right = dz(input.rider ? input.x : 0) * P.STICK_X_RIGHT;
  // Elevator: the stick pulled BACK (y < 0) is nose up.
  const noseUp = -dz(input.rider ? input.y : 0);
  const jump = input.rider && input.jump;
  const rad = (d: number): number => d * Math.PI / 180;
  const height = terrain.ground === null ? Infinity : s.y - terrain.ground;
  let event: FlightEvent | undefined;

  // Throttle: Jump is full power; otherwise cruise aloft, approach power when
  // pointing down near the ground, idle on the ground or with nobody aboard.
  const target = jump ? 1 : !input.rider || s.onGround ? 0 : height < P.APPROACH_HEIGHT ? P.APPROACH_THROTTLE : P.CRUISE_THROTTLE;
  const throttle = toward(s.throttle, target, (target > s.throttle ? P.THROTTLE_UP : P.THROTTLE_DOWN) * dt);
  let { yaw, pitch, speed } = s;
  let onGround = s.onGround, stalled = false;
  const turnRate = right * (onGround ? P.TAXI_TURN * Math.min(1, speed / 3) : P.TURN_RATE * Math.min(1, speed / P.ROTATE_SPEED));

  if (onGround) {
    yaw += turnRate * dt;
    // Auto-rotation needs the throttle held: a landing roll at speed must not bounce back into the air.
    const rotate = speed >= P.ROTATE_SPEED && (noseUp > 0 || (jump && speed >= P.ROTATE_SPEED * P.AUTO_ROTATE));
    pitch = rotate ? Math.min(P.GROUND_PITCH_MAX, pitch + P.PITCH_RATE * dt) : toward(pitch, 0, P.PITCH_RATE * dt);
    let accel = throttle * P.THRUST - P.DRAG * speed * speed - (speed > 0 ? P.ROLL_FRICTION : 0);
    // Stick back is the brake only with the throttle released: pulling back early on a take-off run must not slow it.
    if (noseUp > 0 && !jump && speed < P.ROTATE_SPEED) accel -= P.BRAKE;
    if (!jump && throttle < 0.05) accel -= P.AUTO_BRAKE;
    speed = clamp(speed + accel * dt, 0, P.MAX_SPEED);
    if (pitch >= P.LIFTOFF_PITCH && speed >= P.ROTATE_SPEED * 0.95) { onGround = false; event = 'takeoff'; }
  } else {
    if (speed < P.STALL_SPEED) {
      stalled = true;
      if (!s.stalled) event = 'stall';
      pitch = toward(pitch, P.STALL_PITCH, P.STALL_DROP_RATE * dt);
    } else if (noseUp) {
      pitch = clamp(pitch + noseUp * P.PITCH_RATE * dt, P.PITCH_MIN, P.PITCH_MAX);
    } else {
      // Hands off the nose eases level - except climbing out on full power close to the ground, where it holds a gentle climb.
      pitch = toward(pitch, jump && height < P.APPROACH_HEIGHT ? P.CLIMB_OUT_PITCH : 0, P.LEVEL_RATE * dt);
    }
    yaw += turnRate * dt;
    speed = clamp(speed + (throttle * P.THRUST - P.DRAG * speed * speed - P.GRAVITY * Math.sin(rad(pitch))) * dt, 0, P.MAX_SPEED);
  }
  yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
  const bank = toward(s.bank, onGround ? 0 : clamp(turnRate * P.BANK_PER_TURN, -P.BANK_MAX, P.BANK_MAX), 60 * dt);

  // Move along the heading and the nose; below stall speed the wing loses lift and it sinks.
  const lift = clamp((speed / P.STALL_SPEED) ** 2, 0, 1);
  const horizontal = speed * Math.cos(rad(pitch));
  const vy = onGround ? 0 : speed * Math.sin(rad(pitch)) - (1 - lift) * P.SINK_MAX;
  const fx = -Math.sin(rad(yaw)), fz = Math.cos(rad(yaw));
  let x = s.x + fx * horizontal * dt, z = s.z + fz * horizontal * dt, y = s.y + vy * dt;

  if (terrain.blocked && horizontal > 0) {
    // Into a block: stop where it is. In the air it then stalls and comes down.
    x = s.x; z = s.z; speed = 0; event = 'crash';
  }
  if (onGround) {
    // Follow the ground: up a step of at most STEP_UP, down any small drop; off an edge it is airborne.
    const g = terrain.groundAhead ?? terrain.ground;
    if (g !== null && g - s.y > P.STEP_UP) { x = s.x; z = s.z; speed = 0; event = 'crash'; }
    else if (g !== null && g >= s.y - 0.5) y = g;
    else { onGround = false; y = s.y; }
  } else if (terrain.ground !== null && y <= terrain.ground) {
    const hard = vy < -P.HARD_LANDING;
    y = terrain.ground; onGround = true; pitch = clamp(pitch, 0, P.GROUND_PITCH_MAX);
    if (hard) speed *= 0.4;
    event = hard ? 'hard_landing' : 'landing';
    stalled = false;
  }
  return { state: { x, y, z, yaw, pitch, speed, throttle, onGround, stalled, bank }, ...(event ? { event } : {}) };
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
 *     stop; hands off it coasts down (`COAST`);
 *   - left/right steers, with full lock by `STEER_FULL_SPEED` and less of it
 *     at speed (`STEER_FADE`), reversed when backing up;
 *   - Jump is a short boost (`BOOST_SPEED` for `BOOST_SECONDS`, then
 *     `BOOST_COOLDOWN`);
 *   - it follows the ground: up a step of at most `STEP_UP` (eased at
 *     `CLIMB_RATE`), off an edge it falls, a wall (a rise over `STEP_UP` at
 *     the nose, or a block at head height) stops it, and in water it crawls
 *     at `WATER_SPEED`; the body pitches with the slope under its wheels.
 */
export const CAR = {
  MAX_SPEED: 19, REVERSE_SPEED: 5, ACCEL: 7, BRAKE: 14, COAST: 2.5,
  BOOST_SPEED: 26, BOOST_SECONDS: 1.5, BOOST_COOLDOWN: 3,
  STEER_RATE: 110, STEER_FULL_SPEED: 5, STEER_FADE: 12,
  STEP_UP: 1.05, CLIMB_RATE: 6, GRAVITY: 20, WATER_SPEED: 2,
  LEAN_PER_TURN: 0.04, LEAN_MAX: 4, SQUAT_PER_ACCEL: 0.35, SQUAT_MAX: 3,
  STICK_X_RIGHT: -1, DEADZONE: 0.15, STICK_FULL: 0.8,
} as const;
/** Every car constant as a number. */
export type CarParams = { readonly [K in keyof typeof CAR]: number };

/** One car's state: position, heading, speed along the heading (negative = reversing), vertical speed, the boost timers, and the attitude its animation shows. */
export interface CarState { x: number; y: number; z: number; yaw: number; speed: number; vy: number; onGround: boolean; boost: number; cooldown: number; pitch: number; bank: number }
/** The ground the car stands on: the top of the solid ground under its centre, nose and tail (null: none within reach), a wall at its nose / tail, and whether its wheels are in water. */
export interface CarTerrain { ground: number | null; groundFront: number | null; groundRear: number | null; blockedFront: boolean; blockedRear: boolean; inWater: boolean; wheelbase: number }
export type CarEvent = 'blocked' | 'boost' | 'landed';

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
    const rate = throttle === 0 ? P.COAST : braking ? P.BRAKE : P.ACCEL * (boost > 0 ? 2 : 1);
    speed = toward(speed, target, rate * dt);
    // Steering bites with speed (full lock by STEER_FULL_SPEED), fades at speed, and reverses backing up.
    const bite = clamp(Math.abs(speed) / P.STEER_FULL_SPEED, 0, 1) / (1 + Math.abs(speed) / P.STEER_FADE);
    turnRate = right * P.STEER_RATE * bite * (speed < 0 ? -1 : 1);
  }
  let yaw = s.yaw + turnRate * dt;
  yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
  if ((speed > 0 && terrain.blockedFront) || (speed < 0 && terrain.blockedRear)) { speed = 0; event = 'blocked'; }
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
  STEER_RATE: 70, STEER_FULL_SPEED: 2, STEER_FADE: 20,
  STEP_UP: 1.6, CLIMB_RATE: 3, GRAVITY: 6, WATER_SPEED: 12,
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
 *   - `SPACING`: the most two probe points on the perimeter are apart, blocks.
 *     Under one block, so a one-block trunk cannot slip between two probes.
 *   - `MAX_POINTS`: perimeter probes at most; a bigger vehicle spreads them
 *     (a 36-block barge's 100-block perimeter still gets 0.9 spacing).
 *   - `MAX_LEVELS`: heights tested between the footprint's `lo` and `hi`.
 *   - `SWEEP_STEP`: the most a probe point travels between two tested poses,
 *     blocks, so a 32 blocks/s aircraft (1.6 blocks a tick) cannot jump a trunk.
 *   - `MAX_SUBSTEPS`: poses tested per tick at most.
 */
export const FOOTPRINT = { SPACING: 0.9, MAX_POINTS: 128, MAX_LEVELS: 4, SWEEP_STEP: 0.8, MAX_SUBSTEPS: 4 } as const;
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
  // Perimeter probes as (along, side) offsets: corners first, then each edge at <= SPACING.
  const perimeter = 4 * (L + W);
  const spacing = Math.max(P.SPACING, perimeter / P.MAX_POINTS);
  const offsets: Array<[number, number]> = [];
  const edge = (a0: number, s0: number, a1: number, s1: number): void => {
    const n = Math.max(1, Math.ceil(Math.hypot(a1 - a0, s1 - s0) / spacing));
    for (let k = 0; k < n; k++) offsets.push([a0 + (a1 - a0) * k / n, s0 + (s1 - s0) * k / n]);
  };
  edge(L, -W, L, W); edge(L, W, -L, W); edge(-L, W, -L, -W); edge(-L, -W, L, -W);
  const span = Math.max(0, fp.hi - fp.lo);
  const levels: number[] = [];
  const nLevels = Math.min(P.MAX_LEVELS, Math.max(1, Math.ceil(span) + 1));
  for (let k = 0; k < nLevels; k++) levels.push(fp.lo + (nLevels === 1 ? 0 : span * k / (nLevels - 1)));
  const rad = (d: number): number => d * Math.PI / 180;
  const pointAt = (pose: FootprintPose, a: number, s: number, h: number): [number, number, number] => {
    const r = rad(pose.yaw), fx = -Math.sin(r), fz = Math.cos(r);
    // The vehicle's right (a right turn raises yaw): (-cos, -sin) in Bedrock's frame.
    const rx = -Math.cos(r), rz = -Math.sin(r);
    return [pose.x + fx * a + rx * s, pose.y + a * Math.tan(rad(Math.max(-60, Math.min(60, pose.pitch)))) + h, pose.z + fz * a + rz * s];
  };
  let dyaw = to.yaw - from.yaw;
  while (dyaw > 180) dyaw -= 360;
  while (dyaw < -180) dyaw += 360;
  const travel = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) + Math.abs(rad(dyaw)) * Math.hypot(L, W);
  const steps = Math.min(P.MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / P.SWEEP_STEP)));
  let checks = 0;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const pose: FootprintPose = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t, yaw: from.yaw + dyaw * t, pitch: from.pitch + (to.pitch - from.pitch) * t };
    for (const [a, s] of offsets) for (const h of levels) {
      const p = pointAt(pose, a, s, h);
      checks++;
      if (!solid(p[0], p[1], p[2])) continue;
      const q = pointAt(from, a, s, h);
      if (solid(q[0], q[1], q[2])) continue;
      return { blocked: true, checks, at: p };
    }
  }
  return { blocked: false, checks };
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
 * speed in blocks/s (the time machine raises it to its armed speed) and a
 * line appended to the HUD (the time circuit's state).
 */
export const VEHICLE_DYNAMIC = { topSpeed: 'craftmatic:top_speed', hud: 'craftmatic:vehicle_hud', headlight: 'craftmatic:headlight' } as const;

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
  headlights: HeadlightParams;
  props: typeof FLIGHT_PROPS;
  dynamic: typeof VEHICLE_DYNAMIC;
  /** The building shell's collider block: its `lo`/`hi` states are the solid span in sixteenths (bedrock-building-shell.ts). */
  colliders?: { block: string; loState: string; hiState: string } | undefined;
  inputEvent: string;
  telemetryEvent: string;
}

/**
 * Runs in the pack: one pure step per tick for every scripted vehicle
 * (`carStep` for a car, `carStep` on `HOVER` for a hover craft, `flightStep`
 * for an aircraft, `boatStep` for a boat), the swept footprint over the new
 * pose (`sweepFootprint`), then a teleport to it (the rider rides along, as on
 * the coaster: 20 Hz teleports are interpolated by the client) and the
 * attitude written to the actor properties its drive animation reads. Nobody
 * aboard: an aircraft flies its state out (it glides down and lands), a boat
 * drifts to a stop; parked, they stay put. The HUD shows speed and what to do
 * next; at night a light block runs ahead of the nose (`HEADLIGHTS`).
 *
 * Block probes read a SOLID SPAN per block: a collider block's `lo..hi`
 * sixteenths, a bottom slab's lower half, a top slab's upper half, a full
 * block otherwise; plants, torches, snow layers and light blocks are passed.
 */
export function scriptedVehicleRuntime(config: ScriptedVehicleConfig, flight: typeof flightStep, boat: typeof boatStep, car: typeof carStep, sweep: typeof sweepFootprint, night: typeof isNightTime, lightCell: typeof headlightCell): void {
  const F = config.flight, B = config.boat, C = config.car, H = config.hover, FP = config.footprint, HL = config.headlights, DYN = config.dynamic;
  const COL = config.colliders;
  const typeIds = Object.keys(config.types);
  const states = new Map<string, any>();
  const overrides = new Map<string, { x: number; y: number; jump: boolean; ticks: number }>();
  let telemetry = false;
  const MPH = 2.236936;
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
  const surfaceTop = (dim: any, x: number, y: number, z: number, depth: number): number | null => topBelow(dim, x, y, z, depth, true);
  /** A boat's water: the surface under it (the top of the highest water block within a block of its keel), the ground under it, land at the waterline ahead / astern. */
  const waterAt = (dim: any, st: any, reach: number, draft: number): any => {
    const rad = st.yaw * Math.PI / 180, fx = -Math.sin(rad), fz = Math.cos(rad);
    let surface: number | null = null;
    for (let by = Math.floor(st.y + 1); by >= Math.floor(st.y - 2); by--) { if (isWater(blockOf(dim, st.x, by, st.z))) { surface = by + 0.9; break; } }
    const line = surface ?? st.y + draft;
    const landAt = (d: number): boolean => { const px = st.x + fx * d, pz = st.z + fz * d; return solidAt(dim, px, line - 0.1, pz) || solidAt(dim, px, line + 0.4, pz); };
    return { surface, ground: surface === null ? solidTop(dim, st.x, st.y + 0.5, st.z, 48) : null, shoreAhead: landAt(reach + 0.3), shoreAstern: landAt(-(reach + 0.3)) };
  };
  const blockedAhead = (dim: any, x: number, y: number, z: number): boolean => solidAt(dim, x, y + 0.5, z) && solidAt(dim, x, y + 1.5, z);
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
  let tick = 0, busyMs = 0, busyTicks = 0;
  system.runInterval(() => {
    tick++;
    cells = new Map();
    const started = Date.now();
    let isNight = false;
    try { isNight = night(world.getTimeOfDay(), HL); } catch { /* no clock */ }
    for (const dim of dims()) for (const type of typeIds) {
      const kind = config.types[type]!;
      let list: any[] = [];
      try { list = dim.getEntities({ type }); } catch { continue; }
      for (const e of list) {
        let loc: any, rot: any;
        try { loc = e.location; rot = e.getRotation(); } catch { continue; }
        let st = states.get(e.id);
        if (!st || Math.hypot(loc.x - st.x, loc.z - st.z) > 3 || Math.abs(loc.y - st.y) > 3) {
          // First sight, or moved by something else (the wand, a /tp, a test, a time jump): start from where it stands.
          const light = st?.light;
          if (kind.mode === 'plane') {
            const g = surfaceTop(dim, loc.x, loc.y + 0.5, loc.z, 4);
            const onGround = g !== null && Math.abs(loc.y - g) < 1;
            st = { x: loc.x, y: onGround ? g : loc.y, z: loc.z, yaw: rot.y, pitch: 0, speed: 0, throttle: 0, onGround, stalled: false, bank: 0, wheel: 0 };
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
        const input = { x: 0, y: 0, jump: false, rider: !!driver };
        if (driver) {
          try { const v = driver.inputInfo?.getMovementVector?.(); input.x = v?.x ?? 0; input.y = v?.y ?? 0; } catch { /* no input */ }
          try { input.jump = !!(driver.isJumping || driver.inputInfo?.getButtonState?.('Jump') === 'Pressed'); } catch { /* no input */ }
        }
        const o = overrides.get(e.id);
        if (o) { input.x = o.x; input.y = o.y; input.jump = o.jump; input.rider = true; if (--o.ticks <= 0) overrides.delete(e.id); }
        const noseReach = kind.noseReach * k;
        // Headlights: a driver at night, moving or lately moved.
        st.parked = Math.abs(st.speed) > 0.2 || Math.abs(input.y) > 0.15 ? 0 : (st.parked || 0) + 1;
        if (isNight && input.rider && st.parked < HL.PARK_TICKS && kind.mode !== 'plane') {
          if (tick % HL.EVERY_TICKS === 0) placeLight(e, st, lightCell(st.x, st.y, st.z, st.yaw, noseReach, HL));
        } else if (st.light || (tick % 40 === 0 && !input.rider)) clearLight(e, st);
        const rad = st.yaw * Math.PI / 180, fx = -Math.sin(rad), fz = Math.cos(rad);
        const reach = noseReach + 0.5;
        let r: any, ground: number | null = null;
        let fp: { halfLength: number; halfWidth: number; lo: number; hi: number } | undefined;
        if (kind.mode === 'plane') {
          // Parked, nobody at the controls: nothing to integrate.
          if (!input.rider && st.onGround && st.speed < 0.05) { states.set(e.id, st); continue; }
          const ahead = { x: st.x + fx * reach, z: st.z + fz * reach };
          ground = surfaceTop(dim, st.x, st.y, st.z, st.onGround ? 3 : 48);
          r = flight(st, input, { ground, groundAhead: st.onGround ? surfaceTop(dim, ahead.x, st.y + 1.2, ahead.z, 3) : null, blocked: blockedAhead(dim, ahead.x, st.y, ahead.z) }, F, 0.05);
          r.state.wheel = st.wheel + (r.state.onGround ? r.state.speed * 0.05 * 57.2958 : 0);
          // On the ground the gear rolls over a step; aloft the whole airframe must clear.
          fp = { halfLength: noseReach, halfWidth: kind.halfWidth * k, lo: r.state.onGround ? F.STEP_UP + 0.05 : 0.1, hi: Math.max(0.2, kind.height * k - 0.1) };
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
          const below = (px: number, py: number, pz: number, depth: number): number | null => {
            const t = hover ? surfaceTop(dim, px, py, pz, depth) : solidTop(dim, px, py, pz, depth);
            return t === null ? null : t + lift;
          };
          const reachUp = st.y - lift + P.STEP_UP + 0.2;
          ground = below(st.x, reachUp, st.z, st.onGround ? 4 : 48);
          const groundFront = below(noseX, reachUp, noseZ, 4), groundRear = below(tailX, reachUp, tailZ, 4);
          const wall = (px: number, pz: number, g: number | null): boolean => (g !== null && g - st.y > P.STEP_UP) || solidAt(dim, px, st.y - lift + P.STEP_UP + 0.45, pz);
          r = car(st, input, {
            ground: ground !== null && ground - st.y > P.STEP_UP ? null : ground,
            groundFront, groundRear, blockedFront: wall(noseX, noseZ, groundFront), blockedRear: wall(tailX, tailZ, groundRear),
            inWater: !hover && isWater(blockOf(dim, st.x, st.y + 0.2, st.z)), wheelbase: 2 * reach,
          }, P, 0.05);
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
        // The swept footprint: a corner, a wingtip or the hull's side entering a block stops it there.
        let sweepChecks = 0;
        if (fp && (Math.hypot(ns.x - st.x, ns.z - st.z) > 1e-4 || Math.abs(ns.yaw - st.yaw) > 1e-3 || Math.abs(ns.y - st.y) > 1e-4)) {
          const solid = (x: number, y: number, z: number): boolean => solidAt(dim, x, y, z);
          const from = { x: st.x, y: st.y, z: st.z, yaw: st.yaw, pitch: st.pitch || 0 };
          const hit = sweep(from, { x: ns.x, y: ns.y, z: ns.z, yaw: ns.yaw, pitch: ns.pitch || 0 }, fp, solid, FP);
          sweepChecks = hit.checks;
          if (hit.blocked) {
            // Keep the turn if the turn alone is clear; otherwise hold the old heading too.
            const turnOnly = sweep(from, { x: st.x, y: ns.y, z: st.z, yaw: ns.yaw, pitch: ns.pitch || 0 }, fp, solid, FP);
            sweepChecks += turnOnly.checks;
            ns.x = st.x; ns.z = st.z;
            if (turnOnly.blocked) ns.yaw = st.yaw;
            if (ns.speed !== undefined) ns.speed = 0;
            r.event = kind.mode === 'plane' ? 'crash' : kind.mode === 'boat' ? 'beached' : 'blocked';
            r.hit = hit.at;
          }
        }
        states.set(e.id, ns);
        ns.light = st.light; ns.parked = st.parked; ns.scale = st.scale;
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
          const sound = r.event === 'blocked' ? 'random.anvil_land' : r.event === 'crash' || r.event === 'hard_landing' ? 'random.explode' : r.event === 'stall' ? 'note.bass' : r.event === 'beached' ? 'dig.sand' : r.event === 'boost' || r.event === 'launched' ? 'random.splash' : 'random.orb';
          // A held stick against a wall would repeat the thud every tick: once per contact.
          if (r.event !== st.lastEvent || tick - (st.lastEventTick || 0) > 20) {
            try { e.dimension.playSound(sound, { x: ns.x, y: ns.y, z: ns.z }, { volume: r.event === 'crash' ? 0.4 : 0.7 }); } catch { /* no sound */ }
            ns.lastEventTick = tick;
          } else ns.lastEventTick = st.lastEventTick;
          ns.lastEvent = r.event;
        } else { ns.lastEvent = undefined; ns.lastEventTick = st.lastEventTick; }
        if (telemetry && tick % 20 === 0) console.warn(`CMVT ${JSON.stringify({ type, id: e.id, t: tick, x: Math.round(ns.x * 100) / 100, y: Math.round(ns.y * 100) / 100, z: Math.round(ns.z * 100) / 100, yaw: Math.round(ns.yaw), speed: Math.round(ns.speed * 100) / 100, pitch: Math.round(ns.pitch), input, event: r.event ?? null, hit: r.hit ?? null, rider: !!driver, light: ns.light ?? null, night: isNight, sweepChecks, msPerTick: busyTicks ? Math.round(busyMs / busyTicks * 100) / 100 : 0 })}`);
        if (driver && tick % 4 === 0) {
          let hud: string;
          if (kind.mode === 'plane') {
            const alt = ground === null ? '--' : String(Math.max(0, Math.round(ns.y - ground)));
            const hint = ns.onGround
              ? (ns.speed >= F.ROTATE_SPEED ? '§a[PULL BACK: TAKE OFF]§r' : ns.throttle > 0.05 ? '§e[TAKE-OFF RUN: KEEP JUMP HELD]§r' : '§7[HOLD JUMP: THROTTLE · STICK: STEER]§r')
              : ns.stalled ? '§c[STALL: STICK FORWARD]§r' : '§7[STICK BACK: CLIMB · FORWARD: DIVE · JUMP: FULL POWER]§r';
            hud = `§lPLANE§r §e${(ns.speed * MPH).toFixed(0)} mph§r · §bALT ${alt}§r · THR ${Math.round(ns.throttle * 100)} · ${hint}`;
          } else if (kind.mode === 'car' || kind.mode === 'hover') {
            const hint = r.event === 'blocked' || (ns.speed === 0 && Math.abs(input.y) > 0.15) ? '§c[BLOCKED: BACK UP]§r' : ns.boost > 0 ? '§a[BOOST]§r' : ns.cooldown > 0 ? `§8[BOOST ${ns.cooldown.toFixed(1)}s]§r` : '§7[STICK: DRIVE + STEER · JUMP: BOOST]§r';
            hud = `§l${kind.mode === 'hover' ? 'HOVER' : 'CAR'}§r §e${(Math.abs(ns.speed) * MPH).toFixed(0)} mph${ns.speed < -0.1 ? ' §c[REV]' : ''}§r · ${hint}`;
          } else {
            const hint = !ns.afloat ? '§c[AGROUND: STICK BACK]§r' : r.event === 'beached' || ns.speed === 0 && input.y > 0.15 ? '§c[SHORE AHEAD]§r' : ns.boost > 0 ? '§a[BOOST]§r' : ns.cooldown > 0 ? `§8[BOOST ${ns.cooldown.toFixed(1)}s]§r` : '§7[STICK: THROTTLE + RUDDER · JUMP: BOOST]§r';
            hud = `§lBOAT§r §e${(Math.abs(ns.speed) * MPH).toFixed(0)} mph${ns.speed < -0.1 ? ' §c[ASTERN]' : ''}§r · ${hint}`;
          }
          if (ns.light) hud += ' · §e[LIGHTS]§r';
          try { const extra = e.getDynamicProperty(DYN.hud); if (typeof extra === 'string' && extra) hud += ` · ${extra}`; } catch { /* none */ }
          for (const rr of riders) { try { rr.onScreenDisplay?.setActionBar?.(hud); } catch { /* not a player */ } }
        }
      }
    }
    busyMs += Date.now() - started; busyTicks++;
    if (busyTicks >= 20) { busyMs = busyMs / busyTicks; busyTicks = 1; }
  }, 1);
}

/** `scripts/vehicles.js`: the runtime with the pure models' and helpers' own text. */
export function scriptedVehicleScript(config: ScriptedVehicleConfig): string {
  return `import { world, system } from "@minecraft/server";\n(${scriptedVehicleRuntime.toString()})(${JSON.stringify(config)}, ${flightStep.toString()}, ${boatStep.toString()}, ${carStep.toString()}, ${sweepFootprint.toString()}, ${isNightTime.toString()}, ${headlightCell.toString()});\n`;
}
