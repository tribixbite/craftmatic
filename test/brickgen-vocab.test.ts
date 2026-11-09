/**
 * X-08 (BIZ-05, BIZ-07): the brick vocabulary is official LDraw parts only, with
 * everything the bricker needs read from the part's own geometry.
 * The fixtures under test/fixtures/ldraw-vocab are vendored by
 * `bun scripts/_vendor_ldraw_vocab.ts` (CC BY, authors in its LICENSE.md).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRICK_VOCABULARY, buildVocabulary, frameFor } from '../web/src/brickgen/vocab/index.js';
import { ELEMENT_SPECS } from '../web/src/brickgen/vocab/elements.js';
import { analysePart, flattenPart, occupancyIndex, reachableFiles, type PartSource } from '../web/src/brickgen/vocab/occupancy.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/ldraw-vocab');

/** Same lookup order as the LDraw library: parts/ then p/ (subfiles are named `s/..`, `48/..`). */
export const fixtureSource: PartSource = name => {
  for (const dir of ['parts', 'p']) {
    const f = path.join(FIXTURES, dir, name);
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  return undefined;
};

describe('brickgen-vocab', () => {
  it('every vocabulary element is an official LDraw part with a CC BY licence line', () => {
    expect(BRICK_VOCABULARY.elements.length).toBeGreaterThanOrEqual(80);
    for (const e of BRICK_VOCABULARY.elements) {
      const text = fixtureSource(e.part);
      expect(text, `${e.part} must be vendored`).toBeDefined();
      expect(e.licence, e.part).toMatch(/CC BY/);
      expect(text!.split(/\r?\n/).some(l => l.trim() === `0 !LICENSE ${e.licence}`), `${e.part} licence line is the part's own`).toBe(true);
      expect(text!, e.part).toMatch(/^0 !LDRAW_ORG (Unofficial_)?Part/m);
      expect(e.author.length, `${e.part} author`).toBeGreaterThan(0);
      expect(text!, e.part).toContain(`0 Author: ${e.author}`);
    }
  });

  it('no element name is a bl_ copy or a Studio-only part', () => {
    for (const e of BRICK_VOCABULARY.elements) {
      expect(e.part).not.toMatch(/^bl_/i);
      expect(e.part).toMatch(/^[0-9]+[a-z]?\.dat$/);
      // The header of an official part is `Part`, a Studio stub carries `0 FILE` first or no LDRAW_ORG.
      expect(fixtureSource(e.part)!.split(/\r?\n/)[0]).not.toMatch(/^0 FILE/);
      expect(fixtureSource(e.part)!.split(/\r?\n/)[0], `${e.part} is an obsolete alias`).not.toMatch(/^0 [~=]/);
    }
    expect(new Set(BRICK_VOCABULARY.elements.map(e => e.part)).size).toBe(BRICK_VOCABULARY.elements.length);
  });

  it('every reached subfile and primitive is vendored and none carries a logo', () => {
    for (const e of BRICK_VOCABULARY.elements) {
      const { files, missing } = reachableFiles(e.part, fixtureSource);
      expect(missing, e.part).toEqual([]);
      for (const f of files) expect(f, e.part).not.toMatch(/logo/);
    }
  });

  it('the occupancy of 3040b (slope 45 2x1) matches its geometry', () => {
    const e = BRICK_VOCABULARY.elements.find(x => x.part === '3040b.dat')!;
    expect(e.footprint).toEqual([1, 2]);
    expect(e.heightPlates).toBe(3);
    // Independent reading of the part file: the slope's low column is its first cell in z. The
    // 45 degree face drops 20 LDU per stud, so at that cell's centre the surface is 10 LDU below
    // the top: layers whose mid height is below it (plates 0 and 1 from the bottom) are solid.
    const occ = e.occupancy!;
    const cell = (z: number, layer: number): number => occ[occupancyIndex(1, 2, 0, z, layer)]!;
    const lowZ = [0, 1].find(z => cell(z, 2) === 0)!;
    const highZ = 1 - lowZ;
    expect([cell(lowZ, 0), cell(lowZ, 1), cell(lowZ, 2)]).toEqual([1, 1, 0]);
    expect([cell(highZ, 0), cell(highZ, 1), cell(highZ, 2)]).toEqual([1, 1, 1]);
    // One stud on the flat (high) cell; the underside is open under both.
    expect(e.connections.studsTop).toEqual([[0, highZ]]);
    expect(e.connections.antiStudsBottom).toHaveLength(2);
    // The same numbers from the raw triangles: surface y at the slope cell centre.
    const flat = flattenPart('3040b.dat', fixtureSource);
    const a = analysePart(flat, 'envelope');
    expect(a.frame.bottomY - a.frame.topY).toBe(24);
  });

  it('a cuboid carries no occupancy mask and a 2x4 brick has 8 studs and 8 anti-studs', () => {
    const b = BRICK_VOCABULARY.elements.find(x => x.part === '3001.dat')!;
    expect(b.footprint).toEqual([4, 2]);
    expect(b.occupancy).toBeUndefined();
    expect(b.connections.studsTop).toHaveLength(8);
    expect(b.connections.antiStudsBottom).toHaveLength(8);
  });

  it('an arch leaves its opening empty', () => {
    const a = BRICK_VOCABULARY.elements.find(x => x.part === '3659.dat')!;
    expect(a.footprint).toEqual([4, 1]);
    const occ = a.occupancy!;
    // Bottom layer: only the two end cells are solid; the crown layer is solid everywhere.
    expect([0, 1, 2, 3].map(x => occ[occupancyIndex(4, 1, x, 0, 0)])).toEqual([1, 0, 0, 1]);
    expect([0, 1, 2, 3].map(x => occ[occupancyIndex(4, 1, x, 0, 2)])).toEqual([1, 1, 1, 1]);
  });

  it('the vendored fixture set is complete and every vendored file has a licence entry', () => {
    const license = readFileSync(path.join(FIXTURES, 'LICENSE.md'), 'utf8');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) walk(path.join(dir, d.name), out);
        else if (d.name.endsWith('.dat')) out.push(path.relative(FIXTURES, path.join(dir, d.name)).replace(/\\/g, '/'));
      }
      return out;
    };
    const files = walk(FIXTURES);
    expect(files.length).toBeGreaterThan(80);
    for (const f of files) {
      const text = readFileSync(path.join(FIXTURES, f), 'utf8');
      const author = /^0 Author:\s*(.*)$/m.exec(text)?.[1]?.trim();
      if (author) expect(license, f).toContain(author);
      expect(license, f).toContain(f);
    }
  });

  it('the committed vocabulary equals a rebuild from the vendored geometry', () => {
    const rebuilt = buildVocabulary(fixtureSource);
    expect(rebuilt.map(r => r.element.part)).toEqual(ELEMENT_SPECS.map(s => s.part));
    expect(rebuilt.map(r => r.element)).toEqual(BRICK_VOCABULARY.elements);
    // Frames are stored rounded to 4 decimals.
    for (const r of rebuilt) {
      const f = frameFor(r.element.part)!;
      for (const k of ['centreX', 'centreZ', 'topY', 'bottomY'] as const) expect(f[k], `${r.element.part} ${k}`).toBeCloseTo(r.frame[k], 3);
    }
  });
});
