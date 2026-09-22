/**
 * INVISIBLE STEPS WHERE SCALING BROKE A CLIMB - AND NOWHERE ELSE.
 *
 * A player stays player-sized at every wand size while a model's risers grow
 * with it, so a stair a minifig-scale player steps up at 100 % is a wall at
 * 300 %. `planColliderTreads` (bedrock-collider-scale.ts) lays invisible
 * collider treads to restore exactly the moves the 100 % grid allows. This
 * suite pins the three things the decision demands:
 *
 *  1. ONLY WHERE THE MODEL IMPLIES PASSAGE - a rise within the jump at 100 %.
 *     A plinth two blocks high in the open (a decorative ledge) gets nothing at
 *     any size; a stair and a jump-high platform do, once scaling breaks them.
 *  2. NEVER BLOCK - the reachable set with treads is a strict superset of the
 *     reachable set without them (a floor block that carries a tread is
 *     reachable at the tread's height), checked here INDEPENDENTLY of the
 *     planner's own verification by walking the emitted blocks. A doorway the
 *     walls leave open carries no tread and stays passable.
 *  3. AT 100 % NOTHING CHANGES - the planner emits nothing, the shipped runs
 *     and the wand's commands are byte-identical with the feature on and off.
 *
 * The runtime is driven as the SERIALIZED script the device runs (the shared
 * host), and its output is compared with the planner's own lay + plan.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '@craft/schem/types.js';
import {
  SIZE_STEPS, buildPlacementPackAssets, colliderSourceCells, decodeTreadPlan, encodeColliderRuns, encodeTreadPlan, treadBlocksFor, withColliderTreads,
  type PlacementColliders,
} from '../web/src/engine/bedrock-placement-pack.js';
import {
  GENTLE_HOP16, JUMP16, QUARTER_TURNS, ScaledColliderGrid, planColliderTreads, walkScaledColliders,
  type GridDims, type QuarterTurn, type SourceCell, type TreadBlock, type TreadPlan,
} from '../web/src/engine/bedrock-collider-scale.js';
import { COLLIDER_BLOCK_ID, COLLIDER_HI_STATE, COLLIDER_LO_STATE, colliderState } from '../web/src/engine/bedrock-building-shell.js';
import { host } from './_placement-host.js';

/** The pin the host's player uses (its `location`, floored). */
const ANCHOR = { x: 100, y: 64, z: 200 };
const PIN_AT_FEET = 1, ROTATE = 3, PLACE = 5, SIZE = 10;

const colliders = (dims: GridDims, runs: string): PlacementColliders =>
  ({ ...dims, block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE, runs, keptCells: 0 });

/** Set a column's solid from the floor up to `top16` sixteenths, cut into rows as the collider grid holds it. */
function solidTo(g: BlockGrid, x: number, z: number, top16: number): void {
  for (let row = 0; row * 16 < top16; row++) g.set(x, row, z, colliderState(0, Math.min(16, top16 - row * 16)));
}

/**
 * A two-storey house: a floor plate, walls with a doorway, a straight stair of
 * brick-high risers (7/16 = 0.44 blocks: a step at 100 %, a jump at 200 %, a
 * wall at 300 %) up to an upper floor under a roof. Ground-floor rooms sit
 * under the upper floor too, so headroom is exercised.
 */
function stairHouse(): { dims: GridDims; runs: string; upperTop16: number; stair: { z: number[]; x: number[]; tops: number[] }; door: { z: number } } {
  const dims = { width: 12, height: 6, length: 8 };
  const g = new BlockGrid(dims.width, dims.height, dims.length);
  for (let x = 0; x < 12; x++) for (let z = 0; z < 8; z++) {
    g.set(x, 0, z, colliderState(0, 3));                       // floor plate, top 3/16
    g.set(x, 5, z, colliderState(13, 16));                     // roof slab
    if (x === 0 || x === 11 || z === 0 || z === 7) for (let y = 0; y < 5; y++) g.set(x, y, z, colliderState(0, 16));
  }
  // The doorway: a vanilla door the scene kept (0 in the runs), on the floor plate.
  g.set(0, 1, 4, 'minecraft:oak_door[direction=1]');
  g.set(0, 2, 4, 'minecraft:oak_door[direction=1,upper_block_bit=1]');
  g.set(0, 0, 4, colliderState(0, 3));
  // The stair: cells x = 2..7 at z = 2..3, tops 10, 17, 24, 31, 38, 45 (risers of 7).
  const tops: number[] = [];
  for (let x = 2; x <= 7; x++) { const t = 3 + 7 * (x - 1); tops.push(t); for (const z of [2, 3]) solidTo(g, x, z, t); }
  // The upper floor: row 3, plate 0..3 (top 51), over x = 8..10, z = 1..6.
  for (let x = 8; x <= 10; x++) for (let z = 1; z <= 6; z++) g.set(x, 3, z, colliderState(0, 3));
  return { dims, runs: encodeColliderRuns(g, COLLIDER_BLOCK_ID).runs, upperTop16: 51, stair: { z: [2, 3], x: [2, 3, 4, 5, 6, 7], tops }, door: { z: 4 } };
}

