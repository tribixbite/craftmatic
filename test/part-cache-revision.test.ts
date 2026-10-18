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
  /**
   * stem → ms before that file's response resolves (default 0). Lets a test
   * pin an INTERLEAVING of two concurrent resolutions rather than hoping for
   * one — the concurrent-prefetch race needs a specific one.
   */
  delayMs?: Record<string, number>;
  /**
   * Stems whose every candidate path answers `503` — production's signature
   * for an upstream-throttled part (`worker/ldraw-omr.js` relays an upstream
   * 5xx as `503 no-store` so the client retries instead of caching a miss).
   * The file may still exist in `files`; the point is that this LOAD cannot
   * have it.
   */
  transient?: string[];
  /**
   * Serve `/ldraw-parts/_batch` as an empty-but-valid answer (`{found:{}}`),
   * i.e. "the mirror has none of these" — production's behaviour for
   * unmirrored names. It puts the resolver on its single-volley path instead
   * of the retry-with-backoff ladder, which is what prod actually does.
   */
  batchOk?: boolean;
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
    if (s.includes('/_batch')) {
      return opts.batchOk
        ? new Response(JSON.stringify({ found: {}, missing: [] }), { status: 200 })
        : new Response('', { status: 404 });
    }
    const stem = s.split('/').pop()!.replace(/\.dat$/i, '');
    partFetches.push(stem);
    if (opts.transient?.includes(stem)) return new Response('', { status: 503 });
    const delay = opts.delayMs?.[stem] ?? 0;
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
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

  /**
   * The viewer's repair pass invalidates every part that resolved EMPTY and
   * then re-resolves it sequentially. Transitive invalidation silently broke
   * that contract: it also dropped ancestors, which the pass never rebuilt, so
   * they read back as missing parts. Measured on 71043 — all 25 placements of
   * `90398` vanished — and fixed by having the pass rebuild everything the
   * call REPORTS dropping. That return value is the contract.
   */
  it('invalidatePartGeom() is transitive AND reports every key it dropped', async () => {
    mockFetch({
      rev: 'missing',
      files: {
        'invchild': tris(1),
        'invparent': `0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 invchild.dat`,
        'invtop': `0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 invparent.dat`,
      },
    });
    const { resolvePartGeometry, invalidatePartGeom, getCachedPartGeom } = await freshSession();

    await resolvePartGeometry('invtop');
    expect(getCachedPartGeom('invparent')).toBeDefined();
    expect(getCachedPartGeom('invtop')).toBeDefined();

    const dropped = invalidatePartGeom('invchild');
    expect(getCachedPartGeom('invparent'),
      'a parent that baked in the repaired child must be rebuilt as well').toBeUndefined();
    expect(getCachedPartGeom('invtop')).toBeUndefined();
    expect(new Set(dropped),
      'a caller that invalidates in order to REBUILD needs the whole set back')
      .toEqual(new Set(['invchild', 'invparent', 'invtop']));
  });
});

/**
 * The viewer's repair pass (`repairIncompleteGeometry`), which puts back the
 * geometry the CONCURRENT prefetch loses.
 *
 * The defect it exists for, measured in the browser across 18 sets: 19 minifigs
 * rendered with one arm. `982` (Arm Right) is `982 → 3818 → s\3818s01`; `981`
 * (Arm Left) is one hop deeper, `981 → 3819 → 3818 → s\3818s01`. Resolving both
 * at once let `981`'s chain read `3818`'s cache PLACEHOLDER while `982`'s chain
 * still had it in flight, so `3819` and `981` both cached empty — and a repair
 * that re-resolved only `981` rebuilt it from the still-empty `3819`, forever.
 */
