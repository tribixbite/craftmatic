import { describe, it, expect } from 'vitest';
import {
  computeMbrFromBbox,
  computeMbrFromPolygon,
  resolveMbr,
  resolveHeight,
  deriveSiblings,
  buildBuildingContext,
  ContextInsufficientError,
  haversineM,
} from './resolver.js';
import type { GeocodeResult, LatLon } from './types.js';

// Minimal stub geocode used throughout. Adjust locationType per test.
function mkGeocode(overrides: Partial<GeocodeResult> = {}): GeocodeResult {
  return {
    lat: 40.7414,
    lng: -73.9895,
    formattedAddress: 'Test Address',
    placeId: null,
    locationType: 'ROOFTOP',
    viewport: {
      sw: { lat: 40.7404, lon: -73.9905 },
      ne: { lat: 40.7424, lon: -73.9885 },
    },
    bounds: null,
    ...overrides,
  };
}

describe('haversineM', () => {
  it('returns 0 for identical points', () => {
    expect(haversineM({ lat: 40, lon: -73 }, { lat: 40, lon: -73 })).toBeCloseTo(0);
  });
  it('≈111m per 0.001° latitude', () => {
    const d = haversineM({ lat: 40, lon: -73 }, { lat: 40.001, lon: -73 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe('computeMbrFromBbox', () => {
  it('produces an axis-aligned MBR with 0° rotation', () => {
    const mbr = computeMbrFromBbox(
      { lat: 40.740, lon: -73.990 },
      { lat: 40.742, lon: -73.988 },
    );
    expect(mbr.rotationDeg).toBe(0);
    expect(mbr.widthM).toBeGreaterThan(mbr.depthM);
    expect(mbr.corners.length).toBe(4);
  });
});

describe('computeMbrFromPolygon (rectangle)', () => {
  it('recovers ~20×15m rectangle aligned to cardinal axes', () => {
    const center = { lat: 40.7414, lon: -73.9895 };
    // 20m east-west × 15m north-south box centred on center
    const dLat = 7.5 / 111_111;
    const dLon = 10 / (111_111 * Math.cos(40.7414 * Math.PI / 180));
    const poly: LatLon[] = [
      { lat: center.lat - dLat, lon: center.lon - dLon },
      { lat: center.lat - dLat, lon: center.lon + dLon },
      { lat: center.lat + dLat, lon: center.lon + dLon },
      { lat: center.lat + dLat, lon: center.lon - dLon },
      { lat: center.lat - dLat, lon: center.lon - dLon },
    ];
    const mbr = computeMbrFromPolygon(poly, center);
    expect(mbr.widthM).toBeCloseTo(20, 0);
    expect(mbr.depthM).toBeCloseTo(15, 0);
  });
});

describe('resolveMbr fallback chain', () => {
  const center = { lat: 40.7414, lon: -73.9895 };
  const makePoly = (): LatLon[] => [
    { lat: 40.7413, lon: -73.9896 },
    { lat: 40.7413, lon: -73.9894 },
    { lat: 40.7415, lon: -73.9894 },
    { lat: 40.7415, lon: -73.9896 },
  ];

  it('prefers OSM polygon', () => {
    const r = resolveMbr({
      polygon: makePoly(),
      solarBounds: { sw: { lat: 40.740, lon: -73.991 }, ne: { lat: 40.742, lon: -73.988 } },
      geocode: mkGeocode(),
      center,
    });
    expect(r.source).toBe('osm');
  });

  it('falls back to Solar bbox when no polygon', () => {
    const r = resolveMbr({
      polygon: null,
      solarBounds: { sw: { lat: 40.7413, lon: -73.9896 }, ne: { lat: 40.7415, lon: -73.9894 } },
      geocode: mkGeocode(),
      center,
    });
    expect(r.source).toBe('solar-bbox');
  });

  it('falls back to viewport when polygon + solar both missing', () => {
    const r = resolveMbr({
      polygon: null,
      solarBounds: null,
      geocode: mkGeocode(),
      center,
    });
    expect(r.source).toBe('inferred');
  });

  it('throws context-insufficient when viewport is city-scale', () => {
    expect(() => resolveMbr({
      polygon: null,
      solarBounds: null,
      geocode: mkGeocode({
        viewport: { sw: { lat: 40.5, lon: -74.2 }, ne: { lat: 40.9, lon: -73.8 } },
      }),
      center,
    })).toThrow(ContextInsufficientError);
  });

  it('throws context-insufficient when locationType is APPROXIMATE', () => {
    expect(() => resolveMbr({
      polygon: null,
      solarBounds: null,
      geocode: mkGeocode({ locationType: 'APPROXIMATE' }),
      center,
    })).toThrow(ContextInsufficientError);
  });
});

describe('resolveHeight', () => {
  it('prefers OSM height tag when set', () => {
    const osm = { height: 45, levels: 12 } as unknown as Parameters<typeof resolveHeight>[1];
    const r = resolveHeight(null, osm);
    expect(r.heightM).toBe(45);
    expect(r.heightSource).toBe('osm-levels');
    expect(r.levels).toBe(12);
  });
  it('uses Solar height when OSM height absent', () => {
    const osm = { levels: null } as unknown as Parameters<typeof resolveHeight>[1];
    const solar = { estimatedHeightM: 87 } as unknown as Parameters<typeof resolveHeight>[0];
    const r = resolveHeight(solar, osm);
    expect(r.heightM).toBe(87);
    expect(r.heightSource).toBe('solar');
  });
  it('uses levels × 3.5m fallback', () => {
    const osm = { levels: 4 } as unknown as Parameters<typeof resolveHeight>[1];
    const r = resolveHeight(null, osm);
    expect(r.heightM).toBe(14);
    expect(r.levels).toBe(4);
  });
  it('returns null when all sources fail', () => {
    const r = resolveHeight(null, null);
    expect(r.heightM).toBeNull();
    expect(r.heightSource).toBeNull();
  });
});

describe('deriveSiblings', () => {
  it('computes min edge-to-edge distance', () => {
    const primary: LatLon[] = [
      { lat: 40.7413, lon: -73.9896 },
      { lat: 40.7415, lon: -73.9896 },
      { lat: 40.7415, lon: -73.9894 },
      { lat: 40.7413, lon: -73.9894 },
    ];
    const siblingPoly: LatLon[] = [
      { lat: 40.7416, lon: -73.9896 }, // ~11m north of primary top edge
      { lat: 40.7417, lon: -73.9894 },
    ];
    const siblings = deriveSiblings(primary, [{ polygon: siblingPoly, tags: {} }]);
    expect(siblings.length).toBe(1);
    expect(siblings[0].distanceM).toBeGreaterThan(0);
    expect(siblings[0].distanceM).toBeLessThan(30);
  });
});

describe('buildBuildingContext', () => {
  it('produces a complete BuildingContext from minimal inputs', () => {
    const ctx = buildBuildingContext({
      geocode: mkGeocode(),
      solar: null,
      osm: null,
      smarty: null,
      siblings: [],
    });
    expect(ctx.polygon).toBeNull();
    expect(ctx.polygonSource).toBe('inferred');
    expect(ctx.mbr).toBeDefined();
    expect(ctx.size).toBeDefined();
    expect(ctx.shape).toBe('rect');
    expect(ctx.archType).toBe('residential');
    expect(ctx.svDifficulty).toBe('suburban');
  });

  it('throws context-insufficient when no usable footprint data', () => {
    expect(() => buildBuildingContext({
      geocode: mkGeocode({ locationType: 'APPROXIMATE' }),
      solar: null, osm: null, smarty: null, siblings: [],
    })).toThrow(ContextInsufficientError);
  });

  it('uses OSM polygon when provided', () => {
    const osm = {
      type: 'way', id: 1, tags: { building: 'commercial', 'building:colour': 'white' },
      polygon: [
        { lat: 40.7413, lon: -73.9896 },
        { lat: 40.7413, lon: -73.9894 },
        { lat: 40.7415, lon: -73.9894 },
        { lat: 40.7415, lon: -73.9896 },
      ],
      widthMeters: 20, lengthMeters: 20, height: 30, levels: 9, area: 400,
    } as unknown as Parameters<typeof buildBuildingContext>[0]['osm'];
    const ctx = buildBuildingContext({
      geocode: mkGeocode(), solar: null, osm, smarty: null, siblings: [],
    });
    expect(ctx.polygon).not.toBeNull();
    expect(ctx.polygonSource).toBe('osm');
    expect(ctx.wallColourHint).toBe('white');
    expect(ctx.heightM).toBe(30);
    expect(ctx.svDifficulty).toBe('dense-urban');
    expect(ctx.archType).toBe('commercial');
  });
});
