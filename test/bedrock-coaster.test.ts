import { describe, expect, it, vi } from 'vitest';
import { coasterCartAssets, coasterRuntimeConfig, coasterScript } from '../web/src/engine/bedrock-coaster.js';
import type { CoasterRoute } from '../web/src/engine/bedrock-coaster.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { BlockGrid } from '../src/schem/types.js';
import { extractFile } from '../web/src/engine/zip-utils.js';
import { host } from './_placement-host.js';

function rideHost(route: CoasterRoute) {
  const properties = new Map<string, unknown>([
    ['craftmatic:coaster_origin', { x: 100, y: 64, z: 200 }],
    ['craftmatic:coaster_rotation', 0], ['craftmatic:coaster_scale', 1], ['craftmatic:coaster_route', 0],
  ]);
  const rider = { id: 'rider1', onScreenDisplay: { setActionBar: vi.fn() } };
  const riders: unknown[] = [rider];
  let loaded = true, removed = false;
  const entity: any = {
    id: 'cart1', getDynamicProperty: (key: string) => { if (removed) throw new Error('removed'); return properties.get(key); },
    setDynamicProperty: (key: string, value: unknown) => properties.set(key, value),
    setProperty: vi.fn(), teleport: vi.fn(), getRotation: () => ({ x: 0, y: 0 }),
    getComponent: () => ({ getRiders: () => [...riders], ejectRiders: () => { riders.length = 0; } }),
  };
  entity.tryTeleport = vi.fn((position: unknown, options: unknown) => { entity.teleport(position, options); return true; });
  entity.dimension = { getBlock: () => loaded ? {} : undefined };
  const world = { getDimension: (name: string) => ({ getEntities: () => name === 'overworld' && !removed ? [entity] : [] }) };
  let tick = () => {};
  const system = { runInterval: (callback: () => void) => { tick = callback; } };
  const script = coasterScript(coasterRuntimeConfig('craftmatic:test_cart', [route]));
  const start = () => new Function('world', 'system', script.replace(/^import .*;\n/, ''))(world, system);
  start();
  return { entity, properties, riders, rider, start,
    run: (n: number) => { for (let i = 0; i < n; i++) tick(); },
    setLoaded: (value: boolean) => { loaded = value; }, remove: () => { removed = true; },
  };
}

const straight: CoasterRoute = { label: 'Measured track', points: [[0, 0, 0], [10, 0, 0]], closed: false, maxSegmentLength: 10 };

