/**
 * Clearance (web/src/engine/collider-clearance.ts, collider-form.ts): the
 * invisible colliders pulled back to the model's own geometry, only where
 * that is certain. Each rule is pinned on a small synthetic grid built the way
 * `buildColliderGrid` builds one (a full collider over the cell's geometry
 * span, plus the geometry as layer footprints), so every test fails if its
 * rule is removed:
 *
 *   - a trim never reduces free space and always contains the geometry;
 *   - a trim that would open an enclosed room to the outside is refused (the leak check);
 *   - a closed leaf's frame sliver is never trimmed (no slot beside a closed door);
 *   - a too-low ceiling is raised only where a sneaking player already fits and the part keeps a slab;
 *   - a standing surface keeps its full top (floors stay);
 *   - the forms re-lay at every wand size inside the full cell they replace, and a
 *     player walks a corridor the full colliders sealed.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { COLLIDER_KIT, type Box16, type ColliderForm } from '../web/src/engine/collider-form.js';
import {
  LeakFlood, addLayerBox, applyColliderClearance, formContains, formState, formWithin, layerBoxes, newCellLayers, parseFormState,
  type CellLayers, type ClearanceInput,
} from '../web/src/engine/collider-clearance.js';
import { colliderState } from '../web/src/engine/bedrock-building-shell.js';
import { ixWorldBlocks } from '../web/src/engine/bedrock-interactives.js';
import { colliderSourceCells, encodeColliderRuns, withColliderTreads, SIZE_STEPS } from '../web/src/engine/bedrock-placement-pack.js';
import { WalkWorld, tickPlayer, type PlayerState } from '../web/src/engine/addon-walk.js';
import { QUARTER_TURNS } from '../web/src/engine/bedrock-collider-scale.js';
import { blockSpan } from '../web/src/engine/bedrock-figure-life.js';

const K = COLLIDER_KIT;

/** A synthetic collider grid: `solid` lays a cell from its geometry boxes (sixteenths), as buildColliderGrid does. */
function scene(W: number, H: number, L: number) {
  const grid = new BlockGrid(W, H, L);
  const layers: CellLayers = new Map();
  const idx = (x: number, y: number, z: number): number => (x * H + y) * L + z;
  const solid = (x: number, y: number, z: number, boxes: Box16[]): void => {
    const a = newCellLayers();
    for (const b of boxes) addLayerBox(a, b[0], b[1], b[2], b[3], b[4], b[5]);
    layers.set(idx(x, y, z), a);
    grid.set(x, y, z, colliderState(Math.min(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))));
  };
  const full = (x: number, y: number, z: number): void => solid(x, y, z, [[0, 16, 0, 16, 0, 16]]);
  const input = (extra: Partial<ClearanceInput> = {}): ClearanceInput => ({ grid, layers, leaves: [], closedCells: [], ...extra });
  const form = (x: number, y: number, z: number): ColliderForm | null => parseFormState(grid.get(x, y, z));
  return { grid, layers, idx, solid, full, input, form };
}

/** Cells (padded by one block) a flying sneaking 0.5-wide player reaches from outside, over a grid as it stands. */
function reachable(grid: BlockGrid, closed: ReadonlyArray<readonly number[]> = []): (x: number, y: number, z: number) => boolean {
  const f = new LeakFlood(grid.width, grid.height, grid.length);
  for (let x = 0; x < grid.width; x++) for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) {
    const fm = parseFormState(grid.get(x, y, z));
    if (fm) for (const b of K.formBoxes(fm.v, fm.lo, fm.hi)) f.solid16(x, y, z, b);
  }
  for (const c of closed) f.solid16(c[0]!, c[1]!, c[2]!, [0, 16, c[3]!, c[4]!, 0, 16]);
  const cells = f.reach();
  const PH = grid.height + 2, PL = grid.length + 2;
  return (x, y, z) => cells[((x + 1) * PH + y) * PL + (z + 1)] === 1;
}

