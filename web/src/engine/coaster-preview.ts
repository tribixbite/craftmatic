/**
 * Ride-car animation for the add-on WALK PREVIEW — the pure half; ui/addon-preview.ts
 * owns turning these frames into moving Three.js holders and the "board" camera.
 *
 * REUSES, does not reimplement, the pack's own model: `COASTER_PHYSICS` is the
 * exact constant object `bedrock-coaster.ts`'s `coasterRuntimeConfig` bakes
 * into every pack's `scripts/coaster.js` (gravity, rolling/drag loss, chain
 * lift grade/speed, station brake, dwell ticks, platform-lift speed/dwell —
 * see that module's header for the model), and `coasterTrackUps` is the exact
 * exported function the pack's own config-time compiler calls for the track's
 * physical up vector at every sample (LEGO track is never banked; a loop's up
 * follows its own normal). Only the STATE MACHINE below — a plain per-tick
 * stepper instead of Bedrock's entity/dynamic-property API — is new, because
 * `coasterRuntime` in bedrock-coaster.ts is serialized whole into the pack via
 * `Function.prototype.toString()` and is tightly coupled to live entities
 * (`getRiders`, `tryTeleport`, `setDynamicProperty`); pulling the pure numeric
 * core out of it is exactly the kind of refactor CLAUDE.md says to measure
 * before touching a device-verified system, so this module mirrors its
 * formulas instead (each block below cites the source line range it mirrors).
 *
 * SCOPE, stated rather than hidden:
 *  - One train (train 0) is animated in full: substep integration, station
 *    brake/dwell, a measured chain lift, and — for a route with a platform
 *    lift — a close visual analog of the elevator (the car pauses at the deck
 *    terminal and translates by the measured `lift.travel`, rather than the
 *    runtime's path-splicing hand-off that keeps the physics continuous
 *    through the deck). Good enough to show 10303's elevator rising and
 *    delivering the train; not a device-accuracy replica of the hand-off.
 *  - A route with a SECOND train (`cars.trains > 1`, e.g. 10303/10261) renders
 *    its cars STATIONARY in the loading bay (the station stop, offset back by
 *    one train length) rather than simulating the real dispatch/hold state
 *    machine. # TODO: simulate the second train's own dwell/hold and the
 *    `ahead`-fraction dispatch, matching `coasterRuntime`'s `trains` map.
 *  - Cars are riderless by default, matching "Cars must move riderless by
 *    default" — nothing here ever occupies a seat on its own.
 */
import { buildCoasterPath, sampleCoasterPath, type CoasterPath, type CoasterVec3 } from './coaster-path.js';
import { coasterTrackUps, COASTER_PHYSICS, type CoasterPhysics } from './bedrock-coaster.js';

/** The route fields this module needs — a structural subset of `AddonRoute`
 * (web/src/ui/addon-preview-data.ts); no import from ui/ on purpose (engine/
 * stays independent of the DOM/visual layer). */
export interface CoasterPreviewRouteInput {
  points: ReadonlyArray<readonly [number, number, number]>;
  cumulative: readonly number[];
  length: number;
  closed: boolean;
  station?: { start: number; end: number; stop: number };
  chain?: { start: number; end: number };
  lift?: { deckLength: number; travel: readonly [number, number, number]; parkedPoint: readonly [number, number, number] };
  cars: { count: number; spacing: number; extent: number };
}

/** Per-type data this module needs from `AddonPreviewModel.coasterTypes`. */
export interface CoasterPreviewCarType { wheelbase?: number; seat?: readonly [number, number, number] }

