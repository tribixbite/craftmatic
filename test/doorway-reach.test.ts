/**
 * A door a minifig uses in the real set is a door the player uses at 100 %
 * (docs/bedrock-interactivity.md, "Doors a minifig uses, at 100 %"). Each rule
 * the 2026-09-29 round added is pinned here on a small synthetic grid, so each
 * test fails if its rule is removed:
 *
 *   - an opening is passable from the size at which it holds a MINIFIG
 *     (0.75 x 1.8 blocks at minifig scale), not a whole-block 1 x 2 passage,
 *     measured at the model's own scale;
 *   - clearance lets a phantom top go when it stands in a doorway's approach
 *     at a player's body height (collider-clearance.ts rule 4, `approachTop`),
 *     and nowhere else;
 *   - the collider grid and the layer geometry round a box edge ON a
 *     sixteenth the same way, float noise or not;
 *   - the passability walk finds a way through a corridor that straddles a
 *     column boundary (the fine lattice), and never counts a route that
 *     crosses the leaf's plane anywhere but in the doorway, at its level.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { COLLIDER_KIT, type Box16, type ColliderForm } from '../web/src/engine/collider-form.js';
import { addLayerBox, applyColliderClearance, layerSpan, newCellLayers, parseFormState, formState, type CellLayers } from '../web/src/engine/collider-clearance.js';
import { buildColliderGrid, colliderCellIndex, colliderState, COLLIDER_BLOCK_ID, COLLIDER_HI_STATE, COLLIDER_LO_STATE } from '../web/src/engine/bedrock-building-shell.js';
import {
  INTERACTIVE_FAMILY, INTERACTIVE_PROPERTY, INTERACTIVE_SIZE_PROPERTY, INTERACTIVE_TURN_PROPERTY, interactiveRuntimeItem, passSizeFor, planInteractiveColliders,
  type InteractiveRuntimeConfig, type SceneInteractive,
} from '../web/src/engine/bedrock-interactives.js';
import { doorwayColumnLines, doorwayHoles, verdictOf, walkThroughDoorway } from '../web/src/engine/interactive-walk.js';
import { DOORWAY_PASS_HEIGHT_LDU, DOORWAY_PASS_WIDTH_LDU } from '../web/src/engine/addon-scale.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { SourceCell } from '../web/src/engine/bedrock-collider-scale.js';
import type { SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';
import type { Vec3 } from '../web/src/engine/ldraw-part-geometry.js';

const C = LDU_PER_BLOCK;
/** The grid frame at minifig scale, origin at LDraw 0: grid (x, y, z) = LDraw (x, -y, -z) / C. */
const frame: SceneGridFrame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: C, cellY: C };

/** A door leaf standing on grid row `floor` at grid x `x0`..`x0 + width`, mid-plane at grid z `zc`, facing ±z. */
function leafAt(x0: number, width: number, zc: number, height = 2.6, floor = 1): SceneInteractive {
  const corner: Vec3 = [x0 * C, -floor * C, -zc * C];
  return {
    kind: 'door', part: 'test', description: 'Door', bricks: [], pivotLdu: corner, axisLdu: [0, 1, 0], angleDeg: 90,
    leaf: { corner, along: [width * C, 0, 0], up: [0, -height * C, 0], normal: [0, 0, 1], thicknessLdu: 6 },
    anchorLdu: [(x0 + width / 2) * C, -floor * C, -zc * C],
    boundsLdu: { min: [x0 * C, -(floor + height) * C, -zc * C - 3], max: [(x0 + width) * C, -floor * C, -zc * C + 3] },
    openingLdu: { width: width * C, height: height * C }, offGridDeg: 0,
  };
}

/** The walk pack over a collider grid with one doorway planned in it (`passSize` 100); `layers` is the cells' geometry when the planner should tell a floor from a rim. */
function packOf(g: BlockGrid, leaf: SceneInteractive, layers?: CellLayers) {
  const [plan] = planInteractiveColliders(g, [leaf], frame, layers);
  const item = { ...interactiveRuntimeItem(leaf, 'craftmatic:x_door_1', 'Door 1', plan!), passSize: 100, normal: [0, 0, 1] as [number, number, number] };
  const cells: SourceCell[] = [];
  for (let x = 0; x < g.width; x++) for (let y = 0; y < g.height; y++) for (let z = 0; z < g.length; z++) {
    const f = parseFormState(g.get(x, y, z));
    if (f) cells.push({ x, y, z, lo: f.lo, hi: f.hi, ...(f.v ? { v: f.v } : {}) });
  }
  const cfg: InteractiveRuntimeConfig = { family: INTERACTIVE_FAMILY, property: INTERACTIVE_PROPERTY, label: 'Test', dims: { width: g.width, height: g.height, length: g.length }, colliders: { block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE }, items: [item], turnProperty: INTERACTIVE_TURN_PROPERTY, sizeProperty: INTERACTIVE_SIZE_PROPERTY };
  return { plan: plan!, pack: { cells, dims: cfg.dims, interactives: cfg } };
}

