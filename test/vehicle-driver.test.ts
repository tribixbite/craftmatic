/**
 * The native-mount driver runtime (playable-addon.ts `vehicleDriverRuntime`,
 * `BP/scripts/vehicle-driver.js`) on the headless simulator: a flyer cloud with one
 * player aboard. The Saga round of 2026-09-29 (output/nimbus-saga-0929) found
 * the HUD's "LOOK DOWN: DIVE" did nothing, the summon hint was overwritten
 * within 4 ticks, and the speed read 0 / 24.9 / 60.2 / 99.0 mph at ~10 blocks/s
 * because a client-driven mount's server position moves in bursts.
 */
import { describe, expect, it } from 'vitest';
import { AIRCRAFT_CLIMB_GROUP, AIRCRAFT_DESCEND_GROUP, AIRCRAFT_DESCEND_OFF, AIRCRAFT_DESCEND_ON, DRIVER_ALT_SCAN_BLOCKS, DRIVER_SPEED_WINDOW_TICKS, vehicleDriverConfig, vehicleDriverScript } from '../web/src/engine/playable-addon.js';
import { simHost, solidBelow } from './_sim-host.js';
import { FLYER } from '../web/src/engine/bedrock-flyer.js';
import { quirkValue } from '../web/src/sim/quirks/registry.js';
import { NATIVE_HEADING_PROPERTY } from '../web/src/engine/vehicle-free-look.js';
import type { SimEntity } from '../web/src/sim/entity/entity.js';

const CLOUD = 'craftmatic:t_cloud';
/** mph per block/tick, the runtime's own factor (20 ticks/s, 1 block = 1 m, 2.236936 mph per m/s). */
const MPH_PER_BLOCK_TICK = 20 * 2.236936;

/**
 * The native mount the driver watches: a player seat and the climb / descend
 * groups its events swap. No hover controller is declared, so the simulator
 * does not move it: the tests move it, as a client-driven mount's position
 * arrives on the server.
 */
const CLOUD_TYPE = {
  components: { 'minecraft:type_family': { family: ['craftmatic_vehicle'] }, 'minecraft:collision_box': { width: 1, height: 0.5 }, 'minecraft:rideable': { seat_count: 2, family_types: ['player'], seats: [{ position: [0, 0.5, 0] }, { position: [0, 0.5, -0.8] }] } },
  component_groups: { [AIRCRAFT_CLIMB_GROUP]: {}, [AIRCRAFT_DESCEND_GROUP]: {} },
  events: {
    [AIRCRAFT_DESCEND_ON]: { remove: { component_groups: [AIRCRAFT_CLIMB_GROUP] }, add: { component_groups: [AIRCRAFT_DESCEND_GROUP] } },
    [AIRCRAFT_DESCEND_OFF]: { remove: { component_groups: [AIRCRAFT_DESCEND_GROUP] }, add: { component_groups: [AIRCRAFT_CLIMB_GROUP] } },
  },
};

/**
 * `scripts/vehicle-driver.js` (vehicleDriverScript) on the headless simulator
 * (test/_sim-host.ts): one mount with one player seated on it. `player`
 * holds the rider's look (`rotation`), stick (`input`) and Jump; every event
 * the runtime triggers on the mount is recorded.
 */
/**
 * The same cloud with the device's hover controller declared, so the simulator flies it, chases the rider's look
 * (quirk `hover-turn-chase`) and carries the rider's yaw round with it (quirk `rider-yaw-lag`), as the Saga did.
 */
const NATIVE_CLOUD_TYPE = {
  ...CLOUD_TYPE,
  components: {
    ...CLOUD_TYPE.components,
    'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: [{ position: [0, 0.5, 0], lock_rider_rotation: 181 }] },
    'minecraft:physics': { has_gravity: false, has_collision: true },
    'minecraft:movement.hover': {}, 'minecraft:free_camera_controlled': { strafe_speed_modifier: 1, backwards_movement_modifier: 0.5 }, 'minecraft:flying_speed': { value: FLYER.FLYING_SPEED },
  },
};

