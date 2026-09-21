/**
 * Tests for NLCD Tree Canopy Cover API client.
 *
 * These hit the LIVE MRLC GeoServer, so an outage must never read as a
 * regression. Two layers of defence, because each alone proved insufficient:
 * the suite probes GetCapabilities once at collection time and skips itself
 * loudly when the service is down (2026-09-20), AND each test skips at runtime
 * when its own query comes back `unavailable` — a reachable GetCapabilities did
 * NOT stop an individual GetFeatureInfo from failing and reddening CI
 * (2026-09-21, urban query null while the forested one answered).
 * `queryNlcdCanopy` now reports `status`, so "nothing here" and "could not ask"
 * are distinguishable: a `no-data` answer where data is expected still FAILS.
 */

import { afterEach, describe, it, expect, vi, type TestContext } from 'vitest';
import { MRLC_WMS_URL, queryNlcdCanopy, type NlcdCanopyResult } from '../web/src/ui/import-nlcd.js';

/** True when the WMS answers GetCapabilities with 2xx inside 8 s. */
async function mrlcReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MRLC_WMS_URL}?service=WMS&request=GetCapabilities&version=1.1.1`, {
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Evaluated at module load (top-level await), which is when `describe.skipIf`
// reads it — a flag set inside `beforeAll` would be too late.
const reachable = await mrlcReachable();
if (!reachable) console.warn('[import-nlcd.test] MRLC WMS unreachable — live canopy tests skipped');

/**
 * Abort this test, loudly, when the live service could not answer at all —
 * `ctx.skip()` THROWS, so nothing after the call runs. A `no-data` answer is
 * never skipped: that is the service working, and a real result the assertions
 * must judge.
 */
function skipIfUnavailable(result: NlcdCanopyResult, ctx: TestContext): void {
  if (result.status !== 'unavailable') return;
  console.warn('[import-nlcd.test] MRLC WMS query unavailable — this case skipped, not failed');
  ctx.skip('MRLC WMS did not answer this query');
}

describe.skipIf(!reachable)('queryNlcdCanopy (live MRLC WMS)', () => {
  it('returns canopy percentage for a forested US location', async ctx => {
    // Great Smoky Mountains — high canopy cover expected
    const result = await queryNlcdCanopy(35.6131, -83.4895);
    skipIfUnavailable(result, ctx);
    expect(result.status).toBe('ok');
    expect(result.canopyCoverPct).not.toBeNull();
    if (result.canopyCoverPct != null) {
      expect(result.canopyCoverPct).toBeGreaterThan(50);
      expect(result.canopyCoverPct).toBeLessThanOrEqual(99);
    }
  }, 15000);

  it('returns low canopy for an urban location', async ctx => {
    // Downtown Manhattan — very low canopy expected
    const result = await queryNlcdCanopy(40.7128, -74.0060);
    skipIfUnavailable(result, ctx);
    expect(result.status).toBe('ok');
    expect(result.canopyCoverPct).not.toBeNull();
    if (result.canopyCoverPct != null) {
      expect(result.canopyCoverPct).toBeLessThan(30);
    }
  }, 15000);

  it('reports no-data, not a percentage, for a location outside CONUS', async ctx => {
    // Middle of the Atlantic Ocean
    const result = await queryNlcdCanopy(30.0, -50.0);
    skipIfUnavailable(result, ctx);
    expect(result.status).toBe('no-data');
    expect(result.canopyCoverPct).toBeNull();
  }, 15000);
});

/**
 * Offline coverage for the distinction the live suite depends on. These run
 * everywhere, including when MRLC is down, so the skip logic itself is never
 * shipped untested.
 */
describe('queryNlcdCanopy status (mocked transport)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const respond = (body: unknown, ok = true) => {
    globalThis.fetch = (async () => ({ ok, json: async () => body })) as typeof fetch;
  };

  it('reports ok with the palette value the service returned', async () => {
    respond({ features: [{ properties: { PALETTE_INDEX: 72 } }] });
    await expect(queryNlcdCanopy(35.6131, -83.4895)).resolves.toEqual({ canopyCoverPct: 72, status: 'ok' });
  });
  it('reports no-data when the service answers with no feature', async () => {
    respond({ features: [] });
    await expect(queryNlcdCanopy(30, -50)).resolves.toEqual({ canopyCoverPct: null, status: 'no-data' });
  });
  it('reports no-data for a palette value outside 0-99', async () => {
    respond({ features: [{ properties: { PALETTE_INDEX: 255 } }] });
    await expect(queryNlcdCanopy(30, -50)).resolves.toEqual({ canopyCoverPct: null, status: 'no-data' });
  });
  it('reports unavailable on a non-2xx response', async () => {
    respond({}, false);
    await expect(queryNlcdCanopy(35.6131, -83.4895)).resolves.toEqual({ canopyCoverPct: null, status: 'unavailable' });
  });
  it('reports unavailable when the request throws or times out', async () => {
    globalThis.fetch = (async () => { throw new Error('timeout'); }) as typeof fetch;
    await expect(queryNlcdCanopy(35.6131, -83.4895)).resolves.toEqual({ canopyCoverPct: null, status: 'unavailable' });
  });
  it('skips a live case only for unavailable, never for no-data', () => {
    const skip = vi.fn();
    skipIfUnavailable({ canopyCoverPct: null, status: 'no-data' }, { skip } as unknown as TestContext);
    expect(skip).not.toHaveBeenCalled();
    skipIfUnavailable({ canopyCoverPct: null, status: 'unavailable' }, { skip } as unknown as TestContext);
    expect(skip).toHaveBeenCalledTimes(1);
  });
});
