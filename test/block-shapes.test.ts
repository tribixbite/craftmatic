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
