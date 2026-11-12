/**
 * A generated coaster as pack parts (WP-C02, BIZ-13): the glue between
 * `coaster-design.ts` (a `GeneratedCoaster`), `coaster-track-mesh.ts` (the rail
 * geometry) and the coaster runtime (`bedrock-coaster.ts`).
 *
 *  - `placeGenerated` moves the design's frame into the pack's: the station is
 *    built at the origin heading +x and the circuit runs into negative x/z, so the
 *    route is shifted to put the station by the pin and the track on a platform
 *    (one block of ground).
 *  - `parseCoasterCar` reads OUR car (`test/fixtures/coaster/own-car.ldr`, official
 *    parts only) in the canonical car frame `canonicalCoasterCar` writes.
 *  - `coasterRouteFromGenerated` is the `CoasterRoute` the runtime config is built
 *    from: the design's points, its explicit ups (`coasterTrackUps` would infer
 *    them), its zones, its station, its chain lift and a train of cars.
 *  - `buildCoasterTrackPack` turns the rail chunks into entity files and placement
 *    actors for the `coasterTrack` hook of `buildPlayableAddon`.
 *
 * FRAMES, settled by test (`test/coaster-generated-route.test.ts`):
 *  - HANDEDNESS. The route frame IS the world frame (x east, y up, z south: a
 *    right-handed triple), as the runtime reads `route.points` into the world
 *    with a yaw and a scale and nothing else. A design's positive turn (T toward
 *    `up x T`) is therefore a LEFT turn in the world, with no mirror.
 *  - RAILS. A chunk is a JSON-frame geometry, and the world is the JSON frame mirrored
 *    in Z. `buildTrackMesh` is told `mirror: 'z'` (it solves every cube rotation in
 *    the mirrored frame) and the chunk's actor stands at its root un-mirrored,
 *    `(x, y, -z)`.
 *  - DATUM. The car's origin is its wheels' contact plane (`own-car.ldr`), and a car's
 *    origin rides the route sample, so rail tops sit AT the sample: `railTopOffsetB` 0
 *    (`COASTER_TRACK_MESH`'s default). The track's gauge is the car's wheel spacing.
 */
import { parseLDrawDocument, type ParsedBrick } from './ldraw-parser';
import type { CoasterRoute, CoasterRouteCar, CoasterRouteChainLift, CoasterRouteZone } from './bedrock-coaster';
import { COASTER_MAX_CARS } from './bedrock-coaster';
import { COASTER_ZONES } from './coaster-zones';
import type { CoasterDesign, GeneratedCoaster } from './coaster-design';
import type { CoasterVec3 } from './coaster-path';
import { buildTrackMesh, COASTER_TRACK_MESH, type TrackMesh, type TrackProfile } from './coaster-track-mesh';
import { shellBehavior } from './bedrock-building-shell';
import { resolveLdrawEntityMaterial } from './ldraw-entity-materials';
import { LDU_PER_BLOCK } from './lego-scale';
import type { PlacementActor } from './bedrock-placement-pack';
import type { EmittableGeometry } from './playable-addon';

type Vec3 = [number, number, number];

/** Our car, in the canonical car frame (LDU, +X forward, -Y up, origin at the wheels' contact plane). */
export interface OwnCoasterCar {
  bricks: ParsedBrick[];
  /** The rider's hips joint. */
  seatLdu: Vec3;
  /** Axle to axle, LDU. */
  wheelbaseLdu: number;
  /** Distance between the two rails' centrelines this car runs on, LDU (the wheel centres' spacing). */
  gaugeLdu: number;
}

/** Wheel moulds of the car (`own-car.ldr`): the 4600 axle plates' x distance is the wheelbase, the 4624 rims' z distance the gauge. */
const AXLE_PLATE = '4600.dat', WHEEL_RIM = '4624.dat';

/** Read the car fixture. Throws when it lacks a seat meta, two axle plates or wheel rims on both sides: a car the runtime could not seat or pitch. */
export function parseCoasterCar(text: string): OwnCoasterCar {
  const doc = parseLDrawDocument(text);
  const seat = doc.metas.find(m => m.kind === 'SEAT');
  if (!seat || seat.kind !== 'SEAT') throw new Error('coaster car: no `0 !CRAFTMATIC SEAT` meta (the rider\'s hips joint).');
  const axles = doc.bricks.filter(b => b.part.toLowerCase() === AXLE_PLATE).map(b => b.x);
  if (axles.length !== 2) throw new Error(`coaster car: ${axles.length} axle plates (${AXLE_PLATE}); a car has exactly two.`);
  const rims = doc.bricks.filter(b => b.part.toLowerCase() === WHEEL_RIM).map(b => b.z);
  const gaugeLdu = Math.max(...rims) - Math.min(...rims);
  if (!(gaugeLdu > 0)) throw new Error(`coaster car: wheel rims (${WHEEL_RIM}) must sit on both sides of the car.`);
  return { bricks: doc.bricks, seatLdu: [seat.at[0], seat.at[1], seat.at[2]], wheelbaseLdu: Math.abs(axles[0]! - axles[1]!), gaugeLdu };
}

