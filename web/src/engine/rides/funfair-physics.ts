/**
 * The funfair rides' physics (BIZ-20, package RIDE): a DROP TOWER and a SKY SWING.
 *
 * Both are pure functions of the time since departure, in blocks and seconds, so the serialised runtime
 * (`funfair-runtime.ts`) and the tests evaluate the very same code (`funfairKit` is serialised with
 * `Function.prototype.toString`, as `hopKit` and `colliderBodyProbe` are: it names nothing but its argument).
 *
 * UNITS. One block is one metre (the player is 1.8 blocks tall), so `GRAVITY` is the real 9.81. Every LENGTH,
 * speed and acceleration scales with the wand factor `f` (a ride placed at 200 % is twice as tall, so it falls
 * and swings at twice the blocks/s and the riders feel the same g); no TIME and no angular speed does, so a
 * ride takes the same seconds at every wand size.
 *
 * DROP TOWER. A trapezoid lift to the top (`DROP_LIFT_SPEED`, `DROP_LIFT_ACCEL`), a hold (the view), then a
 * fall at `DROP_FALL_FRACTION` of g (rail and air drag: "near free fall", riders feel 0.1 g), then a MAGNETIC
 * BRAKE over the last `L` blocks that stops the car exactly at the foot at a constant deceleration
 * `DROP_BRAKE_G` x g (an eddy-current brake is nearer v-proportional, but a constant deceleration is the
 * gentlest profile for a given stopping distance and the peak rider load is then exactly 1 + `DROP_BRAKE_G`
 * g, which the tests pin). With fall acceleration `a` and brake deceleration `b` over a tower `H`, the car
 * reaches the brake at v^2 = 2 a (H - L) and stops in `L` when v^2 = 2 b L, so L = H a / (a + b).
 *
 * SKY SWING. A trapezoid lift, then the chair ring spins up to `omega_max` along a smoothstep (zero angular
 * acceleration at both ends, so no jolt), holds, spins down and lowers. Each chair hangs on a chain of length
 * `L = max(SWING_CHAIN_MIN f, SWING_CHAIN_PER_RADIUS r0)` and, in the rotating frame, balances at
 * `tan(tilt) = omega^2 R / g` with `R = r0 + L sin(tilt)` (quasi-static: the pendulum's own swing is ignored).
 * The LATERAL G LIMIT `SWING_LATERAL_G` is the horizontal acceleration the seat may feel as a multiple of g,
 * `omega^2 R = limit x g` at full speed, which fixes `omega_max` and `tilt = atan(limit)` (45 degrees at 1);
 * the tangential acceleration of the spin-up adds to it in quadrature, and stays far under the limit
 * because `SWING_SPINUP_S` is long (the tests measure the combined peak).
 */

/** Every tuned number of the funfair rides, with its unit. */
export const FUNFAIR = {
  /** Gravity, blocks/s^2 at 100 % (1 block = 1 m). */
  GRAVITY: 9.81,
  /** The drop's fall acceleration as a fraction of g: rail friction and air drag, so riders are nearly (not quite) weightless. */
  DROP_FALL_FRACTION: 0.9,
  /** The magnetic brake's constant deceleration, in g: the rider's peak load is 1 + this (a roller coaster's limit is about 4). */
  DROP_BRAKE_G: 3,
  /** The drop's lift speed, blocks/s at 100 %: slow enough to look down, a 100-block tower takes ~28 s. */
  DROP_LIFT_SPEED: 4,
  /** The lift's start/stop acceleration, blocks/s^2 at 100 %. */
  DROP_LIFT_ACCEL: 1.5,
  /** Seconds the car hangs at the top before it falls: the rider view. */
  DROP_HOLD_S: 3,
  /** Seconds the car rests at the foot before the riders are set down. */
  REST_S: 2,
  /** The swing's lift speed, blocks/s at 100 %. */
  SWING_LIFT_SPEED: 4,
  /** The swing lift's start/stop acceleration, blocks/s^2 at 100 %. */
  SWING_LIFT_ACCEL: 1.5,
  /** Lateral g limit of the swing: the most horizontal acceleration a seat feels, as a multiple of g (1 = a 45 degree chain, 1.41 g in all). */
  SWING_LATERAL_G: 1,
  /** Seconds to spin up to full speed (and, equally, to spin down). */
  SWING_SPINUP_S: 10,
  /** Seconds the ring turns at full speed with the chairs out, at least: the hold is stretched to a whole number of revolutions. */
  SWING_FULL_S: 12,
  /** A chair chain, as a fraction of the ring radius. */
  SWING_CHAIN_PER_RADIUS: 0.9,
  /** A chair chain is at least this long, blocks at 100 %. */
  SWING_CHAIN_MIN: 2,
  /** Seconds the first rider seat waits for more riders before the ride departs. */
  BOARD_S: 6,
  /** Seconds before departure once every seat is taken. */
  BOARD_FULL_S: 1.5,
  /** A planned set-down point is lifted this far before finding a free standing spot, blocks (the slide's `SETDOWN_LIFT_BLOCKS`). */
  SETDOWN_LIFT_BLOCKS: 0.05,
  /** How far sideways the set-down searches for a free standing spot, blocks at 100 % (the slide's `SETDOWN_REACH_BLOCKS`). */
  SETDOWN_REACH_BLOCKS: 2,
  /** How far below the planned point the set-down may find a floor, blocks: the most a player falls unhurt (the slide's `SETDOWN_DROP_BLOCKS`). */
  SETDOWN_DROP_BLOCKS: 3,
  /** A seat belongs to a group of the same ride when its axis is within this of the first seat's, blocks at 100 %. */
  GROUP_AXIS_TOL_BLOCKS: 0.5,
  /** Ticks between two checks that a rider is still on their seat during a trip (one who steps off is put back). */
  KEEP_ABOARD_TICKS: 5,
  /** Ticks between two polls for a rider sitting on an idle seat (a tap boards at once; this catches `/ride` and the hold). */
  POLL_TICKS: 4,
  /** Ticks between two sweeps for idle seats left off their start (a reload mid-ride). */
  HOME_TICKS: 100,
} as const;
export type FunfairConstants = typeof FUNFAIR;

