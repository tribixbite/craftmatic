/**
 * PROC-20 (2026-11-24): 11388 Venetian Neighborhood was placed HANGING 6 blocks over the ground. Its source draws two
 * flexible axles (LDD 32235, 36-bone arches) as straight rigid axles at their first bone, 220 LDU below the base, and
 * the export grounds a model on its lowest drawn part. Child play passed every size but 400 % (where only a doorway
 * line fell through), so nothing said "this model floats". `groundedVerdict` reads the placed model's drawn footprint
 * per height band: a model whose broad base starts well over the ground while next to nothing reaches the ground is
 * hanging on thin parts.
 */
import { describe, expect, it } from 'vitest';
import { groundedVerdict } from '../web/src/sim/adapters/craftmatic/child-play.js';
import type { DrawnBox } from '../web/src/sim/adapters/craftmatic/drawn.js';

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): DrawnBox => ({ box: { x0, y0, z0, x1, y1, z1 }, glass: false });

describe('sim child play: the placed model stands on the ground (model-grounded, PROC-20)', () => {
  it('a house on its base plate is grounded', () => {
    const v = groundedVerdict([box(0, 0, 0, 16, 0.4, 16), box(1, 0.4, 1, 15, 8, 15)], 0, 1);
    expect(v.hanging).toBe(false);
    expect(v.hangBlocks).toBeCloseTo(0, 1);
  });

  it('a model whose base starts 6 blocks up on two thin poles hangs (11388)', () => {
    const v = groundedVerdict([box(0, 6, 0, 30, 6.4, 15), box(2, 6.4, 2, 28, 14, 13), box(10, 0.3, 5, 10.25, 6, 5.25), box(20, 0.3, 9, 20.25, 6, 9.25)], 0, 1);
    expect(v.hanging).toBe(true);
    expect(v.hangBlocks).toBeCloseTo(6, 0);
    expect(v.groundShare).toBeLessThan(0.01);
  });

  it('a base 2.8 blocks up on one thin pole hangs (11377, Pixel round 24a: the 2-block whole-band rule passed it)', () => {
    const v = groundedVerdict([box(0, 2.81, 0, 29, 3.2, 18), box(1, 3.2, 1, 28, 20, 17), box(14, 0, 9, 14.2, 2.81, 9.2)], 0, 1);
    expect(v.hanging).toBe(true);
    expect(v.hangBlocks).toBeGreaterThan(2.5);
    expect(v.hangBlocks).toBeLessThanOrEqual(2.81);
  });

  it('scales with the placement size: the same model at 400 percent hangs 24 blocks', () => {
    const s = 4;
    const v = groundedVerdict([box(0, 6 * s, 0, 30 * s, 6.4 * s, 15 * s), box(10 * s, 0.3 * s, 5 * s, 10.25 * s, 6 * s, 5.25 * s)], 0, s);
    expect(v.hanging).toBe(true);
    expect(v.hangBlocks).toBeCloseTo(24, 0);
  });

  it('a car on its wheels and a tree house on its trunk stand on the ground', () => {
    const car = groundedVerdict([box(0, 0.4, 0, 2, 1.5, 5), ...[[0, 0.5], [0, 4], [1.7, 0.5], [1.7, 4]].map(([x, z]) => box(x!, 0, z!, x! + 0.3, 0.6, z! + 0.6))], 0, 1);
    expect(car.hanging).toBe(false);
    const treeHouse = groundedVerdict([box(3, 0, 3, 5, 6, 5), box(0, 6, 0, 8, 7, 8), box(1, 7, 1, 7, 10, 7)], 0, 1);
    expect(treeHouse.hanging).toBe(false);
  });

  it('a model with nothing drawn is not judged', () => {
    expect(groundedVerdict([], 0, 1).hanging).toBe(false);
  });
});
