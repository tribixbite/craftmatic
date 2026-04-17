import { describe, it, expect } from 'vitest';
import { sniffPixels } from './sv-sniff.js';

function fillRgba(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
  return px;
}

describe('sniffPixels', () => {
  it('pure sky (sky-blue) → sky ≈ 1.0', () => {
    const r = sniffPixels(fillRgba(10, 10, 135, 206, 235), 10, 10).ratios;
    expect(r.sky).toBeCloseTo(1, 2);
    expect(r.veg).toBe(0);
    expect(r.building).toBe(0);
  });

  it('pure vegetation (forest green) → veg ≈ 1.0', () => {
    const r = sniffPixels(fillRgba(10, 10, 34, 139, 34), 10, 10).ratios;
    expect(r.veg).toBeCloseTo(1, 2);
    expect(r.sky).toBe(0);
    expect(r.building).toBe(0);
  });

  it('pure grey building → building ≈ 1.0', () => {
    // Mid-grey — below bright threshold, so not classified as sky
    const r = sniffPixels(fillRgba(10, 10, 128, 128, 128), 10, 10).ratios;
    expect(r.building).toBeCloseTo(1, 2);
    expect(r.sky).toBe(0);
    expect(r.veg).toBe(0);
  });

  it('pure white sky → sky ≈ 1.0 (bright+unsaturated)', () => {
    const r = sniffPixels(fillRgba(10, 10, 255, 255, 255), 10, 10).ratios;
    expect(r.sky).toBeCloseTo(1, 2);
  });

  it('warm brown (brick) → building', () => {
    const r = sniffPixels(fillRgba(10, 10, 139, 69, 19), 10, 10).ratios;
    expect(r.building).toBeCloseTo(1, 2);
  });

  it('tan/sandstone → building (not veg, not sky)', () => {
    const r = sniffPixels(fillRgba(10, 10, 220, 190, 140), 10, 10).ratios;
    expect(r.building).toBeGreaterThan(0.9);
  });

  it('dark evergreen (olive) → veg', () => {
    // Olive-green dark, still saturated enough to register as veg
    const r = sniffPixels(fillRgba(10, 10, 85, 107, 47), 10, 10).ratios;
    expect(r.veg).toBeGreaterThan(0.9);
  });

  it('mixed 50/50 building+sky image', () => {
    const w = 10, h = 10;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const top = y < 5;
        if (top) { px[i] = 135; px[i + 1] = 206; px[i + 2] = 235; }
        else { px[i] = 128; px[i + 1] = 128; px[i + 2] = 128; }
        px[i + 3] = 255;
      }
    }
    const r = sniffPixels(px, w, h).ratios;
    expect(r.sky).toBeCloseTo(0.5, 1);
    expect(r.building).toBeCloseTo(0.5, 1);
  });

  it('returns per-pixel mask when requested', () => {
    const result = sniffPixels(fillRgba(2, 2, 135, 206, 235), 2, 2, 4, { mask: true });
    expect(result.mask).toBeInstanceOf(Uint8Array);
    expect(result.mask!.length).toBe(4);
    expect(Array.from(result.mask!)).toEqual([1, 1, 1, 1]);
  });

  it('does not allocate mask by default', () => {
    const result = sniffPixels(fillRgba(2, 2, 0, 0, 0), 2, 2);
    expect(result.mask).toBeNull();
  });

  it('accepts 3-channel RGB input', () => {
    const w = 4, h = 4;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < px.length; i += 3) { px[i] = 135; px[i + 1] = 206; px[i + 2] = 235; }
    const result = sniffPixels(px, w, h, 3);
    expect(result.ratios.sky).toBeCloseTo(1, 2);
  });

  it('throws on under-sized pixel buffer', () => {
    expect(() => sniffPixels(new Uint8Array(16), 10, 10)).toThrow();
  });

  it('tolerates occlusion thresholds — veg occlusion > 40% triggers retry decision', () => {
    // 60% trees (top 6 rows) + 40% building (bottom 4 rows)
    const w = 10, h = 10;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const tree = y < 6;
        if (tree) { px[i] = 34; px[i + 1] = 139; px[i + 2] = 34; }
        else { px[i] = 128; px[i + 1] = 128; px[i + 2] = 128; }
        px[i + 3] = 255;
      }
    }
    const r = sniffPixels(px, w, h).ratios;
    expect(r.veg).toBeGreaterThan(0.4);
    expect(r.building).toBeGreaterThan(0.3);
  });
});