function driverWorld(vehicle: { kind: 'plane' | 'car'; motion?: 'flyer' | 'rotor'; hud?: string } = { kind: 'plane', motion: 'flyer', hud: 'NIMBUS' }, native = false) {
  const h = simHost({
    script: vehicleDriverScript(vehicleDriverConfig([{ typeId: CLOUD, kind: vehicle.kind, label: 'Nimbus', ...(vehicle.motion ? { motion: vehicle.motion } : {}), ...(vehicle.hud ? { hud: vehicle.hud } : {}) }])),
    entities: { [CLOUD]: native ? NATIVE_CLOUD_TYPE : CLOUD_TYPE },
    // The ground: solid up to y 63, the cloud standing on it at 64.
    terrain: solidBelow(64),
  });
  const cloud = h.spawn(CLOUD, { x: 0, y: 64, z: 0 });
  const events: string[] = [];
  const api = h.api(cloud), trigger = api.triggerEvent;
  api.triggerEvent = (e: string) => { events.push(e); return trigger(e); };
  const rider = h.addPlayer('Rider', cloud.location);
  h.seat(rider, cloud);
  let stick = { x: 0, y: 0 };
  const player = {
    sim: rider,
    /** The rider's look: pitch `x` (positive down), yaw `y`. */
    get rotation() { return rider.rotation; },
    /** The move stick: `x` strafe (+left), `y` forward. */
    input: {
      get x() { return stick.x; }, set x(v: number) { stick = { ...stick, x: v }; h.controls(rider, { strafe: v }); },
      get y() { return stick.y; }, set y(v: number) { stick = { ...stick, y: v }; h.controls(rider, { forward: v }); },
    },
    set jump(v: boolean) { h.controls(rider, { jump: v }); },
  };
  let hudFrom = 0;
  /** Every action-bar line since `clearHud`, whoever rides (a second rider's lines too). */
  const hud = (): string[] => h.lines('actionbar').slice(hudFrom);
  /** Runs `n` ticks (the driver wakes every 2); `each` is called with the tick BEFORE the driver reads the world. */
  const run = (n: number, each?: (t: number) => void): void => { for (let i = 0; i < n; i += 2) { h.run(1); each?.(h.engine.tick + 1); h.run(1); } };
  const mphOf = (line: string): number | undefined => { const m = /([\d.]+) mph/.exec(line); return m ? Number(m[1]) : undefined; };
  return {
    h, player, cloud, events, run, hud, mphOf,
    clearHud: () => { hudFrom = h.lines('actionbar').length; },
    lastHud: (): string => hud().at(-1) ?? '',
    /** Nobody aboard. */
    dismount: () => { for (const r of cloud.riderList()) h.unseat(r); },
    /** `who` (default the rider) back aboard. */
    board: (who = rider) => { h.seat(who, cloud); },
  };
}

describe('the driver: look-down dives', () => {
  it('puts the descend group in when the rider looks down past DIVE_PITCH_DEG and takes it out when they level', () => {
    const w = driverWorld();
    w.player.rotation.x = FLYER.DIVE_PITCH_DEG - 5;
    w.run(4);
    expect(w.events).toEqual([]); // a glance down is not a dive
    w.player.rotation.x = FLYER.DIVE_PITCH_DEG + 5;
    w.run(2);
    expect(w.events).toEqual([AIRCRAFT_DESCEND_ON]);
    w.run(6);
    expect(w.events).toEqual([AIRCRAFT_DESCEND_ON]); // once, not every interval
    expect(w.lastHud()).toMatch(/JUMP: DESCEND|sneak gets off/);
    w.player.rotation.x = 0;
    w.run(2);
    expect(w.events).toEqual([AIRCRAFT_DESCEND_ON, AIRCRAFT_DESCEND_OFF]);
  });

  it('back + Jump still descends, and looking up never does', () => {
    const w = driverWorld();
    w.player.input.y = -1; w.player.jump = true;
    w.run(2);
    expect(w.events).toEqual([AIRCRAFT_DESCEND_ON]);
    w.player.input.y = 0;
    w.run(2);
    expect(w.events).toEqual([AIRCRAFT_DESCEND_ON, AIRCRAFT_DESCEND_OFF]);
    w.player.jump = false; w.player.rotation.x = -60;
    w.run(10);
    expect(w.events).toHaveLength(2);
  });

  it('a rotorcraft (kind plane, no motion) dives by pitch too; a native car never', () => {
    const heli = driverWorld({ kind: 'plane' });
    heli.player.rotation.x = 40; heli.run(2);
    expect(heli.events).toEqual([AIRCRAFT_DESCEND_ON]);
    const car = driverWorld({ kind: 'car' });
    car.player.rotation.x = 40; car.run(2);
    expect(car.events).toEqual([]);
  });
});

