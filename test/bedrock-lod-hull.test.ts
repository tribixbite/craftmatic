/**
 * The opt-in LOD hull (`engine/bedrock-lod-hull.ts`): a per-colour surface-voxel
 * shell of an entity's FINAL emitted cube list, switched in by camera distance.
 */
import { describe, expect, it } from 'vitest';
import { ACTOR_DRAW_CEILING_BLOCKS, buildLodHull, entityRenderCullBlocks, LOD_CULL_MARGIN_BLOCKS, LOD_EMPTY_GEOMETRY, LOD_EMPTY_GEOMETRY_ID, MIN_LOD_NEAREST_CUBE_BLOCKS, planLodSwitch, RENDER_CULL_BLOCKS_PER_UNIT, UNITS_PER_BLOCK } from '../web/src/engine/bedrock-lod-hull.js';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.js';
import { bedrockInGameText, buildPlayableAddon, DEFAULT_LOD_DISTANCE, DEVICE_CUBOID_BUDGET, type PlayableAddonOptions } from '../web/src/engine/playable-addon.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { BlockGrid } from '../src/schem/types.js';
import type { SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { CompiledMesh } from '../web/src/engine/ldraw-entity-compiler.js';

interface GeoCube { origin: number[]; size: number[]; uv?: number[] }
interface Geo { 'minecraft:geometry': Array<{ description: { identifier: string }; bones: Array<{ name: string; pivot: number[]; cubes?: GeoCube[] }> }> }

/** One geometry per colour, in the given (draw) order, as box UV forces the compiler to emit. */
const geometryOf = (byColour: Map<number, GeoCube[]>): { value: Geo; meshes: CompiledMesh[] } => {
  const meshes: CompiledMesh[] = [];
  const geometry: Geo['minecraft:geometry'] = [];
  for (const [colorId, cubes] of byColour) {
    const id = `geometry.craftmatic.t_mesh_${meshes.length}`;
    const material = resolveLdrawEntityMaterial(colorId);
    meshes.push({ id, material, translucent: material.alpha < 1 });
    geometry.push({ description: { identifier: id }, bones: [{ name: 'body', pivot: [0, 0, 0], cubes }] });
  }
  return { value: { 'minecraft:geometry': geometry }, meshes };
};

/**
 * A 3x3x3 solid block of one-block cubes, split between colours by a predicate
 * on the cell.
 */
const block = (colourAt: (x: number, y: number, z: number) => number): { value: Geo; meshes: CompiledMesh[] } => {
  const byColour = new Map<number, GeoCube[]>();
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
    const id = colourAt(x, y, z);
    const list = byColour.get(id) ?? [];
    list.push({ origin: [x * UNITS_PER_BLOCK, y * UNITS_PER_BLOCK, z * UNITS_PER_BLOCK], size: [UNITS_PER_BLOCK, UNITS_PER_BLOCK, UNITS_PER_BLOCK], uv: [0, 0] });
    byColour.set(id, list);
  }
  return geometryOf(byColour);
};

const cubesOf = (hull: { value: unknown }): GeoCube[] =>
  (hull.value as Geo)['minecraft:geometry'].flatMap(g => g.bones.flatMap(b => b.cubes ?? []));

/**
 * How many hull GEOMETRIES cover each block cell. Two coplanar cubes from two
 * colour geometries on one cell are exactly the z-fighting the user reported,
 * so every value must be 1.
 */
const claimsPerCell = (doc: unknown): Map<string, number> => {
  const claims = new Map<string, number>();
  for (const g of (doc as Geo)['minecraft:geometry']) {
    const cells = new Set<string>();
    for (const c of g.bones.flatMap(b => b.cubes ?? [])) {
      for (let x = c.origin[0]!; x < c.origin[0]! + c.size[0]!; x += UNITS_PER_BLOCK)
        for (let y = c.origin[1]!; y < c.origin[1]! + c.size[1]!; y += UNITS_PER_BLOCK)
          for (let z = c.origin[2]!; z < c.origin[2]! + c.size[2]!; z += UNITS_PER_BLOCK) cells.add(`${x},${y},${z}`);
    }
    for (const cell of cells) claims.set(cell, (claims.get(cell) ?? 0) + 1);
  }
  return claims;
};

