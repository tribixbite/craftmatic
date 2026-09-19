/**
 * The geometric bound on a MEASURED LDD→LDraw origin correction
 * (`web/src/engine/lxf-parser.ts`).
 *
 * The rule: `e` re-expresses a placement from LDD's origin for a mould onto
 * LDraw's origin for the SAME mould, so it cannot be longer than the mould. A
 * row that claims otherwise is not an origin correction at all — it is the mode
 * of a vote taken over placements that were never the same relationship, and it
 * throws the part hundreds or thousands of LDU out of the model. That is
 * exactly the "torsos, windows, heads and hair are misplaced" report: `50665`
 * Minifig Helmet Classic ships |e| = 4,360 LDU against a 52 LDU part, which put
 * 11374's only helmet 4,360 LDU from the only head.
 *
 * Two things are pinned here, because only one of them is a pure function:
 *   1. the rule itself, including what it must NOT do (reject a row whose part
 *      could not be measured, or a legitimately long correction on a big part);
 *   2. the SHIPPED asset — that `web/public/ldd-measured-align.json` really is
 *      self-describing (carries diagonals), that the known-bad rows are caught,
 *      and that the rows the bound keeps are the overwhelming majority. A
 *      generator that silently stopped emitting the 15th element would make the
 *      loader trust every row again, and nothing else would notice.
 *
 * Offline: the asset is read off disk, no fetch, no DOM.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withinMeasuredBound, applyMeasuredBound, validateMeasuredAlign,
  MEASURED_BOUND_RATIO, MEASURED_ALIGN_URL,
  type MeasuredAlign, type LxfMeasuredTable,
} from '../web/src/engine/lxf-parser.js';

const I9 = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

/** A measured row with offset `e`, support `n`, and an optional diagonal. */
const row = (e: [number, number, number], diag?: number): MeasuredAlign =>
  (diag === undefined
    ? ['3001.dat', ...I9, ...e, 10]
    : ['3001.dat', ...I9, ...e, 10, diag]) as MeasuredAlign;

const SHIPPED = JSON.parse(
  readFileSync(join(process.cwd(), 'web/public/ldd-measured-align.json'), 'utf-8'),
) as Record<string, unknown>;

describe('a measured origin correction cannot be longer than the part it corrects', () => {
  it('keeps a correction well inside the part', () => {
    expect(withinMeasuredBound(row([10, -32, 0], 61.5))).toBe(true);
  });

  it('keeps a correction exactly at the bound', () => {
    // |e| = 100 against a 50 LDU part is exactly 2.0x.
    expect(withinMeasuredBound(row([100, 0, 0], 50))).toBe(true);
  });

  it('rejects the helmet row that put 11374\'s helmet 4,360 LDU from its head', () => {
    expect(withinMeasuredBound(row([4359.8, 0, 0], 52.4))).toBe(false);
  });

  it('judges by RATIO, so a long correction on a long part is fine', () => {
    // A 48x48 baseplate is ~1,357 LDU across; 900 LDU on it is 0.66x.
    expect(withinMeasuredBound(row([900, 0, 0], 1357))).toBe(true);
    // The same 900 LDU on a 1x1 plate is 39x.
    expect(withinMeasuredBound(row([900, 0, 0], 23))).toBe(false);
  });

  it('claims nothing about a part the reference library could not measure', () => {
    expect(withinMeasuredBound(row([4359.8, 0, 0]))).toBe(true);
    expect(withinMeasuredBound(row([4359.8, 0, 0], 0))).toBe(true);
  });

  it('measures the full 3-vector, not one axis', () => {
    // (30, 40, 0) is 50 long: 2.0x a 25 LDU part, and no single axis exceeds it.
    expect(withinMeasuredBound(row([30, 40, 0], 25))).toBe(true);
    expect(withinMeasuredBound(row([30, 40, 1], 25))).toBe(false);
  });
});

