import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  COASTER_MAX_CARS, PARKED_SIDING_FACTOR, TRACK_TWIST_RATE_DEG_PER_BLOCK, buildCoasterRideAssets, canonicalCoasterCar, coasterCarWheelbaseLdu, coasterCartAssets, coasterMaxSpacing, coasterRoutesFromAssemblies,
  coasterRuntimeConfig, coasterScript, coasterTrackUps, findCoasterStation, planCoasterVehicles, resolveCoasterCars, COASTER_CAR_LENGTH,
  COASTER_PHYSICS, COASTER_RIDE_PACE, COASTER_RIDER_VIEW, coasterCarAttitude, coasterLoopRadius, coasterRiderView,
} from '../web/src/engine/bedrock-coaster.js';
import type { CoasterRiderViewConfig, CoasterRoute, CoasterRouteCar } from '../web/src/engine/bedrock-coaster.js';
import type { CoasterCar } from '../web/src/engine/coaster-assemblies.js';
import { detectCoasterAssemblies } from '../web/src/engine/coaster-assemblies.js';
import { extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { sceneGridPoint } from '../web/src/engine/bedrock-scene-actors.js';
import { BEDROCK_UNITS_PER_LDU } from '../web/src/engine/lego-scale.js';
import { buildCoasterFrames, buildCoasterPath } from '../web/src/engine/coaster-path.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { BlockGrid } from '../src/schem/types.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { host } from './_placement-host.js';

interface RideHostOptions { riders?: boolean; scale?: number; wheelbase?: number; seat?: [number, number, number]; camera?: Partial<CoasterRiderViewConfig> }

/** One host per placement. A route that declares a train gets that many car
 * entities, all spawned at the same station point the placement uses. The
 * cart's wheelbase and seat are what `buildCoasterRideAssets` would fill in. */
function rideHost(route: CoasterRoute, options: RideHostOptions = {}) {
  const bare = coasterRuntimeConfig('craftmatic:test_cart', [route]);
  const config = { ...bare, ...(options.camera ? { camera: { ...bare.camera!, ...options.camera } } : {}), types: { ...bare.types, 'craftmatic:test_cart': { ...bare.types['craftmatic:test_cart']!, ...(options.wheelbase !== undefined ? { wheelbase: options.wheelbase } : {}), ...(options.seat ? { seat: options.seat } : {}) } } };
  const count = config.routes[0]!.cars.count;
  let loaded = true, removed = false;
  /** Cars whose chunk has gone: Bedrock reports an unloaded entity as invalid. */
  const gone = new Set<number>();
  const cars = Array.from({ length: count }, (_, index) => {
    const properties = new Map<string, unknown>([
      ['craftmatic:coaster_origin', { x: 100, y: 64, z: 200 }],
      ['craftmatic:coaster_rotation', 0], ['craftmatic:coaster_scale', options.scale ?? 1], ['craftmatic:coaster_route', 0],
    ]);
    const rider = { id: `rider${index}`, onScreenDisplay: { setActionBar: vi.fn() } };
    // A cart now runs with or without a rider, so the default host is EMPTY and
    // a test boards deliberately. `riders: true` starts with a rider aboard.
    const riders: unknown[] = options.riders ? [rider] : [];
    const positions: Array<{ x: number; y: number; z: number }> = [];
    /** The rotation Bedrock would remember between ticks; the runtime reads it back to hold a yaw. */
    const rotation = { x: 0, y: 0 };
    const yaws: number[] = [];
    const entity: any = {
      // The runtime discovers coaster entities by family and resolves each one's
      // role from its type, so the mock carries the cart's type id.
      id: `cart${index}`, typeId: 'craftmatic:test_cart', getDynamicProperty: (key: string) => { if (removed) throw new Error('removed'); return properties.get(key); },
      setDynamicProperty: (key: string, value: unknown) => properties.set(key, value),
      setProperty: vi.fn(), teleport: vi.fn(), getRotation: () => ({ ...rotation }),
      // Bedrock exposes removal through isValid; a removed cart must retire quietly.
      isValid: () => !removed && !gone.has(index),
      getComponent: () => ({ getRiders: () => [...riders], ejectRiders: () => { riders.length = 0; } }),
    };
    entity.tryTeleport = vi.fn((position: any, teleportOptions: any) => {
      entity.teleport(position, teleportOptions); positions.push({ ...position });
      if (teleportOptions?.rotation) { rotation.x = teleportOptions.rotation.x; rotation.y = teleportOptions.rotation.y; yaws.push(teleportOptions.rotation.y); }
      return true;
    });
    entity.dimension = { getBlock: () => loaded ? {} : undefined };
    return { entity, properties, rider, riders, positions, yaws };
  });
  const world = { getDimension: (name: string) => ({ getEntities: () => name === 'overworld' && !removed
    ? cars.filter((_, index) => !gone.has(index)).map(car => car.entity) : [] }) };
  let tick = () => {};
  const system = { runInterval: (callback: () => void) => { tick = callback; } };
  const script = coasterScript(config);
  const start = () => new Function('world', 'system', script.replace(/^import .*;\n/, ''))(world, system);
  start();
  const lead = cars[0]!;
  /** Saved ride distance after each tick (the train's centre), whether or not it moved. */
  const distances: number[] = [];
  const speedsOf = (positions: Array<{ x: number; y: number; z: number }>) => positions.slice(1).map((point, index) => {
    const previous = positions[index]!;
    return Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) * 20;
  });
  const total = config.routes[0]!.path.length, closed = config.routes[0]!.path.closed;
  /** Ride speed in world blocks per second from consecutive saved arc distances (the train's centre). */
  const arcSpeeds = () => distances.slice(1).map((distance, index) => {
    let step = Math.abs(distance - distances[index]!);
    if (closed) step = Math.min(step, total - step);
    return step * 20 * (options.scale ?? 1);
  });
  return { cars, config, distances, start,
    // Car 0 aliases keep the single-cart tests reading as they did.
    entity: lead.entity, properties: lead.properties, riders: lead.riders, rider: lead.rider, positions: lead.positions,
    run: (n: number) => { for (let i = 0; i < n; i++) { tick(); distances.push(Number(lead.properties.get('craftmatic:coaster_distance'))); } },
    board: (index = 0) => { cars[index]!.riders.push(cars[index]!.rider); },
    dismount: (index = 0) => { cars[index]!.riders.length = 0; },
    setLoaded: (value: boolean) => { loaded = value; }, remove: () => { removed = true; },
    unload: (index: number) => { gone.add(index); }, reload: (index: number) => { gone.delete(index); },
    /** World blocks per second between consecutive teleports of one car: the ENTITY's speed, which carries the rider's head offset. */
    speeds: (index = 0) => speedsOf(cars[index]!.positions),
    arcSpeeds,
    /** Where the car's bricks are drawn: the entity position plus its body offset, i.e. the track datum. */
    datums: (index = 0) => datumsOf(cars[index]!, options.scale ?? 1),
  };
}

/**
 * The track datum of every teleport: the entity position plus the body offset
 * the runtime set on the same tick, turned from model units into the world.
 * Bedrock draws a model's -Z toward the entity's facing (yaw θ faces
 * (-sin θ, 0, cos θ)) with the model mirrored in X, so a model vector (mx, my,
 * mz) is the world vector (-(cos θ·mx) + sin θ·mz, my, -(sin θ·mx) - cos θ·mz)
 * scaled by the wand size over 16 units per block.
 */
function datumsOf(car: { entity: any; positions: Array<{ x: number; y: number; z: number }> }, scale: number) {
  const calls = car.entity.setProperty.mock.calls as Array<[string, number]>;
  const yaws = (car.entity.teleport.mock.calls as any[][]).map(call => call[1].rotation.y as number);
  const body = (name: string) => calls.filter(call => call[0] === name).map(call => call[1]);
  const bx = body('craftmatic:body_x'), by = body('craftmatic:body_y'), bz = body('craftmatic:body_z');
  return car.positions.map((p, k) => {
    const yaw = yaws[k]! * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    const mx = (bx[k] ?? 0) / 16 * scale, my = (by[k] ?? 0) / 16 * scale, mz = (bz[k] ?? 0) / 16 * scale;
    return { x: p.x + (-c * mx + s * mz), y: p.y + my, z: p.z + (-s * mx - c * mz) };
  });
}

const straight: CoasterRoute = { label: 'Measured track', points: [[0, 0, 0], [10, 0, 0]], closed: false, maxSegmentLength: 10 };

/**
 * A route with 10303's measured shape: a level reload zone that runs into a
 * tower climb. The numbers come from the route in the device-built 10303 pack
 * (1,066 samples, 174.885 blocks, largest sample spacing 0.375 blocks, station
 * flat 18.9 blocks long at y 3.30, tower climb rising 31.3 blocks over ~50
 * blocks of track — mean sin(theta) 0.63). Held to 12 + 30 blocks here so a
 * full shuttle cycle fits in a few hundred ticks.
 */
const SPACING = 0.375, STATION_RUN = 12, CLIMB_RUN = 30, CLIMB_GRADE = 0.63;
function towerRoute(label = 'Tower shuttle'): CoasterRoute {
  const points: Array<[number, number, number]> = [];
  for (let along = 0; along <= STATION_RUN + 1e-9; along += SPACING) points.push([along, 1, 0]);
  const dx = Math.sqrt(1 - CLIMB_GRADE * CLIMB_GRADE);
  for (let along = SPACING; along <= CLIMB_RUN + 1e-9; along += SPACING) {
    points.push([STATION_RUN + along * dx, 1 + along * CLIMB_GRADE, 0]);
  }
  return { label, points, closed: false, maxSegmentLength: SPACING + 1e-6 };
}

/** A closed vertical circle: no level track at all, and an inverted apex. */
/**
 * How far the cart's own up has tipped, from the two bones that carry it:
 * rotating (0,1,0) by the pitch about X and the roll about Z leaves
 * `cos(pitch) * cos(roll)` as its y, so -1 is fully inverted.
 *
 * Deliberately representation-independent. A loop used to be drawn by flipping
 * the YAW 180 degrees and rolling the cart over; it is now drawn by running the
 * PITCH past vertical with the yaw held, because the first spun the car about
 * the vertical axis at every loop. Both put the cart upside down, and a test
 * that names one of them is testing the parametrisation, not the ride.
 */
function cartUpY(h: { entity: { setProperty: { mock: { calls: unknown[][] } } } }): number {
  const last = (name: string): number => {
    const calls = h.entity.setProperty.mock.calls.filter(call => call[0] === name);
    return calls.length ? Number(calls[calls.length - 1]![1]) : 0;
  };
  const toRad = Math.PI / 180;
  return Math.cos(last('craftmatic:track_pitch') * toRad) * Math.cos(last('craftmatic:track_roll') * toRad);
}

function loopRoute(radius = 10, segments = 64): CoasterRoute {
  const points: Array<[number, number, number]> = Array.from({ length: segments + 1 }, (_, index) => {
    const angle = index / segments * Math.PI * 2;
    return [0, radius * (1 - Math.cos(angle)), radius * Math.sin(angle)] as [number, number, number];
  });
  points[segments] = [...points[0]!];
  return { label: 'Loop', points, closed: true, maxSegmentLength: 2 };
}

describe('measured station', () => {
  it('picks the longest level run in the low band, not a fixed index', () => {
    const station = findCoasterStation(buildCoasterPath(towerRoute().points, false, SPACING + 1e-6));
    expect(station.start).toBeCloseTo(0);
    expect(station.end).toBeCloseTo(STATION_RUN);
    expect(station.stop).toBeCloseTo(STATION_RUN / 2);
    expect(station.point).toEqual([STATION_RUN / 2, 1, 0]);
  });
  it('prefers a low level run over a longer one high on the route', () => {
    // A short platform at the bottom and a long level crest 20 blocks up: a
    // station is where the ride LOADS, so height decides, not raw length.
    const points: Array<[number, number, number]> = [];
    for (let x = 0; x <= 6; x++) points.push([x, 0, 0]);
    for (let x = 1; x <= 20; x++) points.push([6 + x * 0.6, x, 0]);
    for (let x = 1; x <= 30; x++) points.push([18 + x, 20, 0]);
    const station = findCoasterStation(buildCoasterPath(points, false, 2));
    expect(station.stop).toBeCloseTo(3);
    expect(station.point[1]).toBe(0);
  });
  it('falls back to the lowest point when a route has no level run', () => {
    const station = findCoasterStation(buildCoasterPath(loopRoute().points, true, 2));
    expect(station.length).toBeGreaterThanOrEqual(0);
    expect(station.point[1]).toBeCloseTo(0);
  });
  it('joins a level run that straddles a closed route seam', () => {
    // A circuit whose platform spans the repeated first point: both halves
    // belong to one station, not two shorter ones split at the seam. The level
    // crest is longer but high, so it is not eligible.
    const points: Array<[number, number, number]> = [];
    for (let x = 0; x <= 5; x++) points.push([x, 0, 0]);
    for (let i = 1; i <= 3; i++) points.push([5 + i, 1.5 * i, 0]);
    points.push([8, 4.5, 3], [8, 4.5, 6], [0, 4.5, 6], [-8, 4.5, 6], [-8, 4.5, 3], [-8, 4.5, 0]);
    for (let i = 1; i <= 3; i++) points.push([-8 + i, 4.5 - 1.5 * i, 0]);
    for (let x = -4; x <= 0; x++) points.push([x, 0, 0]);
    const path = buildCoasterPath(points, true, 8);
    const station = findCoasterStation(path);
    expect(station.start).toBeGreaterThan(station.end);
    expect(station.end).toBeCloseTo(5);
    expect(station.length).toBeCloseTo(10);
    // Midpoint of a span that wraps the seam is the seam itself, normalized
    // into [0, total) the same way the runtime wraps its own distance.
    expect(station.stop).toBe(0);
    expect(station.point).toEqual([0, 0, 0]);
  });
  it('measures the largest authored sample spacing', () => {
    expect(coasterMaxSpacing(buildCoasterPath(towerRoute().points, false, SPACING + 1e-6))).toBeCloseTo(SPACING);
    expect(coasterMaxSpacing(buildCoasterPath(straight.points, false, 10))).toBeCloseTo(10);
  });
});

