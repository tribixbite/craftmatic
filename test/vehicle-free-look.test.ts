/**
 * Free look on a vehicle (web/src/engine/vehicle-free-look.ts): the pure
 * drag / ease-back model, and the shipped camera runtime
 * (`scripts/vehicle-camera.js`) on the headless simulator - a drag orbits the
 * chase camera, it holds at rest, it eases back behind the nose a second
 * after the last drag while the vehicle moves, the cockpit view is a camera at
 * the driver's eye that looks round and eases back to the front the same way,
 * and the view's pitch reaches the ship's "look down + Jump".
 */
import { describe, expect, it } from 'vitest';
import { FREE_LOOK, NATIVE_STEER, cockpitCamera, cockpitEyeLead, cockpitLagFromLead, freeLookStart, freeLookStep, nativeSteerStart, nativeSteerStep, type CockpitPose, type FreeLookState } from '../web/src/engine/vehicle-free-look.js';
import { quirkValue } from '../web/src/sim/quirks/registry.js';
import { CHASE_PASSABLE_BLOCKS, vehicleCameraScript, type VehicleCameraConfig } from '../web/src/engine/playable-addon.js';
import { FLIGHT_PROPS, VEHICLE_DYNAMIC, VEHICLE_TELEMETRY_EVENT, flightProperties } from '../web/src/engine/bedrock-vehicle.js';
import { simHost, solidBelow } from './_sim-host.js';
import type { SimEntity } from '../web/src/sim/entity/entity.js';

const DT = 0.05;
const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;

/** Run the pure model over per-tick readings; returns the states after each tick. */
function run(readings: Array<{ playerYaw: number; playerPitch?: number; vehicleYaw: number; speed: number }>, from: FreeLookState = freeLookStart()): FreeLookState[] {
  const out: FreeLookState[] = [];
  let s = from;
  for (const r of readings) { s = freeLookStep(s, { playerPitch: 0, ...r }, FREE_LOOK, DT).state; out.push(s); }
  return out;
}
const ticks = (n: number, f: (t: number) => { playerYaw: number; playerPitch?: number; vehicleYaw: number; speed: number }) => Array.from({ length: n }, (_, t) => f(t));

describe('free look (pure)', () => {
  it('a drag turns the view by the drag, at rest', () => {
    const s = run(ticks(11, t => ({ playerYaw: t * 5, vehicleYaw: 0, speed: 0 })));
    expect(s.at(-1)!.yaw).toBeCloseTo(50, 6);
  });
  it('a steady turn of the vehicle is no drag, whether the device carries the rider round with it (6 ticks late) or not', () => {
    const turn = (t: number): number => t * 3;
    // Carried, late by the quirk's lag.
    const carried = run(ticks(60, t => ({ playerYaw: turn(Math.max(0, t - FREE_LOOK.RIDER_YAW_LAG_TICKS)), vehicleYaw: turn(t), speed: 8 })));
    expect(Math.max(...carried.map(s => Math.abs(s.yaw)))).toBeLessThan(1);
    // Not carried: the rider's yaw stays where it was.
    const still = run(ticks(60, t => ({ playerYaw: 0, vehicleYaw: turn(t), speed: 8 })));
    expect(Math.max(...still.map(s => Math.abs(s.yaw)))).toBeLessThan(1e-9);
  });
  it('holds the view where the child left it at rest, and eases it back behind the nose a second after the last drag while moving', () => {
    const dragged = run(ticks(11, t => ({ playerYaw: t * 6, playerPitch: t * 3, vehicleYaw: 0, speed: 0 })));
    const at = dragged.at(-1)!;
    expect(at.yaw).toBeCloseTo(60, 6);
    expect(at.pitch).toBeCloseTo(30, 6);
    // At rest: 3 s later it has not moved.
    const rest = run(ticks(60, () => ({ playerYaw: 60, playerPitch: 30, vehicleYaw: 0, speed: 0 })), at);
    expect(rest.at(-1)!.yaw).toBeCloseTo(60, 6);
    // Moving: nothing for IDLE_TICKS, then 95 % back within three time constants.
    const moving = run(ticks(80, () => ({ playerYaw: 60, playerPitch: 30, vehicleYaw: 0, speed: 8 })), { ...at, idle: 0 });
    expect(moving[FREE_LOOK.IDLE_TICKS - 2]!.yaw).toBeCloseTo(60, 6);
    const settle = FREE_LOOK.IDLE_TICKS + Math.ceil(3 * FREE_LOOK.RECENTRE_SECONDS / DT);
    expect(Math.abs(moving[settle]!.yaw)).toBeLessThan(60 * 0.05 + FREE_LOOK.MIN_STEP_DEG);
    expect(moving.at(-1)!).toMatchObject({ yaw: 0, pitch: 0 });
  });
  it('a new drag stops the ease at once and moves the view from where it is', () => {
    const at: FreeLookState = { ...run(ticks(2, () => ({ playerYaw: 0, vehicleYaw: 0, speed: 8 })))[1]!, yaw: 40, idle: 100 };
    const s = run([{ playerYaw: 0, vehicleYaw: 0, speed: 8 }, { playerYaw: -10, vehicleYaw: 0, speed: 8 }, { playerYaw: -20, vehicleYaw: 0, speed: 8 }], at);
    // The first tick eased (idle), the next two dragged 10 each.
    expect(s[0]!.yaw).toBeLessThan(40);
    expect(s[2]!.yaw).toBeCloseTo(s[0]!.yaw - 20, 6);
    expect(s[2]!.idle).toBe(0);
  });
  it('clamps the dragged pitch', () => {
    const s = run(ticks(40, t => ({ playerYaw: 0, playerPitch: t * 5, vehicleYaw: 0, speed: 0 })));
    expect(s.at(-1)!.pitch).toBe(FREE_LOOK.PITCH_DOWN_MAX);
  });
});