/** A plinth two blocks high standing in the open: a rise no player climbs at 100 %. */
function plinth(): { dims: GridDims; runs: string } {
  const dims = { width: 8, height: 4, length: 8 };
  const g = new BlockGrid(dims.width, dims.height, dims.length);
  for (let x = 3; x <= 4; x++) for (let z = 3; z <= 4; z++) solidTo(g, x, z, 32);
  return { dims, runs: encodeColliderRuns(g, COLLIDER_BLOCK_ID).runs };
}

/** A platform 14/16 high (a two-brick riser, 0.875 blocks): a jump at 100 %, past the jump from 150 %. */
function platform(): { dims: GridDims; runs: string; top16: number } {
  const dims = { width: 10, height: 3, length: 10 };
  const g = new BlockGrid(dims.width, dims.height, dims.length);
  for (let x = 3; x <= 6; x++) for (let z = 3; z <= 6; z++) g.set(x, 0, z, colliderState(0, 14));
  return { dims, runs: encodeColliderRuns(g, COLLIDER_BLOCK_ID).runs, top16: 14 };
}

/** The scaled grid with a plan's blocks applied - what the runtime leaves in the world. */
function withPlan(cells: readonly SourceCell[], dims: GridDims, pct: number, r: QuarterTurn, blocks: readonly TreadBlock[]): ScaledColliderGrid {
  const grid = new ScaledColliderGrid(cells, dims, pct / 100, r);
  for (const b of blocks) grid.write(b.x, b.z, { row: b.y, lo: b.lo, hi: b.hi, src16: 0 });
  return grid;
}

/**
 * The never-block invariant, checked independently of the planner: walk the
 * bare grid and the grid with the plan's blocks; every surface reached bare
 * must be reached assisted, unless a tread now stands on that floor block.
 */
function assertNeverBlocks(cells: readonly SourceCell[], dims: GridDims, plan: TreadPlan): { bare: number; assisted: number } {
  const r = plan.rotation, f = plan.sizePct / 100;
  const bare = new ScaledColliderGrid(cells, dims, f, r), assisted = withPlan(cells, dims, plan.sizePct, r, plan.blocks);
  const before = walkScaledColliders(bare), after = walkScaledColliders(assisted);
  // Floor surfaces the runs converted: (column, floor top) per tread of each run.
  const replaced = new Set<number>();
  for (const run of plan.runs) for (const c of run.columns) replaced.add(bare.key(c.x, c.z, c.floor16));
  const lost: string[] = [];
  for (const k of before.visited) if (!after.visited.has(k) && !replaced.has(k)) { const s = bare.unkey(k); lost.push(`${s.x},${s.z}@${s.t}`); }
  expect(lost, `${plan.sizePct} % / ${r}°: surfaces reachable without treads but not with them`).toEqual([]);
  for (const run of plan.runs) expect(after.visited.has(assisted.key(run.to.x, run.to.z, run.to.t)), `restored surface ${run.to.x},${run.to.z}@${run.to.t} must be reachable`).toBe(true);
  // A refused edge is allowed only when its target is reached all the same (a parallel column of the same riser served it).
  for (const e of plan.refused) expect(after.visited.has(assisted.key(e.to.x, e.to.z, e.to.t)), `refused ${e.reason} edge to ${e.to.x},${e.to.z}@${e.to.t} left it unreachable`).toBe(true);
  if (plan.blocks.length) expect(after.surfaces).toBeGreaterThan(before.surfaces);
  else expect(after.surfaces).toBe(before.surfaces);
  return { bare: before.surfaces, assisted: after.surfaces };
}

