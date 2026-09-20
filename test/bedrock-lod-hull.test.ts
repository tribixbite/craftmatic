/**
 * The opt-in LOD hull (`engine/bedrock-lod-hull.ts`): a per-colour surface-voxel
 * shell of an entity's FINAL emitted cube list, switched in by camera distance.
 */
import { describe, expect, it } from 'vitest';
import { buildLodHull, LOD_EMPTY_GEOMETRY, LOD_EMPTY_GEOMETRY_ID, UNITS_PER_BLOCK } from '../web/src/engine/bedrock-lod-hull.js';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.js';
import { buildPlayableAddon, DEFAULT_LOD_DISTANCE, DEVICE_CUBOID_BUDGET } from '../web/src/engine/playable-addon.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { BlockGrid } from '../src/schem/types.js';
import type { SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { CompiledMesh } from '../web/src/engine/ldraw-entity-compiler.js';

interface GeoCube { origin: number[]; size: number[]; uv?: number[] }
interface Geo { 'minecraft:geometry': Array<{ description: { identifier: string }; bones: Array<{ name: string; pivot: number[]; cubes?: GeoCube[] }> }> }

/**
 * A 3x3x3 solid block of one-block cubes, split between colours by a predicate
 * on the cell — one geometry per colour, as box UV forces the compiler to emit.
 */
const block = (colourAt: (x: number, y: number, z: number) => number): { value: Geo; meshes: CompiledMesh[] } => {
  const byColour = new Map<number, GeoCube[]>();
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
    const id = colourAt(x, y, z);
    const list = byColour.get(id) ?? [];
    list.push({ origin: [x * UNITS_PER_BLOCK, y * UNITS_PER_BLOCK, z * UNITS_PER_BLOCK], size: [UNITS_PER_BLOCK, UNITS_PER_BLOCK, UNITS_PER_BLOCK], uv: [0, 0] });
    byColour.set(id, list);
  }
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

const cubesOf = (hull: { value: unknown }): GeoCube[] =>
  (hull.value as Geo)['minecraft:geometry'].flatMap(g => g.bones.flatMap(b => b.cubes ?? []));

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

/** A small brick-built shell pack, with and without the LOD option. */
const shellPack = async (lod: 'none' | 'hull', lodDistance?: number) => {
  const grid = new BlockGrid(4, 3, 4);
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) grid.set(x, 0, z, 'minecraft:red_concrete');
  // A wall of 2x4 bricks, three long and two courses high: enough surface for a hull.
  const bricks: ParsedBrick[] = [];
  for (let i = 0; i < 3; i++) for (let course = 0; course < 2; course++)
    bricks.push({ part: '3001.dat', color: 4, x: i * 80, y: -course * 24, z: 0, rot: I });
  return buildPlayableAddon(grid, {
    stem: 'lodshed', label: 'Lod Shed', partGeometry: provider(), pbr: false, shell: { bricks, frame },
    lod, ...(lodDistance === undefined ? {} : { lodDistance }),
  });
};

const textOf = async (bytes: Uint8Array, name: string): Promise<string> => new TextDecoder().decode(await extractFile(ab(bytes), name));

describe('the LOD hull inside a pack', () => {
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
    const diagnostics = JSON.parse(await textOf(off.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as { lod: unknown };
    expect(diagnostics.lod).toEqual({ mode: 'none', distance: DEFAULT_LOD_DISTANCE, cuboids: 0, note: 'off', entities: {} });
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
    const expressions = Object.values(controllers).map(c => c.geometry);
    const fullCount = Object.keys(client.geometry).length - 1 - hullGeometries.length;
    expect(expressions.filter(e => e === 'Array.g[query.distance_from_camera > 48]')).toHaveLength(fullCount);
    expect(expressions.filter(e => e === 'Array.g[query.distance_from_camera <= 48]')).toHaveLength(hullGeometries.length);

    const diagnostics = JSON.parse(await textOf(on.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as {
      lod: { mode: string; distance: number; cuboids: number; note: string; entities: Record<string, { cuboids: number; colours: number; geometries: number; cellBlocks: number; shareOfEntity: number }> };
      pack: { cuboids: number; lodCuboids: number; shareOfDeviceBudget: number };
      entities: Record<string, { cubeCount: number }>;
    };
    expect(diagnostics.lod.mode).toBe('hull');
    expect(diagnostics.lod.distance).toBe(48);
    expect(diagnostics.lod.note).toMatch(/in blocks/);
    const hull = diagnostics.lod.entities['lodshed_shell']!;
    expect(hull.cuboids).toBeGreaterThan(0);
    expect(hull.colours).toBeGreaterThan(0);
    expect(hull.cellBlocks).toBe(1);
    expect(hull.geometries).toBe(hullGeometries.length);
    expect(hull.shareOfEntity).toBeCloseTo(hull.cuboids / diagnostics.entities['lodshed_shell']!.cubeCount, 2);
    // The hull is RESIDENT, so the pack's budget counts it.
    expect(diagnostics.pack.lodCuboids).toBe(hull.cuboids);
    const offDiag = JSON.parse(await textOf(off.bytes, 'Craftmatic_lodshed_BP/craftmatic-diagnostics.json')) as { pack: { cuboids: number } };
    expect(diagnostics.pack.cuboids).toBe(offDiag.pack.cuboids + hull.cuboids);
    // `shareOfDeviceBudget` is reported rounded; a shed is a rounding error of the phone's budget.
    expect(diagnostics.pack.shareOfDeviceBudget).toBeCloseTo(diagnostics.pack.cuboids / DEVICE_CUBOID_BUDGET, 3);
    expect(on.warnings.some(w => /distance LOD on/.test(w) && /blocks/.test(w))).toBe(true);
  });
});
