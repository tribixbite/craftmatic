/**
 * Persistent part-cache identity and dependent-geometry invalidation
 * (`web/src/viewer/ldraw/parts.ts`) — audit P1 item 6.
 *
 * The risk being pinned: the IndexedDB `.dat` cache keys entries by PART NAME
 * only, so a corrected upstream part stays stale in a warm browser forever —
 * the browser never asks for it again. Cache identity is now tied to a
 * deployed library revision served at `/ldraw-parts/_rev`.
 *
 * These tests exercise the WARM path the audit specifically called out ("test a
 * warm browser after a library correction, not only an incognito session"): the
 * fake IndexedDB survives `vi.resetModules()`, so each case is a fresh page
 * session against a database that was already populated.
 *
 * The honesty invariant matters as much as the invalidation: an UNKNOWN
 * revision (no endpoint, offline, malformed body) must NEVER be treated as a
 * change. Guessing "changed" on a network blip throws away a warm cache and
 * re-downloads the whole library on the worst connections.
 *
 * Offline + deterministic: `fetch` is mocked to serve synthetic `.dat` text and
 * the revision endpoint; no network, no GPU, no DOM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeIdb, FAKE_IDB_NAME, FAKE_IDB_STORE, type FakeIdb } from './_fake-idb.js';

/** One LDraw triangle; `n` of them makes a distinguishable part definition. */
const tris = (n: number): string =>
  ['0 BFC CERTIFY CCW', ...Array.from({ length: n }, (_, i) =>
    `3 16 ${i} 0 0  10 0 0  0 0 10`)].join('\n');

interface MockOptions {
  /** Body for `/ldraw-parts/_rev`, or 'missing' / 'throw' for the failure modes. */
  rev: string | 'missing' | 'throw';
  /** stem (no `.dat`) → file text. Anything else 404s. */
  files: Record<string, string>;
}

let partFetches: string[] = [];
let realFetch: typeof globalThis.fetch;

function mockFetch(opts: MockOptions): void {
  globalThis.fetch = (async (url: string | URL) => {
    const s = String(url);
    if (s.includes('/_rev')) {
      if (opts.rev === 'throw') throw new Error('network down');
      if (opts.rev === 'missing') return new Response('', { status: 404 });
      return new Response(JSON.stringify({ rev: opts.rev }), { status: 200 });
    }
    // The micro-batch endpoint is absent in this harness (as it is behind an
    // older worker): two failures disable batching and the classic per-path
    // probing takes over, which is the path these tests care about.
    if (s.includes('/_batch')) return new Response('', { status: 404 });
    const stem = s.split('/').pop()!.replace(/\.dat$/i, '');
    partFetches.push(stem);
    const text = opts.files[stem];
    return text === undefined
      ? new Response('', { status: 404 })
      : new Response(text, { status: 200 });
  }) as typeof globalThis.fetch;
}

/** A fresh page session against the SAME database. */
async function freshSession(): Promise<typeof import('../web/src/viewer/ldraw/parts.js')> {
  vi.resetModules();
  partFetches = [];
  return import('../web/src/viewer/ldraw/parts.js');
}

const REV_KEY = 'v1:__meta:library-rev';

