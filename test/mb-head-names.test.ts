/**
 * FIG-04 / PROC-19, TODO(mecabricks-head-decoration): a Mecabricks head named with LEGO's element name
 * (`Mini Head No.2552`) is the Rebrickable print `3626cpr2552`; its elements name the BrickLink / LDraw print
 * (`scripts/mb-head-names.ts`). Measured 2026-11-16 against the heads a DBIX / IOModel2V2 donor matched: where the
 * part is in the set's own Rebrickable inventory the chain agrees 69 of 76; where it is not, 0 of 29 (the author's
 * stand-in), so a head takes the chain's print only when its set holds that part.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { headNumberOf, nameChoice, namedPartCandidates, printOfPart, type RebrickableHeadData } from '../scripts/mb-head-names.ts';
import { decideHeads, type MbHeadRow } from '../scripts/_mb_decoration_votes.ts';

describe('the element number in a Mecabricks head name', () => {
  it('reads every spelling of LEGO\'s "MINI HEAD NO. N" and nothing else', () => {
    for (const [name, n] of [
      ['Mini Head No.2552', 2552], ['Mini Head No. 1144', 1144], ['Minifig Head No. 1966', 1966], ['Minifig Head No.771', 771],
      ['Mini Head "No. 1580"', 1580], ['Mini Head, No. 2141', 2141], ['Mini Head no.2755', 2755], ['Mini head No.4090', 4090],
      ['Head No.1179', 1179],
    ] as const) expect(headNumberOf(name), name).toBe(n);
    // A description, a description holding a number, and a suffixed number are not element names.
    for (const name of ['Mini Head - Moustache', 'Mini Head - Ice Planet No.1', 'Mini Head No.788-2', 'Mini Head', undefined]) {
      expect(headNumberOf(name), String(name)).toBeUndefined();
    }
  });
});

/** A small Rebrickable world: element rows, the print map's `e:` / `n:` rows and two set inventories. */
const data: RebrickableHeadData = {
  parts: new Set(['3626cpr2552', '3626cpr0752', '3626bpr0752', '28621pr4286', '3626cpr0900', '3626cpr0901', '3626cpr0902']),
  elementsOf: new Map([
    ['3626cpr2552', ['6221340']], ['3626cpr0752', ['4500001']], ['3626bpr0752', ['4500002']], ['28621pr4286', ['6400001']],
    // Two elements of one part that the print map gives two different faces: no print for that part.
    ['3626cpr0900', ['4600001', '4600002']],
    // A part whose elements the print map does not know.
    ['3626cpr0901', ['4600003']],
  ]),
  printMap: {
    'n:6221340': '3626pb2060', 'e:4500001': '3626cp7s.dat', 'n:4500002': '3626pb0527', 'e:6400001': '28621p1b.dat',
    'n:4600001': '3626pb0001', 'n:4600002': '3626pb0002',
  },
  inventoryOf: set => ({
    76263: new Set(['3626cpr2552', '973pr0001']),
    10303: new Set(['3626cpr0752']),
    6000: new Set(['3626cpr0752', '3626bpr0752']),
    7000: new Set(['3626cpr0900', '3626cpr0901']),
    75423: new Set(['28621pr4286']),
  } as Record<string, Set<string>>)[set],
};

describe('a numbered head name -> Rebrickable part -> elements -> print', () => {
  it('lists the same number in every head mould Rebrickable numbers prints in', () => {
    expect(namedPartCandidates(752, data.parts)).toEqual(['3626cpr0752', '3626bpr0752']);
    expect(namedPartCandidates(2552, data.parts)).toEqual(['3626cpr2552']);
    expect(namedPartCandidates(5, data.parts)).toEqual([]);
  });

  it('reads one print per part from its elements, and none when they disagree or are unknown', () => {
    expect(printOfPart('3626cpr2552', data)).toEqual({ print: '3626pb2060' });
    expect(printOfPart('3626cpr0752', data)).toEqual({ print: '3626p7s', ldraw: '3626cp7s' });
    expect(printOfPart('3626cpr0900', data)).toHaveProperty('refused');
    expect(printOfPart('3626cpr0901', data)).toHaveProperty('refused');
    expect(printOfPart('3626cpr0902', data)).toHaveProperty('refused'); // no element at all
  });

  const head = (name: string, part = '3626.dat'): MbHeadRow => ({ line: 5, decoration: '3626d1299', part, at: [0, 0, 0], name });

  it('takes the print only when the set\'s own inventory holds the named part', () => {
    expect(nameChoice(head('Mini Head No.2552'), '76263', data)).toEqual({ part: '3626cpr2552', print: '3626pb2060' });
    // The inventory says which mould's numbering the name is (3626bpr0752 is another face).
    expect(nameChoice(head('Mini Head No.752'), '10303', data)).toEqual({ part: '3626cpr0752', print: '3626p7s', ldraw: '3626cp7s' });
    expect(nameChoice(head('Mini Head No. 4286', '28621.dat'), '75423', data)).toEqual({ part: '28621pr4286', print: '3626p1b', ldraw: '28621p1b' });
  });

  it('refuses a part the set does not hold, a set with no inventory, two faces, and a missing link', () => {
    expect(nameChoice(head('Mini Head No.2552'), '10303', data)).toMatchObject({ refused: expect.stringContaining('inventory') });
    expect(nameChoice(head('Mini Head No.2552'), '99999', data)).toMatchObject({ refused: expect.stringContaining('no Rebrickable inventory') });
    expect(nameChoice(head('Mini Head No.752'), '6000', data)).toHaveProperty('refused');
    expect(nameChoice(head('Mini Head No.900'), '7000', data)).toHaveProperty('refused');
    expect(nameChoice(head('Mini Head No.901'), '7000', data)).toHaveProperty('refused');
    expect(nameChoice(head('Mini Head - Moustache'), '76263', data)).toHaveProperty('refused');
  });
});

