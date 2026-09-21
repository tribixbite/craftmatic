/** Scripted ride carts follow measured track paths, including vertical curves.
 * These are deliberately distinct from vanilla rails: no track is flattened,
 * and an open track shuttles rather than inventing a connection across a gap.
 *
 * ## Ride model
 *
 * The cart is a point on a sampled polyline, not a rigid-body simulation. One
 * scalar speed is integrated per Bedrock tick along the track tangent:
 *
 *     a = -g * sin(theta) - rolling - drag * v^2      [blocks/s^2]
 *
 * `sin(theta)` is the y component of the unit track tangent in the direction of
 * travel, so the cart loses speed on a climb and gains it on a drop. Speeds are
 * WORLD blocks per second; the route is in MODEL blocks, so one tick advances
 * `speed / (20 * scale)` model blocks (20 ticks = 1 s, `scale` = wand size).
 *
 * Three bounded overrides sit on top of the integrator, each of which exists
 * for a reason a real coaster shares:
 *
 * - **Chain lift** — on a climb steeper than `LIFT_GRADE`, a cart slower than
 *   the chain is carried at exactly chain speed. It never applies on the flat
 *   or on a drop and never exceeds `LIFT_SPEED`, so it cannot add ride energy.
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
 * ## Trains
 *
 * A route may declare the train its SOURCE has: `cars: { count, spacing }`,
 * measured from the set, never inferred (10303 carries three rider clusters
 * exactly 120 LDU apart, so three cars). The placement then spawns that many
 * car entities, all of the same single-seat rideable type, so each car is
 * boardable by a different player and no seat has to be reserved.
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
 */
import { buildCoasterFrames, buildCoasterPath, sampleCoasterPath, type CoasterPath, type CoasterVec3 } from './coaster-path.js';
import type { Vec3 } from './ldraw-part-geometry.js';
import { withSizeGroups } from './bedrock-placement-pack.js';
import { floatActorProperty } from './bedrock-json.js';

declare const world: any;
declare const system: any;

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
   * cars at 120 / cellLDU blocks). Omitted means one cart.
   */
  cars?: { count: number; spacing: number };
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
   * coupled cars; a train whose cars are longer than it overlaps on that curve. */
  cars: { count: number; spacing: number; extent: number; minChord?: number };
}

export interface CoasterRuntimeConfig {
  typeId: string;
  routes: CoasterRuntimeRoute[];
}

/** |dy/ds| at or below this counts as level track (about 4.6 degrees). */
const STATION_FLAT_GRADE = 0.08;
/** A station sits low: only flat runs inside this fraction of the route's
 * height range above its lowest point are eligible. */
const STATION_LOW_BAND = 0.25;

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

/** The drawn cart body is 20 entity units long: 1.25 blocks at export scale 1.
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
  if (!cars) return { count: 1, spacing: 0, extent: 0 };
  if (!Number.isInteger(cars.count) || cars.count < 1 || cars.count > 8) {
    throw new Error(`Coaster train car count must be an integer in [1, 8], received ${cars.count}.`);
  }
  if (cars.count === 1) return { count: 1, spacing: 0, extent: 0 };
  if (!Number.isFinite(cars.spacing) || cars.spacing <= 0) {
    throw new Error('Coaster train car spacing must be a finite positive number of blocks.');
  }
  const fits = Math.max(1, Math.min(cars.count, Math.floor(path.length / cars.spacing)));
  if (fits === 1) return { count: 1, spacing: 0, extent: 0 };
  return { count: fits, spacing: cars.spacing, extent: (fits - 1) * cars.spacing,
    minChord: minimumCoupledChord(path, cars.spacing) };
}

/** Validate routes before putting them in an executable add-on. */
export function coasterRuntimeConfig(typeId: string, routes: CoasterRoute[]): CoasterRuntimeConfig {
  if (routes.length > 16) throw new Error('At most 16 independent coaster routes are supported per pack.');
  return { typeId, routes: routes.map(route => {
    const path = buildCoasterPath(route.points, route.closed, route.maxSegmentLength);
    return { label: route.label, path, up: buildCoasterFrames(path),
      maxSpacing: coasterMaxSpacing(path), station: findCoasterStation(path),
      cars: resolveCoasterCars(path, route.cars) };
  }) };
}

