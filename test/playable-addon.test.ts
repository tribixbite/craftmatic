import { describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon, measureCoasterTrain, COASTER_SAME_CAR_ARC } from '../web/src/engine/playable-addon.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { packIdentity } from '../web/src/engine/mcpack.js';
import { provenanceSentence, unstampedPipeline, type PipelineStamp, type SourceProvenance } from '../web/src/engine/pipeline-version.js';
import type { CoasterRoute } from '../web/src/engine/bedrock-coaster.js';
import { SIZE_STEPS } from '../web/src/engine/bedrock-placement-pack.js';
import { minifigCreatorLibrary } from '../web/src/engine/minifig-creator.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';

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
  it('emits a standalone minifig creator entity, property-driven controller, wand and runtime', async () => {
    const provider = { getPartMesh: async (part: string) => ({ partId: part, resolvedAs: part, description: part === '973' ? 'Minifig Torso' : 'Minifig Head', triangles: [{ a: [0, 0, 0], b: [20, 0, 0], c: [0, 24, 0], color: 16 }], studs: [], bounds: { min: [0, 0, 0], max: [20, 24, 4] }, unresolvedRefs: [] }), report: () => ({ unresolved: [], printFallbacks: [], substitutions: [] }) };
    const library = minifigCreatorLibrary('starter');
    // Keep this archive-level acceptance fixture fast and independent of the external corpus.
    library.slots.minifig = { torso: [{ part: '973', label: 'Torso', group: 'Core' }], head: [{ part: '3626c', label: 'Head', group: 'Core' }] };
    const result = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'Creator', minifigCreator: library, partGeometry: provider });
    const buffer = ab(result.bytes), entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_creator_BP/entities/creator_minifig.json');
    expect(entries).toContain('Craftmatic_creator_BP/scripts/minifig-wand.js');
    const entity = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_creator_BP/entities/creator_minifig.json')));
    expect(entity['minecraft:entity'].description.properties['craftmatic:torso'].client_sync).toBe(true);
    // Bedrock drops the whole property component over one [0, 0] range (Pixel 2026-09-25: the
    // slots with a single entry and `craftmatic:family`), and the wand could then set nothing.
    for (const [name, prop] of Object.entries(entity['minecraft:entity'].description.properties as Record<string, { type: string; range?: number[] }>)) {
      if (prop.type === 'int') expect(prop.range![1]! > prop.range![0]!, name).toBe(true);
    }
    // A released creator figure walks with the scripted walker, not vanilla's stroll (bedrock-figure-life.ts).
    expect(JSON.stringify(entity)).not.toContain('random_stroll');
    expect(entries).toContain('Craftmatic_creator_BP/scripts/figures.js');
    const figuresJs = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_creator_BP/scripts/figures.js'));
    const figuresConfig = JSON.parse(/const CONFIG = (.*);\n/.exec(figuresJs)![1]!) as { figureTypes: string[]; draftTypes: string[] };
    expect(figuresConfig.figureTypes).toContain(entity['minecraft:entity'].description.identifier);
    expect(figuresConfig.draftTypes).toEqual([entity['minecraft:entity'].description.identifier]);
    expect(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_creator_BP/scripts/main.js'))).toContain("import './figures.js';");
    const controller = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_creator_RP/render_controllers/creator_minifig.render_controllers.json'));
    expect(controller).toContain("q.property('craftmatic:torso')");
    expect(controller).toContain('Array.swatch');
    const grantPath = `Craftmatic_creator_BP/functions/${result.functionCommand.replace('/function ', '')}.mcfunction`;
    const grant = new TextDecoder().decode(await extractFile(buffer, grantPath));
    expect(grant).toContain('give @s craftmatic:creator_brick_wand');
    expect(grant).toContain('give @s craftmatic:creator_minifig_wand');
    expect(entries).toContain('Craftmatic_creator_BP/MINIFIG-CREATOR.txt');
    expect(entries).toContain('Craftmatic_creator_RP/texts/en_US.lang');
  });

  it('reserves optional creator slot index zero for a full-rig None geometry', async () => {
    const provider = { getPartMesh: async (part: string) => ({ partId: part, resolvedAs: part, description: 'Minifig Hair', triangles: [{ a: [0, 0, 0], b: [20, 0, 0], c: [0, 24, 0], color: 16 }], studs: [], bounds: { min: [0, 0, 0], max: [20, 24, 4] }, unresolvedRefs: [] }), report: () => ({ unresolved: [], printFallbacks: [], substitutions: [] }) };
    const library = minifigCreatorLibrary('starter'); library.slots.minifig = { hair: [{ part: '3901', label: 'Hair', group: 'Hair' }] };
    const pack = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'NoneCreator', minifigCreator: library, partGeometry: provider });
    const zip = ab(pack.bytes), entity = JSON.parse(new TextDecoder().decode(await extractFile(zip, 'Craftmatic_nonecreator_BP/entities/nonecreator_minifig.json')));
    expect(entity['minecraft:entity'].description.properties['craftmatic:hair'].range).toEqual([0, 1]);
    const empty = JSON.parse(new TextDecoder().decode(await extractFile(zip, 'Craftmatic_nonecreator_RP/models/entity/nonecreator_mf_empty.geo.json')));
    expect(empty['minecraft:geometry'][0].bones.map((b: { name: string }) => b.name)).toContain('hand_left');
  });
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
    // A grid-only car is scripted too since 2026-09-25 (no camel left): zero native speed, the attitude properties.
    expect(components['minecraft:input_ground_controlled']).toBeUndefined();
    expect(components['minecraft:dash_action']).toBeUndefined();
    expect(Object.keys(entity['minecraft:entity'].description.properties)).toContain('craftmatic:fl_pitch');
    expect(entity.format_version).toBe('1.26.30');
    expect(components['minecraft:rideable'].seats.third_person_camera_radius).toBeGreaterThanOrEqual(5);
    expect(components['minecraft:movement'].value).toBe(0);
    expect(components['minecraft:damage_sensor'].triggers).toEqual([{ cause: 'all', deals_damage: 'no' }]);
    expect(components['minecraft:fire_immune']).toEqual({});
    expect(components['minecraft:rideable'].seats.position[1]).toBeGreaterThan(0);
    expect(components['minecraft:rideable'].seats.position[1]).toBeLessThan(model().height);
    expect(components['minecraft:rideable'].seats.position[0]).toBe(0);
    expect(components['minecraft:rideable'].seats.position[1]).toBeCloseTo(1.26);
    expect(components['minecraft:rideable'].seats.position[2]).toBeCloseTo(.264);
    expect(components['minecraft:rideable'].seats.lock_rider_rotation).toBe(0);
    expect(components['minecraft:variable_max_auto_step']).toBeUndefined();
    // scripts/vehicles.js drives it (carStep, the swept footprint, headlights); the rotorcraft-only driver script is not shipped.
    expect(entries).not.toContain('Craftmatic_batmobile_BP/scripts/vehicle-driver.js');
    const mainScript = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/scripts/main.js'));
    expect(mainScript).toContain("import './vehicles.js';");
    const vehiclesScript = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/scripts/vehicles.js'));
    expect(vehiclesScript).toContain('"craftmatic:batmobile_batmobile":{"mode":"car"');
    expect(vehiclesScript).toContain('"halfWidth":');
    expect(vehiclesScript).toContain('function sweepFootprint');
    expect(vehiclesScript).toContain('craftmatic:vehicle_telemetry');
    expect(vehiclesScript).toContain('getTimeOfDay');
    expect(vehiclesScript).toContain('setActionBar');
    expect(vehiclesScript).not.toContain('night_vision');
    // Both chase presets ship; the joystick steers under player_relative; orbit is the default.
    const chase = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/cameras/presets/batmobile_batmobile_chase.json')));
    expect(chase['minecraft:camera_preset']).toMatchObject({ inherit_from: 'minecraft:follow_orbit', control_scheme: 'player_relative' });
    const boom = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/cameras/presets/batmobile_batmobile_boom.json')));
    expect(boom['minecraft:camera_preset']).toMatchObject({ inherit_from: 'minecraft:fixed_boom', control_scheme: 'player_relative' });
    const cameraScript = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/scripts/vehicle-camera.js'));
    expect(cameraScript).toContain('"preset":"craftmatic:batmobile_batmobile_chase"');
    // A scripted car: the chase camera follows the VEHICLE's heading; the camel's tuning hooks are gone.
    expect(cameraScript).toContain('"kind":"car"');
    expect(cameraScript).toContain('"scripted":true');
    expect(cameraScript).toContain('minecraft:free');
    expect(cameraScript).toContain('"radius":');
    expect(cameraScript).not.toContain('craftmatic:vehicle_scheme');
    expect(cameraScript).not.toContain('craftmatic:vehicle_camera');
    // Hotbar slot 9 swaps the chase camera for the cockpit view.
    expect(cameraScript).toContain('selectedSlotIndex === 8');
    const fn=new TextDecoder().decode(await extractFile(buffer,'Craftmatic_batmobile_BP/functions/craftmatic/batmobile.mcfunction'));
    expect(fn).toContain('give @s craftmatic:batmobile_brick_wand');
    expect(fn).not.toContain('summon ');
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/scripts/placement.js'));
    expect(placement).toContain('"typeId":"craftmatic:batmobile_batmobile","label":"Batmobile","x":12,"y":2,"z":7');
    expect(placement).toContain('"yaw":-90');
  });

  it('pairs behavior and resource packs and makes a boat a scripted vehicle (the buoyant camel crawled at 1.6 blocks/s)', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'Pirate Ship', vehicleMode: 'boat' });
    const buffer = ab(result.bytes);
    const entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_pirate_ship_BP/manifest.json');
    expect(entries).toContain('Craftmatic_pirate_ship_BP/entities/pirate_ship_pirate_ship.json');
    const entity = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_pirate_ship_BP/entities/pirate_ship_pirate_ship.json')));
    const components = entity['minecraft:entity'].components;
    // No native controller moves it: the script owns position and heading, Jump stays an input.
    expect(components['minecraft:buoyant']).toBeUndefined();
    expect(components['minecraft:input_ground_controlled']).toBeUndefined();
    expect(components['minecraft:movement'].value).toBe(0);
    expect(components['minecraft:physics'].has_gravity).toBe(false);
    expect(components['minecraft:vertical_movement_action'].vertical_velocity).toBe(0);
    expect(Object.keys(entity['minecraft:entity'].description.properties)).toEqual(['craftmatic:fl_pitch', 'craftmatic:fl_bank', 'craftmatic:fl_wheel']);
    const script = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_pirate_ship_BP/scripts/vehicles.js'));
    expect(script).toContain('function boatStep');
    expect(script).toContain('"craftmatic:pirate_ship_pirate_ship":{"mode":"boat"');
    expect(entries).not.toContain('Craftmatic_pirate_ship_BP/scripts/vehicle-driver.js');
    const main = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_pirate_ship_BP/scripts/main.js'));
    expect(main).toContain("import './vehicles.js';");
  });

  it('auto-detects ships and boats from label keywords', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'Speedboat', vehicleMode: 'auto' });
    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.kind).toBe('boat');
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

  it('names every entity in texts/en_US.lang instead of leaving raw entity.<id>.name keys visible, with a spawn egg only for is_spawnable entities', async () => {
    const vehicle = new BlockGrid(3, 1, 1);
    vehicle.set(0, 0, 0, 'minecraft:stone');
    const result = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'Glass Car', components: [{
      id: 'car', label: 'Glass Car', kind: 'car', grid: vehicle, provenance: 'test source',
    }], screens: [{ id: 'screen', label: 'Computer', x: 0, y: 0, z: 0 }] });
    const buffer = ab(result.bytes), entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_glass_car_RP/texts/languages.json');
    expect(JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_glass_car_RP/texts/languages.json')))).toEqual(['en_US']);
    const lang = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_glass_car_RP/texts/en_US.lang'));
    // The vehicle is is_spawnable — it gets a name AND a spawn-egg name.
    expect(lang).toContain('entity.craftmatic:glass_car_car.name=Glass Car');
    expect(lang).toContain('item.spawn_egg.entity.craftmatic:glass_car_car.name=Glass Car Spawn Egg');
    // The computer screen is is_spawnable: false — a name, but no spawn egg.
    expect(lang).toContain('entity.craftmatic:glass_car_control_screen.name=Glass Car Control Screen');
    expect(lang).not.toContain('spawn_egg.entity.craftmatic:glass_car_control_screen');
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
    // A +Z nose is yaw 180 in the world (grid +Z is LDraw −Z, and an entity at
    // yaw 0 faces +Z), so the grid geometry is authored for yaw 180: a cell's
    // offset from the centre is kept, not negated. Both cells keep their
    // relative placement, nothing is mirrored.
    expect(cubes.map((cube: any) => cube.origin.slice(0, 3))).toEqual([[-32, 0, -32], [16, 0, 16]]);
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_asymmetric_BP/scripts/placement.js'));
    expect(placement).toContain('"yaw":180');
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

  // Bedrock culls an entity against the box its geometry declares, and the wand's
  // `minecraft:scale` size steps (25 %…400 %) cannot resize it at runtime. A box
  // sized for 100 % made whole sets vanish once the camera tilted far enough to
  // push it out of the frustum. Every chunk carries the WHOLE model's box: a
  // chunk is an arbitrary slice of the cube list, so a per-chunk box would let
  // the game cull parts of one build away independently.
  it('bounds every mesh for the LARGEST wand size step, not just for 100 %', async () => {
    const grid = new BlockGrid(17, 9, 17);
    for (let y=0;y<9;y++) for(let z=0;z<17;z++) for(let x=0;x<17;x++) grid.set(x,y,z,(x+y+z)%2 ? 'minecraft:gold_block' : 'minecraft:stone');
    const result = await buildPlayableAddon(grid, { stem: 'Culling', vehicleMode: 'car' });
    const buffer = ab(result.bytes);
    const meshes = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_culling_RP/models/entity/culling_culling.geo.json')))['minecraft:geometry'];
    expect(meshes.length).toBeGreaterThan(1);
    const cubes = meshes.flatMap((m: any) => m.bones[0].cubes);
    // The model's AABB in blocks, over ALL meshes (16 model units per block).
    const lo = [0, 1, 2].map(i => Math.min(...cubes.map((c: any) => c.origin[i])) / 16);
    const hi = [0, 1, 2].map(i => Math.max(...cubes.map((c: any) => c.origin[i] + c.size[i])) / 16);
    const f = Math.max(...SIZE_STEPS) / 100;
    for (const mesh of meshes) {
      const d = mesh.description, half = d.visible_bounds_width / 2, oy = d.visible_bounds_offset[1];
      for (const i of [0, 2]) {
        expect([d.identifier, i, lo[i]! * f >= -half, hi[i]! * f <= half]).toEqual([d.identifier, i, true, true]);
      }
      expect([d.identifier, lo[1]! * f >= oy - d.visible_bounds_height / 2]).toEqual([d.identifier, true]);
      expect([d.identifier, hi[1]! * f <= oy + d.visible_bounds_height / 2]).toEqual([d.identifier, true]);
    }
  });

  it('uses three-dimensional air controls and visible script-backed screens',async()=>{
    const result=await buildPlayableAddon(new BlockGrid(1,1,1),{stem:'Jet',components:[{id:'jet',label:'Jet',kind:'plane',grid:model(),provenance:'test source'}],screens:[{id:'screen',label:'Computer',x:1,y:2,z:3}]});
    const buffer=ab(result.bytes), entries=listZipEntries(buffer);
    const entity=JSON.parse(new TextDecoder().decode(await extractFile(buffer,'Craftmatic_jet_BP/entities/jet_jet.json')));
    // Happy-Ghast pattern: fly where the rider looks, Jump climbs, hover keeps it up.
    expect(entity['minecraft:entity'].components['minecraft:free_camera_controlled']).toEqual({ strafe_speed_modifier: 1, backwards_movement_modifier: .5 });
    // The vertical action lives only in the climb/descend groups (a removed group does not restore a base component).
    expect(entity['minecraft:entity'].components['minecraft:vertical_movement_action']).toBeUndefined();
    expect(entity['minecraft:entity'].component_groups['craftmatic:climbing']).toEqual({ 'minecraft:vertical_movement_action': { vertical_velocity: .5 } });
    expect(entity['minecraft:entity'].events['minecraft:entity_spawned']).toEqual({ add: { component_groups: ['craftmatic:climbing'] } });
    // Descend: the driver script adds `craftmatic:descending` (Jump's vertical action turned negative) while the
    // rider pulls back and holds Jump, and removes it when the stick returns - a way down that does not depend on look pitch.
    expect(entity['minecraft:entity'].component_groups['craftmatic:descending']).toEqual({ 'minecraft:vertical_movement_action': { vertical_velocity: -.5 } });
    expect(entity['minecraft:entity'].events['craftmatic:descend_on']).toEqual({ remove: { component_groups: ['craftmatic:climbing'] }, add: { component_groups: ['craftmatic:descending'] } });
    expect(entity['minecraft:entity'].events['craftmatic:descend_off']).toEqual({ remove: { component_groups: ['craftmatic:descending'] }, add: { component_groups: ['craftmatic:climbing'] } });
    const driver = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_jet_BP/scripts/vehicle-driver.js'));
    expect(driver).toContain('"descendOn":"craftmatic:descend_on"');
    expect(driver).toContain('"descendOff":"craftmatic:descend_off"');
    expect(driver).toContain('jump && forwardInput < -0.1');
    expect(driver).toContain('vehicle.triggerEvent');
    expect(driver).toContain('BACK+JUMP: DESCEND');
    expect(entity['minecraft:entity'].components['minecraft:is_tamed']).toEqual({});
    expect(entity['minecraft:entity'].components['minecraft:flying_speed']).toEqual({ value: .3 });
    expect(entity['minecraft:entity'].components['minecraft:movement.hover']).toEqual({});
    expect(entity['minecraft:entity'].components['minecraft:physics'].has_gravity).toBe(false);
    expect(entity['minecraft:entity'].components['minecraft:movement.fly']).toBeUndefined();
    // An aircraft keeps the locked scheme (look pitch flies it) and gets no boom preset.
    const chase = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_jet_BP/cameras/presets/jet_jet_chase.json')));
    expect(chase['minecraft:camera_preset'].control_scheme).toBe('locked_player_relative_strafe');
    expect(entries).not.toContain('Craftmatic_jet_BP/cameras/presets/jet_jet_boom.json');
    expect(entries).toContain('Craftmatic_jet_RP/entity/jet_control_screen.entity.json');
    expect(entries).toContain('Craftmatic_jet_BP/scripts/main.js');
    const script = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_jet_BP/scripts/main.js'));
    expect(script).toContain("getEffect('minecraft:night_vision')");
    expect(script).toContain("addEffect('minecraft:night_vision',12000");
    expect(script).toContain("(vehicle.nameTag||vehicle.typeId)+' @ '");
  });

  it('adds configurable 10300 time circuits to a SCRIPTED car (the camel is gone)', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'BackToThe-10300', label: 'Back to the Future Time Machine', vehicleMode: 'car' });
    const buffer = ab(result.bytes), entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_backtothe_10300_BP/scripts/time-machine.js');
    const entity = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_backtothe_10300_BP/entities/backtothe_10300_backtothe_10300.json')))['minecraft:entity'];
    expect(entity.components['minecraft:movement']).toEqual({ value: 0 });
    expect(entity.components['minecraft:input_ground_controlled']).toBeUndefined();
    expect(Object.keys(entity.description.properties)).toContain('craftmatic:fl_pitch');
    const vehicles = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_backtothe_10300_BP/scripts/vehicles.js'));
    expect(vehicles).toContain('"craftmatic:backtothe_10300_backtothe_10300":{"mode":"car"');
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_backtothe_10300_BP/scripts/placement.js'));
    expect(placement).toContain('import { showTimeMachineControls } from "./time-machine.js"');
    expect(placement).toContain('"vehicleControls":true');
    const script = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_backtothe_10300_BP/scripts/time-machine.js'));
    expect(script).toContain('MPH_PER_BLOCK_TICK = 20 * 2.236936');
    expect(script).toContain('"topSpeedProperty":"craftmatic:top_speed"');
    expect(script).toContain('"hudProperty":"craftmatic:vehicle_hud"');
    expect(script).toContain('e.typeId === config.typeId');
    expect(script).not.toContain('applyImpulse');
    expect(script).not.toContain('night_vision');
    expect(script).toContain('slider("Teleport speed (mph) · mph = blocks/sec × 2.236936"');
    expect(script).toContain('destination vehicle-height clearance is obstructed');
    expect(script).toContain('vehicle.tryTeleport');
    expect(script).toContain('rideable?.addRider?.(rider)');
    expect(script).toContain('TIME CIRCUIT OFF');
    expect(script).toContain('minecraft:sonic_explosion');
    const named = await buildPlayableAddon(model(), { stem: 'custom-delorean', label: 'DeLorean', vehicleMode: 'car' });
    const namedEntries = listZipEntries(ab(named.bytes));
    expect(namedEntries).toContain('Craftmatic_custom_delorean_BP/scripts/time-machine.js');
    const namedEntity = JSON.parse(new TextDecoder().decode(await extractFile(ab(named.bytes), 'Craftmatic_custom_delorean_BP/entities/custom_delorean_custom_delorean.json')))['minecraft:entity'].components;
    expect(namedEntity['minecraft:movement']).toEqual({ value: 0 });
  });

  it('raises the scripted car top speed to the armed speed and makes one exact time jump when it gets there', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'BackToThe-10300', label: 'Back to the Future Time Machine', vehicleMode: 'car' });
    let script = new TextDecoder().decode(await extractFile(ab(result.bytes), 'Craftmatic_backtothe_10300_BP/scripts/time-machine.js'));
    script = script.replace(/^import .*;$/gm, '').replace('export { showTimeMachineControls };', 'return showTimeMachineControls;');
    let interval: (() => void) | undefined;
    const commands: string[] = [], teleports: Array<{x:number;y:number;z:number}> = [], dynamic = new Map<string, unknown>();
    const player: any = { id: 'player', typeId: 'minecraft:player', location: { x: 0, y: 70, z: 0 },
      inputInfo: { getMovementVector: () => ({ x: 0, y: 1 }) }, sendMessage: vi.fn(), onScreenDisplay: { setActionBar: vi.fn() } };
    const rideable = { getRiders: () => [player], addRider: vi.fn(() => true) };
    const dimension: any = { heightRange: { min: -64, max: 320 },
      getEntities: ({ type }: any) => type === 'craftmatic:backtothe_10300_backtothe_10300' ? [vehicle] : [],
      getBlock: () => ({ typeId: 'minecraft:air' }), runCommand: (command: string) => { commands.push(command); return { successCount: 1 }; } };
    // scripts/vehicles.js moves the car by teleports along its heading (yaw 0 = +z); here the test does, `speed` blocks/s.
    let speed = 0;
    const vehicle: any = { id: 'car', typeId: 'craftmatic:backtothe_10300_backtothe_10300', dimension, location: { x: 0, y: 70, z: 0 },
      getComponent: (id: string) => id === 'minecraft:rideable' ? rideable : undefined,
      getRotation: () => ({ x: 0, y: 0 }), tryTeleport: (p: any) => { teleports.push({ ...p }); vehicle.location = { ...p }; return true; },
      getDynamicProperty: (key: string) => dynamic.get(key), setDynamicProperty: (key: string, value: unknown) => dynamic.set(key, value) };
    const drive = (): void => { vehicle.location = { ...vehicle.location, z: vehicle.location.z + speed * 2 / 20 }; interval!(); };
    player.dimension = dimension;
    let formValues = [10, 80, 20, 150];
    class Form { title() { return this; } textField() { return this; } slider() { return this; } async show() { return { canceled: false, formValues }; } }
    const world = { getDimension: (id: string) => { if (id !== 'overworld') throw new Error('missing'); return dimension; } };
    const system = { runInterval: (fn: () => void) => { interval = fn; }, runTimeout: (fn: () => void) => fn() };
    const show = new Function('world', 'system', 'ModalFormData', script)(world, system, Form);
    // Circuit off: the car tops out just past 88 mph, and the HUD says the circuit is off.
    drive();
    expect(dynamic.get('craftmatic:top_speed')).toBeCloseTo(88 * 1.03 / 2.236936, 5);
    expect(dynamic.get('craftmatic:vehicle_hud')).toContain('TIME CIRCUIT OFF');
    await show(player);
    expect(dynamic.get('craftmatic:time_armed')).toBe(true);
    expect(commands.some(c => c.startsWith('tickingarea add '))).toBe(true);
    // Armed at 150 mph: the top speed follows it, and the HUD shows it armed.
    drive();
    expect(dynamic.get('craftmatic:top_speed')).toBeCloseTo(150 * 1.03 / 2.236936, 5);
    expect(dynamic.get('craftmatic:vehicle_hud')).toContain('ARMED 150 MPH');
    // Below the armed speed nothing happens; at it, exactly one jump.
    for (speed = 0; speed < 66; speed += 2) { drive(); await Promise.resolve(); }
    expect(teleports).toHaveLength(0);
    for (let i = 0; i < 20 && !teleports.length; i++) { speed = 68; drive(); await Promise.resolve(); }
    expect(teleports).toEqual([{ x: 10, y: 80, z: 20 }]);
    expect(dynamic.get('craftmatic:time_armed')).toBe(false);
    // The jump itself (a 10-block move in 2 ticks) is a teleport, not a speed: no second jump.
    for (let i = 0; i < 40; i++) { drive(); await Promise.resolve(); }
    expect(teleports).toHaveLength(1);
    await show(player);
    speed = 0;
    for (let i = 0; i < 500; i++) { drive(); await Promise.resolve(); }
    expect(teleports).toHaveLength(1);
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
      // `packVersionAt`: [YYMM, DDHH, MMSS] UTC, so 2026-09-09T12:00:01Z reads as 2609.912.1
      // in the game's Technical details (was the opaque [2, 663, 4417] of the legacy encoding).
      expect(b.bp.header.version).toEqual([2609, 912, 1]);
      expect(a.bp.header.version).toEqual([2609, 912, 0]);
      expect(b.bp.header.version).not.toEqual(a.bp.header.version);
      expect(b.bp.modules.every((module: { version: number[] }) =>
        JSON.stringify(module.version) === JSON.stringify(b.bp.header.version))).toBe(true);
      expect(b.bp.dependencies[0]).toEqual({ uuid: b.rp.header.uuid, version: b.rp.header.version });
      expect(b.rp.dependencies).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits multi-seat co-pilot configuration when seatCount > 1', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'Galaxy Cruiser', vehicleMode: 'plane', seatCount: 2 });
    const buffer = ab(result.bytes);
    const entity = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_galaxy_cruiser_BP/entities/galaxy_cruiser_galaxy_cruiser.json')));
    const rideable = entity['minecraft:entity'].components['minecraft:rideable'];
    expect(rideable.seat_count).toBe(2);
    expect(rideable.controlling_seat).toBe(0);
    expect(Array.isArray(rideable.seats)).toBe(true);
    expect(rideable.seats).toHaveLength(2);
    expect(rideable.seats[0].min_rider_count).toBe(0);
    expect(rideable.seats[0].max_rider_count).toBe(1);
    expect(rideable.seats[1].min_rider_count).toBe(1);
    expect(rideable.seats[1].max_rider_count).toBe(2);
    // Driver and passenger seats are separated laterally
    expect(rideable.seats[0].position[0]).not.toEqual(rideable.seats[1].position[0]);
  });

  it('keeps vehicle-driver.js for the rotorcraft alone: rotor sound, co-pilot HUD, descend', async () => {
    const heli = await buildPlayableAddon(model(), { stem: 'Rescue Helicopter', label: 'Rescue Helicopter', vehicleMode: 'plane' });
    const driverScript = new TextDecoder().decode(await extractFile(ab(heli.bytes), 'Craftmatic_rescue_helicopter_BP/scripts/vehicle-driver.js'));
    expect(driverScript).toContain('elytra.loop');
    expect(driverScript).toContain('ABOARD');
    expect(driverScript).toContain('descendOn');
    expect(driverScript).not.toContain('night_vision');
    expect(driverScript).not.toContain('GEAR');
    // A car has no native controller left, so no driver script ships with it.
    const car = await buildPlayableAddon(model(), { stem: 'Supercar', vehicleMode: 'car' });
    expect(listZipEntries(ab(car.bytes))).not.toContain('Craftmatic_supercar_BP/scripts/vehicle-driver.js');
  });
});

