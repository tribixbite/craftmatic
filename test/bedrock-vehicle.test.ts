/**
 * Driven vehicles: the road-wheel grouping of the compiler's vehicle rig and
 * the client drive animation (engine/bedrock-vehicle.ts).
 */
import { describe, expect, it } from 'vitest';
import { vehicleWheelAssemblies, type VehicleWheelBone } from '../web/src/engine/ldraw-entity-compiler.js';
import { BOAT, boatStep, CAR, carStep, type CarState, type CarTerrain, FLIGHT, FLIGHT_PROPS, flightStep, FOOTPRINT, HEADLIGHTS, HOVER, HOVER_WORDS, MOVE, resolveMove, VEHICLE_DYNAMIC, VEHICLE_EGRESS, vehicleEgress, type VehicleEgressInput, type VehicleEgressProbe, headlightCell, isNightTime, scriptedVehicleScript, sweepFootprint, vehicleClientAnimation, vehicleMotionOf, type BoatState, type BoatWater, type FlightInput, type FlightState, type ScriptedVehicleConfig, type ScriptedVehicleType, flightProperties } from '../web/src/engine/bedrock-vehicle.js';
import { simHost, solidBelow } from './_sim-host.js';
import { ESCAPE_OPTIONS } from '../web/src/engine/collider-form.js';

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
    // The set-down (SEAT-05) and the collider body probe it reads the world through.
    expect(js).toContain('function vehicleEgress');
    expect(js).toContain('function colliderBodyProbe');
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
  /** The seat as the size group declares it (the unscaled frame; default [0, 0.5, 0]) and the entity's `minecraft:scale`. */
  seat?: [number, number, number];
  scale?: number;
  /** Ship the set-down (`VEHICLE_EGRESS`, `ESCAPE_OPTIONS`) as a real pack does (SEAT-05). */
  egress?: boolean;
}

