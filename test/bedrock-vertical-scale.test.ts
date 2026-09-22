/**
 * CAN A PLAYER STILL GO UP AND DOWN INSIDE A SCALED-UP BUILDING?
 *
 * The worry (2026-09-21): "a bug exists for scaling that prevents up-and-down
 * movement for scaled up models (because it uses the original 1x scale)". The
 * invisible walkable blocks of a brick-accurate building are re-laid by the
 * shipped placement script at the chosen wand size (`placeColliders` in
 * bedrock-placement-pack.ts), so the question has two measurable halves:
 *
 *  1. GEOMETRY - is every floor, step and ceiling laid at `f ×` its 1× height,
 *     or at the 1× height? Measured per column as the STANDING SURFACES the
 *     re-laid blocks offer (the top of each collision span with head-room over
 *     it), compared with the 1× grid's own surfaces scaled by `f`.
 *  2. PHYSICS - given those surfaces, can a PLAYER-SIZED body (the player, or a
 *     figure capped at player size) get from the entrance to the upper floor?
 *     A breadth-first walk over (column, surface) with the player's real
 *     limits: 1.8 blocks tall, steps up 0.6 without jumping, jumps 1.25.
 *
 * The runtime is driven as the SERIALIZED script the device runs, through the
 * shared host, like every other placement test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '@craft/schem/types.js';
import { SIZE_STEPS, colliderPairOf, decodeColliderRuns, encodeColliderRuns } from '../web/src/engine/bedrock-placement-pack.js';
import { COLLIDER_BLOCK_ID, COLLIDER_HI_STATE, COLLIDER_LO_STATE, colliderState } from '../web/src/engine/bedrock-building-shell.js';
import { PLAYER_HEIGHT_BLOCKS } from '../web/src/engine/lego-scale.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { host } from './_placement-host.js';

/** The pin the host's player sets with "Pin corner at my feet" (its location floored). */
const ANCHOR = { x: 100, y: 64, z: 200 };
/** Menu indices of the runtime's buttons (`menu()` in bedrock-placement-pack.ts). */
const PIN_AT_FEET = 1, PLACE = 5, SIZE = 10;

/**
 * The player's movement limits, in blocks. Height is the shared LEGO/Minecraft
 * constant; the step-up and jump limits are Minecraft's (a body auto-steps a
 * rise of at most 0.6 and a standing jump clears ~1.25 blocks). These are the
 * limits of a PLAYER-SIZED body: a figure capped at player size shares them.
 */
const PLAYER = { height: PLAYER_HEIGHT_BLOCKS, step: 0.6, jump: 1.25 } as const;

interface GridDims { width: number; height: number; length: number }
interface SourceCell { x: number; y: number; z: number; lo: number; hi: number }
/** A vertical collision span [bottom, top) in blocks above the pin plane. */
type Span = readonly [number, number];

function sourceCells(dims: GridDims, runs: string): SourceCell[] {
  const cells = decodeColliderRuns(runs);
  const out: SourceCell[] = [];
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]!;
    if (v === 0) continue;
    const [lo, hi] = colliderPairOf(v);
    out.push({ z: i % dims.length, y: Math.floor(i / dims.length) % dims.height, x: Math.floor(i / (dims.length * dims.height)), lo, hi });
  }
  return out;
}

/** Sort spans and merge the ones that overlap or touch, so a wall two cells tall is one span. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1e-9) out[out.length - 1] = [last[0], Math.max(last[1], s[1])];
    else out.push(s);
  }
  return out;
}

/**
 * The model's TRUE collision spans per column at size `f`, from the 1× grid
 * alone (rotation 0): cell `(x, y, z)` with sixteenths `[lo, hi]` occupies
 * [(y + lo/16) f, (y + hi/16) f) over the columns its scaled square covers.
 * Columns follow the runtime's own centre rule at f ≥ 1 (a column belongs to
 * the cell whose scaled span holds its centre), which is what the geometry
 * test suite pins; this suite is about HEIGHTS, so it reuses that rule.
 */