/** The colliders the runtime wrote, keyed by offset from the pin. */
function placedColliders(blocks: Map<string, any>): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const [key, b] of blocks) {
    if (b.typeId !== COLLIDER_BLOCK_ID) continue;
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    out.set(`${x - ANCHOR.x},${y - ANCHOR.y},${z - ANCHOR.z}`, [Number(b.permutation.getState(COLLIDER_LO_STATE)), Number(b.permutation.getState(COLLIDER_HI_STATE))]);
  }
  return out;
}

/** Drive the shipped runtime at a size and turn; returns what it wrote and what it told the player. */
async function relay(dims: GridDims, runs: string, pct: number, rotation: number, treads: boolean) {
  const h = host({
    stem: `tr${pct}r${rotation}${treads ? 't' : 'b'}`, label: 'House', width: dims.width, height: dims.height, length: dims.length,
    tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: dims.width, height: dims.height, length: dims.length, nonAir: 1 }],
    actors: [], colliders: colliders(dims, runs), treads, settleTicks: 1, finalHoldTicks: 1,
  });
  await h.open({ selection: PIN_AT_FEET }, { canceled: true });
  for (let r = 0; r < rotation / 90; r++) await h.open({ selection: ROTATE }, { canceled: true });
  const steps = (SIZE_STEPS.indexOf(pct) - SIZE_STEPS.indexOf(100) + SIZE_STEPS.length) % SIZE_STEPS.length;
  for (let i = 0; i < steps; i++) await h.open({ selection: SIZE }, { canceled: true });
  await h.open({ selection: PLACE }, { selection: 0 });
  await h.flush(20000);
  expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placed House.'));
  const messages = (h.player.sendMessage.mock.calls as string[][]).map(c => c[0]!);
  return { placed: placedColliders(h.blocks), messages, commands: h.commands, actionBars: h.actionBars, assets: h.assets };
}

const diff = (want: Map<string, [number, number]>, got: Map<string, [number, number]>): string[] => {
  const out: string[] = [];
  for (const [k, v] of want) { const g = got.get(k); if (!g) out.push(`${k}: missing [${v}]`); else if (g[0] !== v[0] || g[1] !== v[1]) out.push(`${k}: want [${v}] got [${g}]`); }
  for (const k of got.keys()) if (!want.has(k)) out.push(`${k}: unexpected [${got.get(k)}]`);
  return out.slice(0, 20);
};

describe('the scaled grid is the runtime re-lay', () => {
  const house = stairHouse();
  const cells = colliderSourceCells({ ...house.dims, runs: house.runs });
  for (const pct of [150, 200, 300, 400]) for (const r of QUARTER_TURNS) {
    it(`${pct} % / ${r}°: the planner's lay equals what the shipped script writes`, async () => {
      const { placed } = await relay(house.dims, house.runs, pct, r, false);
      const lay = new ScaledColliderGrid(cells, house.dims, pct / 100, r).allBlocks();
      expect(diff(lay, placed)).toEqual([]);
    });
  }
});

