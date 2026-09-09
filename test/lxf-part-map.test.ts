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
  loadPartMap, resetPartMapCache, validatePartMap, validatePartAlign,
  buildLxfPlacements, describeLxfDiagnostics,
  PART_MAP_URL,
  type PartAlign, type LxfAlignmentTable, type LxfPartRecord,
} from '../web/src/engine/lxf-parser.js';

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
    const { bricks, diagnostics: d } = buildLxfPlacements(recs, table);
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
      table,
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
      unavailable,
    ).diagnostics;
    const msg = describeLxfDiagnostics(d);
    expect(msg).toMatch(/unavailable \(HTTP 503\)/);
    expect(msg).toMatch(/raw LDD origin/);
    expect(msg).toMatch(/Reload to retry/);
  });

  it('is silent when a fully covered model loads through a healthy table', () => {
    const ok: LxfAlignmentTable = {
      state: 'ok', source: PART_MAP_URL, entries: { 3001: ROW }, rejected: 0,
    };
    const d = buildLxfPlacements(
      [{ designID: '3001', materialId: 21, transformation: tf, boneCount: 1 }], ok,
    ).diagnostics;
    expect(describeLxfDiagnostics(d)).toBeNull();
  });
});
