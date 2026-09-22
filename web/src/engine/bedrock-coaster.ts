/** Scripted ride cars follow measured track paths, including vertical curves.
 * These are deliberately distinct from vanilla rails: no track is flattened,
 * and an open track shuttles rather than inventing a connection across a gap.
 *
 * ## Ride model
 *
 * The car is a point on a sampled polyline, not a rigid-body simulation. One
 * scalar speed is integrated per Bedrock tick along the track tangent:
 *
 *     a = -g * sin(theta) - rolling - drag * v^2      [blocks/s^2]
 *
 * `sin(theta)` is the y component of the unit track tangent in the direction of
 * travel, so the car loses speed on a climb and gains it on a drop. Speeds are
 * WORLD blocks per second; the route is in MODEL blocks, so one tick advances
 * `speed / (20 * scale)` model blocks (20 ticks = 1 s, `scale` = wand size).
 *
 * Three bounded overrides sit on top of the integrator, each of which exists
 * for a reason a real coaster shares:
 *
 * - **Chain lift** — on a climb steeper than `LIFT_GRADE`, a car slower than
 *   the chain is carried at exactly chain speed. It never applies on the flat
 *   or on a drop and never exceeds `LIFT_SPEED`, so it cannot add ride energy.
 *   A set whose chain drive was MEASURED (`coaster-assemblies.ts`: sprockets
 *   under a climbing section) engages the chain on that section only; a set
 *   with no detected drive keeps the assist on every climb, as device-proved.
 * - **Station brake and drive** — approaching the measured platform the speed is
 *   limited to `sqrt(2 * brake * remaining)`, which reaches zero exactly at the
 *   platform; departure is a bounded push from the station drive tyres.
 * - **Floor and ceiling** — a floor so the ride can never deadlock on a grade,
 *   and a ceiling of one authored sample spacing per tick so a step can never
 *   cut the corner of the measured polyline.
 *
 * The ceiling does bleed energy out of the longest drops (a 35-block descent
 * would otherwise reach ~26 blocks/s, four times the spacing limit on a 1x
 * 10303). That is deliberate: the sampled path, not the physics, sets the
 * maximum safe step, and the chain lift restores what the clip removed.
 *
 * ## The set's own cars
 *
 * A route whose SOURCE carries ride cars (`CoasterRoute.vehicles`, measured
 * by `detectCoasterAssemblies`) runs THOSE cars: each car's own bricks are
 * compiled as a rideable entity in the car's canonical frame (travel +X, up
 * -Y, the running datum at the origin — `canonicalCoasterCar`), its measured
 * seat is the player's seat, and its posed rider rides along as a bone that
 * is hidden while a player sits there. One entity TYPE is emitted per distinct
 * car body (`planCoasterVehicles`), instanced once per car; rider figures that
 * differ between cars of one type are rider VARIANTS selected per instance by
 * an actor property. The car's nose keeps its authored heading along the
 * route, so a shuttle runs backwards on the return leg rather than spinning
 * every car round at the dead end. A route with no detected car keeps the
 * fabricated grey cart (`coasterCartAssets`) exactly as device-proved.
 *
 * ## Trains
 *
 * A route may declare the train its SOURCE has: `cars: { count, spacing }`,
 * measured from the set, never inferred (10303 carries three rider clusters
 * exactly 120 LDU apart, so three cars). The placement then spawns that many
 * car entities, each boardable by a different player and no seat reserved.
 *
 * One ride state drives them all: the tracked arc distance is the train's
 * CENTRE, and car k sits at `centre + extent/2 - k * spacing`. Fixing the
 * offsets to the centre rather than to a lead car is what makes an open route's
 * reversal free — the tail simply becomes the head, and nothing is teleported
 * across the train. The grade that drives the physics is averaged over the
 * cars, so a train straddling a crest feels both of its sides, and a car facing
 * an unloaded chunk or a refused teleport holds the whole train.
 *
 * With `cars` absent the train is one car, `extent` is zero, and every one of
 * these expressions collapses to the single-cart ride that was device-proved.
 *
 * ## The set's own lift
 *
 * An open route with a measured PLATFORM lift (10303's elevator: a rigid
 * tilted deck docked end-on at one terminal, translating to the other) is
 * ridden as a circuit. The runtime path is the route with the deck's own
 * running line appended at BOTH terminals — the deck at its parked pose before
 * arc 0 and, translated by the measured travel, after the far end — so the
 * physics, brake and frames need no special case: the train rolls off the
 * course onto the parked deck and brakes to its centre; the platform entity
 * (the deck's own bricks) and its counterweight (opposite) translate over
 * `PLATFORM_SPEED`, carrying the cars; the arc is re-based onto the delivered
 * deck and the train departs down the course. The platform returns once the
 * train has cleared the deck, and a train arriving before it is back holds at
 * the terminal. A CHAIN lift needs no entity: the car climbs that arc range
 * under the chain assist above. Nothing here invents track: the deck line is
 * the set's own rails, snapped onto the terminals it was measured against.
 */
import { buildCoasterFrames, buildCoasterPath, sampleCoasterPath, type CoasterPath, type CoasterVec3 } from './coaster-path.js';
import type { PartGeometryProvider, Vec3 } from './ldraw-part-geometry.js';
import type { ParsedBrick } from './ldraw-parser.js';
import { withSizeGroups, type PlacementActor } from './bedrock-placement-pack.js';
import { bedrockJsonText, floatActorProperty } from './bedrock-json.js';
import { compileLdrawEntityGeometry, ldrawToRenderRotation, type CompiledLdrawGeometry } from './ldraw-entity-compiler.js';
import type { EntityRig } from './minifig-rig.js';
import type { LegoEntityQuality, LegoEntityQualityName } from './ldraw-part-prototype.js';
import { SEATED_EYE_HEIGHT_BLOCKS } from './lego-scale.js';
import { SHELL_FRAME } from './bedrock-building-shell.js';
import type { CoasterAssemblies, CoasterCar, CoasterPlatformLift } from './coaster-assemblies.js';
import type { CoasterTrackExtraction } from './coaster-track.js';
import { sceneGridPoint, type SceneGridFrame } from './bedrock-scene-actors.js';

declare const world: any;
declare const system: any;

// ─── Pipeline → pack contract ────────────────────────────────────────────────

/** A ride car of the SOURCE, ready to compile: its own bricks in the car's canonical frame. */
export interface CoasterRouteCar {
  /** The chassis mould (the type key's first component) and the input indices this car took out of the shell. */
  chassis: string;
  sourceIndices: number[];
  /**
   * The car's bricks (chassis, wheels, tub, restraint…) in the CANONICAL car
   * frame: LDraw units, travel along +X, up along -Y, the running datum at
   * the origin (`canonicalCoasterCar`). The runtime places that origin on the
   * route, so a car sits on its rails exactly as high as the source put it.
   */
  bricks: ParsedBrick[];
  /** The posed rider's figure bricks in the same frame; empty when the car is unridden. */
  rider: ParsedBrick[];
  /** The rider's hips joint in the canonical frame (LDU): the player's seat. Absent when no seat was measured. */
  seatLdu?: Vec3;
  /** The car's datum point in model blocks; projected onto the route to find its arc. */
  datumPoint: Vec3;
  /** +1 when the car's nose (canonical +X) points along increasing arc. */
  heading: 1 | -1;
}

export interface CoasterRouteChainLift {
  kind: 'chain';
  /** Arc span the drive covers, model blocks, increasing arc. */
  arcStart: number;
  arcEnd: number;
  /** +1 when the climb runs with increasing arc. The ride runs this way. */
  climbDirection: 1 | -1;
  /** Drive parts found, for diagnostics. */
  sprockets: number;
}

export interface CoasterRoutePlatformLift {
  kind: 'platform';
  /** The platform's own bricks in the SOURCE frame (compiled like a shell, yaw 0). */
  bricks: ParsedBrick[];
  /** The platform's authored origin in the source frame: the compiled entity's origin. */
  originLdu: Vec3;
  /** The entity's origin at the PARKED pose (deck end snapped onto its terminal), model blocks. */
  parkedPoint: Vec3;
  /** Parked → delivered displacement, model blocks (both ends snapped onto their terminals). */
  travel: Vec3;
  /** The deck's running-datum line at the parked pose, model blocks: the free end, then the end on the terminal. */
  deck: [far: Vec3, terminal: Vec3];
  /** Which route terminal the deck meets while parked. `coasterRuntimeConfig` reverses an `end` route so the deck is always at arc 0. */
  parkedEnd: 'start' | 'end';
  /** The hoist's counterweight, when the set has one riding beside the tower: it moves opposite the platform. */
  counterweight?: { bricks: ParsedBrick[]; originLdu: Vec3; point: Vec3; sourceIndices: number[] };
  /** Measurements in LDU, reported in the diagnostics. */
  measured: { travelLdu: number; axisDistanceLdu: number; betweenTerminalsLdu: number; parkedMisfitLdu: number; deliveredMisfitLdu: number; deckLengthLdu: number; tiltDeg: number; members: number };
}

export type CoasterRouteLift = CoasterRouteChainLift | CoasterRoutePlatformLift;

export interface CoasterRoute {
  label: string;
  /** Model/grid coordinates in blocks, at the exported scale. */
  points: Vec3[];
  closed: boolean;
  /** Maximum verified sample spacing in blocks; not derived from a possibly broken route. */
  maxSegmentLength: number;
  /**
   * The train the SOURCE actually has: how many cars, and their arc pitch in
   * model blocks. Never inferred here — a train length is a measurement of the
   * set (10303 carries three rider clusters exactly 120 LDU apart, so three
   * cars at 120 / cellLDU blocks). Omitted means one cart. Ignored when
   * `vehicles` is present: the cars themselves are the measurement then.
   */
  cars?: { count: number; spacing: number };
  /** The set's own ride cars on this route (`coasterRoutesFromAssemblies`); absent means the fabricated cart. */
  vehicles?: CoasterRouteCar[];
  /** The set's own lift on this route, when one was measured. */
  lift?: CoasterRouteLift;
}

/** The measured flat reload zone a cart brakes into, dwells on, and departs from. */
export interface CoasterStation {
  /** Arc distance in model blocks where the flat run starts. */
  start: number;
  /** Arc distance where it ends. On a closed route the run may straddle the
   * seam, in which case `end < start` and the span wraps through zero. */
  end: number;
  /** The platform: where the cart is braked to a halt. Midpoint of the run. */
  stop: number;
  /** Arc length of the flat run; zero when the route has no flat section. */
  length: number;
  /** Model-local point at `stop`, so a placement can park the cart in reach. */
  point: CoasterVec3;
}

/** One car of a train as the runtime sees it: which entity type, which rider variant, and its name tag. */
export interface CoasterCarSlot { type: string; rider: number; label: string }

export interface CoasterRuntimeLift {
  /** Entity types of the platform and (when the set has one) its counterweight. */
  type: string;
  counterweightType?: string;
  /** Arc length of the deck, model blocks: the runtime path's first `deckLength` is the parked deck. */
  deckLength: number;
  /** Parked → delivered displacement, model blocks. */
  travel: [number, number, number];
  /** The platform entity's origin at the parked pose and the counterweight's at rest, model blocks. */
  parkedPoint: [number, number, number];
  counterweightPoint?: [number, number, number];
}

export interface CoasterRuntimeRoute {
  label: string;
  path: CoasterPath;
  up: CoasterVec3[];
  /** Largest authored sample spacing in model blocks; caps the per-tick step. */
  maxSpacing: number;
  station: CoasterStation;
  /** The resolved train: `extent` is the arc length from the first car to the
   * last, and is zero for the single cart that is the default. `minChord` is
   * the tightest straight-line gap the route's curvature leaves between two
   * coupled cars; a train whose cars are longer than it overlaps on that curve.
   * `heading` fixes the cars' noses along the route (+1/-1); 0 lets the
   * fabricated cart face its direction of motion. `slots` names each car's
   * entity type and rider variant; absent for the fabricated cart. */
  cars: { count: number; spacing: number; extent: number; minChord?: number; heading: 1 | -1 | 0; slots?: CoasterCarSlot[] };
  /** Fixed ride direction (a closed circuit's, or toward a platform lift's deck); 0 shuttles an open route. */
  direction: 1 | -1 | 0;
  /** A measured chain drive: the chain assist engages only on this arc span. Absent keeps it on every climb. */
  chain?: { start: number; end: number };
  lift?: CoasterRuntimeLift;
}

