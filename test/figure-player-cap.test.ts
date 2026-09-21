/**
 * A MINIFIG IS NEVER A GIANT.
 *
 * The rule (2026-09-21, verbatim): "when scaling a model it should never result
 * in the minifigs becoming giants - the minifigs should be capped to always be
 * the same size as a player." Two scalings can grow a figure and both are
 * capped here:
 *
 *  - the EXPORT's model scale (`modelScale`, engine/addon-scale.ts): a figure's
 *    geometry is compiled at `figureModelScale(modelScale)` = min(1, scale);
 *  - the WAND's in-game size steps (`withSizeGroups`): a `playerSized` entity's
 *    groups above 100 % keep the 100 % scale, collision box and rider offset.
 *
 * The number capped to is the shared scale's own: a standing minifig is
 * `LDU_PER_MINIFIG` = 96 LDU = `PLAYER_HEIGHT_BLOCKS` = 1.8 blocks at 1× (about
 * 2.03 with hair on the device), so "player size" and "a minifig at 100 %" are
 * the same size by construction, and the cap is 1×.
 *
 * Knock-ons covered at the end: a figure spawned by the runtime stands ON the
 * scaled floor (not sunk into the plate or the block under the pin), and a
 * seated figure keeps the same 0.3-block offset under the scaled seat pan.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon, figureModelScale } from '../web/src/engine/playable-addon.js';
import { SIZE_STEPS, encodeColliderRuns, figureSizeFactor, withSizeGroups } from '../web/src/engine/bedrock-placement-pack.js';
import { LDU_PER_BLOCK, LDU_PER_MINIFIG, PLAYER_HEIGHT_BLOCKS } from '../web/src/engine/lego-scale.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { minifigFromSpec } from '../web/src/engine/minifig-rig.js';
import { extractFile } from '../web/src/engine/zip-utils.js';
import { host } from './_placement-host.js';

// The minifig moulds as boxes at their real bounds (enough for the rig to compile) - as test/seated-figures.test.ts.
const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
const part = (description: string, b: [number, number, number, number, number, number]): string => [`0 ${description}`, ...box6(...b)].join('\n');
const LIBRARY: Record<string, string> = {
  '973': part('Minifig Torso', [-19, 19, -12, 32, -10, 10]),
  '3626c': part('Minifig Head with Closed Hollow Stud', [-13, 13, 0, 24, -13, 13]),
  '3815': part('Minifig Hips', [-18, 18, -11, 21, -10, 10]),
  '3816': part('Minifig Leg Right', [-19.5, -1.5, -9, 28, -11, 9]),
  '3817': part('Minifig Leg Left', [1.5, 19.5, -9, 28, -11, 9]),
  '3818': part('Minifig Arm Right', [-10, 7, -6.5, 22.44, -13.44, 6.51]),
  '3819': part('Minifig Arm Left', [-7, 10, -6.5, 22.44, -13.44, 6.51]),
  '3820': part('Minifig Hand', [-6, 6, -7.65, 4.61, -15.52, 13]),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });

const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const jsonOf = async (buffer: ArrayBuffer, name: string): Promise<any> => JSON.parse(new TextDecoder().decode(await extractFile(buffer, name)));
/** Height of a compiled geometry in blocks: the cube extent over every bone (16 units = 1 block). */
function geometryHeightBlocks(geo: any): number {
  let min = Infinity, max = -Infinity;
  for (const mesh of geo['minecraft:geometry'] ?? []) for (const bone of mesh.bones ?? []) for (const cube of bone.cubes ?? []) {
    min = Math.min(min, cube.origin[1]); max = Math.max(max, cube.origin[1] + cube.size[1]);
  }
  return (max - min) / 16;
}

