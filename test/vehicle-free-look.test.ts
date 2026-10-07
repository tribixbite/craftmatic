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
import { FREE_LOOK, cockpitCamera, freeLookStart, freeLookStep, type CockpitPose, type FreeLookState } from '../web/src/engine/vehicle-free-look.js';
import { vehicleCameraScript, type VehicleCameraConfig } from '../web/src/engine/playable-addon.js';
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
function cameraHost(cfg: VehicleCameraConfig = cameraCfg) {
  const h = simHost({
    script: vehicleCameraScript({ vehicles: [cfg], pitchProperty: FLIGHT_PROPS.pitch, freeLook: FREE_LOOK, lookPitchProperty: VEHICLE_DYNAMIC.lookPitch, telemetryEvent: VEHICLE_TELEMETRY_EVENT }),
    entities: { [CAR]: { properties: flightProperties() as Record<string, Record<string, unknown>>, components: {
      'minecraft:type_family': { family: ['craftmatic_vehicle', 'car'] },
      'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: [{ position: [0, 0.5, 0], lock_rider_rotation: FREE_LOOK.SEAT_LOCK_DEG }] },
    } } },
    terrain: solidBelow(64),
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
    const { car, view, drive, drag } = cameraHost();
    drive(2, 8);
    drag(10, -4, 0, 8);
    const left = wrap(view()!.yaw - car.rotation.y);
    expect(left).toBeCloseTo(-40, 0);
    drive(FREE_LOOK.IDLE_TICKS - 2, 8);
    expect(wrap(view()!.yaw - car.rotation.y)).toBeCloseTo(left, 0);
    // A turn with nobody dragging: the view stays on the car's nose (the sim does not carry the rider's yaw).
    drive(60, 8, 3);
    expect(Math.abs(wrap(view()!.yaw - car.rotation.y))).toBeLessThan(1);
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
