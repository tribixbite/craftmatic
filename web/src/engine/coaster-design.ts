/**
 * Coaster design -> generated track (WP-C01, BIZ-13).
 *
 * Pure math, no Minecraft API. `generateCoaster(design)` turns a list of
 * elements (station, lift, drop, loop, ...) into a CLOSED route of rail
 * samples at most 0.4 blocks apart (the 25 LDU rule of `coaster-track.ts`),
 * with an explicit `up` per sample, zones by arc distance and a report.
 *
 * HOW IT WORKS
 *  - The track is integrated as a moving frame. The state tracks the HEARTLINE
 *    point `h` (where the rider's heart is), a path frame (tangent `t`, path-up
 *    `nv`) and a bank angle `beta` about the tangent. The rail sample written
 *    out is `h - heartlineB * up`, so a roll about the heartline orbits the
 *    rail around a straight heart path (zero-g roll, corkscrew).
 *  - Curvature is LOAD-CONTROLLED where physics dictates it: the running speed
 *    is integrated while the track is generated (energy model below), and a
 *    loop, a drop's pull-out, an airtime crest or a zero-g crest takes the
 *    curvature that gives its target g at that speed (`kappa = G (g - up.y) /
 *    v^2`). A loop's radius is therefore a TARGET HEIGHT (2 r) solved by
 *    bisection on the load, which makes it a teardrop, as real loops are: a
 *    circle needs 6 g at the bottom to clear the top. Banked turns take the
 *    balanced bank `atan(v^2 kappa / G)`.
 *  - Fixed-shape pieces use clothoid transitions: a trapezoidal curvature
 *    profile (linear ramps in, constant, linear ramps out), integrated as
 *    EXACT angle increments so every element closes its own angles to
 *    rounding error.
 *  - Every element starts and ends level and upright, so the circuit is closed
 *    by a generated return connector (arc, graded straight, arc) whose three
 *    parameters are solved by Newton iteration on the position residual.
 *
 * ENERGY MODEL (design-time estimate; the runtime integrates its own):
 *  d(v^2) = -2 G dy - 2 (DRAG v^2 + ROLLING) ds with `COASTER_PHYSICS`'s
 *  constants, a speed floor `MIN_SPEED`, the design's `maxSpeedBps` ceiling,
 *  lifts holding their speed, launches ramping to their target, brakes
 *  shedding at a fixed deceleration.
 *
 * COORDINATES: model-local blocks, station rail start at the origin heading +x,
 * +y up. Positive yaw turns T toward `up x T` (a rider's LEFT in a right-handed
 * frame). # TODO(C02): confirm handedness against Bedrock's Z mirror when the
 * route is wired into `coasterRuntimeConfig`.
 */
import { COASTER_PHYSICS } from './bedrock-coaster';
import type { CoasterRouteInput, CoasterVec3 } from './coaster-path';

// ---------------------------------------------------------------------------
// Public types (plan A section 2.3; optional fields are compatible extensions)
// ---------------------------------------------------------------------------

export type CoasterElement =
  | { kind: 'station'; lengthB: number }
  | { kind: 'cable-lift' | 'chain-lift'; riseB: number; angleDeg: number; speedBps: number }
  | { kind: 'launch'; lengthB: number; toSpeedBps: number }
  | { kind: 'drop'; fallB: number; angleDeg: number; twistDeg?: number }
  | { kind: 'airtime-hill'; riseB: number; lengthB: number }
  | { kind: 'loop'; radiusB: number } | { kind: 'zero-g-roll'; lengthB: number }
  | { kind: 'corkscrew'; lengthB: number; hand: 'L' | 'R' } | { kind: 'cobra-roll'; radiusB: number }
  | { kind: 'top-hat'; heightB: number } | { kind: 'helix'; radiusB: number; turns: number; dropB: number; bankDeg?: number }
  | { kind: 'turn'; radiusB: number; angleDeg: number; bankDeg?: number; driveBps?: number }
  | { kind: 'straight'; lengthB: number; slopeDeg?: number; driveBps?: number }
  | { kind: 'block-brake' | 'trim-brake'; lengthB: number; toSpeedBps?: number };

export interface CoasterZone {
  kind: 'station' | 'lift' | 'launch' | 'block-brake' | 'trim' | 'dark' | 'show' | 'tunnel' | 'cloud';
  from: number; to: number;   // arc distance, blocks
  params?: Record<string, number | string>;
}

export type ShowCue =
  | { kind: 'darkness'; seconds: number } | { kind: 'fade'; colour: [number, number, number]; inS: number; holdS: number; outS: number }
  | { kind: 'light'; group: string; on: boolean } | { kind: 'sound'; id: string } | { kind: 'particles'; id: string };

/** A zone laid over a span of elements (inclusive indices), for the show layers that are not track elements. */
export interface CoasterOverlay {
  kind: 'dark' | 'show' | 'tunnel' | 'cloud';
  fromElement: number; toElement: number;
  params?: Record<string, number | string>;
}

export interface CoasterDesign {
  name: string; elements: CoasterElement[];
  /** Heartline offset above the rail, blocks; rolls are about the heartline. */
  heartlineB: number; trains: number; carsPerTrain: number;
  limits: { maxSpeedBps: number; gVertical: [min: number, max: number]; gLateral: number; maxJerk: number };
  shows: Array<{ zone: string; at: number; cue: ShowCue }>;
  /** Extension: dark / show / tunnel / cloud zones over element spans. */
  overlays?: CoasterOverlay[];
  /** Extension: turn radius of the generated return connector, blocks (default `COASTER_DESIGN.RETURN_RADIUS_B`). */
  returnRadiusB?: number;
}

/** Per-element results (extension of the plan's `GeneratedCoaster`). */
export interface CoasterSpan {
  index: number; kind: CoasterElement['kind'] | 'return';
  from: number; to: number;           // rail arc distance, blocks
  minG: number; maxG: number;         // vertical load along the seat's up
  maxLateralG: number; maxSpeedBps: number; endSpeedBps: number;
  inversions: number; heightGainB: number;
}

/** Per-sample series the validator reads (extension). All arrays are parallel to `route.points`. */
export interface CoasterAnalysis {
  /** Rail arc distance at each sample. */
  arc: number[];
  /** Heartline speed, blocks/s. */
  speed: number[];
  gVertical: number[]; gLateral: number[];
  /** Jerk of the (vertical, lateral) load vector, g/s, over `JERK_WINDOW_S`. */
  jerk: number[];
  /** Seat up.y per sample (inversion test). */
  upY: number[];
  /** True where the speed floor held the train up (a stall). */
  floorHit: boolean[];
  /** Tangent.y per sample. */
  tangentY: number[];
  /** Brakes that left their zone faster than their target: element index and the excess, blocks/s. */
  brakeShortfall: Array<{ index: number; excessBps: number }>;
  /** Speed on arriving back at the station, blocks/s. */
  arrivalSpeedBps: number;
  /** Closure residuals: position (blocks), tangent (unit-vector distance), up (unit-vector distance). */
  closure: { position: number; tangent: number; up: number };
  limits: CoasterDesign['limits'];
  heartlineB: number;
  shows: CoasterDesign['shows'];
}

export interface GeneratedCoaster {
  route: CoasterRouteInput;   // coaster-path.ts:14
  ups: CoasterVec3[];         // explicit banking, one per point (no inference from rails)
  zones: CoasterZone[];
  report: { lengthB: number; heightB: number; footprintB: [number, number]; inversions: number;
            maxG: number; minG: number; maxLateralG: number; maxSpeedBps: number; lapS: number };
  spans: CoasterSpan[];
  analysis: CoasterAnalysis;
}

export interface CoasterIssue {
  code: 'closure' | 'spacing' | 'g-vertical' | 'g-lateral' | 'jerk' | 'world-height' | 'speed' | 'stall'
    | 'brake' | 'arrival' | 'clearance' | 'show' | 'frame-rate';
  message: string;
  /** Arc distance of the worst sample, when it has one. */
  at?: number;
}