/** What each entity type in a placement is: a ride car (and how many rider variants it carries), the platform, or its counterweight. */
export interface CoasterRuntimeType { role: 'car' | 'platform' | 'counterweight'; riders: number }

export interface CoasterRuntimeConfig {
  /** The fabricated cart's type id; also the stem the set's own vehicle types are named from. */
  typeId: string;
  routes: CoasterRuntimeRoute[];
  types: Record<string, CoasterRuntimeType>;
}

/** |dy/ds| at or below this counts as level track (about 4.6 degrees). */
const STATION_FLAT_GRADE = 0.08;
/** A station sits low: only flat runs inside this fraction of the route's
 * height range above its lowest point are eligible. */
const STATION_LOW_BAND = 0.25;
/** Most cars a route may run (`resolveCoasterCars` rejects more; the pipeline leaves the rest in the shell). */
export const COASTER_MAX_CARS = 8;
/** Actor-property names shared by every ride car. */
const PROP_PITCH = 'craftmatic:track_pitch', PROP_ROLL = 'craftmatic:track_roll', PROP_RIDER = 'craftmatic:rider', PROP_OCCUPIED = 'craftmatic:occupied';
/** The type family every coaster entity carries; the runtime discovers them by it. */
export const COASTER_FAMILY = 'craftmatic_coaster';
/** A seated minifig's eye sits this far above its hips joint along the figure's up: torso origin 44 LDU up (hips 32 + leg pivot 12), eye 11 above that (`findCockpit`). */
const RIDER_EYE_ABOVE_HIPS_LDU = 55;

/** Largest authored sample spacing, measured rather than assumed from the
 * caller's declared guard. The per-tick arc step is capped by this value. */
export function coasterMaxSpacing(path: CoasterPath): number {
  let largest = 0;
  for (let index = 1; index < path.cumulative.length; index++) {
    const spacing = path.cumulative[index]! - path.cumulative[index - 1]!;
    if (spacing > largest) largest = spacing;
  }
  if (!(largest > 0)) throw new Error('Coaster path has no positive sample spacing.');
  return largest;
}

/**
 * Derive the station from the route itself: the longest near-level run in the
 * lowest band of the route's height, which is where a real coaster loads.
 * Never a hard-coded index. A route with no level run at all (a bare loop)
 * stations at its lowest point, with zero platform length.
 */
export function findCoasterStation(path: CoasterPath): CoasterStation {
  const points = path.points, cumulative = path.cumulative, total = path.length;
  const segmentCount = points.length - 1;
  let lowest = points[0]![1], highest = points[0]![1], lowestIndex = 0;
  for (let index = 0; index < points.length; index++) {
    const y = points[index]![1];
    if (y < lowest) { lowest = y; lowestIndex = index; }
    if (y > highest) highest = y;
  }
  const ceiling = lowest + (highest - lowest) * STATION_LOW_BAND;
  const spans: Array<{ start: number; end: number; length: number; meanY: number }> = [];
  let runStart = -1;
  for (let index = 0; index < segmentCount; index++) {
    const spacing = cumulative[index + 1]! - cumulative[index]!;
    const level = Math.abs((points[index + 1]![1] - points[index]![1]) / spacing) <= STATION_FLAT_GRADE;
    if (level && runStart < 0) runStart = index;
    if ((!level || index === segmentCount - 1) && runStart >= 0) {
      const last = level ? index : index - 1;
      spans.push({ start: cumulative[runStart]!, end: cumulative[last + 1]!,
        length: cumulative[last + 1]! - cumulative[runStart]!,
        meanY: (points[runStart]![1] + points[last + 1]![1]) / 2 });
      runStart = -1;
    }
  }
  // A closed route's platform may straddle the repeated seam point; joining the
  // two halves keeps a real station whole instead of halving it at the seam.
  if (path.closed && spans.length > 1 && spans[0]!.start === 0 && spans.at(-1)!.end === total) {
    const head = spans.shift()!, tail = spans.pop()!;
    spans.push({ start: tail.start, end: head.end, length: tail.length + head.length,
      meanY: (tail.meanY + head.meanY) / 2 });
  }
  const low = spans.filter(span => span.meanY <= ceiling);
  const pool = low.length ? low : spans;
  pool.sort((a, b) => b.length - a.length || a.meanY - b.meanY || a.start - b.start);
  const best = pool[0];
  if (!best) {
    const stop = cumulative[lowestIndex]!;
    return { start: stop, end: stop, stop, length: 0, point: points[lowestIndex]! };
  }
  const length = best.start <= best.end ? best.end - best.start : total - best.start + best.end;
  let stop = best.start + length / 2;
  // A closed route's distances live in [0, total): the runtime wraps its own
  // arc distance the same way, so a platform at the seam must be 0, not total.
  if (stop >= total && path.closed) stop -= total;
  else if (stop > total) stop = total;
  return { start: best.start, end: best.end, stop, length, point: sampleCoasterPath(path, stop).position };
}

/** The drawn fabricated cart body is 20 entity units long: 1.25 blocks at export scale 1.
 * Compare it against a train's `minChord` to see whether its cars overlap. */
export const COASTER_CAR_LENGTH = 1.25;

/** Position at an arc distance, without the sampler's per-call validation.
 * Config-time only; the runtime uses the validated sampler. */
function pointAtDistance(path: CoasterPath, arc: number): CoasterVec3 {
  const distance = Math.max(0, Math.min(path.length, arc));
  let low = 0, high = path.points.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (path.cumulative[middle]! <= distance) low = middle; else high = middle - 1;
  }
  const from = path.points[low]!, to = path.points[low + 1]!;
  const span = path.cumulative[low + 1]! - path.cumulative[low]!;
  const ratio = span > 0 ? (distance - path.cumulative[low]!) / span : 0;
  return [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio, from[2] + (to[2] - from[2]) * ratio];
}

/**
 * Tightest straight-line gap between two cars a fixed arc pitch apart, measured
 * at every authored sample. A curve whose radius is small against the pitch
 * pulls coupled cars together — below the drawn car length they visibly
 * overlap, which is a property of the SOURCE's curvature, not of the runtime.
 */
export function minimumCoupledChord(path: CoasterPath, spacing: number): number {
  let smallest = Infinity;
  for (let index = 0; index < path.points.length; index++) {
    let trail = path.cumulative[index]! - spacing;
    if (trail < 0) { if (!path.closed) continue; trail += path.length; }
    const lead = path.points[index]!, behind = pointAtDistance(path, trail);
    const chord = Math.hypot(lead[0] - behind[0], lead[1] - behind[1], lead[2] - behind[2]);
    if (chord < smallest) smallest = chord;
  }
  return Number.isFinite(smallest) ? smallest : spacing;
}

/**
 * Resolve a measured train against the track it has to run on. A train longer
 * than its route would pile its cars on an endpoint, so the count is clamped to
 * what fits — visibly, in the emitted config, rather than by overrunning.
 */
export function resolveCoasterCars(path: CoasterPath, cars: CoasterRoute['cars']): CoasterRuntimeRoute['cars'] {
  if (!cars) return { count: 1, spacing: 0, extent: 0, heading: 0 };
  if (!Number.isInteger(cars.count) || cars.count < 1 || cars.count > COASTER_MAX_CARS) {
    throw new Error(`Coaster train car count must be an integer in [1, ${COASTER_MAX_CARS}], received ${cars.count}.`);
  }
  if (cars.count === 1) return { count: 1, spacing: 0, extent: 0, heading: 0 };
  if (!Number.isFinite(cars.spacing) || cars.spacing <= 0) {
    throw new Error('Coaster train car spacing must be a finite positive number of blocks.');
  }
  const fits = Math.max(1, Math.min(cars.count, Math.floor(path.length / cars.spacing)));
  if (fits === 1) return { count: 1, spacing: 0, extent: 0, heading: 0 };
  return { count: fits, spacing: cars.spacing, extent: (fits - 1) * cars.spacing,
    minChord: minimumCoupledChord(path, cars.spacing), heading: 0 };
}

// ─── Small geometry helpers (config time; the runtime carries its own) ───────

const sub3 = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const add3 = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const mul3 = (a: readonly number[], s: number): Vec3 => [a[0]! * s, a[1]! * s, a[2]! * s];
const len3 = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
const round3 = (v: number): number => Math.round(v * 1000) / 1000 || 0;
const roundV = (v: readonly number[]): Vec3 => [round3(v[0]!), round3(v[1]!), round3(v[2]!)];

/** Arc distance of the nearest point of a polyline (with cumulative arcs) to `p`, and the straight-line distance. */
export function projectArcOnPolyline(points: readonly (readonly number[])[], cumulative: readonly number[], p: readonly number[]): { arc: number; distance: number } {
  let best = { arc: 0, distance: Infinity };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, ab = sub3(b, a);
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    if (len2 <= 0) continue;
    const t = Math.max(0, Math.min(1, ((p[0]! - a[0]!) * ab[0] + (p[1]! - a[1]!) * ab[1] + (p[2]! - a[2]!) * ab[2]) / len2));
    const q = add3(a, mul3(ab, t));
    const d = len3(sub3(p, q));
    if (d < best.distance) best = { arc: cumulative[i - 1]! + Math.sqrt(len2) * t, distance: d };
  }
  return best;
}

// ─── The set's own cars: canonical frame and type plan ───────────────────────

const det3 = (m: readonly number[]): number =>
  m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
const mulM = (a: readonly number[], b: readonly number[]): number[] => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
};
const applyM = (m: readonly number[], v: readonly number[]): Vec3 => [
  m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
  m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
  m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
];
const transposeM = (m: readonly number[]): number[] => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Express a detected car's bricks (and its rider's) in the car's canonical
 * frame: travel along +X, up along -Y (LDraw), the running datum at the
 * origin. The detector's frame already has the chassis's long axis as local X
 * and LDraw up as local -Y; a mirrored source frame (Studio reflections carry
 * det -1) is made proper by flipping local Z, so the compiled car is never a
 * mirror image of the placed one. The datum is `originAboveDatumLdu` under the
 * chassis origin along the car's up, i.e. at local +Y.
 */
export function canonicalCoasterCar(car: CoasterCar, bricks: readonly ParsedBrick[], originAboveDatumLdu: number): { bricks: ParsedBrick[]; rider: ParsedBrick[]; seatLdu?: Vec3 } {
  const rot = car.frame.rot.length === 9 ? car.frame.rot : IDENTITY;
  const mirror = det3(rot) < 0 ? -1 : 1;
  const proper = [...rot];
  proper[2] *= mirror; proper[5] *= mirror; proper[8] *= mirror;
  const toLocal = transposeM(proper);
  const origin = car.frame.originLdu;
  const datum: Vec3 = [0, originAboveDatumLdu, 0];
  const convert = (index: number): ParsedBrick => {
    const b = bricks[index]!;
    const p = sub3(applyM(toLocal, sub3([b.x, b.y, b.z], origin)), datum);
    const r = mulM(toLocal, b.rot && b.rot.length === 9 ? b.rot : IDENTITY);
    return { ...b, x: p[0], y: p[1], z: p[2], rot: r };
  };
  const seat = car.seats[0];
  return {
    bricks: car.bricks.map(convert),
    rider: seat ? seat.riderBricks.map(convert) : [],
    ...(seat ? { seatLdu: sub3([seat.localLdu[0], seat.localLdu[1], seat.localLdu[2] * mirror], datum) } : {}),
  };
}