describe('a mount\'s settle (pure; Saga 30k: the chase camera opened where the player had been looking)', () => {
  it('the seat turning the rider onto the heading is no drag, in one step or eased (CMCAM riderYaw 0 -> -180; 54.8 -> -82.8 -> -90)', () => {
    // X-wing at -180: the rider climbed on looking along 0, the seat turned them half round 4 ticks later.
    const snap = run([...ticks(4, () => ({ playerYaw: 0, vehicleYaw: -180, speed: 0 })), ...ticks(6, () => ({ playerYaw: -180, vehicleYaw: -180, speed: 0 }))], freeLookStart(FREE_LOOK.MOUNT_SETTLE_TICKS));
    for (const s of snap) expect(s.yaw).toBe(0);
    // X-wing at -90, the turn eased over a few ticks.
    const eased = run([54.8, -82.8, -88.6, -89.8, -90, -90, -90].map(playerYaw => ({ playerYaw, vehicleYaw: -90, speed: 0 })), freeLookStart(FREE_LOOK.MOUNT_SETTLE_TICKS));
    for (const s of eased) expect(s.yaw).toBe(0);
    // Once it has landed, a drag is read again at once.
    const after = run(ticks(5, t => ({ playerYaw: -90 + 5 * (t + 1), vehicleYaw: -90, speed: 0 })), eased.at(-1));
    expect(after.at(-1)!.yaw).toBeCloseTo(25, 6);
    // Without the settle (a switch of view) the same turn WAS read as a drag of 180 degrees: the 30k fault.
    expect(Math.abs(run([...ticks(4, () => ({ playerYaw: 0, vehicleYaw: -180, speed: 0 })), ...ticks(2, () => ({ playerYaw: -180, vehicleYaw: -180, speed: 0 }))]).at(-1)!.yaw)).toBe(180);
  });
  it('a rider never turned onto the heading reads drags again once the settle runs out', () => {
    const s = run(ticks(FREE_LOOK.MOUNT_SETTLE_TICKS + 1, () => ({ playerYaw: 40, vehicleYaw: 0, speed: 0 })), freeLookStart(FREE_LOOK.MOUNT_SETTLE_TICKS));
    expect(s.at(-1)!.settle ?? 0).toBe(0);
    expect(run(ticks(3, t => ({ playerYaw: 40 + 5 * (t + 1), vehicleYaw: 0, speed: 0 })), s.at(-1)).at(-1)!.yaw).toBeCloseTo(15, 6);
  });
});

