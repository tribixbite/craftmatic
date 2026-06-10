/**
 * Catalog search ranking tests (rankSets is pure — no fetch needed).
 *
 * Regression: "castle" must surface the flagships (21063 Neuschwanstein,
 * 71043 Hogwarts) — the old first-N-in-file-order search buried them under
 * 200 vintage matches and they never appeared in the capped results.
 */

import { describe, it, expect } from 'vitest';
import { rankSets, type CatalogSet } from '../web/src/engine/lego-catalog.js';

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