/** A pose-stable key for a group of canonical placements: part, colour and pose to 0.1 LDU / 0.001. */
function placementSignature(bricks: readonly ParsedBrick[]): string {
  const q = (v: number, step: number): number => Math.round(v / step) * step || 0;
  return bricks.map(b => `${b.part.toLowerCase()}|${b.color}|${q(b.x, .1)},${q(b.y, .1)},${q(b.z, .1)}|${(b.rot ?? IDENTITY).map(v => q(v, .001)).join(',')}`).sort().join(';');
}

/** One emitted entity type: a car body shared by every car with the same bricks, with the rider variants seen in those cars. */
export interface CoasterVehicleType {
  typeId: string;
  /** Pack-file stem (the type id without its namespace). */
  id: string;
  chassis: string;
  bricks: ParsedBrick[];
  /** Distinct posed riders across the cars of this type (canonical frame); index = the `craftmatic:rider` property value. */
  riders: ParsedBrick[][];
  seatLdu?: Vec3;
  /** Routes and car counts that use this type, for the label and diagnostics. */
  cars: number;
}

export interface CoasterVehiclePlan {
  types: CoasterVehicleType[];
  /** Per route (parallel to the input): the train's slots by DECREASING arc (slot 0 leads at `centre + extent/2`), or undefined for the fabricated cart. */
  routes: Array<{ slots: CoasterCarSlot[]; spacing: number; pitches: number[]; heading: 1 | -1; datumArcs: number[]; headingsAgree: boolean } | undefined>;
}

const stripNamespace = (typeId: string): string => typeId.includes(':') ? typeId.slice(typeId.indexOf(':') + 1) : typeId;
/** The stem the set's own coaster entities are named from: the cart's id without its `_cart` suffix. */
const coasterTypeStem = (typeId: string): string => typeId.replace(/_cart$/, '');

/**
 * Group every route's cars into entity types by their body signature and
 * assign rider variants. Deterministic: types are numbered in first-seen order
 * across routes, so the same set always ships the same ids.
 */
export function planCoasterVehicles(typeId: string, routes: readonly CoasterRoute[]): CoasterVehiclePlan {
  const stem = coasterTypeStem(typeId);
  const types: CoasterVehicleType[] = [];
  const byBody = new Map<string, CoasterVehicleType>();
  const riderIndex = new Map<CoasterVehicleType, Map<string, number>>();
  const planned = routes.map(route => {
    const vehicles = route.vehicles;
    if (!vehicles || !vehicles.length) return undefined;
    // Cumulative arcs of the route, to place each car by its datum point.
    const cumulative = [0];
    for (let i = 1; i < route.points.length; i++) cumulative.push(cumulative[i - 1]! + len3(sub3(route.points[i]!, route.points[i - 1]!)));
    const placed = vehicles.map(car => ({ car, arc: projectArcOnPolyline(route.points, cumulative, car.datumPoint).arc }));
    // Slot 0 is the car at the HIGHEST arc: the runtime puts slot k at `centre + extent/2 - k * spacing`.
    placed.sort((a, b) => b.arc - a.arc);
    const kept = placed.slice(0, COASTER_MAX_CARS);
    const pitches = kept.slice(1).map((entry, k) => round3(kept[k]!.arc - entry.arc));
    const spacing = pitches.length ? round3(pitches.reduce((s, v) => s + v, 0) / pitches.length) : 0;
    const votes = kept.reduce((sum, entry) => sum + entry.car.heading, 0);
    const heading: 1 | -1 = votes < 0 ? -1 : 1;
    const slots = kept.map(({ car }, k) => {
      const body = placementSignature(car.bricks);
      let type = byBody.get(body);
      if (!type) {
        const n = types.length + 1;
        type = { typeId: `${stem}_vehicle_${n}`, id: `${stripNamespace(stem)}_vehicle_${n}`, chassis: car.chassis, bricks: car.bricks, riders: [], cars: 0, ...(car.seatLdu ? { seatLdu: car.seatLdu } : {}) };
        types.push(type); byBody.set(body, type); riderIndex.set(type, new Map());
      }
      if (!type.seatLdu && car.seatLdu) type.seatLdu = car.seatLdu;
      type.cars++;
      let rider = -1;
      if (car.rider.length) {
        const variants = riderIndex.get(type)!;
        const key = placementSignature(car.rider);
        rider = variants.get(key) ?? (variants.set(key, type.riders.length), type.riders.push(car.rider) - 1);
      }
      return { type: type.typeId, rider, label: kept.length > 1 ? `${route.label} Car ${k + 1}` : `${route.label} Ride Car` };
    });
    return { slots, spacing, pitches, heading, datumArcs: kept.map(entry => round3(entry.arc)), headingsAgree: kept.every(entry => entry.car.heading === heading) };
  });
  // A car with no rider on a type that has variants still needs a value the
  // property accepts: `riders.length` is the "none" variant (no bone matches).
  for (const plan of planned) if (plan) for (const slot of plan.slots) {
    if (slot.rider < 0) slot.rider = types.find(t => t.typeId === slot.type)!.riders.length;
  }
  return { types, routes: planned };
}

// ─── Lift-extended route ─────────────────────────────────────────────────────

/** Points from `a` (excluded) to `b` (included) at most `maxSpacing` apart. */
function subdivide(a: readonly number[], b: readonly number[], maxSpacing: number): Vec3[] {
  const n = Math.max(1, Math.ceil(len3(sub3(b, a)) / maxSpacing));
  return Array.from({ length: n }, (_, k) => add3(a, mul3(sub3(b, a), (k + 1) / n)));
}

/** A route (open, with a platform lift parked at its `end` terminal) reversed so the deck sits at arc 0. */
function reverseRoute(route: CoasterRoute): CoasterRoute {
  const cumulative = [0];
  for (let i = 1; i < route.points.length; i++) cumulative.push(cumulative[i - 1]! + len3(sub3(route.points[i]!, route.points[i - 1]!)));
  const total = cumulative.at(-1)!;
  const lift = route.lift;
  return {
    ...route,
    points: [...route.points].reverse(),
    ...(route.vehicles ? { vehicles: route.vehicles.map(car => ({ ...car, heading: car.heading === 1 ? -1 : 1 })) } : {}),
    ...(lift?.kind === 'chain' ? { lift: { ...lift, arcStart: total - lift.arcEnd, arcEnd: total - lift.arcStart, climbDirection: lift.climbDirection === 1 ? -1 : 1 } } : {}),
    ...(lift?.kind === 'platform' ? { lift: { ...lift, parkedEnd: 'start' as const } } : {}),
  };
}

/** Validate routes before putting them in an executable add-on. */
export function coasterRuntimeConfig(typeId: string, routes: CoasterRoute[]): CoasterRuntimeConfig {
  if (routes.length > 16) throw new Error('At most 16 independent coaster routes are supported per pack.');
  // A platform lift docked at the far terminal: reverse the route, so every
  // lift route reads the same way (deck at arc 0, the ride heading toward it).
  const oriented = routes.map(route => route.lift?.kind === 'platform' && route.lift.parkedEnd === 'end' ? reverseRoute(route) : route);
  const plan = planCoasterVehicles(typeId, oriented);
  const types: Record<string, CoasterRuntimeType> = { [typeId]: { role: 'car', riders: 0 } };
  for (const type of plan.types) types[type.typeId] = { role: 'car', riders: type.riders.length };
  const stem = coasterTypeStem(typeId);
  const runtimeRoutes = oriented.map((route, index): CoasterRuntimeRoute => {
    const lift = route.lift;
    if (lift?.kind === 'platform' && route.closed) throw new Error(`${route.label}: a platform lift belongs to an open route; this one is closed.`);
    const routePath = buildCoasterPath(route.points, route.closed, route.maxSegmentLength);
    const routeStation = findCoasterStation(routePath);
    const vehicles = plan.routes[index];
    // The measured train: the set's cars, or the rider-measured `cars`, or one cart.
    let cars: CoasterRuntimeRoute['cars'];
    if (vehicles) {
      const count = vehicles.slots.length;
      cars = count > 1
        ? { count, spacing: vehicles.spacing, extent: round3((count - 1) * vehicles.spacing), minChord: minimumCoupledChord(routePath, vehicles.spacing), heading: vehicles.heading, slots: vehicles.slots }
        : { count: 1, spacing: 0, extent: 0, heading: vehicles.heading, slots: vehicles.slots };
    } else cars = resolveCoasterCars(routePath, route.cars);
    let path = routePath, station = routeStation, deckLength = 0;
    let runtimeLift: CoasterRuntimeLift | undefined;
    if (lift?.kind === 'platform') {
      // Deck at the parked pose before arc 0, and translated after the far end.
      const [far, terminal] = lift.deck;
      deckLength = len3(sub3(terminal, far));
      if (!(deckLength > 0)) throw new Error(`${route.label}: the platform deck has no length.`);
      const first = route.points[0]!, last = route.points.at(-1)!;
      const dockSlip = len3(sub3(terminal, first)), deliverySlip = len3(sub3(add3(far, lift.travel), last));
      const slack = Math.max(0.05, route.maxSegmentLength / 4);
      if (dockSlip > slack) throw new Error(`${route.label}: the parked deck ends ${round3(dockSlip)} blocks from the route's first point; it must be snapped onto the terminal.`);
      if (deliverySlip > slack) throw new Error(`${route.label}: the delivered deck ends ${round3(deliverySlip)} blocks from the route's last point; both docks must be snapped onto their terminals.`);
      const before = [far, ...subdivide(far, terminal, route.maxSegmentLength).slice(0, -1)];
      const after = subdivide(last, add3(terminal, lift.travel), route.maxSegmentLength);
      // The join between the last deck sample and the route's first point is
      // one deck spacing plus the (bounded) dock slip.
      path = buildCoasterPath([...before, ...route.points, ...after], false, route.maxSegmentLength + slack);
      const shift = path.cumulative[before.length]!;
      station = { ...routeStation, start: routeStation.start + shift, end: routeStation.end + shift, stop: routeStation.stop + shift };
      deckLength = shift;
      runtimeLift = {
        type: `${stem}_lift_${index + 1}`, deckLength: round3(deckLength), travel: [round3(lift.travel[0]), round3(lift.travel[1]), round3(lift.travel[2])],
        parkedPoint: [round3(lift.parkedPoint[0]), round3(lift.parkedPoint[1]), round3(lift.parkedPoint[2])],
        ...(lift.counterweight ? { counterweightType: `${stem}_counterweight_${index + 1}`, counterweightPoint: roundV(lift.counterweight.point) as [number, number, number] } : {}),
      };
      types[runtimeLift.type] = { role: 'platform', riders: 0 };
      if (runtimeLift.counterweightType) types[runtimeLift.counterweightType] = { role: 'counterweight', riders: 0 };
    }
    // Ride direction: a closed circuit with a chain drive runs the way the
    // chain climbs; a closed circuit without one runs the way its cars face; an
    // open route with a platform runs toward the parked deck; any other open
    // route shuttles (direction 0: the runtime keeps whichever way it was going).
    const direction: 1 | -1 | 0 = lift?.kind === 'chain' && route.closed ? lift.climbDirection
      : route.closed ? (cars.heading || 1)
      : lift?.kind === 'platform' ? -1 : 0;
    return {
      label: route.label, path, up: buildCoasterFrames(path), maxSpacing: coasterMaxSpacing(path), station, cars, direction,
      ...(lift?.kind === 'chain' ? { chain: { start: round3(Math.min(lift.arcStart, lift.arcEnd) + deckLength), end: round3(Math.max(lift.arcStart, lift.arcEnd) + deckLength) } } : {}),
      ...(runtimeLift ? { lift: runtimeLift } : {}),
    };
  });
  return { typeId, routes: runtimeRoutes, types };
}

// ─── Pack assets ─────────────────────────────────────────────────────────────

