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
 *   an inversion floor so a train is never slower over a loop's top than
 *   `INVERSION_MARGIN` × sqrt(g r) (rising from zero where the track is
 *   vertical, so it never kicks), and an absolute speed ceiling (`MAX_SPEED`).
 *   All of it runs at `COASTER_RIDE_PACE`, real gravity time-scaled. A tick is integrated in
 *   SUBSTEPS no longer than one authored sample spacing, each sampling the
 *   grade where the train actually is, so the polyline's resolution bounds the
 *   integration step and never the speed: a 35-block drop reaches the ceiling
 *   rather than the 7.5 blocks/s that one-sample-per-tick used to allow.
 *
 * ## Car orientation
 *
 * A car rides on two wheel contacts, not on a point: its pitch and yaw are the
 * CHORD between its front and rear wheels on the path (`wheelbase`, measured
 * from the set's wheel parts), so a car no longer see-saws over every sample
 * join, and coupled cars differ only by the track's real curvature over one
 * car pitch. Its yaw is the heading of its AXLE, not of its nose, so it holds
 * still through every loop, planar or helical (`coasterCarAttitude`). Its
 * roll comes from the per-sample up vectors (`coasterTrackUps`):
 * gravity's up wherever the track is upright — LEGO track moulds are never
 * banked — and the loop's own normal through a loop, with a bounded twist rate
 * between the two. A pure parallel transport carried the helical loops'
 * holonomy (84 degrees on 10303) all the way onto the lift's top deck.
 *
 * A Bedrock player cannot roll, and a seat is a fixed offset in the entity's
 * yaw-only frame, so through an inversion the seat would carry the rider to
 * the OUTSIDE of the loop. The runtime therefore places the entity where the
 * rider's head belongs (the seat carried through the car's real pitch and
 * roll, less the player's upright eye height) and offsets the drawn body back
 * onto the track through three synced `craftmatic:body_*` properties, so the
 * bricks stay on the rails and the rider stays inside the loop. On upright
 * track every one of these offsets is exactly zero.
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
 * A route with the set's own cars runs TWO trains (`trains`): the second waits
 * in the loading bay — a block point one train length behind the platform, on
 * the station's level run — and is dispatched when the first is half a lap
 * ahead; a train arriving at an occupied station holds at that same block
 * point. Where the set parks a spare train on a siding (10261's Track 2) those
 * cars ARE the second train and leave the shell; otherwise the first train's
 * car types are instanced again (10303 ships three cars, so its second train
 * is a second copy of them). Every train keeps its own ride state; the lift's
 * hoist is shared per placement, so a train reaching the deck while the
 * platform is still away waits at the terminal as before.
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
  /**
   * Distance between the front and rear wheel contacts along the car's travel,
   * in model blocks (and in LDU): the car's pitch is the chord between them on
   * the path. Measured from the set's wheel parts where they are separate
   * (10303's 24869 wheels sit at ±25 LDU on the 26021 base); a composite
   * chassis with built-in wheels falls back to the mould table. Absent means
   * the runtime pitches the car on the local tangent, as before.
   */
  wheelbase?: number;
  wheelbaseLdu?: number;
}

/** How many trains a route with the set's own cars runs: one riding, one waiting in the loading bay. */
export const COASTER_TRAINS = 2;
/** Clearance kept between the waiting train and the one on the platform, model blocks. */
export const COASTER_HOLD_GAP = 0.5;
/** The second train departs once the first is this fraction of a lap ahead. */
export const COASTER_DISPATCH_FRACTION = 0.5;
/**
 * Wheel contact spacing of chassis moulds whose wheels are built in, measured
 * from the LDraw shortcut that places them: `26021c01.dat` puts its two 24869
 * wheels at x ±25 on the `26021` Train Base 4 x 5 Roller Coaster. A composite
 * chassis exposes no separate wheel parts to measure, so this is the same
 * measurement taken from the part library instead of the placed set.
 */
const CHASSIS_WHEELBASE_LDU: Readonly<Record<string, number>> = { '26021': 50 };

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
  /**
   * How many trains run this route (default 1). A second train needs a route
   * that circulates: a closed circuit or a platform-lift route; an open
   * shuttle keeps one train. Only meaningful with `vehicles`.
   */
  trains?: number;
  /**
   * The set's own cars for the SECOND train, in the order they stand on their
   * siding (highest arc first): they leave the shell and run instead of a
   * copy of the first train's cars. Fewer than the first train's count are
   * not used (the first train is instanced again and a warning says so).
   */
  reserve?: CoasterRouteCar[];
  /** The set's own lift on this route, when one was measured. */
  lift?: CoasterRouteLift;
  /**
   * `train`: a railway line (`CoasterTrackRouteLdu.family`) carrying the set's
   * own train, which the rider DRIVES on `RAIL_TRAIN_PHYSICS`: no lift, no
   * second train, no fabricated cart. Absent: a coaster route, as before.
   */
  family?: 'train';
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

/** One car of a train as the runtime sees it: which entity type, which rider variant, its name tag, and which train it belongs to (slot index = train × count + car). */
export interface CoasterCarSlot { type: string; rider: number; label: string; train: number }

/** Where a route's second train waits and when it may go. */
export interface CoasterDispatch {
  /** Arc of the waiting train's centre: one train length plus `COASTER_HOLD_GAP` behind the platform, against the ride direction. */
  hold: number;
  /** Arc length of one lap for dispatch purposes: the route's, or a lift route's course without the deck it rides twice. */
  lap: number;
  /** A train may leave the platform once the other is this far ahead along the lap. */
  ahead: number;
}

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
   * entity type and rider variant for every train (`trains` × `count` of
   * them); absent for the fabricated cart. */
  cars: { count: number; spacing: number; extent: number; minChord?: number; heading: 1 | -1 | 0; trains: number; slots?: CoasterCarSlot[] };
  /** Present when `cars.trains` > 1: where the second train waits and the lap it is dispatched against. */
  dispatch?: CoasterDispatch;
  /** Fixed ride direction (a closed circuit's, or toward a platform lift's deck); 0 shuttles an open route. */
  direction: 1 | -1 | 0;
  /** A measured chain drive: the chain assist engages only on this arc span. Absent keeps it on every climb. */
  chain?: { start: number; end: number };
  lift?: CoasterRuntimeLift;
  /** Radius of the route's inversions, model blocks (`coasterLoopRadius`); absent on a route that never inverts. */
  loopRadius?: number;
  /**
   * A railway route's own ride constants (`RAIL_TRAIN_PHYSICS`): the rider
   * DRIVES it with the stick. Absent on a coaster route, which rides on
   * `CoasterRuntimeConfig.physics` exactly as before.
   */
  physics?: RidePhysics;
}

/**
 * What each entity type in a placement is: a ride car (and how many rider
 * variants it carries), the platform, or its counterweight. A car also carries
 * its `wheelbase` (model blocks at the exported scale; the runtime pitches it
 * on the chord between its wheels) and its `seat` (the rideable seat offset in
 * blocks, entity frame), both filled by `buildCoasterRideAssets`, which is
 * where the compiled body and the export scale are known.
 */
export interface CoasterRuntimeType { role: 'car' | 'platform' | 'counterweight'; riders: number; wheelbase?: number; seat?: [number, number, number] }

export interface CoasterRuntimeConfig {
  /** The fabricated cart's type id; also the stem the set's own vehicle types are named from. */
  typeId: string;
  routes: CoasterRuntimeRoute[];
  types: Record<string, CoasterRuntimeType>;
  /** The physics constants `coasterRuntime` integrates with (see `COASTER_PHYSICS`).
   * Optional only so a hand-built config in an older test compiles; every real
   * pack gets one from `coasterRuntimeConfig`. */
  physics?: CoasterPhysics;
  /** The rider's track-following camera (see `COASTER_RIDER_VIEW`); absent = no camera, the pre-2026-09-24 behaviour. */
  camera?: CoasterRiderViewConfig;
}

/**
 * How the rider's camera represents a view past vertical.
 *  - `over`: the free camera's pitch runs past ±90 (through a loop it goes
 *    0 → -90 → -180 → -270 ≡ +90 → 0), which draws the world upside down at
 *    the apex exactly as a rider sees it. Needs a client that honours a pitch
 *    outside [-90, 90] (measured on the Pixel, see `docs/bedrock-addon-guide.md`).
 *  - `clamp`: the view DIRECTION is exact but kept to pitch [-90, 90] with the
 *    world drawn upright; going over the top turns the image 180 degrees about
 *    the view axis, spread over a few ticks by `maxTurn`.
 *  - `off`: no camera; the player's own first person, as before.
 */
export type CoasterRiderViewMode = 'roll' | 'rollover' | 'clamp' | 'over' | 'off';

/** The camera constants the runtime reads from `config.camera`. */
export interface CoasterRiderViewConfig {
  mode: CoasterRiderViewMode;
  /** Most the rider may look away from the track frame, degrees: yaw either way, and pitch up or down. */
  lookYaw: number; lookPitch: number;
  /** Ease of each per-tick camera update, seconds (a tick is 0.05). */
  ease: number;
  /** Most the camera's yaw may turn in one tick, degrees (`clamp` needs it for the flip over the top). */
  maxTurn: number;
  /** Ticks the rider's own yaw trails the car's: the client turns a rider with its interpolated view of the car (Pixel: ~0.3 s; 6 ticks held the look within 5 degrees through the fastest curve, from -37..+55 uncompensated). */
  lookLag: number;
  /** Whether pushing the head past a limit drags the look reference along. Off: a lag transient can never shift the view for good. */
  ratchet: boolean;
  /** Length of each tick's camera animation in the roll modes, seconds: more than 0.05 (the engine refuses rotation keyframes 0.05 apart); the next tick replaces it. */
  spline: number;
}

/**
 * The rider's baseline view is the car's own frame: the eye where the rider's
 * head is (seat plus seated eye height along the car's real up), looking along
 * the car's nose, turning with every curve and pitching through every climb,
 * drop and inversion. The player's own look is layered on top as an offset,
 * clamped to `lookYaw`/`lookPitch`, so they can look around but the track
 * always sets where "ahead" is. Values chosen and measured in the guide's
 * "The rider's camera follows the track" section.
 */
export const COASTER_RIDER_VIEW: Readonly<CoasterRiderViewConfig> = { mode: 'clamp', lookYaw: 70, lookPitch: 50, ease: 0.1, maxTurn: 40, lookLag: 6, ratchet: false, spline: 0.1 };

/** |dy/ds| at or below this counts as level track (about 4.6 degrees). */
const STATION_FLAT_GRADE = 0.08;
/** A station sits low: only flat runs inside this fraction of the route's
 * height range above its lowest point are eligible. */
const STATION_LOW_BAND = 0.25;
/** Most cars a route may run (`resolveCoasterCars` rejects more; the pipeline leaves the rest in the shell). */
export const COASTER_MAX_CARS = 8;
/** Actor-property names shared by every ride car. */
const PROP_PITCH = 'craftmatic:track_pitch', PROP_ROLL = 'craftmatic:track_roll', PROP_RIDER = 'craftmatic:rider', PROP_OCCUPIED = 'craftmatic:occupied';
/**
 * The drawn body's offset from the entity origin, model units (1/16 block),
 * entity frame. The runtime moves the ENTITY so the rider's head follows the
 * car through an inversion, and these put the bricks back on the rails. The
 * range covers twice the seat-plus-eye height at the smallest wand size
 * (2 × (1 + 1.25) blocks / 0.25 × 16 = 288); the runtime clamps to it.
 */
const PROP_BODY = ['craftmatic:body_x', 'craftmatic:body_y', 'craftmatic:body_z'] as const;
const BODY_OFFSET_RANGE = 320;
/** The type family every coaster entity carries; the runtime discovers them by it. */
export const COASTER_FAMILY = 'craftmatic_coaster';
/** The `minecraft:rideable.interact_text` every ride car declares (the fabricated
 * cart and the set's own cars alike): the exact device-proved prompt string
 * (`docs/bedrock-addon-guide.md`, world 921). Anything that shows a boarding
 * prompt offline (the add-on preview) reads this constant rather than a copy,
 * so the two can never drift. */
export const RIDE_INTERACT_TEXT = 'Ride the coaster';
/** The boarding prompt of a railway car (a driven train, `CoasterRoute.family`). */
export const RAIL_INTERACT_TEXT = 'Drive the train';

/**
 * The ride's physics constants (see the module header for the model), read by
 * `coasterRuntime` from `config.physics` instead of local literals. A bare
 * function-local `const` here would vanish at the source-text boundary the
 * SAME way `YAW_HOLD_HORIZONTAL` and `BODY_RANGE` document above: `coasterScript`
 * only serializes `coasterRuntime`'s TEXT, so any value the device needs must
 * ride inside `CONFIG` (already JSON-serialized) rather than a module-scope
 * `const` the runtime's body could not see. `coasterRuntimeConfig` always sets
 * `physics: COASTER_PHYSICS`, so the device and anything off-device that wants
 * the same numbers (the add-on walk preview) share exactly one definition.
 */
/**
 * How much faster than real time the ride runs: every speed is multiplied by
 * it and every acceleration by its square, which is the SAME ride — the same
 * track, the same energy, the same loops made or missed — played back faster.
 *
 * At 1 (true 9.8 blocks/s² gravity) the device report of 2026-09-24 was "all
 * coasters are about 50 % too slow", and it is easy to see why: a set at
 * minifig scale is a real-sized ride built with toy radii — 10303's loops are
 * 3.7 blocks across the middle, a real family coaster's are 7-10 m — so the
 * speeds that real gravity gives are right for the height and read as a
 * crawl for the curvature. Time-scaling keeps every ratio the rest of this
 * file was tuned on (drag v² scales with gravity, so it is left alone) and is
 * the one knob that answers "faster" without re-tuning the brake, the chain
 * or the dwell. Measured per set in `docs/bedrock-addon-guide.md`.
 */
export const COASTER_RIDE_PACE = 1.6;