describe('playable add-on — brick-compiled entities', () => {
  const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
    const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
    return [
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    ];
  };
  const LIB: Record<string, string> = {
    '3001': ['0 Brick 2 x 4', ...box6(-40, 40, -24, 0, -20, 20), '1 16 -30 -24 -10 1 0 0 0 1 0 0 0 1 stud.dat'].join('\n'),
    '3823': ['0 Windscreen', ...box6(-20, 20, -40, 0, -2, 2)].join('\n'),
  };
  const providerFor = async () => {
    const { createPartGeometryProvider } = await import('../web/src/engine/ldraw-part-geometry.js');
    return createPartGeometryProvider({ fetchPartText: async id => LIB[id.replace(/^.*\//, '')] ?? null });
  };
  const bricks = [
    { part: '3001.dat', color: 4, x: 0, y: 0, z: 0 },
    { part: '3823.dat', color: 47, x: 0, y: -24, z: 30 },
    { part: '99999.dat', color: 1, x: 100, y: 0, z: 0 },
  ];

  it('measures the roof over the seat, not the top of a tall pole at the tail (10300: a rider floated three blocks up)', async () => {
    const { compileLdrawEntityGeometry } = await import('../web/src/engine/ldraw-entity-compiler.js');
    // A three-brick body with a windscreen at its front, and a nine-brick pole standing at its tail.
    const car = [
      { part: '3001.dat', color: 4, x: 0, y: 0, z: -40 }, { part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }, { part: '3001.dat', color: 4, x: 0, y: 0, z: 40 },
      { part: '3823.dat', color: 47, x: 0, y: -24, z: -30 },
      ...Array.from({ length: 9 }, (_, k) => ({ part: '3001.dat', color: 0, x: 0, y: -24 * k, z: 80 })),
    ];
    const geo = await compileLdrawEntityGeometry('pole_car', 'car', car, { scale: 0.3, partGeometry: await providerFor(), facing: '-z' });
    expect(geo.sizeBlocks.height).toBeGreaterThan(3.5);
    // The roof over the seat is the body with its windscreen (24 + 40 LDU), not the pole's nine bricks.
    expect(geo.roofAtSeatBlocks).toBeLessThan(1.5);
    expect(geo.roofAtSeatBlocks).toBeGreaterThan(0.3);
  });

  it('emits real-geometry meshes, one exact-colour PBR swatch per LDraw colour, an opaque material and diagnostics', async () => {
    const grid = new BlockGrid(4, 4, 4);
    grid.set(1, 1, 1, 'minecraft:red_concrete');
    const result = await buildPlayableAddon(grid, {
      stem: 'senna', components: [{ id: 'car', label: 'Senna', kind: 'car', grid, provenance: 'test', bricks }],
      partGeometry: await providerFor(), vehicleFacing: '+z',
    });
    const buffer = ab(result.bytes), entries = listZipEntries(buffer);
    // One swatch per LDraw colour (box UV: a geometry carries one colour), named
    // after the colour so every entity in the pack shares the file.
    for (const name of [
      'Craftmatic_senna_RP/models/entity/senna_car.geo.json',
      'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_4.png',
      'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_4_mer.png',
      'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_4_normal.png',
      'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_4.texture_set.json',
      'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_1.png',
      'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_47.png',
      'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_47.texture_set.json',
      'Craftmatic_senna_BP/craftmatic-diagnostics.json',
    ]) expect(entries).toContain(name);
    const rpManifest = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_senna_RP/manifest.json')));
    expect(rpManifest.capabilities).toEqual(['pbr']);
    const client = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_senna_RP/entity/senna_car.entity.json')))['minecraft:client_entity'].description;
    expect(client.materials).toEqual({ default: 'entity', blend: 'entity_alphablend' });
    // Every geometry is bound to its own colour's swatch, and the translucent
    // one to the alpha-blended material.
    expect(Object.values(client.textures as Record<string, string>).sort()).toEqual([
      'textures/entity/craftmatic_swatch_1', 'textures/entity/craftmatic_swatch_4', 'textures/entity/craftmatic_swatch_47',
    ]);
    const controllers = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_senna_RP/render_controllers/senna_car.render_controllers.json'))).render_controllers as Record<string, { textures: string[]; materials: Array<Record<string, string>> }>;
    const keyOfTexture = Object.fromEntries(Object.entries(client.textures as Record<string, string>).map(([k, v]) => [v, k]));
    const swatchOf = (i: number): string => (client.textures as Record<string, string>)[controllers[`controller.render.craftmatic.senna_car_mesh_${i}`]!.textures[0]!.replace('Texture.', '')]!;
    expect(keyOfTexture['textures/entity/craftmatic_swatch_4']).toBeDefined();
    const blended = Object.entries(controllers).filter(([, c]) => c.materials[0]!['*'] === 'Material.blend');
    expect(blended).toHaveLength(1);
    expect(blended[0]![1].textures).toEqual([`Texture.${keyOfTexture['textures/entity/craftmatic_swatch_47']}`]);
    const textureSet = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_4.texture_set.json')));
    expect(textureSet['minecraft:texture_set']).toEqual({ color: 'craftmatic_swatch_4', metalness_emissive_roughness: 'craftmatic_swatch_4_mer', normal: 'craftmatic_swatch_4_normal' });
    // Opaque red is opaque end to end; trans-clear keeps its alpha.
    const alphas = pngAlphas(await extractFile(buffer, 'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_4.png'));
    expect([...new Set(alphas)]).toEqual([255]);
    const canopyAlphas = pngAlphas(await extractFile(buffer, 'Craftmatic_senna_RP/textures/entity/craftmatic_swatch_47.png'));
    expect([...new Set(canopyAlphas)]).toEqual([128]);
    const geo = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_senna_RP/models/entity/senna_car.geo.json')));
    const ids = geo['minecraft:geometry'].map((m: { description: { identifier: string } }) => m.description.identifier);
    expect(ids).toEqual(['geometry.craftmatic.senna_car_mesh_0', 'geometry.craftmatic.senna_car_mesh_1', 'geometry.craftmatic.senna_car_mesh_2']);
    // The translucent colour is the LAST geometry, so it draws over the opaque ones.
    expect(swatchOf(2)).toBe('textures/entity/craftmatic_swatch_47');
    const diag = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_senna_BP/craftmatic-diagnostics.json')));
    expect(diag.entities.senna_car).toMatchObject({ sourcePartCount: 3, uniquePartCount: 3, resolvedPartCount: 2, unresolvedParts: ['99999'] });
    expect(result.diagnostics.senna_car).toBeDefined();
    expect(result.warnings.some(w => /bounding box/.test(w))).toBe(true);
    const behavior = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_senna_BP/entities/senna_car.json')));
    expect(behavior['minecraft:entity'].components['minecraft:rideable'].seats.position[1]).toBeGreaterThan(0);
  });

  it('can be exported without PBR assets for classic rendering', async () => {
    const grid = new BlockGrid(2, 2, 2);
    grid.set(0, 0, 0, 'minecraft:red_concrete');
    const result = await buildPlayableAddon(grid, {
      stem: 'plain', components: [{ id: 'car', label: 'Plain', kind: 'car', grid, provenance: 'test', bricks: bricks.slice(0, 1) }],
      partGeometry: await providerFor(), pbr: false,
    });
    const buffer = ab(result.bytes), entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_plain_RP/textures/entity/craftmatic_swatch_4.png');
    expect(entries.some(e => e.endsWith('_mer.png') || e.endsWith('.texture_set.json'))).toBe(false);
    const rpManifest = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_plain_RP/manifest.json')));
    expect(rpManifest.capabilities).toBeUndefined();
  });

  it('threads figureCollisionHeight into a scene figure NPC\'s collision box, bypassing the default 1.0-1.8 clamp (device-919 roaming experiment)', async () => {
    const grid = new BlockGrid(3, 2, 3);
    grid.set(0, 0, 0, 'minecraft:white_concrete');
    const figureArgs = { stem: 'roam', partGeometry: await providerFor(), figures: [{ bricks: bricks.slice(0, 1), x: 1, y: 1, z: 1, facingLdu: [0, -1] as [number, number] }] };
    const withoutOverride = await buildPlayableAddon(grid, figureArgs);
    const defaultBehavior = JSON.parse(new TextDecoder().decode(await extractFile(ab(withoutOverride.bytes), 'Craftmatic_roam_BP/entities/roam_fig1.json')));
    const defaultHeight = defaultBehavior['minecraft:entity'].components['minecraft:collision_box'].height;
    // Unmodified default stays inside the normal player-height clamp.
    expect(defaultHeight).toBeGreaterThanOrEqual(1.0);
    expect(defaultHeight).toBeLessThanOrEqual(1.8);

    const withOverride = await buildPlayableAddon(grid, { ...figureArgs, figureCollisionHeight: 0.95 });
    const overrideBehavior = JSON.parse(new TextDecoder().decode(await extractFile(ab(withOverride.bytes), 'Craftmatic_roam_BP/entities/roam_fig1.json')));
    // The override lands exactly, below the default floor - the whole point of the experiment.
    expect(overrideBehavior['minecraft:entity'].components['minecraft:collision_box'].height).toBe(0.95);
  });

  it('names a scene figure entity and its spawn egg in texts/en_US.lang (was a raw entity.craftmatic:...fig1.name key)', async () => {
    const grid = new BlockGrid(3, 2, 3);
    grid.set(0, 0, 0, 'minecraft:white_concrete');
    const result = await buildPlayableAddon(grid, { stem: 'roam', partGeometry: await providerFor(), figures: [{ bricks: bricks.slice(0, 1), x: 1, y: 1, z: 1, facingLdu: [0, -1] as [number, number] }] });
    const lang = new TextDecoder().decode(await extractFile(ab(result.bytes), 'Craftmatic_roam_RP/texts/en_US.lang'));
    expect(lang).toContain('entity.craftmatic:roam_fig1.name=roam figure 1');
    expect(lang).toContain('item.spawn_egg.entity.craftmatic:roam_fig1.name=roam figure 1 Spawn Egg');
  });

  it('reduces the collider RP blocks.json entry to its sound only, and names the shell + manual seat entities', async () => {
    // A material_instances texture on the BP block wins for a data-driven
    // block, so the RP blocks.json `textures` key this used to also carry was
    // dead config — trimmed, keeping the sound (2026-09-21 pack audit).
    const C = LDU_PER_BLOCK, I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const grid = new BlockGrid(4, 3, 4);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) grid.set(x, 0, z, 'minecraft:red_concrete');
    const frame: SceneGridFrame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
    const result = await buildPlayableAddon(grid, {
      stem: 'shed', label: 'Shed', partGeometry: await providerFor(),
      shell: { bricks: [{ part: '3001.dat', color: 4, x: 2 * C, y: 0, z: 2 * C, rot: I }], frame },
    });
    const buffer = ab(result.bytes);
    const blocksJson = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_RP/blocks.json')));
    expect(blocksJson['craftmatic:collider']).toEqual({ sound: 'stone' });
    const lang = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_RP/texts/en_US.lang'));
    // The shell is is_spawnable: false — a name, but no spawn egg.
    expect(lang).toContain('entity.craftmatic:shed_shell.name=Shed bricks');
    expect(lang).not.toContain('spawn_egg.entity.craftmatic:shed_shell');
    // The manual-seat helper is is_spawnable: true — name AND spawn egg.
    expect(lang).toContain('entity.craftmatic:shed_manual_seat.name=Shed Seat');
    expect(lang).toContain('item.spawn_egg.entity.craftmatic:shed_manual_seat.name=Shed Seat Spawn Egg');
  });
});

describe('pack identity — two models must never share a manifest uuid', () => {
  /** Every uuid a pack's two manifests declare, in a stable order. */
  const manifestUuids = async (bytes: Uint8Array, id: string): Promise<string[]> => {
    const buffer = ab(bytes);
    const read = async (name: string) => JSON.parse(new TextDecoder().decode(await extractFile(buffer, name)));
    const bp = await read(`Craftmatic_${id}_BP/manifest.json`), rp = await read(`Craftmatic_${id}_RP/manifest.json`);
    return [
      bp.header.uuid, ...bp.modules.map((m: { uuid: string }) => m.uuid),
      rp.header.uuid, ...rp.modules.map((m: { uuid: string }) => m.uuid),
    ];
  };

  // The three sets that shipped IDENTICAL BP/RP header uuids: their names all
  // reduce to the same 12-character stem, `Hogwarts`, so the pack id — and with
  // it every manifest uuid — was the same string for all three. Minecraft keys a
  // pack by its header uuid, so importing the second one landed in a `<name>(1)`
  // folder and a world could only ever activate one of them.
  const HOGWARTS = [
    { stem: 'Hogwarts-71043', label: 'Hogwarts Castle (71043)' },
    { stem: 'Hogwarts-76419', label: 'Hogwarts Castle and Grounds (76419)' },
    { stem: 'Hogwarts-76435', label: 'Hogwarts Castle: The Great Hall (76435)' },
  ];

  it('gives three sets sharing a 12-character name stem distinct header AND module uuids', async () => {
    const all: string[] = [];
    for (const set of HOGWARTS) {
      // The OLD pack id for all three — the collision is reproduced exactly by
      // handing every build the same id and only differing labels.
      const result = await buildPlayableAddon(model(), { stem: 'Hogwarts', label: set.label });
      all.push(...await manifestUuids(result.bytes, 'hogwarts'));
    }
    expect(all).toHaveLength(15);
    expect(new Set(all).size).toBe(15);
  });

  it('gives the same model the same uuids across two builds, so a re-export updates in place', async () => {
    const opts = { stem: 'Hogwarts-71043', label: 'Hogwarts Castle (71043)' };
    const first = await manifestUuids((await buildPlayableAddon(model(), opts)).bytes, 'hogwarts_71043');
    const second = await manifestUuids((await buildPlayableAddon(model(), opts)).bytes, 'hogwarts_71043');
    expect(second).toEqual(first);
  });

  it('names the same pack from the CLI and the LEGO tab, whose labels punctuate differently', () => {
    expect(packIdentity('Hogwarts-71043', 'Hogwarts Castle 71043'))
      .toBe(packIdentity('Hogwarts-71043', 'Hogwarts Castle (71043)'));
  });

  it('separates two custom minifigs whose names share 12 characters', () => {
    // The Minifig popover has no set number to fall back on: both stems are
    // `HarryPotter`, so the label is the only thing that tells them apart.
    expect(packIdentity('HarryPotter', 'Harry Potter Gryffindor'))
      .not.toBe(packIdentity('HarryPotter', 'Harry Potter Slytherin'));
  });

  it('falls back to the stem when no label was given, and never yields an empty identity', () => {
    expect(packIdentity('Colosseum-10276')).toBe('colosseum 10276');
    expect(packIdentity('!!!', '')).toBe('model');
  });
});

describe('pack provenance — the pipeline stamp in the pack NAME, never in its identity', () => {
  const stamped = (over: Partial<PipelineStamp> = {}): PipelineStamp => ({
    kind: 'stamped', hash: '0123456789ab', files: 40, commit: '1b74f4ee', date: '2026-09-21', head: '1b74f4ee', headDate: '2026-09-21',
    dirty: false, dirtyFiles: [], treeDirty: false, shallow: false, computedAt: '2026-09-21T14:30:59.000Z', ...over,
  });
  const source: SourceProvenance = { file: '10303 Loop Coaster.io', hash: 'abcdefabcdef', origin: 'index', path: 'IO/10303 Loop Coaster.io', setNum: '10303-1' };
  const manifests = async (bytes: Uint8Array, id: string) => {
    const buffer = ab(bytes);
    const read = async (name: string) => JSON.parse(new TextDecoder().decode(await extractFile(buffer, name)));
    return { bp: await read(`Craftmatic_${id}_BP/manifest.json`), rp: await read(`Craftmatic_${id}_RP/manifest.json`) };
  };
  const uuidsOf = (m: { bp: any; rp: any }): string[] => [
    m.bp.header.uuid, ...m.bp.modules.map((x: { uuid: string }) => x.uuid), m.rp.header.uuid, ...m.rp.modules.map((x: { uuid: string }) => x.uuid),
  ];

  it('shows the stamp in both pack names and the source in both descriptions', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'Loop-Coaster-10303', label: '10303 Loop Coaster', vehicleMode: 'car', pipelineStamp: stamped(), source });
    const m = await manifests(result.bytes, 'loop_coaster_10303');
    expect(m.bp.header.name).toBe('10303 Loop Coaster — Playable (2026-09-21 1b74f4ee)');
    expect(m.rp.header.name).toBe('10303 Loop Coaster — Playable Resources (2026-09-21 1b74f4ee)');
    const sentence = provenanceSentence(stamped(), source);
    expect(sentence).toBe('Built from 10303 Loop Coaster.io (abcdefabcdef) by pipeline 0123456789ab @ 1b74f4ee.');
    expect(m.bp.header.description).toContain(sentence);
    expect(m.rp.header.description).toContain(sentence);
    // A dirty tree says so in the name, dated by the stamp itself.
    const dirty = await buildPlayableAddon(model(), { stem: 'Loop-Coaster-10303', label: '10303 Loop Coaster', vehicleMode: 'car', pipelineStamp: stamped({ dirty: true, dirtyFiles: ['web/src/engine/playable-addon.ts'] }), source });
    expect((await manifests(dirty.bytes, 'loop_coaster_10303')).bp.header.name).toBe('10303 Loop Coaster — Playable (2026-09-21 1b74f4ee+dirty)');
  });

  it('two different stamps produce different names but the SAME uuids (a pipeline build is an upgrade, not a new pack)', async () => {
    const opts = { stem: 'Loop-Coaster-10303', label: '10303 Loop Coaster', vehicleMode: 'car' as const, source };
    const a = await manifests((await buildPlayableAddon(model(), { ...opts, pipelineStamp: stamped() })).bytes, 'loop_coaster_10303');
    const b = await manifests((await buildPlayableAddon(model(), { ...opts, pipelineStamp: stamped({ commit: 'deadbeef', date: '2026-10-01', hash: 'fedcba987654' }) })).bytes, 'loop_coaster_10303');
    const c = await manifests((await buildPlayableAddon(model(), { ...opts, pipelineStamp: unstampedPipeline() })).bytes, 'loop_coaster_10303');
    expect(a.bp.header.name).not.toBe(b.bp.header.name);
    expect(b.bp.header.name).not.toBe(c.bp.header.name);
    expect(c.bp.header.name).toBe('10303 Loop Coaster — Playable (unstamped)');
    expect(uuidsOf(b)).toEqual(uuidsOf(a));
    expect(uuidsOf(c)).toEqual(uuidsOf(a));
    expect(new Set(uuidsOf(a)).size).toBe(uuidsOf(a).length);
    // The uuids are what the raw stem/label derive — the stamped NAME never enters.
    expect(packIdentity('Loop-Coaster-10303', '10303 Loop Coaster')).toBe('10303 loop coaster | loop coaster 10303');
  });

  it('defaults to the injected stamp (unstamped under vitest) and a null source, and says so honestly', async () => {
    const result = await buildPlayableAddon(model(), { stem: 'Roadster', vehicleMode: 'car' });
    const m = await manifests(result.bytes, 'roadster');
    expect(m.bp.header.name).toBe('Roadster — Playable (unstamped)');
    expect(m.bp.header.description).toContain('Built from an unrecorded source by pipeline unstamped.');
    expect(result.provenance).toMatchObject({ generator: 'craftmatic', display: 'unstamped', source: null, pipeline: { kind: 'unstamped' } });
  });

  it('writes craftmatic-provenance.json, returns the same record, and spreads it into the diagnostics', async () => {
    const route: CoasterRoute = { label: 'Track', points: [[0, 0, 0], [10, 0, 0]], closed: false, maxSegmentLength: 10 };
    const grid = new BlockGrid(12, 2, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const result = await buildPlayableAddon(grid, { stem: 'Loop-Coaster-10303', label: '10303 Loop Coaster', pipelineStamp: stamped(), source, coasterRoutes: [route] });
    const buffer = ab(result.bytes);
    const read = async (name: string) => JSON.parse(new TextDecoder().decode(await extractFile(buffer, name)));
    const provenance = await read('Craftmatic_loop_coaster_10303_BP/craftmatic-provenance.json');
    expect(provenance).toEqual(result.provenance);
    expect(provenance).toMatchObject({ generator: 'craftmatic', display: '2026-09-21 1b74f4ee', pipeline: stamped(), source });
    const manifest = (await manifests(result.bytes, 'loop_coaster_10303')).bp;
    expect(provenance.packVersion.value).toEqual(manifest.header.version);
    expect(provenance.packVersion.encodes).toMatch(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const diagnostics = await read('Craftmatic_loop_coaster_10303_BP/craftmatic-diagnostics.json');
    for (const key of ['generator', 'builtAt', 'packVersion', 'display', 'pipeline', 'source'] as const) expect(diagnostics[key]).toEqual(provenance[key]);
    expect(diagnostics.label).toBe('10303 Loop Coaster');
  });
});

describe('measured coaster train (measureCoasterTrain)', () => {
  /** A vertical drop: the 10303 case, in model blocks at a 53.33-LDU cell. */
  const drop = { points: [[0, 20, 0], [0, 0, 0]] as [number, number, number][], closed: false };
  it('reads three riders exactly a pitch apart on a vertical drop as a three-car train', () => {
    // 10303: torsos at identical x/z, 120 LDU apart = 2.25 blocks; ~0.9 blocks off the running line.
    const riders: [number, number, number][] = [[0.9, 15, 0], [0.9, 12.75, 0], [0.9, 10.5, 0]];
    expect(measureCoasterTrain(drop, riders, 1.5)).toEqual({ count: 3, spacing: 2.25, riders: 3, pitches: [2.25, 2.25] });
  });
  it('is a single cart (undefined) with one rider, none, or riders off the track', () => {
    expect(measureCoasterTrain(drop, [[0.9, 15, 0]], 1.5)).toBeUndefined();
    expect(measureCoasterTrain(drop, [], 1.5)).toBeUndefined();
    // Two figures standing 4 blocks away from the track are not riders.
    expect(measureCoasterTrain(drop, [[4, 15, 0], [4, 12.75, 0]], 1.5)).toBeUndefined();
    // A figure beside the track and one on it: one car is no train.
    expect(measureCoasterTrain(drop, [[4, 15, 0], [0.9, 12.75, 0]], 1.5)).toBeUndefined();
  });
  it('seats riders abreast in ONE car, and reads the pitch between cars', () => {
    const riders: [number, number, number][] = [[0.9, 15, 0.4], [0.9, 15, -0.4], [0.9, 12.75, 0.4], [0.9, 12.75, -0.4]];
    expect(measureCoasterTrain(drop, riders, 1.5)).toEqual({ count: 2, spacing: 2.25, riders: 4, pitches: [2.25] });
    expect(COASTER_SAME_CAR_ARC).toBe(0.5);
  });
  it('takes the longest run of consistent pitches and ignores a rider that breaks the pattern', () => {
    // Four riders 2 apart, then a stray one 5 further on: the train is four cars at 2.
    const riders: [number, number, number][] = [[0.9, 18, 0], [0.9, 16, 0], [0.9, 14, 0], [0.9, 12, 0], [0.9, 7, 0]];
    expect(measureCoasterTrain(drop, riders, 1.5)).toEqual({ count: 4, spacing: 2, riders: 5, pitches: [2, 2, 2] });
    // Two riders 3 apart is a two-car train even though a third sits at an unrelated pitch.
    expect(measureCoasterTrain(drop, [[0.9, 18, 0], [0.9, 15, 0], [0.9, 5, 0]], 1.5)).toEqual({ count: 2, spacing: 3, riders: 3, pitches: [3] });
  });
  it('measures the pitch along the ARC of a bent route, not as a straight-line distance', () => {
    // An L: 10 blocks along +x, then 10 along +y. Riders at arc 8 and arc 12 are 4 apart along the track.
    const bent = { points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]] as [number, number, number][], closed: false };
    const train = measureCoasterTrain(bent, [[8, 0.5, 0], [10.5, 2, 0]], 1);
    expect(train).toMatchObject({ count: 2, spacing: 4, riders: 2 });
  });
  it('never declares more cars than the runtime accepts', () => {
    const riders = Array.from({ length: 12 }, (_, k) => [0.9, 19 - k * 1.5, 0] as [number, number, number]);
    const train = measureCoasterTrain(drop, riders, 1.5)!;
    expect(train.count).toBe(8);
    expect(train.spacing).toBe(1.5);
    expect(train.riders).toBe(12);
  });
});

