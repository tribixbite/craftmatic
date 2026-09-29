/**
 * The native-mount driver runtime (playable-addon.ts `vehicleDriverRuntime`,
 * `BP/scripts/vehicle-driver.js`) on a fake world: a flyer cloud with one
 * player aboard. The Saga round of 2026-09-29 (output/nimbus-saga-0929) found
 * the HUD's "LOOK DOWN: DIVE" did nothing, the summon hint was overwritten
 * within 4 ticks, and the speed read 0 / 24.9 / 60.2 / 99.0 mph at ~10 blocks/s
 * because a client-driven mount's server position moves in bursts.
 */
import { describe, expect, it } from 'vitest';
import { AIRCRAFT_DESCEND_OFF, AIRCRAFT_DESCEND_ON, DRIVER_SPEED_WINDOW_TICKS, _vehicleDriverRuntimeForTests, vehicleDriverConfig } from '../web/src/engine/playable-addon.js';
import { FLYER } from '../web/src/engine/bedrock-flyer.js';

const CLOUD = 'craftmatic:t_cloud';
/** mph per block/tick, the runtime's own factor (20 ticks/s, 1 block = 1 m, 2.236936 mph per m/s). */
const MPH_PER_BLOCK_TICK = 20 * 2.236936;

function driverWorld(vehicle: { kind: 'plane' | 'car'; motion?: 'flyer' | 'rotor'; hud?: string } = { kind: 'plane', motion: 'flyer', hud: 'NIMBUS' }) {
  let tick = 0; let loop: () => void = () => {};
  const events: string[] = [];
  const player: any = {
    id: 'p1', typeId: 'minecraft:player', rotation: { x: 0, y: 0 }, input: { x: 0, y: 0 }, jump: false, hud: [] as string[],
    getRotation() { return this.rotation; },
    inputInfo: { getMovementVector: () => player.input, getButtonState: (b: string) => b === 'Jump' && player.jump ? 'Pressed' : 'Released' },
    onScreenDisplay: { setActionBar: (s: string) => { player.hud.push(s); } },
  };
  const riders: any[] = [player];
  const cloud: any = {
    id: 'v1', typeId: CLOUD, location: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    getVelocity() { return this.velocity; }, getRotation: () => ({ x: 0, y: 0 }),
    dimension: { spawnParticle() {}, playSound() {} },
    getComponent: (n: string) => n === 'minecraft:rideable' ? { getRiders: () => riders } : undefined,
    triggerEvent: (e: string) => { events.push(e); },
  };
  const dim: any = { getEntities: (q: any) => q.type === CLOUD ? [cloud] : [] };
  (globalThis as any).world = { getDimension: (id: string) => { if (id !== 'overworld') throw new Error('no such dimension'); return dim; }, afterEvents: { entityHitEntity: { subscribe() {} } } };
  (globalThis as any).system = { get currentTick() { return tick; }, runInterval: (f: () => void) => { loop = f; }, afterEvents: { scriptEventReceive: { subscribe() {} } } };
  _vehicleDriverRuntimeForTests(vehicleDriverConfig([{ typeId: CLOUD, kind: vehicle.kind, label: 'Nimbus', ...(vehicle.motion ? { motion: vehicle.motion } : {}), ...(vehicle.hud ? { hud: vehicle.hud } : {}) }]));
  /** Runs `n` ticks (the driver wakes every 2); `each` is called with the tick BEFORE the driver reads the world. */
  const run = (n: number, each?: (t: number) => void): void => { for (let i = 0; i < n; i += 2) { tick += 2; each?.(tick); loop(); } };
  const mphOf = (line: string): number | undefined => { const m = /([\d.]+) mph/.exec(line); return m ? Number(m[1]) : undefined; };
  return { player, cloud, riders, events, run, lastHud: (): string => player.hud[player.hud.length - 1] ?? '', mphOf };
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
    expect(w.player.hud.length).toBeGreaterThan(0);
    for (const line of w.player.hud) expect(line).toMatch(/^§eNIMBUS!§r Jump climbs, look down \+ Jump dives, sneak gets off$/);
    w.run(4);
    expect(w.lastHud()).toMatch(/^§lNIMBUS§r §e0\.0 mph§r · §bALT 64§r · §a\[STICK: TURN · JUMP: CLIMB · LOOK DOWN \+ JUMP: DIVE\]§r$/);
  });

  it('a new rider on the same cloud gets the hint again; a rotorcraft says HELI', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS + 8);
    expect(w.lastHud()).toMatch(/mph/);
    w.riders[0] = { ...w.player, id: 'p2' };
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
    w.player.hud.length = 0;
    w.run(80, mover);
    const readings = w.player.hud.map(w.mphOf).filter((v): v is number => v !== undefined);
    expect(readings.length).toBeGreaterThanOrEqual(20);
    for (const v of readings) expect(v).toBeCloseTo(trueMph, 0);
  });

  it('reads the same speed for a smooth mover, and zero once it has stood still for a window', () => {
    const w = driverWorld();
    const mover = (): void => { w.cloud.location.z += TRUE_BLOCKS_PER_TICK * 2; };
    w.run(FLYER.RIDE_HINT_TICKS + DRIVER_SPEED_WINDOW_TICKS, mover);
    w.player.hud.length = 0;
    w.run(40, mover);
    for (const v of w.player.hud.map(w.mphOf)) expect(v).toBeCloseTo(trueMph, 0);
    w.run(DRIVER_SPEED_WINDOW_TICKS + 4);
    expect(w.mphOf(w.lastHud())).toBe(0);
  });

  it('a teleport (the wand, a reload) is not a speed', () => {
    const w = driverWorld();
    w.run(FLYER.RIDE_HINT_TICKS + 4);
    w.cloud.location.x += 50;
    w.run(8);
    for (const v of w.player.hud.map(w.mphOf).filter((v): v is number => v !== undefined)) expect(v).toBeLessThan(1);
  });
});