describe('LOD hull geometry', () => {
  it('keeps only the surface of a solid block and greedy-merges it', () => {
    const hull = buildLodHull('t', block(() => 4), { cellBlocks: 1 })!;
    expect(hull.cellBlocks).toBe(1);
    expect(hull.colours).toBe(1);
    // 27 voxels, the centre one buried: 26 surface cells. The greedy (x, then
    // y, then z, first-fit in x/y/z order) covers them with exactly six boxes:
    // the whole z=0 plane (9), (x0..2, y0, z1..2) = 6, (x0, y1..2, z1..2) = 4,
    // (x1..2, y2, z1..2) = 4, (x2, y1, z1..2) = 2 and (x1, y1, z2) = 1.
    expect(hull.cuboids).toBe(6);
    const cubes = cubesOf(hull);
    expect(cubes).toHaveLength(6);
    const volume = cubes.reduce((n, c) => n + (c.size[0]! * c.size[1]! * c.size[2]!), 0);
    expect(volume).toBe(26 * Math.pow(UNITS_PER_BLOCK, 3));
    // Box UV into the colour's flat swatch, as the full-detail cubes do.
    for (const c of cubes) expect(c.uv).toEqual([0, 0]);
    // Every emitted hull cube is one block or a multiple of it, and inside the model's box.
    for (const c of cubes) {
      for (const s of c.size) expect(s % UNITS_PER_BLOCK).toBe(0);
      for (let i = 0; i < 3; i++) expect(c.origin[i]! >= 0 && c.origin[i]! + c.size[i]! <= 3 * UNITS_PER_BLOCK).toBe(true);
    }
  });

  it('builds one geometry per colour and keeps each colour on its own skin cells', () => {
    // Left slab red (4), right two slabs blue (1); the buried centre cell is blue.
    const hull = buildLodHull('t', block(x => (x === 0 ? 4 : 1)), { cellBlocks: 1 })!;
    expect(hull.colours).toBe(2);
    expect(hull.meshes.map(m => m.material.colorId).sort()).toEqual([1, 4]);
    expect(hull.meshes.every(m => !m.translucent)).toBe(true);
    const perColour = new Map(hull.meshes.map(m => [m.material.colorId, m.cuboids]));
    // Red owns the whole x=0 slab (9 cells, all on the skin) — one greedy box.
    expect(perColour.get(4)).toBe(1);
    // Blue owns 18 cells, one of them (1,1,1) buried, so 17 reach the hull.
    const blueVolume = (hull.value as Geo)['minecraft:geometry']
      .filter((_, i) => hull.meshes[i]!.material.colorId === 1)
      .flatMap(g => g.bones.flatMap(b => b.cubes ?? []))
      .reduce((n, c) => n + c.size[0]! * c.size[1]! * c.size[2]!, 0);
    expect(blueVolume).toBe(17 * Math.pow(UNITS_PER_BLOCK, 3));
    expect(hull.cuboids).toBe(perColour.get(4)! + perColour.get(1)!);
    // Distinct geometry ids, in the entity's namespace.
    expect(new Set(hull.meshes.map(m => m.id)).size).toBe(hull.meshes.length);
    for (const m of hull.meshes) expect(m.id.startsWith('geometry.craftmatic.t_lod_')).toBe(true);
  });

  it('gives a skin cell that two colours share to exactly one of them - the larger volume', () => {
    // Two bricks side by side INSIDE one block cell (a brick is 0.375 block at
    // minifig scale, so this is the normal case, not an edge one): red fills
    // x 0-6 of cell 0, blue x 6-16; red also fills all of cell 1. Both colours'
    // raster masks cover cell 0 and both cells are skin, so the first version
    // emitted a red AND a blue full-cell cube on cell 0 - coplanar faces that
    // z-fought (10303: 1,523 of 3,189 skin cells, up to nine claimants).
    const U = UNITS_PER_BLOCK;
    const hull = buildLodHull('t', geometryOf(new Map([
      [4, [{ origin: [0, 0, 0], size: [6, U, U] }, { origin: [U, 0, 0], size: [U, U, U] }]],
      [1, [{ origin: [6, 0, 0], size: [U - 6, U, U] }]],
    ])), { cellBlocks: 1 })!;
    expect(hull.colours).toBe(2);
    // Exactly one cube per cell, and cell 0 went to blue (10 of 16 units of x).
    expect(hull.cuboids).toBe(2);
    expect([...claimsPerCell(hull.value).values()]).toEqual([1, 1]);
    const byColour = new Map(hull.meshes.map((m, i) => [m.material.colorId, (hull.value as Geo)['minecraft:geometry'][i]!.bones[0]!.cubes!]));
    expect(byColour.get(1)).toEqual([{ origin: [0, 0, 0], size: [U, U, U], uv: [0, 0] }]);
    expect(byColour.get(4)).toEqual([{ origin: [U, 0, 0], size: [U, U, U], uv: [0, 0] }]);
  });

  it('never lets glass take a cell with anything opaque in it (76417\'s upper floor read as a glass sheet)', () => {
    const U = UNITS_PER_BLOCK;
    // A sand-green roof plate filling a quarter of cell 0, a trans-clear pane filling
    // the rest of it, and a pane alone in cell 1: the roof keeps cell 0, glass keeps cell 1.
    const hull = buildLodHull('t', geometryOf(new Map([
      [378, [{ origin: [0, 0, 0], size: [U, U / 4, U] }]],
      [47, [{ origin: [0, U / 4, 0], size: [U, 3 * U / 4, U] }, { origin: [U, 0, 0], size: [U, U, U] }]],
    ])), { cellBlocks: 1 })!;
    const byColour = new Map(hull.meshes.map((m, i) => [m.material.colorId, (hull.value as Geo)['minecraft:geometry'][i]!.bones[0]!.cubes!]));
    expect(byColour.get(378)).toEqual([{ origin: [0, 0, 0], size: [U, U, U], uv: [0, 0] }]);
    expect(byColour.get(47)).toEqual([{ origin: [U, 0, 0], size: [U, U, U], uv: [0, 0] }]);
    // And the hull draws it opaque: blended, it showed the hollow hull's own inside.
    expect(hull.meshes.every(m => !m.translucent)).toBe(true);
  });

  it('turns a rotated bone\'s cubes with the geometry\'s own convention, not the render frame\'s', () => {
    const U = UNITS_PER_BLOCK;
    // A 2 x 1 x 1 bar on a bone turned 90 degrees about Z (JSON): under the X mirror the
    // compiler writes, it points DOWN from its pivot (Rz(-90) in JSON coordinates).
    const doc = { 'minecraft:geometry': [{ description: { identifier: 'geometry.craftmatic.t_mesh_0' }, bones: [{ name: 'r1', pivot: [0, 0, 0], rotation: [0, 0, 90], cubes: [{ origin: [0, 0, 0], size: [2 * U, U, U] }] }] }] };
    const hull = buildLodHull('t', { value: doc, meshes: [{ id: 'geometry.craftmatic.t_mesh_0', material: resolveLdrawEntityMaterial(4), translucent: false }] }, { cellBlocks: 1 })!;
    const ys = cubesOf(hull).flatMap(c => [c.origin[1]!, c.origin[1]! + c.size[1]!]);
    expect(Math.min(...ys)).toBe(-2 * U);
    expect(Math.max(...ys)).toBe(0);
  });

  it('breaks a volume tie by draw order and never leaves a skin cell to two colours', () => {
    const U = UNITS_PER_BLOCK;
    // Red and blue each fill half of the one cell: red is drawn first and keeps it.
    const tie = buildLodHull('t', geometryOf(new Map([
      [4, [{ origin: [0, 0, 0], size: [U / 2, U, U] }]],
      [1, [{ origin: [U / 2, 0, 0], size: [U / 2, U, U] }]],
    ])), { cellBlocks: 1 })!;
    expect(tie.cuboids).toBe(1);
    expect(tie.meshes.map(m => m.material.colorId)).toEqual([4]);
    // A 3x3x3 checkerboard of quarter-block cubes: every skin cell holds several
    // colours, and every one of them ends up with exactly one owner.
    const byColour = new Map<number, GeoCube[]>();
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) {
      const id = [4, 1, 2, 14][(x + 2 * y + 3 * z) % 4]!;
      byColour.set(id, [...(byColour.get(id) ?? []), { origin: [x * U / 2, y * U / 2, z * U / 2], size: [U / 2, U / 2, U / 2] }]);
    }
    const board = buildLodHull('t', geometryOf(byColour), { cellBlocks: 1 })!;
    const claims = claimsPerCell(board.value);
    expect(claims.size).toBe(26);
    expect(Math.max(...claims.values())).toBe(1);
    const volume = cubesOf(board).reduce((n, c) => n + c.size[0]! * c.size[1]! * c.size[2]!, 0);
    expect(volume).toBe(26 * Math.pow(U, 3));
  });

  it('reports the entity extent and its reach from the root, in blocks', () => {
    const U = UNITS_PER_BLOCK;
    // A shell hangs BELOW its root (`originAboveModel`): a cube 45 blocks down
    // and 2 blocks out reaches hypot(2, 45, 2) from the root, and that reach is
    // what a render controller must add to the camera distance it tests.
    const hull = buildLodHull('t', geometryOf(new Map([[4, [{ origin: [-2 * U, -45 * U, U], size: [U, U, U] }]]])), { cellBlocks: 1 })!;
    expect(hull.extentBlocks).toEqual({ min: [-2, -45, 1], max: [-1, -44, 2] });
    expect(hull.radiusBlocks).toBeCloseTo(Math.hypot(2, 45, 2), 6);
    // A rotated bone reaches as far as its rotated corners: the same cube spun
    // 90° about the root on Y lands at z = 1..2 -> x, and the reach is unchanged.
    const spun = geometryOf(new Map([[4, [{ origin: [-2 * U, -45 * U, U], size: [U, U, U] }]]]));
    (spun.value['minecraft:geometry'][0]!.bones[0] as { rotation?: number[] }).rotation = [0, 90, 0];
    const rotated = buildLodHull('t', spun, { cellBlocks: 1 })!;
    expect(rotated.radiusBlocks).toBeCloseTo(hull.radiusBlocks, 6);
    expect(rotated.extentBlocks.min[1]).toBe(-45);
    expect(rotated.extentBlocks.min[0]).toBeCloseTo(1, 6);
    expect(rotated.extentBlocks.max[0]).toBeCloseTo(2, 6);
  });

  it('is coarser and cheaper at a 2-block cell, and reports nothing for an empty geometry', () => {
    const fine = buildLodHull('t', block(() => 4), { cellBlocks: 1 })!;
    const coarse = buildLodHull('t', block(() => 4), { cellBlocks: 2 })!;
    expect(coarse.cellBlocks).toBe(2);
    expect(coarse.cuboids).toBeLessThan(fine.cuboids);
    expect(buildLodHull('t', { value: { 'minecraft:geometry': [] }, meshes: [] })).toBeNull();
  });

  it('ships one empty geometry with a bone and no cubes', () => {
    const geo = LOD_EMPTY_GEOMETRY['minecraft:geometry'];
    expect(geo).toHaveLength(1);
    expect(geo[0]!.description.identifier).toBe(LOD_EMPTY_GEOMETRY_ID);
    expect(geo[0]!.bones).toHaveLength(1);
    expect((geo[0]!.bones[0] as { cubes?: unknown[] }).cubes).toBeUndefined();
  });
});