describe('collider forms (collider-form.ts)', () => {
  it('43 block ids in the craftmatic namespace, the full collider first, shapes closed under the quarter turns', () => {
    expect(K.VARIANTS.length).toBe(43);
    expect(K.VARIANTS[0]!.id).toBe('craftmatic:collider');
    for (let v = 1; v < K.VARIANTS.length; v++) for (const r of QUARTER_TURNS) {
      const t = K.turnForm({ v, lo: 3, hi: 12 }, r);
      const a = K.formBoxes(t.v, t.lo, t.hi).map(b => (b[1] - b[0]) * (b[5] - b[4]) * (b[3] - b[2])).reduce((p, q) => p + q, 0);
      const b = K.formBoxes(v, 3, 12).map(q => (q[1] - q[0]) * (q[5] - q[4]) * (q[3] - q[2])).reduce((p, q) => p + q, 0);
      expect(a).toBe(b); // a turn maps a shape onto a shape of the same area, never a bigger one
    }
  });

  it('cover contains every box and never exceeds the full cell over their span (2,000 random cells)', () => {
    let seed = 7;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let t = 0; t < 2000; t++) {
      const boxes: Box16[] = [];
      for (let k = 0; k < 1 + rnd(4); k++) {
        const x0 = rnd(16), y0 = rnd(16), z0 = rnd(16);
        boxes.push([x0, x0 + 1 + rnd(16 - x0), y0, y0 + 1 + rnd(16 - y0), z0, z0 + 1 + rnd(16 - z0)]);
      }
      const form = K.cover(boxes)!;
      const lo = Math.min(...boxes.map(b => b[2])), hi = Math.max(...boxes.map(b => b[3]));
      expect(formContains(form, boxes)).toBe(true);
      expect(formWithin(form, { v: 0, lo, hi })).toBe(true);
    }
  });

  it('a full cell lays exactly what the re-lay always laid, at every size and turn', () => {
    const dims = { width: 5, height: 4, length: 3 };
    for (const pct of SIZE_STEPS) for (const r of QUARTER_TURNS) {
      const f = pct / 100;
      const got = ixWorldBlocks([[2, 1, 1, 3, 13]], dims, f, r, K);
      // The old arithmetic, verbatim (cellColumns + per-row sixteenths).
      const cols = (i: number): [number, number] => { const a = i * f, b = (i + 1) * f; return f < 1 ? [Math.floor(a), Math.max(Math.floor(a), Math.ceil(b) - 1)] : [Math.ceil(a - 0.5), Math.max(Math.ceil(a - 0.5), Math.ceil(b - 0.5) - 1)]; };
      const rc = r === 90 ? { x: dims.length - 1 - 1, z: 2 } : r === 180 ? { x: dims.width - 1 - 2, z: dims.length - 1 - 1 } : r === 270 ? { x: 1, z: dims.width - 1 - 2 } : { x: 2, z: 1 };
      const want = new Map<string, [number, number]>();
      const wy0 = (1 + 3 / 16) * f, wy1 = (1 + 13 / 16) * f;
      for (let wy = Math.floor(wy0); wy < Math.ceil(wy1); wy++) {
        const l = Math.max(0, Math.min(15, Math.floor((wy0 - wy) * 16))), h = Math.max(l + 1, Math.min(16, Math.ceil((wy1 - wy) * 16)));
        for (let wx = cols(rc.x)[0]; wx <= cols(rc.x)[1]; wx++) for (let wz = cols(rc.z)[0]; wz <= cols(rc.z)[1]; wz++) want.set(`${wx},${wy},${wz}`, [l, h]);
      }
      expect(got).toEqual(want);
    }
  });

  it('a form re-laid at every wand size and turn stays inside the full cell it replaces, and 100 % turned is its turned form', () => {
    const dims = { width: 6, height: 5, length: 4 };
    for (let v = 1; v < K.VARIANTS.length; v++) for (const pct of SIZE_STEPS) for (const r of QUARTER_TURNS) {
      const boxes = K.formBoxes(v, 2, 12);
      const form = ixWorldBlocks([[3, 2, 1, 2, 12, v]], dims, pct / 100, r, K);
      const fullCell = ixWorldBlocks([[3, 2, 1, Math.min(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))]], dims, pct / 100, r, K);
      for (const [key, st] of form) {
        const outer = fullCell.get(key);
        expect(outer, `${v} @${pct}/${r} ${key}`).toBeDefined();
        expect(formWithin({ v: st[2] ?? 0, lo: st[0], hi: st[1] }, { v: 0, lo: outer![0], hi: outer![1] })).toBe(true);
      }
      if (pct === 100) expect([...form.values()][0]).toEqual((({ v: tv, lo, hi }) => (tv ? [lo, hi, tv] : [lo, hi]))(K.turnForm({ v, lo: 2, hi: 12 }, r)));
    }
  });

  it('lays the full collider over the extent of a form whose block the world does not know', () => {
    const laid: Array<{ id: string; states: Record<string, number> }> = [];
    const block = { setPermutation: (p: unknown): void => { laid.push(p as { id: string; states: Record<string, number> }); } };
    const known = (id: string, states: Record<string, number>): unknown => { if (id !== 'craftmatic:collider') throw new Error(`unknown block ${id}`); return { id, states }; };
    // A floor band 2..6 with a wall shape above it: its extent is 2..16.
    const v = K.VARIANTS.findIndex(d => d.kind === 1 && d.shape === 3);
    expect(K.lay(block, { v, lo: 2, hi: 6 }, 'lo', 'hi', known)).toBe(false);
    expect(laid).toEqual([{ id: 'craftmatic:collider', states: { lo: 2, hi: 16 } }]);
    expect(K.lay(block, { v: 0, lo: 3, hi: 9 }, 'lo', 'hi', known)).toBe(true);
  });

  it('plans treads over the grid as it was before clearance (a form read as its full cell)', () => {
    // A two-storey block with its walls as forms: the plan must equal the plan over the same cells full.
    const grid = new BlockGrid(6, 5, 6), full = new BlockGrid(6, 5, 6);
    // Ground plates, a platform one block up from x = 3 (a jump at 100 %, two blocks at 200 %: a tread
    // restores it), and a wall on the platform laid as a form.
    for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) {
      const floor = x >= 3 ? colliderState(0, 16) : colliderState(0, 3);
      grid.set(x, 0, z, floor); full.set(x, 0, z, floor);
      if (x === 5 && z > 0) { grid.set(x, 1, z, formState({ v: 1, lo: 0, hi: 12 })); full.set(x, 1, z, colliderState(0, 12)); }
    }
    const runs = (g: BlockGrid): string => encodeColliderRuns(g, 'craftmatic:collider').runs;
    const a = withColliderTreads({ width: 6, height: 5, length: 6, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: runs(grid), keptCells: 0 });
    const b = withColliderTreads({ width: 6, height: 5, length: 6, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: runs(full), keptCells: 0 });
    expect(a.colliders.treads).toEqual(b.colliders.treads);
    expect(a.report.plans.map(p => p.blocks)).toEqual(b.report.plans.map(p => p.blocks));
    expect(a.report.plans.some(p => p.blocks > 0)).toBe(true);
  });

  it('runs carry a form and decode back to it', () => {
    const grid = new BlockGrid(2, 2, 2);
    grid.set(0, 0, 0, formState({ v: 17, lo: 2, hi: 9 }));
    grid.set(1, 1, 1, colliderState(0, 16));
    const runs = encodeColliderRuns(grid, 'craftmatic:collider');
    expect(runs.colliders).toBe(2);
    const cells = colliderSourceCells({ width: 2, height: 2, length: 2, runs: runs.runs });
    expect(cells).toEqual([{ x: 0, y: 0, z: 0, lo: 2, hi: 9, v: 17 }, { x: 1, y: 1, z: 1, lo: 0, hi: 16 }]);
  });
});

