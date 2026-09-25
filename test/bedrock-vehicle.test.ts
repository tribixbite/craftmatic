/**
 * Driven vehicles: the road-wheel grouping of the compiler's vehicle rig and
 * the client drive animation (engine/bedrock-vehicle.ts).
 */
import { describe, expect, it } from 'vitest';
import { vehicleWheelAssemblies, type VehicleWheelBone } from '../web/src/engine/ldraw-entity-compiler.js';
import { BOAT, boatStep, CAR, carStep, type CarState, type CarTerrain, FLIGHT, FLIGHT_PROPS, flightStep, scriptedVehicleScript, vehicleClientAnimation, vehicleMotionOf, type BoatState, type BoatWater, type FlightInput, type FlightState } from '../web/src/engine/bedrock-vehicle.js';

/** Fly `ticks` ticks over flat ground at y = 0 (nothing in the way), returning every state. */
function fly(s: FlightState, input: (t: number, s: FlightState) => FlightInput, ticks: number, ground: number | null = 0): { states: FlightState[]; events: string[] } {
  const states: FlightState[] = [], events: string[] = [];
  for (let t = 0; t < ticks; t++) {
    const r = flightStep(s, input(t, s), { ground, groundAhead: ground, blocked: false }, FLIGHT, 0.05);
    s = r.state; states.push(s);
    if (r.event) events.push(`${t}:${r.event}`);
  }
  return { states, events };
}
const parked: FlightState = { x: 0, y: 0, z: 0, yaw: -90, pitch: 0, speed: 0, throttle: 0, onGround: true, stalled: false, bank: 0 };
const held = (x: number, y: number, jump: boolean) => (): FlightInput => ({ x, y, jump, rider: true });

