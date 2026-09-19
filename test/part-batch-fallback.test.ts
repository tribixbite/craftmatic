/**
 * The `/ldraw-parts/_batch` fast path and how it reacts to failure
 * (`web/src/viewer/ldraw/parts.ts`).
 *
 * Why this suite exists: the batch endpoint resolves a whole set's parts in a
 * handful of requests, and the fallback — probing every candidate path of
 * every part, ending at the `models/<stem>.dat` last resort that only ever
 * 404s — is roughly 4x the requests. Disabling the fast path for the rest of
 * the session is therefore only ever right when the endpoint genuinely is not
 * served here. Doing it on a TIMEOUT is a cure worse than the disease, and it
 * was observed: two `_batch` timeouts during one slow dev load left 329 of 338
 * part fetches timing out and the model reported "No 3D model found"
 * (measured 2026-09-19).
 *
 * So the split under test is the same one `fetchDatText` already makes for
 * parts: a REAL HTTP answer is definitive, a THROWN fetch is transient.
 *
 * Offline and deterministic — `fetch` is mocked, no IndexedDB, no DOM.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** One LDraw triangle, enough to make a resolvable part definition. */
const TRI = '0 BFC CERTIFY CCW\n3 16 0 0 0  10 0 0  0 0 10';

interface Call { url: string }

/** How the mocked `_batch` endpoint behaves for a given call index. */
type BatchBehaviour = 'ok' | 'throw' | 'status404' | 'html200';

let calls: Call[] = [];
let realFetch: typeof globalThis.fetch;

/**
 * Mock `fetch`. `batch` is consumed one entry per `_batch` request; once it
 * runs out the last entry repeats. Every `parts/<stem>.dat` path serves TRI so
 * the per-path fallback can still succeed — the assertions are about HOW MANY
 * requests were made and what the module now believes, not about failure to
 * render.
 */
function mockFetch(batch: BatchBehaviour[]): void {
  let i = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const s = String(url);
    calls.push({ url: s });
    if (s.includes('/_rev')) return new Response('', { status: 404 });
    if (s.includes('/_batch')) {
      const mode = batch[Math.min(i++, batch.length - 1)]!;
      if (mode === 'throw') throw new DOMException('signal timed out', 'TimeoutError');
      if (mode === 'status404') return new Response('', { status: 404 });
      if (mode === 'html200') return new Response('<!doctype html><html></html>', { status: 200 });
      const files = new URL(s, 'http://x').searchParams.get('files') ?? '';
      const found: Record<string, string> = {};
      for (const rel of files.split(',')) if (/^parts\//.test(rel)) found[rel] = TRI;
      return new Response(JSON.stringify({ found, missing: [] }), { status: 200 });
    }
    return /\/parts\/[^/]+\.dat$/.test(s)
      ? new Response(TRI, { status: 200 })
      : new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
}

/** A fresh module instance, so the batch state starts from its defaults. */
async function freshSession(): Promise<typeof import('../web/src/viewer/ldraw/parts.js')> {
  vi.resetModules();
  calls = [];
  return import('../web/src/viewer/ldraw/parts.js');
}

const batchCalls = (): number => calls.filter(c => c.url.includes('/_batch')).length;

describe('the _batch fast path distinguishes a missing endpoint from a slow one', () => {
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

  it('keeps using the batch endpoint while it answers', async () => {
    mockFetch(['ok']);
    const { resolvePartGeometry, __batchStateForTests } = await freshSession();

    await resolvePartGeometry('batch-live-a');
    await resolvePartGeometry('batch-live-b');

    expect(batchCalls(), 'each part resolves through its own batch volley').toBe(2);
    expect(__batchStateForTests()).toEqual({ absent: false, parkedMs: 0, failures: 0 });
  });

  it('gives up permanently only when the endpoint answers with a status', async () => {
    mockFetch(['status404']);
    const { resolvePartGeometry, __batchStateForTests } = await freshSession();

    await resolvePartGeometry('batch-gone-a');
    expect(__batchStateForTests().absent, 'one status is not yet proof').toBe(false);
    await resolvePartGeometry('batch-gone-b');
    expect(__batchStateForTests().absent, 'two statuses are').toBe(true);

    const before = batchCalls();
    await resolvePartGeometry('batch-gone-c');
    expect(batchCalls(), 'no further batch requests once absent').toBe(before);
  });

  it('treats a 200 that is not the documented JSON as a missing endpoint', async () => {
    // An older worker answers every unknown route with the SPA shell.
    mockFetch(['html200']);
    const { resolvePartGeometry, __batchStateForTests } = await freshSession();

    await resolvePartGeometry('batch-html-a');
    await resolvePartGeometry('batch-html-b');

    expect(__batchStateForTests().absent).toBe(true);
    expect(__batchStateForTests().parkedMs, 'not a transient park').toBe(0);
  });

  it('parks — never disables — the fast path when the request times out', async () => {
    mockFetch(['throw', 'throw', 'throw']);
    const { resolvePartGeometry, __batchStateForTests } = await freshSession();

    await resolvePartGeometry('batch-slow-a');
    await resolvePartGeometry('batch-slow-b');
    await resolvePartGeometry('batch-slow-c');

    const state = __batchStateForTests();
    expect(state.absent, 'a timeout must never be read as "no endpoint here"').toBe(false);
    expect(state.parkedMs, 'parked, with a retry ahead').toBeGreaterThan(0);
    expect(state.parkedMs).toBeLessThanOrEqual(5_000);
  });

  it('returns to the fast path by itself once the park expires', async () => {
    mockFetch(['throw', 'ok']);
    const { resolvePartGeometry, __batchStateForTests } = await freshSession();

    await resolvePartGeometry('batch-recover-a');
    expect(__batchStateForTests().parkedMs).toBeGreaterThan(0);

    const parked = batchCalls();
    await resolvePartGeometry('batch-recover-b');
    expect(batchCalls(), 'while parked, no batch request is made').toBe(parked);

    // Advance past the 5 s park. Fake timers are installed only now, so the
    // awaits above ran on the real clock; from here the batch's own 20 ms
    // aggregation timer has to be advanced by hand, which is why the
    // resolution is driven rather than simply awaited.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_001);
    const pending = resolvePartGeometry('batch-recover-c');
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    vi.useRealTimers();
    expect(batchCalls(), 'the fast path comes back without a reload').toBe(parked + 1);
    expect(__batchStateForTests()).toEqual({ absent: false, parkedMs: 0, failures: 0 });
  });
});
