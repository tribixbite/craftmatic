import { describe, expect, it, vi } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';

const ab = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const model = () => { const g=new BlockGrid(6,3,4);g.fill(0,0,0,5,0,3,'minecraft:black_concrete');g.fill(1,1,1,4,1,2,'minecraft:red_concrete');return g; };

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
    const result=await buildPlayableAddon(new BlockGrid(1,1,1),{stem:'Batmobile',components:[{id:'batmobile',label:'Batmobile',kind:'car',grid:model(),x:12,y:2,z:7,provenance:'test source'}]});
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
    expect(components['minecraft:rideable'].seats.position[1]).toBeGreaterThan(model().height);
    const fn=new TextDecoder().decode(await extractFile(buffer,'Craftmatic_batmobile_BP/functions/craftmatic/batmobile.mcfunction'));
    expect(fn).toContain('give @s craftmatic:batmobile_brick_wand');
    expect(fn).not.toContain('summon ');
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_batmobile_BP/scripts/placement.js'));
    expect(placement).toContain('"typeId":"craftmatic:batmobile_batmobile","label":"Batmobile","x":12,"y":2,"z":7');
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