describe('the driver: the ride opens with the mount\'s name and hint', () => {
  it('shows the hint line for RIDE_HINT_TICKS after boarding, then the speed line', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS);
    expect(w.hud().length).toBeGreaterThan(0);
    for (const line of w.hud()) expect(line).toMatch(/^§eNIMBUS!§r Drag to steer, Jump climbs, look down \+ Jump dives, sneak gets off$/);
    w.run(4);
    expect(w.lastHud()).toMatch(/^§lNIMBUS§r §e0\.0 mph§r · §bALT 0§r · §a\[DRAG: STEER · JUMP: CLIMB · LOOK DOWN \+ JUMP: DIVE\]§r$/);
  });

  it('never tells the child the stick turns a native mount: under the default scheme its rider is held in, the stick strafes and a drag steers (Saga 30k, the Nimbus)', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS + 8);
    for (const line of w.hud()) expect(line).not.toMatch(/STICK: TURN/);
    expect(w.hud().some(l => /DRAG: STEER|Drag to steer/.test(l))).toBe(true);
  });

  it('shows ALT as the height over the ground, as a ship does, not the world y (Saga 30j: ALT -59 on the ground)', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS + 4);
    expect(w.lastHud()).toContain('ALT 0§r');
    w.cloud.location = { x: 0, y: 74.4, z: 0 };
    w.run(8);
    expect(w.lastHud()).toContain('ALT 10§r');
    // Past the scan (nothing solid within DRIVER_ALT_SCAN_BLOCKS under it): no number is better than a wrong one.
    w.cloud.location = { x: 0, y: 64 + DRIVER_ALT_SCAN_BLOCKS + 3, z: 0 };
    w.run(8);
    expect(w.lastHud()).toContain('ALT --§r');
  });

  it('the same player back on the same cloud gets the hint again (the Pixel went straight to "[JUMP: DESCEND]" on a remount)', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS + 8);
    expect(w.lastHud()).toMatch(/mph/);
    // Off: the driver sees an empty seat for a few intervals (no HUD is written to nobody).
    w.dismount();
    w.clearHud();
    w.run(20);
    expect(w.hud()).toEqual([]);
    // Back on, the same player: the ride opens with the hint for a full RIDE_HINT_TICKS again.
    w.board();
    w.run(4);
    expect(w.lastHud()).toMatch(/^§eNIMBUS!§r/);
    w.run(FLYER.RIDE_HINT_TICKS - 8);
    for (const line of w.hud()) expect(line).toMatch(/^§eNIMBUS!§r/);
    w.run(8);
    expect(w.lastHud()).toMatch(/mph/);
  });

  it('a new rider on the same cloud gets the hint again; a rotorcraft says HELI', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS + 8);
    expect(w.lastHud()).toMatch(/mph/);
    w.dismount(); w.board(w.h.addPlayer('Rider 2'));
    w.run(4);
    expect(w.lastHud()).toMatch(/^§eNIMBUS!§r/);
    const heli = driverWorld({ kind: 'plane', motion: 'rotor' });
    heli.run(4);
    expect(heli.lastHud()).toMatch(/^§eHELI!§r/);
  });
});