function trueSpans(cells: readonly SourceCell[], f: number): Map<string, Span[]> {
  const columns = (i: number): number[] => {
    const a = i * f, b = (i + 1) * f, out: number[] = [];
    if (f < 1) { for (let k = Math.floor(a); k < b; k++) out.push(k); return out; }
    for (let k = Math.floor(a); k < b; k++) if (k + 0.5 >= a && k + 0.5 < b) out.push(k);
    return out;
  };
  const raw = new Map<string, Span[]>();
  for (const c of cells) for (const wx of columns(c.x)) for (const wz of columns(c.z)) {
    const key = `${wx},${wz}`;
    let list = raw.get(key);
    if (!list) raw.set(key, list = []);
    list.push([(c.y + c.lo / 16) * f, (c.y + c.hi / 16) * f]);
  }
  return new Map([...raw].map(([k, v]) => [k, mergeSpans(v)]));
}

/** The collision spans per column that the runtime actually WROTE, from the host's fake world. */
function placedSpans(blocks: Map<string, any>): Map<string, Span[]> {
  const raw = new Map<string, Span[]>();
  for (const [key, b] of blocks) {
    if (b.typeId !== COLLIDER_BLOCK_ID) continue;
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    const lo = Number(b.permutation.getState(COLLIDER_LO_STATE)), hi = Number(b.permutation.getState(COLLIDER_HI_STATE));
    const col = `${x - ANCHOR.x},${z - ANCHOR.z}`;
    let list = raw.get(col);
    if (!list) raw.set(col, list = []);
    list.push([y - ANCHOR.y + lo / 16, y - ANCHOR.y + hi / 16]);
  }
  return new Map([...raw].map(([k, v]) => [k, mergeSpans(v)]));
}

/**
 * Where a player-sized body can STAND in a column: the pin plane (the world
 * ground the pin sits on) and the top of every span, each only if the gap
 * above it up to the next span is at least the body's height.
 */
function surfaces(spans: readonly Span[] | undefined, height: number): number[] {
  const list = spans ?? [];
  const out: number[] = [];
  const tops = [0, ...list.map(s => s[1])];
  for (const top of tops) {
    const above = list.find(s => s[0] >= top - 1e-9 && s[1] > top + 1e-9);
    const clearance = above ? above[0] - top : Infinity;
    // The ground itself is not a surface where a span already covers it.
    if (top === 0 && list.some(s => s[0] < 1e-9 && s[1] > 1e-9)) continue;
    if (clearance + 1e-9 >= height) out.push(top);
  }
  return out;
}

/** The 4-neighbour breadth-first walk from a set of start (column, surface) nodes with the player's limits. */
function reachable(spansByColumn: Map<string, Span[]>, bounds: { x0: number; x1: number; z0: number; z1: number }, starts: Array<{ x: number; z: number; y: number }>, body = PLAYER): Map<string, number[]> {
  const nodes = new Map<string, number[]>();
  const key = (x: number, z: number): string => `${x},${z}`;
  const surfacesAt = (x: number, z: number): number[] => surfaces(spansByColumn.get(key(x, z)), body.height);
  const seen = new Set<string>();
  const queue: Array<[number, number, number]> = [];
  const visit = (x: number, z: number, y: number): void => {
    const id = `${x},${z},${y.toFixed(4)}`;
    if (seen.has(id)) return;
    seen.add(id); queue.push([x, z, y]);
    const list = nodes.get(key(x, z)) ?? [];
    list.push(y); nodes.set(key(x, z), list);
  };
  for (const s of starts) if (surfacesAt(s.x, s.z).some(y => Math.abs(y - s.y) < 1e-6)) visit(s.x, s.z, s.y);
  for (let h = 0; h < queue.length; h++) {
    const [x, z, y] = queue[h]!;
    // Head-room in THIS column above the surface: a jump needs the rise plus the body.
    const here = spansByColumn.get(key(x, z)) ?? [];
    const above = here.find(s => s[0] >= y - 1e-9 && s[1] > y + 1e-9);
    const headroom = above ? above[0] - y : Infinity;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, nz = z + dz;
      if (nx < bounds.x0 || nx > bounds.x1 || nz < bounds.z0 || nz > bounds.z1) continue;
      for (const ny of surfacesAt(nx, nz)) {
        const rise = ny - y;
        if (rise <= body.step + 1e-9) { visit(nx, nz, ny); continue; }
        if (rise <= body.jump + 1e-9 && headroom + 1e-9 >= rise + body.height) visit(nx, nz, ny);
      }
    }
  }
  return nodes;
}

