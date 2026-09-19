/**
 * VIRTUAL WALLS MUST MATCH THE BRICKS, AT EVERY SIZE.
 *
 * A brick-accurate building is drawn by a shell entity and walked on by a grid
 * of `craftmatic:collider` blocks. Off 100 % the blocks are not placed from the
 * structure tiles at all: the in-game script re-lays them from the run-length
 * grid shipped in the pack (`placeColliders` in bedrock-placement-pack.ts). A
 * player reported hitting INVISIBLE WALLS after scaling up, i.e. collision
 * where no brick is drawn - so this suite pins the re-lay against the model's
 * own occupied volume at every step of `SIZE_STEPS`.
 *
 * Granularity of the comparison, stated rather than hand-waved:
 *  - X and Z: whole world blocks. A collider is a full-width block, so a column
 *    is either solid or not; the expectation is an EXACT set of columns.
 *  - Y: sixteenths of a world block, the precision of the `[lo, hi]` pair.
 *    Because a block carries ONE pair, the strongest statement possible is
 *    that its pair equals the outward-rounded (floor lo, ceil hi) hull of the
 *    model volume inside that block. `hullGap` below measures what that hull
 *    over-fills when a block holds two disjoint spans, and the suite reports it
 *    instead of pretending it is zero.
 *
 * The runtime is driven as the shipped script, through the shared host, exactly
 * as test/bedrock-placement-size.test.ts does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '@craft/schem/types.js';
import { SIZE_STEPS, colliderPairOf, decodeColliderRuns, encodeColliderRuns } from '../web/src/engine/bedrock-placement-pack.js';
import { COLLIDER_BLOCK_ID, COLLIDER_HI_STATE, COLLIDER_LO_STATE, colliderState } from '../web/src/engine/bedrock-building-shell.js';
import { host } from './_placement-host.js';

/** The pin the host's player uses (its `location`, floored). */
const ANCHOR = { x: 100, y: 64, z: 200 };

interface GridDims { width: number; height: number; length: number }
/** One solid source cell: the box [x, x+1] × [y+lo/16, y+hi/16] × [z, z+1] in grid units. */
interface SourceCell { x: number; y: number; z: number; lo: number; hi: number }
/** A world block's collision span, in sixteenths. */
type Pair = readonly [number, number];

/** Every collider cell of a grid, decoded from the shipped run-length text. */
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

/**
 * The world box a source cell's footprint square occupies after the wand turns
 * the model by `r` inside its W × L footprint and scales it by `f` about the
 * pinned corner. Written as an interval transform of the square [x, x+1] ×
 * [z, z+1] so it derives from the geometry, not from the runtime's integer
 * cell arithmetic.
 */
function turnedFootprint(c: SourceCell, dims: GridDims, r: number, f: number): { x0: number; x1: number; z0: number; z1: number } {
  const { width: w, length: l } = dims;
  const [x0, x1, z0, z1] =
    r === 90 ? [l - c.z - 1, l - c.z, c.x, c.x + 1] :
    r === 180 ? [w - c.x - 1, w - c.x, l - c.z - 1, l - c.z] :
    r === 270 ? [c.z, c.z + 1, w - c.x - 1, w - c.x] :
    [c.x, c.x + 1, c.z, c.z + 1];
  return { x0: x0 * f, x1: x1 * f, z0: z0 * f, z1: z1 * f };
}

/** Integer coordinates of the blocks a half-open world span [a, b) touches with positive length. */
function blocksOver(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = Math.floor(a); i < b; i++) out.push(i);
  return out;
}

/**
 * The world COLUMNS a cell's scaled horizontal span [a, b) owns, at scale `f`.
 *
 * At `f` >= 1 the column is owned when its centre falls inside the span, so the
 * wall is the model ROUNDED to blocks. Claiming every column the span merely
 * touches instead dilates the model outward by up to a whole block on each
 * fractional boundary, and that block is collision standing in open space - the
 * invisible wall. A span of length >= 1 always contains a column centre, so
 * rounding can never open a hole. Below 100 % a cell is narrower than a block,
 * several cells share one, and each must keep it solid or the floor gets holes.
 */
function columnsOver(a: number, b: number, f: number): number[] {
  if (f < 1) return blocksOver(a, b);
  const out: number[] = [];
  for (let i = Math.floor(a); i < b; i++) if (i + 0.5 >= a && i + 0.5 < b) out.push(i);
  return out;
}

interface Expectation {
  /** Per world block (`x,y,z` offsets from the pin) the hull pair its collider must carry. */
  hull: Map<string, Pair>;
  /** Per world block, the sixteenths genuinely inside the model (a subset of the hull). */
  exact: Map<string, Set<number>>;
  /** Sixteenths the single-pair hull adds over the exact volume, summed over all blocks. */
  hullGap: number;
}

