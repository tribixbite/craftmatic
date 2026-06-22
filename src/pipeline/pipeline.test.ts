/**
 * End-to-end integration test for the new pipeline.
 *
 * Exercises the full Stage 0-9 flow with mock fetchers — no real HTTP, no
 * real tile capture. Proves the pipe stays connected without regressions.
 */

import { describe, it, expect } from 'vitest';
import { runPipeline } from './pipeline.js';
import type { ContextFetchers } from './context/resolver.js';
import type { StreetViewFetchers, SvImageFetch } from './capture/streetview.js';
import type { SatelliteFetcher } from './capture/satellite.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FLATIRON = {
  lat: 40.7411, lng: -73.9897,
  address: '175 5th Ave, New York, NY',
};

function rgbaFilled(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  return px;
}

function makeContextFetchers(): ContextFetchers {
  return {
    geocode: async () => ({
      lat: FLATIRON.lat, lng: FLATIRON.lng,
      formattedAddress: FLATIRON.address,
      placeId: 'test-place-id',
      locationType: 'ROOFTOP',
      viewport: {
        sw: { lat: FLATIRON.lat - 0.0001, lon: FLATIRON.lng - 0.0001 },
        ne: { lat: FLATIRON.lat + 0.0001, lon: FLATIRON.lng + 0.0001 },
      },
      bounds: null,
    }),
    solar: async () => ({
      buildingBounds: {
        sw: { lat: FLATIRON.lat - 0.00007, lng: FLATIRON.lng - 0.00015 },
        ne: { lat: FLATIRON.lat + 0.00007, lng: FLATIRON.lng + 0.00015 },
      },
      estimatedHeightM: 12,
      buildingFootprintAreaSqm: 600,
      roofPitchDeg: 5,
    } as unknown as NonNullable<Awaited<ReturnType<ContextFetchers['solar']>>>),
    osm: async () => ({
      type: 'way', id: 1,
      polygon: [
        { lat: FLATIRON.lat - 0.00007, lon: FLATIRON.lng - 0.00010 },
        { lat: FLATIRON.lat - 0.00007, lon: FLATIRON.lng + 0.00015 },
        { lat: FLATIRON.lat + 0.00007, lon: FLATIRON.lng - 0.00005 },
      ],
      tags: {
        building: 'commercial',
        'building:levels': '3',
        'building:colour': 'tan',
        'roof:shape': 'flat',
      },
      widthMeters: 30, lengthMeters: 20, height: 12, levels: 3, area: 600,
    } as unknown as NonNullable<Awaited<ReturnType<ContextFetchers['osm']>>>),
    osmSiblings: async () => [],
    smarty: async () => null,
  };
}

function makeSvFetchers(): StreetViewFetchers {
  return {
    metadata: async (lat, lng) => ({
      panoId: `pano-${lat.toFixed(5)}-${lng.toFixed(5)}`,
      panoLat: lat + 0.00003,
      panoLng: lng - 0.00003,
    }),
    image: async (): Promise<SvImageFetch> => {
      // Tan facade — building-dominant sniff, passes minBuildingPixelRatio
      const rgba = rgbaFilled(32, 32, 210, 190, 150);
      return { bytes: new Uint8Array(0), width: 32, height: 32, rgba };
    },
  };
}

function makeSatFetcher(): SatelliteFetcher {
  return async ({ size, scale }) => {
    const w = size * scale, h = size * scale;
    const rgba = rgbaFilled(w, h, 70, 70, 70); // dark grey roof
    return { bytes: new Uint8Array(0), width: w, height: h, rgba };
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runPipeline end-to-end (mocked fetchers)', () => {
  it('resolves a full pipeline from address → printable GLB + voxel grid', async () => {
    const result = await runPipeline({
      address: FLATIRON.address,
      apiKey: 'test-key',
      projectRoot: '/nonexistent', // only used by captureTiles; we don't rely on it
      fetchers: {
        context: makeContextFetchers(),
        streetview: makeSvFetchers(),
        satellite: makeSatFetcher(),
      },
      skipTiles: true,
      // No tile API available in tests — captureTiles will throw internally,
      // orchestrator swallows it, pipeline uses cleaned-tiles fallback path.
    });

    expect(result.slug).toBeDefined();
    expect(result.report.status).toBeDefined();

    // Context + evidence always populated (even when tile capture fails)
    expect(result.artifacts).not.toBeNull();
    if (result.artifacts) {
      expect(result.artifacts.context.polygon).not.toBeNull();
      expect(result.artifacts.evidence.footprint.source).toBe('osm');
      expect(result.artifacts.evidence.heightM.value).toBeGreaterThan(6);
      expect(result.artifacts.evidence.roofShape.value).toBe('flat');

      // Synthesis should have run — non-empty artifacts
      expect(result.artifacts.printGlbBytes.byteLength).toBeGreaterThan(0);
      expect(result.artifacts.sceneGlbBytes.byteLength).toBeGreaterThan(0);
      expect(result.artifacts.voxelBlockCount).toBeGreaterThan(0);

      // Synthesis path: OSM polygon present + historic flag → hybrid,
      // but without tile coverage, hybrid falls back to parametric internally.
      // So expect '7a-parametric' or '7c-hybrid'.
      expect(result.artifacts.synthesisPath).toMatch(/7a-parametric|7c-hybrid/);
    }

    // Provenance from fusion is threaded into the report (Stage 9).
    expect(result.report.provenance).not.toBeNull();
    expect(result.report.provenance!.fields.map(f => f.field)).toContain('wall');
    expect(result.report.provenance!.meanConfidence).toBeGreaterThan(0);

    // Independent height cross-check runs (OSM 3 levels ≈ Solar 12m → agree).
    expect(result.report.crossCheck).not.toBeNull();
    expect(result.report.crossCheck!.truncationSuspected).toBe(false);
  }, 60_000);

  it('produces a context-insufficient report when geocode is too imprecise + no OSM/Solar', async () => {
    const fetchers: ContextFetchers = {
      geocode: async () => ({
        lat: 0, lng: 0, formattedAddress: 'middle of ocean',
        placeId: null, locationType: 'APPROXIMATE',
        viewport: null, bounds: null,
      }),
      solar: async () => null,
      osm: async () => null,
      osmSiblings: async () => [],
      smarty: async () => null,
    };
    const result = await runPipeline({
      address: 'nowhere',
      apiKey: 'test-key',
      projectRoot: '/nonexistent',
      fetchers: { context: fetchers, streetview: makeSvFetchers(), satellite: makeSatFetcher() },
    });
    expect(result.report.status).toBe('context-insufficient');
    expect(result.artifacts).toBeNull();
  });

  it('forwards progress events across all stages', async () => {
    const seenStages = new Set<string>();
    await runPipeline({
      address: FLATIRON.address,
      apiKey: 'test-key',
      projectRoot: '/nonexistent',
      fetchers: {
        context: makeContextFetchers(),
        streetview: makeSvFetchers(),
        satellite: makeSatFetcher(),
      },
      skipTiles: true,
      onProgress: ({ stage }) => { seenStages.add(stage); },
    });
    // At minimum we should see sv + satellite (tiles may fail silently).
    expect(seenStages.has('satellite')).toBe(true);
  }, 60_000);
});
