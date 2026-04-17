import { describe, it, expect } from 'vitest';
import { extractPalette, dominantLab } from './palette.js';

function fill(
  w: number, h: number,
  chunks: ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number; rgb: [number, number, number] }>,
): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Find matching chunk (last match wins)
      let rgb: [number, number, number] = [0, 0, 0];
      for (const c of chunks) {
        if (x >= c.x0 && x < c.x1 && y >= c.y0 && y < c.y1) rgb = c.rgb;
      }
      px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
    }
  }
  return px;
}

describe('extractPalette', () => {
  it('returns empty clusters for empty input', () => {
    const px = fill(0, 0, []);
    expect(extractPalette(px, 0, 0).clusters.length).toBe(0);
  });

  it('1-colour image → single dominant cluster', () => {
    const px = fill(20, 20, [{ x0: 0, y0: 0, x1: 20, y1: 20, rgb: [128, 128, 128] }]);
    const result = extractPalette(px, 20, 20, 4, { k: 3 });
    expect(result.clusters[0].weight).toBeCloseTo(1, 2);
    // Lab of grey has a,b ≈ 0
    expect(Math.abs(result.clusters[0].lab[1])).toBeLessThan(2);
    expect(Math.abs(result.clusters[0].lab[2])).toBeLessThan(2);
  });

  it('3-colour image separates into 3 clusters', () => {
    const px = fill(30, 30, [
      { x0: 0, y0: 0, x1: 30, y1: 10, rgb: [200, 100, 100] },   // red-ish
      { x0: 0, y0: 10, x1: 30, y1: 20, rgb: [100, 200, 100] },  // green-ish
      { x0: 0, y0: 20, x1: 30, y1: 30, rgb: [100, 100, 200] },  // blue-ish
    ]);
    const result = extractPalette(px, 30, 30, 4, { k: 3, seed: 1 });
    expect(result.clusters.length).toBe(3);
    // Each cluster should be ~33% weight
    for (const c of result.clusters) {
      expect(c.weight).toBeGreaterThan(0.25);
      expect(c.weight).toBeLessThan(0.42);
    }
  });

  it('zone filter samples only specified region', () => {
    const px = fill(40, 40, [
      { x0: 0, y0: 0, x1: 40, y1: 20, rgb: [255, 0, 0] },     // top: red
      { x0: 0, y0: 20, x1: 40, y1: 40, rgb: [0, 0, 255] },    // bottom: blue
    ]);
    // Sample bottom 50% only
    const result = extractPalette(px, 40, 40, 4, {
      k: 1, zone: { x0: 0, y0: 0.5, x1: 1, y1: 1 }, seed: 1,
    });
    // Cluster should be predominantly blue — b (yellow-blue) axis very negative in Lab
    expect(result.clusters[0].lab[2]).toBeLessThan(-30);
  });

  it('mask filter skips masked pixels', () => {
    const w = 20, h = 20;
    const px = fill(w, h, [
      { x0: 0, y0: 0, x1: w, y1: 10, rgb: [255, 0, 0] },   // top: red (will be masked)
      { x0: 0, y0: 10, x1: w, y1: h, rgb: [0, 255, 0] },   // bottom: green
    ]);
    const mask = new Uint8Array(w * h);
    // Mask out top half (veg=2)
    for (let y = 0; y < 10; y++) for (let x = 0; x < w; x++) mask[y * w + x] = 2;
    const result = extractPalette(px, w, h, 4, { k: 1, mask, seed: 1 });
    // Should be green dominant (positive a, b range for green is a<0, b>0)
    expect(result.clusters[0].lab[1]).toBeLessThan(-10);
  });

  it('respects stride for faster sampling', () => {
    const w = 60, h = 60;
    const px = fill(w, h, [{ x0: 0, y0: 0, x1: w, y1: h, rgb: [50, 50, 50] }]);
    const result = extractPalette(px, w, h, 4, { k: 1, stride: 10, seed: 1 });
    expect(result.clusters[0].weight).toBeCloseTo(1, 2);
  });

  it('dominantLab helper returns null for empty palette', () => {
    expect(dominantLab({ clusters: [] })).toBeNull();
  });

  it('dominantLab returns the largest cluster centroid', () => {
    const px = fill(20, 20, [
      { x0: 0, y0: 0, x1: 20, y1: 15, rgb: [200, 200, 200] },  // 75% bright grey
      { x0: 0, y0: 15, x1: 20, y1: 20, rgb: [50, 50, 50] },    // 25% dark grey
    ]);
    const result = extractPalette(px, 20, 20, 4, { k: 2, seed: 1 });
    const dom = dominantLab(result);
    // Dominant cluster is bright grey, L ≈ 81
    expect(dom![0]).toBeGreaterThan(70);
  });

  it('deterministic across runs with same seed', () => {
    const px = fill(30, 30, [
      { x0: 0, y0: 0, x1: 30, y1: 15, rgb: [200, 100, 50] },
      { x0: 0, y0: 15, x1: 30, y1: 30, rgb: [50, 100, 200] },
    ]);
    const a = extractPalette(px, 30, 30, 4, { k: 2, seed: 42 });
    const b = extractPalette(px, 30, 30, 4, { k: 2, seed: 42 });
    expect(a.clusters[0].lab).toEqual(b.clusters[0].lab);
  });
});
