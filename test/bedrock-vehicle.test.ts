/**
 * Driven vehicles: the road-wheel grouping of the compiler's vehicle rig and
 * the client drive animation (engine/bedrock-vehicle.ts).
 */
import { describe, expect, it } from 'vitest';
import { vehicleWheelAssemblies, type VehicleWheelBone } from '../web/src/engine/ldraw-entity-compiler.js';
import { BOAT, boatStep, CAR, carStep, type CarState, type CarTerrain, FLIGHT, FLIGHT_PROPS, flightStep, FOOTPRINT, HEADLIGHTS, HOVER, HOVER_WORDS, VEHICLE_DYNAMIC, headlightCell, isNightTime, scriptedVehicleScript, sweepFootprint, vehicleClientAnimation, vehicleMotionOf, type BoatState, type BoatWater, type FlightInput, type FlightState, type ScriptedVehicleConfig, type ScriptedVehicleType } from '../web/src/engine/bedrock-vehicle.js';

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
    const js = scriptedVehicleScript(hostConfig({ 'craftmatic:p': { mode: 'plane', noseReach: 4, halfWidth: 3, height: 2 } }));
    expect(js).toContain('function flightStep');
    expect(js).toContain('function boatStep');
    expect(js).toContain('function carStep');
    expect(js).toContain('function sweepFootprint');
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

// ─── The pack runtime on a fake world (the serialised text, as the device runs it) ───

/** The runtime's config for a set of types, with the pack's real constants. */
function hostConfig(types: Record<string, ScriptedVehicleType>, extra: Partial<ScriptedVehicleConfig> = {}): ScriptedVehicleConfig {
  return { types, flight: FLIGHT, boat: BOAT, car: CAR, hover: HOVER, footprint: FOOTPRINT, headlights: HEADLIGHTS, props: FLIGHT_PROPS, dynamic: VEHICLE_DYNAMIC, inputEvent: 'craftmatic:flight_input', telemetryEvent: 'craftmatic:vehicle_telemetry', ...extra };
}

interface HostOptions {
  type: ScriptedVehicleType;
  /** Where the vehicle starts, and its yaw (Bedrock: -90 faces +x). */
  at: { x: number; y: number; z: number }; yaw?: number;
  /** Block ids by "x,y,z" over the default world: stone below y = 64, air above. */
  blocks?: Record<string, string>;
  /** A block id for a whole cell range (x0..x1, y0..y1, z0..z1 inclusive), applied before `blocks`. */
  fills?: Array<{ from: [number, number, number]; to: [number, number, number]; id: string }>;
  time?: number;
  colliders?: ScriptedVehicleConfig['colliders'];
  /** Blocks at x beyond this are not loaded (getBlock returns undefined). */
  unloadedBeyondX?: number;
}

/**
 * Run `scripts/vehicles.js` (the serialised runtime) against a fake world: one
 * vehicle, one player riding it whose stick the test sets, blocks from a map.
 * Records the vehicle's poses, and every block the runtime SETS (headlights).
 */