describe('the cockpit eye\'s lag (pure; Saga 30k: the eye ran ahead of the drawn seat at speed; Saga 30l: behind it)', () => {
  const MPH = 2.236936;
  /**
   * The four device readings, each the eye's lead over the drawn seat bracketed by matching the frame to the offline
   * cockpit picture at half-block eye shifts (`_cockpit_view.ts --shift`; +-0.3 block of read). Round 30k ran the
   * camera at the coaster's 1.5, round 30l at 4.
   */
  const READINGS = [
    { name: 'McLaren 30k', lag: 1.5, mph: 43, lead: [1.5, 2.5] },   // over the hood (the notes' 2.3-3.0 was high: +2.5 shows sky alone)
    { name: 'X-wing 30k', lag: 1.5, mph: 40, lead: [1.5, 2.0] },    // up the nose, the canopy pair close
    { name: 'McLaren 30l', lag: 4, mph: 43, lead: [-1.3, -0.7] },   // the grey pillars behind the cabin, the hood through the gap
    { name: 'X-wing 30l', lag: 4, mph: 40, lead: [-1.55, -0.95] },  // flat grey faces inside the fuselage
  ] as const;
  const READ_SLACK_BLOCKS = 0.3;
  it('the device readings at the coaster\'s 1.5 put the lag that keeps the eye on the seat in a bracket COCKPIT_TICK_LAG sits in, and the 30l readings at 4 another: 3 is inside or at the edge of all four', () => {
    const brackets = READINGS.map(r => ({ ...r, lo: cockpitLagFromLead(r.lag, r.mph / MPH, r.lead[0]), hi: cockpitLagFromLead(r.lag, r.mph / MPH, r.lead[1]) }));
    const b = Object.fromEntries(brackets.map(r => [r.name, r]));
    expect(b['McLaren 30k']!.lo).toBeCloseTo(3.06, 2); expect(b['McLaren 30k']!.hi).toBeCloseTo(4.10, 2);
    expect(b['X-wing 30k']!.lo).toBeCloseTo(3.18, 2); expect(b['X-wing 30k']!.hi).toBeCloseTo(3.74, 2);
    expect(b['McLaren 30l']!.lo).toBeCloseTo(2.65, 2); expect(b['McLaren 30l']!.hi).toBeCloseTo(3.27, 2);
    expect(b['X-wing 30l']!.lo).toBeCloseTo(2.27, 2); expect(b['X-wing 30l']!.hi).toBeCloseTo(2.94, 2);
    // The chosen lag is within a read's slack of every bracket (the 30k and 30l brackets do not overlap exactly:
    // 3.18 against 2.94), and nearer their common centre than either round's old value.
    for (const r of brackets) {
      const slack = READ_SLACK_BLOCKS / (r.mph / MPH / 20);
      expect(FREE_LOOK.COCKPIT_TICK_LAG).toBeGreaterThanOrEqual(r.lo - slack);
      expect(FREE_LOOK.COCKPIT_TICK_LAG).toBeLessThanOrEqual(r.hi + slack);
    }
    const centre = brackets.reduce((a, r) => a + (r.lo + r.hi) / 2, 0) / brackets.length;
    expect(Math.abs(FREE_LOOK.COCKPIT_TICK_LAG - centre)).toBeLessThan(0.5);
    expect(Math.abs(4 - centre)).toBeGreaterThan(Math.abs(FREE_LOOK.COCKPIT_TICK_LAG - centre));
    expect(Math.abs(1.5 - centre)).toBeGreaterThan(Math.abs(FREE_LOOK.COCKPIT_TICK_LAG - centre));
    // The quirk the simulator judges by is the same number, and a reading at rest says nothing.
    expect(quirkValue('cockpit-draw-lag', 'ticks')).toBe(FREE_LOOK.COCKPIT_TICK_LAG);
    expect(cockpitLagFromLead(1.5, 0, 0)).toBe(1.5);
  });
  it('reproduces the 30k fault at the old lag and the 30l fault at 4, and keeps the eye on the seat at any speed at the new one', () => {
    const draw = quirkValue('cockpit-draw-lag', 'ticks');
    // 30k at 1.5: 1.4 blocks ahead at 43 mph and 1.3 at 40 (the eye over the hood / up the nose, within a read of +1.5..+2.5 / +1.5..+2), on the seat at rest.
    expect(cockpitEyeLead(43 / MPH, 1.5, draw)).toBeCloseTo(1.44, 1);
    expect(cockpitEyeLead(40 / MPH, 1.5, draw)).toBeCloseTo(1.34, 1);
    expect(cockpitEyeLead(0, 1.5, draw)).toBe(0);
    // 30l at 4: a block BEHIND the seat at 43 mph (the grey pillars behind the cabin: -1.3..-0.7) and 0.9 at 40 (inside the X-wing's fuselage: -1.55..-0.95, within a read).
    expect(cockpitEyeLead(43 / MPH, 4, draw)).toBeCloseTo(-0.96, 1);
    expect(cockpitEyeLead(40 / MPH, 4, draw)).toBeCloseTo(-0.89, 1);
    for (const speed of [0, 5, 12.5, 19.2, 26, 40.5]) expect(cockpitEyeLead(speed, FREE_LOOK.COCKPIT_TICK_LAG, draw)).toBe(0);
    expect(FREE_LOOK.COCKPIT_HISTORY).toBeGreaterThan(FREE_LOOK.COCKPIT_TICK_LAG + 1);
  });
});

