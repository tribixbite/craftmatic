/**
 * The "Textured + shapes" block-mapping profile (slice 4 / proposal pass D).
 *
 * The point of the profile is coverage: vanilla has no slab or stair for any
 * dyed family, so as long as the tables emit concrete the block-shape passes
 * can only ever refine the handful of cells that happen to be sandstone. These
 * tests pin the three things that can silently break that:
 *   • the anchors — which LEGO colours must move onto a shape-capable material
 *     and, just as importantly, which must NOT (a nearest-neighbour that repaints
 *     LEGO red as acacia planks is "correct" and unusable);
 *   • every candidate id being a real block AND present in the render table, so
 *     a re-imported export never falls through to the hash-coloured fallback;
 *   • material-seam coherence — one block per colour id, so a part cannot dither.
 */

import { describe, it, expect } from 'vitest';
import {
  TEXTURED_PALETTE, matchTextured, matchTexturedHex, rgbToOklab,
  texturedLdrawColorToBlock, texturedStudioColorToBlock,
  SHAPE_PENALTY, MAX_TEXTURED_DISTANCE, CHROMA_FLOOR, MAX_HUE_SHIFT, MIN_CHROMA_RATIO,
} from '../web/src/engine/textured-palette.js';
import { SHAPE_VARIANTS, slabIdFor, stairsIdFor } from '../web/src/engine/block-shapes.js';
import { lintPalette } from '../web/src/engine/palette-lint.js';
import { getAllBlockColors } from '../src/blocks/colors.js';
import { LDRAW_COLOR_RGB, ldrawColorToBlock } from '../web/src/engine/ldraw-colors.js';
import { STUDIO_COLOR_TO_BLOCK } from '../web/src/engine/studio-colors.js';
import { BLOCK_PROFILES, TEXTURED_PROFILE_ID, getBlockProfile } from '../web/src/engine/block-profiles.js';

describe('OKLab', () => {
  it('puts black at L 0 and white at L 1', () => {
    const [lk] = rgbToOklab(0, 0, 0);
    const [lw] = rgbToOklab(255, 255, 255);
    expect(lk).toBeCloseTo(0, 6);
    expect(lw).toBeCloseTo(1, 3);
  });

  it('gives a mid gray zero chroma', () => {
    const [, a, b] = rgbToOklab(128, 128, 128);
    expect(Math.abs(a)).toBeLessThan(1e-6);
    expect(Math.abs(b)).toBeLessThan(1e-6);
  });
});

