import { describe, it, expect } from 'vitest';
import { normalizeSampleLuminance } from './photogrammetry-recolor.js';

function pack(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}
function luma(packed: number): number {
  return 0.2126 * ((packed >> 16) & 0xff) + 0.7152 * ((packed >> 8) & 0xff) + 0.0722 * (packed & 0xff);
}

describe('normalizeSampleLuminance', () => {
  it('lifts the shadowed tail of a bimodal (sun/shade) sample set', () => {
    // Half the facade in deep shade (~RGB 40), half sunlit (~RGB 200) — the
    // baked-lighting signature. After normalisation the dark half must be
    // materially lifted while ordering (dark < light) is preserved.
    const n = 400;
    const arr = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      arr[i] = i < n / 2 ? pack(40, 38, 42) : pack(200, 196, 190);
    }
    const beforeDark = luma(arr[0]);
    normalizeSampleLuminance(arr);
    const afterDark = luma(arr[0]);
    const afterLight = luma(arr[n - 1]);
    expect(afterDark).toBeGreaterThan(beforeDark + 15); // shadow lifted
    expect(afterDark).toBeLessThan(afterLight);          // ordering intact
  });

  it('preserves chroma direction (brick stays reddish after the lift)', () => {
    const n = 200;
    const arr = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      // Shaded brick (dark red) + sunlit cream.
      arr[i] = i < n / 2 ? pack(70, 35, 30) : pack(210, 200, 180);
    }
    normalizeSampleLuminance(arr);
    const r = (arr[0] >> 16) & 0xff, g = (arr[0] >> 8) & 0xff, b = arr[0] & 0xff;
    expect(r).toBeGreaterThan(g); // still red-dominant
    expect(r).toBeGreaterThan(b);
  });

  it('leaves uniformly-lit buildings untouched (genuinely dark tower)', () => {
    // Narrow spread around RGB 60 — a real dark facade, not sun/shade.
    const n = 200;
    const arr = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const v = 55 + (i % 11); // L* spread well under the 25 threshold
      arr[i] = pack(v, v, v);
    }
    const before = Array.from(arr);
    normalizeSampleLuminance(arr);
    expect(Array.from(arr)).toEqual(before);
  });

  it('ignores unsampled (-1) cells and tiny sample sets', () => {
    const arr = new Int32Array(60).fill(-1);
    arr[0] = pack(40, 40, 40);
    arr[1] = pack(200, 200, 200);
    const before = Array.from(arr);
    normalizeSampleLuminance(arr); // <50 samples → no-op
    expect(Array.from(arr)).toEqual(before);
  });
});
