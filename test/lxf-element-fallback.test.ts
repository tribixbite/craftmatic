/**
 * The ELEMENT fallback of the `.lxf` loader (port of clego reconvert_dbix.py
 * `Resolver.resolve_element`, 2026-09-24).
 *
 * A design neither alignment table names used to be drawn as `<designID>.dat`
 * at identity; for a design whose LDD number is not an LDraw file that is a
 * missing part (LDD 28650, the mini-doll head, is LDraw 92198). The brick's
 * `itemNos` element ids resolve it through Rebrickable's element table
 * (`web/public/ldd-element-map.json`, scripts/gen-ldd-element-map.py).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  buildLxfPlacements, describeLxfDiagnostics, elementPartFor, needsElementTable,
  miniDollCorrectionFor, validateElementRow, validateTable, ELEMENT_MAP_URL, MEASURED_ALIGN_URL, PART_MAP_URL,
  type LxfAlignmentTable, type LxfElementTable, type LxfMeasuredTable, type LxfPartRecord,
} from '../web/src/engine/lxf-parser.js';

const TABLE: LxfAlignmentTable = {
  state: 'ok', source: PART_MAP_URL, rejected: 0, entries: { 3001: ['3001.dat', 0, 0, 0, 0, 1, 0, 0] },
};
const MEASURED: LxfMeasuredTable = { state: 'ok', source: MEASURED_ALIGN_URL, entries: {}, rejected: 0 };
const ELEMENTS: LxfElementTable = {
  state: 'ok', source: ELEMENT_MAP_URL, rejected: 0, entries: { 6278211: '92198', 4600258: '92198' },
};
const BONE = '1,0,0,0,1,0,0,0,1,1,2,3';

const rec = (over: Partial<LxfPartRecord>): LxfPartRecord => ({
  designID: '28650', materialId: 24, transformation: BONE, boneCount: 1, brickParts: 1, itemNos: '6278211', ...over,
});

describe('element fallback', () => {
  it('resolves an unnamed design through the brick element id', () => {
    const { bricks, diagnostics } = buildLxfPlacements([rec({})], TABLE, MEASURED, { elements: ELEMENTS });
    expect(bricks[0]!.part).toBe('92198.dat');
    expect(diagnostics.elementPlacements).toBe(1);
    expect(diagnostics.unmappedDesignIds).toEqual([]);
    expect(describeLxfDiagnostics(diagnostics)).toContain('LEGO element id');
  });

  it('takes the first element id the table knows', () => {
    expect(elementPartFor(rec({ itemNos: '1,4600258' }), ELEMENTS)).toBe('92198.dat');
  });

  it('keeps the mini-doll slot correction on the file the element finds', () => {
    // 92198 is a doll head; the placement is identity + the head slot's offset,
    // exactly as a table-named 92198 would get (clego: figure_correction(stem)).
    expect(miniDollCorrectionFor('92198.dat')).not.toBeNull();
    const withEl = buildLxfPlacements([rec({})], TABLE, MEASURED, { elements: ELEMENTS });
    expect(withEl.diagnostics.miniDollPlacements).toBe(1);
    const raw = buildLxfPlacements([rec({})], TABLE, MEASURED);
    expect(raw.diagnostics.miniDollPlacements).toBe(0);
    expect(withEl.bricks[0]!.y).not.toBe(raw.bricks[0]!.y);
  });

  it('never applies to a multi-part brick, a named design, or without the table', () => {
    expect(buildLxfPlacements([rec({ brickParts: 2 })], TABLE, MEASURED, { elements: ELEMENTS }).bricks[0]!.part)
      .toBe('28650.dat');
    expect(buildLxfPlacements([rec({ designID: '3001' })], TABLE, MEASURED, { elements: ELEMENTS }).bricks[0]!.part)
      .toBe('3001.dat');
    expect(buildLxfPlacements([rec({})], TABLE, MEASURED).bricks[0]!.part).toBe('28650.dat');
    const down: LxfElementTable = { ...ELEMENTS, state: 'unavailable', entries: {} };
    expect(buildLxfPlacements([rec({})], TABLE, MEASURED, { elements: down }).bricks[0]!.part).toBe('28650.dat');
  });

  it('is fetched only when some part can use it', () => {
    expect(needsElementTable([rec({})], TABLE, MEASURED)).toBe(true);
    expect(needsElementTable([rec({ designID: '3001' })], TABLE, MEASURED)).toBe(false);
    expect(needsElementTable([rec({ brickParts: 3 })], TABLE, MEASURED)).toBe(false);
    expect(needsElementTable([rec({ itemNos: undefined })], TABLE, MEASURED)).toBe(false);
  });
});

describe('shipped ldd-element-map.json', () => {
  const path = 'web/public/ldd-element-map.json';
  it('validates and resolves the mini-doll head clego resolves', () => {
    const t = validateTable(JSON.parse(readFileSync(path, 'utf8')), path, validateElementRow) as LxfElementTable;
    expect(t.state).toBe('ok');
    expect(t.rejected).toBe(0);
    expect(Object.keys(t.entries).length).toBeGreaterThan(30_000);
    // Rebrickable element 4600258 is a 92198 mini-doll head print.
    expect(t.entries['4600258']).toBe('92198');
  });
});

// 42703's mini-dolls are the corpus case (clego commit 3d4cc013): their heads
// and hair are LDD designs no alignment table names.
const LXFML_42703 = 'C:/git/clego/lego_sets/DBIX_LXFML/42703.lxfml';
describe.skipIf(!existsSync(LXFML_42703))('42703 through the element fallback', () => {
  it('rescues parts that were bare design files', async () => {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('bun', ['scripts/_lxfml_to_ldr.ts', LXFML_42703], { encoding: 'utf8' });
    expect(out).toMatch(/of those found their LDraw part through the brick's LEGO element id/);
  }, 60_000);
});