describe('applyColliderClearance', () => {
  it('pulls a thin wall back to its geometry: free space only grows and the geometry stays covered', () => {
    const s = scene(4, 4, 4);
    // A 1-stud wall (6/16) standing against the +x side of column x=1, three rows high, under a
    // ceiling row (so the wall's top is not a standing surface).
    for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) s.solid(1, y, z, [[10, 16, 0, 16, 0, 16]]);
    for (let z = 0; z < 4; z++) s.full(1, 3, z);
    const r = applyColliderClearance(s.input());
    expect(r.applied.wall).toBe(12);
    for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) {
      const f = s.form(1, y, z)!;
      expect(f.v).not.toBe(0);
      expect(formWithin(f, { v: 0, lo: 0, hi: 16 })).toBe(true);
      expect(formContains(f, layerBoxes(s.layers.get(s.idx(1, y, z))!))).toBe(true);
      expect(K.formBoxes(f.v, f.lo, f.hi)).toEqual([[8, 16, 0, 16, 0, 16]]);
    }
    expect(r.freedBlocks).toBeGreaterThan(5);
  });

  it('never opens a room the colliders and the geometry both enclose (the leak check)', () => {
    // x = 0 outside | 1 a doorway-cut cell (air, its geometry still there) | 2 a partition cell whose
    // geometry runs along the corridor | 3 the room | 4 wall. Before: the partition cell is full.
    // Geometry: the cut cell is solid. Trimming the partition alone would join outside -> cut cell ->
    // partition -> room: a route neither world has.
    const s = scene(5, 3, 3);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
      if (x === 0) continue;
      if (x === 3 && z === 1 && y < 2) continue; // the room: two rows of air
      s.full(x, y, z);
    }
    // The cut cells (the doorway pass cleared them; their geometry is still recorded).
    for (let y = 0; y < 2; y++) s.grid.set(1, y, 1, 'minecraft:air');
    // The partition: geometry only along z < 4/16, open towards the room.
    for (let y = 0; y < 2; y++) {
      const a = newCellLayers(); addLayerBox(a, 0, 16, 0, 16, 0, 4);
      s.layers.set(s.idx(2, y, 1), a);
      s.grid.set(2, y, 1, colliderState(0, 16));
    }
    const before = reachable(s.grid);
    expect(before(3, 0, 1)).toBe(false);
    const r = applyColliderClearance(s.input());
    expect(r.refused.leak).toBeGreaterThan(0);
    expect(s.form(2, 0, 1)).toEqual({ v: 0, lo: 0, hi: 16 });
    expect(reachable(s.grid)(3, 0, 1)).toBe(false);
  });

  it('never trims the frame beside a closed leaf, and does trim a wall away from it', () => {
    const s = scene(5, 3, 4);
    // A wall along z = 2 (geometry a thin slab on its -z side), a door leaf in column x = 2.
    for (let x = 0; x < 5; x++) for (let y = 0; y < 3; y++) s.solid(x, y, 2, [[0, 16, 0, 16, 0, 4]]);
    s.grid.set(2, 0, 2, 'minecraft:air'); s.grid.set(2, 1, 2, 'minecraft:air');
    s.layers.delete(s.idx(2, 0, 2)); s.layers.delete(s.idx(2, 1, 2));
    const leaf = { x0: 1.9, y0: 0, z0: 2.05, x1: 3.1, y1: 2, z1: 2.15 };
    const plane = { c: [1.9, 0, 2.1], a: [1.2, 0, 0], u: [0, 2, 0] };
    const r = applyColliderClearance(s.input({ leaves: [leaf], leafPlanes: [plane], closedCells: [[2, 0, 2, 0, 16], [2, 1, 2, 0, 16]] }));
    // Frame slivers either side of the leaf: kept whole.
    for (const x of [1, 3]) for (const y of [0, 1]) expect(s.form(x, y, 2)).toEqual({ v: 0, lo: 0, hi: 16 });
    expect(r.refused['door-leaf']).toBeGreaterThanOrEqual(4);
    // The wall further along is pulled back to its slab.
    expect(s.form(0, 0, 2)!.v).not.toBe(0);
  });

  it('raises a too-low ceiling only where a sneaking player fits and the part keeps a slab above', () => {
    const s = scene(4, 4, 1);
    // Column 0: floor block, gap of 26/16 (sneak fits, standing does not), ceiling [10, 16] in row 2 -> raised to 13.
    s.full(0, 0, 0); s.solid(0, 2, 0, [[0, 16, 10, 16, 0, 16]]);
    // Column 1: gap 22/16 (a sneaking player does not fit): never raised.
    s.full(1, 0, 0); s.solid(1, 2, 0, [[0, 16, 6, 16, 0, 16]]);
    // Column 2: gap 26/16 but the ceiling part is only 4/16 thick: raising 3 would leave 1 - refused by the rule.
    s.full(2, 0, 0); s.solid(2, 2, 0, [[0, 16, 10, 14, 0, 16]]);
    // Column 3: gap 32/16, a standing player fits already: nothing to do.
    s.full(3, 0, 0); s.solid(3, 3, 0, [[0, 16, 0, 16, 0, 16]]);
    const r = applyColliderClearance(s.input());
    expect(s.form(0, 2, 0)).toEqual({ v: 0, lo: 13, hi: 16 });
    expect(s.form(1, 2, 0)).toEqual({ v: 0, lo: 6, hi: 16 });
    expect(s.form(2, 2, 0)).toEqual({ v: 0, lo: 10, hi: 14 });
    expect(s.form(3, 3, 0)).toEqual({ v: 0, lo: 0, hi: 16 });
    expect(r.applied.ceiling).toBe(1);
  });

  it('keeps a standing surface whole: a plate the player walks on is not narrowed', () => {
    const s = scene(3, 3, 1);
    // A plate covering half the cell's footprint, open sky above it: its top is a floor.
    s.solid(1, 0, 0, [[0, 8, 0, 3, 0, 16]]);
    const r = applyColliderClearance(s.input());
    expect(s.form(1, 0, 0)).toEqual({ v: 0, lo: 0, hi: 3 });
    expect(r.refused['walkable-top']).toBe(1);
  });
});

