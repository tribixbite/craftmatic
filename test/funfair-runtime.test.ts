/**
 * The funfair rides' runtime (engine/rides/funfair-runtime.ts, BIZ-20) as the pack ships it
 * (`funfairScript`) on the headless simulator (test/_sim-host.ts): a drop tower and a sky swing with a seat
 * for every rider, each on its own path, departing together, set down outside the ring.
 */
import { describe, expect, it } from 'vitest';
import { FUNFAIR, funfairKit } from '../web/src/engine/rides/funfair-physics.js';
import { funfairScript, type FunfairRuntimeConfig } from '../web/src/engine/rides/funfair-runtime.js';
import { rideSeatBehavior } from '../web/src/engine/playable-addon.js';
import { COLLIDER_BLOCK_ID } from '../web/src/engine/bedrock-building-shell.js';
import type { SimEntity } from '../web/src/sim/entity/entity.js';
import { simHost } from './_sim-host.js';

const SEAT = 'craftmatic:t_funfair', CAR = 'craftmatic:t_ring', OTHER = 'craftmatic:t_prop';
const PROP = { components: { 'minecraft:type_family': { family: ['craftmatic_actor'] }, 'minecraft:collision_box': { width: 1, height: 1 } } };
const kit = funfairKit(FUNFAIR);
const TICKS = (s: number): number => Math.ceil(s * 20);

interface RingOptions { kind: 'drop' | 'swing'; seats?: number; radius?: number; height?: number; f?: number; foot?: number; ground?: boolean }

/** A ring of seats round the axis (x 0.5, z 0.5) at `foot`, each with its own foot / top / axis path and an exit outside the ring. */
function ring(o: RingOptions) {
  const n = o.seats ?? 4, r0 = (o.radius ?? 3) * (o.f ?? 1), height = (o.height ?? 30) * (o.f ?? 1), f = o.f ?? 1, foot = o.foot ?? 1;
  const axis = { x: 0.5, z: 0.5 };
  const config: FunfairRuntimeConfig = { seatType: SEAT, rides: [{ kind: o.kind, carType: CAR }], constants: FUNFAIR };
  const h = simHost({
    script: funfairScript(config),
    entities: { [SEAT]: rideSeatBehavior('t_funfair') as Record<string, unknown>, [CAR]: PROP, [OTHER]: PROP },
    colliders: true,
  });
  if (o.ground !== false) h.fill({ x: -30, y: foot - 1, z: -30 }, { x: 30, y: foot - 1, z: 30 }, COLLIDER_BLOCK_ID);
  const seats = Array.from({ length: n }, (_, i) => {
    const a = i / n * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    const at = { x: axis.x + dx * r0, y: foot, z: axis.z + dz * r0 };
    const path = [at, { ...at, y: foot + height }, { x: axis.x, y: foot + height, z: axis.z }];
    const exit = { x: axis.x + dx * (r0 + 1.5 * f), y: foot, z: axis.z + dz * (r0 + 1.5 * f) };
    return h.spawn(SEAT, at, { dynamic: { 'craftmatic:ride': 0, 'craftmatic:ride_scale': f, 'craftmatic:ride_path': JSON.stringify(path), 'craftmatic:ride_exits': JSON.stringify([exit]) } });
  });
  const car = h.spawn(CAR, { x: axis.x, y: foot, z: axis.z }, { dynamic: { 'craftmatic:ride': 0 } });
  /** A child who sits on seat `i` (as world state). */
  const sit = (i: number, name = `Rider${i}`): SimEntity => {
    const p = h.addPlayer(name, seats[i]!.location);
    h.seat(p, seats[i]!);
    return p;
  };
  return { h, seats, car, sit, r0, height, f, axis, foot, trip: o.kind === 'drop' ? kit.drop(height, f) : kit.swing(height, r0, f) };
}