describe('applyMeasuredBound separates a bad row from a corrupt one', () => {
  const table = (entries: Record<string, MeasuredAlign>): LxfMeasuredTable =>
    ({ state: 'ok', source: MEASURED_ALIGN_URL, rejected: 2, entries });

  it('drops only the out-of-bound rows and counts them apart from `rejected`', () => {
    const t = applyMeasuredBound(table({
      good: row([10, -32, 0], 61.5),
      bad: row([4359.8, 0, 0], 52.4),
      unmeasured: row([4359.8, 0, 0]),
    }));
    expect(Object.keys(t.entries).sort()).toEqual(['good', 'unmeasured']);
    expect(t.boundRejected).toBe(1);
    expect(t.rejected, 'the schema count must not absorb it').toBe(2);
  });

  it('returns the table untouched when nothing is out of bound', () => {
    const src = table({ good: row([10, -32, 0], 61.5) });
    const t = applyMeasuredBound(src);
    expect(t).toBe(src);
    expect(t.boundRejected).toBeUndefined();
  });

  it('leaves an unavailable table alone rather than reporting a clean filter', () => {
    const src: LxfMeasuredTable = {
      state: 'unavailable', source: MEASURED_ALIGN_URL, rejected: 0, entries: {},
      error: 'HTTP 503',
    };
    expect(applyMeasuredBound(src)).toBe(src);
  });
});

describe('the shipped measured table is self-describing', () => {
  const rows = Object.entries(SHIPPED).filter(
    (e): e is [string, MeasuredAlign] => validateMeasuredAlign(e[1]),
  );

  it('every row passes the schema', () => {
    expect(rows.length).toBe(Object.keys(SHIPPED).length);
    expect(rows.length).toBeGreaterThan(1500);
  });

  it('carries a part diagonal on the overwhelming majority of rows', () => {
    const withDiag = rows.filter(([, r]) => typeof r[14] === 'number').length;
    // 1,805 of 1,839 on the 2026-09-19 table; the residue is `bl_*` ids the
    // reference library does not have, and those are accepted unbounded.
    expect(withDiag / rows.length).toBeGreaterThan(0.95);
  });

  it('the bound keeps the large majority and rejects a real minority', () => {
    const kept = rows.filter(([, r]) => withinMeasuredBound(r)).length;
    const dropped = rows.length - kept;
    // A bound that dropped nothing would mean the generator stopped emitting
    // diagonals; one that dropped most would mean it emitted wrong ones.
    expect(dropped).toBeGreaterThan(50);
    expect(dropped / rows.length).toBeLessThan(0.30);
  });

  it('catches the named rows whose physical evidence is in the module docs', () => {
    // Each of these has its |e| and its part diagonal recorded in clego's
    // dbix_align_bound.py header; they are the reason the rule exists.
    for (const design of ['50665', '53126', '68504']) {
      const r = SHIPPED[design];
      expect(validateMeasuredAlign(r), `${design} must still be in the table`).toBe(true);
      expect(withinMeasuredBound(r as MeasuredAlign), `${design} must be out of bound`)
        .toBe(false);
    }
  });

  it('keeps the minifig slots the figure gate depends on', () => {
    // A bound that caught these would break every minifig: the torso, hips and
    // legs corrections are a few tens of LDU on parts of the same size.
    for (const design of ['3814', '3815', '3816', '3817']) {
      const r = SHIPPED[design];
      expect(validateMeasuredAlign(r), `${design} must be in the table`).toBe(true);
      expect(withinMeasuredBound(r as MeasuredAlign), `${design} must survive`).toBe(true);
    }
  });

  it('the ratio constant is the calibrated one', () => {
    // Studio's own authored ldraw.xml corrections top out at 1.73x, so 2.0 is
    // the smallest round number that cannot reject a hand-authored row.
    expect(MEASURED_BOUND_RATIO).toBe(2.0);
  });
});
