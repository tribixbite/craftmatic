/**
 * FIG-04 / PROC-19, TODO(mecabricks-head-decoration): a Mecabricks conversion names the print of a decorated head
 * where an honest signal says which print it is (`scripts/_mb_decoration_votes.ts`, clego
 * `geograde/mb_head_decorations.py` + `mb_head_prints.py`). Generality census 2026-11-16: the converter wrote every
 * decorated head as the plain `3626`, so 31 census heads and 22 favourite heads drew the default face.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import {
  attachDecorations, chooseHeadPrint, decideHeads, headMould, ownVotesOf, type HeadVote, type MbHeadRow,
} from '../scripts/_mb_decoration_votes.ts';
import { acceptVotes, tallyVotes } from '../scripts/decoration-votes.ts';

const head = (line: number, decoration: string, at: [number, number, number] = [0, 0, 0], part = '3626.dat'): MbHeadRow =>
  ({ line, decoration, part, at });
const vote = (o: Partial<HeadVote> & { decoration: string; print: string; set: string; line: number }): HeadVote =>
  ({ target: `MecabricksLDR/${o.set}.ldr`, donor: `DbixConvV3/${o.set}.ldr`, score: 1, ...o });

describe('Mecabricks head decorations meet the shipped head line', () => {
  it('attaches a decoration to the one brick at its part and position, and to no other', () => {
    const b = (part: string, x: number): ParsedBrick => ({ part, color: 78, x, y: -24, z: 0, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
    const bricks = [b('973.dat', 10), b('3626.dat', 10), b('3626.dat', 50), b('3626.dat', 50)];
    const rows = attachDecorations(bricks, [head(5, '3626d1299', [10, -24, 0]), head(9, '3626d43', [50, -24, 0])]);
    // The second decoration sits on two identical lines (a superimposed duplicate): ambiguous, left alone.
    expect([...rows].map(([i, h]) => [i, h.decoration])).toEqual([[1, '3626d1299']]);
  });
});

describe('the print a decorated head is written with', () => {
  it('renames to a library print of the same mould, never to a BrickLink-style name', () => {
    expect(headMould('3626cp0e.dat')).toBe('3626');
    expect(headMould('28621p17')).toBe('28621');
    // A donor's LDraw print of the same mould: the hollow-stud `3626c` print first.
    expect(chooseHeadPrint('3626.dat', '3626p01', ['3626bp01', '3626cp01'])).toEqual({ print: '3626p01', rename: '3626cp01.dat' });
    // `3626cpb1993` is what an IOModel2V2 donor places, and no LDraw library ships it: LDraw's own print of that
    // BrickLink id (`printedHeadFor`) instead.
    expect(chooseHeadPrint('3626.dat', '3626pb1993', ['3626cpb1993']).rename).not.toMatch(/pb\d/);
    // No LDraw print: the id rides on a HEAD_PRINT meta (no rename).
    expect(chooseHeadPrint('3626.dat', '3626pb3484', ['3626cpb3484'])).toEqual({ print: '3626pb3484' });
    // Another mould's print is not a rename for this head.
    expect(chooseHeadPrint('28621.dat', '3626p01', ['3626cp01'])).toEqual({ print: '3626p01' });
    // A name the library does not hold as that very file is no rename.
    expect(chooseHeadPrint('3626.dat', '3626p01', ['3626cp01'], () => false)).toEqual({ print: '3626p01' });
  });
});

describe('which heads get a print (votes, or a direct match by a full-vocabulary donor)', () => {
  const file = 'MecabricksLDR/1000.ldr';
  const votes: HeadVote[] = [
    // 3626dA: four OTHER sets agree (DBIX) -> an accepted row, which set 1000's one rival vote (below) cannot contest.
    ...['2000', '3000', '4000', '5000'].map(set => vote({ decoration: '3626dA', print: '3626pb1211', set, line: 3 })),
    // A head of set 1000 matched directly by its DBIX conversion.
    vote({ decoration: '3626dB', print: '3626pb2644', set: '1000', line: 7, target: file }),
    // A head matched only by an LDR file (an LDraw-limited author, who may draw the nearest print).
    vote({ decoration: '3626dC', print: '3626p01', set: '1000', line: 9, target: file, donor: 'LDR/1000 x.mpd', part: '3626bp01' }),
    // Two donors pair one head with two different prints.
    vote({ decoration: '3626dD', print: '3626pb0001', set: '1000', line: 11, target: file }),
    vote({ decoration: '3626dD', print: '3626pb0002', set: '1000', line: 11, target: file, donor: 'IOModel2V2/1000.ldr' }),
    // A direct DBIX match against the accepted row: this figure's own print wins (one decoration, several faces).
    vote({ decoration: '3626dA', print: '3626pb9999', set: '1000', line: 13, target: file }),
  ];
  const tally = tallyVotes(votes);
  const table = new Map(acceptVotes(tally).flatMap(v => ('print' in v ? [[v.decoration, { print: v.print, parts: v.parts }] as const] : [])));
  const d = decideHeads(file, [head(1, '3626dA'), head(7, '3626dB'), head(9, '3626dC'), head(11, '3626dD'), head(13, '3626dA'), head(15, '3626dE')],
    table, tally, ownVotesOf(votes));

  it('takes an accepted row for an unmatched head of its decoration', () => {
    expect(d[0]).toMatchObject({ line: 1, basis: 'votes', print: '3626pb1211' });
  });
  it('takes a full-vocabulary donor\'s direct match, even against the accepted row', () => {
    expect(d[1]).toMatchObject({ line: 7, basis: 'own set', print: '3626pb2644' });
    expect(d[4]).toMatchObject({ line: 13, basis: 'own set', print: '3626pb9999' });
  });
  it('refuses a match only an LDraw-limited donor made, donors that disagree, and a decoration nobody voted', () => {
    expect(d[2]).toHaveProperty('refused');
    expect(d[3]).toHaveProperty('refused');
    expect(d[5]).toMatchObject({ refused: 'no vote' });
  });
  it('accepts a decoration only from two agreeing sets, and the smile only from five', () => {
    const one = acceptVotes(tallyVotes([vote({ decoration: 'x', print: '3626pb1', set: '1', line: 1 })]));
    expect(one[0]).toHaveProperty('refused');
    const smile = acceptVotes(tallyVotes(['1', '2', '3', '4'].map(s => vote({ decoration: 'y', print: '3626p01', set: s, line: 1 }))));
    expect(smile[0]).toHaveProperty('refused');
  });
});

const CORPUS = 'C:/git/clego/lego_sets';
const HAVE_MB = existsSync(`${CORPUS}/MecabricksLDR/21358.ldr`);

/**
 * Heads the written Mecabricks conversions name a print for, at least (`bun scripts/_mb_decoration_votes.ts
 * --plan`, written by clego `geograde/mb_head_prints.py --write`, 2026-11-16). Before: 0 in each.
 */
const MB_PRINT_FLOORS: Readonly<Record<string, number>> = {
  'MecabricksLDR/21358.ldr': 11, 'MecabricksLDR/60271.ldr': 9, 'MecabricksLDR/10273.ldr': 1, 'MecabricksLDR/75258.ldr': 1,
};

describe.skipIf(!HAVE_MB)('Mecabricks conversions name their decorated heads\' prints (corpus)', () => {
  it('meets each written file\'s floor of heads naming a print', async () => {
    const { loadModelBricks } = await import('../scripts/model-source.ts');
    const { namedHeadPrint } = await import('../scripts/face-census.ts');
    const short: string[] = [];
    for (const [f, floor] of Object.entries(MB_PRINT_FLOORS)) {
      const { bricks } = await loadModelBricks(`${CORPUS}/${f}`);
      const named = bricks.filter(b => /^(3626|28621)/i.test(b.part) && namedHeadPrint(b.part, b.headPrint)).length;
      if (named < floor) short.push(`${f}: ${named} heads name a print, floor ${floor}`);
    }
    expect(short).toEqual([]);
  }, 300_000);
});
