import { describe, it, expect } from 'vitest';
import {
  captureStreetView,
  classifyOcclusion,
  computeDirectionBearings,
  fetchFacadeSv,
  offsetPoint,
  type StreetViewFetchers,
} from './streetview.js';
import type { CaptureProfile, BuildingContext } from '../context/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function synthImage(r: number, g: number, b: number, side = 16): import('./streetview.js').SvImageFetch {
  // Populate pre-decoded RGBA so tests don't need sharp (sharp is unavailable in Termux vitest)
  const rgba = new Uint8Array(side * side * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  return { bytes: new Uint8Array(0), width: side, height: side, rgba };
}

function baseProfile(overrides: Partial<CaptureProfile['streetview']> = {}): CaptureProfile['streetview'] {
  return {
    dirCount: 4,
    offsetM: 30,
    maxPanoDistM: 80,
    angleVariants: [-15, 0, 15],
    minBuildingPixelRatio: 0.2,
    pitchDeg: 10,
    ...overrides,
  };
}

const CENTER = { lat: 40.7414, lon: -73.9895 };
const CTX_MBR: Pick<BuildingContext, 'center' | 'mbr' | 'svDifficulty'> = {
  center: { lat: CENTER.lat, lng: CENTER.lon },
  mbr: {
    rotationDeg: 0,
    widthM: 60, depthM: 40,
    corners: [CENTER, CENTER, CENTER, CENTER],
  },
  svDifficulty: 'suburban',
};

// ─── Geo primitives ─────────────────────────────────────────────────────────

describe('computeDirectionBearings', () => {
  it('returns evenly spaced bearings starting from rotationDeg', () => {
    expect(computeDirectionBearings(4, 0)).toEqual([0, 90, 180, 270]);
    expect(computeDirectionBearings(2, 45)).toEqual([45, 225]);
  });
  it('returns [] for dirCount=0', () => {
    expect(computeDirectionBearings(0, 0)).toEqual([]);
  });
});

describe('offsetPoint', () => {
  it('30m north from 40.7 lat is ~0.00027° north', () => {
    const p = offsetPoint(40.7, -73.9, 0, 30);
    expect(p.lat - 40.7).toBeCloseTo(30 / 111_111, 5);
    expect(Math.abs(p.lng - (-73.9))).toBeLessThan(1e-6);
  });
});

describe('classifyOcclusion', () => {
  it('none when clear building view', () => {
    expect(classifyOcclusion(
      { sky: 0.2, veg: 0.05, building: 0.75 },
      { sky: 0.2, veg: 0.05, building: 0.75 },
      0, 0, 0.2,
    )).toBe('none');
  });
  it('trees when veg ≥ 0.30 in best variant', () => {
    expect(classifyOcclusion(
      { sky: 0.0, veg: 0.5, building: 0.5 },
      { sky: 0.0, veg: 0.4, building: 0.6 },
      0, 30, 0.2,
    )).toBe('trees');
  });
  it('adjacent-building when heading shift >= 20° cleared the primary', () => {
    expect(classifyOcclusion(
      { sky: 0.1, veg: 0.0, building: 0.3 },
      { sky: 0.1, veg: 0.0, building: 0.6 },
      0, 30, 0.5,
    )).toBe('adjacent-building');
  });
  it('poles fallback', () => {
    expect(classifyOcclusion(
      { sky: 0.4, veg: 0.0, building: 0.1 },
      { sky: 0.4, veg: 0.0, building: 0.15 },
      0, 0, 0.5,
    )).toBe('poles');
  });
});

// ─── fetchFacadeSv with stubbed fetchers ────────────────────────────────────