describe('drag steering of a native mount (pure; Saga 30l: one swipe spun the Nimbus at 6.5 degrees a tick for 40 s)', () => {
  const P = NATIVE_STEER;
  /**
   * The device as the steering sees it: the rider's reported yaw is the finger's total plus, when `carried`, the
   * heading's own turns `lag` ticks late (quirk `rider-yaw-lag`: 6 on the coaster and the cloud, ~8 on the X-wing).
   * `swipes` are [startTick, degrees over 16 ticks].
   */
  function ride(carried: boolean, swipes: Array<[number, number]>, ticks: number, lag = FREE_LOOK.RIDER_YAW_LAG_TICKS) {
    let s = nativeSteerStart(0, 0, freeLookStart);
    const headings: number[] = [], steps: number[] = [], looks: number[] = [], verdicts: Array<string | undefined> = [];
    let finger = 0;
    for (let t = 0; t < ticks; t++) {
      for (const [at, deg] of swipes) if (t >= at && t < at + 16) finger += deg / 16;
      const carry = carried && t - lag - 1 >= 0 ? headings[t - lag - 1]! : 0;
      const riderYaw = wrap(finger + carry);
      const r = nativeSteerStep(s, { riderYaw, riderPitch: 0 }, P, FREE_LOOK, freeLookStep);
      s = r.state; headings.push(r.yaw); steps.push(r.step); looks.push(riderYaw); verdicts.push(r.state.verdict);
    }
    return { state: s, headings, steps, looks, verdicts, finger };
  }
  it('under the carry (the device as measured) the probe reads it, the body stays put, the view turns by the swipe and nothing spins', () => {
    for (const lag of [6, 8]) {
      const { state, headings, steps, looks, verdicts } = ride(true, [[70, 84]], 200, lag);
      // One probe: the body turned PROBE_DEG, the look followed, the turn was taken back; the view ends where it began.
      expect(state.verdict).toBe('carried');
      expect(state.tries).toBe(1);
      expect(verdicts.findIndex(v => v === 'carried')).toBeLessThan(40);
      expect(Math.max(...headings.map(h => Math.abs(wrap(h))))).toBe(P.PROBE_DEG);
      expect(wrap(headings[60]!)).toBe(0);
      expect(wrap(looks[60]!)).toBe(0);
      // The swipe: the body does not move (any turn would turn the view with it), the view turns by the swipe, and
      // the heading is still a second and five seconds later - never the device's spin.
      expect(steps.slice(60).every(v => v === 0)).toBe(true);
      expect(wrap(headings.at(-1)!)).toBe(0);
      expect(wrap(looks.at(-1)!)).toBeCloseTo(84, 6);
    }
  });
  it('a body proven free (the look stayed through two probes) follows every swipe at the rate and stops with the finger', () => {
    const { state, headings, steps, looks } = ride(false, [[80, 84], [160, -30]], 240);
    expect(state.verdict).toBe('free');
    expect(state.tries).toBe(P.PROBE_FREE_CONFIRM);
    // Each probe turned the body one way and back, the second the other way; nothing net before the swipe.
    expect(wrap(headings[79]!)).toBe(0);
    // The turn keeps up with the finger (9 a tick against 5.25), is over within a tick of the swipe's end and stops.
    expect(Math.max(...steps.slice(80).map(Math.abs))).toBeLessThanOrEqual(P.RATE_DEG_PER_TICK);
    expect(wrap(headings[120]!)).toBeCloseTo(84, 6);
    expect(steps.slice(98, 160).every(v => v === 0)).toBe(true);
    expect(wrap(headings.at(-1)!)).toBeCloseTo(54, 6);
    expect(wrap(looks.at(-1)!)).toBeCloseTo(54, 6);
  });
  it('a finger moving against the probe fakes one "stayed"; the second probe reads the carry, so the body never follows', () => {
    // The finger drags -12 during the first probe's wait (the probe turned +12 and the carry +12 arrives): the look
    // reads as unmoved. The next probe, the other way, in a quiet moment, sees the carry.
    const { state, headings } = ride(true, [[12, -12], [120, 60]], 220);
    expect(state.freeVotes).toBe(1);
    expect(state.verdict).toBe('carried');
    expect(state.tries).toBe(2);
    expect(wrap(headings.at(-1)!)).toBe(0);
  });
  it('a mount\'s settle: the seat turning the rider onto the heading is no swipe, and no probe runs through it (Saga 30k riderYaw 0 -> -180)', () => {
    let s = nativeSteerStart(-180, FREE_LOOK.MOUNT_SETTLE_TICKS, freeLookStart);
    for (const riderYaw of [0, 0, 0, 0, -180, -180, -180, -180, -180, -180]) { const r = nativeSteerStep(s, { riderYaw, riderPitch: 0 }, P, FREE_LOOK, freeLookStep); s = r.state; expect(r.step).toBe(0); }
    expect(s.heading).toBe(-180);
    expect(s.tries).toBe(0);
  });
});

