/**
 * Block shapes — occupancy classification and the slab refinement pass.
 *
 * The two properties that matter, both asserted here:
 *   1. ADDITIVE-SAFE — no cell ever becomes air, no cell is ever created. The
 *      pass replaces one solid palette entry with another solid one or does
 *      nothing. This is the whole reason it is allowed to exist next to the
 *      "over-coverage is the fidelity" rule (CLAUDE.md 2026-09-08).
 *   2. It only gives up a half that is AIR ANYWAY, so an interior seam — the
 *      boundary cell two stacked bricks share — stays a full cube.
 *
 * Plus the availability truth: vanilla has no dyed slab, so a concrete cell
 * that classifies as half-height keeps its cube rather than getting a
 * near-colour material substituted for it.
 */

import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  classifyOccupancy, createShapeHints, addOccupancy, applyBlockShapes,
  slabIdFor, stairsIdFor, SHAPE_VARIANTS,
  isSlopeDescription, analyzeSlope, stairCodeForPlacement, stairCode,
  decodeStairCode, addStairRequest,
} from '../web/src/engine/block-shapes.js';
import { lintPalette } from '../web/src/engine/palette-lint.js';

const AIR = 'minecraft:air';
const Q = 255;
const q = (u: number) => Math.round(u * Q);

describe('classifyOccupancy', () => {
  it('keeps a cell a cube when it is mostly full', () => {
    expect(classifyOccupancy(0, Q)).toBe('full');                 // whole cell
    expect(classifyOccupancy(q(0.1), q(0.95))).toBe('full');      // 0.85 of it
    expect(classifyOccupancy(q(0), q(0.75))).toBe('full');        // exactly the cutoff
  });

  it('keeps a cell a cube when the occupancy straddles the midline', () => {
    // Half a cell's worth of material, but centred — no slab represents that.
    expect(classifyOccupancy(q(0.25), q(0.7))).toBe('full');
  });

  it('reads a bottom-sitting interval as a bottom slab', () => {
    expect(classifyOccupancy(0, q(0.5))).toBe('slab-bottom');     // brick top cell
    expect(classifyOccupancy(0, q(0.1))).toBe('slab-bottom');     // plate over a brick
    expect(classifyOccupancy(q(0.05), q(0.55))).toBe('slab-bottom'); // slight overhang
  });

  it('reads a top-sitting interval as a top slab', () => {
    expect(classifyOccupancy(q(0.5), Q)).toBe('slab-top');        // brick bottom cell
    expect(classifyOccupancy(q(0.6), q(0.9))).toBe('slab-top');   // plate at 1 block/stud
  });

  it('treats a cell with no recorded contribution as full', () => {
    // lo > hi is the empty sentinel — what the gap fill and the contact bridge
    // add. Those cells must stay cubes.
    expect(classifyOccupancy(Q, 0)).toBe('full');
  });
});

describe('shape id construction', () => {
  it('builds slab and stair ids with alphabetically ordered properties', () => {
    expect(slabIdFor('minecraft:sandstone', 'bottom')).toBe('minecraft:sandstone_slab[type=bottom]');
    expect(stairsIdFor('minecraft:oak_planks', 'north', 'top'))
      .toBe('minecraft:oak_stairs[facing=north,half=top,shape=straight]');
  });

  it('returns null for families vanilla gives no shape', () => {
    // The measured constraint: no dyed family has a slab or a stair.
    for (const c of ['white', 'gray', 'red', 'black']) {
      expect(slabIdFor(`minecraft:${c}_concrete`, 'bottom')).toBeNull();
      expect(slabIdFor(`minecraft:${c}_wool`, 'top')).toBeNull();
      expect(slabIdFor(`minecraft:${c}_stained_glass`, 'top')).toBeNull();
      expect(stairsIdFor(`minecraft:${c}_concrete`, 'north', 'bottom')).toBeNull();
    }
    expect(slabIdFor('minecraft:glass', 'top')).toBeNull();
    expect(slabIdFor('minecraft:iron_block', 'top')).toBeNull();
    // smooth_stone has a slab but no stairs — the asymmetry is real.
    expect(slabIdFor('minecraft:smooth_stone', 'top')).toBe('minecraft:smooth_stone_slab[type=top]');
    expect(stairsIdFor('minecraft:smooth_stone', 'north', 'bottom')).toBeNull();
  });

  it('every id the table can emit passes the palette lint', () => {
    const ids: string[] = [];
    for (const block of Object.keys(SHAPE_VARIANTS)) {
      for (const half of ['top', 'bottom'] as const) {
        const s = slabIdFor(block, half);
        if (s) ids.push(s);
        for (const facing of ['north', 'south', 'east', 'west'] as const) {
          const st = stairsIdFor(block, facing, half);
          if (st) ids.push(st);
        }
      }
    }
    expect(ids.length).toBeGreaterThan(300);
    expect(lintPalette(ids).issues).toEqual([]);
  });
});