describe('serialized coaster runtime', () => {
  it('runs continuously with nobody aboard, from the station outwards', () => {
    const h = rideHost(towerRoute());
    // Parked on the platform from the first tick, so a player can walk up to it.
    h.run(1);
    expect(h.positions[0]).toEqual({ x: 106, y: 65, z: 200 });
    expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(STATION_RUN / 2);
    // It departs by itself and keeps moving: no rider has ever been aboard.
    h.run(400);
    expect(h.riders).toHaveLength(0);
    expect(h.positions).toHaveLength(401);
    const travelled = h.speeds().reduce((total, speed) => total + speed / 20, 0);
    expect(travelled).toBeGreaterThan(40);
  });
  it('crawls up the measured grade and runs away on the drop', () => {
    const h = rideHost(towerRoute());
    h.run(1200);
    // The cart's bricks (the datum) trace the track; the entity itself also
    // carries the rider's head offset, so speeds are read off the datums.
    const datums = h.datums();
    const climbing: number[] = [], falling: number[] = [];
    for (let index = 1; index < datums.length; index++) {
      const from = datums[index - 1]!, to = datums[index]!;
      const step = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      if (step < 1e-9) continue;
      const grade = (to.y - from.y) / step;
      if (grade > 0.2) climbing.push(step * 20); else if (grade < -0.2) falling.push(step * 20);
    }
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    const { LIFT_SPEED, STATION_BRAKE, MAX_SPEED } = COASTER_PHYSICS;
    expect(climbing.length).toBeGreaterThan(50);
    expect(falling.length).toBeGreaterThan(50);
    // The chain lift holds the climb at its own speed; the 19-block drop is
    // bounded by the physics (sqrt(2 g h)) and the ceiling — never by the
    // sample spacing (7.5 blocks/s on this route).
    expect(mean(climbing)).toBeGreaterThan(0.88 * LIFT_SPEED);
    expect(mean(climbing)).toBeLessThan(1.04 * LIFT_SPEED);
    expect(mean(falling) / mean(climbing)).toBeGreaterThan(3);
    // The chain never overdrives the climb; the drop runs well past the old
    // 7.5 blocks/s spacing ceiling and is bounded here by the station brake
    // curve (sqrt(2 · brake · 24) at the top of the drop, which ends 6 blocks
    // from the platform), never by the ceiling.
    expect(Math.max(...climbing)).toBeLessThanOrEqual(1.04 * LIFT_SPEED);
    expect(Math.max(...falling)).toBeGreaterThan(0.9 * Math.sqrt(2 * STATION_BRAKE * 24));
    expect(Math.max(...falling)).toBeLessThanOrEqual(MAX_SPEED + 1e-6);
  });
  it('integrates each tick in substeps no longer than a sample spacing, so speed is bounded by physics, not resolution', () => {
    for (const scale of [1, 4]) {
      const h = rideHost(towerRoute(), { scale });
      h.run(1500);
      const spacing = coasterMaxSpacing(h.config.routes[0]!.path);
      let largest = 0;
      for (let index = 1; index < h.distances.length; index++) {
        const step = Math.abs(h.distances[index]! - h.distances[index - 1]!);
        if (step > largest) largest = step;
      }
      // The arc step per tick exceeds one sample spacing on the drop at 1x (the
      // old ceiling) and never the ride ceiling.
      if (scale === 1) expect(largest).toBeGreaterThan(spacing);
      expect(largest).toBeLessThanOrEqual(COASTER_PHYSICS.MAX_SPEED / (20 * scale) + 1e-9);
      expect(Math.max(...h.arcSpeeds())).toBeLessThanOrEqual(COASTER_PHYSICS.MAX_SPEED + 1e-6);
    }
    // A ceiling-limited drop still follows every sample: the datums lie on the polyline.
    const h = rideHost(towerRoute());
    h.run(1200);
    const dx = Math.sqrt(1 - CLIMB_GRADE * CLIMB_GRADE);
    for (const d of h.datums()) {
      if (d.x <= 100 + STATION_RUN + 1e-6) expect(d.y).toBeCloseTo(65, 6);
      else expect(d.y - 65).toBeCloseTo((d.x - 100 - STATION_RUN) / dx * CLIMB_GRADE, 6);
    }
  });
  it('carries the rider\'s head through the car\'s pitch and draws the bricks back on the track', () => {
    // On the 39-degree climb the seat and eye (1.25 blocks) tilt back with the
    // car: the entity sits behind and below the datum by exactly that, and the
    // body offset returns the bricks to the rails. On the level run all three
    // offsets are zero, byte for byte the device-proved placement.
    const h = rideHost(towerRoute());
    h.run(600);
    const calls = h.entity.setProperty.mock.calls as Array<[string, number]>;
    const body = (name: string) => calls.filter(call => call[0] === name).map(call => call[1]);
    const bx = body('craftmatic:body_x'), by = body('craftmatic:body_y'), bz = body('craftmatic:body_z');
    expect(bx).toHaveLength(h.positions.length);
    const datums = h.datums();
    let level = 0, climbing = 0;
    for (let k = 0; k < h.positions.length; k++) {
      const p = h.positions[k]!, d = datums[k]!;
      if (d.x <= 100 + STATION_RUN + 1e-6) {
        level++;
        expect(p).toEqual(d);
        expect([bx[k], by[k], bz[k]].map(Math.abs)).toEqual([0, 0, 0]);
      } else if (d.x > 100 + STATION_RUN + 2) {
        climbing++;
        const tilt = Math.asin(CLIMB_GRADE);
        // Eye 1.25 up the car's up vector (which leans back by the climb angle) versus 1.25 straight up.
        expect(p.x - d.x).toBeCloseTo(-1.25 * Math.sin(tilt), 3);
        expect(p.y - d.y).toBeCloseTo(1.25 * (Math.cos(tilt) - 1), 3);
        expect(bx[k]).toBeCloseTo(0, 6);
      }
    }
    expect(level).toBeGreaterThan(50);
    expect(climbing).toBeGreaterThan(50);
  });
  it('brakes into the platform, dwells, and departs again each lap', () => {
    const h = rideHost(towerRoute());
    h.run(1600);
    const stop = h.config.routes[0]!.station.stop;
    // A dwell is a run of consecutive ticks parked on the platform.
    const dwells: number[] = [];
    let run = 0;
    for (let index = 1; index < h.distances.length; index++) {
      const parked = Math.abs(h.distances[index]! - stop) < 1e-9 && h.distances[index] === h.distances[index - 1];
      if (parked) run++; else { if (run) dwells.push(run); run = 0; }
    }
    if (run) dwells.push(run);
    expect(dwells.length).toBeGreaterThanOrEqual(2);
    for (const dwell of dwells) expect(dwell).toBeGreaterThanOrEqual(50);
    // It arrives braked, not at full speed: the last approach step is slow.
    const arrival = h.distances.findIndex((distance, index) => index > 2 && Math.abs(distance - stop) < 1e-9
      && Math.abs(h.distances[index - 1]! - stop) > 1e-9);
    expect(arrival).toBeGreaterThan(0);
    const approach = Math.abs(h.distances[arrival - 1]! - h.distances[arrival - 2]!);
    expect(approach).toBeLessThan(0.1);
  });
  it('still stops at the platform on every lap with a rider aboard', () => {
    const h = rideHost(towerRoute(), { riders: true });
    h.run(1600);
    const stop = h.config.routes[0]!.station.stop;
    const parkedTicks = h.distances.filter(distance => Math.abs(distance - stop) < 1e-9).length;
    expect(parkedTicks).toBeGreaterThanOrEqual(100);
    expect(h.riders).toHaveLength(1);
    expect(h.rider.onScreenDisplay.setActionBar).toHaveBeenCalledWith('Coaster departing — sneak to dismount');
  });
  it('holds a boarding player for two seconds when they board on the platform', () => {
    const h = rideHost(towerRoute());
    h.run(1);
    // Board with the platform dwell nearly over: the cart still waits 40 ticks.
    h.run(95);
    h.board();
    const before = Number(h.properties.get('craftmatic:coaster_distance'));
    h.run(39);
    expect(h.properties.get('craftmatic:coaster_distance')).toBe(before);
    h.run(2);
    expect(Number(h.properties.get('craftmatic:coaster_distance'))).toBeGreaterThan(before);
  });
  it('does not stall a moving cart when a rider boards mid-ride', () => {
    const h = rideHost(towerRoute());
    h.run(200);
    const before = Number(h.properties.get('craftmatic:coaster_distance'));
    h.board();
    h.run(5);
    expect(Number(h.properties.get('craftmatic:coaster_distance'))).not.toBe(before);
  });
  it('uses the placement origin, yaw and size together without a constant lift', () => {
    const h = rideHost({ ...straight, points: [[2, 1, 3], [12, 1, 3]] }, { scale: 4 });
    h.properties.set('craftmatic:coaster_rotation', 90);
    h.run(1);
    // The whole route is level, so its station spans it and the platform is its
    // midpoint: model (7, 1, 3) placed at 400 % with a quarter turn.
    const at = h.positions[0]!;
    expect(at.x).toBeCloseTo(88); expect(at.y).toBe(68); expect(at.z).toBeCloseTo(228);
    h.run(140);
    expect(h.positions.at(-1)!.z).toBeGreaterThan(228);
  });
  it('follows vertical track under the chain lift without inventing horizontal movement', () => {
    const h = rideHost({ ...straight, points: [[0, 0, 0], [0, 10, 0]] });
    h.run(101);
    // 99 ticks parked at the foot of the climb, then the station drive push,
    // after which the chain takes over at its own speed. The bricks (datums)
    // climb the track; the entity carries the rider's head, which on a
    // vertical car lies 1.25 blocks to the car's up side, and no further.
    const datums = h.datums();
    expect(datums[0]!.x).toBeCloseTo(100, 6); expect(datums[0]!.y).toBeCloseTo(64, 6); expect(datums[0]!.z).toBeCloseTo(200, 6);
    expect(datums[98]!.y).toBeCloseTo(64, 6);
    const { DEPART_SPEED, LIFT_SPEED } = COASTER_PHYSICS;
    expect(datums[99]!.y).toBeCloseTo(64 + DEPART_SPEED / 20, 9);
    // The push decays under gravity to the chain's speed within the next tick.
    expect(datums[100]!.y).toBeCloseTo(64 + DEPART_SPEED / 20 + LIFT_SPEED / 20, 3);
    for (let k = 0; k < datums.length; k++) {
      expect(datums[k]!.x).toBeCloseTo(100, 6);
      expect(Math.hypot(h.positions[k]!.x - datums[k]!.x, h.positions[k]!.z - datums[k]!.z)).toBeCloseTo(1.25, 6);
      expect(h.positions[k]!.y - datums[k]!.y).toBeCloseTo(-1.25, 6);
    }
    h.run(20);
    const speeds = h.arcSpeeds().slice(-10);
    for (const speed of speeds) expect(speed).toBeCloseTo(LIFT_SPEED, 6);
    expect(h.entity.setProperty).toHaveBeenCalledWith('craftmatic:track_pitch', -90);
  });
  it('turns the cart over through a loop without ever spinning its yaw', () => {
    // The reported defect: "the cart does a physically impossible around-track
    // swivel when entering/exiting upside-down loops". A vertical loop passes
    // through two vertical tangents and its heading's horizontal component
    // reverses past the top, so a yaw taken from that horizontal flips 180
    // degrees twice a lap. The cart is on rails: it turns OVER.
    const h = rideHost(loopRoute());
    h.run(400);
    const yaws = h.cars[0]!.yaws;
    expect(yaws.length).toBeGreaterThan(100);
    const step = (a: number, b: number): number => {
      let delta = (b - a) % 360;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      return Math.abs(delta);
    };
    const worst = yaws.slice(1).reduce((most, yaw, index) => Math.max(most, step(yaws[index]!, yaw)), 0);
    expect(worst).toBeLessThan(45);

    // The rotation has to go SOMEWHERE: the pitch carries it past vertical,
    // which is why the property's range is the full turn and not +/-90.
    const pitches = (h.entity.setProperty.mock.calls as Array<[string, number]>)
      .filter(([name]) => name === 'craftmatic:track_pitch').map(([, value]) => value);
    expect(Math.max(...pitches.map(Math.abs))).toBeGreaterThan(95);
    // And the cart really does end up inverted somewhere on the lap.
    expect(Math.min(...pitches.map(p => Math.cos(p * Math.PI / 180)))).toBeLessThan(-0.9);
  });

  it('inverts the cart visually at a loop apex while leaving player rotation upright', () => {
    const route = loopRoute();
    const h = rideHost(route);
    h.properties.set('craftmatic:coaster_distance', coasterRuntimeConfig('craftmatic:ride', [route]).routes[0]!.path.length / 2);
    h.run(1);
    expect(cartUpY(h)).toBeLessThan(-0.9);
    expect(h.entity.teleport.mock.calls[0][1].rotation.x).toBe(0);
  });
  it('keeps a closed circuit circulating and stops at its lowest point', () => {
    const h = rideHost(loopRoute());
    h.run(1200);
    const total = h.config.routes[0]!.path.length;
    // A circuit wraps rather than reversing: distance returns through zero.
    const wraps = h.distances.filter((distance, index) => index > 0 && distance < h.distances[index - 1]! - total / 2).length;
    expect(wraps).toBeGreaterThanOrEqual(1);
    const stop = h.config.routes[0]!.station.stop;
    expect(h.distances.filter(distance => Math.abs(distance - stop) < 1e-9).length).toBeGreaterThanOrEqual(50);
  });
  it('pauses at an unloaded chunk without advancing distance, then resumes', () => {
    const h = rideHost(towerRoute()); h.setLoaded(false); h.run(60);
    expect(h.entity.teleport).not.toHaveBeenCalled(); expect(h.properties.has('craftmatic:coaster_distance')).toBe(false);
    h.setLoaded(true); h.run(1);
    expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(STATION_RUN / 2);
  });
  it('reverses an open route at its measured endpoint; never wraps the gap', () => {
    const h = rideHost(straight);
    h.properties.set('craftmatic:coaster_distance', 9.95);
    h.properties.set('craftmatic:coaster_speed', 6);
    h.run(1);
    expect(h.positions[0]!.x).toBe(110);
    expect(h.properties.get('craftmatic:coaster_direction')).toBe(-1);
    h.run(1);
    // It leaves the dead end on the bounded station-drive push, heading back.
    expect(h.positions[1]!.x).toBeCloseTo(110 - COASTER_PHYSICS.DEPART_SPEED / 20);
  });
  it('persists progress and speed across a script reload and retires removed carts', () => {
    const h = rideHost(towerRoute());
    h.run(140);
    const distance = Number(h.properties.get('craftmatic:coaster_distance'));
    const speed = Number(h.properties.get('craftmatic:coaster_speed'));
    expect(distance).toBeGreaterThan(STATION_RUN / 2);
    expect(speed).toBeGreaterThan(0);
    h.start(); h.run(1);
    // The reloaded script resumes from the saved distance at the saved speed.
    // Within one tick of re-integration of the same saved speed.
    expect(Number(h.properties.get('craftmatic:coaster_distance'))).toBeCloseTo(distance + speed / 20, 2);
    const moves = h.entity.teleport.mock.calls.length;
    h.remove(); h.run(40);
    expect(h.entity.teleport).toHaveBeenCalledTimes(moves);
  });
  it('does not move a summoned cart with no placement frame', () => {
    const h = rideHost(towerRoute(), { riders: true }); h.properties.delete('craftmatic:coaster_origin'); h.run(60);
    expect(h.entity.teleport).not.toHaveBeenCalled();
    expect(h.riders).toHaveLength(0);
  });
  it('holds distance after a failed teleport and resumes at the same next sample', () => {
    const h = rideHost(towerRoute());
    h.entity.tryTeleport.mockReturnValueOnce(false);
    h.run(1);
    expect(h.entity.teleport).not.toHaveBeenCalled(); expect(h.properties.has('craftmatic:coaster_distance')).toBe(false);
    h.run(1);
    expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(STATION_RUN / 2);
  });
  it('keeps running after a rider is lost, without forcing a remount', () => {
    const h = rideHost(towerRoute(), { riders: true });
    h.run(1);
    h.entity.tryTeleport.mockImplementationOnce((position: any, options: unknown) => {
      h.entity.teleport(position, options); h.positions.push({ ...position });
      h.riders.length = 0;
      return true;
    });
    h.run(1);
    expect(h.rider.onScreenDisplay.setActionBar).toHaveBeenCalledWith('Coaster ride ended. Board again when the cart stops at the station.');
    h.run(300);
    expect(h.riders).toHaveLength(0);
    // The ride carries on and comes back to the platform for the next player.
    expect(Number(h.properties.get('craftmatic:coaster_distance'))).toBeGreaterThan(STATION_RUN);
  });
  it('retires a cart removed by Undo without reporting a movement error', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = rideHost(towerRoute(), { riders: true }); h.run(45);
      h.rider.onScreenDisplay.setActionBar.mockClear();
      h.remove(); h.run(60);
      // Undo is an ordinary retirement: no console fault, no message to a player.
      expect(log).not.toHaveBeenCalled();
      expect(h.rider.onScreenDisplay.setActionBar).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it('reports bounded movement errors with their stage and throttles repeated logs', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = rideHost(towerRoute(), { riders: true });
      h.entity.tryTeleport.mockImplementation(() => { throw new Error('movement denied ' + 'x'.repeat(200)); });
      h.run(150);
      expect(h.properties.has('craftmatic:coaster_distance')).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toContain('at teleport cart: movement denied');
      expect(h.rider.onScreenDisplay.setActionBar).toHaveBeenCalledWith('Coaster paused at teleport cart: ' + ('movement denied ' + 'x'.repeat(200)).slice(0, 160));
      h.run(150);
      expect(log).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });
  it('stays inside the declared pitch, roll and body-offset property ranges over a whole ride', () => {
    const h = rideHost(loopRoute(), { scale: 0.25 });
    h.run(1500);
    const calls = h.entity.setProperty.mock.calls as Array<[string, number]>;
    expect(calls.length).toBeGreaterThan(2000);
    const seen = new Set<string>();
    for (const [name, value] of calls) {
      seen.add(name);
      expect(Number.isFinite(value)).toBe(true);
      if (name === 'craftmatic:track_pitch') { expect(value).toBeGreaterThanOrEqual(-180); expect(value).toBeLessThanOrEqual(180); }
      else if (name === 'craftmatic:track_roll') { expect(value).toBeGreaterThanOrEqual(-180); expect(value).toBeLessThanOrEqual(180); }
      else { expect(name).toMatch(/^craftmatic:body_[xyz]$/); expect(value).toBeGreaterThanOrEqual(-320); expect(value).toBeLessThanOrEqual(320); }
    }
    expect([...seen].sort()).toEqual(['craftmatic:body_x', 'craftmatic:body_y', 'craftmatic:body_z', 'craftmatic:track_pitch', 'craftmatic:track_roll']);
  });
  it('rotates heading consistently with the placed track', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const h = rideHost(straight); h.properties.set('craftmatic:coaster_rotation', rotation);
      h.properties.set('craftmatic:coaster_distance', 1);
      h.run(1);
      const yaw = h.entity.teleport.mock.calls[0][1].rotation.y * Math.PI / 180;
      const position = h.positions[0]!;
      // Check facing against actual movement, not a duplicated yaw formula.
      const radius = Math.hypot(position.x - 100, position.z - 200);
      expect(-Math.sin(yaw)).toBeCloseTo((position.x - 100) / radius);
      expect(Math.cos(yaw)).toBeCloseTo((position.z - 200) / radius);
    }
  });
});

/**
 * 10303's three rider clusters sit at (-435.01, y, -99.99) with y = -1162,
 * -1282 and -1402: identical but for exactly 120 LDU of pitch, i.e. a
 * three-car train. At that pack's 53.333 LDU cell the pitch is 2.25 blocks.
 */
const TRAIN_CARS = 3, TRAIN_SPACING = 2.25;
const towerTrain = (): CoasterRoute => ({ ...towerRoute('Tower train'), cars: { count: TRAIN_CARS, spacing: TRAIN_SPACING } });

