/**
 * Invisible access stairs up to a raised door (`planThresholdStairs`,
 * docs/bedrock-interactivity.md "Stairs up to a raised threshold" and "Access
 * steps").
 *
 * A door on a base 1.5 blocks over open ground reads SEALED/ONE-WAY: nobody
 * walks up to it. The planner lays treads, each half a block (`STAIR_RISE16`)
 * below the last, down to the ground - straight out where it can, turning
 * along the facade where that is blocked - but only in open air a flying
 * player reaches from outside with every door closed, never inside a closed
 * room, never in a doorway, never in front of a lower door and never through
 * a cell the pack's rides, vehicles or figures use (`avoid`). A side a player
 * already reaches with a jump gets none.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { colliderState } from '../web/src/engine/bedrock-building-shell.js';
import { ACCESS_MARGIN_MAX, STAIR_MAX_TREADS, STAIR_RISE16, accessAvoidCells, accessMarginFor, planThresholdStairs, type InteractiveColliderPlan, type StairCandidate } from '../web/src/engine/bedrock-interactives.js';
import { addLayerBox, newCellLayers, parseFormState, type CellLayers } from '../web/src/engine/collider-clearance.js';

/** A 12 x 8 x 12 grid with a raised base: rows 0 at x 0..3 (full) and row 1 at x 0..3 up to `baseHi16` - a door's floor at 1 + baseHi16/16. */
function raisedBase(baseHi16: number): BlockGrid {
  const g = new BlockGrid(12, 8, 12);
  for (let x = 0; x <= 3; x++) for (let z = 0; z < 12; z++) {
    g.set(x, 0, z, colliderState(0, 16));
    g.set(x, 1, z, colliderState(0, baseHi16));
  }
  return g;
}

/** A door at column (3, 5) facing +x, its closed cells on the base. */
function doorPlan(door: number): InteractiveColliderPlan {
  const floorRow = Math.floor(door), lo = Math.round((door - floorRow) * 16);
  return { blocking: [[3, floorRow, 5, lo, 16], [3, floorRow + 1, 5, 0, 16], [3, floorRow + 2, 5, 0, 8]], neighbours: [], cleared: 0, passageCleared: 0, treads: 0, stairTreads: 0, stairs: [], approach: [], floor16: floorRow * 16 + lo };
}

/** The top (sixteenths, absolute) of the collider column at (x, z), or 0 for the ground. */
function columnTop(g: BlockGrid, x: number, z: number): number {
  let top = 0;
  for (let y = 0; y < g.height; y++) {
    const f = parseFormState(g.get(x, y, z));
    if (f) top = y * 16 + f.hi;
  }
  return top;
}