describe('the driver: HUD speed of a client-driven mount', () => {
  const TRUE_BLOCKS_PER_TICK = 0.5; // ~10 blocks/s, the Nimbus's measured cruise
  const trueMph = TRUE_BLOCKS_PER_TICK * MPH_PER_BLOCK_TICK; // 22.4

  it('reads the true speed when the server position moves in 8-tick bursts (the Saga read 0 / 24.9 / 60.2 / 99.0)', () => {
    const w = driverWorld();
    const mover = (t: number): void => { if (t % 8 === 0) w.cloud.location.x += TRUE_BLOCKS_PER_TICK * 8; };
    w.run(FLYER.RIDE_HINT_TICKS + DRIVER_SPEED_WINDOW_TICKS, mover); // past the hint and a full window
    w.clearHud();
    w.run(80, mover);
    const readings = w.hud().map(w.mphOf).filter((v): v is number => v !== undefined);
    expect(readings.length).toBeGreaterThanOrEqual(20);
    for (const v of readings) expect(v).toBeCloseTo(trueMph, 0);
  });

  it('reads the same speed for a smooth mover, and zero once it has stood still for a window', () => {
    const w = driverWorld();
    const mover = (): void => { w.cloud.location.z += TRUE_BLOCKS_PER_TICK * 2; };
    w.run(FLYER.RIDE_HINT_TICKS + DRIVER_SPEED_WINDOW_TICKS, mover);
    w.clearHud();
    w.run(40, mover);
    for (const v of w.hud().map(w.mphOf)) expect(v).toBeCloseTo(trueMph, 0);
    w.run(DRIVER_SPEED_WINDOW_TICKS + 4);
    expect(w.mphOf(w.lastHud())).toBe(0);
  });

  it('a start after a long hover ramps up within a window and never overshoots (no spike from a stale anchor)', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS + 400); // hovering in place for 20 s
    w.clearHud();
    const mover = (t: number): void => { if (t % 8 === 0) w.cloud.location.x += TRUE_BLOCKS_PER_TICK * 8; };
    w.run(DRIVER_SPEED_WINDOW_TICKS + 8, mover);
    const ramp = w.hud().map(w.mphOf).filter((v): v is number => v !== undefined);
    for (const v of ramp) expect(v).toBeLessThanOrEqual(trueMph + 0.5);
    // A stale anchor (the hover's first sample, 20 s old) would read ~0 for the whole first window; the ramp is past half by its end.
    expect(ramp[ramp.length - 1]).toBeGreaterThan(trueMph / 2);
    w.clearHud();
    w.run(40, mover);
    for (const v of w.hud().map(w.mphOf)) expect(v).toBeCloseTo(trueMph, 0);
  });

  it('a teleport (the wand, a reload) is not a speed', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS + 4);
    w.cloud.location.x += 50;
    w.run(8);
    for (const v of w.hud().map(w.mphOf).filter((v): v is number => v !== undefined)) expect(v).toBeLessThan(1);
  });
});

