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
import { LANE_HEADROOM, doorLanesOnFoot, doorSideOnFoot, judgeDoorSide, routeSqueezedAt, slackDrawn, type DoorwaySide } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { COLLIDER_SLACK } from '../web/src/sim/adapters/craftmatic/play.js';
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

  /**
   * Pixel round 2026-11-25e (gate-j pack, `output/device-round-2026-11-25e/pixel-25e/notes.md`): the lane the
   * simulator stopped dead at the arcade column's head band (z origin+6.6, a band 0.2 into the player's box) was walked
   * onto the sill on the phone, joystick held forward 8 s. An exactly axis-aligned walk stops against the band's face
   * for good; a push a fraction of a degree off the axis slides along that face and clears it (0.5-0.7 degrees
   * reproduces the device's end, Position z 6006 on the sill), and no heading within a degree got the 25d pack's
   * lanes onto the sill, which the phone could not walk either. The lanes are walked within `LANE_HEADING_DEG`.
   */
  it('a lane whose colliders stand a sliver past the drawn post into it slides off with the push a child gives (11388 Doors 4/6, Pixel round 25e)', () => {
    // A post the model draws to z -0.4 in front of the steps (to -0.15 with the colliders' slack, `slackDrawn`); its
    // collider fills the block to z 0.0, under the head.
    const post = box(4, 5, 0, 4, -1, -0.4);
    const { drawn, floods } = worlds(false, slackDrawn([...DRAWN, post]));
    const h = colliders(false);
    for (let y = 0; y <= 3; y++) h.setBlock(4, y, -1, COLLIDER, span(0, 16));
    const real = { real: walkFlood(h.engine, 'overworld', FROM, AREA), drawn: floods.drawn };
    const v = doorLanesOnFoot(h.engine, drawn, 'overworld', real, OUTSIDE);
    // The lane whose box overlaps the collider by 0.1 but clears the drawn post (lateral -0.3: z 0.2, box -0.1..0.5).
    const sliver = v.lanes.find(l => Math.abs(l.lateral - -0.3) < 1e-6);
    expect(sliver).toBeDefined();
    expect(sliver!.colliders).toBe(true);
  });

  it('with the colliders\' slack the 25d sheet still stops every lane the model lets a child walk', () => {
    const v = lanes(true, slackDrawn(DRAWN));
    expect(v.drawn).toBeGreaterThan(3);
    expect(v.colliders).toBe(0);
  });

  /** `judgeDoorSide` over a drawn model and the 25d-style colliders (`sheet`). */
  function side(sheet: boolean, drawnBoxes: readonly DrawnBox[]) {
    const { h, drawn, floods } = worlds(sheet, drawnBoxes);
    const widened = slackDrawn(drawnBoxes);
    const drawnSlack = drawnWalkEngine(new DrawnWalkWorld(widened, 0, 0.0625)) as unknown as SimEngine;
    const all = { ...floods, drawnSlack: walkFlood(drawnSlack, 'overworld', FROM, AREA) };
    const anyTop = drawnWalkEngine(new DrawnWalkWorld(drawnBoxes, 0, 0)) as unknown as SimEngine;
    return judgeDoorSide(h.engine, { drawn, drawnSlack, anyTop }, 'overworld', FROM, all, OUTSIDE);
  }

  it('a walk the model leaves only a sliver wide is the model\'s squeeze, not the pack\'s (judgeDoorSide tight; 42670 Garage door 1)', () => {
    // A planter and a post either side of the only way to the steps, 0.63 apart: a 0.6-wide body passes them 0.015 clear.
    const squeeze = [...DRAWN.slice(0, 4), box(0, 3, 0, 4, -6, 0.2), box(0, 3, 0, 4, 0.83, 8), ...DRAWN.slice(4)];
    const v = side(true, squeeze);
    expect(v.side.drawn).toBe(true);
    expect(v.side.colliders).toBe(false);
    expect(v.tight).toBe(true);
    // The open approach under the same sheet stays the pack's.
    const open = side(true, DRAWN);
    expect(open.side.colliders).toBe(false);
    expect(open.tight).toBe(false);
  });

  /**
   * gate-k (2026-11-25), 910032 Door 4's - side, a dining nook: the drawn route steps into a pocket 0.025 past a bench's
   * end, whose collider band fills the cell, and climbs the bench to the door. The widened world reached the side
   * anyway, over a floor plate's top widened into a cell the colliders leave empty (TODO(slack-phantom-footing)), so the
   * squeeze is read where the drawn route leaves the colliders' walk (`routeSqueezedAt`).
   */
  it('a drawn route that leaves the colliders\' walk within their slack of the model is the model\'s squeeze (routeSqueezedAt; 910032 Door 4, gate-k)', () => {
    const anyTop = drawnWalkEngine(new DrawnWalkWorld([box(9.625, 10.375, 0, 1.125, -2.5, -0.25)], 0, 0)) as unknown as SimEngine;
    const at = (px: number, pz: number, y = 0.225) => ({ x: Math.floor(px), z: Math.floor(pz), y, px, pz });
    // 910032's pocket node: the box 10.4-11.0 stands 0.025 past the bench's end.
    expect(routeSqueezedAt(anyTop, 'overworld', at(10.7, -2.7), 1)).toBe(true);
    // Half a block clear of it, and the bench's own top, are not squeezes.
    expect(routeSqueezedAt(anyTop, 'overworld', at(11.3, -1.5), 1)).toBe(false);
    expect(routeSqueezedAt(anyTop, 'overworld', at(10, -1.5, 1.125), 1)).toBe(false);
    // A step (no more than 9/16 over the feet) beside the node is walked onto, not squeezed past.
    const step = drawnWalkEngine(new DrawnWalkWorld([box(9.625, 10.375, 0, 0.75, -2.5, -0.25)], 0, 0)) as unknown as SimEngine;
    expect(routeSqueezedAt(step, 'overworld', at(10.7, -2.7), 1)).toBe(false);
  });

  it('judgeDoorSide reads a side tight where the route breaks in a squeeze, even when the widened world finds a way (910032 Door 4, gate-k)', () => {
    // The planter and post 0.63 apart (42670), inside one cell, now with colliders: the cell holds both faces, and no
    // form leaves a gap between two bands, so it is laid whole.
    // The posts run past the flood's area, so the only way in is the gap; the child starts west of them.
    const squeeze = [...DRAWN.slice(0, 4), box(0, 3, 0, 4, -20, 0.2), box(0, 3, 0, 4, 0.83, 20), ...DRAWN.slice(4)];
    const west = { x: -1.5, y: 0, z: 0.5 };
    const h = colliders(false);
    for (let x = 0; x <= 2; x++) for (let y = 0; y <= 3; y++) {
      for (let z = -20; z <= -1; z++) h.setBlock(x, y, z, COLLIDER, span(0, 16));
      for (let z = 0; z <= 19; z++) h.setBlock(x, y, z, COLLIDER, span(0, 16));
    }
    const drawn = drawnWalkEngine(new DrawnWalkWorld(squeeze, 0, 0.0625)) as unknown as SimEngine;
    const anyTop = drawnWalkEngine(new DrawnWalkWorld(squeeze, 0, 0)) as unknown as SimEngine;
    const flood = walkFlood(drawn, 'overworld', west, AREA);
    // The widened world stands in for one that found another way: the drawn world itself.
    const floods = { real: walkFlood(h.engine, 'overworld', west, AREA), drawn: flood, drawnSlack: flood };
    const v = judgeDoorSide(h.engine, { drawn, drawnSlack: drawn, anyTop }, 'overworld', west, floods, OUTSIDE);
    expect(v.side.drawn).toBe(true);
    expect(v.side.colliders).toBe(false);
    expect(v.side.breakAt).toBeDefined();
    expect(v.tight).toBe(true);
    // The 25d sheet's break (the step under the sheet, clear of the model by more than the slack) stays the pack's.
    expect(side(true, DRAWN).tight).toBe(false);
  });

  /**
   * gate-k (2026-11-25): 76269 Door 3 (+ side) - every straight lane the model lets a child walk passes 0.08 under a
   * hanging glass piece and 0.01 beside a glass stand, which the colliders (supersets by up to COLLIDER_SLACK, and a
   * sixteenth up or down) close; 6194 Door 1 (- side, a diagonal door at a building's corner) - every lane runs into
   * the facade and arrives only by sliding along it, where the colliders' pocket (a closed leaf's block 0.19 behind the
   * drawn face, the wall end's corner square at the face) catches it. Neither is a straight walk the model leaves room
   * for: a lane is the model's only where its walk keeps COLLIDER_SLACK clear of every drawn cube it cannot climb.
   */
  it('a lane that passes within the colliders\' slack under a hanging part is the model\'s squeeze, not a lane (76269 Door 3, gate-k)', () => {
    const hang = box(1, 2, 1.88, 2.3, -1, 3);
    const open = lanes(false, [...DRAWN, hang]);
    expect(open.drawn).toBeGreaterThan(5);
    const { h, drawn, floods } = worlds(false, [...DRAWN, hang]);
    const v = doorLanesOnFoot(h.engine, drawn, 'overworld', floods, OUTSIDE, { clearance: COLLIDER_SLACK, headroom: LANE_HEADROOM });
    expect(v.drawn).toBe(0);
    expect(v.squeezed).toBe(open.drawn);
    // Without the hanging part the same clearance keeps every lane.
    const plain = doorLanesOnFoot(h.engine, worlds(false).drawn, 'overworld', worlds(false).floods, OUTSIDE, { clearance: COLLIDER_SLACK, headroom: LANE_HEADROOM });
    expect(plain.drawn).toBe(lanes(false).drawn);
  });

  it('a lane that only grazes a wall face is dropped, the lanes clear of it are kept (6194 Door 1, gate-k)', () => {
    const wall = box(0, 4, 0, 3, -1, 0.05);
    const { h, drawn, floods } = worlds(false, [...DRAWN, wall]);
    const v = doorLanesOnFoot(h.engine, drawn, 'overworld', floods, OUTSIDE, { clearance: COLLIDER_SLACK, headroom: LANE_HEADROOM });
    expect(v.drawn).toBeGreaterThan(5);
    expect(v.squeezed).toBeGreaterThan(0);
    for (const l of v.lanes.filter(x => !x.squeezed)) expect(l.start.z - 0.3 - 0.05).toBeGreaterThanOrEqual(COLLIDER_SLACK - 1e-6);
    // A squeezed lane is still walked over the colliders, and one they pass clears the side (6194 Door 2, + side).
    expect(v.colliders).toBe(v.drawn + v.squeezed);
  });

  it('judgeDoorSide does not fail a side whose only lanes squeeze under a hanging part the colliders close (76269 Door 3, gate-k)', () => {
    const hang = box(1, 2, 1.88, 2.3, -1, 3);
    const drawnBoxes = [...DRAWN, hang];
    const h = colliders(false);
    // The hanging part's collider: a slab 1.75-2.0 over the cells the lanes cross; the flood still walks round at z -2..-1.
    for (let z = -1; z <= 2; z++) h.setBlock(1, 1, z, COLLIDER, span(12, 16));
    const drawn = drawnWalkEngine(new DrawnWalkWorld(drawnBoxes, 0, 0.0625)) as unknown as SimEngine;
    const drawnSlack = drawnWalkEngine(new DrawnWalkWorld(slackDrawn(drawnBoxes), 0, 0.0625)) as unknown as SimEngine;
    const anyTop = drawnWalkEngine(new DrawnWalkWorld(drawnBoxes, 0, 0)) as unknown as SimEngine;
    const floods = { real: walkFlood(h.engine, 'overworld', FROM, AREA), drawn: walkFlood(drawn, 'overworld', FROM, AREA), drawnSlack: walkFlood(drawnSlack, 'overworld', FROM, AREA) };
    const v = judgeDoorSide(h.engine, { drawn, drawnSlack, anyTop }, 'overworld', FROM, floods, OUTSIDE);
    expect(v.side.drawn).toBe(true);
    expect(v.side.colliders).toBe(true);
    // Over the colliders no lane gets past the slab, and no lane the model leaves room for is left to judge.
    expect(doorLanesOnFoot(h.engine, anyTop, 'overworld', floods, OUTSIDE).colliders).toBe(0);
    expect(v.lanes?.drawn).toBe(0);
    expect(v.lanes?.squeezed).toBeGreaterThan(5);
  });

  it('a side the model\'s own flood never reaches is not judged by its lanes (judgeDoorSide; 42670 Door 3)', () => {
    const wall = [box(3, 5, 0, 0.3, -1, 3), box(5, 6, 0, 3, -1, 3), box(6, 9, 0, 1.05, -1, 3), ...DRAWN.slice(4)];
    const v = side(true, wall);
    expect(v.side.drawn).toBe(false);
    expect(v.lanes).toBeUndefined();
    expect(side(false, DRAWN).lanes?.colliders).toBeGreaterThan(5);
  });
});
