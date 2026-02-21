/**
 * Mapillary API client tests — unit tests for image selection and feature analysis,
 * plus live integration tests with 3 test addresses (skipped without MAPILLARY_ACCESS_TOKEN).
 *
 * Unit tests exercise pickBestImage, analyzeFeatures, and null-without-key behavior.
 * Live tests verify real API responses have expected structure and data.
 */

import { describe, it, expect } from 'vitest';
import {
  searchMapillaryImages, searchMapillaryFeatures,
  pickBestImage, analyzeFeatures,
  hasMapillaryApiKey, getMapillaryApiKey,
  type MapillaryImageData, type MapillaryFeatureData,
} from '@craft/gen/api/mapillary.js';

// ─── Test Data ──────────────────────────────────────────────────────────────

/** Synthetic images for unit tests */
const MOCK_IMAGES: MapillaryImageData[] = [
  {
    id: 'img-close-flat', capturedAt: 1700000000000, compassAngle: 90,
    lat: 37.7993, lng: -122.4370, isPano: false,
    thumbUrl: 'https://example.com/thumb1.jpg', width: 2048, height: 1536,
  },
  {
    id: 'img-far-flat', capturedAt: 1710000000000, compassAngle: 180,
    lat: 37.8010, lng: -122.4350, isPano: false,
    thumbUrl: 'https://example.com/thumb2.jpg', width: 2048, height: 1536,
  },
  {
    id: 'img-close-pano', capturedAt: 1720000000000, compassAngle: 45,
    lat: 37.7994, lng: -122.4371, isPano: true,
    thumbUrl: 'https://example.com/thumb3.jpg', width: 8192, height: 4096,
  },
  {
    id: 'img-closest-newest', capturedAt: 1730000000000, compassAngle: 270,
    lat: 37.7993, lng: -122.4370, isPano: false,
    thumbUrl: 'https://example.com/thumb4.jpg', width: 2048, height: 1536,
  },
];

const TARGET_LAT = 37.7993;
const TARGET_LNG = -122.4370;

/** Synthetic features for unit tests */
const MOCK_FEATURES: MapillaryFeatureData[] = [
  { id: 'f1', type: 'construction--flat--driveway', lat: 37.7993, lng: -122.4370 },
  { id: 'f2', type: 'construction--barrier--fence', lat: 37.7994, lng: -122.4371 },
  { id: 'f3', type: 'object--fire-hydrant', lat: 37.7995, lng: -122.4369 },
  { id: 'f4', type: 'object--street-light', lat: 37.7992, lng: -122.4372 },
];

// ─── Unit Tests ─────────────────────────────────────────────────────────────

describe('pickBestImage', () => {
  it('returns null for empty array', () => {
    expect(pickBestImage([], TARGET_LAT, TARGET_LNG)).toBeNull();
  });

  it('prefers closest non-pano image', () => {
    // img-close-flat and img-closest-newest are both at target; pano is penalized
    const best = pickBestImage(MOCK_IMAGES, TARGET_LAT, TARGET_LNG);
    expect(best).not.toBeNull();
    expect(best!.isPano).toBe(false);
    expect(best!.id).toBe('img-closest-newest'); // same distance but newer
  });

  it('tiebreaks by recency (newer wins)', () => {
    // Two images at identical coords, different capture times
    const tied: MapillaryImageData[] = [
      { ...MOCK_IMAGES[0], id: 'old', capturedAt: 1600000000000 },
      { ...MOCK_IMAGES[0], id: 'new', capturedAt: 1700000000000 },
    ];
    const best = pickBestImage(tied, TARGET_LAT, TARGET_LNG);
    expect(best!.id).toBe('new');
  });

  it('selects pano if all images are pano', () => {
    const panos: MapillaryImageData[] = [
      { ...MOCK_IMAGES[2], id: 'pano-far', lat: 37.8010, lng: -122.4350 },
      { ...MOCK_IMAGES[2], id: 'pano-close', lat: 37.7994, lng: -122.4371 },
    ];
    const best = pickBestImage(panos, TARGET_LAT, TARGET_LNG);
    expect(best).not.toBeNull();
    expect(best!.id).toBe('pano-close');
  });

  it('handles single image', () => {
    const best = pickBestImage([MOCK_IMAGES[1]], TARGET_LAT, TARGET_LNG);
    expect(best).not.toBeNull();
    expect(best!.id).toBe('img-far-flat');
  });
});