describe('the cap itself', () => {
  it('a minifig at 1× IS player height by the shared scale, so the cap is 1×', () => {
    expect(LDU_PER_MINIFIG / LDU_PER_BLOCK).toBeCloseTo(PLAYER_HEIGHT_BLOCKS, 9);
    expect(figureModelScale(1)).toBe(1);
    expect(figureModelScale(2)).toBe(1);
    expect(figureModelScale(4)).toBe(1);
    expect(figureModelScale(0.5)).toBe(0.5);
    expect(figureModelScale(NaN)).toBe(1);
    for (const pct of SIZE_STEPS) expect(figureSizeFactor(pct / 100)).toBe(Math.min(1, pct / 100));
  });

  it('withSizeGroups({ playerSized }) keeps the 100 % scale, collision box and rider offset above 100 %, and still ships every group', () => {
    const base = { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 'craftmatic:fig' }, components: { 'minecraft:collision_box': { width: 0.6, height: 1.8 } } } };
    const rideable = { seat_count: 1, seats: { position: [0, -0.3, 0], lock_rider_rotation: 181 } };
    const out = withSizeGroups(base, { width: 0.6, height: 1.8 }, rideable, { playerSized: true }) as any;
    const groups = out['minecraft:entity'].component_groups, events = out['minecraft:entity'].events;
    for (const pct of SIZE_STEPS.filter(p => p !== 100)) {
      const g = groups[`craftmatic:size_${pct}`];
      expect(g, `group for ${pct} %`).toBeDefined();
      expect(events[`craftmatic:size_${pct}`]).toBeDefined();
      const f = Math.min(1, pct / 100);
      expect(g['minecraft:scale'].value).toBe(f);
      expect(g['minecraft:collision_box']).toEqual({ width: Math.round(0.6 * f * 1000) / 1000, height: Math.round(1.8 * f * 1000) / 1000 });
      expect(g['minecraft:rideable'].seats.position).toEqual([0, Math.round(-0.3 * f * 1000) / 1000, 0]);
    }
    expect(groups['craftmatic:size_400']['minecraft:scale'].value).toBe(1);
    expect(groups['craftmatic:size_50']['minecraft:scale'].value).toBe(0.5);
    // The default (a vehicle, a shell) is unchanged: it scales all the way.
    const vehicle = withSizeGroups(base, { width: 0.6, height: 1.8 }, rideable) as any;
    expect(vehicle['minecraft:entity'].component_groups['craftmatic:size_400']['minecraft:scale'].value).toBe(4);
    expect(vehicle['minecraft:entity'].component_groups['craftmatic:size_400']['minecraft:rideable'].seats.position).toEqual([0, -1.2, 0]);
  });
});

describe('a figure in a 2× export is compiled at 1× (player height), while the model scales', () => {
  const build = async (modelScale: number) => {
    const grid = new BlockGrid(6, 4, 6);
    for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) grid.set(x, 0, z, 'minecraft:white_concrete');
    const fig = minifigFromSpec({ torso: { part: '973', color: 4 } });
    const pack = await buildPlayableAddon(grid, {
      stem: 'giant', label: 'Giant', partGeometry: provider(), pbr: false, modelScale,
      figures: [
        { bricks: fig.bricks, x: 1, y: 1, z: 1, facingLdu: [0, -1] },
        { bricks: fig.bricks, x: 3, y: 1, z: 3, facingLdu: [1, 0], seatIndex: 0 },
      ],
      seats: [{ x: 3, y: 1.5, z: 3, yaw: -90, label: 'Seat (4079)' }],
    });
    const buffer = ab(pack.bytes);
    return {
      pack, buffer,
      figureGeo: await jsonOf(buffer, 'Craftmatic_giant_RP/models/entity/giant_fig1.geo.json'),
      figureBehavior: await jsonOf(buffer, 'Craftmatic_giant_BP/entities/giant_fig1.json'),
      seatBehavior: await jsonOf(buffer, 'Craftmatic_giant_BP/entities/giant_seat.json'),
      config: JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_giant_BP/scripts/placement.js')))![1]!),
    };
  };

  it('the figure geometry is the same height at modelScale 2 as at 1, and that height is player height', async () => {
    const one = await build(1), two = await build(2);
    const h1 = geometryHeightBlocks(one.figureGeo), h2 = geometryHeightBlocks(two.figureGeo);
    // The rig's minifig: 96 LDU body = 1.8 blocks, no hair in this fixture.
    expect(h1).toBeGreaterThanOrEqual(PLAYER_HEIGHT_BLOCKS - 1e-6);
    expect(h1).toBeLessThan(2.05);
    expect(h2).toBeCloseTo(h1, 6);
    // Without the cap it would have been twice that: a 3.6-block giant.
    expect(h2).toBeLessThan(2 * PLAYER_HEIGHT_BLOCKS - 1);
    expect(two.pack.warnings.some(w => /figures stay at 1×/.test(w))).toBe(true);
  });

  it('the figure entity is player-sized in every wand size group above 100 %, and its collision box never exceeds the player', async () => {
    const { figureBehavior } = await build(2);
    const e = figureBehavior['minecraft:entity'];
    const base = e.components['minecraft:collision_box'];
    expect(base.width).toBeLessThanOrEqual(0.6);
    expect(base.height).toBeLessThanOrEqual(PLAYER_HEIGHT_BLOCKS);
    for (const pct of [150, 200, 300, 400]) {
      const g = e.component_groups[`craftmatic:size_${pct}`];
      expect(g['minecraft:scale'].value, `${pct} %`).toBe(1);
      expect(g['minecraft:collision_box'], `${pct} %`).toEqual(base);
    }
    expect(e.component_groups['craftmatic:size_50']['minecraft:scale'].value).toBe(0.5);
  });

  it('the seat keeps a player-sized rider 0.3 blocks under the pan at 400 %, and the seated figure still rides it', async () => {
    const { seatBehavior, config } = await build(2);
    const groups = seatBehavior['minecraft:entity'].component_groups;
    expect(groups['craftmatic:size_400']['minecraft:rideable'].seats.position).toEqual([0, -0.3, 0]);
    expect(groups['craftmatic:size_200']['minecraft:rideable'].seats.position).toEqual([0, -0.3, 0]);
    expect(groups['craftmatic:size_50']['minecraft:rideable'].seats.position).toEqual([0, -0.15, 0]);
    // The seat ACTOR is a point inside the model and scales with it (worldPoint), the figure rides it.
    const actors = config.actors as Array<{ typeId: string; x: number; y: number; z: number; rideOf?: number }>;
    const seat = actors.findIndex(a => a.typeId === 'craftmatic:giant_seat');
    expect(actors[seat]).toMatchObject({ x: 3, y: 1.5, z: 3 });
    expect(actors.find(a => a.typeId === 'craftmatic:giant_fig2')!.rideOf).toBe(seat);
  });
});

