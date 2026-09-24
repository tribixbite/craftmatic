/**
 * Integration coverage for the `.lxf` LDD→LDraw ALIGNMENT TABLE loader — audit
 * 2026-09-08, P1 item 3.
 *
 * `test/lxf-alignment.test.ts` covers the pure transform maths. It cannot see
 * the failure this file exists for: `loadPartMap()` used to turn every HTTP,
 * network and JSON error into `{}` and KEEP that promise, so one transient blip
 * left every later `.lxf` load in the page session placing parts at their raw
 * LDD origins — silently, with no retry and no diagnostic. A model rendered
 * that way looks scattered, which is indistinguishable from the "LDD alignment
 * is approximate" caveat the UI already shows.
 *
 * The four cases the audit asked for:
 *   1. a failed fetch followed by recovery
 *   2. malformed JSON
 *   3. a partially covered REAL fixture (the shipped web/public table)
 *   4. fresh versus warm sessions
 *
 * Offline and deterministic: `fetch` is stubbed, and case 3 reads the real
 * `web/public/ldd-part-map.json` off disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadPartMap, loadMeasuredAlign, resetPartMapCache, validatePartMap,
  validatePartAlign, validateMeasuredAlign, validateTable,
  buildLxfPlacements, describeLxfDiagnostics,
  PART_MAP_URL, MEASURED_ALIGN_URL,
  type PartAlign, type MeasuredAlign, type LxfAlignmentTable,
  type LxfMeasuredTable, type LxfPartRecord,
} from '../web/src/engine/lxf-parser.js';

/** An empty-but-healthy measured table: every placement goes through Studio's ldraw.xml path. */
const NO_MEASURED: LxfMeasuredTable = {
  state: 'ok', source: MEASURED_ALIGN_URL, entries: {}, rejected: 0,
};

/** A well-formed table row: 3001 at identity alignment. */
const ROW: PartAlign = ['3001.dat', 0, 0, 0, 0, 1, 0, 0];

/** Minimal Response stand-in — only what the loader touches. */
const jsonResponse = (body: unknown, init: { status?: number; etag?: string } = {}): Response => {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'etag' ? init.etag ?? null : null) },
    json: async () => {
      if (typeof body === 'string') return JSON.parse(body) as unknown; // may throw
      return body;
    },
  } as unknown as Response;
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetPartMapCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // The loader backs a retry off by 250/750 ms; fake timers would need manual
  // pumping through the async chain, so shorten the wall clock instead by
  // letting the real timers run — three attempts cost ~1 s, well inside the
  // suite's 60 s timeout.
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetPartMapCache();
});

describe('loadPartMap — schema validation', () => {
  it('accepts a well-formed row and reports the entry count', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 3001: ROW }, { etag: '"abc"' }));
    const t = await loadPartMap();
    expect(t.state).toBe('ok');
    expect(t.source).toBe(PART_MAP_URL);
    expect(Object.keys(t.entries)).toEqual(['3001']);
    expect(t.rejected).toBe(0);
    expect(t.version).toBe('"abc"');
  });

  it('DROPS individual malformed rows and counts them — one bad row must not disable the rest', () => {
    const t = validatePartMap({
      3001: ROW,
      bad_len: ['x.dat', 0, 0, 0],
      bad_name: [7, 0, 0, 0, 0, 1, 0, 0],
      bad_nan: ['x.dat', 0, Number.NaN, 0, 0, 1, 0, 0],
      bad_str: ['x.dat', 0, '3', 0, 0, 1, 0, 0],
      bad_null: null,
    }, PART_MAP_URL);
    expect(t.state).toBe('ok');
    expect(Object.keys(t.entries)).toEqual(['3001']);
    expect(t.rejected).toBe(5);
  });

  it('rejects a body that is not an object, and an object with no usable rows', () => {
    expect(validatePartMap([ROW], PART_MAP_URL).state).toBe('unavailable');
    expect(validatePartMap('nope', PART_MAP_URL).state).toBe('unavailable');
    const empty = validatePartMap({ a: ['x.dat', 0, 0, 0] }, PART_MAP_URL);
    expect(empty.state).toBe('unavailable');
    expect(empty.error).toMatch(/no usable entries/);
  });

  it('validatePartAlign is strict about arity, name and finiteness', () => {
    expect(validatePartAlign(ROW)).toBe(true);
    expect(validatePartAlign(['', 0, 0, 0, 0, 1, 0, 0])).toBe(false);
    expect(validatePartAlign(['x.dat', 0, 0, 0, 0, 1, 0, 0, 0])).toBe(false);
    expect(validatePartAlign(['x.dat', 0, 0, 0, 0, Infinity, 0, 0])).toBe(false);
  });
});