describe('cockpitCamera (pure)', () => {
  const pose = (x: number, z: number, yaw: number, pitch = 0): CockpitPose => ({ x, y: 64, z, yaw, pitch });
  it('stands at the driver\'s eye turned by the heading and scaled by the size, looking along the nose turned by the offsets', () => {
    // Yaw 90 faces -x: the seat frame's +z (nose) is world -x, its +x is world +z.
    const c = cockpitCamera([pose(10, 20, 90)], 0, [0.5, 2, 1], 2, { yaw: 30, pitch: 10 }, FREE_LOOK.COCKPIT_PITCH_MAX)!;
    expect(c.location.x).toBeCloseTo(10 - 2, 6);
    expect(c.location.y).toBeCloseTo(68, 6);
    expect(c.location.z).toBeCloseTo(20 + 1, 6);
    expect(c.rotation).toEqual({ x: 10, y: 120 });
  });
  it('shows the pose COCKPIT_TICK_LAG ticks back (the client draws the vehicle behind the server), the yaw the short way round', () => {
    const poses = [pose(0, 0, 170), pose(0, 1, 178), pose(0, 2, -174), pose(0, 3, -166)];
    const c = cockpitCamera(poses, 1.5, [0, 0, 0], 1, { yaw: 0, pitch: 0 }, FREE_LOOK.COCKPIT_PITCH_MAX)!;
    expect(c.location.z).toBeCloseTo(1.5, 6);
    expect(c.rotation.y).toBeCloseTo(-178, 6);
    // Fewer poses than the lag: the oldest.
    expect(cockpitCamera([pose(0, 5, 0)], 1.5, [0, 0, 0], 1, { yaw: 0, pitch: 0 }, 89)!.location.z).toBe(5);
    expect(cockpitCamera([], 1.5, [0, 0, 0], 1, { yaw: 0, pitch: 0 }, 89)).toBeNull();
  });
  it('keeps the pitch inside what setCamera accepts', () => {
    expect(cockpitCamera([pose(0, 0, 0, 60)], 0, [0, 0, 0], 1, { yaw: 0, pitch: 60 }, FREE_LOOK.COCKPIT_PITCH_MAX)!.rotation.x).toBe(FREE_LOOK.COCKPIT_PITCH_MAX);
  });
});

// ─── The shipped camera runtime on the simulator ───