export interface CoasterPreviewCarFrame {
  /** 0-based slot within train 0 (matches `entity.coasterCarIndex % cars.count`). */
  slot: number;
  /** Model blocks at 100 %, the same frame `AddonRoute.points` uses. */
  position: CoasterVec3;
  /** Degrees, Bedrock yaw convention (0 faces +Z), matching `AddonEntity.yaw`. */
  yaw: number;
  pitch: number;
  roll: number;
  /** The physical up vector at this frame, model frame (for the "board" camera). */
  up: CoasterVec3;
  /** Whether the car is presently under power/gravity (false while dwelling or lifting). */
  moving: boolean;
}

export type CoasterLiftPhase = 'track' | 'lifting' | 'delivered';

export interface CoasterPreviewState {
  /** Arc distance of train 0's centre. */
  centre: number;
  direction: 1 | -1;
  /** World blocks/s (matches `coasterRuntime`'s `speed`, pre-scale). */
  speed: number;
  /** Ticks left before departure (matches `train.dwell`). */
  dwell: number;
  /**
   * Whether the station brake is watching for the target arc — mirrors
   * `coasterRuntime`'s `train.armed`. Disarmed the instant it departs and
   * re-armed once it has physically left the station's flat span; without
   * this a train that has JUST set `speed = DEPART_SPEED` but not yet moved
   * reads "already at the target" on the very next tick and re-arrives at
   * itself forever (bit this module once, fixed before it shipped).
   */
  armed: boolean;
  phase: CoasterLiftPhase;
  /** 0 (parked) to 1 (delivered). */
  liftProgress: number;
  liftDwell: number;
  /** Per-slot held yaw for the inverted-track hold (`coasterRuntime`'s `heldYaw`), degrees. */
  lastYaw: number[];
}

/** A fresh train parked at the station (or arc 0 for a route with none), dwelling as a newly-placed empty train does. */
export function initCoasterPreviewState(route: CoasterPreviewRouteInput, physics: CoasterPhysics = COASTER_PHYSICS): CoasterPreviewState {
  const stop = route.station?.stop ?? 0;
  return { centre: stop, direction: 1, speed: 0, dwell: physics.DWELL_EMPTY, armed: false, phase: 'track', liftProgress: 0, liftDwell: 0, lastYaw: new Array(Math.max(1, route.cars.count)).fill(0) };
}

const len3 = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);
const sub3 = (a: readonly number[], b: readonly number[]): CoasterVec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add3 = (a: readonly number[], b: readonly number[]): CoasterVec3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];

/** Build the `CoasterPath` this module integrates over, with a spacing guard
 * measured from the samples themselves (mirrors `coasterMaxSpacing`) so the
 * validator in `buildCoasterPath` can never reject the pack's own polyline. */
function toPath(route: CoasterPreviewRouteInput): { path: CoasterPath; maxSpacing: number } {
  let maxSpacing = 0;
  for (let i = 1; i < route.cumulative.length; i++) maxSpacing = Math.max(maxSpacing, route.cumulative[i]! - route.cumulative[i - 1]!);
  if (!(maxSpacing > 0)) throw new Error('Coaster preview route has no positive sample spacing.');
  const guard = maxSpacing * (1 + 1e-6) + 1e-9;
  return { path: buildCoasterPath(route.points as CoasterVec3[], route.closed, guard), maxSpacing };
}

/** Position at `arc` without a validated sampler's per-call checks — mirrors `coasterRuntime`'s `locate`. */
function locate(path: CoasterPath, arc: number): { position: CoasterVec3; tangent: CoasterVec3 } {
  const s = sampleCoasterPath(path, arc);
  return { position: s.position, tangent: s.tangent };
}

/** The direction a car points: the chord between its wheel contacts, or the local tangent with no measured wheelbase — mirrors `coasterRuntime`'s `chordAt`. */
function chordAt(path: CoasterPath, arc: number, wheelbase: number | undefined): CoasterVec3 {
  if (!wheelbase || !(wheelbase > 0)) return locate(path, arc).tangent;
  const front = locate(path, arc + wheelbase / 2).position, rear = locate(path, arc - wheelbase / 2).position;
  const chord = sub3(front, rear);
  const length = len3(chord);
  return length > 1e-6 ? [chord[0] / length, chord[1] / length, chord[2] / length] : locate(path, arc).tangent;
}

