import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  COLLIDER_BLOCK_ID, SHELL_FRAME, buildColliderGrid, colliderBlockDefinition, colliderState, isSceneBlock,
} from '../web/src/engine/bedrock-building-shell.js';
import { toBedrockBlock } from '../web/src/engine/bedrock-blocks.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';

/** A grid frame with the cell origin at LDraw 0 and minifig-scale cells. */
const frame: SceneGridFrame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
const C = LDU_PER_BLOCK;

describe('buildColliderGrid', () => {
  it('collides a baseplate cell only as high as the plate, a wall fully, keeps doors, fills gap cells', () => {
    const grid = new BlockGrid(3, 3, 3);
    grid.set(0, 0, 0, 'minecraft:white_concrete'); // a plate 8 LDU thick at the cell floor
    grid.set(1, 0, 0, 'minecraft:white_concrete'); // a full-height wall
    grid.set(2, 0, 0, 'minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
    grid.set(0, 1, 0, 'minecraft:white_concrete'); // gap fill: no part reaches it
    grid.set(1, 2, 0, 'minecraft:white_concrete'); // a ceiling slab at the TOP of its cell
    // LDraw Y down: the plate spans y −8..0 (top at −8), the wall −C..0, the slab sits at the top of cell y=2: y −3C..−3C+8.
    const boxes = [
      { min: [0, -8, 0] as [number, number, number], max: [C, 0, C] as [number, number, number] },
      { min: [C, -C, 0] as [number, number, number], max: [2 * C, 0, C] as [number, number, number] },
      { min: [C, -3 * C, 0] as [number, number, number], max: [2 * C, -3 * C + 8, C] as [number, number, number] },
    ];
    const { grid: out, stats } = buildColliderGrid(grid, boxes, frame);
    expect(out.get(0, 0, 0)).toBe(colliderState(0, 3));
    expect(out.get(1, 0, 0)).toBe(colliderState(0, 16));
    expect(out.get(2, 0, 0)).toBe('minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
    expect(out.get(0, 1, 0)).toBe(colliderState(0, 16));
    expect(out.get(1, 2, 0)).toBe(colliderState(13, 16));
    expect(out.get(2, 2, 2)).toBe('minecraft:air');
    expect(stats).toEqual({ colliders: 4, partial: 2, kept: 1 });
  });

  it('keeps the blocks the scene made live and light sources', () => {
    expect(isSceneBlock('minecraft:spruce_door[facing=south]')).toBe(true);
    expect(isSceneBlock('minecraft:sea_lantern')).toBe(true);
    expect(isSceneBlock('minecraft:white_concrete')).toBe(false);
    expect(isSceneBlock('minecraft:glass_pane[north=true]')).toBe(false);
  });
});

describe('the collider block', () => {
  it('passes through the Bedrock encoder as a namespaced block with integer states', () => {
    expect(toBedrockBlock(colliderState(3, 16))).toEqual({ name: COLLIDER_BLOCK_ID, states: { 'craftmatic:lo': 3, 'craftmatic:hi': 16 } });
    expect(toBedrockBlock('craftmatic:collider')).toEqual({ name: COLLIDER_BLOCK_ID, states: {} });
  });

  it('defines every lo < hi permutation with a matching collision box and dampens no light', () => {
    const def = colliderBlockDefinition() as { 'minecraft:block': { description: { states: Record<string, { values: { min: number; max: number } }> }; components: Record<string, unknown>; permutations: Array<{ condition: string; components: { 'minecraft:collision_box': { origin: number[]; size: number[] } } }> } };
    const block = def['minecraft:block'];
    expect(block.permutations).toHaveLength(136);
    expect(block.description.states['craftmatic:lo']!.values).toEqual({ min: 0, max: 15 });
    expect(block.description.states['craftmatic:hi']!.values).toEqual({ min: 1, max: 16 });
    const p = block.permutations.find(x => x.condition.includes('== 3 &&') && x.condition.endsWith('== 16'))!;
    expect(p.components['minecraft:collision_box']).toEqual({ origin: [-8, 3, -8], size: [16, 13, 16] });
    expect(block.components['minecraft:light_dampening']).toBe(0);
    expect(block.components['minecraft:selection_box']).toBe(false);
  });
});

// ─── The shell through the compiler and the add-on ───────────────────────────

const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
const LIBRARY: Record<string, string> = {
  '3001': ['0 Brick 2 x 4', ...box6(-40, 40, -24, 0, -20, 20)].join('\n'),
  '3005': ['0 Brick 1 x 1', ...box6(-10, 10, -24, 0, -10, 10)].join('\n'),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('the building shell', () => {
  it('compiles on the grid frame: an LDraw +X, +Z brick lands at +X, +Z of the entity at yaw 0, and every loose piece stays', async () => {
    // Two separate pieces (no clustering may drop the small one): a 2×4 at the origin and a 1×1 far along +X/+Z.
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 4, x: 0, y: 0, z: 0, rot: I },
      { part: '3005.dat', color: 1, x: 300, y: -24, z: 200, rot: I },
    ];
    const geo = await compileLdrawEntityGeometry('shell', 'prop', bricks, { partGeometry: provider(), frame: [...SHELL_FRAME], wholeModel: true, quality: { studFacets: 1 } });
    expect(geo.diagnostics.detached.placements).toBe(0);
    expect(geo.partBoxesLdu).toHaveLength(2);
    const cubes = (geo.value as { 'minecraft:geometry': Array<{ bones: Array<{ cubes: Array<{ origin: number[]; size: number[] }> }> }> })['minecraft:geometry'].flatMap(m => m.bones.flatMap(b => b.cubes));
    const small = cubes.find(c => Math.abs(c.size[0]! - 6) < 0.01)!;
    const big = cubes.find(c => Math.abs(c.size[0]! - 24) < 0.01)!;
    // Render frame = −I·LDraw, so render = (−x, −y, −z). The JSON mirrors X (Bedrock's left-handed
    // model frame): JSON x = −render x = LDraw x, JSON z = render z = −LDraw z. The world at yaw 0
    // sees render (−x, y, −z) (extraPlacement, Pixel-proven) = LDraw (x, −y, z): the grid's frame.
    // So in the JSON the small brick (LDraw +300, +200) is at LARGER x and SMALLER z than the big one.
    expect(small.origin[0]!).toBeGreaterThan(big.origin[0]!);
    expect(small.origin[2]!).toBeLessThan(big.origin[2]!);
    // Higher in LDraw (−24) is higher in the model.
    expect(small.origin[1]!).toBeGreaterThan(big.origin[1]!);
    // Whole-model: no facing warning, no stand rules.
    expect(geo.warnings.some(w => /front\/rear/.test(w))).toBe(false);
    expect(geo.diagnostics.displayDropped.placements).toBe(0);
  });

  it('ships the shell entity, the collider block and collider structure tiles, and keeps the coloured grid for the preview', async () => {
    const grid = new BlockGrid(4, 3, 4);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) grid.set(x, 0, z, 'minecraft:red_concrete');
    grid.set(1, 1, 1, 'minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
    grid.set(1, 2, 1, 'minecraft:oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]');
    const bricks: ParsedBrick[] = [{ part: '3001.dat', color: 4, x: 2 * C, y: 0, z: 2 * C, rot: I }];
    const pack = await buildPlayableAddon(grid, { stem: 'shed', label: 'Shed', partGeometry: provider(), shell: { bricks, frame }, pbr: false });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_shed_BP/blocks/collider.json');
    expect(entries).toContain('Craftmatic_shed_RP/blocks.json');
    expect(entries).toContain('Craftmatic_shed_RP/textures/blocks/craftmatic_collider.png');
    expect(entries).toContain('Craftmatic_shed_BP/entities/shed_shell.json');
    expect(entries).toContain('Craftmatic_shed_RP/models/entity/shed_shell.geo.json');
    expect(pack.components.some(c => c.kind === 'shell')).toBe(true);
    expect(pack.warnings.some(w => /brick-accurate building/.test(w))).toBe(true);
    // The terrain atlas carries the clear tile.
    const terrain = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_RP/textures/terrain_texture.json'))) as { texture_data: Record<string, unknown> };
    expect(terrain.texture_data['craftmatic_collider']).toEqual({ textures: 'textures/blocks/craftmatic_collider' });
    // The structure tile's palette is colliders plus the door, no concrete.
    const tile = entries.find(e => /structures\/craftmatic\/.*\.mcstructure$/.test(e))!;
    const raw = new TextDecoder('latin1').decode(await extractFile(buffer, tile));
    expect(raw).toContain('craftmatic:collider');
    expect(raw).toContain('minecraft:wooden_door');
    expect(raw).not.toContain('red_concrete');
    // The shell behaviour: static, unhurt, not selectable.
    const behavior = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_BP/entities/shed_shell.json'))) as { 'minecraft:entity': { components: Record<string, unknown> } };
    expect(behavior['minecraft:entity'].components['minecraft:physics']).toEqual({ has_gravity: false, has_collision: false });
    // The placement script spawns it as an actor at yaw 0, its origin lifted one block over the roof
    // (a 24 LDU brick is 0.45 blocks tall → lift 2) so the block that lights it is open sky;
    // the geometry is authored that far below the origin.
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_BP/scripts/placement.js'));
    const shellActor = /\{"typeId":"craftmatic:shed_shell"[^}]*\}/.exec(placement)![0];
    expect(shellActor).toContain('"yaw":0');
    expect(JSON.parse(shellActor).y).toBeCloseTo(2, 5);
    const geo = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_RP/models/entity/shed_shell.geo.json'))) as { 'minecraft:geometry': Array<{ description: { visible_bounds_offset: number[] }; bones: Array<{ cubes: Array<{ origin: number[]; size: number[] }> }> }> };
    const tops = geo['minecraft:geometry'].flatMap(m => m.bones.flatMap(b => b.cubes.map(c => c.origin[1]! + c.size[1]!)));
    expect(Math.max(...tops)).toBeLessThan(0);
    expect(Math.min(...geo['minecraft:geometry'].flatMap(m => m.bones.flatMap(b => b.cubes.map(c => c.origin[1]!))))).toBeCloseTo(-32, 5);
    expect(geo['minecraft:geometry'][0]!.description.visible_bounds_offset[1]).toBeLessThan(0);
  });
});
