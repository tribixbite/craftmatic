/**
 * HOP (web/src/engine/bedrock-ride-hop.ts): fly or drive into another
 * mountable and ride it. The pure contact test first, then the SERIALISED
 * runtimes - `scripts/hop.js`, `scripts/vehicles.js` and `scripts/rides.js`
 * exactly as a pack ships them - in the headless simulator (web/src/sim), in
 * a small add-on built here: a scripted plane that takes off and catches a
 * moving three-car train from behind, a train whose seats players already
 * hold, two packs that own the same plane, native clouds for the back-hop
 * cooldown, and a slide whose foot a car is parked at.
 */
import { describe, expect, it } from 'vitest';
import { createZip } from '../web/src/engine/zip-utils.js';
import { bedrockJsonText } from '../web/src/engine/bedrock-json.js';
import { HOP, HOP_TAGS, hopContact, hopKitConfig, hopRuntimeConfig, hopScript, type HopShape, type HopSource } from '../web/src/engine/bedrock-ride-hop.js';
import { BOAT, CAR, FLIGHT, FLIGHT_INPUT_EVENT, FLIGHT_PROPS, FOOTPRINT, HEADLIGHTS, HOVER, MOVE, VEHICLE_DYNAMIC, VEHICLE_TELEMETRY_EVENT, flightProperties, scriptedVehicleScript } from '../web/src/engine/bedrock-vehicle.js';
import { RIDE, ridesScript } from '../web/src/engine/bedrock-rides.js';
import { vehicleCameraScript } from '../web/src/engine/playable-addon.js';
import { FREE_LOOK } from '../web/src/engine/vehicle-free-look.js';
import { Simulation } from '../web/src/sim/core/simulation.js';
import { readAddon, type Addon } from '../web/src/sim/pack/pack.js';
import { FLAT_GROUND_Y } from '../web/src/sim/world/voxel-world.js';
import type { SimEntity } from '../web/src/sim/entity/entity.js';

// ─── The contact test ────────────────────────────────────────────────────────

const shape: HopShape = { halfLength: 1.5, halfWidth: 1, height: 1, rider: { r: 0, u: 0.4, f: 0 } };
const at = (x: number, y: number, z: number, yaw = 0) => ({ x, y, z, yaw });
const box = (x: number, y: number, z: number, e = 0.5) => ({ center: { x, y, z }, extent: { x: e, y: e, z: e } });

describe('hopContact: the swept test in the vehicle\'s frame', () => {
  it('a target closing head-on is met within the lead, not before', () => {
    // Yaw 0 faces +Z. A target 4 blocks ahead coming at a block a tick: the nose band ends at 1.5 + 0.5 + 0.71 + 0.5.
    expect(hopContact(shape, at(0, 0, 0), at(0, 0, 0), { x: 0, y: 0.5, z: 5 }, box(0, 0.5, 4), HOP).hit).toBe(true);
    expect(hopContact(shape, at(0, 0, 0), at(0, 0, 0), { x: 0, y: 0.5, z: 9 }, box(0, 0.5, 8), HOP).hit).toBe(false);
  });
  it('a target parked beside the vehicle is never boarded, however close', () => {
    const r = hopContact(shape, at(0, 0, 0), at(0, 0, 0), { x: 1.2, y: 0.5, z: 0 }, box(1.2, 0.5, 0), HOP);
    expect(r.closing).toBe(0);
    expect(r.hit).toBe(false);
  });
  it('a car crossing at 3 blocks a tick is caught between two samples (no tunnelling)', () => {
    // From 3 blocks right to 3 left in one tick: neither sample touches (2.21 is the side band), the segment does.
    expect(hopContact(shape, at(0, 0, 0), at(0, 0, 0), { x: 3, y: 0.5, z: 0 }, box(-3, 0.5, 0), HOP).hit).toBe(true);
    // Moving away at the same speed: the lead runs further away, nothing touches.
    expect(hopContact(shape, at(0, 0, 0), at(0, 0, 0), { x: -4, y: 0.5, z: 0 }, box(-7, 0.5, 0), HOP).hit).toBe(false);
  });
  it('reads the target in the vehicle\'s own frame: at yaw 90 the nose is -X', () => {
    const P = { ...HOP, LEAD_TICKS: 0 };
    // A long thin vehicle (half length 3, half width 0.2); the target comes to 3.2 blocks along -X.
    const thin: HopShape = { halfLength: 3, halfWidth: 0.2, height: 1 };
    expect(hopContact(thin, at(0, 0, 0, 90), at(0, 0, 0, 90), { x: -4.2, y: 0.5, z: 0 }, box(-3.2, 0.5, 0, 0.1), P).hit).toBe(true);
    expect(hopContact(thin, at(0, 0, 0, 0), at(0, 0, 0, 0), { x: -4.2, y: 0.5, z: 0 }, box(-3.2, 0.5, 0, 0.1), P).hit).toBe(false);
  });
  it('the rider\'s box counts: a seat passing over the vehicle at head height is touched', () => {
    const flat: HopShape = { halfLength: 1, halfWidth: 1, height: 0.3, rider: { r: 0, u: 0.3, f: 0 } };
    expect(hopContact(flat, at(0, 0, 0), at(0, 0, 0), { x: 0, y: 2.2, z: 2 }, box(0, 2.2, 1, 0.2), HOP).hit).toBe(true);
    expect(hopContact({ ...flat, rider: undefined }, at(0, 0, 0), at(0, 0, 0), { x: 0, y: 2.2, z: 2 }, box(0, 2.2, 1, 0.2), HOP).hit).toBe(false);
  });
});