describe('serialized coaster runtime', () => {
  it('waits for boarding, follows distance and stops without a rider', () => {
    const h = rideHost(straight);
    h.run(40); expect(h.entity.teleport).not.toHaveBeenCalled();
    h.run(1); expect(h.entity.teleport.mock.calls[0][0]).toEqual({ x: 100.2, y: 64, z: 200 });
    h.riders.length = 0; h.run(50); expect(h.entity.teleport).toHaveBeenCalledTimes(1);
  });
  it('uses the placement origin, yaw and size together without a constant lift', () => {
    const h = rideHost({ ...straight, points: [[2, 1, 3], [12, 1, 3]] });
    h.properties.set('craftmatic:coaster_rotation', 90); h.properties.set('craftmatic:coaster_scale', 4);
    h.run(41);
    const at = h.entity.teleport.mock.calls[0][0];
    expect(at.x).toBeCloseTo(88); expect(at.y).toBe(68); expect(at.z).toBeCloseTo(208.2);
  });
  it('follows vertical track at lift speed without inventing horizontal movement', () => {
    const h = rideHost({ ...straight, points: [[0, 0, 0], [0, 10, 0]] });
    h.run(41); expect(h.entity.teleport.mock.calls[0][0]).toEqual({ x: 100, y: 64.075, z: 200 });
    expect(h.entity.setProperty).toHaveBeenCalledWith('craftmatic:track_pitch', -90);
  });
  it('inverts the cart visually at a loop apex while leaving player rotation upright', () => {
    const points: [number, number, number][] = Array.from({ length: 65 }, (_, i) => {
      const angle = i / 64 * Math.PI * 2;
      return [0, 10 * (1 - Math.cos(angle)), 10 * Math.sin(angle)];
    });
    points[64] = [...points[0]!];
    const route: CoasterRoute = { label: 'Loop', points, closed: true, maxSegmentLength: 1 };
    const h = rideHost(route);
    h.properties.set('craftmatic:coaster_distance', coasterRuntimeConfig('craftmatic:ride', [route]).routes[0]!.path.length / 2);
    h.run(41);
    const roll = h.entity.setProperty.mock.calls.find((call: unknown[]) => call[0] === 'craftmatic:track_roll')?.[1];
    expect(Math.abs(roll)).toBeGreaterThan(170);
    expect(h.entity.teleport.mock.calls[0][1].rotation.x).toBe(0);
  });
  it('pauses at an unloaded chunk without advancing distance, then resumes', () => {
    const h = rideHost(straight); h.setLoaded(false); h.run(60);
    expect(h.entity.teleport).not.toHaveBeenCalled(); expect(h.properties.has('craftmatic:coaster_distance')).toBe(false);
    h.setLoaded(true); h.run(1); expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(0.2);
  });
  it('reverses an open route at its measured endpoint; never wraps the gap', () => {
    const h = rideHost(straight); h.properties.set('craftmatic:coaster_distance', 9.95); h.run(41);
    expect(h.entity.teleport.mock.calls[0][0].x).toBe(110);
    expect(h.properties.get('craftmatic:coaster_direction')).toBe(-1);
    h.run(41); expect(h.entity.teleport.mock.calls[1][0].x).toBeCloseTo(109.8);
  });
  it('persists progress across a script reload and retires removed carts', () => {
    const h = rideHost(straight); h.run(45);
    expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(1);
    h.start(); h.run(41); expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(1.2);
    h.remove(); h.run(40); expect(h.entity.teleport).toHaveBeenCalledTimes(6);
  });
  it('does not move a summoned cart with no placement frame', () => {
    const h = rideHost(straight); h.properties.delete('craftmatic:coaster_origin'); h.run(60);
    expect(h.entity.teleport).not.toHaveBeenCalled();
    expect(h.riders).toHaveLength(0);
  });
  it('holds distance after a failed teleport and resumes at the same next sample', () => {
    const h = rideHost(straight); h.entity.tryTeleport.mockReturnValueOnce(false); h.run(41);
    expect(h.entity.teleport).not.toHaveBeenCalled(); expect(h.properties.has('craftmatic:coaster_distance')).toBe(false);
    h.run(1); expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(0.2);
  });
  it('stops after rider loss without forcing a remount and allows deliberate reboarding', () => {
    const h = rideHost(straight);
    h.entity.tryTeleport.mockImplementationOnce((position: unknown, options: unknown) => {
      h.entity.teleport(position, options);
      h.riders.length = 0;
      return true;
    });
    h.run(41);
    expect(h.rider.onScreenDisplay.setActionBar).toHaveBeenCalledWith('Coaster mount was interrupted. Reboard the cart to continue.');
    h.run(60);
    expect(h.riders).toHaveLength(0);
    expect(h.entity.teleport).toHaveBeenCalledTimes(1);
    expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(0.2);
    h.riders.push(h.rider);
    h.run(40);
    expect(h.entity.teleport).toHaveBeenCalledTimes(1);
    h.run(1);
    expect(h.properties.get('craftmatic:coaster_distance')).toBeCloseTo(0.4);
  });
  it('reports bounded movement errors with their stage and throttles repeated logs', () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = rideHost(straight);
      h.entity.tryTeleport.mockImplementation(() => { throw new Error('movement denied ' + 'x'.repeat(200)); });
      h.run(150);
      expect(h.properties.has('craftmatic:coaster_distance')).toBe(false);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toContain('at teleport cart: movement denied');
      expect(h.rider.onScreenDisplay.setActionBar).toHaveBeenCalledWith('Coaster paused at teleport cart: ' + ('movement denied ' + 'x'.repeat(200)).slice(0, 160));
      h.run(150);
      expect(log).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });
  it('rotates heading consistently with the placed track', () => {
    for (const rotation of [0, 90, 180, 270]) {
      const h = rideHost(straight); h.properties.set('craftmatic:coaster_rotation', rotation); h.run(41);
      const yaw = h.entity.teleport.mock.calls[0][1].rotation.y * Math.PI / 180;
      const position = h.entity.teleport.mock.calls[0][0];
      // Check facing against actual movement, not a duplicated yaw formula.
      expect(-Math.sin(yaw)).toBeCloseTo((position.x - 100) / 0.2);
      expect(Math.cos(yaw)).toBeCloseTo((position.z - 200) / 0.2);
    }
  });
});

