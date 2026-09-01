/**
 * Colour-space detection for .io archives (regression for the .schem export bug,
 * backlog S1).
 *
 * BrickLink Studio writes the SAME model twice inside one .io: `model.ldr` uses
 * standard LDraw colour ids and `model2.ldr` uses Studio/BrickLink ids.
 * `extractIoModel` returns whichever entry actually has type-1 brick refs —
 * modern exports win on model.ldr. The old code blanket-applied
 * `studioColorToBlock` to every ".io" by EXTENSION, so LDraw ids were read
 * through the BL table: LDraw 15 (White) hit Studio 15 (Trans-Light Blue) and
 * 21063's white castle walls exported as light-blue stained glass, while LDraw
 * 71/28 (Light Bluish Gray / Dark Tan) became magenta/orange concrete.
 *
 * Fixtures below are synthetic but mirror the real 21063 pairing measured from
 * C:/git/clego/lego_sets/IO/21063.io (939 white bricks are LDraw 15 in
 * model.ldr and BL 1 in model2.ldr, etc.).
 */

import { describe, it, expect } from 'vitest';
import {
  colorHistogram,
  detectIoColorSpace,
} from '../web/src/engine/io-extractor.js';
import { BL_TO_LDRAW } from '../web/src/engine/bl-ldraw-map.js';
import { ldrawColorToBlock } from '../web/src/engine/ldraw-colors.js';
import { studioColorToBlock } from '../web/src/engine/studio-colors.js';

/** Build an LDraw text body with `count` type-1 lines of each given colour. */
function makeModel(counts: Record<number, number>): string {
  const lines = ['0 Synthetic test model', '0 Name: test.ldr'];
  for (const [id, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      lines.push(`1 ${id} 0 ${i * 24} 0 1 0 0 0 1 0 0 0 1 3001.dat`);
    }
  }
  return lines.join('\n');
}

// The real 21063 pairing (part counts from the archive's own histograms).
const REAL_PAIRS: [ldraw: number, bl: number, count: number][] = [
  [15, 1, 939],   // White        — the castle walls
  [330, 155, 354], // Olive Green
  [0, 11, 328],   // Black
  [72, 85, 318],  // Dark Bluish Gray
  [71, 86, 298],  // Light Bluish Gray
  [19, 2, 277],   // Tan
  [28, 69, 219],  // Dark Tan
  [2, 6, 153],    // Green
  [288, 80, 118], // Dark Green
  [70, 88, 88],   // Reddish Brown
  [320, 59, 63],  // Dark Red
];

const LDRAW_SPACE = makeModel(Object.fromEntries(REAL_PAIRS.map(([l, , n]) => [l, n])));
const BL_SPACE = makeModel(Object.fromEntries(REAL_PAIRS.map(([, b, n]) => [b, n])));

describe('BL_TO_LDRAW map', () => {
  it('reproduces the real 21063 model.ldr ids from its model2.ldr ids', () => {
    for (const [ldraw, bl] of REAL_PAIRS) {
      expect(BL_TO_LDRAW[bl], `BL ${bl} should map to LDraw ${ldraw}`).toBe(ldraw);
    }
  });
});

describe('colorHistogram', () => {
  it('counts type-1 colour ids', () => {
    const h = colorHistogram(makeModel({ 15: 3, 0: 2 }));
    expect(h.get(15)).toBe(3);
    expect(h.get(0)).toBe(2);
  });

  it('ignores the -1 inherit placeholder (spelled the same in both spaces)', () => {
    const h = colorHistogram(makeModel({ 15: 3, [-1]: 500 }));
    expect(h.has(-1)).toBe(false);
    expect(h.get(15)).toBe(3);
  });

  it('ignores comment and non-type-1 lines', () => {
    const h = colorHistogram('0 Comment 1 15 x\n2 24 0 0 0 1 1 1\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat');
    expect([...h.entries()]).toEqual([[4, 1]]);
  });
});

