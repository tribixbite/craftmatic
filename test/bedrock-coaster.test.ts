import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  COASTER_MAX_CARS, PARKED_SIDING_FACTOR, buildCoasterRideAssets, canonicalCoasterCar, coasterCartAssets, coasterMaxSpacing, coasterRoutesFromAssemblies,
  coasterRuntimeConfig, coasterScript, findCoasterStation, planCoasterVehicles, resolveCoasterCars, COASTER_CAR_LENGTH,
} from '../web/src/engine/bedrock-coaster.js';
import type { CoasterRoute, CoasterRouteCar } from '../web/src/engine/bedrock-coaster.js';
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
import { buildCoasterPath } from '../web/src/engine/coaster-path.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { BlockGrid } from '../src/schem/types.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { host } from './_placement-host.js';

interface RideHostOptions { riders?: boolean; scale?: number }

/** One host per placement. A route that declares a train gets that many car
 * entities, all spawned at the same station point the placement uses. */
function rideHost(route: CoasterRoute, options: RideHostOptions = {}) {
  const config = coasterRuntimeConfig('craftmatic:test_cart', [route]);
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
    const entity: any = {
      // The runtime discovers coaster entities by family and resolves each one's
      // role from its type, so the mock carries the cart's type id.
      id: `cart${index}`, typeId: 'craftmatic:test_cart', getDynamicProperty: (key: string) => { if (removed) throw new Error('removed'); return properties.get(key); },
      setDynamicProperty: (key: string, value: unknown) => properties.set(key, value),
      setProperty: vi.fn(), teleport: vi.fn(), getRotation: () => ({ x: 0, y: 0 }),
      // Bedrock exposes removal through isValid; a removed cart must retire quietly.
      isValid: () => !removed && !gone.has(index),
      getComponent: () => ({ getRiders: () => [...riders], ejectRiders: () => { riders.length = 0; } }),
    };
    entity.tryTeleport = vi.fn((position: any, teleportOptions: unknown) => {
      entity.teleport(position, teleportOptions); positions.push({ ...position }); return true;
    });
    entity.dimension = { getBlock: () => loaded ? {} : undefined };
    return { entity, properties, rider, riders, positions };
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
  return { cars, config, distances, start,
    // Car 0 aliases keep the single-cart tests reading as they did.
    entity: lead.entity, properties: lead.properties, riders: lead.riders, rider: lead.rider, positions: lead.positions,
    run: (n: number) => { for (let i = 0; i < n; i++) { tick(); distances.push(Number(lead.properties.get('craftmatic:coaster_distance'))); } },
    board: (index = 0) => { cars[index]!.riders.push(cars[index]!.rider); },
    dismount: (index = 0) => { cars[index]!.riders.length = 0; },
    setLoaded: (value: boolean) => { loaded = value; }, remove: () => { removed = true; },
    unload: (index: number) => { gone.add(index); }, reload: (index: number) => { gone.delete(index); },
    /** World blocks per second between consecutive teleports of one car. */
    speeds: (index = 0) => speedsOf(cars[index]!.positions),
  };
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
    const climbing: number[] = [], falling: number[] = [];
    for (let index = 1; index < h.positions.length; index++) {
      const from = h.positions[index - 1]!, to = h.positions[index]!;
      const step = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      if (step < 1e-9) continue;
      const grade = (to.y - from.y) / step;
      if (grade > 0.2) climbing.push(step * 20); else if (grade < -0.2) falling.push(step * 20);
    }
    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    expect(climbing.length).toBeGreaterThan(100);
    expect(falling.length).toBeGreaterThan(100);
    // The chain lift holds the climb at its own speed; the drop is bounded only
    // by the sample-spacing ceiling (20 * scale * 0.375 = 7.5 blocks/s).
    expect(mean(climbing)).toBeGreaterThan(2.2);
    expect(mean(climbing)).toBeLessThan(2.6);
    expect(mean(falling) / mean(climbing)).toBeGreaterThan(2.5);
    // The chain never overdrives the climb, and the drop reaches the ceiling.
    expect(Math.max(...climbing)).toBeLessThanOrEqual(2.6);
    expect(Math.max(...falling)).toBeGreaterThan(7.4);
    expect(Math.max(...falling)).toBeLessThanOrEqual(7.5 + 1e-9);
  });
  it('never advances more than one authored sample spacing in a tick', () => {
    for (const scale of [1, 4]) {
      const h = rideHost(towerRoute(), { scale });
      h.run(1500);
      const spacing = coasterMaxSpacing(h.config.routes[0]!.path);
      let largest = 0;
      for (let index = 1; index < h.distances.length; index++) {
        const step = Math.abs(h.distances[index]! - h.distances[index - 1]!);
        if (step > largest) largest = step;
      }
      expect(largest).toBeGreaterThan(0);
      expect(largest).toBeLessThanOrEqual(spacing + 1e-9);
    }
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
    // after which the chain takes over at its own speed.
    expect(h.positions[0]).toEqual({ x: 100, y: 64, z: 200 });
    expect(h.positions[98]).toEqual({ x: 100, y: 64, z: 200 });
    expect(h.positions[99]!.y).toBeCloseTo(64.15, 9);
    expect(h.positions[100]!.y).toBeCloseTo(64.275, 9);
    h.run(20);
    const speeds = h.speeds().slice(-10);
    for (const speed of speeds) expect(speed).toBeCloseTo(2.5, 6);
    expect(h.entity.setProperty).toHaveBeenCalledWith('craftmatic:track_pitch', -90);
  });
  it('inverts the cart visually at a loop apex while leaving player rotation upright', () => {
    const route = loopRoute();
    const h = rideHost(route);
    h.properties.set('craftmatic:coaster_distance', coasterRuntimeConfig('craftmatic:ride', [route]).routes[0]!.path.length / 2);
    h.run(1);
    const roll = h.entity.setProperty.mock.calls.find((call: unknown[]) => call[0] === 'craftmatic:track_roll')?.[1];
    expect(Math.abs(roll)).toBeGreaterThan(170);
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
    expect(h.positions[1]!.x).toBeCloseTo(109.85);
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
  it('stays inside the declared pitch and roll property ranges over a whole ride', () => {
    const h = rideHost(loopRoute());
    h.run(1500);
    const calls = h.entity.setProperty.mock.calls as Array<[string, number]>;
    expect(calls.length).toBeGreaterThan(2000);
    for (const [name, value] of calls) {
      expect(Number.isFinite(value)).toBe(true);
      if (name === 'craftmatic:track_pitch') { expect(value).toBeGreaterThanOrEqual(-90); expect(value).toBeLessThanOrEqual(90); }
      else { expect(value).toBeGreaterThanOrEqual(-180); expect(value).toBeLessThanOrEqual(180); }
    }
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
    expect(resolveCoasterCars(path, undefined)).toEqual({ count: 1, spacing: 0, extent: 0, heading: 0 });
    expect(resolveCoasterCars(path, { count: 1, spacing: 9 })).toEqual({ count: 1, spacing: 0, extent: 0, heading: 0 });
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
    // Invert this route's profile to recover each car's arc position: level
    // run along x, then a constant grade. Cars are coupled along the ARC.
    const arcOf = (point: { x: number; y: number }) =>
      point.y > 65 + 1e-9 ? STATION_RUN + (point.y - 65) / CLIMB_GRADE : point.x - 100;
    let worstArc = 0, shortestChord = Infinity, longestChord = 0;
    for (let index = 0; index < ticks; index++) {
      for (let car = 1; car < h.cars.length; car++) {
        const a = h.cars[car - 1]!.positions[index]!, b = h.cars[car]!.positions[index]!;
        worstArc = Math.max(worstArc, Math.abs(arcOf(a) - arcOf(b) - TRAIN_SPACING));
        const chord = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        shortestChord = Math.min(shortestChord, chord);
        longestChord = Math.max(longestChord, chord);
      }
    }
    expect(worstArc).toBeLessThan(1e-9);
    // Straight-line spacing equals the arc pitch on straight track and closes
    // up across a bend — the chord of a coupled train, never longer than it.
    expect(longestChord).toBeLessThanOrEqual(TRAIN_SPACING + 1e-9);
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
    for (let index = 0; index < h.cars[0]!.positions.length; index++) {
      expect(h.cars[0]!.positions[index]!.x).toBeGreaterThan(h.cars[2]!.positions[index]!.x);
    }
    // No car ever steps further than the authored sample spacing, including on
    // the tick the train reverses at the end of the open route.
    for (const car of h.cars) for (const speed of h.speeds(h.cars.indexOf(car))) expect(speed / 20).toBeLessThanOrEqual(SPACING + 1e-9);
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
    expect(runtime.routes[0].cars).toEqual({ count: 1, spacing: 0, extent: 0, heading: 0 });
    // Route 1: three actors, one per car, every one at the station point, indexed 0..2.
    const cars = placement.actors.filter((actor: any) => actor.coasterRouteIndex === 1);
    expect(cars.map((actor: any) => actor.coasterCarIndex)).toEqual([0, 1, 2]);
    expect(cars.map((actor: any) => actor.label)).toEqual(['Train track Car 1', 'Train track Car 2', 'Train track Car 3']);
    const station = runtime.routes[1].station;
    for (const car of cars) expect(car).toMatchObject({ x: station.point[0], y: station.point[1], z: station.point[2] });
    expect(runtime.routes[1].cars).toEqual({ count: 3, spacing: 2.25, extent: 4.5, minChord: 2.25, heading: 0 });
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
    expect(properties).toMatch(/"range": \[\s*-90\.0,\s*90\.0\s*\]/);
    expect(properties).toMatch(/"range": \[\s*-180\.0,\s*180\.0\s*\]/);
    // Still valid JSON carrying the same numeric meaning.
    const parsed = JSON.parse(entityJson)['minecraft:entity'].description.properties;
    expect(parsed['craftmatic:track_pitch']).toEqual({ type: 'float', range: [-90, 90], default: 0, client_sync: true });
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
    expect(floatProperties).toBe(2);
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
function liftHost(route: CoasterRoute) {
  const config = coasterRuntimeConfig('craftmatic:test_cart', [route]);
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
    const entity: any = {
      id, typeId, getDynamicProperty: (key: string) => properties.get(key), setDynamicProperty: (key: string, value: unknown) => properties.set(key, value),
      setProperty: (key: string, value: unknown) => actorProperties.set(key, value), getRotation: () => ({ x: 0, y: 0 }), isValid: () => !removed.has(id),
      getComponent: (name: string) => name === 'minecraft:rideable' ? { getRiders: () => [...riders], ejectRiders: () => { riders.length = 0; } } : undefined,
      tryTeleport: vi.fn((position: any) => { if (refuse?.(typeId)) return false; positions.push({ ...position }); return true; }),
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
    // every tick - at most one hoist step (0.125 blocks) ahead of where they
    // were, exactly as a train car ahead of a refused car already behaves.
    expect(h.progress()).toBe(before.progress);
    expect(Math.abs(h.lead.positions.at(-1)!.x - before.car.x)).toBeLessThanOrEqual(0.125 + 1e-9);
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
    expect(Math.min(...onChain)).toBeGreaterThanOrEqual(2.5 - 1e-6);
    // …and past the sprockets the climb is on momentum alone, down to the floor.
    expect(Math.min(...offChain)).toBeCloseTo(0.8, 6);
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
    expect(runtime!.cars.slots).toHaveLength(3);
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
    expect(assets.actors.filter(a => a.coasterCarIndex !== undefined)).toHaveLength(3);
    expect(assets.actors.filter(a => a.coasterCarIndex === undefined)).toHaveLength(2);
    expect(assets.warnings.some(w => /55-part lift platform/.test(w))).toBe(true);
  }, 240_000);
});

describe.skipIf(!HAVE_CORPUS)('10261 Roller Coaster: its own train under its chain lift, the siding left parked', () => {
  it('runs the closed circuit with six cars found, three riding and three parked', async () => {
    const { scene } = await corpusRoutes(PUBLISHED_10261);
    expect(scene.routes).toHaveLength(1);
    expect(scene.parked).toEqual([expect.objectContaining({ label: 'Track 2', cars: 3 })]);
    const [route] = scene.routes;
    expect(route!.closed).toBe(true);
    expect(route!.vehicles).toHaveLength(3);
    expect(route!.vehicles!.every(car => car.chassis === '26021c01.dat' && car.rider.length > 0)).toBe(true);
    expect(route!.lift).toMatchObject({ kind: 'chain', climbDirection: 1 });
    const runtime = coasterRuntimeConfig('craftmatic:c_10261_coaster_cart', scene.routes).routes[0]!;
    expect(runtime.direction).toBe(1);
    expect(runtime.cars).toMatchObject({ count: 3, heading: 1 });
    expect(runtime.cars.spacing).toBeCloseTo(126 / 53.333333, 2);
    expect(runtime.chain!.start).toBeCloseTo(127.3 / 53.333333, 1);
    expect(runtime.chain!.end).toBeCloseTo(1690.9 / 53.333333, 1);
    expect(runtime.lift).toBeUndefined();
    // The three riders on the circuit leave the shell; the siding's bricks do not.
    expect(scene.riderIndices.size).toBeGreaterThanOrEqual(3 * 4);
    expect(scene.movedIndices.size).toBeLessThan(3 * 16 + 3 * 12);
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