/** A purpose-built ride vehicle for a route whose source has no car of its own. The imported set stays intact. */
export function coasterCartAssets(typeId: string, modelScale = 1) {
  if (!Number.isFinite(modelScale) || modelScale <= 0 || modelScale > 4) throw new Error('Coaster cart export scale must be in (0, 4].');
  // The drawn cart spans -6.6..+7 entity units about its origin (13.6 units =
  // 0.85 blocks). A 0.6-high box left the top of the tub and the seated rider
  // outside the interact target, which is what a player has to aim at to board;
  // 0.9 covers the whole body. Hit target only: `has_collision` is false.
  const collision = { width: 1.375 * modelScale, height: 0.9 * modelScale };
  const rideable = { seat_count: 1, family_types: ['player'], interact_text: 'Ride the coaster',
    crouching_skip_interact: true, seats: { position: [0, 0.35 * modelScale, 0], lock_rider_rotation: 181 } };
  const geometryId = `geometry.${typeId.replace(':', '.')}`;
  const animationId = `animation.${typeId.replace(':', '.')}.track_pitch`;
  return {
    behavior: withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
      description: { identifier: typeId, is_spawnable: false, is_summonable: true,
        properties: {
          // Float actor properties MUST serialize with a decimal point or Bedrock
          // drops the whole property component; see `bedrock-json.ts`.
          [PROP_PITCH]: floatActorProperty([-90, 90], 0),
          [PROP_ROLL]: floatActorProperty([-180, 180], 0),
        } },
      components: {
        'minecraft:type_family': { family: [COASTER_FAMILY] },
        'minecraft:persistent': {}, 'minecraft:nameable': {},
        'minecraft:health': { value: 20, max: 20 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': collision,
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:rideable': rideable,
      },
    } }, collision, rideable),
    client: { format_version: '1.10.0', 'minecraft:client_entity': { description: {
      identifier: typeId, materials: { default: 'entity_alphatest' },
      textures: { default: 'textures/entity/craftmatic_coaster' }, geometry: { default: geometryId },
      animations: { track_pitch: animationId }, scripts: { animate: ['track_pitch'] },
      render_controllers: ['controller.render.default'],
    } } },
    geometry: { format_version: '1.12.0', 'minecraft:geometry': [{
      description: { identifier: geometryId, texture_width: 2, texture_height: 2,
        visible_bounds_width: 8 * modelScale, visible_bounds_height: 8 * modelScale, visible_bounds_offset: [0, 0, 0] },
      // Separate pitch/roll bones make composition explicit, independent of
      // the engine's Euler order. The entity itself only rotates in yaw.
      bones: [{ name: 'track_pitch', pivot: [0, 0, 0], cubes: [] as Array<{ origin: number[]; size: number[]; uv: number[] }> },
      { name: 'cart', parent: 'track_pitch', pivot: [0, 0, 0], cubes: [
        { origin: [-11, 0, -10], size: [22, 2, 20], uv: [0, 0] },
        { origin: [-11, 2, -10], size: [1, 4, 20], uv: [0, 0] },
        { origin: [10, 2, -10], size: [1, 4, 20], uv: [0, 0] },
        { origin: [-10, 2, -10], size: [20, 5, 1], uv: [0, 0] },
        { origin: [-10, 2, 9], size: [20, 3, 1], uv: [0, 0] },
        // Standard rails are 60 LDU apart: wheel centres ±9 entity units.
        // The running datum is 32 LDU above sleepers, rail tops 10 LDU:
        // wheels reach down 22 LDU = 6.6 entity units, avoiding a floating tub.
        ...[-11, 7].flatMap(x => [-8, 4].map(z => ({ origin: [x, -6.6, z], size: [4, 6.6, 4], uv: [0, 0] }))),
      ].map(cube => ({ ...cube, origin: cube.origin.map(v => v * modelScale), size: cube.size.map(v => v * modelScale) })) }],
    }] },
    animations: { format_version: '1.8.0', animations: { [animationId]: {
      loop: true, bones: {
        track_pitch: { rotation: [`query.property('${PROP_PITCH}')`, 0, 0] },
        cart: { rotation: [0, 0, `query.property('${PROP_ROLL}')`] },
      },
    } } },
  };
}

/** Client animation bindings, in the shape `playable-addon.ts`'s `clientEntity` takes. */
export interface CoasterClientAnimations { animations: Record<string, string>; animate: Array<string | Record<string, string>> }

/** A brick-compiled coaster entity, for `emitCompiledEntity` in `playable-addon.ts`. */
export interface CoasterCompiledEntity {
  id: string;
  typeId: string;
  role: 'car' | 'platform' | 'counterweight';
  label: string;
  geo: CompiledLdrawGeometry;
  behavior: unknown;
  animations?: CoasterClientAnimations;
  /** Body cuboids, rider cuboids (all variants) — both resident. */
  cuboids: number;
  riderCuboids: number;
  riders: number;
}

export interface CoasterRideDeps {
  namespace: string;
  label: string;
  /** Pack folder prefixes (`Craftmatic_x_BP/`, `…_RP/`). */
  bp: string;
  rp: string;
  modelScale: number;
  unitsPerLdu: number;
  quality: LegoEntityQualityName | Partial<LegoEntityQuality>;
  pbr: boolean;
  partGeometry?: PartGeometryProvider;
  onProgress?: (phase: string, pct?: number) => void;
}

export interface CoasterRideAssets {
  compiled: CoasterCompiledEntity[];
  /** Files the caller pushes as they are: the fabricated cart (when a route needs it), the car animations, the runtime script and the readme. */
  files: Array<{ name: string; data: Uint8Array }>;
  actors: PlacementActor[];
  names: Array<{ identifier: string; label: string }>;
  warnings: string[];
  /** The fabricated cart's cuboids (0 when every route runs the set's own cars). */
  cartCuboids: number;
  /** Cuboids of the compiled cars, platforms and counterweights (each type once). */
  vehicleCuboids: number;
  /** Entity types shipped: the cart (if any) plus every compiled type. */
  entityTypes: number;
  cartTypeUsed: boolean;
}

const enc = new TextEncoder();
const textBytes = (s: string): Uint8Array => enc.encode(s.endsWith('\n') ? s : `${s}\n`);
const jsonBytes = (v: unknown): Uint8Array => textBytes(bedrockJsonText(v, 2));

/** Wrap every root bone of every mesh under `track_pitch` → `track_roll`, pivoted at the entity origin (the running datum). */
function wrapTrackBones(geo: CompiledLdrawGeometry): void {
  const geometries = (geo.value as { 'minecraft:geometry': Array<{ bones: Array<{ name: string; parent?: string; pivot: number[]; cubes: unknown[] }> }> })['minecraft:geometry'];
  for (const geometry of geometries) {
    for (const bone of geometry.bones) if (!bone.parent) bone.parent = 'track_roll';
    geometry.bones.unshift(
      { name: 'track_pitch', pivot: [0, 0, 0], cubes: [] },
      { name: 'track_roll', parent: 'track_pitch', pivot: [0, 0, 0], cubes: [] },
    );
  }
}

/** Count the cuboids of a compiled geometry, split by bone prefix. */
function countCuboids(geo: CompiledLdrawGeometry, riderPrefix = 'rider_'): { total: number; rider: number } {
  let total = 0, rider = 0;
  const geometries = (geo.value as { 'minecraft:geometry': Array<{ bones: Array<{ name: string; parent?: string; cubes: unknown[] }> }> })['minecraft:geometry'];
  for (const geometry of geometries) {
    const parents = new Map(geometry.bones.map(b => [b.name, b.parent]));
    const underRider = (name: string): boolean => { for (let n: string | undefined = name; n; n = parents.get(n)) if (n.startsWith(riderPrefix)) return true; return false; };
    for (const bone of geometry.bones) { total += bone.cubes.length; if (underRider(bone.name)) rider += bone.cubes.length; }
  }
  return { total, rider };
}

/** The rideable ride-car behaviour: the fabricated cart's, with the compiled body's hit box and the measured seat. */
function carBehavior(typeId: string, riders: number, collision: { width: number; height: number }, seat: [number, number, number]): unknown {
  const rideable = { seat_count: 1, family_types: ['player'], interact_text: 'Ride the coaster',
    crouching_skip_interact: true, seats: { position: seat, lock_rider_rotation: 181 } };
  return withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
    description: { identifier: typeId, is_spawnable: false, is_summonable: true,
      properties: {
        [PROP_PITCH]: floatActorProperty([-90, 90], 0),
        [PROP_ROLL]: floatActorProperty([-180, 180], 0),
        // Which posed rider this car carries (`riders` = none), and whether a
        // player is in the seat: the rider bone is hidden while it is.
        ...(riders ? { [PROP_RIDER]: { type: 'int', range: [0, riders], default: 0, client_sync: true }, [PROP_OCCUPIED]: { type: 'bool', default: false, client_sync: true } } : {}),
      } },
    components: {
      'minecraft:type_family': { family: [COASTER_FAMILY] },
      'minecraft:persistent': {}, 'minecraft:nameable': {},
      'minecraft:health': { value: 20, max: 20 },
      'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
      'minecraft:fire_immune': {},
      'minecraft:collision_box': collision,
      'minecraft:physics': { has_gravity: false, has_collision: false },
      'minecraft:rideable': rideable,
    },
  } }, collision, rideable);
}

/** The platform / counterweight: a moving prop the runtime teleports; nothing rides it, nothing hurts it. */
function liftBehavior(typeId: string, collision: { width: number; height: number }): unknown {
  return withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
    description: { identifier: typeId, is_spawnable: false, is_summonable: true },
    components: {
      'minecraft:type_family': { family: [COASTER_FAMILY] },
      'minecraft:persistent': {}, 'minecraft:nameable': {},
      'minecraft:health': { value: 100, max: 100 },
      'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
      'minecraft:fire_immune': {},
      'minecraft:collision_box': collision,
      'minecraft:physics': { has_gravity: false, has_collision: false },
      'minecraft:pushable_by_block': {},
      'minecraft:knockback_resistance': { value: 1 },
    },
  } }, collision);
}

/** The car's track animation: pitch/roll bones from the synced properties, rider variants shown by `craftmatic:rider` and hidden by `craftmatic:occupied`. */
function carAnimation(animationId: string, riders: number): unknown {
  const bones: Record<string, unknown> = {
    track_pitch: { rotation: [`query.property('${PROP_PITCH}')`, 0, 0] },
    track_roll: { rotation: [0, 0, `query.property('${PROP_ROLL}')`] },
  };
  for (let k = 0; k < riders; k++) {
    bones[`rider_${k}`] = { scale: `query.property('${PROP_RIDER}') == ${k} && !query.property('${PROP_OCCUPIED}') ? 1.0 : 0.0` };
  }
  return { format_version: '1.8.0', animations: { [animationId]: { loop: true, bones } } };
}

const COASTER_README = (own: boolean, lift: boolean): string => [
  'Measured-track coaster rides', '',
  own
    ? "The set's own cars are the ride: each car's LEGO bricks are the rideable vehicle, its posed rider sits in it until you take the seat, and it runs continuously on the measured track and brakes to a stop at the flat reload zone. Walk up to a car while the train is stopped and tap to ride; it departs two seconds after you board, and stops at the station on every lap. Sneak to dismount."
    : 'The grey Ride Cart runs continuously on the measured track and brakes to a stop at the flat reload zone. Walk up to it while it is stopped and tap to ride; it departs two seconds after you board, and stops at the station on every lap. Sneak to dismount.',
  'It rolls on gravity - slow up a climb, fast on a drop - with a chain lift on the steep ascent where the set has one. Closed measured tracks circulate; open tracks reverse at their real ends, never teleport across missing segments. The car follows the source track in 3D; the player stays upright (no upside-down player roll). A set whose cars form a train runs them as one train; any car can be boarded.',
  ...(lift ? ["The set's own lift completes the circuit: the train rolls onto the platform, which carries it up its measured travel (its counterweight sinks opposite) and lets it go at the top. The platform returns for the next lap; a train that arrives first waits at the foot."] : []),
  own ? "Cars with no track of their own stay where the set parked them. Undo/re-place removes the ride cars and lift. Motion pauses at unloaded chunks." : 'Imported display cars remain part of the source scenery; the grey cart is an added ride mechanism, not replacement LEGO geometry. Undo/re-place removes the old ride cart. Motion pauses at unloaded chunks.',
].join('\n');