/** A 1×N×1 column of `block`, plus hints. */
function column(blocks: Array<string | null>) {
  const h = blocks.length;
  const grid = new BlockGrid(1, h, 1);
  blocks.forEach((b, y) => { if (b) grid.set(0, y, 0, b); });
  return { grid, hints: createShapeHints(1, h, 1) };
}

describe('applyBlockShapes', () => {
  it('slabs an exposed half-height sandstone cell', () => {
    const { grid, hints } = column(['minecraft:sandstone', null]);
    addOccupancy(hints, 0, 0, 0, 0, 0.4);       // bottom 40% of the cell
    const stats = applyBlockShapes(grid, hints);
    expect(grid.get(0, 0, 0)).toBe('minecraft:sandstone_slab[type=bottom]');
    expect(stats).toMatchObject({ candidates: 1, slabs: 1, noVariant: 0, blockedByNeighbour: 0 });
  });

  it('never removes or adds a cell', () => {
    const { grid, hints } = column(['minecraft:sandstone', 'minecraft:sandstone', null]);
    addOccupancy(hints, 0, 0, 0, 0.5, 1);
    addOccupancy(hints, 0, 1, 0, 0, 0.3);
    const before = grid.countNonAir();
    applyBlockShapes(grid, hints);
    expect(grid.countNonAir()).toBe(before);
    expect(grid.get(0, 2, 0)).toBe(AIR);
  });

  it('leaves an interior seam a full cube (the half it would give up is solid)', () => {
    // Two stacked parts meeting in cell 1: occupancy unions to the whole cell,
    // and even if it did not, cell 1 has solid neighbours both ways.
    const { grid, hints } = column([
      'minecraft:sandstone', 'minecraft:sandstone', 'minecraft:sandstone', null,
    ]);
    addOccupancy(hints, 0, 0, 0, 0.5, 1);
    addOccupancy(hints, 0, 1, 0, 0, 0.45);       // lower part's top
    addOccupancy(hints, 0, 1, 0, 0.45, 1);       // upper part's bottom → union = full
    addOccupancy(hints, 0, 2, 0, 0, 0.4);
    const stats = applyBlockShapes(grid, hints);
    expect(grid.get(0, 1, 0)).toBe('minecraft:sandstone');
    expect(grid.get(0, 2, 0)).toBe('minecraft:sandstone_slab[type=bottom]');
    expect(stats.slabs).toBe(2);                 // cells 0 (top slab) and 2
  });

  it('refuses to slab a cell whose empty half is not air', () => {
    const { grid, hints } = column(['minecraft:sandstone', 'minecraft:sandstone']);
    addOccupancy(hints, 0, 0, 0, 0, 0.4);        // wants a bottom slab…
    addOccupancy(hints, 0, 1, 0, 0, 1);          // …but cell 1 above is solid
    const stats = applyBlockShapes(grid, hints);
    expect(grid.get(0, 0, 0)).toBe('minecraft:sandstone');
    expect(stats).toMatchObject({ candidates: 1, slabs: 0, blockedByNeighbour: 1 });
  });

  it('keeps a full cube when the family has no slab, and says which block', () => {
    const { grid, hints } = column(['minecraft:white_concrete', null]);
    addOccupancy(hints, 0, 0, 0, 0, 0.4);
    const stats = applyBlockShapes(grid, hints);
    expect(grid.get(0, 0, 0)).toBe('minecraft:white_concrete');
    expect(stats).toMatchObject({ candidates: 1, slabs: 0, noVariant: 1 });
    expect(stats.noVariantByBlock).toEqual({ 'minecraft:white_concrete': 1 });
  });

  it('does nothing when the hints do not match the grid', () => {
    const { grid } = column(['minecraft:sandstone', null]);
    const stats = applyBlockShapes(grid, createShapeHints(2, 2, 2));
    expect(stats.candidates).toBe(0);
    expect(grid.get(0, 0, 0)).toBe('minecraft:sandstone');
  });

  it('emits only lint-clean palette entries', () => {
    const { grid, hints } = column(['minecraft:sandstone', null, 'minecraft:sandstone']);
    addOccupancy(hints, 0, 0, 0, 0, 0.4);
    addOccupancy(hints, 0, 2, 0, 0.6, 1);
    applyBlockShapes(grid, hints);
    expect(lintPalette(grid.reversePalette().filter(b => b !== AIR)).issues).toEqual([]);
  });
});