/** Thrown by `generateCoaster` when a design cannot be built or fails `validateCoaster`. */
export class CoasterDesignError extends Error {
  constructor(message: string, readonly issues: readonly CoasterIssue[] = []) {
    super(message);
    this.name = 'CoasterDesignError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every tuned number of the generator. Gravity, drag, rolling and the brake/lift rates come from `COASTER_PHYSICS`. */
export const COASTER_DESIGN = {
  /** The route contract: neighbouring samples at most this far apart, blocks (25 LDU at 53.33 LDU/block is 0.47; the plan's rule is 0.4). */
  MAX_SAMPLE_SPACING_B: 0.4,
  /** Integration aims for this rail chord, blocks: under the contract so rounding never breaks it. */
  STEP_TARGET_B: 0.34,
  /** Clothoid ramp: the fraction of a fixed-shape piece spent ramping curvature in (and again out). */
  RAMP_FRACTION: 0.3,
  /** Radius of a lift's or a graded straight's pitch transitions, blocks. */
  LIFT_BLEND_RADIUS_B: 14,
  /** Radius of a drop's entry crest, blocks (slow there: gentle). */
  DROP_ENTRY_RADIUS_B: 12,
  /** Radius that takes a past-vertical lip back to vertical, blocks. */
  DROP_LIP_RADIUS_B: 20,
  /** Vertical load of a drop's pull-out, g. */
  DROP_PULLOUT_G: 3.4,
  /** Vertical load entering a downgrade (a crest: light) and leaving one or climbing one (a dip: heavy), g: helices and graded straights. */
  SLOPE_ENTRY_G: 0.4, SLOPE_EXIT_G: 1.8,
  /** Vertical load on the ramps of a zero-g roll, g. */
  HILL_RAMP_G: 1.6,
  /** Vertical load at a zero-g roll's crest, g. */
  ZERO_G_CREST_G: 0,
  /** Vertical load at an airtime hill's crest, g (negative: out of the seat), kept inside the design's minimum plus `G_MARGIN`. */
  HILL_CREST_G: -0.5,
  /** Search range of a loop's constant load, g (the upper end is the design's maximum minus `G_MARGIN`). */
  LOOP_G_MIN: 1.1,
  /** Margin kept inside the design's g limits when a load is chosen, g. */
  G_MARGIN: 0.15,
  /** A loop's (and a cobra half loop's) helical offset: how far its exit lies beside its entry, blocks. */
  LOOP_SHIFT_B: 2.6,
  /** Length of a cobra's half-roll straight, blocks. */
  COBRA_ROLL_LENGTH_B: 10,
  /** Corkscrew centripetal load target, g, the lateral load its unbanked lead-in/out turns may carry, g, and the cone half-angle range, degrees. */
  CORKSCREW_G: 1.8, CORKSCREW_LEAD_G: 0.9, CORKSCREW_TILT_MIN_DEG: 8, CORKSCREW_TILT_MAX_DEG: 38,
  /** Top hat's pitch transitions load, g, and crest load, g. */
  TOP_HAT_ARC_G: 2.2, TOP_HAT_CREST_G: -0.4,
  /** Largest curvature a load-controlled piece may take, rad/block (a guard against slow-speed blow-ups). */
  KAPPA_MAX: 1.2,
  /** Block-brake deceleration, blocks/s^2: twice the station brake. */
  BLOCK_BRAKE_DECEL: 2 * COASTER_PHYSICS.STATION_BRAKE,
  /** Default exit speeds of brakes, blocks/s. */
  BLOCK_BRAKE_TO_BPS: 3.5, TRIM_BRAKE_TO_BPS: 12,
  /** The return connector is a powered transfer at this speed, blocks/s, with a trim over its last `RETURN_TRIM_LENGTH_B` blocks down to the platform speed. */
  RETURN_DRIVE_BPS: 10, RETURN_TRIM_LENGTH_B: 12,
  /** Radius and pitch-arc length of the generated return connector, blocks. */
  RETURN_RADIUS_B: 24, RETURN_PITCH_ARC_B: 8, RETURN_MAX_PITCH_RAD: 0.6,
  /** A rider is inverted below this up.y; a stretch of at least `MIN_INVERSION_SAMPLES` samples is one inversion. */
  INVERTED_UP_Y: -0.5, MIN_INVERSION_SAMPLES: 3,
  /** Rail samples closer than this, blocks, between parts of the track further apart than `CLEARANCE_SKIP_ARC_B` along it, are a collision. */
  CLEARANCE_B: 1.2, CLEARANCE_SKIP_ARC_B: 14,
  /** World limits for the model's y=0 on the ground: Bedrock's ground, build limit and bedrock floor. */
  WORLD_GROUND_Y: 64, WORLD_MAX_Y: 319, WORLD_MIN_Y: -64,
  /** Closure tolerances: position, blocks; tangent and up, unit-vector distance. */
  CLOSURE_POSITION_B: 1e-6, CLOSURE_DIRECTION: 5e-3,
  /** Jerk is the change of the load vector over at least this many seconds. */
  JERK_WINDOW_S: 0.2,
  /**
   * Most the car's frame (tangent AND up) may rotate per 50 ms tick at the design speed, degrees. The rider's camera
   * cannot turn the drawn view more than `COASTER_RIDER_VIEW.maxTurn` (40) in one frame, and the runtime rides some
   * stretches faster than the design's own estimate (1.4x measured on the 3x sketch's first roll), so 28 keeps 1.4x
   * the design speed under the cap. Measured by C04 (2026-11-12): the sketch's zero-g rolls turned the frame 43 and
   * 91 degrees per tick and the sim's camera drew 41-106 degrees in one frame there (`camera-continuous`).
   */
  MAX_FRAME_RATE_DEG_PER_TICK: 28,
  /** Arriving faster than this multiple of the station's depart speed at the platform is refused. */
  ARRIVAL_SPEED_FACTOR: 1.3,
} as const;

const G = COASTER_PHYSICS.GRAVITY;
const D2R = Math.PI / 180;
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// Small vector helpers (mutable triples, local to this module)
// ---------------------------------------------------------------------------

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = norm(a); return l > 1e-15 ? mul(a, 1 / l) : [0, 0, 0]; };
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** Rodrigues: `v` rotated by the rotation vector `w` (axis w/|w|, angle |w|). */
function rotate(v: V3, w: V3): V3 {
  const a = norm(w);
  if (a < 1e-15) return v;
  const k = mul(w, 1 / a), c = Math.cos(a), s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

// ---------------------------------------------------------------------------
// Profiles: an exact angle function a(s) over a length, and its derivative
// ---------------------------------------------------------------------------

/** An angle (rad) as a function of arc length (blocks) over `[0, len]`. */
interface Profile { a(s: number): number }

/** Trapezoidal-curvature (clothoid in, constant, clothoid out) profile turning `total` radians over `len`. */
function shaped(total: number, len: number, f: number = COASTER_DESIGN.RAMP_FRACTION): Profile {
  const ramp = f * len, peak = total / (len - ramp);
  return {
    a(s: number): number {
      const x = clamp(s, 0, len);
      if (x < ramp) return peak * x * x / (2 * ramp);
      if (x <= len - ramp) return peak * ramp / 2 + peak * (x - ramp);
      return total - peak * (len - x) * (len - x) / (2 * ramp);
    },
  };
}
/** A smooth 0 -> `total` rise (smoothstep) over `len`. */
const smooth = (total: number, len: number): Profile => ({ a: s => { const x = clamp(s / len, 0, 1); return total * x * x * (3 - 2 * x); } });
/** A bank bump 0 -> `peak` -> 0 over `len`: smooth ramps over the outer thirds, held between. */
const bump = (peak: number, len: number): Profile => ({
  a: s => {
    const x = clamp(s / len, 0, 1), r = (u: number): number => u * u * (3 - 2 * u);
    return peak * (x < 1 / 3 ? r(3 * x) : x > 2 / 3 ? r(3 * (1 - x)) : 1);
  },
});

// ---------------------------------------------------------------------------
// State, segments, runner
// ---------------------------------------------------------------------------

type ZoneKind = 'station' | 'lift' | 'launch' | 'block-brake' | 'trim' | 'free';
interface ZoneSpec {
  kind: ZoneKind;
  /** lift: held speed; launch/brake/trim: target speed, blocks/s. */
  speed?: number;
  /** brake deceleration, blocks/s^2. */
  decel?: number;
}
const FREE: ZoneSpec = { kind: 'free' };

interface State {
  h: V3;          // heartline position
  t: V3;          // tangent
  nv: V3;         // path-up (perpendicular to t)
  beta: number;   // bank about t, toward the rider's left, rad
  v2: number;     // heart speed squared, blocks^2/s^2
  sh: number;     // heart arc length so far
}
const cloneState = (s: State): State => ({ ...s });
/** Path-left axis. */
const pathLeft = (s: State): V3 => cross(s.nv, s.t);
/** The seat's up vector: path-up banked toward the left by beta. */
function upOf(s: State): V3 {
  const l = pathLeft(s), c = Math.cos(s.beta), n = Math.sin(s.beta);
  return [s.nv[0] * c + l[0] * n, s.nv[1] * c + l[1] * n, s.nv[2] * c + l[2] * n];
}

/** One planned integration step: arc `ds` with the angle increments to apply. */
interface Step {
  ds: number;
  dPitch: number;       // about t x nv
  dYaw: number;         // about yawAxis
  dAxis: number;        // about a fixed world axis (corkscrew)
  dShift: number;       // lateral translation along the pitch axis (a helical loop's offset), blocks
  dRoll: number;        // rotation of the PATH frame about t (not a bank): after it the next pitch piece turns the other way up
  beta: number;         // absolute bank after the step
  end: boolean;
}
interface Seg {
  zone: ZoneSpec;
  yawAxis: 'nv' | 'world';
  axis?: () => V3;
  /** Pure: plan a step of at most `maxDs` from `st`. */
  plan(st: State, maxDs: number): Step;
  /** Accept a planned step (advance the piece's own progress). */
  commit(step: Step): void;
}

const MAX_STEPS_PER_SEG = 200000;

/** A fixed-length piece driven by exact angle profiles. `balanced` banks to `atan(v^2 kappa / G)` against the yaw rate. */
function fixedSeg(o: {
  len: number; zone?: ZoneSpec; pitch?: Profile; yaw?: Profile; beta?: Profile; yawAxis?: 'nv' | 'world';
  balanced?: boolean; axisProf?: Profile; axisDir?: () => V3; yawCos?: number; frameRoll?: Profile;
}): Seg {
  let s = 0;
  return {
    zone: o.zone ?? FREE,
    yawAxis: o.yawAxis ?? 'nv',
    axis: o.axisDir,
    plan(st, maxDs): Step {
      const ds = Math.min(maxDs, o.len - s), s1 = s + ds;
      const dYaw = o.yaw ? o.yaw.a(s1) - o.yaw.a(s) : 0;
      let beta = st.beta;
      if (o.beta) beta = o.beta.a(s1);
      else if (o.balanced && ds > 0) beta = s1 >= o.len - 1e-12 ? 0 : Math.sign(dYaw) * Math.atan(st.v2 * Math.abs(dYaw / ds) * (o.yawCos ?? 1) / G);
      return {
        ds, dPitch: o.pitch ? o.pitch.a(s1) - o.pitch.a(s) : 0, dYaw,
        dAxis: o.axisProf ? o.axisProf.a(s1) - o.axisProf.a(s) : 0, dShift: 0, dRoll: o.frameRoll ? o.frameRoll.a(s1) - o.frameRoll.a(s) : 0, beta, end: s1 >= o.len - 1e-12,
      };
    },
    commit(step) { s += step.ds; },
  };
}
const straightSeg = (len: number, zone?: ZoneSpec): Seg => fixedSeg({ len, zone });

/**
 * A pitch piece that turns by `angle` (signed) at the curvature giving the target vertical load `g(p)` at the
 * running speed, p = progress 0..1. `shift` translates the heart sideways (along the pitch axis) by an exact profile of p
 * (the helical offset of a loop's exit; a TRANSLATION, because a sideways tilt does not commute with the pitch and
 * would leave the track pitched after the element); `roll` sets the bank over p.
 */
function loadSeg(o: { angle: number; g: (p: number) => number; zone?: ZoneSpec; shift?: Profile; roll?: Profile }): Seg {
  let acc = 0;
  const sign = Math.sign(o.angle);
  return {
    zone: o.zone ?? FREE,
    yawAxis: 'nv',
    plan(st, maxDs): Step {
      const p = acc / o.angle;
      // The load is measured along the PATH-up axis (the seat's up with the bank taken out), so a roll about the
      // heartline (zero-g roll) leaves the heart on its ballistic arc instead of chasing the rolling seat.
      let kappa = G * (o.g(p) - st.nv[1]) / Math.max(st.v2, COASTER_PHYSICS.MIN_SPEED ** 2);
      // The curvature must carry the angle the right way; a load that cannot (wrong sign) still creeps forward.
      if (kappa * sign <= 1e-4) kappa = sign * 1e-4;
      kappa = clamp(kappa, -COASTER_DESIGN.KAPPA_MAX, COASTER_DESIGN.KAPPA_MAX);
      let ds = maxDs, dPitch = kappa * ds, end = false;
      const remaining = o.angle - acc;
      if (Math.abs(dPitch) >= Math.abs(remaining)) { dPitch = remaining; ds = remaining / kappa; end = true; }
      const p1 = (acc + dPitch) / o.angle;
      return {
        ds, dPitch, dYaw: 0, dAxis: 0, dRoll: 0, dShift: o.shift ? o.shift.a(p1) - o.shift.a(p) : 0,
        beta: o.roll ? o.roll.a(p1) : st.beta, end,
      };
    },
    commit(step) { acc += step.dPitch; },
  };
}

/** Per-sample record sink. */
interface Recorder {
  rail: V3[]; up: V3[]; tan: V3[]; heart: V3[];
  sh: number[]; speed2: number[]; gv: number[]; gl: number[]; floor: boolean[]; element: number[];
}
const newRecorder = (): Recorder => ({ rail: [], up: [], tan: [], heart: [], sh: [], speed2: [], gv: [], gl: [], floor: [], element: [] });

interface RunOptions {
  heartline: number; limits: CoasterDesign['limits']; rec?: Recorder; element?: number;
  /** Rail chord target, blocks (default `STEP_TARGET_B`); the closure solver's coarse passes use a larger one. */
  stepB?: number;
}
interface RunStats { maxY: number; minY: number; length: number; end: State }

/** Apply the energy model for one step and the zone's speed rule. */
function advanceSpeed(st: State, ds: number, dy: number, zone: ZoneSpec, zoneStartV2: number, zoneLen: number, zoneS: number, limits: CoasterDesign['limits']): boolean {
  const P = COASTER_PHYSICS;
  const floor2 = P.MIN_SPEED ** 2, ceil2 = limits.maxSpeedBps ** 2;
  let v2 = (st.v2 - 2 * G * dy - 2 * P.ROLLING * ds) / (1 + 2 * P.DRAG * ds);
  switch (zone.kind) {
    case 'station': v2 = P.DEPART_SPEED ** 2; break;
    case 'lift': v2 = zone.speed! ** 2; break;
    case 'launch': v2 = zoneStartV2 + (zone.speed! ** 2 - zoneStartV2) * clamp(zoneS / zoneLen, 0, 1); break;
    case 'block-brake': case 'trim': {
      const target2 = zone.speed! ** 2;
      if (v2 > target2) v2 = Math.max(target2, v2 - 2 * zone.decel! * ds);
      break;
    }
    default: break;
  }
  const hitFloor = v2 <= floor2;
  st.v2 = clamp(v2, floor2, ceil2);
  return hitFloor;
}

/** Integrate `segs` from `start`, optionally recording. Returns the end state and extremes of the heartline. */
function runSegs(start: State, segs: Seg[], opt: RunOptions): RunStats {
  const st = cloneState(start);
  let maxY = st.h[1], minY = st.h[1], length = 0;
  const C = COASTER_DESIGN;
  for (const seg of segs) {
    const zoneStartV2 = st.v2;
    let zoneS = 0;
    const zoneLen = seg.zone.kind === 'launch' ? probeLength(seg) : 0;
    for (let guard = 0; guard < MAX_STEPS_PER_SEG; guard++) {
      const target = opt.stepB ?? C.STEP_TARGET_B;
      let maxDs = target;
      let step = seg.plan(st, maxDs);
      if (step.ds < 1e-12) { seg.commit(step); if (step.end) break; continue; }
      let next = applyStep(st, step, seg);
      // Shrink until the RAIL chord meets the target (a roll or a tight turn moves the rail faster than the heart).
      for (let k = 0; k < 40; k++) {
        const chord = norm(sub(add(next.h, mul(upOf(next), -opt.heartline)), add(st.h, mul(upOf(st), -opt.heartline))));
        if (chord <= target + 1e-12 || step.ds < 1e-9) break;
        maxDs = Math.min(maxDs, step.ds) * (target / chord) * 0.98;
        step = seg.plan(st, maxDs);
        next = applyStep(st, step, seg);
      }
      let floorHit = false;
      if (opt.rec) recordSample(opt.rec, st, step, next, opt);
      const dy = next.h[1] - st.h[1];
      next.v2 = st.v2; next.sh = st.sh + step.ds;
      floorHit = advanceSpeed(next, step.ds, dy, seg.zone, zoneStartV2, zoneLen, zoneS + step.ds, opt.limits);
      if (opt.rec) opt.rec.floor.push(floorHit);
      Object.assign(st, next);
      zoneS += step.ds; length += step.ds;
      maxY = Math.max(maxY, st.h[1]); minY = Math.min(minY, st.h[1]);
      seg.commit(step);
      if (step.end) break;
      if (guard === MAX_STEPS_PER_SEG - 1) throw new CoasterDesignError('a track piece never finished (a load target cannot turn the track)');
    }
  }
  st.beta = ((st.beta % TWO_PI) + TWO_PI) % TWO_PI; if (st.beta > Math.PI) st.beta -= TWO_PI;
  return { maxY, minY, length, end: st };
}

/** A `launch` needs its own length for the speed ramp: probe it once with a throwaway run. */
function probeLength(seg: Seg): number {
  // fixedSeg exposes its length through a plan of an unbounded step
  const probe = seg.plan({ h: [0, 0, 0], t: [1, 0, 0], nv: [0, 1, 0], beta: 0, v2: 0, sh: 0 }, 1e9);
  return probe.ds;
}

function applyStep(st: State, step: Step, seg: Seg): State {
  const n = unit(cross(st.t, st.nv));
  const yawAxis: V3 = seg.yawAxis === 'world' ? [0, 1, 0] : st.nv;
  let w: V3 = add(mul(n, step.dPitch), mul(yawAxis, step.dYaw));
  if (step.dAxis !== 0 && seg.axis) w = add(w, mul(seg.axis(), step.dAxis));
  if (step.dRoll !== 0) w = add(w, mul(st.t, step.dRoll));
  const tMid = rotate(st.t, mul(w, 0.5));
  let t = unit(rotate(st.t, w));
  let nv = rotate(st.nv, w);
  nv = unit(sub(nv, mul(t, dot(nv, t))));
  t = unit(t);
  return { h: add(add(st.h, mul(unit(tMid), step.ds)), mul(n, step.dShift)), t, nv, beta: step.beta, v2: st.v2, sh: st.sh + step.ds };
}

function recordSample(rec: Recorder, st: State, step: Step, next: State, opt: RunOptions): void {
  const u = upOf(st), t = st.t, l = cross(u, t);
  const dT = step.ds > 0 ? mul(sub(next.t, t), 1 / step.ds) : ([0, 0, 0] as V3);
  rec.rail.push(sub(st.h, mul(u, opt.heartline)));
  rec.up.push(u); rec.tan.push(t); rec.heart.push(st.h);
  rec.sh.push(st.sh); rec.speed2.push(st.v2);
  rec.gv.push((st.v2 * dot(dT, u) + G * u[1]) / G);
  rec.gl.push((st.v2 * dot(dT, l) + G * l[1]) / G);
  rec.element.push(opt.element ?? -1);
}

// ---------------------------------------------------------------------------
// Solvers
// ---------------------------------------------------------------------------

/** Bisection on a function that is monotone over `[lo, hi]`; returns x with f(x) ~ target. Throws when the target is outside the range. */
function solveMonotone(f: (x: number) => number, lo: number, hi: number, target: number, what: string, tol = 1e-4): number {
  let flo = f(lo), fhi = f(hi);
  const up = fhi >= flo;
  const inRange = up ? target >= flo - tol && target <= fhi + tol : target <= flo + tol && target >= fhi - tol;
  if (!inRange) throw new CoasterDesignError(`${what}: target ${target.toFixed(2)} is outside what the element can reach (${flo.toFixed(2)} .. ${fhi.toFixed(2)}); not enough speed or height for it?`);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (Math.abs(fm - target) <= tol) return mid;
    if ((fm < target) === up) { lo = mid; flo = fm; } else { hi = mid; fhi = fm; }
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Element builders
// ---------------------------------------------------------------------------

interface BuildCtx { st: State; run: (segs: Seg[]) => RunStats; limits: CoasterDesign['limits']; heartline: number; index: number }
interface BuiltElement { segs: Seg[]; zone?: ZoneSpec }

const rampLen = (angle: number, radius: number): number => Math.abs(angle) * radius / (1 - COASTER_DESIGN.RAMP_FRACTION);
const gMax = (c: BuildCtx): number => c.limits.gVertical[1] - COASTER_DESIGN.G_MARGIN;
const gMin = (c: BuildCtx): number => c.limits.gVertical[0] + COASTER_DESIGN.G_MARGIN;

/** A fixed pitch arc of `angle` at radius `r`. */
const pitchArc = (angle: number, r: number, zone?: ZoneSpec): Seg => {
  const len = rampLen(angle, r);
  return fixedSeg({ len, pitch: shaped(angle, len), zone });
};

/**
 * The loop-shaped half/full turn solved so its top is `height` over its start: the constant load `g` is searched from
 * the tightest allowed (the design's maximum) toward gentler ones, and the FIRST bracket that crosses the target is
 * bisected. Height is not monotone in g (a very gentle load never turns the track over before the speed is gone), so a
 * plain bisection over the whole range would land on that stalled branch. With `fit`, a target outside the reachable
 * band is clamped into it (a cobra's second half loop starts slower than its first and takes what the speed allows).
 */
function solveLoopG(c: BuildCtx, angle: number, height: number, what: string, shift?: Profile, fit = false): number {
  const f = (g: number): number => c.run([loadSeg({ angle, g: () => g, shift })]).maxY - c.st.h[1];
  const hi = gMax(c), lo = COASTER_DESIGN.LOOP_G_MIN, steps = 24;
  const gs: number[] = [], hs: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const g = hi + (lo - hi) * i / steps, h = f(g);
    // Past the tallest loop this speed can turn over the height falls again: the stalled branch.
    if (i > 0 && h < hs[i - 1]! && h < Math.max(...hs) - 0.3) break;
    gs.push(g); hs.push(h);
  }
  const tight = hs[0]!, tallest = Math.max(...hs), top = hs.indexOf(tallest);
  let target = height;
  if (target < tight - 5e-3) {
    if (!fit) throw new CoasterDesignError(`${what}: even the tightest allowed loop (${hi.toFixed(2)} g) is ${tight.toFixed(1)} blocks tall at this speed (loop radius >= ${(tight / 2).toFixed(1)} here); ask for a larger radius or enter slower`);
    return hi;
  }
  if (target > tallest) {
    if (!fit) throw new CoasterDesignError(`${what}: not enough speed for a loop ${height.toFixed(1)} tall: the tallest this entry speed turns over is ${tallest.toFixed(1)} (radius ${(tallest / 2).toFixed(1)})`);
    target = 0.92 * tallest;
    if (target < tight) return hi;
  }
  for (let i = 1; i <= top; i++) if (hs[i]! >= target) return solveMonotone(f, gs[i - 1]!, gs[i]!, target, what, 5e-3);
  return gs[top]!;
}

function buildElement(el: CoasterElement, c: BuildCtx): BuiltElement {
  const C = COASTER_DESIGN;
  const what = `element ${c.index} (${el.kind})`;
  switch (el.kind) {
    case 'station':
      return { segs: [straightSeg(el.lengthB, { kind: 'station' })] };
    case 'cable-lift': case 'chain-lift': {
      const zone: ZoneSpec = { kind: 'lift', speed: el.speedBps };
      const a = el.angleDeg * D2R;
      const make = (x: number): Seg[] => [pitchArc(a, C.LIFT_BLEND_RADIUS_B, zone), straightSeg(x, zone), pitchArc(-a, C.LIFT_BLEND_RADIUS_B, zone)];
      const x = solveMonotone(v => c.run(make(v)).end.h[1] - c.st.h[1], 0, el.riseB / Math.sin(a) + 50, el.riseB, what);
      return { segs: make(x) };
    }
    case 'launch':
      return { segs: [straightSeg(el.lengthB, { kind: 'launch', speed: el.toSpeedBps })] };
    case 'drop': {
      const peak = el.angleDeg * D2R, main = Math.min(peak, Math.PI / 2);
      const twist = (el.twistDeg ?? 0) * D2R;
      const make = (x: number): Seg[] => {
        const segs: Seg[] = [pitchArc(-peak, C.DROP_ENTRY_RADIUS_B)];
        if (peak > main + 1e-9) segs.push(pitchArc(peak - main, C.DROP_LIP_RADIUS_B));
        segs.push(fixedSeg({ len: Math.max(x, 1e-6), beta: twist ? bump(twist, Math.max(x, 1e-6)) : undefined }));
        segs.push(loadSeg({ angle: main, g: () => Math.min(C.DROP_PULLOUT_G, gMax(c)) }));
        return segs;
      };
      const x = solveMonotone(v => c.st.h[1] - c.run(make(v)).end.h[1], 0, el.fallB / Math.sin(main) + 50, el.fallB, what, 2e-3);
      return { segs: make(x) };
    }
    case 'airtime-hill': {
      const crest = Math.max(C.HILL_CREST_G, gMin(c));
      // Unknowns: the ramp angle alpha (sets the rise) and the ramps' load (sets the length: more g, tighter, shorter).
      const make = (alpha: number, gr: number): Seg[] => [
        loadSeg({ angle: alpha, g: () => gr }),
        loadSeg({ angle: -2 * alpha, g: () => crest }),
        loadSeg({ angle: alpha, g: () => gr }),
      ];
      const alphaFor = (gr: number): number =>
        solveMonotone(al => c.run(make(al, gr)).maxY - c.st.h[1], 1 * D2R, 80 * D2R, el.riseB, `${what} rise (is there speed for it?)`, 5e-3);
      const lengthFor = (gr: number): number => c.run(make(alphaFor(gr), gr)).length;
      const gr = solveMonotone(lengthFor, 1.05, gMax(c), el.lengthB, `${what} length`, el.lengthB * 0.01);
      return { segs: make(alphaFor(gr), gr) };
    }
    case 'zero-g-roll': {
      const make = (alpha: number): Seg[] => [
        loadSeg({ angle: alpha, g: () => C.HILL_RAMP_G }),
        loadSeg({ angle: -2 * alpha, g: () => C.ZERO_G_CREST_G, roll: smooth(TWO_PI, 1) }),
        loadSeg({ angle: alpha, g: () => C.HILL_RAMP_G }),
      ];
      const alpha = solveMonotone(al => c.run(make(al)).length, 1 * D2R, 60 * D2R, el.lengthB, what, el.lengthB * 0.01);
      return { segs: make(alpha) };
    }
    case 'loop': {
      const shift = smooth(C.LOOP_SHIFT_B, 1);
      const g = solveLoopG(c, TWO_PI, 2 * el.radiusB, what, shift);
      return { segs: [loadSeg({ angle: TWO_PI, g: () => g, shift })] };
    }
    case 'cobra-roll': {
      // Two half loops, each followed by a half roll back upright: two inversions, heading kept, +4 r of height.
      const shift = smooth(C.LOOP_SHIFT_B, 1);
      // Segments are single use (they keep their own progress): each half is a factory over a solved load.
      const half = (cc: BuildCtx): (() => Seg[]) => {
        const g = solveLoopG(cc, Math.PI, 2 * el.radiusB, what, shift, true);
        return () => [loadSeg({ angle: Math.PI, g: () => g, shift }),
          fixedSeg({ len: C.COBRA_ROLL_LENGTH_B, frameRoll: smooth(Math.PI, C.COBRA_ROLL_LENGTH_B) })];
      };
      const first = half(c);
      // The second half loop starts from where the first ended, at the speed it ends with.
      const mid = c.run(first()).end;
      const second = half({ ...c, st: mid, run: segs => runSegs(mid, segs, { heartline: c.heartline, limits: c.limits }) });
      return { segs: [...first(), ...second()] };
    }
    default:
      return buildOther(el, c, what);
  }
}

/** The elements that are plain straights, turns, brakes, corkscrews, helices and the top hat. */
function buildOther(el: CoasterElement, c: BuildCtx, what: string): BuiltElement {
  const C = COASTER_DESIGN;
  switch (el.kind) {
    case 'top-hat': {
      const arc = { angle: Math.PI / 2, g: (): number => Math.min(C.TOP_HAT_ARC_G, gMax(c)) };
      const make = (up: number, down: number): Seg[] => [
        loadSeg(arc), fixedSeg({ len: Math.max(up, 1e-6) }),
        loadSeg({ angle: -Math.PI, g: () => C.TOP_HAT_CREST_G }),
        fixedSeg({ len: Math.max(down, 1e-6) }), loadSeg(arc),
      ];
      const up = solveMonotone(v => c.run(make(v, 0)).maxY - c.st.h[1], 0, el.heightB * 2, el.heightB, `${what} height`, 5e-3);
      const down = solveMonotone(v => c.run(make(up, v)).end.h[1] - c.st.h[1], 0, el.heightB * 3, 0, `${what} descent`, 5e-3);
      return { segs: make(up, down) };
    }
    case 'helix': {
      const A = el.turns * TWO_PI, bank = el.bankDeg;
      const make = (phi: number): Seg[] => {
        const body = A * el.radiusB / (Math.cos(phi) * (1 - C.RAMP_FRACTION));
        return [loadSeg({ angle: -phi, g: () => C.SLOPE_ENTRY_G }),
          fixedSeg({ len: body, yaw: shaped(A, body), yawAxis: 'world', yawCos: Math.cos(phi),
            balanced: bank === undefined, beta: bank === undefined ? undefined : bump(bank * D2R, body) }),
          loadSeg({ angle: phi, g: () => Math.min(C.SLOPE_EXIT_G, gMax(c)) })];
      };
      const phi = solveMonotone(p => c.st.h[1] - c.run(make(p)).end.h[1], 0.5 * D2R, 60 * D2R, el.dropB, what, 5e-3);
      return { segs: make(phi) };
    }
    case 'turn': {
      const A = el.angleDeg * D2R, len = rampLen(A, el.radiusB), bank = el.bankDeg;
      const zone: ZoneSpec | undefined = el.driveBps ? { kind: 'lift', speed: el.driveBps } : undefined;
      return { segs: [fixedSeg({ len, yaw: shaped(A, len), yawAxis: 'world', zone,
        balanced: bank === undefined, beta: bank === undefined ? undefined : bump(bank * D2R * Math.sign(A), len) })] };
    }
    case 'straight': {
      const zone: ZoneSpec | undefined = el.driveBps ? { kind: 'lift', speed: el.driveBps } : undefined;
      if (!el.slopeDeg) return { segs: [straightSeg(el.lengthB, zone)] };
      if (el.slopeDeg < 0) throw new CoasterDesignError(`${what}: slopeDeg must be positive (a graded straight climbs, then levels)`);
      const a = el.slopeDeg * D2R;
      const make = (x: number): Seg[] => [loadSeg({ angle: a, g: () => C.SLOPE_EXIT_G, zone }), straightSeg(x, zone), loadSeg({ angle: -a, g: () => C.SLOPE_ENTRY_G, zone })];
      const x = solveMonotone(v => c.run(make(v)).length, 0, el.lengthB, el.lengthB, what, 1e-3);
      return { segs: make(x) };
    }
    case 'block-brake':
      return { segs: [straightSeg(el.lengthB, { kind: 'block-brake', speed: el.toSpeedBps ?? C.BLOCK_BRAKE_TO_BPS, decel: C.BLOCK_BRAKE_DECEL })] };
    case 'trim-brake':
      return { segs: [straightSeg(el.lengthB, { kind: 'trim', speed: el.toSpeedBps ?? C.TRIM_BRAKE_TO_BPS, decel: COASTER_PHYSICS.STATION_BRAKE })] };
    case 'corkscrew': {
      const hand = el.hand === 'L' ? 1 : -1, Lc = el.lengthB, omega = TWO_PI / Lc;
      const sinE = clamp(C.CORKSCREW_G * G / (Math.max(c.st.v2, 1) * omega),
        Math.sin(C.CORKSCREW_TILT_MIN_DEG * D2R), Math.sin(C.CORKSCREW_TILT_MAX_DEG * D2R));
      const eps = Math.asin(sinE);
      // The lead-in/out is an unbanked sideways turn of `eps`: long enough that its lateral load stays under
      // `CORKSCREW_LEAD_G` at the entry speed (peak curvature = eps / (0.7 Lt) for the clothoid shape).
      const Lt = clamp(eps * Math.max(c.st.v2, 1) / ((1 - C.RAMP_FRACTION) * G * C.CORKSCREW_LEAD_G), 5, 120);
      const axis = unit([c.st.t[0], 0, c.st.t[2]]);
      return { segs: [
        fixedSeg({ len: Lt, yaw: shaped(hand * eps, Lt) }),
        fixedSeg({ len: Lc, axisProf: { a: s => hand * TWO_PI * clamp(s / Lc, 0, 1) }, axisDir: () => axis }),
        fixedSeg({ len: Lt, yaw: shaped(-hand * eps, Lt) }),
      ] };
    }
    default:
      throw new CoasterDesignError(`${what}: not a buildable element`);
  }
}

// ---------------------------------------------------------------------------
// Closure: the return connector
// ---------------------------------------------------------------------------

/** 3x3 linear solve by Gaussian elimination with partial pivoting; undefined when singular. */
function solve3(m: number[][], b: number[]): number[] | undefined {
  const a = m.map((row, i) => [...row, b[i]!]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(a[r]![i]!) > Math.abs(a[p]![i]!)) p = r;
    if (Math.abs(a[p]![i]!) < 1e-12) return undefined;
    [a[i], a[p]] = [a[p]!, a[i]!];
    for (let r = i + 1; r < 3; r++) {
      const k = a[r]![i]! / a[i]![i]!;
      for (let cI = i; cI < 4; cI++) a[r]![cI]! -= k * a[i]![cI]!;
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let sum = a[i]![3]!;
    for (let j = i + 1; j < 3; j++) sum -= a[i]![j]! * x[j]!;
    x[i] = sum / a[i]![i]!;
  }
  return x;
}

/**
 * The return connector: a level turn, a graded straight (pitch arcs in and out) and a level turn, parameters
 * `[alpha1, straight length, grade]` solved by damped Newton so the end state lands on the start's position.
 * Both turns together carry the heading change `dPsi`; the connector is a speed-trim zone down to the platform speed.
 */
function solveReturn(end: State, start: State, heartline: number, limits: CoasterDesign['limits'], radius: number): { segs: () => Seg[]; length: number } {
  // A tighter connector turn is tried when the asked radius leaves no room (a station close to the end of the layout).
  let failure: CoasterDesignError | undefined;
  for (const k of [1, 0.7, 0.5, 0.35]) {
    try { return solveReturnAt(end, start, heartline, limits, radius * k); } catch (e) { if (!(e instanceof CoasterDesignError)) throw e; failure ??= e; }
  }
  throw failure!;
}

function solveReturnAt(end: State, start: State, heartline: number, limits: CoasterDesign['limits'], radius: number): { segs: () => Seg[]; length: number } {
  const C = COASTER_DESIGN;
  const zone: ZoneSpec = { kind: 'lift', speed: C.RETURN_DRIVE_BPS };
  const trimZone: ZoneSpec = { kind: 'trim', speed: COASTER_PHYSICS.DEPART_SPEED, decel: COASTER_PHYSICS.STATION_BRAKE };
  const heading = (t: V3): number => Math.atan2(-t[2], t[0]);
  let dPsi = heading(start.t) - heading(end.t);
  dPsi = Math.atan2(Math.sin(dPsi), Math.cos(dPsi));
  const turn = (a: number): Seg[] => {
    const len = rampLen(a, radius);
    return len < 1e-9 ? [] : [fixedSeg({ len, yaw: shaped(a, len), yawAxis: 'world', zone, balanced: true })];
  };
  const build = (x: number[], total: number): Seg[] => [
    ...turn(x[0]!),
    fixedSeg({ len: C.RETURN_PITCH_ARC_B, pitch: shaped(x[2]!, C.RETURN_PITCH_ARC_B), zone }),
    fixedSeg({ len: Math.max(x[1]!, 1e-9), zone }),
    fixedSeg({ len: C.RETURN_PITCH_ARC_B, pitch: shaped(-x[2]!, C.RETURN_PITCH_ARC_B), zone }),
    ...turn(total - x[0]!),
    fixedSeg({ len: C.RETURN_TRIM_LENGTH_B, zone: trimZone }),
  ];
  const residual = (x: number[], total: number, stepB: number): V3 =>
    sub(runSegs(end, build(x, total), { heartline, limits, stepB }).end.h, start.h);
  const newton = (x0: number[], total: number, stepB: number, iterations: number): { x: number[]; r: number } => {
    let x = [...x0], res = residual(x, total, stepB), rn = norm(res);
    for (let it = 0; it < iterations && rn > 1e-10; it++) {
      const J: number[][] = [[], [], []];
      for (let j = 0; j < 3; j++) {
        const xp = [...x]; const h = 1e-5; xp[j]! += h;
        const rp = residual(xp, total, stepB);
        for (let i = 0; i < 3; i++) J[i]![j] = (rp[i]! - res[i]!) / h;
      }
      const dx = solve3(J, [-res[0], -res[1], -res[2]]);
      if (!dx) break;
      let lambda = 1, improved = false;
      for (let k = 0; k < 10; k++, lambda /= 2) {
        const xn = x.map((v, i) => v + lambda * dx[i]!);
        xn[1] = Math.max(xn[1]!, 0.5);
        xn[2] = clamp(xn[2]!, -C.RETURN_MAX_PITCH_RAD, C.RETURN_MAX_PITCH_RAD);
        const rr = residual(xn, total, stepB), nn = norm(rr);
        if (nn < rn) { x = xn; res = rr; rn = nn; improved = true; break; }
      }
      if (!improved) break;
    }
    return { x, r: rn };
  };
  const distance = Math.hypot(start.h[0] - end.h[0], start.h[2] - end.h[2]);
  let best: { x: number[]; total: number; length: number } | undefined;
  for (const total of [dPsi, dPsi + TWO_PI, dPsi - TWO_PI]) {
    for (const a1 of [0.5 * total, -0.5 * total, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI, total, 0.2, 2 * Math.PI, -2 * Math.PI, 1.5 * Math.PI, -1.5 * Math.PI]) {
      const coarse = newton([a1, Math.max(distance, 10), 0], total, 1.5, 25);
      if (coarse.r > 0.5) continue;
      const fine = newton(coarse.x, total, C.STEP_TARGET_B, 12);
      if (fine.r > 1e-8 || fine.x[1]! < 0.5) continue;
      const length = runSegs(end, build(fine.x, total), { heartline, limits }).length;
      if (!best || length < best.length) best = { x: fine.x, total, length };
    }
  }
  if (!best) {
    const d = sub(start.h, end.h);
    throw new CoasterDesignError(`the design cannot be closed: no return connector (turn, graded straight, turn; turn radius ${radius}) reaches the station from ${d.map(v => v.toFixed(1)).join(', ')} blocks away (dx, dy, dz) with a ${(dPsi / D2R).toFixed(0)} degree heading change; end the design nearer the station, or add turns`);
  }
  const { x, total } = best;
  return { segs: () => build(x, total), length: best.length };
}

// ---------------------------------------------------------------------------
// generateCoaster
// ---------------------------------------------------------------------------

function checkDesign(design: CoasterDesign): void {
  const bad = (m: string): never => { throw new CoasterDesignError(m); };
  if (!design.elements.length || design.elements[0]!.kind !== 'station') bad('a design must begin with a station element');
  if (!(design.heartlineB >= 0) || !Number.isFinite(design.heartlineB)) bad('heartlineB must be a finite number >= 0');
  const l = design.limits;
  if (!(l.maxSpeedBps > 0) || !(l.gLateral > 0) || !(l.maxJerk > 0) || !(l.gVertical[0] < l.gVertical[1])) bad('limits are not usable');
  design.elements.forEach((el, i) => {
    for (const [k, v] of Object.entries(el)) {
      if (typeof v === 'number' && !Number.isFinite(v)) bad(`element ${i} (${el.kind}): ${k} is not finite`);
      if (typeof v === 'number' && v <= 0 && /B$|Bps$/.test(k) && k !== 'bankDeg') bad(`element ${i} (${el.kind}): ${k} must be positive`);
    }
  });
}

const zoneOfElement = (el: CoasterElement): Pick<CoasterZone, 'kind' | 'params'> | undefined => {
  switch (el.kind) {
    case 'station': return { kind: 'station' };
    case 'cable-lift': case 'chain-lift': return { kind: 'lift', params: { speedBps: el.speedBps } };
    case 'launch': return { kind: 'launch', params: { toSpeedBps: el.toSpeedBps } };
    case 'block-brake': return { kind: 'block-brake', params: { toSpeedBps: el.toSpeedBps ?? COASTER_DESIGN.BLOCK_BRAKE_TO_BPS } };
    case 'trim-brake': return { kind: 'trim', params: { toSpeedBps: el.toSpeedBps ?? COASTER_DESIGN.TRIM_BRAKE_TO_BPS } };
    case 'turn': case 'straight': return el.driveBps ? { kind: 'lift', params: { speedBps: el.driveBps, drive: 1 } } : undefined;
    default: return undefined;
  }
};

/** Counts contiguous stretches of at least `MIN_INVERSION_SAMPLES` samples inverted, whose first sample is in `[from, to)`. */
function countInversions(upY: readonly number[], from: number, to: number): number {
  let count = 0, run = 0, runStart = 0;
  for (let i = 0; i <= upY.length; i++) {
    if (i < upY.length && upY[i]! < COASTER_DESIGN.INVERTED_UP_Y) { if (!run) runStart = i; run++; continue; }
    if (run >= COASTER_DESIGN.MIN_INVERSION_SAMPLES && runStart >= from && runStart < to) count++;
    run = 0;
  }
  return count;
}

/**
 * Generate the closed circuit for a design. Throws `CoasterDesignError` when an element cannot reach its numbers
 * or the result fails `validateCoaster` (pass `{ validate: false }` to inspect an invalid design).
 */
export function generateCoaster(design: CoasterDesign, opts: { validate?: boolean } = {}): GeneratedCoaster {
  checkDesign(design);
  const heartline = design.heartlineB, limits = design.limits;
  const start: State = { h: [0, heartline, 0], t: [1, 0, 0], nv: [0, 1, 0], beta: 0, v2: COASTER_PHYSICS.DEPART_SPEED ** 2, sh: 0 };
  const rec = newRecorder();
  const spanStart: number[] = [];
  let cur = start;
  design.elements.forEach((el, index) => {
    const st = cur;
    const ctx: BuildCtx = { st, run: segs => runSegs(st, segs, { heartline, limits }), limits, heartline, index };
    const built = buildElement(el, ctx);
    spanStart.push(rec.rail.length);
    cur = runSegs(st, built.segs, { heartline, limits, rec, element: index }).end;
  });
  if (Math.abs(cur.t[1]) > 2e-3 || Math.abs(cur.nv[1] - 1) > 2e-3 || Math.abs(cur.beta) > 2e-3) {
    throw new CoasterDesignError('the design must end level and upright (its last element left the track pitched or rolled)');
  }
  const ret = solveReturn(cur, start, heartline, limits, design.returnRadiusB ?? COASTER_DESIGN.RETURN_RADIUS_B);
  spanStart.push(rec.rail.length);
  const arrival = runSegs(cur, ret.segs(), { heartline, limits, rec, element: design.elements.length });
  const last = arrival.end;
  // The final sample is the seam: it IS the first sample (exact repeat, as `createCoasterRoute` requires).
  const closure = {
    position: norm(sub(sub(last.h, mul(upOf(last), heartline)), rec.rail[0]!)),
    tangent: norm(sub(last.t, rec.tan[0]!)),
    up: norm(sub(upOf(last), rec.up[0]!)),
  };
  rec.rail.push([...rec.rail[0]!]); rec.up.push([...rec.up[0]!]); rec.tan.push([...rec.tan[0]!]); rec.heart.push([...rec.heart[0]!]);
  rec.sh.push(last.sh); rec.speed2.push(last.v2); rec.floor.push(false); rec.element.push(design.elements.length);
  rec.gv.push(rec.gv.at(-1)!); rec.gl.push(rec.gl.at(-1)!);
  const gen = analyse(design, rec, spanStart, closure, last.v2);
  if (opts.validate !== false) {
    const issues = validateCoaster(gen);
    if (issues.length) throw new CoasterDesignError(`${design.name}: ${issues.map(i => i.message).join('; ')}`, issues);
  }
  return gen;
}

function analyse(design: CoasterDesign, rec: Recorder, spanStart: number[], closure: CoasterAnalysis['closure'], arrivalV2: number): GeneratedCoaster {
  const n = rec.rail.length, P = COASTER_PHYSICS, C = COASTER_DESIGN;
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1]! + norm(sub(rec.rail[i]!, rec.rail[i - 1]!)));
  const speed = rec.speed2.map(Math.sqrt);
  // Heart time per step, for the lap and the jerk window.
  const time: number[] = [0];
  for (let i = 1; i < n; i++) time.push(time[i - 1]! + 2 * (rec.sh[i]! - rec.sh[i - 1]!) / Math.max(speed[i]! + speed[i - 1]!, 1e-9));
  const jerk: number[] = new Array<number>(n).fill(0);
  for (let i = 0, j = 0; i < n; i++) {
    if (j < i) j = i;
    while (j < n - 1 && time[j]! - time[i]! < C.JERK_WINDOW_S) j++;
    const dt = time[j]! - time[i]!;
    jerk[i] = dt >= C.JERK_WINDOW_S * 0.999 ? Math.hypot(rec.gv[j]! - rec.gv[i]!, rec.gl[j]! - rec.gl[i]!) / dt : 0;
  }
  const upY = rec.up.map(u => u[1]);
  const spans: CoasterSpan[] = [];
  const nEl = design.elements.length;
  for (let e = 0; e <= nEl; e++) {
    const a = spanStart[e]!, b = e < nEl ? spanStart[e + 1]! : n - 1;
    const slice = (arr: readonly number[]): number[] => arr.slice(a, Math.max(b, a + 1));
    const gv = slice(rec.gv), gl = slice(rec.gl).map(Math.abs), sp = slice(speed);
    spans.push({
      index: e, kind: e < nEl ? design.elements[e]!.kind : 'return', from: arc[a]!, to: arc[Math.min(b, n - 1)]!,
      minG: Math.min(...gv), maxG: Math.max(...gv), maxLateralG: Math.max(...gl), maxSpeedBps: Math.max(...sp),
      endSpeedBps: speed[Math.min(b, n - 1)]!, inversions: countInversions(upY, a, b),
      heightGainB: rec.rail[Math.min(b, n - 1)]![1] - rec.rail[a]![1],
    });
  }
  // Brakes that left their zone too fast.
  const brakeShortfall: CoasterAnalysis['brakeShortfall'] = [];
  design.elements.forEach((el, i) => {
    if (el.kind !== 'block-brake' && el.kind !== 'trim-brake') return;
    const target = el.toSpeedBps ?? (el.kind === 'block-brake' ? C.BLOCK_BRAKE_TO_BPS : C.TRIM_BRAKE_TO_BPS);
    const excess = spans[i]!.endSpeedBps - target;
    if (excess > 0.05) brakeShortfall.push({ index: i, excessBps: excess });
  });
  const analysis: CoasterAnalysis = {
    arc, speed, gVertical: rec.gv, gLateral: rec.gl, jerk, upY, floorHit: rec.floor, tangentY: rec.tan.map(t => t[1]),
    brakeShortfall, arrivalSpeedBps: Math.sqrt(arrivalV2), closure, limits: design.limits, heartlineB: design.heartlineB, shows: design.shows,
  };
  // Zones by arc distance.
  const zones: CoasterZone[] = [];
  for (const s of spans) {
    if (s.index === nEl) {
      const cut = Math.max(s.from, s.to - C.RETURN_TRIM_LENGTH_B);
      zones.push({ kind: 'lift', from: s.from, to: cut, params: { speedBps: C.RETURN_DRIVE_BPS, drive: 1 } });
      zones.push({ kind: 'trim', from: cut, to: s.to, params: { toSpeedBps: P.DEPART_SPEED } });
      continue;
    }
    const z = zoneOfElement(design.elements[s.index]);
    if (z) zones.push({ ...z, from: s.from, to: s.to });
  }
  for (const o of design.overlays ?? []) {
    const a = spans[o.fromElement], b = spans[o.toElement];
    if (a && b) zones.push({ kind: o.kind, from: a.from, to: b.to, ...(o.params ? { params: o.params } : {}) });
  }
  zones.sort((p, q) => p.from - q.from || p.to - q.to);
  const xs = rec.rail.map(p => p[0]), ys = rec.rail.map(p => p[1]), zs = rec.rail.map(p => p[2]);
  const ext = (v: number[]): number => Math.max(...v) - Math.min(...v);
  const report = {
    lengthB: arc[n - 1]!, heightB: ext(ys), footprintB: [ext(xs), ext(zs)] as [number, number],
    inversions: countInversions(upY, 0, n), maxG: Math.max(...rec.gv), minG: Math.min(...rec.gv),
    maxLateralG: Math.max(...rec.gl.map(Math.abs)), maxSpeedBps: Math.max(...speed),
    lapS: time[n - 1]! + P.DWELL_LOADED / 20,
  };
  return {
    route: { points: rec.rail.map(p => [p[0], p[1], p[2]] as CoasterVec3), kind: 'closed', maxSegmentLength: C.MAX_SAMPLE_SPACING_B },
    ups: rec.up.map(u => [u[0], u[1], u[2]] as CoasterVec3), zones, report, spans, analysis,
  };
}