describe('a doorway is passable from the size at which it holds a minifig', () => {
  it('takes the minifig envelope (40 x 96 LDU), not a whole-block 1 x 2 passage', () => {
    expect(DOORWAY_PASS_WIDTH_LDU / C).toBeCloseTo(0.75, 2);
    expect(DOORWAY_PASS_HEIGHT_LDU / C).toBeCloseTo(1.8, 2);
    // 80049's shop doors: 48 x 123 LDU (0.9 x 2.3 blocks) - a minifig walks through, so from 100 %.
    expect(passSizeFor('door', { width: 48, height: 123 })).toBe(100);
    expect(passSizeFor('door', { width: 40, height: 96 })).toBe(100);
    // Narrower than a minifig's hips, or lower than a standing minifig: not at 100 %.
    expect(passSizeFor('door', { width: 39, height: 144 })).toBe(150);
    expect(passSizeFor('door', { width: 48, height: 80 })).toBe(150); // 71043's microscale doors
    expect(passSizeFor('gate', { width: 40, height: 10 })).toBe(100); // a gate has no lintel
    // A hatch is a hole dropped through: still a block each way.
    expect(passSizeFor('hatch', { width: 48, height: 48 })).toBe(150);
  });

  it('measures the opening at the model\'s own scale', () => {
    // The same 60 x 144 LDU door on a model exported at half the minifig scale is 0.56 x 1.35 blocks.
    expect(passSizeFor('door', { width: 60, height: 144 })).toBe(100);
    expect(passSizeFor('door', { width: 60, height: 144 }, undefined, 0.5 / C)).toBe(150);
    const leaf = leafAt(3.25, 60 / C, 5.5, 144 / C);
    expect(interactiveRuntimeItem(leaf, 't', 'Door 1', null).passSize).toBe(100);
    const half = interactiveRuntimeItem(leaf, 't', 'Door 1', null, 0.5 / C);
    expect(half.passSize).toBe(150);
    expect(half.opening).toEqual({ width: 0.6, height: 1.4 });
  });
});

/** A synthetic clearance scene: `solid` lays a cell from its geometry as buildColliderGrid does. */
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
  const form = (x: number, y: number, z: number): ColliderForm | null => parseFormState(grid.get(x, y, z));
  return { grid, layers, solid, form };
}

describe('clearance lets a phantom top go in a doorway\'s approach (rule 4, approachTop)', () => {
  /**
   * 10326's Doors 1-2: in front of the door, at head height over its floor, a
   * cell whose only geometry is a 1/16 sliver of the next cell's shelf. Read
   * as a standing surface its whole footprint stayed solid, 0.05 block into
   * the head of a player on the approach's plate.
   */
  const front = () => {
    const s = scene(3, 4, 3);
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) s.solid(x, 0, z, [[0, 16, 0, 4, 0, 16]]); // the floor plate
    // Row 2 in front of the door (z 1): a sliver along its far face, 11/16 tall.
    s.solid(1, 2, 1, [[0, 14, 0, 11, 15, 16]]);
    return s;
  };
  it('trims it when it stands in an approach at a player\'s body height', () => {
    const s = front();
    const r = applyColliderClearance({ grid: s.grid, layers: s.layers, leaves: [], closedCells: [], approaches: [{ columns: [[1, 1]], floor16: 3 }] });
    const f = s.form(1, 2, 1)!;
    expect(COLLIDER_KIT.formBoxes(f.v, f.lo, f.hi)).toEqual([[0, 16, 0, 11, 12, 16]]);
    expect(r.approachTops).toBe(1);
    expect(r.refused['walkable-top']).toBe(0);
  });
  it('keeps it whole outside any approach, and keeps an approach\'s own floor (within an auto-step of the door\'s)', () => {
    const outside = front();
    applyColliderClearance({ grid: outside.grid, layers: outside.layers, leaves: [], closedCells: [], approaches: [{ columns: [[0, 1]], floor16: 3 }] });
    // Not narrowed (the ceiling rule may still lift its underside to standing height over the plate).
    expect(outside.form(1, 2, 1)).toMatchObject({ v: 0, hi: 11 });
    // A step in the approach whose top is within 9/16 of the doorway's floor is the floor walked on.
    const step = scene(3, 2, 3);
    step.solid(1, 0, 1, [[0, 8, 0, 10, 0, 16]]);
    const r = applyColliderClearance({ grid: step.grid, layers: step.layers, leaves: [], closedCells: [], approaches: [{ columns: [[1, 1]], floor16: 3 }] });
    expect(step.form(1, 0, 1)).toEqual({ v: 0, lo: 0, hi: 10 });
    expect(r.refused['walkable-top']).toBe(1);
    expect(r.approachTops).toBe(0);
  });
  it('records every passage doorway\'s approach and floor in the plan', () => {
    const g = new BlockGrid(12, 6, 10);
    for (let x = 0; x < 12; x++) for (let z = 0; z < 10; z++) g.set(x, 0, z, colliderState(0, 16));
    for (let x = 0; x < 12; x++) for (let y = 1; y <= 4; y++) g.set(x, y, 5, colliderState(0, 16));
    const [plan] = planInteractiveColliders(g, [leafAt(3.25, 1.5, 5.5)], frame);
    expect(plan!.floor16).toBe(16);
    const cols = new Set(plan!.approach.map(([x, z]) => `${x},${z}`));
    for (const x of [3, 4]) for (const z of [2, 3, 4, 6, 7, 8]) expect(cols.has(`${x},${z}`), `${x},${z}`).toBe(true);
    expect(cols.has('3,5')).toBe(false); // the leaf's own columns are the doorway, not its approach
    expect(cols.has('2,4')).toBe(false);
  });
});