export const COASTER_PHYSICS = {
  /** Gravity along the track tangent, blocks/s²: Earth's, time-scaled by the pace. */
  GRAVITY: 9.8 * COASTER_RIDE_PACE ** 2,
  /** Constant wheel and bearing loss, blocks/s². */
  ROLLING: 0.12 * COASTER_RIDE_PACE ** 2,
  /** Quadratic drag coefficient, 1/block: the loss term is DRAG * v². Pace-invariant. */
  DRAG: 0.008,
  /** Speed floor, blocks/s. The ride may never deadlock on a grade. */
  MIN_SPEED: 0.8 * COASTER_RIDE_PACE,
  /** Absolute speed ceiling, blocks/s, independent of wand size. Every drop
   * the ceiling clips loses energy for good, and 16 (the old, unpaced value)
   * cost 10303 the speed its first loop needed: the train crawled over the
   * top on the chain. */
  MAX_SPEED: 32,
  /** A train through an inversion keeps at least this multiple of the
   * minimum speed that holds it on a loop of the route's radius at the apex,
   * sqrt(g r), scaled by how far it is over (`coasterRuntime`). */
  INVERSION_MARGIN: 1.3,
  /** Chain lift: engages only above this grade and holds exactly LIFT_SPEED. */
  LIFT_GRADE: 0.08, LIFT_SPEED: 2.5 * COASTER_RIDE_PACE, LIFT_ACCEL: 12 * COASTER_RIDE_PACE ** 2,
  /** Station brake, blocks/s²; the limit curve reaches zero at the platform. */
  STATION_BRAKE: 3.5 * COASTER_RIDE_PACE ** 2,
  /** Station drive tyres pushing the cart out of the platform, blocks/s. */
  DEPART_SPEED: 3 * COASTER_RIDE_PACE,
  /** Platform dwell in ticks: longer with nobody aboard, loaded is shorter, a
   * boarding player always gets BOARD_TICKS before departure. */
  DWELL_EMPTY: 100, DWELL_LOADED: 60, BOARD_TICKS: 40,
  /** Platform lift: hoist speed (world blocks/s), the pause before it rises
   * and after it arrives (ticks), and the clearance (model blocks) the train
   * must keep past the deck before it goes back down. */
  PLATFORM_SPEED: 2.5 * COASTER_RIDE_PACE, PLATFORM_DWELL: 30, PLATFORM_CLEARANCE: 1,
  /** A seated player's eye above the seat, world blocks (`SEATED_EYE_HEIGHT_BLOCKS`). */
  RIDER_EYE: 1.25,
  /** How horizontal a car's AXLE must be (its horizontal fraction) before the
   * heading at right angles to it may set the yaw; below it (a car on its
   * side) the last yaw is held. See `coasterCarAttitude`. */
  YAW_HOLD_HORIZONTAL: 0.20,
  /** Declared range of the body-offset properties, model units. */
  BODY_RANGE: 320,
} as const;
export type CoasterPhysics = typeof COASTER_PHYSICS;

/**
 * A DRIVEN rail vehicle's own constants: the rider's stick is the throttle and
 * the brake, and a train with nobody at the controls holds itself still.
 * Blocks/s², world scale.
 */
export interface RideDriverPhysics {
  /** Acceleration at full stick in the direction of travel (or from rest). */
  TRACTION: number;
  /** Deceleration at full stick against the direction of travel. */
  BRAKE: number;
  /** Deceleration with no driver aboard: an unattended train stops and stays. */
  PARK_BRAKE: number;
}

/**
 * The ONE ride model every rail vehicle runs, coaster or train: the coaster's
 * constants (`COASTER_PHYSICS`) widened to plain numbers, plus `DRIVER` for a
 * vehicle the rider drives. Without `DRIVER` it is exactly the coaster.
 */
export type RidePhysics = { readonly [K in keyof CoasterPhysics]: number } & { readonly DRIVER?: RideDriverPhysics };

/**
 * A train on LEGO railway track, on the coaster's engine (`rideSubstep`,
 * `coasterRuntime`) with a driver: no chain, no inversion floor, no minimum
 * speed, no automatic station stop, a buffer stop at an open end instead of a
 * shuttle reversal. Real gravity (a train set is flat; nothing is time-scaled).
 * The top speed is a Minecraft figure, not a railway one: 12 blocks/s is 1.5x a
 * minecart and still lets a rider read an R40 curve (15-block radius at
 * minifig scale); 0 to 12 takes 4 s at full stick, a full-stick stop 2 s.
 */
export const RAIL_TRAIN_PHYSICS: RidePhysics = {
  ...COASTER_PHYSICS,
  GRAVITY: 9.8,
  ROLLING: 0.3,
  DRAG: 0.004,
  MIN_SPEED: 0,
  MAX_SPEED: 12,
  INVERSION_MARGIN: 0,
  // A sine never exceeds 1, so no chain ever engages (Infinity would not survive JSON).
  LIFT_GRADE: 2, LIFT_SPEED: 0, LIFT_ACCEL: 0,
  DEPART_SPEED: 0,
  DWELL_EMPTY: 0, DWELL_LOADED: 0, BOARD_TICKS: 0,
  DRIVER: { TRACTION: 3, BRAKE: 6, PARK_BRAKE: 6 },
};

/** What the ride engine is told about the track and the rider for one substep. */
export interface RideSubstepInput {
  /** A measured chain drive engages here (coaster only). */
  chain: boolean;
  /** Speed floor through an inversion this substep, world blocks/s; 0 for none (coaster only). */
  floor: number;
  /** Driver's stick along INCREASING arc, -1..1 (a driven vehicle only). */
  push: number;
  /** Someone is at the controls (a driven vehicle only; without, the park brake holds it). */
  driven: boolean;
}

/**
 * One integration substep of the rail ride, shared by the pack's runtime
 * (`coasterRuntime`, which receives it as an argument because it is serialized
 * by `.toString()`) and the walk preview (`coaster-preview.ts`). `speed` is
 * world blocks/s along `direction` (±1 = increasing/decreasing arc);
 * `gradeArc` is sin(theta) of the track averaged over the train, measured
 * along INCREASING arc.
 *
 * Coaster (no `DRIVER`): gravity, rolling and drag, the chain assist, the
 * minimum speed and the inversion floor - the formulas that shipped, in the
 * same floating-point order, so a coaster rides exactly as before
 * (`scripts/_coaster_replay.ts` digests 10261/10303 identical across this
 * refactor). Driven: a signed velocity pushed by the stick, braked against the
 * motion, parked with nobody aboard; losses and brakes stop a train, they
 * never reverse it; from rest only a push or a grade steeper than the rolling
 * loss starts it.
 */
export function rideSubstep(speed: number, direction: 1 | -1, gradeArc: number, dt: number, input: RideSubstepInput, P: RidePhysics): { speed: number; direction: 1 | -1 } {
  const D = P.DRIVER;
  if (!D) {
    const grade = gradeArc * direction;
    speed = Math.max(0, speed + (-P.GRAVITY * grade - P.ROLLING - P.DRAG * speed * speed) * dt);
    // The chain catches a cart slower than itself on a climb and carries it at
    // chain speed; it never touches a cart that is already faster.
    if (input.chain && grade > P.LIFT_GRADE && speed < P.LIFT_SPEED) speed = Math.min(P.LIFT_SPEED, speed + P.LIFT_ACCEL * dt);
    speed = Math.max(speed, P.MIN_SPEED);
    if (input.floor > 0) speed = Math.max(speed, input.floor);
    return { speed, direction };
  }
  const u = speed * direction;
  const sign = u > 0 ? 1 : u < 0 ? -1 : 0;
  const push = input.driven ? Math.max(-1, Math.min(1, input.push)) : 0;
  const gravity = -P.GRAVITY * gradeArc;
  let next: number;
  if (sign) {
    let a = gravity - sign * (P.ROLLING + P.DRAG * u * u);
    if (!input.driven) a -= sign * D.PARK_BRAKE;
    else if (push && Math.sign(push) !== sign) a -= sign * D.BRAKE * Math.abs(push);
    else a += push * D.TRACTION;
    next = u + a * dt;
    if (Math.sign(next) !== sign) next = 0;
  } else {
    const drive = gravity + push * D.TRACTION;
    const resist = P.ROLLING + (input.driven ? 0 : D.PARK_BRAKE);
    next = Math.abs(drive) > resist ? (drive - Math.sign(drive) * resist) * dt : 0;
  }
  next = Math.max(-P.MAX_SPEED, Math.min(P.MAX_SPEED, next));
  return { speed: Math.abs(next), direction: next > 0 ? 1 : next < 0 ? -1 : direction };
}
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
  if (!cars) return { count: 1, spacing: 0, extent: 0, heading: 0, trains: 1 };
  if (!Number.isInteger(cars.count) || cars.count < 1 || cars.count > COASTER_MAX_CARS) {
    throw new Error(`Coaster train car count must be an integer in [1, ${COASTER_MAX_CARS}], received ${cars.count}.`);
  }
  if (cars.count === 1) return { count: 1, spacing: 0, extent: 0, heading: 0, trains: 1 };
  if (!Number.isFinite(cars.spacing) || cars.spacing <= 0) {
    throw new Error('Coaster train car spacing must be a finite positive number of blocks.');
  }
  const fits = Math.max(1, Math.min(cars.count, Math.floor(path.length / cars.spacing)));
  if (fits === 1) return { count: 1, spacing: 0, extent: 0, heading: 0, trains: 1 };
  return { count: fits, spacing: cars.spacing, extent: (fits - 1) * cars.spacing,
    minChord: minimumCoupledChord(path, cars.spacing), heading: 0, trains: 1 };
}

// ─── Track up vectors ────────────────────────────────────────────────────────

/** Fastest the up vector may twist about the tangent, degrees per model block: bounds every correction below. */
export const TRACK_TWIST_RATE_DEG_PER_BLOCK = 20;
/** A vertical curve tighter than this radius (model blocks) whose centre is above the car is a loop: the up follows its normal. */
const LOOP_RADIUS_MAX = 8;
/**
 * How level the track must be for GRAVITY to be a meaningful up target: the
 * horizontal fraction of the tangent, so 0.05 is a pitch of about 87 degrees.
 *
 * Gravity's up is `perpendicular([0, 1, 0], t)`, whose DIRECTION on a
 * near-vertical tangent is just that tangent's azimuth — numerically
 * meaningless. Measured on 10303 at arc 370.8, where the horizontal fraction is
 * 0.002, `dot(up, gravity)` swung +0.883 -> -0.598 -> +0.502 over three
 * samples and the branch flipped with it.
 *
 * This only stops an ill-conditioned target being chased; it is NOT what fixed
 * the reported swivel. That was the ride runtime taking the car's yaw from a
 * heading whose horizontal reverses past a loop's top — see the car frame
 * there. A larger threshold was tried and rejected: suppressing gravity up to
 * 69 degrees left 10303's tower parallel-transported through its own crest and
 * inverted the car for 83 blocks.
 */
const TRACK_LEVEL_MIN = 0.05;
/** Curvature is measured between tangents this far either side of a sample, so one kinked join is not a loop. */
const CURVATURE_HALF_WINDOW = 0.75;
/**
 * Steeper than this (the tangent's horizontal fraction; 0.8 is a pitch of 37
 * degrees) a sample inside a loop-tight vertical curve follows the curve's
 * normal even while it is still near upright, instead of gravity's up.
 *
 * Gravity's up, projected off a steep tangent, leans toward whatever sideways
 * component that tangent has, and a LEGO loop's entry and exit carry one (the
 * loop is a helix, its exit a track width off its entry): on 10303 the
 * gravity target rolled the up 48 degrees off the loop's own plane at pitches
 * of 60-77 degrees going into and out of its second loop, and the car's yaw,
 * taken from that up's axle (`coasterCarAttitude`), still swung 43 degrees
 * there. With the normal taking over from 37 degrees the up stays within 10
 * degrees of the loop's plane and the yaw within 13 degrees (the first loop's
 * own lean) through both loops. 0.5 (60 degrees) was measured
 * too: it leaves 20 degrees of the lean and a 19-degree yaw swing. Level track
 * (and so every dip a level car rides) never reaches this branch.
 */
const LOOP_STEEP_LEVEL = 0.8;

/**
 * The physical up vector at every authored sample. Parallel transport
 * (`buildCoasterFrames`) is the minimum-twist frame, which is exactly wrong
 * for a coaster: a helical loop has torsion, so the transported frame leaves
 * the loop banked and STAYS banked — on 10303 the cars ran 61-84 degrees on
 * their side from the first loop to the top of the lift, and the deck at the
 * top received them rolled 117 degrees. LEGO track is never banked: upright
 * track carries gravity's up, and through a loop the rails face the loop's
 * centre. So each transported up is twisted about the tangent toward that
 * target — gravity's up projected off the tangent where the track is upright
 * (weighted by how upright and how level it is), the smoothed curve normal
 * where the track bends in a vertical plane tighter than `LOOP_RADIUS_MAX`
 * with its centre on the car's up side (a loop or a dip, never a crest) and is
 * either steeper than `LOOP_STEEP_LEVEL` or already banked past 60 degrees — at
 * no more than `TRACK_TWIST_RATE_DEG_PER_BLOCK`, and a correction applied at
 * one sample is carried by the transport into every later one. Vertical and
 * inverted track outside a loop keeps the transport. A closed route's seam
 * stays continuous: the last frame is the first.
 */
export function coasterTrackUps(path: CoasterPath): CoasterVec3[] {
  const transported = buildCoasterFrames(path);
  const points = path.points, cumulative = path.cumulative, last = points.length - 1;
  const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const unit = (v: readonly number[]): Vec3 => { const l = len3(v); return l > 1e-12 ? [v[0]! / l, v[1]! / l, v[2]! / l] : [0, 0, 0]; };
  const perpendicular = (v: readonly number[], t: readonly number[]): Vec3 => { const a = dot(v, t); return unit([v[0]! - a * t[0]!, v[1]! - a * t[1]!, v[2]! - a * t[2]!]); };
  const rotate = (v: readonly number[], axis: readonly number[], angle: number): Vec3 => {
    const c = Math.cos(angle), s = Math.sin(angle), k = dot(axis, v) * (1 - c), x = cross(axis, v);
    return [v[0]! * c + x[0] * s + axis[0]! * k, v[1]! * c + x[1] * s + axis[1]! * k, v[2]! * c + x[2] * s + axis[2]! * k];
  };
  // The same central-difference tangents the transport was built on.
  const tangents: Vec3[] = [];
  for (let i = 0; i <= last; i++) {
    if (path.closed && i === last) { tangents.push(tangents[0]!); continue; }
    const p = points[i === 0 ? (path.closed ? last - 1 : 0) : i - 1]!, n = points[i === last ? last : i + 1]!;
    let t = unit(sub3(n, p));
    if (!len3(t)) t = unit(sub3(n, points[i]!));
    tangents.push(t);
  }
  const ups: CoasterVec3[] = [];
  let carried = 0, before = 0;
  for (let i = 0; i <= last; i++) {
    const t = tangents[i]!;
    let up = perpendicular(rotate(transported[i]!, t, carried), t);
    // Curvature over a window: the tangents CURVATURE_HALF_WINDOW behind and ahead.
    while (before < i && cumulative[before + 1]! <= cumulative[i]! - CURVATURE_HALF_WINDOW) before++;
    let after = i;
    while (after < last && cumulative[after]! < cumulative[i]! + CURVATURE_HALF_WINDOW) after++;
    const span = cumulative[after]! - cumulative[before]!;
    const turn = sub3(tangents[after]!, tangents[before]!);
    const curvature = span > 0 ? len3(turn) / span : 0;
    const normal = perpendicular(turn, t);
    const binormal = cross(t, normal);
    let target: Vec3 | undefined, weight = 0;
    const level = Math.hypot(t[0], t[2]);
    const gravity = level > TRACK_LEVEL_MIN ? perpendicular([0, 1, 0], t) : undefined;
    const upright = gravity ? dot(up, gravity) : -1;
    const loop = curvature > 1 / LOOP_RADIUS_MAX && Math.abs(binormal[1]) < 0.5 && dot(normal, up) > 0.5;
    if (loop && level < LOOP_STEEP_LEVEL) {
      // Steep inside a loop-tight vertical curve: the loop's normal, which
      // gravity's up only approximates here (`LOOP_STEEP_LEVEL`).
      target = normal; weight = 1;
    } else if (upright > 0.5 && gravity) {
      // Within 60 degrees of upright: gravity's up, weighted by how upright and how level.
      target = gravity; weight = upright * level;
    } else if (loop) {
      // Banked past that inside a vertical curve with its centre on the car's
      // up side: the loop's normal. A level dip is upright and never reaches
      // here, so the sample-join noise in a polyline's normal cannot roll a level car.
      target = normal; weight = 1;
    } else if (upright > 0 && gravity) {
      target = gravity; weight = upright * level;
    }
    if (target) {
      const twist = Math.atan2(dot(cross(up, target), t), dot(up, target));
      const cap = i === 0 ? Math.PI : TRACK_TWIST_RATE_DEG_PER_BLOCK * Math.PI / 180 * (cumulative[i]! - cumulative[i - 1]!);
      const step = Math.max(-cap, Math.min(cap, weight * twist));
      up = perpendicular(rotate(up, t, step), t);
      carried += step;
    }
    ups.push(up);
  }
  if (path.closed) ups[last] = ups[0]!;
  return ups;
}