describe('fixed-wing flight model', () => {
  it('stays parked with nobody at the controls and with a rider who does nothing', () => {
    expect(fly(parked, () => ({ x: 0, y: 0, jump: false, rider: false }), 40).states.at(-1)).toMatchObject({ x: 0, y: 0, speed: 0, onGround: true });
    expect(fly(parked, held(0, 0, false), 40).states.at(-1)).toMatchObject({ speed: 0, onGround: true });
  });
  it('takes off on Jump alone, within about ten blocks of run, heading +x at yaw -90', () => {
    const { states, events } = fly(parked, held(0, 0, true), 100);
    const lift = events.find(e => e.endsWith('takeoff'));
    expect(lift).toBeDefined();
    const at = states[Number(lift!.split(':')[0])]!;
    expect(at.x).toBeGreaterThan(4);
    expect(at.x).toBeLessThan(16);
    expect(Math.abs(at.z)).toBeLessThan(0.01);
    expect(states.at(-1)!.y).toBeGreaterThan(1);
  });
  it('rotates earlier when the stick is pulled back at take-off speed, and brakes below it', () => {
    const pulled = fly(parked, (t) => ({ x: 0, y: t > 20 ? -1 : 0, jump: true, rider: true }), 100).events.find(e => e.endsWith('takeoff'));
    const alone = fly(parked, held(0, 0, true), 100).events.find(e => e.endsWith('takeoff'));
    expect(Number(pulled!.split(':')[0])).toBeLessThan(Number(alone!.split(':')[0]));
    const rolling: FlightState = { ...parked, speed: 6, throttle: 0 };
    const braked = fly(rolling, held(0, -1, false), 10).states.at(-1)!.speed;
    const coasted = fly(rolling, held(0, 0, false), 10).states.at(-1)!.speed;
    expect(braked).toBeLessThan(coasted);
  });
  it('climbs with the stick back, dives with it forward, and holds cruise hands off', () => {
    const cruise: FlightState = { ...parked, y: 30, speed: 20, throttle: FLIGHT.CRUISE_THROTTLE, onGround: false };
    expect(fly(cruise, held(0, -1, false), 40).states.at(-1)!.y).toBeGreaterThan(33);
    expect(fly(cruise, held(0, 1, false), 40).states.at(-1)!.y).toBeLessThan(27);
    const level = fly(cruise, held(0, 0, false), 200).states.at(-1)!;
    expect(Math.abs(level.y - 30)).toBeLessThan(1);
    expect(level.speed).toBeGreaterThan(FLIGHT.STALL_SPEED * 2);
  });
  it('turns right on a right stick (x = -1 in Minecraft), banking right while it does', () => {
    const cruise: FlightState = { ...parked, y: 30, speed: 20, throttle: FLIGHT.CRUISE_THROTTLE, onGround: false };
    const turned = fly(cruise, held(FLIGHT.STICK_X_RIGHT, 0, false), 20).states.at(-1)!;
    expect(turned.yaw).toBeGreaterThan(-90 + 30);
    expect(turned.bank).toBeGreaterThan(10);
  });
  it('stalls when too slow: the nose drops and it sinks', () => {
    const slow: FlightState = { ...parked, y: 30, speed: 4, pitch: 20, throttle: 0, onGround: false };
    const { states, events } = fly(slow, held(0, -1, false), 20);
    expect(events[0]).toBe('0:stall');
    expect(states.at(-1)!.pitch).toBeLessThan(0);
    expect(states.at(-1)!.y).toBeLessThan(30);
  });
  it('lands on the ground under it, gently or hard, and then rolls to a stop', () => {
    // A little forward stick until the wheels touch, then hands off.
    const approach: FlightState = { ...parked, y: 5, speed: 14, pitch: -4, throttle: 0.3, onGround: false };
    const { states, events } = fly(approach, (_t, s) => ({ x: 0, y: s.onGround ? 0 : 0.3, jump: false, rider: true }), 400);
    const touch = states.findIndex(s => s.onGround);
    expect(states[touch - 1]!.speed).toBeGreaterThan(FLIGHT.STALL_SPEED);
    expect(Math.hypot(states.at(-1)!.x - states[touch]!.x, states.at(-1)!.z - states[touch]!.z)).toBeLessThan(40);
    expect(events.some(e => e.endsWith(':landing'))).toBe(true);
    expect(states.at(-1)).toMatchObject({ y: 0, onGround: true, speed: 0 });
    const dive: FlightState = { ...parked, y: 12, speed: 30, pitch: -40, throttle: 1, onGround: false };
    expect(fly(dive, held(0, 1, true), 40).events.some(e => e.endsWith(':hard_landing'))).toBe(true);
  });
  it('stops at a block in the way', () => {
    const r = flightStep({ ...parked, speed: 8 }, { x: 0, y: 0, jump: true, rider: true }, { ground: 0, groundAhead: 0, blocked: true }, FLIGHT, 0.05);
    expect(r.event).toBe('crash');
    expect(r.state).toMatchObject({ x: 0, z: 0, speed: 0 });
  });
  it('serialises the runtime with the model in it and nothing outside it', () => {
    const js = scriptedVehicleScript({ types: { 'craftmatic:p': { mode: 'plane', noseReach: 4 } }, flight: FLIGHT, boat: BOAT, car: CAR, props: FLIGHT_PROPS, inputEvent: 'craftmatic:flight_input', telemetryEvent: 'craftmatic:vehicle_telemetry' });
    expect(js).toContain('function flightStep');
    expect(js).toContain('function boatStep');
    expect(js).toContain('function carStep');
    expect(js).not.toMatch(/__name|import_/);
  });
});

type Box = { index: number; min: [number, number, number]; max: [number, number, number] };
const box = (index: number, min: [number, number, number], max: [number, number, number]): Box => ({ index, min, max });

