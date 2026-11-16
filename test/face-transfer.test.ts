/**
 * TODO(face-source-transfer), audit 2026-11-15 A-10 / FIG-04: a head print is carried from another source of the same
 * set only when the figure match is unambiguous (`scripts/face-transfer.ts`).
 */
import { describe, expect, it } from 'vitest';
import { decideTransfers, printFitsHead, signatureScore, type FigureSig } from '../scripts/face-transfer.ts';

const sig = (head: number, print: string | null, entries: Record<string, number>, printedPart: string | null = null): FigureSig =>
  ({ head, print, printedPart, keys: new Map(Object.entries(entries)) });

// Two figures that differ by torso and legs colour, plus a pair of identical clones.
const RED = { 'torso:c4': 3, 'arm:c4': 2, 'hand:c14': 1, 'lower:c0': 2, 'head:c14': 1, 'headwear:c0': 3, 'headwear:62810:c0': 3 };
const BLUE = { 'torso:c1': 3, 'arm:c1': 2, 'hand:c14': 1, 'lower:c15': 2, 'head:c14': 1, 'headwear:c70': 3, 'headwear:62696:c70': 3 };

describe('face-transfer :: carries a print only on an unambiguous figure match', () => {
  it('scores identical signatures 1 and disjoint ones 0', () => {
    expect(signatureScore(new Map(Object.entries(RED)), new Map(Object.entries(RED)))).toBe(1);
    expect(signatureScore(new Map([['a', 1]]), new Map([['b', 1]]))).toBe(0);
  });

  it('carries each donor figure\'s print to the target figure made of the same parts', () => {
    const got = decideTransfers([sig(1, null, RED), sig(2, null, BLUE)], [sig(7, '3626pb100', BLUE), sig(8, '3626pb200', RED)]);
    expect(got).toEqual([{ head: 1, print: '3626pb200', score: 1 }, { head: 2, print: '3626pb100', score: 1 }]);
  });

  it('refuses when two donor figures with DIFFERENT prints match equally', () => {
    const got = decideTransfers([sig(1, null, RED)], [sig(7, '3626pb100', RED), sig(8, '3626pb200', RED)]);
    expect(got[0]!.print).toBeUndefined();
    expect(got[0]!.refused).toMatch(/^ambiguous/);
  });

  it('gives clones one shared print, but never more heads than the donor wears it on', () => {
    const two = decideTransfers([sig(1, null, RED), sig(2, null, RED)], [sig(7, '3626pb100', RED), sig(8, '3626pb100', RED)]);
    expect(two.map(d => d.print)).toEqual(['3626pb100', '3626pb100']);
    const short = decideTransfers([sig(1, null, RED), sig(2, null, RED)], [sig(7, '3626pb100', RED)]);
    expect(short.every(d => d.print === undefined && /donor has 1/.test(d.refused!))).toBe(true);
  });

  it('refuses a weak match, a donor with no print, and leaves already-printed heads alone', () => {
    const weak = { ...RED, 'torso:c4': 0, 'torso:c2': 3, 'lower:c0': 0, 'lower:c2': 2 };
    expect(decideTransfers([sig(1, null, weak)], [sig(7, '3626pb100', RED)])[0]!.refused).toMatch(/^no candidate/);
    expect(decideTransfers([sig(1, null, RED)], [sig(7, null, RED)])[0]!.refused).toBe('donor names no print');
    expect(decideTransfers([sig(1, '3626pb5', RED)], [sig(7, '3626pb100', RED)])).toEqual([]);
  });

  it('carries a print the library draws as a RENAME to the donor printed part, any other as a meta', () => {
    const got = decideTransfers([sig(1, null, RED), sig(2, null, BLUE)],
      [sig(7, '3626p0e', RED, '3626cp0e'), sig(8, '3626pb100', BLUE)]);
    expect(got).toEqual([{ head: 1, print: '3626p0e', score: 1, part: '3626cp0e' }, { head: 2, print: '3626pb100', score: 1 }]);
  });

  it('keeps a minifig print off a doll head and the other way round', () => {
    expect(printFitsHead('3626.dat', '3626pb2852')).toBe(true);
    expect(printFitsHead('28621.dat', '3626p7e')).toBe(true);
    expect(printFitsHead('92198.dat', '3626pb2852')).toBe(false);
    expect(printFitsHead('3626.dat', '92198pr0050')).toBe(false);
    expect(decideTransfers([sig(1, null, RED)], [sig(7, '92198pr0050', RED)], () => false)[0]!.refused).toMatch(/not this head's mould/);
  });
});

describe('face-transfer :: donors beyond the models index (generality census 2026-11-16)', () => {
  it('takes the set\'s Studio file (IO/<set>-1.io) as a donor after the index\'s other sources', async () => {
    const { donorPaths } = await import('../scripts/face-transfer.ts');
    // 2507's only indexed source is its Mecabricks conversion (plain `3626` heads); the corpus also holds the
    // Studio file the index does not list, which names every printed head by its BrickLink id.
    const have = new Set(['IO/2507-1.io']);
    expect(donorPaths('2507', ['MecabricksLDR/2507.ldr'], p => have.has(p))).toEqual(['IO/2507-1.io']);
    // Indexed donors keep their try order and come first; an indexed Studio file is not listed twice.
    expect(donorPaths('910035', ['IO/910035.io', 'IOModel2V2/910035.ldr', 'DbixConvV3/910035.ldr'], () => true))
      .toEqual(['IOModel2V2/910035.ldr', 'DbixConvV3/910035.ldr', 'IO/910035-1.io']);
    expect(donorPaths('7140', ['IO/7140-1.io', 'LDR/7140.ldr'], () => true)).toEqual(['LDR/7140.ldr']);
    expect(donorPaths('1234', ['LDR/1234.ldr'], () => false)).toEqual([]);
  });
});
