/**
 * The Marketplace budget gate (M06, BIZ-25): pure measures and tier evaluation in
 * `web/src/engine/marketplace/budget.ts`, plus the runtime measurement of `scripts/_marketplace_budget.ts`
 * over a pack built in memory.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import {
  BUDGET_TIERS, DEFAULT_TIER_ID, PLATFORM_LIMITS, countBlockPermutations, cuboidsOfGeometry, entityGeometryCubes,
  evaluateBudget, median, staticMeasure, tierById, type BudgetFile, type RuntimeMeasure,
} from '../web/src/engine/marketplace/budget.js';
import { addonFiles, measureRuntime } from '../scripts/_marketplace_budget.js';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { minifigFromSpec } from '../web/src/engine/minifig-rig.js';

// A torso mould as boxes at its real bounds: enough for the figure rig to compile (as test/bedrock-cuboid-budget.test.ts does).
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

const enc = new TextEncoder();
const json = (path: string, value: unknown): BudgetFile => ({ name: path, data: enc.encode(JSON.stringify(value)) });
const block = (id: string, states: Record<string, unknown>) => ({ 'minecraft:block': { description: { identifier: id, states } } });
const range16 = Array.from({ length: 16 }, (_, i) => i);

/** A PNG header (signature + IHDR) of the given size: enough for the size reader. */
const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w); v.setUint32(20, h);
  return b;
};