describe('persistent .dat cache is versioned by the deployed library revision', () => {
  let idb: FakeIdb;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    idb = installFakeIdb(FAKE_IDB_NAME, FAKE_IDB_STORE);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    idb.uninstall();
  });

  it('serves a warm cache without refetching when the revision is unchanged', async () => {
    const store = idb.records(FAKE_IDB_STORE);
    store.set('v1:revtest-same', tris(1));
    store.set(REV_KEY, 'rev-A');

    mockFetch({ rev: 'rev-A', files: {} }); // network has NOTHING: cache or bust
    const { resolvePartGeometry, partCacheRevision } = await freshSession();

    const geom = await resolvePartGeometry('revtest-same');
    expect(geom.tris.length, 'must come from the persistent cache').toBe(1);
    expect(partFetches, 'an unchanged revision must not refetch').toEqual([]);
    expect(partCacheRevision()).toEqual({ format: 'v1', library: 'rev-A' });
    expect(store.get(REV_KEY)).toBe('rev-A');
  });

  it('clears the cache and refetches after a library correction (warm browser)', async () => {
    const store = idb.records(FAKE_IDB_STORE);
    store.set('v1:revtest-fixed', tris(1)); // the STALE, pre-correction bytes
    store.set('v1:revtest-other', tris(1)); // an unrelated warm entry
    store.set(REV_KEY, 'rev-A');

    // The deployment now serves rev-B, and the corrected part has 3 triangles.
    mockFetch({ rev: 'rev-B', files: { 'revtest-fixed': tris(3) } });
    const { resolvePartGeometry, partCacheRevision } = await freshSession();

    const geom = await resolvePartGeometry('revtest-fixed');
    expect(geom.tris.length, 'the CORRECTED part must render, not the cached one').toBe(3);
    expect(partFetches, 'the corrected part must actually be refetched').toContain('revtest-fixed');
    expect(store.has('v1:revtest-other'), 'the whole store is dropped, not one key').toBe(false);
    expect(store.get(REV_KEY), 'the new revision is recorded').toBe('rev-B');
    expect(partCacheRevision().library).toBe('rev-B');
    // And the refetched text is persisted under the new revision.
    expect(store.get('v1:revtest-fixed')).toBe(tris(3));
  });

  it('keeps the cache when the revision is UNKNOWN (endpoint absent)', async () => {
    const store = idb.records(FAKE_IDB_STORE);
    store.set('v1:revtest-unknown', tris(2));
    store.set(REV_KEY, 'rev-B');

    mockFetch({ rev: 'missing', files: {} });
    const { resolvePartGeometry, partCacheRevision } = await freshSession();

    const geom = await resolvePartGeometry('revtest-unknown');
    expect(geom.tris.length, 'a 404 on /_rev must not evict anything').toBe(2);
    expect(partFetches).toEqual([]);
    expect(store.get(REV_KEY), 'nothing is recorded for an unknown revision').toBe('rev-B');
    expect(partCacheRevision().library, 'unknown is reported as unknown, not guessed').toBeNull();
  });

  it('keeps the cache when the revision probe THROWS (offline / timeout)', async () => {
    const store = idb.records(FAKE_IDB_STORE);
    store.set('v1:revtest-offline', tris(2));
    store.set(REV_KEY, 'rev-B');

    mockFetch({ rev: 'throw', files: {} });
    const { resolvePartGeometry } = await freshSession();

    expect((await resolvePartGeometry('revtest-offline')).tris.length).toBe(2);
    expect(partFetches).toEqual([]);
    expect(store.get(REV_KEY)).toBe('rev-B');
  });

  it('clears once on adoption, when cached entries predate revision tracking', async () => {
    const store = idb.records(FAKE_IDB_STORE);
    store.set('v1:revtest-legacy', tris(1)); // entries, but no recorded revision
    expect(store.has(REV_KEY)).toBe(false);

    mockFetch({ rev: 'rev-C', files: { 'revtest-legacy': tris(4) } });
    const { resolvePartGeometry } = await freshSession();

    const geom = await resolvePartGeometry('revtest-legacy');
    expect(geom.tris.length,
      'provenance-unknown entries cannot be shown to match the served library').toBe(4);
    expect(store.get(REV_KEY)).toBe('rev-C');
  });

  it('probes the revision at most once per session', async () => {
    idb.records(FAKE_IDB_STORE).set(REV_KEY, 'rev-D');
    let revHits = 0;
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const s = String(url);
      if (s.includes('/_rev')) { revHits++; return new Response(JSON.stringify({ rev: 'rev-D' }), { status: 200 }); }
      if (s.includes('/_batch')) return new Response('', { status: 404 });
      const stem = s.split('/').pop()!.replace(/\.dat$/i, '');
      return stem === 'revtest-once'
        ? new Response(tris(1), { status: 200 })
        : new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const { resolvePartGeometry, primePartCache } = await freshSession();
    await primePartCache();
    await resolvePartGeometry('revtest-once');
    await resolvePartGeometry('revtest-once-b');
    expect(revHits, 'one probe per page session, not one per part').toBe(1);
  });

  it('degrades to no persistent cache (and no probe) without IndexedDB', async () => {
    idb.uninstall();
    (globalThis as unknown as { indexedDB?: unknown }).indexedDB = undefined;
    let revHits = 0;
    globalThis.fetch = (async (url: string | URL) => {
      const s = String(url);
      if (s.includes('/_rev')) { revHits++; return new Response('{"rev":"x"}', { status: 200 }); }
      if (s.includes('/_batch')) return new Response('', { status: 404 });
      const stem = s.split('/').pop()!.replace(/\.dat$/i, '');
      return stem === 'revtest-noidb'
        ? new Response(tris(1), { status: 200 })
        : new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const { resolvePartGeometry, partCacheRevision } = await freshSession();
    expect((await resolvePartGeometry('revtest-noidb')).tris.length).toBe(1);
    expect(revHits, 'nothing to version → no probe request at all').toBe(0);
    expect(partCacheRevision()).toEqual({ format: 'v1', library: null });
  });
});