describe('planThresholdStairs', () => {
  it('lays auto-step treads from a 1.5-block threshold down to open ground', () => {
    const g = raisedBase(8); // door floor 1.5 blocks = 24/16
    const plans = [doorPlan(1.5)];
    const cand: StairCandidate = { item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 1.5 };
    planThresholdStairs(g, plans, [cand], new Map([['3,5', 0]]));
    expect(plans[0]!.stairTreads).toBeGreaterThan(0);
    expect(plans[0]!.stairs.join()).toMatch(/laid 2 treads/);
    // Walking out: 24 -> x4 -> x5 -> ground; every step at most 9/16, none a hole under a tread.
    const tops = [24, columnTop(g, 4, 5), columnTop(g, 5, 5), columnTop(g, 6, 5)];
    for (let k = 1; k < tops.length; k++) expect(tops[k - 1]! - tops[k]!).toBeLessThanOrEqual(9);
    expect(tops[3]).toBe(0);
    // Each tread is solid from the ground up (no pocket under it).
    for (const x of [4, 5]) expect(parseFormState(g.get(x, 0, 5))?.lo).toBe(0);
    // Nothing laid beside the run.
    expect(columnTop(g, 4, 4)).toBe(0);
  });

  it('refuses a stair inside a closed room (not reached from outside with the doors shut)', () => {
    const g = raisedBase(8);
    // A sealed box around the space in front of the door: walls at x 8, z 2 and z 8, a roof at row 4.
    for (let x = 4; x <= 8; x++) for (let z = 2; z <= 8; z++) for (let y = 0; y <= 4; y++) {
      const wall = x === 8 || z === 2 || z === 8 || y === 4;
      if (wall) g.set(x, y, z, colliderState(0, 16));
    }
    // The wall over the base closes the room's fourth side above the door.
    for (let z = 2; z <= 8; z++) for (let y = 2; y <= 4; y++) if (z !== 5) g.set(3, y, z, colliderState(0, 16));
    g.set(3, 4, 5, colliderState(0, 16));
    const plans = [doorPlan(1.5)];
    planThresholdStairs(g, plans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 1.5 }], new Map([['3,5', 0]]));
    expect(plans[0]!.stairTreads).toBe(0);
    expect(plans[0]!.stairs.join()).toMatch(/not outside/);
    for (const y of [0, 1]) expect(parseFormState(g.get(4, y, 5))).toBeNull(); // no tread under the roof
  });

  it('lays a straight half-block stair from a 2.75-block threshold (was past the old 2.5-block limit)', () => {
    const tall = raisedBase(16);
    for (let x = 0; x <= 3; x++) for (let z = 0; z < 12; z++) tall.set(x, 2, z, colliderState(0, 12)); // floor 2.75 = 44/16
    const plans = [doorPlan(2.75)];
    planThresholdStairs(tall, plans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 2.75 }], new Map([['3,5', 0]]));
    expect(plans[0]!.stairs.join()).toMatch(/laid 5 treads over a rise of 44\/16$/);
    const tops = [44, ...[4, 5, 6, 7, 8, 9].map(x => columnTop(tall, x, 5))];
    expect(tops[6]).toBe(0);
    for (let k = 1; k < tops.length; k++) expect(tops[k - 1]! - tops[k]!).toBeLessThanOrEqual(STAIR_RISE16);
  });

  it('refuses a rise past the limit and an off-axis leaf', () => {
    // 4.5 blocks: more than `STAIR_MAX_TREADS` half-block treads.
    const tall = new BlockGrid(14, 8, 12);
    for (let x = 0; x <= 3; x++) for (let z = 0; z < 12; z++) {
      for (let y = 0; y < 4; y++) tall.set(x, y, z, colliderState(0, 16));
      tall.set(x, 4, z, colliderState(0, 8));
    }
    const plans = [doorPlan(4.5)];
    planThresholdStairs(tall, plans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 4.5 }], new Map([['3,5', 0]]));
    expect(plans[0]!.stairTreads).toBe(0);
    expect(plans[0]!.stairs.join()).toMatch(new RegExp(`more than ${STAIR_MAX_TREADS} treads`));
    const g = raisedBase(8), diag = [doorPlan(1.5)];
    planThresholdStairs(g, diag, [{ item: 0, cx: 3, cz: 5, gn: [Math.SQRT1_2, Math.SQRT1_2], dir: 1, door: 1.5 }], new Map([['3,5', 0]]));
    expect(diag[0]!.stairs.join()).toMatch(/off-axis/);
  });

  it('keeps clear of a lower door beside the run', () => {
    const g = raisedBase(8);
    const plans = [doorPlan(1.5), { ...doorPlan(0), blocking: [[5, 0, 6, 0, 16] as [number, number, number, number, number]] }];
    planThresholdStairs(g, plans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 1.5 }], new Map([['3,5', 0], ['5,6', 1]]));
    expect(plans[0]!.stairTreads).toBe(0);
    expect(plans[0]!.stairs.join()).toMatch(/another doorway/);
  });
  it('turns along the facade where the straight run is blocked, and never lays a tread next to nothing', () => {
    const g = raisedBase(8);
    // A post two columns out on the door's line: the straight run stops at step 2.
    for (let y = 0; y < 4; y++) g.set(5, y, 5, colliderState(0, 16));
    const plans = [doorPlan(1.5)];
    planThresholdStairs(g, plans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 1.5 }], new Map([['3,5', 0]]));
    expect(plans[0]!.stairs.join()).toMatch(/laid 2 treads over a rise of 24\/16 \(1 turn along the facade\)/);
    // x4 z5 then along the facade (z 4 or z 6), down to the ground.
    expect(columnTop(g, 4, 5)).toBe(16);
    expect(Math.max(columnTop(g, 4, 4), columnTop(g, 4, 6))).toBe(8);
  });

  it('keeps out of the cells a ride, a vehicle or a figure uses', () => {
    const g = raisedBase(8);
    const plans = [doorPlan(1.5)];
    // A slide chute running along z past the door's front, one column out.
    const avoid = accessAvoidCells({ paths: [[[4.5, 1.2, 0.5], [4.5, 1.2, 11.5]]] });
    planThresholdStairs(g, plans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 1.5 }], new Map([['3,5', 0]]), undefined, avoid);
    expect(plans[0]!.stairTreads).toBe(0);
    expect(plans[0]!.stairs.join()).toMatch(/in the way of a ride, a vehicle or a figure/);
  });

  it('lays nothing where a jump already reaches the doorway (1.25 blocks)', () => {
    const g = raisedBase(4); // door floor 1.25 = 20/16
    const plans = [doorPlan(1.25)];
    planThresholdStairs(g, plans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 1.25 }], new Map([['3,5', 0]]));
    expect(plans[0]!.stairTreads).toBe(0);
    expect(plans[0]!.stairs).toEqual([]);
  });

  it('stands on the doorway\'s own lip (a wall band clearance keeps as its landing), never on a rim further out', () => {
    /** A thin wall band (x 0..4 sixteenths) in cell (x, 1, 5), topping out at 1 + 10/16. */
    const withRim = (x: number): { g: BlockGrid; layers: CellLayers } => {
      const g = raisedBase(8), layers: CellLayers = new Map();
      g.set(x, 1, 5, colliderState(0, 10));
      g.set(x, 0, 5, colliderState(0, 16));
      const lower = newCellLayers(); addLayerBox(lower, 0, 4, 0, 16, 0, 16);
      const rim = newCellLayers(); addLayerBox(rim, 0, 4, 0, 10, 0, 16);
      layers.set((x * g.height + 0) * g.length + 5, lower);
      layers.set((x * g.height + 1) * g.length + 5, rim);
      return { g, layers };
    };
    const near = withRim(4), plans = [doorPlan(1.5)];
    planThresholdStairs(near.g, plans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 1.5 }], new Map([['3,5', 0]]), near.layers);
    expect(plans[0]!.stairs.join()).toMatch(/laid \d treads over a rise of 24\/16$/);
    const far = withRim(6), farPlans = [doorPlan(1.5)];
    planThresholdStairs(far.g, farPlans, [{ item: 0, cx: 3, cz: 5, gn: [1, 0], dir: 1, door: 1.5 }], new Map([['3,5', 0]]), far.layers);
    // Straight out meets the rim at step 3; the run turns along the facade instead of standing on it.
    expect(farPlans[0]!.stairs.join()).toMatch(/turn/);
    expect(columnTop(far.g, 6, 5)).toBe(26);
  });
});