/** A purpose-built ride vehicle, not invented replacement LEGO geometry.
 * The imported set and its display cars remain intact. */
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
          'craftmatic:track_pitch': floatActorProperty([-90, 90], 0),
          'craftmatic:track_roll': floatActorProperty([-180, 180], 0),
        } },
      components: {
        'minecraft:type_family': { family: ['craftmatic_coaster'] },
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
        track_pitch: { rotation: ["query.property('craftmatic:track_pitch')", 0, 0] },
        cart: { rotation: [0, 0, "query.property('craftmatic:track_roll')"] },
      },
    } } },
  };
}

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
  /** A route emitted before trains existed, or a partially overwritten pack. */
  const SINGLE = { count: 1, spacing: 0, extent: 0 };

  /** Loaded cars, by entity id. */
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
          for (const entity of world.getDimension(name).getEntities({ type: config.typeId })) {
            if (!tracked.has(entity.id)) tracked.set(entity.id, { entity });
          }
        } catch { /* A dimension may be unavailable during world startup. */ }
      }
    }
    // ── Group every loaded car by its placement: one train per placed route ──
    // Cars of one train share a single ride state, so they move rigidly; a
    // single-cart route is simply a train of one and is unchanged by this.
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
        const rideable = entity.getComponent('minecraft:rideable');
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
        if (!group) groups.set(placement, group = { route, cars, origin, rotation, scale, list: [] });
        // A car index written by the placement wins; otherwise one is assigned
        // below and saved, so a car never changes place in its train.
        const index = entity.getDynamicProperty(key + 'car');
        group.list.push({ id, entity, rideable, riders,
          index: Number.isInteger(index) && index >= 0 && index < cars.count ? index as number : -1 });
      } catch (error) { report(id, stage, error, riders); tracked.delete(id); }
    }
    for (const [placement, group] of groups) {
      const route = group.route, path = route.path, total = path.length, station = route.station;
      const cars = group.cars, extent = cars.extent, list = group.list;
      const origin = group.origin, rotation = group.rotation, scale = group.scale;
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
      if (!train) trains.set(placement, train = { dwell: 0, armed: true, boarded: false, grade: undefined, seen: 0 });
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
        const direction = lead.entity.getDynamicProperty(key + 'direction') === -1 ? -1 : 1;
        const storedSpeed = Number(lead.entity.getDynamicProperty(key + 'speed'));
        let speed = Number.isFinite(storedSpeed) ? Math.max(0, Math.min(MAX_SPEED, storedSpeed)) : 0;
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
          if (grade > LIFT_GRADE && speed < LIFT_SPEED) speed = Math.min(LIFT_SPEED, speed + LIFT_ACCEL / 20);
          speed = Math.max(speed, MIN_SPEED);
        }
        // Arc distance to the platform in the direction of travel, or -1 when
        // the train is not heading for it (station behind on an open route) or
        // is still clearing the platform it just left.
        let toStation = -1;
        if (train.armed && train.dwell <= 0) {
          let ahead = (target - centre) * direction;
          if (path.closed) { ahead %= total; if (ahead < 0) ahead += total; }
          if (ahead >= 0) toStation = ahead;
        }
        // Kinematic brake: v = sqrt(2 a s) reaches zero exactly at the platform.
        // `toStation` is in model blocks; the brake works in world blocks.
        if (toStation >= 0) speed = Math.min(speed, Math.sqrt(2 * STATION_BRAKE * toStation * scale));
        // A step may never exceed one authored sample spacing, or it would cut
        // the corner of the measured polyline instead of following it. Every car
        // advances by the same step, so no car can exceed it either.
        speed = Math.min(speed, MAX_SPEED, 20 * scale * route.maxSpacing);
        const step = speed / (20 * scale);
        let next = centre + step * direction;
        let nextDirection = direction;
        let arrived = false;
        if (toStation >= 0 && step >= toStation) { next = target; arrived = true; }
        else if (path.closed) next = ((next % total) + total) % total;
        else if (next > high || next < low) {
          // The real end of an open route: stop, reverse, and re-arm the brake.
          // No track is invented across the gap. The train leaves the dead end
          // on the same bounded drive push the platform uses, so a shuttle end
          // cannot strand it crawling at the floor speed along level track.
          next = next < low ? low : high;
          nextDirection = -direction;
          speed = DEPART_SPEED;
          train.armed = true;
        }
        if (arrived) { speed = 0; train.dwell = riders.length ? DWELL_LOADED : DWELL_EMPTY; }
        else if (!train.armed) {
          const inside = station.start <= station.end
            ? next >= station.start && next <= station.end
            : next >= station.start || next <= station.end;
          if (!inside) train.armed = true;
        }
        stage = 'sample next track';
        const angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
        const frames: any[] = [];
        let gradeSum = 0;
        for (const car of list) {
          const at = sample(path, carArc(next, car.index));
          gradeSum += at.tangent[1];
          const p = at.position;
          const position = { x: origin.x + (p[0] * c - p[2] * s) * scale,
            y: origin.y + p[1] * scale, z: origin.z + (p[0] * s + p[2] * c) * scale };
          const tangent = at.tangent.map((value: number) => value * direction);
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
        // Never teleport into an unloaded region. Holding the centre allows a
        // later tick to resume without skipping track or abandoning a rider;
        // one car in an unloaded chunk holds the whole train, because a train
        // that moved only some of its cars would no longer be a train.
        stage = 'check next chunk';
        let held = false;
        for (const frame of frames) {
          let loaded = false;
          try { loaded = !!frame.car.entity.dimension.getBlock({ x: Math.floor(frame.position.x), y: Math.floor(frame.position.y), z: Math.floor(frame.position.z) }); } catch {}
          if (!loaded) { held = true; break; }
        }
        if (held) { warn(riders, 'Coaster paused: next track chunk is not loaded'); continue; }
        stage = 'teleport cart';
        let moved = true;
        for (const frame of frames) {
          if (!frame.car.entity.tryTeleport(frame.position, { rotation: { x: 0, y: frame.yaw }, keepVelocity: false, checkForBlocks: false })) { moved = false; break; }
        }
        // A car that moved before a later one failed is put back next tick: the
        // saved centre is still the old one, so the train re-places from it.
        if (!moved) { warn(riders, 'Coaster paused: movement could not complete'); continue; }
        stage = 'save cart progress';
        // Every car carries the same ride state, so any loaded car can lead it.
        // `distance` on a train car is the TRAIN's centre, not that car's arc.
        for (const frame of frames) {
          frame.car.entity.setDynamicProperty(key + 'distance', next);
          frame.car.entity.setDynamicProperty(key + 'direction', nextDirection);
          frame.car.entity.setDynamicProperty(key + 'speed', speed);
        }
        train.grade = gradeSum / frames.length;
        stage = 'animate cart';
        // A value outside a declared actor-property range throws, which would
        // otherwise untrack the cart mid-ride; the angles are already in range.
        for (const frame of frames) {
          frame.car.entity.setProperty('craftmatic:track_pitch', Math.max(-90, Math.min(90, frame.pitch)));
          frame.car.entity.setProperty('craftmatic:track_roll', Math.max(-180, Math.min(180, frame.roll)));
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
              : `${route.label} — ${speed.toFixed(1)} blocks/s — sneak to dismount`);
          }
        }
      } catch (error) {
        report(lead.id, stage, error, riders);
        // Removed carts (Undo/re-place) must not survive as script-held state.
        for (const car of list) tracked.delete(car.id);
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