describe('the collider grid and its layer geometry round a box edge on a sixteenth alike', () => {
  it('a plate top at 12/16 with float noise spans [0, 12] in both, so clearance does not read the cell as cut', () => {
    const grid = new BlockGrid(1, 1, 1);
    grid.set(0, 0, 0, 'minecraft:white_concrete');
    // LDraw Y down: a box from the cell floor up to 0.75 block, plus 1e-7 block of float noise.
    const top = (0.75 + 1e-7) * C;
    const { grid: out, layers } = buildColliderGrid(grid, [{ min: [0, -top, -C], max: [C, 0, 0] }], frame);
    expect(out.get(0, 0, 0)).toBe(colliderState(0, 12));
    expect(layerSpan(layers.get(colliderCellIndex(out, 0, 0, 0))!)).toEqual([0, 12]);
  });
});

describe('the passability walk', () => {
  it('walks a corridor that straddles a column boundary (the fine lattice)', () => {
    // A wall at z 5 with a 1.5-block door at x 3.25..4.75; in front of it (z 6..8) a corridor 1.0 wide
    // between two thin walls at x 3.0..3.5 and 4.5..5.0 - each column only half free, and the two free
    // halves meet on the x = 4 face, so no single column holds the player.
    const g = new BlockGrid(12, 6, 12);
    for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) g.set(x, 0, z, colliderState(0, 16));
    for (let x = 0; x < 12; x++) for (let y = 1; y <= 4; y++) g.set(x, y, 5, colliderState(0, 16));
    const band = (x0: number, x1: number): string => formState(COLLIDER_KIT.cover([[x0, x1, 0, 16, 0, 16]])!);
    for (let z = 6; z <= 8; z++) for (let y = 1; y <= 4; y++) {
      for (let x = 0; x <= 2; x++) g.set(x, y, z, colliderState(0, 16));
      for (let x = 5; x < 12; x++) g.set(x, y, z, colliderState(0, 16));
      g.set(3, y, z, band(0, 8));
      g.set(4, y, z, band(8, 16));
    }
    const { pack } = packOf(g, leafAt(3.25, 1.5, 5.5));
    const open = walkThroughDoorway(pack, 0, 100, 0, true), closed = walkThroughDoorway(pack, 0, 100, 0, false);
    expect(open.outcome).toBe('passed');
    expect(open.directions.every(d => d.outcome === 'passed')).toBe(true);
    expect(closed.outcome).not.toBe('passed');
    expect(verdictOf(open, closed)).toBe('OK');
  });

  it('never counts a way round a raised doorway on the ground under it', () => {
    // A room on stilts: its floor slab at row 2 (top 3.0) over z 0..5, the door on it in a wall at z 5.
    // In front of the door a wall four cells deep (z 6..9, deeper than the passage cut reaches), then a
    // porch at the door's level (z 10..12). The porch is reached from the door only by going down the
    // room's stairs (x 3, z 1..-1), along the ground UNDER the room and the wall (x 4), and up the
    // porch's stairs (x 3, z 14..12): a way that crosses the leaf's plane on the ground, 3 blocks under
    // the doorway. That is no way through this door, open or closed.
    const g = new BlockGrid(12, 9, 16);
    for (let x = 0; x < 12; x++) {
      for (let z = 0; z <= 5; z++) if (!(x === 3 && z <= 1)) g.set(x, 2, z, colliderState(0, 16)); // the room floor, a stair hole at x 3
      for (let y = 3; y <= 6; y++) for (let z = 5; z <= 9; z++) if (z > 5 || y >= 3) g.set(x, y, z, colliderState(0, 16)); // door wall + the deep wall
      for (let z = 10; z <= 12; z++) g.set(x, 2, z, colliderState(0, 16)); // the porch floor
    }
    // The room's stairs down (x 3): z 1 top 2, z 0 top 1; the porch's stairs up (x 3): z 13 top 2, z 14 top 1.
    g.set(3, 0, 1, colliderState(0, 16)); g.set(3, 1, 1, colliderState(0, 16)); g.set(3, 0, 0, colliderState(0, 16));
    g.set(3, 0, 13, colliderState(0, 16)); g.set(3, 1, 13, colliderState(0, 16)); g.set(3, 0, 14, colliderState(0, 16));
    const { pack } = packOf(g, leafAt(3.25, 1.5, 5.5, 2.6, 3));
    const open = walkThroughDoorway(pack, 0, 100, 0, true), closed = walkThroughDoorway(pack, 0, 100, 0, false);
    expect(closed.outcome).not.toBe('passed');
    expect(open.outcome).not.toBe('passed');
    expect(verdictOf(open, closed)).toBe('SEALED');
  });
});