describe('loadPartMap — case 1: a failed fetch followed by recovery', () => {
  it('retries a thrown fetch within one call and succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({ 3001: ROW }));
    const t = await loadPartMap();
    expect(t.state).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx but NOT a 404 (a missing asset is definitive)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }));
    expect((await loadPartMap()).state).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    resetPartMapCache();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
    const t = await loadPartMap();
    expect(t.state).toBe('unavailable');
    expect(t.error).toBe('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure — the NEXT load recovers without a page reload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }));
    expect((await loadPartMap()).state).toBe('unavailable');
    const afterFailure = fetchMock.mock.calls.length;

    fetchMock.mockResolvedValue(jsonResponse({ 3001: ROW }));
    const t = await loadPartMap();
    expect(t.state).toBe('ok');
    expect(Object.keys(t.entries)).toEqual(['3001']);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFailure);
  });

  it('does not cache a THROWN load either', async () => {
    // A rejection that escapes fetchMock's contract (e.g. the stub itself is
    // broken) must not poison the cache with a rejected promise.
    fetchMock.mockImplementation(() => { throw new Error('sync boom'); });
    expect((await loadPartMap()).state).toBe('unavailable');
    fetchMock.mockImplementation(async () => jsonResponse({ 3001: ROW }));
    expect((await loadPartMap()).state).toBe('ok');
  });
});

describe('loadPartMap — case 2: malformed JSON', () => {
  it('reports it as unavailable, with the parse error, and does not retry the bytes', async () => {
    fetchMock.mockResolvedValue(jsonResponse('{ this is not json', { etag: 'W/"1"' }));
    const t = await loadPartMap();
    expect(t.state).toBe('unavailable');
    expect(t.error).toMatch(/^malformed JSON:/);
    expect(t.version).toBe('W/"1"');
    expect(fetchMock).toHaveBeenCalledTimes(1); // re-reading the same bytes cannot help
  });

  it('and it is still not cached, so a fixed deploy recovers in-session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{ nope'));
    expect((await loadPartMap()).state).toBe('unavailable');
    fetchMock.mockResolvedValueOnce(jsonResponse({ 3001: ROW }));
    expect((await loadPartMap()).state).toBe('ok');
  });
});