describe('road wheels', () => {
  // 10337's wheel placements as the compiler sees them (levelled LDraw frame, travel along X):
  // twin rear wheels (56904 rim in a 70490 tyre, 5650 rim set IN along the axle in a 15413 tyre) and two fronts.
  const countach: Box[] = [
    box(0, [-128, -100, 82], [-52, -24, 120]), box(1, [-128, -100, -200], [-52, -24, -162]),
    box(2, [-152, -123, -198], [-28, 0, -162]), box(3, [-152, -123, 82], [-28, 0, 118]),
    box(4, [-128, -100, 118], [-52, -24, 168]), box(5, [-128, -100, -248], [-52, -24, -198]),
    box(6, [372, -100, 115], [448, -24, 165]), box(7, [372, -100, -245], [448, -24, -195]),
    box(8, [-152, -124, 118], [-28, 0, 168]), box(9, [-152, -124, -248], [-28, 0, -198]),
    box(10, [348, -124, 115], [472, 0, 165]), box(11, [348, -124, -245], [472, 0, -195]),
  ];
  it('puts each rim in its tyre, even set in along the axle, and keeps twin wheels apart', () => {
    const { wheels, rejected } = vehicleWheelAssemblies(countach, 'x');
    expect(rejected).toBe(0);
    expect(wheels.map(w => w.indices.sort((a, b) => a - b))).toEqual([[0, 3], [1, 2], [4, 8], [5, 9], [6, 10], [7, 11]]);
    expect(wheels.every(w => w.axle === 2 && w.radiusLdu === 62)).toBe(true);
  });
  it('leaves a wheel lying flat, or one turned along the travel axis, on the body and counts it', () => {
    const flat = box(0, [0, -8, 0], [40, 0, 40]);
    const along = box(1, [100, -40, 0], [140, 0, 10]);
    const { wheels, rejected } = vehicleWheelAssemblies([flat, along], 'z');
    expect(wheels).toEqual([]);
    expect(rejected).toBe(2);
  });
});

describe('drive animation', () => {
  const wheels: VehicleWheelBone[] = [
    { name: 'wheel_0', radiusBlocks: 0.32, parts: 2, pivot: [0, 5, 20], end: -1 },
    { name: 'wheel_1', radiusBlocks: 0.32, parts: 2, pivot: [0, 5, -20], end: 1 },
  ];
  it('spins every wheel by its own radius and steers only the front ones', () => {
    const a = vehicleClientAnimation('car_1', 'car', wheels);
    const bones = (a.file as any).animations[a.id].bones;
    expect(bones.wheel_0.rotation).toEqual(['v.cm_wheel / 0.32', 0, 0]);
    expect(bones.wheel_1.rotation).toEqual(['v.cm_wheel / 0.32', 'v.cm_steer', 0]);
    expect(bones.body.rotation).toEqual(['v.cm_pitch', 0, 'v.cm_roll']);
    expect(a.client.animate).toEqual(['drive']);
  });
  it('declares every variable it reads in initialize (an unset one errors every frame)', () => {
    for (const motion of ['car', 'boat', 'plane', 'rotor'] as const) {
      const a = vehicleClientAnimation('v', motion, wheels);
      const text = JSON.stringify(a.file) + a.client.preAnimation.join(' ');
      const used = new Set(text.match(/v\.cm_[a-z_]+/g));
      const declared = new Set(a.client.initialize.map(l => l.split('=')[0]!.trim()));
      expect([...used].filter(v => !declared.has(v))).toEqual([]);
    }
  });
  it('reads a scripted vehicle attitude from its properties and leans a car out of a turn from its motion', () => {
    for (const motion of ['plane', 'boat'] as const) {
      const pre = vehicleClientAnimation('p', motion, []).client.preAnimation;
      // The property lines come last, so they win over the motion-derived ones.
      expect(pre.slice(-3)).toEqual([`v.cm_pitch = -q.property('${FLIGHT_PROPS.pitch}');`, `v.cm_roll = -q.property('${FLIGHT_PROPS.bank}');`, `v.cm_wheel = q.property('${FLIGHT_PROPS.wheel}');`]);
    }
    expect(vehicleClientAnimation('c', 'car', []).client.preAnimation.join(' ')).toMatch(/v\.cm_yaw_rate \* 0\.045/);
    expect(vehicleClientAnimation('c', 'car', []).client.preAnimation.join(' ')).not.toMatch(/q\.property/);
  });
  it('tells a rotorcraft from a fixed wing by its title', () => {
    expect(vehicleMotionOf('plane', 'Rescue Helicopter (42092-1)')).toBe('rotor');
    expect(vehicleMotionOf('plane', 'Passenger Airplane (60367-1)')).toBe('plane');
    expect(vehicleMotionOf('boat', 'Pirate Ship')).toBe('boat');
  });
});