describe('a threshold tread stands on a floor, never on a wall\'s rim (10326\'s Door 1, Saga round 2026-09-29c)', () => {
  /**
   * The museum's front: the base plate (row 0), the door wall at z 3 with the
   * leaf hung 14/16 up row 2 (floor 2.875) and the room floor inside at that
   * height (z 4..7); in front of the leaf's two columns (z 2), at x 3 the
   * base's front wall - a 4/16 band with a 2/16 plate at its foot, a floor +
   * wall form whose rim at 2.0 is no floor - and at x 4 nothing down to the
   * plate. With `rimIsFloor` the cell at x 3 is a full brick instead.
   */
  const front = (rimIsFloor: boolean) => {
    const s = scene(8, 6, 8);
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) s.solid(x, 0, z, [[0, 16, 0, 16, 0, 16]]);
    for (let x = 0; x < 8; x++) for (let y = 1; y <= 5; y++) s.solid(x, y, 3, [[0, 16, 0, 16, 0, 16]]);
    for (let x = 0; x < 8; x++) for (let z = 4; z < 8; z++) s.solid(x, 2, z, [[0, 16, 0, 14, 0, 16]]);
    s.solid(3, 1, 2, rimIsFloor ? [[0, 16, 0, 16, 0, 16]] : [[0, 16, 0, 2, 0, 16], [0, 16, 2, 16, 12, 16]]);
    return s;
  };
  it('lays no half-way tread on a rim, and the device\'s line through the other column reports the pit', () => {
    const s = front(false);
    const { plan, pack } = packOf(s.grid, leafAt(3, 1.5, 3.5, 2.5, 2.875), s.layers);
    expect(plan.treads).toBe(0);
    expect(parseFormState(s.grid.get(3, 2, 2))).toBeNull();
    const open = walkThroughDoorway(pack, 0, 100, 0, true), closed = walkThroughDoorway(pack, 0, 100, 0, false);
    // The rim's full cell is still a shelf 0.875 under the threshold (clearance keeps a landing): a way in, with a jump.
    expect(verdictOf(open, closed)).toBe('OK');
    expect(open.directions.find(d => d.from === -1)).toMatchObject({ outcome: 'passed' });
    expect(open.directions.find(d => d.from === -1)!.jumps).toBeGreaterThan(0);
    // The leaf's other column (x 4) drops to the plate, 1.875 under the doorway, on the outside: a hole the verdict walk never stood over.
    const lines = doorwayColumnLines(pack, 0, 100, 0);
    const holes = doorwayHoles(lines, 100);
    expect(holes.map(h => `${h.column.x},${h.column.z}:${h.from}`)).toContain('4,3:-1');
    expect(holes.find(h => h.column.x === 4 && h.from === -1)!.dropNear).toBeCloseTo(1.875, 2);
    expect(holes.some(h => h.column.x === 3 && h.from === -1)).toBe(false);
  });
  it('lays the tread on a floor, and walks through without a jump', () => {
    const s = front(true);
    const { plan, pack } = packOf(s.grid, leafAt(3, 1.5, 3.5, 2.5, 2.875), s.layers);
    expect(plan.treads).toBe(1);
    expect(parseFormState(s.grid.get(3, 2, 2))).toEqual({ v: 0, lo: 0, hi: 7 });
    const open = walkThroughDoorway(pack, 0, 100, 0, true);
    expect(verdictOf(open, walkThroughDoorway(pack, 0, 100, 0, false))).toBe('OK');
    expect(open.directions.some(d => d.outcome === 'passed' && d.jumps === 0)).toBe(true);
  });
});

