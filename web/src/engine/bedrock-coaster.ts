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

/** Validate routes before putting them in an executable add-on. */
export function coasterRuntimeConfig(typeId: string, routes: CoasterRoute[]): CoasterRuntimeConfig {
  if (routes.length > 16) throw new Error('At most 16 independent coaster routes are supported per pack.');
  return { typeId, routes: routes.map(route => {
    const path = buildCoasterPath(route.points, route.closed, route.maxSegmentLength);
    return { label: route.label, path, up: buildCoasterFrames(path),
      maxSpacing: coasterMaxSpacing(path), station: findCoasterStation(path) };
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

  const tracked = new Map<string, any>();
  let ticks = 0;
  let lastErrorLogTick = -200;
  const key = 'craftmatic:coaster_';
  const warn = (riders: any[], message: string) => {
    for (const rider of riders) try { rider.onScreenDisplay?.setActionBar(message); } catch {}
  };
  const tick = () => {
    ticks++;
    if (ticks === 1 || ticks % 20 === 0) {
      for (const name of ['overworld', 'nether', 'the_end']) {
        try {
          for (const entity of world.getDimension(name).getEntities({ type: config.typeId })) {
            // A cart runs with or without a rider, so a freshly discovered one
            // starts armed for its platform and with no dwell owed.
            if (!tracked.has(entity.id)) tracked.set(entity.id, { entity, dwell: 0, armed: true, boarded: false, tangentY: undefined });
          }
        } catch { /* A dimension may be unavailable during world startup. */ }
      }
    }
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
        const path = route.path, total = path.length, station = route.station;
        stage = 'restore cart progress';
        const storedDistance = Number(entity.getDynamicProperty(key + 'distance'));
        const placed = !Number.isFinite(storedDistance);
        // A newly placed cart waits on the platform, the one part of the route a
        // player can be expected to reach, rather than wherever it was spawned.
        let distance = placed ? station.stop : Math.max(0, Math.min(total, storedDistance));
        const direction = entity.getDynamicProperty(key + 'direction') === -1 ? -1 : 1;
        const storedSpeed = Number(entity.getDynamicProperty(key + 'speed'));
        let speed = Number.isFinite(storedSpeed) ? Math.max(0, Math.min(MAX_SPEED, storedSpeed)) : 0;
        if (placed) { state.dwell = DWELL_EMPTY; state.armed = false; }
        // Boarding mid-ride (a command, or a moving cart) must not stall the
        // ride; boarding on the platform holds it for the full boarding delay.
        if (riders.length) {
          if (!state.boarded) { state.boarded = true; if (state.dwell > 0 && state.dwell < BOARD_TICKS) state.dwell = BOARD_TICKS; }
        } else state.boarded = false;

        stage = 'integrate ride physics';
        if (state.tangentY === undefined) state.tangentY = sample(path, distance).tangent[1];
        // sin(theta) of the track under the cart, in the direction of travel.
        const grade = state.tangentY * direction;
        if (state.dwell > 0) {
          state.dwell--;
          speed = 0;
          // Leaving the platform: a bounded push from the station drive, and the
          // brake disarmed until the cart is clear of its own station.
          if (state.dwell === 0) { speed = DEPART_SPEED; state.armed = false; }
        } else {
          speed = Math.max(0, speed + (-GRAVITY * grade - ROLLING - DRAG * speed * speed) / 20);
          // The chain catches a cart slower than itself on a climb and carries
          // it at chain speed; it never touches a cart that is already faster.
          if (grade > LIFT_GRADE && speed < LIFT_SPEED) speed = Math.min(LIFT_SPEED, speed + LIFT_ACCEL / 20);
          speed = Math.max(speed, MIN_SPEED);
        }
        // Arc distance to the platform in the direction of travel, or -1 when
        // the cart is not heading for it (station behind on an open route) or is
        // still clearing the platform it just left.
        let toStation = -1;
        if (state.armed && state.dwell <= 0) {
          let ahead = (station.stop - distance) * direction;
          if (path.closed) { ahead %= total; if (ahead < 0) ahead += total; }
          if (ahead >= 0) toStation = ahead;
        }
        // Kinematic brake: v = sqrt(2 a s) reaches zero exactly at the platform.
        // `toStation` is in model blocks; the brake works in world blocks.
        if (toStation >= 0) speed = Math.min(speed, Math.sqrt(2 * STATION_BRAKE * toStation * scale));
        // A step may never exceed one authored sample spacing, or it would cut
        // the corner of the measured polyline instead of following it.
        speed = Math.min(speed, MAX_SPEED, 20 * scale * route.maxSpacing);
        const step = speed / (20 * scale);
        let next = distance + step * direction;
        let nextDirection = direction;
        let arrived = false;
        if (toStation >= 0 && step >= toStation) { next = station.stop; arrived = true; }
        else if (path.closed) next = ((next % total) + total) % total;
        else if (next > total || next < 0) {
          // The real end of an open route: stop, reverse, and re-arm the brake.
          // No track is invented across the gap. The cart leaves the dead end on
          // the same bounded drive push the platform uses, so a shuttle end
          // cannot strand it crawling at the floor speed along level track.
          next = next < 0 ? 0 : total;
          nextDirection = -direction;
          speed = DEPART_SPEED;
          state.armed = true;
        }
        if (arrived) { speed = 0; state.dwell = riders.length ? DWELL_LOADED : DWELL_EMPTY; }
        else if (!state.armed) {
          const inside = station.start <= station.end
            ? next >= station.start && next <= station.end
            : next >= station.start || next <= station.end;
          if (!inside) state.armed = true;
        }
        stage = 'sample next track';
        const at = sample(path, next);
        const angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
        const p = at.position;
        const position = { x: origin.x + (p[0] * c - p[2] * s) * scale,
          y: origin.y + p[1] * scale, z: origin.z + (p[0] * s + p[2] * c) * scale };
        // Never teleport into an unloaded region. Holding distance allows a
        // later tick to resume without skipping track or abandoning the rider.
        stage = 'check next chunk';
        let loaded = false;
        try { loaded = !!entity.dimension.getBlock({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }); } catch {}
        if (!loaded) { warn(riders, 'Coaster paused: next track chunk is not loaded'); continue; }
        stage = 'orient cart';
        const tangent = at.tangent.map(value => value * direction);
        const horizontal = Math.hypot(tangent[0]!, tangent[2]!);
        const worldTx = tangent[0]! * c - tangent[2]! * s;
        const worldTz = tangent[0]! * s + tangent[2]! * c;
        const yaw = horizontal > 1e-6 ? Math.atan2(-worldTx, worldTz) * 180 / Math.PI : entity.getRotation().y;
        const pitch = -Math.atan2(tangent[1]!, horizontal) * 180 / Math.PI;
        const i = at.segmentIndex;
        const ratio = (at.distance - path.cumulative[i]) / (path.cumulative[i + 1] - path.cumulative[i]);
        const up0 = route.up[i], up1 = route.up[i + 1];
        const up = up0.map((value, axis) => value + (up1[axis] - value) * ratio);
        const ux = up[0] * c - up[2] * s, uy = up[1], uz = up[0] * s + up[2] * c;
        // Remove entity yaw then bone pitch from the transported track up.
        // The remaining angle is local roll; at a loop apex this turns the
        // cart upside down without attempting unsupported player-camera roll.
        const yawRad = yaw * Math.PI / 180, pitchRad = pitch * Math.PI / 180;
        const localX = ux * Math.cos(yawRad) + uz * Math.sin(yawRad);
        const yawZ = -ux * Math.sin(yawRad) + uz * Math.cos(yawRad);
        const localY = uy * Math.cos(pitchRad) + yawZ * Math.sin(pitchRad);
        const roll = Math.atan2(-localX, localY) * 180 / Math.PI;
        stage = 'teleport cart';
        if (!entity.tryTeleport(position, { rotation: { x: 0, y: yaw }, keepVelocity: false, checkForBlocks: false })) {
          warn(riders, 'Coaster paused: movement could not complete'); continue;
        }
        stage = 'save cart progress';
        entity.setDynamicProperty(key + 'distance', next);
        entity.setDynamicProperty(key + 'direction', nextDirection);
        entity.setDynamicProperty(key + 'speed', speed);
        state.tangentY = at.tangent[1];
        stage = 'animate cart';
        // A value outside a declared actor-property range throws, which would
        // otherwise untrack the cart mid-ride; the angles are already in range.
        entity.setProperty('craftmatic:track_pitch', Math.max(-90, Math.min(90, pitch)));
        entity.setProperty('craftmatic:track_roll', Math.max(-180, Math.min(180, roll)));
        stage = 'check rider retention';
        const aboard: any[] = rideable?.getRiders() ?? [];
        const retained = new Set(aboard.map((rider: any) => rider.id));
        const lost = riders.filter(rider => !retained.has(rider.id));
        // Never force a rider back on: this may have been a deliberate dismount.
        // The cart keeps running and comes back to the platform by itself.
        if (lost.length) warn(lost, 'Coaster ride ended. Board again when the cart stops at the station.');
        if (ticks % 20 === 0) {
          warn(aboard, state.dwell > 0 ? 'Coaster departing — sneak to dismount'
            : `${route.label} — ${speed.toFixed(1)} blocks/s — sneak to dismount`);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const boundedDetail = detail.slice(0, 160);
        warn(riders, `Coaster paused at ${stage}: ${boundedDetail}`);
        if (ticks - lastErrorLogTick >= 200) {
          console.warn(`[Craftmatic coaster] ${config.typeId} ${id} at ${stage}: ${boundedDetail}`);
          lastErrorLogTick = ticks;
        }
        // Removed carts (Undo/re-place) must not survive as script-held state.
        tracked.delete(id);
      }
    }
  };
  system.runInterval(tick, 1);
}

/** Emit the same runtime exercised by the host tests. Riders remain upright;
 * pitch animates the cart only, not an unsupported upside-down player pose. */
export function coasterScript(config: CoasterRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${coasterRuntime.toString()})(CONFIG, ${sampleCoasterPath.toString()});\n`;
}
