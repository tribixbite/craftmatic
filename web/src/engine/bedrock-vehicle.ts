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
}>> = {
  car: { rollPerYawRate: 0.045, rollMax: 4, pitchPerAccel: 0.35, pitchMax: 3, flightPath: false, noseDownPerSpeed: 0, steerPerYawRate: 0.35, steerMax: 28 },
  // A boat's lean, squat and swell come from the runtime (`boatStep`, the swell in `scriptedVehicleRuntime`) through the actor properties.
  boat: { rollPerYawRate: 0, rollMax: 0, pitchPerAccel: 0, pitchMax: 0, flightPath: false, noseDownPerSpeed: 0, steerPerYawRate: 0, steerMax: 0 },
  plane: { rollPerYawRate: -0.55, rollMax: 40, pitchPerAccel: 0, pitchMax: 30, flightPath: true, noseDownPerSpeed: 0, steerPerYawRate: 0.35, steerMax: 25 },
  rotor: { rollPerYawRate: -0.2, rollMax: 15, pitchPerAccel: 0, pitchMax: 14, flightPath: false, noseDownPerSpeed: 1.6, steerPerYawRate: 0, steerMax: 0 },
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
  if (motion === 'plane' || motion === 'boat') {
    // A fixed wing or a boat is moved by the scripted-vehicle runtime
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
  const dz = (v: number): number => (Math.abs(v) < P.DEADZONE ? 0 : v);
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
  STICK_X_RIGHT: -1, DEADZONE: 0.15,
} as const;
export type BoatParams = typeof BOAT;

/** One boat's state: position, heading, speed along the heading (negative = astern), the boost timers, and the attitude its animation shows. */
export interface BoatState { x: number; y: number; z: number; yaw: number; speed: number; vy: number; afloat: boolean; boost: number; cooldown: number; pitch: number; bank: number }
/** The water under and ahead of a boat: the water's surface under it (null: none), the top of the ground under it, and whether land stands at the waterline ahead or astern. */
export interface BoatWater { surface: number | null; ground: number | null; shoreAhead: boolean; shoreAstern: boolean }
export type BoatEvent = 'beached' | 'boost' | 'launched';

/** Advance one boat by `dt` seconds (pure; the device runs this text). */
export function boatStep(s: BoatState, input: FlightInput, water: BoatWater, P: BoatParams, dt: number): { state: BoatState; event?: BoatEvent } {
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const toward = (v: number, target: number, rate: number): number => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
  const dz = (v: number): number => (Math.abs(v) < P.DEADZONE ? 0 : v);
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

// ─── The scripted-vehicle runtime (aircraft and boats) ─────────────────────────

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
 */
export const FLIGHT_INPUT_EVENT = 'craftmatic:flight_input';
/** `/scriptevent craftmatic:vehicle_telemetry on|off`: one `CMVT {json}` content-log line per scripted or driven vehicle per second. */
export const VEHICLE_TELEMETRY_EVENT = 'craftmatic:vehicle_telemetry';

/** What the scripted-vehicle runtime is told about the pack. */
export interface ScriptedVehicleConfig {
  /** Every scripted vehicle type: how it moves and half its length (where its bow or nose is probed). */
  types: Record<string, { mode: 'plane' | 'boat'; noseReach: number }>;
  flight: FlightParams;
  boat: BoatParams;
  props: typeof FLIGHT_PROPS;
  inputEvent: string;
  telemetryEvent: string;
}

/**
 * Runs in the pack: one pure step per tick for every scripted vehicle
 * (`flightStep` for an aircraft, `boatStep` for a boat), then a teleport to
 * the new pose (the rider rides along, as on the coaster: 20 Hz teleports are
 * interpolated by the client) and the attitude written to the actor
 * properties its drive animation reads. Nobody aboard: an aircraft flies its
 * state out (it glides down and lands), a boat drifts to a stop; parked, they
 * stay put. The HUD shows speed and what to do next.
 */
export function scriptedVehicleRuntime(config: ScriptedVehicleConfig, flight: typeof flightStep, boat: typeof boatStep): void {
  const F = config.flight, B = config.boat;
  const typeIds = Object.keys(config.types);
  const states = new Map<string, any>();
  const overrides = new Map<string, { x: number; y: number; jump: boolean; ticks: number }>();
  let telemetry = false;
  const MPH = 2.236936;
  const dims = (): any[] => ['overworld', 'nether', 'the_end'].flatMap(id => { try { return [world.getDimension(id)]; } catch { return []; } });
  // Plants, torches, snow layers and light blocks are passed through; everything else solid is ground.
  const PASSABLE = /(^|:)(air|cave_air|void_air|light_block.*|short_grass|tall_grass|grass|fern|large_fern|.*_flower|dandelion|poppy|torch|.*_torch|snow_layer|vine|seagrass|kelp|kelp_plant|lily_pad)$/;
  const blockOf = (dim: any, x: number, y: number, z: number): any => { try { return dim.getBlock({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }); } catch { return undefined; } };
  const isWater = (b: any): boolean => !!b && (b.isLiquid === true || /water/.test(String(b.typeId)));
  const isSolid = (b: any): boolean => !!b && !b.isAir && !isWater(b) && !PASSABLE.test(String(b.typeId));
  /** Top of the first block below that stops an aircraft (solid or water), within `reach`. */
  const groundBelow = (dim: any, x: number, y: number, z: number, reach: number): number | null => {
    const top = Math.floor(y + 0.5);
    for (let by = top; by >= top - reach; by--) {
      const b = blockOf(dim, x, by, z);
      if (!b) return null;
      if (isSolid(b) || isWater(b)) return by + 1;
    }
    return null;
  };
  /** A boat's water: the surface under it (the top of the highest water block within a block of its keel), the ground under it, land at the waterline ahead / astern. */
  const waterAt = (dim: any, st: any, reach: number): any => {
    const rad = st.yaw * Math.PI / 180, fx = -Math.sin(rad), fz = Math.cos(rad);
    let surface: number | null = null;
    for (let by = Math.floor(st.y + 1); by >= Math.floor(st.y - 2); by--) { if (isWater(blockOf(dim, st.x, by, st.z))) { surface = by + 0.9; break; } }
    const line = surface ?? st.y + B.DRAFT;
    const landAt = (d: number): boolean => { const px = st.x + fx * d, pz = st.z + fz * d; return isSolid(blockOf(dim, px, line - 0.1, pz)) || isSolid(blockOf(dim, px, line + 0.4, pz)); };
    return { surface, ground: surface === null ? groundBelow(dim, st.x, st.y + 0.5, st.z, 48) : null, shoreAhead: landAt(reach + 0.3), shoreAstern: landAt(-(reach + 0.3)) };
  };
  const blockedAhead = (dim: any, x: number, y: number, z: number): boolean => isSolid(blockOf(dim, x, y + 0.5, z)) && isSolid(blockOf(dim, x, y + 1.5, z));
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
  let tick = 0;
  system.runInterval(() => {
    tick++;
    for (const dim of dims()) for (const type of typeIds) {
      const kind = config.types[type]!;
      let list: any[] = [];
      try { list = dim.getEntities({ type }); } catch { continue; }
      for (const e of list) {
        let loc: any, rot: any;
        try { loc = e.location; rot = e.getRotation(); } catch { continue; }
        let st = states.get(e.id);
        if (!st || Math.hypot(loc.x - st.x, loc.z - st.z) > 3 || Math.abs(loc.y - st.y) > 3) {
          // First sight, or moved by something else (the wand, a /tp, a test): start from where it stands.
          if (kind.mode === 'plane') {
            const g = groundBelow(dim, loc.x, loc.y + 0.5, loc.z, 4);
            const onGround = g !== null && Math.abs(loc.y - g) < 1;
            st = { x: loc.x, y: onGround ? g : loc.y, z: loc.z, yaw: rot.y, pitch: 0, speed: 0, throttle: 0, onGround, stalled: false, bank: 0, wheel: 0 };
          } else {
            st = { x: loc.x, y: loc.y, z: loc.z, yaw: rot.y, speed: 0, vy: 0, afloat: false, boost: 0, cooldown: 0, pitch: 0, bank: 0, wheel: 0 };
          }
        }
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
        const rad = st.yaw * Math.PI / 180, fx = -Math.sin(rad), fz = Math.cos(rad);
        const reach = kind.noseReach + 0.5;
        let r: any, ground: number | null = null;
        if (kind.mode === 'plane') {
          // Parked, nobody at the controls: nothing to integrate.
          if (!input.rider && st.onGround && st.speed < 0.05) { states.set(e.id, st); continue; }
          const ahead = { x: st.x + fx * reach, z: st.z + fz * reach };
          ground = groundBelow(dim, st.x, st.y, st.z, st.onGround ? 3 : 48);
          r = flight(st, input, { ground, groundAhead: st.onGround ? groundBelow(dim, ahead.x, st.y + 1.2, ahead.z, 3) : null, blocked: blockedAhead(dim, ahead.x, st.y, ahead.z) }, F, 0.05);
          r.state.wheel = st.wheel + (r.state.onGround ? r.state.speed * 0.05 * 57.2958 : 0);
        } else {
          const w = waterAt(dim, st, kind.noseReach);
          r = boat(st, input, w, B, 0.05);
          r.state.wheel = 0;
        }
        const ns = r.state;
        states.set(e.id, ns);
        // A boat rides a gentle swell (drawn only: the state keeps the calm line).
        const swell = kind.mode === 'boat' && ns.afloat ? { heave: Math.sin(tick * 0.16) * 0.04, roll: Math.sin(tick * 0.11) * 2, pitch: Math.sin(tick * 0.13) * 1.2 } : { heave: 0, roll: 0, pitch: 0 };
        try { e.teleport({ x: ns.x, y: ns.y + swell.heave, z: ns.z }, { rotation: { x: 0, y: ns.yaw }, keepVelocity: false }); } catch { /* unloaded */ }
        try { e.setProperty(config.props.pitch, Math.max(-90, Math.min(90, ns.pitch + swell.pitch))); } catch { /* not declared */ }
        try { e.setProperty(config.props.bank, Math.max(-90, Math.min(90, ns.bank + swell.roll))); } catch { /* not declared */ }
        try { e.setProperty(config.props.wheel, ns.wheel % 100000); } catch { /* not declared */ }
        if (r.event) {
          const sound = r.event === 'crash' || r.event === 'hard_landing' ? 'random.explode' : r.event === 'stall' ? 'note.bass' : r.event === 'beached' ? 'dig.sand' : r.event === 'boost' || r.event === 'launched' ? 'random.splash' : 'random.orb';
          try { e.dimension.playSound(sound, { x: ns.x, y: ns.y, z: ns.z }, { volume: r.event === 'crash' ? 0.4 : 0.7 }); } catch { /* no sound */ }
        }
        if (telemetry && tick % 20 === 0) console.warn(`CMVT ${JSON.stringify({ type, id: e.id, t: tick, x: Math.round(ns.x * 100) / 100, y: Math.round(ns.y * 100) / 100, z: Math.round(ns.z * 100) / 100, yaw: Math.round(ns.yaw), speed: Math.round(ns.speed * 100) / 100, pitch: Math.round(ns.pitch), input, event: r.event ?? null, rider: !!driver })}`);
        if (driver && tick % 4 === 0) {
          let hud: string;
          if (kind.mode === 'plane') {
            const alt = ground === null ? '--' : String(Math.max(0, Math.round(ns.y - ground)));
            const hint = ns.onGround
              ? (ns.speed >= F.ROTATE_SPEED ? '§a[PULL BACK: TAKE OFF]§r' : ns.throttle > 0.05 ? '§e[TAKE-OFF RUN: KEEP JUMP HELD]§r' : '§7[HOLD JUMP: THROTTLE · STICK: STEER]§r')
              : ns.stalled ? '§c[STALL: STICK FORWARD]§r' : '§7[STICK BACK: CLIMB · FORWARD: DIVE · JUMP: FULL POWER]§r';
            hud = `✈️ §e${(ns.speed * MPH).toFixed(0)} mph§r · §bALT ${alt}§r · THR ${Math.round(ns.throttle * 100)} · ${hint}`;
          } else {
            const hint = !ns.afloat ? '§c[AGROUND: STICK BACK]§r' : r.event === 'beached' || ns.speed === 0 && input.y > 0.15 ? '§c[SHORE AHEAD]§r' : ns.boost > 0 ? '§a[BOOST]§r' : ns.cooldown > 0 ? `§8[BOOST ${ns.cooldown.toFixed(1)}s]§r` : '§7[STICK: THROTTLE + RUDDER · JUMP: BOOST]§r';
            hud = `⛵ §e${(Math.abs(ns.speed) * MPH).toFixed(0)} mph${ns.speed < -0.1 ? ' §c[ASTERN]' : ''}§r · ${hint}`;
          }
          for (const rr of riders) { try { rr.onScreenDisplay?.setActionBar?.(hud); } catch { /* not a player */ } }
        }
      }
    }
  }, 1);
}

/** `scripts/vehicles.js`: the runtime with both pure models' own text. */
export function scriptedVehicleScript(config: ScriptedVehicleConfig): string {
  return `import { world, system } from "@minecraft/server";\n(${scriptedVehicleRuntime.toString()})(${JSON.stringify(config)}, ${flightStep.toString()}, ${boatStep.toString()});\n`;
}
