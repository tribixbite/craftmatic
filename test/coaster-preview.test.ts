/**
 * The add-on walk preview's ride-car animation (web/src/engine/coaster-preview.ts):
 * a plain per-tick stepper over the SAME `COASTER_PHYSICS` constants and
 * `coasterTrackUps` function the real pack's `scripts/coaster.js` uses
 * (bedrock-coaster.ts), so a preview-side regression here is a regression in
 * numbers the device also runs. See that module's header for what is a
 * faithful mirror (single-train integration, station brake/dwell, chain lift)
 * versus a stated simplification (a second train's dispatch; the platform
 * lift's exact path-splicing hand-off).
 */
import { describe, expect, it } from 'vitest';
import {
  coasterCarEyePoint, initCoasterPreviewState, stepCoasterPreviewTick,
  type CoasterPreviewRouteInput,
} from '../web/src/engine/coaster-preview.js';
import { COASTER_PHYSICS } from '../web/src/engine/bedrock-coaster.js';

/**
 * A closed loop with a flat station (arc 0-5), a steep climb (arc 5-17, grade
 * ~0.866 — well past `LIFT_GRADE` 0.08), a matching descent (arc 17-29) and a
 * flat return leg (arc 29-46) that closes back on the station. Every step is
 * exactly 1 model block, so arc distances land on round numbers.
 */
function hillLoop(): CoasterPreviewRouteInput {
  const points: Array<[number, number, number]> = [];
  for (let x = 0; x <= 5; x++) points.push([x, 0, 0]);
  const dxUp = 0.5, dyUp = Math.sqrt(1 - dxUp * dxUp);
  for (let i = 1; i <= 12; i++) points.push([5 + i * dxUp, i * dyUp, 0]);
  const top = points[points.length - 1]!;
  for (let i = 1; i <= 12; i++) points.push([top[0] + i * dxUp, top[1] - i * dyUp, 0]);
  const bottom = points[points.length - 1]!;
  for (let i = 1; i <= 17; i++) points.push([bottom[0] - i, 0, 0]);
  // Close exactly onto the first point.
  points[points.length - 1] = [...points[0]!];
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return {
    points, cumulative, length: cumulative[cumulative.length - 1]!, closed: true,
    station: { start: 0, end: 5, stop: 2.5 },
    chain: { start: 5, end: 17 },
    cars: { count: 1, spacing: 0, extent: 0 },
  };
}

/**
 * The same station-climb-descent shape, but OPEN (a platform lift "belongs to
 * an open route", per bedrock-coaster.ts) and without the return leg: arc 0 is
 * the deck/station end, arc 29 the far dead-end at the bottom of the descent.
 * Departing the station (direction +1) climbs and descends to the far end,
 * bounces, and comes back down (direction -1) to brake into the deck.
 */
function liftLoop(): CoasterPreviewRouteInput {
  const points: Array<[number, number, number]> = [];
  for (let x = 0; x <= 5; x++) points.push([x, 0, 0]);
  const dxUp = 0.5, dyUp = Math.sqrt(1 - dxUp * dxUp);
  for (let i = 1; i <= 12; i++) points.push([5 + i * dxUp, i * dyUp, 0]);
  const top = points[points.length - 1]!;
  for (let i = 1; i <= 12; i++) points.push([top[0] + i * dxUp, top[1] - i * dyUp, 0]);
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return {
    points, cumulative, length: cumulative[cumulative.length - 1]!, closed: false,
    station: { start: 0, end: 5, stop: 2.5 },
    lift: { deckLength: 2, travel: [0, 10, 0], parkedPoint: [0, 0, 0] },
    cars: { count: 1, spacing: 0, extent: 0 },
  };
}

function run(route: CoasterPreviewRouteInput, ticks: number, scale = 1) {
  let state = initCoasterPreviewState(route);
  const history: typeof state[] = [state];
  const frames: ReturnType<typeof stepCoasterPreviewTick>['frames'][] = [];
  for (let i = 0; i < ticks; i++) {
    const r = stepCoasterPreviewTick(route, state, scale);
    state = r.state;
    history.push(state);
    frames.push(r.frames);
  }
  return { state, history, frames };
}

describe('initCoasterPreviewState', () => {
  it('parks the train at the station, dwelling as a newly-placed empty train does', () => {
    const s = initCoasterPreviewState(hillLoop());
    expect(s.centre).toBe(2.5);
    expect(s.speed).toBe(0);
    expect(s.dwell).toBe(COASTER_PHYSICS.DWELL_EMPTY);
    expect(s.phase).toBe('track');
  });
});