export interface StepCoasterPreviewResult { state: CoasterPreviewState; frames: CoasterPreviewCarFrame[] }

/**
 * Advance ONE Minecraft tick (1/20 s) of train 0. Mirrors `coasterRuntime`'s
 * per-train block (bedrock-coaster.ts, "integrate ride physics" through
 * "sample next track", roughly its lines 1760-1990) with the entity/property
 * I/O removed: no dynamic properties, no teleports, no rider retention — just
 * the next `CoasterPreviewState` and where every slot of train 0 sits.
 *
 * `scale` is the wand's export scale (`sizePct / 100`): the same divisor
 * `coasterRuntime` applies (`20 * scale`) to turn a world blocks/s speed into
 * a per-tick MODEL-block advance.
 */
export function stepCoasterPreviewTick(
  route: CoasterPreviewRouteInput, state: CoasterPreviewState, scale: number, physics: CoasterPhysics = COASTER_PHYSICS,
  /** The measured wheel-contact spacing (model blocks) of the car at a given
   * slot in train 0, when the set's own car measured one (`CoasterVehicleType.wheelbase`
   * in bedrock-coaster.ts, read back via `AddonPreviewModel.coasterTypes`). A
   * car pitches on the chord between its wheels rather than the local tangent
   * when this is given — see the module header on the fabricated cart, which
   * has none and simply uses the tangent. */
  wheelbaseOfSlot?: (slot: number) => number | undefined,
): StepCoasterPreviewResult {
  if (!(scale > 0)) throw new Error('Coaster preview scale must be positive.');
  const { path, maxSpacing } = toPath(route);
  const total = path.length;
  const count = Math.max(1, route.cars.count);
  const extent = route.cars.extent || 0;
  const station = route.station ?? { start: 0, end: 0, stop: 0 };
  const lift = route.lift;
  let { centre, direction, speed, dwell, armed, phase, liftProgress, liftDwell } = state;
  const lastYaw = [...state.lastYaw];
  const low = route.closed ? 0 : extent / 2, high = route.closed ? total : total - extent / 2;
  const target = route.closed ? station.stop : Math.max(low, Math.min(high, station.stop));

  let next = centre;
  let nextDirection = direction;
  let arrived: 'station' | 'deck' | null = null;
  let carLift = 0;

  if (lift && phase === 'lifting') {
    speed = 0;
    const travelLength = len3(lift.travel) || 1e-6;
    liftProgress = Math.min(1, liftProgress + physics.PLATFORM_SPEED / (20 * scale) / travelLength);
    carLift = liftProgress;
    if (liftProgress >= 1) { phase = 'delivered'; carLift = 1; liftDwell = physics.PLATFORM_DWELL; }
  } else if (lift && phase === 'delivered') {
    speed = 0;
    carLift = 1;
    if (liftDwell > 0) liftDwell--;
    else { phase = 'track'; speed = physics.DEPART_SPEED; armed = false; }
  } else {
    if (dwell > 0) {
      dwell--; speed = 0;
      if (dwell === 0) { speed = physics.DEPART_SPEED; armed = false; }
    } else {
      // Substep the integrator so the polyline's own resolution bounds the
      // per-tick step, never the speed — mirrors `coasterRuntime`'s substep loop.
      const bound = (speed + (physics.GRAVITY + physics.LIFT_ACCEL) / 20) / (20 * scale);
      const substeps = Math.max(1, Math.ceil(bound / maxSpacing));
      const dt = 1 / 20 / substeps;
      let advanced = 0;
      for (let sub = 0; sub < substeps; sub++) {
        const here = centre + advanced * direction;
        let sum = 0;
        for (let slot = 0; slot < count; slot++) sum += chordAt(path, carArc(here, slot, extent, route.cars.spacing, route.closed, total), wheelbaseOfSlot?.(slot))[1];
        const grade = (sum / count) * direction;
        speed = Math.max(0, speed + (-physics.GRAVITY * grade - physics.ROLLING - physics.DRAG * speed * speed) * dt);
        const chainHere = !route.chain || (here >= route.chain.start - extent / 2 && here <= route.chain.end + extent / 2);
        if (chainHere && grade > physics.LIFT_GRADE && speed < physics.LIFT_SPEED) speed = Math.min(physics.LIFT_SPEED, speed + physics.LIFT_ACCEL * dt);
        speed = Math.max(speed, physics.MIN_SPEED);
        advanced += (speed * dt) / scale;
      }
      // Gated on `armed`, exactly like `coasterRuntime`: a train that has just
      // set DEPART_SPEED but not yet moved is still numerically "at" the
      // target, and would re-arrive at itself forever without this.
      let toStop = -1, stopAt = target, stopKind: 'station' | 'deck' = 'station';
      let ahead = (target - centre) * direction;
      if (route.closed) { ahead = ((ahead % total) + total) % total; }
      if (armed && ahead >= 0) toStop = ahead;
      if (armed && lift && direction === -1) {
        const deckTarget = liftProgress <= 0 ? lift.deckLength / 2 : lift.deckLength + extent / 2;
        const deckAhead = centre - deckTarget;
        if (deckAhead >= 0 && (toStop < 0 || deckAhead < toStop)) { toStop = deckAhead; stopAt = deckTarget; stopKind = 'deck'; }
      }
      const integrated = speed;
      if (toStop >= 0) speed = Math.min(speed, Math.sqrt(2 * physics.STATION_BRAKE * toStop * scale));
      speed = Math.min(speed, physics.MAX_SPEED);
      const step = integrated > 0 ? advanced * speed / integrated : speed / (20 * scale);
      next = centre + step * direction;
      if (toStop >= 0 && step >= toStop) { next = stopAt; arrived = stopKind; }
      else if (route.closed) next = ((next % total) + total) % total;
      else if (next > high || next < low) {
        const hitLow = next < low;
        next = hitLow ? low : high;
        // The deck brake above (`stopKind === 'deck'`) is what normally stops a
        // lift route exactly AT the deck; this clamp is the defensive fallback
        // (extent 0, a very short deck) so the low end can never be overrun.
        // The HIGH end always bounces — see the module header: the preview
        // treats it as the course's natural turnaround, not a second mechanism.
        if (lift && hitLow) { speed = 0; arrived = 'deck'; }
        else { nextDirection = direction === 1 ? -1 : 1; speed = physics.DEPART_SPEED; }
      }
      if (arrived === 'station') { speed = 0; dwell = physics.DWELL_EMPTY; }
      else if (arrived === 'deck') { speed = 0; phase = 'lifting'; liftDwell = physics.PLATFORM_DWELL; }
      else if (!armed) {
        // Re-arm once the train has physically left the station's flat span —
        // mirrors `coasterRuntime`'s own re-arm check.
        const inside = station.start <= station.end ? next >= station.start && next <= station.end : next >= station.start || next <= station.end;
        if (!inside) armed = true;
      }
    }
  }

  const up = coasterTrackUps(path);
  const frames: CoasterPreviewCarFrame[] = [];
  for (let slot = 0; slot < count; slot++) {
    const arc = carArc(next, slot, extent, route.cars.spacing, route.closed, total);
    const at = sampleCoasterPath(path, arc);
    const lifted: CoasterVec3 = lift && carLift > 0 ? add3(at.position, [lift.travel[0] * carLift, lift.travel[1] * carLift, lift.travel[2] * carLift]) : at.position;
    const tangent = chordAt(path, arc, wheelbaseOfSlot?.(slot));
    const horizontal = Math.hypot(tangent[0], tangent[2]);
    const i = at.segmentIndex;
    const ratio = (at.distance - path.cumulative[i]!) / (path.cumulative[i + 1]! - path.cumulative[i]!);
    const up0 = up[i]!, up1 = up[i + 1]!;
    const sampledUp: CoasterVec3 = [up0[0] + (up1[0] - up0[0]) * ratio, up0[1] + (up1[1] - up0[1]) * ratio, up0[2] + (up1[2] - up0[2]) * ratio];
    const heldYaw = lastYaw[slot] ?? 0;
    const upright = sampledUp[1] >= 0 && horizontal > physics.YAW_HOLD_HORIZONTAL;
    const yaw = upright ? Math.atan2(-tangent[0], tangent[2]) * 180 / Math.PI : heldYaw;
    lastYaw[slot] = yaw;
    const yawRad = yaw * Math.PI / 180;
    const alongHeading = -tangent[0] * Math.sin(yawRad) + tangent[2] * Math.cos(yawRad);
    const pitch = -Math.atan2(tangent[1], alongHeading) * 180 / Math.PI;
    const pitchRad = pitch * Math.PI / 180;
    const localX = sampledUp[0] * Math.cos(yawRad) + sampledUp[2] * Math.sin(yawRad);
    const yawZ = -sampledUp[0] * Math.sin(yawRad) + sampledUp[2] * Math.cos(yawRad);
    const localY = sampledUp[1] * Math.cos(pitchRad) + yawZ * Math.sin(pitchRad);
    const roll = Math.atan2(-localX, localY) * 180 / Math.PI;
    frames.push({ slot, position: lifted, yaw, pitch, roll, up: sampledUp, moving: phase === 'track' && dwell === 0 });
  }
  return { state: { centre: next, direction: nextDirection, speed, dwell, armed, phase, liftProgress, liftDwell, lastYaw }, frames };
}

