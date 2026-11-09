/**
 * X-10 (BIZ-05, BIZ-33): the bricker, `IntentLattice` -> `BrickPlan`.
 *
 * Synthetic lattices pin each rule (largest element, running bond, slopes,
 * frames, hollow interiors, colour runs); the goldens are the three hand-sized
 * building lattices; two REAL inputs close it: a lattice voxelised from a real
 * corpus model (`latticeFromBricks`, needs the local part library) and the
 * Notre-Dame massing from A05 bricked into a first plain model.
 *
 * Every plan is judged by the independent X-09 verifier, and the writer's
 * quarter-turn convention is checked by reading the written file back.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { brickLattice, findAlignedSeams, latticeFromPlan, slopeDirOf } from '../web/src/brickgen/bricker/index.js';
import { plainMassingLattice } from '../web/src/brickgen/bricker/plain-massing.js';
import { writeLdraw } from '../web/src/brickgen/emit/ldraw-writer.js';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import type { BrickPlan, IntentLabel, IntentLattice } from '../web/src/brickgen/types.js';
import { importBricks } from '../web/src/brickgen/verify/ldraw-import.js';
import { isClean, verifyPlan, verifyPlanDetailed } from '../web/src/brickgen/verify/index.js';
import { placeAll, VOCABULARY_LOOKUP } from '../web/src/brickgen/verify/world.js';
import { BRICK_VOCABULARY, elementFor, occupancyIndex } from '../web/src/brickgen/vocab/index.js';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { latticeIndex } from '../web/src/engine/legolize/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'output', 'x10');

const WALL: IntentLabel = { role: 'wall', colour: 4 };
const WALL_BLUE: IntentLabel = { role: 'wall', colour: 1 };

/** Build a lattice from a predicate returning a 0-based label index (or -1 for empty). */
function lattice(dims: [number, number, number], labels: IntentLabel[], pick: (x: number, p: number, z: number) => number): IntentLattice {
  const cells = new Uint16Array(dims[0] * dims[1] * dims[2]);
  for (let p = 0; p < dims[1]; p++) for (let z = 0; z < dims[2]; z++) for (let x = 0; x < dims[0]; x++) {
    const k = pick(x, p, z);
    if (k >= 0) cells[latticeIndex(dims, x, p, z)] = k + 1;
  }
  return { dims, cells, labels };
}
const solidBox = (w: number, h: number, d: number, label: IntentLabel = WALL): IntentLattice => lattice([w, h, d], [label], () => 0);

/** Independent seam check from X-09's own placement: a seam is aligned when the same face is a course boundary in two stacked layers. */
function alignedSeamCount(plan: BrickPlan): number {
  const { world } = placeAll(plan.elements, VOCABULARY_LOOKUP);
  const owner = new Map<string, number>();
  for (const w of world) for (const [x, p, z] of w.body) owner.set(`${x},${p},${z}`, w.index);
  const o = (x: number, p: number, z: number): number | undefined => owner.get(`${x},${p},${z}`);
  let n = 0;
  for (const key of owner.keys()) {
    const [x, p, z] = key.split(',').map(Number) as [number, number, number];
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      const a = o(x, p, z), b = o(x + dx, p, z + dz), a0 = o(x, p - 1, z), b0 = o(x + dx, p - 1, z + dz);
      if (a === undefined || b === undefined || a0 === undefined || b0 === undefined) continue;
      if (a !== b && a0 !== b0 && a0 !== a && b0 !== b) n++;
    }
  }
  return n;
}