// ─── Frame: design -> pack ──────────────────────────────────────────────────

export interface PlaceOptions {
  /** Blocks between the pin and the station's start along x and z (default 8). */
  marginB?: number;
  /** Height of the platform under the station, blocks: the route is raised by it (default 1). */
  groundB?: number;
}
export const PLACE_DEFAULTS = { marginB: 8, groundB: 1 } as const;

/** The design's route and ups in the pack's frame, the offset applied and the extent. */
export interface PlacedCoaster {
  points: Vec3[]; ups: CoasterVec3[]; zones: CoasterRouteZone[];
  /** Added to every design coordinate. */
  offset: Vec3;
  /** Largest coordinate per axis after the move, blocks. */
  extent: Vec3;
}

/**
 * Move the design's frame into the pack's: a pure translation (arcs, ups and tangents are unchanged) that puts the
 * station's start `marginB` from the pin and the rails on the platform. The circuit runs on into NEGATIVE x and z, so
 * a player who pins at the platform stands at the station, not hundreds of blocks from it (entities have no lower bound).
 */
export function placeGenerated(gen: GeneratedCoaster, options: PlaceOptions = {}): PlacedCoaster {
  const margin = options.marginB ?? PLACE_DEFAULTS.marginB, ground = options.groundB ?? PLACE_DEFAULTS.groundB;
  const offset: Vec3 = [margin, ground, margin];
  const points = gen.route.points.map((p): Vec3 => [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]]);
  const extent: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let a = 0; a < 3; a++) extent[a] = Math.max(extent[a]!, p[a]!);
  return { points, ups: gen.ups.map((u): CoasterVec3 => [u[0], u[1], u[2]]), zones: gen.zones.map(z => ({ ...z, ...(z.params ? { params: { ...z.params } } : {}) })), offset, extent };
}

// ─── The runtime route ──────────────────────────────────────────────────────

export interface RouteOptions extends PlaceOptions {
  /** Label of the route and its cars (default the design's name). */
  label?: string;
  /** Arc distance between neighbouring cars, blocks (default 2.5: the car's 120 LDU plus a coupling gap). */
  pitchB?: number;
}
export const ROUTE_DEFAULTS = { pitchB: 2.5 } as const;

/** Position at an arc distance on a closed polyline of `points` (wrapping). */
function pointAtArc(points: readonly Vec3[], cumulative: readonly number[], arc: number): Vec3 {
  const total = cumulative[cumulative.length - 1]!;
  const s = ((arc % total) + total) % total;
  let lo = 0, hi = points.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cumulative[mid]! <= s) lo = mid; else hi = mid - 1; }
  const a = points[lo]!, b = points[lo + 1]!, span = cumulative[lo + 1]! - cumulative[lo]!;
  const f = span > 0 ? (s - cumulative[lo]!) / span : 0;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * The runtime route of a generated coaster: the points, ups and zones as designed, the platform of the design's
 * station zone, the first real lift (a `lift` zone that is not a flat drive) as the chain, and ONE train of
 * `design.carsPerTrain` cars of `car` standing in the station (the runtime instances a second train for
 * `design.trains` 2).
 *
 * @throws when the design has no station zone or more cars than a train may carry (`COASTER_MAX_CARS`)
 */