describe('an approach is a spot a player can go on from (910004\'s Door 3, Saga round 2026-09-29c)', () => {
  /**
   * A door in a wall at z 3 on the ground plate. Inside, `alcove`: one free
   * column (3, 4) between furniture (x 2 and x 4, solid to row 3, four cells
   * deep) and a wall at z 5 - a dead end a stud deep. `hallway`: the row z 4
   * free across the whole width, the wall at z 5 - a corridor along the wall.
   */
  const inside = (alcove: boolean) => {
    const g = new BlockGrid(8, 6, 8);
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) g.set(x, 0, z, colliderState(0, 16));
    for (let x = 0; x < 8; x++) for (let y = 1; y <= 4; y++) g.set(x, y, 3, colliderState(0, 16));
    for (let x = 0; x < 8; x++) for (let z = 4; z < 8; z++) for (let y = 1; y <= 3; y++) {
      if (z === 4 && (!alcove || x === 3)) continue;
      g.set(x, y, z, colliderState(0, 16));
    }
    return g;
  };
  it('calls a door into a one-column alcove SEALED, not OK', () => {
    const { pack } = packOf(inside(true), leafAt(3, 1.5, 3.5, 2.5, 1));
    const open = walkThroughDoorway(pack, 0, 100, 0, true), closed = walkThroughDoorway(pack, 0, 100, 0, false);
    expect(open.outcome).toBe('sealed');
    expect(verdictOf(open, closed)).toBe('SEALED');
  });
  it('still walks a door onto a corridor running along the wall', () => {
    const { pack } = packOf(inside(false), leafAt(3, 1.5, 3.5, 2.5, 1));
    const open = walkThroughDoorway(pack, 0, 100, 0, true), closed = walkThroughDoorway(pack, 0, 100, 0, false);
    expect(open.outcome).toBe('passed');
    expect(verdictOf(open, closed)).toBe('OK');
  });
});

describe('the passage is measured from the doorway\'s floor, not the row the leaf\'s bottom is in (41732\'s Door 3, Saga round 2026-09-29c)', () => {
  /**
   * A leaf hung 14/16 up row 2 (floor 2.875) in a wall at z 3; inside, a
   * floor LEVEL with the threshold two cells deep (row 2 [0, 14] at z 4..5),
   * then the ground plate (row 0). The row-based rule read the level floor as
   * an obstacle ("row y0 higher than a 9/16 step") and cleared both cells
   * whole - a 1.875-block pit behind the door.
   */
  it('keeps a floor level with a leaf hung high in its row', () => {
    const s = scene(8, 6, 8);
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) s.solid(x, 0, z, [[0, 16, 0, 16, 0, 16]]);
    for (let x = 0; x < 8; x++) for (let y = 1; y <= 5; y++) s.solid(x, y, 3, [[0, 16, 0, 16, 0, 16]]);
    for (let x = 0; x < 8; x++) for (let z = 4; z <= 5; z++) s.solid(x, 2, z, [[0, 16, 0, 14, 0, 16]]);
    const { plan, pack } = packOf(s.grid, leafAt(3, 1.5, 3.5, 2.5, 2.875), s.layers);
    expect(plan.passageCleared).toBe(0);
    for (const x of [3, 4]) for (const z of [4, 5]) expect(parseFormState(s.grid.get(x, 2, z))).toEqual({ v: 0, lo: 0, hi: 14 });
    const open = walkThroughDoorway(pack, 0, 100, 0, true);
    expect(open.directions.find(d => d.from === 1)).toMatchObject({ outcome: 'passed' });
    expect(doorwayHoles(doorwayColumnLines(pack, 0, 100, 0), 100).filter(h => h.from === 1)).toEqual([]);
  });
});