/**
 * Everything a pack needs for its coaster rides: the set's own cars, platforms
 * and counterweights compiled from their bricks (returned for the caller's
 * `emitCompiledEntity`, which owns swatches, render controllers and LOD), the
 * fabricated cart where a route has no car, the placement actors, and the
 * runtime script.
 */
export async function buildCoasterRideAssets(config: CoasterRuntimeConfig, routes: readonly CoasterRoute[], deps: CoasterRideDeps): Promise<CoasterRideAssets> {
  const { bp, rp, label } = deps;
  const oriented = routes.map(route => route.lift?.kind === 'platform' && route.lift.parkedEnd === 'end' ? reverseRoute(route) : route);
  const plan = planCoasterVehicles(config.typeId, oriented);
  const compiled: CoasterCompiledEntity[] = [];
  const files: CoasterRideAssets['files'] = [];
  const actors: PlacementActor[] = [];
  const names: CoasterRideAssets['names'] = [];
  const warnings: string[] = [];
  const cartTypeUsed = config.routes.some(route => !route.cars.slots);
  let cartCuboids = 0, vehicleCuboids = 0;
  if (cartTypeUsed) {
    const cartId = stripNamespace(config.typeId);
    const cart = coasterCartAssets(config.typeId, deps.modelScale);
    cartCuboids = cart.geometry['minecraft:geometry'].reduce((total, geometry) => total + geometry.bones.reduce((sum, bone) => sum + bone.cubes.length, 0), 0);
    files.push(
      { name: `${bp}entities/${cartId}.json`, data: jsonBytes(cart.behavior) },
      { name: `${rp}entity/${cartId}.entity.json`, data: jsonBytes(cart.client) },
      { name: `${rp}models/entity/${cartId}.geo.json`, data: textBytes(bedrockJsonText(cart.geometry)) },
      { name: `${rp}animations/${cartId}.animation.json`, data: jsonBytes(cart.animations) },
    );
    names.push({ identifier: config.typeId, label: `${label} Ride Cart` });
  }
  // ── The set's own cars, one compile per type ──
  const carFrame = ldrawToRenderRotation('+x');
  for (const type of plan.types) {
    deps.onProgress?.(`compiling ${label} ${type.chassis} ride car`);
    const bricks: ParsedBrick[] = [...type.bricks];
    const boneOf: string[] = type.bricks.map(() => 'body');
    const rigBones: EntityRig['bones'] = [];
    type.riders.forEach((rider, k) => {
      rigBones.push({ name: `rider_${k}`, parent: 'body', pivotLdu: [0, 0, 0] });
      for (const b of rider) { bricks.push(b); boneOf.push(`rider_${k}`); }
    });
    const geo = await compileLdrawEntityGeometry(type.id, 'prop', bricks, {
      scale: deps.unitsPerLdu, frame: [...carFrame], wholeModel: true, originLdu: [0, 0, 0], partGeometry: deps.partGeometry,
      quality: deps.quality, pbr: deps.pbr, ...(rigBones.length ? { rig: { bones: rigBones, boneOf } } : {}),
    });
    wrapTrackBones(geo);
    const counted = countCuboids(geo);
    vehicleCuboids += counted.total;
    // The measured seat: the rider's hips joint through the car frame, then the
    // compiler's own seated-eye rule so the player sits where the figure sat.
    let seat: [number, number, number] = [0, Math.max(0.3, round3(geo.sizeBlocks.height * 0.35)), 0];
    if (type.seatLdu) {
      const eye = applyM(carFrame, add3(type.seatLdu, [0, -RIDER_EYE_ABOVE_HIPS_LDU, 0]));
      const units = mul3(eye, deps.unitsPerLdu);
      seat = [Math.abs(units[0] / 16) < 0.3 ? 0 : round3(units[0] / 16), Math.max(0.3, round3(units[1] / 16 - SEATED_EYE_HEIGHT_BLOCKS)), round3(units[2] / 16)];
    } else warnings.push(`${label}: ${type.chassis} ride car has no measured seat (no posed rider on this chassis); the player sits at the car's mid height.`);
    const animationId = `animation.${type.typeId.replace(':', '.')}.track`;
    files.push({ name: `${rp}animations/${type.id}.animation.json`, data: jsonBytes(carAnimation(animationId, type.riders.length)) });
    compiled.push({
      id: type.id, typeId: type.typeId, role: 'car', label: `${label} ${type.chassis.replace(/\.dat$/i, '')} car`, geo,
      behavior: carBehavior(type.typeId, type.riders.length, geo.collisionBox, seat),
      animations: { animations: { track: animationId }, animate: ['track'] },
      cuboids: counted.total, riderCuboids: counted.rider, riders: type.riders.length,
    });
    names.push({ identifier: type.typeId, label: `${label} Ride Car` });
    warnings.push(...geo.warnings.filter(w => !/front\/rear direction/.test(w)));
  }
  // ── Platforms and counterweights ──
  for (const [index, route] of config.routes.entries()) {
    const source = oriented[index]!;
    const lift = route.lift, data = source.lift;
    if (!lift || data?.kind !== 'platform') continue;
    deps.onProgress?.(`compiling ${label} lift platform`);
    const compileStatic = async (id: string, typeId: string, role: 'platform' | 'counterweight', bricks: ParsedBrick[], originLdu: Vec3, entityLabel: string) => {
      const geo = await compileLdrawEntityGeometry(id, 'prop', bricks, {
        scale: deps.unitsPerLdu, frame: [...SHELL_FRAME], wholeModel: true, originLdu, partGeometry: deps.partGeometry, quality: deps.quality, pbr: deps.pbr,
      });
      const counted = countCuboids(geo);
      vehicleCuboids += counted.total;
      compiled.push({ id, typeId, role, label: entityLabel, geo, behavior: liftBehavior(typeId, geo.collisionBox), cuboids: counted.total, riderCuboids: 0, riders: 0 });
      names.push({ identifier: typeId, label: entityLabel });
      warnings.push(...geo.warnings.filter(w => !/front\/rear direction/.test(w)));
    };
    await compileStatic(stripNamespace(lift.type), lift.type, 'platform', data.bricks, data.originLdu, `${label} Lift`);
    actors.push({ typeId: lift.type, label: `${route.label} Lift`, x: lift.parkedPoint[0], y: lift.parkedPoint[1], z: lift.parkedPoint[2], yaw: 0, coasterRouteIndex: index });
    if (lift.counterweightType && data.counterweight && lift.counterweightPoint) {
      await compileStatic(stripNamespace(lift.counterweightType), lift.counterweightType, 'counterweight', data.counterweight.bricks, data.counterweight.originLdu, `${label} Counterweight`);
      actors.push({ typeId: lift.counterweightType, label: `${route.label} Counterweight`, x: lift.counterweightPoint[0], y: lift.counterweightPoint[1], z: lift.counterweightPoint[2], yaw: 0, coasterRouteIndex: index });
    }
    const m = data.measured;
    const trainLength = route.cars.extent + (route.cars.spacing || 0);
    if (trainLength > lift.deckLength) warnings.push(`${route.label}: the ${route.cars.count}-car train spans ${round3(trainLength)} blocks and the lift deck is ${lift.deckLength} blocks long, so the cars overhang the platform while it moves (measured, not clamped).`);
    warnings.push(`${route.label}: the set's own ${m.members}-part lift platform (deck ${round3(m.deckLengthLdu)} LDU, tilt ${m.tiltDeg}°) rides ${round3(m.travelLdu)} LDU between its terminals (authored travel ${round3(m.axisDistanceLdu)}, terminal-to-terminal ${round3(m.betweenTerminalsLdu)}; parked pose snapped ${round3(m.parkedMisfitLdu)} LDU onto its dock, delivery ${round3(m.deliveredMisfitLdu)})${data.counterweight ? `, with its ${data.counterweight.bricks.length}-part counterweight moving opposite` : ''}.`);
  }
  // ── Car actors: one per slot, all at the station point ──
  config.routes.forEach((route, index) => {
    const p = route.station.point;
    const { count } = route.cars;
    const plannedRoute = plan.routes[index];
    for (let car = 0; car < count; car++) {
      const slot = route.cars.slots?.[car];
      const carLabel = slot?.label ?? (count > 1 ? `${route.label} Car ${car + 1}` : `${route.label} Ride Cart`);
      actors.push({ typeId: slot?.type ?? config.typeId, label: carLabel, x: p[0], y: p[1], z: p[2], coasterRouteIndex: index, coasterCarIndex: car });
    }
    if (plannedRoute && !plannedRoute.headingsAgree) warnings.push(`${route.label}: its cars do not all face the same way along the track; the train faces the majority's way (${route.cars.heading === 1 ? 'with' : 'against'} the route's arc).`);
    if (route.cars.slots && route.direction && route.cars.heading && route.direction !== route.cars.heading) {
      warnings.push(`${route.label}: the cars face ${route.cars.heading === 1 ? 'with' : 'against'} the route's arc but the ride runs the other way (the chain climbs that way), so the train runs backwards as the set posed it.`);
    }
    if (route.cars.minChord !== undefined && !route.cars.slots && route.cars.minChord < COASTER_CAR_LENGTH) {
      warnings.push(`${route.label}: the ${count}-car train at a ${route.cars.spacing}-block pitch closes to a ${round3(route.cars.minChord)}-block chord between coupled cars somewhere on the route, under the ${COASTER_CAR_LENGTH}-block car length, so the cars will visibly intersect there (craftmatic-diagnostics.json coaster.routes[].cars).`);
    }
  });
  const own = plan.types.length > 0, lifted = config.routes.some(route => route.lift);
  files.push(
    { name: `${bp}scripts/coaster.js`, data: textBytes(coasterScript(config)) },
    { name: `${bp}COASTER.txt`, data: textBytes(COASTER_README(own, lifted)) },
  );
  const ownRoutes = config.routes.filter(route => route.cars.slots).length;
  warnings.push(`${config.routes.length} measured coaster route(s): ${ownRoutes ? `the set's own cars run ${ownRoutes === config.routes.length ? 'every route' : `${ownRoutes} of them`}${lifted ? ' and its lift completes the circuit' : ''}` : 'the grey Ride Cart runs on its own'} and stop at the reload zone — walk up and tap to ride. ${config.routes.some(route => !route.direction) ? 'Open tracks shuttle; riders' : 'Riders'} stay upright.`);
  return { compiled, files, actors, names, warnings, cartCuboids, vehicleCuboids, entityTypes: compiled.length + (cartTypeUsed ? 1 : 0), cartTypeUsed };
}

/** The `coaster` block of `craftmatic-diagnostics.json`. */
export function coasterDiagnostics(config: CoasterRuntimeConfig, assets: CoasterRideAssets): unknown {
  return {
    cuboids: assets.cartCuboids, vehicleCuboids: assets.vehicleCuboids, riderRoll: false, deviceVerified: false, carLength: COASTER_CAR_LENGTH,
    types: assets.compiled.map(entity => ({ id: entity.typeId, role: entity.role, cuboids: entity.cuboids, riderCuboids: entity.riderCuboids, riders: entity.riders, seat: (entity.behavior as any)?.['minecraft:entity']?.components?.['minecraft:rideable']?.seats?.position ?? null })),
    routes: config.routes.map(route => ({
      label: route.label, lengthBlocks: route.path.length, samples: route.path.points.length, closed: route.path.closed,
      station: { stop: route.station.stop, length: route.station.length, point: route.station.point },
      // The resolved train beside the station: count/spacing/extent in
      // model blocks; `minChord` is the tightest straight-line gap the
      // route leaves between coupled cars, reported and never clamped —
      // under `carLength` the fabricated cars intersect there.
      cars: { ...route.cars, ...(route.cars.minChord !== undefined ? { overlaps: route.cars.minChord < COASTER_CAR_LENGTH } : {}) },
      direction: route.direction,
      ...(route.chain ? { chain: route.chain } : {}),
      ...(route.lift ? { lift: route.lift } : {}),
    })),
  };
}

// ─── From the detector's measurements to routes the pack can build ──────────

/**
 * A stray car rides beside the tower as the hoist's counterweight when its
 * travel axis is parallel to the platform's and it stands within this lateral
 * distance of the platform's travel line (10303's pair is 335 LDU off it, on
 * the tower's own guide rails; a 24-stud tower footprint is 480).
 */
export const COUNTERWEIGHT_LATERAL_MAX_LDU = 480;
/** How far the stray's travel axis may deviate from the lift axis (cos 25°). */
const COUNTERWEIGHT_PARALLEL_MIN = 0.9;
/**
 * An open route shorter than this many train lengths is a SIDING: the cars
 * on it are parked display, not a second ride (10261's 480-LDU siding holds
 * a 252-LDU train; twice its length with a car is 756).
 */
export const PARKED_SIDING_FACTOR = 2;

export interface CoasterSceneRoutes {
  routes: CoasterRoute[];
  /** Indices (into the bricks handed in) of every placement that is now a ride car, rider, platform or counterweight: they leave the static shell. */
  movedIndices: Set<number>;
  /** Of those, the posed riders' figure parts (they also leave the NPC list). */
  riderIndices: Set<number>;
  /** Routes that were left out with their reason (a parked siding), by track label. */
  parked: Array<{ label: string; cars: number; reason: string }>;
  warnings: string[];
}

/** An LDraw vector (not a point) in grid blocks: LDraw Y down → grid Y up. */
export function sceneGridVector(frame: SceneGridFrame, v: readonly number[]): Vec3 {
  return [v[0]! / frame.cellXZ * frame.scale, -v[1]! / frame.cellY * frame.scale, v[2]! / frame.cellXZ * frame.scale];
}

/**
 * Turn the detector's cars, trains and lifts into per-route data for the
 * pack, in model blocks. Nothing is invented: a route with no detected car
 * gets a plain route (the caller keeps today's fabricated cart for it), a
 * platform is only emitted where one docks, and a chain lift only where its
 * sprockets were found. `bricks` are the scene placements the detector ran
 * over, so every index here refers to that array.
 */
export function coasterRoutesFromAssemblies(tracks: CoasterTrackExtraction, assemblies: CoasterAssemblies, bricks: readonly ParsedBrick[], frame: SceneGridFrame): CoasterSceneRoutes {
  const routes: CoasterRoute[] = [];
  const movedIndices = new Set<number>();
  const riderIndices = new Set<number>();
  const parked: CoasterSceneRoutes['parked'] = [];
  const warnings: string[] = [];
  const toBlocks = (p: readonly number[]): Vec3 => sceneGridPoint(frame, [p[0]!, p[1]!, p[2]!]);
  const usedStrays = new Set<string>();
  tracks.routes.forEach((track, routeIndex) => {
    const points = track.points.map(toBlocks);
    const maxSegmentLength = track.maxSegmentLengthLdu * frame.scale / Math.min(frame.cellXZ, frame.cellY);
    const base: CoasterRoute = { label: track.label, points, closed: track.closed, maxSegmentLength };
    // LDU arcs along this route, for the chain lift's span and the siding rule.
    const cumulativeLdu = [0];
    for (let i = 1; i < track.points.length; i++) cumulativeLdu.push(cumulativeLdu[i - 1]! + len3(sub3(track.points[i]!, track.points[i - 1]!)));
    const lengthLdu = cumulativeLdu.at(-1) ?? 0;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + len3(sub3(points[i]!, points[i - 1]!)));
    const ldrawPath = track.points.length > 1 ? buildCoasterPath(track.points, track.closed, track.maxSegmentLengthLdu + 1e-6) : undefined;
    /** A point at an LDU arc of this route, projected onto the block route. */
    const arcToBlocks = (arcLdu: number): number => ldrawPath ? projectArcOnPolyline(points, cumulative, toBlocks(sampleCoasterPath(ldrawPath, Math.max(0, Math.min(lengthLdu, arcLdu))).position)).arc : arcLdu * frame.scale / Math.min(frame.cellXZ, frame.cellY);

    // ── The route's own cars ──
    const cars = assemblies.cars.filter(car => car.route?.routeIndex === routeIndex).sort((a, b) => b.route!.arcLdu - a.route!.arcLdu);
    const train = assemblies.trains.find(t => t.routeIndex === routeIndex);
    let vehicles: CoasterRouteCar[] | undefined;
    if (cars.length) {
      const longest = Math.max(...cars.map(car => car.lengthLdu));
      const trainLength = (train?.extentLdu ?? 0) + Math.max(train?.meanPitchLdu ?? 0, longest);
      if (!track.closed && lengthLdu < PARKED_SIDING_FACTOR * trainLength) {
        parked.push({ label: track.label, cars: cars.length, reason: `an open ${round3(lengthLdu)}-LDU track holding a ${round3(trainLength)}-LDU train is a siding` });
        warnings.push(`${track.label}: its ${cars.length} car${cars.length === 1 ? '' : 's'} stay parked - ${round3(lengthLdu)} LDU of open track is under ${PARKED_SIDING_FACTOR} train lengths (${round3(trainLength)} LDU), a siding rather than a ride.`);
        return;
      }
      const kept = cars.slice(0, COASTER_MAX_CARS);
      if (kept.length < cars.length) warnings.push(`${track.label}: ${cars.length} cars found; the ${cars.length - kept.length} lowest on the track stay in the shell (the runtime carries at most ${COASTER_MAX_CARS} per train).`);
      vehicles = kept.map(car => {
        const originAboveDatum = car.route!.originAboveDatumLdu;
        const canonical = canonicalCoasterCar(car, bricks, originAboveDatum);
        const datumLdu = sub3(car.frame.originLdu, mul3(car.frame.upWorld, originAboveDatum));
        for (const i of car.bricks) movedIndices.add(i);
        for (const seat of car.seats) for (const i of seat.riderBricks) { movedIndices.add(i); riderIndices.add(i); }
        return {
          chassis: car.chassis.part, sourceIndices: [...car.bricks, ...car.seats.flatMap(seat => [...seat.riderBricks])],
          bricks: canonical.bricks, rider: canonical.rider, ...(canonical.seatLdu ? { seatLdu: canonical.seatLdu } : {}),
          datumPoint: toBlocks(datumLdu), heading: car.route!.heading,
        };
      });
    }

    // ── The route's lift ──
    let lift: CoasterRouteLift | undefined;
    for (const found of assemblies.lifts) {
      if (found.kind === 'chain' && found.routeIndex === routeIndex) {
        lift = { kind: 'chain', arcStart: round3(arcToBlocks(found.arcStartLdu)), arcEnd: round3(arcToBlocks(found.arcEndLdu)), climbDirection: found.climbDirection, sprockets: found.sprockets.length + found.links.length };
        break;
      }
      if (found.kind === 'platform' && found.parked.routeIndex === routeIndex) {
        lift = platformRouteLift(found, assemblies, bricks, frame, usedStrays);
        for (const i of found.bricks) movedIndices.add(i);
        if (lift.counterweight) for (const i of lift.counterweight.sourceIndices) movedIndices.add(i);
        break;
      }
    }
    routes.push({ ...base, ...(vehicles ? { vehicles } : {}), ...(lift ? { lift } : {}) });
  });
  return { routes, movedIndices, riderIndices, parked, warnings };
}

