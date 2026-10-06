/**
 * Driven vehicles: the road-wheel grouping of the compiler's vehicle rig and
 * the client drive animation (engine/bedrock-vehicle.ts).
 */
import { describe, expect, it } from 'vitest';
import { vehicleWheelAssemblies, type VehicleWheelBone } from '../web/src/engine/ldraw-entity-compiler.js';
import { BOAT, boatStep, CAR, carStep, type CarState, type CarTerrain, FLIGHT, FLIGHT_PROPS, flightStep, FOOTPRINT, HEADLIGHTS, HOVER, HOVER_WORDS, MOVE, resolveMove, VEHICLE_DYNAMIC, headlightCell, isNightTime, scriptedVehicleScript, sweepFootprint, vehicleClientAnimation, vehicleMotionOf, type BoatState, type BoatWater, type FlightInput, type FlightState, type ScriptedVehicleConfig, type ScriptedVehicleType, flightProperties } from '../web/src/engine/bedrock-vehicle.js';
import { simHost, solidBelow } from './_sim-host.js';

/** Fly `ticks` ticks over flat ground at y = 0 (nothing in the way), returning every state. */
function fly(s: FlightState, input: (t: number, s: FlightState) => FlightInput, ticks: number, ground: number | null = 0): { states: FlightState[]; events: string[] } {
  const states: FlightState[] = [], events: string[] = [];
  for (let t = 0; t < ticks; t++) {
    const r = flightStep(s, input(t, s), { ground }, FLIGHT, 0.05);
    s = r.state; states.push(s);
    if (r.event) events.push(`${t}:${r.event}`);
  }
  return { states, events };
}
const parked: FlightState = { x: 0, y: 0, z: 0, yaw: -90, pitch: 0, speed: 0, vy: 0, onGround: true, bank: 0, jumpHeld: false, diving: false };
const aloft: FlightState = { ...parked, y: 20, onGround: false };
const held = (x: number, y: number, jump: boolean, lookPitch?: number) => (): FlightInput => ({ x, y, jump, rider: true, ...(lookPitch === undefined ? {} : { lookPitch }) });