// ─── The actor's render cull, and the switch that has to sit under it ─────────

describe('the render cull and the LOD switch', () => {
  it('draws an actor to 64 blocks per unit of collision-box diagonal, never under 64, and never past the measured ceiling', () => {
    // Under the ceiling the fit answers: a 0.1 shell culls at 64 (round921).
    expect(entityRenderCullBlocks({ width: 0.1, height: 0.1 })).toBe(64);
    expect(entityRenderCullBlocks(undefined)).toBe(64);
    // Round 2026-09-26a, both phones (26.51 / 26.52): a figure (0.6 x 1.8, fit 127), a door (0.25 x 2.5,
    // fit 160), the 76417 needle (fit 135) and a vehicle-sized box all stop at the same ~72 blocks.
    for (const box of [{ width: 0.6, height: 1.8 }, { width: 0.25, height: 2.5 }, { width: 0.1, height: 2.115 }, { width: 3.5, height: 2.5 }]) {
      expect(entityRenderCullBlocks(box)).toBe(ACTOR_DRAW_CEILING_BLOCKS);
    }
    expect(ACTOR_DRAW_CEILING_BLOCKS).toBeGreaterThan(64);
    expect(ACTOR_DRAW_CEILING_BLOCKS).toBeLessThan(71.6);
  });

  it('drops the 76417 shell hull its needle had planned at ~120 blocks, where no actor is drawn (round 2026-09-26a)', () => {
    // Needle 0.1 x 2.115: the fit put its cull at 135 and its switch near 120; the device drew nothing past 72.
    const plan = planLodSwitch({ lodDistance: 96, radiusBlocks: 30, collisionBox: { width: 0.1, height: 2.115 } });
    expect(plan.renderCullBlocks).toBe(ACTOR_DRAW_CEILING_BLOCKS);
    expect(plan.ship).toBe(false);
  });

  it('drops the hull for 10303: a 0.1-box shell with a 50.3-block reach culls at 64, so no switch is both under the cull and far enough from the cubes', () => {
    const plan = planLodSwitch({ lodDistance: 96, radiusBlocks: 50.3, collisionBox: { width: 0.1, height: 0.1 } });
    expect(plan.ship).toBe(false);
    if (plan.ship) throw new Error('unreachable');
    expect(plan.requestedSwitchDistance).toBe(146.3);
    expect(plan.renderCullBlocks).toBe(64);
    expect(plan.latestSwitchDistance).toBe(64 - LOD_CULL_MARGIN_BLOCKS);
    // The camera would be INSIDE the model's reach at the latest possible switch.
    expect(plan.nearestCubeBlocks).toBeCloseTo(48 - 50.3, 6);
    expect(plan.reason).toMatch(/not drawn past 64 blocks/);
    expect(plan.reason).toMatch(/0\.1 x 0\.1/);
  });

  it('caps a vehicle switch one chunk under the measured ceiling, however large its box', () => {
    const plan = planLodSwitch({ lodDistance: 96, radiusBlocks: 12, collisionBox: { width: 3.5, height: 2.5 } });
    expect(plan.ship).toBe(true);
    if (!plan.ship) throw new Error('unreachable');
    expect(plan.switchDistance).toBe(ACTOR_DRAW_CEILING_BLOCKS - LOD_CULL_MARGIN_BLOCKS);
    expect(plan.switchSource).toBe('render-cull');
    expect(plan.nearestCubeBlocks).toBe(ACTOR_DRAW_CEILING_BLOCKS - LOD_CULL_MARGIN_BLOCKS - 12);
    expect(plan.hullWindowBlocks).toBe(LOD_CULL_MARGIN_BLOCKS);
    // A requested switch under the cap stands as asked.
    const near = planLodSwitch({ lodDistance: 40, radiusBlocks: 5, collisionBox: { width: 3.5, height: 2.5 } });
    expect(near.ship && near.switchDistance).toBe(45);
    expect(near.ship && near.switchSource).toBe('requested');
  });

  it('caps the switch one chunk under the cull for a small shell, down to the 32-block floor, and drops it below', () => {
    const shed = planLodSwitch({ lodDistance: 96, radiusBlocks: 4, collisionBox: { width: 0.1, height: 0.1 } });
    expect(shed.ship).toBe(true);
    if (!shed.ship) throw new Error('unreachable');
    expect(shed.switchDistance).toBe(48);
    expect(shed.switchSource).toBe('render-cull');
    expect(shed.nearestCubeBlocks).toBe(44);
    expect(shed.hullWindowBlocks).toBe(LOD_CULL_MARGIN_BLOCKS);
    // Exactly at the floor ships; a tenth of a block past it does not.
    const atFloor = planLodSwitch({ lodDistance: 96, radiusBlocks: 48 - MIN_LOD_NEAREST_CUBE_BLOCKS, collisionBox: { width: 0.1, height: 0.1 } });
    expect(atFloor.ship).toBe(true);
    const pastFloor = planLodSwitch({ lodDistance: 96, radiusBlocks: 48 - MIN_LOD_NEAREST_CUBE_BLOCKS + 0.1, collisionBox: { width: 0.1, height: 0.1 } });
    expect(pastFloor.ship).toBe(false);
    // A requested switch already under the cap stands as requested.
    const near = planLodSwitch({ lodDistance: 40, radiusBlocks: 4, collisionBox: { width: 0.1, height: 0.1 } });
    expect(near.ship && near.switchDistance).toBe(44);
    expect(near.ship && near.switchSource).toBe('requested');
  });

  it('honours an explicit distance as asked and only reports whether the cull lets it show', () => {
    // The device A/B ships a never-hull (1024) and an always-hull (1) pack;
    // both must keep their hull geometry resident.
    const never = planLodSwitch({ lodDistance: 1024, radiusBlocks: 50.3, collisionBox: { width: 0.1, height: 0.1 }, explicit: true });
    expect(never.ship && never.switchDistance).toBe(1074.3);
    expect(never.ship && never.hullWindowBlocks).toBeLessThan(0);
    const always = planLodSwitch({ lodDistance: 1, radiusBlocks: 50.3, collisionBox: { width: 0.1, height: 0.1 }, explicit: true });
    expect(always.ship && always.switchDistance).toBe(51.3);
    expect(always.ship && always.hullWindowBlocks).toBeCloseTo(64 - 51.3, 6);
    expect(always.ship && always.nearestCubeBlocks).toBe(1);
  });

  it('spells a percent sign out for text the game shows, and leaves everything else alone', () => {
    // Bedrock's text formatter deletes a bare `%` (round921-21-wand-top.jpg);
    // the word cannot be misrendered, unlike a `%%` that has not been seen
    // rendered from a script form on a device.
    expect(bedrockInGameText('at 100 %; 150 % makes them 2.5×2.2')).toBe('at 100 percent; 150 percent makes them 2.5×2.2');
    expect(bedrockInGameText('Size 100% → 150%')).toBe('Size 100 percent → 150 percent');
    expect(bedrockInGameText('reaches 5 % of the height')).toBe('reaches 5 percent of the height');
    expect(bedrockInGameText('no sign here')).toBe('no sign here');
    expect(bedrockInGameText('')).toBe('');
  });
});

