/**
 * L-01 (BIZ-33): the vocabulary reads the official "~Moved to" names (`3023.dat` -> `3023b.dat`) and carries the
 * frequent official parts the batcave car and the nimbus fixture place, so the V-02 truth lattice reads their
 * footprint instead of falling back to their mesh (the batcave car was 19 % exact: 304 of 400 bricks).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BRICK_VOCABULARY, ELEMENT_SPECS, MOVED_PARTS, elementFor, frameFor } from '../web/src/brickgen/vocab/index.js';
import { latticeFromFootprints } from '../web/src/engine/legolize/lattice.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/ldraw-vocab/parts');

describe('vocabulary moved-name aliases', () => {
  it('3023 reads as 3023b: same element, same frame', () => {
    const real = elementFor('3023b.dat');
    expect(real).toBeDefined();
    expect(elementFor('3023.dat')).toBe(real);
    expect(frameFor('3023.dat')).toEqual(frameFor('3023b.dat'));
    expect(elementFor('4073.dat')).toBe(elementFor('6141.dat'));
    expect(elementFor('4287.dat')).toBe(elementFor('4287a.dat'));
  });

  it('every alias is a vendored one-line "~Moved to" identity reference to a vocabulary element', () => {
    const parts = new Set(ELEMENT_SPECS.map((s) => s.part));
    for (const [alias, target] of Object.entries(MOVED_PARTS)) {
      const file = path.join(FIXTURES, alias);
      expect(existsSync(file), `${alias} is vendored`).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text, alias).toMatch(/^0 ~Moved to /m);
      const refs = text.split(/\r?\n/).filter((l) => l.startsWith('1 '));
      expect(refs, alias).toHaveLength(1);
      expect(refs[0]!.trim().split(/\s+/).slice(2).join(' ').toLowerCase(), alias).toBe(`0 0 0 1 0 0 0 1 0 0 0 1 ${target}`);
      expect(parts.has(target), `${alias} -> ${target} is an element`).toBe(true);
      expect(elementFor(alias), alias).toBe(elementFor(target));
    }
  });

  it('carries the frequent official parts of the batcave car (2420 plate 2x2 corner, 54200 slope, 3958 plate 6x6)', () => {
    for (const p of ['2420.dat', '54200.dat', '3958.dat', '3032.dat', '26601.dat', '2357.dat', '3700.dat']) expect(elementFor(p), p).toBeDefined();
    expect(elementFor('2420.dat')!.occupancy).toEqual(Uint8Array.from([1, 1, 1, 0]));
    expect(BRICK_VOCABULARY.elements.length).toBeGreaterThanOrEqual(115);
  });

  it('a moved-name brick is a vocabulary brick in the truth lattice, not a mesh fallback', async () => {
    const { stats, lattice } = await latticeFromFootprints([
      { part: '3023.dat', color: 4, x: 0, y: 0, z: 0 },
      { part: '2420.dat', color: 4, x: 40, y: 0, z: 0 },
    ]);
    expect(stats.meshBricks).toBe(0);
    expect(stats.vocabBricks).toBe(2);
    expect(lattice.dims[1]).toBe(1);
  });
});