/** Half-width, model blocks, of the tangent window a loop's radius is measured over: wide enough to span a sample-join jog, narrow against a 3.7-block loop. */
const LOOP_RADIUS_HALF_WINDOW = 1.5;

/**
 * The radius (model blocks) of the route's inversions: the median, over every
 * sample whose up points below the horizon, of the curve radius measured
 * between tangents `LOOP_RADIUS_HALF_WINDOW` either side. 0 for a route that
 * never inverts. The median, because a single sample-join jog can read as a
 * straight (infinite radius) or a kink (zero) and one loop's samples outvote it.
 * The runtime keeps a train through an inversion at `INVERSION_MARGIN` ×
 * sqrt(g r); the add-on preview calls this same function.
 */
export function coasterLoopRadius(path: CoasterPath, ups: readonly CoasterVec3[]): number {
  const points = path.points, cumulative = path.cumulative, last = points.length - 1;
  const tangent = (i: number): Vec3 => {
    const a = points[Math.max(0, i - 1)]!, b = points[Math.min(last, i + 1)]!;
    const d = sub3(b, a), l = len3(d);
    return l > 1e-12 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 0, 0];
  };
  const radii: number[] = [];
  for (let i = 0; i <= last; i++) {
    if (!(ups[i]![1] < 0)) continue;
    let before = i, after = i;
    while (before > 0 && cumulative[i]! - cumulative[before]! < LOOP_RADIUS_HALF_WINDOW) before--;
    while (after < last && cumulative[after]! - cumulative[i]! < LOOP_RADIUS_HALF_WINDOW) after++;
    const span = cumulative[after]! - cumulative[before]!;
    const turn = len3(sub3(tangent(after), tangent(before)));
    if (span > 0 && turn > 1e-6) radii.push(span / turn);
  }
  if (!radii.length) return 0;
  radii.sort((a, b) => a - b);
  return radii[Math.floor(radii.length / 2)]!;
}

// ─── Car attitude ────────────────────────────────────────────────────────────

/** A car's pose as Bedrock draws it: entity yaw, then the `track_pitch` bone, then `track_roll`, all degrees. */
export interface CoasterCarAttitude { yaw: number; pitch: number; roll: number }

/**
 * Split a car's nose and up (unit-ish vectors in ONE frame, world or model)
 * into the entity yaw and the two bone angles the pack animates, choosing the
 * yaw so it never swivels.
 *
 * The yaw is the azimuth of the car's HEADING — the horizontal direction at
 * right angles to its axle (`nose × up`) — not the azimuth of its nose. The two
 * agree exactly on upright unbanked track, which is every LEGO track outside a
 * loop. Through a loop they do not: the nose passes vertical twice, and near
 * vertical its horizontal part is whatever small sideways component the track
 * has. A LEGO loop is a HELIX (its exit is offset one track width from its
 * entry), so on 10303's second loop the nose azimuth swung 69 degrees in the
 * ticks before the car counted as inverted (up to 53 in one tick), the yaw was
 * then HELD there through the loop and swung back on the way out — a
 * 101-degree swivel of the rider, whose camera turns with the entity's yaw.
 * The first loop happens to enter square, which is why the earlier hold fixed
 * it and not the second.
 * The axle is horizontal through any loop, planar or helical, and turns only
 * as fast as the track really turns, so a yaw taken from it is continuous with
 * no hold, no threshold on the nose and no memory of which loop it is in.
 *
 * `fallbackYaw` serves only a car rolled onto its side (the axle within
 * `1 - headingMin` of vertical), where the axle's azimuth is undefined. The
 * pitch then runs continuously through ±180 in the heading's own vertical
 * plane and the roll is what is left of the up about the nose. This function
 * is serialized into the pack (passed to `coasterRuntime` like
 * `sampleCoasterPath`), so it may reference nothing outside its own body.
 */
export function coasterCarAttitude(nose: readonly number[], up: readonly number[], fallbackYaw: number, headingMin = 0.2): CoasterCarAttitude {
  const nLength = Math.hypot(nose[0]!, nose[1]!, nose[2]!) || 1;
  const n = [nose[0]! / nLength, nose[1]! / nLength, nose[2]! / nLength];
  const along = up[0]! * n[0]! + up[1]! * n[1]! + up[2]! * n[2]!;
  let u = [up[0]! - along * n[0]!, up[1]! - along * n[1]!, up[2]! - along * n[2]!];
  const uLength = Math.hypot(u[0]!, u[1]!, u[2]!);
  u = uLength > 1e-9 ? [u[0]! / uLength, u[1]! / uLength, u[2]! / uLength] : [0, 1, 0];
  // The axle (nose × up) and the heading at right angles to it in the
  // horizontal plane (world up × axle); for a level car the heading IS the nose.
  const axleX = n[1]! * u[2]! - n[2]! * u[1]!, axleZ = n[0]! * u[1]! - n[1]! * u[0]!;
  const headingX = axleZ, headingZ = -axleX;
  const toDeg = 180 / Math.PI;
  const yaw = Math.hypot(headingX, headingZ) > headingMin ? Math.atan2(-headingX, headingZ) * toDeg : fallbackYaw;
  const yawRad = yaw / toDeg, sinYaw = Math.sin(yawRad), cosYaw = Math.cos(yawRad);
  // Pitch: the nose in the yawed heading's vertical plane; it runs past ±90 through a loop.
  const alongHeading = -n[0]! * sinYaw + n[2]! * cosYaw;
  const pitch = -Math.atan2(n[1]!, alongHeading) * toDeg;
  // Roll: remove the entity yaw, then the bone pitch, from the up.
  const pitchRad = pitch / toDeg;
  const localX = u[0]! * cosYaw + u[2]! * sinYaw;
  const yawZ = -u[0]! * sinYaw + u[2]! * cosYaw;
  const localY = u[1]! * Math.cos(pitchRad) + yawZ * Math.sin(pitchRad);
  const roll = Math.atan2(-localX, localY) * toDeg;
  return { yaw, pitch, roll };
}

/** The rider's camera for one tick: Bedrock rotation (degrees; pitch positive looks down) plus the view's direction and up. */
export interface CoasterRiderView { yaw: number; pitch: number; roll: number; direction: number[]; up: number[] }

/**
 * The rider's camera from the car's frame and the rider's own look offset.
 *
 * `nose` and `up` are the car's (any one frame, world or model); `look` is how
 * far the rider has turned their head from it, degrees, Bedrock sense (+yaw
 * turns right, +pitch looks down), already clamped by `coasterRiderLook`. The
 * look is applied IN THE CAR'S FRAME — yaw about the car's up, then pitch about
 * the turned axle — so "look left" upside down in a loop is still the rider's
 * left, as it is for a real rider.
 *
 * `over` returns the roll-free rotation closest to the view (yaw from its
 * right axis, pitch fitted to its direction and up), so the pitch runs on past
 * ±90 through a loop and the yaw moves only as the track turns. `clamp` gives the plain
 * direction's yaw/pitch within ±90 and limits the yaw to `maxTurn` degrees per
 * tick, so passing the zenith turns the image over in a few ticks instead of
 * one. Both are unwrapped against `previous`, so a camera ease never takes the
 * long way round the ±180 seam. The roll that `over` cannot draw (only the
 * helix's lean, or a large look offset inside a loop) is returned for anything
 * that can draw it (the add-on preview).
 *
 * Serialized into the pack like `coasterCarAttitude`: it may reference nothing
 * outside its own body.
 */
export function coasterRiderView(nose: readonly number[], up: readonly number[], look: { yaw: number; pitch: number }, previous: { yaw: number; pitch: number; roll?: number } | null,
  mode: string, maxTurn: number): CoasterRiderView {
  const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
  const nLength = Math.hypot(nose[0]!, nose[1]!, nose[2]!) || 1;
  const n = [nose[0]! / nLength, nose[1]! / nLength, nose[2]! / nLength];
  const along = up[0]! * n[0]! + up[1]! * n[1]! + up[2]! * n[2]!;
  let u = [up[0]! - along * n[0]!, up[1]! - along * n[1]!, up[2]! - along * n[2]!];
  const uLength = Math.hypot(u[0]!, u[1]!, u[2]!);
  u = uLength > 1e-9 ? [u[0]! / uLength, u[1]! / uLength, u[2]! / uLength] : [0, 1, 0];
  // The rider's right: nose × up (facing +Z with +Y up, that is -X, which a
  // Bedrock yaw of +90 faces — so +yaw turns right, as the player's own does).
  const r = [n[1]! * u[2]! - n[2]! * u[1]!, n[2]! * u[0]! - n[0]! * u[2]!, n[0]! * u[1]! - n[1]! * u[0]!];
  const a = look.yaw * toRad, b = look.pitch * toRad;
  const heading = [0, 1, 2].map(k => Math.cos(a) * n[k]! + Math.sin(a) * r[k]!);
  const direction = [0, 1, 2].map(k => Math.cos(b) * heading[k]! - Math.sin(b) * u[k]!);
  const viewUp = [0, 1, 2].map(k => Math.sin(b) * heading[k]! + Math.cos(b) * u[k]!);
  const wrap = (angle: number) => ((angle % 360) + 540) % 360 - 180;
  const near = (angle: number, reference: number | undefined) => reference === undefined || !Number.isFinite(reference) ? angle : reference + wrap(angle - reference);
  // The roll that takes a camera at (yaw, pitch) with no roll to the view's
  // own up, about the view direction. Positive rolls the view to its LEFT
  // (right side up): measured on the Pixel, a spline keyframe rotation of
  // {x: 0, y: 0, z: 90} put the ground on the LEFT of the screen.
  const rollTo = (yawDeg: number, pitchDeg: number): number => {
    const y = yawDeg * toRad, p = pitchDeg * toRad;
    const r0 = [-Math.cos(y), 0, -Math.sin(y)];
    const u0 = [-Math.sin(y) * Math.sin(p), Math.cos(p), Math.cos(y) * Math.sin(p)];
    return Math.atan2(-(viewUp[0]! * r0[0]! + viewUp[2]! * r0[2]!), viewUp[0]! * u0[0]! + viewUp[1]! * u0[1]! + viewUp[2]! * u0[2]!) * toDeg;
  };
  if (mode === 'clamp' || mode === 'roll') {
    // The direction's own yaw and pitch (within ±90, as `setCamera` demands).
    // At the zenith the direction has no azimuth; hold the last yaw and let
    // the roll (in `roll` mode) carry the rest.
    const horizontal = Math.hypot(direction[0]!, direction[2]!);
    const target = horizontal > 1e-4 ? Math.atan2(-direction[0]!, direction[2]!) * toDeg : (previous ? previous.yaw : 0);
    let yaw = near(target, previous?.yaw);
    // `clamp` cannot roll, so the 180-degree turn over a loop's side is spread
    // over a few ticks; `roll` is exact and needs no limit.
    if (mode === 'clamp' && previous && Number.isFinite(previous.yaw) && maxTurn > 0) yaw = previous.yaw + Math.max(-maxTurn, Math.min(maxTurn, yaw - previous.yaw));
    const pitch = -Math.asin(Math.max(-1, Math.min(1, direction[1]!))) * toDeg;
    const roll = mode === 'roll' ? near(rollTo(yaw, pitch), previous?.roll) : 0;
    return { yaw, pitch, roll, direction, up: viewUp };
  }
  // `over` / `rollover`: the yaw is the heading of the view's own right axis
  // (d × u, projected level) — continuous through any loop, planar or helical,
  // exactly as the car's yaw is taken from its axle — and the pitch fits BOTH
  // axes in that heading's vertical plane (maximising d0·d + u0·u for
  // d0 = cos p h - sin p y, u0 = sin p h + cos p y), so it runs on past ±90
  // through a loop with no representation flip at the zenith. What is left is
  // a small roll (10303's helix lean, ~12 degrees), which `rollover` draws and
  // `over` drops. Needs a client that takes a pitch outside ±90: `setCamera`
  // on the Pixel does NOT ("Pitch (x rot) is outside accepted range").
  const right = [direction[1]! * viewUp[2]! - direction[2]! * viewUp[1]!, direction[2]! * viewUp[0]! - direction[0]! * viewUp[2]!, direction[0]! * viewUp[1]! - direction[1]! * viewUp[0]!];
  const level = Math.hypot(right[0]!, right[2]!);
  // Right axis (-cos y, 0, -sin y). Within ~11 degrees of vertical (a view
  // rolled on its side) it has no heading: hold the last yaw.
  let yaw = level > 0.2 ? near(Math.atan2(-right[2]!, -right[0]!) * toDeg, previous?.yaw) : (previous && Number.isFinite(previous.yaw) ? previous.yaw : 0);
  if (previous && Number.isFinite(previous.yaw) && maxTurn > 0) yaw = previous.yaw + Math.max(-maxTurn, Math.min(maxTurn, yaw - previous.yaw));
  const yr = yaw * toRad;
  const h = [-Math.sin(yr), 0, Math.cos(yr)];
  const hd = h[0]! * direction[0]! + h[2]! * direction[2]!, hu = h[0]! * viewUp[0]! + h[2]! * viewUp[2]!;
  const pitch = near(Math.atan2(hu - direction[1]!, hd + viewUp[1]!) * toDeg, previous?.pitch);
  return { yaw, pitch, roll: near(rollTo(yaw, pitch), previous?.roll), direction, up: viewUp };
}

/** The rider's look offset and the reference it is measured from. */
export interface CoasterRiderLook { yaw: number; pitch: number; yawRef: number; pitchRef: number }

/**
 * The rider's head turn relative to the car, clamped, from the player's own
 * rotation. `relativeYaw` is the player's yaw less the car's (Bedrock turns a
 * rider with its vehicle, so this is what the player has turned themselves);
 * `pitch` is the player's own pitch. The reference is where the player was
 * looking when they boarded, so the view starts on the track frame whatever
 * they were looking at, and it RATCHETS: pushing past a limit drags the
 * reference along, so the offset is always reachable back to zero by looking
 * the other way — the same feel as a clamped head, without being able to
 * write the player's pitch (Bedrock ignores `setRotation` pitch on the phone,
 * measured 2026-09-24). Serialized into the pack; self-contained.
 */