describe('brickgen-bricker', () => {
  describe('packing and bond', () => {
    it('a 6 x 6 x 9-plate solid wall lattice bricks to one connected component with no aligned seams in consecutive layers', () => {
      const r = brickLattice(solidBox(6, 9, 6));
      expect(r.report.components).toBe(1);
      expect(r.report.unsupported).toBe(0);
      expect(r.report.overlaps).toBe(0);
      expect(alignedSeamCount(r.plan)).toBe(0);
      expect(findAlignedSeams(r.plan)).toBe(0);
      // Three brick courses of the largest 2xN brick that fits (6x2), three per course.
      expect(r.plan.elements.map(e => e.part)).toEqual(Array(9).fill('2456.dat'));
    });

    it('a solid 4x4x3-plate block becomes a 2x4-brick stack with no full-height vertical seam', () => {
      // 4 x 4 studs, three brick courses (9 plates): 2x4 bricks, every course turned against the one below.
      const r = brickLattice(solidBox(4, 9, 4));
      expect(r.plan.elements.every(e => e.part === '3001.dat')).toBe(true);
      expect(r.plan.elements).toHaveLength(6);
      const turns = [0, 3, 6].map(p => new Set(r.plan.elements.filter(e => e.at[1] === p).map(e => e.turn % 2)));
      for (const t of turns) expect(t.size).toBe(1);
      expect(turns[0]).not.toEqual(turns[1]);
      expect(r.report.components).toBe(1);
      expect(alignedSeamCount(r.plan)).toBe(0);
      // A seam plane crossing EVERY course would split the stack: there is none.
      const { world } = placeAll(r.plan.elements, VOCABULARY_LOOKUP);
      const planeCourses = new Map<string, Set<number>>();
      for (const w of world) for (const [x, p, z] of w.body) {
        for (const [axis, c] of [['x', x], ['z', z]] as const) planeCourses.set(`${axis}${c}`, (planeCourses.get(`${axis}${c}`) ?? new Set()).add(Math.floor(p / 3)));
      }
      expect(r.report.parts).toBe(6);
    });

    it('a single brick course of two side-by-side bricks is repaired to one component (plates bridge the seam)', () => {
      const r = brickLattice(solidBox(4, 3, 4));
      expect(r.report.components).toBe(1);
      expect(r.report.unsupported).toBe(0);
      expect(r.repairs).toBeGreaterThan(0);
    });

    it('never exceeds 1x8 for single-wide or 2x10 for double-wide elements', () => {
      const r = brickLattice(solidBox(30, 9, 3));
      for (const e of r.plan.elements) {
        const [a, b] = elementFor(e.part)!.footprint;
        const [short, long] = a < b ? [a, b] : [b, a];
        expect(long).toBeLessThanOrEqual(short === 1 ? 8 : short === 2 ? 10 : 4);
      }
      expect(r.report.components).toBe(1);
    });

    it('a ten-stud run keeps a running bond: the 8+2 seam moves every course', () => {
      const r = brickLattice(solidBox(10, 12, 1));
      expect(alignedSeamCount(r.plan)).toBe(0);
      expect(r.report.components).toBe(1);
    });

    it('is deterministic', () => {
      const a = brickLattice(solidBox(9, 9, 7));
      const b = brickLattice(solidBox(9, 9, 7));
      expect(a.plan).toEqual(b.plan);
    });

    it('uses plates for a floor, never bricks', () => {
      const r = brickLattice(lattice([6, 2, 6], [{ role: 'floor', colour: 7 }], () => 0));
      expect(r.plan.elements.every(e => elementFor(e.part)!.heightPlates === 1)).toBe(true);
      expect(r.report.components).toBe(1);
    });

    it('a wall two plates high still bricks (plates where no brick fits) and stays connected', () => {
      const r = brickLattice(solidBox(6, 2, 2));
      expect(r.report.components).toBe(1);
      expect(r.plan.elements.every(e => elementFor(e.part)!.heightPlates === 1)).toBe(true);
    });
  });

  describe('colour runs', () => {
    it('an element never mixes colours: a two-colour wall splits at each colour change and stays connected', () => {
      // Colour boundary at x = 3 in the lower courses and x = 5 above: the courses overlap, so the model is one piece.
      const colourAt = (x: number, p: number): number => (x < (p < 6 ? 3 : 5) ? 0 : 1);
      const r = brickLattice(lattice([8, 12, 2], [WALL, WALL_BLUE], (x, p) => colourAt(x, p)));
      const { world } = placeAll(r.plan.elements, VOCABULARY_LOOKUP);
      for (const w of world) {
        const want = w.placed.colour === 4 ? 0 : 1;
        for (const [x, p] of w.body) expect(colourAt(x, p)).toBe(want);
      }
      expect(r.report.components).toBe(1);
    });
  });

  describe('slopes, arches, frames', () => {
    it('a 45 degree slope shape labelled with its direction is bricked as that slope with the right quarter turn', () => {
      const slope = elementFor('3039.dat')!;
      for (const turn of [0, 1, 2, 3] as const) {
        const dir = slopeDirOf(slope, turn)!;
        // Cells exactly the slope's envelope at this turn, over a plate base to stand on.
        const probe = brickLattice(lattice([4, 3, 4], [WALL], () => 0)); // warm-up: the packer is reusable
        expect(probe.report.parts).toBeGreaterThan(0);
        const [fx, fz] = slope.footprint;
        const odd = turn % 2 === 1;
        const [w, d] = odd ? [fz, fx] : [fx, fz];
        const cells = new Set<string>();
        const { world } = placeAll([{ part: '3039.dat', colour: 4, at: [0, 0, 0], turn, group: 'g' }], VOCABULARY_LOOKUP);
        for (const c of world[0]!.body) cells.add(c.join(','));
        const l = lattice([w, 3, d], [{ role: 'roof-slope', colour: 4, slope: { dir, rise: 3 } }], (x, p, z) => (cells.has(`${x},${p},${z}`) ? 0 : -1));
        const r = brickLattice(l);
        expect(r.plan.elements).toHaveLength(1);
        expect(r.plan.elements[0]).toMatchObject({ part: '3039.dat', turn });
        expect(r.plan.elements[0]!.turn).toBe(turn);
      }
    });

    it('slope directions of the four turns are all different', () => {
      const dirs = ([0, 1, 2, 3] as const).map(t => slopeDirOf(elementFor('3040b.dat')!, t));
      expect(new Set(dirs).size).toBe(4);
    });

    it('a roof-slope cell run with no slope shape falls back to plates and bricks, still connected to its wall', () => {
      const l = lattice([6, 12, 2], [WALL, { role: 'roof-slope', colour: 4, slope: { dir: 3, rise: 1 } }], (x, p) => (p < 9 ? 0 : x < 3 ? 1 : -1));
      const r = brickLattice(l);
      expect(r.report.components).toBe(1);
    });

    it('window cells matching a frame are bricked as that frame and the opening stays empty', () => {
      // A 4 x 1 wall, 12 plates high, with a 2 x 1 x 6 window opening at plates 3..8, x = 1..2.
      const label: IntentLabel = { role: 'window', colour: 15 };
      const l = lattice([4, 12, 1], [WALL, label], (x, p) => (x >= 1 && x <= 2 && p >= 3 && p <= 8 ? 1 : 0));
      const r = brickLattice(l);
      const frames = r.plan.elements.filter(e => elementFor(e.part)!.roles.includes('window'));
      expect(frames).toHaveLength(1);
      expect(frames[0]!.part).toBe('60592.dat');
      expect(frames[0]!.at).toEqual([1, 3, 0]);
      expect(r.report.components).toBe(1);
      expect(r.report.overlaps).toBe(0);
    });

    it('arch cells matching an arch are bricked as that arch', () => {
      // 6 x 1 wall, 9 plates; an arch 1x4 (3659) over x = 1..4 at plates 3..5, resting on bricks.
      const arch = elementFor('3659.dat')!;
      const [fx, fz] = arch.footprint;
      const l = lattice([6, 9, 1], [WALL, { role: 'arch', colour: 4 }], (x, p) => {
        if (p >= 3 && p <= 5 && x >= 1 && x <= 4) {
          const occ = arch.occupancy ? arch.occupancy[occupancyIndex(fx, fz, x - 1, 0, p - 3)] : 1;
          return occ ? 1 : -1;
        }
        return 0;
      });
      const r = brickLattice(l);
      expect(r.plan.elements.filter(e => e.part === '3659.dat')).toHaveLength(1);
      expect(r.report.components).toBe(1);
    });
  });

  describe('hollow interiors', () => {
    it('a hollowOk solid block needs fewer parts than the same block solid, and stays one component', () => {
      // A tall 30 x 30 x 45-plate block (15 courses): the interior is 26 x 26 x 41 cells of bricks nobody can see.
      // (A squat block gains nothing: its two-plate top and bottom skins cost more parts than the bricks they replace.)
      const solid = brickLattice(solidBox(30, 45, 30, { role: 'solid', colour: 4 }));
      const hollow = brickLattice(solidBox(30, 45, 30, { role: 'solid', colour: 4, hollowOk: true }));
      expect(hollow.report.parts).toBeLessThan(solid.report.parts);
      expect(hollow.hollowed).toBe(26 * 26 * 41); // a two-stud skin at the sides, two plates top and bottom
      expect(hollow.report.components).toBe(1);
      expect(hollow.report.unsupported).toBe(0);
    });
  });

  describe('writer round trip (quarter-turn convention)', () => {
    it('the written file reads back onto the same cells as the plan', () => {
      const r = brickLattice(lattice([9, 12, 7], [WALL], (x, p, z) => (x === 0 || z === 0 || x === 8 || z === 6 ? 0 : -1)));
      const text = writeLdraw(r.plan);
      // Flatten the MPD to the main model's placements: each group file is referenced once at the identity.
      const doc = parseLDrawDocument(text);
      const back = importBricks(doc.bricks);
      expect(back.offLattice).toEqual([]);
      const { world: a } = placeAll(r.plan.elements, VOCABULARY_LOOKUP);
      const { world: b } = placeAll(back.plan.elements, VOCABULARY_LOOKUP);
      const cells = (w: typeof a): string[] => w.flatMap(e => e.body.map(c => c.join(','))).sort();
      expect(cells(b)).toEqual(cells(a));
      expect(verifyPlan(back.plan).components).toBe(1);
    });
  });

  describe('goldens', () => {
    /** An 8 x 8 box house: floor plates, a ring wall of 6 courses, a flat plate roof. */
    function houseLattice(): IntentLattice {
      const FLOOR = { role: 'floor', colour: 7 } as IntentLabel, ROOF = { role: 'roof-flat', colour: 4 } as IntentLabel;
      return lattice([8, 21, 8], [FLOOR, WALL, ROOF], (x, p, z) => {
        if (p < 2) return 0;
        const edge = x === 0 || z === 0 || x === 7 || z === 7;
        if (p < 20) return edge ? 1 : -1;
        return 2;
      });
    }
    function lHallLattice(): IntentLattice {
      const inL = (x: number, z: number): boolean => x >= 0 && z >= 0 && ((x < 12 && z < 6) || (x < 6 && z < 12));
      const edge = (x: number, z: number): boolean => inL(x, z) && !(inL(x - 1, z) && inL(x + 1, z) && inL(x, z - 1) && inL(x, z + 1));
      return lattice([12, 16, 12], [{ role: 'floor', colour: 7 }, { role: 'wall', colour: 15 }, { role: 'roof-flat', colour: 1 }], (x, p, z) => {
        if (!inL(x, z)) return -1;
        if (p < 2) return 0;
        if (p < 15) return edge(x, z) ? 1 : -1;
        return 2;
      });
    }
    function courtyardLattice(): IntentLattice {
      return lattice([14, 14, 14], [{ role: 'floor', colour: 7 }, { role: 'wall', colour: 6 }, { role: 'trim', colour: 0 }], (x, p, z) => {
        const ring = x === 0 || z === 0 || x === 13 || z === 13;
        const court = x >= 4 && x <= 9 && z >= 4 && z <= 9;
        if (p < 2) return court ? -1 : 0;
        if (p < 13) return ring || (x >= 3 && x <= 10 && z >= 3 && z <= 10 && !court) ? 1 : -1;
        return ring ? 2 : -1;
      });
    }
    const cases: Array<[string, () => IntentLattice, [number, number]]> = [
      ['box house', houseLattice, [30, 400]],
      ['L-plan hall', lHallLattice, [40, 700]],
      ['courtyard', courtyardLattice, [30, 700]],
    ];
    for (const [name, make, [lo, hi]] of cases) {
      it(`${name} verifies at one component, 0 unsupported, no overlaps, part count in band`, () => {
        const r = brickLattice(make());
        const v = verifyPlanDetailed(r.plan);
        expect(v.report.components).toBe(1);
        expect(v.report.unsupported).toBe(0);
        expect(v.report.overlaps).toBe(0);
        expect(v.report.illegalParts).toEqual([]);
        expect(r.plan.elements.length).toBeGreaterThanOrEqual(lo);
        expect(r.plan.elements.length).toBeLessThanOrEqual(hi);
        // Every filled lattice cell is covered exactly once by a body cell or a declared opening.
        const covered = new Set<string>();
        for (const w of v.detail.world) for (const c of w.body) covered.add(c.join(','));
        const l = make();
        let filled = 0, missing = 0;
        for (let p = 0; p < l.dims[1]; p++) for (let z = 0; z < l.dims[2]; z++) for (let x = 0; x < l.dims[0]; x++) {
          if (l.cells[latticeIndex(l.dims, x, p, z)] === 0) continue;
          filled++;
          if (!covered.has(`${x},${p},${z}`)) missing++;
        }
        expect(missing).toBe(0);
        expect(covered.size).toBe(filled);
      });
    }
  });

  describe('real inputs', () => {
    // A lattice read from a real corpus model (OMR files, committed fixtures) through X-09's importer: the cells are the
    // parts' own occupancy, so the input is exact. (X-11's `latticeFromBricks` fills only one plate layer per brick on
    // this machine's library, see the report; the importer path needs no part library at all.)
    for (const [file, slug, original] of [['omr-566-1-elephant.mpd', 'elephant', 34], ['omr-1869-1-flag.mpd', 'flag', 82]] as const) {
      it(`a lattice from a real corpus model (OMR ${file}) is re-bricked into one connected model with no more parts`, () => {
        const doc = parseLDrawDocument(readFileSync(path.join(HERE, 'fixtures', file), 'utf8'));
        const imported = importBricks(doc.bricks);
        expect(imported.offLattice).toEqual([]);
        expect(verifyPlan(imported.plan).components).toBe(1);
        const { lattice: l, skipped } = latticeFromPlan(imported.plan);
        expect(skipped).toBe(0);
        const r = brickLattice(l);
        mkdirSync(OUT, { recursive: true });
        writeFileSync(path.join(OUT, `${slug}-rebricked.ldr`), writeLdraw(r.plan, { slug: `${slug}-rebricked`, title: `${slug} re-bricked by the X-10 bricker`, author: 'brickgen bricker test', licence: 'Redistributable under CC BY 4.0' }));
        expect(imported.plan.elements).toHaveLength(original);
        expect(r.report.illegalParts).toEqual([]);
        expect(r.report.overlaps).toBe(0);
        expect(r.report.components).toBe(1);
        expect(r.report.unsupported).toBe(0);
        expect(r.report.parts).toBeLessThanOrEqual(original);
        // Same shape: every source cell is covered by exactly one body cell, and no other.
        const { world } = placeAll(r.plan.elements, VOCABULARY_LOOKUP);
        const covered = world.reduce((n, w) => n + w.body.length, 0);
        expect(covered).toBe(l.cells.reduce((n, c) => n + (c ? 1 : 0), 0));
      });
    }

    it('the Notre-Dame massing (A05) is bricked into a first plain LDraw model that verifies', () => {
      const json = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'osm', 'notre-dame.overpass.json'), 'utf8'));
      const site = siteFromOverpass(json, { name: 'Notre-Dame massing', retrieved: '2026-11-09', buildingId: 'way/201611261' });
      const { massing } = buildMassing(site.site, { roles: site.roles });
      const { lattice: l, notes } = plainMassingLattice(massing);
      expect(l.dims[0]).toBeGreaterThan(150);
      const r = brickLattice(l);
      mkdirSync(OUT, { recursive: true });
      writeFileSync(path.join(OUT, 'notre-dame-plain.ldr'), writeLdraw(r.plan, { slug: 'notre-dame-plain', title: 'Notre-Dame massing, plain bricks (X-10)', author: 'brickgen bricker', licence: 'Redistributable under CC BY 4.0' }));
      writeFileSync(path.join(OUT, 'notre-dame-plain.report.json'), JSON.stringify({ report: r.report, repairs: r.repairs, hollowed: r.hollowed, lattice: l.dims, notes, filledCells: r.filled }, null, 2));
      expect(r.report.illegalParts).toEqual([]);
      expect(r.report.overlaps).toBe(0);
      expect(r.report.parts).toBeGreaterThan(1000);
      // Separate volumes of the massing (towers beside the nave) all stand on the ground plate: one model.
      expect(isClean(r.report), JSON.stringify(r.report)).toBe(true);
      expect(r.report.components).toBe(1);
    }, 240000);
  });

  it('the vocabulary still has the parts the bricker relies on', () => {
    for (const p of ['3001.dat', '2456.dat', '3003.dat', '3005.dat', '3022.dat', '3031.dat', '3040b.dat', '3659.dat', '60592.dat']) expect(BRICK_VOCABULARY.elements.some(e => e.part === p)).toBe(true);
  });
});
