import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.js';
import { minifigFromSpec } from '../web/src/engine/minifig-rig.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { BlockGrid } from '../src/schem/types.js';
import { extractFile } from '../web/src/engine/zip-utils.js';

const ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';

describe.skipIf(!existsSync(ROOT))('creator library real geometry', () => {
  it('uses one canonical figure floor and preserves inherited base versus fixed 973pbs print meshes', async () => {
    setLDrawRoot(ROOT);
    const provider = createPartGeometryProvider();
    const figure = minifigFromSpec({ torso: { part: '973pbs', color: 4 }, head: { part: '3626c', color: 14 }, legs: { right: '3816', left: '3817', color: 1 }, arms: { right: '3818', left: '3819', color: 4 } });
    const torso = figure.bricks.filter((_, i) => figure.slots[i] === 'torso');
    const legs = figure.bricks.filter((_, i) => figure.slots[i]?.startsWith('leg_'));
    expect(torso[0]).toMatchObject({ part: '973pbs', y: 0 });
    expect(legs.map(part => part.part)).toEqual(['3816', '3817']);
    expect(legs.map(part => part.y)).toEqual([44, 44]);
    const common = { scale: 16 / 53.3333333333, partGeometry: provider, wholeModel: true, originLdu: [0, 72, 0] as [number, number, number], inheritMaterialId: true };
    const printed = await compileLdrawEntityGeometry('printed_torso', 'figure', torso, common);
    const head = await compileLdrawEntityGeometry('head', 'figure', figure.bricks.filter((_, i) => figure.slots[i] === 'head'), common);
    expect(printed.originLdu).toEqual(head.originLdu);
    expect(printed.meshes.some(mesh => mesh.material.colorId === 16)).toBe(true);
    expect(printed.meshes.some(mesh => mesh.material.colorId !== 16)).toBe(true);
  }, 30_000);

  it('pairs the canonical right and left limb moulds', () => {
    const figure = minifigFromSpec({ torso: { part: '973', color: 4 }, legs: { right: '3816', left: '3817', color: 1 }, arms: { right: '3818', left: '3819', color: 4 } });
    expect(figure.bricks.filter((_, i) => figure.slots[i]?.startsWith('leg_')).map(part => part.part)).toEqual(['3816', '3817']);
    expect(figure.bricks.filter((_, i) => figure.slots[i]?.startsWith('arm_')).map(part => part.part)).toEqual(['3818', '3819']);
  });

  it('emits the actual creator archive with paired limbs and property-gated print layers', async () => {
    setLDrawRoot(ROOT);
    const inner = createPartGeometryProvider(), requested: string[] = [];
    const provider = { getPartMesh: async (part: string) => { requested.push(part); return inner.getPartMesh(part); }, report: () => inner.report() };
    const pack = await buildPlayableAddon(new BlockGrid(1, 1, 1), { stem: 'realcreator', partGeometry: provider, minifigCreator: { tier: 'custom', colours: [4, 1], slots: { minifig: { torso: [{ part: '973pbs', label: 'Printed torso', group: 'Printed' }], legs: [{ part: '3816', label: 'Classic leg pair', group: 'Core' }], arms: [{ part: '3818', label: 'Classic arm pair', group: 'Core' }] }, minidoll: {} } } });
    const zip = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const controller = JSON.parse(new TextDecoder().decode(await extractFile(zip, 'Craftmatic_realcreator_RP/render_controllers/realcreator_minifig.render_controllers.json')));
    const runtime = new TextDecoder().decode(await extractFile(zip, 'Craftmatic_realcreator_BP/scripts/minifig-wand.js'));
    expect(runtime).toContain('Classic leg pair');
    expect(requested).toEqual(expect.arrayContaining(['3816', '3817', '3818', '3819']));
    // Inspect emitted coordinates, not only config strings: individually
    // recentering each slot puts torsos on the floor and collapses the figure.
    const slotBounds = async (slot: string) => {
      const data = JSON.parse(new TextDecoder().decode(await extractFile(zip, `Craftmatic_realcreator_RP/models/entity/realcreator_mf_${slot}_0.geo.json`)));
      const cubes = data['minecraft:geometry'].flatMap((mesh: { bones: Array<{ cubes?: Array<{ origin: number[]; size: number[] }> }> }) => mesh.bones.flatMap(bone => bone.cubes ?? [])) as Array<{ origin: number[]; size: number[] }>;
      expect(cubes.length).toBeGreaterThan(0);
      return {
        minY: Math.min(...cubes.map(cube => cube.origin[1]!)),
        maxY: Math.max(...cubes.map(cube => cube.origin[1]! + cube.size[1]!)),
        minX: Math.min(...cubes.map(cube => cube.origin[0]!)),
        maxX: Math.max(...cubes.map(cube => cube.origin[0]! + cube.size[0]!)),
      };
    };
    const legs = await slotBounds('legs'), torso = await slotBounds('torso'), arms = await slotBounds('arms');
    expect(legs.minY).toBeCloseTo(0, 1);
    expect(torso.minY).toBeGreaterThan(legs.maxY);
    expect(arms.minY).toBeGreaterThan(legs.minY);
    expect(legs.minX).toBeLessThan(0);
    expect(legs.maxX).toBeGreaterThan(0);
    expect(arms.minX).toBeLessThan(legs.minX);
    expect(arms.maxX).toBeGreaterThan(legs.maxX);
    const values = Object.values(controller.render_controllers) as Array<Record<string, unknown>>;
    const base = values.find(value => JSON.stringify(value).includes("craftmatic:c_torso"))!;
    const prints = values.filter(value => JSON.stringify(value).includes("craftmatic:torso') == 0"));
    expect(JSON.stringify(base)).toContain('Array.swatch');
    expect(prints.length).toBeGreaterThan(0);
    for (const print of prints) expect(JSON.stringify(print)).not.toContain('craftmatic:c_torso');
  }, 30_000);
});
