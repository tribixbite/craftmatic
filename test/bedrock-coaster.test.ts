import { describe, expect, it, vi } from 'vitest';
import { coasterCartAssets, coasterMaxSpacing, coasterRuntimeConfig, coasterScript, findCoasterStation, resolveCoasterCars, COASTER_CAR_LENGTH } from '../web/src/engine/bedrock-coaster.js';
import type { CoasterRoute } from '../web/src/engine/bedrock-coaster.js';
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
      id: `cart${index}`, getDynamicProperty: (key: string) => { if (removed) throw new Error('removed'); return properties.get(key); },
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
    expect(resolveCoasterCars(path, undefined)).toEqual({ count: 1, spacing: 0, extent: 0 });
    expect(resolveCoasterCars(path, { count: 1, spacing: 9 })).toEqual({ count: 1, spacing: 0, extent: 0 });
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
    expect(runtime.routes[0].cars).toEqual({ count: 1, spacing: 0, extent: 0 });
    // Route 1: three actors, one per car, every one at the station point, indexed 0..2.
    const cars = placement.actors.filter((actor: any) => actor.coasterRouteIndex === 1);
    expect(cars.map((actor: any) => actor.coasterCarIndex)).toEqual([0, 1, 2]);
    expect(cars.map((actor: any) => actor.label)).toEqual(['Train track Car 1', 'Train track Car 2', 'Train track Car 3']);
    const station = runtime.routes[1].station;
    for (const car of cars) expect(car).toMatchObject({ x: station.point[0], y: station.point[1], z: station.point[2] });
    expect(runtime.routes[1].cars).toEqual({ count: 3, spacing: 2.25, extent: 4.5, minChord: 2.25 });
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