/** Drive the shipped runtime: pin at the feet, cycle to `pct`, place, return the spans it wrote. */
async function relay(spec: { dims: GridDims; runs: string; stem: string }, pct: number, turns = 20000): Promise<Map<string, Span[]>> {
  const h = host({
    stem: spec.stem, label: spec.stem, width: spec.dims.width, height: spec.dims.height, length: spec.dims.length,
    tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: spec.dims.width, height: spec.dims.height, length: spec.dims.length, nonAir: 1 }],
    actors: [],
    colliders: { ...spec.dims, block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE, runs: spec.runs, keptCells: 0 },
    // This suite measures the re-lay ALONE: the surfaces must be exactly f × the
    // 1× ones, and the "blocked" verdicts below are what that geometry gives a
    // player. The invisible steps a pack ships by default (bedrock-collider-scale.ts)
    // add surfaces on purpose; test/bedrock-collider-treads.test.ts measures them.
    treads: false,
    settleTicks: 1, finalHoldTicks: 1,
  });
  await h.open({ selection: PIN_AT_FEET }, { canceled: true });
  const steps = (SIZE_STEPS.indexOf(pct) - SIZE_STEPS.indexOf(100) + SIZE_STEPS.length) % SIZE_STEPS.length;
  for (let i = 0; i < steps; i++) await h.open({ selection: SIZE }, { canceled: true });
  await h.open({ selection: PLACE }, { selection: 0 });
  await h.flush(turns);
  expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`Placed ${spec.stem}.`));
  return placedSpans(h.blocks);
}

/** Every surface of every column, flattened to `x,z,y` strings, for a set comparison. */
const flatten = (spans: Map<string, Span[]>, height: number): string[] =>
  [...spans].flatMap(([col, s]) => surfaces(s, height).map(y => `${col}:${y.toFixed(4)}`)).sort();

/**
 * The compare: the placed surfaces against the 1× surfaces scaled by `f`. A
 * `[lo, hi]` pair is whole sixteenths, so a surface at a fractional factor may
 * round OUTWARD by under one sixteenth; at an integer factor it must be exact.
 */
function compareSurfaces(placed: Map<string, Span[]>, truth: Map<string, Span[]>, f: number, height: number): { mismatches: string[]; surfaces: number } {
  const mismatches: string[] = [];
  let count = 0;
  const tolerance = Number.isInteger(f) ? 1e-9 : 1 / 16 + 1e-9;
  for (const [col, spans] of truth) {
    const want = surfaces(spans, height), got = surfaces(placed.get(col), height);
    count += want.length;
    for (const y of want) if (!got.some(g => Math.abs(g - y) <= tolerance)) mismatches.push(`${col}: surface at ${y.toFixed(3)} (= 1× ${(y / f).toFixed(3)} × ${f}) missing; placed offers [${got.map(g => g.toFixed(3)).join(', ')}]`);
    for (const g of got) if (!want.some(y => Math.abs(g - y) <= tolerance)) mismatches.push(`${col}: placed surface at ${g.toFixed(3)} has no counterpart in the scaled model [${want.map(y => y.toFixed(3)).join(', ')}]`);
  }
  for (const col of placed.keys()) if (!truth.has(col)) mismatches.push(`${col}: colliders where the model has none`);
  return { mismatches: mismatches.slice(0, 12), surfaces: count };
}

/**
 * A two-storey building with the staircase a LEGO set would have: 9 brick-high
 * risers (24 LDU = 0.45 blocks at minifig scale, quantized to sixteenths the way
 * `buildColliderGrid` does it) from the ground plate up to the upper floor
 * plate, an open doorway in the front wall, and an open stairwell.
 */