describe('measured train', () => {
  it('defaults to a single cart and rejects an unmeasurable train', () => {
    const path = buildCoasterPath(towerRoute().points, false, SPACING + 1e-6);
    expect(resolveCoasterCars(path, undefined)).toEqual({ count: 1, spacing: 0, extent: 0, heading: 0, trains: 1 });
    expect(resolveCoasterCars(path, { count: 1, spacing: 9 })).toEqual({ count: 1, spacing: 0, extent: 0, heading: 0, trains: 1 });
    expect(() => resolveCoasterCars(path, { count: 2.5, spacing: 1 })).toThrow(/integer in \[1, 8\]/);
    expect(() => resolveCoasterCars(path, { count: 3, spacing: 0 })).toThrow(/positive number of blocks/);
  });
  it('clamps a train longer than the track it runs on', () => {
    // 42 blocks of route cannot hold three cars 20 blocks apart.
    const path = buildCoasterPath(towerRoute().points, false, SPACING + 1e-6);
    expect(resolveCoasterCars(path, { count: 3, spacing: 20 })).toMatchObject({ count: 2, spacing: 20, extent: 20 });
    expect(resolveCoasterCars(path, { count: 3, spacing: TRAIN_SPACING }))
      .toMatchObject({ count: 3, spacing: TRAIN_SPACING, extent: 2 * TRAIN_SPACING });
  });
  it('measures how far a route’s curvature closes a coupled train up', () => {
    const tower = buildCoasterPath(towerRoute().points, false, SPACING + 1e-6);
    // The tower route bends once, by asin(0.63) = 39.05 degrees: two cars
    // 2.25 blocks apart along the arc close to 2.25 * cos(19.5 deg).
    const bent = resolveCoasterCars(tower, { count: 3, spacing: TRAIN_SPACING }).minChord!;
    expect(bent).toBeCloseTo(TRAIN_SPACING * Math.cos(Math.asin(CLIMB_GRADE) / 2), 2);
    expect(bent).toBeLessThan(TRAIN_SPACING);
    // A straight route leaves the pitch untouched.
    expect(resolveCoasterCars(buildCoasterPath([[0, 0, 0], [40, 0, 0]], false, 40), { count: 3, spacing: 2 }).minChord)
      .toBeCloseTo(2, 9);
    // A tight circle closes two coupled cars right up — it is the SOURCE's
    // curvature that does this, and the caller compares the result against
    // COASTER_CAR_LENGTH to decide whether such a train is buildable. Measured
    // on the real 10303 route: a 2.25-block pitch closes to 0.148 blocks at
    // arc 104.1, and is under one car length on 3.9 % of the track.
    const loop = buildCoasterPath(loopRoute(0.6, 64).points, true, 0.2);
    const tight = resolveCoasterCars(loop, { count: 2, spacing: 1.88 });
    expect(tight.count).toBe(2);
    expect(tight.minChord!).toBeLessThan(COASTER_CAR_LENGTH);
  });
  it('parks the whole train centred on the platform, one car per spacing', () => {
    const h = rideHost(towerTrain());
    h.run(1);
    expect(h.cars).toHaveLength(3);
    // Station platform at arc 6; the train straddles it at 3.75 / 6 / 8.25.
    expect(h.cars.map(car => car.positions[0]!.x)).toEqual([108.25, 106, 103.75]);
    for (const car of h.cars) expect(car.positions[0]!.y).toBe(65);
    // Every car carries the same ride state, so any loaded car can lead it.
    for (const car of h.cars) expect(car.properties.get('craftmatic:coaster_distance')).toBeCloseTo(6);
  });
  it('holds the cars rigidly a spacing apart all the way round', () => {
    const h = rideHost(towerTrain());
    h.run(900);
    const ticks = h.cars[0]!.positions.length;
    expect(ticks).toBe(900);
    for (const car of h.cars) expect(car.positions).toHaveLength(ticks);
    // Invert this route's profile to recover each car's arc position from where
    // its bricks are drawn: level run along x, then a constant grade. Cars are
    // coupled along the ARC.
    const arcOf = (point: { x: number; y: number }) =>
      point.y > 65 + 1e-9 ? STATION_RUN + (point.y - 65) / CLIMB_GRADE : point.x - 100;
    const datums = h.cars.map((_, index) => h.datums(index));
    let worstArc = 0, shortestChord = Infinity, longestChord = 0;
    for (let index = 0; index < ticks; index++) {
      for (let car = 1; car < h.cars.length; car++) {
        const a = datums[car - 1]![index]!, b = datums[car]![index]!;
        worstArc = Math.max(worstArc, Math.abs(arcOf(a) - arcOf(b) - TRAIN_SPACING));
        const chord = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        shortestChord = Math.min(shortestChord, chord);
        longestChord = Math.max(longestChord, chord);
      }
    }
    expect(worstArc).toBeLessThan(1e-6);
    // Straight-line spacing equals the arc pitch on straight track and closes
    // up across a bend — the chord of a coupled train, never longer than it.
    expect(longestChord).toBeLessThanOrEqual(TRAIN_SPACING + 1e-6);
    expect(shortestChord).toBeGreaterThan(TRAIN_SPACING * 0.9);
  });
  it('gives each car its own pitch where the train straddles the grade', () => {
    const h = rideHost(towerTrain());
    h.run(400);
    const pitchOf = (index: number) => {
      const calls = h.cars[index]!.entity.setProperty.mock.calls as Array<[string, number]>;
      return calls.filter(call => call[0] === 'craftmatic:track_pitch').map(call => call[1]);
    };
    const straddled = pitchOf(0).some((pitch, index) => Math.abs(pitch - pitchOf(2)[index]!) > 10);
    expect(straddled).toBe(true);
    // Still one shared speed: the cars never drift apart (asserted above).
    for (let index = 0; index < 3; index++) expect(pitchOf(index).every(pitch => pitch >= -90 && pitch <= 90)).toBe(true);
  });
  it('reverses without flipping the cars past each other', () => {
    const h = rideHost(towerTrain());
    h.run(900);
    const directions = h.distances.map((_, index) => index);
    expect(directions.length).toBeGreaterThan(0);
    // Car 0 keeps the greater arc for the whole run: the train's tail simply
    // becomes its head when an open route reverses, nothing teleports across.
    const first = h.datums(0), last = h.datums(2);
    for (let index = 0; index < first.length; index++) {
      expect(first[index]!.x).toBeGreaterThan(last[index]!.x);
    }
    // The train never steps further than the ride ceiling allows,
    // including on the tick it reverses at the end of the open route.
    for (const speed of h.arcSpeeds()) expect(speed).toBeLessThanOrEqual(COASTER_PHYSICS.MAX_SPEED + 1e-6);
  });
  it('keeps the whole train inside an open route at both ends', () => {
    const h = rideHost(towerTrain());
    h.run(1600);
    const total = h.config.routes[0]!.path.length;
    for (const distance of h.distances) {
      expect(distance).toBeGreaterThanOrEqual(2 * TRAIN_SPACING / 2 - 1e-9);
      expect(distance).toBeLessThanOrEqual(total - 2 * TRAIN_SPACING / 2 + 1e-9);
    }
  });
  it('lets a player board any car, and holds the train while they do', () => {
    const h = rideHost(towerTrain());
    h.run(1);
    h.run(95);
    h.board(2);
    const before = Number(h.properties.get('craftmatic:coaster_distance'));
    h.run(39);
    expect(h.properties.get('craftmatic:coaster_distance')).toBe(before);
    h.run(2);
    expect(Number(h.properties.get('craftmatic:coaster_distance'))).toBeGreaterThan(before);
    // The rider is on car 2 and the ride carries them: three single-seat cars
    // are three independent places for three different players.
    expect(h.cars[2]!.riders).toHaveLength(1);
    expect(h.cars[0]!.riders).toHaveLength(0);
  });
  it('stops the train at the platform on every lap', () => {
    const h = rideHost(towerTrain());
    h.run(1600);
    const stop = h.config.routes[0]!.station.stop;
    const dwells: number[] = [];
    let run = 0;
    for (let index = 1; index < h.distances.length; index++) {
      const parked = Math.abs(h.distances[index]! - stop) < 1e-9 && h.distances[index] === h.distances[index - 1];
      if (parked) run++; else { if (run) dwells.push(run); run = 0; }
    }
    if (run) dwells.push(run);
    expect(dwells.length).toBeGreaterThanOrEqual(2);
    for (const dwell of dwells) expect(dwell).toBeGreaterThanOrEqual(50);
  });
  it('keeps running when one car unloads, and takes it back where it belongs', () => {
    const h = rideHost(towerTrain());
    h.run(200);
    // Bedrock reports an unloaded entity as invalid; the ride must not stop,
    // and the remaining cars must not close the gap where it was.
    h.unload(0);
    const before = h.cars[1]!.positions.length;
    h.run(200);
    expect(h.cars[1]!.positions.length).toBe(before + 200);
    expect(h.cars[0]!.positions.length).toBe(before);
    // The state on car 1 carried the ride: it can lead in car 0's absence.
    const centre = Number(h.cars[1]!.properties.get('craftmatic:coaster_distance'));
    expect(centre).not.toBe(Number(h.cars[0]!.properties.get('craftmatic:coaster_distance')));
    h.reload(0);
    h.run(21);
    const arcOf = (point: { x: number; y: number }) =>
      point.y > 65 + 1e-9 ? STATION_RUN + (point.y - 65) / CLIMB_GRADE : point.x - 100;
    // Its saved index puts it back a spacing ahead of car 1, not at the end of
    // the train or on top of another car.
    expect(arcOf(h.cars[0]!.positions.at(-1)!) - arcOf(h.cars[1]!.positions.at(-1)!)).toBeCloseTo(TRAIN_SPACING, 9);
  });
  it('holds the whole train when one car faces an unloaded chunk', () => {
    const h = rideHost(towerTrain());
    h.run(1);
    for (const car of h.cars) expect(car.positions).toHaveLength(1);
    h.setLoaded(false);
    h.run(200);
    for (const car of h.cars) expect(car.positions).toHaveLength(1);
    expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(6);
  });
});

describe('coaster pack assets', () => {
  it('initializes the cart route frame through the serialized placement lifecycle', async () => {
    const h = host({ stem: 'coaster_frame', label: 'Ride', width: 12, height: 4, length: 8, tiles: [],
      actors: [{ typeId: 'craftmatic:ride', label: 'Ride', x: 3, y: 2, z: 4, coasterRouteIndex: 0 }] });
    await h.open({ selection: 1 }, { canceled: true });
    await h.open({ selection: 5 }, { selection: 0 }); await h.flush(4000);
    const cart = h.spawned.find(spawn => spawn.typeId === 'craftmatic:ride')!;
    expect(cart).toBeDefined();
    expect(cart.entity.getDynamicProperty('craftmatic:coaster_origin')).toEqual({ x: 100, y: 64, z: 200 });
    expect(cart.entity.getDynamicProperty('craftmatic:coaster_scale')).toBe(1);
    expect(cart.entity.getDynamicProperty('craftmatic:coaster_route')).toBe(0);
    // No car index in the actor: none written, the runtime assigns one on first sight.
    expect(cart.entity.getDynamicProperty('craftmatic:coaster_car')).toBeUndefined();
  });
  it('writes each train car its placement-assigned index, all spawned at the station point', async () => {
    const at = { x: 3, y: 2, z: 4 };
    const h = host({ stem: 'coaster_train', label: 'Ride', width: 12, height: 4, length: 8, tiles: [],
      actors: [0, 1, 2].map(car => ({ typeId: 'craftmatic:ride', label: `Ride Car ${car + 1}`, ...at, coasterRouteIndex: 0, coasterCarIndex: car })) });
    await h.open({ selection: 1 }, { canceled: true });
    await h.open({ selection: 5 }, { selection: 0 }); await h.flush(4000);
    const cars = h.spawned.filter(spawn => spawn.typeId === 'craftmatic:ride');
    expect(cars).toHaveLength(3);
    expect(cars.map(car => car.entity.getDynamicProperty('craftmatic:coaster_car'))).toEqual([0, 1, 2]);
    for (const car of cars) {
      expect(car.entity.getDynamicProperty('craftmatic:coaster_route')).toBe(0);
      expect(car.entity.getDynamicProperty('craftmatic:coaster_origin')).toEqual({ x: 100, y: 64, z: 200 });
      expect(car.at).toEqual(cars[0]!.at);
    }
  });
  it('spawns one actor per measured car and records the train beside the station in the diagnostics', async () => {
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const train: CoasterRoute = { ...straight, label: 'Train track', cars: { count: 3, spacing: 2.25 } };
    const pack = await buildPlayableAddon(grid, { stem: 'Coaster', coasterRoutes: [straight, train] });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const decode = async (name: string) => new TextDecoder().decode(await extractFile(buffer, name));
    const placement = JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(await decode('Craftmatic_coaster_BP/scripts/placement.js'))![1]!);
    const runtime = JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(await decode('Craftmatic_coaster_BP/scripts/coaster.js'))![1]!);
    // Route 0 (no `cars`): the single device-proved cart, one actor, index 0.
    const single = placement.actors.filter((actor: any) => actor.coasterRouteIndex === 0);
    expect(single.map((actor: any) => actor.coasterCarIndex)).toEqual([0]);
    expect(single[0].label).toBe('Measured track Ride Cart');
    expect(runtime.routes[0].cars).toEqual({ count: 1, spacing: 0, extent: 0, heading: 0, trains: 1 });
    // Route 1: three actors, one per car, every one at the station point, indexed 0..2.
    const cars = placement.actors.filter((actor: any) => actor.coasterRouteIndex === 1);
    expect(cars.map((actor: any) => actor.coasterCarIndex)).toEqual([0, 1, 2]);
    expect(cars.map((actor: any) => actor.label)).toEqual(['Train track Car 1', 'Train track Car 2', 'Train track Car 3']);
    const station = runtime.routes[1].station;
    for (const car of cars) expect(car).toMatchObject({ x: station.point[0], y: station.point[1], z: station.point[2] });
    expect(runtime.routes[1].cars).toEqual({ count: 3, spacing: 2.25, extent: 4.5, minChord: 2.25, heading: 0, trains: 1 });
    // The fabricated cart carries its wheelbase and seat into the runtime's types.
    expect(runtime.types['craftmatic:coaster_coaster_cart']).toEqual({ role: 'car', riders: 0, wheelbase: 1.125, seat: [0, 0.35, 0] });
    // Diagnostics: count/spacing/extent/minChord beside the station, per route.
    const diagnostics = JSON.parse(await decode('Craftmatic_coaster_BP/craftmatic-diagnostics.json'));
    expect(diagnostics.coaster.carLength).toBe(COASTER_CAR_LENGTH);
    expect(diagnostics.coaster.routes[0]).toMatchObject({ label: 'Measured track', cars: { count: 1, spacing: 0, extent: 0 }, station: { stop: 5, length: 10 } });
    expect(diagnostics.coaster.routes[1]).toMatchObject({ label: 'Train track', cars: { count: 3, spacing: 2.25, extent: 4.5, minChord: 2.25, overlaps: false }, station: { stop: 5, point: station.point } });
    // A straight never closes coupled cars up, so nothing warns about overlap.
    expect(pack.warnings.some(w => /visibly intersect/.test(w))).toBe(false);
  });
  it('surfaces, and never clamps, a train whose route curvature closes the cars under one car length', async () => {
    // A hairpin: 10 blocks out, a 0.4-block turn, 10 blocks back, sampled every
    // half block on the return leg (minimumCoupledChord measures at authored
    // samples). Two cars a 2.25-block arc apart straddle the turn 0.43 blocks
    // apart in a straight line - the fold shape 10303's stitched route has at
    // its fragment joins. The pack keeps the measured train and says where it
    // will intersect (craftmatic-diagnostics.json + a warning); nothing clamps.
    const points: [number, number, number][] = [[0, 1, 0], [10, 1, 0]];
    for (let x = 10; x >= 0; x -= 0.5) points.push([x, 1, 0.4]);
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, { stem: 'Coaster', coasterRoutes: [{ label: 'Hairpin', points, closed: false, maxSegmentLength: 10, cars: { count: 3, spacing: 2.25 } }] });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const diagnostics = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_coaster_BP/craftmatic-diagnostics.json')));
    const cars = diagnostics.coaster.routes[0].cars;
    expect(cars.count).toBe(3);
    expect(cars.minChord).toBeCloseTo(Math.hypot(0.15, 0.4), 6);
    expect(cars.minChord).toBeLessThan(COASTER_CAR_LENGTH);
    expect(cars.overlaps).toBe(true);
    expect(pack.warnings.find(w => /visibly intersect/.test(w))).toContain(`${Math.round(cars.minChord * 1000) / 1000}-block chord`);
  });
  it('emits rideable non-gravity cart with synced visual pitch and scale groups', () => {
    const assets = coasterCartAssets('craftmatic:ride');
    const entity = (assets.behavior as any)['minecraft:entity'];
    expect(entity.components['minecraft:physics']).toEqual({ has_gravity: false, has_collision: false });
    expect(entity.description.properties['craftmatic:track_pitch'].client_sync).toBe(true);
    expect(entity.component_groups['craftmatic:size_400']).toBeDefined();
  });
  it('gives the cart an interact prompt and a hit box that covers the drawn body', () => {
    const entity = (coasterCartAssets('craftmatic:ride').behavior as any)['minecraft:entity'];
    expect(entity.components['minecraft:rideable'].interact_text).toBe('Ride the coaster');
    // The tub and the seated rider have to be inside the box a player aims at.
    expect(entity.components['minecraft:collision_box']).toEqual({ width: 1.375, height: 0.9 });
  });
  it('scales cart geometry, collision and seat at export before applying wand size', () => {
    const assets = coasterCartAssets('craftmatic:ride', 4);
    const entity = (assets.behavior as any)['minecraft:entity'];
    expect(entity.components['minecraft:collision_box'].width).toBe(5.5);
    expect(entity.components['minecraft:rideable'].seats.position).toEqual([0, 1.4, 0]);
    const body = assets.geometry['minecraft:geometry'][0]!.bones.find(bone => bone.name === 'cart')!;
    expect(body.cubes[0]!.size).toEqual([88, 8, 80]);
    expect(entity.component_groups['craftmatic:size_400']['minecraft:collision_box'].width).toBe(22);
    const wheels = body.cubes.slice(5);
    expect(wheels).toHaveLength(4);
    expect(wheels[0]!.origin[1]).toBe(-26.4);
  });
  it('writes float actor properties as float literals so Bedrock loads the property component', async () => {
    // Bedrock types actor-property JSON numbers by their LITERAL form. A float
    // property serialized as `"default": 0` is rejected with "'default' value does
    // not match the specified type 'float'", which drops the WHOLE property
    // component: client Molang `query.property` then errors every frame and the
    // server's `setProperty` throws, stalling the ride. Measured on a Pixel 8 Pro
    // (Bedrock 1.26.51) 2026-09-21 in the device content log.
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, { stem: 'Coaster', coasterRoutes: [straight] });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const entityJson = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_coaster_BP/entities/coaster_coaster_cart.json'));
    const properties = /"properties": \{[\s\S]*?\n {6}\}/.exec(entityJson)![0]!;
    expect(properties).not.toMatch(/"default": -?\d+(?!\.)/);
    expect(properties).toContain('"default": 0.0');
    expect(properties).toMatch(/"range": \[\s*-180\.0,\s*180\.0\s*\]/);
    // Still valid JSON carrying the same numeric meaning. Pitch runs the full
    // turn: a car in a loop rotates past vertical on its rails rather than
    // flipping its yaw, which is what a +/-90 range used to force.
    const parsed = JSON.parse(entityJson)['minecraft:entity'].description.properties;
    expect(parsed['craftmatic:track_pitch']).toEqual({ type: 'float', range: [-180, 180], default: 0, client_sync: true });
    expect(parsed['craftmatic:track_roll']).toEqual({ type: 'float', range: [-180, 180], default: 0, client_sync: true });
  });
  it('keeps every float property in every emitted entity out of integer literals', async () => {
    // Safety net for entities added later: one integer literal anywhere in a
    // float property drops the whole property component for that entity.
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, { stem: 'Coaster', coasterRoutes: [straight] });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const names = listZipEntries(buffer).filter(name => /_BP\/entities\/.+\.json$/.test(name));
    expect(names.length).toBeGreaterThan(0);
    let floatProperties = 0;
    for (const name of names) {
      const source = new TextDecoder().decode(await extractFile(buffer, name));
      const properties = JSON.parse(source)['minecraft:entity']?.description?.properties as
        Record<string, { type?: string }> | undefined;
      for (const [id, property] of Object.entries(properties ?? {})) {
        if (property?.type !== 'float') continue;
        floatProperties++;
        const block = new RegExp(`"${id}": \\{[\\s\\S]*?\\n {8}\\}`).exec(source)![0]!;
        expect.soft(block, `${name} ${id}`).not.toMatch(/: -?\d+(?![.\d])/);
        expect.soft(block, `${name} ${id}`).not.toMatch(/\n\s+-?\d+(?![.\d])/);
      }
    }
    // Pitch, roll and the three body offsets.
    expect(floatProperties).toBe(5);
  });
  it('never emits an entity identifier that Bedrock rejects for a numeric set stem', async () => {
    // Bedrock refuses an identifier whose name begins with a digit ("identifier
    // cannot begin with a number") and the entity then does not exist at all.
    // Most LEGO stems are numeric: 10303's ride cart and manual seat were
    // rejected on the device 2026-09-21 while its 13 prefixed entities loaded.
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, {
      stem: '10303', label: '10303-Loop-Coaster', coasterRoutes: [straight],
      shell: { bricks: [], origin: [0, 0, 0] } as never,
      seats: [{ label: 'Bench', x: 1, y: 1, z: 1, yaw: 0 }] as never,
      screens: [{ label: 'Screen', x: 2, y: 1, z: 1 }] as never,
    });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const names = listZipEntries(buffer).filter(name => /_BP\/entities\/.+\.json$/.test(name));
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      const identifier = JSON.parse(new TextDecoder().decode(await extractFile(buffer, name)))['minecraft:entity'].description.identifier as string;
      expect.soft(identifier, name).toMatch(/^craftmatic:[a-z][a-z0-9_]*$/);
    }
  });
  it('packages the runtime and source-frame route only for coaster-enabled exports', async () => {
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, { stem: 'Coaster', coasterRoutes: [straight] });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const decode = async (name: string) => new TextDecoder().decode(await extractFile(buffer, name));
    expect(await decode('Craftmatic_coaster_BP/scripts/main.js')).toContain("import './coaster.js'");
    const coaster = await decode('Craftmatic_coaster_BP/scripts/coaster.js');
    expect(coaster).toContain('Measured track');
    // The station travels with the route so the runtime never derives it in game.
    expect(JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(coaster)![1]!).routes[0].station.stop).toBeCloseTo(5);
    const placement = await decode('Craftmatic_coaster_BP/scripts/placement.js');
    const config = JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(placement)![1]!);
    // The cart spawns on the station platform, where the runtime parks it and
    // where a player can walk up to it — not at arc 0, wherever that lands.
    const station = JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(coaster)![1]!).routes[0].station;
    expect(config.actors.find((actor: any) => actor.coasterRouteIndex === 0))
      .toMatchObject({ x: station.point[0], y: station.point[1], z: station.point[2] });
    expect(station.point[0]).toBeCloseTo(5);
  });
});