describe('assembled geometry is invalidated when a child definition changes', () => {
  beforeEach(() => {
    realFetch = globalThis.fetch;
    (globalThis as unknown as { indexedDB?: unknown }).indexedDB = undefined;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  /**
   * The leak this pins: `resolvePartGeometry` FLATTENS a sub-file's triangles
   * into its parent and caches the result, so dropping only the child's entry
   * leaves the parent holding the old child. A Studio `.io` ships
   * `CustomParts/` containing the exact primitives its modified parts need —
   * names ordinary library parts also reference — so without transitive
   * invalidation model A's primitive stays baked inside a SHARED part while
   * model B renders.
   */
  it('rebuilds a parent when a custom part redefines its child, and again when cleared', async () => {
    mockFetch({
      rev: 'missing',
      files: {
        'leakchild': tris(1),                                   // library definition
        'leakparent': `0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 leakchild.dat`,
      },
    });
    const { resolvePartGeometry, preloadDatTexts, clearMpdInlines } = await freshSession();

    expect((await resolvePartGeometry('leakparent')).tris.length,
      'baseline: the parent renders the library child').toBe(1);

    // Model A loads and brings its own definition of that name.
    preloadDatTexts(new Map([['CustomParts/leakchild.dat', tris(5)]]));
    expect((await resolvePartGeometry('leakparent')).tris.length,
      'the parent must be rebuilt from the redefined child').toBe(5);

    // Model A is unloaded; model B must NOT inherit model A's definition.
    clearMpdInlines();
    expect((await resolvePartGeometry('leakparent')).tris.length,
      'custom parts must not leak into the next model through a cached parent').toBe(1);
  });

  it('propagates through a chain of parents (grandparent included)', async () => {
    mockFetch({
      rev: 'missing',
      files: {
        'chainchild': tris(1),
        'chainmid': `0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 chainchild.dat`,
        'chaintop': `0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 chainmid.dat`,
      },
    });
    const { resolvePartGeometry, preloadDatTexts, clearMpdInlines } = await freshSession();

    expect((await resolvePartGeometry('chaintop')).tris.length).toBe(1);
    preloadDatTexts(new Map([['CustomParts/chainchild.dat', tris(3)]]));
    expect((await resolvePartGeometry('chaintop')).tris.length,
      'invalidation must reach the grandparent, not stop at the direct parent').toBe(3);
    clearMpdInlines();
    expect((await resolvePartGeometry('chaintop')).tris.length).toBe(1);
  });

  it('invalidatePartGeom() is transitive too', async () => {
    mockFetch({
      rev: 'missing',
      files: {
        'invchild': tris(1),
        'invparent': `0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 invchild.dat`,
      },
    });
    const { resolvePartGeometry, invalidatePartGeom, getCachedPartGeom } = await freshSession();

    await resolvePartGeometry('invparent');
    expect(getCachedPartGeom('invparent')).toBeDefined();
    invalidatePartGeom('invchild');
    expect(getCachedPartGeom('invparent'),
      'a parent that baked in the repaired child must be rebuilt as well').toBeUndefined();
  });
});