function twoStoreyStaircase(): { dims: GridDims; runs: string; cells: SourceCell[]; door: { x: number; z: number }; upperFloorTop: number; risers: number[] } {
  const dims: GridDims = { width: 10, height: 7, length: 12 };
  const g = new BlockGrid(dims.width, dims.height, dims.length);
  const set = (x: number, y: number, z: number, lo: number, hi: number): void => g.set(x, y, z, colliderState(lo, hi));
  /** A solid column from the ground up to `top` blocks, cut into cells like the export's box → cell pass. */
  const solidTo = (x: number, z: number, top: number): void => {
    for (let y = 0; y < Math.ceil(top - 1e-9); y++) set(x, y, z, 0, Math.min(16, Math.max(1, Math.ceil((top - y) * 16 - 1e-9))));
  };
  const BRICK = 24 / (96 / PLAYER_HEIGHT_BLOCKS);   // one brick in blocks (0.45)
  const PLATE = 8 / (96 / PLAYER_HEIGHT_BLOCKS);    // one plate in blocks (0.15)
  for (let x = 0; x < dims.width; x++) for (let z = 0; z < dims.length; z++) {
    set(x, 0, z, 0, Math.ceil(PLATE * 16));   // ground plate, top 3/16
    const wall = x === 0 || x === dims.width - 1 || z === 0 || z === dims.length - 1;
    if (wall) for (let y = 1; y < dims.height; y++) set(x, y, z, 0, 16);
  }
  // Doorway: two wall cells the scene kept as a vanilla door carry 0 in the runs.
  const door = { x: 2, z: 0 };
  g.set(door.x, 1, door.z, 'minecraft:oak_door[direction=1]');
  g.set(door.x, 2, door.z, 'minecraft:oak_door[direction=1,upper_block_bit=1]');
  // Upper floor plate over the front half of the interior (x 1..5), top at 4 + 3/16.
  const upperFloorTop = 4 + Math.ceil(PLATE * 16) / 16;
  for (let x = 1; x <= 5; x++) for (let z = 1; z < dims.length - 1; z++) set(x, 4, z, 0, Math.ceil(PLATE * 16));
  // Staircase along +z in column x = 6, beside the plate's edge (x = 5): riser k
  // stands one brick higher than the last; the top step (z = 9) meets the plate.
  const STAIR_X = 6;
  const risers: number[] = [];
  const groundTop = Math.ceil(PLATE * 16) / 16;
  for (let k = 1; k <= 9; k++) solidTo(STAIR_X, k, groundTop + BRICK * k);
  const runs = encodeColliderRuns(g, COLLIDER_BLOCK_ID).runs;
  for (let k = 1; k <= 9; k++) {
    const top = surfaces(mergeSpans(sourceCells(dims, runs).filter(c => c.x === STAIR_X && c.z === k).map(c => [c.y + c.lo / 16, c.y + c.hi / 16] as Span)), 0).at(-1)!;
    risers.push(top);
  }
  return { dims, runs, cells: sourceCells(dims, runs), door, upperFloorTop, risers };
}