// ─── Slope pass (stairs) ─────────────────────────────────────────────────────

type Tri = [[number, number, number], [number, number, number], [number, number, number]];

/**
 * A wedge shaped like a real LEGO slope: full height at +z, thinning toward −z,
 * with studs poking 4 LDU above the brick top and a wall thickness kept at the
 * thin end. LDraw Y points DOWN, so y=0 is the brick top and y=24 its underside.
 * The studs matter — they are what made a naive underside probe misread a
 * NORMAL slope as inverted (see analyzeSlope).
 */
function wedgeTris(inverted = false): Tri[] {
  const out: Tri[] = [];
  const t = (z: number) => (z + 20) / 40;                       // 0 at −z, 1 at +z
  const topY = (z: number) => inverted ? 0 : 24 - t(z) * 20;    // normal: top falls toward −z
  const botY = (z: number) => inverted ? 24 - (1 - t(z)) * 20 : 24;
  for (let i = 0; i < 8; i++) {
    const z0 = -20 + i * 5, z1 = z0 + 5;
    for (const x of [-20, -10, 0, 10, 20]) {
      out.push([[x, topY(z0), z0], [x, topY(z1), z1], [x, botY(z1), z1]]);
      out.push([[x, topY(z0), z0], [x, botY(z1), z1], [x, botY(z0), z0]]);
    }
  }
  // Two studs on the full-height end, as flat discs at y = −4.
  for (const x of [-10, 10]) {
    out.push([[x - 6, -4, 14], [x + 6, -4, 14], [x, -4, 6]]);
    out.push([[x - 6, -4, 14], [x, -4, 6], [x - 6, -4, 6]]);
  }
  return out;
}

describe('slope detection', () => {
  it('accepts the 33° and 45° single-wedge families from the library description', () => {
    expect(isSlopeDescription('0 Slope Brick 45  2 x  1')).toBe(true);
    expect(isSlopeDescription('0 Slope Brick 45  2 x  2 Inverted')).toBe(true);
    expect(isSlopeDescription('0 Slope Brick 33  3 x  2')).toBe(true);
    expect(isSlopeDescription('0 =Slope Brick 45  2 x  4')).toBe(true);
  });

  it('rejects cheese, steep, multi-face and non-slope parts', () => {
    // Each string is a real first line from the LDraw library.
    expect(isSlopeDescription('0 =Slope Brick 31  1 x  1 x  0.667 ')).toBe(false);
    expect(isSlopeDescription('0 Slope Brick 18  4 x  2')).toBe(false);
    expect(isSlopeDescription('0 Slope Brick 75  2 x  1 x  3 Inverted')).toBe(false);
    expect(isSlopeDescription('0 Slope Brick 33  2 x  2 Double')).toBe(false);
    expect(isSlopeDescription('0 Slope Brick 33  3 x  3 Double Convex')).toBe(false);
    expect(isSlopeDescription('0 Slope Brick 33/45  6 x  4 with  2 x  2 Cutout')).toBe(false);
    expect(isSlopeDescription('0 Brick  2 x  4')).toBe(false);
    expect(isSlopeDescription('0 Plate  2 x  4')).toBe(false);
  });

  it('reads a normal wedge as pointing at its full-height end', () => {
    expect(analyzeSlope(wedgeTris(false))).toEqual({ ux: 0, uz: 1, inverted: false });
  });

  it('reads an inverted wedge (cut underside) as half=top', () => {
    expect(analyzeSlope(wedgeTris(true))).toEqual({ ux: 0, uz: 1, inverted: true });
  });

  it('returns null for a plain box', () => {
    const box: Tri[] = [];
    for (const x of [-20, 0, 20]) for (const z of [-20, 0, 20]) {
      box.push([[x, 0, z], [x, 24, z], [x + 5, 24, z]]);
      box.push([[x, 0, z], [x + 5, 24, z], [x + 5, 0, z]]);
    }
    expect(analyzeSlope(box)).toBeNull();
  });
});