// ─── The runtimes in the simulator ───────────────────────────────────────────

const enc = new TextEncoder();
const PLANE = 'craftmatic:test_plane', CAR_T = 'craftmatic:test_car', CLOUD = 'craftmatic:test_cloud', CHAIR = 'craftmatic:test_chair', SEAT = 'craftmatic:test_slide_seat', FIGURE = 'craftmatic:test_fig';
const entity = (identifier: string, components: Record<string, unknown>, description: Record<string, unknown> = {}): string =>
  bedrockJsonText({ format_version: '1.26.30', 'minecraft:entity': { description: { identifier, is_spawnable: true, is_summonable: true, ...description }, components } });
const seatOf = (count: number, position: number[], families = ['player']) => ({ seat_count: count, family_types: families, interact_text: 'action.interact.mount', seats: { position } });
const ENTITIES: Record<string, string> = {
  'plane.json': entity(PLANE, {
    'minecraft:type_family': { family: ['craftmatic_vehicle', 'plane'] }, 'minecraft:rideable': seatOf(1, [0, 0.5, 0]),
    'minecraft:collision_box': { width: 2, height: 1 }, 'minecraft:physics': { has_gravity: false, has_collision: true },
  }, { properties: flightProperties() }),
  'car.json': entity(CAR_T, {
    'minecraft:type_family': { family: ['craftmatic_coaster'] }, 'minecraft:rideable': seatOf(1, [0, 0.35, 0]),
    'minecraft:collision_box': { width: 1.375, height: 0.9 }, 'minecraft:physics': { has_gravity: false, has_collision: false },
  }),
  // A native hover mount (a flyer's cloud): Bedrock's controller holds it where it is when nobody steers.
  'cloud.json': entity(CLOUD, {
    'minecraft:type_family': { family: ['craftmatic_vehicle', 'flyer'] }, 'minecraft:rideable': seatOf(1, [0, 0.6, 0]),
    'minecraft:collision_box': { width: 1.2, height: 0.6 }, 'minecraft:physics': { has_gravity: false, has_collision: true },
    'minecraft:free_camera_controlled': {}, 'minecraft:movement.hover': {}, 'minecraft:flying_speed': { value: 0.0725 },
  }),
  'chair.json': entity(CHAIR, { 'minecraft:rideable': seatOf(1, [0, 0.3, 0], ['player', 'craftmatic_figure']), 'minecraft:collision_box': { width: 0.8, height: 0.8 }, 'minecraft:physics': { has_gravity: false, has_collision: false } }),
  'seat.json': entity(SEAT, { 'minecraft:rideable': seatOf(1, [0, -0.3, 0]), 'minecraft:collision_box': { width: 0.6, height: 0.4 }, 'minecraft:physics': { has_gravity: false, has_collision: false } }),
  'fig.json': entity(FIGURE, { 'minecraft:type_family': { family: ['craftmatic_figure'] }, 'minecraft:collision_box': { width: 0.6, height: 1.8 }, 'minecraft:physics': { has_gravity: false, has_collision: false } }),
};
const SOURCES: Record<string, HopSource> = {
  [PLANE]: { halfLength: 1.5, halfWidth: 1.5, height: 1, vacate: 'hover' },
  [CLOUD]: { halfLength: 0.6, halfWidth: 0.6, height: 0.6, vacate: 'native' },
};
const VEHICLES = scriptedVehicleScript({
  types: { [PLANE]: { mode: 'plane', noseReach: 1.5, halfWidth: 1.5, height: 1 } }, flight: FLIGHT, boat: BOAT, car: CAR, hover: HOVER,
  footprint: FOOTPRINT, move: MOVE, headlights: HEADLIGHTS, props: FLIGHT_PROPS, dynamic: VEHICLE_DYNAMIC, inputEvent: FLIGHT_INPUT_EVENT, telemetryEvent: VEHICLE_TELEMETRY_EVENT,
});
const HOP_JS = hopScript(hopRuntimeConfig('craftmatic', SOURCES));
const RIDES_JS = ridesScript({ seatType: SEAT, rides: [{ kind: 'slide' }], constants: RIDE, hop: hopKitConfig('craftmatic') });