describe('vertical movement inside a scaled building (synthetic two-storey staircase)', () => {
  const b = twoStoreyStaircase();
  const bounds = (f: number) => ({ x0: -1, x1: Math.ceil(b.dims.width * f), z0: -1, z1: Math.ceil(b.dims.length * f) });
  /** A column of the upper floor plate beside the top step (x = 5, z = 9 at 1×), scaled. */
  const landing = (f: number): string => `${Math.ceil(5 * f - 0.5)},${Math.ceil(9 * f - 0.5)}`;
  /** Start outside the front wall, on the ground, in the doorway's own column(s). */
  const starts = (f: number) => {
    const out: Array<{ x: number; z: number; y: number }> = [];
    for (let x = Math.floor(b.door.x * f); x < (b.door.x + 1) * f; x++) out.push({ x, z: -1, y: 0 });
    return out;
  };

  it('1×: the staircase has brick-high risers the player steps up without jumping, and reaches the upper floor', () => {
    const rises = b.risers.map((top, i) => top - (i ? b.risers[i - 1]! : 3 / 16));
    for (const r of rises) { expect(r).toBeGreaterThan(0.4); expect(r).toBeLessThanOrEqual(PLAYER.step); }
    const nodes = reachable(trueSpans(b.cells, 1), bounds(1), starts(1));
    expect(nodes.get(landing(1))!.some(y => Math.abs(y - b.upperFloorTop) < 1e-6)).toBe(true);
  });

  for (const pct of SIZE_STEPS.filter(p => p !== 100)) {
    const f = pct / 100;
    it(`${pct} %: every floor, step and ceiling is re-laid at ${f} × its 1× height (not at the 1× height)`, async () => {
      const placed = await relay({ dims: b.dims, runs: b.runs, stem: `Stairs${pct}` }, pct);
      const truth = trueSpans(b.cells, f);
      // Compare with NO head-room requirement too, so a shrunken building (1.75
      // blocks tall at 25 %) still has every span top checked, not only the
      // ones a player fits over.
      // Below 100 % several cells share a world block and its single [lo, hi]
      // pair is their hull, so only the surfaces a body can stand on compare.
      for (const height of f >= 1 ? [PLAYER.height, 0] : [PLAYER.height]) {
        const { mismatches, surfaces: n } = compareSurfaces(placed, truth, f, height);
        expect(n, `surfaces checked at head-room ${height}`).toBeGreaterThan(height ? 0 : 10);
        expect(mismatches).toEqual([]);
      }
      // The upper floor's standing surface is at f × (4 + 3/16), which is NOT
      // the 1× value. At 25 % four cells share one column and the staircase's
      // hull swallows the plate top in the landing column, so that step is
      // covered by the surface comparison above only.
      if (f >= 0.5) {
        const upper = surfaces(placed.get(landing(f)), 0);
        const wantUpper = b.upperFloorTop * f;
        expect(upper.some(y => Math.abs(y - wantUpper) <= (Number.isInteger(f) ? 1e-9 : 1 / 16))).toBe(true);
        expect(upper.some(y => Math.abs(y - b.upperFloorTop) < 1e-6)).toBe(false);
      }
    });
  }

  it('reports, per size, whether a player-sized body can still climb to the upper floor - and why not', async () => {
    // The riser of a LEGO brick staircase scales with the model while the
    // player does not: 0.45 blocks at 1× is a step, at 2× (0.9) it is a jump,
    // and from 3× (1.35) it is above the 1.25-block jump. This is physics, not
    // a re-lay using the 1× height - the surfaces above are already proven to
    // scale - and it is what "no up-and-down movement at 400 %" would feel like.
    const report: Array<{ pct: number; riser: number; climb: 'step' | 'jump' | 'blocked'; upperFloorReached: boolean; highest: number }> = [];
    for (const pct of SIZE_STEPS) {
      const f = pct / 100;
      const spans = pct === 100 ? trueSpans(b.cells, 1) : await relay({ dims: b.dims, runs: b.runs, stem: `Climb${pct}` }, pct);
      const nodes = reachable(spans, bounds(f), starts(f));
      const all = [...nodes.values()].flat();
      const highest = all.length ? Math.max(...all) : 0;
      const riser = Math.max(...b.risers.map((top, i) => top - (i ? b.risers[i - 1]! : 3 / 16))) * f;
      const climb = riser <= PLAYER.step ? 'step' : riser <= PLAYER.jump ? 'jump' : 'blocked';
      // Reached = the body stands on the upper floor PLATE beside the top step (not merely on the top step).
      const upperFloorReached = (nodes.get(landing(f)) ?? []).some(y => Math.abs(y - b.upperFloorTop * f) <= 1 / 16);
      report.push({ pct, riser: Math.round(riser * 1000) / 1000, climb, upperFloorReached, highest: Math.round(highest * 1000) / 1000 });
    }
    console.log('vertical-scale verdict (synthetic staircase; below 100 % the 7-cell storeys shrink under the 1.8-block body, so nothing inside is standable):\n'
      + report.map(r => `  ${String(r.pct).padStart(3)} %  riser ${r.riser.toFixed(3)} blocks -> ${r.climb.padEnd(7)}  upper floor reached: ${r.upperFloorReached}  highest surface ${r.highest}`).join('\n'));
    const byPct = Object.fromEntries(report.map(r => [r.pct, r]));
    // From 100 % to 200 % the player gets up (stepping, then jumping); from 300 % the riser is out of reach.
    for (const pct of [100, 150, 200]) expect(byPct[pct]!.upperFloorReached, `${pct} %`).toBe(true);
    for (const pct of [300, 400]) { expect(byPct[pct]!.upperFloorReached, `${pct} %`).toBe(false); expect(byPct[pct]!.climb).toBe('blocked'); }
    expect(byPct[100]!.climb).toBe('step');
    expect(byPct[200]!.climb).toBe('jump');
  });
});

/**
 * The same measurement on real shipped packs (the collider grids the device
 * round used). They live under output/ and are not in git, so this block skips
 * where they are absent (CI).
 */
const REAL_PACKS = [
  { file: 'output/bedrock-entity-qa/910004-runtime-door.mcaddon', label: 'Winter Chalet 910004', sizes: [200, 400] },
  { file: 'output/bedrock-entity-qa/10303-coaster-measured-final.mcaddon', label: 'Loop Coaster 10303', sizes: [200] },
] as const;

