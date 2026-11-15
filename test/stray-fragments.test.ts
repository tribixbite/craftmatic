/**
 * A-08 (audit 2026-11-15, VIEW-02 / PROC-19): loose pieces lying more than 8 studs clear of the model - the
 * alternate build's parts beside 77092's Deku tree, accessory rows, 76457's wand sprues - are left out of a pack and
 * named in a report line; a substantial sub-build (30 parts or more) and every figure (`groupFigures`)
 * stay, wherever they stand.
 */
import { describe, expect, it } from 'vitest';
import { findStrayFragments, STRAY_CLEARANCE_LDU, STRAY_MAX_PARTS } from '../web/src/engine/stray-fragments.js';

type Box = { min: [number, number, number]; max: [number, number, number] };
/** A 1 x 1 brick's box (20 x 24 x 20 LDU) with its corner at (x, y, z). */
const cube = (x: number, y = 0, z = 0): Box => ({ min: [x, y, z], max: [x + 20, y + 24, z + 20] });
/** A connected row of `n` bricks starting at x (each touches the next). */
const row = (x: number, n: number, y = 0, z = 0): Box[] => Array.from({ length: n }, (_, i) => cube(x + 20 * i, y, z));

describe('stray-fragments :: loose source pieces far from the model', () => {
  it('drops a small piece more than 8 studs clear and keeps one 8 studs or nearer', () => {
    const model = row(0, 400);                       // the model: 400 connected bricks along x 0..8000
    const near = row(0, 3, 0, 20 + STRAY_CLEARANCE_LDU);     // gap of exactly 8 studs along z: stays
    const far = row(0, 3, 0, -20 - STRAY_CLEARANCE_LDU - 1);  // the other side, just past 8 studs: dropped
    const boxes = [...model, ...near, ...far];
    const result = findStrayFragments(boxes, boxes.map(() => false));
    expect(result.dropped.map(g => g.indices.length)).toEqual([3]);
    expect(result.dropped[0]!.indices).toEqual([403, 404, 405]);
    expect(result.dropped[0]!.clearanceLdu).toBeCloseTo(STRAY_CLEARANCE_LDU + 1, 5);
  });

  it('drops a row of loose pieces each beside the next but all far from the model (77092 alternate build)', () => {
    const model = row(0, 400);
    // Ten 3-brick pieces 2 studs apart, the first 9 studs from the model: none touches the model's 8-stud reach.
    const field = Array.from({ length: 10 }, (_, k) => row(0, 3, 0, 20 + 180 + k * (20 + 40))).flat();
    const boxes = [...model, ...field];
    expect(findStrayFragments(boxes, boxes.map(() => false)).dropped).toHaveLength(10);
  });

  it(`keeps a sub-build of ${STRAY_MAX_PARTS} parts however far it stands, and drops one of ${STRAY_MAX_PARTS - 1}`, () => {
    const model = row(0, 400);
    const big = row(0, STRAY_MAX_PARTS, 0, 2000);
    const small = row(0, STRAY_MAX_PARTS - 1, 0, 4000);
    const boxes = [...model, ...big, ...small];
    const result = findStrayFragments(boxes, boxes.map(() => false));
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.indices[0]).toBe(400 + STRAY_MAX_PARTS);
  });

  it('keeps a figure line-up standing on no part: figure placements always stay', () => {
    const model = row(0, 400);
    const figure = row(0, 6, 0, 3000);
    const boxes = [...model, ...figure];
    const member = boxes.map((_, i) => i >= 400);
    expect(findStrayFragments(boxes, member).dropped).toEqual([]);
  });

  it('judges what only TOUCHES a far figure as the loose piece it is once the figure walks off (76457 wand sprues)', () => {
    const model = row(0, 400);
    const figure = row(0, 6, 0, 3000);
    const sprue = [cube(120, 0, 3000)];          // touching the figure row's end, 150 studs from the model
    const boxes = [...model, ...figure, ...sprue];
    const member = boxes.map((_, i) => i >= 400 && i < 406);
    expect(findStrayFragments(boxes, member).dropped.map(d => d.indices)).toEqual([[406]]);
  });

  it('drops nothing from a model that has no main body (every piece under the sub-build size)', () => {
    const boxes = [...row(0, 10), ...row(0, 10, 0, 5000)];
    expect(findStrayFragments(boxes, boxes.map(() => false)).dropped).toEqual([]);
  });
});

