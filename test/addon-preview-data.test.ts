/**
 * The add-on walk's data layer (web/src/ui/addon-preview-data.ts): reading a
 * built `.mcaddon` back, the legend counts, the laid grid at a size (checked
 * against the engine's own ScaledColliderGrid), the reach overlay and the
 * highlight state. The real-pack cases run against the QA packs in
 * output/bedrock-entity-qa/ and skip when they are absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildAddonPreviewModel, classifyAddonEntity, columnBoxes, defaultLegendState, entitySpawnsAt, extractJsonAfter,
  laidColliderBlocks, legendCounts, loadAddonPreviewModel, placedPoint, reachOverlay, recommendedSize, toggleLegend, treadBlocksAt,
  type AddonPreviewModel,
} from '../web/src/ui/addon-preview-data.js';
import { ScaledColliderGrid, type SourceCell } from '../web/src/engine/bedrock-collider-scale.js';
import { encodeColliderRuns, encodeTreadPlan } from '../web/src/engine/bedrock-placement-pack.js';

const PACK_10303 = 'output/bedrock-entity-qa/10303-owncars.mcaddon';
const PACK_10261 = 'output/bedrock-entity-qa/10261-owncars.mcaddon';
const havePacks = existsSync(PACK_10303) && existsSync(PACK_10261);

const readPack = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('extractJsonAfter', () => {
  it('takes the balanced literal after the marker, braces inside strings included', () => {
    const src = 'import x;\nconst CONFIG = {"a":"}{][","b":[1,{"c":"\\"}"}],"d":{"e":1}};\nconst other = {"z":1};';
    expect(extractJsonAfter(src, 'const CONFIG')).toEqual({ a: '}{][', b: [1, { c: '"}' }], d: { e: 1 } });
    expect(extractJsonAfter(src, 'const other')).toEqual({ z: 1 });
    expect(extractJsonAfter(src, 'const missing')).toBeUndefined();
  });
});

describe('classifyAddonEntity', () => {
  const roles = { 'craftmatic:c_x_coaster_lift_1': 'platform', 'craftmatic:c_x_coaster_counterweight_1': 'counterweight', 'craftmatic:c_x_coaster_vehicle_1': 'car' };
  it('reads the suffix and the coaster role table', () => {
    expect(classifyAddonEntity('craftmatic:b_10303_shell', {}, roles)).toBe('shell');
    expect(classifyAddonEntity('craftmatic:f_10303_fig3', {}, roles)).toBe('figure');
    expect(classifyAddonEntity('craftmatic:colosseum_fig1', {}, roles)).toBe('figure');
    expect(classifyAddonEntity('craftmatic:s_10261_seat', {}, roles)).toBe('seat');
    expect(classifyAddonEntity('craftmatic:chalet_door_leaf_2', {}, roles)).toBe('door');
    expect(classifyAddonEntity('craftmatic:c_x_coaster_lift_1', {}, roles)).toBe('lift');
    expect(classifyAddonEntity('craftmatic:c_x_coaster_counterweight_1', {}, roles)).toBe('counterweight');
    expect(classifyAddonEntity('craftmatic:c_x_coaster_vehicle_1', { coasterRouteIndex: 0 }, roles)).toBe('car');
    expect(classifyAddonEntity('craftmatic:c_x_coaster_cart', {}, {})).toBe('car');
    expect(classifyAddonEntity('craftmatic:v_42110_car', {}, {})).toBe('vehicle');
    expect(classifyAddonEntity('craftmatic:s_x_screen', {}, {})).toBe('screen');
  });
});

/** A 4×3×4 grid: a floor slab, a one-block step, and a three-block wall. */
function synthetic(): { cells: SourceCell[]; dims: { width: number; height: number; length: number } } {
  const dims = { width: 4, height: 4, length: 4 };
  const cells: SourceCell[] = [];
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) cells.push({ x, y: 0, z, lo: 0, hi: 16 }); // floor, full block
  cells.push({ x: 1, y: 1, z: 1, lo: 0, hi: 8 }); // a half step on the floor
  for (let y = 1; y < 4; y++) cells.push({ x: 3, y, z: 3, lo: 0, hi: 16 }); // a wall column, tops out of reach
  return { cells, dims };
}

