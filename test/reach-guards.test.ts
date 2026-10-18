/**
 * INVISIBLE GUARDS AT THE EDGES OF THE REACH OUR STEPS MADE (`guardPass` in
 * bedrock-collider-scale.ts, docs/bedrock-interactivity.md "Guards at the
 * edges of the new reach").
 *
 * Pixel round 30l (2026-10-07): the lane pass made 10261's lift hill climbable
 * at 200 % with auto-jump, and walking on past the top the player walked off
 * the model's east end and fell 43 blocks - an edge no child reached on foot
 * before our treads led them there. So wherever a surface the treads made
 * reachable meets a fall of more than `REACH_GUARD_DROP16` (4 blocks), the
 * column it would fall into gets a guard; on the footprint's border, where
 * there is no column to guard, the border surface itself is capped. The model's
 * own reach (anything the walk reaches without a tread, and everything at
 * 100 %) is never guarded, a fall within the limit is not, and a guard never
 * cuts off a surface the player reached before.
 */
import { describe, expect, it } from 'vitest';
import {
  JUMP16, REACH_GUARD_DROP16, REACH_GUARD_HEIGHT16, ScaledColliderGrid, planColliderTreads, walkScaledColliders,
  type GridDims, type SourceCell, type TreadBlock, type TreadPlan,
} from '../web/src/engine/bedrock-collider-scale.js';
import { GUARD_DROP16, GUARD_HEIGHT16 } from '../web/src/engine/bedrock-interactives.js';
import { WalkWorld, tickPlayer, type PlayerState } from '../web/src/engine/addon-walk.js';
import { colliderLaneWalk } from '../web/src/engine/bedrock-placement-pack.js';
import { COLLIDER_KIT } from '../web/src/engine/collider-form.js';

/** The clearance form covering a cell's NORTH half (z 0..8/16) over its whole width: a wall band `collider_w9`. */
const NORTH_HALF = COLLIDER_KIT.VARIANTS.findIndex(d => d.id === 'craftmatic:collider_w9');

/** A column solid from the ground to `top16` sixteenths, as source cells (whole rows, the top row cut). */
function column(x: number, z: number, top16: number): SourceCell[] {
  const out: SourceCell[] = [];
  for (let y = 0; y * 16 < top16; y++) out.push({ x, y, z, lo: 0, hi: Math.min(16, top16 - y * 16) });
  return out;
}

/**
 * A straight stair up `steps` risers of `riser16` along +x (cells x 1..steps, z 2..4) onto a deck (x steps+1 ..
 * deckEnd, z 2..4) at the stair's top, in a grid `width` cells wide: open air past the deck's end and along both
 * sides. A riser of 14/16 is a jump at 100 % and past it at 200 % (the main tread rule restores it); one of 8/16
 * is still within the jump at 200 % (the model's own climb).
 */
function stairDeck(riser16: number, steps: number, deckEnd: number, width = 16): { cells: SourceCell[]; dims: GridDims; top16: number } {
  const cells: SourceCell[] = [];
  for (let i = 1; i <= steps; i++) for (let z = 2; z <= 4; z++) cells.push(...column(i, z, i * riser16));
  const top16 = steps * riser16;
  for (let x = steps + 1; x <= deckEnd; x++) for (let z = 2; z <= 4; z++) cells.push(...column(x, z, top16));
  return { cells, dims: { width, height: Math.ceil(top16 / 16) + 3, length: 8 }, top16 };
}

/** The per-tick player walking straight along +x from `from` (world blocks from the pin), jumping whenever it is stopped. */
function walkPlusX(world: WalkWorld, from: { x: number; y: number; z: number }, ticks = 400): { end: PlayerState; deepestFall: number } {
  let s: PlayerState = { ...from, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 };
  let floorY = from.y, deepestFall = 0, jump = false;
  for (let t = 0; t < ticks; t++) {
    const wasGround = s.onGround;
    if (wasGround) floorY = s.y;
    const r = tickPlayer(world, s, { move: { x: 1, z: 0 }, jump, sneak: false, autoJump: true });
    if (r.state.onGround && !wasGround) deepestFall = Math.max(deepestFall, floorY - r.state.y);
    jump = r.collided.x && r.state.onGround;
    s = r.state;
  }
  return { end: s, deepestFall };
}