/** The platform's parked and delivered poses snapped onto their terminals, its deck line, and the counterweight riding opposite. */
function platformRouteLift(found: CoasterPlatformLift, assemblies: CoasterAssemblies, bricks: readonly ParsedBrick[], frame: SceneGridFrame, usedStrays: Set<string>): CoasterRoutePlatformLift {
  const toBlocks = (p: readonly number[]): Vec3 => sceneGridPoint(frame, [p[0]!, p[1]!, p[2]!]);
  const up = found.frame.upWorld;
  const originAboveDatum = assemblies.originAboveDatumLdu ?? 14.3;
  const datumAboveRail = assemblies.datumAboveRailTopLdu ?? (found.carOriginAboveRailLdu - originAboveDatum);
  const parkedShift = found.parked.misfitLdu;
  const deliveredShift = add3(mul3(found.travel.axisWorld, found.travel.distanceLdu), found.travel.deliveredAt.misfitLdu);
  const travelLdu = sub3(deliveredShift, parkedShift);
  const deckDatum = (end: 'a' | 'b'): Vec3 => add3(add3(end === 'a' ? found.deck.aLdu : found.deck.bLdu, mul3(up, datumAboveRail)), parkedShift);
  const terminalEnd = found.parked.deckEnd, farEnd = terminalEnd === 'a' ? 'b' : 'a';
  const originLdu: Vec3 = [found.frame.originLdu[0], found.frame.originLdu[1], found.frame.originLdu[2]];
  // The counterweight: strays travelling parallel to the hoist, beside its line.
  const parkedOrigin = add3(originLdu, parkedShift);
  const axis = found.travel.axisWorld;
  const lateral = (p: readonly number[]): number => { const d = sub3(p, parkedOrigin); const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]; return len3(sub3(d, mul3(axis, along))); };
  const along = (p: readonly number[]): number => { const d = sub3(p, parkedOrigin); return d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]; };
  const travelAlong = travelLdu[0] * axis[0] + travelLdu[1] * axis[1] + travelLdu[2] * axis[2];
  const span: [number, number] = [Math.min(0, travelAlong), Math.max(0, travelAlong)];
  const weights = assemblies.strays.filter(stray => {
    if (usedStrays.has(stray.car.id)) return false;
    const t = stray.car.frame.travelWorld;
    if (Math.abs(t[0] * axis[0] + t[1] * axis[1] + t[2] * axis[2]) < COUNTERWEIGHT_PARALLEL_MIN) return false;
    if (lateral(stray.car.frame.originLdu) > COUNTERWEIGHT_LATERAL_MAX_LDU) return false;
    const a = along(stray.car.frame.originLdu);
    return a >= span[0] - stray.car.lengthLdu && a <= span[1] + stray.car.lengthLdu;
  });
  let counterweight: CoasterRoutePlatformLift['counterweight'];
  if (weights.length) {
    for (const w of weights) usedStrays.add(w.car.id);
    const indices = [...new Set(weights.flatMap(w => [...w.car.bricks]))];
    const centre = mul3(weights.reduce((sum, w) => add3(sum, w.car.frame.originLdu), [0, 0, 0] as Vec3), 1 / weights.length);
    counterweight = { bricks: indices.map(i => bricks[i]!), originLdu: centre, point: toBlocks(centre), sourceIndices: indices };
  }
  const deckA = found.deck.aLdu, deckB = found.deck.bLdu;
  return {
    kind: 'platform',
    bricks: found.bricks.map(i => bricks[i]!),
    originLdu,
    parkedPoint: toBlocks(parkedOrigin),
    travel: sceneGridVector(frame, travelLdu),
    deck: [toBlocks(deckDatum(farEnd)), toBlocks(deckDatum(terminalEnd))],
    parkedEnd: found.parked.end,
    ...(counterweight ? { counterweight } : {}),
    measured: {
      travelLdu: round3(len3(travelLdu)), axisDistanceLdu: round3(found.travel.distanceLdu), betweenTerminalsLdu: round3(found.travel.betweenTerminalsLdu),
      parkedMisfitLdu: round3(found.parked.misfitDistanceLdu), deliveredMisfitLdu: round3(found.travel.deliveredAt.misfitDistanceLdu),
      deckLengthLdu: round3(len3(sub3(deckB, deckA))), tiltDeg: found.tiltDeg, members: found.bricks.length,
    },
  };
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

