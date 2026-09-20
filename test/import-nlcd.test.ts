/**
 * Tests for NLCD Tree Canopy Cover API client.
 *
 * These hit the LIVE MRLC GeoServer. `queryNlcdCanopy` answers `null` for both
 * "outside coverage" and "service unreachable", so a third-party outage read as
 * a regression and failed CI on a docs-only push (2026-09-20). The suite now
 * probes GetCapabilities once at collection time and skips itself, loudly, when
 * the service is down; the `null`-for-ocean case still runs only when it is up,
 * because that answer is indistinguishable from an outage.
 */

import { describe, it, expect } from 'vitest';
import { MRLC_WMS_URL, queryNlcdCanopy } from '../web/src/ui/import-nlcd.js';

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

describe.skipIf(!reachable)('queryNlcdCanopy (live MRLC WMS)', () => {
  it('returns canopy percentage for a forested US location', async () => {
    // Great Smoky Mountains — high canopy cover expected
    const result = await queryNlcdCanopy(35.6131, -83.4895);
    expect(result.canopyCoverPct).not.toBeNull();
    if (result.canopyCoverPct != null) {
      expect(result.canopyCoverPct).toBeGreaterThan(50);
      expect(result.canopyCoverPct).toBeLessThanOrEqual(99);
    }
  }, 15000);

  it('returns low canopy for an urban location', async () => {
    // Downtown Manhattan — very low canopy expected
    const result = await queryNlcdCanopy(40.7128, -74.0060);
    expect(result.canopyCoverPct).not.toBeNull();
    if (result.canopyCoverPct != null) {
      expect(result.canopyCoverPct).toBeLessThan(30);
    }
  }, 15000);

  it('returns null for a location outside CONUS', async () => {
    // Middle of the Atlantic Ocean
    const result = await queryNlcdCanopy(30.0, -50.0);
    expect(result.canopyCoverPct).toBeNull();
  }, 15000);
});
