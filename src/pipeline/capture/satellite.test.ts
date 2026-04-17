import { describe, it, expect } from 'vitest';
import {
  buildTreeMask,
  captureSatellite,
  computeSatelliteZoomFromBbox,
  detectShadowAzimuth,
  type SatelliteFetcher,
} from './satellite.js';
import type { CaptureProfile } from '../context/types.js';

function fillRgba(
  w: number, h: number,
  chunks: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number; rgb: [number, number, number] }>,
): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let rgb: [number, number, number] = [128, 128, 128];
      for (const c of chunks) {
        if (x >= c.x0 && x < c.x1 && y >= c.y0 && y < c.y1) rgb = c.rgb;
      }
      px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
    }
  }
  return px;
}

function baseProfile(maskTrees = false, scale: 1 | 2 = 1): CaptureProfile {
  return {
    tiles: { radiusM: 40, errorTarget: 2, verticalBands: 1, cameraMode: 'perspective', expectedHeightM: 30 },
    streetview: {
      dirCount: 0, offsetM: 30, maxPanoDistM: 80, angleVariants: [0],
      minBuildingPixelRatio: 0.2, pitchDeg: 10,
    },
    satellite: { scale, maskTrees },
  };
}

describe('computeSatelliteZoomFromBbox', () => {
  it('chooses higher zoom for smaller buildings', () => {
    const smallZ = computeSatelliteZoomFromBbox(15, 15, 40, 640);
    const largeZ = computeSatelliteZoomFromBbox(200, 200, 40, 640);
    expect(smallZ).toBeGreaterThan(largeZ);
  });
  it('clamps to 15-21 range', () => {
    expect(computeSatelliteZoomFromBbox(2000, 2000, 40, 640)).toBeGreaterThanOrEqual(15);
    expect(computeSatelliteZoomFromBbox(1, 1, 40, 640)).toBeLessThanOrEqual(21);
  });
  it('residential (~30m) → z20-21', () => {
    expect(computeSatelliteZoomFromBbox(30, 30, 37.7, 640)).toBeGreaterThanOrEqual(19);
  });
});

describe('buildTreeMask', () => {
  it('all green image → nearly all masked', () => {
    const px = fillRgba(20, 20, [{ x0: 0, y0: 0, x1: 20, y1: 20, rgb: [40, 150, 40] }]);
    const mask = buildTreeMask(px, 20, 20, 4);
    const touched = mask.reduce((a, b) => a + b, 0);
    expect(touched).toBeGreaterThan(0.95 * 20 * 20);
  });
  it('all grey image → nothing masked', () => {
    const px = fillRgba(20, 20, [{ x0: 0, y0: 0, x1: 20, y1: 20, rgb: [128, 128, 128] }]);
    const mask = buildTreeMask(px, 20, 20, 4);
    // dilation from 0 seeds adds nothing
    expect(mask.reduce((a, b) => a + b, 0)).toBe(0);
  });
  it('verdigris copper (bright cyan-green) is NOT masked as tree', () => {
    // Bright verdigris e.g. Guggenheim roof
    const px = fillRgba(20, 20, [{ x0: 0, y0: 0, x1: 20, y1: 20, rgb: [100, 200, 180] }]);
    const mask = buildTreeMask(px, 20, 20, 4);
    // V = 200/255 ≈ 0.78 is above the tree upper bound (0.7) → no mask
    expect(mask.reduce((a, b) => a + b, 0)).toBe(0);
  });
  it('dilates mask by 2 pixels', () => {
    // Single green pixel at centre of 10×10 image
    const px = fillRgba(10, 10, []);
    const ctr = (5 * 10 + 5) * 4;
    px[ctr] = 40; px[ctr + 1] = 150; px[ctr + 2] = 40;
    const mask = buildTreeMask(px, 10, 10, 4);
    // Dilated 2 pixels = a 5x5 diamond-ish region (manhattan distance ≤ 2)
    // At least the 4 direct neighbours of (5,5) should be masked
    expect(mask[5 * 10 + 4]).toBe(1);
    expect(mask[5 * 10 + 6]).toBe(1);
    expect(mask[4 * 10 + 5]).toBe(1);
    expect(mask[6 * 10 + 5]).toBe(1);
  });
});