describe('the name chain inside the head decisions', () => {
  const file = 'MecabricksLDR/76263.ldr';
  const h = (line: number, decoration: string, name: string): MbHeadRow => ({ line, decoration, part: '3626.dat', at: [0, 0, 0], name });
  const byName = (r: MbHeadRow) => nameChoice(r, '76263', data);

  it('writes a head nothing else decided from its name, as a rename where LDraw draws the print', () => {
    const d = decideHeads(file, [h(3, '3626d1299', 'Mini Head No.2552')], new Map(), {}, new Map(), () => true, byName);
    expect(d[0]).toMatchObject({ line: 3, basis: 'name', print: '3626pb2060' });
  });

  it('never overrides a direct full-vocabulary match, and refuses a conflict with an accepted vote row', () => {
    const own = new Map([[`${file}|3`, { any: new Set(['3626pb9999']), full: new Set(['3626pb9999']), parts: new Map() }]]);
    const d1 = decideHeads(file, [h(3, '3626d1299', 'Mini Head No.2552')], new Map(), {}, own, () => true, byName);
    expect(d1[0]).toMatchObject({ basis: 'own set', print: '3626pb9999' });
    const table = new Map([['3626d1299', { print: '3626pb1111', parts: [] as string[] }]]);
    const d2 = decideHeads(file, [h(3, '3626d1299', 'Mini Head No.2552')], table, {}, new Map(), () => true, byName);
    expect(d2[0]).toHaveProperty('refused');
    // An agreeing name keeps the vote.
    const agree = new Map([['3626d1299', { print: '3626pb2060', parts: [] as string[] }]]);
    expect(decideHeads(file, [h(3, '3626d1299', 'Mini Head No.2552')], agree, {}, new Map(), () => true, byName)[0])
      .toMatchObject({ basis: 'votes', print: '3626pb2060' });
  });
});

const CORPUS = 'C:/git/clego/lego_sets';
const HAVE_MB = existsSync(`${CORPUS}/MecabricksLDR/7208.ldr`);

/**
 * Heads the written Mecabricks conversions name a print for, at least, after the name chain was written
 * (clego `geograde/mb_head_prints.py --write`, 2026-11-16; census sets and the favourite 76269, each its set's first
 * pick). Before: 0 in each but 76269, which held 19 (`_face_print_transfer.ts`).
 */
const NAME_PRINT_FLOORS: Readonly<Record<string, number>> = {
  'MecabricksLDR/2263.ldr': 2, 'MecabricksLDR/2507.ldr': 5, 'MecabricksLDR/6860.ldr': 5, 'MecabricksLDR/7208.ldr': 4,
  'MecabricksLDR/3222.ldr': 2, 'MecabricksLDR/76269.ldr': 24,
};

describe.skipIf(!HAVE_MB)('Mecabricks conversions name the prints their head names give (corpus)', () => {
  it('meets each written file\'s floor of heads naming a print', async () => {
    const { loadModelBricks } = await import('../scripts/model-source.ts');
    const { namedHeadPrint } = await import('../scripts/face-census.ts');
    const short: string[] = [];
    expect(Object.keys(NAME_PRINT_FLOORS).length).toBeGreaterThan(0);
    for (const [f, floor] of Object.entries(NAME_PRINT_FLOORS)) {
      const { bricks } = await loadModelBricks(`${CORPUS}/${f}`);
      const named = bricks.filter(b => /^(3626|28621)/i.test(b.part) && namedHeadPrint(b.part, b.headPrint)).length;
      if (named < floor) short.push(`${f}: ${named} heads name a print, floor ${floor}`);
    }
    expect(short).toEqual([]);
  }, 300_000);
});