export type FunfairPhase = 'lift' | 'hold' | 'fall' | 'brake' | 'spinup' | 'full' | 'spindown' | 'lower' | 'rest';

/** A seat state `t` seconds after departure. Lengths in blocks, times in seconds. */
export interface TripState {
  phase: FunfairPhase;
  /** Height of the ring over its foot. */
  rise: number;
  /** Ring azimuth turned since departure, radians (a swing; 0 for a drop). */
  turn: number;
  /** A swing chair distance past the ring radius. */
  out: number;
  /** A swing chair height under the ring, from the chain swing. */
  sag: number;
  /** A swing chair chain angle from the vertical, radians. */
  tilt: number;
  /** Angular speed of the ring, rad/s. */
  omega: number;
  /** Vertical speed, blocks/s (up positive). */
  speed: number;
  /** Magnitude of the horizontal acceleration a seat feels, blocks/s^2. */
  aHoriz: number;
  /** Vertical acceleration of the seat, blocks/s^2 (up positive; free fall is -g). */
  aVert: number;
}

export interface Trip {
  /** Seconds from departure to the end of the rest at the foot. */
  duration: number;
  at(t: number): TripState;
}

export interface FunfairKit {
  /** A drop tower `height` blocks tall (world blocks, already scaled) at wand factor `f`. */
  drop(height: number, f: number): Trip;
  /** A swing whose ring rises `height` blocks, seats at radius `r0` (world blocks) at wand factor `f`. */
  swing(height: number, r0: number, f: number): Trip;
}

/**
 * The ride profiles for the constants `C`. Serialised into `scripts/rides-funfair.js`: it may use only its argument.
 */
