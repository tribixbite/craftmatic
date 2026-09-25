/**
 * Railway track on the coaster's route extractor (`coaster-track.ts`) and
 * trains on the coaster's ride step (`rideSubstep`, bedrock-coaster.ts): the
 * rail-vehicle round, 2026-09-25. See the add-on guide, "Rail vehicles on the
 * coaster engine".
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { coasterTrackProfile, extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.js';
import { COASTER_PHYSICS, RAIL_TRAIN_PHYSICS, rideSubstep, type RidePhysics } from '../web/src/engine/bedrock-coaster.js';

const brick = (part: string, x: number, y: number, z: number, yawDeg = 0): ParsedBrick => {
  const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // LDraw rotation about Y (row-major): a point (px, pz) turns to (c px + s pz, -s px + c pz).
  return { part: `${part}.dat`, color: 72, x, y, z, rot: [c, 0, s, 0, 1, 0, -s, 0, c] } as ParsedBrick;
};
const length = (points: readonly (readonly number[])[]): number => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0]! - points[i]![0]!, p[1]! - points[i]![1]!, p[2]! - points[i]![2]!), 0);

describe('railway track profiles (measured on the library meshes)', () => {
  it('routes the straights and curves as railway moulds on the rail-top centreline', () => {
    for (const id of ['53401', '2865', '74746', '53400', '2867', '74747', '85976']) {
      const profile = coasterTrackProfile(`${id}.dat`)!;
      expect(profile.family, id).toBe('train');
      expect(profile.samples.every(p => p[1] === -16), id).toBe(true);
    }
    expect(coasterTrackProfile('53401')!.samples[0]).toEqual([-160, -16, 0]);
    expect(coasterTrackProfile('53401')!.samples.at(-1)).toEqual([160, -16, 0]);
    // Coaster moulds are unchanged: no family.
    expect(coasterTrackProfile('25059')!.family).toBeUndefined();
  });

  it('closes sixteen R40 curves into one circle of radius 800 LDU', () => {
    // Curve k turned k x 22.5 degrees about the circle's centre at the origin:
    // its own centre is local (0, 0, -800), so its origin sits at R_k (0, 0, 800).
    const bricks = Array.from({ length: 16 }, (_, k) => {
      const a = k * 22.5 * Math.PI / 180;
      return brick('53400', 800 * Math.sin(a), 0, 800 * Math.cos(a), k * 22.5);
    });
    const tracks = extractCoasterTrackRoutes(bricks);
    expect(tracks.routes).toHaveLength(1);
    expect(tracks.routes[0]!.closed).toBe(true);
    expect(tracks.routes[0]!.family).toBe('train');
    expect(tracks.routes[0]!.fragmentIds).toHaveLength(16);
    // The polygon through 16 x 16 arc samples: within 0.1 % of 2 pi 800.
    expect(Math.abs(length(tracks.routes[0]!.points) - 2 * Math.PI * 800)).toBeLessThan(5);
  });

  it('pairs loose 4.5V/12V rails one gauge apart into a running line, and leaves a lone rail out', () => {
    // 10277's own placement: rails at x +/-50, stepping 320 along z, turned 90 degrees.
    const rail = (x: number, z: number): ParsedBrick => ({ part: '3228c.dat', color: 72, x, y: -48, z, rot: [0, 0, -1, 0, 1, 0, 1, 0, 0] } as ParsedBrick);
    const bricks = [rail(50, -1930), rail(-50, -1930), rail(-50, -1610), rail(50, -1610), rail(-50, -1290), rail(50, -1290), rail(400, 0)];
    const tracks = extractCoasterTrackRoutes(bricks);
    expect(tracks.routes).toHaveLength(1);
    expect(tracks.routes[0]!.family).toBe('train');
    expect(tracks.routes[0]!.fragmentIds.every(id => id.startsWith('rail-pair:'))).toBe(true);
    expect(Math.round(length(tracks.routes[0]!.points))).toBe(960);
    expect(tracks.routes[0]!.points.every(p => p[0] === 0 && p[1] === -48)).toBe(true);
  });

  // Corpus-gated: the sources are read inside the tests, never in the describe body.
  const corpus = 'C:/git/clego/lego_sets';
  const load = (path: string): ParsedBrick[] => parseLDrawDocument(readFileSync(`${corpus}/${path}`, 'utf8')).bricks;
  it.skipIf(!existsSync(`${corpus}/IOModel2V2/4559.ldr`))('closes 4559 Cargo Railway (9V straights and curves) into one 26-mould circuit', () => {
    const tracks = extractCoasterTrackRoutes(load('IOModel2V2/4559.ldr'));
    expect(tracks.routes.map(r => [r.family, r.closed, r.fragmentIds.length])).toEqual([['train', true, 26]]);
    expect(tracks.graph.gaps).toHaveLength(0);
  });
  it.skipIf(!existsSync(`${corpus}/OMR/10277-1.mpd`))('routes 10277 Crocodile Locomotive over its four paired 3228c rails', () => {
    const tracks = extractCoasterTrackRoutes(load('OMR/10277-1.mpd'));
    expect(tracks.routes.map(r => [r.family, r.closed, r.fragmentIds.length, Math.round(length(r.points))])).toEqual([['train', false, 4, 1280]]);
  });
});

describe('railway cars: the set\'s own trains found on their track (corpus-gated)', () => {
  const corpus = 'C:/git/clego/lego_sets';
  const detect = async (path: string) => {
    const { detectCoasterAssemblies } = await import('../web/src/engine/coaster-assemblies.js');
    const { createPartGeometryProvider } = await import('../web/src/engine/ldraw-part-geometry.js');
    const { setLDrawRoot } = await import('../web/src/engine/ldraw-geometry.js');
    setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
    const bricks = parseLDrawDocument(readFileSync(`${corpus}/${path}`, 'utf8')).bricks;
    const provider = createPartGeometryProvider();
    const meshes = new Map<string, Awaited<ReturnType<typeof provider.getPartMesh>>>();
    await Promise.all([...new Set(bricks.map(b => b.part))].map(async p => { meshes.set(p, await provider.getPartMesh(p)); }));
    const tracks = extractCoasterTrackRoutes(bricks);
    return detectCoasterAssemblies(bricks, meshes, tracks);
  };
  it.skipIf(!existsSync(`${corpus}/IOModel2V2/4559.ldr`))('4559 Cargo Railway: two cars on the closed 9V circuit, each on train bases', async () => {
    const found = await detect('IOModel2V2/4559.ldr');
    const onLine = found.cars.filter(car => car.route);
    expect(onLine.map(car => car.chassis.part)).toEqual(['2972.dat', '2972.dat']);
    expect(found.trains.map(t => t.carIds.length)).toEqual([2]);
  }, 60_000);
  it.skipIf(!existsSync(`${corpus}/IOModel2V2/910044.ldr`))('910044 Wild West Train: loco, tender and car on the open line, two with their driver and guard', async () => {
    const found = await detect('IOModel2V2/910044.ldr');
    const onLine = found.cars.filter(car => car.route);
    expect(onLine).toHaveLength(3);
    expect(onLine.filter(car => car.seats.some(seat => seat.source === 'rider'))).toHaveLength(2);
    expect(found.trains.map(t => t.carIds.length)).toEqual([3]);
  }, 60_000);
});

describe('rideSubstep: one ride step for coasters and trains', () => {
  /** The coaster formula exactly as `coasterRuntime` inlined it before 2026-09-25. */
  const shipped = (speed: number, grade: number, dt: number, chain: boolean, floor: number): number => {
    const P = COASTER_PHYSICS;
    speed = Math.max(0, speed + (-P.GRAVITY * grade - P.ROLLING - P.DRAG * speed * speed) * dt);
    if (chain && grade > P.LIFT_GRADE && speed < P.LIFT_SPEED) speed = Math.min(P.LIFT_SPEED, speed + P.LIFT_ACCEL * dt);
    speed = Math.max(speed, P.MIN_SPEED);
    if (floor > 0) speed = Math.max(speed, floor);
    return speed;
  };

  it('is bit-identical to the shipped coaster formula over a sweep of states', () => {
    let seed = 7;
    const rand = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 20000; i++) {
      const speed = rand() * 30, gradeArc = rand() * 2 - 1, dt = 0.05 / (1 + Math.floor(rand() * 8)), direction = rand() < 0.5 ? 1 : -1;
      const chain = rand() < 0.5, floor = rand() < 0.3 ? rand() * 10 : 0;
      const out = rideSubstep(speed, direction, gradeArc, dt, { chain, floor, push: 0, driven: false }, COASTER_PHYSICS as RidePhysics);
      expect(out.direction).toBe(direction);
      expect(Object.is(out.speed, shipped(speed, gradeArc * direction, dt, chain, floor))).toBe(true);
    }
  });

  const run = (seconds: number, start: { speed: number; direction: 1 | -1 }, push: number, gradeArc = 0, driven = true) => {
    let state = start;
    for (let t = 0; t < seconds * 20 * 4; t++) state = rideSubstep(state.speed, state.direction, gradeArc, 1 / 80, { chain: false, floor: 0, push, driven }, RAIL_TRAIN_PHYSICS);
    return state;
  };
  const D = RAIL_TRAIN_PHYSICS.DRIVER!;

  it('accelerates a train from rest under full stick and holds it at the top speed', () => {
    const after1 = run(1, { speed: 0, direction: 1 }, 1);
    // Traction less rolling and drag: a little under 3 - 0.3 blocks/s after one second.
    expect(after1.speed).toBeGreaterThan(2.6);
    expect(after1.speed).toBeLessThan(D.TRACTION - RAIL_TRAIN_PHYSICS.ROLLING + 0.01);
    expect(after1.direction).toBe(1);
    expect(run(20, { speed: 0, direction: 1 }, 1).speed).toBe(RAIL_TRAIN_PHYSICS.MAX_SPEED);
  });

  it('brakes to a stop without reversing, then reverses from rest on a held stick', () => {
    // Brake 6 plus rolling and drag: half a second takes a little over 3 blocks/s off.
    const braking = run(0.5, { speed: 6, direction: 1 }, -1);
    expect(braking.direction).toBe(1);
    expect(braking.speed).toBeGreaterThan(2.5);
    expect(braking.speed).toBeLessThan(3);
    // Rolling and drag alone never turn a moving train round.
    expect(run(60, { speed: 6, direction: 1 }, 0).direction).toBe(1);
    const reversing = run(2, { speed: 6, direction: 1 }, -1);
    expect(reversing.direction).toBe(-1);
    expect(reversing.speed).toBeGreaterThan(1);
  });

  it('parks a train nobody drives, on the flat and on a grade shallower than its park brake', () => {
    expect(run(2, { speed: 8, direction: 1 }, 0, 0, false).speed).toBe(0);
    expect(run(5, { speed: 0, direction: 1 }, 0, 0.3, false).speed).toBe(0);
    // A driver who lets go coasts: rolling and drag only.
    const coasting = run(1, { speed: 8, direction: 1 }, 0);
    expect(coasting.speed).toBeGreaterThan(7.2);
    expect(coasting.speed).toBeLessThan(8);
  });
});