describe('loadPartMap — case 4: fresh versus warm sessions', () => {
  it('a SUCCESS is cached: a second load in the same session refetches nothing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 3001: ROW }));
    const a = await loadPartMap();
    const b = await loadPartMap();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toBe(a); // the same resolved table object, not a re-validated copy
  });

  it('concurrent first loads share ONE request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 3001: ROW }));
    const [a, b] = await Promise.all([loadPartMap(), loadPartMap()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('a fresh session (cache reset) refetches', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 3001: ROW }));
    await loadPartMap();
    resetPartMapCache();
    await loadPartMap();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('case 3: coverage against the REAL shipped table', () => {
  const real = JSON.parse(
    readFileSync(join(process.cwd(), 'web/public/ldd-part-map.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const table = validatePartMap(real, PART_MAP_URL);

  it('the deployed table validates, with no rejected rows', () => {
    expect(table.state).toBe('ok');
    expect(table.rejected).toBe(0);
    expect(Object.keys(table.entries).length).toBeGreaterThan(4000);
  });

  it('a bare-identity Studio row the measured table contradicts is overridden (gen-ldd-part-map.py)', () => {
    // 21229 (spindled quarter-round fence WITH studs) is 30056 plus three studs:
    // 21229.dat includes s\30056s01.dat at identity, so the two share a frame and
    // must share Studio's correction. Studio wrote identity for 21229; 76417's
    // tower railings hung 48 LDU low and 70 out (device, 2026-09-24).
    expect(real['21229']).toEqual(['21229.dat', ...(real['30056'] as unknown[]).slice(1)]);
    // 37352 (Brick 1 x 2 curved top) takes the 1 x 2 brick's correction (488 measured votes).
    expect((real['37352'] as unknown[]).slice(1)).toEqual((real['3004'] as unknown[]).slice(1));
  });

  it('reports mapped vs unmapped placements for a PARTIALLY covered model', () => {
    const covered = Object.keys(table.entries)[0]!;
    // A 12-float column-major bone at the origin, identity rotation.
    const tf = '1,0,0,0,1,0,0,0,1,0,0,0';
    const recs: LxfPartRecord[] = [
      { designID: covered, materialId: 21, transformation: tf, boneCount: 1 },
      { designID: covered, materialId: 21, transformation: tf, boneCount: 1 },
      { designID: '99999991', materialId: 21, transformation: tf, boneCount: 1 },
      { designID: '99999992', materialId: 21, transformation: tf, boneCount: 2 },
      { designID: '99999992', materialId: 21, transformation: '1,2,3', boneCount: 1 },
      { designID: '99999993', materialId: 21, transformation: '', boneCount: 0 },
    ];
    const { bricks, diagnostics: d } = buildLxfPlacements(recs, table, NO_MEASURED);
    expect(bricks).toHaveLength(4);                 // 6 records - 1 bad tf - 1 no bone
    expect(d.mappedPlacements).toBe(2);
    expect(d.unmappedPlacements).toBe(2);
    expect(d.unmappedDesignIds.sort()).toEqual(['99999991', '99999992']);
    expect(d.skippedBadTransform).toBe(1);
    expect(d.skippedNoBone).toBe(1);
    expect(d.multiBoneParts).toBe(1);
    expect(d.table.state).toBe('ok');
    expect(d.table.source).toBe(PART_MAP_URL);
    // An unmapped design falls back to a bare <designID>.dat at identity.
    expect(bricks.some(b => b.part === '99999991.dat')).toBe(true);
    // A mapped design uses the table's LDraw filename.
    expect(bricks[0]!.part).toBe(table.entries[covered]![0]);
  });

  it('an unmapped design id is NOT reported as an unavailable table', () => {
    const d = buildLxfPlacements(
      [{ designID: 'nope', materialId: 21, transformation: '1,0,0,0,1,0,0,0,1,0,0,0', boneCount: 1 }],
      table, NO_MEASURED,
    ).diagnostics;
    expect(d.table.state).toBe('ok');
    expect(describeLxfDiagnostics(d)).toMatch(/have no LDD→LDraw alignment entry/);
    expect(describeLxfDiagnostics(d)).not.toMatch(/unavailable/);
  });
});

describe('describeLxfDiagnostics', () => {
  const unavailable: LxfAlignmentTable = {
    state: 'unavailable', source: PART_MAP_URL, entries: {}, rejected: 0,
    error: 'HTTP 503',
  };
  const tf = '1,0,0,0,1,0,0,0,1,0,0,0';

  it('a missing table is a loud failure with a retry hint, not a soft caveat', () => {
    const d = buildLxfPlacements(
      [{ designID: '3001', materialId: 21, transformation: tf, boneCount: 1 }],
      unavailable, { ...NO_MEASURED, state: 'unavailable', error: 'HTTP 503' },
    ).diagnostics;
    const msg = describeLxfDiagnostics(d);
    expect(msg).toMatch(/tables unavailable \(HTTP 503\)/);
    expect(msg).toMatch(/raw LDD origin/);
    expect(msg).toMatch(/Reload to retry/);
  });

  it('is silent when a fully covered model loads through a healthy table', () => {
    const ok: LxfAlignmentTable = {
      state: 'ok', source: PART_MAP_URL, entries: { 3001: ROW }, rejected: 0,
    };
    const measured: LxfMeasuredTable = {
      state: 'ok', source: MEASURED_ALIGN_URL, rejected: 0,
      entries: { 3001: ['3001.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 9] },
    };
    const d = buildLxfPlacements(
      [{ designID: '3001', materialId: 21, transformation: tf, boneCount: 1 }], ok, measured,
    ).diagnostics;
    expect(describeLxfDiagnostics(d)).toBeNull();
  });
});

describe('a missing Studio table with a healthy measured fallback', () => {
  it('says the model is placed less exactly and asks for a reload', () => {
    const tf = '1,0,0,0,1,0,0,0,1,0,0,0';
    const measured: LxfMeasuredTable = {
      state: 'ok', source: MEASURED_ALIGN_URL, rejected: 0,
      entries: { 3001: ['3001.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 9] },
    };
    const d = buildLxfPlacements(
      [{ designID: '3001', materialId: 21, transformation: tf, boneCount: 1 }],
      { state: 'unavailable', source: PART_MAP_URL, entries: {}, rejected: 0, error: 'HTTP 503' }, measured,
    ).diagnostics;
    expect(d.measuredPlacements).toBe(1);
    const msg = describeLxfDiagnostics(d);
    expect(msg).toMatch(/Studio ldraw\.xml alignment table unavailable \(HTTP 503\)/);
    expect(msg).toMatch(/less exactly/);
    expect(msg).toMatch(/Reload to retry/);
  });
});

describe('the MEASURED alignment table (audit P0 item 2)', () => {
  const MROW: MeasuredAlign = ['3001.dat', 1, 0, 0, 0, 1, 0, 0, 0, 1, 30, -24, 10, 506];

  it('validateMeasuredAlign is strict about arity, name, finiteness and det(R)', () => {
    expect(validateMeasuredAlign(MROW)).toBe(true);
    expect(validateMeasuredAlign(MROW.slice(0, 13))).toBe(false);
    expect(validateMeasuredAlign(['', ...MROW.slice(1)])).toBe(false);
    expect(validateMeasuredAlign(['p.dat', 1, 0, 0, 0, 1, 0, 0, 0, Number.NaN, 0, 0, 0, 1])).toBe(false);
    // A reflection (det = -1) must be rejected: it would mirror the part.
    expect(validateMeasuredAlign(['p.dat', 1, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 1])).toBe(false);
    // ... and so must a scaled/degenerate rotation.
    expect(validateMeasuredAlign(['p.dat', 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(false);
  });

  it('loads from its own URL and its own cache slot', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === MEASURED_ALIGN_URL ? jsonResponse({ 3001: MROW }) : jsonResponse({ 3001: ROW }));
    const [xml, meas] = await Promise.all([loadPartMap(), loadMeasuredAlign()]);
    expect(xml.source).toBe(PART_MAP_URL);
    expect(meas.source).toBe(MEASURED_ALIGN_URL);
    expect(meas.entries['3001']).toEqual(MROW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Warm: neither refetches.
    await Promise.all([loadPartMap(), loadMeasuredAlign()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a measured failure does not poison the ldraw.xml table (independent caches)', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === MEASURED_ALIGN_URL ? jsonResponse({}, { status: 503 }) : jsonResponse({ 3001: ROW }));
    expect((await loadMeasuredAlign()).state).toBe('unavailable');
    expect((await loadPartMap()).state).toBe('ok');
  });

  it('the SHIPPED measured table validates, with no rejected rows', () => {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), 'web/public/ldd-measured-align.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const t = validateTable(raw, MEASURED_ALIGN_URL, validateMeasuredAlign);
    expect(t.state).toBe('ok');
    expect(t.rejected).toBe(0);
    expect(Object.keys(t.entries).length).toBeGreaterThan(1500);
    // Every row must name a .dat and carry a proper rotation.
    for (const [id, row] of Object.entries(t.entries)) {
      expect(row[0], `design ${id}`).toMatch(/\.dat$/);
      expect(row[13], `design ${id} support`).toBeGreaterThanOrEqual(2);
    }
  });

  it('The Studio ldraw.xml columns WIN over the measured correction for a shared design', () => {
    // Measured on 91 native .lxf files with authentic Studio truth
    // (scripts/lxf_gt_eval.py): the inverse ldraw.xml columns place parts more
    // exactly than the quantised measured votes, so they are primary.
    const tf = '1,0,0,0,1,0,0,0,1,0,0,0';
    const xml: LxfAlignmentTable = {
      state: 'ok', source: PART_MAP_URL, rejected: 0,
      entries: { 3001: ['xml-name.dat', 1, 0, 0, 0, 1, 0, 0] },
    };
    const measured: LxfMeasuredTable = {
      state: 'ok', source: MEASURED_ALIGN_URL, rejected: 0, entries: { 3001: MROW },
    };
    const { bricks, diagnostics: d } = buildLxfPlacements(
      [{ designID: '3001', materialId: 21, transformation: tf, boneCount: 1 }], xml, measured);
    expect(d.mappedPlacements).toBe(1);
    expect(d.measuredPlacements).toBe(0);
    expect(bricks[0]!.part).toBe('xml-name.dat');   // Studio's filename
    expect(bricks[0]!.x).toBeCloseTo(-25);          // the INVERSE of t_align=(1,0,0) cm
    expect(bricks[0]!.y).toBeCloseTo(0);
    expect(bricks[0]!.z).toBeCloseTo(0);
    expect(describeLxfDiagnostics(d)).toBeNull();   // fully Studio-aligned → silent
  });

  it('the measured correction is the FALLBACK for a design Studio does not name', () => {
    const tf = '1,0,0,0,1,0,0,0,1,0,0,0';
    const xml: LxfAlignmentTable = { state: 'ok', source: PART_MAP_URL, rejected: 0, entries: {} };
    const measured: LxfMeasuredTable = {
      state: 'ok', source: MEASURED_ALIGN_URL, rejected: 0, entries: { 3001: MROW },
    };
    const { bricks, diagnostics: d } = buildLxfPlacements(
      [{ designID: '3001', materialId: 21, transformation: tf, boneCount: 1 }], xml, measured);
    expect(d.measuredPlacements).toBe(1);
    expect(d.mappedPlacements).toBe(0);
    expect(bricks[0]!.part).toBe('3001.dat');       // the measured table's filename
    expect(bricks[0]!.x).toBeCloseTo(30);           // e applied in LDU, unscaled
    expect(bricks[0]!.y).toBeCloseTo(-24);
    expect(bricks[0]!.z).toBeCloseTo(10);
  });

  it('reports the split when SOME designs fall back to the measured table', () => {
    const tf = '1,0,0,0,1,0,0,0,1,0,0,0';
    // Studio names 3023 only; 3001 is measured-only, so it takes the fallback.
    const xml: LxfAlignmentTable = {
      state: 'ok', source: PART_MAP_URL, rejected: 0,
      entries: { 3023: ['3023.dat', 0, 0, 0, 0, 1, 0, 0] },
    };
    const measured: LxfMeasuredTable = {
      state: 'ok', source: MEASURED_ALIGN_URL, rejected: 0, entries: { 3001: MROW },
    };
    const d = buildLxfPlacements([
      { designID: '3001', materialId: 21, transformation: tf, boneCount: 1 },
      { designID: '3023', materialId: 21, transformation: tf, boneCount: 1 },
    ], xml, measured).diagnostics;
    expect(d.measuredPlacements).toBe(1);
    expect(d.mappedPlacements).toBe(1);
    expect(describeLxfDiagnostics(d)).toMatch(/1 of 2 placements \(50\.0%\) use Studio's exact ldraw\.xml alignment; 1 fall back to the measured/);
  });

  it('a missing MEASURED fallback table is reported even when the Studio table is healthy', () => {
    const tf = '1,0,0,0,1,0,0,0,1,0,0,0';
    const xml: LxfAlignmentTable = {
      state: 'ok', source: PART_MAP_URL, rejected: 0, entries: { 3001: ROW },
    };
    const d = buildLxfPlacements(
      [{ designID: '3001', materialId: 21, transformation: tf, boneCount: 1 }], xml,
      { ...NO_MEASURED, state: 'unavailable', error: 'HTTP 503' }).diagnostics;
    const msg = describeLxfDiagnostics(d);
    expect(msg).toMatch(/measured fallback alignment table unavailable \(HTTP 503\)/);
    expect(msg).toMatch(/ldraw\.xml/);
    expect(msg).toMatch(/Reload to retry/);
  });
});

// ── The shipped table carries the SECOND Studio mapping ─────────────────────
// `ldraw_lxfv56.xml` names ids that `ldraw.xml` does not, some of them only
// through material-typed rows (`type="21"` = LDD material, not a subtype).
// Losing either source regresses coaster track (25059, 80566) or places the
// hinge halves of 42703/76417 at their raw LDD origin (80133, 80134, 77083).
describe('shipped part map includes the lxfv56-only rows', () => {
  const table = JSON.parse(readFileSync(join(__dirname, '..', 'web', 'public', 'ldd-part-map.json'), 'utf8')) as Record<string, [string, ...number[]]>;
  it.each([
    ['25059', '25059.dat'], ['80566', '80566.dat'],
    ['80133', '2430.dat'], ['80134', '2429.dat'],
  ])('%s -> %s', (id, file) => {
    expect(table[id]?.[0]).toBe(file);
  });
  it('refuses the 77083 bull bar -> 20309 half-round window substitute', () => {
    expect(table['77083']).toBeUndefined();
  });
});

// ── Dual-moulded parts: the second material picks a pattern or splits shells ──
// 68498 (goblin/elf hair with moulded ears) is curated onto LDraw 93230, whose
// ears are a subpart. 76417's goblins (LDD 283 light nougat ears) get
// 93230p04; 40893's goblin has olive green ears (LDD 330), which no pattern
// carries, so the hair and ears are placed as subparts in their own colours.
describe('dual-material parts', () => {
  const shipped = validateTable(
    JSON.parse(readFileSync(join(__dirname, '..', 'web', 'public', 'ldd-part-map.json'), 'utf8')),
    'ldd-part-map.json', validatePartAlign,
  ) as LxfAlignmentTable;
  const identity = '1,0,0,0,1,0,0,0,1,0,0,0';
  const place = (materialIds: number[]) => buildLxfPlacements(
    [{ designID: '68498', materialId: materialIds[0]!, materialIds, transformation: identity, boneCount: 1 }],
    shipped, NO_MEASURED,
  );
  it('light nougat ears -> the 93230p04 pattern in the hair colour', () => {
    const { bricks, diagnostics } = place([199, 283]);
    expect(bricks.map(b => b.part)).toEqual(['93230p04.dat']);
    expect(diagnostics.dualMaterialPatterned).toBe(1);
  });
  it('olive green ears -> hair and ears subparts, each in its own colour', () => {
    const { bricks, diagnostics } = place([308, 330]);
    expect(bricks.map(b => [b.part, b.color])).toEqual([['s/93230s01.dat', 308], ['s/93230s02.dat', 330]]);
    expect(diagnostics.dualMaterialSplit).toBe(1);
  });
  it('one material -> the base mould', () => {
    expect(place([199]).bricks.map(b => b.part)).toEqual(['93230.dat']);
  });
});