describe('Bedrock entity identifiers', () => {
  /**
   * A Bedrock entity identifier may not begin with a digit: the engine drops
   * the WHOLE definition, so the entity never exists in game and nothing is
   * logged. Most LEGO set stems ARE numeric, so every id must go through
   * `entityId()`. The door leaf and the minifig creator entity did not, and it
   * took a set with BOTH a numeric stem and a door (31084 Pirate Roller
   * Coaster) to expose it — its `door_leaf_1` entity could never exist. The
   * builder now refuses to emit such a pack; these pin that it cannot come back.
   */
  const identifiers = async (bytes: Uint8Array): Promise<string[]> => {
    const buffer = ab(bytes);
    const names = listZipEntries(buffer).filter(name => /\/entities\/[^/]+\.json$/.test(name));
    return Promise.all(names.map(async name => {
      const entity = JSON.parse(new TextDecoder().decode(await extractFile(buffer, name))) as {
        'minecraft:entity': { description: { identifier: string } };
      };
      return entity['minecraft:entity'].description.identifier;
    }));
  };

  it('never begins an identifier with a digit, whatever the stem', async () => {
    const result = await buildPlayableAddon(model(), { stem: '31084 Pirate Coaster', vehicleMode: 'car' });
    const ids = await identifiers(result.bytes);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.split(':')[1] ?? '').not.toMatch(/^[0-9]/);
  });

  it('prefixes the minifig creator entity for a numeric stem, and leaves a named one alone', async () => {
    const provider = { getPartMesh: async (part: string) => ({ partId: part, resolvedAs: part, description: 'Minifig Torso', triangles: [{ a: [0, 0, 0] as [number, number, number], b: [20, 0, 0] as [number, number, number], c: [0, 24, 0] as [number, number, number], color: 16 }], studs: [], bounds: { min: [0, 0, 0] as [number, number, number], max: [20, 24, 4] as [number, number, number] }, unresolvedRefs: [] }), report: () => ({ unresolved: [], printFallbacks: [], substitutions: [] }) };
    const library = minifigCreatorLibrary('starter');
    library.slots.minifig = { torso: [{ part: '973', label: 'Torso', group: 'Core' }] };

    const numeric = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: '31084', minifigCreator: library, partGeometry: provider });
    expect(await identifiers(numeric.bytes)).toContain('craftmatic:f_31084_minifig');

    // entityId() is the identity on a stem that already starts with a letter,
    // so an existing pack's identifier is untouched by the fix.
    const named = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'Creator', minifigCreator: library, partGeometry: provider });
    expect(await identifiers(named.bytes)).toContain('craftmatic:creator_minifig');
  });
});