/** A behaviour pack with the given scripts and every test entity (`name` keeps two copies apart). */
async function pack(name: string, scripts: Record<string, string>): Promise<Addon> {
  const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}${name.length}`.slice(0, 36);
  const manifest = { format_version: 2, header: { name, uuid: uuid(1), version: [1, 0, 0] }, modules: [{ type: 'data', uuid: uuid(2), version: [1, 0, 0] }, { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: uuid(3), version: [1, 0, 0] }], dependencies: [{ module_name: '@minecraft/server', version: '2.9.0' }] };
  const files = [{ name: `${name}_BP/manifest.json`, data: enc.encode(JSON.stringify(manifest)) }];
  files.push({ name: `${name}_BP/scripts/main.js`, data: enc.encode(Object.keys(scripts).map(f => `import './${f}';`).join('\n')) });
  for (const [f, t] of Object.entries(scripts)) files.push({ name: `${name}_BP/scripts/${f}`, data: enc.encode(t) });
  for (const [f, t] of Object.entries(ENTITIES)) files.push({ name: `${name}_BP/entities/${f}`, data: enc.encode(t) });
  return readAddon(await createZip(files), name);
}

/** A world with the packs loaded and a child standing on the flat ground. */
async function world(packs: Addon[]): Promise<{ sim: Simulation; child: SimEntity }> {
  const sim = new Simulation();
  for (const p of packs) sim.loadAddon(p);
  const child = sim.addPlayer('Child', { x: 0.5, y: FLAT_GROUND_Y, z: 0.5 });
  await sim.run(1);
  return { sim, child };
}
const spawn = (sim: Simulation, type: string, x: number, y: number, z: number, yaw = 0): SimEntity => { const e = sim.engine.spawnEntity(type, 'overworld', { x, y, z }); e.rotation.y = yaw; return e; };

/** Three cars in a row along +Z, front car (rank 0) ahead, tagged as the coaster tags a train. */
function train(sim: Simulation, x: number, y: number, z: number): SimEntity[] {
  const cars = [0, 1, 2].map(i => spawn(sim, CAR_T, x, y, z - i * 2));
  for (const [i, c] of cars.entries()) { c.tags.add(`${HOP_TAGS.train}T1`); c.tags.add(`${HOP_TAGS.rank}${i}`); }
  return cars;
}
/** Move a train along +Z by `dz` (and to height `y`), its riders with it. */
function moveTrain(cars: SimEntity[], dz: number, y?: number): void {
  for (const c of cars) { c.location = { x: c.location.x, y: y ?? c.location.y, z: c.location.z + dz }; c.placeRiders(); }
}

/** Take the ship off: Jump lifts it straight up; returns once it is `height` up. */
async function takeOff(sim: Simulation, child: SimEntity, plane: SimEntity, height: number): Promise<void> {
  sim.controls.set(child.id, { forward: 0, strafe: 0, jump: true });
  for (let t = 0; t < 400 && plane.location.y < FLAT_GROUND_Y + height; t++) await sim.run(1);
  expect(plane.location.y).toBeGreaterThanOrEqual(FLAT_GROUND_Y + height);
}

describe('the hop runtime, serialised, in the simulator', () => {
  it('a plane flown into the REAR car of a moving train seats the player in the FRONT car, and the plane hovers where it was left', async () => {
    const { sim, child } = await world([await pack('hopA', { 'vehicles.js': VEHICLES, 'hop.js': HOP_JS })]);
    const plane = spawn(sim, PLANE, 0.5, FLAT_GROUND_Y, 0.5);
    await sim.run(2);
    expect(plane.addRider(child, sim.engine.tick)).toEqual({ ok: true });
    await takeOff(sim, child, plane, 4);
    // Level flight on the stick: the ship flies along +Z (yaw 0) and holds its height.
    sim.controls.set(child.id, { jump: false, forward: 1 });
    await sim.run(30);
    const speed = () => (plane.location.z - z0) / 10;
    const z0 = plane.location.z;
    await sim.run(10);
    expect(speed()).toBeGreaterThan(0.6); // blocks a tick: over 12 blocks/s
    // A train 10 blocks ahead at the plane's height, running the same way at 8 blocks/s: the plane catches its REAR car.
    const cars = train(sim, plane.location.x, plane.location.y, plane.location.z + 14);
    let hopped = -1;
    for (let t = 0; t < 120 && hopped < 0; t++) {
      moveTrain(cars, 8 / 20, plane.location.y);
      await sim.run(1);
      if (child.ridingOn && child.ridingOn !== plane) hopped = sim.engine.tick;
    }
    expect(hopped).toBeGreaterThan(0);
    // It met the REAR car (the plane is still behind it, by less than the reach and the lead) ...
    expect(cars[2]!.location.z - plane.location.z).toBeGreaterThan(0);
    expect(cars[2]!.location.z - plane.location.z).toBeLessThan(cars[0]!.location.z - plane.location.z - 3);
    // ... and the child sits in the FRONT one.
    expect(child.ridingOn).toBe(cars[0]);
    expect(sim.engine.timeline.of('script-error')).toHaveLength(0);
    expect(plane.dynamic.get(VEHICLE_DYNAMIC.hold)).toBe(true);
    const claim = [...child.tags].find(t => t.startsWith(HOP_TAGS.claim));
    expect(claim).toBe(`${HOP_TAGS.claim}${hopped}:${plane.id}`);
    expect(sim.host.stats.get('sound note.chime')).toBe(1);
    // The plane hovers where it was left: 3 s later it has not moved.
    const left = { ...plane.location };
    for (let t = 0; t < 60; t++) { moveTrain(cars, 8 / 20); await sim.run(1); }
    expect(plane.location).toEqual(left);
    expect(child.ridingOn).toBe(cars[0]);
    // Back aboard, the hold ends and it flies on at the speed it had.
    cars[0]!.removeRider(child);
    expect(plane.addRider(child, sim.engine.tick)).toEqual({ ok: true });
    await sim.run(5);
    expect(plane.dynamic.get(VEHICLE_DYNAMIC.hold)).toBeUndefined();
    expect(plane.location.z - left.z).toBeGreaterThan(2);
  }, 30000);

  it('a riderless ship that nobody hopped off brakes and sinks to the ground (the hold is the hop\'s, not every empty ship\'s)', async () => {
    const { sim, child } = await world([await pack('hopA', { 'vehicles.js': VEHICLES, 'hop.js': HOP_JS })]);
    const plane = spawn(sim, PLANE, 0.5, FLAT_GROUND_Y, 0.5);
    await sim.run(2);
    plane.addRider(child, sim.engine.tick);
    await takeOff(sim, child, plane, 4);
    sim.controls.set(child.id, { jump: false, forward: 1 });
    await sim.run(40);
    plane.removeRider(child);
    const y0 = plane.location.y, z0 = plane.location.z;
    // Nobody aboard: it brakes to a stop and sinks gently to the ground, where it parks.
    // The child follows on the ground: a ship past the loaded area holds still (an unloaded block is not air).
    for (let t = 0; t < 400; t++) { child.location = { x: plane.location.x, y: FLAT_GROUND_Y, z: plane.location.z }; await sim.run(1); }
    expect(plane.location.z).toBeGreaterThan(z0 + 3);
    expect(plane.location.y).toBeLessThan(y0);
    expect(plane.location.y).toBeCloseTo(FLAT_GROUND_Y, 5);
  }, 30000);

  it('a train whose every seat a player holds is flown through, not boarded; a figure yields its chair', async () => {
    const { sim, child } = await world([await pack('hopA', { 'vehicles.js': VEHICLES, 'hop.js': HOP_JS })]);
    const cloud = spawn(sim, CLOUD, 0.5, FLAT_GROUND_Y + 3, 0.5);
    await sim.run(2);
    cloud.addRider(child, sim.engine.tick);
    const cars = train(sim, 0.5, FLAT_GROUND_Y + 3, -8);
    const others = cars.map((c, i) => { const p = sim.addPlayer(`Rider${i}`, { x: c.location.x, y: c.location.y, z: c.location.z }); c.addRider(p, sim.engine.tick + 1); return p; });
    await sim.run(25); // past the boarding grace
    for (let t = 0; t < 60; t++) { moveTrain(cars, 0.5); await sim.run(1); }
    expect(others.every((p, i) => p.ridingOn === cars[i])).toBe(true);
    expect(child.ridingOn).toBe(cloud);
    // A chair a figure sits on: the figure stands up for the player.
    const chair = spawn(sim, CHAIR, 0.5, FLAT_GROUND_Y + 3, -6);
    const fig = spawn(sim, FIGURE, 0.5, FLAT_GROUND_Y + 3, -6);
    await sim.run(2);
    expect(chair.addRider(fig, sim.engine.tick)).toEqual({ ok: true });
    for (let t = 0; t < 40 && child.ridingOn === cloud; t++) { chair.location = { ...chair.location, z: chair.location.z + 0.4 }; chair.placeRiders(); await sim.run(1); }
    expect(child.ridingOn).toBe(chair);
    expect(fig.ridingOn).toBeUndefined();
  }, 30000);

  it('two packs that both own the plane hop the player once (the claim tag)', async () => {
    const { sim, child } = await world([await pack('hopA', { 'vehicles.js': VEHICLES, 'hop.js': HOP_JS }), await pack('hopB', { 'hop.js': HOP_JS })]);
    const plane = spawn(sim, PLANE, 0.5, FLAT_GROUND_Y, 0.5);
    await sim.run(2);
    plane.addRider(child, sim.engine.tick);
    await sim.run(25);
    const cars = train(sim, 0.5, FLAT_GROUND_Y, -12);
    for (let t = 0; t < 80 && child.ridingOn === plane; t++) { moveTrain(cars, 0.5); await sim.run(1); }
    expect(child.ridingOn).toBe(cars[0]);
    expect(sim.host.stats.get('sound note.chime')).toBe(1);
    expect([...child.tags].filter(t => t.startsWith(HOP_TAGS.claim))).toHaveLength(1);
    // Nothing reported an error on the way.
    expect(sim.engine.timeline.of('script-error')).toHaveLength(0);
  }, 30000);

  it('never hops straight back into the mount it left, until the cooldown has passed', async () => {
    const { sim, child } = await world([await pack('hopA', { 'hop.js': HOP_JS })]);
    const a = spawn(sim, CLOUD, 0.5, FLAT_GROUND_Y + 3, 0.5), b = spawn(sim, CLOUD, 0.5, FLAT_GROUND_Y + 3, -6);
    await sim.run(2);
    a.addRider(child, sim.engine.tick);
    await sim.run(25);
    /** Sweep cloud B through A and on to the far side (the child rides whichever it is on). */
    const sweep = async (from: number, to: number): Promise<void> => {
      const n = Math.ceil(Math.abs(to - from) / 0.4);
      for (let i = 1; i <= n; i++) { b.location = { ...b.location, z: from + (to - from) * i / n }; b.placeRiders(); await sim.run(1); }
    };
    await sweep(-6, 6);
    expect(child.ridingOn).toBe(b);
    const hopTick = sim.engine.tick - 0;
    await sim.run(25); // past the grace
    await sweep(6, -6); // back through A: A is the mount just left
    expect(child.ridingOn).toBe(b);
    expect(sim.engine.tick - hopTick).toBeLessThan(HOP.BACK_COOLDOWN_TICKS);
    await sim.run(HOP.BACK_COOLDOWN_TICKS);
    await sweep(-6, 6);
    expect(child.ridingOn).toBe(a);
  }, 30000);

  it('the rider the plane\'s camera hid stays hidden by the coaster after the hop, whichever pack runs first (Saga 30j: the rider\'s own head filled the coaster camera)', async () => {
    // The plane's camera hides its rider (a body that fits at no size, as 7140's at 100 %); the "coaster" hides
    // a new rider ONCE, for an hour, as bedrock-coaster.ts `aimRider` does.
    const camera = vehicleCameraScript({
      vehicles: [{ typeId: PLANE, preset: 'craftmatic:test_plane_chase', kind: 'plane', radius: 6, height: 2, pivotY: 0.5, scripted: true, riderVisibleSizes: [] }],
      pitchProperty: FLIGHT_PROPS.pitch, hop: { claimTag: HOP_TAGS.claim, graceTicks: HOP.BOARD_GRACE_TICKS, hiddenTag: HOP_TAGS.hidden },
      freeLook: FREE_LOOK, lookPitchProperty: VEHICLE_DYNAMIC.lookPitch, telemetryEvent: VEHICLE_TELEMETRY_EVENT,
    });
    const coaster = `import { world, system } from '@minecraft/server';