describe('drop tower', () => {
  it('waits for riders, then lifts every seat together on its own path, falls and sets each rider down outside the ring on the ground', () => {
    const w = ring({ kind: 'drop' });
    const riders = [w.sit(0), w.sit(2)];
    // Boarding: nothing moves for BOARD_S.
    w.h.run(TICKS(FUNFAIR.BOARD_S) - 8);
    expect(w.seats.map(s => s.location.y)).toEqual([1, 1, 1, 1]);
    // Departed: all four seats (two empty) rise by the same amount; the ring with them.
    w.h.run(8 + TICKS(12));
    const dys = w.seats.map(s => s.location.y - w.foot);
    expect(dys[0]).toBeGreaterThan(1);
    for (const dy of dys) expect(dy).toBeCloseTo(dys[0]!, 6);
    expect(w.car.location.y - w.foot).toBeCloseTo(dys[0]!, 6);
    for (const [i, s] of w.seats.entries()) { expect(s.location.x).toBeCloseTo(w.axis.x + Math.cos(i / 4 * Math.PI * 2) * w.r0, 6); }
    // Run to the end: the lowest and highest the riders were, and that they come back down to the ground outside the ring.
    let top = 0, lowAfterTop = Infinity, fastest = 0, last = w.seats[0]!.location.y;
    const total = TICKS(w.trip.duration + FUNFAIR.BOARD_S) + 40;
    for (let i = 0; i < total; i++) {
      w.h.run(1);
      const y = w.seats[0]!.location.y; // the seat carries the rider (the rider sits 0.8 under it)
      if (y > top) top = y;
      if (top > 20 && y < lowAfterTop) lowAfterTop = y;
      fastest = Math.max(fastest, (last - y) * 20);
      last = y;
    }
    expect(top).toBeCloseTo(w.foot + w.height, 0);
    // The fall's top speed is the profile's: g_eff x time to the brake.
    const g = FUNFAIR.GRAVITY * FUNFAIR.DROP_FALL_FRACTION;
    const brakeLen = w.height * g / (g + FUNFAIR.DROP_BRAKE_G * FUNFAIR.GRAVITY);
    expect(fastest).toBeCloseTo(Math.sqrt(2 * g * (w.height - brakeLen)), 0);
    for (const [i, p] of riders.entries()) {
      const seat = w.seats[i * 2]!;
      expect(p.ridingOn).toBeUndefined();
      // Outside the ring, standing on the ground (the floor at y 0 is a full block: its top is y 1).
      expect(Math.hypot(p.location.x - w.axis.x, p.location.z - w.axis.z)).toBeGreaterThan(w.r0 + 0.5);
      expect(p.location.y).toBeCloseTo(1, 6);
      expect(seat.location.y).toBeCloseTo(1, 6);
    }
    expect(w.car.location.y).toBeCloseTo(w.foot, 6);
  });

  it('starts sooner once every seat is taken, and not at all when the only rider gets off', () => {
    const full = ring({ kind: 'drop', seats: 2 });
    full.sit(0); full.sit(1);
    full.h.run(TICKS(FUNFAIR.BOARD_FULL_S) + 12);
    expect(full.seats[0]!.location.y).toBeGreaterThan(full.foot);
    const idle = ring({ kind: 'drop' });
    const p = idle.sit(0);
    idle.h.run(20);
    idle.h.unseat(p);
    idle.h.run(TICKS(FUNFAIR.BOARD_S) + 60);
    expect(idle.seats.map(s => s.location.y)).toEqual([1, 1, 1, 1]);
  });

  it('puts a rider who steps off mid-ride back on their seat', () => {
    const w = ring({ kind: 'drop', seats: 2 });
    const p = w.sit(0); w.sit(1);
    w.h.run(TICKS(FUNFAIR.BOARD_FULL_S) + TICKS(6));
    expect(w.seats[0]!.location.y).toBeGreaterThan(w.foot + 1);
    w.h.unseat(p);
    w.h.run(FUNFAIR.KEEP_ABOARD_TICKS + 2);
    expect(p.ridingOn).toBe(w.seats[0]);
    expect(Math.abs(p.location.y - w.seats[0]!.location.y)).toBeLessThan(1.5);
  });

  it('is the same ride in the same seconds at every wand size, with every length scaled', () => {
    for (const f of [0.5, 2]) {
      const w = ring({ kind: 'drop', f, seats: 2 });
      w.sit(0); w.sit(1);
      const ticks = TICKS(FUNFAIR.BOARD_FULL_S) + TICKS(w.trip.duration) + 20;
      let top = 0;
      for (let i = 0; i < ticks; i++) { w.h.run(1); top = Math.max(top, w.seats[0]!.location.y - w.foot); }
      expect(top / f).toBeCloseTo(30, 0);
      // Done in the same time: set down.
      expect(w.seats[0]!.location.y).toBeCloseTo(w.foot, 6);
    }
  });
});

