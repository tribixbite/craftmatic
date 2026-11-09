/**
 * Our own figure, design study (BIZ-21, WP-F01): the three candidate figures in
 * test/fixtures/figures/*.ldr are built only from generic official parts and are
 * measurably not a minifigure (silhouette IoU below 0.6 in front and side view,
 * head/height and shoulder/height ratios differing by at least 25 %), and each
 * has the separable body groups a walk, sit and ride rig needs.
 *
 * Needs an LDraw library on disk (clego's `ldraw_ref/`, CRAFTMATIC_LDRAW_REF), so
 * the suite is gated on its presence at module load, like the other part-reading
 * suites; those numbers are evidence for the lawyer, not proof.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DISTINCTNESS_GATE, bestShiftIou, compatibilityProblems, draftCanon, figureHeight, flattenFigure, measureDistinctness,
  minifigReferenceLdr, passesDistinctness, silhouetteIou, silhouetteOf, type FigTri, type PartResolver,
} from '../web/src/engine/figure-brickling.js';

const REF = process.env.CRAFTMATIC_LDRAW_REF ?? 'C:/git/clego/ldraw_ref';
const HAS_LIBRARY = existsSync(join(REF, 'official', 'parts', '3062b.dat'));
const FIXTURES = resolve(__dirname, 'fixtures/figures');

/** Parts from the official library's parts/ and p/ folders. */
const resolver: PartResolver = name => {
  for (const dir of ['parts', 'p']) {
    const f = join(REF, 'official', dir, name);
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  return null;
};

/** The candidate names, read from the fixture folder (no library needed). */
const STEMS = readdirSync(FIXTURES).filter(f => f.endsWith('.ldr')).map(f => f.replace(/\.ldr$/, '')).sort();

describe.skipIf(!HAS_LIBRARY)('figure-brickling: the candidate figures are not minifigures', () => {
  // Loaded lazily inside the first test that needs them (a skipped describe still runs its body).
  const load = (stem: string): FigTri[] => flattenFigure(readFileSync(join(FIXTURES, `${stem}.ldr`), 'utf8'), resolver);
  const minifig = (): FigTri[] => flattenFigure(minifigReferenceLdr(), resolver);

  it('there are three candidates', () => {
    expect(STEMS).toEqual(['bell', 'pebble', 'toadstool']);
  });

  for (const stem of STEMS) {
    describe(stem, () => {
      it("the candidate's normalised front silhouette IoU against the minifig composite is below 0.6", () => {
        const d = measureDistinctness(load(stem), minifig());
        // The gate value is the larger of the centred and the best-shift IoU, so sliding the outlines cannot hide an overlap.
        expect(d.frontGate).toBeLessThan(DISTINCTNESS_GATE.maxIou);
      });

      it("the candidate's normalised side silhouette IoU against the minifig composite is below 0.6", () => {
        const d = measureDistinctness(load(stem), minifig());
        expect(d.sideGate).toBeLessThan(DISTINCTNESS_GATE.maxIou);
      });

      it('head/height and shoulder/height ratios differ from the minifig by at least 25 percent', () => {
        const d = measureDistinctness(load(stem), minifig());
        expect(d.headRatioDifference).toBeGreaterThanOrEqual(DISTINCTNESS_GATE.minRatioDifference);
        expect(d.shoulderRatioDifference).toBeGreaterThanOrEqual(DISTINCTNESS_GATE.minRatioDifference);
        expect(passesDistinctness(d)).toBe(true);
      });

      it('stands 120 to 140 LDU tall (a minifig is about 96)', () => {
        const h = figureHeight(load(stem));
        expect(h).toBeGreaterThanOrEqual(120);
        expect(h).toBeLessThanOrEqual(140);
      });

      it('uses no minifigure or mini-doll mould: every part is a generic brick, plate, cone or dish', () => {
        const names = new Set([...readFileSync(join(FIXTURES, `${stem}.ldr`), 'utf8').matchAll(/^1(?:\s+\S+){13}\s+(\S+\.dat)\s*$/gm)].map(m => m[1]!));
        expect(names.size).toBeGreaterThan(3);
        for (const name of names) {
          const description = (resolver(name) ?? '').split(/\r?\n/)[0] ?? '';
          expect(description, name).toMatch(/^0\s+\S/); // the part exists
          expect(description, name).not.toMatch(/minifig|mini-?doll|torso|hips|\bhead\b|\bleg\b|\barm\b|\bhand\b|figure/i);
        }
      });

      it('has the separable body groups a walk, seat and ride rig needs', () => {
        expect(compatibilityProblems(load(stem))).toEqual([]);
        const c = draftCanon(load(stem));
        expect(c.hipHeightLdu).toBeGreaterThanOrEqual(32); // legs long enough to sit and to gait
        expect(c.neck[1]).toBeLessThan(c.hipRight[1]); // the neck is above the hips (LDraw Y is down)
        expect(c.shoulderRight[0]).toBeLessThan(c.shoulderLeft[0]); // right is -X, as the minifig rig has it
      });
    });
  }

  it('the metric reads a minifig as identical to itself (control: the gate would fail it)', () => {
    const m = minifig();
    const d = measureDistinctness(m, m);
    expect(d.frontIou).toBeCloseTo(1, 5);
    expect(d.sideIou).toBeCloseTo(1, 5);
    expect(passesDistinctness(d)).toBe(false);
  });

  it('the metric normalises height: a minifig drawn 40 percent larger still scores 1', () => {
    const m = minifig();
    const big = m.map(t => ({ ...t, a: t.a.map(v => v * 1.4) as FigTri['a'], b: t.b.map(v => v * 1.4) as FigTri['b'], c: t.c.map(v => v * 1.4) as FigTri['c'] }));
    const f = silhouetteIou(silhouetteOf(m, 'front'), silhouetteOf(big, 'front'));
    expect(f).toBeGreaterThan(0.99);
  });

  it('the best-shift IoU is never below the centred IoU', () => {
    const m = minifig();
    const c = load(STEMS[0]!);
    const a = silhouetteOf(c, 'front'), b = silhouetteOf(m, 'front');
    expect(bestShiftIou(a, b)).toBeGreaterThanOrEqual(silhouetteIou(a, b));
  });

  it('the candidates differ from each other (front IoU below 0.8 for every pair)', () => {
    const figs = STEMS.map(load);
    for (let i = 0; i < figs.length; i++) for (let j = i + 1; j < figs.length; j++) {
      expect(silhouetteIou(silhouetteOf(figs[i]!, 'front'), silhouetteOf(figs[j]!, 'front')), `${STEMS[i]} vs ${STEMS[j]}`).toBeLessThan(0.8);
    }
  });

  it('a part missing from the library is an error, not a thinner figure', () => {
    expect(() => flattenFigure('1 16 0 0 0 1 0 0 0 1 0 0 0 1 no-such-part.dat', resolver)).toThrow(/not in the library/);
  });
});
