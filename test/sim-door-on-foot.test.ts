/**
 * PROC-20 (Pixel round 2026-11-25d): 11388 Venetian Neighborhood's double door (Doors 4/6) sits 1.06 blocks over the
 * grass at the top of the model's own blue steps between two white pillars. In Survival the tester walked up from the
 * grass and stopped ~4 blocks short of the leaf, jumping did not help; a /tp onto the sill opened the door. The
 * simulator passed it: its doorway lines START 1.5 blocks out, on the landing, and the tap reached the leaf from
 * inside the house. What stopped the walk were the pack's colliders, not the model: a full-footprint collider sheet
 * (1.00-1.06) over the lower half of the step column, drawn only at its far eighth (the sill's lip), under the
 * arch's ceiling band - no stand point gets the player's box from the step below up onto it.
 *
 * `doorSideOnFoot` asks each doorway side of the MODEL first (`DrawnWalkWorld`: does a walk from the ground over what
 * the model draws reach a spot in front of the leaf?) and then of the pack's colliders; a side the model lets a child
 * walk to and the colliders do not is the pack's (`door-approach-on-foot`).
 */
import { describe, expect, it } from 'vitest';
import { simHost, solidBelow } from './_sim-host.js';
import { doorLanesOnFoot, doorSideOnFoot, type DoorwaySide } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { DrawnWalkWorld, drawnWalkEngine, type DrawnBox } from '../web/src/sim/adapters/craftmatic/drawn.js';
import { walkFlood } from '../web/src/sim/scenario/approach.js';
import type { SimEngine } from '../web/src/sim/core/engine.js';

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): DrawnBox => ({ box: { x0, y0, z0, x1, y1, z1 }, glass: false });
const COLLIDER = 'craftmatic:collider';
const span = (lo: number, hi: number) => ({ 'craftmatic:lo': lo, 'craftmatic:hi': hi });

/**
 * The 11388 doorway in miniature: ground at y 0, the leaf's plane at x 6 (columns z 0..1, opening along +x), the
 * doorway's floor 1.0625. The model DRAWS steps 0.3 (x 3-5), 0.45 (x 5-5.5), 0.9 (x 5.5-6) up to the 1.05 sill (x 6-9),
 * an arch's ceiling 2.55 over x 3.4-4.2, walls either side and behind, and the closed leaf.
 */
const DRAWN: DrawnBox[] = [
  box(3, 5, 0, 0.3, -1, 3), box(5, 5.5, 0, 0.45, -1, 3), box(5.5, 6, 0, 0.9, -1, 3), box(6, 9, 0, 1.05, -1, 3),
  box(3.4, 4.2, 2.55, 3.3, -1, 3),
  box(3, 10, 0, 4, -2, -1), box(3, 10, 0, 4, 3, 4), box(9, 10, 0, 4, -1, 3),
  box(6, 6.15, 1.05, 3.5, -1, 3),
];

/** The pack's colliders over the same model; `sheet`: the shipped 1/16 slab over the whole step column x 5. */
function colliders(sheet: boolean) {
  const h = simHost({ terrain: solidBelow(0), colliders: true });
  for (let z = -1; z <= 2; z++) {
    for (const x of [3, 4]) h.setBlock(x, 0, z, COLLIDER, span(0, 8));
    h.setBlock(4, 2, z, COLLIDER, span(11, 16));
    h.setBlock(5, 0, z, COLLIDER, span(0, 10));
    if (sheet) h.setBlock(5, 1, z, COLLIDER, span(0, 1));
    for (let x = 6; x <= 8; x++) { h.setBlock(x, 0, z, COLLIDER, span(0, 16)); h.setBlock(x, 1, z, COLLIDER, span(0, 1)); }
    // The closed leaf's cells.
    for (let y = 1; y <= 3; y++) h.setBlock(6, y, z, COLLIDER, span(0, 16));
  }
  for (let x = 3; x <= 9; x++) for (let y = 0; y <= 3; y++) { h.setBlock(x, y, -2, COLLIDER, span(0, 16)); h.setBlock(x, y, 3, COLLIDER, span(0, 16)); }
  for (let z = -1; z <= 2; z++) for (let y = 0; y <= 3; y++) h.setBlock(9, y, z, COLLIDER, span(0, 16));
  return h;
}