// Serialized with the pure sampler into the pack. No imports may be captured,
// so every tuning constant is declared inside this function body.
function coasterRuntime(config: CoasterRuntimeConfig, sample: typeof sampleCoasterPath) {
  // ── Ride physics (see the module header for the model and its units) ──
  /** Earth gravity along the track tangent, blocks/s². */
  const GRAVITY = 9.8;
  /** Constant wheel and bearing loss, blocks/s². A real coaster loses one to
   * two per cent of g to rolling resistance; a larger value eats the momentum
   * that is supposed to carry the cart over the next crest. */
  const ROLLING = 0.15;
  /** Quadratic drag coefficient, 1/block: the loss term is DRAG * v², blocks/s². */
  const DRAG = 0.012;
  /** Speed floor, blocks/s. The ride may never deadlock on a grade. */
  const MIN_SPEED = 0.8;
  /** Absolute speed ceiling, blocks/s, independent of wand size. */
  const MAX_SPEED = 12;
  /** Chain lift: engages only above this grade and holds exactly LIFT_SPEED.
   * The chain is a kinematic constraint rather than a force, so LIFT_ACCEL only
   * smooths the catch — it must exceed GRAVITY or the chain would "slip" on a
   * steep climb and the cart would sink to the floor speed instead. */
  const LIFT_GRADE = 0.08, LIFT_SPEED = 2.5, LIFT_ACCEL = 12;
  /** Station brake, blocks/s²; the limit curve reaches zero at the platform. */
  const STATION_BRAKE = 3.5;
  /** Station drive tyres pushing the cart out of the platform, blocks/s. */
  const DEPART_SPEED = 3;
  /** Platform dwell in ticks: longer with nobody aboard, so a player can walk
   * up and board; a boarding player always gets BOARD_TICKS before departure. */
  const DWELL_EMPTY = 100, DWELL_LOADED = 60, BOARD_TICKS = 40;
  /** Platform lift: hoist speed in world blocks/s, the pause before it rises
   * and after it arrives (ticks), and how far past the delivered deck (model
   * blocks) the train must be before the platform goes back down. */
  const PLATFORM_SPEED = 2.5, PLATFORM_DWELL = 30, PLATFORM_CLEARANCE = 1;
  /** A route emitted before trains existed, or a partially overwritten pack. */
  const SINGLE = { count: 1, spacing: 0, extent: 0, heading: 0 };
  const types = config.types || {};

  /** Loaded coaster entities, by entity id. */
  const tracked = new Map<string, any>();
  /** Shared ride state, one entry per placed route (a train, not a car). */
  const trains = new Map<string, any>();
  let ticks = 0;
  let lastErrorLogTick = -200;
  const key = 'craftmatic:coaster_';
  const warn = (riders: any[], message: string) => {
    for (const rider of riders) try { rider.onScreenDisplay?.setActionBar(message); } catch {}
  };
  const report = (id: string, stage: string, error: unknown, riders: any[]) => {
    const detail = error instanceof Error ? error.message : String(error);
    const boundedDetail = detail.slice(0, 160);
    warn(riders, `Coaster paused at ${stage}: ${boundedDetail}`);
    if (ticks - lastErrorLogTick >= 200) {
      console.warn(`[Craftmatic coaster] ${config.typeId} ${id} at ${stage}: ${boundedDetail}`);
      lastErrorLogTick = ticks;
    }
  };
  const tick = () => {
    ticks++;
    if (ticks === 1 || ticks % 20 === 0) {
      for (const name of ['overworld', 'nether', 'the_end']) {
        try {
          // Every coaster entity carries the family: ride cars, the fabricated
          // cart, lift platforms and counterweights alike.
          for (const entity of world.getDimension(name).getEntities({ families: ['craftmatic_coaster'] })) {
            if (!tracked.has(entity.id) && types[entity.typeId]) tracked.set(entity.id, { entity, role: types[entity.typeId].role });
          }
        } catch { /* A dimension may be unavailable during world startup. */ }
      }
    }
    // ── Group every loaded entity by its placement: one train per placed route ──
    // Cars of one train share a single ride state, so they move rigidly; a
    // single-cart route is simply a train of one and is unchanged by this. The
    // route's platform and counterweight join the same group.
    const groups = new Map<string, any>();
    for (const [id, state] of tracked) {
      const entity = state.entity;
      // Undo and re-place remove carts. A removed entity is an ordinary
      // retirement, not a movement error: reading anything off it throws
      // "Entity being invalid", which would otherwise be reported to the player
      // and logged as a fault (observed on the device, 2026-09-21).
      const valid = typeof entity.isValid === 'function' ? entity.isValid() : entity.isValid;
      if (valid === false) { tracked.delete(id); continue; }
      let riders: any[] = [];
      let stage = 'read ride state';
      try {
        const rideable = state.role === 'car' ? entity.getComponent('minecraft:rideable') : undefined;
        riders = rideable?.getRiders() ?? [];
        stage = 'read route placement';
        const routeIndex = entity.getDynamicProperty(key + 'route');
        const route = Number.isInteger(routeIndex) ? config.routes[routeIndex as number] : undefined;
        const origin = entity.getDynamicProperty(key + 'origin');
        const rotation = Number(entity.getDynamicProperty(key + 'rotation'));
        const scale = Number(entity.getDynamicProperty(key + 'scale'));
        if (!route || !origin || ![origin.x, origin.y, origin.z, rotation, scale].every(Number.isFinite) || scale <= 0 || scale > 4) {
          if (riders.length) { warn(riders, 'Coaster has no valid placed track. Re-place it with the Brick Wand.'); rideable?.ejectRiders(); }
          continue;
        }
        const cars = route.cars || SINGLE;
        const placement = `${routeIndex}@${origin.x},${origin.y},${origin.z}/${rotation}/${scale}`;
        let group = groups.get(placement);
        if (!group) groups.set(placement, group = { route, cars, origin, rotation, scale, list: [], platform: undefined, counterweight: undefined });
        if (state.role === 'platform') { group.platform = { id, entity, state }; continue; }
        if (state.role === 'counterweight') { group.counterweight = { id, entity, state }; continue; }
        // A car index written by the placement wins; otherwise one is assigned
        // below and saved, so a car never changes place in its train.
        const index = entity.getDynamicProperty(key + 'car');
        group.list.push({ id, entity, rideable, riders, state,
          index: Number.isInteger(index) && index >= 0 && index < cars.count ? index as number : -1 });
      } catch (error) { report(id, stage, error, riders); tracked.delete(id); }
    }
    for (const [placement, group] of groups) {
      const route = group.route, path = route.path, total = path.length, station = route.station;
      const cars = group.cars, extent = cars.extent, list = group.list;
      const origin = group.origin, rotation = group.rotation, scale = group.scale;
      const lift = route.lift;
      // A platform whose cars are all unloaded has nothing to follow: hold it.
      if (!list.length) continue;
      const taken = new Set(list.filter((car: any) => car.index >= 0).map((car: any) => car.index));
      for (const car of list) {
        if (car.index >= 0) continue;
        let index = 0;
        while (taken.has(index) && index < cars.count - 1) index++;
        taken.add(index); car.index = index;
        try { car.entity.setDynamicProperty(key + 'car', index); } catch {}
      }
      list.sort((a: any, b: any) => a.index - b.index || (a.id < b.id ? -1 : 1));
      const lead = list[0];
      const riders = list.reduce((all: any[], car: any) => all.concat(car.riders), []);
      let train = trains.get(placement);
      if (!train) trains.set(placement, train = { dwell: 0, armed: true, boarded: false, grade: undefined, seen: 0, liftDwell: 0, liftPlaced: false });
      train.seen = ticks;
      let stage = 'restore cart progress';
      try {
        // Arc distance of car `index` from the train's centre. The centre, not
        // a car, is the tracked position: it keeps the offsets fixed when an
        // open route reverses and the train's tail becomes its head, instead of
        // flipping every car to the other side of a lead.
        const carArc = (middle: number, index: number) => {
          const arc = middle + extent / 2 - index * cars.spacing;
          return path.closed ? ((arc % total) + total) % total : Math.max(0, Math.min(total, arc));
        };
        // The whole train has to fit on an open route, so its centre cannot
        // reach either end by half the train's length.
        const low = path.closed ? 0 : extent / 2, high = path.closed ? total : total - extent / 2;
        const target = path.closed ? station.stop : Math.max(low, Math.min(high, station.stop));
        const storedDistance = Number(lead.entity.getDynamicProperty(key + 'distance'));
        const placed = !Number.isFinite(storedDistance);
        // A newly placed train waits on the platform, the one part of the route
        // a player can be expected to reach, rather than wherever it spawned.
        let centre = placed ? target
          : path.closed ? ((storedDistance % total) + total) % total
            : Math.max(low, Math.min(high, storedDistance));
        // A fixed ride direction (a circuit, or a lift route) always wins over
        // the stored one; a shuttle keeps whichever way it was going.
        const direction: 1 | -1 = route.direction === 1 || route.direction === -1 ? route.direction
          : lead.entity.getDynamicProperty(key + 'direction') === -1 ? -1 : 1;
        // The cars' noses: fixed along the route for the set's own cars, or
        // the direction of motion for the symmetric fabricated cart.
        const facing: 1 | -1 = cars.heading === 1 || cars.heading === -1 ? cars.heading : direction;
        const storedSpeed = Number(lead.entity.getDynamicProperty(key + 'speed'));
        let speed = Number.isFinite(storedSpeed) ? Math.max(0, Math.min(MAX_SPEED, storedSpeed)) : 0;
        // Lift state: which phase the train is in and how far the platform has
        // travelled (0 parked, 1 delivered). Both persist across script reloads.
        const storedPhase = lead.entity.getDynamicProperty(key + 'phase');
        let phase: string = lift && (storedPhase === 'lifting' || storedPhase === 'delivered') ? storedPhase : 'track';
        const storedProgress = Number(lead.entity.getDynamicProperty(key + 'lift'));
        let progress = lift && Number.isFinite(storedProgress) ? Math.max(0, Math.min(1, storedProgress)) : 0;
        const deckLength = lift ? lift.deckLength : 0;
        const progressBefore = progress;
        if (placed) { train.dwell = DWELL_EMPTY; train.armed = false; }
        // Boarding mid-ride (a command, or a moving car) must not stall the
        // ride; boarding on the platform holds it for the full boarding delay.
        if (riders.length) {
          if (!train.boarded) { train.boarded = true; if (train.dwell > 0 && train.dwell < BOARD_TICKS) train.dwell = BOARD_TICKS; }
        } else train.boarded = false;

        stage = 'integrate ride physics';
        if (train.grade === undefined) {
          let sum = 0;
          for (const car of list) sum += sample(path, carArc(centre, car.index)).tangent[1];
          train.grade = sum / list.length;
        }
        // sin(theta) of the track under the train, averaged over its cars in
        // the direction of travel: a train straddling a crest feels both sides.
        const grade = train.grade * direction;
        let next = centre;
        let nextDirection = direction;
        let arrived: string | null = null;
        /** Platform displacement applied to the cars this tick (they ride it while lifting). */
        let carLift = 0;
        if (phase === 'lifting') {
          // The train sits on the deck; the platform carries it. Nothing rolls.
          speed = 0;
          carLift = progress;
          if (train.liftDwell > 0) train.liftDwell--;
          else {
            const travelLength = Math.hypot(lift.travel[0], lift.travel[1], lift.travel[2]);
            progress = Math.min(1, progress + PLATFORM_SPEED / (20 * scale) / Math.max(1e-6, travelLength));
            carLift = progress;
            if (progress >= 1) {
              // Delivered: the same deck position, now on the far end's copy of
              // the deck at the end of the runtime path. The platform stays up
              // until the train has rolled clear.
              next = centre + total - deckLength;
              carLift = 0;
              phase = 'delivered';
              train.liftDwell = PLATFORM_DWELL;
            }
          }
        } else if (phase === 'delivered') {
          speed = 0;
          if (train.liftDwell > 0) train.liftDwell--;
          else { phase = 'track'; speed = DEPART_SPEED; train.armed = true; }
        } else {
          if (train.dwell > 0) {
            train.dwell--;
            speed = 0;
            // Leaving the platform: a bounded push from the station drive, and the
            // brake disarmed until the train is clear of its own station.
            if (train.dwell === 0) { speed = DEPART_SPEED; train.armed = false; }
          } else {
            speed = Math.max(0, speed + (-GRAVITY * grade - ROLLING - DRAG * speed * speed) / 20);
            // The chain catches a cart slower than itself on a climb and carries
            // it at chain speed; it never touches a cart that is already faster.
            // A measured drive engages only over its own sprockets.
            const chainHere = !route.chain || (centre >= route.chain.start - extent / 2 && centre <= route.chain.end + extent / 2);
            if (chainHere && grade > LIFT_GRADE && speed < LIFT_SPEED) speed = Math.min(LIFT_SPEED, speed + LIFT_ACCEL / 20);
            speed = Math.max(speed, MIN_SPEED);
          }
          // Arc distance to the next stop in the direction of travel, or -1 when
          // nothing is ahead: the platform (armed, ahead, not still clearing it),
          // and on a lift route heading down, the parked deck's centre — or the
          // terminal, where the train waits while the platform is still away.
          let toStop = -1, stopAt = target, stopKind = 'station';
          if (train.armed && train.dwell <= 0) {
            let ahead = (target - centre) * direction;
            if (path.closed) { ahead %= total; if (ahead < 0) ahead += total; }
            if (ahead >= 0) { toStop = ahead; }
          }
          if (lift && direction === -1) {
            const deckTarget = progress <= 0 ? deckLength / 2 : deckLength + extent / 2;
            const ahead = centre - deckTarget;
            if (ahead >= 0 && (toStop < 0 || ahead < toStop)) { toStop = ahead; stopAt = deckTarget; stopKind = progress <= 0 ? 'deck' : 'wait'; }
          }
          // Kinematic brake: v = sqrt(2 a s) reaches zero exactly at the stop.
          // `toStop` is in model blocks; the brake works in world blocks.
          if (toStop >= 0) speed = Math.min(speed, Math.sqrt(2 * STATION_BRAKE * toStop * scale));
          // A step may never exceed one authored sample spacing, or it would cut
          // the corner of the measured polyline instead of following it. Every car
          // advances by the same step, so no car can exceed it either.
          speed = Math.min(speed, MAX_SPEED, 20 * scale * route.maxSpacing);
          const step = speed / (20 * scale);
          next = centre + step * direction;
          if (toStop >= 0 && step >= toStop) { next = stopAt; arrived = stopKind; }
          else if (path.closed) next = ((next % total) + total) % total;
          else if (next > high || next < low) {
            next = next < low ? low : high;
            if (lift) {
              // A lift route never reverses: its low end IS the parked deck, so
              // overrunning the brake there is an arrival, and its far end is
              // only reached by a train that has just been delivered.
              speed = 0;
              if (next === low) arrived = 'deck';
            } else {
              // The real end of an open route: stop, reverse, and re-arm the brake.
              // No track is invented across the gap. The train leaves the dead end
              // on the same bounded drive push the platform uses, so a shuttle end
              // cannot strand it crawling at the floor speed along level track.
              nextDirection = direction === 1 ? -1 : 1;
              speed = DEPART_SPEED;
              train.armed = true;
            }
          }
          if (arrived === 'station') { speed = 0; train.dwell = riders.length ? DWELL_LOADED : DWELL_EMPTY; }
          else if (arrived === 'deck') { speed = 0; phase = 'lifting'; train.liftDwell = PLATFORM_DWELL; }
          else if (arrived === 'wait') { speed = 0; }
          else if (!train.armed) {
            const inside = station.start <= station.end
              ? next >= station.start && next <= station.end
              : next >= station.start || next <= station.end;
            if (!inside) train.armed = true;
          }
        }
        // The platform goes back down once the delivered train has rolled clear
        // of the deck; it never moves under a train that is still on it.
        if (lift && phase === 'track' && progress > 0) {
          const trailing = next + extent / 2;
          if (trailing < total - deckLength - PLATFORM_CLEARANCE) {
            const travelLength = Math.hypot(lift.travel[0], lift.travel[1], lift.travel[2]);
            progress = Math.max(0, progress - PLATFORM_SPEED / (20 * scale) / Math.max(1e-6, travelLength));
          }
        }
        const platformMoving = progress !== progressBefore;
        stage = 'sample next track';
        const angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
        const toWorld = (p: readonly number[]) => ({ x: origin.x + (p[0]! * c - p[2]! * s) * scale, y: origin.y + p[1]! * scale, z: origin.z + (p[0]! * s + p[2]! * c) * scale });
        const frames: any[] = [];
        let gradeSum = 0;
        for (const car of list) {
          const at = sample(path, carArc(next, car.index));
          gradeSum += at.tangent[1];
          const p = at.position;
          const lifted = lift && carLift > 0 ? [p[0] + lift.travel[0] * carLift, p[1] + lift.travel[1] * carLift, p[2] + lift.travel[2] * carLift] : p;
          const position = toWorld(lifted);
          const tangent = at.tangent.map((value: number) => value * facing);
          const horizontal = Math.hypot(tangent[0], tangent[2]);
          const worldTx = tangent[0] * c - tangent[2] * s;
          const worldTz = tangent[0] * s + tangent[2] * c;
          const yaw = horizontal > 1e-6 ? Math.atan2(-worldTx, worldTz) * 180 / Math.PI : car.entity.getRotation().y;
          const pitch = -Math.atan2(tangent[1], horizontal) * 180 / Math.PI;
          const i = at.segmentIndex;
          const ratio = (at.distance - path.cumulative[i]) / (path.cumulative[i + 1] - path.cumulative[i]);
          const up0 = route.up[i], up1 = route.up[i + 1];
          const up = up0.map((value: number, axis: number) => value + (up1[axis] - value) * ratio);
          const ux = up[0] * c - up[2] * s, uy = up[1], uz = up[0] * s + up[2] * c;
          // Remove entity yaw then bone pitch from the transported track up.
          // The remaining angle is local roll; at a loop apex this turns the
          // cart upside down without attempting unsupported player-camera roll.
          const yawRad = yaw * Math.PI / 180, pitchRad = pitch * Math.PI / 180;
          const localX = ux * Math.cos(yawRad) + uz * Math.sin(yawRad);
          const yawZ = -ux * Math.sin(yawRad) + uz * Math.cos(yawRad);
          const localY = uy * Math.cos(pitchRad) + yawZ * Math.sin(pitchRad);
          const roll = Math.atan2(-localX, localY) * 180 / Math.PI;
          frames.push({ car, position, yaw, pitch, roll });
        }
        // The platform and counterweight: placed once on first sight and then
        // whenever the hoist moves. Absent entities (removed, unloaded) are
        // simply not moved; their pose is a function of `progress`, so they are
        // right again the moment they are seen.
        const liftFrames: any[] = [];
        if (lift && (platformMoving || !train.liftPlaced)) {
          const t = lift.travel;
          if (group.platform) liftFrames.push({ entity: group.platform.entity, position: toWorld([lift.parkedPoint[0] + t[0] * progress, lift.parkedPoint[1] + t[1] * progress, lift.parkedPoint[2] + t[2] * progress]) });
          if (group.counterweight && lift.counterweightPoint) liftFrames.push({ entity: group.counterweight.entity, position: toWorld([lift.counterweightPoint[0] - t[0] * progress, lift.counterweightPoint[1] - t[1] * progress, lift.counterweightPoint[2] - t[2] * progress]) });
        }
        // Never teleport into an unloaded region. Holding the centre allows a
        // later tick to resume without skipping track or abandoning a rider;
        // one car in an unloaded chunk holds the whole train, because a train
        // that moved only some of its cars would no longer be a train. The
        // platform under a lifting train holds it the same way.
        stage = 'check next chunk';
        let held = false;
        for (const frame of [...frames, ...liftFrames]) {
          let loaded = false;
          const entity = frame.car ? frame.car.entity : frame.entity;
          try { loaded = !!entity.dimension.getBlock({ x: Math.floor(frame.position.x), y: Math.floor(frame.position.y), z: Math.floor(frame.position.z) }); } catch {}
          if (!loaded) { held = true; break; }
        }
        if (held) { warn(riders, 'Coaster paused: next track chunk is not loaded'); continue; }
        stage = 'teleport cart';
        let moved = true;
        for (const frame of frames) {
          if (!frame.car.entity.tryTeleport(frame.position, { rotation: { x: 0, y: frame.yaw }, keepVelocity: false, checkForBlocks: false })) { moved = false; break; }
        }
        for (const frame of liftFrames) {
          if (!moved) break;
          if (!frame.entity.tryTeleport(frame.position, { rotation: { x: 0, y: rotation }, keepVelocity: false, checkForBlocks: false })) moved = false;
        }
        // A car that moved before a later one failed is put back next tick: the
        // saved centre is still the old one, so the train re-places from it.
        if (!moved) { warn(riders, 'Coaster paused: movement could not complete'); continue; }
        if (lift) train.liftPlaced = true;
        stage = 'save cart progress';
        // Every car carries the same ride state, so any loaded car can lead it.
        // `distance` on a train car is the TRAIN's centre, not that car's arc.
        for (const frame of frames) {
          frame.car.entity.setDynamicProperty(key + 'distance', next);
          frame.car.entity.setDynamicProperty(key + 'direction', nextDirection);
          frame.car.entity.setDynamicProperty(key + 'speed', speed);
          if (lift) { frame.car.entity.setDynamicProperty(key + 'phase', phase); frame.car.entity.setDynamicProperty(key + 'lift', progress); }
        }
        train.grade = gradeSum / frames.length;
        stage = 'animate cart';
        // A value outside a declared actor-property range throws, which would
        // otherwise untrack the cart mid-ride; the angles are already in range.
        for (const frame of frames) {
          frame.car.entity.setProperty('craftmatic:track_pitch', Math.max(-90, Math.min(90, frame.pitch)));
          frame.car.entity.setProperty('craftmatic:track_roll', Math.max(-180, Math.min(180, frame.roll)));
          // The set's own car: show its posed rider unless a player has the seat.
          const type = types[frame.car.entity.typeId];
          const slot = cars.slots && cars.slots[frame.car.index];
          if (type && type.riders > 0 && slot) {
            const occupied = frame.car.riders.length > 0;
            if (frame.car.state.rider !== slot.rider) { frame.car.entity.setProperty('craftmatic:rider', slot.rider); frame.car.state.rider = slot.rider; }
            if (frame.car.state.occupied !== occupied) { frame.car.entity.setProperty('craftmatic:occupied', occupied); frame.car.state.occupied = occupied; }
          }
        }
        stage = 'check rider retention';
        for (const car of list) {
          const aboard: any[] = car.rideable?.getRiders() ?? [];
          const retained = new Set(aboard.map((rider: any) => rider.id));
          const lost = car.riders.filter((rider: any) => !retained.has(rider.id));
          // Never force a rider back on: this may have been a deliberate
          // dismount. The ride keeps running and comes back to the platform.
          if (lost.length) warn(lost, 'Coaster ride ended. Board again when the cart stops at the station.');
          if (ticks % 20 === 0) {
            warn(aboard, train.dwell > 0 ? 'Coaster departing — sneak to dismount'
              : phase === 'lifting' ? `${route.label} — lift rising — sneak to dismount`
              : phase === 'delivered' ? `${route.label} — at the top — sneak to dismount`
              : arrived === 'wait' ? `${route.label} — waiting for the lift — sneak to dismount`
              : `${route.label} — ${speed.toFixed(1)} blocks/s — sneak to dismount`);
          }
        }
      } catch (error) {
        report(lead.id, stage, error, riders);
        // Removed carts (Undo/re-place) must not survive as script-held state.
        for (const car of list) tracked.delete(car.id);
        if (group.platform) tracked.delete(group.platform.id);
        if (group.counterweight) tracked.delete(group.counterweight.id);
        trains.delete(placement);
      }
    }
    // Forget the ride state of a train whose cars have all gone.
    for (const [placement, train] of trains) if (train.seen !== ticks) trains.delete(placement);
  };
  system.runInterval(tick, 1);
}

/** Emit the same runtime exercised by the host tests. Riders remain upright;
 * pitch animates the cart only, not an unsupported upside-down player pose. */
export function coasterScript(config: CoasterRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${coasterRuntime.toString()})(CONFIG, ${sampleCoasterPath.toString()});\n`;
}