describe('sky swing', () => {
  it('turns every seat about the shared axis, swings it out under the lateral g limit and sets the riders down', () => {
    const w = ring({ kind: 'swing', height: 20, radius: 4 });
    const p = w.sit(1); w.sit(3);
    w.h.run(TICKS(FUNFAIR.BOARD_S) + 2);
    const radii: number[] = [], azimuths: number[] = [], speeds: number[] = [];
    const pos: Array<[number, number]> = [];
    const total = TICKS(w.trip.duration);
    for (let i = 0; i < total; i++) {
      w.h.run(1);
      const s = w.seats[1]!.location;
      radii.push(Math.hypot(s.x - w.axis.x, s.z - w.axis.z));
      azimuths.push(Math.atan2(s.z - w.axis.z, s.x - w.axis.x));
      pos.push([s.x, s.z]);
    }
    // At full speed the seat hangs out past the ring, by about the chain's sine at the limit angle.
    const chain = Math.max(FUNFAIR.SWING_CHAIN_MIN, FUNFAIR.SWING_CHAIN_PER_RADIUS * w.r0);
    expect(Math.max(...radii)).toBeCloseTo(w.r0 + chain * Math.sin(Math.atan(FUNFAIR.SWING_LATERAL_G)), 1);
    expect(radii[0]).toBeCloseTo(w.r0, 1);
    // It went round more than once, always the same way.
    let turned = 0;
    for (let i = 1; i < azimuths.length; i++) { let d = azimuths[i]! - azimuths[i - 1]!; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; expect(d).toBeGreaterThanOrEqual(-1e-9); turned += d; }
    expect(turned).toBeGreaterThan(Math.PI * 2);
    // The seat's own horizontal acceleration, measured from where the script put it each tick, stays within the limit.
    let peak = 0;
    for (let i = 2; i < pos.length; i++) {
      const ax = (pos[i]![0] - 2 * pos[i - 1]![0] + pos[i - 2]![0]) * 400, az = (pos[i]![1] - 2 * pos[i - 1]![1] + pos[i - 2]![1]) * 400;
      peak = Math.max(peak, Math.hypot(ax, az) / FUNFAIR.GRAVITY);
    }
    expect(peak).toBeLessThanOrEqual(FUNFAIR.SWING_LATERAL_G * 1.05);
    expect(peak).toBeGreaterThan(FUNFAIR.SWING_LATERAL_G * 0.9);
    w.h.run(TICKS(1) + 10);
    expect(p.ridingOn).toBeUndefined();
    expect(Math.hypot(p.location.x - w.axis.x, p.location.z - w.axis.z)).toBeGreaterThan(w.r0 + 0.5);
    expect(p.location.y).toBeCloseTo(1, 6);
    expect(w.seats[1]!.location.y).toBeCloseTo(w.foot, 6);
  });
});

describe('boarding by a tap', () => {
  const touches = (w: ReturnType<typeof ring>, player: SimEntity) => ({
    tap: (target: SimEntity) => { w.h.engine.emit('entityHitEntity', { damagingEntity: player, hitEntity: target }); w.h.run(1); },
  });
  it('a tap on a seat, or on the ring (the nearest free seat), seats the child; a tap on a prop or a running ride does nothing', () => {
    const w = ring({ kind: 'drop' });
    const a = w.h.addPlayer('A', { x: 4.5, y: 1, z: 0.5 });
    const b = w.h.addPlayer('B', { x: 0.5, y: 1, z: 4.5 });
    touches(w, a).tap(w.seats[0]!);
    expect(w.seats[0]!.riderList()).toEqual([a]);
    // B taps the ring: the free seat nearest B is seat 1 (at +z).
    touches(w, b).tap(w.car);
    expect(w.seats[1]!.riderList()).toEqual([b]);
    // A prop boards nothing.
    const c = w.h.addPlayer('C', { x: 0.5, y: 1, z: -4.5 });
    touches(w, c).tap(w.h.spawn(OTHER, w.car.location));
    expect(w.seats.map(s => s.riderList().length)).toEqual([1, 1, 0, 0]);
    // Once it is running nobody can be added to it.
    w.h.run(TICKS(FUNFAIR.BOARD_S) + 40);
    touches(w, c).tap(w.seats[2]!);
    expect(w.seats[2]!.riderList()).toEqual([]);
  });
});

describe('the script', () => {
  it('serialises into a module that names only Script API globals', () => {
    const src = funfairScript({ seatType: 'x:y', rides: [{ kind: 'drop' }], constants: FUNFAIR });
    expect(src).toMatch(/^import \{ world, system \} from '@minecraft\/server';/);
    expect(() => new Function('world', 'system', src.replace(/^import.*\n/, ''))).not.toThrow();
  });
});
