/**
 * A07 (BIZ-05): roof grammars. A massing volume's `RoofSpec` becomes `roof-slope` cells the X-10 bricker turns into
 * real slope parts (not a stepped hip of bricks), in the descent direction the slope picker expects, and every
 * result must still pass X-09 with one component.
 */
import { describe, expect, it } from 'vitest';
import { brickLattice } from '../web/src/brickgen/bricker/index.js';
import { buildGrammarLattice } from '../web/src/brickgen/grammar/index.js';
import type { FeatureSet, IntentLattice, Massing, MassVolume, RoofSpec, Vec2m } from '../web/src/brickgen/types.js';
import { isClean } from '../web/src/brickgen/verify/index.js';
import { placeAll, VOCABULARY_LOOKUP } from '../web/src/brickgen/verify/world.js';
import { slopeDirOf } from '../web/src/brickgen/bricker/index.js';
import { elementFor } from '../web/src/brickgen/vocab/index.js';
import type { BrickPlan } from '../web/src/brickgen/types.js';

const NO_FEATURES: FeatureSet = { features: [], style: { wallColour: 71, trimColour: 71, roofColour: 72, accentColours: [] } };
const rect = (x0: number, z0: number, x1: number, z1: number): Vec2m[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** One volume on the ground at 1 stud per metre (2.5 plates per metre). */
function massingOf(volumes: MassVolume[]): Massing {
  let w = 0, d = 0, h = 0;
  for (const v of volumes) { for (const [x, z] of v.outer) { w = Math.max(w, x); d = Math.max(d, z); } h = Math.max(h, v.topM + 30); }
  return { volumes, scale: { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'test' }, boundsM: [[0, 0, 0], [w, h, d]] };
}
const volume = (id: string, outer: Vec2m[], topM: number, roof: RoofSpec, role: MassVolume['role'] = 'body'): MassVolume =>
  ({ id, outer, holes: [], baseM: 0, topM, roof, role });

const SLOPE_PARTS = new Set(['3040b.dat', '3039.dat', '3038.dat', '3037.dat', '3298.dat', '3297.dat', '4286.dat', '11477.dat', '85984.dat', '15068.dat']);

/** Grammar -> bricker, the whole path a roof takes. */
function build(volumes: MassVolume[]): { lattice: IntentLattice; plan: BrickPlan; clean: boolean; pad: number } {
  const { lattice, frame } = buildGrammarLattice(massingOf(volumes), NO_FEATURES);
  const r = brickLattice(lattice);
  return { lattice, plan: r.plan, clean: isClean(r.report), pad: frame.pad };
}

/** Slope elements with the cell-space centre of their body and the direction their roof descends. */
function slopes(plan: BrickPlan): Array<{ part: string; cx: number; cz: number; dir: number; top: number }> {
  const { world } = placeAll(plan.elements, VOCABULARY_LOOKUP);
  return world.filter(w => SLOPE_PARTS.has(w.placed.part)).map(w => {
    let sx = 0, sz = 0, top = 0;
    for (const [x, p, z] of w.body) { sx += x + 0.5; sz += z + 0.5; top = Math.max(top, p); }
    return { part: w.placed.part, cx: sx / w.body.length, cz: sz / w.body.length, dir: slopeDirOf(elementFor(w.placed.part)!, w.placed.turn)!, top };
  });
}

/** Highest filled plate layer of the column holding cell `(x, z)`. */
function columnTop(l: IntentLattice, x: number, z: number): number {
  const [W, H, D] = l.dims;
  for (let p = H - 1; p >= 0; p--) if (l.cells[(p * D + z) * W + x]) return p;
  return -1;
}

describe('brickgen-grammar-roof gabled', () => {
  const walls = 6; // metres of wall under the roof
  const { lattice, plan, clean, pad } = build([volume('a', rect(0, 0, 10, 24), walls, { shape: 'gabled', pitchDeg: 45, ridgeAxis: 'long' })]);

  it('a gabled roof over a 10-stud span at 45 degrees uses slope elements on both faces and closes at the ridge', () => {
    const s = slopes(plan);
    const west = s.filter(e => e.cx - pad < 5), east = s.filter(e => e.cx - pad > 5);
    expect(west.length).toBeGreaterThanOrEqual(4);
    expect(east.length).toBeGreaterThanOrEqual(4);
    // Slopes face outward: the west face descends towards -x (dir 1), the east face towards +x (dir 0).
    expect(west.every(e => e.dir === 1)).toBe(true);
    expect(east.every(e => e.dir === 0)).toBe(true);
    // Closes at the ridge: the two centre columns are the highest, level with each other, and the roof falls away from them.
    const mid = (x: number): number => columnTop(lattice, pad + x, pad + 12);
    expect(mid(4)).toBe(mid(5));
    for (let x = 0; x < 4; x++) expect(mid(x)).toBeLessThanOrEqual(mid(x + 1));
    for (let x = 6; x < 10; x++) expect(mid(x)).toBeLessThanOrEqual(mid(x - 1));
    expect(mid(0)).toBeLessThan(mid(4) - 6);
  });

  it('rises at the pitch the massing asked for (45 degrees: 5 studs of half span = 12.5 plates, within a brick)', () => {
    // Roof base = the ceiling's top: 6 m of wall is 15 plates over the 2-plate base plate.
    const apex = columnTop(lattice, pad + 4, pad + 12) + 1 - (15 + 2);
    expect(Math.abs(apex - 12.5)).toBeLessThanOrEqual(3);
  });

  it('verifies as one clean component', () => { expect(clean).toBe(true); });
});