// ─── The set's own cars ──────────────────────────────────────────────────────

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** A brick in a synthetic car; `rot` defaults to the identity. */
const brick = (part: string, x: number, y: number, z: number, rot: number[] = IDENTITY, color = 16): ParsedBrick => ({ color, x, y, z, rot, part });
/** A detected car: chassis at `originLdu` in frame `rot` (local→world), member indices into the caller's bricks. */
function detectedCar(id: string, originLdu: Vec3, rot: number[], indices: number[], seat?: { localLdu: Vec3; riderBricks: number[] }, route?: { arcLdu: number; heading: 1 | -1 }): CoasterCar {
  const col = (k: number): Vec3 => [rot[k]!, rot[3 + k]!, rot[6 + k]!];
  const up = col(1).map(v => -v) as Vec3;
  return {
    id, chassis: { index: indices[0]!, part: '26021.dat', description: 'Train Base  4 x  5 Roller Coaster' }, bricks: indices, wheels: [],
    frame: { originLdu, rot, travelWorld: col(0), upWorld: up },
    extentLocalLdu: { min: [-70, -41, -40], max: [71, 46, 40] }, lengthLdu: 141, widthLdu: 80, heightLdu: 87,
    seats: seat ? [{ localLdu: seat.localLdu, worldLdu: [0, 0, 0], source: 'rider', riderBricks: seat.riderBricks }] : [],
    ...(route ? { route: { routeIndex: 0, routeLabel: 'Track 1', arcLdu: route.arcLdu, offsetLdu: 14, originAboveDatumLdu: 14, heading: route.heading } } : {}),
  };
}
/** Row-major product a·b. */
const mul = (a: number[], b: number[]): number[] => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
};
const apply = (m: number[], v: Vec3): Vec3 => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** 90° about Y: local +X → world -Z. */
const YAW90 = [0, 0, 1, 0, 1, 0, -1, 0, 0];
/** The same frame mirrored in local Z (a Studio reflection): det -1. */
const YAW90_MIRROR = mul(YAW90, [1, 0, 0, 0, 1, 0, 0, 0, -1]);
const round3 = (v: number): number => Math.round(v * 1000) / 1000 || 0;

describe("the set's own cars: canonical frame", () => {
  /** A car whose chassis sits at `origin` in frame `rot`, with a wheel 25 LDU ahead and 17.4 under the origin, and a rider hips 18 LDU behind, 1 up. */
  function placed(origin: Vec3, rot: number[]) {
    const wheelLocal: Vec3 = [25, 17.4, 0], hipsLocal: Vec3 = [-18, -1, 0];
    const wheel = add(origin, apply(rot, wheelLocal)), hips = add(origin, apply(rot, hipsLocal));
    const bricks = [
      brick('26021.dat', origin[0], origin[1], origin[2], rot, 322),
      brick('24869.dat', wheel[0], wheel[1], wheel[2], mul(rot, [0, 0, 1, 0, 1, 0, -1, 0, 0]), 72),
      brick('3816.dat', hips[0], hips[1], hips[2], rot, 0),
    ];
    return { bricks, car: detectedCar('car:0', origin, rot, [0, 1], { localLdu: hipsLocal, riderBricks: [2] }) };
  }
  it('puts the chassis 14 LDU above the datum, travel along +X, and carries the rider with it', () => {
    const { bricks, car } = placed([100, -46, 50], YAW90);
    const canonical = canonicalCoasterCar(car, bricks, 14);
    expect(canonical.bricks).toHaveLength(2);
    const [chassis, wheel] = canonical.bricks;
    expect([chassis!.x, chassis!.y, chassis!.z].map(round3)).toEqual([0, -14, 0]);
    expect(chassis!.rot!.map(round3)).toEqual(IDENTITY);
    // The wheel keeps its place under the chassis: 25 ahead, 3.4 below the datum line (LDraw +Y is down).
    expect([wheel!.x, wheel!.y, wheel!.z].map(round3)).toEqual([25, 3.4, 0]);
    expect(canonical.rider).toHaveLength(1);
    expect([canonical.rider[0]!.x, canonical.rider[0]!.y, canonical.rider[0]!.z].map(round3)).toEqual([-18, -15, 0]);
    expect(canonical.seatLdu!.map(round3)).toEqual([-18, -15, 0]);
  });
  it('makes a mirrored source frame proper by flipping local Z, so the car is never compiled as its mirror image', () => {
    const { bricks, car } = placed([100, -46, 50], YAW90_MIRROR);
    const canonical = canonicalCoasterCar(car, bricks, 14);
    const chassis = canonical.bricks[0]!;
    // The chassis brick's own placement is mirrored (det -1); expressed in the
    // PROPER local frame it is that mirror, not the identity.
    expect(chassis.rot!.map(round3)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, -1]);
    const wheel = canonical.bricks[1]!;
    expect([wheel.x, wheel.y, wheel.z].map(round3)).toEqual([25, 3.4, 0]);
    // A seat off the centreline would flip with the frame; on it, nothing changes.
    expect(canonical.seatLdu!.map(round3)).toEqual([-18, -15, 0]);
  });
});

/** A route car for the config tests: canonical bricks are placeholders (never compiled here). */
function routeCar(datumPoint: Vec3, heading: 1 | -1, body = 'a', rider = 'r1'): CoasterRouteCar {
  return {
    chassis: '26021.dat', sourceIndices: [], datumPoint, heading,
    bricks: [brick('26021.dat', 0, -14, 0, IDENTITY, body === 'a' ? 322 : 4), brick('3023.dat', 40, -22, 0, IDENTITY, 15)],
    rider: rider ? [brick('973.dat', -18, -59, 0, IDENTITY, rider === 'r1' ? 15 : 4)] : [],
    seatLdu: [-18, -15, 0],
  };
}

describe("the set's own cars: type plan", () => {
  const points: Vec3[] = Array.from({ length: 41 }, (_, k) => [k * 0.5, 1, 0]);
  const route = (vehicles: CoasterRouteCar[]): CoasterRoute => ({ label: 'T', points, closed: false, maxSegmentLength: 0.5, vehicles });
  it('groups cars by body, numbers rider variants, and orders slots from the highest arc down', () => {
    const plan = planCoasterVehicles('craftmatic:x_coaster_cart', [route([
      routeCar([4, 1, 0], -1, 'a', 'r1'), routeCar([6, 1, 0], -1, 'a', 'r2'), routeCar([8, 1, 0], -1, 'b', 'r1'), routeCar([10, 1, 0], -1, 'a', ''),
    ])]);
    expect(plan.types.map(t => t.typeId)).toEqual(['craftmatic:x_coaster_vehicle_1', 'craftmatic:x_coaster_vehicle_2']);
    expect(plan.types[0]!.riders).toHaveLength(2);
    expect(plan.types[0]!.cars).toBe(3);
    expect(plan.types[1]!.riders).toHaveLength(1);
    const planned = plan.routes[0]!;
    expect(planned.datumArcs).toEqual([10, 8, 6, 4]);
    expect(planned.spacing).toBe(2);
    expect(planned.heading).toBe(-1);
    expect(planned.headingsAgree).toBe(true);
    // Slot 0 (arc 10) is the unridden body-a car: its rider value is the "none"
    // variant, one past the last. Variants are numbered per type in slot order,
    // so body a's first rider seen (arc 6, r2) is its variant 0.
    expect(planned.slots.map(s => `${s.type.replace(/^.*_vehicle_/, 'v')}/${s.rider}`)).toEqual(['v1/2', 'v2/0', 'v1/0', 'v1/1']);
    expect(planned.slots.map(s => s.label)).toEqual(['T Car 1', 'T Car 2', 'T Car 3', 'T Car 4']);
  });
  it('carries at most the runtime maximum and takes the majority heading', () => {
    const cars = Array.from({ length: COASTER_MAX_CARS + 2 }, (_, k) => routeCar([1 + k * 2, 1, 0], k < 3 ? 1 : -1));
    const planned = planCoasterVehicles('craftmatic:x_coaster_cart', [route(cars)]).routes[0]!;
    expect(planned.slots).toHaveLength(COASTER_MAX_CARS);
    expect(planned.heading).toBe(-1);
    expect(planned.headingsAgree).toBe(false);
  });
});

// ─── Lift-extended route config ──────────────────────────────────────────────

/** A level 20-block open route along +X with a 5-block deck parked at its start; the deck's far end lands on the route's end after a 25-block travel. */
function liftRoute(options: { parkedEnd?: 'start' | 'end'; slip?: number; counterweight?: boolean; heading?: 1 | -1 } = {}): CoasterRoute {
  const points: Vec3[] = Array.from({ length: 41 }, (_, k) => [k * 0.5, 1, 0]);
  const parkedEnd = options.parkedEnd ?? 'start';
  return {
    label: 'Tower', points: parkedEnd === 'start' ? points : [...points].reverse(), closed: false, maxSegmentLength: 0.5,
    vehicles: [routeCar([10, 1, 0], options.heading ?? -1), routeCar([12, 1, 0], options.heading ?? -1)],
    lift: {
      kind: 'platform', bricks: [brick('3010.dat', 0, 0, 0)], originLdu: [0, 0, 0], parkedPoint: [-2.5, 0, 0], travel: [25, 0, 0],
      deck: [[-5, 1, 0], [0 + (options.slip ?? 0), 1, 0]], parkedEnd,
      ...(options.counterweight ? { counterweight: { bricks: [brick('3001.dat', 0, 0, 0)], originLdu: [0, 0, 0], point: [-2.5, 5, 0], sourceIndices: [] } } : {}),
      measured: { travelLdu: 1333, axisDistanceLdu: 1300, betweenTerminalsLdu: 1320, parkedMisfitLdu: 10, deliveredMisfitLdu: 5, deckLengthLdu: 266.7, tiltDeg: 0, members: 1 },
    },
  };
}

describe('lift-extended route config', () => {
  it('appends the parked deck before arc 0 and the delivered deck after the end, shifting the station', () => {
    const config = coasterRuntimeConfig('craftmatic:x_coaster_cart', [liftRoute()]);
    const [route] = config.routes;
    expect(route!.path.length).toBeCloseTo(30, 6);
    expect(route!.path.closed).toBe(false);
    expect(route!.path.points[0]).toEqual([-5, 1, 0]);
    expect(route!.path.points.at(-1)).toEqual([25, 1, 0]);
    expect(route!.lift).toMatchObject({ type: 'craftmatic:x_coaster_lift_1', deckLength: 5, travel: [25, 0, 0], parkedPoint: [-2.5, 0, 0] });
    expect(route!.lift!.counterweightType).toBeUndefined();
    // The station was measured on the ROUTE (its whole 20 blocks are level) and moved by the deck's length.
    expect(route!.station.stop).toBeCloseTo(15, 6);
    expect(route!.station.start).toBeCloseTo(5, 6);
    expect(route!.station.point).toEqual([10, 1, 0]);
    expect(route!.direction).toBe(-1);
    expect(route!.cars).toMatchObject({ count: 2, spacing: 2, extent: 2, heading: -1 });
    expect(route!.cars.slots!.map(s => s.type)).toEqual(['craftmatic:x_coaster_vehicle_1', 'craftmatic:x_coaster_vehicle_1']);
    expect(config.types['craftmatic:x_coaster_lift_1']).toEqual({ role: 'platform', riders: 0 });
    expect(config.types['craftmatic:x_coaster_vehicle_1']).toEqual({ role: 'car', riders: 1 });
    // The fabricated cart's type stays declared (harmless) but no route uses it.
    expect(config.types['craftmatic:x_coaster_cart']).toEqual({ role: 'car', riders: 0 });
    expect(config.routes.every(r => r.cars.slots)).toBe(true);
  });
  it('names the counterweight when the set has one', () => {
    const config = coasterRuntimeConfig('craftmatic:x_coaster_cart', [liftRoute({ counterweight: true })]);
    expect(config.routes[0]!.lift).toMatchObject({ counterweightType: 'craftmatic:x_coaster_counterweight_1', counterweightPoint: [-2.5, 5, 0] });
    expect(config.types['craftmatic:x_coaster_counterweight_1']).toEqual({ role: 'counterweight', riders: 0 });
  });
  it('reverses a route whose deck docks at the far end, so every lift route reads the same way', () => {
    const reversed = coasterRuntimeConfig('craftmatic:x_coaster_cart', [liftRoute({ parkedEnd: 'end', heading: 1 })]).routes[0]!;
    const forward = coasterRuntimeConfig('craftmatic:x_coaster_cart', [liftRoute({ heading: -1 })]).routes[0]!;
    expect(reversed.path.points).toEqual(forward.path.points);
    expect(reversed.direction).toBe(-1);
    expect(reversed.cars.heading).toBe(-1);
    expect(reversed.station.stop).toBeCloseTo(forward.station.stop, 6);
  });
  it('refuses a deck that was not snapped onto its terminal, and a platform on a closed route', () => {
    expect(() => coasterRuntimeConfig('craftmatic:x_coaster_cart', [liftRoute({ slip: 0.4 })])).toThrow(/snapped onto the terminal/);
    const closed = liftRoute();
    expect(() => coasterRuntimeConfig('craftmatic:x_coaster_cart', [{ ...closed, closed: true, points: [...closed.points, closed.points[0]!] }])).toThrow(/open route/);
  });
  it('runs a closed circuit the way its chain climbs and confines the chain assist to its measured span', () => {
    const loop = loopRoute();
    const config = coasterRuntimeConfig('craftmatic:x_coaster_cart', [{ ...loop, vehicles: [routeCar([0, 0, 0], -1)], lift: { kind: 'chain', arcStart: 5, arcEnd: 20, climbDirection: 1, sprockets: 2 } }]);
    expect(config.routes[0]!.direction).toBe(1);
    expect(config.routes[0]!.cars.heading).toBe(-1);
    expect(config.routes[0]!.chain).toEqual({ start: 5, end: 20 });
    // Without a lift a circuit runs the way its cars face.
    expect(coasterRuntimeConfig('craftmatic:x_coaster_cart', [{ ...loop, vehicles: [routeCar([0, 0, 0], -1)] }]).routes[0]!.direction).toBe(-1);
  });
});

// ─── Lift runtime ────────────────────────────────────────────────────────────

/** A host whose entities are spawned from the config's own roles: cars per slot, the platform and the counterweight. */
function liftHost(route: CoasterRoute, camera?: Partial<CoasterRiderViewConfig>) {
  const bare = coasterRuntimeConfig('craftmatic:test_cart', [route]);
  const config = camera ? { ...bare, camera: { ...bare.camera!, ...camera } } : bare;
  const runtimeRoute = config.routes[0]!;
  let loaded = true;
  const removed = new Set<string>();
  let refuse: ((typeId: string) => boolean) | undefined;
  const make = (id: string, typeId: string, index?: number) => {
    const properties = new Map<string, unknown>([
      ['craftmatic:coaster_origin', { x: 100, y: 64, z: 200 }], ['craftmatic:coaster_rotation', 0], ['craftmatic:coaster_scale', 1], ['craftmatic:coaster_route', 0],
      ...(index !== undefined ? [['craftmatic:coaster_car', index] as [string, unknown]] : []),
    ]);
    const actorProperties = new Map<string, unknown>();
    const riders: any[] = [];
    const positions: Array<{ x: number; y: number; z: number }> = [];
    /** The rotation Bedrock remembers from the last teleport. */
    const rotation = { x: 0, y: 0 };
    const entity: any = {
      id, typeId, getDynamicProperty: (key: string) => properties.get(key), setDynamicProperty: (key: string, value: unknown) => properties.set(key, value),
      setProperty: (key: string, value: unknown) => actorProperties.set(key, value), getRotation: () => ({ ...rotation }), isValid: () => !removed.has(id),
      getComponent: (name: string) => name === 'minecraft:rideable' ? { getRiders: () => [...riders], ejectRiders: () => { riders.length = 0; } } : undefined,
      tryTeleport: vi.fn((position: any, options?: any) => { if (refuse?.(typeId)) return false; positions.push({ ...position }); if (options?.rotation) Object.assign(rotation, options.rotation); return true; }),
      dimension: { getBlock: () => loaded ? {} : undefined },
    };
    return { id, typeId, entity, properties, actorProperties, riders, positions };
  };
  const cars = runtimeRoute.cars.slots!.map((slot, k) => make(`car${k}`, slot.type, k));
  const platform = runtimeRoute.lift ? make('platform', runtimeRoute.lift.type) : undefined;
  const weight = runtimeRoute.lift?.counterweightType ? make('weight', runtimeRoute.lift.counterweightType) : undefined;
  const all = [...cars, ...(platform ? [platform] : []), ...(weight ? [weight] : [])];
  const world = { getDimension: (name: string) => ({ getEntities: () => name === 'overworld' ? all.filter(m => !removed.has(m.id)).map(m => m.entity) : [] }) };
  let tick = () => {};
  const system = { runInterval: (callback: () => void) => { tick = callback; } };
  new Function('world', 'system', coasterScript(config).replace(/^import .*;\n/, ''))(world, system);
  const lead = cars[0]!;
  return {
    config, route: runtimeRoute, cars, platform, weight, lead,
    run: (n: number) => { for (let i = 0; i < n; i++) tick(); },
    /** Run until `predicate` holds, or `limit` ticks pass; returns the ticks run. */
    runUntil: (predicate: () => boolean, limit = 5000) => { let n = 0; while (!predicate() && n < limit) { tick(); n++; } return n; },
    phase: () => String(lead.properties.get('craftmatic:coaster_phase') ?? 'track'),
    progress: () => Number(lead.properties.get('craftmatic:coaster_lift') ?? 0),
    distance: () => Number(lead.properties.get('craftmatic:coaster_distance')),
    speed: () => Number(lead.properties.get('craftmatic:coaster_speed')),
    setLoaded: (value: boolean) => { loaded = value; },
    setRefuse: (fn?: (typeId: string) => boolean) => { refuse = fn; },
    remove: (id: string) => { removed.add(id); },
  };
}