/**
 * Where the model's solid volume lands, from geometry alone: turn, scale about
 * the pin, then quantize each block's span outward to sixteenths (floor the
 * bottom, ceil the top) because that is all a `[lo, hi]` pair can express.
 */
function expectedColliders(cells: readonly SourceCell[], dims: GridDims, r: number, f: number): Expectation {
  const hull = new Map<string, Pair>();
  const exact = new Map<string, Set<number>>();
  for (const c of cells) {
    const fp = turnedFootprint(c, dims, r, f);
    const y0 = (c.y + c.lo / 16) * f, y1 = (c.y + c.hi / 16) * f;
    for (const wy of blocksOver(y0, y1)) {
      // The span inside THIS block, in sixteenths, rounded outward to the pair's precision.
      const lo = Math.max(0, Math.floor((y0 - wy) * 16));
      const hi = Math.min(16, Math.max(lo + 1, Math.ceil((y1 - wy) * 16)));
      for (const wx of columnsOver(fp.x0, fp.x1, f)) for (const wz of columnsOver(fp.z0, fp.z1, f)) {
        const key = `${wx},${wy},${wz}`;
        const prev = hull.get(key);
        hull.set(key, prev ? [Math.min(prev[0], lo), Math.max(prev[1], hi)] : [lo, hi]);
        let set = exact.get(key);
        if (!set) exact.set(key, set = new Set<number>());
        for (let s = lo; s < hi; s++) set.add(s);
      }
    }
  }
  let hullGap = 0;
  for (const [key, [lo, hi]] of hull) hullGap += (hi - lo) - exact.get(key)!.size;
  return { hull, exact, hullGap };
}

/** The colliders actually written into the fake world, keyed by offset from the pin. */
function placedColliders(blocks: Map<string, any>): Map<string, Pair> {
  const out = new Map<string, Pair>();
  for (const [key, b] of blocks) {
    if (b.typeId !== COLLIDER_BLOCK_ID) continue;
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    out.set(`${x - ANCHOR.x},${y - ANCHOR.y},${z - ANCHOR.z}`, [Number(b.permutation.getState(COLLIDER_LO_STATE)), Number(b.permutation.getState(COLLIDER_HI_STATE))]);
  }
  return out;
}

/** Cheap human-readable diff of two block maps, truncated so a failure names cells instead of dumping a grid. */
function diff(expected: Map<string, Pair>, actual: Map<string, Pair>, limit = 12): string[] {
  const out: string[] = [];
  for (const [key, pair] of expected) {
    const got = actual.get(key);
    if (!got) out.push(`${key}: missing wall, expected [${pair}]`);
    else if (got[0] !== pair[0] || got[1] !== pair[1]) out.push(`${key}: expected [${pair}], got [${got}]`);
  }
  for (const key of actual.keys()) if (!expected.has(key)) out.push(`${key}: INVISIBLE WALL, no brick here (got [${actual.get(key)}])`);
  return out.length > limit ? [...out.slice(0, limit), `… and ${out.length - limit} more`] : out;
}

/**
 * Place a collider grid at one size/rotation through the shipped runtime and
 * return what it wrote. At 100 % the runtime does NOT re-lay: the blocks come
 * from the structure tiles, which carry the grid verbatim, so this is only ever
 * called off 100 % (`sourceAsPlaced` is the 100 % baseline).
 */
async function relay(dims: GridDims, runs: string, pct: number, rotation: number): Promise<Map<string, Pair>> {
  return (await relaySequence(dims, runs, [pct], rotation)).placed;
}

/**
 * Place the same build at several sizes in a row WITHOUT undoing between them -
 * the wand's size cycle invites exactly this ("100 → 150 → … → 400") - and
 * return what stands at the end plus every `fillBlocks` the runtime attempted.
 */
async function relaySequence(dims: GridDims, runs: string, pcts: readonly number[], rotation: number): Promise<{ placed: Map<string, Pair>; fills: Array<{ from: any; to: any; block: string; options?: unknown }> }> {
  const h = host({
    stem: `sz${pcts.join('_')}r${rotation}`, label: 'Scaled', width: dims.width, height: dims.height, length: dims.length,
    tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: dims.width, height: dims.height, length: dims.length, nonAir: 1 }],
    actors: [],
    colliders: { ...dims, block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE, runs, keptCells: 0 },
    settleTicks: 1, finalHoldTicks: 1,
  });
  // Menu indices, from the button order in `menu()`: 1 = pin at my feet, 3 = rotate
  // (90° steps for a pack with blocks), 5 = place, 10 = size. Size cycles through
  // SIZE_STEPS from the 100 % it starts at, so the press count is the index delta.
  await h.open({ selection: 1 }, { canceled: true });
  for (let r = 0; r < rotation / 90; r++) await h.open({ selection: 3 }, { canceled: true });
  let current = 100;
  for (const pct of pcts) {
    const steps = (SIZE_STEPS.indexOf(pct) - SIZE_STEPS.indexOf(current) + SIZE_STEPS.length) % SIZE_STEPS.length;
    for (let i = 0; i < steps; i++) await h.open({ selection: 10 }, { canceled: true });
    current = pct;
    await h.open({ selection: 5 }, { selection: 0 });
    await h.flush(4000);
  }
  expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placed Scaled.'));
  return { placed: placedColliders(h.blocks), fills: h.fills };
}