describe('stepCoasterPreviewTick — riderless default motion', () => {
  const route = hillLoop();

  it('does not move during the initial dwell, then departs on its own with no rider input', () => {
    const { history } = run(route, COASTER_PHYSICS.DWELL_EMPTY - 1);
    for (const s of history) expect(s.speed).toBe(0);
    const { state: departed } = run(route, COASTER_PHYSICS.DWELL_EMPTY + 1);
    expect(departed.speed).toBeGreaterThan(0);
    expect(departed.centre).not.toBe(2.5);
  });

  it('returns frames.length === cars.count with finite positions every tick', () => {
    const { frames } = run(route, 300);
    for (const f of frames) {
      expect(f).toHaveLength(1);
      const [x, y, z] = f[0]!.position;
      expect(Number.isFinite(x)).toBe(true); expect(Number.isFinite(y)).toBe(true); expect(Number.isFinite(z)).toBe(true);
    }
  });

  it('the chain lift holds the climb near LIFT_SPEED', () => {
    // Run past the initial dwell so the train is moving, then keep going until
    // it is somewhere on the climb (arc 5..17) and sample speed there.
    let state = initCoasterPreviewState(route);
    let sawClimbSpeed: number | null = null;
    for (let i = 0; i < 400 && sawClimbSpeed === null; i++) {
      const r = stepCoasterPreviewTick(route, state, 1);
      state = r.state;
      if (state.centre > 8 && state.centre < 15) sawClimbSpeed = state.speed;
    }
    expect(sawClimbSpeed).not.toBeNull();
    // The chain never exceeds LIFT_SPEED and pulls a slower car up to it.
    expect(sawClimbSpeed as number).toBeLessThanOrEqual(COASTER_PHYSICS.LIFT_SPEED + 1e-6);
    expect(sawClimbSpeed as number).toBeGreaterThan(COASTER_PHYSICS.MIN_SPEED);
  });

  it('gains speed on the descent and brakes back toward zero approaching the station', () => {
    let state = initCoasterPreviewState(route);
    let peakDescentSpeed = 0;
    let arrivedBack = false;
    for (let i = 0; i < 2000 && !arrivedBack; i++) {
      const r = stepCoasterPreviewTick(route, state, 1);
      state = r.state;
      if (state.centre > 20 && state.centre < 27) peakDescentSpeed = Math.max(peakDescentSpeed, state.speed);
      if (state.dwell === COASTER_PHYSICS.DWELL_EMPTY && i > 200) arrivedBack = true;
    }
    expect(arrivedBack).toBe(true);
    // A 5-block near-vertical drop under gravity comfortably clears chain speed.
    expect(peakDescentSpeed).toBeGreaterThan(COASTER_PHYSICS.LIFT_SPEED);
    expect(state.speed).toBe(0);
  });

  it('never exceeds MAX_SPEED', () => {
    const { history } = run(route, 2000);
    for (const s of history) expect(s.speed).toBeLessThanOrEqual(COASTER_PHYSICS.MAX_SPEED + 1e-9);
  });

  it('reports moving=false only while dwelling', () => {
    const { state, frames } = run(hillLoop(), COASTER_PHYSICS.DWELL_EMPTY - 5);
    expect(state.dwell).toBeGreaterThan(0);
    expect(frames.at(-1)![0]!.moving).toBe(false);
  });
});

describe('stepCoasterPreviewTick — a route with a platform lift', () => {
  const route = liftLoop();

  it('cycles track -> lifting -> delivered -> track without ever stalling permanently', () => {
    let state = initCoasterPreviewState(route);
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      const r = stepCoasterPreviewTick(route, state, 1);
      state = r.state;
      seen.add(state.phase);
    }
    expect(seen.has('lifting')).toBe(true);
    expect(seen.has('delivered')).toBe(true);
    // It must have gone back to ordinary track running after being delivered
    // at least once (i.e. it is not permanently stuck at the deck).
    expect(state.speed).toBeGreaterThanOrEqual(0);
  });

  it('the deck progress only ever runs 0..1', () => {
    let state = initCoasterPreviewState(route);
    for (let i = 0; i < 4000; i++) {
      const r = stepCoasterPreviewTick(route, state, 1);
      state = r.state;
      expect(state.liftProgress).toBeGreaterThanOrEqual(0);
      expect(state.liftProgress).toBeLessThanOrEqual(1);
    }
  });
});

describe('coasterCarEyePoint', () => {
  it('with no measured seat, sits the eye straight up the car\'s own up vector', () => {
    const frame = { slot: 0, position: [1, 2, 3] as const, yaw: 0, pitch: 0, roll: 0, up: [0, 1, 0] as const, moving: true };
    const eye = coasterCarEyePoint(frame, undefined);
    expect(eye[0]).toBeCloseTo(1);
    expect(eye[1]).toBeCloseTo(2 + COASTER_PHYSICS.RIDER_EYE);
    expect(eye[2]).toBeCloseTo(3);
  });

  it('is exactly the position plus RIDER_EYE up when the seat offset is zero', () => {
    const frame = { slot: 0, position: [0, 0, 0] as const, yaw: 45, pitch: 10, roll: 5, up: [0, 1, 0] as const, moving: true };
    const eye = coasterCarEyePoint(frame, [0, 0, 0]);
    expect(eye[1]).toBeCloseTo(COASTER_PHYSICS.RIDER_EYE);
  });
});