describe('the candidate palette', () => {
  it('is entirely real Minecraft blocks, with real slabs and stairs', () => {
    const ids = TEXTURED_PALETTE.map(c => c.block);
    expect(lintPalette(ids).issues).toEqual([]);
    // …and every shape id the pass could derive from one of them.
    const shapes: string[] = [];
    for (const id of ids) {
      const slab = slabIdFor(id, 'bottom');
      const stairs = stairsIdFor(id, 'north', 'top');
      if (slab) shapes.push(slab);
      if (stairs) shapes.push(stairs);
    }
    expect(shapes.length).toBeGreaterThan(80);
    expect(lintPalette(shapes).issues).toEqual([]);
  });

  it('gives every candidate an explicit colour in the render table', () => {
    // getBlockColor() has a HASH fallback for unknown ids, so a candidate the
    // render table doesn't list re-imports as a random colour in the Upload
    // tab's 3D view instead of failing loudly. Presence is the invariant; the
    // VALUES deliberately differ (BLOCK_COLORS' dyed entries are LEGO-tuned).
    const known = getAllBlockColors();
    const missing = TEXTURED_PALETTE.map(c => c.block).filter(b => !known.has(b));
    expect(missing).toEqual([]);
  });

  it('carries no dyed family other than concrete, and no glazed terracotta', () => {
    for (const { block } of TEXTURED_PALETTE) {
      expect(block).not.toMatch(/_glazed_terracotta$/);
      expect(block).not.toMatch(/_wool$/);
      expect(block).not.toMatch(/_terracotta$/);
      expect(block).not.toMatch(/_concrete_powder$/);
    }
  });

  it('has more shape-capable candidates than dyed ones', () => {
    const shapeable = TEXTURED_PALETTE.filter(c => SHAPE_VARIANTS[c.block]?.slab);
    expect(shapeable.length).toBeGreaterThan(TEXTURED_PALETTE.length - shapeable.length);
  });

  it('lists no duplicate block', () => {
    const ids = TEXTURED_PALETTE.map(c => c.block);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the matcher', () => {
  it('reports the real distance, not the biased score', () => {
    // An exact hit on a listed candidate must read as distance 0.
    const stone = TEXTURED_PALETTE.find(c => c.block === 'minecraft:stone')!;
    const m = matchTextured(...(stone.rgb as [number, number, number]));
    expect(m.block).toBe('minecraft:stone');
    expect(m.distance).toBeCloseTo(0, 6);
  });

  it('rejects a malformed hex instead of guessing', () => {
    expect(matchTexturedHex('nope')).toBeNull();
    expect(matchTexturedHex('#FFF')).toBeNull();
    expect(matchTexturedHex('#A0A5A9')?.block).toBe('minecraft:smooth_stone');
  });

  it('never returns a block outside the palette', () => {
    const ids = new Set(TEXTURED_PALETTE.map(c => c.block));
    for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
      expect(ids.has(matchTextured(r, g, b).block)).toBe(true);
    }
  });

  it('honours the absolute gate: a far shape-capable block never wins', () => {
    for (let r = 0; r < 256; r += 37) for (let g = 0; g < 256; g += 37) for (let b = 0; b < 256; b += 37) {
      const m = matchTextured(r, g, b);
      if (m.shapeable) expect(m.distance).toBeLessThanOrEqual(MAX_TEXTURED_DISTANCE);
    }
  });

  it('keeps the gates in a sane relationship', () => {
    expect(SHAPE_PENALTY).toBeGreaterThan(0);
    expect(SHAPE_PENALTY).toBeLessThan(MAX_TEXTURED_DISTANCE);
    expect(MAX_HUE_SHIFT).toBeGreaterThan(0);
    expect(MAX_HUE_SHIFT).toBeLessThan(90);
    expect(MIN_CHROMA_RATIO).toBeGreaterThan(0);
    expect(MIN_CHROMA_RATIO).toBeLessThan(1);
    expect(CHROMA_FLOOR).toBeGreaterThan(0);
  });
});

describe('anchors — colours that MUST move onto a shape-capable material', () => {
  const cases: Array<[number, string, string]> = [
    [71, 'Light Bluish Gray', 'minecraft:smooth_stone'],
    [7,  'Light Gray',        'minecraft:smooth_stone'],
    [72, 'Dark Bluish Gray',  'minecraft:stone_bricks'],
    [15, 'White',             'minecraft:quartz_block'],
    [19, 'Tan',               'minecraft:smooth_sandstone'],
    [28, 'Dark Tan',          'minecraft:oak_planks'],
    [70, 'Reddish Brown',     'minecraft:dark_oak_planks'],
    [308, 'Dark Brown',       'minecraft:dark_oak_planks'],
    [484, 'Dark Orange',      'minecraft:acacia_planks'],
  ];
  for (const [id, name, block] of cases) {
    it(`LDraw ${id} (${name}) → ${block.replace('minecraft:', '')}`, () => {
      expect(texturedLdrawColorToBlock(id)).toBe(block);
      expect(SHAPE_VARIANTS[block]?.slab).toBeTruthy();
    });
  }
});

describe('anchors — colours that must STAY dyed', () => {
  // Each of these has a "nearer" textured neighbour in raw OKLab terms and is
  // held back by MAX_TEXTURED_DISTANCE. Without that gate the first cut of this
  // profile repainted LEGO red as acacia planks and orange as bamboo.
  // They must land on the DEFAULT table's block, not merely on some dyed block:
  // the nearest dyed candidate to LEGO Orange is `yellow_concrete`, and quietly
  // substituting that for the hand-curated `orange_concrete` would be a
  // regression the profile has no business making (header rule 2).
  const cases: Array<[number, string, string]> = [
    [4,  'Red',    'minecraft:red_concrete'],
    [25, 'Orange', 'minecraft:orange_concrete'],
    [14, 'Yellow', 'minecraft:yellow_concrete'],
    [27, 'Lime',   'minecraft:lime_concrete'],
    [22, 'Purple', 'minecraft:purple_concrete'],
    [0,  'Black',  'minecraft:black_concrete'],
    [1,  'Blue',   'minecraft:blue_concrete'],
  ];
  for (const [id, name, block] of cases) {
    it(`LDraw ${id} (${name}) stays ${block.replace('minecraft:', '')}`, () => {
      expect(texturedLdrawColorToBlock(id)).toBe(block);
      expect(texturedLdrawColorToBlock(id)).toBe(ldrawColorToBlock(id));
      expect(SHAPE_VARIANTS[block]).toBeUndefined();
    });
  }

  it('changes a colour ONLY when the replacement carries a slab', () => {
    for (const key of Object.keys(LDRAW_COLOR_RGB)) {
      const id = Number(key);
      const tex = texturedLdrawColorToBlock(id);
      if (tex !== ldrawColorToBlock(id)) expect(SHAPE_VARIANTS[tex]?.slab).toBeTruthy();
    }
  });

  // The greens are held back by the COLOUR-CHARACTER guard, not by distance:
  // each has a shape-capable block nearer than its concrete, and each of those
  // blocks is a yellow or a neutral gray. This regression shipped in the first
  // cut and was caught only by a schemat.io A/B — 121,594 cells of 21063's Olive
  // Green landscaping came out as bamboo planks.
  const greens: Array<[number, string, string]> = [
    [330, 'Olive Green',  'minecraft:bamboo_planks'],
    [288, 'Dark Green',   'minecraft:deepslate_tiles'],
    [378, 'Sand Green',   'minecraft:diorite'],
  ];
  for (const [id, name, wouldHaveBeen] of greens) {
    it(`LDraw ${id} (${name}) is NOT repainted as ${wouldHaveBeen.replace('minecraft:', '')}`, () => {
      expect(texturedLdrawColorToBlock(id)).toBe(ldrawColorToBlock(id));
      // The rejected block really is nearer — i.e. the guard is what saved it,
      // not the distance gate.
      const hex = LDRAW_COLOR_RGB[id]!;
      const rgb: [number, number, number] = [
        parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
      ];
      const lab = rgbToOklab(...rgb);
      const cand = TEXTURED_PALETTE.find(c => c.block === wouldHaveBeen)!;
      const cl = rgbToOklab(...(cand.rgb as [number, number, number]));
      const d = Math.hypot(lab[0] - cl[0], lab[1] - cl[1], lab[2] - cl[2]);
      expect(d).toBeLessThanOrEqual(MAX_TEXTURED_DISTANCE);
    });
  }

  it('a neutral brick may not GAIN chroma', () => {
    // LEGO's grays must land on gray stone, never on a plank or a prismarine.
    for (const id of [7, 71, 72, 496, 135]) {
      const block = texturedLdrawColorToBlock(id);
      const cand = TEXTURED_PALETTE.find(c => c.block === block);
      if (!cand) continue;
      const lab = rgbToOklab(...(cand.rgb as [number, number, number]));
      expect(Math.hypot(lab[1], lab[2])).toBeLessThanOrEqual(CHROMA_FLOOR * 2);
    }
  });

  it('black is the deliberate boundary case, not an accident', () => {
    // Vanilla's darkest slab material is blackstone, a whole OKLab lightness
    // step above LEGO black — if that ever changes this test should be revisited
    // rather than silently start emitting blackstone for black bricks.
    const m = matchTextured(0x05, 0x13, 0x1d);
    expect(m.shapeable).toBe(false);
    const shapeable = TEXTURED_PALETTE.filter(c => SHAPE_VARIANTS[c.block]?.slab);
    const lab = rgbToOklab(0x05, 0x13, 0x1d);
    const best = Math.min(...shapeable.map(c => {
      const l = rgbToOklab(...(c.rgb as [number, number, number]));
      return Math.hypot(lab[0] - l[0], lab[1] - l[1], lab[2] - l[2]);
    }));
    expect(best).toBeGreaterThan(MAX_TEXTURED_DISTANCE);
  });
});

describe('colours the profile must not touch', () => {
  it('leaves transparent bricks in stained glass', () => {
    for (const id of [33, 34, 36, 40, 43, 46, 47, 117]) {
      expect(texturedLdrawColorToBlock(id)).toBe(ldrawColorToBlock(id));
      expect(texturedLdrawColorToBlock(id)).toMatch(/_stained_glass$|:glass$/);
    }
  });

  it('leaves chrome / metallic bricks on metal blocks', () => {
    for (const id of [80, 82, 83, 87, 297, 494]) {
      expect(texturedLdrawColorToBlock(id)).toBe(ldrawColorToBlock(id));
      expect(texturedLdrawColorToBlock(id)).toMatch(/_block$/);
    }
  });

  it('falls back to the default table for a colour with no known hex', () => {
    const unknown = 987654;
    expect(LDRAW_COLOR_RGB[unknown]).toBeUndefined();
    expect(texturedLdrawColorToBlock(unknown)).toBe(ldrawColorToBlock(unknown));
  });
});

describe('material-seam coherence', () => {
  it('resolves one block per colour id, stably', () => {
    // Every cell of every part of a colour takes the same block, so a part can
    // never dither across families — that is the whole coherence guarantee.
    for (const id of [0, 15, 19, 71, 72, 70, 4]) {
      const first = texturedLdrawColorToBlock(id);
      for (let i = 0; i < 5; i++) expect(texturedLdrawColorToBlock(id)).toBe(first);
    }
  });

  it('emits only real blocks across the whole LDraw table', () => {
    const ids = Object.keys(LDRAW_COLOR_RGB).map(Number).map(texturedLdrawColorToBlock);
    expect(lintPalette(ids).issues).toEqual([]);
    expect(ids.length).toBeGreaterThan(150);
  });
});

describe('the Studio/BrickLink colour space', () => {
  it('routes BL ids through BL_TO_LDRAW to the same answer', () => {
    // BL 1 = White = LDraw 15; BL 2 = Tan = LDraw 19; BL 11 = Black = LDraw 0.
    expect(texturedStudioColorToBlock(1)).toBe(texturedLdrawColorToBlock(15));
    expect(texturedStudioColorToBlock(2)).toBe(texturedLdrawColorToBlock(19));
    expect(texturedStudioColorToBlock(11)).toBe(texturedLdrawColorToBlock(0));
  });

  it('emits only real blocks for every BL id in the Studio table', () => {
    const ids = Object.keys(STUDIO_COLOR_TO_BLOCK).map(Number).map(texturedStudioColorToBlock);
    expect(lintPalette(ids).issues).toEqual([]);
    expect(ids.length).toBeGreaterThan(100);
  });
});

describe('the profile registration', () => {
  it('is selectable and distinct from the default', () => {
    const p = getBlockProfile(TEXTURED_PROFILE_ID);
    expect(p.id).toBe(TEXTURED_PROFILE_ID);
    expect(BLOCK_PROFILES.map(x => x.id)).toContain(TEXTURED_PROFILE_ID);
    // The default must stay the default — a palette change ships selectable.
    expect(BLOCK_PROFILES[0]!.id).toBe('default');
    expect(p.colorFn('ldraw')).toBeTypeOf('function');
    expect(p.colorFn('bl')).toBeTypeOf('function');
    // The default profile still means "engine built-in table" for LDraw space.
    expect(BLOCK_PROFILES[0]!.colorFn('ldraw')).toBeUndefined();
  });

  it('actually resolves colours differently from the default', () => {
    const tex = getBlockProfile(TEXTURED_PROFILE_ID).colorFn('ldraw')!;
    expect(tex(71)).not.toBe(ldrawColorToBlock(71));
    expect(tex(15)).not.toBe(ldrawColorToBlock(15));
  });
});