function syntheticModel(): AddonPreviewModel {
  const { cells, dims } = synthetic();
  const grid = new Map<string, string>();
  for (const c of cells) grid.set(`${c.x},${c.y},${c.z}`, `craftmatic:collider[lo=${c.lo},hi=${c.hi}]`);
  const { runs, keptCells } = encodeColliderRuns({ ...dims, get: (x, y, z) => grid.get(`${x},${y},${z}`) ?? 'minecraft:air' }, 'craftmatic:collider');
  const placement = `const CONFIG = ${JSON.stringify({
    id: 'synthetic', label: 'Synthetic', ...dims,
    actors: [
      { typeId: 'craftmatic:b_synthetic_shell', label: 'Synthetic bricks', x: 2, y: 5, z: 2, yaw: 0 },
      { typeId: 'craftmatic:f_synthetic_fig1', label: 'figure 1', x: 0.5, y: 1, z: 0.5, yaw: 90 },
      { typeId: 'craftmatic:f_synthetic_fig2', label: 'figure 2', x: 2.5, y: 1, z: 2.5, yaw: 0, rideOf: 3 },
      { typeId: 'craftmatic:s_synthetic_seat', label: 'Seat (4079)', x: 2.5, y: 1.2, z: 2.5, yaw: 0 },
      { typeId: 'craftmatic:synthetic_door_leaf_1', label: 'door leaf', x: 1, y: 1, z: 3, yaw: 0, maxSizeExclusive: 200, doorCandidateIndex: 0 },
    ],
    colliders: { ...dims, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs, keptCells,
      treads: { plans: { '200:0': encodeTreadPlan([{ x: 5, y: 2, z: 5, lo: 0, hi: 8 }]) }, counts: { '200:0': 1 } } },
    runtimeDoorCandidates: [{ x: 1, y: 1, z: 3, requiredSize: 200, lower: { id: 'minecraft:wooden_door', states: {} }, upper: { id: 'minecraft:wooden_door', states: {} } }],
    access: { sizePct: 150, reason: 'measured on the synthetic set.' },
    sizes: [25, 50, 75, 100, 150, 200, 300, 400],
  })};\n`;
  const coaster = `const CONFIG = ${JSON.stringify({
    typeId: 'craftmatic:c_synthetic_coaster_cart',
    routes: [{ label: 'Track 1', path: { points: [[0, 1, 0], [3, 1, 0], [3, 1, 3]], closed: false, length: 6 }, station: { start: 0, end: 2, stop: 1, point: [1, 1, 0] } }],
    types: { 'craftmatic:c_synthetic_coaster_cart': { role: 'car', riders: 0 } },
  })};\n`;
  return buildAddonPreviewModel({ placementScript: placement, coasterScript: coaster });
}