export function funfairKit(C: FunfairConstants): FunfairKit {
  const zero = { turn: 0, out: 0, sag: 0, tilt: 0, omega: 0, aHoriz: 0 };
  /** A trapezoid move of `dist` at most `vmax` with ramps of `a`: its duration, and position / speed / acceleration at `t`. */
  const trapezoid = (dist: number, vmax: number, a: number) => {
    const ramp = vmax * vmax / a;
    const tri = dist < ramp; // too short to reach vmax: a triangle
    const vp = tri ? Math.sqrt(dist * a) : vmax;
    const tr = vp / a, cruise = tri ? 0 : (dist - ramp) / vmax, T = 2 * tr + cruise;
    const at = (t: number): { pos: number; vel: number; acc: number } => {
      if (t <= 0) return { pos: 0, vel: 0, acc: 0 };
      if (t >= T) return { pos: dist, vel: 0, acc: 0 };
      if (t < tr) return { pos: 0.5 * a * t * t, vel: a * t, acc: a };
      if (t < tr + cruise) return { pos: 0.5 * a * tr * tr + vp * (t - tr), vel: vp, acc: 0 };
      const u = T - t;
      return { pos: dist - 0.5 * a * u * u, vel: a * u, acc: -a };
    };
    return { T, at };
  };

  const drop = (height: number, f: number): Trip => {
    const g = C.GRAVITY * f, a = C.DROP_FALL_FRACTION * g, b = C.DROP_BRAKE_G * C.GRAVITY * f;
    const lift = trapezoid(height, C.DROP_LIFT_SPEED * f, C.DROP_LIFT_ACCEL * f);
    const brakeLen = height * a / (a + b);
    const freeLen = height - brakeLen;
    const tFree = Math.sqrt(2 * freeLen / a), vBrake = a * tFree, tBrake = 2 * brakeLen / vBrake;
    const t1 = lift.T, t2 = t1 + C.DROP_HOLD_S, t3 = t2 + tFree, t4 = t3 + tBrake, t5 = t4 + C.REST_S;
    return {
      duration: t5,
      at: (t: number): TripState => {
        if (t < t1) { const s = lift.at(t); return { phase: 'lift', rise: s.pos, speed: s.vel, aVert: s.acc, ...zero }; }
        if (t < t2) return { phase: 'hold', rise: height, speed: 0, aVert: 0, ...zero };
        if (t < t3) { const u = t - t2; return { phase: 'fall', rise: height - 0.5 * a * u * u, speed: -a * u, aVert: -a, ...zero }; }
        if (t < t4) { const u = t - t3; return { phase: 'brake', rise: brakeLen - (vBrake * u - 0.5 * b * u * u), speed: -(vBrake - b * u), aVert: b, ...zero }; }
        return { phase: 'rest', rise: 0, speed: 0, aVert: 0, ...zero };
      },
    };
  };

  const swing = (height: number, r0: number, f: number): Trip => {
    const g = C.GRAVITY * f, limit = C.SWING_LATERAL_G;
    const chain = Math.max(C.SWING_CHAIN_MIN * f, C.SWING_CHAIN_PER_RADIUS * r0);
    // Full speed: the chain at atan(limit), omega^2 R = limit g.
    const tiltMax = Math.atan(limit);
    const wMax = Math.sqrt(limit * g / (r0 + chain * Math.sin(tiltMax)));
    /** The chain angle at angular speed `w`: the fixed point of tan(tilt) = w^2 (r0 + L sin(tilt)) / g (a contraction at these sizes). */
    const tiltAt = (w: number): number => { let th = 0; for (let i = 0; i < 100; i++) th = Math.atan(w * w * (r0 + chain * Math.sin(th)) / g); return th; };
    const lift = trapezoid(height, C.SWING_LIFT_SPEED * f, C.SWING_LIFT_ACCEL * f);
    const Tu = C.SWING_SPINUP_S;
    // The ring turns a WHOLE number of revolutions, so the chairs come home at the azimuth they left from (the seats
    // and the ring stop where they started, with nothing to snap back): the full-speed hold is stretched to the next one.
    const revolutions = Math.max(1, Math.ceil(wMax * (Tu + C.SWING_FULL_S) / (2 * Math.PI)));
    const tFull = 2 * Math.PI * revolutions / wMax - Tu;
    // Smoothstep s(x) = 3x^2 - 2x^3, its integral S(x) = x^3 - x^4 / 2 and derivative 6x(1 - x).
    const S = (x: number): number => x * x * x - x * x * x * x / 2;
    const t1 = lift.T, t2 = t1 + Tu, t3 = t2 + tFull, t4 = t3 + Tu, t5 = t4 + lift.T, t6 = t5 + C.REST_S;
    const spin = (phase: FunfairPhase, rise: number, w: number, alpha: number, turn: number): TripState => {
      const tilt = tiltAt(w), radius = r0 + chain * Math.sin(tilt);
      return { phase, rise, turn, out: chain * Math.sin(tilt), sag: chain * (1 - Math.cos(tilt)), tilt, omega: w, speed: 0, aHoriz: radius * Math.sqrt(w ** 4 + alpha * alpha), aVert: 0 };
    };
    const turnTotal = 2 * Math.PI * revolutions;
    return {
      duration: t6,
      at: (t: number): TripState => {
        if (t < t1) { const s = lift.at(t); return { phase: 'lift', rise: s.pos, speed: s.vel, aVert: s.acc, ...zero }; }
        if (t < t2) { const x = (t - t1) / Tu; return spin('spinup', height, wMax * (3 * x * x - 2 * x * x * x), wMax * 6 * x * (1 - x) / Tu, wMax * Tu * S(x)); }
        if (t < t3) return spin('full', height, wMax, 0, wMax * Tu * S(1) + wMax * (t - t2));
        if (t < t4) {
          const x = (t - t3) / Tu, y = 1 - x;
          return spin('spindown', height, wMax * (3 * y * y - 2 * y * y * y), wMax * 6 * y * x / Tu, wMax * Tu * S(1) + wMax * tFull + wMax * Tu * (S(1) - S(y)));
        }
        if (t < t5) { const s = lift.at(t - t4); return { phase: 'lower', rise: height - s.pos, speed: -s.vel, aVert: -s.acc, ...zero, turn: turnTotal }; }
        return { phase: 'rest', rise: 0, speed: 0, aVert: 0, ...zero, turn: turnTotal };
      },
    };
  };

  return { drop, swing };
}