describe('accessMarginFor', () => {
  const door = { min: [10, 2.875, 1] as [number, number, number], max: [11.4, 5.4, 1.4] as [number, number, number], normal: 'z' as const };
  it('widens the side a raised door faces out of by the treads a straight run needs', () => {
    // 46/16 over the ground: ceil((46 + 8) / 8) - 1 = 6 treads and a landing; one column is already in front.
    expect(accessMarginFor([door], { width: 20, height: 16, length: 13 }, () => false)).toEqual({ x0: 0, x1: 0, z0: 6, z1: 0 });
  });
  it('widens nothing for a door a jump over the ground, or on the side a facade stands in front of', () => {
    expect(accessMarginFor([{ ...door, min: [10, 1.25, 1] }], { width: 20, height: 16, length: 13 }, () => false)).toEqual({ x0: 0, x1: 0, z0: 0, z1: 0 });
    // The chest row over the leaf's foot (row 4) holds the model's wall in front of the door.
    expect(accessMarginFor([door], { width: 20, height: 16, length: 13 }, (x, y, z) => y === 4 && z === 0 && x === 10)).toEqual({ x0: 0, x1: 0, z0: 0, z1: 0 });
  });
  it('never widens a side past ACCESS_MARGIN_MAX', () => {
    const high = { ...door, min: [10, 6, 0] as [number, number, number] };
    expect(accessMarginFor([high], { width: 20, height: 16, length: 13 }, () => false).z0).toBe(ACCESS_MARGIN_MAX);
  });
});
