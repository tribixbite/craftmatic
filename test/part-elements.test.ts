/**
 * Semantic part → Minecraft element pass (slice 5).
 *
 * Same two properties the slab/stair passes are held to, because the pass is
 * allowed to exist for the same reason:
 *   1. ADDITIVE-SAFE — no cell becomes air, no cell is created, no footprint
 *      moves. Every rewrite swaps one solid palette entry for another.
 *   2. It declines rather than substitutes. A LEGO fence moulded in a colour
 *      with no fence or wall keeps its cubes; a lattice in a colour `iron_bars`
 *      would misrepresent keeps its cubes; a ladder with no wall behind it keeps
 *      its cubes.
 *
 * Plus the membership rules, which are description-driven data and therefore the
 * thing most likely to drift: a solid "Grille" tile must NOT become openwork,
 * and a "Fence Lattice" must be a fence rather than bars.
 */

import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { createShapeHints, addElementRequest, applyBlockShapes } from '../web/src/engine/block-shapes.js';
import {
  applyPartElements, elementKindForDescription, paneIdFor,
  FENCE_VARIANTS, WALL_VARIANTS, BARS_MATERIALS, MAX_ELEMENT_CELLS,
  ELEMENT_NONE, ELEMENT_PANE, ELEMENT_FENCE, ELEMENT_BARS, ELEMENT_LADDER, ELEMENT_CONFLICT,
} from '../web/src/engine/part-elements.js';
import { lintPalette } from '../web/src/engine/palette-lint.js';
import { getAllBlockColors } from '../src/blocks/colors.js';

const AIR = 'minecraft:air';

/** A grid with one cell of `block` at (1,1,1) and an element request on it. */
function oneCell(block: string, kind: number, extra?: (g: BlockGrid) => void) {
  const grid = new BlockGrid(3, 3, 3);
  grid.set(1, 1, 1, block);
  extra?.(grid);
  const hints = createShapeHints(3, 3, 3, false, true);
  addElementRequest(hints, 1, 1, 1, kind);
  return { grid, hints };
}

describe('membership, from the library description', () => {
  it('reads the glass inserts as panes', () => {
    for (const d of [
      '0 Glass for Window  1 x  2 x  2 without Sill',
      '0 =Glass for Window  1 x  4 x  3 Opening',
      '0 Glass for Train Door',
      '0 Glass for Door  1 x  6 x  7 with Arch',
    ]) expect(elementKindForDescription(d)).toBe(ELEMENT_PANE);
  });

  it('reads the fence families as fences, lattice included', () => {
    for (const d of [
      '0 Fence Lattice  1 x  4 x  2',
      '0 Fence Spindled  1 x  4 x  2 with 4 Studs',
      '0 Fence Ornamented  1 x  4 x  2',
      '0 Fence  1 x  4 x  2 Picket',
    ]) expect(elementKindForDescription(d)).toBe(ELEMENT_FENCE);
  });

  it('reads a window pane lattice as bars, but never a solid grille', () => {
    expect(elementKindForDescription('0 Window  1 x  2 x  2 Pane Lattice Diamond')).toBe(ELEMENT_BARS);
    // The two most-placed "grille" parts in the whole corpus (2412b at 3,453 and
    // 2877 at 3,070 placements) are SOLID mouldings with a ridge pattern.
    // Turning them into iron_bars would put a hole through a wall.
    expect(elementKindForDescription('0 Tile  1 x  2 Grille with Groove')).toBe(ELEMENT_NONE);
    expect(elementKindForDescription('0 Brick  1 x  2 with Grille')).toBe(ELEMENT_NONE);
    expect(elementKindForDescription('0 Slope Brick 18  2 x  1 x  0.667 Grille')).toBe(ELEMENT_NONE);
  });

  it('reads a ladder part as a ladder, but skips the obsolete stub', () => {
    expect(elementKindForDescription('0 Plate  1 x  2 with Ladder')).toBe(ELEMENT_LADDER);
    expect(elementKindForDescription('0 ~Ladder  2.5 x 14 (Obsolete)')).toBe(ELEMENT_NONE);
  });

  it('maps none of the families the survey measured and refused', () => {
    for (const d of [
      '0 Door  1 x  4 x  6 Frame',              // 187 placements — see the header
      '0 Door  1 x  4 x  6 with 4 Panes and Stud Handle',
      '0 Window  1 x  2 x  2 without Sill',     // frames stay solid
      '0 Plant Leaves  4 x  3',
      '0 Antenna  4H with Flat Top',
      '0 Brick  1 x  2',
    ]) expect(elementKindForDescription(d)).toBe(ELEMENT_NONE);
  });
});

