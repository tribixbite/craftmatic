import { describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';

const ab = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const model = () => { const g=new BlockGrid(6,3,4);g.fill(0,0,0,5,0,3,'minecraft:black_concrete');g.fill(1,1,1,4,1,2,'minecraft:red_concrete');return g; };
const pngAlphas = (bytes: ArrayBuffer | Uint8Array): number[] => {
  const png = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const idat: Uint8Array[] = [];
  for (let p = 8; p < png.length;) {
    const n = (png[p]! << 24) | (png[p + 1]! << 16) | (png[p + 2]! << 8) | png[p + 3]!;
    const type = new TextDecoder().decode(png.subarray(p + 4, p + 8));
    if (type === 'IDAT') idat.push(png.slice(p + 8, p + 8 + n));
    p += 12 + n;
  }
  const compressed = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let offset = 0; for (const part of idat) { compressed.set(part, offset); offset += part.length; }
  const raw = inflateSync(compressed);
  expect(raw[0]).toBe(0); // PNG filter type for the first 16-pixel row.
  return Array.from({ length: 16 }, (_, x) => raw[1 + x * 4 + 3]!);
};

describe('playable Bedrock add-on',()=>{
  it('moves the selected whole model without leaving a stationary duplicate', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'Roadster', vehicleMode: 'car' });
    const entries = listZipEntries(ab(result.bytes));
    expect(entries.some(name => name.endsWith('.mcstructure'))).toBe(false);
    expect(result.components).toHaveLength(1);
  });

  it('does not make an unidentified car garage drive as one vehicle', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'Car Garage', vehicleMode: 'auto' });
    expect(result.components).toHaveLength(0);
    expect(result.tileCount).toBeGreaterThan(0);
  });

  it('pairs behavior and resource packs and emits native fast car controls',async()=>{
    const result=await buildPlayableAddon(new BlockGrid(1,1,1),{stem:'Batmobile',components:[{id:'batmobile',label:'Batmobile',kind:'car',grid:model(),x:12,y:2,z:7,forwardDirection:'+x',seatAnchor:{x:.456,y:.42,z:.5},provenance:'test source'}]});
    const buffer=ab(result.bytes), entries=listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_batmobile_BP/manifest.json');
    expect(entries).toContain('Craftmatic_batmobile_RP/manifest.json');
    expect(entries).toContain('Craftmatic_batmobile_BP/entities/batmobile_batmobile.json');
    expect(entries).toContain('Craftmatic_batmobile_RP/textures/entity/batmobile_batmobile.png');
    const manifest=JSON.parse(new TextDecoder().decode(await extractFile(buffer,'Craftmatic_batmobile_BP/manifest.json')));
    expect(manifest.header.description).toContain(`Place with ${result.functionCommand};`);
    const entity=JSON.parse(new TextDecoder().decode(await extractFile(buffer,'Craftmatic_batmobile_BP/entities/batmobile_batmobile.json')));
    const components=entity['minecraft:entity'].components;
    expect(components['minecraft:input_ground_controlled']).toEqual({});
    expect(components['minecraft:movement'].value).toBeGreaterThan(1);
    expect(components['minecraft:movement'].value).toBeLessThan(1.4);
    expect(components['minecraft:damage_sensor'].triggers).toEqual([{ cause: 'all', deals_damage: 'no' }]);
    expect(components['minecraft:fire_immune']).toEqual({});
    expect(components['minecraft:rideable'].seats.position[1]).toBeGreaterThan(0);
    expect(components['minecraft:rideable'].seats.position[1]).toBeLessThan(model().height);
    expect(components['minecraft:rideable'].seats.position[0]).toBe(0);
    expect(components['minecraft:rideable'].seats.position[1]).toBeCloseTo(1.26);
    expect(components['minecraft:rideable'].seats.position[2]).toBeCloseTo(.264);
    expect(components['minecraft:rideable'].seats.lock_rider_rotation).toBe(0);
    expect(components['minecraft:variable_max_auto_step']).toEqual({
      base_value: 1.25,
      controlled_value: 1.56,
      jump_prevented_value: .6,
    });
    expect(entries).toContain('Craftmatic_batmobile_BP/scripts/vehicle-driver.js');
    const mainScript = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/scripts/main.js'));
    expect(mainScript).toContain("import './vehicle-driver.js';");
    const driverScript = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/scripts/vehicle-driver.js'));
    expect(driverScript).toContain('craftmatic:batmobile_batmobile');
    expect(driverScript).toContain('boostCooldown');
    expect(driverScript).toContain('stallTicks');
    expect(driverScript).toContain('setActionBar');
    const fn=new TextDecoder().decode(await extractFile(buffer,'Craftmatic_batmobile_BP/functions/craftmatic/batmobile.mcfunction'));
    expect(fn).toContain('give @s craftmatic:batmobile_brick_wand');
    expect(fn).not.toContain('summon ');
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/scripts/placement.js'));
    expect(placement).toContain('"typeId":"craftmatic:batmobile_batmobile","label":"Batmobile","x":12,"y":2,"z":7');
    expect(placement).toContain('"yaw":-90');
  });

  it('renders vehicle glass translucent while solids and computer screens stay opaque', async () => {
    const vehicle = new BlockGrid(3, 1, 1);
    vehicle.set(0, 0, 0, 'minecraft:glass');
    vehicle.set(1, 0, 0, 'minecraft:light_blue_stained_glass');
    vehicle.set(2, 0, 0, 'minecraft:stone');
    const result = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'Glass Car', components: [{
      id: 'car', label: 'Glass Car', kind: 'car', grid: vehicle, provenance: 'test source',
    }], screens: [{ id: 'screen', label: 'Computer', x: 0, y: 0, z: 0 }] });
    const buffer = ab(result.bytes);
    const client = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_glass_car_RP/entity/glass_car_car.entity.json')))['minecraft:client_entity'].description;
    expect(client.materials.default).toBe('entity_alphablend');
    const vehicleAlpha = pngAlphas(await extractFile(buffer, 'Craftmatic_glass_car_RP/textures/entity/glass_car_car.png'));
    expect(vehicleAlpha[0]).toBe(96);
    expect(vehicleAlpha[1]).toBe(96);
    expect(vehicleAlpha[2]).toBe(255);
    const screenAlpha = pngAlphas(await extractFile(buffer, 'Craftmatic_glass_car_RP/textures/entity/craftmatic_screen.png'));
    expect(screenAlpha[0]).toBe(255);
  });

  it('keeps component scale aligned to the scene and turns an X-long car onto entity forward', async () => {
    const car = new BlockGrid(24, 6, 8);
    car.fill(0, 0, 0, 23, 2, 7, 'minecraft:black_concrete');
    const result = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'Technic Racer', components: [{
      id: 'racer', label: 'Technic Racer', kind: 'car', grid: car, sceneScale: .5,
      longitudinalAxis: 'x', x: 30, y: 2, z: 20, provenance: 'test source',
    }] });
    const buffer = ab(result.bytes);
    const entity = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_technic_racer_BP/entities/technic_racer_racer.json')))['minecraft:entity'].components;
    expect(entity['minecraft:rideable'].seats.position[1]).toBeCloseTo(1.35);
    expect(entity['minecraft:rideable'].seats.position[1]).toBeLessThan(car.height * .5);
    expect(entity['minecraft:collision_box'].width).toBeCloseTo(3.4);
    const meshes = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_technic_racer_RP/models/entity/technic_racer_racer.geo.json')))['minecraft:geometry'];
    const cubes = meshes.flatMap((mesh: any) => mesh.bones[0].cubes);
    const xSpan = Math.max(...cubes.map((cube: any) => cube.origin[0] + cube.size[0])) - Math.min(...cubes.map((cube: any) => cube.origin[0]));
    const zSpan = Math.max(...cubes.map((cube: any) => cube.origin[2] + cube.size[2])) - Math.min(...cubes.map((cube: any) => cube.origin[2]));
    expect(xSpan / 16).toBe(4);
    expect(zSpan / 16).toBe(12);
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_technic_racer_BP/scripts/placement.js'));
    expect(placement).toContain('"x":30,"y":2,"z":20,"yaw":-90');
    expect(result.warnings).toContain('Technic Racer: front/rear direction was not identifiable from source geometry; select an explicit vehicle facing if it drives backward.');
  });

  it('honors an explicit negative-X front without changing the placed world footprint', async () => {
    const car = new BlockGrid(10, 3, 4);
    car.fill(0, 0, 0, 9, 0, 3, 'minecraft:black_concrete');
    const result = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'Racer', vehicleFacing: '-x', components: [{
      id: 'car', label: 'Racer', kind: 'car', grid: car, longitudinalAxis: 'x', x: 2.25, y: 1, z: 3.5, provenance: 'test',
    }] });
    const buffer = ab(result.bytes);
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_racer_BP/scripts/placement.js'));
    expect(placement).toContain('"x":2.25,"y":1,"z":3.5,"yaw":90');
    expect(result.warnings).toEqual([]);
  });

  it('uses proper rotations rather than mirroring asymmetric cars', async () => {
    const car = new BlockGrid(4, 2, 6);
    car.set(0, 0, 1, 'minecraft:red_concrete');
    car.set(3, 0, 4, 'minecraft:blue_concrete');
    const result = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'Asymmetric', vehicleFacing: '+z', components: [{
      id: 'car', label: 'Asymmetric', kind: 'car', grid: car, longitudinalAxis: 'z', provenance: 'test',
    }] });
    const buffer = ab(result.bytes);
    const meshes = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_asymmetric_RP/models/entity/asymmetric_car.geo.json')))['minecraft:geometry'];
    const cubes = meshes.flatMap((mesh: any) => mesh.bones[0].cubes);
    expect(cubes.map((cube: any) => cube.origin.slice(0, 3))).toEqual([[16, 0, 16], [-32, 0, -32]]);
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_asymmetric_BP/scripts/placement.js'));
    expect(placement).toContain('"yaw":0');
  });

  it('preserves a complex model across bounded independently rendered meshes', async () => {
    const grid = new BlockGrid(17, 9, 17);
    for (let y=0;y<9;y++) for(let z=0;z<17;z++) for(let x=0;x<17;x++) grid.set(x,y,z,(x+y+z)%2 ? 'minecraft:gold_block' : 'minecraft:stone');
    const result = await buildPlayableAddon(grid, { stem: 'Checker', vehicleMode: 'car' });
    const buffer = ab(result.bytes);
    const meshes = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_checker_RP/models/entity/checker_checker.geo.json')))['minecraft:geometry'];
    expect(meshes).toHaveLength(3);
    expect(meshes.flatMap((m: any) => m.bones[0].cubes)).toHaveLength(17*9*17);
    expect(meshes.every((m: any) => m.bones[0].cubes.length <= 1024)).toBe(true);
    const client = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_checker_RP/entity/checker_checker.entity.json')))['minecraft:client_entity'].description;
    const controllers = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_checker_RP/render_controllers/checker_checker.render_controllers.json'))).render_controllers;
    expect(client.render_controllers).toHaveLength(3);
    for (const key of client.render_controllers) {
      const alias = controllers[key].geometry.replace('Geometry.', '');
      expect(meshes.some((m: any) => m.description.identifier === client.geometry[alias])).toBe(true);
    }
  });

  it('uses three-dimensional air controls and visible script-backed screens',async()=>{
    const result=await buildPlayableAddon(new BlockGrid(1,1,1),{stem:'Jet',components:[{id:'jet',label:'Jet',kind:'plane',grid:model(),provenance:'test source'}],screens:[{id:'screen',label:'Computer',x:1,y:2,z:3}]});
    const buffer=ab(result.bytes), entries=listZipEntries(buffer);
    const entity=JSON.parse(new TextDecoder().decode(await extractFile(buffer,'Craftmatic_jet_BP/entities/jet_jet.json')));
    expect(entity['minecraft:entity'].components['minecraft:input_air_controlled']).toBeTruthy();
    expect(entity['minecraft:entity'].components['minecraft:physics'].has_gravity).toBe(false);
    expect(entity['minecraft:entity'].components['minecraft:movement.fly'].start_speed).toBe(0);
    expect(entries).toContain('Craftmatic_jet_RP/entity/jet_control_screen.entity.json');
    expect(entries).toContain('Craftmatic_jet_BP/scripts/main.js');
    const script = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_jet_BP/scripts/main.js'));
    expect(script).toContain("getEffect('minecraft:night_vision')");
    expect(script).toContain("addEffect('minecraft:night_vision',12000");
    expect(script).toContain("(vehicle.nameTag||vehicle.typeId)+' @ '");
  });

  it('adds configurable 10300 time circuits with slow forward acceleration', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'BackToThe-10300', label: 'Back to the Future Time Machine', vehicleMode: 'car' });
    const buffer = ab(result.bytes), entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_backtothe_10300_BP/scripts/time-machine.js');
    const entity = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_backtothe_10300_BP/entities/backtothe_10300_backtothe_10300.json')))['minecraft:entity'].components;
    expect(entity['minecraft:movement']).toEqual({ value: .02, max: 6 });
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_backtothe_10300_BP/scripts/placement.js'));
    expect(placement).toContain('import { showTimeMachineControls } from "./time-machine.js"');
    expect(placement).toContain('"vehicleControls":true');
    const script = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_backtothe_10300_BP/scripts/time-machine.js'));
    expect(script).toContain('MPH_PER_BLOCK_TICK = 20 * 2.236936');
    expect(script).toContain('ACCEL_MPH_PER_SECOND = 6');
    expect(script).toContain('BRAKE_MPH_PER_SECOND = 60');
    expect(script).toContain('e.typeId === config.typeId');
    expect(script).toContain("getMovementVector()?.y");
    expect(script).toContain('slider("Teleport speed (mph) · mph = blocks/sec × 2.236936"');
    expect(script).toContain('destination vehicle-height clearance is obstructed');
    expect(script).toContain('vehicle.tryTeleport');
    expect(script).toContain('rideable?.addRider?.(rider)');
    expect(script).toContain('time circuit disarmed');
    expect(script).toContain('minecraft:sonic_explosion');
    const named = await buildPlayableAddon(model(), { stem: 'custom-delorean', label: 'DeLorean', vehicleMode: 'car' });
    const namedEntity = JSON.parse(new TextDecoder().decode(await extractFile(ab(named.bytes), 'Craftmatic_custom_delorean_BP/entities/custom_delorean_custom_delorean.json')))['minecraft:entity'].components;
    expect(namedEntity['minecraft:movement']).toEqual({ value: .02, max: 6 });
  });

  it('ramps through drag, brakes, and performs one exact armed time jump', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'BackToThe-10300', label: 'Back to the Future Time Machine', vehicleMode: 'car' });
    let script = new TextDecoder().decode(await extractFile(ab(result.bytes), 'Craftmatic_backtothe_10300_BP/scripts/time-machine.js'));
    script = script.replace(/^import .*;$/gm, '').replace('export { showTimeMachineControls };', 'return showTimeMachineControls;');
    let interval: (() => void) | undefined;
    const commands: string[] = [], teleports: Array<{x:number;y:number;z:number}> = [], dynamic = new Map<string, unknown>();
    let movementY = 1, velocity = { x: 0, y: 0, z: 0 };
    const player: any = { id: 'player', typeId: 'minecraft:player', location: { x: 0, y: 70, z: 0 },
      inputInfo: { getMovementVector: () => ({ x: 0, y: movementY }) }, sendMessage: vi.fn(), onScreenDisplay: { setActionBar: vi.fn() } };
    const rideable = { getRiders: () => [player], addRider: vi.fn(() => true) };
    const dimension: any = { heightRange: { min: -64, max: 320 },
      getEntities: ({ type }: any) => type === 'craftmatic:backtothe_10300_backtothe_10300' ? [vehicle] : [],
      getBlock: () => ({ typeId: 'minecraft:air' }), runCommand: (command: string) => { commands.push(command); return { successCount: 1 }; } };
    const vehicle: any = { id: 'car', typeId: 'craftmatic:backtothe_10300_backtothe_10300', dimension, location: { x: 0, y: 70, z: 0 },
      getComponent: (id: string) => id === 'minecraft:rideable' ? rideable : undefined, getVelocity: () => ({ ...velocity }), getViewDirection: () => ({ x: 0, y: 0, z: 1 }),
      applyImpulse: (v: any) => { velocity = { x: velocity.x + v.x, y: velocity.y + v.y, z: velocity.z + v.z }; }, clearVelocity: () => { velocity = { x: 0, y: 0, z: 0 }; },
      getRotation: () => ({ x: 0, y: 0 }), tryTeleport: (p: any) => { teleports.push({ ...p }); vehicle.location = { ...p }; return true; },
      getDynamicProperty: (key: string) => dynamic.get(key), setDynamicProperty: (key: string, value: unknown) => dynamic.set(key, value) };
    player.dimension = dimension;
    let formValues = [10, 80, 20, 150];
    class Form { title() { return this; } textField() { return this; } slider() { return this; } async show() { return { canceled: false, formValues }; } }
    const world = { getDimension: (id: string) => { if (id !== 'overworld') throw new Error('missing'); return dimension; } };
    const system = { runInterval: (fn: () => void) => { interval = fn; }, runTimeout: (fn: () => void) => fn() };
    const show = new Function('world', 'system', 'ModalFormData', script)(world, system, Form);
    await show(player);
    expect(dynamic.get('craftmatic:time_armed')).toBe(true);
    expect(commands.some(c => c.startsWith('tickingarea add '))).toBe(true);
    interval!();
    expect(Math.hypot(velocity.x, velocity.z) * 20 * 2.236936).toBeLessThan(2);
    for (let i = 0; i < 500 && !teleports.length; i++) { velocity.x *= .3; velocity.z *= .3; interval!(); await Promise.resolve(); }
    expect(teleports).toEqual([{ x: 10, y: 80, z: 20 }]);
    expect(dynamic.get('craftmatic:time_armed')).toBe(false);
    for (let i = 0; i < 40; i++) { velocity.x *= .7; velocity.z *= .7; interval!(); await Promise.resolve(); }
    expect(teleports).toHaveLength(1);
    await show(player);
    for (let i = 0; i < 500; i++) { velocity = { x: 0, y: 0, z: 0 }; interval!(); await Promise.resolve(); }
    expect(teleports).toHaveLength(1);
    movementY = 0;
    for (let i = 0; i < 60; i++) { velocity.x *= .7; velocity.z *= .7; interval!(); }
    expect(Math.hypot(velocity.x, velocity.z) * 20 * 2.236936).toBeLessThan(1);
    expect(commands.some(c => c.startsWith('tickingarea remove '))).toBe(true);
    const adds = commands.filter(c => c.startsWith('tickingarea add ')).length;
    formValues = [1e100, 80, 20, 88];
    await show(player);
    expect(commands.filter(c => c.startsWith('tickingarea add '))).toHaveLength(adds);
    expect(player.sendMessage).toHaveBeenLastCalledWith('Use coordinates within +/-29,999,999 and a speed from 10 to 150 mph.');
  });

  it('reports deduplicated structure blocks that Bedrock cannot encode', async () => {
    const grid = new BlockGrid(2, 1, 1);
    grid.set(0, 0, 0, 'minecraft:unknown_fixture');
    grid.set(1, 0, 0, 'minecraft:unknown_fixture');
    const result = await buildPlayableAddon(grid, { stem: 'Static Fixture', vehicleMode: 'static' });
    expect(result.warnings).toEqual([
      '1 block type had no Bedrock equivalent and was omitted: minecraft:unknown_fixture',
    ]);
  });

  it('re-exports changed content as a newer version of the same one-way-linked packs', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
      const first = await buildPlayableAddon(model(), { stem: 'Roadster', vehicleMode: 'car' });
      const changed = model();
      changed.set(0, 2, 0, 'minecraft:yellow_concrete');
      vi.setSystemTime(new Date('2026-09-09T12:00:01Z'));
      const second = await buildPlayableAddon(changed, { stem: 'Roadster', vehicleMode: 'car' });
      const manifests = async (bytes: Uint8Array) => {
        const buffer = ab(bytes);
        return {
          bp: JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_roadster_BP/manifest.json'))),
          rp: JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_roadster_RP/manifest.json'))),
        };
      };
      const a = await manifests(first.bytes), b = await manifests(second.bytes);
      expect(b.bp.header.uuid).toBe(a.bp.header.uuid);
      expect(b.rp.header.uuid).toBe(a.rp.header.uuid);
      expect(b.bp.header.version).toEqual([2, 663, 4_417]);
      expect(b.bp.header.version).not.toEqual(a.bp.header.version);
      expect(b.bp.modules.every((module: { version: number[] }) =>
        JSON.stringify(module.version) === JSON.stringify(b.bp.header.version))).toBe(true);
      expect(b.bp.dependencies[0]).toEqual({ uuid: b.rp.header.uuid, version: b.rp.header.version });
      expect(b.rp.dependencies).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