describe('the lift completes the circuit', () => {
  it('rolls onto the parked deck, is carried its measured travel, and leaves from the delivered deck', () => {
    const h = liftHost(liftRoute({ counterweight: true }));
    h.run(1);
    // Placed: parked at the station, the platform placed once at its parked pose, the counterweight at rest.
    expect(h.phase()).toBe('track');
    expect(h.distance()).toBeCloseTo(15, 6);
    expect(h.platform!.positions).toHaveLength(1);
    expect(h.platform!.positions[0]).toEqual({ x: 97.5, y: 64, z: 200 });
    expect(h.weight!.positions[0]).toEqual({ x: 97.5, y: 69, z: 200 });
    // Departs after the empty dwell and brakes to a stop centred on the deck (arc 2.5), then lifts.
    const toDeck = h.runUntil(() => h.phase() === 'lifting');
    expect(toDeck).toBeGreaterThan(100);
    expect(h.distance()).toBeCloseTo(2.5, 6);
    expect(h.speed()).toBe(0);
    // The runtime path starts at the deck's far end (x -5); slot 0 sits half the extent ahead of the centre.
    const carAtDeck = h.lead.positions.at(-1)!;
    expect(carAtDeck.x).toBeCloseTo(100 - 5 + 2.5 + 1, 6);
    // The hoist: cars and platform move together along the travel, the counterweight opposite.
    h.runUntil(() => h.progress() > 0.5);
    const mid = h.progress();
    expect(h.phase()).toBe('lifting');
    expect(h.lead.positions.at(-1)!.x).toBeCloseTo(carAtDeck.x + 25 * mid, 6);
    expect(h.platform!.positions.at(-1)!.x).toBeCloseTo(97.5 + 25 * mid, 6);
    expect(h.weight!.positions.at(-1)!.x).toBeCloseTo(97.5 - 25 * mid, 6);
    expect(h.cars[1]!.positions.at(-1)!.x).toBeCloseTo(h.lead.positions.at(-1)!.x - 2, 6);
    // Delivered: the arc is re-based onto the far deck and the platform sits at its delivered pose.
    h.runUntil(() => h.phase() === 'delivered');
    expect(h.progress()).toBe(1);
    expect(h.distance()).toBeCloseTo(2.5 + 30 - 5, 6);
    expect(h.platform!.positions.at(-1)).toEqual({ x: 122.5, y: 64, z: 200 });
    expect(h.lead.positions.at(-1)!.x).toBeCloseTo(100 - 5 + 27.5 + 1, 6);
    // Departs down the course; the platform goes back only once the train has cleared the deck.
    h.runUntil(() => h.phase() === 'track');
    expect(h.progress()).toBe(1);
    h.runUntil(() => h.progress() < 1);
    expect(h.distance() + 1).toBeLessThan(30 - 5 - 1);
    h.runUntil(() => h.progress() === 0);
    expect(h.platform!.positions.at(-1)).toEqual({ x: 97.5, y: 64, z: 200 });
    expect(h.weight!.positions.at(-1)).toEqual({ x: 97.5, y: 69, z: 200 });
    // …stops at the station on the way, and does the whole thing again.
    h.runUntil(() => h.speed() === 0 && Math.abs(h.distance() - 15) < 1e-6);
    expect(h.phase()).toBe('track');
    h.runUntil(() => h.phase() === 'lifting');
    expect(h.distance()).toBeCloseTo(2.5, 6);
    // Every car frame stayed within the runtime path plus the travel.
    for (const car of h.cars) for (const p of car.positions) { expect(p.x).toBeGreaterThanOrEqual(95 - 1e-6); expect(p.x).toBeLessThanOrEqual(125 + 1e-6); expect(p.y).toBe(65); }
  });
  it('holds the train when the platform refuses to move, and never advances the hoist without it', () => {
    const h = liftHost(liftRoute());
    h.runUntil(() => h.phase() === 'lifting');
    h.runUntil(() => h.progress() > 0.2);
    const before = { progress: h.progress(), car: { ...h.lead.positions.at(-1)! }, platform: h.platform!.positions.length };
    h.setRefuse(typeId => typeId === h.platform!.typeId);
    h.run(40);
    // The hoist never advanced: the saved progress is unchanged, the platform
    // itself never moved, and the cars are re-placed from that same saved state
    // every tick - at most one hoist step (PLATFORM_SPEED / 20 blocks) ahead of
    // where they were, exactly as a train car ahead of a refused car already behaves.
    expect(h.progress()).toBe(before.progress);
    expect(Math.abs(h.lead.positions.at(-1)!.x - before.car.x)).toBeLessThanOrEqual(COASTER_PHYSICS.PLATFORM_SPEED / 20 + 1e-9);
    expect(h.lead.positions.at(-1)).toEqual(h.lead.positions.at(-2));
    expect(h.platform!.positions).toHaveLength(before.platform);
    h.setRefuse(undefined);
    h.run(1);
    expect(h.progress()).toBeGreaterThan(before.progress);
    // An unloaded chunk under the hoist holds it the same way.
    h.setLoaded(false);
    const held = h.progress();
    h.run(40);
    expect(h.progress()).toBe(held);
    h.setLoaded(true);
    h.run(1);
    expect(h.progress()).toBeGreaterThan(held);
  });
  it('waits at the terminal for a platform that is still returning, then boards it', () => {
    const h = liftHost(liftRoute());
    // As if reloaded with the platform up and the train already back on the course.
    for (const car of h.cars) {
      car.properties.set('craftmatic:coaster_distance', 12);
      car.properties.set('craftmatic:coaster_phase', 'track');
      car.properties.set('craftmatic:coaster_lift', 1);
      car.properties.set('craftmatic:coaster_speed', 3);
    }
    h.run(1);
    expect(h.progress()).toBeLessThan(1);
    const arrived = h.runUntil(() => h.speed() === 0 && h.progress() > 0);
    expect(arrived).toBeLessThan(5000);
    // Stopped at the terminal (deck length + half the train), not on the deck.
    expect(h.distance()).toBeCloseTo(5 + 1, 6);
    expect(h.phase()).toBe('track');
    h.runUntil(() => h.progress() === 0);
    h.runUntil(() => h.phase() === 'lifting');
    expect(h.distance()).toBeCloseTo(2.5, 6);
  });
  it('lifts the cars even when the platform entity is gone', () => {
    const h = liftHost(liftRoute());
    h.remove('platform');
    h.runUntil(() => h.phase() === 'lifting');
    const n = h.runUntil(() => h.phase() === 'delivered');
    expect(n).toBeLessThan(5000);
    expect(h.platform!.positions).toHaveLength(0);
  });
  it('keeps a rider through the whole lift and shows the posed rider only in an empty seat', () => {
    const h = liftHost(liftRoute());
    h.run(1);
    for (const car of h.cars) expect(car.actorProperties.get('craftmatic:rider')).toBe(0);
    expect(h.lead.actorProperties.get('craftmatic:occupied')).toBe(false);
    h.lead.riders.push({ id: 'p', onScreenDisplay: { setActionBar: vi.fn() } });
    h.run(1);
    expect(h.lead.actorProperties.get('craftmatic:occupied')).toBe(true);
    expect(h.cars[1]!.actorProperties.get('craftmatic:occupied')).toBe(false);
    h.runUntil(() => h.phase() === 'delivered');
    expect(h.lead.riders).toHaveLength(1);
    expect(h.lead.riders[0].onScreenDisplay.setActionBar).toHaveBeenCalledWith(expect.stringMatching(/lift rising/));
    h.lead.riders.length = 0;
    h.run(1);
    expect(h.lead.actorProperties.get('craftmatic:occupied')).toBe(false);
  });
  it('confines a measured chain to its sprockets and keeps the cars facing their authored way through a shuttle reversal', () => {
    // A closed loop with the chain on the first quarter of the climb only.
    const loop = loopRoute();
    const chained = liftHost({ ...loop, vehicles: [routeCar([0, 0, 0], 1)], lift: { kind: 'chain', arcStart: 0, arcEnd: 4, climbDirection: 1, sprockets: 2 } });
    chained.run(150);
    const speeds: Array<[number, number]> = [];
    for (let i = 0; i < 3000; i++) { chained.run(1); speeds.push([chained.distance(), chained.speed()]); }
    // Once the departure push has decayed, the chain holds the climb at its own speed…
    const onChain = speeds.filter(([d]) => d > 2 && d < 3.5).map(([, v]) => v);
    const offChain = speeds.filter(([d]) => d > 5 && d < 9).map(([, v]) => v);
    expect(onChain.length).toBeGreaterThan(0);
    expect(offChain.length).toBeGreaterThan(0);
    expect(Math.min(...onChain)).toBeGreaterThanOrEqual(COASTER_PHYSICS.LIFT_SPEED - 1e-6);
    // …and past the sprockets the climb is on momentum alone, down to the floor.
    expect(Math.min(...offChain)).toBeCloseTo(COASTER_PHYSICS.MIN_SPEED, 6);
    // An open shuttle with the set's own cars: yaw is the same before and after the dead end.
    const shuttle = liftHost({ ...towerRoute(), vehicles: [routeCar([3, 1, 0], 1)] });
    shuttle.run(120);
    const yawOf = (call: any[]) => call[1].rotation.y;
    const calls = shuttle.lead.entity.tryTeleport.mock.calls as any[][];
    const first = yawOf(calls[calls.length - 1]!);
    shuttle.runUntil(() => Number(shuttle.lead.properties.get('craftmatic:coaster_direction')) === -1);
    shuttle.run(5);
    expect(yawOf(calls[calls.length - 1]!)).toBeCloseTo(first, 6);
  });
});

// ─── From the detector to routes ─────────────────────────────────────────────

describe('routes from the detector', () => {
  const tri = (a: Vec3, b: Vec3, c: Vec3) => ({ a, b, c, color: 16 });
  function boxMesh(partId: string, description: string, min: Vec3, max: Vec3): LdrawPartMesh {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
    const triangles = [
      tri(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1)), tri(v(x0, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),
      tri(v(x0, y1, z0), v(x1, y1, z1), v(x1, y1, z0)), tri(v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)),
      tri(v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)), tri(v(x0, y0, z0), v(x1, y1, z0), v(x1, y0, z0)),
      tri(v(x0, y0, z1), v(x1, y1, z1), v(x0, y1, z1)), tri(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1)),
      tri(v(x0, y0, z0), v(x0, y1, z1), v(x0, y1, z0)), tri(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)),
      tri(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)), tri(v(x1, y0, z0), v(x1, y1, z1), v(x1, y0, z1)),
    ];
    return { partId, resolvedAs: partId, triangles, studs: [], bounds: { min, max }, unresolvedRefs: [], description };
  }
  const MESHES = new Map<string, LdrawPartMesh | null>([
    ['80562.dat', boxMesh('80562', 'Train Track Roller Coaster  4 x  4', [-40, -18, -34], [40, 8, 34])],
    ['26021c01.dat', boxMesh('26021c01', 'Train Base  4 x  5 Roller Coaster with Dark Bluish Gray Wheels', [-70, 0, -40], [71, 44, 40])],
    ['3023.dat', boxMesh('3023', 'Plate  1 x  2', [-20, 0, -10], [20, 8, 10])],
    ['973.dat', boxMesh('973', 'Minifig Torso', [-19, 0, -10], [19, 32, 10])],
    ['3626c.dat', boxMesh('3626c', 'Minifig Head with Closed Hollow Stud', [-13, 0, -13], [13, 24, 13])],
    ['3815.dat', boxMesh('3815', 'Minifig Hips', [-18, -11, -10], [18, 21, 10])],
    ['3816.dat', boxMesh('3816', 'Minifig Leg Right', [-19.5, -9, -11], [-1.5, 28, 9])],
  ]);
  /** A composite chassis at `x` on a level route whose datum is y -32 (origin 14.3 above it), a plate and, optionally, a seated rider. */
  const carAt = (x: number, withRider = true): ParsedBrick[] => {
    const y = -32 - 14.3;
    const parts = [brick('26021c01.dat', x, y, 0, IDENTITY, 322), brick('3023.dat', x - 40, y - 8, 0, IDENTITY, 15)];
    if (withRider) parts.push(brick('973.dat', x - 18, y - 45, 0, IDENTITY, 15), brick('3626c.dat', x - 18, y - 69, 0, IDENTITY, 14), brick('3815.dat', x - 18, y - 13, 0, IDENTITY, 0), brick('3816.dat', x - 18, y - 1, 0, IDENTITY, 0));
    return parts;
  };
  const straights = (count: number): ParsedBrick[] => Array.from({ length: count }, (_, k) => brick('80562.dat', k * 80, 0, 0));
  const FRAME = { x: 0, y: 0, z: 0, scale: 1, cellXZ: 20, cellY: 20 };
  const run = (bricks: ParsedBrick[]) => {
    const tracks = extractCoasterTrackRoutes(bricks, { isGeometryAvailable: () => true });
    return coasterRoutesFromAssemblies(tracks, detectCoasterAssemblies(bricks, MESHES, tracks), bricks, FRAME);
  };
  it('turns a detected car into a route vehicle in blocks, taking its bricks and rider out of the shell', () => {
    const bricks = [...straights(10), ...carAt(200)];
    const result = run(bricks);
    expect(result.routes).toHaveLength(1);
    const [route] = result.routes;
    expect(route!.vehicles).toHaveLength(1);
    const [car] = route!.vehicles!;
    expect(car!.chassis).toBe('26021c01.dat');
    expect(car!.bricks).toHaveLength(2);
    expect(car!.rider).toHaveLength(4);
    // The datum under the chassis: x 200, y -32 in LDU → blocks at a 20-LDU cell, y up.
    expect(car!.datumPoint.map(round3)).toEqual([10, 1.6, 0]);
    expect(car!.seatLdu!.map(v => Math.round(v * 10) / 10)).toEqual([-18, -15.3, 0]);
    expect(car!.heading).toBe(1);
    expect(route!.lift).toBeUndefined();
    // Chassis, plate and the four figure parts leave the shell; the figure parts are riders.
    expect([...result.movedIndices].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15]);
    expect([...result.riderIndices].sort((a, b) => a - b)).toEqual([12, 13, 14, 15]);
    expect(result.parked).toEqual([]);
    // The route carries the same points the plain pipeline would have used.
    expect(route!.points[0]).toEqual(sceneGridPoint(FRAME, [-40, -32, 0]));
  });
  it('leaves a train on a short open siding parked, with no ride and nothing taken out of the shell', () => {
    const bricks = [...straights(2), ...carAt(-20), ...carAt(106, false)];
    const result = run(bricks);
    expect(result.routes).toEqual([]);
    expect(result.parked).toHaveLength(1);
    expect(result.parked[0]!.cars).toBe(2);
    expect(result.movedIndices.size).toBe(0);
    expect(result.warnings.some(w => new RegExp(`under ${PARKED_SIDING_FACTOR} train lengths`).test(w))).toBe(true);
  });
  it('hands a route with no car through unchanged, for the fabricated cart', () => {
    const result = run(straights(4));
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]!.vehicles).toBeUndefined();
    expect(result.movedIndices.size).toBe(0);
  });
});

// ─── Track up vectors ────────────────────────────────────────────────────────

/** Twist between consecutive ups about the track, degrees per block: the previous up carried onto the next tangent, then the rotation left over. */
function twistRates(path: { points: readonly Vec3[]; cumulative: readonly number[] }, ups: readonly Vec3[]): number[] {
  const unit = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const tangentAt = (i: number): Vec3 => { const a = path.points[Math.max(0, i - 1)]!, b = path.points[Math.min(path.points.length - 1, i + 1)]!; return unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]); };
  const rates: number[] = [];
  for (let i = 1; i < ups.length; i++) {
    const before = tangentAt(i - 1), after = tangentAt(i), axis = cross(before, after), s = Math.hypot(...axis), c = dot(before, after);
    let carried = ups[i - 1]!;
    if (s > 1e-9) {
      const k = [axis[0] / s, axis[1] / s, axis[2] / s] as Vec3, angle = Math.atan2(s, c), cs = Math.cos(angle), sn = Math.sin(angle), kd = dot(k, carried) * (1 - cs), kx = cross(k, carried);
      carried = [carried[0] * cs + kx[0] * sn + k[0] * kd, carried[1] * cs + kx[1] * sn + k[1] * kd, carried[2] * cs + kx[2] * sn + k[2] * kd];
    }
    const along = dot(carried, after);
    carried = unit([carried[0] - along * after[0], carried[1] - along * after[1], carried[2] - along * after[2]]);
    const twist = Math.atan2(dot(cross(carried, ups[i]!), after), dot(carried, ups[i]!)) * 180 / Math.PI;
    rates.push(Math.abs(twist) / (path.cumulative[i]! - path.cumulative[i - 1]!));
  }
  return rates;
}

/**
 * A level run into a HELICAL loop (radius 4, drifting 2 blocks sideways over
 * the turn, like 10303's) and out onto level track: a vertical loop with
 * torsion, which parallel transport leaves banked forever.
 */
function helixRoute(): { route: CoasterRoute; loopStart: number; loopEnd: number } {
  const points: Vec3[] = [];
  const step = 0.25;
  for (let x = 0; x < 12; x += step) points.push([x, 1, 0]);
  const radius = 4, turns = 96;
  for (let k = 0; k <= turns; k++) {
    const a = k / turns * Math.PI * 2;
    points.push([12 + radius * Math.sin(a), 1 + radius * (1 - Math.cos(a)), 2 * k / turns]);
  }
  for (let x = 12 + step; x <= 30; x += step) points.push([x, 1, 2]);
  return { route: { label: 'Helix', points, closed: false, maxSegmentLength: 0.3 }, loopStart: 12, loopEnd: 12 + 2 * Math.PI * Math.hypot(radius, 2 / (2 * Math.PI)) };
}