describe('coaster pack assets', () => {
  it('initializes the cart route frame through the serialized placement lifecycle', async () => {
    const h = host({ stem: 'coaster_frame', label: 'Ride', width: 12, height: 4, length: 8, tiles: [],
      actors: [{ typeId: 'craftmatic:ride', label: 'Ride', x: 3, y: 2, z: 4, coasterRouteIndex: 0 }] });
    await h.open({ selection: 1 }, { canceled: true });
    await h.open({ selection: 5 }, { selection: 0 }); await h.flush(4000);
    const cart = h.spawned.find(spawn => spawn.typeId === 'craftmatic:ride')!;
    expect(cart).toBeDefined();
    expect(cart.entity.getDynamicProperty('craftmatic:coaster_origin')).toEqual({ x: 100, y: 64, z: 200 });
    expect(cart.entity.getDynamicProperty('craftmatic:coaster_scale')).toBe(1);
    expect(cart.entity.getDynamicProperty('craftmatic:coaster_route')).toBe(0);
  });
  it('emits rideable non-gravity cart with synced visual pitch and scale groups', () => {
    const assets = coasterCartAssets('craftmatic:ride');
    const entity = (assets.behavior as any)['minecraft:entity'];
    expect(entity.components['minecraft:physics']).toEqual({ has_gravity: false, has_collision: false });
    expect(entity.description.properties['craftmatic:track_pitch'].client_sync).toBe(true);
    expect(entity.component_groups['craftmatic:size_400']).toBeDefined();
  });
  it('scales cart geometry, collision and seat at export before applying wand size', () => {
    const assets = coasterCartAssets('craftmatic:ride', 4);
    const entity = (assets.behavior as any)['minecraft:entity'];
    expect(entity.components['minecraft:collision_box'].width).toBe(5.5);
    expect(entity.components['minecraft:rideable'].seats.position).toEqual([0, 1.4, 0]);
    const body = assets.geometry['minecraft:geometry'][0]!.bones.find(bone => bone.name === 'cart')!;
    expect(body.cubes[0]!.size).toEqual([88, 8, 80]);
    expect(entity.component_groups['craftmatic:size_400']['minecraft:collision_box'].width).toBe(22);
    const wheels = body.cubes.slice(5);
    expect(wheels).toHaveLength(4);
    expect(wheels[0]!.origin[1]).toBe(-26.4);
  });
  it('writes float actor properties as float literals so Bedrock loads the property component', async () => {
    // Bedrock types actor-property JSON numbers by their LITERAL form. A float
    // property serialized as `"default": 0` is rejected with "'default' value does
    // not match the specified type 'float'", which drops the WHOLE property
    // component: client Molang `query.property` then errors every frame and the
    // server's `setProperty` throws, stalling the ride. Measured on a Pixel 8 Pro
    // (Bedrock 1.26.51) 2026-09-21 in the device content log.
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, { stem: 'Coaster', coasterRoutes: [straight] });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const entityJson = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_coaster_BP/entities/coaster_coaster_cart.json'));
    const properties = /"properties": \{[\s\S]*?\n {6}\}/.exec(entityJson)![0]!;
    expect(properties).not.toMatch(/"default": -?\d+(?!\.)/);
    expect(properties).toContain('"default": 0.0');
    expect(properties).toMatch(/"range": \[\s*-90\.0,\s*90\.0\s*\]/);
    expect(properties).toMatch(/"range": \[\s*-180\.0,\s*180\.0\s*\]/);
    // Still valid JSON carrying the same numeric meaning.
    const parsed = JSON.parse(entityJson)['minecraft:entity'].description.properties;
    expect(parsed['craftmatic:track_pitch']).toEqual({ type: 'float', range: [-90, 90], default: 0, client_sync: true });
    expect(parsed['craftmatic:track_roll']).toEqual({ type: 'float', range: [-180, 180], default: 0, client_sync: true });
  });
  it('packages the runtime and source-frame route only for coaster-enabled exports', async () => {
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, { stem: 'Coaster', coasterRoutes: [straight] });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const decode = async (name: string) => new TextDecoder().decode(await extractFile(buffer, name));
    expect(await decode('Craftmatic_coaster_BP/scripts/main.js')).toContain("import './coaster.js'");
    expect(await decode('Craftmatic_coaster_BP/scripts/coaster.js')).toContain('Measured track');
    const placement = await decode('Craftmatic_coaster_BP/scripts/placement.js');
    const config = JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(placement)![1]!);
    expect(config.actors.find((actor: any) => actor.coasterRouteIndex === 0)).toMatchObject({ x: 0, y: 0, z: 0 });
  });
});