/** Sail `ticks` ticks on open water (surface at y = 1) unless `water` says otherwise. */
function sail(s: BoatState, input: (t: number, s: BoatState) => FlightInput, ticks: number, water: (s: BoatState) => BoatWater = () => ({ surface: 1, ground: null, shoreAhead: false, shoreAstern: false })) {
  const states: BoatState[] = [], events: string[] = [];
  for (let t = 0; t < ticks; t++) { const r = boatStep(s, input(t, s), water(s), BOAT, 0.05); s = r.state; states.push(s); if (r.event) events.push(`${t}:${r.event}`); }
  return { states, events };
}
const moored: BoatState = { x: 0, y: 0.7, z: 0, yaw: -90, speed: 0, vy: 0, afloat: true, boost: 0, cooldown: 0, pitch: 0, bank: 0 };

describe('boat model', () => {
  it('floats at its draft and stays put untouched', () => {
    expect(sail(moored, () => ({ x: 0, y: 0, jump: false, rider: false }), 40).states.at(-1)).toMatchObject({ x: 0, y: 1 - BOAT.DRAFT, speed: 0 });
  });
  it('reaches full speed ahead in a few seconds, coasts down hands off, and goes astern slowly', () => {
    const ahead = sail(moored, held(0, 1, false), 80).states.at(-1)!;
    expect(ahead.speed).toBeCloseTo(BOAT.MAX_SPEED, 5);
    expect(ahead.x).toBeGreaterThan(10);
    const coast = sail(ahead, held(0, 0, false), 40).states;
    expect(coast.at(-1)!.speed).toBeGreaterThan(0);
    expect(coast.at(-1)!.speed).toBeLessThan(ahead.speed);
    expect(sail(moored, held(0, -1, false), 60).states.at(-1)!.speed).toBeCloseTo(-BOAT.REVERSE_SPEED, 5);
  });
  it('boosts on Jump, then cools down', () => {
    const { states, events } = sail(moored, held(0, 1, true), 200);
    expect(events[0]).toBe('0:boost');
    expect(Math.max(...states.map(s => s.speed))).toBeGreaterThan(BOAT.MAX_SPEED + 1);
    expect(events.filter(e => e.endsWith('boost'))).toHaveLength(Math.ceil(200 * 0.05 / (BOAT.BOOST_SECONDS + BOAT.BOOST_COOLDOWN)));
  });
  it('turns with the rudder, more at speed, and a little at rest', () => {
    const rest = sail(moored, held(BOAT.STICK_X_RIGHT, 0, false), 20).states.at(-1)!;
    const fast = sail({ ...moored, speed: BOAT.MAX_SPEED }, held(BOAT.STICK_X_RIGHT, 1, false), 20).states.at(-1)!;
    expect(rest.yaw).toBeGreaterThan(-90);
    expect(fast.yaw - -90).toBeGreaterThan(2 * (rest.yaw - -90));
  });
  it('beaches at a shore and only backs off it', () => {
    const shore = (s: BoatState): BoatWater => ({ surface: 1, ground: null, shoreAhead: s.x > 5, shoreAstern: false });
    const { states, events } = sail(moored, held(0, 1, false), 100, shore);
    expect(events.some(e => e.endsWith('beached'))).toBe(true);
    expect(states.at(-1)!.x).toBeLessThan(6);
    expect(sail(states.at(-1)!, held(0, -1, false), 40, shore).states.at(-1)!.x).toBeLessThan(states.at(-1)!.x);
  });
  it('falls onto the ground when there is no water under it', () => {
    const dry = sail({ ...moored, y: 5, afloat: false }, held(0, 1, false), 40, () => ({ surface: null, ground: 0, shoreAhead: false, shoreAstern: false })).states.at(-1)!;
    expect(dry).toMatchObject({ y: 0, afloat: false });
    expect(Math.abs(dry.x)).toBeLessThan(0.01);
  });
});