describe('track up vectors', () => {
  const gravityTwist = (path: { points: readonly Vec3[] }, ups: readonly Vec3[], i: number): number => {
    const a = path.points[Math.max(0, i - 1)]!, b = path.points[Math.min(path.points.length - 1, i + 1)]!;
    const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as Vec3, l = Math.hypot(...t);
    const h = Math.hypot(t[0] / l, t[2] / l);
    const g: Vec3 = [-t[1] / l * t[0] / l / h, h, -t[1] / l * t[2] / l / h];
    const u = ups[i]!;
    return Math.acos(Math.max(-1, Math.min(1, u[0] * g[0] + u[1] * g[1] + u[2] * g[2]))) * 180 / Math.PI;
  };
  it('keeps gravity as the up on level track, on a crest and in a dip', () => {
    const points: Vec3[] = [];
    // Level, a 4-block-radius crest, a 4-block-radius dip, level: never banked.
    for (let x = 0; x <= 40; x += 0.25) points.push([x, 1 + 2 * Math.sin(x / 4) * Math.sin(x / 4), 0]);
    const path = buildCoasterPath(points, false, 0.3);
    const ups = coasterTrackUps(path);
    for (let i = 0; i < ups.length; i++) expect(gravityTwist(path, ups, i)).toBeLessThan(1e-4);
  });
  it('returns to upright after a helical loop where parallel transport stays banked, within the twist-rate bound', () => {
    const { route, loopEnd } = helixRoute();
    const path = buildCoasterPath(route.points, false, route.maxSegmentLength);
    const transported = buildCoasterFrames(path);
    const ups = coasterTrackUps(path);
    const last = ups.length - 1;
    // The transport leaves the level exit banked; the physical up does not.
    expect(gravityTwist(path, transported, last)).toBeGreaterThan(20);
    expect(gravityTwist(path, ups, last)).toBeLessThan(1e-6);
    // Upright again within two blocks of leaving the loop, and inverted at its apex.
    for (let i = 0; i < ups.length; i++) {
      if (path.cumulative[i]! > loopEnd + 2) expect(gravityTwist(path, ups, i)).toBeLessThan(0.5);
      if (path.cumulative[i]! < 12) expect(gravityTwist(path, ups, i)).toBeLessThan(1e-6);
    }
    const apex = ups.reduce((best, up, i) => (path.points[i]![1] > path.points[best]![1] ? i : best), 0);
    expect(ups[apex]![1]).toBeLessThan(-0.9);
    // No correction twists faster than the declared rate.
    for (const rate of twistRates(path, ups)) expect(rate).toBeLessThanOrEqual(TRACK_TWIST_RATE_DEG_PER_BLOCK + 1e-6);
  });
  it('keeps a closed route continuous at its seam', () => {
    const ups = coasterTrackUps(buildCoasterPath(loopRoute().points, true, 2));
    expect(ups.at(-1)).toEqual(ups[0]);
    expect(ups[0]![1]).toBeGreaterThan(0.99);
  });
});

// ─── Wheelbase chord and body offset ─────────────────────────────────────────

describe('car orientation', () => {
  /** A level run with one sample jogged 0.3 blocks up: the fold a stitched route has at a fragment join. */
  const jogged = (): CoasterRoute => {
    const points: Vec3[] = Array.from({ length: 81 }, (_, k) => [k * 0.375, 1, 0]);
    points[40] = [15, 1.3, 0];
    return { label: 'Jog', points, closed: false, maxSegmentLength: 0.5 };
  };
  const pitches = (h: ReturnType<typeof rideHost>, index = 0) => (h.cars[index]!.entity.setProperty.mock.calls as Array<[string, number]>)
    .filter(call => call[0] === 'craftmatic:track_pitch').map(call => call[1]);
  it('pitches a car on the chord between its wheels, so a jogged sample no longer see-saws it', () => {
    const tangent = rideHost(jogged());
    tangent.run(600);
    const chord = rideHost(jogged(), { wheelbase: 2 });
    chord.run(600);
    // On the local tangent the jog pitches the cart by atan(0.3 / 0.375) = 39 degrees; over a 2-block chord by at most atan(0.3 / 2) = 8.5.
    expect(Math.max(...pitches(tangent).map(Math.abs))).toBeGreaterThan(35);
    expect(Math.max(...pitches(chord).map(Math.abs))).toBeLessThan(9);
    // The bricks still trace the track itself: the datum is the centre sample,
    // on the polyline, with or without the chord.
    for (const host of [tangent, chord]) for (const d of host.datums()) {
      const x = d.x - 100;
      const jog = Math.max(0, 0.3 * (1 - Math.abs(x - 15) / 0.375));
      expect(d.y).toBeCloseTo(65 + jog, 6);
      expect(d.z).toBeCloseTo(200, 6);
    }
  });
  it('lets coupled cars differ only by the curvature over one pitch', () => {
    const train: CoasterRoute = { ...jogged(), cars: { count: 3, spacing: 2.25 } };
    const worstGap = (h: ReturnType<typeof rideHost>) => {
      const p = [pitches(h, 0), pitches(h, 1), pitches(h, 2)];
      let worst = 0;
      for (let k = 0; k < p[0]!.length; k++) worst = Math.max(worst, Math.abs(p[0]![k]! - p[1]![k]!), Math.abs(p[1]![k]! - p[2]![k]!));
      return worst;
    };
    const tangent = rideHost(train); tangent.run(700);
    const chord = rideHost(train, { wheelbase: 2 }); chord.run(700);
    // Two chords can straddle the jog with opposite slopes (up to 2 × 8.5).
    expect(worstGap(tangent)).toBeGreaterThan(35);
    expect(worstGap(chord)).toBeLessThan(17);
  });
  it('takes the yaw from the axle, so it is exact on level track and holds still through a helical loop', () => {
    // Level track: yaw is the nose azimuth, no pitch, no roll.
    const level = coasterCarAttitude([1, 0, 0], [0, 1, 0], 0);
    expect(level.yaw).toBeCloseTo(-90, 9); expect(level.pitch).toBeCloseTo(0, 9); expect(level.roll).toBeCloseTo(0, 9);
    // A helix of radius 4 drifting 1.5 blocks sideways per turn: the nose
    // azimuth swings toward the drift as the track steepens, the axle does not.
    const r = 4, drift = 1.5 / (2 * Math.PI);
    let worstAxle = 0, worstNose = 0;
    for (let k = 1; k < 200; k++) {
      const phi = k / 200 * 2 * Math.PI;
      const nose = [drift, r * Math.sin(phi), r * Math.cos(phi)];
      const inward = [0, Math.cos(phi), -Math.sin(phi)];
      const { yaw, pitch, roll } = coasterCarAttitude(nose, inward, 0);
      worstAxle = Math.max(worstAxle, Math.abs(yaw));
      const horizontal = Math.hypot(nose[0]!, nose[2]!);
      if (horizontal / Math.hypot(...nose) > COASTER_PHYSICS.YAW_HOLD_HORIZONTAL) worstNose = Math.max(worstNose, Math.abs(Math.atan2(-nose[0]!, nose[2]!) * 180 / Math.PI) % 180);
      // Pitch and roll reconstruct the car's up; only the helix's own lean is lost.
      const p = pitch * Math.PI / 180, q = roll * Math.PI / 180;
      expect(Math.cos(p) * Math.cos(q)).toBeCloseTo(inward[1]!, 1);
    }
    expect(worstAxle).toBeLessThan(4);
    expect(worstNose).toBeGreaterThan(10);
  });
  it('keeps the yaw still and the speed up through every inversion of a two-loop helical course', () => {
    // Level run, a helix drifting +1.2 blocks, level, a helix drifting -1.6,
    // level. The course starts level so the train leaves slowly: the chain
    // assist carries each climb and the inversion floor carries each top.
    const r = 4, step = 0.2, points: Vec3[] = [];
    let z = 0, x = 0;
    const straightRun = (length: number) => { const n = Math.round(length / step); for (let k = 0; k < n; k++) points.push([x, 0, z + k * step]); z += length; };
    const helix = (drift: number) => {
      const n = Math.ceil(2 * Math.PI * r / step);
      for (let k = 0; k < n; k++) { const phi = k / n * 2 * Math.PI; points.push([x + drift * k / n, r - r * Math.cos(phi), z + r * Math.sin(phi)]); }
      x += drift;
    };
    straightRun(14); helix(1.2); straightRun(6); helix(-1.6); straightRun(14); points.push([x, 0, z]);
    const route: CoasterRoute = { label: 'Two loops', points, closed: false, maxSegmentLength: 0.3 };
    const h = rideHost(route);
    const runtime = h.config.routes[0]!;
    expect(runtime.loopRadius).toBeCloseTo(r, 0);
    const floorTop = COASTER_PHYSICS.INVERSION_MARGIN * Math.sqrt(COASTER_PHYSICS.GRAVITY * r);
    const upYAt = (arc: number) => {
      const path = runtime.path;
      let i = 0; while (i < path.points.length - 2 && path.cumulative[i + 1]! <= arc) i++;
      return runtime.up[i]![1];
    };
    const yaws = h.cars[0]!.yaws, rows: Array<{ yaw: number; upY: number; speed: number }> = [];
    for (let t = 0; t < 1400; t++) {
      h.run(1);
      const arc = Number(h.properties.get('craftmatic:coaster_distance'));
      rows.push({ yaw: yaws.at(-1)!, upY: upYAt(arc), speed: Number(h.properties.get('craftmatic:coaster_speed')) });
    }
    const inversions: number[][] = [];
    rows.forEach((row, k) => { if (row.upY < 0 && (k === 0 || rows[k - 1]!.upY >= 0)) inversions.push([k]); if (row.upY < 0) inversions.at(-1)!.push(k); });
    // Both loops, out and back: the shuttle reverses at the far end.
    expect(inversions.length).toBeGreaterThanOrEqual(3);
    const turn = (a: number, b: number) => Math.abs(((b - a) % 360 + 540) % 360 - 180);
    for (const run of inversions) {
      const from = Math.max(0, run[0]! - 10), to = Math.min(rows.length - 1, run.at(-1)! + 10);
      const reference = rows[from]!.yaw;
      let range = 0, worstStep = 0;
      for (let k = from; k <= to; k++) {
        range = Math.max(range, turn(reference, rows[k]!.yaw));
        if (k > from) worstStep = Math.max(worstStep, turn(rows[k - 1]!.yaw, rows[k]!.yaw));
      }
      // The helix's own lean (atan(drift / circumference), under 4 degrees,
      // taken as a kink where it meets the level run) is all the yaw may do:
      // a reversal is 180, the reported swivel was 49 in one tick.
      expect(range).toBeLessThan(6);
      expect(worstStep).toBeLessThan(5);
      // Over the top (up within 25 degrees of straight down) the train holds
      // the loop with margin: v^2 > g r, from the floor if not from energy.
      for (const k of run) if (rows[k]!.upY < -0.9) expect(rows[k]!.speed).toBeGreaterThan(Math.sqrt(COASTER_PHYSICS.GRAVITY * r * 0.9));
      expect(Math.max(...run.map(k => rows[k]!.speed))).toBeGreaterThan(0.9 * floorTop);
    }
  });
  it('keeps the rider inside a loop: the entity sinks so the eye follows the car, the bricks stay on the rails', () => {
    const route = loopRoute();
    const h = rideHost(route, { seat: [0, 0.35, 0] });
    const total = coasterRuntimeConfig('craftmatic:ride', [route]).routes[0]!.path.length;
    h.properties.set('craftmatic:coaster_distance', total / 2);
    h.run(1);
    // The apex of a 10-radius loop: the datum is the track point (y 64 + 20),
    // one tick past the apex at the inversion floor, about a block of arc on
    // the 64-gon (a 0.06-block drop).
    const datum = h.datums()[0]!;
    expect(datum.y).toBeGreaterThan(83.9);
    expect(datum.y).toBeLessThanOrEqual(84 + 1e-9);
    // Inverted, the seat and the eye (0.35 + 1.25) hang BELOW the rails; the
    // upright seat then puts the entity 1.6 lower still, so the eye lands 1.6
    // under the rails instead of 1.6 above them.
    // A tick past the apex the car has turned ~6 degrees on, so the eye's
    // 1.6 blocks lean that far off vertical: 3.2 x cos 6° below, 0.17 across.
    const entity = h.positions[0]!;
    expect(entity.y).toBeCloseTo(datum.y - 2 * 1.6, 1);
    expect(entity.y).toBeLessThan(datum.y - 3.15);
    expect(Math.hypot(entity.x - datum.x, entity.z - datum.z)).toBeLessThan(0.25);
    expect(cartUpY(h)).toBeLessThan(-0.9);
    // Player rotation stays upright, as before.
    expect(h.entity.teleport.mock.calls[0][1].rotation.x).toBe(0);
  });
});

// ─── Two trains ──────────────────────────────────────────────────────────────

/** A level 60-block closed rectangle with the set's own two-car train; the whole run is level, so its station is the seam's midpoint. */
function circuitRoute(trains = 2): CoasterRoute {
  const points: Vec3[] = [];
  const along = (from: Vec3, to: Vec3, n: number) => { for (let k = 0; k < n; k++) points.push([from[0] + (to[0] - from[0]) * k / n, 1, from[2] + (to[2] - from[2]) * k / n]); };
  along([0, 1, 0], [20, 1, 0], 40); along([20, 1, 0], [20, 1, 10], 20); along([20, 1, 10], [0, 1, 10], 40); along([0, 1, 10], [0, 1, 0], 20);
  points.push([0, 1, 0]);
  return { label: 'Circuit', points, closed: true, maxSegmentLength: 0.5 + 1e-6, trains, vehicles: [routeCar([5, 1, 0], 1), routeCar([3, 1, 0], 1)] };
}

describe('two trains on one route', () => {
  it('plans the second train from the siding\'s cars, or as a copy, and never on a shuttle', () => {
    const own = planCoasterVehicles('craftmatic:x_coaster_cart', [{ ...circuitRoute(), reserve: [routeCar([50, 1, 0], 1, 'b', 'r2'), routeCar([48, 1, 0], 1, 'b', '')] }]).routes[0]!;
    expect(own.trains).toBe(2);
    expect(own.reserveUsed).toBe(true);
    expect(own.slots.map(s => `${s.train}:${s.type.replace(/^.*_vehicle_/, 'v')}/${s.rider}`)).toEqual(['0:v1/0', '0:v1/0', '1:v2/0', '1:v2/1']);
    expect(own.slots.map(s => s.label)).toEqual(['Circuit Car 1', 'Circuit Car 2', 'Circuit Train 2 Car 1', 'Circuit Train 2 Car 2']);
    const copy = planCoasterVehicles('craftmatic:x_coaster_cart', [{ ...circuitRoute(), reserve: [routeCar([50, 1, 0], 1, 'b')] }]);
    expect(copy.routes[0]!.reserveUsed).toBe(false);
    expect(copy.routes[0]!.slots.map(s => s.type)).toEqual(Array(4).fill('craftmatic:x_coaster_vehicle_1'));
    expect(copy.types[0]!.cars).toBe(4);
    expect(copy.warnings.some(w => /1 spare car\(s\) are fewer than the 2-car train/.test(w))).toBe(true);
    const shuttle = planCoasterVehicles('craftmatic:x_coaster_cart', [{ ...towerRoute(), trains: 2, vehicles: [routeCar([3, 1, 0], 1)] }]);
    expect(shuttle.routes[0]!.trains).toBe(1);
    expect(shuttle.warnings.some(w => /open shuttle runs one train/.test(w))).toBe(true);
  });
  it('waits in the loading bay, holds behind an occupied platform, and leaves once the other train is half a lap ahead', () => {
    const h = liftHost(circuitRoute());
    const route = h.route, stop = route.station.stop, lap = route.dispatch!.lap, hold = route.dispatch!.hold;
    expect(route.cars.trains).toBe(2);
    expect(h.cars).toHaveLength(4);
    expect(hold).toBeCloseTo(((stop - (2 + 2 + 0.5)) % lap + lap) % lap, 6);
    const second = h.cars[2]!;
    const arcOf = (car: typeof second) => Number(car.properties.get('craftmatic:coaster_distance'));
    const speedOf = (car: typeof second) => Number(car.properties.get('craftmatic:coaster_speed'));
    h.run(1);
    expect(arcOf(h.lead)).toBeCloseTo(stop, 6);
    expect(arcOf(second)).toBeCloseTo(hold, 6);
    // The first train dwells and leaves; the second stays in the bay until the platform is clear by a train length.
    h.runUntil(() => speedOf(h.lead) > 0);
    expect(arcOf(second)).toBeCloseTo(hold, 6);
    const left = h.runUntil(() => speedOf(second) > 0);
    expect(left).toBeGreaterThan(20);
    const ahead = ((arcOf(h.lead) - stop) % lap + lap) % lap;
    expect(ahead).toBeGreaterThanOrEqual(2 + 2 + 1 - 1e-6);
    // It brakes into the platform and then waits there until the first train is half a lap ahead.
    h.runUntil(() => speedOf(second) === 0 && Math.abs(arcOf(second) - stop) < 1e-6);
    h.runUntil(() => speedOf(second) > 0, 6000);
    const halfway = ((arcOf(h.lead) - arcOf(second)) % lap + lap) % lap;
    expect(halfway).toBeGreaterThanOrEqual(lap / 2 - 0.2);
    expect(halfway).toBeLessThan(lap / 2 + 1);
    // Over several laps the trains alternate, never both on the platform, never closer than the gap.
    let closest = Infinity, bothParked = 0;
    for (let t = 0; t < 6000; t++) {
      h.run(1);
      const a = arcOf(h.lead), b = arcOf(second);
      let apart = Math.abs(a - b); apart = Math.min(apart, lap - apart);
      closest = Math.min(closest, apart);
      if (Math.abs(a - stop) < 1e-6 && Math.abs(b - stop) < 1e-6) bothParked++;
    }
    expect(bothParked).toBe(0);
    expect(closest).toBeGreaterThanOrEqual(2 + 2 + 0.5 - 1e-6);
    for (const car of h.cars) expect(car.positions.length).toBeGreaterThan(6000);
  });
  it('shares one lift between two trains: the second waits at the terminal until the platform is back', () => {
    const h = liftHost({ ...liftRoute(), trains: 2 });
    expect(h.route.cars.trains).toBe(2);
    expect(h.route.dispatch).toMatchObject({ lap: 25, ahead: 12.5, hold: 19.5 });
    const second = h.cars[2]!;
    const phaseOf = (car: typeof second) => String(car.properties.get('craftmatic:coaster_phase') ?? 'track');
    const arcOf = (car: typeof second) => Number(car.properties.get('craftmatic:coaster_distance'));
    h.run(1);
    expect(arcOf(second)).toBeCloseTo(19.5, 6);
    // First train up and away; only then does the second reach the deck, and never while the platform is away.
    h.runUntil(() => phaseOf(h.lead) === 'delivered');
    expect(phaseOf(second)).toBe('track');
    let liftingTogether = 0, secondLiftedAt = -1;
    for (let t = 0; t < 5000 && secondLiftedAt < 0; t++) {
      h.run(1);
      if (phaseOf(h.lead) !== 'track' && phaseOf(second) !== 'track') liftingTogether++;
      if (phaseOf(second) === 'lifting') secondLiftedAt = t;
    }
    expect(secondLiftedAt).toBeGreaterThan(0);
    expect(liftingTogether).toBe(0);
    // While the second rises the first is on the course; the platform is up for the second, not the first.
    h.runUntil(() => phaseOf(second) === 'delivered');
    expect(h.progress()).toBe(0);
    expect(Number(second.properties.get('craftmatic:coaster_lift'))).toBe(1);
    expect(h.platform!.positions.at(-1)!.x).toBeCloseTo(122.5, 6);
  });
});