/** Every surface the bare grid's walk reaches must still be reached with the plan laid, save a floor a tread now covers. */
function lostSurfaces(cells: readonly SourceCell[], dims: GridDims, plan: TreadPlan): string[] {
  const f = plan.sizePct / 100;
  const bare = new ScaledColliderGrid(cells, dims, f, plan.rotation), laid = new ScaledColliderGrid(cells, dims, f, plan.rotation);
  for (const b of plan.blocks) laid.write(b.x, b.z, { row: b.y, lo: b.lo, hi: b.hi, src16: 0 });
  const before = walkScaledColliders(bare), after = walkScaledColliders(laid);
  const covered = new Set<number>();
  for (const run of plan.runs) for (const c of run.columns) covered.add(bare.key(c.x, c.z, c.floor16));
  const lost: string[] = [];
  for (const k of before.visited) if (!after.visited.has(k) && !covered.has(k)) { const s = bare.unkey(k); lost.push(`${s.x},${s.z}@${s.t}`); }
  return lost;
}

const blocksIn = (blocks: readonly TreadBlock[], x: number): TreadBlock[] => blocks.filter(b => b.x === x);

describe('reach guards (guardPass)', () => {
  it('share the doorway drop guards\' limits: a fall past 4 blocks, a rail 1.5 blocks tall', () => {
    expect(REACH_GUARD_DROP16).toBe(GUARD_DROP16);
    expect(REACH_GUARD_HEIGHT16).toBe(GUARD_HEIGHT16);
    // Over the jump, so the rail cannot be climbed from the edge it guards.
    expect(REACH_GUARD_HEIGHT16).toBeGreaterThan(JUMP16);
  });

  it('guard the far end and both sides of a deck the treads made reachable at 200 %, and nothing at 100 %', () => {
    const m = stairDeck(14, 6, 10);
    expect(planColliderTreads(m.cells, m.dims, 100, 0).blocks).toEqual([]);
    expect(planColliderTreads(m.cells, m.dims, 100, 0).guards).toBeUndefined();
    const plan = planColliderTreads(m.cells, m.dims, 200, 0);
    expect(plan.verified).toBe(true);
    expect(plan.runs.length).toBeGreaterThan(0);
    const g = plan.guards!;
    expect(g.columns).toBeGreaterThan(0);
    expect(g.unguarded).toEqual({ door: 0, verify: 0 });
    expect(g.pastEdge).toBe(0);
    // The deck (cells 7..10 -> world x 14..21, z 4..9) at 200 % stands 10.5 blocks up; its far end is world x 22.
    const deck16 = m.top16 * 2;
    const end = blocksIn(plan.blocks, 22).filter(b => b.z >= 4 && b.z <= 9);
    expect(new Set(end.map(b => b.z))).toEqual(new Set([4, 5, 6, 7, 8, 9]));
    // Each end column holds the rail from the deck's top to 1.5 blocks over it, nothing lower.
    for (const z of [4, 5, 6, 7, 8, 9]) {
      const rows = end.filter(b => b.z === z);
      expect(Math.min(...rows.map(b => b.y * 16 + b.lo))).toBe(deck16);
      expect(Math.max(...rows.map(b => b.y * 16 + b.hi))).toBe(deck16 + REACH_GUARD_HEIGHT16);
    }
    // Both sides of the deck (world z 3 and 10) are guarded along its length.
    for (const z of [3, 10]) for (let x = 14; x <= 21; x++) expect(plan.blocks.some(b => b.x === x && b.z === z), `side ${x},${z}`).toBe(true);
    expect(lostSurfaces(m.cells, m.dims, plan)).toEqual([]);
  });

  it('stop the per-tick player at the deck\'s end, where without them it falls 10.5 blocks', () => {
    const m = stairDeck(14, 6, 10);
    const plan = planColliderTreads(m.cells, m.dims, 200, 0);
    const onDeck = { x: 15.5, y: m.top16 * 2 / 16 + 0.01, z: 6.5 };
    const guarded = walkPlusX(new WalkWorld({ cells: m.cells, dims: m.dims, sizePct: 200, rotation: 0, treads: plan.blocks }), onDeck);
    expect(guarded.deepestFall).toBeLessThanOrEqual(REACH_GUARD_DROP16 / 16);
    expect(guarded.end.y).toBeGreaterThanOrEqual(onDeck.y - 0.02);
    expect(guarded.end.x).toBeLessThan(22);
    // The treads alone (the guards taken out) let the same walk off the end.
    const guardCols = new Set(plan.guards!.sample.map(s => `${s.x},${s.z}`));
    const treadsOnly = plan.blocks.filter(b => !guardCols.has(`${b.x},${b.z}`));
    const open = walkPlusX(new WalkWorld({ cells: m.cells, dims: m.dims, sizePct: 200, rotation: 0, treads: treadsOnly }), onDeck);
    expect(open.deepestFall).toBeGreaterThan(10);
  });

  it('cap a deck that runs to the footprint\'s border, where there is no column past it to guard', () => {
    // The deck runs to the grid's last cell (x 15 -> world x 30..31 at 200 %): the border column is capped.
    const m = stairDeck(14, 6, 15);
    const plan = planColliderTreads(m.cells, m.dims, 200, 0);
    const g = plan.guards!;
    expect(g.capped).toBeGreaterThan(0);
    expect(g.pastEdge).toBe(0);
    const deck16 = m.top16 * 2;
    for (let z = 4; z <= 9; z++) expect(plan.blocks.some(b => b.x === 31 && b.z === z && b.y * 16 + b.hi === deck16 + REACH_GUARD_HEIGHT16), `cap 31,${z}`).toBe(true);
    const walk = walkPlusX(new WalkWorld({ cells: m.cells, dims: m.dims, sizePct: 200, rotation: 0, treads: plan.blocks }), { x: 15.5, y: deck16 / 16 + 0.01, z: 6.5 });
    expect(walk.deepestFall).toBeLessThanOrEqual(REACH_GUARD_DROP16 / 16);
    expect(walk.end.x).toBeLessThan(31);
    expect(lostSurfaces(m.cells, m.dims, plan)).toEqual([]);
  });

  it('guard the model\'s own reach too above 100 %: a deck reached without a tread at 200 % gets rails over its 10-block fall (round 30m)', () => {
    // Half-block risers: 1 block at 200 %, within the jump - the walk reaches the deck by itself. Until 2026-10-11
    // the model's own reach was never guarded; a player stays player-sized while the model's drops double.
    const m = stairDeck(8, 10, 13, 18);
    const plan = planColliderTreads(m.cells, m.dims, 200, 0);
    expect(plan.verified).toBe(true);
    const g = plan.guards!;
    expect(g.columns).toBeGreaterThan(0);
    expect(g.capped).toBe(0);
    expect(g.unguarded).toEqual({ door: 0, verify: 0 });
    // The deck (cells 11..13 -> world x 22..27, z 4..9) stands 10 blocks up; its far end is world x 28, its sides z 3 and 10.
    const deck16 = m.top16 * 2;
    for (const z of [4, 5, 6, 7, 8, 9]) {
      const rows = plan.guardBlocks.filter(b => b.x === 28 && b.z === z);
      expect(rows.length, `end 28,${z}`).toBeGreaterThan(0);
      expect(Math.min(...rows.map(b => b.y * 16 + b.lo))).toBe(deck16);
      expect(Math.max(...rows.map(b => b.y * 16 + b.hi))).toBe(deck16 + REACH_GUARD_HEIGHT16);
    }
    for (const z of [3, 10]) for (let x = 22; x <= 27; x++) expect(plan.guardBlocks.some(b => b.x === x && b.z === z), `side ${x},${z}`).toBe(true);
    // The stair's own risers (a 1-block step each) are no fall: nothing is laid on the stair's treads.
    expect(plan.guardBlocks.some(b => b.x <= 20 && b.z >= 4 && b.z <= 9)).toBe(false);
    expect(lostSurfaces(m.cells, m.dims, plan)).toEqual([]);
    // The per-tick player walking +x along the deck is stopped at its end instead of falling 10 blocks.
    const walk = walkPlusX(new WalkWorld({ cells: m.cells, dims: m.dims, sizePct: 200, rotation: 0, treads: plan.blocks }), { x: 23.5, y: deck16 / 16 + 0.01, z: 6.5 });
    expect(walk.deepestFall).toBeLessThanOrEqual(REACH_GUARD_DROP16 / 16);
    expect(walk.end.x).toBeLessThan(28);
    // And at 100 % the same model gets nothing: its drops are the ones the set was built with.
    expect(planColliderTreads(m.cells, m.dims, 100, 0).guards).toBeUndefined();
  });

  it('leave the model\'s own reach on the footprint\'s border open rather than cap it: a cap gives up the column', () => {
    // The deck runs to the grid's last cell (x 15 -> world x 30..31 at 200 %) and is reached bare (1-block risers).
    const m = stairDeck(8, 10, 15, 16);
    const plan = planColliderTreads(m.cells, m.dims, 200, 0);
    const g = plan.guards!;
    expect(g.capped).toBe(0);
    expect(g.pastEdge).toBeGreaterThan(0);
    // No cap on the deck's border columns (x 31, z 4..9); the deck's sides (z 3 and 10) are guarded as anywhere.
    expect(plan.guardBlocks.some(b => b.x === 31 && b.z >= 4 && b.z <= 9)).toBe(false);
    expect(plan.guardBlocks.some(b => b.x === 31 && (b.z === 3 || b.z === 10))).toBe(true);
    expect(lostSurfaces(m.cells, m.dims, plan)).toEqual([]);
  });

  it('read the edges the full cells hide over the clearance forms when the plan has the lane check (10261 at 200 %, round 30m)', () => {
    // A deck 10 blocks up reached by a stair, in a grid whose last two deck cells are a clearance form covering
    // only the NORTH half (z 0..8/16) of each cell: the full-cell reading calls both cells floor, the forms end
    // the deck's south lane two cells early. At 200 % world columns z 6..7 of those cells hold nothing.
    const m = stairDeck(8, 10, 13, 18);
    // The deck's south row (cell z 4 -> world z 8..9) in its last two cells (x 12..13 -> world x 24..27), every block
    // of the column a wall-band form over the cell's north half (`collider_w9`: x 0..16, z 0..8 of the cell).
    const south = (c: SourceCell): boolean => c.x >= 12 && c.z === 4;
    const formed: SourceCell[] = m.cells.map(c => (south(c) ? { ...c, v: NORTH_HALF } : c));
    expect(COLLIDER_KIT.formBoxes(NORTH_HALF, 0, 16)).toEqual([[0, 16, 0, 16, 0, 8]]);
    // The pipeline's full-cell reading of the same cells (bedrock-placement-pack.ts `colliderTreadsJob`).
    const full: SourceCell[] = formed.map(c => (c.v ? { x: c.x, y: c.y, z: c.z, lo: Math.min(...COLLIDER_KIT.formBoxes(c.v, c.lo, c.hi).map(b => b[2])), hi: Math.max(...COLLIDER_KIT.formBoxes(c.v, c.lo, c.hi).map(b => b[3])) } : c));
    const deck16 = m.top16 * 2;
    // Without the lane check the plan reads the full cells only: world columns (24..27, 9) read as deck.
    const gridOnly = planColliderTreads(full, m.dims, 200, 0);
    expect(gridOnly.guards!.formColumns).toBe(0);
    expect(gridOnly.guardBlocks.some(b => b.x >= 24 && b.x <= 27 && b.z === 9)).toBe(false);
    const plan = planColliderTreads(full, m.dims, 200, 0, [], [], { walk: colliderLaneWalk(formed, m.dims, 200, 0), cells: formed });
    expect(plan.verified).toBe(true);
    expect(plan.guards!.formColumns).toBeGreaterThan(0);
    // The form pass guards the open columns the south lane (world z 9) ends at, from the deck's top: x 24 from
    // the east edge of (23, 9), x 24..27 from the south edges of (24..27, 8).
    for (const x of [24, 25, 26, 27]) {
      const rows = plan.guardBlocks.filter(b => b.x === x && b.z === 9);
      expect(rows.length, `form edge ${x},9`).toBeGreaterThan(0);
      expect(Math.min(...rows.map(b => b.y * 16 + b.lo))).toBe(deck16);
    }
    expect(lostSurfaces(formed, m.dims, plan)).toEqual([]);
    // The per-tick player on the south lane over the forms is stopped at x 24 instead of falling 10 blocks.
    const walk = walkPlusX(new WalkWorld({ cells: formed, dims: m.dims, sizePct: 200, rotation: 0, treads: plan.blocks }), { x: 22.5, y: deck16 / 16 + 0.01, z: 9.5 });
    expect(walk.deepestFall).toBeLessThanOrEqual(REACH_GUARD_DROP16 / 16);
    expect(walk.end.x).toBeLessThan(24);
    const open = walkPlusX(new WalkWorld({ cells: formed, dims: m.dims, sizePct: 200, rotation: 0, treads: gridOnly.blocks }), { x: 22.5, y: deck16 / 16 + 0.01, z: 9.5 });
    expect(open.deepestFall).toBeGreaterThan(REACH_GUARD_DROP16 / 16);
  });

  it('leave a fall within the limit alone: a deck 3.5 blocks up at 200 % gets treads and no guard', () => {
    const m = stairDeck(14, 2, 8);
    const plan = planColliderTreads(m.cells, m.dims, 200, 0);
    expect(plan.runs.length).toBeGreaterThan(0);
    expect(m.top16 * 2).toBeLessThanOrEqual(REACH_GUARD_DROP16);
    expect(plan.guards?.columns ?? 0).toBe(0);
  });

  it('never stand in a doorway\'s column', () => {
    const m = stairDeck(14, 6, 10);
    // A doorway cell just past the deck's end (cell 11, z 3 -> world x 22..23, z 6..7 at 200 %).
    const plan = planColliderTreads(m.cells, m.dims, 200, 0, [], [[11, 6, 3]]);
    expect(plan.blocks.some(b => (b.x === 22 || b.x === 23) && (b.z === 6 || b.z === 7))).toBe(false);
    expect(plan.guards!.unguarded.door).toBeGreaterThan(0);
  });
});
