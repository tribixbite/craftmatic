/**
 * Pinball PHYSICS, shared by the Bedrock add-on runtime and the tests.
 *
 * `createPinballSim` is SELF-CONTAINED on purpose: the add-on serialises it
 * with `.toString()` into the behaviour pack's script, so it may not reference
 * an import, a module-level constant or another function of this file. Every
 * helper lives inside it.
 *
 * Units are the table's plane coordinates (engine/pinball-table.ts): LDU, with
 * `u` DOWN the table toward the player and `w` across it, and seconds. The
 * constants are GAME units, not the model's real scale: a real 19 mm ball on
 * an 8.45 degree LEGO playfield accelerates at ~3,600 LDU/s2 and crosses the
 * table in about 0.7 s, which at Bedrock's 20 ticks a second is a ball that
 * jumps 1.8 blocks per frame. Time runs at ~0.55x instead (gravity scaled by
 * its square), so a ball falls the 920 LDU table in ~1.3 s and a flipper shot
 * climbs it with room to spare.
 *
 * The ball is a disc of radius `ballRadius` sliding in the plane. It collides
 * with:
 *   - the STATIC field through the signed distance field (bilinear sample,
 *     central-difference normal), restitution `wallBounce`;
 *   - FLIPPERS as capsules swinging about their pivots; the contact carries
 *     the flipper's own surface velocity, which is what makes a shot;
 *   - BUMPERS as circles that kick the ball off at `bumperKick` and score.
 * Each 20 Hz tick is split into `substeps` so no step moves the ball more than
 * a fraction of its radius.
 */

/** What the simulation needs from a detected table (plain JSON; no typed arrays). */
export interface PinballSimTable {
  u0: number; w0: number; cell: number; rows: number; cols: number;
  /** Signed distance per cell, LDU x 2, row-major. */
  sdf2: number[];
  ballRadius: number;
  flippers: Array<{ side: 'left' | 'right'; pivot: [number, number]; length: number; pivotRadius: number; tipRadius: number; restAngle: number; activeAngle: number }>;
  bumpers: Array<{ centre: [number, number]; radius: number }>;
  launch: [number, number];
  /** Unit direction the plunger fires in; defaults to straight up the table. */
  launchDir?: [number, number];
  drainU: number;
  /**
   * The across-table span (w) where crossing `drainU` loses the ball: the gap
   * between and around the flippers. Outside it — a shooter lane that runs
   * below the flipper line, as 11374's does — the ball is still in play.
   * Absent: the whole width drains.
   */
  drainSpan?: [number, number];
}

export interface PinballSimOptions {
  gravity?: number;          // LDU/s2 along +u
  substeps?: number;
  wallBounce?: number;
  flipperBounce?: number;
  flipperUpSpeed?: number;   // rad/s
  flipperDownSpeed?: number; // rad/s
  bumperKick?: number;       // LDU/s leaving a bumper
  launchMin?: number;        // LDU/s at zero charge
  launchMax?: number;        // LDU/s at full charge
  chargeSeconds?: number;    // hold time for full charge
  maxSpeed?: number;
  balls?: number;
}

export interface PinballInput { left: boolean; right: boolean; launch: boolean }

export type PinballPhase = 'ready' | 'play' | 'over';

export interface PinballEvent { kind: 'bumper' | 'drain' | 'launch' | 'flipper' | 'over' | 'rescue' | 'kickout' | 'return'; at?: [number, number]; score?: number }

export interface PinballState {
  u: number; w: number; vu: number; vw: number;
  phase: PinballPhase;
  charge: number;
  score: number;
  ball: number;          // 1-based ball in play
  balls: number;
  flipperAngles: number[];
  time: number;
}

export interface PinballSim {
  readonly state: PinballState;
  /** Advance one tick of `dt` seconds (0.05 in game). Returns what happened. */
  step(input: PinballInput, dt: number): PinballEvent[];
  /** A fresh game: score 0, ball 1 on the launcher. */
  reset(): void;
  /** Signed distance at a plane point (for tests and diagnostics). */
  distance(u: number, w: number): number;
}

