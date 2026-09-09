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
  composeLxfMeasured,
  FRAME_SIGN,
  type PartAlign,
  type MeasuredAlign,
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

describe('FRAME_SIGN — the LDD→LDraw change of basis', () => {
  it('is PROPER (det = +1): diag(1,-1,1) mirrors the model', () => {
    // Both libraries are right-handed, so the map between Y-up and Y-down is a
    // 180° rotation about X, not a Y reflection. diag(1,-1,1) has det = -1 and
    // shipped until 2026-09-09; it put every chiral part in the wrong slot and
    // measured 7.15 % geometric agreement against authentic Studio truth where
    // diag(1,-1,-1) plus the measured table reaches 72.70 %.
    const [sx, sy, sz] = FRAME_SIGN;
    expect(sx * sy * sz).toBe(1);
    expect([sx, sy, sz]).toEqual([1, -1, -1]);
  });
});

describe('composeLxfPlacement — LDD bone × ldraw.xml align → LDraw placement', () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const RZ90 = [0, -1, 0, 1, 0, 0, 0, 0, 1]; // row-major

  it('converts a pure translation (Y and Z flipped, ×25), no align', () => {
    const p = composeLxfPlacement(I, [1, 2, 3], undefined);
    expectMat(p.rot, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(p.x).toBeCloseTo(25);   //  1 cm × 25
    expect(p.y).toBeCloseTo(-50);  // -2 cm × 25 (Y flipped)
    expect(p.z).toBeCloseTo(-75);  // -3 cm × 25 (Z flipped too — det(F) = +1)
  });

  it('F-conjugates the rotation (Rz(90) in LDD → Rz(-90) in LDraw)', () => {
    // The Z row/column carries no off-diagonal here, so this case is identical
    // under either F — which is exactly why the mirror was invisible for years.
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

  it('composes R_world = R_bone·R_align, conjugated by the PROPER F', () => {
    // bone identity, align = Ry(90) = [0,0,1, 0,1,0, -1,0,0]. Conjugating by
    // diag(1,-1,-1) scales entry (i,j) by s_i·s_j, so the two Z off-diagonals
    // flip sign: Ry(90) becomes Ry(-90). Under the old det=-1 F they did NOT,
    // which is the mirror.
    const align: PartAlign = ['p.dat', 0, 0, 0, HALF_PI, 0, 1, 0];
    const p = composeLxfPlacement(I, [0, 0, 0], align);
    expectMat(p.rot, [0, 0, -1, 0, 1, 0, 1, 0, 0]);
  });
});

describe('composeLxfMeasured — post-flip measured correction', () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const RZ90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  /** D = identity, e = (0,0,0): the flip and ×25 only. */
  const NOOP: MeasuredAlign = ['p.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 9];

  it('with an identity correction it is just the change of basis + ×25', () => {
    const p = composeLxfMeasured(I, [1, 2, 3], NOOP);
    expectMat(p.rot, I);
    expect(p.x).toBeCloseTo(25);
    expect(p.y).toBeCloseTo(-50);
    expect(p.z).toBeCloseTo(-75);
  });

  it('adds e in the FLIPPED frame, rotated by the flipped bone (already LDU)', () => {
    // e = (10, -24, 0) is 3001's real measured correction. Bone at identity, so
    // R_ldr = I and the offset lands unrotated and unscaled.
    const m: MeasuredAlign = ['3001.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 10, -24, 0, 506];
    const p = composeLxfMeasured(I, [0, 0, 0], m);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(-24);
    expect(p.z).toBeCloseTo(0);
  });

  it('rotates e by F·R_bone·F, not by R_bone', () => {
    // F·Rz90·F = [0,1,0, -1,0,0, 0,0,1] (see above). Applied to e=(10,0,0) that
    // gives (0,-10,0) — the Y component is negative, which is what distinguishes
    // the flipped frame from the raw LDD one.
    const m: MeasuredAlign = ['p.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0, 9];
    const p = composeLxfMeasured(RZ90, [0, 0, 0], m);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-10);
    expect(p.z).toBeCloseTo(0);
  });

  it('right-multiplies D onto the flipped bone rotation', () => {
    // D = Rz(90) row-major; bone identity → rot = I·D = D verbatim (the table's
    // D is ALREADY in the LDraw basis, so it is not conjugated again).
    const m: MeasuredAlign = ['p.dat', 0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 9];
    expectMat(composeLxfMeasured(I, [0, 0, 0], m).rot, [0, -1, 0, 1, 0, 0, 0, 0, 1]);
  });
});
