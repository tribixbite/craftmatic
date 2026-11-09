/**
 * Our own figure, second design pass (BIZ-21, WP-F01b): the candidates in
 * `FIGURE_CANDIDATES.f01b` clear the F01 distinctness gate (test/figure-brickling.test.ts
 * runs it over every pass) AND the bar F01's candidates missed: limbs attached
 * to the torso (studs, side studs, Technic pin hinges), a face of round plates
 * on the head's front, a body at player width, every part a CC BY official
 * generic brick.
 *
 * Needs an LDraw library on disk (clego's `ldraw_ref/`, CRAFTMATIC_LDRAW_REF).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DISTINCTNESS_GATE, FIGURE_CANDIDATES, LIMB_GROUPS, PLAYER_HEIGHT_BLOCKS, compatibilityProblems, draftCanon, faceEyes,
  figurePlacements, flattenFigure, limbAttachmentGaps, measureDistinctness, minifigReferenceLdr, partLicences,
  passesDistinctness, silhouetteIou, silhouetteOf, type FigTri, type FigureGroup, type PartResolver,
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

/** The brief's limits at player scale (the figure stands PLAYER_HEIGHT_BLOCKS tall). */
const MAX_BODY_WIDTH_BLOCKS = 0.7;
const MAX_TOTAL_WIDTH_BLOCKS = 1.2;

describe.skipIf(!HAS_LIBRARY)('figure-brickling F01b: the second-pass candidates are attached, faced and player-sized', () => {
  const ldrOf = (stem: string): string => readFileSync(join(FIXTURES, `${stem}.ldr`), 'utf8');
  const load = (stem: string): FigTri[] => flattenFigure(ldrOf(stem), resolver);
  const minifig = (): FigTri[] => flattenFigure(minifigReferenceLdr(), resolver);

  for (const stem of FIGURE_CANDIDATES.f01b) {
    describe(stem, () => {
      it('clears the whole distinctness gate (both IoUs, both ratios, the height band)', () => {
        const d = measureDistinctness(load(stem), minifig());
        expect(d.frontGate).toBeLessThan(DISTINCTNESS_GATE.maxIou);
        expect(d.sideGate).toBeLessThan(DISTINCTNESS_GATE.maxIou);
        expect(d.headRatioDifference).toBeGreaterThanOrEqual(DISTINCTNESS_GATE.minRatioDifference);
        expect(d.shoulderRatioDifference).toBeGreaterThanOrEqual(DISTINCTNESS_GATE.minRatioDifference);
        expect(passesDistinctness(d)).toBe(true);
      });

      it('every limb box touches the torso box (arms on pins or side studs, legs on studs; F01 floated its arms)', () => {
        const gaps = limbAttachmentGaps(load(stem));
        for (const limb of LIMB_GROUPS) expect(gaps[limb], limb).toBeLessThanOrEqual(0.5);
      });

      it('has a face: at least two round-plate eyes seated on the front of the head, left and right', () => {
        const eyes = faceEyes(ldrOf(stem));
        expect(eyes.length).toBeGreaterThanOrEqual(2);
        const xs = eyes.map(e => e.position[0]);
        expect(Math.min(...xs)).toBeLessThan(0);
        expect(Math.max(...xs)).toBeGreaterThan(0);
      });

      it('is player-sized: body at most 0.7 block wide and 1.2 blocks over the arms when 1.8 blocks tall', () => {
        const c = draftCanon(load(stem));
        const blocksPerLdu = PLAYER_HEIGHT_BLOCKS / c.heightLdu;
        expect(c.bodyWidthLdu * blocksPerLdu).toBeLessThanOrEqual(MAX_BODY_WIDTH_BLOCKS);
        expect(c.widthLdu * blocksPerLdu).toBeLessThanOrEqual(MAX_TOTAL_WIDTH_BLOCKS);
      });

      it('every part is an official CC BY generic part: no minifigure or mini-doll mould', () => {
        const licences = partLicences(ldrOf(stem), resolver);
        expect(licences.size).toBeGreaterThan(5);
        for (const [part, licence] of licences) {
          expect(licence, part).toMatch(/CC BY/);
          const description = (resolver(part) ?? '').split(/\r?\n/)[0] ?? '';
          expect(description, part).not.toMatch(/minifig|mini-?doll|torso|hips|\bhead\b|\bleg\b|\barm\b|\bhand\b|figure/i);
        }
      });

      it('has the six rig groups, and nothing but joint hardware untagged', () => {
        const groups = new Set(figurePlacements(ldrOf(stem)).map(q => q.group));
        const rigGroups: FigureGroup[] = ['head', 'torso', ...LIMB_GROUPS];
        for (const g of rigGroups) expect(groups.has(g), g).toBe(true);
        const other = figurePlacements(ldrOf(stem)).filter(q => q.group === 'other');
        for (const q of other) expect(q.part, 'untagged part').toMatch(/^(2780|3673)\.dat$/); // Technic pins only
        expect(compatibilityProblems(load(stem))).toEqual([]);
      });
    });
  }

  it('the F01b candidates differ from each other and from the F01 ones (front IoU below 0.8 for every pair)', () => {
    const all = [...FIGURE_CANDIDATES.f01, ...FIGURE_CANDIDATES.f01b];
    const figs = all.map(load);
    for (let i = 0; i < figs.length; i++) for (let j = i + 1; j < figs.length; j++) {
      expect(silhouetteIou(silhouetteOf(figs[i]!, 'front'), silhouetteOf(figs[j]!, 'front')), `${all[i]} vs ${all[j]}`).toBeLessThan(0.8);
    }
  });
});
