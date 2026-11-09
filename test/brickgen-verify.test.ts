/**
 * X-09 (BIZ-08): the lattice verifier.
 *
 * Three kinds of evidence: synthetic plans that pin each rule, real LDraw
 * models read back onto the lattice (two committed OMR files and, when clego's
 * corpus is on disk, a handful more) that must come out clean, and
 * deliberately broken copies of those same models that must not.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeLdraw } from '../web/src/brickgen/emit/ldraw-writer.js';
import type { BrickPlan, PlacedElement } from '../web/src/brickgen/types.js';
import { crossCheckConnectivity } from '../web/src/brickgen/verify/crosscheck.js';
import { importBricks, libraryImport, VOCABULARY_IMPORT } from '../web/src/brickgen/verify/ldraw-import.js';
import { DEFAULT_CANTILEVER_LIMITS, isClean, verifyPlan, verifyPlanDetailed, type VerifyOptions } from '../web/src/brickgen/verify/index.js';
import { turnedCell, VOCABULARY_LOOKUP } from '../web/src/brickgen/verify/world.js';
import { elementFor } from '../web/src/brickgen/vocab/index.js';
import { SHELL_FRAME } from '../web/src/engine/bedrock-building-shell.js';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { resolvePartGeometry } from '../web/src/viewer/ldraw/parts.js';
import { GOLDENS, fixtureSource } from './helpers/brickgen-goldens.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCALE = { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'test' };
const el = (part: string, at: [number, number, number], turn: 0 | 1 | 2 | 3 = 0, colour = 4, group = 'g'): PlacedElement => ({ part, colour, at, turn, group });
const plan = (elements: PlacedElement[]): BrickPlan => ({ elements, groups: [{ id: 'g', label: 'G' }], scale: SCALE, metas: [] });

/** A 6x2 base plate carrying two 1x1 brick towers three studs apart (x = 0 and x = 3): their studs are at plate 4. */
const TOWERS = [el('3795.dat', [0, 0, 0]), el('3005.dat', [0, 1, 0]), el('3005.dat', [3, 1, 0])];

/** Remove every element whose body spans plate layer `layer`: the model is cut across that layer. */
function cutAcross(elements: readonly PlacedElement[], layer: number, heightOf: (part: string) => number): PlacedElement[] {
  return elements.filter(e => !(e.at[1] <= layer && layer < e.at[1] + heightOf(e.part)));
}
const vocabHeight = (part: string): number => elementFor(part)!.heightPlates;

