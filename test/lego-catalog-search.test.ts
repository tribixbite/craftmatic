/**
 * Catalog search ranking tests (rankSets is pure — no fetch needed).
 *
 * Regression: "castle" must surface the flagships (21063 Neuschwanstein,
 * 71043 Hogwarts) — the old first-N-in-file-order search buried them under
 * 200 vintage matches and they never appeared in the capped results.
 */

import { describe, it, expect } from 'vitest';
import { rankSets, splitQueryTerms, type CatalogSet } from '../web/src/engine/lego-catalog.js';

const SET = (set_num: string, name: string, year: number, num_parts: number, theme_id = 1): CatalogSet =>
  ({ set_num, name, year, theme_id, num_parts });

// A miniature catalog shaped like the real failure: many small old "castle"
// sets EARLIER in file order than the big modern flagships.
const CATALOG: CatalogSet[] = [
  ...Array.from({ length: 30 }, (_, i) =>
    SET(`00${10 + i}-1`, `Castle Mini Figures ${i}`, 1978 + (i % 5), 8 + i)),
  SET('6080-1', 'King\'s Castle', 1984, 664),
  SET('10305-1', 'Lion Knights\' Castle', 2022, 4514),
  SET('21063-1', 'Neuschwanstein Castle', 2025, 3455),
  SET('71043-1', 'Hogwarts Castle', 2018, 6020),
  SET('10294-1', 'Titanic', 2021, 9090),
];

describe('rankSets — relevance ranking', () => {
  it('surfaces flagship castles for "castle" within the result cap', () => {
    const top = rankSets(CATALOG, 'castle', null, null, null, 24).map(s => s.set_num);
    expect(top).toContain('21063-1');
    expect(top).toContain('71043-1');
    expect(top).toContain('10305-1');
    // and the flagships rank ABOVE the tiny vintage promos (which may have
    // been pushed out of the capped results entirely — also a pass)
    const promoIdx = top.indexOf('0010-1');
    if (promoIdx !== -1) expect(top.indexOf('71043-1')).toBeLessThan(promoIdx);
  });

  it('exact set number outranks everything', () => {
    const top = rankSets(CATALOG, '21063', null, null, null, 5);
    expect(top[0]!.set_num).toBe('21063-1');
  });

  it('does not match sets lacking the query words', () => {
    const top = rankSets(CATALOG, 'titanic', null, null, null, 5);
    expect(top.map(s => s.set_num)).toEqual(['10294-1']);
  });

  it('all query words must match (AND semantics)', () => {
    const top = rankSets(CATALOG, 'hogwarts castle', null, null, null, 5);
    expect(top.map(s => s.set_num)).toEqual(['71043-1']);
  });

  it('respects theme/year filters', () => {
    const byYear = rankSets(CATALOG, 'castle', null, 2020, null, 24);
    expect(byYear.every(s => s.year >= 2020)).toBe(true);
    expect(byYear.map(s => s.set_num)).toContain('21063-1');
  });

  it('honours the result cap', () => {
    expect(rankSets(CATALOG, 'castle', null, null, null, 5)).toHaveLength(5);
  });
});

describe('several search terms are a UNION', () => {
  it('splits on commas, semicolons and newlines, and trims', () => {
    expect(splitQueryTerms('10354,71040')).toEqual(['10354', '71040']);
    expect(splitQueryTerms(' 10354 ; 71040 ')).toEqual(['10354', '71040']);
    expect(splitQueryTerms('10354\n71040')).toEqual(['10354', '71040']);
    expect(splitQueryTerms('Castle, TITANIC')).toEqual(['castle', 'titanic']);
  });

  it('treats a blank box, and a box holding only separators, as browse-all', () => {
    expect(splitQueryTerms('')).toEqual(['']);
    expect(splitQueryTerms('  ')).toEqual(['']);
    expect(splitQueryTerms(' , ; ')).toEqual(['']);
  });

  it('returns every named set for a list of set numbers', () => {
    const got = rankSets(CATALOG, '21063,71043', null, null, null, 24).map(s => s.set_num);
    expect(got).toEqual(['21063-1', '71043-1']);
  });

  it('keeps the typed order of the terms, not the score order', () => {
    // 71043 scores higher than 21063 on its own (6,020 parts vs 3,455), so a
    // single ranking would put it first. The user typed 21063 first.
    expect(rankSets(CATALOG, '21063,71043', null, null, null, 24).map(s => s.set_num))
      .toEqual(['21063-1', '71043-1']);
    expect(rankSets(CATALOG, '71043,21063', null, null, null, 24).map(s => s.set_num))
      .toEqual(['71043-1', '21063-1']);
  });

  it('ranks inside a term exactly as a single-term query does', () => {
    const alone = rankSets(CATALOG, 'castle', null, null, null, 24).map(s => s.set_num);
    const withOther = rankSets(CATALOG, 'castle,titanic', null, null, null, 24).map(s => s.set_num);
    // The castle hits keep their order among themselves; titanic is woven in.
    expect(withOther.filter(n => alone.includes(n))).toEqual(alone.slice(0, 23));
    expect(withOther).toContain('10294-1');
  });

  it('does not let a broad term starve a narrow one out of the cap', () => {
    // "castle" has 34 matches here; concatenating would fill all 24 slots with
    // them and answer nothing at all for "titanic".
    const got = rankSets(CATALOG, 'castle,titanic', null, null, null, 24).map(s => s.set_num);
    expect(got).toHaveLength(24);
    expect(got.indexOf('10294-1'), 'the narrow term must land near the top').toBeLessThan(3);
  });

  it('lists a set that matches two terms ONCE, under the first', () => {
    const got = rankSets(CATALOG, 'hogwarts,castle', null, null, null, 24).map(s => s.set_num);
    expect(got[0]).toBe('71043-1');
    expect(got.filter(n => n === '71043-1')).toHaveLength(1);
  });

  it('still ANDs the words inside one term', () => {
    // "lion knights" is one term and must not become two.
    expect(rankSets(CATALOG, 'lion knights', null, null, null, 24).map(s => s.set_num))
      .toEqual(['10305-1']);
  });

  it('applies the theme/year filters and the cap across all terms', () => {
    const byYear = rankSets(CATALOG, '21063,6080', null, 2020, null, 24).map(s => s.set_num);
    expect(byYear).toEqual(['21063-1']);          // 6080 is 1984
    expect(rankSets(CATALOG, 'castle,titanic', null, null, null, 3)).toHaveLength(3);
  });
});
