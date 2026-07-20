import { describe, it, expect } from 'vitest';
import { buildFootprintMask } from './satellite.js';

describe('buildFootprintMask', () => {
  // 20×20m square centred on the crop centre at zoom 20, 64×64px crop of
  // logical size 64 (scalePx=1). Ground resolution at z20/lat0 ≈ 0.149 m/px
  // → the square spans ~134px, far larger than the crop → everything inside.
  const D = 10 / 111_111;
  const SQUARE = [
    { lat: -D, lon: -D }, { lat: -D, lon: D },
    { lat: D, lon: D }, { lat: D, lon: -D },
  ];

  it('marks pixels inside the footprint as inside', () => {
    const m = buildFootprintMask(SQUARE, 0, 0, 20, 64, 64, 64);
    expect(m.insideCount).toBe(64 * 64);
  });

  it('a footprint away from the crop leaves everything outside', () => {
    const FAR = SQUARE.map(p => ({ lat: p.lat + 0.01, lon: p.lon }));
    const m = buildFootprintMask(FAR, 0, 0, 20, 64, 64, 64);
    expect(m.insideCount).toBe(0);
    expect(m.outside.every(v => v === 1)).toBe(true);
  });

  it('a small centred footprint yields a proportional inside region', () => {
    // ~3×3m at z20 ≈ 20×20px of a 64×64 crop.
    const d = 1.5 / 111_111;
    const small = [
      { lat: -d, lon: -d }, { lat: -d, lon: d },
      { lat: d, lon: d }, { lat: d, lon: -d },
    ];
    const m = buildFootprintMask(small, 0, 0, 20, 64, 64, 64);
    expect(m.insideCount).toBeGreaterThan(200);
    expect(m.insideCount).toBeLessThan(1000);
    // Centre pixel inside, corner outside.
    expect(m.outside[32 * 64 + 32]).toBe(0);
    expect(m.outside[0]).toBe(1);
  });
});