/** Drive `ticks` ticks over ground whose height at world x is `groundAt(x)` (flat 0 by default). */
function drive(s: CarState, input: (t: number, s: CarState) => FlightInput, ticks: number, groundAt: (x: number) => number = () => 0, wall = (_s: CarState) => false) {
  const states: CarState[] = [], events: string[] = [];
  for (let t = 0; t < ticks; t++) {
    const nose = s.x + 1.5, tail = s.x - 1.5;
    const terrain: CarTerrain = { ground: groundAt(s.x), groundFront: groundAt(nose), groundRear: groundAt(tail), blockedFront: wall(s) || groundAt(nose) - s.y > CAR.STEP_UP, blockedRear: false, inWater: false, wheelbase: 3 };
    const r = carStep(s, input(t, s), terrain, CAR, 0.05);
    s = r.state; states.push(s);
    if (r.event) events.push(`${t}:${r.event}`);
  }
  return { states, events };
}
const parkedCar: CarState = { x: 0, y: 0, z: 0, yaw: -90, speed: 0, vy: 0, onGround: true, boost: 0, cooldown: 0, pitch: 0, bank: 0 };

describe('car model', () => {
  it('drives straight ahead on a straight stick and coasts down when it is released (the camel spun and stopped dead)', () => {
    const run = drive(parkedCar, held(0, 1, false), 80).states;
    expect(run.at(-1)!.speed).toBeCloseTo(CAR.MAX_SPEED, 5);
    expect(Math.abs(run.at(-1)!.z)).toBeLessThan(1e-9);
    expect(run.every(s => s.yaw === -90)).toBe(true);
    const coast = drive(run.at(-1)!, held(0, 0, false), 20).states.at(-1)!;
    expect(coast.speed).toBeGreaterThan(CAR.MAX_SPEED - 3);
    expect(coast.speed).toBeLessThan(CAR.MAX_SPEED);
  });
  it('brakes on the stick back, then reverses, slowly', () => {
    const moving: CarState = { ...parkedCar, speed: 10 };
    const braked = drive(moving, held(0, -1, false), 10).states.at(-1)!;
    expect(braked.speed).toBeCloseTo(3, 5);
    const back = drive(parkedCar, held(0, -1, false), 40).states.at(-1)!;
    expect(back.speed).toBeCloseTo(-CAR.REVERSE_SPEED, 5);
    expect(back.x).toBeLessThan(0);
  });
  it('steers right on a right stick while moving (not at rest), reverses the steering backing up, and leans out of the turn', () => {
    expect(drive(parkedCar, held(CAR.STICK_X_RIGHT, 0, false), 20).states.at(-1)!.yaw).toBe(-90);
    const turning = drive({ ...parkedCar, speed: 8 }, held(CAR.STICK_X_RIGHT, 1, false), 20).states.at(-1)!;
    expect(turning.yaw).toBeGreaterThan(-90 + 30);
    expect(turning.bank).toBeLessThan(0);
    const backing = drive({ ...parkedCar, speed: -4 }, held(CAR.STICK_X_RIGHT, -1, false), 20).states.at(-1)!;
    expect(backing.yaw).toBeLessThan(-90);
  });
  it('climbs a one-block step, stops at a two-block wall, and falls off an edge', () => {
    const step = drive(parkedCar, held(0, 1, false), 60, x => (x > 4 ? 1 : 0));
    expect(step.states.at(-1)!.y).toBe(1);
    expect(step.states.at(-1)!.x).toBeGreaterThan(8);
    const wall = drive(parkedCar, held(0, 1, false), 60, x => (x > 4 ? 2 : 0));
    expect(wall.events.some(e => e.endsWith('blocked'))).toBe(true);
    expect(wall.states.at(-1)!.x).toBeLessThan(4);
    const edge = drive({ ...parkedCar, speed: 10, y: 3 }, held(0, 1, false), 30, x => (x < 2 ? 3 : 0));
    expect(edge.states.at(-1)).toMatchObject({ y: 0, onGround: true });
    expect(edge.events.some(e => e.endsWith('landed'))).toBe(true);
  });
  it('boosts on Jump, then cools down', () => {
    const { states, events } = drive(parkedCar, held(0, 1, true), 60);
    expect(events[0]).toBe('0:boost');
    expect(Math.max(...states.map(s => s.speed))).toBeGreaterThan(CAR.MAX_SPEED);
  });
});