const seen = new Set();
system.runInterval(() => {
  for (const car of world.getDimension('overworld').getEntities({ type: '${CAR_T}' })) {
    for (const r of car.getComponent('minecraft:rideable').getRiders()) {
      if (r.typeId === 'minecraft:player' && !seen.has(r.id)) { seen.add(r.id); r.addEffect('invisibility', 72000, { amplifier: 0, showParticles: false }); }
    }
  }
}, 1);
`;
    for (const order of ['plane-first', 'coaster-first'] as const) {
      // The shipped pack's import order (main.js): the camera script runs before hop.js in a tick.
      const planePack = await pack('hopP', { 'vehicle-camera.js': camera, 'vehicles.js': VEHICLES, 'hop.js': HOP_JS });
      const coasterPack = await pack('hopC', { 'coaster.js': coaster });
      const { sim, child } = await world(order === 'plane-first' ? [planePack, coasterPack] : [coasterPack, planePack]);
      const plane = spawn(sim, PLANE, 0.5, FLAT_GROUND_Y, 0.5);
      await sim.run(2);
      plane.addRider(child, sim.engine.tick);
      await sim.run(25);
      expect(child.effects.has('minecraft:invisibility'), order).toBe(true);
      expect(child.tags.has(HOP_TAGS.hidden), order).toBe(true);
      const cars = train(sim, 0.5, FLAT_GROUND_Y, -12);
      for (let t = 0; t < 80 && child.ridingOn === plane; t++) { moveTrain(cars, 0.5); await sim.run(1); }
      expect(child.ridingOn, order).toBe(cars[0]);
      // Long past the plane camera's own 3-second effect: the coaster's is the one left, and the plane's tag is gone.
      for (let t = 0; t < 100; t++) { moveTrain(cars, 0.5); await sim.run(1); }
      expect(child.effects.has('minecraft:invisibility'), order).toBe(true);
      expect(child.tags.has(HOP_TAGS.hidden), order).toBe(false);
      expect(sim.engine.timeline.of('script-error'), order).toHaveLength(0);
    }
  }, 60000);

  it('a car parked at a slide\'s foot takes the rider at the set-down (they slide into it)', async () => {
    const { sim, child } = await world([await pack('hopA', { 'rides.js': RIDES_JS })]);
    const top = { x: 0.5, y: FLAT_GROUND_Y + 3, z: 0.5 }, foot = { x: 0.5, y: FLAT_GROUND_Y, z: 5.5 }, end = { x: 0.5, y: FLAT_GROUND_Y, z: 6.5 };
    const seat = spawn(sim, SEAT, top.x, top.y, top.z);
    seat.dynamic.set('craftmatic:ride', 0); seat.dynamic.set('craftmatic:ride_scale', 1); seat.dynamic.set('craftmatic:ride_path', JSON.stringify([top, foot, end]));
    const car = spawn(sim, CAR_T, 0.5, FLAT_GROUND_Y, 7.5);
    await sim.run(2);
    expect(seat.addRider(child, sim.engine.tick)).toEqual({ ok: true });
    let t = 0;
    for (; t < 200 && child.ridingOn !== car; t++) await sim.run(1);
    expect(child.ridingOn).toBe(car);
    // Without a car there, the same slide sets the rider down on the ground.
    car.removeRider(child);
    sim.engine.removeEntity(car);
    await sim.run(20);
    child.location = { ...top };
    expect(seat.addRider(child, sim.engine.tick)).toEqual({ ok: true });
    for (t = 0; t < 200 && child.ridingOn; t++) await sim.run(1);
    expect(child.ridingOn).toBeUndefined();
    expect(Math.hypot(child.location.x - end.x, child.location.z - end.z)).toBeLessThan(1.6);
  }, 30000);
});