function vehicleHost(o: HostOptions) {
  const typeId = 'craftmatic:t_vehicle';
  const placed = new Map<string, string>();
  const blockId = (x: number, y: number, z: number): string => {
    const k = `${x},${y},${z}`;
    if (placed.has(k)) return placed.get(k)!;
    if (o.blocks?.[k]) return o.blocks[k]!;
    for (const f of o.fills ?? []) if (x >= f.from[0] && x <= f.to[0] && y >= f.from[1] && y <= f.to[1] && z >= f.from[2] && z <= f.to[2]) return f.id;
    return y < 64 ? 'minecraft:stone' : 'minecraft:air';
  };
  const block = (p: { x: number; y: number; z: number }): any => {
    if (o.unloadedBeyondX !== undefined && p.x > o.unloadedBeyondX) return undefined;
    const id = blockId(p.x, p.y, p.z);
    const m = /^(.*)\[lo=(\d+),hi=(\d+)\]$/.exec(id);
    return {
      typeId: m ? m[1] : id, isAir: id === 'minecraft:air', isLiquid: id === 'minecraft:water',
      permutation: { getState: (s: string) => (m ? (s.endsWith(':lo') ? Number(m[2]) : Number(m[3])) : s === 'minecraft:vertical_half' ? (id.endsWith('_slab') ? 'bottom' : undefined) : undefined) },
      setType: (t: string) => { placed.set(`${p.x},${p.y},${p.z}`, t); },
    };
  };
  let stick = { x: 0, y: 0 }, jump = false, riding = true;
  const player = { typeId: 'minecraft:player', inputInfo: { getMovementVector: () => ({ ...stick }), getButtonState: () => (jump ? 'Pressed' : 'Released') }, onScreenDisplay: { setActionBar: () => {} } };
  const dynamic = new Map<string, unknown>();
  const poses: Array<{ x: number; y: number; z: number; yaw: number }> = [];
  const dim: any = { id: 'overworld', getBlock: block, getEntities: (q: { type?: string; families?: string[] }) => (q.type === typeId || q.families?.includes('craftmatic_vehicle') ? [entity] : []), playSound: () => {}, runCommand: () => ({}) };
  const entity: any = {
    id: 'v1', typeId, location: { ...o.at }, rot: { x: 0, y: o.yaw ?? -90 }, dimension: dim,
    getRotation() { return { ...this.rot }; },
    teleport(p: any, opt: any) { this.location = { ...p }; if (opt?.rotation) this.rot = { ...opt.rotation }; poses.push({ ...p, yaw: this.rot.y }); },
    setProperty: () => {}, getDynamicProperty: (k: string) => dynamic.get(k), setDynamicProperty: (k: string, v: unknown) => { if (v === undefined) dynamic.delete(k); else dynamic.set(k, v); },
    getComponent: (name: string) => (name === 'minecraft:rideable' ? { getRiders: () => (riding ? [player] : []) } : undefined),
  };
  let tick = (): void => {};
  const world = { getDimension: (id: string) => { if (id !== 'overworld') throw new Error('no such dimension'); return dim; }, getTimeOfDay: () => o.time ?? 6000 };
  const system = { runInterval: (fn: () => void) => { tick = fn; }, afterEvents: { scriptEventReceive: { subscribe: () => {} } } };
  const script = scriptedVehicleScript(hostConfig({ [typeId]: o.type }, o.colliders ? { colliders: o.colliders } : {}));
  new Function('world', 'system', script.replace(/^import .*;\n/, ''))(world, system);
  return {
    entity, poses, placed, dynamic,
    set: (x: number, y: number, j = false) => { stick = { x, y }; jump = j; },
    dismount: () => { riding = false; },
    run: (n: number) => { for (let i = 0; i < n; i++) tick(); },
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
  it('tilts the band with the pitch: a nose-up climb clears a low block the level nose would hit', () => {
    const low = solidCells(['2,64,0']);
    const level = sweepFootprint({ x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 0 }, { x: 0.3, y: 64, z: 0.5, yaw: -90, pitch: 0 }, { ...fp, halfWidth: 0.3 }, low, FOOTPRINT);
    const climbing = sweepFootprint({ x: -0.5, y: 64, z: 0.5, yaw: -90, pitch: 40 }, { x: 0.3, y: 64, z: 0.5, yaw: -90, pitch: 40 }, { ...fp, halfWidth: 0.3 }, low, FOOTPRINT);
    expect(level.blocked).toBe(true);
    expect(climbing.blocked).toBe(false);
  });
  it('probes only the leading boundary: the bow going ahead, the stern backing up, the outward-swinging half in a turn', () => {
    const barge = { halfLength: 18, halfWidth: 7, lo: 0.6, hi: 13 };
    const none = (): boolean => false;
    const ahead = sweepFootprint({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, { x: 0, y: 64, z: 0.6, yaw: 0, pitch: 0 }, barge, none, FOOTPRINT);
    // The bow: 14 blocks at <= 0.9 spacing (17 points with both corners) at 4 heights.
    expect(ahead.checks).toBe(17 * FOOTPRINT.MAX_LEVELS);
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
  it('keeps a big hull to at most MAX_POINTS perimeter probes and MAX_LEVELS heights per pose', () => {
    const r = sweepFootprint({ x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, { x: 0, y: 64, z: 0.1, yaw: 0, pitch: 0 }, { halfLength: 18, halfWidth: 7, lo: 0.1, hi: 13 }, () => false, FOOTPRINT);
    expect(r.checks).toBeLessThanOrEqual(FOOTPRINT.MAX_POINTS * FOOTPRINT.MAX_LEVELS + 8);
  });
});

describe('the vehicle runtime against blocks (scripts/vehicles.js on a fake world)', () => {
  const car: ScriptedVehicleType = { mode: 'car', noseReach: 2, halfWidth: 1.2, height: 1.5 };
  it('stops a car at a trunk by its corner, where the old centre-line probe drove through it', () => {
    const trunk = { fills: [{ from: [12, 64, 1] as [number, number, number], to: [12, 69, 1] as [number, number, number], id: 'minecraft:oak_log' }] };
    const wide = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, ...trunk });
    wide.set(0, 1);
    wide.run(100);
    // The nose (x + 2) stops at the trunk's face, x = 12.
    expect(wide.entity.location.x + car.noseReach).toBeLessThanOrEqual(12.05);
    expect(wide.entity.location.x + car.noseReach).toBeGreaterThan(11);
    // A centre-line-only car (no half width) passes the same trunk.
    const narrow = vehicleHost({ type: { ...car, halfWidth: 0.05 }, at: { x: 0.5, y: 64, z: 0.5 }, ...trunk });
    narrow.set(0, 1);
    narrow.run(100);
    expect(narrow.entity.location.x).toBeGreaterThan(14);
  });
  it('stops a taxiing aircraft by a wingtip', () => {
    const plane: ScriptedVehicleType = { mode: 'plane', noseReach: 3, halfWidth: 4, height: 2.5 };
    const host = vehicleHost({ type: plane, at: { x: 0.5, y: 64, z: 0.5 }, fills: [{ from: [9, 64, 4], to: [9, 70, 4], id: 'minecraft:oak_log' }] });
    host.set(0, 0, true);
    host.run(120);
    // The wingtip reaches z = 4.5: the post at x = 9 stops the leading edge (x + 3) at 9.
    expect(host.entity.location.x + plane.noseReach).toBeLessThanOrEqual(9.05);
    expect(host.entity.location.x).toBeGreaterThan(2);
  });
  it('takes off a long aircraft without its tail striking the runway as it rotates (the band tilts about its low end)', () => {
    // The Milano: 16 long, 30 wide, 8.8 tall. Tilted about its centre at 12 degrees its tail dipped 1.7 blocks
    // into the ground and every take-off roll stopped dead (Pixel GameTest, 2026-09-25).
    const milano: ScriptedVehicleType = { mode: 'plane', noseReach: 8, halfWidth: 15, height: 8.8 };
    const host = vehicleHost({ type: milano, at: { x: 0.5, y: 64, z: 0.5 } });
    host.set(0, 0, true);
    host.run(200);
    expect(Math.max(...host.poses.map(p => p.y))).toBeGreaterThan(66);
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
  it('holds still where the terrain ahead or under it is not loaded, instead of falling through it', () => {
    const host = vehicleHost({ type: car, at: { x: 0.5, y: 64, z: 0.5 }, unloadedBeyondX: 30 });
    host.set(0, 1);
    host.run(200);
    // The nose probe (x + 2.5) meets the unloaded column first: it stops short of it, on the ground.
    expect(host.entity.location.x).toBeLessThan(30);
    expect(host.entity.location.x).toBeGreaterThan(20);
    expect(host.entity.location.y).toBe(64);
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