describe('the rule: treads only where the 100 % grid allows the move, and only once scaling broke it', () => {
  const house = stairHouse();
  const cells = colliderSourceCells({ ...house.dims, runs: house.runs });

  it('100 %: the walk climbs the stair to the upper floor and the planner emits nothing', () => {
    for (const r of QUARTER_TURNS) {
      const plan = planColliderTreads(cells, house.dims, 100, r);
      expect(plan.blocks).toEqual([]);
      expect(plan.runs).toEqual([]);
      expect(plan.before.highest16).toBe(house.upperTop16);
      expect(plan.after).toEqual(plan.before);
    }
  });

  it('150 % and 200 %: the risers are still a jump, so nothing is laid and the upper floor is reached bare', () => {
    for (const pct of [150, 200]) {
      const plan = planColliderTreads(cells, house.dims, pct, 0);
      expect(plan.blocks, `${pct} %`).toEqual([]);
      expect(plan.before.highest16).toBe(Math.ceil(house.upperTop16 * pct / 100));
    }
  });

  for (const pct of [300, 400]) for (const r of QUARTER_TURNS) {
    it(`${pct} % / ${r}°: the stair is a wall bare and climbable with treads, in half-block hops, and nothing reachable is lost`, () => {
      const plan = planColliderTreads(cells, house.dims, pct, r);
      const f = pct / 100;
      const upper = Math.ceil(house.upperTop16 * f);
      expect(plan.before.highest16, 'bare: the upper floor is out of reach').toBeLessThan(upper);
      expect(plan.after.highest16, 'with treads: the upper floor is reached').toBe(upper);
      expect(plan.verified).toBe(true);
      expect(plan.blocks.length).toBeGreaterThan(0);
      expect(plan.runs.length).toBeGreaterThanOrEqual(house.stair.tops.length - 1);
      // Every run restores a rise within the jump at 100 % that is past it here. The stair's own risers (a
      // step at 100 %) get half-block hops - their cells are wide enough - and no hop anywhere exceeds a jump.
      for (const run of plan.runs) {
        expect(run.rise100).toBeLessThanOrEqual(1.25);
        expect(run.rise * 16).toBeGreaterThan(JUMP16);
        expect(run.hop16).toBeLessThanOrEqual(JUMP16);
        if (run.rise100 <= 0.5) expect(run.hop16, `stair riser ${run.from.x},${run.from.z} -> ${run.to.x},${run.to.z}`).toBeLessThanOrEqual(GENTLE_HOP16);
        expect(run.treads).toBeGreaterThanOrEqual(1);
      }
      // No run was refused for headroom, and none had to be reverted: the fast path verified as laid.
      expect(plan.unrestored.headroom).toBe(0);
      expect(plan.unrestored.verify).toBe(0);
      assertNeverBlocks(cells, house.dims, plan);
    });
  }

  it('the doorway carries no tread and the ground floor stays reachable through it at every size', () => {
    for (const pct of [300, 400]) {
      const plan = planColliderTreads(cells, house.dims, pct, 0);
      const f = pct / 100;
      const doorColumns = new ScaledColliderGrid(cells, house.dims, f, 0);
      // The door cell (0, z=4) at this size: its columns; none may hold a tread block.
      const zs: number[] = [];
      for (let z = 0; z < doorColumns.length; z++) if (Math.floor((z + 0.5) / f) === house.door.z) zs.push(z);
      const xs: number[] = [];
      for (let x = 0; x < doorColumns.width; x++) if (Math.floor((x + 0.5) / f) === 0) xs.push(x);
      for (const b of plan.blocks) expect(xs.includes(b.x) && zs.includes(b.z), `tread in the doorway at ${b.x},${b.y},${b.z} (${pct} %)`).toBe(false);
      // The ground floor (plate top 3/16 × f) inside is reached bare and with treads.
      const assisted = withPlan(cells, house.dims, pct, 0, plan.blocks);
      const reach = walkScaledColliders(assisted);
      const plateTop = Math.ceil(3 * f);
      const inside = { x: Math.floor(1.5 * f), z: Math.floor(4.5 * f) };
      expect(reach.visited.has(assisted.key(inside.x, inside.z, plateTop)), `ground floor reachable at ${pct} %`).toBe(true);
    }
  });

  it('a plinth two blocks high in the open - a rise no player climbs at 100 % - gets nothing at any size', () => {
    const p = plinth();
    const pc = colliderSourceCells({ ...p.dims, runs: p.runs });
    for (const pct of [100, 150, 200, 300, 400]) for (const r of QUARTER_TURNS) {
      const plan = planColliderTreads(pc, p.dims, pct, r);
      expect(plan.blocks, `${pct} % / ${r}°`).toEqual([]);
      expect(plan.unrestored).toEqual({ 'no-run': 0, headroom: 0, verify: 0 });
      expect(plan.after.highest16).toBe(0);
    }
  });

  it('a platform a player jumps onto at 100 % is restored from 150 % up, with treads on the ground before it', () => {
    const p = platform();
    const pc = colliderSourceCells({ ...p.dims, runs: p.runs });
    expect(planColliderTreads(pc, p.dims, 100, 0).before.highest16).toBe(p.top16);
    for (const pct of [150, 200, 300, 400]) for (const r of QUARTER_TURNS) {
      const plan = planColliderTreads(pc, p.dims, pct, r);
      const top = Math.ceil(p.top16 * pct / 100);
      expect(plan.before.highest16, `${pct} % bare`).toBe(0);
      expect(plan.after.highest16, `${pct} % with treads`).toBe(top);
      expect(plan.verified).toBe(true);
      // Treads stand on the ground (row 0 upward, solid from the floor), never above the platform.
      for (const b of plan.blocks) { expect(b.y * 16 + b.hi).toBeLessThan(top); expect(b.y === 0 ? b.lo : 0).toBe(0); }
      assertNeverBlocks(pc, p.dims, plan);
    }
  });
});