describe('buildAddonPreviewModel (synthetic pack)', () => {
  const model = syntheticModel();
  it('reads dims, cells, actors, doors, routes and the access record', () => {
    expect(model.dims).toEqual({ width: 4, height: 4, length: 4 });
    expect(model.cells).toHaveLength(16 + 1 + 3);
    expect(model.entities.map(e => e.kind)).toEqual(['shell', 'figure', 'figure', 'seat', 'door']);
    expect(model.doorCandidates).toEqual([{ x: 1, y: 1, z: 3, requiredSize: 200 }]);
    expect(model.routes).toHaveLength(1);
    expect(model.routes[0]!.cumulative).toEqual([0, 3, 6]); // computed: the script carried none
    expect(model.routes[0]!.station?.stop).toBe(1);
    expect(recommendedSize(model)).toEqual({ sizePct: 150, reason: 'measured on the synthetic set.' });
    expect(model.notes.some(n => /diagnostics/.test(n))).toBe(true); // said, not dropped
  });
  it('counts the legend per row', () => {
    const c = legendCounts(model, 100, 0);
    expect(c.figure).toBe(2);
    expect(c.detail.figure).toBe('1 seated');
    expect(c.seat).toBe(1);
    expect(c.door).toBe(2); // the leaf and the vanilla candidate
    expect(c.track).toBe(1);
    expect(c.vehicle).toBe(0);
    expect(c.collider).toBe(20);
    expect(c.tread).toBe(0);
    expect(legendCounts(model, 200, 0).tread).toBe(1);
    expect(legendCounts(model, 200, 90).tread).toBe(0);
  });
  it('retires the door leaf at the size its candidate hangs', () => {
    const leaf = model.entities.find(e => e.kind === 'door')!;
    expect(entitySpawnsAt(leaf, 150)).toBe(true);
    expect(entitySpawnsAt(leaf, 200)).toBe(false);
  });
});

describe('laidColliderBlocks', () => {
  const { cells, dims } = synthetic();
  it('is the source grid itself at 100 %', () => {
    const { blocks, dims: laid } = laidColliderBlocks(cells, dims, 100, 0);
    expect(laid).toEqual(dims);
    expect(blocks).toHaveLength(cells.length);
    const step = blocks.find(b => b.x === 1 && b.y === 1 && b.z === 1)!;
    expect([step.lo, step.hi]).toEqual([0, 8]);
  });
  it.each([[150, 0], [200, 90], [300, 180], [400, 270]] as const)('matches the engine\'s ScaledColliderGrid at %i %% turn %i', (pct, r) => {
    const { blocks } = laidColliderBlocks(cells, dims, pct, r);
    const expected = new ScaledColliderGrid(cells, dims, pct / 100, r).allBlocks();
    const mine = new Map(blocks.map(b => [`${b.x},${b.y},${b.z}`, [b.lo, b.hi]]));
    expect(mine.size).toBe(expected.size);
    for (const [k, v] of expected) expect(mine.get(k), k).toEqual(v);
  });
  it('shares blocks between cells below 100 % with min lo / max hi', () => {
    const { blocks, dims: laid } = laidColliderBlocks(cells, dims, 50, 0);
    expect(laid).toEqual({ width: 2, height: 2, length: 2 });
    // The floor's 16 cells become 4 blocks of half height; the half step (1,1,1) lands in row 0 of block (0,0,0) and lifts its hi to 12; the wall's base lifts (1,0,1) to 16.
    const floor = blocks.filter(b => b.y === 0);
    expect(floor).toHaveLength(4);
    expect(floor.map(b => [b.x, b.z, b.lo, b.hi])).toEqual([[0, 0, 0, 12], [0, 1, 0, 8], [1, 0, 0, 8], [1, 1, 0, 16]]);
    // The three-block wall (y 1..3 at 100 %) covers rows 0..1 at 50 %.
    const wall = blocks.filter(b => b.x === 1 && b.z === 1);
    expect(wall.map(b => [b.y, b.lo, b.hi])).toEqual([[0, 0, 16], [1, 0, 16]]);
  });
  it('lets a tread replace the block it lands on', () => {
    const { blocks } = laidColliderBlocks(cells, dims, 200, 0, [{ x: 2, y: 2, z: 2, lo: 0, hi: 8 }, { x: 99, y: 0, z: 0, lo: 0, hi: 8 }]);
    const t = blocks.filter(b => b.tread);
    expect(t).toEqual([{ x: 2, y: 2, z: 2, lo: 0, hi: 8, tread: true }]); // the out-of-footprint one is dropped
  });
});