describe('material variants', () => {
  it('emits only real Minecraft ids', () => {
    const ids = [
      ...Object.values(FENCE_VARIANTS), ...Object.values(WALL_VARIANTS),
      'minecraft:iron_bars', 'minecraft:ladder', 'minecraft:glass_pane',
      paneIdFor('minecraft:white_stained_glass')!, paneIdFor('minecraft:glass')!,
    ];
    expect(lintPalette(ids).issues).toEqual([]);
  });

  it('gives every emitted element a colour in the render table', () => {
    // Same invariant as the textured palette: getBlockColor() has a hash
    // fallback, so a missing id re-imports as a random colour rather than
    // failing loudly. `_pane`/`_fence`/`_wall` resolve through the material.
    const known = getAllBlockColors();
    const resolves = (id: string): boolean => {
      if (known.has(id)) return true;
      for (const suffix of ['_pane', '_fence', '_wall']) {
        if (!id.endsWith(suffix)) continue;
        const stem = id.slice(0, -suffix.length);
        return [stem, `${stem}s`, `${stem}_planks`, `${stem}_block`].some(c => known.has(c));
      }
      return false;
    };
    const missing = [
      ...Object.values(FENCE_VARIANTS), ...Object.values(WALL_VARIANTS),
      'minecraft:iron_bars', 'minecraft:ladder', 'minecraft:glass_pane',
      ...['white', 'black', 'light_blue', 'lime'].map(c => `minecraft:${c}_stained_glass_pane`),
    ].filter(id => !resolves(id));
    expect(missing).toEqual([]);
  });

  it('has a pane for glass and the 16 dyed glasses, and nothing else', () => {
    expect(paneIdFor('minecraft:glass')).toBe('minecraft:glass_pane');
    expect(paneIdFor('minecraft:light_blue_stained_glass')).toBe('minecraft:light_blue_stained_glass_pane');
    // tinted_glass genuinely has no pane in vanilla.
    expect(paneIdFor('minecraft:tinted_glass')).toBeNull();
    expect(paneIdFor('minecraft:white_concrete')).toBeNull();
  });

  it('keeps the vanilla wood/stone asymmetry', () => {
    // Wood has fences and no walls; stone has walls and no fences, except
    // nether brick, which uniquely has both.
    expect(FENCE_VARIANTS['minecraft:oak_planks']).toBe('minecraft:oak_fence');
    expect(WALL_VARIANTS['minecraft:oak_planks']).toBeUndefined();
    expect(WALL_VARIANTS['minecraft:cobblestone']).toBe('minecraft:cobblestone_wall');
    expect(FENCE_VARIANTS['minecraft:cobblestone']).toBeUndefined();
    expect(FENCE_VARIANTS['minecraft:nether_bricks']).toBe('minecraft:nether_brick_fence');
    expect(WALL_VARIANTS['minecraft:nether_bricks']).toBe('minecraft:nether_brick_wall');
    // …and the walls vanilla does NOT have, which are easy to invent.
    for (const m of ['minecraft:stone', 'minecraft:smooth_stone', 'minecraft:polished_andesite',
                     'minecraft:quartz_block', 'minecraft:purpur_block', 'minecraft:smooth_sandstone']) {
      expect(WALL_VARIANTS[m]).toBeUndefined();
    }
  });
});