describe('the driver: drag steering of the native mount (Saga 30l: one swipe spun the Nimbus at 6.5 degrees a tick for 40 s; Saga 30m: forward flew along an unturned body)', () => {
  const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
  /** The heading the driver holds, as the chase camera reads it (`NATIVE_HEADING_PROPERTY`). */
  const headingOf = (h: ReturnType<typeof driverWorld>['h'], cloud: SimEntity): number => Number(h.api(cloud).getDynamicProperty(NATIVE_HEADING_PROPERTY));
  it('one swipe at rest turns the heading (the view and where forward flies) by the swipe and the cloud stops turning, the controller\'s chase undone every tick', () => {
    const w = driverWorld(undefined, true);
    const { h, cloud, player } = w;
    // The seat's settle and the mount probe (the simulator carries the look, so it reads "carried" and takes its
    // turn back), then the Saga's swipe: 400 px, ~84 degrees over 0.8 s, nothing else held.
    h.run(60);
    const yaw0 = cloud.rotation.y, look0 = player.sim.rotation.y;
    expect(headingOf(h, cloud)).toBeCloseTo(yaw0, 6);
    let last = cloud.rotation.y, turned = 0;
    const rates: number[] = [];
    const tick = (): void => { h.run(1); const d = wrap(cloud.rotation.y - last); last = cloud.rotation.y; turned += d; rates.push(Math.abs(d)); };
    for (let t = 0; t < 16; t++) { player.sim.rotation = { x: player.sim.rotation.x, y: wrap(player.sim.rotation.y + 84 / 16) }; tick(); }
    for (let t = 0; t < 100; t++) tick();
    // The body (and the heading the chase camera looks along) turned by the swipe and is still a second and five
    // seconds later - never the device's 6.5 degrees a tick. The rider's own look is carried round with the body's
    // turn, so it runs a swipe ahead of the heading: nobody sees it under the script camera.
    // The body is read here after the controller's chase of the tick (0.144 of the look's offset), which the
    // script's write undoes on the next: the heading is what it holds.
    const chase = quirkValue('hover-turn-chase', 'offsetShareTurnedPerTick');
    // The heading turns by the swipe and a little more: the chase's transient turn of each tick is carried into the
    // look as well (the 30l model's 84 -> 98 offset) and read as finger - a geometric series that converges, at most
    // the swipe / (1 - 0.144); the Saga's 30m swipe turned the view 108 for 400 px.
    const by = wrap(headingOf(h, cloud) - yaw0);
    expect(by).toBeGreaterThanOrEqual(84 - 1);
    expect(by).toBeLessThanOrEqual(84 / (1 - chase) + 1);
    expect(Math.abs(wrap(cloud.rotation.y - headingOf(h, cloud)))).toBeLessThanOrEqual(chase * Math.abs(wrap(player.sim.rotation.y - headingOf(h, cloud))) + 1e-6);
    expect(Math.max(...rates.slice(-60))).toBeLessThan(0.01);
    expect(wrap(player.sim.rotation.y - headingOf(h, cloud))).toBeGreaterThan(70);
    expect(Math.abs(wrap(player.sim.rotation.y - look0))).toBeGreaterThan(150); // ~190: wraps past 180
    expect(h.errors()).toEqual([]);
  });
  it('a swipe back turns the heading back, and the CMVT line names the verdict', () => {
    const w = driverWorld(undefined, true);
    const { h, cloud, player } = w;
    h.run(60);
    const swipe = (deg: number): void => { for (let t = 0; t < 16; t++) { player.sim.rotation = { x: 0, y: wrap(player.sim.rotation.y + deg / 16) }; h.run(1); } h.run(60); };
    const yaw0 = cloud.rotation.y;
    const chase = quirkValue('hover-turn-chase', 'offsetShareTurnedPerTick');
    swipe(60);
    const there = wrap(headingOf(h, cloud) - yaw0);
    expect(there).toBeGreaterThanOrEqual(60 - 1);
    expect(there).toBeLessThanOrEqual(60 / (1 - chase) + 1);
    // Back: the look's offset (the carry) now closes as the heading turns back, so the chase's feed reverses too.
    swipe(-60);
    expect(Math.abs(wrap(headingOf(h, cloud) - yaw0))).toBeLessThan(60 * chase / (1 - chase) + 1);
    h.engine.emit('scriptEventReceive', { id: 'craftmatic:vehicle_telemetry', message: 'fast' });
    h.run(8);
    const row = h.lines('console').map(l => /CMVT (\{.*\})/.exec(l)?.[1]).filter((v): v is string => !!v).map(v => JSON.parse(v) as { steer?: { verdict?: string; heading?: number } }).at(-1);
    expect(row?.steer?.verdict).toBe('carried');
    expect(Math.round(wrap(row?.steer?.heading ?? NaN))).toBe(Math.round(wrap(headingOf(h, cloud))));
    expect(h.errors()).toEqual([]);
  });
  it('forward after a swipe flies where the view looks, within the controller\'s chase residual (quirk hover-stick-body-frame, Saga 30m: 94 degrees off the view)', () => {
    const w = driverWorld(undefined, true);
    const { h, cloud, player } = w;
    h.run(60);
    for (let t = 0; t < 16; t++) { player.sim.rotation = { x: 0, y: wrap(player.sim.rotation.y + 84 / 16) }; h.run(1); }
    h.run(40);
    const view = headingOf(h, cloud), start = { ...cloud.location };
    player.input.y = 1;
    h.run(60);
    player.input.y = 0;
    const dx = cloud.location.x - start.x, dz = cloud.location.z - start.z;
    expect(Math.hypot(dx, dz)).toBeGreaterThan(3);
    // Bedrock yaw of the displacement: 0 faces +Z, 90 faces -X. The residual is the controller's chase of the
    // rider's look (0.144 of the offset) before the heading is written back - the device read 13-14 degrees.
    const travel = Math.atan2(-dx, dz) * 180 / Math.PI;
    expect(Math.abs(wrap(travel - view))).toBeLessThan(20);
    expect(h.errors()).toEqual([]);
  });
});