const CAR = 'craftmatic:t_car';
const cameraCfg: VehicleCameraConfig = { typeId: CAR, preset: 'craftmatic:t_car_chase', kind: 'car', radius: 6, height: 2.6, pivotY: 0.75, scripted: true, riderVisibleSizes: null, eye: [0, 1.62, -0.4] };
function cameraHost(cfg: VehicleCameraConfig = cameraCfg, terrain = solidBelow(64), extraComponents: Record<string, unknown> = {}) {
  const h = simHost({
    script: vehicleCameraScript({ vehicles: [cfg], pitchProperty: FLIGHT_PROPS.pitch, freeLook: FREE_LOOK, lookPitchProperty: VEHICLE_DYNAMIC.lookPitch, telemetryEvent: VEHICLE_TELEMETRY_EVENT, passableBlocks: CHASE_PASSABLE_BLOCKS }),
    entities: { [CAR]: { properties: flightProperties() as Record<string, Record<string, unknown>>, components: {
      'minecraft:type_family': { family: ['craftmatic_vehicle', 'car'] },
      'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: [{ position: [0, 0.5, 0], lock_rider_rotation: FREE_LOOK.SEAT_LOCK_DEG }] },
      ...extraComponents,
    } } },
    terrain,
  });
  const car = h.spawn(CAR, { x: 0.5, y: 64, z: 0.5 }, { yaw: 0 });
  const rider = h.addPlayer('Driver', { x: 0.5, y: 64, z: 0.5 });
  h.seat(rider, car);
  /** The chase camera's yaw (Bedrock: from its location toward the point it faces) and pitch (+ = down), or undefined when cleared. */
  const view = (): { yaw: number; pitch: number } | undefined => {
    const c = h.host.playerState(rider).camera;
    if (!c.location || !c.facing) return undefined;
    const dx = c.facing.x - c.location.x, dy = c.facing.y - c.location.y, dz = c.facing.z - c.location.z;
    return { yaw: Math.atan2(-dx, dz) * 180 / Math.PI, pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI };
  };
  /** Drive the car along its heading at `speed` blocks/s for `n` ticks (as scripts/vehicles.js teleports it). */
  const drive = (n: number, speed: number, turnPerTick = 0): void => {
    for (let i = 0; i < n; i++) {
      car.rotation.y += turnPerTick;
      const r = car.rotation.y * Math.PI / 180;
      car.location = { x: car.location.x - Math.sin(r) * speed / 20, y: car.location.y, z: car.location.z + Math.cos(r) * speed / 20 };
      h.run(1);
    }
  };
  /** The child drags: the rider's look turns by (dYaw, dPitch) degrees a tick for `n` ticks. */
  const drag = (n: number, dYaw: number, dPitch = 0, speed = 0): void => {
    for (let i = 0; i < n; i++) { rider.rotation = { x: rider.rotation.x + dPitch, y: rider.rotation.y + dYaw }; if (speed) drive(1, speed); else h.run(1); }
  };
  return { h, car, rider, view, drive, drag };
}