// ─── Through the pack: an opt-in that changes nothing until it is asked for ───

const partBox = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
const LIBRARY: Record<string, string> = {
  '3001': ['0 Brick 2 x 4', ...partBox(-40, 40, -24, 0, -20, 20)].join('\n'),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const C = LDU_PER_BLOCK;
const frame: SceneGridFrame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: C, cellY: C };

/**
 * A small brick-built shell pack, with and without the LOD option. `courses`
 * makes the wall taller: a shell's root sits above the model, so a tall wall
 * has a long reach from it and its hull cannot fit under the 64-block cull.
 */
const shellPack = async (lod: 'none' | 'hull', lodDistance?: number, courses = 2, extra: Partial<PlayableAddonOptions> = {}) => {
  const grid = new BlockGrid(4, 3, 4);
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) grid.set(x, 0, z, 'minecraft:red_concrete');
  // A wall of 2x4 bricks, three long and two courses high: enough surface for a
  // hull. The first brick is red and the other two blue, so the hull has two
  // colours that SHARE the block cells straddling the brick boundary (a brick
  // is 80 LDU, a block 53), the case that z-fought. (Colouring by course would
  // not do: both courses sit inside one 53-LDU cell row and tie on volume.)
  const bricks: ParsedBrick[] = [];
  for (let i = 0; i < 3; i++) for (let course = 0; course < courses; course++)
    bricks.push({ part: '3001.dat', color: i ? 1 : 4, x: i * 80, y: -course * 24, z: 0, rot: I });
  return buildPlayableAddon(grid, {
    stem: 'lodshed', label: 'Lod Shed', partGeometry: provider(), pbr: false, shell: { bricks, frame },
    lod, ...(lodDistance === undefined ? {} : { lodDistance }), ...extra,
  });
};