describe('brickgen-verify', () => {
  it('a 1x4 plate bridging two towers by one stud each is connected; the same plate one plate higher is two components', () => {
    const bridged = verifyPlan(plan([...TOWERS, el('3710.dat', [0, 4, 0])]));
    expect(bridged.components).toBe(1);
    expect(bridged.unsupported).toBe(0);
    const floating = verifyPlan(plan([...TOWERS, el('3710.dat', [0, 5, 0])]));
    expect(floating.components).toBe(2);
    expect(floating.largestPct).toBeCloseTo(75, 5);
    expect(floating.unsupported).toBe(1);
  });

  it('a quarter turn does not change what is connected: the bridge turned about any corner is still one piece', () => {
    // Turn the whole design: x/z are swapped or mirrored by the same matrix the writer uses.
    const turnAll = (t: 0 | 1 | 2 | 3): PlacedElement[] => [
      el('3795.dat', t % 2 ? [0, 0, 0] : [0, 0, 0], t),
      ...[[0, 1, 0], [3, 1, 0]].map(([x, y, z]) => el('3005.dat', [x! * (t === 0 ? 1 : 0), y!, x! * (t === 0 ? 0 : 1)], 0)),
      el('3710.dat', [0, 4, 0], t),
    ];
    // 3795 turned covers 2 in x and 6 in z, so the towers move to z = 0 and z = 3 for odd turns.
    for (const t of [0, 1, 3] as const) expect(verifyPlan(plan(turnAll(t))).components).toBe(1);
  });

  it('turnedCell agrees with the writer for a 2x4 brick: 90 degrees swaps the extents', () => {
    const cells = (turn: 0 | 1 | 2 | 3): string[] => {
      const out: string[] = [];
      for (let lx = 0; lx < 4; lx++) for (let lz = 0; lz < 2; lz++) out.push(turnedCell(turn, 4, 2, lx, lz).join(','));
      return out;
    };
    for (const t of [0, 1, 2, 3] as const) {
      const c = cells(t).map(s => s.split(',').map(Number) as [number, number]);
      expect(new Set(cells(t)).size).toBe(8);
      const xs = c.map(p => p[0]), zs = c.map(p => p[1]);
      expect([Math.min(...xs), Math.min(...zs)]).toEqual([0, 0]);
      expect([Math.max(...xs) + 1, Math.max(...zs) + 1]).toEqual(t % 2 ? [2, 4] : [4, 2]);
    }
  });

  describe('stability', () => {
    it('a 1x8 plate held by one stud overhangs 7 studs and is a cantilever violation; a 1x4 held the same way is not', () => {
      const base = [el('3795.dat', [0, 0, 0]), el('3005.dat', [0, 1, 0])];
      const long = verifyPlanDetailed(plan([...base, el('3460.dat', [0, 4, 0])]));
      expect(long.report.cantileverViolations).toEqual([{ group: 'g', studs: 7 }]);
      expect(long.detail.stability.cantilevers[0]).toMatchObject({ part: '3460.dat', limit: DEFAULT_CANTILEVER_LIMITS.plate });
      expect(verifyPlan(plan([...base, el('3710.dat', [0, 4, 0])])).cantileverViolations).toEqual([]);
    });

    it('anchoring at both ends brings the overhang under the limit', () => {
      const bridge = verifyPlan(plan([el('3795.dat', [0, 0, 0]), el('3005.dat', [0, 1, 0]), el('3005.dat', [5, 1, 0]), el('3460.dat', [0, 4, 0])]));
      expect(bridge.cantileverViolations).toEqual([]);
    });

    it('a slope or arch overhang counts as supported by its own occupancy', () => {
      const base = [el('3795.dat', [0, 0, 0]), el('3005.dat', [0, 1, 0])];
      // The 1x4 arch carried by one stud: it would break a plate, and it is exempt as an arch.
      const arch = verifyPlan(plan([...base, el('3659.dat', [0, 4, 0])]));
      expect(arch.cantileverViolations).toEqual([]);
      expect(arch.components).toBe(1);
    });

    it('limits are per class and can be overridden', () => {
      const p = plan([el('3795.dat', [0, 0, 0]), el('3005.dat', [0, 1, 0]), el('3710.dat', [0, 4, 0])]);
      expect(verifyPlan(p).cantileverViolations).toEqual([]);
      const tight: VerifyOptions = { limits: { ...DEFAULT_CANTILEVER_LIMITS, plate: 2 } };
      expect(verifyPlan(p, tight).cantileverViolations).toEqual([{ group: 'g', studs: 3 }]);
    });

    it('a piece held only by clutch from above is reported as hanging, not unsupported', () => {
      // A 1x1 plate hung under a bridge plate that rests on the two towers' tops (the towers are 2 bricks tall here).
      const towers = [el('3795.dat', [0, 0, 0]), el('3005.dat', [0, 1, 0]), el('3005.dat', [3, 1, 0]), el('3005.dat', [0, 4, 0]), el('3005.dat', [3, 4, 0])];
      const bridge = el('3710.dat', [0, 7, 0]);
      const hung = el('3024.dat', [1, 6, 0]); // its stud meets the bridge's anti-stud from below
      const r = verifyPlanDetailed(plan([...towers, bridge, hung]));
      expect(r.report.components).toBe(1);
      expect(r.report.unsupported).toBe(0);
      expect(r.detail.stability.hanging).toEqual([6]);
    });

    it('a ground plane other than plate 0 can be chosen', () => {
      const raised = plan([el('3795.dat', [0, 4, 0]), el('3005.dat', [0, 5, 0])]);
      expect(verifyPlan(raised).unsupported).toBe(2); // nothing stands on plate 0
      expect(verifyPlan(raised, { groundPlate: 4 }).unsupported).toBe(0);
    });
  });

  describe('overlaps and legality', () => {
    it('two bricks in the same cells overlap; a brick and the plate under it do not', () => {
      expect(verifyPlan(plan([el('3001.dat', [0, 0, 0]), el('3001.dat', [0, 1, 0])])).overlaps).toBe(1);
      expect(verifyPlan(plan([el('3001.dat', [0, 0, 0]), el('3001.dat', [0, 0, 0], 2)])).overlaps).toBe(1);
      expect(verifyPlan(plan([el('3020.dat', [0, 0, 0]), el('3001.dat', [0, 1, 0])])).overlaps).toBe(0);
    });

    it('a slope leaves its empty cells free: a plate may sit in a slope\'s lowest cell', () => {
      const slope = elementFor('3040b.dat')!;
      const [fx, fz] = slope.footprint;
      let empty: [number, number] | undefined;
      for (let z = 0; z < fz; z++) for (let x = 0; x < fx; x++) if (slope.occupancy![x + fx * (z + fz * 2)] === 0) empty = [x, z];
      expect(empty, 'a 45 degree slope is empty in its top layer somewhere').toBeDefined();
      const [dx, dz] = turnedCell(0, fx, fz, empty![0], empty![1]);
      expect(verifyPlan(plan([el('3040b.dat', [0, 0, 0]), el('3024.dat', [dx, 2, dz])])).overlaps).toBe(0);
      expect(verifyPlan(plan([el('3040b.dat', [0, 0, 0]), el('3024.dat', [dx, 0, dz])])).overlaps).toBe(1);
    });

    it('parts outside the vocabulary, bl_ copies and logo studs are illegal; legal parts list nothing', () => {
      const r = verifyPlan(plan([el('3001.dat', [0, 0, 0]), el('99999.dat', [0, 3, 0]), el('bl_3001.dat', [4, 3, 0]), el('3001-logo.dat', [4, 6, 0]), el('3001.dat', [0, 6, 0])]));
      expect(r.illegalParts).toEqual(['3001-logo.dat', '99999.dat', 'bl_3001.dat']);
      expect(r.parts).toBe(5);
      expect(verifyPlan(plan([el('3001.dat', [0, 0, 0])])).illegalParts).toEqual([]);
    });

    it('a part whose licence is not CC BY is illegal even when it is in the vocabulary', () => {
      const lookup: VerifyOptions['lookup'] = part => {
        const v = VOCABULARY_LOOKUP(part);
        return v && part === '3001.dat' ? { ...v, element: { ...v.element, licence: 'All rights reserved' } } : v;
      };
      expect(verifyPlan(plan([el('3001.dat', [0, 0, 0])]), { lookup }).illegalParts).toEqual(['3001.dat']);
    });

    it('every element of the vocabulary passes its own legality check', () => {
      const parts = ['3001.dat', '3040b.dat', '3659.dat', '60592.dat', '3062b.dat'];
      expect(verifyPlan(plan(parts.map((p, i) => el(p, [i * 12, 0, 0])))).illegalParts).toEqual([]);
    });
  });

  describe('goldens built the way a builder would', () => {
    for (const [name, build] of GOLDENS) {
      it(`${name}: one component, nothing unsupported, no overlaps, no cantilever, legal`, () => {
        const r = verifyPlan(build());
        expect(r.components).toBe(1);
        expect(r.largestPct).toBe(100);
        expect(isClean(r), JSON.stringify(r)).toBe(true);
      });
    }

    it('the box house without its floor bridging layer falls into pieces: the verifier sees the seams', () => {
      const house = GOLDENS[0]![1]();
      const cut = { ...house, elements: house.elements.filter(e => !(e.group === 'base' && e.at[1] === 1)) };
      const r = verifyPlan(cut);
      expect(r.components).toBeGreaterThan(1);
    });
  });

  describe('real LDraw models read back onto the lattice', () => {
    const load = (file: string) => {
      const imp = importBricks(parseLDraw(readFileSync(path.join(HERE, 'fixtures', file), 'utf8')), VOCABULARY_IMPORT);
      return imp;
    };

    for (const [file, label] of [['omr-1869-1-flag.mpd', 'South African flag (OMR 1869-1)'], ['omr-566-1-elephant.mpd', 'elephant (OMR 566-1)']] as const) {
      it(`${label} is one connected component with a load path for every brick`, () => {
        const imp = load(file);
        expect(imp.offLattice).toEqual([]);
        const { report, detail } = verifyPlanDetailed(imp.plan);
        expect(report.parts).toBeGreaterThan(30);
        expect(report.components, JSON.stringify(report)).toBe(1);
        expect(report.unsupported).toBe(0);
        expect(report.overlaps).toBe(0);
        expect(report.illegalParts).toEqual([]);
        expect(detail.stability.cantilevers).toEqual([]);
      });
    }

    it('lifting everything above the third brick layer by one plate tears the flag in two', () => {
      const imp = load('omr-1869-1-flag.mpd');
      const base = verifyPlan(imp.plan);
      expect(base.components).toBe(1);
      const ys = [...new Set(imp.plan.elements.map(e => e.at[1]))].sort((a, b) => a - b);
      expect(ys.length).toBeGreaterThan(3);
      const cut = ys[2]!;
      const lifted = imp.plan.elements.map(e => (e.at[1] > cut ? { ...e, at: [e.at[0], e.at[1] + 1, e.at[2]] as [number, number, number] } : e));
      const r = verifyPlan({ ...imp.plan, elements: lifted });
      expect(r.components).toBe(2);
      expect(r.unsupported).toBeGreaterThan(0);
      expect(isClean(r)).toBe(false);
    });

    it('removing a whole course from the elephant cuts it: components and unsupported rise', () => {
      const imp = load('omr-566-1-elephant.mpd');
      const ys = [...new Set(imp.plan.elements.map(e => e.at[1]))].sort((a, b) => a - b);
      const mid = ys[Math.floor(ys.length / 2)]!;
      const r = verifyPlan({ ...imp.plan, elements: cutAcross(imp.plan.elements, mid, vocabHeight) });
      expect(r.components).toBeGreaterThan(1);
      expect(r.unsupported).toBeGreaterThan(0);
    });

    it('a duplicated brick is an overlap; a smuggled part is illegal; a long plate on one stud is a cantilever', () => {
      const imp = load('omr-1869-1-flag.mpd');
      const top = imp.plan.elements.reduce((a, b) => (b.at[1] > a.at[1] ? b : a));
      const dup = verifyPlan({ ...imp.plan, elements: [...imp.plan.elements, { ...top }] });
      expect(dup.overlaps).toBeGreaterThanOrEqual(1);
      const smuggled = verifyPlan({ ...imp.plan, elements: imp.plan.elements.map((e, i) => (i === 0 ? { ...e, part: 'bl_3001.dat' } : e)) });
      expect(smuggled.illegalParts).toEqual(['bl_3001.dat']);
      // A 1x8 plate laid on the highest brick: one stud in contact, seven studs of overhang.
      // ... on the stud with the largest x of the top layer, so its seven other studs hang in the air.
      const edge = verifyPlanDetailed(imp.plan).detail.world.filter(w => w.y0 === top.at[1]).flatMap(w => w.studs).reduce((a, b) => (b[0] > a[0] ? b : a));
      const plate: PlacedElement = { part: '3460.dat', colour: 4, turn: 0, group: 'model', at: [edge[0], edge[1], edge[2]] };
      const r = verifyPlan({ ...imp.plan, elements: [...imp.plan.elements, plate] });
      expect(r.cantileverViolations.length).toBe(1);
      expect(r.cantileverViolations[0]!.studs).toBeGreaterThan(DEFAULT_CANTILEVER_LIMITS.plate);
    });

    it('bricks that are not upright, or off the stud grid, are reported and not snapped', () => {
      const text = ['1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '1 4 10 -24 0 1 0 0 0 1 0 0 0 1 3001.dat', '1 4 0 -24 0 1 0 0 0 0 -1 0 1 0 3001.dat', '1 4 0 -24 0 1 0 0 0 1 0 0 0 1 notapart.dat'].join('\n');
      const imp = importBricks(parseLDraw(text), VOCABULARY_IMPORT);
      expect(imp.plan.elements).toHaveLength(1);
      expect(imp.offLattice.map(o => o.reason)).toEqual(['off the stud/plate grid', 'not upright or not a quarter turn', 'unknown part']);
    });
  });

  describe('corpus models (clego, skipped when it is not on disk)', () => {
    const REF = 'C:/git/clego/ldraw_ref/official';
    const OMR = 'C:/git/clego/lego_sets/OMR';
    const SETS = ['390-2', '395-1', '7796-1', '1869-1', '566-1_Elephant'];
    const present = existsSync(REF) && SETS.every(s => existsSync(`${OMR}/${s}.mpd`));
    const source = (name: string): string | undefined => {
      for (const d of ['parts', 'p']) { const f = `${REF}/${d}/${name}`; if (existsSync(f)) return readFileSync(f, 'utf8'); }
      return undefined;
    };

    it.skipIf(!present)('the hand-built OMR sets read from the real library are one component each, with at least 90 % of their bricks on the lattice', () => {
      const resolve = libraryImport(source);
      for (const set of SETS) {
        const bricks = parseLDraw(readFileSync(`${OMR}/${set}.mpd`, 'utf8'));
        const imp = importBricks(bricks, resolve);
        expect(imp.plan.elements.length / bricks.length, `${set} on-lattice share`).toBeGreaterThanOrEqual(0.9);
        const r = verifyPlan(imp.plan, { lookup: imp.lookup });
        expect(r.components, `${set}: ${JSON.stringify(r)}`).toBe(1);
        expect(r.unsupported, set).toBe(0);
      }
    });

    it.skipIf(!present)('the same sets with a course removed from the middle fail', () => {
      const resolve = libraryImport(source);
      for (const set of SETS) {
        const imp = importBricks(parseLDraw(readFileSync(`${OMR}/${set}.mpd`, 'utf8')), resolve);
        const ys = [...new Set(imp.plan.elements.map(e => e.at[1]))].sort((a, b) => a - b);
        if (ys.length < 5) continue;
        const mid = ys[Math.floor(ys.length / 2)]!;
        const r = verifyPlan({ ...imp.plan, elements: cutAcross(imp.plan.elements, mid, p => imp.lookup(p)!.element.heightPlates) }, { lookup: imp.lookup });
        expect(r.components > 1 || r.unsupported > 0, set).toBe(true);
      }
    });
  });

  describe('budget', () => {
    /** The real compile of a plan: written as .ldr, parsed, compiled as a whole-model shell with the shipped defaults. */
    async function compiledCuboids(p: BrickPlan): Promise<number> {
      const provider = createPartGeometryProvider({ fetchPartText: async id => fixtureSource(`${id}.dat`) ?? null });
      const geo = await compileLdrawEntityGeometry('golden', 'prop', parseLDraw(writeLdraw(p)), { partGeometry: provider, frame: [...SHELL_FRAME], wholeModel: true, quality: 'balanced' });
      return geo.diagnostics.cubeCount;
    }

    for (const [name, build] of GOLDENS) {
      it(`${name}: the estimate is within 15 % of the compiled cuboid count`, async () => {
        const p = build();
        const estimate = verifyPlan(p).budget.cuboidsEstimate;
        const real = await compiledCuboids(p);
        expect(real).toBeGreaterThan(100);
        expect(Math.abs(estimate - real) / real, `estimate ${estimate} vs compiled ${real}`).toBeLessThanOrEqual(0.15);
      }, 60_000);
    }

    it('square-peg studs (studFacets 1) cost a quarter of the stud cuboids', () => {
      const p = GOLDENS[0]![1]();
      const round = verifyPlanDetailed(p).detail.budget;
      const peg = verifyPlanDetailed(p, { budget: { studFacets: 1 } }).detail.budget;
      expect(peg.bodyCuboids).toBe(round.bodyCuboids);
      expect(peg.studCuboids * 4).toBe(round.studCuboids);
    });
  });

  describe('cross-check with the viewer audit', () => {
    let realFetch: typeof globalThis.fetch;
    beforeAll(() => {
      realFetch = globalThis.fetch;
      // Serve the vendored official parts for the viewer's `/ldraw-parts/<rel>` probes.
      globalThis.fetch = (async (url: string | URL) => {
        const rel = String(url).replace(/^.*\/ldraw-parts\//, '').replace(/^(parts|p)\//, '');
        const text = rel.startsWith('UnOfficial') ? undefined : fixtureSource(rel);
        return text === undefined ? new Response('', { status: 404 }) : new Response(text, { status: 200 });
      }) as typeof fetch;
    });
    afterAll(() => { globalThis.fetch = realFetch; });

    it('the audit never reports more components than the lattice on the goldens, and agrees where the model is cleanly stacked', async () => {
      await resolvePartGeometry('3001');
      for (const [name, build] of GOLDENS) {
        const c = await crossCheckConnectivity(build());
        expect(c.consistent, `${name}: lattice ${c.latticeComponents}, audit ${c.auditComponents}`).toBe(true);
        expect(c.latticeComponents).toBe(1);
        expect(c.auditComponents).toBe(1);
      }
    }, 60_000);

    it('an element one plate too high is two components in both, so the emit and the lattice agree on the break', async () => {
      const c = await crossCheckConnectivity(plan([...TOWERS, el('3710.dat', [0, 5, 0])]));
      expect(c.latticeComponents).toBe(2);
      expect(c.auditComponents).toBeLessThanOrEqual(2);
      expect(c.consistent).toBe(true);
    }, 60_000);
  });
});