describe('the pack ships the treads and the runtime lays them', () => {
  const house = stairHouse();
  const cells = colliderSourceCells({ ...house.dims, runs: house.runs });

  it('encodes a plan as 7 chars per block and decodes it back', () => {
    const blocks: TreadBlock[] = [{ x: 0, y: 0, z: 0, lo: 0, hi: 1 }, { x: 1234, y: 57, z: 39999, lo: 3, hi: 16 }, { x: 199, y: 200, z: 201, lo: 15, hi: 16 }];
    const code = encodeTreadPlan(blocks);
    expect(code.length).toBe(21);
    expect(decodeTreadPlan(code)).toEqual(blocks);
    expect(JSON.parse(JSON.stringify({ code })).code).toBe(code);
  });

  it('withColliderTreads attaches a plan per size and turn that needs one, and reports every combination', () => {
    const { colliders: c, report } = withColliderTreads(colliders(house.dims, house.runs));
    expect(report.plans.length).toBe(4 * 4);
    expect(report.rule).toMatch(/1\.25-block jump/);
    const keys = Object.keys(c.treads!.plans).sort();
    expect(keys).toEqual(['300:0', '300:180', '300:270', '300:90', '400:0', '400:180', '400:270', '400:90']);
    for (const k of keys) expect(c.treads!.counts[k]).toBe(decodeTreadPlan(c.treads!.plans[k]!).length);
    expect(keys.some(k => k.startsWith('100:') || k.startsWith('150:') || k.startsWith('200:'))).toBe(false);
    for (const p of report.plans) {
      expect(p.verified).toBe(true);
      if (p.sizePct >= 300) { expect(p.blocks).toBeGreaterThan(0); expect(p.after.highestBlocks).toBeGreaterThan(p.before.highestBlocks); }
      else expect(p.blocks).toBe(0);
    }
  });

  for (const pct of [300, 400]) for (const r of [0, 90] as const) {
    it(`${pct} % / ${r}°: the shipped script writes the lay plus the plan, and tells the player how many steps it added`, async () => {
      const { placed, messages, actionBars } = await relay(house.dims, house.runs, pct, r, true);
      const { colliders: c } = withColliderTreads(colliders(house.dims, house.runs));
      const blocks = treadBlocksFor(c, pct, r);
      expect(blocks.length).toBeGreaterThan(0);
      const want = withPlan(cells, house.dims, pct, r, blocks).allBlocks();
      expect(diff(want, placed)).toEqual([]);
      expect(messages.some(m => new RegExp(`${blocks.length} invisible steps? added`).test(m))).toBe(true);
      expect(actionBars.some(a => a.includes(`${blocks.length} invisible steps added`))).toBe(true);
      // The treads are reachable in what was actually written: walk the placed blocks.
      const placedCells: SourceCell[] = [];
      for (const [k, [lo, hi]] of placed) { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; placedCells.push({ x, y, z, lo, hi }); }
      const dimsAt = { width: Math.ceil((r % 180 ? house.dims.length : house.dims.width) * pct / 100), height: Math.ceil(house.dims.height * pct / 100), length: Math.ceil((r % 180 ? house.dims.width : house.dims.length) * pct / 100) };
      const reach = walkScaledColliders(new ScaledColliderGrid(placedCells, dimsAt, 1, 0));
      expect(reach.highest16).toBe(Math.ceil(house.upperTop16 * pct / 100));
    });
  }

  it('200 %: no steps are needed, none are laid, and the player is not told about any', async () => {
    const { placed, messages } = await relay(house.dims, house.runs, 200, 0, true);
    expect(diff(new ScaledColliderGrid(cells, house.dims, 2, 0).allBlocks(), placed)).toEqual([]);
    expect(messages.some(m => /invisible step/.test(m))).toBe(false);
  });

  it('100 %: the runs, the tiles and the wand\'s commands are byte-identical with treads on and off', async () => {
    const spec = {
      stem: 'identity', label: 'House', width: house.dims.width, height: house.dims.height, length: house.dims.length,
      tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: house.dims.width, height: house.dims.height, length: house.dims.length, nonAir: 1 }],
      actors: [], colliders: colliders(house.dims, house.runs), settleTicks: 1, finalHoldTicks: 1,
    };
    const on = buildPlacementPackAssets(spec), off = buildPlacementPackAssets({ ...spec, treads: false });
    const config = (a: typeof on) => JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(a.script)![1]!);
    const cOn = config(on), cOff = config(off);
    expect(cOn.colliders.runs).toBe(cOff.colliders.runs);
    expect(cOn.tiles).toEqual(cOff.tiles);
    expect(cOff.colliders.treads).toBeUndefined();
    expect(Object.keys(cOn.colliders.treads.plans).some(k => k.startsWith('100:'))).toBe(false);
    expect(on.treads).toBeDefined();
    expect(off.treads).toBeUndefined();
    expect(off.files.some(f => f.name === 'craftmatic-treads.json')).toBe(false);
    expect(on.files.some(f => f.name === 'craftmatic-treads.json')).toBe(true);
    // At 100 % the runtime loads the structure tiles; the command stream is the same either way.
    const a = await relay(house.dims, house.runs, 100, 0, true), b = await relay(house.dims, house.runs, 100, 0, false);
    expect(a.commands).toEqual(b.commands);
    expect(a.placed).toEqual(b.placed);
    expect(a.messages.some(m => /invisible step/.test(m))).toBe(false);
  });
});

