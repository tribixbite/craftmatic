/**
 * Unit tests for the LDraw MPD/LDR parser — the heart of the LEGO pipeline.
 *
 * These are fully offline and deterministic (synthetic LDraw text, no network),
 * guarding the intricate, currently-unguarded transform / step / primitive logic
 * called out in ROADMAP.md #1. All expected values are hand-derived from the
 * LDraw spec (world = parentRot × local + parentPos; childRot = parentRot × localRot).
 */

import { describe, it, expect } from 'vitest';
import { parseLDraw, countSteps } from '../web/src/engine/ldraw-parser.js';

// Identity 3×3, row-major — the no-rotation placement matrix.
const I = '1 0 0 0 1 0 0 0 1';

describe('parseLDraw — basic placement', () => {
  it('emits a single brick at the given position with identity rotation', () => {
    const bricks = parseLDraw(`1 4 10 20 30 ${I} 3001.dat`);
    expect(bricks).toHaveLength(1);
    const b = bricks[0];
    expect(b.color).toBe(4);
    expect(b.x).toBeCloseTo(10);
    expect(b.y).toBeCloseTo(20);
    expect(b.z).toBeCloseTo(30);
    expect(b.part).toBe('3001.dat');
    expect(b.step).toBe(1);
    expect(b.rot).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('returns [] for empty / comment-only input', () => {
    expect(parseLDraw('')).toEqual([]);
    expect(parseLDraw('   \n\n  ')).toEqual([]);
    expect(parseLDraw('0 a comment\n0 STEP')).toEqual([]);
  });

  it('lowercases part names and strips path prefixes / backslashes', () => {
    const bricks = parseLDraw(`1 4 0 0 0 ${I} s\\3001S01.DAT`);
    expect(bricks[0].part).toBe('3001s01.dat');
  });
});

describe('parseLDraw — nested transform accumulation', () => {
  // Main places sub.ldr translated +100 in X and rotated 90° about Y.
  // Ry(90°) row-major = [0 0 1, 0 1 0, -1 0 0].
  // The sub contains one brick at local (10,0,0).
  //   world = Ry·(10,0,0) + (100,0,0) = (100, 0, -10).
  const MPD = [
    '0 FILE main.ldr',
    '1 16 100 0 0 0 0 1 0 1 0 -1 0 0 sub.ldr',
    '0 FILE sub.ldr',
    `1 4 10 0 0 ${I} 3001.dat`,
  ].join('\n');

  it('applies parentRot × local + parentPos to nested bricks', () => {
    const bricks = parseLDraw(MPD);
    expect(bricks).toHaveLength(1);
    const b = bricks[0];
    expect(b.x).toBeCloseTo(100);
    expect(b.y).toBeCloseTo(0);
    expect(b.z).toBeCloseTo(-10);
  });

  it('compounds rotation: childRot = parentRot × localRot', () => {
    const b = parseLDraw(MPD)[0];
    // local is identity, so childRot equals the parent (Ry 90°) matrix.
    expect(b.rot!.map((v) => Math.round(v))).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
  });
});

describe('parseLDraw — colour-16 (Main Colour) inheritance', () => {
  it('resolves a colour-16 brick to its parent reference colour', () => {
    const MPD = [
      '0 FILE main.ldr',
      `1 4 0 0 0 ${I} sub.ldr`, // sub referenced as colour 4
      '0 FILE sub.ldr',
      `1 16 0 0 0 ${I} 3001.dat`, // brick inherits → 4
    ].join('\n');
    expect(parseLDraw(MPD)[0].color).toBe(4);
  });

  it('keeps an explicit non-16 colour even inside a coloured sub', () => {
    const MPD = [
      '0 FILE main.ldr',
      `1 4 0 0 0 ${I} sub.ldr`,
      '0 FILE sub.ldr',
      `1 1 0 0 0 ${I} 3001.dat`, // explicit blue, not inherited
    ].join('\n');
    expect(parseLDraw(MPD)[0].color).toBe(1);
  });
});

describe('countSteps / step numbering', () => {
  it('counts flat top-level STEP markers (step starts at 1)', () => {
    const ldr = [
      `1 4 0 0 0 ${I} 3001.dat`,
      '0 STEP',
      `1 4 0 0 0 ${I} 3002.dat`,
      '0 STEP',
      `1 4 0 0 0 ${I} 3003.dat`,
    ].join('\n');
    const bricks = parseLDraw(ldr);
    expect(bricks.map((b) => b.step)).toEqual([1, 2, 3]);
    expect(countSteps(bricks)).toBe(3);
  });

  it('counts STEP markers nested inside sub-assemblies (the 31084 case)', () => {
    // Top level holds only references; the STEP markers live inside a.ldr/b.ldr.
    // A depth-0-only counter would report 1 step; the real one accumulates.
    const MPD = [
      '0 FILE main.ldr',
      `1 16 0 0 0 ${I} a.ldr`,
      `1 16 0 0 0 ${I} b.ldr`,
      '0 FILE a.ldr',
      `1 4 0 0 0 ${I} 3001.dat`,
      '0 STEP',
      `1 4 0 0 0 ${I} 3002.dat`,
      '0 FILE b.ldr',
      `1 4 0 0 0 ${I} 3003.dat`,
      '0 STEP',
      `1 4 0 0 0 ${I} 3004.dat`,
    ].join('\n');
    const bricks = parseLDraw(MPD);
    expect(bricks.map((b) => b.part)).toEqual(['3001.dat', '3002.dat', '3003.dat', '3004.dat']);
    expect(bricks.map((b) => b.step)).toEqual([1, 2, 2, 3]);
    expect(countSteps(bricks)).toBe(3);
  });

  it('countSteps returns 0 for an empty model', () => {
    expect(countSteps([])).toBe(0);
  });
});

describe('parseLDraw — geometry-primitive filtering', () => {
  it('drops primitive sub-part files but keeps real parts', () => {
    const ldr = [
      `1 4 0 0 0 ${I} 3001.dat`, // real part — kept
      `1 4 0 0 0 ${I} 4-4cyli.dat`, // fraction primitive — dropped
      `1 4 0 0 0 ${I} stud.dat`, // stud primitive — dropped
      `1 4 0 0 0 ${I} box.dat`, // box primitive — dropped
      `1 4 0 0 0 ${I} ring3.dat`, // ring primitive — dropped
      `1 4 0 0 0 ${I} stug2.dat`, // anti-stud primitive — dropped
    ].join('\n');
    const bricks = parseLDraw(ldr);
    expect(bricks.map((b) => b.part)).toEqual(['3001.dat']);
  });
});

describe('parseLDraw — embedded part definitions vs shortcuts', () => {
  it('treats Unofficial_Part as a terminal brick (not recursed) but recurses Unofficial_Shortcut', () => {
    const MPD = [
      '0 FILE main.ldr',
      `1 4 0 0 0 ${I} embedded.dat`,
      `1 4 0 0 0 ${I} shortcut.dat`,
      '0 FILE embedded.dat',
      '0 !LDRAW_ORG Unofficial_Part',
      `1 4 0 0 0 ${I} 3001.dat`, // must NOT surface — part def is terminal
      '0 FILE shortcut.dat',
      '0 !LDRAW_ORG Unofficial_Shortcut',
      `1 4 0 0 0 ${I} 3002.dat`, // must surface — shortcuts are recursed
      `1 4 0 0 0 ${I} 3003.dat`,
    ].join('\n');
    const parts = parseLDraw(MPD).map((b) => b.part);
    expect(parts).toEqual(['embedded.dat', '3002.dat', '3003.dat']);
  });
});

describe('parseLDraw — malformed lines', () => {
  it('skips type-1 lines with too few tokens', () => {
    const ldr = [
      '1 4 0 0 0 1 0 0', // truncated — ignored
      `1 4 0 0 0 ${I} 3001.dat`,
    ].join('\n');
    expect(parseLDraw(ldr).map((b) => b.part)).toEqual(['3001.dat']);
  });
});