export function createPinballSim(table: PinballSimTable, options: PinballSimOptions = {}): PinballSim {
  const G = options.gravity ?? 1100;
  const SUB = options.substeps ?? 12;
  const E_WALL = options.wallBounce ?? 0.5;
  const E_FLIP = options.flipperBounce ?? 0.3;
  const UP = options.flipperUpSpeed ?? 14;
  const DOWN = options.flipperDownSpeed ?? 7;
  const KICK = options.bumperKick ?? 900;
  const L_MIN = options.launchMin ?? 900;
  const L_MAX = options.launchMax ?? 1900;
  const CHARGE_S = options.chargeSeconds ?? 1;
  const V_MAX = options.maxSpeed ?? 2400;
  const BALLS = options.balls ?? 3;
  const R = table.ballRadius;
  const { u0, w0, cell, rows, cols, sdf2 } = table;

  const at = (r: number, c: number): number => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return -cell * 4;
    return sdf2[r * cols + c]! / 2;
  };
  /** Bilinear signed distance at a plane point. */
  const distance = (u: number, w: number): number => {
    const fr = (u - u0) / cell - 0.5, fc = (w - w0) / cell - 0.5;
    const r = Math.floor(fr), c = Math.floor(fc);
    const tr = fr - r, tc = fc - c;
    const a = at(r, c), b = at(r, c + 1), d = at(r + 1, c), e = at(r + 1, c + 1);
    return (a * (1 - tc) + b * tc) * (1 - tr) + (d * (1 - tc) + e * tc) * tr;
  };

  const state: PinballState = {
    u: table.launch[0], w: table.launch[1], vu: 0, vw: 0,
    phase: 'ready', charge: 0, score: 0, ball: 1, balls: BALLS,
    flipperAngles: table.flippers.map(f => f.restAngle),
    time: 0,
  };
  const flipperOmega = table.flippers.map(() => 0);
  const bumperCool = table.bumpers.map(() => 0);
  let launchHeld = false;
  // Seconds the ball has been nearly still in play. A table's basins (a
  // pocket closed on its downhill side) hold a ball for ever; a real machine
  // empties them with a saucer KICKOUT, and so does this: after STALL_S the
  // ball is fired back up the table and the player scores KICKOUT_SCORE.
  let stalled = 0;
  const STALL_S = 1.5;
  const KICKOUT_SCORE = 250;

  const serve = (): void => {
    stalled = 0;
    state.u = table.launch[0]; state.w = table.launch[1];
    state.vu = 0; state.vw = 0; state.charge = 0; state.phase = 'ready';
  };
  const reset = (): void => {
    state.score = 0; state.ball = 1; state.time = 0;
    serve();
  };

  /** Angle toward target at speed; returns the angular velocity used this substep. */
  const moveFlipper = (i: number, pressed: boolean, h: number): void => {
    const f = table.flippers[i]!;
    const target = pressed ? f.activeAngle : f.restAngle;
    // Angles are compared on the short way round.
    let diff = target - state.flipperAngles[i]!;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const speed = pressed ? UP : DOWN;
    const stepMax = speed * h;
    if (Math.abs(diff) <= stepMax) { state.flipperAngles[i] = target; flipperOmega[i] = diff / h; }
    else { state.flipperAngles[i] = state.flipperAngles[i]! + Math.sign(diff) * stepMax; flipperOmega[i] = Math.sign(diff) * speed; }
  };

  const collideFlipper = (i: number, events: PinballEvent[]): void => {
    const f = table.flippers[i]!;
    const th = state.flipperAngles[i]!;
    const du = Math.sin(th), dw = Math.cos(th);
    const pu = state.u - f.pivot[0], pw = state.w - f.pivot[1];
    const s = Math.max(0, Math.min(f.length, pu * du + pw * dw));
    const cu = f.pivot[0] + du * s, cw = f.pivot[1] + dw * s;
    const rad = f.pivotRadius + (f.tipRadius - f.pivotRadius) * (s / f.length);
    let nu = state.u - cu, nw = state.w - cw;
    const dist = Math.hypot(nu, nw);
    if (dist >= rad + R || dist < 1e-6) return;
    nu /= dist; nw /= dist;
    state.u += nu * (rad + R - dist);
    state.w += nw * (rad + R - dist);
    // The flipper surface moves at omega x r: d/dtheta of (sin, cos)*s is (cos, -sin)*s.
    const om = flipperOmega[i]!;
    const fu = om * s * Math.cos(th), fw = -om * s * Math.sin(th);
    const ru = state.vu - fu, rw = state.vw - fw;
    const vn = ru * nu + rw * nw;
    if (vn < 0) {
      state.vu -= (1 + E_FLIP) * vn * nu;
      state.vw -= (1 + E_FLIP) * vn * nw;
      if (Math.abs(om) > 1) events.push({ kind: 'flipper', at: [state.u, state.w] });
    }
  };

  const step = (input: PinballInput, dt: number): PinballEvent[] => {
    const events: PinballEvent[] = [];
    state.time += dt;
    if (state.phase === 'over') {
      // A fresh game starts on a launch press after game over.
      if (input.launch && !launchHeld) { reset(); }
      launchHeld = input.launch;
      return events;
    }
    const h = dt / SUB;
    for (let k = 0; k < bumperCool.length; k++) bumperCool[k] = Math.max(0, bumperCool[k]! - dt);

    if (state.phase === 'ready') {
      for (let i = 0; i < table.flippers.length; i++) {
        const pressed = table.flippers[i]!.side === 'left' ? input.left : input.right;
        for (let s = 0; s < SUB; s++) moveFlipper(i, pressed, h);
      }
      if (input.launch) state.charge = Math.min(1, state.charge + dt / CHARGE_S);
      if (!input.launch && launchHeld) {
        // Release: fire along the launch direction at a speed set by the charge.
        const dir = table.launchDir ?? [-1, 0];
        const speed = L_MIN + (L_MAX - L_MIN) * state.charge;
        state.vu = dir[0] * speed;
        state.vw = dir[1] * speed;
        state.phase = 'play';
        events.push({ kind: 'launch', at: [state.u, state.w] });
        state.charge = 0;
      }
      launchHeld = input.launch;
      return events;
    }
    launchHeld = input.launch;

    for (let s = 0; s < SUB; s++) {
      for (let i = 0; i < table.flippers.length; i++) {
        moveFlipper(i, table.flippers[i]!.side === 'left' ? input.left : input.right, h);
      }
      state.vu += G * h;
      const sp = Math.hypot(state.vu, state.vw);
      if (sp > V_MAX) { state.vu *= V_MAX / sp; state.vw *= V_MAX / sp; }
      state.u += state.vu * h;
      state.w += state.vw * h;

      // Static field.
      const d = distance(state.u, state.w);
      if (d < R) {
        const eps = cell * 0.5;
        let gu = distance(state.u + eps, state.w) - distance(state.u - eps, state.w);
        let gw = distance(state.u, state.w + eps) - distance(state.u, state.w - eps);
        const gl = Math.hypot(gu, gw);
        if (gl > 1e-9) {
          gu /= gl; gw /= gl;
          state.u += gu * (R - d);
          state.w += gw * (R - d);
          const vn = state.vu * gu + state.vw * gw;
          if (vn < 0) {
            state.vu -= (1 + E_WALL) * vn * gu;
            state.vw -= (1 + E_WALL) * vn * gw;
          }
        }
      }
      // Bumpers.
      for (let b = 0; b < table.bumpers.length; b++) {
        const bp = table.bumpers[b]!;
        let nu = state.u - bp.centre[0], nw = state.w - bp.centre[1];
        const dist = Math.hypot(nu, nw);
        if (dist >= bp.radius + R || dist < 1e-6) continue;
        nu /= dist; nw /= dist;
        state.u = bp.centre[0] + nu * (bp.radius + R);
        state.w = bp.centre[1] + nw * (bp.radius + R);
        const vn = state.vu * nu + state.vw * nw;
        const tu = state.vu - vn * nu, tw = state.vw - vn * nw;
        const out = Math.max(Math.abs(vn), KICK);
        state.vu = tu + nu * out;
        state.vw = tw + nw * out;
        if (bumperCool[b] === 0) {
          bumperCool[b] = 0.15;
          state.score += 100;
          events.push({ kind: 'bumper', at: [bp.centre[0], bp.centre[1]], score: state.score });
        }
      }
      // Flippers.
      for (let i = 0; i < table.flippers.length; i++) collideFlipper(i, events);
    }
    // Rolling drag, gentle.
    state.vu *= 1 - 0.08 * dt;
    state.vw *= 1 - 0.08 * dt;

    const nearPlunger = Math.hypot(state.u - table.launch[0], state.w - table.launch[1]) < R * 3;
    if (Math.hypot(state.vu, state.vw) < 40 && !nearPlunger) stalled += dt; else stalled = 0;
    if (stalled > STALL_S) {
      stalled = 0;
      // Deterministic side: alternate by the ball count and score.
      const side = (state.score / 250 + state.ball) % 2 < 1 ? -1 : 1;
      state.vu = -KICK;
      state.vw = side * KICK * 0.3;
      state.score += KICKOUT_SCORE;
      events.push({ kind: 'kickout', at: [state.u, state.w], score: state.score });
    }
    // Lost inside a solid (a tunnel through a thin wall): put it back on the launcher.
    if (distance(state.u, state.w) < -2 * R) {
      events.push({ kind: 'rescue', at: [state.u, state.w] });
      serve();
      return events;
    }
    // Back at the plunger and at rest (a weak launch that rolled back down the
    // lane, or a ball the return trough delivered): re-plunge, no ball lost.
    const atPlunger = Math.hypot(state.u - table.launch[0], state.w - table.launch[1]) < R * 2;
    if (atPlunger && Math.hypot(state.vu, state.vw) < 80) {
      serve();
      events.push({ kind: 'return', at: [state.u, state.w] });
      return events;
    }
    const span = table.drainSpan;
    if (state.u > table.drainU && (!span || (state.w >= span[0] && state.w <= span[1]))) {
      events.push({ kind: 'drain', at: [state.u, state.w], score: state.score });
      if (state.ball >= state.balls) {
        state.phase = 'over';
        events.push({ kind: 'over', score: state.score });
      } else {
        state.ball++;
        serve();
      }
    }
    return events;
  };

  return { state, step, reset, distance };
}
