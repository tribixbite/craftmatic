/**
 * The funfair rides' physics (engine/rides/funfair-physics.ts, BIZ-20): the drop tower's lift, hold, near
 * free fall and magnetic brake, and the sky swing's lift, spin-up and outward swing under a lateral g limit.
 * Pure functions of time; the sizes are checked with the wand factor `f` because every length scales with it
 * and no time does.
 */
import { describe, expect, it } from 'vitest';
import { FUNFAIR, funfairKit, type Trip } from '../web/src/engine/rides/funfair-physics.js';

const kit = funfairKit(FUNFAIR);
const DT = 0.01;
/** Every state of a trip, `DT` apart, from 0 to a second past its end. */
const sample = (trip: Trip) => Array.from({ length: Math.ceil((trip.duration + 1) / DT) }, (_, i) => trip.at(i * DT));
const G = FUNFAIR.GRAVITY;

describe('drop tower', () => {
  const H = 100;
  const trip = kit.drop(H, 1);

  it('lifts slowly to the top, holds there, falls at nearly g, brakes to rest exactly at the foot', () => {
    const s = sample(trip);
    expect(trip.duration).toBeGreaterThan(30);
    expect(s[0]!.rise).toBe(0);
    expect(Math.max(...s.map(x => x.rise))).toBeCloseTo(H, 6);
    expect(s[s.length - 1]!.rise).toBeCloseTo(0, 6);
    const phases = s.map(x => x.phase).filter((p, i, a) => i === 0 || p !== a[i - 1]);
    expect(phases).toEqual(['lift', 'hold', 'fall', 'brake', 'rest']);
    // The lift never runs faster than its speed.
    const lift = s.filter(x => x.phase === 'lift');
    expect(Math.max(...lift.map(x => Math.abs(x.speed)))).toBeLessThanOrEqual(FUNFAIR.DROP_LIFT_SPEED + 1e-9);
  });

  it('falls with the documented fraction of g, so the rider is nearly weightless', () => {
    const s = sample(trip).filter(x => x.phase === 'fall');
    for (const x of s.slice(1, -1)) expect(x.aVert).toBeCloseTo(-FUNFAIR.DROP_FALL_FRACTION * G, 6);
  });

  it('brakes at the documented g and no harder: the peak load is 1 + DROP_BRAKE_G', () => {
    const s = sample(trip);
    const peak = Math.max(...s.map(x => x.aVert / G + 1));
    expect(peak).toBeCloseTo(1 + FUNFAIR.DROP_BRAKE_G, 1);
    expect(peak).toBeLessThanOrEqual(1 + FUNFAIR.DROP_BRAKE_G + 0.05);
    // And the brake is a smooth stop: speed reaches 0 where the position reaches the foot.
    const brake = s.filter(x => x.phase === 'brake');
    // Under one sample of the brake from rest.
    expect(Math.abs(brake[brake.length - 1]!.speed)).toBeLessThan(FUNFAIR.DROP_BRAKE_G * G * DT * 1.01);
  });

  it('scales every length by the wand factor and no time', () => {
    for (const f of [0.25, 1, 2, 4]) {
      const t = kit.drop(H * f, f);
      expect(t.duration).toBeCloseTo(trip.duration, 6);
      for (const sec of [5, 20, 31, 33, 34.5]) expect(t.at(sec).rise / f).toBeCloseTo(trip.at(sec).rise, 6);
    }
  });
});

describe('sky swing', () => {
  const H = 60, R0 = 4;
  const trip = kit.swing(H, R0, 1);

  it('lifts, spins up, swings out at full speed, spins down and lowers back to the foot', () => {
    const s = sample(trip);
    const phases = s.map(x => x.phase).filter((p, i, a) => i === 0 || p !== a[i - 1]);
    expect(phases).toEqual(['lift', 'spinup', 'full', 'spindown', 'lower', 'rest']);
    expect(Math.max(...s.map(x => x.rise))).toBeCloseTo(H, 6);
    expect(s[s.length - 1]!.rise).toBeCloseTo(0, 6);
    expect(s[s.length - 1]!.out).toBeCloseTo(0, 6);
  });

  it('never exceeds the lateral g limit, and reaches it at full extension', () => {
    const s = sample(trip);
    const peak = Math.max(...s.map(x => x.aHoriz / G));
    expect(peak).toBeLessThanOrEqual(FUNFAIR.SWING_LATERAL_G + 1e-3);
    expect(peak).toBeGreaterThan(FUNFAIR.SWING_LATERAL_G - 0.02);
    const full = s.filter(x => x.phase === 'full');
    // The chair hangs out at atan(limit) from the vertical and swings out by L sin(tilt) beyond the ring.
    const chain = Math.max(FUNFAIR.SWING_CHAIN_MIN, FUNFAIR.SWING_CHAIN_PER_RADIUS * R0);
    expect(full[0]!.tilt).toBeCloseTo(Math.atan(FUNFAIR.SWING_LATERAL_G), 2);
    expect(full[0]!.out).toBeCloseTo(chain * Math.sin(full[0]!.tilt), 2);
    expect(full[0]!.sag).toBeCloseTo(chain * (1 - Math.cos(full[0]!.tilt)), 2);
  });

  it('the swing out is a physical balance: tan(tilt) = omega^2 R / g at every moment of the spin', () => {
    for (const x of sample(trip).filter(y => y.omega > 0.05)) {
      const radius = R0 + x.out;
      expect(Math.tan(x.tilt)).toBeCloseTo(x.omega * x.omega * radius / G, 3);
    }
  });

  it('turns a whole number of revolutions, so the chairs and the ring end where they started', () => {
    for (const [h, r] of [[60, 4], [20, 3], [90, 6]] as const) {
      const t = kit.swing(h, r, 1);
      const end = t.at(t.duration).turn / (2 * Math.PI);
      expect(end).toBeCloseTo(Math.round(end), 9);
      expect(Math.round(end)).toBeGreaterThanOrEqual(1);
      // The hold at full speed is at least SWING_FULL_S.
      const full = sample(t).filter(x => x.phase === 'full').length * DT;
      expect(full).toBeGreaterThanOrEqual(FUNFAIR.SWING_FULL_S - 2 * DT);
    }
  });

  it('turns by the integral of omega and the limit holds at every wand size (omega does not depend on size)', () => {
    const s = sample(trip);
    let turn = 0;
    for (let i = 1; i < s.length; i++) turn += (s[i - 1]!.omega + s[i]!.omega) / 2 * DT;
    expect(s[s.length - 1]!.turn).toBeCloseTo(turn, 1);
    for (const f of [0.25, 2, 4]) {
      const t = kit.swing(H * f, R0 * f, f);
      expect(t.duration).toBeCloseTo(trip.duration, 6);
      expect(Math.max(...sample(t).map(x => x.aHoriz / (G * f)))).toBeLessThanOrEqual(FUNFAIR.SWING_LATERAL_G + 1e-3);
      expect(t.at(trip.duration * 0.5).omega).toBeCloseTo(trip.at(trip.duration * 0.5).omega, 6);
    }
  });
});