describe('columnBoxes', () => {
  it('merges full blocks stacked in a column and keeps partial blocks and treads apart', () => {
    const boxes = columnBoxes([
      { x: 0, y: 0, z: 0, lo: 0, hi: 16, tread: false }, { x: 0, y: 1, z: 0, lo: 0, hi: 16, tread: false }, { x: 0, y: 2, z: 0, lo: 0, hi: 8, tread: false },
      { x: 0, y: 4, z: 0, lo: 0, hi: 16, tread: false }, { x: 0, y: 5, z: 0, lo: 0, hi: 16, tread: true },
      { x: 1, y: 0, z: 0, lo: 8, hi: 16, tread: false }, { x: 1, y: 1, z: 0, lo: 0, hi: 16, tread: false },
    ]);
    expect(boxes).toEqual([
      { x: 0, z: 0, y0: 0, y1: 2, tread: false }, { x: 0, z: 0, y0: 2, y1: 2.5, tread: false },
      { x: 0, z: 0, y0: 4, y1: 5, tread: false }, { x: 0, z: 0, y0: 5, y1: 6, tread: true },
      { x: 1, z: 0, y0: 0.5, y1: 2, tread: false }, // a full block on a partial one that reaches 16 joins it
    ]);
  });
});

describe('reachOverlay', () => {
  const { cells, dims } = synthetic();
  it('marks the floor and the half step reached and the wall top unreached at 100 %', () => {
    const r = reachOverlay(cells, dims, 100, 0)!;
    expect(r).not.toBeNull();
    const at = (x: number, z: number, t: number) => r.surfaces.find(s => s.x === x && s.z === z && s.t === t);
    expect(at(0, 0, 16)?.reached).toBe(true);
    expect(at(1, 1, 24)?.reached).toBe(true); // the half step: floor 16 + 8
    expect(at(3, 3, 64)?.reached).toBe(false); // three blocks up from the floor: past a jump
    expect(r.unreachedSurfaces).toBe(1);
    expect(r.reachedColumns).toBe(15); // the wall column's floor top has no headroom
    expect(r.highestBlocks).toBe(1.5);
  });
  it('is null below 100 %, where the scaled grid does not apply', () => {
    expect(reachOverlay(cells, dims, 75, 0)).toBeNull();
  });
  it('lets a tread restore a rise the size broke', () => {
    // At 200 % the floor slab is a two-block cliff from the ground: nothing on it is reached bare.
    const bare = reachOverlay(cells, dims, 200, 0)!;
    expect(bare.reachedSurfaces).toBe(0);
    // One tread cutting the corner block down to a jump's height (20/16) opens the whole floor.
    const with1 = reachOverlay(cells, dims, 200, 0, [{ x: 0, y: 1, z: 0, lo: 0, hi: 4 }])!;
    expect(with1.surfaces.some(s => s.x === 0 && s.z === 0 && s.t === 20 && s.reached)).toBe(true);
    expect(with1.reachedSurfaces).toBe(60); // 56 floor tops with headroom + the 4 step tops; the 4 wall tops stay out of reach
    expect(with1.unreachedSurfaces).toBe(4);
  });
});

describe('legend state and placement', () => {
  it('toggles without mutating', () => {
    const a = defaultLegendState();
    const b = toggleLegend(a, 'door', 'highlight');
    expect(a.door.highlight).toBe(false);
    expect(b.door.highlight).toBe(true);
    expect(b.door.show).toBe(true);
    expect(toggleLegend(b, 'door', 'show').door).toEqual({ show: false, highlight: true });
  });
  it('places a model point as the wand does: turn, then scale', () => {
    const dims = { width: 10, height: 5, length: 4 };
    expect(placedPoint({ x: 1, y: 2, z: 3 }, dims, 200, 0)).toEqual({ x: 2, y: 4, z: 6 });
    expect(placedPoint({ x: 1, y: 2, z: 3 }, dims, 100, 90)).toEqual({ x: 1, y: 2, z: 1 });
    expect(placedPoint({ x: 1, y: 2, z: 3 }, dims, 100, 180)).toEqual({ x: 9, y: 2, z: 1 });
  });
});