const textOf = async (bytes: Uint8Array, name: string): Promise<string> => new TextDecoder().decode(await extractFile(ab(bytes), name));

describe('the LOD hull inside a pack', () => {
  it('can compare full and hull at one camera without changing resident geometry', async () => {
    // At a fixed 20–25 block camera, the existing distance option can force
    // either representation. Both packs retain BOTH meshes, isolating drawing
    // cost from residency and screen-coverage changes in a device experiment.
    const full = await shellPack('hull', 1024);
    const hull = await shellPack('hull', 1);
    const entries = listZipEntries(ab(full.bytes));
    expect(listZipEntries(ab(hull.bytes))).toEqual(entries);
    const invariant = entries.filter(name =>
      /\/models\/entity\/|\/entity\/|\/entities\/|\/scripts\//.test(name));
    expect(invariant.length).toBeGreaterThan(0);
    for (const name of invariant) {
      expect(await textOf(full.bytes, name), name).toBe(await textOf(hull.bytes, name));
    }
    for (const root of ['Craftmatic_lodshed_BP', 'Craftmatic_lodshed_RP']) {
      const a = JSON.parse(await textOf(full.bytes, `${root}/manifest.json`)) as { header: { uuid: string } };
      const b = JSON.parse(await textOf(hull.bytes, `${root}/manifest.json`)) as { header: { uuid: string } };
      expect(a.header.uuid).toBe(b.header.uuid);
    }
    const diagnostics = 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json';
    const a = JSON.parse(await textOf(full.bytes, diagnostics)) as { pack: { cuboids: number }; lod: { cuboids: number; entities: Record<string, { switchDistance: number }> } };
    const b = JSON.parse(await textOf(hull.bytes, diagnostics)) as typeof a;
    expect(a.pack.cuboids).toBe(b.pack.cuboids);
    expect(a.lod.cuboids).toBe(b.lod.cuboids);
    expect(a.lod.cuboids).toBeGreaterThan(0);
    // The controllers differ ONLY by the switch distance (option + the same reach from the root).
    const controller = 'Craftmatic_lodshed_RP/render_controllers/lodshed_shell.render_controllers.json';
    const near = a.lod.entities['lodshed_shell']!.switchDistance, far = b.lod.entities['lodshed_shell']!.switchDistance;
    expect(near - far).toBeCloseTo(1024 - 1, 6);
    expect((await textOf(full.bytes, controller)).replaceAll(String(near), String(far)))
      .toBe(await textOf(hull.bytes, controller));
  });

  it('leaves the shipped form alone by default', async () => {
    const off = await shellPack('none');
    const again = await shellPack('none');
    expect(listZipEntries(ab(off.bytes)).filter(e => /_lod\.geo\.json|craftmatic_lod_empty/.test(e))).toEqual([]);
    const controllers = JSON.parse(await textOf(off.bytes, 'Craftmatic_lodshed_RP/render_controllers/lodshed_shell.render_controllers.json')).render_controllers as Record<string, Record<string, unknown>>;
    for (const c of Object.values(controllers)) {
      expect(c.arrays).toBeUndefined();
      expect(String(c.geometry)).toMatch(/^Geometry\.mesh_\d+$/);
    }
    const client = JSON.parse(await textOf(off.bytes, 'Craftmatic_lodshed_RP/entity/lodshed_shell.entity.json'))['minecraft:client_entity'].description as { geometry: Record<string, string> };
    expect(client.geometry.empty).toBeUndefined();
    const diagnostics = JSON.parse(await textOf(off.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as { lod: { renderCull: { blocksPerUnitDiagonal: number; evidence: string } } };
    expect(diagnostics.lod).toMatchObject({ mode: 'none', distance: DEFAULT_LOD_DISTANCE, explicitDistance: false, cuboids: 0, note: 'off', entities: {}, skipped: {} });
    // The cull rule the switch is derived from is stated in every pack, with its evidence.
    expect(diagnostics.lod.renderCull.blocksPerUnitDiagonal).toBe(RENDER_CULL_BLOCKS_PER_UNIT);
    expect(diagnostics.lod.renderCull.evidence).toMatch(/round921/);
    // Two builds of the same input agree byte for byte on the geometry (the pack
    // version comes from the clock, so the archive itself cannot be compared).
    expect(await textOf(off.bytes, 'Craftmatic_lodshed_RP/models/entity/lodshed_shell.geo.json'))
      .toBe(await textOf(again.bytes, 'Craftmatic_lodshed_RP/models/entity/lodshed_shell.geo.json'));
    expect(off.warnings.some(w => /distance LOD/.test(w))).toBe(false);
  });

  it('adds the hull geometry, one shared empty geometry, and switches on camera distance', async () => {
    const on = await shellPack('hull', 48);
    const off = await shellPack('none');
    const entries = listZipEntries(ab(on.bytes));
    expect(entries).toContain('Craftmatic_lodshed_RP/models/entity/lodshed_shell_lod.geo.json');
    // Declared ONCE for the pack, not once per entity.
    expect(entries.filter(e => /craftmatic_lod_empty\.geo\.json$/.test(e))).toHaveLength(1);
    // The full-detail geometry file is untouched by the option.
    expect(await textOf(on.bytes, 'Craftmatic_lodshed_RP/models/entity/lodshed_shell.geo.json'))
      .toBe(await textOf(off.bytes, 'Craftmatic_lodshed_RP/models/entity/lodshed_shell.geo.json'));

    const client = JSON.parse(await textOf(on.bytes, 'Craftmatic_lodshed_RP/entity/lodshed_shell.entity.json'))['minecraft:client_entity'].description as { geometry: Record<string, string>; render_controllers: string[] };
    expect(client.geometry.empty).toBe(LOD_EMPTY_GEOMETRY_ID);
    const hullGeometries = Object.entries(client.geometry).filter(([, v]) => /_lod_\d+$/.test(v));
    expect(hullGeometries.length).toBeGreaterThan(0);
    // One render controller per geometry; `empty` is shared and has none of its own.
    expect(client.render_controllers).toHaveLength(Object.keys(client.geometry).length - 1);

    const controllers = JSON.parse(await textOf(on.bytes, 'Craftmatic_lodshed_RP/render_controllers/lodshed_shell.render_controllers.json')).render_controllers as Record<string, { arrays: { geometries: Record<string, string[]> }; geometry: string }>;
    for (const [name, c] of Object.entries(controllers)) {
      const index = Number(/_mesh_(\d+)$/.exec(name)![1]);
      expect(c.arrays.geometries['Array.g']).toEqual([`Geometry.mesh_${index}`, 'Geometry.empty']);
    }
    const diagnostics = JSON.parse(await textOf(on.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as {
      lod: { mode: string; distance: number; explicitDistance: boolean; cuboids: number; note: string; entities: Record<string, { cuboids: number; colours: number; geometries: number; cellBlocks: number; shareOfEntity: number; radiusBlocks: number; switchDistance: number; renderCullBlocks: number; switchSource: string }> };
      pack: { cuboids: number; lodCuboids: number; shareOfDeviceBudget: number };
      entities: Record<string, { cubeCount: number }>;
    };
    expect(diagnostics.lod.mode).toBe('hull');
    expect(diagnostics.lod.distance).toBe(48);
    expect(diagnostics.lod.explicitDistance).toBe(true);
    expect(diagnostics.lod.note).toMatch(/in blocks/);
    const hull = diagnostics.lod.entities['lodshed_shell']!;
    expect(hull.cuboids).toBeGreaterThan(0);
    expect(hull.colours).toBe(2);
    expect(hull.cellBlocks).toBe(1);
    expect(hull.geometries).toBe(hullGeometries.length);

    // The controllers test the camera-to-ROOT distance, so they switch at the
    // option PLUS the entity's reach from its root (the shell hangs below it),
    // never at the bare option: the bare 32 flipped 10303 to its hull for a
    // camera standing at the tracks.
    expect(hull.radiusBlocks).toBeGreaterThan(1);
    // An EXPLICIT distance (the device A/B's lever) is honoured as asked; the
    // shell's 0.1 box culls it at 64, which is reported beside it.
    expect(hull.switchDistance).toBeCloseTo(48 + hull.radiusBlocks, 1);
    expect(hull.switchSource).toBe('requested');
    expect(hull.renderCullBlocks).toBe(64);
    const expressions = Object.values(controllers).map(c => c.geometry);
    const fullCount = Object.keys(client.geometry).length - 1 - hullGeometries.length;
    expect(expressions.filter(e => e === `Array.g[query.distance_from_camera > ${hull.switchDistance}]`)).toHaveLength(fullCount);
    expect(expressions.filter(e => e === `Array.g[query.distance_from_camera <= ${hull.switchDistance}]`)).toHaveLength(hullGeometries.length);
    expect(on.warnings.some(w => new RegExp(`lodshed_shell at ${hull.switchDistance} \\(reach ${hull.radiusBlocks}, culls at 64\\)`).test(w))).toBe(true);

    // Two colours share block cells in this wall; no skin cell may carry a cube from both.
    const hullDoc = JSON.parse(await textOf(on.bytes, 'Craftmatic_lodshed_RP/models/entity/lodshed_shell_lod.geo.json')) as unknown;
    const claims = claimsPerCell(hullDoc);
    expect(claims.size).toBeGreaterThan(0);
    expect(Math.max(...claims.values())).toBe(1);
    expect(hull.shareOfEntity).toBeCloseTo(hull.cuboids / diagnostics.entities['lodshed_shell']!.cubeCount, 2);
    // The hull is RESIDENT, so the pack's budget counts it.
    expect(diagnostics.pack.lodCuboids).toBe(hull.cuboids);
    const offDiag = JSON.parse(await textOf(off.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as { pack: { cuboids: number } };
    expect(diagnostics.pack.cuboids).toBe(offDiag.pack.cuboids + hull.cuboids);
    // `shareOfDeviceBudget` is reported rounded; a shed is a rounding error of the phone's budget.
    expect(diagnostics.pack.shareOfDeviceBudget).toBeCloseTo(diagnostics.pack.cuboids / DEVICE_CUBOID_BUDGET, 3);
    expect(on.warnings.some(w => /distance LOD on/.test(w) && /blocks/.test(w))).toBe(true);
  });

  it("derives the switch from the shell's own render cull, which its collision box sizes", async () => {
    interface LodDiag {
      lod: { cuboids: number; entities: Record<string, { switchDistance: number; requestedSwitchDistance: number; renderCullBlocks: number; nearestCubeBlocks: number; hullWindowBlocks: number; switchSource: string; radiusBlocks: number }>; skipped: Record<string, { reason: string; hullCuboidsNotShipped: number; requestedSwitchDistance: number; renderCullBlocks: number; latestSwitchDistance: number; nearestCubeBlocks: number; collisionBox: { width: number; height: number } | null }> };
      pack: { cuboids: number; lodCuboids: number };
    }
    // Bedrock stops drawing an actor at a distance its collision box sets, and
    // the hull is the SAME actor — a hull that takes over past that point can
    // never be seen. The shell sizes its box from the model, so a taller build
    // draws further and leaves the hull more room.
    const shed = await shellPack('hull');
    const shedDiag = JSON.parse(await textOf(shed.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as LodDiag;
    const h = shedDiag.lod.entities['lodshed_shell']!;
    expect(shedDiag.lod.skipped).toEqual({});
    expect(h.switchDistance - (h.renderCullBlocks - LOD_CULL_MARGIN_BLOCKS)).toBeLessThanOrEqual(0.05);
    expect(h.switchDistance).toBeLessThanOrEqual(h.requestedSwitchDistance);
    expect(h.nearestCubeBlocks).toBeGreaterThanOrEqual(MIN_LOD_NEAREST_CUBE_BLOCKS);
    expect(h.requestedSwitchDistance).toBeCloseTo(DEFAULT_LOD_DISTANCE + h.radiusBlocks, 1);
    const controllers = JSON.parse(await textOf(shed.bytes, 'Craftmatic_lodshed_RP/render_controllers/lodshed_shell.render_controllers.json')).render_controllers as Record<string, { geometry: string }>;
    expect(Object.values(controllers).some(c => c.geometry === `Array.g[query.distance_from_camera > ${h.switchDistance}]`)).toBe(true);

    // Forty courses: a taller model, a bigger box, a further cull. Its hull
    // ships, and its switch still sits under its own cull.
    const tower = await shellPack('hull', undefined, 40);
    const towerDiag = JSON.parse(await textOf(tower.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as LodDiag;
    const t = towerDiag.lod.entities['lodshed_shell']!;
    expect(towerDiag.lod.skipped).toEqual({});
    expect(towerDiag.lod.cuboids).toBeGreaterThan(0);
    expect(t.renderCullBlocks).toBeGreaterThan(h.renderCullBlocks);
    expect(t.switchDistance - (t.renderCullBlocks - LOD_CULL_MARGIN_BLOCKS)).toBeLessThanOrEqual(0.05);
    expect(t.nearestCubeBlocks).toBeGreaterThanOrEqual(MIN_LOD_NEAREST_CUBE_BLOCKS);
    expect(listZipEntries(ab(tower.bytes)).some(e => /_lod\.geo\.json$/.test(e))).toBe(true);

    // The hull is resident geometry: the same pack without it is cheaper by
    // exactly the hull's cuboids, and the export says the LOD is on.
    const plain = await shellPack('none', undefined, 40);
    const plainDiag = JSON.parse(await textOf(plain.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as LodDiag;
    expect(towerDiag.pack.cuboids - plainDiag.pack.cuboids).toBe(towerDiag.lod.cuboids);
    expect(plainDiag.lod?.cuboids ?? 0).toBe(0);
    expect(tower.warnings.some(w => /distance LOD on/.test(w))).toBe(true);
  });

  it('hands the wand a walk-through reason the game can show: every percent sign spelt out, the diagnostics untouched', async () => {
    const reason = 'Wall openings are 1.7×1.5 blocks at 100 %; 150 % makes them 2.5×2.2 (a player needs 1×2; 49/149 clear it); a player still reaches 5 % of the model\'s height at 150 %.';
    const pack = await shellPack('none', undefined, 2, {
      access: { basis: 'apertures', scale: 1.5, sizePct: 150, reason },
      interactionNote: 'A measured source door leaf remains under the two-block vanilla clearance even at 400%, so the wand will not claim a usable door.',
    });
    const script = await textOf(pack.bytes, 'Craftmatic_lodshed_BP/scripts/placement.js');
    // Exactly the text the wand embeds, as it will render (round921-21-wand-top.jpg showed the `%` deleted).
    expect(script).toContain(JSON.stringify('Wall openings are 1.7×1.5 blocks at 100 percent; 150 percent makes them 2.5×2.2 (a player needs 1×2; 49/149 clear it); a player still reaches 5 percent of the model\'s height at 150 percent.'));
    expect(script).toContain('even at 400 percent, so the wand');
    expect(script).not.toContain(JSON.stringify(reason));
    // Nothing this pack hands the wand carries a sign the formatter would
    // delete (the wand runtime's own `${size}%` templates are its module's).
    const config = /^const CONFIG = (.*);$/m.exec(script)![1]!;
    expect(config).not.toMatch(/%/);
    // The recommended step itself still travels as a number for the Size button.
    expect(config).toContain('"sizePct":150');
    // The diagnostics record keeps the measurement as measured.
    const diagnostics = JSON.parse(await textOf(pack.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as { access: { reason: string } };
    expect(diagnostics.access.reason).toBe(reason);
  });
});