const FROM = { x: 0.5, y: 0, z: 0.5 };
const AREA = { x0: -4, x1: 14, z0: -6, z1: 8 };
/** The outside side of the doorway: the leaf's columns at x 6, the spots 0.5-1.5 out toward -x. */
const OUTSIDE: DoorwaySide = { columns: [{ x: 6.5, y: 1.0625, z: 0.5 }, { x: 6.5, y: 1.0625, z: 1.5 }], n: { x: 1, z: 0 }, side: -1, floorY: 1.0625, k: 1 };

function worlds(sheet: boolean, drawnBoxes: readonly DrawnBox[] = DRAWN) {
  const h = colliders(sheet);
  const drawn = drawnWalkEngine(new DrawnWalkWorld(drawnBoxes, 0, 0.0625)) as unknown as SimEngine;
  const floods = { real: walkFlood(h.engine, 'overworld', FROM, AREA), drawn: walkFlood(drawn, 'overworld', FROM, AREA) };
  return { h, drawn, floods };
}
function judge(sheet: boolean, drawnBoxes: readonly DrawnBox[] = DRAWN) {
  const { h, drawn, floods } = worlds(sheet, drawnBoxes);
  return doorSideOnFoot(h.engine, drawn, 'overworld', FROM, floods, OUTSIDE);
}
function lanes(sheet: boolean, drawnBoxes: readonly DrawnBox[] = DRAWN) {
  const { h, drawn, floods } = worlds(sheet, drawnBoxes);
  return doorLanesOnFoot(h.engine, drawn, 'overworld', floods, OUTSIDE);
}

describe('sim child play: a doorway the model lets a child walk up to, the colliders must too (door-approach-on-foot, PROC-20)', () => {
  it('a collider sheet over the step under the arch keeps the walk off the landing the model draws (11388 Doors 4/6, Pixel round 25d)', () => {
    const v = judge(true);
    expect(v.drawn).toBe(true);
    expect(v.colliders).toBe(false);
    // The drawn route leaves the colliders' walk at the step column under the sheet.
    expect(v.blame).toMatch(/the drawn route leaves the colliders' walk/);
    expect(v.blame).toMatch(/to 5\.\d+,/);
  });

  it('the same steps without the sheet are walked up to the landing', () => {
    const v = judge(false);
    expect(v.drawn).toBe(true);
    expect(v.colliders).toBe(true);
    expect(v.blame).toBeUndefined();
  });

  it('a doorway the model itself gives no way up to is not the pack\'s', () => {
    // No steps: a wall three blocks high stands before the leaf, and the landing behind it is the model's own room.
    const v = judge(true, [box(3, 5, 0, 0.3, -1, 3), box(5, 6, 0, 3, -1, 3), box(6, 9, 0, 1.05, -1, 3), ...DRAWN.slice(4)]);
    expect(v.drawn).toBe(false);
  });

  it('a child pushing straight at the door stops under the arch on every lane the model lets it walk (11388 Doors 4/6 straight lanes)', () => {
    // The planner's flood can find a zig-zag round a sheet that covers only part of a row; the device walked straight.
    const v = lanes(true);
    expect(v.drawn).toBeGreaterThan(5);
    expect(v.colliders).toBe(0);
    // Every lane stops at the step under the sheet, short of x 5; the landing is on the top steps past it.
    for (const l of v.lanes) { expect(l.stop.x).toBeLessThan(5); expect(l.goal.x).toBeGreaterThan(5); }
  });

  it('without the sheet every straight lane reaches the landing', () => {
    const v = lanes(false);
    expect(v.drawn).toBeGreaterThan(5);
    expect(v.colliders).toBe(v.drawn);
  });
});