describe('detectIoColorSpace — paired entries (the real Studio layout)', () => {
  const entries = new Map([['model.ldr', LDRAW_SPACE], ['model2.ldr', BL_SPACE]]);

  it('classifies a chosen model.ldr as LDraw space', () => {
    const d = detectIoColorSpace('model.ldr', LDRAW_SPACE, entries);
    expect(d.space).toBe('ldraw');
    expect(d.reason).toMatch(/paired-histogram confirmed/);
  });

  it('classifies a chosen model2.ldr as BL space', () => {
    const d = detectIoColorSpace('model2.ldr', BL_SPACE, entries);
    expect(d.space).toBe('bl');
    expect(d.reason).toMatch(/paired-histogram confirmed/);
  });

  it('is unaffected by model2.ldr being padded with -1 inline sub-part refs', () => {
    // The real 21063 model2.ldr has 5,542 `-1` lines against 3,245 real ones.
    const padded = `${BL_SPACE}\n${makeModel({ [-1]: 5542 })}`;
    const padEntries = new Map([['model.ldr', LDRAW_SPACE], ['model2.ldr', padded]]);
    expect(detectIoColorSpace('model.ldr', LDRAW_SPACE, padEntries).space).toBe('ldraw');
    expect(detectIoColorSpace('model2.ldr', padded, padEntries).space).toBe('bl');
  });
});

describe('detectIoColorSpace — degenerate archives', () => {
  it('falls back to the entry-name convention with only model.ldr', () => {
    const entries = new Map([['model.ldr', LDRAW_SPACE]]);
    const d = detectIoColorSpace('model.ldr', LDRAW_SPACE, entries);
    expect(d.space).toBe('ldraw');
    expect(d.reason).toMatch(/entry-name convention/);
  });

  it('falls back to BL for a lone model2.ldr (the Studio norm)', () => {
    const entries = new Map([['model2.ldr', BL_SPACE]]);
    expect(detectIoColorSpace('model2.ldr', BL_SPACE, entries).space).toBe('bl');
  });

  it('treats modelv2.ldr as BL space', () => {
    const entries = new Map([['modelv2.ldr', BL_SPACE]]);
    expect(detectIoColorSpace('modelv2.ldr', BL_SPACE, entries).space).toBe('bl');
  });

  it('reports LDraw when both entries literally agree (one shared space)', () => {
    const entries = new Map([['model.ldr', LDRAW_SPACE], ['model2.ldr', LDRAW_SPACE]]);
    const d = detectIoColorSpace('model2.ldr', LDRAW_SPACE, entries);
    expect(d.space).toBe('ldraw');
    expect(d.reason).toMatch(/share one colour space/);
  });

  it('does not crash on a model with no colour ids', () => {
    const entries = new Map([['model.ldr', '0 Empty'], ['model2.ldr', BL_SPACE]]);
    expect(detectIoColorSpace('model.ldr', '0 Empty', entries).space).toBe('ldraw');
  });
});

describe('the bug this prevents', () => {
  it('LDraw 15 through the BL table is glass, through its own table is white', () => {
    expect(studioColorToBlock(15)).toBe('minecraft:light_blue_stained_glass');
    expect(ldrawColorToBlock(15)).toBe('minecraft:white_concrete');
  });

  it('every real 21063 colour resolves to an opaque non-glass block in LDraw space', () => {
    for (const [ldraw] of REAL_PAIRS) {
      expect(ldrawColorToBlock(ldraw), `LDraw id ${ldraw}`).not.toMatch(/glass/);
    }
  });

  it('reading those same ids through the BL table produces the reported artefacts', () => {
    // Documents the exact symptoms in output/schem-backlog/user-schematio-1.png.
    expect(studioColorToBlock(15)).toMatch(/glass/);            // walls: blue glass
    expect(studioColorToBlock(71)).toBe('minecraft:magenta_concrete'); // terrain: magenta
    expect(studioColorToBlock(28)).toBe('minecraft:orange_concrete');  // terrain: orange
    expect(studioColorToBlock(72)).toBe('minecraft:light_blue_concrete'); // terrain: cyan
  });
});