describe('a driven train in the pack runtime (coasterScript on the replay host)', () => {
  it('parks unattended, goes on the stick, stops at a buffer, and reverses on the stick', async () => {
    const { coasterRuntimeConfig, coasterScript } = await import('../web/src/engine/bedrock-coaster.js');
    const { replayCoasterScript } = await import('../scripts/_coaster_replay.js');
    // 40 blocks of level railway line; the replay boards a rider at tick 200
    // and holds the stick forward to tick 600, idle to 800, back to 1000.
    const points = Array.from({ length: 81 }, (_, i) => [i * 0.5, 0, 0] as [number, number, number]);
    const config = coasterRuntimeConfig('craftmatic:test_train', [{ label: 'Line', points, closed: false, maxSegmentLength: 0.5, family: 'train' }]);
    expect(config.routes[0]!.physics?.DRIVER).toBeDefined();
    expect(config.routes[0]!.direction).toBe(0);
    const trace: unknown[] = [];
    replayCoasterScript(coasterScript(config), 1400, trace);
    const distance = new Map<number, number>(), speed = new Map<number, number>();
    for (const e of trace as unknown[][]) {
      if (e[1] !== 'dyn' || e[2] !== 'r0c0') continue;
      if (e[3] === 'craftmatic:coaster_distance') distance.set(e[0] as number, e[4] as number);
      if (e[3] === 'craftmatic:coaster_speed') speed.set(e[0] as number, e[4] as number);
    }
    expect(speed.get(199)).toBe(0);
    expect(distance.get(199)).toBe(distance.get(2));
    // Placed mid-line, it has ~20 blocks to the buffer: about 3 blocks/s² of traction gets it near 10.
    expect(Math.max(...[...speed].filter(([t]) => t > 200 && t < 600).map(([, v]) => v))).toBeGreaterThan(9);
    expect(distance.get(599)).toBeCloseTo(40, 3);
    expect(speed.get(599)).toBe(0);
    expect(distance.get(999)!).toBeLessThan(distance.get(799)! - 5);
  });
});