/**
 * A small building with every feature that can go wrong: a part-height floor
 * plate, full-height walls around an EMPTY interior (an invisible wall shows up
 * there first), a doorway the walls leave open, and a part-height ceiling slab.
 */
function testBuilding(): { dims: GridDims; runs: string } {
  const dims = { width: 6, height: 4, length: 6 };
  const g = new BlockGrid(dims.width, dims.height, dims.length);
  for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) {
    g.set(x, 0, z, colliderState(0, 3));    // floor plate
    g.set(x, 3, z, colliderState(13, 16));  // ceiling slab
    for (const y of [1, 2]) if (x === 0 || x === 5 || z === 0 || z === 5) g.set(x, y, z, colliderState(0, 16));
  }
  // The doorway: two wall cells the scene kept as a vanilla door, so the runs carry 0 there.
  g.set(3, 1, 0, 'minecraft:oak_door[direction=1]');
  g.set(3, 2, 0, 'minecraft:oak_door[direction=1,upper_block_bit=1]');
  return { dims, runs: encodeColliderRuns(g, COLLIDER_BLOCK_ID).runs };
}

describe('collider re-lay matches the model at every size', () => {
  const { dims, runs } = testBuilding();
  const cells = sourceCells(dims, runs);

  it('100 %: the tiles carry the grid and the shipped runs describe the same cells', async () => {
    // Off 100 % only: at 100 % the runtime loads the structure tiles instead of
    // re-laying, so the baseline is that the shipped run grid IS the placed one.
    const want = expectedColliders(cells, dims, 0, 1);
    expect(want.hullGap).toBe(0);
    expect(new Map([...want.hull].map(([k, v]) => [k, `${v}`]))).toEqual(
      new Map(cells.map(c => [`${c.x},${c.y},${c.z}`, `${c.lo},${c.hi}`])));
  });

  for (const pct of SIZE_STEPS.filter(p => p !== 100)) {
    it(`${pct} %: every brick cell is solid and no empty cell is`, async () => {
      const f = pct / 100;
      const want = expectedColliders(cells, dims, 0, f);
      const got = await relay(dims, runs, pct, 0);
      expect(diff(want.hull, got)).toEqual([]);
      // The columns a player can walk into must be exactly the model's own.
      const columns = (m: Map<string, Pair>): string[] => [...new Set([...m.keys()].map(k => { const [x, , z] = k.split(','); return `${x},${z}`; }))].sort();
      expect(columns(got)).toEqual(columns(want.hull));
      // The doorway stays walkable: every world block ENTIRELY between the floor
      // plate's top and the ceiling slab's underside, in the door's own column,
      // must carry no collider at all. Below 100 % the whole building is under
      // four blocks tall, so there is no such block and nothing to check.
      if (f < 1) return;
      const top = (3 / 16) * f, bottom = (3 + 13 / 16) * f;
      for (const x of columnsOver(3 * f, 4 * f, f)) for (const z of columnsOver(0, 1 * f, f)) {
        for (let y = Math.ceil(top); y + 1 <= bottom; y++) {
          expect(got.get(`${x},${y},${z}`), `doorway blocked at ${x},${y},${z} (${pct} %)`).toBeUndefined();
        }
      }
    });
  }

  it('reports the over-fill a single [lo, hi] pair forces, per size', async () => {
    // A block holding two disjoint spans can only carry their hull. This is the
    // suite's declared tolerance; it must stay small and it must be ZERO where
    // one source cell never shares a world block with another.
    const report: Array<{ pct: number; hullGap: number; blocks: number }> = [];
    for (const pct of SIZE_STEPS) {
      const want = expectedColliders(cells, dims, 0, pct / 100);
      report.push({ pct, hullGap: want.hullGap, blocks: want.hull.size });
    }
    // An integer factor of 1 or more never puts two source cells in one world
    // block, so the hull is exact there. Below 100 % it is not, and 150 % puts a
    // cell boundary mid-block; those are the only steps allowed any over-fill.
    for (const r of report) {
      if (Number.isInteger(r.pct / 100)) expect(r.hullGap, `${r.pct} % must be exact`).toBe(0);
      else expect(r.hullGap / (r.blocks * 16), `${r.pct} % over-fill`).toBeLessThan(0.4);
    }
  });

  it('a second place at a bigger size leaves none of the smaller one behind', async () => {
    // The user's own sequence: cycle the size up and place again, without undo.
    // Every re-lay must clear the colliders already standing in its box, or the
    // old size's walls survive INSIDE the new build with nothing drawn on them.
    const { placed, fills } = await relaySequence(dims, runs, [100, 150, 200, 300, 400], 0);
    const want = expectedColliders(cells, dims, 0, 4);
    expect(diff(want.hull, placed)).toEqual([]);
    // The clear must have actually run: a plain {from, to} object is not a
    // BlockVolume and the runtime swallows the rejection, so assert it happened.
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) {
      const cellCount = (Math.abs(f.to.x - f.from.x) + 1) * (Math.abs(f.to.y - f.from.y) + 1) * (Math.abs(f.to.z - f.from.z) + 1);
      expect(cellCount, 'one fillBlocks call must stay inside the 32768-block cap').toBeLessThanOrEqual(32768);
    }
  });

  it('placing smaller afterwards leaves nothing of the bigger one standing', async () => {
    // The case the box clear alone cannot reach: the new footprint is INSIDE the
    // old one, so the previous placement's bounds have to be swept as well.
    const { placed } = await relaySequence(dims, runs, [400, 150], 0);
    const want = expectedColliders(cells, dims, 0, 1.5);
    expect(diff(want.hull, placed)).toEqual([]);
  });

  it('clears only this pack own colliders, never the player world', async () => {
    // Clearing the whole bounding box would delete the player's world inside the
    // footprint; only `craftmatic:collider` may be removed.
    const { fills } = await relaySequence(dims, runs, [200], 0);
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(f.options).toEqual({ blockFilter: { includeTypes: [COLLIDER_BLOCK_ID] } });
  });

  for (const rotation of [90, 180, 270]) {
    it(`${rotation}° at 200 %: the turned, scaled walls match the turned model`, async () => {
      const want = expectedColliders(cells, dims, rotation, 2);
      const got = await relay(dims, runs, 200, rotation);
      expect(diff(want.hull, got)).toEqual([]);
    });
  }
});

