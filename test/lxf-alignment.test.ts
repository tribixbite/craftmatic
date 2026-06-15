/**
 * Unit tests for the .lxf (LDD) per-part alignment math — issue #108.
 *
 * Roadmap #1 flagged this intricate transform as needing tests; it's the
 * error-prone core that, when wrong, makes .lxf models render with floating /
 * mis-rotated pieces. The DOM/fetch/ZIP glue around it (parseLxf) is thin; the
 * MATH is what breaks, so it's extracted into pure exported functions and
 * tested directly here — no DOM, no network, no deps. Expected values are
 * hand-derived from the LDD→LDraw conventions documented in lxf-parser.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  axisAngleToMatrix,
  parseBoneTransform,
  composeLxfPlacement,
  type PartAlign,
} from '../web/src/engine/lxf-parser.js';

const HALF_PI = Math.PI / 2;
const expectMat = (got: number[], want: number[]) => {
  expect(got).toHaveLength(9);
  for (let i = 0; i < 9; i++) expect(got[i]).toBeCloseTo(want[i], 6);
};

describe('axisAngleToMatrix', () => {
  it('returns identity for zero angle or zero axis', () => {
    expectMat(axisAngleToMatrix(0, 0, 1, 0), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expectMat(axisAngleToMatrix(1.23, 0, 0, 0), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('builds a 90° rotation about Z (row-major)', () => {
    expectMat(axisAngleToMatrix(HALF_PI, 0, 0, 1), [0, -1, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('builds a 90° rotation about Y (row-major)', () => {
    expectMat(axisAngleToMatrix(HALF_PI, 0, 1, 0), [0, 0, 1, 0, 1, 0, -1, 0, 0]);
  });

  it('normalizes a non-unit axis (180° about (0,0,2) == about Z)', () => {
    expectMat(axisAngleToMatrix(Math.PI, 0, 0, 2), [-1, 0, 0, 0, -1, 0, 0, 0, 1]);
  });
});

describe('parseBoneTransform — column-major 4×3 → row-major + translation', () => {
  it('extracts identity rotation + translation', () => {
    const r = parseBoneTransform('1,0,0,0,1,0,0,0,1,1,2,3')!;
    expectMat(r.rBone, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(r.tBone).toEqual([1, 2, 3]);
  });

  it('transposes a column-major Rz(90) into the right row-major matrix', () => {
    // Rz(90) row-major is [0,-1,0, 1,0,0, 0,0,1]; its COLUMN-major flat
    // (cols 0,1,2 = (0,1,0),(-1,0,0),(0,0,1)) is [0,1,0,-1,0,0,0,0,1].
    const r = parseBoneTransform('0,1,0,-1,0,0,0,0,1,10,20,30')!;
    expectMat(r.rBone, [0, -1, 0, 1, 0, 0, 0, 0, 1]);
    expect(r.tBone).toEqual([10, 20, 30]);
  });

  it('returns null when fewer than 12 values', () => {
    expect(parseBoneTransform('1,2,3')).toBeNull();
    expect(parseBoneTransform('')).toBeNull();
  });
});

describe('composeLxfPlacement — LDD bone × align → LDraw placement', () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const RZ90 = [0, -1, 0, 1, 0, 0, 0, 0, 1]; // row-major

  it('converts a pure translation (Y-flip + ×25), no align', () => {
    const p = composeLxfPlacement(I, [1, 2, 3], undefined);
    expectMat(p.rot, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(p.x).toBeCloseTo(25);   //  1 cm × 25
    expect(p.y).toBeCloseTo(-50);  // -2 cm × 25 (Y flipped)
    expect(p.z).toBeCloseTo(75);   //  3 cm × 25
  });

  it('F-conjugates the rotation (Rz(90) in LDD → Rz(-90) in LDraw)', () => {
    const p = composeLxfPlacement(RZ90, [0, 0, 0], undefined);
    expectMat(p.rot, [0, 1, 0, -1, 0, 0, 0, 0, 1]);
  });

  it('composes t_world = R_bone·t_align + t_bone', () => {
    // align = identity rotation, t_align=(0,1,0); bone = Rz(90), t_bone=(10,0,0).
    // R_bone·t_align = Rz90·(0,1,0) = (-1,0,0); + t_bone = (9,0,0) → x=225.
    const align: PartAlign = ['p.dat', 0, 1, 0, 0, 0, 0, 1];
    const p = composeLxfPlacement(RZ90, [10, 0, 0], align);
    expect(p.x).toBeCloseTo(225);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
    expectMat(p.rot, [0, 1, 0, -1, 0, 0, 0, 0, 1]); // rWorld = Rz90·I, then F-conj
  });

  it('composes R_world = R_bone·R_align', () => {
    // bone identity, align = Ry(90). rWorld = Ry90; F-conjugation leaves Ry
    // unchanged (no row-1/col-1 off-diagonals).
    const align: PartAlign = ['p.dat', 0, 0, 0, HALF_PI, 0, 1, 0];
    const p = composeLxfPlacement(I, [0, 0, 0], align);
    expectMat(p.rot, [0, 0, 1, 0, 1, 0, -1, 0, 0]);
  });
});