/**
 * A real set: the chalet's collider grid from the pipeline (needs the clego
 * corpus; skips without it). Every plan must verify, and the sizes at which
 * the bare walk loses height must gain it back.
 */
const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const SET_FILE = 'C:/git/clego/lego_sets/DbixConvV3/910004.ldr';
const HAVE_CORPUS = existsSync(LDRAW_ROOT) && existsSync(SET_FILE);

describe.skipIf(!HAVE_CORPUS)('treads on a real set (910004 Winter Chalet)', () => {
  it('every plan verifies, the pack ships them, and no size reaches less with treads than without', async () => {
    const { parseLDrawDocument, embeddedPartTexts } = await import('../web/src/engine/ldraw-parser.js');
    const { seedDatTexts, setLDrawRoot } = await import('../web/src/engine/ldraw-geometry.js');
    const { runSchemPipeline } = await import('../web/src/engine/schem-pipeline.js');
    const { extractFile, listZipEntries } = await import('../web/src/engine/zip-utils.js');
    const { LDU_PER_BLOCK } = await import('../web/src/engine/lego-scale.js');
    setLDrawRoot(LDRAW_ROOT);
    const doc = parseLDrawDocument(readFileSync(SET_FILE, 'utf8'));
    seedDatTexts(embeddedPartTexts(doc));
    const result = await runSchemPipeline({
      source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
      format: 'mcaddon', packStem: 'Set910004', packLabel: 'Winter Chalet (910004)', profile: 'default', modelScale: 1,
      lightFill: false, shapes: false, vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced',
    });
    const bytes = result.bytes!;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const entries = listZipEntries(buffer);
    const script = new TextDecoder().decode(await extractFile(buffer, entries.find(e => e.endsWith('scripts/placement.js'))!));
    const config = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(script)![1]!);
    expect(config.colliders).toBeTruthy();
    const report = JSON.parse(new TextDecoder().decode(await extractFile(buffer, entries.find(e => e.endsWith('craftmatic-treads.json'))!)));
    expect(report.plans.length).toBe(16);
    const lines: string[] = [];
    for (const p of report.plans) {
      expect(p.verified, `${p.sizePct} % / ${p.rotation}°`).toBe(true);
      expect(p.after.highestBlocks).toBeGreaterThanOrEqual(p.before.highestBlocks);
      expect(p.after.surfaces).toBeGreaterThanOrEqual(p.before.surfaces);
      if (p.rotation === 0) lines.push(`  ${p.sizePct} %: highest ${p.before.highestBlocks} -> ${p.after.highestBlocks} blocks (at 100 %), surfaces ${p.before.surfaces} -> ${p.after.surfaces}, ${p.blocks} tread blocks in ${p.runs.length} runs, unrestored ${JSON.stringify(p.unrestored)}`);
      const key = `${p.sizePct}:${p.rotation}`;
      if (p.blocks) expect(config.colliders.treads.counts[key]).toBe(p.blocks);
      else expect(config.colliders.treads?.plans?.[key]).toBeUndefined();
    }
    console.log(`treads on 910004 (${config.colliders.width}×${config.colliders.height}×${config.colliders.length} cells):\n${lines.join('\n')}`);
  }, 600_000);
});