describe('stairCodeForPlacement', () => {
  const slope = { ux: 0, uz: 1, inverted: false };
  const yaw = (deg: number): number[] => {
    const c = Math.round(Math.cos(deg * Math.PI / 180)), s = Math.round(Math.sin(deg * Math.PI / 180));
    return [c, 0, s, 0, 1, 0, -s, 0, c];
  };

  it('rotates the facing with the brick, grid +z being south', () => {
    const facings = [0, 90, 180, 270].map(d => decodeStairCode(stairCodeForPlacement(slope, yaw(d)))!.facing);
    expect(facings).toEqual(['south', 'east', 'north', 'west']);
  });

  it('flips an upside-down placement to half=top and back', () => {
    const flip = [1, 0, 0, 0, -1, 0, 0, 0, 1];
    expect(decodeStairCode(stairCodeForPlacement(slope, flip))!.half).toBe('top');
    expect(decodeStairCode(stairCodeForPlacement({ ...slope, inverted: true }, flip))!.half).toBe('bottom');
    expect(decodeStairCode(stairCodeForPlacement({ ...slope, inverted: true }, yaw(0)))!.half).toBe('top');
  });

  it('refuses a placement a stair cannot represent', () => {
    const onItsSide = [1, 0, 0, 0, 0, -1, 0, 1, 0];   // rolled 90°, local Y horizontal
    expect(stairCodeForPlacement(slope, onItsSide)).toBe(0);
    const yaw45 = [0.707, 0, 0.707, 0, 1, 0, -0.707, 0, 0.707];
    expect(stairCodeForPlacement(slope, yaw45)).toBe(0);
  });
});

describe('applyBlockShapes — stairs', () => {
  const stairsGrid = (block: string) => {
    const grid = new BlockGrid(1, 2, 1);
    grid.set(0, 0, 0, block);
    grid.set(0, 1, 0, block);
    const hints = createShapeHints(1, 2, 1, true);
    addOccupancy(hints, 0, 0, 0, 0, 1);
    addOccupancy(hints, 0, 1, 0, 0, 1);
    return { grid, hints };
  };

  it('places a stair on a slope cell whose descending side is open', () => {
    const { grid, hints } = stairsGrid('minecraft:sandstone');
    addStairRequest(hints, 0, 1, 0, stairCode('south', 'bottom'));
    const stats = applyBlockShapes(grid, hints);
    expect(grid.get(0, 1, 0)).toBe('minecraft:sandstone_stairs[facing=south,half=bottom,shape=straight]');
    expect(grid.get(0, 0, 0)).toBe('minecraft:sandstone');
    expect(stats).toMatchObject({ stairs: 1, stairCandidates: 1 });
  });

  it('leaves a slope cell alone when the cell above is solid', () => {
    const { grid, hints } = stairsGrid('minecraft:sandstone');
    addStairRequest(hints, 0, 0, 0, stairCode('south', 'bottom'));
    applyBlockShapes(grid, hints);
    expect(grid.get(0, 0, 0)).toBe('minecraft:sandstone');
  });

  it('drops the request when two slopes claim the same cell', () => {
    const { grid, hints } = stairsGrid('minecraft:sandstone');
    addStairRequest(hints, 0, 1, 0, stairCode('south', 'bottom'));
    addStairRequest(hints, 0, 1, 0, stairCode('east', 'bottom'));
    const stats = applyBlockShapes(grid, hints);
    expect(grid.get(0, 1, 0)).toBe('minecraft:sandstone');
    expect(stats.stairs).toBe(0);
  });

  it('falls through to the slab pass when the family has no stairs', () => {
    const grid = new BlockGrid(1, 2, 1);
    grid.set(0, 0, 0, 'minecraft:white_concrete');
    const hints = createShapeHints(1, 2, 1, true);
    addOccupancy(hints, 0, 0, 0, 0, 0.4);
    addStairRequest(hints, 0, 0, 0, stairCode('north', 'bottom'));
    const stats = applyBlockShapes(grid, hints);
    expect(grid.get(0, 0, 0)).toBe('minecraft:white_concrete');
    expect(stats).toMatchObject({ stairs: 0, stairNoVariant: 1, candidates: 1, noVariant: 1 });
  });

  it('interns only the stair orientations it actually places', () => {
    // paletteIndexOf INTERNS, so resolving all eight orientations eagerly put
    // unused entries in every export's palette.
    const { grid, hints } = stairsGrid('minecraft:sandstone');
    addStairRequest(hints, 0, 1, 0, stairCode('west', 'bottom'));
    applyBlockShapes(grid, hints);
    expect(grid.reversePalette().filter(b => b.includes('_stairs')))
      .toEqual(['minecraft:sandstone_stairs[facing=west,half=bottom,shape=straight]']);
  });
});