describe('detectShadowAzimuth', () => {
  it('returns null when no shadow pixels', () => {
    const px = fillRgba(20, 20, [{ x0: 0, y0: 0, x1: 20, y1: 20, rgb: [200, 200, 200] }]);
    expect(detectShadowAzimuth(px, 20, 20)).toBeNull();
  });
  it('detects shadow on the east side of centre', () => {
    // White building, dark shadow on the right half
    const px = fillRgba(20, 20, [
      { x0: 0, y0: 0, x1: 10, y1: 20, rgb: [220, 220, 220] },
      { x0: 10, y0: 0, x1: 20, y1: 20, rgb: [30, 30, 30] }, // dark to the east
    ]);
    const az = detectShadowAzimuth(px, 20, 20);
    expect(az).not.toBeNull();
    // Shadow pixels are all to the east → azimuth ≈ 90° (east)
    expect(az!).toBeGreaterThan(60);
    expect(az!).toBeLessThan(120);
  });
});

describe('captureSatellite', () => {
  const lat = 40.7414, lng = -73.9895;

  it('computes zoom from tile bbox when available', async () => {
    let capturedZoom = -1;
    const fetcher: SatelliteFetcher = async ({ zoom, size, scale }) => {
      capturedZoom = zoom;
      const rgba = fillRgba(size * scale, size * scale, []);
      return { bytes: new Uint8Array(0), width: size * scale, height: size * scale, rgba };
    };
    await captureSatellite({
      lat, lng, widthM: 200, depthM: 200,
      // Tile evidence says the real extent is much smaller (30m) → higher zoom
      tiles: {
        glbPath: null, glbBytes: new ArrayBuffer(0),
        heightmap: new Float32Array(0), heightmapWidth: 0, heightmapLength: 0,
        measuredBbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 40, z: 30 } },
        truncated: false, meshCount: 10, noCoverage: false,
      },
      profile: baseProfile(), fetcher,
    });
    // With 30m extent, zoom should be >= 20
    expect(capturedZoom).toBeGreaterThanOrEqual(20);
  });

  it('falls back to MBR dims when tiles unavailable', async () => {
    let capturedZoom = -1;
    const fetcher: SatelliteFetcher = async ({ zoom, size, scale }) => {
      capturedZoom = zoom;
      const rgba = fillRgba(size * scale, size * scale, []);
      return { bytes: new Uint8Array(0), width: size * scale, height: size * scale, rgba };
    };
    await captureSatellite({
      lat, lng, widthM: 30, depthM: 30, tiles: null, profile: baseProfile(), fetcher,
    });
    expect(capturedZoom).toBeGreaterThanOrEqual(20);
  });

  it('produces tree mask when maskTrees=true', async () => {
    const fetcher: SatelliteFetcher = async ({ size, scale }) => {
      // Half grey roof, half green canopy
      const w = size * scale, h = size * scale;
      const rgba = fillRgba(w, h, [
        { x0: 0, y0: 0, x1: w / 2, y1: h, rgb: [128, 128, 128] },
        { x0: w / 2, y0: 0, x1: w, y1: h, rgb: [40, 150, 40] },
      ]);
      return { bytes: new Uint8Array(0), width: w, height: h, rgba };
    };
    const result = await captureSatellite({
      lat, lng, widthM: 30, depthM: 30, tiles: null,
      profile: baseProfile(true), fetcher,
    });
    const treeCount = result.treeMask.reduce((a, b) => a + b, 0);
    expect(treeCount).toBeGreaterThan(0);
    // Roof palette primary should be grey-ish (cluster 0 from masked half)
    expect(Math.abs(result.roofPalette.primary[1])).toBeLessThan(5); // a* near 0
    expect(Math.abs(result.roofPalette.primary[2])).toBeLessThan(5); // b* near 0
  });

  it('extracts roof palette centred on inner 70%', async () => {
    const fetcher: SatelliteFetcher = async ({ size, scale }) => {
      const w = size * scale, h = size * scale;
      // Red ring (outside 70% zone), grey centre (inside)
      const rgba = fillRgba(w, h, [
        { x0: 0, y0: 0, x1: w, y1: h, rgb: [220, 50, 50] },
        {
          x0: Math.floor(w * 0.15), y0: Math.floor(h * 0.15),
          x1: Math.ceil(w * 0.85), y1: Math.ceil(h * 0.85),
          rgb: [150, 150, 150],
        },
      ]);
      return { bytes: new Uint8Array(0), width: w, height: h, rgba };
    };
    const result = await captureSatellite({
      lat, lng, widthM: 30, depthM: 30, tiles: null,
      profile: baseProfile(), fetcher,
    });
    // Inner 70% is grey → dominant cluster a* and b* near 0
    expect(Math.abs(result.roofPalette.primary[1])).toBeLessThan(5);
    expect(Math.abs(result.roofPalette.primary[2])).toBeLessThan(5);
  });
});