describe.skipIf(!REAL_PACKS.every(p => existsSync(p.file)))('vertical movement inside real shipped packs', () => {
  for (const pack of REAL_PACKS) {
    it(`${pack.label}: floors re-lay at f × their 1× height, and the climb verdict per size`, async () => {
      const bytes = readFileSync(pack.file);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const name = listZipEntries(buffer).find(e => e.endsWith('scripts/placement.js'))!;
      const script = new TextDecoder().decode(await extractFile(buffer, name));
      const config = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(script)![1]!);
      expect(config.colliders).toBeTruthy();
      const dims: GridDims = { width: config.colliders.width, height: config.colliders.height, length: config.colliders.length };
      const cells = sourceCells(dims, config.colliders.runs);
      const truth1 = trueSpans(cells, 1);
      const bounds = (f: number) => ({ x0: -1, x1: Math.ceil(dims.width * f), z0: -1, z1: Math.ceil(dims.length * f) });
      /** Start on the ground all round the footprint: the player walks up from outside. */
      const starts = (f: number) => {
        const out: Array<{ x: number; z: number; y: number }> = [];
        const bx = bounds(f);
        for (let x = bx.x0; x <= bx.x1; x++) { out.push({ x, z: bx.z0, y: 0 }); out.push({ x, z: bx.z1, y: 0 }); }
        for (let z = bx.z0; z <= bx.z1; z++) { out.push({ x: bx.x0, z, y: 0 }); out.push({ x: bx.x1, z, y: 0 }); }
        return out;
      };
      const levels = (nodes: Map<string, number[]>, f: number): string => {
        const hist = new Map<string, number>();
        for (const ys of nodes.values()) for (const y of ys) { const k = (Math.round(y / f * 16) / 16).toFixed(3); hist.set(k, (hist.get(k) ?? 0) + 1); }
        return [...hist].sort((a, b) => Number(a[0]) - Number(b[0])).filter(([, n]) => n >= 4).map(([k, n]) => `${k}(${n})`).join(' ');
      };
      /** The same walk with an unlimited jump: what walls and head-room alone allow. */
      const FLYING = { height: PLAYER.height, step: Infinity, jump: Infinity } as const;
      const base = reachable(truth1, bounds(1), starts(1));
      const baseHighest = Math.max(...[...base.values()].flat());
      const baseFlyNodes = reachable(truth1, bounds(1), starts(1), FLYING);
      const baseFly = [...baseFlyNodes.values()].flat();
      const doors = (config.runtimeDoorCandidates ?? []).map((d: any) => `door@${d.x},${d.y},${d.z} needs ${d.requiredSize}% column surfaces ${JSON.stringify(surfaces(truth1.get(`${Math.floor(d.x)},${Math.floor(d.z)}`), PLAYER.height))}`);
      const lines = [`  doors: ${doors.join(' | ') || 'none'}`, `  100 %  unlimited-jump levels(1× height: nodes) ${levels(baseFlyNodes, 1)}`,`  100 %  reachable (column,surface) nodes ${[...base.values()].flat().length}, highest ${baseHighest.toFixed(3)}, levels(1× height: nodes) ${levels(base, 1)}; with unlimited jump ${baseFly.length} nodes, highest ${Math.max(...baseFly).toFixed(3)}`];
      for (const pct of pack.sizes) {
        const f = pct / 100;
        const placed = await relay({ dims, runs: config.colliders.runs, stem: `${pack.label.replace(/[^A-Za-z0-9]/g, '')}${pct}` }, pct, 400000);
        const { mismatches, surfaces: n } = compareSurfaces(placed, trueSpans(cells, f), f, PLAYER.height);
        expect(n).toBeGreaterThan(100);
        expect(mismatches, `${pack.label} at ${pct} %`).toEqual([]);
        const nodes = reachable(placed, bounds(f), starts(f));
        const highest = Math.max(...[...nodes.values()].flat());
        const fly = [...reachable(placed, bounds(f), starts(f), FLYING).values()].flat();
        lines.push(`  ${pct} %  surfaces match f × 1× (${n} checked); reachable nodes ${[...nodes.values()].flat().length}, highest ${highest.toFixed(3)} (= 1× ${(highest / f).toFixed(3)}), levels(1× height: nodes) ${levels(nodes, f)}; with unlimited jump ${fly.length} nodes, highest ${Math.max(...fly).toFixed(3)} (= 1× ${(Math.max(...fly) / f).toFixed(3)})`);
      }
      console.log(`vertical-scale verdict (${pack.label}, ${dims.width}×${dims.height}×${dims.length} cells):\n${lines.join('\n')}`);
    }, 900_000);
  }
});