describe('the pass', () => {
  it('turns a window glass cell into a pane', () => {
    const { grid, hints } = oneCell('minecraft:light_blue_stained_glass', ELEMENT_PANE);
    const stats = applyPartElements(grid, hints);
    expect(stats.panes).toBe(1);
    expect(grid.get(1, 1, 1)).toBe(
      'minecraft:light_blue_stained_glass_pane[east=false,north=false,south=false,waterlogged=false,west=false]',
    );
  });

  it('connects a pane to its solid neighbours', () => {
    const { grid, hints } = oneCell('minecraft:glass', ELEMENT_PANE, g => {
      g.set(2, 1, 1, 'minecraft:stone');   // east
      g.set(1, 1, 0, 'minecraft:stone');   // north
    });
    applyPartElements(grid, hints);
    expect(grid.get(1, 1, 1)).toBe(
      'minecraft:glass_pane[east=true,north=true,south=false,waterlogged=false,west=false]',
    );
  });

  it('turns a fence part into its wood fence and a stone one into a wall', () => {
    const wood = oneCell('minecraft:oak_planks', ELEMENT_FENCE);
    expect(applyPartElements(wood.grid, wood.hints).fences).toBe(1);
    expect(wood.grid.get(1, 1, 1)).toBe(
      'minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]',
    );

    const stone = oneCell('minecraft:cobblestone', ELEMENT_FENCE);
    expect(applyPartElements(stone.grid, stone.hints).walls).toBe(1);
    expect(stone.grid.get(1, 1, 1)).toBe(
      'minecraft:cobblestone_wall[east=none,north=none,south=none,up=true,waterlogged=false,west=none]',
    );
  });

  it('declines a fence in a material with neither variant', () => {
    const { grid, hints } = oneCell('minecraft:red_concrete', ELEMENT_FENCE);
    const stats = applyPartElements(grid, hints);
    expect(stats.fences + stats.walls).toBe(0);
    expect(stats.noVariant).toBe(1);
    expect(stats.noVariantByBlock['minecraft:red_concrete']).toBe(1);
    expect(grid.get(1, 1, 1)).toBe('minecraft:red_concrete');
  });

  it('only makes iron bars out of a neutral material', () => {
    const gray = oneCell('minecraft:gray_concrete', ELEMENT_BARS);
    expect(applyPartElements(gray.grid, gray.hints).bars).toBe(1);
    expect(gray.grid.get(1, 1, 1)).toMatch(/^minecraft:iron_bars\[/);

    // iron_bars is a fixed dark gray, so using it here would be a RECOLOUR.
    const red = oneCell('minecraft:red_concrete', ELEMENT_BARS);
    expect(applyPartElements(red.grid, red.hints).bars).toBe(0);
    expect(red.grid.get(1, 1, 1)).toBe('minecraft:red_concrete');
    expect(BARS_MATERIALS.has('minecraft:red_concrete')).toBe(false);
  });

  it('hangs a ladder on the wall BEHIND it and leaves the climbing side open', () => {
    const { grid, hints } = oneCell('minecraft:oak_planks', ELEMENT_LADDER, g => {
      g.set(1, 1, 0, 'minecraft:stone');   // wall to the north
    });
    const stats = applyPartElements(grid, hints);
    expect(stats.ladders).toBe(1);
    // Minecraft's ladder model sits on the face OPPOSITE `facing`, so a wall to
    // the north means the ladder faces south.
    expect(grid.get(1, 1, 1)).toBe('minecraft:ladder[facing=south,waterlogged=false]');
  });

  it('leaves a ladder with nothing to hang on as a cube', () => {
    const { grid, hints } = oneCell('minecraft:oak_planks', ELEMENT_LADDER);
    const stats = applyPartElements(grid, hints);
    expect(stats.ladders).toBe(0);
    expect(stats.unsupported).toBe(1);
    expect(grid.get(1, 1, 1)).toBe('minecraft:oak_planks');
  });

  it('leaves a ladder boxed in on both sides as a cube', () => {
    const { grid, hints } = oneCell('minecraft:oak_planks', ELEMENT_LADDER, g => {
      for (const [x, z] of [[1, 0], [1, 2], [0, 1], [2, 1]]) g.set(x!, 1, z!, 'minecraft:stone');
    });
    expect(applyPartElements(grid, hints).ladders).toBe(0);
    expect(grid.get(1, 1, 1)).toBe('minecraft:oak_planks');
  });

  it('drops a cell two different mapped parts both claimed', () => {
    const { grid, hints } = oneCell('minecraft:glass', ELEMENT_PANE);
    addElementRequest(hints, 1, 1, 1, ELEMENT_FENCE);      // conflict
    expect(hints.element![(1 * 3 + 1) * 3 + 1]).toBe(ELEMENT_CONFLICT);
    const stats = applyPartElements(grid, hints);
    expect(stats.candidates).toBe(0);
    expect(grid.get(1, 1, 1)).toBe('minecraft:glass');
  });

  it('never creates or removes a cell', () => {
    const grid = new BlockGrid(4, 4, 4);
    const hints = createShapeHints(4, 4, 4, false, true);
    let solid = 0;
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
      grid.set(x, 1, z, 'minecraft:glass');
      addElementRequest(hints, x, 1, z, ELEMENT_PANE);
      solid++;
    }
    const before = grid.countNonAir();
    applyPartElements(grid, hints);
    expect(grid.countNonAir()).toBe(before);
    expect(before).toBe(solid);
  });

  it('emits only lint-clean palette entries for every element it writes', () => {
    const grid = new BlockGrid(5, 3, 3);
    const hints = createShapeHints(5, 3, 3, false, true);
    const cases: Array<[number, string]> = [
      [ELEMENT_PANE, 'minecraft:lime_stained_glass'],
      [ELEMENT_FENCE, 'minecraft:spruce_planks'],
      [ELEMENT_FENCE, 'minecraft:sandstone'],
      [ELEMENT_BARS, 'minecraft:black_concrete'],
      [ELEMENT_LADDER, 'minecraft:oak_planks'],
    ];
    cases.forEach(([kind, block], x) => {
      grid.set(x, 1, 1, block);
      addElementRequest(hints, x, 1, 1, kind);
    });
    grid.set(4, 1, 0, 'minecraft:stone');           // wall for the ladder
    applyPartElements(grid, hints);
    expect(lintPalette(grid.reversePalette().filter(b => b !== AIR)).issues).toEqual([]);
  });
});