describe('a figure spawned by the runtime stands ON the scaled floor', () => {
  const PIN_AT_FEET = 1, PLACE = 5, SIZE = 10;
  const collider = (lo: number, hi: number) => ({ typeId: 'craftmatic:collider', permutation: { getState: (k: string) => (k === 'craftmatic:hi' ? hi : lo) }, setPermutation() {} });
  const grass = () => ({ typeId: 'minecraft:grass_block', permutation: { getState: () => undefined }, setPermutation() {} });
  const spec = (figureY: number) => {
    // A 2×2×2 grid whose only colliders are a floor plate (0..3/16) at y = 0.
    const g = new BlockGrid(2, 2, 2);
    for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) g.set(x, 0, z, 'craftmatic:collider[lo=0,hi=3]');
    const runs = encodeColliderRuns(g, 'craftmatic:collider');
    return { stem: 'floor', label: 'Floor', width: 2, height: 2, length: 2,
      tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 2, height: 2, length: 2, nonAir: 4 }],
      actors: [{ typeId: 'craftmatic:floor_fig1', label: 'Figure', x: 0.5, y: figureY, z: 0.5 }],
      colliders: { width: 2, height: 2, length: 2, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: runs.runs, keptCells: 0 },
      settleTicks: 1, finalHoldTicks: 1 };
  };
  const place = async (figureY: number, pct: number, prepare: (h: ReturnType<typeof host>) => void) => {
    const h = host(spec(figureY));
    prepare(h);
    await h.open({ selection: PIN_AT_FEET }, { canceled: true });
    const steps = (SIZE_STEPS.indexOf(pct) - SIZE_STEPS.indexOf(100) + SIZE_STEPS.length) % SIZE_STEPS.length;
    for (let i = 0; i < steps; i++) await h.open({ selection: SIZE }, { canceled: true });
    await h.open({ selection: PLACE }, { selection: 0 });
    await h.flush(2000);
    expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placed Floor.'));
    return h.spawned.find(s => s.typeId === 'craftmatic:floor_fig1')!.at.y as number;
  };

  it('at 400 % a figure whose source floor point is a plate below the pin plane (the chalet: y = -0.15) lands on top of the re-laid plate, not inside the grass under the pin', async () => {
    // The runtime re-lays the plate as 0..12/16 at row 64; the world block under the pin is grass.
    const y = await place(-0.15, 400, h => { h.blocks.set('100,63,200', grass()); });
    expect(y).toBe(64 + 12 / 16);
  });

  it('at 100 % the same figure is lifted out of the grass onto the plate the structure tiles carry', async () => {
    // At 100 % the tiles place the blocks (no re-lay in the host), so the plate is put in the world by hand.
    const y = await place(-0.15, 100, h => { h.blocks.set('100,63,200', grass()); h.blocks.set('100,64,200', collider(0, 3)); });
    expect(y).toBe(64 + 3 / 16);
  });

  it('a figure already standing on the plate top is not moved, at 100 % or 200 %', async () => {
    expect(await place(3 / 16, 100, h => { h.blocks.set('100,64,200', collider(0, 3)); })).toBe(64 + 3 / 16);
    // At 200 % the plate top is at 6/16 and the figure's source point scales to the same place.
    expect(await place(3 / 16, 200, () => {})).toBe(64 + 6 / 16);
  });
});
