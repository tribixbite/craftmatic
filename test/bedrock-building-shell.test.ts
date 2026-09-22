import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  ACTOR_CULL_FLOOR_BLOCKS, COLLIDER_BLOCK_ID, SHELL_BOX_WIDTH, SHELL_FRAME, actorCullDistance, buildColliderGrid, colliderBlockDefinition, colliderState, isSceneBlock, shellBehavior, shellCollisionBox,
} from '../web/src/engine/bedrock-building-shell.js';
import { SIZE_STEPS } from '../web/src/engine/bedrock-placement-pack.js';
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
    // Grid z 0 is LDraw z −C..0: the grid is a half turn about X, so grid +Z is LDraw −Z.
    const boxes = [
      { min: [0, -8, -C] as [number, number, number], max: [C, 0, 0] as [number, number, number] },
      { min: [C, -C, -C] as [number, number, number], max: [2 * C, 0, 0] as [number, number, number] },
      { min: [C, -3 * C, -C] as [number, number, number], max: [2 * C, -3 * C + 8, 0] as [number, number, number] },
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

/**
 * The shell's collision box only sets how far Bedrock draws the actor
 * (`64 × max(1, |box diagonal|)`, measured on the Pixel 8 Pro 2026-09-21: the
 * 0.1 × 0.1 box culled 10303 at ~64 blocks). The box must be a thin needle
 * sized from the model's own extent, scale with the wand's size groups, and
 * stand entirely above the model so it intercepts nothing.
 */
describe('the shell collision box and its cull distance', () => {
  const box = (largest: number) => shellCollisionBox({ width: largest, height: largest / 2, length: largest / 3 });
  const cull = (largest: number, f = 1) => Math.round(actorCullDistance(box(largest), f));

  it('is a needle whose cull distance is four times the largest dimension, never under the 64-block floor', () => {
    // A small vehicle-sized model (5 blocks) keeps the floor; 10303 (44 blocks tall) is drawn to 176;
    // a 100-block castle to 400. The old 0.1 × 0.1 box gave 64 for every model.
    expect(box(5).width).toBe(SHELL_BOX_WIDTH);
    expect(cull(5)).toBe(ACTOR_CULL_FLOOR_BLOCKS);
    expect(cull(44)).toBe(176);
    expect(cull(100)).toBe(400);
    expect(box(44).height).toBeCloseTo(2.75, 1);
    expect(actorCullDistance({ width: 0.1, height: 0.1 })).toBe(64);
    // The measured figures (0.6 × 1.8): drawn at 100, gone by 168 on the device.
    const figures = actorCullDistance({ width: 0.6, height: 1.8 });
    expect(figures).toBeGreaterThan(100);
    expect(figures).toBeLessThan(168);
  });

  it('scales with the wand size, so a 400 % placement is drawn four times as far and a 25 % one keeps the floor', () => {
    expect(cull(44, 4)).toBe(704);
    expect(cull(44, 0.25)).toBe(ACTOR_CULL_FLOOR_BLOCKS);
    const behavior = shellBehavior('shell', { width: 30, height: 44, length: 20 }) as { 'minecraft:entity': { components: Record<string, any>; component_groups: Record<string, any> } };
    const e = behavior['minecraft:entity'];
    expect(e.components['minecraft:collision_box']).toEqual(box(44));
    for (const pct of SIZE_STEPS.filter(p => p !== 100)) {
      const g = e.component_groups[`craftmatic:size_${pct}`]['minecraft:collision_box'];
      expect(g.width).toBeCloseTo(SHELL_BOX_WIDTH * pct / 100, 3);
      expect(g.height).toBeCloseTo(box(44).height * pct / 100, 2);
    }
    // Without an extent (the pipeline not yet passing sgeo.sizeBlocks) the fallback still lifts the cull off the floor.
    expect(actorCullDistance((shellBehavior('shell') as any)['minecraft:entity'].components['minecraft:collision_box'])).toBeCloseTo(176, 0);
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
  'door': ['0 Door 1 x 2 x 2', ...box6(-10, 10, -48, 0, -3, 3)].join('\n'),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('the building shell', () => {
  it('compiles on the grid frame: an LDraw +X, +Z brick lands at +X and, in the world at yaw 0, −Z (grid +Z is LDraw −Z), and every loose piece stays', async () => {
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
    // SHELL_FRAME is the −Z-nose rotation diag(−1, −1, 1), so render = (−x, −y, z). The JSON mirrors X
    // (Bedrock's left-handed model frame): JSON x = −render x = LDraw x, JSON z = render z = LDraw z.
    // The world at yaw 0 sees render (−x, y, −z) (extraPlacement, Pixel-proven) = LDraw (x, −y, −z):
    // the grid's frame, a proper rotation (det +1). So in the JSON the small brick (LDraw +300, +200)
    // is at LARGER x and LARGER z than the big one; the old −I frame put it at smaller z, which was
    // the mirror the grid used to carry.
    expect(small.origin[0]!).toBeGreaterThan(big.origin[0]!);
    expect(small.origin[2]!).toBeGreaterThan(big.origin[2]!);
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
    // The manual-chair tool exists even with no inferred mould seats.
    expect(entries).toContain('Craftmatic_shed_RP/entity/shed_manual_seat.entity.json');
    expect(entries).toContain('Craftmatic_shed_RP/models/entity/craftmatic_seat.geo.json');
    expect(entries).toContain('Craftmatic_shed_RP/textures/entity/craftmatic_seat.png');
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
    const behavior = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_BP/entities/shed_shell.json'))) as { 'minecraft:entity': { components: Record<string, any> } };
    expect(behavior['minecraft:entity'].components['minecraft:physics']).toEqual({ has_gravity: false, has_collision: false });
    // The collision box (a needle extending UP from the origin) stands above every drawn cube: the geometry
    // is authored entirely below the origin (its tops are negative, asserted below), so the box can touch
    // nothing a player stands on and its only effect is the cull distance.
    const shellBox = behavior['minecraft:entity'].components['minecraft:collision_box'] as { width: number; height: number };
    expect(shellBox.width).toBe(SHELL_BOX_WIDTH);
    expect(actorCullDistance(shellBox)).toBeGreaterThanOrEqual(ACTOR_CULL_FLOOR_BLOCKS);
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

  it('archives an undersized leaf as separate exact geometry at its source-frame origin', async () => {
    const grid = new BlockGrid(5, 4, 5);
    grid.set(2, 0, 2, 'minecraft:red_concrete');
    // Grid +Z is LDraw −Z (the frame is a half turn about X), so cell z 2 is LDraw z −2C.
    const shellBrick: ParsedBrick = { part: '3001.dat', color: 4, x: 2 * C, y: 0, z: -2 * C, rot: I };
    // This non-zero archive placement freezes the source-origin mapping: the
    // leaf floor is one cell up at x=2,z=3 before its open-sky light lift.
    const leaf: ParsedBrick = { part: 'door.dat', color: 6, x: 2 * C, y: -C, z: -3 * C, rot: I };
    const pack = await buildPlayableAddon(grid, {
      stem: 'micro-door', label: 'Micro door', partGeometry: provider(), pbr: false,
      shell: { bricks: [shellBrick], frame },
      leafActors: [{ bricks: [leaf], frame, maxSizeExclusive: 300, doorCandidateIndex: 0, hideAt100: false }],
    });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_micro_door_BP/entities/micro_door_door_leaf_1.json');
    expect(entries).toContain('Craftmatic_micro_door_RP/models/entity/micro_door_door_leaf_1.geo.json');
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_micro_door_BP/scripts/placement.js'));
    const actor = JSON.parse(/\{"typeId":"craftmatic:micro_door_door_leaf_1"[^}]*\}/.exec(placement)![0]);
    expect(actor).toMatchObject({ x: 2, y: 3, yaw: 0, maxSizeExclusive: 300, doorCandidateIndex: 0, hideAt100: false });
    expect(actor.z).toBeCloseTo(3, 8);
    expect(pack.components.find(c => c.id === 'micro_door_door_leaf_1')?.provenance).toContain('exact source door placement');
  });
});