describe('analyzeFeatures', () => {
  it('detects driveway and fence', () => {
    const result = analyzeFeatures(MOCK_FEATURES);
    expect(result.hasDriveway).toBe(true);
    expect(result.hasFence).toBe(true);
  });

  it('returns false for empty features', () => {
    const result = analyzeFeatures([]);
    expect(result.hasDriveway).toBe(false);
    expect(result.hasFence).toBe(false);
  });

  it('detects only driveway when no fence present', () => {
    const features: MapillaryFeatureData[] = [
      { id: 'f1', type: 'construction--flat--driveway', lat: 0, lng: 0 },
      { id: 'f2', type: 'object--fire-hydrant', lat: 0, lng: 0 },
    ];
    const result = analyzeFeatures(features);
    expect(result.hasDriveway).toBe(true);
    expect(result.hasFence).toBe(false);
  });

  it('detects wall as fence', () => {
    const features: MapillaryFeatureData[] = [
      { id: 'f1', type: 'construction--barrier--wall', lat: 0, lng: 0 },
    ];
    const result = analyzeFeatures(features);
    expect(result.hasDriveway).toBe(false);
    expect(result.hasFence).toBe(true);
  });

  it('detects only fence when no driveway present', () => {
    const features: MapillaryFeatureData[] = [
      { id: 'f1', type: 'construction--barrier--fence', lat: 0, lng: 0 },
      { id: 'f2', type: 'object--mailbox', lat: 0, lng: 0 },
    ];
    const result = analyzeFeatures(features);
    expect(result.hasDriveway).toBe(false);
    expect(result.hasFence).toBe(true);
  });
});

describe('searchMapillaryImages', () => {
  it('returns null when no API key provided', async () => {
    const result = await searchMapillaryImages(TARGET_LAT, TARGET_LNG, '');
    expect(result).toBeNull();
  });
});

describe('searchMapillaryFeatures', () => {
  it('returns null when no API key provided', async () => {
    const result = await searchMapillaryFeatures(TARGET_LAT, TARGET_LNG, '');
    expect(result).toBeNull();
  });
});

describe('API key management', () => {
  it('getMapillaryApiKey returns string', () => {
    const key = getMapillaryApiKey();
    expect(typeof key).toBe('string');
  });

  it('hasMapillaryApiKey matches key presence', () => {
    const key = getMapillaryApiKey();
    expect(hasMapillaryApiKey()).toBe(key.length > 0);
  });
});

// ─── Live Integration Tests ─────────────────────────────────────────────────

const MLY_KEY = process.env.MAPILLARY_ACCESS_TOKEN ?? '';
const SKIP_MSG = 'MAPILLARY_ACCESS_TOKEN not set';

/**
 * SF has dense Mapillary coverage — reliable for asserting image results.
 * Grand Rapids and Newton have sparse/no coverage — test API call
 * structure only (returns array or null, no crash).
 */
const SF = { name: 'SF — 2340 Francisco St', lat: 37.7993, lng: -122.4370 };
const SPARSE_ADDRESSES = [
  { name: 'Grand Rapids — 1617 Lotus Ave SE', lat: 42.9437, lng: -85.6366 },
  { name: 'Newton — 240 Highland St', lat: 42.3484, lng: -71.2092 },
] as const;

describe.skipIf(!MLY_KEY)('Mapillary live API', () => {
  describe(SF.name, () => {
    it('finds at least 1 image', async () => {
      const images = await searchMapillaryImages(SF.lat, SF.lng, MLY_KEY);
      expect(images).not.toBeNull();
      expect(images!.length).toBeGreaterThanOrEqual(1);

      // Verify image metadata structure
      const first = images![0];
      expect(first.id).toBeDefined();
      expect(typeof first.compassAngle).toBe('number');
      expect(typeof first.lat).toBe('number');
      expect(typeof first.lng).toBe('number');
      expect(typeof first.isPano).toBe('boolean');
    }, 45000);

    it('pickBestImage returns a non-null result', async () => {
      const images = await searchMapillaryImages(SF.lat, SF.lng, MLY_KEY);
      expect(images).not.toBeNull();

      const best = pickBestImage(images!, SF.lat, SF.lng);
      expect(best).not.toBeNull();
      expect(best!.id).toBeDefined();
      expect(best!.thumbUrl).toBeDefined();
    }, 45000);

    it('searches features (may be empty)', async () => {
      const features = await searchMapillaryFeatures(SF.lat, SF.lng, MLY_KEY);
      if (features !== null) {
        expect(Array.isArray(features)).toBe(true);
        for (const f of features) {
          expect(f.id).toBeDefined();
          expect(typeof f.type).toBe('string');
        }
      }
    }, 45000);
  });

  // Sparse-coverage addresses — verify API calls don't crash, coverage may be null
  for (const addr of SPARSE_ADDRESSES) {
    describe(addr.name, () => {
      it('image search returns array or null (sparse coverage)', async () => {
        const images = await searchMapillaryImages(addr.lat, addr.lng, MLY_KEY, 0.005);
        if (images !== null) {
          expect(Array.isArray(images)).toBe(true);
          expect(images[0].id).toBeDefined();
        }
      }, 45000);

      it('feature search returns array or null', async () => {
        const features = await searchMapillaryFeatures(addr.lat, addr.lng, MLY_KEY, 0.005);
        if (features !== null) {
          expect(Array.isArray(features)).toBe(true);
        }
      }, 45000);
    });
  }
});