describe('repairIncompleteGeometry() rebuilds parts emptied by the prefetch race', () => {
  beforeEach(() => {
    realFetch = globalThis.fetch;
    (globalThis as unknown as { indexedDB?: unknown }).indexedDB = undefined;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  /** `1 16 <identity> <child>.dat` — one sub-file reference, no transform. */
  const ref = (child: string): string =>
    `1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${child}.dat`;

  it('repairs a 3-hop chain whose middle link raced (the 981 minifig arm)', async () => {
    // Delays pin the interleaving: `armbase` is in flight (placeholder cached,
    // waiting on the slow `armsub`) from ~5ms to ~205ms, and the deeper chain
    // reaches it at ~65ms — exactly the browser race, deterministically.
    mockFetch({
      rev: 'missing',
      delayMs: { armsub: 200, armmirror: 60 },
      files: {
        armsub: tris(4),                                       // the real geometry
        armbase: `0 BFC CERTIFY CCW\n${ref('armsub')}`,        // 3818
        armmirror: `0 BFC CERTIFY CCW\n${ref('armbase')}`,     // 3819
        armleft: `0 ~Moved to armmirror\n${ref('armmirror')}`, // 981  (3 hops)
        armright: `0 ~Moved to armbase\n${ref('armbase')}`,    // 982  (2 hops)
      },
    });
    const { resolvePartGeometry, repairIncompleteGeometry, getCachedPartGeom } =
      await freshSession();

    // The prefetch, exactly as the viewer runs it: every unique part at once.
    const uniqueParts = ['armright', 'armleft'];
    await Promise.all(uniqueParts.map(p => resolvePartGeometry(p)));
    expect(getCachedPartGeom('armright')?.tris.length,
      'the shallow arm wins the race and is fine').toBe(4);
    expect(getCachedPartGeom('armleft')?.tris.length,
      'precondition: the deep arm lost the race and cached EMPTY').toBe(0);
    expect(getCachedPartGeom('armmirror')?.tris.length,
      'and so did its middle link, which is what one repair round cannot see').toBe(0);

    const report = await repairIncompleteGeometry(uniqueParts);
    expect(getCachedPartGeom('armleft')?.tris.length,
      'the deep arm must render after repair — this is the one-armed minifig').toBe(4);
    expect(getCachedPartGeom('armmirror')?.tris.length,
      'repair has to reach DOWN to the empty middle link, not just retry the top').toBe(4);
    expect(report.repaired).toEqual(['armleft']);
    expect(report.stillEmpty).toEqual([]);
  });

  it('rebuilds the ancestors it drops, so a repair cannot create a missing part', async () => {
    // The 71043 regression in reverse: invalidation is transitive UPWARD, so a
    // part holding a baked copy of an empty descendant is dropped too. Leaving
    // it unbuilt is what cost 71043 all 25 placements of `90398`.
    mockFetch({
      rev: 'missing',
      files: {
        ancshared: tris(2),
        ancempty: `0 BFC CERTIFY CCW\n${ref('ancnosuchfile')}`, // renders nothing, ever
        anctop: `0 BFC CERTIFY CCW\n${ref('ancempty')}\n${ref('ancshared')}`,
      },
    });
    const { resolvePartGeometry, repairIncompleteGeometry, getCachedPartGeom } =
      await freshSession();

    const uniqueParts = ['anctop', 'ancempty'];
    await Promise.all(uniqueParts.map(p => resolvePartGeometry(p)));
    expect(getCachedPartGeom('anctop')?.tris.length).toBe(2);

    const report = await repairIncompleteGeometry(uniqueParts);
    expect(getCachedPartGeom('anctop')?.tris.length,
      'the ancestor dropped by the repair must be rebuilt, not left absent').toBe(2);
    expect(report.stillEmpty,
      'a genuinely unrenderable part is reported, not silently retried').toEqual(['ancempty']);
    expect(report.repaired).toEqual([]);
    expect(report.passes,
      'a pass that repairs nothing is the fixed point — it must not burn the cap').toBe(1);
  });

  it('does not mistake a pure-EDGE primitive for damage', async () => {
    // Measured on 910032: counting only triangles made healthy edge-only
    // primitives (`4-4edge` and friends) look empty, so the walk dropped them
    // AND their whole ancestor closure — hundreds of parts re-resolved, and
    // the arm the pass existed to repair came back empty anyway.
    mockFetch({
      rev: 'missing',
      files: {
        edgeprim: ['0 BFC CERTIFY CCW', '2 24 0 0 0 10 0 0'].join('\n'), // edges, no tris
        edgeuser: [tris(3), ref('edgeprim')].join('\n'),                 // healthy ancestor
        edgeseed: ['0 BFC CERTIFY CCW', ref('edgeprim')].join('\n'),     // 0 tris → a seed
      },
    });
    const { resolvePartGeometry, repairIncompleteGeometry, getCachedPartGeom } =
      await freshSession();

    const uniqueParts = ['edgeuser', 'edgeseed'];
    await Promise.all(uniqueParts.map(p => resolvePartGeometry(p)));
    const userBefore = getCachedPartGeom('edgeuser');
    const primBefore = getCachedPartGeom('edgeprim');

    const report = await repairIncompleteGeometry(uniqueParts);
    expect(getCachedPartGeom('edgeprim'),
      'an edge primitive has geometry — it must not be dropped').toBe(primBefore);
    expect(getCachedPartGeom('edgeuser'),
      'and neither must every part that references one').toBe(userBefore);
    expect(report.passes, 'nothing to repair → one pass proves it and stops').toBe(1);
  });

  /**
   * The 2026-09-18 production stall, in one deterministic case.
   *
   * A part whose every candidate path answers `503` is deliberately left
   * UNCACHED (a throttle must not be recorded as a missing part), so nothing
   * memoises the failure. The repair pass then re-resolved it — and it walks
   * its keys SEQUENTIALLY, with no progress reporting — so on production, where
   * a cold load sees dozens of throttled names, the load sat on
   * `Loading geometry: N/N parts (100%)` for minutes with the source badge
   * frozen at `loading…`. Users read that as "it never loads"; a second click
   * worked because by then the throttle window had passed.
   *
   * The invariant: the repair pass rebuilds from what this load already
   * downloaded. It never goes back to the network.
   */
  it('does not re-probe the network for a part whose text failed transiently', async () => {
    mockFetch({
      rev: 'missing',
      batchOk: true,
      transient: ['throttledpart'],
      files: {
        throttledpart: tris(4),                                 // exists, but 503s today
        holderpart: `0 BFC CERTIFY CCW\n${ref('throttledpart')}`,
      },
    });
    const { resolvePartGeometry, repairIncompleteGeometry } = await freshSession();
    await resolvePartGeometry('holderpart');
    expect(partFetches, 'the prefetch DOES try the throttled name').toContain('throttledpart');

    const duringPrefetch = partFetches.length;
    const report = await repairIncompleteGeometry(['holderpart', 'throttledpart']);
    expect(partFetches.slice(duringPrefetch),
      'the repair pass must rebuild from cache only — re-probing a throttled '
      + 'name here is what froze production loads for minutes').toEqual([]);
    expect(report.stillEmpty, 'and it stays honestly reported as unrenderable')
      .toContain('throttledpart');
  });

  it('drops a partial parent before the next load so a recovered 503 child returns', async () => {
    mockFetch({
      rev: 'missing',
      batchOk: true,
      transient: ['recoverchild'],
      files: {
        recoverchild: tris(4),
        recoverparent: `${tris(1)}\n${ref('recoverchild')}`,
      },
    });
    const {
      resolvePartGeometry,
      repairIncompleteGeometry,
      clearTransientMisses,
      transientMissNames,
      unresolvedDatNames,
    } = await freshSession();

    expect((await resolvePartGeometry('recoverparent')).tris.length,
      'precondition: the parent keeps its own triangle but loses the 503 child').toBe(1);
    const report = await repairIncompleteGeometry(['recoverparent']);
    expect(report.passes,
      'a non-empty partial parent is not a repair seed during the same throttle').toBe(0);
    expect(transientMissNames(),
      'the partial hole must be available to viewer diagnostics').toContain('recoverchild');
    expect(unresolvedDatNames,
      'a transient outage must not be mislabeled or cached as a definitive miss')
      .not.toContain('recoverchild');

    // Next load: the upstream throttle has cleared. Its reset must evict the
    // partial parent, not merely forget the transient name.
    mockFetch({
      rev: 'missing',
      batchOk: true,
      files: {
        recoverchild: tris(4),
        recoverparent: `${tris(1)}\n${ref('recoverchild')}`,
      },
    });
    clearTransientMisses();
    expect((await resolvePartGeometry('recoverparent')).tris.length,
      'the recovered child must be folded into a rebuilt parent').toBe(5);
    expect(transientMissNames()).toEqual([]);
  });

  it('caps its passes so an unrenderable part cannot loop forever', async () => {
    mockFetch({ rev: 'missing', files: { capempty: '0 BFC CERTIFY CCW' } });
    const { resolvePartGeometry, repairIncompleteGeometry } = await freshSession();
    await resolvePartGeometry('capempty');
    const report = await repairIncompleteGeometry(['capempty'], { maxPasses: 3 });
    expect(report.passes).toBeLessThanOrEqual(3);
    expect(report.stillEmpty).toEqual(['capempty']);
  });
});