// ---------------------------------------------------------------------------
// validateCoaster
// ---------------------------------------------------------------------------

/**
 * How fast the car's frame (tangent and up together) rotates at each sample, in degrees per 50 ms tick at the design
 * speed: the angle between the frames two samples either side, over their arc, times the speed. A roll about the
 * heartline shows here although the heart's path is straight, which the g limits do not see.
 */
export function frameRateDegPerTick(gen: GeneratedCoaster): number[] {
  const pts = gen.route.points, ups = gen.ups, arc = gen.analysis.arc, speed = gen.analysis.speed, n = pts.length;
  const frame = (i: number): [V3, V3, V3] => {
    const t = unit(sub(pts[Math.min(n - 1, i + 1)] as V3, pts[Math.max(0, i - 1)] as V3));
    const u = ups[i] as V3;
    return [t, u, cross(t, u)];
  };
  const out: number[] = new Array<number>(n).fill(0);
  for (let i = 2; i < n - 2; i++) {
    const a = frame(i - 2), b = frame(i + 2);
    let trace = 0;
    for (let k = 0; k < 3; k++) trace += dot(a[k]!, b[k]!);
    const angle = Math.acos(clamp((trace - 1) / 2, -1, 1));
    const ds = arc[i + 2]! - arc[i - 2]!;
    out[i] = ds > 1e-9 ? (angle / ds) * speed[i]! / 20 * (180 / Math.PI) : 0;
  }
  return out;
}