describe('the camera runtime with free look (scripts/vehicle-camera.js on the simulator)', () => {
  it('sits behind the nose, orbits by a drag, holds at rest, and eases back behind the nose while moving', () => {
    const { car, view, drive, drag } = cameraHost();
    drive(2, 0);
    expect(wrap(view()!.yaw - car.rotation.y)).toBeCloseTo(0, 1);
    // Drag 90 degrees round at rest.
    drag(15, 6);
    expect(wrap(view()!.yaw - car.rotation.y)).toBeCloseTo(90, 0);
    // At rest it stays there.
    drive(60, 0);
    expect(wrap(view()!.yaw - car.rotation.y)).toBeCloseTo(90, 0);
    // Moving: still there a moment after the drag ended (the idle already passed at rest, so it eases at once) ...
    drive(10, 8);
    const part = Math.abs(wrap(view()!.yaw - car.rotation.y));
    expect(part).toBeLessThan(90);
    expect(part).toBeGreaterThan(20);
    // ... and behind the nose within ~2.5 s (an exponential ease: 1.5 percent of the 90 degrees left).
    drive(40, 8);
    expect(Math.abs(wrap(view()!.yaw - car.rotation.y))).toBeLessThan(2);
    drive(40, 8);
    expect(Math.abs(wrap(view()!.yaw - car.rotation.y))).toBeLessThan(0.01);
  });
  it('waits a second after the last drag before it eases, and follows the car through a turn', () => {
    const { car, rider, view, drive, drag } = cameraHost();
    drive(2, 8);
    drag(10, -4, 0, 8);
    const left = wrap(view()!.yaw - car.rotation.y);
    expect(left).toBeCloseTo(-40, 0);
    drive(FREE_LOOK.IDLE_TICKS - 2, 8);
    expect(wrap(view()!.yaw - car.rotation.y)).toBeCloseTo(left, 0);
    // A turn with nobody dragging: the view stays on the car's nose. The simulator carries the rider's yaw round
    // with the car RIDER_YAW_LAG_TICKS late, as the device does (quirk `rider-yaw-lag`, Saga 30l), and the drag
    // reading nets that turn out.
    drive(60, 8, 3);
    expect(Math.abs(wrap(view()!.yaw - car.rotation.y))).toBeLessThan(1);
    // The rider's reported yaw: the drag's 40 off the nose, trailing the turn by its lag (3 a tick x 6 ticks).
    expect(wrap(rider.rotation.y - car.rotation.y)).toBeCloseTo(left - 3 * FREE_LOOK.RIDER_YAW_LAG_TICKS, 0);
  });
  it('the chase boom and its heights grow with the vehicle\'s size, the boom capped under the actor draw ceiling (Saga 30l: one boom for every size put the camera on the 400 percent Milano\'s hull)', () => {
    const boom = (scale: number): { back: number; up: number } => {
      const { h, car, drive } = cameraHost(cameraCfg, solidBelow(64), { 'minecraft:scale': { value: scale } });
      drive(2, 0);
      const c = h.host.playerState(h.engine.players[0]!).camera.location!;
      return { back: Math.round((car.location.z - c.z) * 100) / 100, up: Math.round((c.y - car.location.y) * 100) / 100 };
    };
    const one = boom(1);
    expect(one.back).toBeCloseTo(cameraCfg.radius, 6);
    expect(one.up).toBeCloseTo(cameraCfg.pivotY + cameraCfg.height * 0.5, 6);
    const two = boom(2);
    expect(two.back).toBeCloseTo(2 * one.back, 6);
    expect(two.up).toBeCloseTo(2 * one.up, 6);
    expect(boom(0.5).back).toBeCloseTo(one.back / 2, 6);
    // A 10x vehicle (a 60-block boom) is capped: the camera must stay under the ~70 blocks past which no actor draws.
    expect(boom(10).back).toBeCloseTo(FREE_LOOK.CHASE_BOOM_MAX_BLOCKS, 6);
    expect(FREE_LOOK.CHASE_BOOM_MAX_BLOCKS).toBeLessThan(70);
  });
  it('a drag down tips the view and tells the vehicle where it looks (a ship\'s "look down + Jump")', () => {
    const { car, view, drive, drag } = cameraHost();
    drive(2, 0);
    const level = view()!.pitch;
    drag(10, 0, 4);
    expect(view()!.pitch).toBeGreaterThan(level + 30);
    expect(car.dynamic.get(VEHICLE_DYNAMIC.lookPitch)).toBeCloseTo(40, 0);
  });
  it('in the cockpit view (hotbar slot 9) the camera stands at the driver\'s eye, looks round by a drag and eases back to the front in yaw AND pitch while moving (Saga 30j)', () => {
    const { h, car, rider, drive, drag } = cameraHost();
    const cam = () => h.host.playerState(rider).camera;
    drive(2, 0);
    h.host.playerState(rider).selectedSlot = 8;
    drive(3, 0);
    // A free camera at the eye (the car at rest: no lag to show), level along the nose; the rider hidden round it.
    expect(cam().preset).toBe('minecraft:free');
    expect(cam().location!.y).toBeCloseTo(car.location.y + 1.62, 6);
    expect(cam().location!.z).toBeCloseTo(car.location.z - 0.4, 6);
    expect(wrap(cam().rotation!.y - car.rotation.y)).toBeCloseTo(0, 6);
    expect(cam().rotation!.x).toBeCloseTo(0, 6);
    expect(rider.effects.has('minecraft:invisibility')).toBe(true);
    // Drag right and down at rest: the view follows and holds.
    drag(10, 5, 2);
    expect(wrap(cam().rotation!.y - car.rotation.y)).toBeCloseTo(50, 0);
    expect(cam().rotation!.x).toBeCloseTo(20, 0);
    drive(40, 0);
    expect(wrap(cam().rotation!.y - car.rotation.y)).toBeCloseTo(50, 0);
    // Driving: back to the front, yaw and pitch, within ~4 s.
    drive(FREE_LOOK.IDLE_TICKS + 60, 8);
    expect(Math.abs(wrap(cam().rotation!.y - car.rotation.y))).toBeLessThan(1);
    expect(Math.abs(cam().rotation!.x)).toBeLessThan(1);
  });
  it('in the cockpit view at speed the eye stands on the vehicle\'s pose COCKPIT_TICK_LAG ticks back, where the device draws the seat (Saga 30k: at 1.5 it rode over the McLaren\'s hood at 43 mph)', () => {
    const { h, car, rider, drive } = cameraHost();
    drive(2, 0);
    h.host.playerState(rider).selectedSlot = 8;
    const speed = 19.2;
    drive(20, speed);
    const c = h.host.playerState(rider).camera.location!;
    // The car faces +z; the eye is 0.4 behind its origin. The camera stands COCKPIT_TICK_LAG ticks of travel back.
    expect(c.z).toBeCloseTo(car.location.z - FREE_LOOK.COCKPIT_TICK_LAG * speed / 20 - 0.4, 6);
    expect(c.x).toBeCloseTo(car.location.x, 6);
  });
  it('the first mount opens the chase camera behind the nose though the child climbed on looking at the vehicle\'s face (Saga 30k s32/s50: the seat\'s turn of the rider read as a drag)', () => {
    const { h, car, rider, view, drive, drag } = cameraHost();
    // The child faced the car's nose from in front when they climbed on; the seat turns them onto its heading 4 ticks later.
    rider.rotation = { x: 0, y: 180 };
    h.run(4);
    rider.rotation = { x: 0, y: 0 };
    h.run(3);
    expect(Math.abs(wrap(view()!.yaw - car.rotation.y))).toBeLessThan(1);
    drive(20, 0);
    expect(Math.abs(wrap(view()!.yaw - car.rotation.y))).toBeLessThan(1);
    // And the free look works from there.
    drag(10, 6);
    expect(wrap(view()!.yaw - car.rotation.y)).toBeCloseTo(60, 0);
  });
  it('holds a native mount\'s rider in the default control scheme, where a drag turns the look it flies along (Saga 30k: under player_relative the Nimbus ignored every drag)', () => {
    const { h, rider } = cameraHost({ ...cameraCfg, kind: 'plane', scripted: false });
    // A scheme a previous ride left: the runtime clears it on mount and keeps it clear.
    h.host.playerState(rider).controlScheme = 'player_relative';
    h.run(1);
    expect(h.host.playerState(rider).controlScheme).toBeUndefined();
    h.host.playerState(rider).controlScheme = 'player_relative';
    h.run(12);
    expect(h.host.playerState(rider).controlScheme).toBeUndefined();
  });
  it('switching views starts the new one on the nose, and the cockpit\'s hiding ends with it (Saga 30j: the chase camera came back where the cockpit drag left it)', () => {
    const { h, car, rider, view, drive, drag } = cameraHost();
    drive(2, 0);
    h.host.playerState(rider).selectedSlot = 8;
    drive(2, 0);
    drag(10, 5);
    h.host.playerState(rider).selectedSlot = 0;
    drive(2, 0);
    expect(Math.abs(wrap(view()!.yaw - car.rotation.y))).toBeLessThan(1);
    expect(rider.effects.has('minecraft:invisibility')).toBe(false);
    // And a chase drag does not carry into the cockpit view.
    drag(10, -6);
    h.host.playerState(rider).selectedSlot = 8;
    drive(2, 0);
    expect(Math.abs(wrap(h.host.playerState(rider).camera.rotation!.y - car.rotation.y))).toBeLessThan(1);
  });
  it('never sits behind a wall: a wall between the vehicle and the chase camera pulls it in front of the wall, and a plant does not (Saga 30j s68)', () => {
    // A stone wall two blocks behind the car (it faces +z, the camera trails toward -z), three high; a tall grass row in front of it.
    const wallZ = -2, terrain = (_x: number, y: number, z: number) =>
      ({ typeId: y < 64 ? 'minecraft:stone' : z === wallZ && y < 67 ? 'minecraft:stone' : z === wallZ + 1 && y === 64 ? 'minecraft:tall_grass' : 'minecraft:air' });
    const { h, rider, drive } = cameraHost(cameraCfg, terrain);
    drive(2, 0);
    const c = h.host.playerState(rider).camera;
    // In front of the wall's face (z -1), not behind it, still on the trailing side of the car.
    expect(c.location!.z).toBeGreaterThan(wallZ + 1);
    expect(c.location!.z).toBeLessThan(0.5);
    // Without the wall the camera trails the full boom.
    const open = cameraHost(cameraCfg, (_x: number, y: number, z: number) => ({ typeId: y < 64 ? 'minecraft:stone' : z === -1 && y === 64 ? 'minecraft:tall_grass' : 'minecraft:air' }));
    open.drive(2, 0);
    expect(open.h.host.playerState(open.rider).camera.location!.z).toBeLessThan(wallZ);
  });
  it('logs a CMCAM line per rider with telemetry on (the device probe reads the drag and the ease from it)', () => {
    const { h, drive, drag } = cameraHost();
    h.engine.emit('scriptEventReceive', { id: VEHICLE_TELEMETRY_EVENT, message: 'fast', sourceType: 'Server' });
    drive(2, 0);
    drag(8, 5);
    drive(8, 8);
    const lines = h.lines('console').filter(l => l.startsWith('[warn] CMCAM ')).map(l => l.slice('[warn] '.length));
    expect(lines.length).toBeGreaterThan(2);
    const last = JSON.parse(lines.at(-1)!.slice(6));
    expect(last).toMatchObject({ type: CAR, mode: 'chase' });
    expect(typeof last.yawOff).toBe('number');
  });
});

void (null as unknown as SimEntity);