export function coasterRiderLook(relativeYaw: number, pitch: number, previous: { yawRef: number; pitchRef: number } | null, limitYaw: number, limitPitch: number, ratchet = true): CoasterRiderLook {
  const wrap = (angle: number) => ((angle % 360) + 540) % 360 - 180;
  let yawRef = previous && Number.isFinite(previous.yawRef) ? previous.yawRef : relativeYaw;
  let pitchRef = previous && Number.isFinite(previous.pitchRef) ? previous.pitchRef : pitch;
  let yaw = wrap(relativeYaw - yawRef);
  // Without the ratchet the reference never moves: a transient past the limit
  // (the rider's yaw trailing the car's through a fast turn) cannot shift the view for good.
  if (yaw > limitYaw) { if (ratchet) yawRef = wrap(yawRef + yaw - limitYaw); yaw = limitYaw; }
  else if (yaw < -limitYaw) { if (ratchet) yawRef = wrap(yawRef + yaw + limitYaw); yaw = -limitYaw; }
  let offset = pitch - pitchRef;
  if (offset > limitPitch) { if (ratchet) pitchRef = pitch - limitPitch; offset = limitPitch; }
  else if (offset < -limitPitch) { if (ratchet) pitchRef = pitch + limitPitch; offset = -limitPitch; }
  return { yaw, pitch: offset, yawRef, pitchRef };
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
  // The FIRST seat is the player's: its posed rider is the `rider` variant
  // the runtime hides while a player sits there. Every other seat's rider is
  // a PASSENGER, part of the car body, riding whoever drives. 76417's vault
  // cart carries Harry and Hagrid; taking only `seats[0]` shipped Harry and
  // dropped Hagrid's ten parts out of the whole pack (they had left the
  // shell as car members and were emitted nowhere, 2026-09-24).
  const [seat, ...passengers] = car.seats;
  return {
    bricks: [...car.bricks.map(convert), ...passengers.flatMap(s => s.riderBricks.map(convert))],
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
  /** Wheel contact spacing in model blocks, from the first car of this body that measured one. */
  wheelbase?: number;
  /** Routes and car counts that use this type, for the label and diagnostics. */
  cars: number;
}

export interface CoasterVehiclePlan {
  types: CoasterVehicleType[];
  /**
   * Per route (parallel to the input): every train's slots, train 0 first,
   * each train by DECREASING arc (its slot 0 leads at `centre + extent/2`),
   * or undefined for the fabricated cart. `reserveUsed` says whether the
   * second train is the set's own spare cars or a copy of the first train.
   */
  routes: Array<{ slots: CoasterCarSlot[]; count: number; trains: number; reserveUsed: boolean; spacing: number; pitches: number[]; heading: 1 | -1; datumArcs: number[]; headingsAgree: boolean } | undefined>;
  warnings: string[];
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
  const warnings: string[] = [];
  /** The type a car's body compiles to (created on first sight) and its rider variant on that type. */
  const slotOf = (car: CoasterRouteCar, label: string, train: number): CoasterCarSlot => {
    const body = placementSignature(car.bricks);
    let type = byBody.get(body);
    if (!type) {
      const n = types.length + 1;
      type = { typeId: `${stem}_vehicle_${n}`, id: `${stripNamespace(stem)}_vehicle_${n}`, chassis: car.chassis, bricks: car.bricks, riders: [], cars: 0, ...(car.seatLdu ? { seatLdu: car.seatLdu } : {}) };
      types.push(type); byBody.set(body, type); riderIndex.set(type, new Map());
    }
    if (!type.seatLdu && car.seatLdu) type.seatLdu = car.seatLdu;
    if (type.wheelbase === undefined && car.wheelbase !== undefined && car.wheelbase > 0) type.wheelbase = car.wheelbase;
    type.cars++;
    let rider = -1;
    if (car.rider.length) {
      const variants = riderIndex.get(type)!;
      const key = placementSignature(car.rider);
      rider = variants.get(key) ?? (variants.set(key, type.riders.length), type.riders.push(car.rider) - 1);
    }
    return { type: type.typeId, rider, label, train };
  };
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
    const count = kept.length;
    const pitches = kept.slice(1).map((entry, k) => round3(kept[k]!.arc - entry.arc));
    const spacing = pitches.length ? round3(pitches.reduce((s, v) => s + v, 0) / pitches.length) : 0;
    const votes = kept.reduce((sum, entry) => sum + entry.car.heading, 0);
    const heading: 1 | -1 = votes < 0 ? -1 : 1;
    const carLabel = (k: number, train: number): string => {
      const prefix = train ? `${route.label} Train ${train + 1}` : route.label;
      return count > 1 ? `${prefix} Car ${k + 1}` : `${prefix} Ride Car`;
    };
    const slots = kept.map(({ car }, k) => slotOf(car, carLabel(k, 0), 0));
    // A second train needs a route that circulates; a shuttle would run its
    // two trains into each other at the dead end.
    const circulates = route.closed || route.lift?.kind === 'platform';
    const trains = Math.max(1, Math.floor(route.trains ?? 1));
    if (trains > 1 && !circulates) warnings.push(`${route.label}: an open shuttle runs one train; the second was not added.`);
    const trainCount = circulates ? Math.min(trains, 2) : 1;
    let reserveUsed = false;
    for (let train = 1; train < trainCount; train++) {
      const reserve = route.reserve ?? [];
      if (reserve.length >= count) {
        reserveUsed = true;
        for (let k = 0; k < count; k++) slots.push(slotOf(reserve[k]!, carLabel(k, train), train));
      } else {
        if (reserve.length) warnings.push(`${route.label}: ${reserve.length} spare car(s) are fewer than the ${count}-car train; the second train instances the first train's cars.`);
        for (let k = 0; k < count; k++) {
          const first = slots[k]!;
          const type = types.find(t => t.typeId === first.type)!;
          type.cars++;
          slots.push({ ...first, label: carLabel(k, train), train });
        }
      }
    }
    return { slots, count, trains: trainCount, reserveUsed, spacing, pitches, heading, datumArcs: kept.map(entry => round3(entry.arc)), headingsAgree: kept.every(entry => entry.car.heading === heading) };
  });
  // A car with no rider on a type that has variants still needs a value the
  // property accepts: `riders.length` is the "none" variant (no bone matches).
  for (const plan of planned) if (plan) for (const slot of plan.slots) {
    if (slot.rider < 0) slot.rider = types.find(t => t.typeId === slot.type)!.riders.length;
  }
  return { types, routes: planned, warnings };
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
    ...(route.reserve ? { reserve: route.reserve.map(car => ({ ...car, heading: car.heading === 1 ? -1 : 1 })) } : {}),
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
      const { count, trains } = vehicles;
      cars = count > 1
        ? { count, spacing: vehicles.spacing, extent: round3((count - 1) * vehicles.spacing), minChord: minimumCoupledChord(routePath, vehicles.spacing), heading: vehicles.heading, trains, slots: vehicles.slots }
        : { count: 1, spacing: 0, extent: 0, heading: vehicles.heading, trains, slots: vehicles.slots };
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
    // A driven train keeps whichever way its driver last sent it (0), circuit or not.
    const railway = route.family === 'train';
    const direction: 1 | -1 | 0 = railway ? 0
      : lift?.kind === 'chain' && route.closed ? lift.climbDirection
      : route.closed ? (cars.heading || 1)
      : lift?.kind === 'platform' ? -1 : 0;
    // A second train waits one train length behind the platform, against the
    // ride direction, and is dispatched against the lap: the circuit, or a
    // lift route's course without the deck (which the runtime path holds twice).
    let dispatch: CoasterDispatch | undefined;
    if (cars.trains > 1) {
      if (!direction) throw new Error(`${route.label}: a second train needs a fixed ride direction.`);
      const trainLength = cars.extent + (cars.count > 1 ? cars.spacing : COASTER_CAR_LENGTH);
      let hold = station.stop - direction * (trainLength + COASTER_HOLD_GAP);
      if (path.closed) hold = ((hold % path.length) + path.length) % path.length;
      const lap = path.closed ? path.length : path.length - deckLength;
      if (!path.closed && (hold < deckLength + cars.extent / 2 || hold > path.length - deckLength - cars.extent / 2)) {
        throw new Error(`${route.label}: the second train's waiting point (arc ${round3(hold)}) falls off the course.`);
      }
      dispatch = { hold: round3(hold), lap: round3(lap), ahead: round3(lap * COASTER_DISPATCH_FRACTION) };
    }
    const up = coasterTrackUps(path);
    const loopRadius = coasterLoopRadius(path, up);
    return {
      label: route.label, path, up, maxSpacing: coasterMaxSpacing(path), station, cars, direction,
      ...(loopRadius > 0 ? { loopRadius: round3(loopRadius) } : {}),
      ...(dispatch ? { dispatch } : {}),
      ...(lift?.kind === 'chain' ? { chain: { start: round3(Math.min(lift.arcStart, lift.arcEnd) + deckLength), end: round3(Math.max(lift.arcStart, lift.arcEnd) + deckLength) } } : {}),
      ...(runtimeLift ? { lift: runtimeLift } : {}),
      ...(railway ? { physics: RAIL_TRAIN_PHYSICS } : {}),
    };
  });
  return { typeId, routes: runtimeRoutes, types, physics: COASTER_PHYSICS, camera: { ...COASTER_RIDER_VIEW } };
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
  const rideable = { seat_count: 1, family_types: ['player'], interact_text: RIDE_INTERACT_TEXT,
    crouching_skip_interact: true, seats: { position: [0, 0.35 * modelScale, 0], lock_rider_rotation: 181 } };
  const geometryId = `geometry.${typeId.replace(':', '.')}`;
  const animationId = `animation.${typeId.replace(':', '.')}.track_pitch`;
  return {
    behavior: withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
      description: { identifier: typeId, is_spawnable: false, is_summonable: true,
        properties: {
          // Float actor properties MUST serialize with a decimal point or Bedrock
          // drops the whole property component; see `bedrock-json.ts`.
          [PROP_PITCH]: floatActorProperty([-180, 180], 0),
          [PROP_ROLL]: floatActorProperty([-180, 180], 0),
          ...bodyOffsetProperties(),
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
        track_pitch: { position: bodyOffsetExpression(), rotation: [`query.property('${PROP_PITCH}')`, 0, 0] },
        cart: { rotation: [0, 0, `query.property('${PROP_ROLL}')`] },
      },
    } } },
  };
}

/** The fabricated cart's wheel contact spacing in model blocks: its wheel cubes are centred 18 entity units apart. */
export const COASTER_CART_WHEELBASE = 18 / 16;

/** The three synced body-offset properties every ride car declares (float literals, see `bedrock-json.ts`). */
function bodyOffsetProperties(): Record<string, unknown> {
  return Object.fromEntries(PROP_BODY.map(name => [name, floatActorProperty([-BODY_OFFSET_RANGE, BODY_OFFSET_RANGE], 0)]));
}