describe('handover to the shape pass', () => {
  it('leaves a placed element alone and lets a declined cell still become a slab', () => {
    const grid = new BlockGrid(3, 3, 3);
    const hints = createShapeHints(3, 3, 3, false, true);
    // (0,1,1): a real pane. (1,1,1): a fence in a material with no variant.
    grid.set(0, 1, 1, 'minecraft:glass');
    addElementRequest(hints, 0, 1, 1, ELEMENT_PANE);
    grid.set(1, 1, 1, 'minecraft:sandstone');
    addElementRequest(hints, 1, 1, 1, ELEMENT_BARS);      // sandstone is not neutral
    // Both cells read as bottom-half occupancy, i.e. slab candidates.
    for (const x of [0, 1]) {
      const i = (1 * 3 + 1) * 3 + x;
      hints.lo[i] = 0; hints.hi[i] = Math.round(0.4 * 255);
    }
    applyPartElements(grid, hints);
    const stats = applyBlockShapes(grid, hints);
    expect(grid.get(0, 1, 1)).toMatch(/^minecraft:glass_pane\[/);   // untouched
    expect(grid.get(1, 1, 1)).toBe('minecraft:sandstone_slab[type=bottom]');
    expect(stats.slabs).toBe(1);
  });
});

describe('the resolution guard', () => {
  it('is a real cap, and coarse enough to admit a whole window at 1 block/stud', () => {
    // A 1x4x6 window glass is ~5x8 cells at 20 LDU per cell and ~150 at 4 LDU.
    // The cap has to sit between those or the pass is either useless or
    // destructive — see MAX_ELEMENT_CELLS.
    expect(MAX_ELEMENT_CELLS).toBeGreaterThan(40);
    expect(MAX_ELEMENT_CELLS).toBeLessThan(150);
  });
});
