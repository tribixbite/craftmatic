/**
 * Invisible guards where a doorway opens onto a drop (`planDropGuards`,
 * docs/bedrock-interactivity.md "A doorway over a drop").
 *
 * 76417's Gate 1 is a barred gate in the bank's outer wall, 17 blocks over the
 * grass with nothing drawn outside it (Saga round 2026-09-30i). No access stair
 * reaches that high, so the gate leads nowhere - but a child walking through
 * it may not walk into the air: the columns on the side whose floor is more
 * than `GUARD_DROP16` under the doorway's landing get a guard `GUARD_HEIGHT16`
 * tall. A drop a stair could serve, a stair already laid, or a side that is
 * the model's own floor gets none.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { colliderState } from '../web/src/engine/bedrock-building-shell.js';
import { GUARD_DROP16, GUARD_HEIGHT16, planDropGuards, type InteractiveColliderPlan, type StairCandidate } from '../web/src/engine/bedrock-interactives.js';
import { parseFormState } from '../web/src/engine/collider-clearance.js';

/** A 12 x 14 x 12 grid with a tower: x 0..3 full from the ground to `top` blocks (whole rows), the door's floor at `top`. */
function tower(top: number): BlockGrid {
  const g = new BlockGrid(12, 14, 12);
  for (let x = 0; x <= 3; x++) for (let z = 0; z < 12; z++) for (let y = 0; y < top; y++) g.set(x, y, z, colliderState(0, 16));
  return g;
}

/** A door at column (3, 5) facing +x, its closed cells over the tower's top. */
function doorPlan(door: number): InteractiveColliderPlan {
  return { blocking: [[3, door, 5, 0, 16], [3, door + 1, 5, 0, 16], [3, door + 2, 5, 0, 8]], neighbours: [], cleared: 0, passageCleared: 0, treads: 0, stairTreads: 0, stairs: [], approach: [], floor16: door * 16 };
}

const side = (dir: 1 | -1, door: number): StairCandidate => ({ item: 0, cx: 3, cz: 5, gn: [1, 0], dir, door });

describe('planDropGuards', () => {
  it('guards the column a door opens onto when nothing is under it for 10 blocks, a jump and a half tall', () => {
    const g = tower(10);
    const plans = [doorPlan(10)];
    planDropGuards(g, plans, [side(1, 10)], new Map([['3,5', 0]]));
    // The column in front (x 4) gets a guard from the doorway's floor up 1.5 blocks: a full row and half of the next.
    expect(g.get(4, 10, 5)).toBe(colliderState(0, 16));
    expect(g.get(4, 11, 5)).toBe(colliderState(0, GUARD_HEIGHT16 - 16));
    expect(g.get(4, 12, 5)).toBe('minecraft:air');
    // Only the column on the side, beside the leaf: not the columns along the facade, not the leaf's own.
    expect(g.get(4, 10, 4)).toBe('minecraft:air');
    expect(g.get(3, 10, 5)).toBe('minecraft:air');
    expect(plans[0]!.guardCells).toEqual([[4, 10, 5, 0, 16], [4, 11, 5, 0, 8]]);
    expect(plans[0]!.stairs.join()).toMatch(/guarded a drop of more than 4 blocks \(2 cells over 1 column\)/);
  });

  it('follows the landing out: a 2-block ledge in front of the door is walked, and its edge is guarded', () => {
    const g = tower(10);
    // A ledge at the doorway's level in front: x 4..5 at z 4..6.
    for (let x = 4; x <= 5; x++) for (let z = 4; z <= 6; z++) g.set(x, 9, z, colliderState(0, 16));
    const plans = [doorPlan(10)];
    planDropGuards(g, plans, [side(1, 10)], new Map([['3,5', 0]]));
    // The ledge stays a floor with nothing over it; past its edge (x 6, and z 3 / z 7 beside it) is guarded.
    for (let x = 4; x <= 5; x++) expect(g.get(x, 10, 5)).toBe('minecraft:air');
    expect(g.get(6, 10, 5)).toBe(colliderState(0, 16));
    expect(g.get(4, 10, 3)).toBe(colliderState(0, 16));
    expect(g.get(5, 10, 7)).toBe(colliderState(0, 16));
  });

  it('lays nothing where the fall is one a stair could serve, or the other side is the model\'s own floor', () => {
    // A door 3 blocks up: a fall of 3 is under GUARD_DROP16 (4 blocks), the stair planner's business.
    const low = tower(3);
    const plans = [doorPlan(3)];
    expect(3 * 16).toBeLessThanOrEqual(GUARD_DROP16);
    planDropGuards(low, plans, [side(1, 3)], new Map([['3,5', 0]]));
    expect(plans[0]!.guardCells).toBeUndefined();
    expect(plans[0]!.stairs).toEqual([]);
    // The inside of the tower (-x) is its own floor at the doorway's level: no drop, no guard.
    const high = tower(10);
    const inside = [doorPlan(10)];
    planDropGuards(high, inside, [side(-1, 10)], new Map([['3,5', 0]]));
    expect(inside[0]!.guardCells).toBeUndefined();
    let changed = 0;
    for (let x = 0; x < 12; x++) for (let y = 0; y < 14; y++) for (let z = 0; z < 12; z++) if (parseFormState(high.get(x, y, z)) && (x > 3 || y >= 10)) changed++;
    expect(changed).toBe(0);
  });

  it('never fills a cell a ride, a figure or a vehicle uses, and reports a drop past the grid\'s edge', () => {
    const g = tower(10);
    const plans = [doorPlan(10)];
    planDropGuards(g, plans, [side(1, 10)], new Map([['3,5', 0]]), new Set(['4,11,5']));
    expect(g.get(4, 10, 5)).toBe('minecraft:air');
    expect(plans[0]!.stairs.join()).toMatch(/a drop it could not guard/);
    // A door at the grid's edge: the drop lies past it, where no collider can go.
    const edge = new BlockGrid(4, 14, 12);
    for (let x = 0; x <= 3; x++) for (let z = 0; z < 12; z++) for (let y = 0; y < 10; y++) edge.set(x, y, z, colliderState(0, 16));
    const p2 = [doorPlan(10)];
    planDropGuards(edge, p2, [side(1, 10)], new Map([['3,5', 0]]));
    expect(p2[0]!.stairs.join()).toMatch(/1 column past the grid's edge unguarded/);
  });
});