/** The root bone's animated position: the body offset the runtime sets, in model units. */
function bodyOffsetExpression(): string[] {
  return PROP_BODY.map(name => `query.property('${name}')`);
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
  /** The runtime's entity types with each car's measured wheelbase and seat filled in: what `coaster.js` actually carries. */
  types: Record<string, CoasterRuntimeType>;
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
function carBehavior(typeId: string, riders: number, collision: { width: number; height: number }, seat: [number, number, number], interactText = RIDE_INTERACT_TEXT): unknown {
  const rideable = { seat_count: 1, family_types: ['player'], interact_text: interactText,
    crouching_skip_interact: true, seats: { position: seat, lock_rider_rotation: 181 } };
  return withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
    description: { identifier: typeId, is_spawnable: false, is_summonable: true,
      properties: {
        [PROP_PITCH]: floatActorProperty([-180, 180], 0),
        [PROP_ROLL]: floatActorProperty([-180, 180], 0),
        ...bodyOffsetProperties(),
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
    track_pitch: { position: bodyOffsetExpression(), rotation: [`query.property('${PROP_PITCH}')`, 0, 0] },
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
  'It rolls on gravity - slow up a climb, fast on a drop - with a chain lift on the steep ascent where the set has one. Closed measured tracks circulate; open tracks reverse at their real ends, never teleport across missing segments. The car follows the source track in 3D, and so does your view: from the seat, looking along the track, pitching through every climb and drop and over the top of a loop; drag to look around (up to 70 degrees either side, 50 up or down). A set whose cars form a train runs them as one train; any car can be boarded.',
  ...(lift ? ["The set's own lift completes the circuit: the train rolls onto the platform, which carries it up its measured travel (its counterweight sinks opposite) and lets it go at the top. The platform returns for the next lap; a train that arrives first waits at the foot."] : []),
  ...(own ? ['Two trains share each track: the second waits in the loading bay behind the platform and leaves once the first is half a lap ahead; a train coming back to an occupied platform holds behind it. Through a loop the car turns over on its rails and your view goes over the top with it.'] : []),
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
  /** Car types that run on a railway line: their prompt says the rider drives. */
  const railTypes = new Set(config.routes.filter(route => route.physics?.DRIVER).flatMap(route => (route.cars.slots ?? []).map(slot => slot.type)));
  let cartCuboids = 0, vehicleCuboids = 0;
  // The runtime's types, with what only this stage knows: the fabricated
  // cart's wheelbase at the export scale, each compiled car's seat.
  const types: Record<string, CoasterRuntimeType> = Object.fromEntries(Object.entries(config.types).map(([id, type]) => [id, { ...type }]));
  warnings.push(...plan.warnings);
  if (cartTypeUsed) {
    const cartId = stripNamespace(config.typeId);
    const cart = coasterCartAssets(config.typeId, deps.modelScale);
    const cartSeat = (cart.behavior as { 'minecraft:entity': { components: { 'minecraft:rideable': { seats: { position: [number, number, number] } } } } })['minecraft:entity'].components['minecraft:rideable'].seats.position;
    types[config.typeId] = { ...(types[config.typeId] ?? { role: 'car', riders: 0 }), wheelbase: round3(COASTER_CART_WHEELBASE * deps.modelScale), seat: cartSeat };
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
    if (type.wheelbase === undefined) warnings.push(`${label}: ${type.chassis} ride car has no measured wheelbase; it pitches on the track's local tangent instead of the chord between its wheels.`);
    types[type.typeId] = { ...(types[type.typeId] ?? { role: 'car', riders: type.riders.length }), seat, ...(type.wheelbase !== undefined ? { wheelbase: round3(type.wheelbase) } : {}) };
    const animationId = `animation.${type.typeId.replace(':', '.')}.track`;
    files.push({ name: `${rp}animations/${type.id}.animation.json`, data: jsonBytes(carAnimation(animationId, type.riders.length)) });
    compiled.push({
      id: type.id, typeId: type.typeId, role: 'car', label: `${label} ${type.chassis.replace(/\.dat$/i, '')} car`, geo,
      behavior: carBehavior(type.typeId, type.riders.length, geo.collisionBox, seat, railTypes.has(type.typeId) ? RAIL_INTERACT_TEXT : RIDE_INTERACT_TEXT),
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
  // ── Car actors: one per slot of every train, all at the station point ──
  config.routes.forEach((route, index) => {
    const p = route.station.point;
    const { count, trains } = route.cars;
    const plannedRoute = plan.routes[index];
    for (let car = 0; car < count * trains; car++) {
      const slot = route.cars.slots?.[car];
      const carLabel = slot?.label ?? (count > 1 ? `${route.label} Car ${car + 1}` : `${route.label} Ride Cart`);
      actors.push({ typeId: slot?.type ?? config.typeId, label: carLabel, x: p[0], y: p[1], z: p[2], coasterRouteIndex: index, coasterCarIndex: car });
    }
    if (trains > 1 && route.dispatch) {
      warnings.push(`${route.label}: a second ${count}-car train waits in the loading bay at arc ${route.dispatch.hold} (${plannedRoute?.reserveUsed ? "the set's own spare cars from its siding" : `a second copy of the set's ${count} car${count === 1 ? '' : 's'}; the set has no spare`}) and departs once the first is ${route.dispatch.ahead} blocks (half a lap) ahead.`);
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
    { name: `${bp}scripts/coaster.js`, data: textBytes(coasterScript({ ...config, types })) },
    { name: `${bp}COASTER.txt`, data: textBytes(COASTER_README(own, lifted)) },
  );
  const ownRoutes = config.routes.filter(route => route.cars.slots).length;
  warnings.push(`${config.routes.length} measured coaster route(s): ${ownRoutes ? `the set's own cars run ${ownRoutes === config.routes.length ? 'every route' : `${ownRoutes} of them`}${lifted ? ' and its lift completes the circuit' : ''}` : 'the grey Ride Cart runs on its own'} and stop at the reload zone — walk up and tap to ride. ${config.routes.some(route => !route.direction) ? 'Open tracks shuttle; the' : 'The'} rider's view follows the track.`);
  return { compiled, types, files, actors, names, warnings, cartCuboids, vehicleCuboids, entityTypes: compiled.length + (cartTypeUsed ? 1 : 0), cartTypeUsed };
}

/** The `coaster` block of `craftmatic-diagnostics.json`. */
export function coasterDiagnostics(config: CoasterRuntimeConfig, assets: CoasterRideAssets): unknown {
  return {
    cuboids: assets.cartCuboids, vehicleCuboids: assets.vehicleCuboids, riderRoll: false, deviceVerified: false, carLength: COASTER_CAR_LENGTH,
    twistRateDegPerBlock: TRACK_TWIST_RATE_DEG_PER_BLOCK,
    types: assets.compiled.map(entity => ({ id: entity.typeId, role: entity.role, cuboids: entity.cuboids, riderCuboids: entity.riderCuboids, riders: entity.riders, seat: (entity.behavior as any)?.['minecraft:entity']?.components?.['minecraft:rideable']?.seats?.position ?? null, wheelbase: assets.types[entity.typeId]?.wheelbase ?? null })),
    routes: config.routes.map(route => ({
      label: route.label, lengthBlocks: route.path.length, samples: route.path.points.length, closed: route.path.closed,
      station: { stop: route.station.stop, length: route.station.length, point: route.station.point },
      // The resolved train beside the station: count/spacing/extent in
      // model blocks; `minChord` is the tightest straight-line gap the
      // route leaves between coupled cars, reported and never clamped —
      // under `carLength` the fabricated cars intersect there.
      cars: { ...route.cars, ...(route.cars.minChord !== undefined ? { overlaps: route.cars.minChord < COASTER_CAR_LENGTH } : {}) },
      direction: route.direction,
      ...(route.dispatch ? { dispatch: route.dispatch } : {}),
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
  /** Routes that were left out with their reason (a parked siding), by track label; `dispatchedTo` names the ride route whose second train the siding's cars became. */
  parked: Array<{ label: string; cars: number; reason: string; dispatchedTo?: string }>;
  warnings: string[];
}

/**
 * A car's wheel contact spacing along its travel axis, in LDU: the spread of
 * its separate wheel parts' origins in the car frame, or the mould table for
 * a composite chassis whose wheels are built in. Undefined when neither knows.
 */
export function coasterCarWheelbaseLdu(car: CoasterCar, bricks: readonly ParsedBrick[]): number | undefined {
  if (car.wheels.length >= 2) {
    const rot = car.frame.rot.length === 9 ? car.frame.rot : IDENTITY;
    const toLocal = transposeM(rot);
    const along = car.wheels.map(index => { const b = bricks[index]!; return applyM(toLocal, sub3([b.x, b.y, b.z], car.frame.originLdu))[0]; });
    const spread = Math.max(...along) - Math.min(...along);
    if (spread > 1) return round3(spread);
  }
  const stem = /^(\d+)/.exec(car.chassis.part.toLowerCase())?.[1];
  return stem ? CHASSIS_WHEELBASE_LDU[stem] : undefined;
}

/** An LDraw vector (not a point) in grid blocks: LDraw Y down → grid Y up. */
export function sceneGridVector(frame: SceneGridFrame, v: readonly number[]): Vec3 {
  // The same half turn about X as `sceneGridPoint`, without the origin.
  return [v[0]! / frame.cellXZ * frame.scale, -v[1]! / frame.cellY * frame.scale, -v[2]! / frame.cellXZ * frame.scale];
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
  /** A detected car as a route vehicle, its bricks and rider taken out of the shell. */
  const routeCar = (car: CoasterCar): CoasterRouteCar => {
    const originAboveDatum = car.route!.originAboveDatumLdu;
    const canonical = canonicalCoasterCar(car, bricks, originAboveDatum);
    const datumLdu = sub3(car.frame.originLdu, mul3(car.frame.upWorld, originAboveDatum));
    for (const i of car.bricks) movedIndices.add(i);
    for (const seat of car.seats) for (const i of seat.riderBricks) { movedIndices.add(i); riderIndices.add(i); }
    const wheelbaseLdu = coasterCarWheelbaseLdu(car, bricks);
    return {
      chassis: car.chassis.part, sourceIndices: [...car.bricks, ...car.seats.flatMap(seat => [...seat.riderBricks])],
      bricks: canonical.bricks, rider: canonical.rider, ...(canonical.seatLdu ? { seatLdu: canonical.seatLdu } : {}),
      datumPoint: toBlocks(datumLdu), heading: car.route!.heading,
      ...(wheelbaseLdu !== undefined ? { wheelbaseLdu, wheelbase: round3(wheelbaseLdu / frame.cellXZ * frame.scale) } : {}),
    };
  };
  /** Sidings: their cars stay parked unless a ride route takes them as its second train. */
  const sidings: Array<{ label: string; cars: CoasterCar[]; points: Vec3[]; parked: CoasterSceneRoutes['parked'][number]; stays: string }> = [];
  /** Per emitted route: the ride routes that may take a spare train, with the count they need. */
  const rideRoutes: Array<{ route: CoasterRoute; points: Vec3[]; count: number }> = [];
  tracks.routes.forEach((track, routeIndex) => {
    const points = track.points.map(toBlocks);
    const maxSegmentLength = track.maxSegmentLengthLdu * frame.scale / Math.min(frame.cellXZ, frame.cellY);
    const railway = track.family === 'train';
    const base: CoasterRoute = { label: track.label, points, closed: track.closed, maxSegmentLength, ...(railway ? { family: 'train' as const } : {}) };
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
      // A railway line is driven wherever the train has room to move at all; a
      // coaster's short open track is a siding that holds a spare train. A
      // railway train never becomes a coaster's second train.
      if (railway && !track.closed && lengthLdu <= trainLength) {
        // The set's train fills its whole display track: there is nowhere to drive it.
        parked.push({ label: track.label, cars: cars.length, reason: `the ${round3(trainLength)}-LDU train fills its ${round3(lengthLdu)}-LDU railway line` });
        warnings.push(`${track.label}: its ${cars.length} railway car${cars.length === 1 ? '' : 's'} stay part of the build - the ${round3(trainLength)}-LDU train fills the ${round3(lengthLdu)} LDU of open line it stands on.`);
        return;
      }
      if (!railway && !track.closed && lengthLdu < PARKED_SIDING_FACTOR * trainLength) {
        const entry = { label: track.label, cars: cars.length, reason: `an open ${round3(lengthLdu)}-LDU track holding a ${round3(trainLength)}-LDU train is a siding` };
        parked.push(entry);
        sidings.push({ label: track.label, cars, points, parked: entry, stays: `${track.label}: its ${cars.length} car${cars.length === 1 ? '' : 's'} stay parked - ${round3(lengthLdu)} LDU of open track is under ${PARKED_SIDING_FACTOR} train lengths (${round3(trainLength)} LDU), a siding rather than a ride.` });
        return;
      }
      const kept = cars.slice(0, COASTER_MAX_CARS);
      if (kept.length < cars.length) warnings.push(`${track.label}: ${cars.length} cars found; the ${cars.length - kept.length} lowest on the track stay in the shell (the runtime carries at most ${COASTER_MAX_CARS} per train).`);
      vehicles = kept.map(routeCar);
    }

    // ── The route's lift ── (a railway line has none)
    let lift: CoasterRouteLift | undefined;
    for (const found of railway ? [] : assemblies.lifts) {
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
    const route: CoasterRoute = { ...base, ...(vehicles ? { vehicles } : {}), ...(lift ? { lift } : {}) };
    // The set's own cars run two trains where the route circulates (a circuit, or the lift's).
    if (vehicles && !railway && (track.closed || lift?.kind === 'platform')) {
      route.trains = COASTER_TRAINS;
      rideRoutes.push({ route, points, count: vehicles.length });
    }
    routes.push(route);
  });
  // A siding's cars become the nearest ride route's second train when there
  // are enough of them; each siding serves one route, nearest first.
  const cumulativeOf = (points: readonly Vec3[]): number[] => { const c = [0]; for (let i = 1; i < points.length; i++) c.push(c[i - 1]! + len3(sub3(points[i]!, points[i - 1]!))); return c; };
  for (const ride of rideRoutes) {
    const cumulative = cumulativeOf(ride.points);
    const candidates = sidings.filter(s => !s.parked.dispatchedTo && s.cars.length >= ride.count)
      .map(s => ({ s, distance: Math.min(...s.points.map(p => projectArcOnPolyline(ride.points, cumulative, p).distance)) }))
      .sort((a, b) => a.distance - b.distance);
    const nearest = candidates[0];
    if (!nearest) continue;
    const spare = nearest.s.cars.slice(0, ride.count);
    ride.route.reserve = spare.map(routeCar);
    nearest.s.parked.dispatchedTo = ride.route.label;
    warnings.push(`${nearest.s.label}: its ${spare.length} parked car${spare.length === 1 ? '' : 's'} run as ${ride.route.label}'s second train (${round3(nearest.distance)} blocks from that track)${nearest.s.cars.length > spare.length ? `; ${nearest.s.cars.length - spare.length} stay in the shell` : ''}.`);
  }
  for (const s of sidings) if (!s.parked.dispatchedTo) warnings.push(s.stays);
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
function coasterRuntime(config: CoasterRuntimeConfig, sample: typeof sampleCoasterPath, attitude: typeof coasterCarAttitude, riderView: typeof coasterRiderView, riderLook: typeof coasterRiderLook, Spline?: any, rideStep?: typeof rideSubstep) {
  // ── Ride physics (see the module header for the model and its units) ──
  // Every value below comes from `config.physics` (== `COASTER_PHYSICS`,
  // JSON-serialized into CONFIG by `coasterRuntimeConfig`) rather than a
  // module-level `const`: this function is serialized with `.toString()` and
  // re-evaluated with no imports but `world`/`system`, so an identifier this
  // body did not receive as an argument or read off `config` is a
  // ReferenceError on the device. The literal fallback after `||` only serves
  // a hand-built `CoasterRuntimeConfig` in a test that skips
  // `coasterRuntimeConfig`; every real pack always carries `physics`.
  const PHYSICS: Partial<CoasterPhysics> = config.physics || {};
  const GRAVITY = PHYSICS.GRAVITY ?? 9.8;
  const ROLLING = PHYSICS.ROLLING ?? 0.12;
  const DRAG = PHYSICS.DRAG ?? 0.008;
  const MIN_SPEED = PHYSICS.MIN_SPEED ?? 0.8;
  const MAX_SPEED = PHYSICS.MAX_SPEED ?? 16;
  const INVERSION_MARGIN = PHYSICS.INVERSION_MARGIN ?? 1.3;
  const LIFT_GRADE = PHYSICS.LIFT_GRADE ?? 0.08, LIFT_SPEED = PHYSICS.LIFT_SPEED ?? 2.5, LIFT_ACCEL = PHYSICS.LIFT_ACCEL ?? 12;
  const STATION_BRAKE = PHYSICS.STATION_BRAKE ?? 3.5;
  const DEPART_SPEED = PHYSICS.DEPART_SPEED ?? 3;
  const DWELL_EMPTY = PHYSICS.DWELL_EMPTY ?? 100, DWELL_LOADED = PHYSICS.DWELL_LOADED ?? 60, BOARD_TICKS = PHYSICS.BOARD_TICKS ?? 40;
  const PLATFORM_SPEED = PHYSICS.PLATFORM_SPEED ?? 2.5, PLATFORM_DWELL = PHYSICS.PLATFORM_DWELL ?? 30, PLATFORM_CLEARANCE = PHYSICS.PLATFORM_CLEARANCE ?? 1;
  /** A seated player's eye above the seat, world blocks (`SEATED_EYE_HEIGHT_BLOCKS`). */
  const RIDER_EYE = PHYSICS.RIDER_EYE ?? 1.25;
  // How horizontal a car's axle must be before its heading may set the yaw (`coasterCarAttitude`).
  const YAW_HOLD_HORIZONTAL = PHYSICS.YAW_HOLD_HORIZONTAL ?? 0.20;
  /** Declared range of the body-offset properties, model units. */
  const BODY_RANGE = PHYSICS.BODY_RANGE ?? 320;
  /** The coaster's constants as the shared ride step (`rideSubstep`) reads them. */
  const COASTER_RIDE: any = { GRAVITY, ROLLING, DRAG, MIN_SPEED, MAX_SPEED, LIFT_GRADE, LIFT_SPEED, LIFT_ACCEL };
  /** The stick of the train's driver along the car's nose, -1..1, or NaN with nobody at the controls. */
  const stickOf = (riders: any[]): number => {
    for (const rider of riders) {
      try { const m = rider?.inputInfo?.getMovementVector?.(); if (m && Number.isFinite(m.y)) return m.y; } catch {}
    }
    return NaN;
  };
  /** A route emitted before trains existed, or a partially overwritten pack. */
  const SINGLE = { count: 1, spacing: 0, extent: 0, heading: 0, trains: 1 };
  const types = config.types || {};

  /** Loaded coaster entities, by entity id. */
  const tracked = new Map<string, any>();
  /** Shared ride state, one entry per placed train (a train, not a car). */
  const trains = new Map<string, any>();
  /** The platform lift of each placement, shared by the trains that use it. */
  const hoists = new Map<string, any>();
  let ticks = 0;
  let lastErrorLogTick = -200;
  const key = 'craftmatic:coaster_';
  const warn = (riders: any[], message: string) => {
    for (const rider of riders) try { rider.onScreenDisplay?.setActionBar(message); } catch {}
  };
  // ── The rider's track-following camera (`coasterRiderView`) ──
  // One entry per player riding a car: their look reference, the last camera
  // rotation (for unwrapping), and whether this runtime made them invisible
  // (a free camera at the eye draws the rider's own upright body around it,
  // as the pinball seat measured). `seen` is refreshed while grouping, before
  // any hold can skip a train, so a paused tick never drops the camera.
  const camera: CoasterRiderViewConfig = { ...{ mode: 'off', lookYaw: 70, lookPitch: 50, ease: 0.1, maxTurn: 40, lookLag: 6, ratchet: false, spline: 0.1 }, ...(config.camera || {}) };
  const viewers = new Map<string, any>();
  /** Each rider's rotation and their car's, read together at the start of the tick. */
  const headings = new Map<string, { head: any; car: number }>();
  let cameraDebug = false, traceTicks = 0, lookLag = Math.max(0, Math.min(19, Math.round(camera.lookLag))), lookRatchet = !!camera.ratchet, stillMode = 'set', animEvery = 1;
  /** Ticks after boarding during which the look reference follows the head (see `aimRider`). */
  const SETTLE_TICKS = 10;
  const releaseViewer = (id: string) => {
    const viewer = viewers.get(id);
    viewers.delete(id);
    if (!viewer) return;
    try { viewer.player.camera.clear(); } catch {}
    if (viewer.invisible) try { viewer.player.removeEffect('invisibility'); } catch {}
  };
  const aimRider = (rider: any, frame: any) => {
    if (camera.mode === 'off' || !rider?.camera) return;
    let viewer = viewers.get(rider.id);
    if (!viewer) {
      viewer = { player: rider, look: null, view: null, invisible: false, seen: ticks, settle: SETTLE_TICKS };
      viewers.set(rider.id, viewer);
      try { rider.addEffect('invisibility', 20 * 60 * 60, { showParticles: false }); viewer.invisible = true; } catch {}
    }
    viewer.player = rider;
    viewer.seen = ticks;
    // Sampled with the car's rotation at the start of the tick (see the
    // grouping stage); a rider seen only now falls back to the car's last yaw.
    const sampled = headings.get(rider.id);
    const rotation = sampled ? sampled.head : rider.getRotation();
    const nowYaw = sampled && Number.isFinite(sampled.car) ? sampled.car : Number.isFinite(frame.priorYaw) ? frame.priorYaw : frame.yaw;
    // The rider's yaw is the CLIENT's (it turns the rider with its own,
    // interpolated view of the car), so it can trail the server's car yaw:
    // compare it with the car's yaw `lookLag` ticks back.
    viewer.carYaws = viewer.carYaws || [];
    viewer.carYaws.push(nowYaw);
    if (viewer.carYaws.length > 20) viewer.carYaws.shift();
    const carYaw = viewer.carYaws[Math.max(0, viewer.carYaws.length - 1 - lookLag)];
    // Bedrock turns a new rider to face the seat a few ticks AFTER mounting
    // (Pixel: a 65-degree offset appeared once boarded), so the look reference
    // follows the head until that has settled: the ride starts looking ahead.
    if (viewer.settle > 0) { viewer.settle--; viewer.look = null; }
    viewer.look = riderLook(rotation.y - carYaw, rotation.x, viewer.look, camera.lookYaw, camera.lookPitch, lookRatchet);
    viewer.view = riderView(frame.nose, frame.up, viewer.look, viewer.view, camera.mode, camera.maxTurn);
    const eye = frame.eye, view = viewer.view;
    if (traceTicks > 0) {
      traceTicks--;
      console.warn(`CAMTRACE ${ticks} carNow=${carYaw.toFixed(2)} car=${frame.yaw.toFixed(2)} prior=${Number(frame.priorYaw).toFixed(2)} carP=${frame.pitch.toFixed(2)} headY=${rotation.y.toFixed(2)} headP=${rotation.x.toFixed(2)} live=${JSON.stringify(rider.getRotation())} look=${viewer.look.yaw.toFixed(2)}/${viewer.look.pitch.toFixed(2)} cam=${viewer.view.yaw.toFixed(2)}/${viewer.view.pitch.toFixed(2)} eye=${frame.eye.x.toFixed(2)},${frame.eye.y.toFixed(2)},${frame.eye.z.toFixed(2)}`);
    }
    if ((camera.mode === 'roll' || camera.mode === 'rollover') && Spline) {
      // Roll is only reachable through a camera ANIMATION (`setCamera` takes
      // yaw and pitch alone). Its rotation keyframes must be MORE than 0.05 s
      // apart (Pixel: "Time between rotation frames must be greater than
      // 0.05"), so a one-tick animation is refused. Each tick therefore plays
      // a `spline`-second animation (0.1) that starts at this tick's true pose
      // and runs on at the pose's current rate; the next tick replaces it
      // halfway, where the camera has reached about the next true pose, so
      // the motion is continuous with no added lag. A component that jumped
      // (the yaw and roll swapping sides at a zenith) is not extrapolated.
      // The free camera the animation needs is set once, at the first frame.
      const rotation = { x: view.pitch, y: view.yaw, z: view.roll };
      if (!viewer.eye) {
        rider.camera.setCamera('minecraft:free', { location: eye, rotation: { x: Math.max(-90, Math.min(90, view.pitch)), y: view.yaw } });
      } else {
        const seconds = camera.spline > 0.05 ? camera.spline : 0.1;
        const ahead = seconds / (0.05 * animEvery);
        const from = viewer.eye, last = viewer.rotation;
        const step = [eye.x - from.x, eye.y - from.y, eye.z - from.z];
        const moved = Math.hypot(step[0]!, step[1]!, step[2]!) > 0.01;
        if (!moved && stillMode === 'set') {
          // Standing still (the station, the lift deck, a hold): the plain
          // camera, eased; a still car is upright, so there is no roll to lose.
          rider.camera.setCamera('minecraft:free', { location: eye, rotation: { x: Math.max(-90, Math.min(90, view.pitch)), y: view.yaw }, easeOptions: { easeTime: Math.max(0.05, camera.ease), easeType: 'Linear' } });
          viewer.eye = eye; viewer.rotation = rotation;
          return;
        }
        if (animEvery > 1 && ticks % animEvery !== 0) return;
        const spline = new Spline();
        // The Pixel refuses a linear spline of TWO points ("Linear needs at
        // least 2 control points", with them 0.01 and 1 block apart alike)
        // and plays one of three, so the segment is given its midpoint too. A
        // car standing still holds the first point with its progress at 0.
        const end = moved ? { x: eye.x + step[0]! * ahead, y: eye.y + step[1]! * ahead, z: eye.z + step[2]! * ahead } : { x: eye.x, y: eye.y + 1, z: eye.z };
        spline.controlPoints = [eye, { x: (eye.x + end.x) / 2, y: (eye.y + end.y) / 2, z: (eye.z + end.z) / 2 }, end];
        const extrapolate = (now: number, before: number) => { const rate = now - before; return Math.abs(rate) <= 30 ? now + rate * ahead : now; };
        const target = { x: extrapolate(rotation.x, last.x), y: extrapolate(rotation.y, last.y), z: extrapolate(rotation.z, last.z) };
        // `roll` keeps the pitch within ±90; `rollover` asks the keyframes for more (device probe).
        if (camera.mode === 'roll') target.x = Math.max(-90, Math.min(90, target.x));
        rider.camera.playAnimation(spline, { totalTimeSeconds: seconds, animation: {
          progressKeyFrames: [{ alpha: 0, timeSeconds: 0 }, { alpha: moved ? 1 : 0, timeSeconds: seconds }],
          rotationKeyFrames: [{ rotation, timeSeconds: 0 }, { rotation: target, timeSeconds: seconds }] } });
      }
      viewer.eye = eye; viewer.rotation = rotation;
    } else {
      // `setCamera` refuses a pitch outside ±90 (Pixel, 26.51): only `over`
      // ever asks for one, and it is not a device mode.
      const options: any = { location: eye, rotation: { x: view.pitch, y: view.yaw } };
      if (camera.ease > 0) options.easeOptions = { easeTime: camera.ease, easeType: 'Linear' };
      rider.camera.setCamera('minecraft:free', options);
    }
    if (cameraDebug && ticks % 5 === 0) {
      try { rider.onScreenDisplay?.setActionBar(`cam ${camera.mode} y${viewer.view.yaw.toFixed(0)} p${viewer.view.pitch.toFixed(0)} | car y${frame.yaw.toFixed(0)} p${frame.pitch.toFixed(0)} | head y${rotation.y.toFixed(0)} p${rotation.x.toFixed(0)} | look ${viewer.look.yaw.toFixed(0)}/${viewer.look.pitch.toFixed(0)}`); } catch {}
    }
  };
  // Device tuning and measurement hook: `/scriptevent craftmatic:coaster_cam <words>`.
  //   mode clamp|roll|rollover|over|off · ease <s> · spline <s> · look <yaw> <pitch> · turn <deg> · debug 0|1 · trace <ticks>
  //   rot <pitch> <yaw>       free camera at the sender's eye with that rotation (pitch range probe)
  //   roll <pitch> <yaw> <z>  a 6 s playAnimation holding rotation {x,y,z} (roll probe)
  //   attach [locator]        attach the sender's camera to the nearest car (bone-following probe)
  //   clear                   clear the sender's camera
  // # TODO: remove once the camera defaults are device-final (see TASKS-BEDROCK-ADDON.md).
  try {
    system.afterEvents.scriptEventReceive.subscribe((event: any) => {
      if (event.id !== 'craftmatic:coaster_cam') return;
      const words = String(event.message || '').trim().split(/\s+/);
      const number = (k: number, fallback: number) => { const v = Number(words[k]); return Number.isFinite(v) ? v : fallback; };
      const source = event.sourceEntity;
      const verb = words[0];
      if (verb === 'mode' && ['over', 'clamp', 'roll', 'rollover', 'off'].includes(words[1]!)) {
        camera.mode = words[1] as CoasterRiderViewMode;
        for (const id of [...viewers.keys()]) releaseViewer(id);
      } else if (verb === 'ease') camera.ease = Math.max(0, number(1, camera.ease));
      else if (verb === 'look') { camera.lookYaw = Math.max(0, number(1, camera.lookYaw)); camera.lookPitch = Math.max(0, number(2, camera.lookPitch)); }
      else if (verb === 'turn') camera.maxTurn = Math.max(0, number(1, camera.maxTurn));
      else if (verb === 'spline') camera.spline = Math.max(0.06, number(1, camera.spline));
      else if (verb === 'debug') cameraDebug = words[1] === '1';
      else if (verb === 'lag') lookLag = Math.max(0, Math.min(19, Math.round(number(1, 0))));
      else if (verb === 'ratchet') lookRatchet = words[1] !== '0';
      else if (verb === 'every') animEvery = Math.max(1, Math.min(20, Math.round(number(1, 1))));
      else if (verb === 'still') stillMode = words[1] === 'anim' ? 'anim' : 'set';
      else if (verb === 'trace') traceTicks = Math.max(0, Math.min(2000, number(1, 200)));
      else if (source?.camera) {
        const at = source.getHeadLocation ? source.getHeadLocation() : source.location;
        if (verb === 'rot') source.camera.setCamera('minecraft:free', { location: at, rotation: { x: number(1, 0), y: number(2, 0) } });
        else if (verb === 'roll') {
          // The free camera takes only ±90; the keyframes below carry the asked pitch (does a keyframe take more?).
          source.camera.setCamera('minecraft:free', { location: at, rotation: { x: Math.max(-90, Math.min(90, number(1, 0))), y: number(2, 0) } });
          const rotation = { x: number(1, 0), y: number(2, 0), z: number(3, 0) };
          system.runTimeout(() => {
            try {
              // Two points 0.01 apart were refused on the Pixel ("Linear needs at
              // least 2 control points"); three a block apart drift the eye 1 block in 6 s.
              const spline = Spline ? new Spline() : {};
              spline.controlPoints = [at, { x: at.x, y: at.y + 0.5, z: at.z }, { x: at.x, y: at.y + 1, z: at.z }];
              source.camera.playAnimation(spline, { totalTimeSeconds: 6, animation: {
                progressKeyFrames: [{ alpha: 0, timeSeconds: 0 }, { alpha: 1, timeSeconds: 6 }],
                rotationKeyFrames: [{ rotation, timeSeconds: 0 }, { rotation, timeSeconds: 6 }] } });
            } catch (error) { console.warn(`[Craftmatic coaster] roll probe: ${error instanceof Error ? error.message : String(error)}`); }
          }, 2);
        } else if (verb === 'seq') {
          // Chaining probe: seq <interval ticks> <seconds> <count> <roll step> <move 0|1>.
          // A free camera at the eye, then `count` animations every `interval`
          // ticks, each `seconds` long, rolling `step` degrees further; `move`
          // drifts the eye up 0.05 blocks a tick (else progress holds at 0).
          const interval = Math.max(1, Math.round(number(1, 1))), seconds = Math.max(0.06, number(2, 0.1));
          const count = Math.max(1, Math.round(number(3, 60))), rollStep = number(4, 3), move = number(5, 1) !== 0;
          const yaw = source.getRotation().y;
          source.camera.setCamera('minecraft:free', { location: at, rotation: { x: 0, y: yaw } });
          let k = 0;
          const run = system.runInterval(() => {
            if (k >= count) { system.clearRun(run); return; }
            try {
              const rise = move ? 0.05 * interval : 0;
              const p0 = { x: at.x, y: at.y + k * rise, z: at.z };
              const p2 = move ? { x: at.x, y: at.y + (k + 2) * rise, z: at.z } : { x: at.x, y: at.y + 1, z: at.z };
              const spline = Spline ? new Spline() : {};
              spline.controlPoints = [p0, { x: p0.x, y: (p0.y + p2.y) / 2, z: p0.z }, p2];
              source.camera.playAnimation(spline, { totalTimeSeconds: seconds, animation: {
                progressKeyFrames: [{ alpha: 0, timeSeconds: 0 }, { alpha: move ? 1 : 0, timeSeconds: seconds }],
                rotationKeyFrames: [{ rotation: { x: 0, y: yaw, z: k * rollStep }, timeSeconds: 0 }, { rotation: { x: 0, y: yaw, z: (k + 1) * rollStep }, timeSeconds: seconds }] } });
            } catch (error) { console.warn(`[Craftmatic coaster] seq probe ${k}: ${error instanceof Error ? error.message : String(error)}`); }
            k++;
          }, interval);
        } else if (verb === 'attach') {
          // Does a camera attached to a car inherit its animated pitch/roll? The nearest car within 24 blocks.
          let best: any, bestDistance = 24;
          for (const state of tracked.values()) {
            if (state.role !== 'car') continue;
            try {
              const l = state.entity.location, d = Math.hypot(l.x - at.x, l.y - at.y, l.z - at.z);
              if (d < bestDistance) { best = state.entity; bestDistance = d; }
            } catch {}
          }
          if (best) source.camera.attachToEntity({ entity: best, locator: words[1] || 'Eyes' });
        } else if (verb === 'clear') source.camera.clear();
      }
      console.warn(`[Craftmatic coaster] camera ${words.join(' ')} -> ${JSON.stringify(camera)}`);
    });
  } catch { /* A host without script events (the offline tests) has no tuning hook. */ }
  const report = (id: string, stage: string, error: unknown, riders: any[]) => {
    const detail = error instanceof Error ? error.message : String(error);
    const boundedDetail = detail.slice(0, 160);
    warn(riders, `Coaster paused at ${stage}: ${boundedDetail}`);
    if (ticks - lastErrorLogTick >= 200) {
      console.warn(`[Craftmatic coaster] ${config.typeId} ${id} at ${stage}: ${boundedDetail}`);
      lastErrorLogTick = ticks;
    }
  };
  /** Position and tangent at an arc, without the validated sampler's per-call checks (those run once per car per tick). */
  const locate = (path: any, arc: number) => {
    const total = path.length;
    const distance = path.closed ? ((arc % total) + total) % total : Math.max(0, Math.min(total, arc));
    let low = 0, high = path.points.length - 2;
    while (low < high) { const middle = (low + high + 1) >> 1; if (path.cumulative[middle] <= distance) low = middle; else high = middle - 1; }
    const from = path.points[low], to = path.points[low + 1], length = path.cumulative[low + 1] - path.cumulative[low];
    const ratio = length > 0 ? (distance - path.cumulative[low]) / length : 0;
    return { position: [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio, from[2] + (to[2] - from[2]) * ratio],
      tangent: [(to[0] - from[0]) / length, (to[1] - from[1]) / length, (to[2] - from[2]) / length] };
  };
  /** The direction a car points at an arc: the chord between its wheel contacts, or the local tangent for a car with no measured wheelbase. */
  const chordAt = (path: any, arc: number, wheelbase: number): number[] => {
    if (!(wheelbase > 0)) return locate(path, arc).tangent;
    const front = locate(path, arc + wheelbase / 2).position, rear = locate(path, arc - wheelbase / 2).position;
    const chord = [front[0] - rear[0], front[1] - rear[1], front[2] - rear[2]];
    const length = Math.hypot(chord[0], chord[1], chord[2]);
    return length > 1e-6 ? [chord[0] / length, chord[1] / length, chord[2] / length] : locate(path, arc).tangent;
  };
  /** The track's up vector at an arc, interpolated between authored samples. */
  const upAt = (route: any, arc: number): number[] => {
    const path = route.path, total = path.length;
    const distance = path.closed ? ((arc % total) + total) % total : Math.max(0, Math.min(total, arc));
    let low = 0, high = path.points.length - 2;
    while (low < high) { const middle = (low + high + 1) >> 1; if (path.cumulative[middle] <= distance) low = middle; else high = middle - 1; }
    const length = path.cumulative[low + 1] - path.cumulative[low];
    const ratio = length > 0 ? (distance - path.cumulative[low]) / length : 0;
    const a = route.up[low], b = route.up[low + 1];
    return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio, a[2] + (b[2] - a[2]) * ratio];
  };
  const tick = () => {
    ticks++;
    headings.clear();
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
    // ── Group every loaded entity by its placement and train ──
    // Cars of one train share a single ride state, so they move rigidly; a
    // single-cart route is simply a train of one and is unchanged by this. A
    // route's second train is its own group; the placement's platform and
    // counterweight belong to the placement, shared by its trains.
    const groups = new Map<string, any>();
    const places = new Map<string, any>();
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
        // The rider's head turn is measured against the car's rotation READ AT
        // THE SAME MOMENT, before this tick's teleport: Bedrock turns a rider
        // with its vehicle during its own entity tick, so both readings come
        // from one engine state whichever order the engine applies them in.
        let carYawNow = NaN;
        if (riders.length) try { carYawNow = entity.getRotation().y; } catch {}
        for (const rider of riders) {
          const viewer = viewers.get(rider?.id);
          if (viewer) viewer.seen = ticks;
          try { headings.set(rider.id, { head: rider.getRotation(), car: carYawNow }); } catch {}
        }
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
        const trainCount = cars.trains || 1;
        const base = `${routeIndex}@${origin.x},${origin.y},${origin.z}/${rotation}/${scale}`;
        let place = places.get(base);
        if (!place) places.set(base, place = { platform: undefined, counterweight: undefined, groups: [] as string[] });
        if (state.role === 'platform') { place.platform = { id, entity, state }; continue; }
        if (state.role === 'counterweight') { place.counterweight = { id, entity, state }; continue; }
        // A car index written by the placement wins; otherwise one is assigned
        // below and saved, so a car never changes place in its train. The index
        // runs over every train: train = index / count, car = index % count.
        const stored = entity.getDynamicProperty(key + 'car');
        const index = Number.isInteger(stored) && stored >= 0 && stored < cars.count * trainCount ? stored as number : -1;
        const train = index >= 0 ? Math.floor(index / cars.count) : 0;
        const placement = `${base}/t${train}`;
        let group = groups.get(placement);
        if (!group) { groups.set(placement, group = { base, train, route, cars, origin, rotation, scale, list: [] }); place.groups.push(placement); }
        group.list.push({ id, entity, rideable, riders, state, index });
      } catch (error) { report(id, stage, error, riders); tracked.delete(id); }
    }
    // A placement's hoist, restored once from whichever of its trains saved
    // the platform away from its parked pose (a train that is not carrying or
    // returning it saves 0).
    for (const [base, place] of places) {
      if (hoists.has(base)) continue;
      let progress = 0, owner: string | null = null;
      for (const placement of place.groups) {
        const group = groups.get(placement);
        if (!group?.route.lift) continue;
        const saved = Number(group.list[0]?.entity.getDynamicProperty(key + 'lift'));
        if (Number.isFinite(saved) && saved > progress) { progress = Math.min(1, saved); owner = placement; }
      }
      if (groups.get(place.groups[0])?.route.lift) hoists.set(base, { progress, owner, placed: false });
    }
    // The first train of a placement is processed first, so a second train
    // always sees where the first stands before deciding to leave the bay.
    for (const [placement, group] of [...groups].sort((a, b) => a[1].train - b[1].train)) {
      const route = group.route, path = route.path, total = path.length, station = route.station;
      const cars = group.cars, extent = cars.extent, count = cars.count, list = group.list;
      const origin = group.origin, rotation = group.rotation, scale = group.scale;
      const lift = route.lift, dispatch = cars.trains > 1 ? route.dispatch : undefined;
      const place = places.get(group.base);
      const hoist = lift ? hoists.get(group.base) : undefined;
      if (!list.length) continue;
      const taken = new Set(list.filter((car: any) => car.index >= 0).map((car: any) => car.index));
      for (const car of list) {
        if (car.index >= 0) continue;
        let index = group.train * count;
        while (taken.has(index) && index < (group.train + 1) * count - 1) index++;
        taken.add(index); car.index = index;
        try { car.entity.setDynamicProperty(key + 'car', index); } catch {}
      }
      for (const car of list) car.slot = car.index % count;
      list.sort((a: any, b: any) => a.index - b.index || (a.id < b.id ? -1 : 1));
      const lead = list[0];
      const riders = list.reduce((all: any[], car: any) => all.concat(car.riders), []);
      let train = trains.get(placement);
      if (!train) trains.set(placement, train = { dwell: 0, armed: true, boarded: false, holding: false, waiting: false, seen: 0, liftDwell: 0, progress: NaN });
      train.seen = ticks;
      let stage = 'restore cart progress';
      try {
        // Arc distance of car `slot` from the train's centre. The centre, not
        // a car, is the tracked position: it keeps the offsets fixed when an
        // open route reverses and the train's tail becomes its head, instead of
        // flipping every car to the other side of a lead.
        const carArc = (middle: number, slot: number) => {
          const arc = middle + extent / 2 - slot * cars.spacing;
          return path.closed ? ((arc % total) + total) % total : Math.max(0, Math.min(total, arc));
        };
        const wheelbaseOf = (car: any): number => { const wheelbase = types[car.entity.typeId]?.wheelbase; return wheelbase !== undefined && wheelbase > 0 ? wheelbase : 0; };
        // The whole train has to fit on an open route, so its centre cannot
        // reach either end by half the train's length.
        const low = path.closed ? 0 : extent / 2, high = path.closed ? total : total - extent / 2;
        const target = path.closed ? station.stop : Math.max(low, Math.min(high, station.stop));
        const storedDistance = Number(lead.entity.getDynamicProperty(key + 'distance'));
        const placed = !Number.isFinite(storedDistance);
        // A newly placed train waits on the platform, the one part of the route
        // a player can be expected to reach, rather than wherever it spawned; a
        // second train waits in the loading bay behind it.
        let centre = placed ? (group.train > 0 && dispatch ? dispatch.hold : target)
          : path.closed ? ((storedDistance % total) + total) % total
            : Math.max(low, Math.min(high, storedDistance));
        // A fixed ride direction (a circuit, or a lift route) always wins over
        // the stored one; a shuttle keeps whichever way it was going.
        let direction: 1 | -1 = route.direction === 1 || route.direction === -1 ? route.direction
          : lead.entity.getDynamicProperty(key + 'direction') === -1 ? -1 : 1;
        // A railway route is driven: its own constants, and the stick of whoever is aboard.
        const RIDE: any = route.physics && route.physics.DRIVER ? route.physics : COASTER_RIDE;
        const driver: any = route.physics && route.physics.DRIVER ? route.physics.DRIVER : undefined;
        const stick = driver ? stickOf(riders) : NaN;
        const driven = Number.isFinite(stick);
        // The cars' noses: fixed along the route for the set's own cars, or
        // the direction of motion for the symmetric fabricated cart.
        const facing: 1 | -1 = cars.heading === 1 || cars.heading === -1 ? cars.heading : direction;
        const storedSpeed = Number(lead.entity.getDynamicProperty(key + 'speed'));
        let speed = Number.isFinite(storedSpeed) ? Math.max(0, Math.min(MAX_SPEED, storedSpeed)) : 0;
        // Lift state: which phase this train is in, and (shared by the
        // placement's trains) how far the platform has travelled, 0 parked to
        // 1 delivered. Both persist across script reloads.
        const storedPhase = lead.entity.getDynamicProperty(key + 'phase');
        let phase: string = lift && (storedPhase === 'lifting' || storedPhase === 'delivered') ? storedPhase : 'track';
        const owns = !!hoist && (hoist.owner === placement || hoist.owner === null);
        let progress = hoist ? hoist.progress : 0;
        // Only the train the hoist carries may be lifting; a reload that says
        // otherwise is stale and that train is back on the track.
        if (phase !== 'track' && hoist && hoist.owner !== null && hoist.owner !== placement) phase = 'track';
        const deckLength = lift ? lift.deckLength : 0;
        const progressBefore = progress;
        if (placed) {
          if (driver) { train.dwell = 0; train.armed = false; }
          else if (group.train > 0 && dispatch) { train.holding = true; train.armed = true; }
          else { train.dwell = DWELL_EMPTY; train.armed = false; }
        }
        // Boarding mid-ride (a command, or a moving car) must not stall the
        // ride; boarding on the platform holds it for the full boarding delay.
        if (riders.length) {
          if (!train.boarded) { train.boarded = true; if (train.dwell > 0 && train.dwell < BOARD_TICKS) train.dwell = BOARD_TICKS; }
        } else train.boarded = false;
        // ── The other train on this placement, for dispatch ──
        // Lap progress counts arc from the platform in the ride direction; on a
        // lift route the hoist is a jump, so the deck is counted once.
        const lap = dispatch ? dispatch.lap : total;
        const lapProgress = (arc: number, liftPhase: string): number => {
          let p: number;
          if (!lift) p = ((arc - station.stop) * direction % total + total) % total;
          else if (liftPhase !== 'track') p = station.stop - deckLength / 2;
          else if (arc > station.stop) p = station.stop - deckLength / 2 + (total - deckLength / 2 - arc);
          else p = station.stop - arc;
          p = ((p % lap) + lap) % lap;
          return lap - p < 1e-6 ? 0 : p;
        };
        let other: any;
        if (dispatch && place) {
          for (const sibling of place.groups) {
            if (sibling === placement) continue;
            const state = trains.get(sibling);
            const siblingGroup = groups.get(sibling);
            if (!state || !siblingGroup) continue;
            const arc = Number.isFinite(state.centre) ? state.centre : Number(siblingGroup.list[0]?.entity.getDynamicProperty(key + 'distance'));
            if (!Number.isFinite(arc)) continue;
            other = { progress: lapProgress(arc, state.phase || 'track') };
            break;
          }
        }
        const mine = lapProgress(centre, phase);
        const otherAhead = other ? (((other.progress - mine) % lap) + lap) % lap : Infinity;
        const trainLength = extent + (count > 1 ? cars.spacing : 0);
        /** The platform is taken while the other train stands on it or has not yet
         * cleared a train length past it; a second train placed before its sibling
         * has reported assumes the platform is taken. */
        const stationBusy = other ? other.progress < trainLength + 1 : placed && group.train > 0;
        const mayDepart = !other || otherAhead >= (dispatch ? dispatch.ahead : 0);

        stage = 'integrate ride physics';
        let next = centre;
        let nextDirection = direction;
        let arrived: string | null = null;
        /** Platform displacement applied to the cars this tick (they ride it while lifting). */
        let carLift = 0;
        train.waiting = false;
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
            // brake disarmed until the train is clear of its own station — once
            // the other train is far enough ahead.
            if (train.dwell === 0) {
              if (mayDepart) { speed = DEPART_SPEED; train.armed = false; }
              else { train.dwell = 1; train.waiting = true; }
            }
          } else if (train.holding) {
            // In the loading bay behind an occupied platform: wait for it.
            speed = 0;
            if (!stationBusy) { train.holding = false; speed = DEPART_SPEED; train.armed = true; }
          } else {
            // Integrate in substeps no longer than one authored sample spacing,
            // each sampling the grade where the train actually is: the polyline
            // bounds the integration step, never the speed.
            // The inversion floor can lift the speed mid-tick, so it bounds the substep too.
            // A driven train (`route.physics.DRIVER`) bounds it by its own traction.
            const inversionFloor = route.loopRadius > 0 ? INVERSION_MARGIN * Math.sqrt(GRAVITY * route.loopRadius * scale) : 0;
            const bound = driver
              ? (speed + (RIDE.GRAVITY + driver.TRACTION) / 20) / (20 * scale)
              : (Math.max(speed, inversionFloor) + (GRAVITY + LIFT_ACCEL) / 20) / (20 * scale);
            const substeps = Math.max(1, Math.ceil(bound / route.maxSpacing));
            const dt = 1 / 20 / substeps;
            let advanced = 0;
            for (let sub = 0; sub < substeps; sub++) {
              const here = centre + advanced * direction;
              // sin(theta) of the track under the train, averaged over its cars
              // along increasing arc: a train straddling a crest feels both.
              let sum = 0;
              for (const car of list) sum += chordAt(path, carArc(here, car.slot), wheelbaseOf(car))[1];
              // A measured drive engages only over its own sprockets.
              const chainHere = !route.chain || (here >= route.chain.start - extent / 2 && here <= route.chain.end + extent / 2);
              // Through an inversion the train keeps INVERSION_MARGIN x the
              // speed that holds it on the loop at the apex, sqrt(g r), scaled
              // by sqrt(how far over it is): zero where the track is vertical,
              // so the floor rises from nothing instead of kicking the train at
              // the side of the loop. It only ever lifts a train that has lost
              // the energy real track would have given it.
              let floor = 0;
              if (route.loopRadius > 0) {
                let lowest = 1;
                for (const car of list) lowest = Math.min(lowest, upAt(route, carArc(here, car.slot))[1]);
                if (lowest < 0) floor = INVERSION_MARGIN * Math.sqrt(GRAVITY * route.loopRadius * scale * -lowest);
              }
              // One step for every rail vehicle (`rideSubstep`): gravity-only for a coaster, the stick for a train.
              // The stick is read against the train's FIXED nose (its cars' authored heading), never its
              // motion: a nose that turned with the motion would flip the stick's sense at every reversal.
              const moved = rideStep!(speed, direction, sum / list.length, dt, { chain: chainHere, floor, push: stick * (cars.heading || 1), driven }, RIDE);
              speed = moved.speed;
              if (moved.direction !== direction) {
                // Only a driven train reverses, and only from rest: a tick that
                // already moved it one way ends at rest, and the next tick starts
                // the other way, so no advance is ever counted in the wrong sense.
                if (advanced > 0) { speed = 0; break; }
                direction = moved.direction; nextDirection = direction;
              }
              advanced += speed * dt / scale;
            }
            train.advanced = advanced;
          }
          // Arc distance to the next stop in the direction of travel, or -1 when
          // nothing is ahead: the platform (armed, ahead, not still clearing it),
          // the loading bay behind an occupied platform, and on a lift route
          // heading down, the parked deck's centre — or the terminal, where the
          // train waits while the platform is still away.
          let toStop = -1, stopAt = target, stopKind = 'station';
          // A driven train stops where its driver brakes: no station brake.
          if (!driver && train.armed && train.dwell <= 0 && !train.holding) {
            let ahead = (target - centre) * direction;
            if (path.closed) { ahead %= total; if (ahead < 0) ahead += total; }
            if (ahead >= 0) { toStop = ahead; }
          }
          if (dispatch && stationBusy && !train.holding && train.dwell <= 0) {
            let ahead = (dispatch.hold - centre) * direction;
            if (path.closed) { ahead %= total; if (ahead < 0) ahead += total; }
            if (ahead >= 0 && (toStop < 0 || ahead < toStop)) { toStop = ahead; stopAt = dispatch.hold; stopKind = 'hold'; }
          }
          if (lift && direction === -1) {
            // The parked deck is free when the platform is down and no other
            // train is standing on it about to rise.
            const deckFree = progress <= 0 && owns;
            const deckTarget = deckFree ? deckLength / 2 : deckLength + extent / 2;
            const ahead = centre - deckTarget;
            if (ahead >= 0 && (toStop < 0 || ahead < toStop)) { toStop = ahead; stopAt = deckTarget; stopKind = deckFree ? 'deck' : 'wait'; }
          }
          // Kinematic brake: v = sqrt(2 a s) reaches zero exactly at the stop.
          // `toStop` is in model blocks; the brake works in world blocks. The
          // integrated advance shrinks with the speed the brake and ceiling leave.
          const integrated = speed;
          if (toStop >= 0) speed = Math.min(speed, Math.sqrt(2 * STATION_BRAKE * toStop * scale));
          speed = Math.min(speed, RIDE.MAX_SPEED);
          const step = train.advanced !== undefined && integrated > 0 ? train.advanced * speed / integrated : speed / (20 * scale);
          train.advanced = undefined;
          next = centre + step * direction;
          if (toStop >= 0 && step >= toStop) { next = stopAt; arrived = stopKind; }
          else if (path.closed) next = ((next % total) + total) % total;
          else if (next > high || next < low) {
            next = next < low ? low : high;
            if (driver) {
              // A railway line's open end is a buffer stop: the train halts and
              // stays pointing the way it came; its driver backs it out.
              speed = 0;
            } else if (lift) {
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
          else if (arrived === 'hold') { speed = 0; train.holding = true; }
          else if (arrived === 'deck') {
            // The deck is one platform: the train that reaches it first takes the hoist.
            if (hoist && hoist.owner !== null && hoist.owner !== placement) { speed = 0; }
            else { speed = 0; phase = 'lifting'; train.liftDwell = PLATFORM_DWELL; if (hoist) hoist.owner = placement; }
          }
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
        if (lift && owns && phase === 'track' && progress > 0) {
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
        for (const car of list) {
          const arc = carArc(next, car.slot);
          const at = sample(path, arc);
          const p = at.position;
          const lifted = lift && carLift > 0 ? [p[0] + lift.travel[0] * carLift, p[1] + lift.travel[1] * carLift, p[2] + lift.travel[2] * carLift] : p;
          const datum = toWorld(lifted);
          // The car points along the chord between its wheel contacts, which is
          // the local tangent for a car that measured no wheelbase.
          const tangent = chordAt(path, arc, wheelbaseOf(car)).map((value: number) => value * facing);
          const worldTx = tangent[0] * c - tangent[2] * s;
          const worldTz = tangent[0] * s + tangent[2] * c;
          const i = at.segmentIndex;
          const ratio = (at.distance - path.cumulative[i]) / (path.cumulative[i + 1] - path.cumulative[i]);
          const up0 = route.up[i], up1 = route.up[i + 1];
          const up = up0.map((value: number, axis: number) => value + (up1[axis] - value) * ratio);
          const ux = up[0] * c - up[2] * s, uy = up[1], uz = up[0] * s + up[2] * c;
          // The car is on rails, so it turns OVER through a loop, it does not
          // spin: the yaw is the azimuth of its axle's heading, continuous
          // through every inversion (`coasterCarAttitude`), and the pitch runs
          // past 90 degrees in that heading's vertical plane. The fallback is
          // only for a car on its side; it is the script's own last yaw, never
          // read back off the entity, whose rotation a rider can disturb.
          const heldYaw = Number.isFinite(car.state.yaw) ? car.state.yaw : car.entity.getRotation().y;
          const { yaw, pitch, roll } = attitude([worldTx, tangent[1], worldTz], [ux, uy, uz], heldYaw, YAW_HOLD_HORIZONTAL);
          const priorYaw = car.state.yaw;
          car.state.yaw = yaw;
          const yawRad = yaw * Math.PI / 180;
          // ── Where the rider's head belongs ──
          // The seat is a fixed offset in the entity's yaw-only frame (model
          // +X right, +Y up, +Z back; the entity faces model -Z), so on inverted
          // track it would put the player outside the loop. Carry the seat and
          // the player's eye through the car's real frame instead, place the
          // ENTITY so the upright seat lands there, and draw the body back on
          // the rails through the body-offset properties. Upright: all zero.
          const type = types[car.entity.typeId];
          const seat = type && type.seat ? type.seat : [0, 0, 0];
          const nose = [worldTx, tangent[1], worldTz];
          let cu = [ux, uy, uz];
          const along = cu[0] * nose[0] + cu[1] * nose[1] + cu[2] * nose[2];
          cu = [cu[0] - along * nose[0], cu[1] - along * nose[1], cu[2] - along * nose[2]];
          const cuLength = Math.hypot(cu[0], cu[1], cu[2]) || 1;
          cu = [cu[0] / cuLength, cu[1] / cuLength, cu[2] / cuLength];
          const right = [nose[1] * cu[2] - nose[2] * cu[1], nose[2] * cu[0] - nose[0] * cu[2], nose[0] * cu[1] - nose[1] * cu[0]];
          const sinYaw = Math.sin(yawRad), cosYaw = Math.cos(yawRad);
          const noseFlat = [-sinYaw, 0, cosYaw], rightFlat = [-cosYaw, 0, -sinYaw];
          const offset = [0, 0, 0];
          const eyeOffset = [0, 0, 0];
          for (let axis = 0; axis < 3; axis++) {
            const real = (seat[0] * right[axis] + seat[1] * cu[axis] - seat[2] * nose[axis]) * scale + RIDER_EYE * cu[axis];
            const flat = (seat[0] * rightFlat[axis] + seat[1] * (axis === 1 ? 1 : 0) - seat[2] * noseFlat[axis]) * scale + RIDER_EYE * (axis === 1 ? 1 : 0);
            offset[axis] = real - flat;
            eyeOffset[axis] = real;
          }
          const position = { x: datum.x + offset[0], y: datum.y + offset[1], z: datum.z + offset[2] };
          // The rider's eye in the seat through the car's real frame: where the
          // track-following camera sits (`coasterRiderView`).
          const eye = { x: datum.x + eyeOffset[0], y: datum.y + eyeOffset[1], z: datum.z + eyeOffset[2] };
          // The body offset in model units: the world vector back to the datum,
          // turned into the entity's frame (yaw plus the model's 180-degree facing).
          const gx = -offset[0], gy = -offset[1], gz = -offset[2];
          const body = [-(cosYaw * gx + sinYaw * gz), gy, sinYaw * gx - cosYaw * gz].map(value => Math.max(-BODY_RANGE, Math.min(BODY_RANGE, value * 16 / scale)));
          frames.push({ car, position, yaw, priorYaw, pitch, roll, body, eye, nose, up: cu });
        }
        // The platform and counterweight: placed once on first sight and then
        // whenever the hoist moves, by the train that holds it. Absent entities
        // (removed, unloaded) are simply not moved; their pose is a function of
        // `progress`, so they are right again the moment they are seen.
        const liftFrames: any[] = [];
        if (lift && hoist && owns && (platformMoving || !hoist.placed)) {
          const t = lift.travel;
          if (place?.platform) liftFrames.push({ entity: place.platform.entity, position: toWorld([lift.parkedPoint[0] + t[0] * progress, lift.parkedPoint[1] + t[1] * progress, lift.parkedPoint[2] + t[2] * progress]) });
          if (place?.counterweight && lift.counterweightPoint) liftFrames.push({ entity: place.counterweight.entity, position: toWorld([lift.counterweightPoint[0] - t[0] * progress, lift.counterweightPoint[1] - t[1] * progress, lift.counterweightPoint[2] - t[2] * progress]) });
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
        if (hoist && owns) {
          hoist.placed = true;
          hoist.progress = progress;
          hoist.owner = progress > 0 || phase !== 'track' ? placement : null;
        }
        stage = 'save cart progress';
        // Every car carries the same ride state, so any loaded car can lead it.
        // `distance` on a train car is the TRAIN's centre, not that car's arc.
        for (const frame of frames) {
          frame.car.entity.setDynamicProperty(key + 'distance', next);
          frame.car.entity.setDynamicProperty(key + 'direction', nextDirection);
          frame.car.entity.setDynamicProperty(key + 'speed', speed);
          if (lift) { frame.car.entity.setDynamicProperty(key + 'phase', phase); frame.car.entity.setDynamicProperty(key + 'lift', owns ? progress : 0); }
        }
        train.centre = next;
        train.phase = phase;
        stage = 'animate cart';
        // A value outside a declared actor-property range throws, which would
        // otherwise untrack the cart mid-ride; the angles are already in range.
        for (const frame of frames) {
          frame.car.entity.setProperty('craftmatic:track_pitch', Math.max(-180, Math.min(180, frame.pitch)));
          frame.car.entity.setProperty('craftmatic:track_roll', Math.max(-180, Math.min(180, frame.roll)));
          frame.car.entity.setProperty('craftmatic:body_x', frame.body[0]);
          frame.car.entity.setProperty('craftmatic:body_y', frame.body[1]);
          frame.car.entity.setProperty('craftmatic:body_z', frame.body[2]);
          // The set's own car: show its posed rider unless a player has the seat.
          const type = types[frame.car.entity.typeId];
          const slot = cars.slots && cars.slots[frame.car.index];
          if (type && type.riders > 0 && slot) {
            const occupied = frame.car.riders.length > 0;
            if (frame.car.state.rider !== slot.rider) { frame.car.entity.setProperty('craftmatic:rider', slot.rider); frame.car.state.rider = slot.rider; }
            if (frame.car.state.occupied !== occupied) { frame.car.entity.setProperty('craftmatic:occupied', occupied); frame.car.state.occupied = occupied; }
          }
        }
        // The camera follows the car the rider is in. A camera fault must never
        // stop the ride: it is reported like any stage, but per rider.
        for (const frame of frames) {
          for (const rider of frame.car.riders) {
            try { aimRider(rider, frame); } catch (error) {
              if (ticks - lastErrorLogTick >= 200) { console.warn(`[Craftmatic coaster] ${config.typeId} rider camera: ${error instanceof Error ? error.message : String(error)}`); lastErrorLogTick = ticks; }
            }
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
            if (driver) { warn(aboard, `${route.label} — ${speed.toFixed(1)} blocks/s — stick forward: go · back: brake and reverse — sneak to dismount`); continue; }
            warn(aboard, train.waiting ? `${route.label} — waiting for the other train — sneak to dismount`
              : train.dwell > 0 ? 'Coaster departing — sneak to dismount'
              : train.holding ? `${route.label} — waiting for the platform — sneak to dismount`
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
        if (place?.platform) tracked.delete(place.platform.id);
        if (place?.counterweight) tracked.delete(place.counterweight.id);
        trains.delete(placement);
        hoists.delete(group.base);
      }
    }
    // Forget the ride state of a train whose cars have all gone.
    for (const [placement, train] of trains) if (train.seen !== ticks) trains.delete(placement);
    for (const base of [...hoists.keys()]) if (!places.has(base)) hoists.delete(base);
    // A rider no car reported this tick has dismounted (sneak, Undo, a removed
    // car): give them their own camera back.
    for (const [id, viewer] of [...viewers]) if (viewer.seen !== ticks) releaseViewer(id);
  };
  system.runInterval(tick, 1);
}

/** Emit the same runtime exercised by the host tests. The player model stays
 * upright in the seat; the rider's CAMERA follows the car (`coasterRiderView`). */
export function coasterScript(config: CoasterRuntimeConfig): string {
  return `import { world, system, LinearSpline } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${coasterRuntime.toString()})(CONFIG, ${sampleCoasterPath.toString()}, ${coasterCarAttitude.toString()}, ${coasterRiderView.toString()}, ${coasterRiderLook.toString()}, typeof LinearSpline === 'undefined' ? undefined : LinearSpline, ${rideSubstep.toString()});\n`;
}