describe('wheelbase from the set', () => {
  const carWith = (wheelXs: number[], chassis = '26021.dat') => {
    const origin: Vec3 = [100, -46, 50];
    const bricks = [brick(chassis, origin[0], origin[1], origin[2], IDENTITY, 322), ...wheelXs.map(x => brick('24869.dat', origin[0] + x, origin[1] + 17.4, origin[2], [0, 0, 1, 0, 1, 0, -1, 0, 0], 72))];
    const car = { ...detectedCar('car:0', origin, IDENTITY, bricks.map((_, k) => k)), wheels: wheelXs.map((_, k) => k + 1), chassis: { index: 0, part: chassis, description: '' } };
    return { car, bricks };
  };
  it('measures separate wheel parts, and falls back to the mould table for a composite chassis', () => {
    const measured = carWith([-30, 30]);
    expect(coasterCarWheelbaseLdu(measured.car, measured.bricks)).toBe(60);
    const single = carWith([25]);
    expect(coasterCarWheelbaseLdu(single.car, single.bricks)).toBe(50);
    const composite = carWith([], '26021c01.dat');
    expect(coasterCarWheelbaseLdu(composite.car, composite.bricks)).toBe(50);
    const unknown = carWith([], '99999.dat');
    expect(coasterCarWheelbaseLdu(unknown.car, unknown.bricks)).toBeUndefined();
  });
});

// ─── Real corpus files (skipped where absent, e.g. CI) ───────────────────────

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const PUBLISHED_10303 = 'C:/git/clego/lego_sets/IOModel2V2/10303.ldr';
const PUBLISHED_10261 = 'C:/git/clego/lego_sets/IOModel2V2/10261.ldr';
const HAVE_CORPUS = existsSync(LDRAW_ROOT) && existsSync(PUBLISHED_10303) && existsSync(PUBLISHED_10261);
/** 10303 and 10261 export at the minifig scale: a 53.33-LDU cell. */
const CORPUS_FRAME = { x: 0, y: 0, z: 0, scale: 1, cellXZ: 53.333333, cellY: 53.333333 };