/**
 * The same assertions against a real set's shipped pack. 31141 has doors and
 * six figures, so its grid carries kept cells (doorways) beside the colliders.
 * Needs the clego corpus; skips where it is absent (CI).
 */
const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const SET_FILE = 'C:/git/clego/lego_sets/IOModel2V2/31141.ldr';
const HAVE_CORPUS = existsSync(LDRAW_ROOT) && existsSync(SET_FILE);

describe.skipIf(!HAVE_CORPUS)('collider re-lay of a real set (31141)', () => {
  it('re-lays 31141 at every size with no invisible wall', async () => {
    const { parseLDrawDocument, embeddedPartTexts } = await import('../web/src/engine/ldraw-parser.js');
    const { seedDatTexts, setLDrawRoot } = await import('../web/src/engine/ldraw-geometry.js');
    const { runSchemPipeline } = await import('../web/src/engine/schem-pipeline.js');
    const { extractFile, listZipEntries } = await import('../web/src/engine/zip-utils.js');
    setLDrawRoot(LDRAW_ROOT);
    const doc = parseLDrawDocument(readFileSync(SET_FILE, 'utf8'));
    seedDatTexts(embeddedPartTexts(doc));
    const result = await runSchemPipeline({
      source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: 20, maxDim: 700 } },
      format: 'mcaddon', packStem: 'Set31141', packLabel: 'Fairground Carousel (31141)', profile: 'default',
      lightFill: false, shapes: false, vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced',
    });
    const bytes = result.bytes!;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const name = listZipEntries(buffer).find(e => e.endsWith('scripts/placement.js'))!;
    const script = new TextDecoder().decode(await extractFile(buffer, name));
    const config = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(script)![1]!);
    expect(config.colliders, 'the export must be brick-accurate for this test to mean anything').toBeTruthy();
    const dims: GridDims = { width: config.colliders.width, height: config.colliders.height, length: config.colliders.length };
    const cells = sourceCells(dims, config.colliders.runs);
    expect(cells.length).toBeGreaterThan(200);
    // At 400 % the footprint must exceed the runtime's 48-block box, so the
    // per-box backup/clear/write chunking is covered by this case.
    expect(Math.ceil(dims.width * 4), `31141 grid is ${dims.width}x${dims.height}x${dims.length}`).toBeGreaterThan(48);
    for (const pct of SIZE_STEPS.filter(p => p !== 100)) {
      const want = expectedColliders(cells, dims, 0, pct / 100);
      const got = await relay(dims, config.colliders.runs, pct, 0);
      expect(diff(want.hull, got), `31141 at ${pct} %`).toEqual([]);
    }
  }, 600_000);
});