/** Arc distance of car `slot`'s datum, train centred at `centre` — mirrors `coasterRuntime`'s `carArc`. */
function carArc(centre: number, slot: number, extent: number, spacing: number, closed: boolean, total: number): number {
  const arc = centre + extent / 2 - slot * spacing;
  return closed ? ((arc % total) + total) % total : Math.max(0, Math.min(total, arc));
}

/**
 * Where a rider's eye belongs for the "board" camera: the car's datum plus the
 * measured seat offset carried through the car's real up/nose frame, plus the
 * seated eye height along that up. A simplified, camera-only analog of
 * `coasterRuntime`'s body-offset correction (bedrock-coaster.ts ~1960-1988):
 * it places the CAMERA correctly through an inversion but does not also draw
 * the car's bricks pinned back on the rails, since the preview has no second,
 * separately-offset body to draw. # TODO: draw the offset body too if the
 * preview ever needs to prove inversion seating rather than just ride motion.
 */
export function coasterCarEyePoint(frame: CoasterPreviewCarFrame, seat: readonly [number, number, number] | undefined, physics: CoasterPhysics = COASTER_PHYSICS): CoasterVec3 {
  if (!seat) return add3(frame.position, [frame.up[0] * physics.RIDER_EYE, frame.up[1] * physics.RIDER_EYE, frame.up[2] * physics.RIDER_EYE]);
  const yawRad = frame.yaw * Math.PI / 180;
  const nose: CoasterVec3 = [-Math.sin(yawRad), 0, Math.cos(yawRad)];
  const cu = frame.up;
  const right: CoasterVec3 = [nose[1] * cu[2] - nose[2] * cu[1], nose[2] * cu[0] - nose[0] * cu[2], nose[0] * cu[1] - nose[1] * cu[0]];
  const out: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) out[axis] = frame.position[axis]! + seat[0] * right[axis]! + seat[1] * cu[axis]! - seat[2] * nose[axis]! + physics.RIDER_EYE * cu[axis]!;
  return out;
}