/** The scripted vehicle's type as the pack declares it: the vehicle family, its flight properties, one player seat (and a size's scale). */
const vehicleType = (seat: [number, number, number] = [0, 0.5, 0], scale?: number) => ({
  properties: flightProperties() as Record<string, Record<string, unknown>>,
  components: {
    'minecraft:type_family': { family: ['craftmatic_vehicle'] },
    'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: [{ position: seat }] },
    ...(scale === undefined ? {} : { 'minecraft:scale': { value: scale } }),
  },
});

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
    script: scriptedVehicleScript(hostConfig({ [typeId]: o.type }, { ...(o.colliders ? { colliders: o.colliders } : {}), ...(o.egress ? { egress: VEHICLE_EGRESS, escape: ESCAPE_OPTIONS } : {}) })),
    entities: { [typeId]: vehicleType(o.seat, o.scale) }, colliders: !!o.colliders, terrain: solidBelow(64), timeOfDay: o.time ?? 6000,
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
    entity, poses, placed, dynamic: vehicle.dynamic, player, vehicle,
    /** Every action-bar line the driver was shown. */
    get bars(): string[] { return h.lines('actionbar', 'Driver'); },
    set: (x: number, y: number, j = false) => { h.controls(player, { strafe: x, forward: y, jump: j }); },
    dismount: () => { h.unseat(player); },
    /** The device's sneak: Bedrock's own set-down about the seat (quirk `dismount-near-seat`), then the runtime. */
    sneak: () => { h.controls(player, { sneak: true }); },
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
  it('lets an embedded hull rise out along a solid layer, but does not enter a new obstacle above it', () => {
    // 10786's source-placed boat begins with several boundary samples in this
    // voxel. On its first forward/rising tick another sample enters the same
    // voxel; the old all-edge test treated that as a new obstruction.
    const from = { x: 23, y: -60, z: 0, yaw: 0, pitch: -1.5 };
    const to = { x: 23, y: -59.125, z: -0.03, yaw: 0, pitch: -2 };
    const band = { halfLength: 3.47, halfWidth: 2.48, lo: 0.41, hi: 2.97 };
    const embedded = solidCells(['23,-59,3']);
    expect(sweepFootprint(from, to, band, embedded, FOOTPRINT).blocked).toBe(false);
    const ceiling = solidCells(['23,-57,3']);
    expect(sweepFootprint(from, to, band, ceiling, FOOTPRINT).blocked).toBe(true);
    // Existing low penetration does not license an unrelated higher voxel.
    const embeddedFloorAndCeiling = solidCells(['23,-59,3', '23,-57,3']);
    expect(sweepFootprint(from, to, band, embeddedFloorAndCeiling, FOOTPRINT).blocked).toBe(true);
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
  describe('probes a vertical move only at the face that leads it (the Pixel paid 20-24 ms of a 50 ms tick for 890 probes)', () => {
    // The Milano as shipped (76286: noseReach 8.02, halfWidth 15, height 8.48), its ship band at scale k.
    const milano = (k: number) => ({ halfLength: 8.02 * k, halfWidth: 15 * k, lo: 0.1, hi: 8.48 * k - 0.1 });
    const at = { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0 };
    const checks = (band: { halfLength: number; halfWidth: number; lo: number; hi: number }, to: Partial<typeof at>, from: Partial<typeof at> = {}): number =>
      sweepFootprint({ ...at, ...from }, { ...at, ...to }, band, () => false, FOOTPRINT).checks;
    /** Perimeter probe points of a band (each edge at <= SPACING, both corners), the count a whole-perimeter, one-level sweep makes. */
    const perimeterPoints = (band: { halfLength: number; halfWidth: number }): number => {
      const spacing = Math.max(FOOTPRINT.SPACING, 4 * (band.halfLength + band.halfWidth) / FOOTPRINT.MAX_POINTS);
      const n = (len: number): number => Math.max(1, Math.ceil(len / spacing)) + 1;
      return 2 * n(2 * band.halfWidth) + 2 * n(2 * band.halfLength);
    };
    it.each([1, 2])('a cruising, climbing Milano at %sx adds at most one probe per perimeter point per pose to its level cruise', k => {
      const level = checks(milano(k), { z: at.z + 0.9 * k });
      const climbing = checks(milano(k), { z: at.z + 0.9 * k, y: at.y + 0.05 * k, pitch: 2.1 }, { pitch: 2 });
      const poses = Math.ceil(Math.hypot(0.9 * k, 0.05 * k) / FOOTPRINT.SWEEP_STEP);
      expect(climbing).toBeLessThanOrEqual(level + perimeterPoints(milano(k)) * poses);
      // The measured counts (scripts/_sweep_checks.ts): 916 at 1x and 2,853 at 2x, where every level at every point was 2,376 and 8,040.
      expect(climbing).toBeLessThan(k === 1 ? 1000 : 3000);
    });
    it('a straight drop or lift probes every perimeter point once per pose: the floor going down, the roof going up', () => {
      const car = { halfLength: 3.49, halfWidth: 2.24, lo: 1.1, hi: 1.69 };
      expect(checks(car, { y: at.y - 0.4 })).toBe(perimeterPoints(car));
      expect(checks(car, { y: at.y + 0.4 })).toBe(perimeterPoints(car));
      // And it is the floor / roof that is probed: a block under the floor stops the drop, one level with the roof the lift.
      const below = (x: number, y: number): boolean => Math.floor(y) === 64 && Math.abs(x - at.x) < 3;
      expect(sweepFootprint({ ...at, y: 64.5 }, { ...at, y: 64.5 - 0.4 }, { ...car, lo: 0.6 }, below, FOOTPRINT).blocked).toBe(true);
      const above = (x: number, y: number): boolean => Math.floor(y) === 66 && Math.abs(x - at.x) < 3;
      expect(sweepFootprint({ ...at, y: 64 }, { ...at, y: 64.4 }, { ...car, hi: 1.8 }, above, FOOTPRINT).blocked).toBe(true);
    });
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
  it('a ship never deflects along a wall met off square (one half meets it first): it rises at it; a car, with no lift, steps along it (Saga 30j, VEH-08)', () => {
    // A one-high wall at x = 2 across every z; the move 19 degrees off square (yaw -71 heads +x and a little +z),
    // so the +z half of the nose reaches the wall first. The halves alone read that as "a post met with a corner".
    const wall = (x: number, y: number): boolean => Math.floor(x) === 2 && Math.floor(y) === 64;
    const f = { x: -0.5, y: 64, z: 0.5, yaw: -71, pitch: 0 }, r0 = -71 * Math.PI / 180;
    const t = { ...f, x: f.x - Math.sin(r0) * 0.6, z: f.z + Math.cos(r0) * 0.6 };
    const ship = resolveMove(f, t, { ...fp, lo: 0.1 }, wall, FOOTPRINT, MOVE, { climb: 0.4, climbFirst: true }, sweepFootprint);
    expect(ship.how).toBe('rise');
    expect(ship.pose).toMatchObject({ x: -0.5, z: 0.5 });
    expect(ship.pose.y).toBeCloseTo(64.4, 9);
    // A car keeps the halves' rule: the sidestep along the wall is its way along (the McLaren's device slide-along).
    const road = resolveMove(f, t, fp, wall, FOOTPRINT, MOVE, car, sweepFootprint);
    expect(road.how).toBe('deflect');
    expect(road.pose.x).toBeLessThanOrEqual(f.x + 1e-9);
    expect(road.pose.z).toBeGreaterThan(0.5);
  });
  it('a ship deflects only round a NARROW block (at most NARROW_CELLS joined cells in its plane): a post or a crown, never a wall of any shape', () => {
    const ship = { climb: 0.4, climbFirst: true }, shipFp = { ...fp, lo: 0.1 };
    const f = { ...from, z: 0.1 }, t = { ...f, x: 0.1 };
    // A single post, a 2x2 pillar and a 3x3 crown at the +z corner, taller than one climb: stepped round.
    const column = (cx: number, cz: number): string[] => [64, 65, 66].map(y => `${cx},${y},${cz}`);
    for (const cells of [column(2, 1), [...column(2, 1), ...column(3, 1), ...column(2, 2), ...column(3, 2)], [2, 3, 4].flatMap(cx => [1, 2, 3].flatMap(cz => column(cx, cz)))]) {
      const solid = (x: number, y: number, z: number): boolean => cells.includes(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
      expect(resolveMove(f, t, shipFp, solid, FOOTPRINT, MOVE, ship, sweepFootprint).how).toBe('deflect');
    }
    // A diagonal of NARROW_CELLS + 1 cells through the same corner (8-connected: one wall): no deflect, it rises.
    const diag = new Set<string>();
    for (let k = 0; k <= MOVE.NARROW_CELLS; k++) for (const y of [64, 65, 66]) diag.add(`${2 + k},${y},${1 + k}`);
    const wallish = (x: number, y: number, z: number): boolean => diag.has(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
    const r = resolveMove(f, t, shipFp, wallish, FOOTPRINT, MOVE, ship, sweepFootprint);
    expect(r.how).toBe('rise');
  });
  it('a turn on the spot never rises: with its tail against a post it pivots about the tail, or is blocked (Saga 30j: lifted 4-6 blocks)', () => {
    const ship = { climb: 0.4, climbFirst: true };
    // Heading +x, turning right (yaw -90 -> -80): the nose swings to +z, the tail to -z. The tail's -z corner
    // (x -2.5, z -0.7) swings into cell (-3, 64, -2), a post there.
    const post = cells(['-3,64,-2']);
    const turn = { ...from, yaw: -80 };
    const r = resolveMove(from, turn, fp, post, FOOTPRINT, MOVE, ship, sweepFootprint);
    expect(r.how).toBe('pivot');
    expect(r.pose.y).toBe(64);
    expect(r.pose.yaw).toBe(-80);
    // The tail point stays where it was: centre - L * heading.
    const r1 = -80 * Math.PI / 180;
    expect(r.pose.x - fp.halfLength * -Math.sin(r1)).toBeCloseTo(from.x - fp.halfLength, 6);
    expect(r.pose.z - fp.halfLength * Math.cos(r1)).toBeCloseTo(from.z, 6);
    // Both ends against posts (the nose's +z corner, x 1.5 z 1.7, swings into cell (1, 64, 2)): blocked, still not lifted.
    const both = cells(['-3,64,-2', '1,64,2']);
    const b = resolveMove(from, turn, fp, both, FOOTPRINT, MOVE, ship, sweepFootprint);
    expect(b.how).toBe('blocked');
    expect(b.pose.y).toBe(64);
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
  // The X-wing as 7140's pack ships it (packs-f200ddc7 vehicles.js config).
  const xwing: ScriptedVehicleType = { mode: 'plane', noseReach: 6.36, halfWidth: 5.82, height: 4.26 };
  it('lifts a ship over a hill it is flown into 19 degrees off square instead of sliding along it (Saga 30j, VEH-08)', () => {
    // A two-high hill across the way at x = 20, long toward +z (the side a sidestep runs to): yaw -71 heads +x and a
    // little +z. The device's X-wing met its 2-high hill and 10-high wall at yaw -19 to an axis-aligned face and
    // "deflected" 13-50 blocks along it, never lifting (CMVT 15:19:25-31, 15:21:04-09, 15:22:15-17).
    const host = vehicleHost({ type: xwing, at: { x: 0.5, y: 64, z: 0.5 }, yaw: -71, fills: [{ from: [20, 64, -12], to: [21, 65, 120], id: 'minecraft:stone' }] });
    // A hundred ticks aboard first, so the HUD shows what the runtime does instead of the controls hint.
    host.run(100);
    host.set(0, 1);
    host.run(200);
    /** Whether a pose's TURNED footprint rectangle reaches into cell (cx, cz). */
    const turnedInto = (p: { x: number; z: number; yaw: number }, cx: number, cz: number): boolean => {
      const r = p.yaw * Math.PI / 180, fx = -Math.sin(r), fz = Math.cos(r), rx = -Math.cos(r), rz = -Math.sin(r);
      for (const [px, pz] of [[cx + 0.5, cz + 0.5], [cx + 0.05, cz + 0.05], [cx + 0.95, cz + 0.05], [cx + 0.05, cz + 0.95], [cx + 0.95, cz + 0.95]]) {
        const dx = px! - p.x, dz = pz! - p.z;
        if (Math.abs(dx * fx + dz * fz) < xwing.noseReach - 0.05 && Math.abs(dx * rx + dz * rz) < xwing.halfWidth - 0.05) return true;
      }
      return false;
    };
    // It got past, over the top (the band's bottom, y + 0.1, above 66), with no pose at the hill's height inside it ...
    expect(host.entity.location.x).toBeGreaterThan(22 + xwing.noseReach);
    expect(Math.max(...host.poses.map(p => p.y))).toBeGreaterThanOrEqual(66 - 0.1 - 1e-6);
    const low = host.poses.filter(p => p.y + 0.1 < 66 - 1e-6);
    const inside = low.filter(p => [20, 21].some(cx => { for (let cz = -12; cz <= 120; cz++) if (turnedInto(p, cx, cz)) return true; return false; }));
    expect(inside).toEqual([]);
    // ... and it did not run along the hill: where it crossed, its drift across is the heading's own (tan 19 degrees
    // of its progress), not a sidestep's 12 blocks/s (the device's 13-50 blocks along the face).
    const crossed = host.poses.find(p => p.x - xwing.noseReach > 22)!;
    expect(crossed.z - 0.5).toBeLessThan((crossed.x - 0.5) * Math.tan(19 * Math.PI / 180) + 3);
    expect(host.bars.some(b => /LIFTING OVER/.test(b))).toBe(true);
  });
  it('a turn on the spot with the tail against a post neither climbs it nor passes through it: it pivots (Saga 30j: rose 4-6 blocks)', () => {
    // Heading +x on the ground; turning right swings the tail to -z. The tail's -z corner (x -5.86, z -5.32)
    // meets a post column at cell (-6, -7) after a few degrees; the post spans the airframe's height.
    const host = vehicleHost({ type: xwing, at: { x: 0.5, y: 64, z: 0.5 }, fills: [{ from: [-6, 64, -7], to: [-6, 69, -7], id: 'minecraft:oak_log' }] });
    const yaw0 = host.vehicle.rotation.y;
    host.set(FLIGHT.STICK_X_RIGHT, 0);
    host.run(40);
    expect(host.entity.location.y).toBeCloseTo(64, 6);
    expect(Math.max(...host.poses.map(p => p.y))).toBeCloseTo(64, 6);
    // It still turned (about its tail), and never put its body into the post's cell.
    const turned = ((host.vehicle.rotation.y - yaw0 + 540) % 360) - 180;
    expect(turned).toBeGreaterThan(20);
    expect(host.poses.filter(p => Math.hypot(p.x - (-5.5), p.z - (-6.5)) < 0.5)).toEqual([]);
  });
  it('an empty ship sinking to park holds over a player under it and sinks on when they walk out (Saga 30j s79: parked ON the child)', () => {
    const host = vehicleHost({ type: xwing, at: { x: 0.5, y: 64, z: 0.5 } });
    host.set(0, 0, true);
    host.run(40);
    expect(host.entity.location.y).toBeGreaterThan(70);
    host.set(0, 0);
    host.dismount();
    // The rider falls straight under the hull; the ship sinks after it and must stop over the rider's head.
    host.run(200);
    const feet = host.player.location.y;
    expect(feet).toBeCloseTo(64, 1);
    expect(host.entity.location.y).toBeCloseTo(feet + FLIGHT.PLAYER_HEIGHT + FLIGHT.PARK_CLEARANCE, 2);
    // Out from under it: it parks on the ground.
    host.player.location = { x: host.player.location.x + 2 * xwing.noseReach + 4, y: feet, z: host.player.location.z };
    host.run(200);
    expect(host.entity.location.y).toBeCloseTo(64, 5);
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
    // The rider falls under it and walks out (an empty ship never parks on a player: the test above).
    host.run(20);
    host.player.location = { x: host.player.location.x + 10, y: 64, z: host.player.location.z };
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

describe('getting off a scripted vehicle (SEAT-05: vehicleEgress)', () => {
  // The Milano as the vehicle test above drives it (16 long, 30 wide, 8.8 tall at 100 %), seat (0, 4.58, 3.6) at 100 %.
  const milano: ScriptedVehicleType = { mode: 'plane', noseReach: 8, halfWidth: 15, height: 8.8 };
  const SEAT100: [number, number, number] = [0, 4.58, 3.6];
  type P3 = { x: number; y: number; z: number };
  /** A flat world: the ground's top at `ground` everywhere, raised to `wall` where `walled(x, z)`, water up to `water` where `wetAt(x, z)`. */
  const flat = (o: { ground?: number; walled?: (x: number, z: number) => boolean; wall?: number; wetAt?: (x: number, z: number) => boolean; water?: number; escape?: P3 } = {}): VehicleEgressProbe => {
    const ground = o.ground ?? 64, wall = o.wall ?? ground + 4;
    const top = (x: number, z: number): number => (o.walled?.(x, z) ? wall : ground);
    const corners = (q: { x: number; z: number }): Array<[number, number]> => [[q.x - 0.3, q.z - 0.3], [q.x + 0.3, q.z - 0.3], [q.x - 0.3, q.z + 0.3], [q.x + 0.3, q.z + 0.3]];
    const free = (q: P3): boolean => corners(q).every(([cx, cz]) => top(cx, cz) <= q.y + 1e-9);
    return {
      floor: (x, z, t, depth) => {
        const tops = corners({ x, z }).map(([cx, cz]) => top(cx, cz)).filter(y => y <= t + 1e-9 && y >= t - depth - 1e-9);
        return tops.length ? Math.max(...tops) : null;
      },
      free,
      walkExit: q => free(q) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const n = { x: q.x + dx!, y: q.y, z: q.z + dz! }; return Math.abs(top(n.x, n.z) - q.y) <= 9 / 16 && free(n); }),
      wet: q => !!o.wetAt?.(q.x, q.z) && q.y < (o.water ?? ground),
      escape: () => o.escape,
    };
  };
  /** The Milano parked at the origin facing +Z (yaw 0) at wand factor `k`, Bedrock having set the rider down a block off its seat. */
  const atSize = (k: number, extra: Partial<VehicleEgressInput> = {}): VehicleEgressInput => {
    const seat = { x: SEAT100[0] * k, y: 64 + SEAT100[1] * k - 0.5, z: SEAT100[2] * k };
    return { pose: { x: 0, y: 64, z: 0, yaw: 0 }, halfLength: milano.noseReach * k, halfWidth: milano.halfWidth * k, height: milano.height * k, scale: k, seat, current: { x: seat.x, y: seat.y + 0.2, z: seat.z - 1 }, airborne: false, ...extra };
  };
  /** Within the footprint (half a body of slack) and under the hull's top, the Milano facing +Z at the origin. */
  const inHull = (q: P3, k: number): boolean => Math.abs(q.z) < milano.noseReach * k + 0.3 && Math.abs(q.x) < milano.halfWidth * k + 0.3 && q.y < 64 + milano.height * k;

  it.each([1, 2, 4])('sets the rider down on the ground BESIDE the hull at %ix, the side nearest the seat, never in it (Pixel 30l: ~9 blocks off the 200 percent Milano)', k => {
    const r = vehicleEgress(atSize(k), flat(), VEHICLE_EGRESS);
    expect(r.how).toBe('beside');
    expect(r.at.y).toBe(64);
    expect(inHull(r.at, k)).toBe(false);
    // The seat is forward of the centre: the nose side, straight ahead of it (L + margin + half a body).
    expect(r.at.x).toBeCloseTo(0, 6);
    expect(r.at.z).toBeCloseTo(milano.noseReach * k + VEHICLE_EGRESS.MARGIN + 0.3, 6);
  });
  it('leaves Bedrock\'s own set-down alone when it is already outside the hull on a walkable floor', () => {
    const current = { x: 16, y: 64, z: 3.6 };
    expect(vehicleEgress(atSize(1, { current, seat: { x: 15.5, y: 64.2, z: 3.6 } }), flat(), VEHICLE_EGRESS)).toEqual({ at: current, how: 'native' });
  });
  it('leaves a player moved away on purpose (a /tp out of the seat) where it went', () => {
    expect(vehicleEgress(atSize(2, { current: { x: 80, y: 64, z: 80 } }), flat(), VEHICLE_EGRESS).how).toBe('moved');
  });
  it('in the air: beside the hull at the seat\'s height, to float down (never under the hull, where it parks)', () => {
    const r = vehicleEgress(atSize(2, { airborne: true, pose: { x: 0, y: 90, z: 0, yaw: 0 }, seat: { x: 0, y: 99, z: 7.2 }, current: { x: 0, y: 99.2, z: 6.2 } }), flat(), VEHICLE_EGRESS);
    expect(r.how).toBe('float');
    expect(r.at.y).toBe(99);
    expect(r.at.z).toBeGreaterThan(milano.noseReach * 2);
  });
  it('afloat with no shore beside it: in the water beside the hull at its waterline; a pier beside it is taken first', () => {
    const boat = { pose: { x: 0, y: 62, z: 0, yaw: 0 }, seat: { x: 0, y: 63.5, z: 1 }, current: { x: 0, y: 63.7, z: 0 }, halfLength: 3, halfWidth: 1.5, height: 2.5, waterline: 63 };
    // Open water: the sea bed lies 5 under the boat's base, past the drop: no floor, so a swim beside the hull.
    const sea = flat({ ground: 57, wetAt: () => true, water: 64 });
    const swim = vehicleEgress(atSize(1, boat), sea, VEHICLE_EGRESS);
    expect(swim.how).toBe('swim');
    expect(swim.at.y).toBe(63);
    // Beside the hull nearest the seat: off its side (1.5 + margin + half a body), level with the seat.
    expect(Math.abs(swim.at.x)).toBeCloseTo(1.5 + VEHICLE_EGRESS.MARGIN + 0.3, 6);
    expect(Math.abs(swim.at.z - boat.seat.z)).toBeLessThan(0.5);
    // A pier along one side (x <= -1.6, the boat's right), its top at 63: a dry floor beside the hull, taken.
    const pier = flat({ ground: 57, wetAt: (x: number) => x > -1.6, water: 64, walled: (x: number) => x <= -1.6, wall: 63 });
    const p = vehicleEgress(atSize(1, boat), pier, VEHICLE_EGRESS);
    expect(p.how).toBe('beside');
    expect(p.at.y).toBe(63);
  });
  it('walled in beside the hull (a car in its garage): the collider probe\'s escape, never a spot inside the hull', () => {
    const car = { pose: { x: 0.5, y: 64, z: 0.5, yaw: 0 }, halfLength: 2, halfWidth: 1.2, height: 1.5, seat: { x: 0.5, y: 64.1, z: 0.5 }, current: { x: 0.5, y: 64.3, z: -0.5 } };
    // Walls everywhere outside the footprint: no spot beside the hull fits.
    const walled = (x: number, z: number): boolean => Math.abs(x - 0.5) > 1.6 || Math.abs(z - 0.5) > 2.4;
    expect(vehicleEgress(atSize(1, car), flat({ walled, wall: 80, escape: { x: 6, y: 64, z: 9 } }), VEHICLE_EGRESS)).toEqual({ at: { x: 6, y: 64, z: 9 }, how: 'escape' });
    // An escape that lands inside the footprint is refused: the hull is an entity no block probe sees.
    expect(vehicleEgress(atSize(1, car), flat({ walled, wall: 80, escape: { x: 0.5, y: 64, z: 0.5 } }), VEHICLE_EGRESS).how).toBe('none');
  });
  it('the shipped runtime sets a sneaking rider down beside the 100/200/400 percent Milano on the ground, with no fall (scripts/vehicles.js on the simulator)', () => {
    for (const k of [1, 2, 4]) {
      // The pack declares the seat unscaled and the device multiplies it by the scale (quirk seat-scales-with-entity).
      const host = vehicleHost({ type: { ...milano }, at: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, seat: SEAT100, scale: k, egress: true });
      host.run(4);
      expect(host.player.location.y).toBeGreaterThan(64 + SEAT100[1] * k - 1);
      host.sneak();
      let lowest = Infinity;
      for (let t = 0; t < 40; t++) { host.run(1); lowest = Math.min(lowest, host.player.location.y); }
      const p = host.player.location;
      expect(host.player.ridingOn, `${k}x still riding`).toBeUndefined();
      expect(p.y, `${k}x on the ground`).toBeCloseTo(64, 3);
      // Never under the ground, never inside the hull: beside it, ahead of the nose (the seat's side).
      expect(lowest).toBeGreaterThanOrEqual(64 - 1e-6);
      expect(Math.abs(p.z - 0.5)).toBeGreaterThanOrEqual(milano.noseReach * k);
    }
  });
  it('reads the vehicle\'s LIVE scale for the set-down: a size event after the runtime first saw it still lands the rider beside the resized hull', () => {
    const host = vehicleHost({ type: { ...milano }, at: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, seat: SEAT100, egress: true });
    host.run(4);
    // The wand's size event, after the runtime's first sight of the vehicle (its state keeps scale 1).
    host.vehicle.components['minecraft:scale'] = { value: 2 };
    host.run(4);
    host.sneak();
    host.run(40);
    expect(host.player.location.y).toBeCloseTo(64, 3);
    expect(Math.abs(host.player.location.z - 0.5)).toBeGreaterThanOrEqual(milano.noseReach * 2);
  });
  it('without the set-down (a pack built before it) the same sneak drops the rider from the seat\'s height (Pixel 30l: ~9 blocks at 200 percent)', () => {
    const host = vehicleHost({ type: { ...milano }, at: { x: 0.5, y: 64, z: 0.5 }, yaw: 0, seat: SEAT100, scale: 2 });
    host.run(4);
    host.sneak();
    host.run(2);
    const top = host.player.location.y;
    host.run(60);
    expect(top - 64).toBeGreaterThan(8);
    expect(host.player.location.y).toBeCloseTo(64, 3);
  });
});