export function coasterRouteFromGenerated(gen: GeneratedCoaster, design: CoasterDesign, car: OwnCoasterCar, options: RouteOptions = {}): CoasterRoute {
  const placed = placeGenerated(gen, options);
  const station = placed.zones.find(z => z.kind === 'station');
  if (!station) throw new Error('coaster design: no station zone (the design must start with a station element).');
  if (design.carsPerTrain < 1 || design.carsPerTrain > COASTER_MAX_CARS) throw new Error(`coaster design: ${design.carsPerTrain} cars per train; a train carries 1 to ${COASTER_MAX_CARS}.`);
  const stop = (station.from + station.to) / 2;
  const cumulative = [0];
  for (let i = 1; i < placed.points.length; i++) {
    const p = placed.points[i]!, q = placed.points[i - 1]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  const pitch = options.pitchB ?? ROUTE_DEFAULTS.pitchB, n = design.carsPerTrain;
  // Slot k leads at `centre + extent / 2 - k * pitch` (`planCoasterVehicles` sorts by decreasing arc).
  const vehicles: CoasterRouteCar[] = Array.from({ length: n }, (_, k): CoasterRouteCar => ({
    chassis: 'own-coaster-car.dat', sourceIndices: [], bricks: car.bricks, rider: [], seatLdu: car.seatLdu,
    datumPoint: pointAtArc(placed.points, cumulative, stop + ((n - 1) / 2 - k) * pitch), heading: 1,
    wheelbase: car.wheelbaseLdu / LDU_PER_BLOCK, wheelbaseLdu: car.wheelbaseLdu, length: 120 / LDU_PER_BLOCK,
  }));
  const lift = placed.zones.find(z => z.kind === 'lift' && !z.params?.['drive']);
  const chain: CoasterRouteChainLift | undefined = lift ? { kind: 'chain', arcStart: lift.from, arcEnd: lift.to, climbDirection: 1, sprockets: 0 } : undefined;
  return {
    // The route's own speed ceiling is its design limit, capped by what the sim measured the pack can hold (`COASTER_ZONES.SPEED_CAP_BPS`).
    maxSpeedBps: Math.min(design.limits.maxSpeedBps, COASTER_ZONES.SPEED_CAP_BPS),
    label: options.label ?? design.name, points: placed.points, closed: true, maxSegmentLength: gen.route.maxSegmentLength,
    vehicles, trains: design.trains, ups: placed.ups, zones: placed.zones, station: { start: station.from, end: station.to, stop },
    ...(chain ? { lift: chain } : {}),
  };
}

// ─── The track ──────────────────────────────────────────────────────────────

/** One rail chunk as a pack entity: what `emitCompiledEntity` takes, plus its label. */
export interface CoasterTrackEntity { id: string; label: string; geo: EmittableGeometry; behavior: unknown; cuboids: number }

/** The rail chunks of a generated coaster for `PlayableAddonOptions.coasterTrack`. */
export interface CoasterTrackPack {
  entities: CoasterTrackEntity[];
  /** One per chunk, at its root in the pack's frame, yaw 0. */
  actors: PlacementActor[];
  warnings: string[];
  mesh: Pick<TrackMesh, 'stats'>;
  /** The rails' straight pieces in the MIRRORED mesh frame (z negated against the pack's), for gauge and height checks. */
  rails: TrackMesh['railPieces'];
}

export interface TrackPackOptions extends PlaceOptions {
  /** Entity id stem (`<idPrefix>_c<ix>_<iy>_<iz>`); must not begin with a digit. */
  idPrefix: string;
  label?: string;
  /** Overrides of the rail profile; the gauge defaults to the car's wheel spacing. */
  profile?: Partial<TrackProfile>;
  /** The car the rails carry (sets the gauge). */
  car?: Pick<OwnCoasterCar, 'gaugeLdu'>;
  /** Namespace of the entities (default `craftmatic`). */
  namespace?: string;
}

/**
 * Rails and ties as entity chunks. The mesh is solved in the Z-mirrored frame (`mirror: 'z'`: the world is the
 * geometry JSON's frame mirrored in Z) and each chunk's actor stands at its root un-mirrored.
 */
export function buildCoasterTrackPack(gen: GeneratedCoaster, options: TrackPackOptions): CoasterTrackPack {
  const placed = placeGenerated(gen, options);
  const gaugeB = options.car ? options.car.gaugeLdu / LDU_PER_BLOCK : COASTER_TRACK_MESH.gaugeB;
  const mesh = buildTrackMesh(
    { route: { ...gen.route, points: placed.points }, ups: placed.ups, zones: placed.zones as GeneratedCoaster['zones'] },
    { idPrefix: options.idPrefix, mirror: 'z', floorY: 0, profile: { gaugeB, ...options.profile } },
  );
  const ns = options.namespace ?? 'craftmatic', label = options.label ?? gen.route.kind;
  const entities: CoasterTrackEntity[] = [], actors: PlacementActor[] = [];
  mesh.chunks.forEach((chunk, index) => {
    const meshes = chunk.materials.map(m => {
      const material = resolveLdrawEntityMaterial(m.ldrawColor);
      return { id: m.geometryId, material, translucent: material.alpha < 1 };
    });
    // The collision box only sets how far the chunk is drawn (`shellBehavior`): size it from the chunk's reach.
    const span = chunk.reachBlocks * 2;
    entities.push({
      id: chunk.id, label: `${label} track ${index + 1}`,
      geo: { value: chunk.geometry, meshes, diagnostics: { cubeCount: chunk.cubeCount } },
      behavior: shellBehavior(chunk.id, { width: span, height: span, length: span }), cuboids: chunk.cubeCount,
    });
    actors.push({ typeId: `${ns}:${chunk.id}`, label: `${label} track ${index + 1}`, x: chunk.root[0], y: chunk.root[1], z: -chunk.root[2], yaw: 0 });
  });
  return { entities, actors, warnings: mesh.warnings, mesh: { stats: mesh.stats }, rails: mesh.railPieces };
}