describe.skipIf(!havePacks)('real QA packs', () => {
  it('10303 Loop Coaster: 8 figures, 5 ride entities (3 cars, a platform and its counterweight), one open track with a station and a lift', async () => {
    const m = await loadAddonPreviewModel(readPack(PACK_10303));
    expect(m.dims).toEqual({ width: 42, height: 44, length: 21 });
    expect(m.cells.length).toBeGreaterThan(4000);
    const c = legendCounts(m, 150, 0);
    expect(c.figure).toBe(8);
    expect(c.seat).toBe(0);
    expect(c.door).toBe(0);
    expect(c.track).toBe(1);
    expect(c.vehicle).toBe(5);
    expect(c.detail.vehicle).toBe('3 cars, 1 platform, 1 counterweight');
    expect(c.collider).toBe(m.cells.length);
    expect(c.tread).toBe(m.colliders!.treads!.counts['150:0']);
    expect(c.tread).toBeGreaterThan(0);
    const route = m.routes[0]!;
    expect(route.closed).toBe(false);
    expect(route.points.length).toBeGreaterThan(1000);
    expect(route.station?.stop).toBeCloseTo(20.29, 1);
    expect(route.lift?.travel[1]).toBeCloseTo(35.34, 2);
    expect(route.lift?.counterweightPoint).toBeDefined();
    expect(recommendedSize(m)?.sizePct).toBe(150);
    expect(m.accessDetail?.doorway?.count).toBe(149);
    expect(m.provenance?.source?.hash).toBe('df3b47c3c9f2');
    expect(m.treadReport?.plans.length).toBe(16);
    // Its laid grid at the recommended size matches the engine's, and the walk reaches something on it.
    const laid = laidColliderBlocks(m.cells, m.dims, 150, 0, treadBlocksAt(m, 150, 0));
    const expected = new ScaledColliderGrid(m.cells, m.dims, 1.5, 0).allBlocks();
    const treadKeys = new Set(treadBlocksAt(m, 150, 0).map(t => `${t.x},${t.y},${t.z}`));
    let checked = 0;
    for (const b of laid.blocks) {
      if (treadKeys.has(`${b.x},${b.y},${b.z}`)) continue;
      expect(expected.get(`${b.x},${b.y},${b.z}`), `${b.x},${b.y},${b.z}`).toEqual([b.lo, b.hi]);
      checked++;
    }
    expect(checked).toBeGreaterThan(10000);
    const r = reachOverlay(m.cells, m.dims, 150, 0, treadBlocksAt(m, 150, 0))!;
    expect(r.reachedSurfaces).toBeGreaterThan(0);
    expect(r.unreachedSurfaces).toBeGreaterThan(0);
  }, 60000);

  it('10261 Roller Coaster: 8 figures (one seated), one seat, 3 cars on a closed circuit, no lift', async () => {
    const m = await loadAddonPreviewModel(readPack(PACK_10261));
    expect(m.dims).toEqual({ width: 42, height: 25, length: 22 });
    const c = legendCounts(m, 100, 0);
    expect(c.figure).toBe(8);
    expect(c.detail.figure).toBe('1 seated');
    expect(c.seat).toBe(1);
    expect(c.door).toBe(0);
    expect(c.track).toBe(1);
    expect(c.vehicle).toBe(3);
    expect(c.detail.vehicle).toBe('3 cars');
    expect(c.tread).toBe(0);
    expect(legendCounts(m, 150, 0).tread).toBe(50);
    const route = m.routes[0]!;
    expect(route.closed).toBe(true);
    expect(route.length).toBeCloseTo(244.7, 0);
    expect(route.lift).toBeUndefined();
    expect(route.chain).toBeDefined();
    expect(recommendedSize(m)?.sizePct).toBe(100);
    const seat = m.entities.find(e => e.kind === 'seat')!;
    const rider = m.entities.find(e => e.kind === 'figure' && e.rideOf !== undefined)!;
    expect(m.entities[rider.rideOf!]).toBe(seat);
  }, 60000);
});