describe('fetchFacadeSv', () => {
  it('returns null when metadata probes all fail', async () => {
    const fetchers: StreetViewFetchers = {
      metadata: async () => null,
      image: async () => ({ bytes: new Uint8Array(), width: 0, height: 0 }),
    };
    const result = await fetchFacadeSv({
      fetchers, center: { lat: CENTER.lat, lng: CENTER.lon },
      bearing: 0, facadeEdge: 0, facadeWidthM: 40, profile: baseProfile(),
    });
    expect(result).toBeNull();
  });

  it('accepts the 0.5× offset probe when 1.0× returns pano too far', async () => {
    let calls = 0;
    const fetchers: StreetViewFetchers = {
      metadata: async (lat, lng) => {
        calls++;
        if (calls === 1) {
          // 1× offset — return far pano (> maxPanoDistM of 80m → reject)
          return { panoId: 'far', panoLat: lat + 0.001, panoLng: lng };
        }
        // 2nd call (0.5× offset) — close pano
        return { panoId: 'near', panoLat: lat, panoLng: lng };
      },
      image: async () => synthImage(128, 128, 128),
    };
    const result = await fetchFacadeSv({
      fetchers, center: { lat: CENTER.lat, lng: CENTER.lon },
      bearing: 0, facadeEdge: 0, facadeWidthM: 40, profile: baseProfile(),
    });
    expect(result?.panoId).toBe('near');
  });

  it('tries angleVariants when primary is occluded', async () => {
    let imageCalls = 0;
    const fetchers: StreetViewFetchers = {
      metadata: async (lat, lng) => ({ panoId: 'p', panoLat: lat, panoLng: lng }),
      image: async () => {
        imageCalls++;
        // First two calls (primary + first variant): veg-heavy
        // Third call: clear building
        return imageCalls <= 2
          ? synthImage(34, 139, 34)   // forest green → veg
          : synthImage(128, 128, 128); // grey → building
      },
    };
    const result = await fetchFacadeSv({
      fetchers,
      center: { lat: CENTER.lat, lng: CENTER.lon },
      bearing: 0, facadeEdge: 0, facadeWidthM: 40,
      profile: baseProfile({ angleVariants: [-15, 0, 15, 30] }),
    });
    expect(imageCalls).toBeGreaterThan(1);
    expect(result?.occlusion).not.toBe('trees');
    expect(result?.sniff.building).toBeGreaterThan(0.8);
  });
});

// ─── captureStreetView orchestrator ────────────────────────────────────────

describe('captureStreetView', () => {
  it('skips entirely when dirCount is 0 (no-coverage profile)', async () => {
    const fetchers: StreetViewFetchers = {
      metadata: async () => { throw new Error('should not be called'); },
      image: async () => { throw new Error('should not be called'); },
    };
    const profile: CaptureProfile = {
      tiles: { radiusM: 40, errorTarget: 2, verticalBands: 1, cameraMode: 'perspective', expectedHeightM: 15 },
      streetview: baseProfile({ dirCount: 0 }),
      satellite: { scale: 1, maskTrees: false },
    };
    const result = await captureStreetView({ ctx: CTX_MBR, profile, fetchers });
    expect(result).toEqual([]);
  });

  it('captures 4 directions when dirCount=4', async () => {
    const fetchers: StreetViewFetchers = {
      metadata: async (lat, lng) => ({ panoId: `p-${lat.toFixed(5)}-${lng.toFixed(5)}`, panoLat: lat, panoLng: lng }),
      image: async () => synthImage(220, 190, 140),
    };
    const profile: CaptureProfile = {
      tiles: { radiusM: 40, errorTarget: 2, verticalBands: 1, cameraMode: 'perspective', expectedHeightM: 15 },
      streetview: baseProfile({ dirCount: 4 }),
      satellite: { scale: 1, maskTrees: false },
    };
    const result = await captureStreetView({ ctx: CTX_MBR, profile, fetchers });
    expect(result.length).toBe(4);
    for (const f of result) {
      expect(f.panoId).toBeDefined();
      expect(f.sniff.building).toBeGreaterThan(0.8);
    }
  });

  it('tolerates some directions failing (metadata null)', async () => {
    let calls = 0;
    const fetchers: StreetViewFetchers = {
      metadata: async (lat, lng) => {
        calls++;
        // Fail all probes on directions 2 and 3 (3 probes each)
        if (calls >= 7) return null;
        return { panoId: `p-${calls}`, panoLat: lat, panoLng: lng };
      },
      image: async () => synthImage(220, 190, 140),
    };
    const profile: CaptureProfile = {
      tiles: { radiusM: 40, errorTarget: 2, verticalBands: 1, cameraMode: 'perspective', expectedHeightM: 15 },
      streetview: baseProfile({ dirCount: 4 }),
      satellite: { scale: 1, maskTrees: false },
    };
    const result = await captureStreetView({ ctx: CTX_MBR, profile, fetchers });
    // At least the first 2 directions should succeed (3 probes × 2 = 6 calls)
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.length).toBeLessThanOrEqual(4);
  });
});