describe('figures read a form as the full collider it replaced (bedrock-figure-life.ts blockSpan)', () => {
  it('a wall form spans lo..hi, a floor + wall form runs to the block top, a wall + ceiling form from its bottom', () => {
    const C = { block: 'craftmatic:collider' };
    const id = (kind: 0 | 1 | 2): string => K.VARIANTS.find(d => d.kind === kind && d.shape === 3)!.id;
    expect(blockSpan(id(0), false, false, 5, C, 2, 9)).toEqual([5 + 2 / 16, 5 + 9 / 16]);
    expect(blockSpan(id(1), false, false, 5, C, 2, 9)).toEqual([5 + 2 / 16, 6]);
    expect(blockSpan(id(2), false, false, 5, C, 2, 9)).toEqual([5, 5 + 9 / 16]);
    expect(blockSpan('craftmatic:collider', false, false, 5, C, 2, 9)).toEqual([5 + 2 / 16, 5 + 9 / 16]);
  });
});

describe('a player in the trimmed world', () => {
  it('walks a corridor whose walls the full colliders had sealed', () => {
    // Two columns wide, 6 long; thin walls on the OUTER sides of both columns (a 1.5-block hall).
    const s = scene(2, 3, 6);
    for (let z = 0; z < 6; z++) for (let y = 0; y < 3; y++) {
      s.solid(0, y, z, [[0, 4, 0, 16, 0, 16]]);
      s.solid(1, y, z, [[12, 16, 0, 16, 0, 16]]);
    }
    const walk = (grid: BlockGrid): number => {
      const cells = colliderSourceCells({ width: 2, height: 3, length: 6, runs: encodeColliderRuns(grid, 'craftmatic:collider').runs });
      const world = new WalkWorld({ cells, dims: { width: 2, height: 3, length: 6 }, sizePct: 100, rotation: 0, treads: 'none' });
      let st: PlayerState = { x: 1, y: 0, z: -1, vx: 0, vy: 0, vz: 0, onGround: true, sneaking: false, tick: 0 };
      for (let t = 0; t < 200; t++) st = tickPlayer(world, st, { move: { x: 0, z: 1 }, jump: false, sneak: false }).state;
      return st.z;
    };
    expect(walk(s.grid)).toBeLessThan(0); // full colliders: the hall is a wall
    applyColliderClearance(s.input());
    expect(walk(s.grid)).toBeGreaterThan(6); // trimmed: the player walks its whole length
  });
});