describe('spaceship flight model (every scripted aircraft)', () => {
  it('stays parked with nobody at the controls and with a rider who does nothing', () => {
    expect(fly(parked, () => ({ x: 0, y: 0, jump: false, rider: false }), 40).states.at(-1)).toMatchObject({ x: 0, y: 0, speed: 0, onGround: true });
    expect(fly(parked, held(0, 0, false), 40).states.at(-1)).toMatchObject({ speed: 0, onGround: true });
  });
  it('goes STRAIGHT UP on Jump from the ground, with no take-off run', () => {
    const { states, events } = fly(parked, held(0, 0, true), 40);
    expect(events[0]).toBe('0:takeoff');
    const end = states.at(-1)!;
    expect(end.y).toBeGreaterThan(FLIGHT.CLIMB_SPEED * 2 * 0.8);
    expect(Math.hypot(end.x, end.z)).toBeLessThan(1e-9);
  });
  it('HOVERS hands off: no stall, no sink, no glide (a rider aboard)', () => {
    const end = fly(aloft, held(0, 0, false), 200).states.at(-1)!;
    expect(end).toMatchObject({ x: 0, y: 20, z: 0, speed: 0, onGround: false });
    // From full speed hands off it stops within BRAKE's time and holds its height.
    const fast = fly({ ...aloft, speed: FLIGHT.MAX_SPEED }, held(0, 0, false), 60).states.at(-1)!;
    expect(fast.speed).toBe(0);
    expect(fast.y).toBe(20);
  });
  it('flies forward on the stick and straight BACKWARDS on the stick pulled back, along the heading (yaw -90 is +x)', () => {
    const ahead = fly(aloft, held(0, 1, false), 60).states.at(-1)!;
    expect(ahead.x).toBeGreaterThan(10);
    expect(ahead.speed).toBeCloseTo(FLIGHT.MAX_SPEED, 5);
    expect(ahead.y).toBe(20);
    const back = fly(aloft, held(0, -1, false), 60).states.at(-1)!;
    expect(back.x).toBeLessThan(-4);
    expect(back.speed).toBeCloseTo(-FLIGHT.REVERSE_SPEED, 5);
    expect(back.y).toBe(20);
  });
  it('goes STRAIGHT DOWN on Jump with the stick pulled back, and lands on the ground', () => {
    const { states, events } = fly(aloft, held(0, -1, true), 120);
    const end = states.at(-1)!;
    expect(end).toMatchObject({ y: 0, onGround: true });
    expect(Math.abs(end.x)).toBeLessThan(1e-9);
    expect(events.some(e => e.endsWith(':landing'))).toBe(true);
    expect(Math.min(...states.map(s => s.vy))).toBeCloseTo(-FLIGHT.DESCEND_SPEED, 5);
  });
  it('goes down on a Jump PRESSED while the view looks down, and keeps going down while it is held', () => {
    // Pressed looking down past DIVE_PITCH_DEG: down, even after the view comes back up (the camera's ease).
    const down = fly(aloft, (t) => ({ x: 0, y: 0, jump: true, rider: true, lookPitch: t < 2 ? FLIGHT.DIVE_PITCH_DEG + 10 : 0 }), 30).states.at(-1)!;
    expect(down.y).toBeLessThan(20 - 2);
    // Pressed looking level: up, even if the view later drops.
    const up = fly(aloft, (t) => ({ x: 0, y: 0, jump: true, rider: true, lookPitch: t < 2 ? 0 : 60 }), 30).states.at(-1)!;
    expect(up.y).toBeGreaterThan(20 + 2);
    // Let go and press again level: up again.
    const again = fly(aloft, (t) => ({ x: 0, y: 0, jump: t < 10 || t >= 12, rider: true, lookPitch: t < 10 ? 60 : 0 }), 40).states.at(-1)!;
    expect(again.vy).toBeGreaterThan(0);
  });
  it('turns on the stick at rest too (a right stick is x = -1 in Minecraft), banking into the turn aloft', () => {
    const pivot = fly(aloft, held(FLIGHT.STICK_X_RIGHT, 0, false), 20).states.at(-1)!;
    expect(pivot.yaw).toBeCloseTo(-90 + FLIGHT.TURN_RATE, 0);
    expect(pivot.bank).toBeGreaterThan(10);
    expect(Math.hypot(pivot.x, pivot.z)).toBeLessThan(1e-9);
  });
  it('with nobody aboard it brakes and sinks gently to the ground, and parks', () => {
    const { states, events } = fly({ ...aloft, speed: 10 }, () => ({ x: 0, y: 0, jump: false, rider: false }), 200);
    expect(events.some(e => e.endsWith(':landing'))).toBe(true);
    expect(states.at(-1)).toMatchObject({ y: 0, onGround: true, speed: 0 });
    expect(Math.min(...states.map(s => s.vy))).toBeGreaterThanOrEqual(-FLIGHT.IDLE_SINK - 1e-9);
  });
  it('glides over a rise of a step under it on the ground, and hovers off an edge', () => {
    // Moving onto a step 1 block up: the ground under it rises and it stands on it.
    const step = flightStep({ ...parked, speed: 5 }, { x: 0, y: 1, jump: false, rider: true }, { ground: 1 }, FLIGHT, 0.05).state;
    expect(step).toMatchObject({ y: 1, onGround: true });
    // Off an edge with a rider aboard: it holds its height (a spaceship does not fall).
    const edge = fly({ ...parked, speed: 5 }, held(0, 1, false), 20, -10).states.at(-1)!;
    expect(edge).toMatchObject({ y: 0, onGround: false });
  });
  it('serialises the runtime with the models in it and nothing outside it', () => {
    const js = scriptedVehicleScript(hostConfig({ 'craftmatic:p': { mode: 'plane', noseReach: 4, halfWidth: 3, height: 2 } }));
    expect(js).toContain('function flightStep');
    expect(js).toContain('function boatStep');
    expect(js).toContain('function carStep');
    expect(js).toContain('function sweepFootprint');
    expect(js).toContain('function resolveMove');
    expect(js).toContain('function isNightTime');
    expect(js).toContain('function headlightCell');
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

/** Drive `ticks` ticks over ground whose height at world x is `groundAt(x)` (flat 0 by default). Walls are the runtime's (`resolveMove`), not the step's. */
function drive(s: CarState, input: (t: number, s: CarState) => FlightInput, ticks: number, groundAt: (x: number) => number = () => 0) {
  const states: CarState[] = [], events: string[] = [];
  for (let t = 0; t < ticks; t++) {
    const nose = s.x + 1.5, tail = s.x - 1.5;
    const terrain: CarTerrain = { ground: groundAt(s.x), groundFront: groundAt(nose), groundRear: groundAt(tail), inWater: false, wheelbase: 3 };
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
  it('steers right on a right stick while moving, pivots slowly at rest, reverses the steering backing up, and leans out of the turn', () => {
    // At a standstill it pivots on the spot (out of a corner or a wedge), at PIVOT_RATE, without moving.
    const pivot = drive(parkedCar, held(CAR.STICK_X_RIGHT, 0, false), 20).states.at(-1)!;
    expect(pivot.yaw).toBeCloseTo(-90 + CAR.PIVOT_RATE, 5);
    expect(Math.hypot(pivot.x, pivot.z)).toBe(0);
    const turning = drive({ ...parkedCar, speed: 8 }, held(CAR.STICK_X_RIGHT, 1, false), 20).states.at(-1)!;
    expect(turning.yaw).toBeGreaterThan(-90 + 30);
    expect(turning.bank).toBeLessThan(0);
    const backing = drive({ ...parkedCar, speed: -4 }, held(CAR.STICK_X_RIGHT, -1, false), 20).states.at(-1)!;
    expect(backing.yaw).toBeLessThan(-90);
  });
  it('climbs a one-block step and falls off an edge (a wall is the runtime\'s: see "the vehicle runtime against blocks")', () => {
    const step = drive(parkedCar, held(0, 1, false), 60, x => (x > 4 ? 1 : 0));
    expect(step.states.at(-1)!.y).toBe(1);
    expect(step.states.at(-1)!.x).toBeGreaterThan(8);
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

// ─── The pack runtime on a fake world (the serialised text on the simulator, as the device runs it) ───

/** The runtime's config for a set of types, with the pack's real constants. */
function hostConfig(types: Record<string, ScriptedVehicleType>, extra: Partial<ScriptedVehicleConfig> = {}): ScriptedVehicleConfig {
  return { types, flight: FLIGHT, boat: BOAT, car: CAR, hover: HOVER, footprint: FOOTPRINT, move: MOVE, headlights: HEADLIGHTS, props: FLIGHT_PROPS, dynamic: VEHICLE_DYNAMIC, inputEvent: 'craftmatic:flight_input', telemetryEvent: 'craftmatic:vehicle_telemetry', ...extra };
}

interface HostOptions {
  type: ScriptedVehicleType;
  /** Where the vehicle starts, and its yaw (Bedrock: -90 faces +x). */
  at: { x: number; y: number; z: number }; yaw?: number;
  /**
   * A block id for a whole cell range (x0..x1, y0..y1, z0..z1 inclusive) over
   * the default world (stone below y = 64, air above), later fills over
   * earlier ones; a collider is written `craftmatic:collider[lo=L,hi=H]`.
   */
  fills?: Array<{ from: [number, number, number]; to: [number, number, number]; id: string }>;
  time?: number;
  colliders?: ScriptedVehicleConfig['colliders'];
  /** Blocks at x beyond this read as not loaded (the API's `getBlock` answers undefined there). */
  unloadedBeyondX?: number;
}

/** The scripted vehicle's type as the pack declares it: the vehicle family, its flight properties, one player seat. */
const VEHICLE_TYPE = {
  properties: flightProperties() as Record<string, Record<string, unknown>>,
  components: {
    'minecraft:type_family': { family: ['craftmatic_vehicle'] },
    'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: [{ position: [0, 0.5, 0] }] },
  },
};

/**
 * Run `scripts/vehicles.js` (the serialised runtime) on the headless
 * simulator (test/_sim-host.ts): one scripted vehicle, one player seated on
 * it whose stick the test holds, the world stone below y = 64. Records the
 * vehicle's poses (every `teleport` the runtime makes) and every block the
 * runtime SETS (headlights).
 */
function vehicleHost(o: HostOptions) {
  const typeId = 'craftmatic:t_vehicle';
  const h = simHost({
    script: scriptedVehicleScript(hostConfig({ [typeId]: o.type }, o.colliders ? { colliders: o.colliders } : {})),
    entities: { [typeId]: VEHICLE_TYPE }, colliders: !!o.colliders, terrain: solidBelow(64), timeOfDay: o.time ?? 6000,
  });
  for (const f of o.fills ?? []) {
    const m = /^(.*)\[lo=(\d+),hi=(\d+)\]$/.exec(f.id);
    h.fill({ x: f.from[0], y: f.from[1], z: f.from[2] }, { x: f.to[0], y: f.to[1], z: f.to[2] }, m ? m[1]! : f.id, m ? { 'craftmatic:lo': Number(m[2]), 'craftmatic:hi': Number(m[3]) } : {});
  }
  // Every block the RUNTIME sets from here on (the fills above are the test's).
  const placed = new Map<string, string>();
  h.engine.dimension('overworld').onWrite = (x, y, z, p) => { placed.set(`${x},${y},${z}`, p.typeId); };
  if (o.unloadedBeyondX !== undefined) {
    // Fault injection at the API: the chunk ahead is not loaded, so `getBlock` answers undefined there
    // (quirk `unloaded-block-undefined`). A real unload cannot be staged with a rider aboard: the rider loads its own chunks.
    const dim = h.dimension(), getBlock = dim.getBlock, edge = o.unloadedBeyondX;
    dim.getBlock = (p: { x: number; y: number; z: number }) => (p.x > edge ? undefined : getBlock(p));
  }
  const vehicle = h.spawn(typeId, o.at, { yaw: o.yaw ?? -90 });
  const entity = h.api(vehicle);
  const poses: Array<{ x: number; y: number; z: number; yaw: number }> = [];
  const teleport = entity.teleport;
  entity.teleport = (p: { x: number; y: number; z: number }, opt?: Record<string, unknown>) => { teleport(p, opt); poses.push({ ...p, yaw: vehicle.rotation.y }); };
  const player = h.addPlayer('Driver', o.at);
  h.seat(player, vehicle);
  return {
    entity, poses, placed, dynamic: vehicle.dynamic,
    /** Every action-bar line the driver was shown. */
    get bars(): string[] { return h.lines('actionbar', 'Driver'); },
    set: (x: number, y: number, j = false) => { h.controls(player, { strafe: x, forward: y, jump: j }); },
    dismount: () => { h.unseat(player); },
    run: (n: number) => { h.run(n); },
  };
}

describe('swept footprint (sweepFootprint)', () => {
  const solidCells = (cells: string[]) => (x: number, y: number, z: number): boolean => cells.includes(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
  const fp = { halfLength: 2, halfWidth: 1.2, lo: 0.2, hi: 1.5 };
  it('finds a trunk at a corner the centre line never touches', () => {
    // Heading +x (yaw -90): the corner at z = 0.5 + 1.2 reaches cell z = 1; the centre line (z = 0.5) stays in cell 0.
    const hit = sweepFootprint({ x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 0 }, { x: 0.3, y: 64, z: 0.5, yaw: -90, pitch: 0 }, fp, solidCells(['2,64,1']), FOOTPRINT);
    expect(hit.blocked).toBe(true);
    expect(Math.floor(hit.at![0])).toBe(2);
    expect(Math.floor(hit.at![2])).toBe(1);
  });
  it('lets a vehicle leave a block it already overlaps (a point blocks only when it ENTERS a solid)', () => {
    const cells = ['1,64,1', '2,64,1', '3,64,1'];
    expect(sweepFootprint({ x: 0, y: 64, z: 0.5, yaw: -90, pitch: 0 }, { x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 0 }, fp, solidCells(cells), FOOTPRINT).blocked).toBe(false);
  });
  it('sweeps a fast move in substeps, so a one-block trunk cannot be jumped between two ticks', () => {
    // 1.6 blocks in one tick (32 blocks/s): the nose (x + 2) goes from 1.5 to 3.1, over cell x = 2 between the two poses.
    const hit = sweepFootprint({ x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 0 }, { x: 1.1, y: 64, z: 0.5, yaw: -90, pitch: 0 }, { ...fp, halfWidth: 0.3 }, solidCells(['2,64,0']), FOOTPRINT);
    expect(hit.blocked).toBe(true);
  });
  it.each([-0.3, 0.3])('checks the trailing edge during a simultaneous horizontal and %s vertical move', dy => {
    // The nose is past a ledge but the tail is still over/under it. Leading
    // horizontal edges alone miss the tail entering it while falling/rising.
    const from = { x: 0, y: 64, z: 0.5, yaw: -90, pitch: 0 };
    const to = { ...from, x: 0.3, y: from.y + dy };
    const band = { halfLength: 2, halfWidth: 0.3, lo: 0.2, hi: 0.8 };
    const ledge = solidCells([`-2,${dy < 0 ? 63 : 65},0`]);
    expect(sweepFootprint(from, to, band, ledge, FOOTPRINT).blocked).toBe(true);
    expect(sweepFootprint(from, { ...to, y: from.y }, band, ledge, FOOTPRINT).blocked).toBe(false);
  });
  it('tilts the band with the pitch: a nose-up climb clears a low block the level nose would hit', () => {
    const low = solidCells(['2,64,0']);
    const level = sweepFootprint({ x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 0 }, { x: 0.3, y: 64, z: 0.5, yaw: -90, pitch: 0 }, { ...fp, halfWidth: 0.3 }, low, FOOTPRINT);
    const climbing = sweepFootprint({ x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 40 }, { x: 0.3, y: 64, z: 0.5, yaw: -90, pitch: 40 }, { ...fp, halfWidth: 0.3 }, low, FOOTPRINT);
    expect(level.blocked).toBe(true);
    expect(climbing.blocked).toBe(false);
  });
  it.each([1, 2, 4])('detects a one-block crown throughout a tall band at scale %s', scale => {
    const band = { halfLength: 2, halfWidth: 0.3, lo: 0.1, hi: 8.7 * scale };
    const from = { x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 0 };
    for (let height = 0; height < Math.floor(band.hi); height++) {
      const crown = solidCells([`2,${64 + height},0`]);
      expect(sweepFootprint(from, { ...from, x: 0.3 }, band, crown, FOOTPRINT).blocked, `crown at ${height}`).toBe(true);
    }
  });
  it('probes only the leading boundary: the bow going ahead, the stern backing up, the outward-swinging half in a turn', () => {
    const barge = { halfLength: 18, halfWidth: 7, lo: 0.6, hi: 13 };
    const none = (): boolean => false;
    const ahead = sweepFootprint({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, { x: 0, y: 64, z: 0.6, yaw: 0, pitch: 0 }, barge, none, FOOTPRINT);
    // Only the bow: 14 blocks at <= 0.9 spacing (17 points with both corners).
    const heights = Math.ceil((barge.hi - barge.lo) / FOOTPRINT.SPACING) + 1;
    expect(ahead.checks).toBe(17 * heights);
    const turning = sweepFootprint({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, { x: 0, y: 64, z: 0.6, yaw: 3.5, pitch: 0 }, barge, none, FOOTPRINT);
    expect(turning.checks).toBeGreaterThan(ahead.checks);
    // A stump just behind the stern stops it backing up, and nothing ahead of the bow does.
    const stern = (x: number, y: number, z: number): boolean => Math.floor(z) === -19 && Math.floor(y) === 64 && Math.abs(x) < 3;
    expect(sweepFootprint({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, { x: 0, y: 64, z: -0.6, yaw: 0, pitch: 0 }, barge, stern, FOOTPRINT).blocked).toBe(true);
    expect(sweepFootprint({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, { x: 0, y: 64, z: 0.6, yaw: 0, pitch: 0 }, barge, stern, FOOTPRINT).blocked).toBe(false);
  });
  it('tilts the band about its low end, so an aircraft rotating on the runway does not strike its tail', () => {
    // On flat ground (solid below y = 64), rotating nose-up from 7 to 8.5 degrees while turning a little:
    // tilted about its centre the tail band (8 blocks aft, 1.05 up) sank from 64.07 into the runway at 63.85.
    const runway = (_x: number, y: number): boolean => y < 64;
    const r = sweepFootprint({ x: 0, y: 64, z: 0, yaw: 0, pitch: 7 }, { x: 0, y: 64, z: 0.5, yaw: 1, pitch: 8.5 }, { halfLength: 8, halfWidth: 15, lo: 1.05, hi: 8.7 }, runway, FOOTPRINT);
    expect(r.blocked).toBe(false);
  });
  it('keeps horizontal probes bounded while covering the full height of a big hull', () => {
    const r = sweepFootprint({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, { x: 0, y: 64, z: 0.1, yaw: 0, pitch: 0 }, { halfLength: 18, halfWidth: 7, lo: 0.1, hi: 13 }, () => false, FOOTPRINT);
    const heights = Math.ceil((13 - 0.1) / FOOTPRINT.SPACING) + 1;
    expect(r.checks).toBeLessThanOrEqual((FOOTPRINT.MAX_POINTS + 8) * heights);
  });
});

describe('the collision response (resolveMove): never stuck', () => {
  const cells = (list: string[]) => (x: number, y: number, z: number): boolean => list.includes(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
  const fp = { halfLength: 2, halfWidth: 1.2, lo: 0.2, hi: 1.5 };
  // Heading +x: the nose goes from x 1.5 to 2.1, into cell x = 2.
  const from = { x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 0 };
  const to = { ...from, x: 0.1 };
  const car = { climb: 0, climbFirst: false };
  it('takes a clear move as it is', () => {
    expect(resolveMove(from, to, fp, () => false, FOOTPRINT, MOVE, car, sweepFootprint)).toMatchObject({ how: 'clear', kept: 1, pose: to });
  });
  it('steps AWAY from a trunk met by one half of the footprint, keeping its forward progress', () => {
    // A trunk at the +z corner (the vehicle's right, heading +x), 0.3 into its width: it steps to -z and keeps going.
    const shallow = { ...from, z: 0.1 };
    const r = resolveMove(shallow, { ...shallow, x: 0.1 }, fp, cells(['2,64,1']), FOOTPRINT, MOVE, car, sweepFootprint);
    expect(r.how).toBe('deflect');
    expect(r.pose.x).toBeCloseTo(0.1, 9);
    expect(r.pose.z).toBeCloseTo(0.1 - MOVE.DEFLECT_SHARE * 0.6, 9);
    // 0.7 into its width (more than one sidestep clears): it steps sideways where it stands, then on.
    const deep = resolveMove(from, to, fp, cells(['2,64,1']), FOOTPRINT, MOVE, car, sweepFootprint);
    expect(deep.how).toBe('deflect');
    expect(deep.pose.x).toBe(-0.5);
    expect(deep.pose.z).toBeLessThan(0.5);
  });
  it('does not step sideways along a wall across the whole way (both halves blocked): it slides or stops', () => {
    const wall = (x: number, y: number): boolean => Math.floor(x) === 2 && Math.floor(y) === 64;
    const r = resolveMove(from, to, fp, wall, FOOTPRINT, MOVE, car, sweepFootprint);
    expect(r.how).toBe('blocked');
    expect(r.pose).toMatchObject({ x: -0.5, z: 0.5 });
  });
  it('slides along a wall met at an angle, keeping the share of the move along it', () => {
    // A wall along x at z = 2 (cells z = 2), the move 30 degrees toward it.
    const wall = (_x: number, y: number, z: number): boolean => Math.floor(z) === 2 && Math.floor(y) === 64;
    const f = { x: 0, y: 64, z: 0.7, yaw: -60, pitch: 0 };
    const d = 0.6, r0 = -60 * Math.PI / 180;
    const t = { ...f, x: f.x - Math.sin(r0) * d, z: f.z + Math.cos(r0) * d };
    const r = resolveMove(f, t, { ...fp, halfWidth: 0.5 }, wall, FOOTPRINT, MOVE, car, sweepFootprint);
    expect(r.how).toBe('slide');
    expect(r.pose.z).toBe(f.z);
    expect(r.pose.x).toBeGreaterThan(f.x);
    expect(r.kept).toBeGreaterThan(0.5);
    expect(r.kept).toBeLessThan(1);
  });
  it('glances along a slanted wall across the whole way (a diagonal of blocks): the move turned toward the wall\'s line, shortened', () => {
    // Cells x = round((6 - z) tan 30) for z in -6..6: a wall across the lane, 60 degrees off the drive (+x).
    const diag = new Set<string>();
    for (let z = -6; z <= 6; z++) diag.add(`${Math.round((6 - z) * Math.tan(Math.PI / 6))},64,${z}`);
    const solid = (x: number, y: number, z: number): boolean => diag.has(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
    const wide = { ...fp, halfLength: 1, halfWidth: 1.5 };
    // Nose (x + 1) at 1.9, its +z corner (z 2) just short of the wall's nearest cell (2, 2); the wall recedes to -z.
    const f = { x: 0.9, y: 64, z: 0.5, yaw: -90, pitch: 0 };
    // Pushed straight ahead (+x) every step, it works along the wall's line toward the roomier (-z) end, past it,
    // and on: a deflect at the first corner, glancing slides along the diagonal after it - never into the wall.
    let pose = f;
    const hows = new Set<string>();
    for (let i = 0; i < 80 && pose.x < 9; i++) {
      const r = resolveMove(pose, { ...pose, x: pose.x + 0.6 }, wide, solid, FOOTPRINT, MOVE, car, sweepFootprint);
      hows.add(r.how);
      pose = r.pose;
    }
    expect(pose.x).toBeGreaterThanOrEqual(9);
    expect(pose.z).toBeLessThan(-6);
    expect(hows.has('slide')).toBe(true);
    expect(hows.has('blocked')).toBe(false);
  });
  it('climbs (a ship: over it first) or rises (straight up at the face) with a climb allowance; keeps the turn when only the turn is clear', () => {
    const low = (x: number, y: number): boolean => Math.floor(x) === 2 && Math.floor(y) === 64;
    const ship = { climb: 0.4, climbFirst: true };
    const shipFp = { ...fp, lo: 0.1 };
    // Against a one-block wall: lifted 0.4 the band's bottom (64.5) is still in it, so it rises in place.
    const rise = resolveMove(from, to, shipFp, low, FOOTPRINT, MOVE, ship, sweepFootprint);
    expect(rise.how).toBe('rise');
    expect(rise.pose.x).toBe(-0.5);
    expect(rise.pose.y).toBeCloseTo(64.4, 9);
    // From 64.6 lifted 0.4 the band's bottom (65.1) clears the wall's top at 65: over it, forward.
    const high = { ...from, y: 64.6 };
    const over = resolveMove(high, { ...high, x: 0.1 }, shipFp, low, FOOTPRINT, MOVE, ship, sweepFootprint);
    expect(over.how).toBe('climb');
    expect(over.pose.x).toBe(0.1);
    expect(over.pose.y).toBeCloseTo(65, 9);
    // A turn with the move: blocked forward, the turn alone clear - it keeps the turn.
    const wall = (x: number, y: number): boolean => Math.floor(x) === 2 && Math.floor(y) === 64;
    const r = resolveMove(from, { ...to, yaw: -80 }, fp, wall, FOOTPRINT, MOVE, car, sweepFootprint);
    expect(r.how).toBe('blocked');
    expect(r.pose).toMatchObject({ x: -0.5, z: 0.5, yaw: -80 });
  });
});

describe('the vehicle runtime against blocks (scripts/vehicles.js on the simulator)', () => {
  const car: ScriptedVehicleType = { mode: 'car', noseReach: 2, halfWidth: 1.2, height: 1.5 };
  /** Whether a pose's footprint rectangle (heading +x) overlaps a block cell [cx, cx+1] x [cz, cz+1] over the band's heights. */
  const overlapsCell = (p: { x: number; z: number }, half: { l: number; w: number }, cx: number, cz: number): boolean =>
    p.x + half.l > cx + 1e-3 && p.x - half.l < cx + 1 - 1e-3 && p.z + half.w > cz + 1e-3 && p.z - half.w < cz + 1 - 1e-3;
  it('steps a car round a trunk it meets with its corner, never through it (the old sweep stopped it dead there; the centre line drove through)', () => {
    const trunk = { fills: [{ from: [12, 64, 1] as [number, number, number], to: [12, 69, 1] as [number, number, number], id: 'minecraft:oak_log' }] };
    const wide = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, ...trunk });
    wide.set(0, 1);
    wide.run(100);
    // It got past the trunk, stepped AWAY from the side it hit (the trunk is at +z: it moved to -z) ...
    expect(wide.entity.location.x).toBeGreaterThan(16);
    expect(wide.entity.location.z).toBeLessThan(0.5 - 0.5);
    // ... and no pose put its body into the trunk's cell.
    expect(wide.poses.filter(p => overlapsCell(p, { l: car.noseReach, w: car.halfWidth }, 12, 1))).toEqual([]);
  });
  it('steps a ship round a post met by its wingtip, never through it', () => {
    const plane: ScriptedVehicleType = { mode: 'plane', noseReach: 3, halfWidth: 4, height: 2.5 };
    const host = vehicleHost({ type: plane, at: { x: 0.5, y: 64, z: 0.5 }, fills: [{ from: [9, 64, 4], to: [9, 70, 4], id: 'minecraft:oak_log' }] });
    host.set(0, 1);
    host.run(80);
    expect(host.entity.location.x).toBeGreaterThan(14);
    // Under the post's top (71) no pose overlaps it: it stepped round (or rose over) it.
    expect(host.poses.filter(p => p.y + 1.05 < 71 && overlapsCell(p, { l: plane.noseReach, w: plane.halfWidth }, 9, 4))).toEqual([]);
  });
  it('lifts a ship straight up off the ground on Jump, the long Milano too (no take-off run, no tail strike)', () => {
    // The Milano: 16 long, 30 wide, 8.8 tall.
    const milano: ScriptedVehicleType = { mode: 'plane', noseReach: 8, halfWidth: 15, height: 8.8 };
    const host = vehicleHost({ type: milano, at: { x: 0.5, y: 64, z: 0.5 } });
    host.set(0, 0, true);
    host.run(60);
    expect(host.entity.location.y).toBeGreaterThan(64 + FLIGHT.CLIMB_SPEED * 2);
    expect(Math.abs(host.entity.location.x - 0.5)).toBeLessThan(1e-6);
    expect(host.bars.some(b => /JUMP: UP/.test(b))).toBe(true);
  });
  it('lifts a ship over a wall it is flown into, without Jump (the old one stopped dead at it)', () => {
    const plane: ScriptedVehicleType = { mode: 'plane', noseReach: 2, halfWidth: 1.5, height: 1.5 };
    // A six-high wall across the path at x = 10.
    const host = vehicleHost({ type: plane, at: { x: 0.5, y: 64, z: 0.5 }, fills: [{ from: [10, 64, -6], to: [10, 69, 6], id: 'minecraft:stone' }] });
    host.set(0, 1);
    host.run(160);
    expect(host.entity.location.x).toBeGreaterThan(14);
    expect(Math.max(...host.poses.map(p => p.y))).toBeGreaterThanOrEqual(70 - 1e-6);
    expect(host.poses.filter(p => p.y < 70 - 1e-6 && overlapsCell(p, { l: plane.noseReach, w: plane.halfWidth }, 10, 0))).toEqual([]);
  });
  it('stops a ship going straight up under a roof instead of passing through it', () => {
    const plane: ScriptedVehicleType = { mode: 'plane', noseReach: 2, halfWidth: 1.5, height: 1.5 };
    const host = vehicleHost({ type: plane, at: { x: 0.5, y: 64, z: 0.5 }, fills: [{ from: [-5, 70, -5], to: [5, 70, 5], id: 'minecraft:stone' }] });
    host.set(0, 0, true);
    host.run(80);
    // Its top (y + 1.5 - 0.1, the band's top) stays under the roof's underside at 70.
    expect(Math.max(...host.poses.map(p => p.y))).toBeLessThanOrEqual(70 - 1.4 + 1e-6);
  });
  it('sinks an empty ship gently to the ground and parks it (an abandoned ship stays within reach)', () => {
    const plane: ScriptedVehicleType = { mode: 'plane', noseReach: 2, halfWidth: 1.5, height: 1.5 };
    const host = vehicleHost({ type: plane, at: { x: 0.5, y: 64, z: 0.5 } });
    host.set(0, 0, true);
    host.run(40);
    expect(host.entity.location.y).toBeGreaterThan(68);
    host.dismount();
    host.run(200);
    expect(host.entity.location.y).toBeCloseTo(64, 5);
  });
  it('drives a car out of a two-deep pit by scrambling up its far wall (the old car sat in it for ever)', () => {
    // A pit 2 deep (floor 62), 6 long along +x (x 6..11), wide across the path.
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, fills: [{ from: [6, 62, -6], to: [11, 63, 6], id: 'minecraft:air' }] });
    host.set(0, 1);
    host.run(200);
    expect(Math.min(...host.poses.map(p => p.y))).toBeLessThan(63);
    expect(host.entity.location.x).toBeGreaterThan(16);
    expect(host.entity.location.y).toBeCloseTo(64, 5);
  });
  it('slides a car along a wall it meets at an angle instead of stopping dead', () => {
    // A wall along x (z = 3), the car heading 20 degrees off +x toward it (yaw -70 turns toward +z).
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, yaw: -70, fills: [{ from: [-10, 64, 3], to: [200, 66, 3], id: 'minecraft:stone' }] });
    host.set(0, 1);
    host.run(120);
    expect(host.entity.location.x).toBeGreaterThan(14);
    // Never into the wall: the car's widest reach across (its rectangle turned 20 degrees) stays under z = 3.
    const reach = car.noseReach * Math.sin(20 * Math.PI / 180) + car.halfWidth * Math.cos(20 * Math.PI / 180);
    expect(Math.max(...host.poses.map(p => p.z))).toBeLessThanOrEqual(3 - reach + 0.05);
  });
  it('stops a car at a wall too high to climb, and it backs and pivots out', () => {
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, fills: [{ from: [10, 64, -6], to: [10, 68, 6], id: 'minecraft:stone' }] });
    host.set(0, 1);
    host.run(100);
    const stopped = host.entity.location.x;
    expect(stopped + car.noseReach).toBeLessThanOrEqual(10.05);
    expect(host.entity.location.y).toBeLessThanOrEqual(64 + CAR.RISE_MAX + 1e-6);
    expect(host.bars.at(-1)).toMatch(/BLOCKED/);
    // Back off, pivot a quarter turn at rest, and drive away along the wall.
    host.set(0, -1); host.run(30);
    host.set(CAR.STICK_X_RIGHT, 0); host.run(50);
    host.set(0, 1); host.run(40);
    expect(Math.hypot(host.entity.location.x - stopped, host.entity.location.z - 0.5)).toBeGreaterThan(5);
    expect(host.entity.location.y).toBeCloseTo(64, 5);
  });
  it('drives ON a collider plate floor, at its sixteenth, not a block above it', () => {
    const colliders = { block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi' };
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 65, z: 0.5 }, colliders, fills: [{ from: [-4, 64, -4], to: [30, 64, 4], id: 'craftmatic:collider[lo=0,hi=2]' }] });
    host.set(0, 0.5);
    host.run(60);
    expect(host.entity.location.y).toBeCloseTo(64 + 2 / 16, 5);
    expect(host.entity.location.x).toBeGreaterThan(3);
  });
  it('floats a hover craft off the land and over water, at its ride height, without sinking', () => {
    const hover: ScriptedVehicleType = { mode: 'hover', noseReach: 2, halfWidth: 1, height: 1.5 };
    // Water from x = 10 on: its surface (63.9) a block under the land's (64).
    const host = vehicleHost({ type: hover, at: { x: 0.5, y: 65, z: 0.5 }, fills: [{ from: [10, 62, -6], to: [60, 63, 6], id: 'minecraft:water' }, { from: [10, 63, -6], to: [60, 63, 6], id: 'minecraft:water' }] });
    host.set(0, 1);
    host.run(120);
    const over = host.poses.filter(p => p.x > 14);
    expect(over.length).toBeGreaterThan(5);
    // It rides HOVER.RIDE_HEIGHT above the surface (63.9), give or take its bob.
    for (const p of over.slice(-5)) expect(p.y).toBeGreaterThan(63.9 + HOVER.RIDE_HEIGHT - 0.2);
    expect(host.entity.location.x).toBeGreaterThan(20);
  });
  it('holds a deep-draft hull at its waterline instead of sinking a block a tick (10365)', () => {
    // 10365's keel sits 2.6 blocks over its origin (stand posts hang below), so
    // its draft is ~3.8. A water scan around the ORIGIN started under the
    // surface and took each deeper block for the top.
    const ship: ScriptedVehicleType = { mode: 'boat', noseReach: 3, halfWidth: 1.5, height: 20, draft: 3.8 };
    const host = vehicleHost({ type: ship, at: { x: 0.5, y: 63.9 - 3.8, z: 0.5 }, fills: [{ from: [-40, 50, -40], to: [40, 63, 40], id: 'minecraft:water' }] });
    host.dismount();
    host.run(60);
    expect(host.poses.length).toBeGreaterThan(30);
    // Its origin rides the draft under the surface (63.9), give or take the swell.
    expect(host.entity.location.y).toBeGreaterThan(63.9 - 3.8 - 0.1);
    expect(host.entity.location.y).toBeLessThan(63.9 - 3.8 + 0.1);
  });
  it('lights the way at night with one light block ahead of the nose, moves it, and clears it when the rider leaves', () => {
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, time: 18000 });
    host.set(0, 0.5);
    host.run(40);
    const lights = [...host.placed].filter(([, id]) => id === `minecraft:light_block_${HEADLIGHTS.LEVEL}`);
    expect(lights.length).toBe(1);
    const [cell] = lights[0]!;
    const [lx, ly] = cell.split(',').map(Number);
    // Ahead of the nose along +x, one block up.
    expect(lx!).toBeGreaterThan(host.entity.location.x + car.noseReach);
    expect(ly).toBe(65);
    // Every earlier light cell went back to air as it moved.
    expect([...host.placed].filter(([, id]) => id === 'minecraft:air').length).toBeGreaterThan(0);
    expect(host.dynamic.get(VEHICLE_DYNAMIC.headlight)).toBe(cell);
    host.dismount();
    host.run(2);
    expect([...host.placed].filter(([, id]) => id.startsWith('minecraft:light_block')).length).toBe(0);
    expect(host.dynamic.has(VEHICLE_DYNAMIC.headlight)).toBe(false);
  });
  it('brakes an empty car to a stop instead of letting it coast off (an empty time machine coasted 200 blocks)', () => {
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 } });
    host.set(0, 1);
    host.run(80);
    const at = host.entity.location.x;
    host.dismount();
    host.run(100);
    // From 19 blocks/s at BRAKE 14: about 13 blocks (a coast at 2.5 would roll 72).
    expect(host.entity.location.x - at).toBeLessThan(20);
    expect(host.entity.location.x - at).toBeGreaterThan(5);
  });
  it('drives a low car under an overhang without falling through the world (10797, Saga 2026-09-29)', () => {
    // A doll-scale car (1 block tall) passes under a collider whose underside is 1.25 over the road:
    // the ground scan started INSIDE that collider, read its top (2 over the car) as a wall under the
    // centre, called it "no ground" and dropped the car, which then fell through the stone for ever
    // (the Saga's 10797 car ended at y -104, under the world).
    const colliders = { block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi' };
    const low: ScriptedVehicleType = { mode: 'car', noseReach: 0.8, halfWidth: 0.5, height: 1 };
    const host = vehicleHost({ type: low, at: { x: 0.5, y: 64, z: 0.5 }, colliders, fills: [{ from: [5, 65, -3], to: [9, 65, 3], id: 'craftmatic:collider[lo=4,hi=16]' }] });
    host.set(0, 0.6);
    host.run(80);
    expect(Math.min(...host.poses.map(p => p.y))).toBeGreaterThan(63.9);
    expect(host.entity.location.x).toBeGreaterThan(10);
    expect(host.entity.location.y).toBeCloseTo(64, 5);
  });
  it('a car whose centre ends inside a solid block holds its height instead of falling', () => {
    // Spawned (or pushed) with its base inside a 2-block wall: no fall, whatever the scan reads above it.
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, fills: [{ from: [0, 64, 0], to: [0, 65, 0], id: 'minecraft:stone' }] });
    host.set(0, 0);
    host.run(20);
    expect(Math.min(64, ...host.poses.map(p => p.y))).toBeGreaterThan(63.9);
  });
  it('holds still where the terrain ahead or under it is not loaded, instead of falling through it', () => {
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, unloadedBeyondX: 30 });
    host.set(0, 1);
    host.run(200);
    // The nose probe (x + 2.5) meets the unloaded column first: it stops short of it, on the ground.
    expect(host.entity.location.x).toBeLessThan(30);
    expect(host.entity.location.x).toBeGreaterThan(20);
    expect(host.entity.location.y).toBe(64);
  });
  it('shows the controls hint for a new driver only at first, then only the speed (the bar covers the car on a phone)', () => {
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 } });
    host.set(0, 0.5);
    host.run(20);
    expect(host.bars.at(-1)).toMatch(/STICK: DRIVE \+ STEER/);
    host.run(120);
    expect(host.bars.at(-1)).toMatch(/mph/);
    expect(host.bars.at(-1)).not.toMatch(/STICK/);
  });
  it('places no light by day', () => {
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, time: 6000 });
    host.set(0, 0.5);
    host.run(40);
    expect(host.placed.size).toBe(0);
  });
  it('drives to the top speed another runtime sets (the time machine arms 88 mph)', () => {
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 } });
    host.dynamic.set(VEHICLE_DYNAMIC.topSpeed, 40.5);
    host.set(0, 1);
    host.run(200);
    const last = host.poses.slice(-2);
    expect((last[1]!.x - last[0]!.x) * 20 * 2.236936).toBeGreaterThan(88);
  });
});

describe('headlight and hover helpers', () => {
  it('calls it night from dusk to dawn', () => {
    expect(isNightTime(6000, HEADLIGHTS)).toBe(false);
    expect(isNightTime(13000, HEADLIGHTS)).toBe(true);
    expect(isNightTime(23000, HEADLIGHTS)).toBe(true);
    expect(isNightTime(23900, HEADLIGHTS)).toBe(false);
  });
  it('puts the light ahead of the nose along the heading', () => {
    expect(headlightCell(0.5, 64, 0.5, -90, 2, HEADLIGHTS)).toEqual([4, 65, 0]);
    expect(headlightCell(0.5, 64, 0.5, 0, 2, HEADLIGHTS)).toEqual([0, 65, 4]);
  });
  it('floats a sail barge and a speeder, and nothing titled otherwise', () => {
    expect(vehicleMotionOf('boat', "Jabba's Sail Barge (75397-1)")).toBe('hover');
    expect(vehicleMotionOf('plane', 'Speeder Bike Battle Pack')).toBe('hover');
    expect(vehicleMotionOf('boat', 'Pirate Ship')).toBe('boat');
    expect(HOVER_WORDS.test('Galaxy Explorer')).toBe(false);
  });
});