describe('marketplace-budget', () => {
  it('block permutations are summed over every custom block and states product', () => {
    // The dev collider set: 43 blocks, each with `lo` and `hi` of 16 values = 256 permutations a block.
    const colliders = Array.from({ length: 43 }, (_, i) => ({ path: `blocks/collider_${i}.json`, json: block(`ns:collider_${i}`, { 'ns:lo': range16, 'ns:hi': range16 }) }));
    expect(countBlockPermutations(colliders).total).toBe(11_008);
    // A range-form state, a three-state product and a stateless block (1 permutation).
    const mixed = [
      { path: 'blocks/a.json', json: block('ns:a', { 'ns:r': { values: { min: 0, max: 3 } }, 'ns:b': [false, true] }) },
      { path: 'blocks/b.json', json: block('ns:b', { 'ns:x': [0, 1, 2], 'ns:y': [0, 1], 'ns:z': [0, 1, 2, 3, 4] }) },
      { path: 'blocks/c.json', json: block('ns:c', {}) },
    ];
    const r = countBlockPermutations(mixed);
    expect(r.blocks.map(b => b.permutations)).toEqual([8, 30, 1]);
    expect(r.total).toBe(39);
  });

  it('counts the cubes of a geometry in both file formats', () => {
    const modern = { format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.a' }, bones: [{ name: 'x', cubes: [{}, {}, {}] }, { name: 'y', cubes: [{}] }, { name: 'z' }] }, { description: { identifier: 'geometry.b' }, bones: [{ cubes: [{}, {}] }] }] };
    expect(cuboidsOfGeometry(modern)).toEqual({ 'geometry.a': 4, 'geometry.b': 2 });
    const legacy = { 'geometry.old': { bones: [{ cubes: [{}, {}] }] } };
    expect(cuboidsOfGeometry(legacy)).toEqual({ 'geometry.old': 2 });
  });

  it('maps each client entity to the cuboids of the geometries it names', () => {
    const files: BudgetFile[] = [
      json('RP/models/entity/a.geo.json', { 'minecraft:geometry': [{ description: { identifier: 'geometry.a' }, bones: [{ cubes: [{}, {}, {}] }] }, { description: { identifier: 'geometry.lod' }, bones: [{ cubes: [{}] }] }] }),
      json('RP/entity/a.entity.json', { 'minecraft:client_entity': { description: { identifier: 'ns:a', geometry: { default: 'geometry.a', lod: 'geometry.lod' } } } }),
      json('RP/entity/b.entity.json', { 'minecraft:client_entity': { description: { identifier: 'ns:b', geometry: { default: 'geometry.missing' } } } }),
    ];
    const m = entityGeometryCubes(files);
    expect(m.get('ns:a')).toBe(4);
    expect(m.get('ns:b')).toBe(0);
  });

  it('measures size, file count, permutations and texture sizes from the files', () => {
    const files: BudgetFile[] = [
      { name: 'RP/textures/blocks/big.png', data: png(512, 256) },
      { name: 'RP/textures/blocks/ok.png', data: png(256, 256) },
      { name: 'RP/textures/entity/wide.png', data: png(2048, 2048) },
      { name: 'RP/textures/entity/huge.png', data: png(4096, 64) },
      json('BP/blocks/a.json', block('ns:a', { 'ns:s': range16 })),
    ];
    const m = staticMeasure(files);
    expect(m.fileCount).toBe(5);
    expect(m.uncompressedBytes).toBe(files.reduce((s, f) => s + f.data.length, 0));
    expect(m.permutations).toBe(16);
    expect(m.oversizeTextures.map(t => t.path).sort()).toEqual(['RP/textures/blocks/big.png', 'RP/textures/entity/huge.png']);
  });

  it('the standard tier is the default and carries evidence for every limit', () => {
    const t = tierById(DEFAULT_TIER_ID);
    expect(t.id).toBe('standard');
    expect([t.maxResidentCuboids, t.maxResidentEntities, t.maxScriptMsMedian, t.maxUncompressedBytes]).toEqual([60_000, 120, 4, 25 * 1024 * 1024]);
    expect(t.evidence.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(BUDGET_TIERS)).toContain('standard');
    expect(() => tierById('nope')).toThrow(/standard/);
    expect(PLATFORM_LIMITS.maxPermutations).toBe(10_000);
    expect(PLATFORM_LIMITS.maxFiles).toBe(3_500);
  });

  it('evaluates each measure against the tier: the limit itself passes, over fails, unmeasured is incomplete', () => {
    const tier = tierById('standard');
    const staticOk = { uncompressedBytes: tier.maxUncompressedBytes, fileCount: 10, permutations: 10_000, blocks: 1, oversizeTextures: [], totalGeometryCuboids: 60_000 };
    const runtimeOk: RuntimeMeasure = { residentEntities: 120, placedCuboids: 1000, scriptMsMedian: 4, scriptMsP95: 6, ticks: 200, entitiesByType: {} };
    expect(evaluateBudget({ static: staticOk, runtime: runtimeOk }, tier).verdict).toBe('pass');
    const over = evaluateBudget({ static: { ...staticOk, totalGeometryCuboids: 60_001, permutations: 11_008 }, runtime: runtimeOk }, tier);
    expect(over.verdict).toBe('fail');
    expect(over.rows.filter(r => r.status === 'fail').map(r => r.metric).sort()).toEqual(['block permutations', 'resident cuboids']);
    const none = evaluateBudget({ static: staticOk, runtime: null, runtimeReason: 'static only' }, tier);
    expect(none.verdict).toBe('incomplete');
    expect(none.rows.find(r => r.metric === 'script ms per tick (median)')?.status).toBe('not-measured');
    // A failing static row wins over an unmeasured runtime.
    expect(evaluateBudget({ static: { ...staticOk, fileCount: 3_501 }, runtime: null }, tier).verdict).toBe('fail');
    expect(JSON.parse(JSON.stringify(over))).toEqual(over);
  });

  it('median takes the middle of an unsorted list and the mean of the middle two', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('measures a placed pack on the simulator: live entities after placement and per-tick script time', async () => {
    const grid = new BlockGrid(4, 2, 4);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) grid.set(x, 0, z, 'minecraft:white_concrete');
    const fig = minifigFromSpec({ torso: { part: '973', color: 4 } });
    const pack = await buildPlayableAddon(grid, {
      stem: 'plinth', label: 'Plinth', pbr: false, partGeometry: provider(),
      figures: [{ bricks: fig.bricks, x: 1, y: 1, z: 1, facingLdu: [0, -1] }],
    });
    const addon = await readAddon(pack.bytes, 'plinth');
    const m = await measureRuntime(addon, { ticks: 60, size: 100 });
    expect(m.ticks).toBe(60);
    expect(m.residentEntities).toBeGreaterThan(0);
    expect(m.placedCuboids).toBeGreaterThan(0);
    expect(m.scriptMsMedian).toBeGreaterThanOrEqual(0);
    expect(Object.values(m.entitiesByType).reduce((s, n) => s + n, 0)).toBe(m.residentEntities);
    // The static side of the same archive finds the same geometry the placed entities draw from.
    const stat = staticMeasure(addonFiles(addon));
    expect(stat.totalGeometryCuboids).toBeGreaterThanOrEqual(m.placedCuboids / m.residentEntities);
  }, 120_000);
});