/** Every way a generated circuit breaks its limits; empty when it is sound. */
export function validateCoaster(gen: GeneratedCoaster): CoasterIssue[] {
  const C = COASTER_DESIGN, a = gen.analysis, L = a.limits, pts = gen.route.points, n = pts.length;
  const issues: CoasterIssue[] = [];
  const worst = (arr: readonly number[], pick: (v: number) => number): number => { let k = 0; for (let i = 1; i < arr.length; i++) if (pick(arr[i]!) > pick(arr[k]!)) k = i; return k; };
  let maxChord = 0;
  for (let i = 1; i < n; i++) maxChord = Math.max(maxChord, norm(sub(pts[i] as V3, pts[i - 1] as V3)));
  if (maxChord > C.MAX_SAMPLE_SPACING_B + 1e-9) issues.push({ code: 'spacing', message: `samples up to ${maxChord.toFixed(3)} blocks apart (limit ${C.MAX_SAMPLE_SPACING_B})` });
  const c = a.closure;
  if (c.position > C.CLOSURE_POSITION_B || c.tangent > C.CLOSURE_DIRECTION || c.up > C.CLOSURE_DIRECTION) {
    issues.push({ code: 'closure', message: `circuit does not close (position ${c.position.toExponential(1)}, tangent ${c.tangent.toExponential(1)}, up ${c.up.toExponential(1)})` });
  }
  const gvMax = worst(a.gVertical, v => v), gvMin = worst(a.gVertical, v => -v);
  if (a.gVertical[gvMax]! > L.gVertical[1] + 1e-6) issues.push({ code: 'g-vertical', at: a.arc[gvMax], message: `vertical g ${a.gVertical[gvMax]!.toFixed(2)} above ${L.gVertical[1]} at arc ${a.arc[gvMax]!.toFixed(1)}` });
  if (a.gVertical[gvMin]! < L.gVertical[0] - 1e-6) issues.push({ code: 'g-vertical', at: a.arc[gvMin], message: `vertical g ${a.gVertical[gvMin]!.toFixed(2)} below ${L.gVertical[0]} at arc ${a.arc[gvMin]!.toFixed(1)}` });
  const gl = worst(a.gLateral, Math.abs);
  if (Math.abs(a.gLateral[gl]!) > L.gLateral + 1e-6) issues.push({ code: 'g-lateral', at: a.arc[gl], message: `lateral g ${Math.abs(a.gLateral[gl]!).toFixed(2)} above ${L.gLateral} at arc ${a.arc[gl]!.toFixed(1)}` });
  const jk = worst(a.jerk, v => v);
  if (a.jerk[jk]! > L.maxJerk) issues.push({ code: 'jerk', at: a.arc[jk], message: `jerk ${a.jerk[jk]!.toFixed(1)} g/s above ${L.maxJerk} at arc ${a.arc[jk]!.toFixed(1)}` });
  const stall = a.floorHit.findIndex((f, i) => f && (a.tangentY[i]! > 0.2 || a.upY[i]! < 0));
  if (stall >= 0) issues.push({ code: 'stall', at: a.arc[stall], message: `the train runs out of speed on a climb or an inversion at arc ${a.arc[stall]!.toFixed(1)}` });
  const ys = pts.map(p => p[1]);
  const top = C.WORLD_GROUND_Y + Math.max(...ys), bottom = C.WORLD_GROUND_Y + Math.min(...ys);
  if (top > C.WORLD_MAX_Y) issues.push({ code: 'world-height', message: `world height ${top.toFixed(0)} is above the build limit ${C.WORLD_MAX_Y} (ground at ${C.WORLD_GROUND_Y})` });
  if (bottom < C.WORLD_MIN_Y) issues.push({ code: 'world-height', message: `world height ${bottom.toFixed(0)} is below the world floor ${C.WORLD_MIN_Y}` });
  for (const b of a.brakeShortfall) issues.push({ code: 'brake', message: `brake element ${b.index} leaves ${b.excessBps.toFixed(1)} blocks/s over its exit speed: lengthen it` });
  if (a.arrivalSpeedBps > COASTER_PHYSICS.DEPART_SPEED * C.ARRIVAL_SPEED_FACTOR) {
    issues.push({ code: 'arrival', message: `the train reaches the station at ${a.arrivalSpeedBps.toFixed(1)} blocks/s: brake harder or longer before the return` });
  }
  for (const s of a.shows) if (!Number.isFinite(s.at) || s.at < 0 || s.at > a.arc[n - 1]!) issues.push({ code: 'show', message: `show cue at ${s.at} is outside the circuit` });
  const rate = frameRateDegPerTick(gen), fr = worst(rate, v => v);
  if (rate[fr]! > C.MAX_FRAME_RATE_DEG_PER_TICK) {
    const el = gen.spans.find(sp => a.arc[fr]! >= sp.from && a.arc[fr]! < sp.to);
    issues.push({ code: 'frame-rate', at: a.arc[fr], message: `the car's frame turns ${rate[fr]!.toFixed(0)} degrees per tick at arc ${a.arc[fr]!.toFixed(1)} (${el ? `element ${el.index}, ${el.kind}` : 'the return'}), above ${C.MAX_FRAME_RATE_DEG_PER_TICK}: the rider camera cannot follow it; lengthen the roll or give it more speed` });
  }
  const clear = nearestApproach(pts as readonly V3[], a.arc);
  if (clear) issues.push({ code: 'clearance', at: clear.at, message: `track passes within ${clear.d.toFixed(2)} blocks of itself at arc ${clear.at.toFixed(1)} (needs ${C.CLEARANCE_B})` });
  return issues;
}

/** Spatial-hash scan for two rail samples closer than `CLEARANCE_B` that are far apart along the track (cyclically). */
function nearestApproach(pts: readonly V3[], arc: readonly number[]): { d: number; at: number } | undefined {
  const C = COASTER_DESIGN, cell = C.CLEARANCE_B, total = arc[arc.length - 1]!;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  let worstD = Infinity, worstAt = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]!, cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        const along = Math.abs(arc[i]! - arc[j]!), cyc = Math.min(along, total - along);
        if (cyc < C.CLEARANCE_SKIP_ARC_B) continue;
        const d = norm(sub(p, pts[j]!));
        if (d < C.CLEARANCE_B && d < worstD) { worstD = d; worstAt = arc[i]!; }
      }
    }
    const k = key(cx, cy, cz);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  return worstD < Infinity ? { d: worstD, at: worstAt } : undefined;
}