async function corpusRoutes(file: string) {
  setLDrawRoot(LDRAW_ROOT);
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const provider = createPartGeometryProvider({ document: doc });
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(doc.bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const tracks = extractCoasterTrackRoutes(doc.bricks, { isGeometryAvailable: (_id, b) => (meshes.get(b.part)?.triangles.length ?? 0) > 0 });
  const assemblies = detectCoasterAssemblies(doc.bricks, meshes, tracks);
  return { bricks: doc.bricks, provider, scene: coasterRoutesFromAssemblies(tracks, assemblies, doc.bricks, CORPUS_FRAME) };
}

describe.skipIf(!HAVE_CORPUS)('10303 Loop Coaster: its own three cars, its platform lift and its counterweight', () => {
  it('builds one circuit through the elevator, with the cars compiled from their own bricks', async () => {
    const { scene, provider } = await corpusRoutes(PUBLISHED_10303);
    expect(scene.routes).toHaveLength(1);
    const [route] = scene.routes;
    expect(route!.vehicles).toHaveLength(3);
    expect(route!.vehicles!.every(car => car.chassis === '26021.dat' && car.rider.length > 0 && car.seatLdu)).toBe(true);
    expect(route!.lift?.kind).toBe('platform');
    const lift = route!.lift as Extract<CoasterRoute['lift'], { kind: 'platform' }>;
    expect(lift.bricks).toHaveLength(55);
    expect(lift.counterweight?.bricks).toHaveLength(46);
    expect(lift.measured.travelLdu).toBeCloseTo(1884.9, 0);
    expect(lift.measured.axisDistanceLdu).toBeCloseTo(1854.6, 0);
    expect(lift.measured.betweenTerminalsLdu).toBeCloseTo(1857.8, 0);
    expect(lift.measured.deckLengthLdu).toBeCloseTo(377.5, 0);
    // 3 cars x 15/14/15 bricks + 3 riders + 55 platform + 46 counterweight parts leave the shell.
    expect(scene.movedIndices.size).toBeGreaterThan(44 + 55 + 46);
    expect(scene.riderIndices.size).toBeGreaterThanOrEqual(3 * 4);
    const config = coasterRuntimeConfig('craftmatic:c_10303_coaster_cart', scene.routes);
    const [runtime] = config.routes;
    expect(runtime!.direction).toBe(-1);
    expect(runtime!.cars).toMatchObject({ count: 3, spacing: 2.25, heading: -1 });
    expect(runtime!.cars.slots).toHaveLength(6);
    expect(runtime!.lift!.deckLength).toBeCloseTo(7.08, 1);
    expect(runtime!.lift!.travel[1]).toBeCloseTo(35.34, 1);
    expect(Math.abs(runtime!.lift!.travel[0])).toBeLessThan(0.5);
    expect(runtime!.lift!.counterweightType).toBe('craftmatic:c_10303_coaster_counterweight_1');
    // Route 8,930.5 LDU + the deck twice, at 53.33 LDU per block.
    expect(runtime!.path.length).toBeCloseTo((8930.5 + 2 * 377.5) / 53.333333, 0);
    // The compiled entities: one type per car body, a platform and a counterweight, every car with track bones and its rider bone.
    const assets = await buildCoasterRideAssets(config, scene.routes, { namespace: 'craftmatic', label: '10303', bp: 'BP/', rp: 'RP/', modelScale: 1, unitsPerLdu: BEDROCK_UNITS_PER_LDU, quality: 'balanced', pbr: false, partGeometry: provider });
    expect(assets.cartTypeUsed).toBe(false);
    expect(assets.compiled.map(e => e.role)).toEqual(['car', 'car', 'car', 'platform', 'counterweight']);
    for (const car of assets.compiled.filter(e => e.role === 'car')) {
      expect(car.riders).toBe(1);
      expect(car.riderCuboids).toBeGreaterThan(0);
      const geometry = (car.geo.value as any)['minecraft:geometry'];
      for (const mesh of geometry) {
        const names = mesh.bones.map((b: any) => b.name);
        expect(names.slice(0, 2)).toEqual(['track_pitch', 'track_roll']);
        expect(mesh.bones.filter((b: any) => !b.parent).map((b: any) => b.name)).toEqual(['track_pitch']);
      }
      const rideable = (car.behavior as any)['minecraft:entity'].components['minecraft:rideable'];
      expect(rideable.seats.position[1]).toBeGreaterThanOrEqual(0.3);
      expect(Math.abs(rideable.seats.position[2])).toBeLessThan(0.5);
    }
    // Two trains: six car actors (indices 0..5), the second train a copy of the first's types.
    expect(runtime!.cars.trains).toBe(2);
    expect(runtime!.dispatch).toMatchObject({ ahead: expect.any(Number) });
    // Derived from the route's own station, not a literal: the measured stop
    // moves whenever the track measurement improves.
    expect(runtime!.dispatch!.hold).toBeCloseTo(runtime!.station.stop + 4.5 + 2.25 + 0.5, 1);
    expect(runtime!.dispatch!.lap).toBeCloseTo(runtime!.path.length - runtime!.lift!.deckLength, 2);
    expect(runtime!.cars.slots!.map(s => s.train)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(runtime!.cars.slots!.slice(3).map(s => s.type)).toEqual(runtime!.cars.slots!.slice(0, 3).map(s => s.type));
    expect(runtime!.cars.slots![3]!.label).toBe('Track 1 Train 2 Car 1');
    expect(assets.actors.filter(a => a.coasterCarIndex !== undefined).map(a => a.coasterCarIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(assets.actors.filter(a => a.coasterCarIndex === undefined)).toHaveLength(2);
    expect(assets.warnings.some(w => /55-part lift platform/.test(w))).toBe(true);
    expect(assets.warnings.some(w => /second copy of the set's 3 cars/.test(w))).toBe(true);
    // The 24869 wheels sit at ±25 LDU on the 26021 base: a 50-LDU wheelbase, 0.9375 blocks at this cell.
    expect(route!.vehicles!.every(car => car.wheelbaseLdu === 50)).toBe(true);
    for (const type of assets.compiled.filter(e => e.role === 'car')) expect(assets.types[type.typeId]!.wheelbase).toBeCloseTo(50 / 53.333333, 3);
    // Upright at the top of the lift: the up vector on the delivered deck is gravity's.
    expect(runtime!.up.at(-1)![1]).toBeGreaterThan(0.99);
    // Through the two helical loops the transported frame would leave the cars
    // 61-84 degrees on their side; the physical up is within 21 degrees of
    // gravity's wherever the track is upright. The most is at the steep entry
    // of the second loop (20.2 at arc 76.5), where the up follows the loop's
    // own normal rather than gravity's (`LOOP_STEEP_LEVEL`).
    const path = runtime!.path;
    let worstTwist = 0;
    for (let i = 1; i < path.points.length - 1; i++) {
      const a = path.points[i - 1]!, b = path.points[i + 1]!;
      const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...t);
      const h = Math.hypot(t[0]! / l, t[2]! / l);
      if (h < 0.5) continue;
      const g = [-t[1]! / l * t[0]! / l / h, h, -t[1]! / l * t[2]! / l / h];
      const u = runtime!.up[i]!;
      if (u[1] <= 0) continue;
      const twist = Math.acos(Math.max(-1, Math.min(1, u[0] * g[0]! + u[1] * g[1]! + u[2] * g[2]!))) * 180 / Math.PI;
      worstTwist = Math.max(worstTwist, twist);
    }
    expect(worstTwist).toBeLessThan(21);
  }, 240_000);
  it('turns over through BOTH loops without swivelling, and keeps its speed over every top', async () => {
    // Device report 2026-09-24: "first upside-down swivel fixed but still
    // occurs during second upside-down loop", and the train "creeps to nearly
    // stopped" upside down. The serialized runtime, riderless, over two laps.
    const { scene } = await corpusRoutes(PUBLISHED_10303);
    const h = liftHost(scene.routes[0]!);
    const route = h.route, path = route.path, cars = route.cars;
    const radius = route.loopRadius!;
    expect(radius).toBeGreaterThan(3); expect(radius).toBeLessThan(5);
    const upYAt = (arc: number) => {
      let i = 0; while (i < path.points.length - 2 && path.cumulative[i + 1]! <= arc) i++;
      const ratio = (arc - path.cumulative[i]!) / (path.cumulative[i + 1]! - path.cumulative[i]!);
      return route.up[i]![1] + (route.up[i + 1]![1] - route.up[i]![1]) * ratio;
    };
    const rows: Array<Array<{ arc: number; yaw: number; upY: number; speed: number }>> = [[], [], []];
    for (let t = 0; t < 2600; t++) {
      h.run(1);
      if (h.phase() !== 'track') continue;
      const centre = h.distance(), speed = h.speed();
      for (let slot = 0; slot < 3; slot++) {
        const calls = h.cars[slot]!.entity.tryTeleport.mock.calls as any[][];
        if (!calls.length) continue;
        const arc = centre + cars.extent / 2 - slot * cars.spacing;
        rows[slot]!.push({ arc, yaw: calls.at(-1)![1].rotation.y, upY: upYAt(arc), speed });
      }
    }
    const turn = (a: number, b: number) => Math.abs(((b - a) % 360 + 540) % 360 - 180);
    const loops = new Set<number>();
    let tops = 0;
    for (const log of rows) {
      for (let k = 1; k < log.length; k++) {
        if (!(log[k]!.upY < 0 && log[k - 1]!.upY >= 0)) continue;
        let end = k; while (end < log.length - 1 && log[end + 1]!.upY < 0) end++;
        if (end - k < 3) continue; // the vertical drop grazes up.y 0; a loop spends many ticks inverted
        loops.add(Math.round(log[k]!.arc / 10));
        // The run inverted plus 3 blocks of track either side of it.
        let from = k, to = end;
        while (from > 0 && Math.abs(log[from - 1]!.arc - log[k]!.arc) < 3) from--;
        while (to < log.length - 1 && Math.abs(log[to + 1]!.arc - log[end]!.arc) < 3) to++;
        let range = 0, worstStep = 0;
        for (let j = from; j <= to; j++) {
          range = Math.max(range, turn(log[from]!.yaw, log[j]!.yaw));
          if (j > from) worstStep = Math.max(worstStep, turn(log[j - 1]!.yaw, log[j]!.yaw));
        }
        // Before: 101 degrees and up to 53 in one tick on the second loop.
        // Now the most is the first loop's own helix lean (12 degrees) plus a
        // one-tick 5-degree blip at its apex, where the extracted polyline
        // jogs sideways at a fragment join (track data, not the runtime).
        expect(range).toBeLessThan(20);
        expect(worstStep).toBeLessThan(10);
        for (let j = k; j <= end; j++) {
          if (log[j]!.upY > -0.9) continue;
          tops++;
          // Before: 2.5 blocks/s on the chain over the first loop's top, where
          // sqrt(g r) is the least that holds the car on the rails.
          expect(log[j]!.speed).toBeGreaterThan(1.2 * Math.sqrt(COASTER_PHYSICS.GRAVITY * radius));
        }
      }
    }
    expect(loops.size).toBeGreaterThanOrEqual(2);
    expect(tops).toBeGreaterThan(0);
  }, 240_000);
});

describe.skipIf(!HAVE_CORPUS)("10261 Roller Coaster: its own train under its chain lift, the siding's train as the second", () => {
  it('runs the closed circuit with six cars found, three riding and three dispatched from the siding', async () => {
    const { scene } = await corpusRoutes(PUBLISHED_10261);
    expect(scene.routes).toHaveLength(1);
    expect(scene.parked).toEqual([expect.objectContaining({ label: 'Track 2', cars: 3, dispatchedTo: 'Track 1' })]);
    const [route] = scene.routes;
    expect(route!.closed).toBe(true);
    expect(route!.vehicles).toHaveLength(3);
    expect(route!.vehicles!.every(car => car.chassis === '26021c01.dat' && car.rider.length > 0)).toBe(true);
    // The composite chassis exposes no wheel parts: its wheelbase is the mould's (26021c01.dat places 24869 at ±25).
    expect(route!.vehicles!.every(car => car.wheelbaseLdu === 50)).toBe(true);
    expect(route!.trains).toBe(2);
    expect(route!.reserve).toHaveLength(3);
    expect(route!.reserve!.every(car => car.chassis === '26021c01.dat')).toBe(true);
    expect(route!.lift).toMatchObject({ kind: 'chain', climbDirection: 1 });
    const runtime = coasterRuntimeConfig('craftmatic:c_10261_coaster_cart', scene.routes).routes[0]!;
    expect(runtime.direction).toBe(1);
    expect(runtime.cars).toMatchObject({ count: 3, heading: 1, trains: 2 });
    expect(runtime.cars.spacing).toBeCloseTo(126 / 53.333333, 2);
    // The chain spans the hill: it starts near the foot and runs most of a lap
    // before the crest. Arcs are route-derived, so pin the shape, not a length
    // that moves with every track-measurement fix.
    expect(runtime.chain!.start).toBeLessThan(5);
    expect(runtime.chain!.end).toBeGreaterThan(25);
    expect(runtime.chain!.end).toBeLessThan(runtime.path.length * 0.25);
    expect(runtime.chain!.end - runtime.chain!.start).toBeGreaterThan(20);
    expect(runtime.lift).toBeUndefined();
    // The second train waits one train length plus the gap behind the platform on the closed circuit.
    expect(runtime.dispatch!.hold).toBeCloseTo(runtime.station.stop - (runtime.cars.extent + runtime.cars.spacing + 0.5), 3);
    expect(runtime.dispatch!.lap).toBeCloseTo(runtime.path.length, 2);
    expect(runtime.cars.slots!.map(s => s.train)).toEqual([0, 0, 0, 1, 1, 1]);
    // The siding's three riders leave the shell with the circuit's three, and so do the siding's cars.
    expect(scene.riderIndices.size).toBeGreaterThanOrEqual(6 * 4);
    expect(scene.movedIndices.size).toBeGreaterThan(3 * 16 + 3 * 12);
    expect(scene.warnings.some(w => /Track 2: its 3 parked cars run as Track 1's second train/.test(w))).toBe(true);
    // No loop, no twist: every up vector is gravity's projected off the track (never banked).
    const path = runtime.path;
    for (let i = 1; i < path.points.length - 1; i++) {
      const a = path.points[i - 1]!, b = path.points[i + 1]!;
      const t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...t);
      const h = Math.hypot(t[0]! / l, t[2]! / l);
      const g = [-t[1]! / l * t[0]! / l / h, h, -t[1]! / l * t[2]! / l / h];
      const u = runtime.up[i]!;
      expect(u[0] * g[0]! + u[1] * g[1]! + u[2] * g[2]!).toBeGreaterThan(Math.cos(0.5 * Math.PI / 180));
    }
  }, 120_000);
});

// ─── Pack-level assets (gated on the playable-addon.ts integration patch) ────

const ADDON_INTEGRATED = /buildCoasterRideAssets/.test(readFileSync(new URL('../web/src/engine/playable-addon.ts', import.meta.url), 'utf8'));

describe.skipIf(!ADDON_INTEGRATED)("pack assets with the set's own cars", () => {
  it('ships one entity type per car body, the lift and counterweight, and no fabricated cart', async () => {
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, { stem: 'Coaster', coasterRoutes: [liftRoute({ counterweight: true })] });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const entries = listZipEntries(buffer);
    expect(entries.filter(e => /coaster_vehicle_1\.(json|entity\.json|geo\.json|animation\.json)$/.test(e))).toHaveLength(4);
    expect(entries.some(e => /coaster_lift_1\.json$/.test(e))).toBe(true);
    expect(entries.some(e => /coaster_counterweight_1\.json$/.test(e))).toBe(true);
    expect(entries.some(e => /coaster_cart\.json$/.test(e))).toBe(false);
    expect(entries.some(e => /craftmatic_coaster\.png$/.test(e))).toBe(false);
    const decode = async (name: string) => new TextDecoder().decode(await extractFile(buffer, name));
    const placement = JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(await decode('Craftmatic_coaster_BP/scripts/placement.js'))![1]!);
    const coasterActors = placement.actors.filter((actor: any) => actor.coasterRouteIndex === 0);
    // Ids keep the pack's existing `<id>_coaster_*` shape, as the fabricated cart did.
    expect(coasterActors.map((a: any) => a.typeId.replace(/^craftmatic:coaster_/, ''))).toEqual(['coaster_lift_1', 'coaster_counterweight_1', 'coaster_vehicle_1', 'coaster_vehicle_1']);
    expect(coasterActors.map((a: any) => a.coasterCarIndex)).toEqual([undefined, undefined, 0, 1]);
    const diagnostics = JSON.parse(await decode('Craftmatic_coaster_BP/craftmatic-diagnostics.json'));
    expect(diagnostics.coaster.cuboids).toBe(0);
    expect(diagnostics.coaster.types.map((t: any) => t.role)).toEqual(['car', 'platform', 'counterweight']);
    expect(diagnostics.coaster.routes[0].lift.deckLength).toBe(5);
    expect(pack.components.filter(c => c.kind === 'car')).toHaveLength(1);
    expect(pack.warnings.some(w => /its lift completes the circuit/.test(w))).toBe(true);
    // Float actor properties still serialize as float literals in the compiled car.
    const entity = await decode(entries.find(e => /coaster_vehicle_1\.json$/.test(e))!);
    expect(entity).toMatch(/"default": 0\.0/);
  }, 60_000);
});

// ─── The rider's track-following camera ──────────────────────────────────────

/** A player mock riding `entity`: Bedrock turns a rider with its vehicle, so the
 * player's yaw is the car's last teleported yaw plus the head turn `head`. */
function cameraRider(entity: any, head = { yaw: 0, pitch: 0 }) {
  const lastYaw = () => {
    const calls = entity.tryTeleport.mock.calls as any[][];
    return calls.length ? Number(calls.at(-1)![1].rotation.y) : 0;
  };
  return {
    head,
    player: {
      id: 'player', typeId: 'minecraft:player', onScreenDisplay: { setActionBar: vi.fn() },
      camera: { setCamera: vi.fn(), clear: vi.fn() }, addEffect: vi.fn(), removeEffect: vi.fn(),
      getRotation: () => ({ x: head.pitch, y: lastYaw() + head.yaw }),
    },
  };
}

/** Bedrock's view direction for a camera rotation (yaw 0 faces +Z, +pitch looks down), pitch taken literally past ±90. */
function viewDirection(rotation: { x: number; y: number }): number[] {
  const y = rotation.y * Math.PI / 180, p = rotation.x * Math.PI / 180;
  return [-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)];
}
const angleDeg = (a: number[], b: number[]) => {
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  return Math.acos(Math.max(-1, Math.min(1, (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (la * lb)))) * 180 / Math.PI;
};
/** A car's nose on `path` at `arc`: the chord between its wheel contacts (the runtime's `chordAt`, closed-route aware). */
function routeChord(path: { points: number[][]; cumulative: number[]; length: number; closed: boolean }, arc: number, wheelbase: number): number[] {
  const at = (value: number) => {
    const d = path.closed ? ((value % path.length) + path.length) % path.length : Math.max(0, Math.min(path.length, value));
    let i = 0; while (i < path.points.length - 2 && path.cumulative[i + 1]! <= d) i++;
    const t = (d - path.cumulative[i]!) / (path.cumulative[i + 1]! - path.cumulative[i]!);
    return [0, 1, 2].map(k => path.points[i]![k]! + (path.points[i + 1]![k]! - path.points[i]![k]!) * t);
  };
  // No measured wheelbase: the runtime takes the tangent of the segment the arc is on.
  const [front, rear] = wheelbase > 0.01 ? [at(arc + wheelbase / 2), at(arc - wheelbase / 2)] : [at(arc + 1e-4), at(arc)];
  return [0, 1, 2].map(k => front[k]! - rear[k]!);
}
const finiteView = (view: any) => Number.isFinite(view.rotation.x) && Number.isFinite(view.rotation.y) && Number.isFinite(view.location.x);

describe('the rider camera follows the track', () => {
  it('over mode: puts the view along the car\'s nose through a vertical loop, over the top and upside down, with no yaw snap', () => {
    // A pitch past ±90 is REFUSED by Bedrock's script API on the Pixel
    // ("Pitch (x rot) is outside accepted range of [-90, 90]"), so this mode is
    // not the default; the math is kept honest for any client that allows it.
    const h = rideHost(loopRoute(), { seat: [0, 0.35, 0], camera: { mode: 'over' } });
    const { player } = cameraRider(h.entity);
    h.run(1); h.riders.push(player); h.run(120); // board at the station, depart
    const calls = player.camera.setCamera.mock.calls as any[][];
    const route = h.config.routes[0]!, wheelbase = h.config.types['craftmatic:test_cart']!.wheelbase || 0;
    let worstYawStep = 0, worstPitchStep = 0, worstAlong = 0, minPitch = 0, maxPitch = 0, compared = 0;
    let previous: any;
    for (let t = 0; t < 600; t++) {
      const before = h.distances.at(-1)!;
      h.run(1);
      const view = calls.at(-1)![1];
      expect(finiteView(view)).toBe(true);
      if (previous) {
        worstYawStep = Math.max(worstYawStep, Math.abs(view.rotation.y - previous.rotation.y));
        worstPitchStep = Math.max(worstPitchStep, Math.abs(view.rotation.x - previous.rotation.x));
      }
      minPitch = Math.min(minPitch, view.rotation.x); maxPitch = Math.max(maxPitch, view.rotation.x);
      previous = view;
      // The fabricated cart faces its motion: the nose is the wheel chord, signed by the way it moved.
      const after = h.distances.at(-1)!;
      let step = after - before; if (Math.abs(step) > route.path.length / 2) step -= Math.sign(step) * route.path.length;
      if (Math.abs(step) < 1e-6) continue;
      const nose = routeChord(route.path, after, wheelbase).map(v => v * Math.sign(step));
      worstAlong = Math.max(worstAlong, angleDeg(viewDirection(view.rotation), nose)); compared++;
    }
    expect(compared).toBeGreaterThan(400);
    expect(worstAlong).toBeLessThan(0.01);
    // Never a snap: the camera's yaw is held through the loop, the pitch rolls on past vertical.
    expect(worstYawStep).toBeLessThan(1e-6);
    expect(worstPitchStep).toBeLessThan(30);
    // Over the top: the pitch runs through -180 (upside down, looking back), a full turn per lap.
    expect(maxPitch - minPitch).toBeGreaterThan(300);
    expect(calls[0]![1].easeOptions).toEqual({ easeTime: COASTER_RIDER_VIEW.ease, easeType: 'Linear' });
  });

  it('layers the rider\'s head turn on the track frame, clamped, and recentres by looking back', () => {
    const h = rideHost(towerRoute(), { seat: [0, 0.35, 0] });
    const rider = cameraRider(h.entity, { yaw: 25, pitch: -10 }); // boards looking somewhere else
    h.run(1); h.riders.push(rider.player); h.run(1);
    const calls = rider.player.camera.setCamera.mock.calls as any[][];
    const cart = () => { const c = h.entity.tryTeleport.mock.calls as any[][]; return c.at(-1)![1].rotation.y as number; };
    // Boarding sets the reference: the view starts on the track frame whatever the player was looking at.
    expect(calls.at(-1)![1].rotation.y).toBeCloseTo(cart(), 6);
    expect(calls.at(-1)![1].rotation.x).toBeCloseTo(0, 6);
    // Turn the head 30 right and 20 down: the view turns with it, relative to the car.
    rider.head.yaw = 55; rider.head.pitch = 10; h.run(1);
    expect(calls.at(-1)![1].rotation.y - cart()).toBeCloseTo(30, 6);
    expect(calls.at(-1)![1].rotation.x).toBeCloseTo(20, 6);
    // Past the limits the offset holds at the limit ...
    // (the camera turns at most `maxTurn` a tick, so a 150-degree flick takes a few)
    rider.head.yaw = 25 + 150; rider.head.pitch = -10 - 90; h.run(3);
    expect(calls.at(-1)![1].rotation.y - cart()).toBeCloseTo(COASTER_RIDER_VIEW.lookYaw, 6);
    expect(calls.at(-1)![1].rotation.x).toBeCloseTo(-COASTER_RIDER_VIEW.lookPitch, 6);
    // ... and looking back by the limit returns to the track frame exactly.
    rider.head.yaw -= COASTER_RIDER_VIEW.lookYaw; rider.head.pitch += COASTER_RIDER_VIEW.lookPitch; h.run(3);
    expect(calls.at(-1)![1].rotation.y).toBeCloseTo(cart(), 6);
    expect(calls.at(-1)![1].rotation.x).toBeCloseTo(0, 6);
  });

  it('turns the look with the car upside down: "right" in a loop is the rider\'s right', () => {
    // Nose straight up the loop side, the car's up pointing to -Z: its right is nose x up = -X.
    const right = coasterRiderView([0, 1, 0], [0, 0, -1], { yaw: 90, pitch: 0 }, null, 'over', 40).direction;
    expect(right[0]).toBeCloseTo(-1, 6); expect(right[1]).toBeCloseTo(0, 6);
    // Looking "down" in the seat is toward the car's floor, +Z here.
    const down = coasterRiderView([0, 1, 0], [0, 0, -1], { yaw: 0, pitch: 90 }, null, 'over', 40).direction;
    expect(down[2]).toBeCloseTo(1, 6);
  });

  it('clamp mode (the default) looks exactly along the nose, keeps the pitch within ±90, and spreads the flip over the top across ticks', () => {
    expect(COASTER_RIDER_VIEW.mode).toBe('clamp');
    const h = rideHost(loopRoute(), { seat: [0, 0.35, 0] });
    const { player } = cameraRider(h.entity);
    h.run(1); h.riders.push(player); h.run(120);
    const calls = player.camera.setCamera.mock.calls as any[][];
    const route = h.config.routes[0]!, wheelbase = h.config.types['craftmatic:test_cart']!.wheelbase || 0;
    let previous: any, flipping = 0, worstAlong = 0, compared = 0;
    for (let t = 0; t < 700; t++) {
      const before = h.distances.at(-1)!;
      h.run(1);
      const view = calls.at(-1)![1].rotation;
      expect(Math.abs(view.x)).toBeLessThanOrEqual(90 + 1e-9);
      if (previous) expect(Math.abs(view.y - previous.y)).toBeLessThanOrEqual(COASTER_RIDER_VIEW.maxTurn + 1e-9);
      const after = h.distances.at(-1)!;
      let step = after - before; if (Math.abs(step) > route.path.length / 2) step -= Math.sign(step) * route.path.length;
      if (Math.abs(step) > 1e-6) {
        const nose = routeChord(route.path, after, wheelbase).map(v => v * Math.sign(step));
        const error = angleDeg(viewDirection(view), nose);
        // While the yaw is still turning over the top the view is off the nose,
        // but only near the zenith/nadir, where the yaw hardly matters.
        if (error > 0.01) { flipping++; expect(Math.abs(view.x)).toBeGreaterThan(45); }
        worstAlong = Math.max(worstAlong, error); compared++;
      }
      previous = view;
    }
    expect(compared).toBeGreaterThan(400);
    // Two flips a lap (up the loop's side, down the other), each a few ticks.
    expect(flipping).toBeGreaterThan(0);
    expect(flipping / compared).toBeLessThan(0.1);
    const yaws = (calls as any[][]).map(call => call[1].rotation.y);
    expect(Math.max(...yaws) - Math.min(...yaws)).toBeGreaterThan(170);
  });

  it('gives the player their own camera back, and their visibility, on dismount', () => {
    const h = rideHost(towerRoute());
    const { player } = cameraRider(h.entity);
    h.run(1); h.riders.push(player); h.run(5);
    expect(player.addEffect).toHaveBeenCalledWith('invisibility', expect.any(Number), { showParticles: false });
    expect(player.camera.clear).not.toHaveBeenCalled();
    h.dismount(); h.run(1);
    expect(player.camera.clear).toHaveBeenCalledTimes(1);
    expect(player.removeEffect).toHaveBeenCalledWith('invisibility');
    h.run(5);
    expect(player.camera.clear).toHaveBeenCalledTimes(1);
  });

  it('keeps the camera through a paused tick (an unloaded chunk) instead of dropping it', () => {
    const h = rideHost(towerRoute());
    const { player } = cameraRider(h.entity);
    h.run(1); h.riders.push(player); h.run(3);
    h.setLoaded(false); h.run(3); h.setLoaded(true); h.run(2);
    expect(player.camera.clear).not.toHaveBeenCalled();
  });

  it('never touches the camera of a pack built without one', () => {
    const h = rideHost(towerRoute());
    const bare = { ...h.config }; delete bare.camera;
    const world = { getDimension: (name: string) => ({ getEntities: () => name === 'overworld' ? [h.entity] : [] }) };
    let tick = () => {};
    new Function('world', 'system', coasterScript(bare).replace(/^import .*;\n/, ''))(world, { runInterval: (callback: () => void) => { tick = callback; } });
    const { player } = cameraRider(h.entity);
    tick(); h.riders.push(player);
    for (let i = 0; i < 20; i++) tick();
    expect(player.camera.setCamera).not.toHaveBeenCalled();
    expect(player.addEffect).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAVE_CORPUS)('10303: the rider view through the lift, the drop, the curves and both loops', () => {
  it('over mode: looks along the track all lap, runs over both tops upside down, and never snaps', async () => {
    const { scene } = await corpusRoutes(PUBLISHED_10303);
    const h = liftHost(scene.routes[0]!, { mode: 'over' });
    const rider = cameraRider(h.lead.entity);
    h.run(1); h.lead.riders.push(rider.player);
    const calls = rider.player.camera.setCamera.mock.calls as any[][];
    const phases: string[] = [];
    const centres: number[] = [];
    for (let t = 0; t < 1400; t++) { h.run(1); phases.push(h.phase()); centres.push(h.distance()); }
    const views = calls.map(call => call[1]);
    expect(views.length).toBeGreaterThan(1300);
    let worstAlong = 0, compared = 0, worstYawStep = 0, worstPitchStep = 0, inverted = 0, leaning = 0;
    const tops: number[] = [];
    const path = h.route.path, cars = h.route.cars;
    const wheelbase = h.config.types[cars.slots![0]!.type]!.wheelbase || 0;
    for (let k = 1; k < views.length; k++) {
      worstYawStep = Math.max(worstYawStep, Math.abs(views[k]!.rotation.y - views[k - 1]!.rotation.y));
      worstPitchStep = Math.max(worstPitchStep, Math.abs(views[k]!.rotation.x - views[k - 1]!.rotation.x));
      const pitch = views[k]!.rotation.x, over = Math.abs(((pitch % 360) + 540) % 360 - 180) > 120;
      if (over) { inverted++; if (!tops.length || k - tops.at(-1)! > 40) tops.push(k); }
      if (phases[k] !== 'track') continue;
      // The car's nose: the chord between its wheels at slot 0's arc, facing its authored heading.
      const arc = centres[k]! + cars.extent / 2;
      const nose = routeChord(path, arc, wheelbase).map(v => v * (cars.heading || 1));
      if (Math.hypot(...nose) < 1e-6) continue;
      const e = angleDeg(viewDirection(views[k]!.rotation), nose);
      if (e > 2) leaning++;
      worstAlong = Math.max(worstAlong, e); compared++;
    }
    expect(compared).toBeGreaterThan(800);
    // With no head turn the view is the car's nose everywhere but inside the two
    // helical loops, where the loop's ~12-degree lean is a roll a Bedrock camera
    // cannot draw and the closest roll-free view splits it (measured: 2-11
    // degrees over ~20 ticks a loop, 17 once at loop 2's fragment-join jog).
    expect(worstAlong).toBeLessThan(20);
    expect(leaning).toBeLessThan(50);
    // Two loop tops, each seen upside down (pitch within 60 of ±180).
    expect(tops.length).toBe(2);
    expect(inverted).toBeGreaterThan(10);
    // No snap anywhere: the yaw moves with the track's turns (16.9 at most, on a
    // curve at speed), the pitch with its grade and loops.
    expect(worstYawStep).toBeLessThan(20);
    expect(worstPitchStep).toBeLessThan(30);
  }, 240_000);

  it('clamp mode (the default, what Bedrock accepts): exact along the nose except while turning over a loop, pitch within ±90, no yaw jump', async () => {
    const { scene } = await corpusRoutes(PUBLISHED_10303);
    const h = liftHost(scene.routes[0]!);
    const rider = cameraRider(h.lead.entity);
    h.run(1); h.lead.riders.push(rider.player);
    const calls = rider.player.camera.setCamera.mock.calls as any[][];
    const path = h.route.path, cars = h.route.cars;
    const wheelbase = h.config.types[cars.slots![0]!.type]!.wheelbase || 0;
    let compared = 0, off = 0, worstOffLevel = 0, worstYawStep = 0, worstError = 0;
    for (let t = 0; t < 1400; t++) {
      h.run(1);
      const view = calls.at(-1)![1].rotation, previous = calls.at(-2)?.[1].rotation;
      expect(Math.abs(view.x)).toBeLessThanOrEqual(90 + 1e-9);
      if (previous) worstYawStep = Math.max(worstYawStep, Math.abs(view.y - previous.y));
      if (h.phase() !== 'track') continue;
      const nose = routeChord(path, h.distance() + cars.extent / 2, wheelbase).map(v => v * (cars.heading || 1));
      if (Math.hypot(...nose) < 1e-9) continue;
      const error = angleDeg(viewDirection(view), nose);
      compared++;
      if (error > 0.5) { off++; worstOffLevel = Math.max(worstOffLevel, 90 - Math.abs(view.x)); worstError = Math.max(worstError, error); }
    }
    expect(compared).toBeGreaterThan(800);
    // Off the nose only while the yaw turns over a loop's side: measured 13
    // ticks a lap (4 per flip, 4 flips), up to 34 degrees while the view is
    // still 41-83 degrees from level — the image turns over in 0.2 s rather
    // than snapping, and at 32 blocks/s the loop turns on under it meanwhile.
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(20);
    expect(worstOffLevel).toBeLessThan(50);
    expect(worstError).toBeLessThan(40);
    expect(worstYawStep).toBeLessThanOrEqual(COASTER_RIDER_VIEW.maxTurn + 1e-9);
  }, 240_000);
});
