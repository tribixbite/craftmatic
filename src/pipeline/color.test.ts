import { describe, it, expect } from 'vitest';
import {
  rgbToLab,
  labToRgb,
  hexToRgb,
  hexToLab,
  labToRgbHex,
  labToHexColor,
} from './color.js';

describe('rgbToLab', () => {
  it('maps white to L*≈100 with neutral chroma', () => {
    const [L, a, b] = rgbToLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 0);
    expect(Math.abs(a)).toBeLessThan(0.5);
    expect(Math.abs(b)).toBeLessThan(0.5);
  });
  it('maps black to L*=0', () => {
    const [L, a, b] = rgbToLab(0, 0, 0);
    expect(L).toBeCloseTo(0, 1);
    expect(Math.abs(a)).toBeLessThan(0.5);
    expect(Math.abs(b)).toBeLessThan(0.5);
  });
  it('maps sRGB red to the canonical Lab red (53.2, 80.1, 67.2)', () => {
    const [L, a, b] = rgbToLab(255, 0, 0);
    expect(L).toBeCloseTo(53.2, 0);
    expect(a).toBeCloseTo(80.1, 0);
    expect(b).toBeCloseTo(67.2, 0);
  });
});

describe('labToRgb round-trip', () => {
  it('recovers 8-bit channels within ±1 across the gamut', () => {
    // A spread of in-gamut colours incl. greys, saturated primaries, and the
    // masonry/facade tones the pipeline actually deals in.
    const colours: Array<[number, number, number]> = [
      [255, 255, 255], [0, 0, 0], [128, 128, 128],
      [255, 0, 0], [0, 255, 0], [0, 0, 255],
      [178, 121, 84],  // brick
      [200, 196, 188], // limestone
      [58, 62, 70],    // dark curtain-wall glass
    ];
    for (const [r, g, b] of colours) {
      const [r2, g2, b2] = labToRgb(rgbToLab(r, g, b));
      expect(Math.abs(r2 - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(g2 - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(b2 - b)).toBeLessThanOrEqual(1);
    }
  });
  it('clamps out-of-gamut Lab into [0, 255]', () => {
    const rgb = labToRgb([50, 120, -120]); // hyper-saturated, outside sRGB
    for (const c of rgb) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
      expect(Number.isInteger(c)).toBe(true);
    }
  });
});

describe('hex helpers', () => {
  it('hexToRgb parses with and without the leading #', () => {
    expect(hexToRgb('#b27954')).toEqual([178, 121, 84]);
    expect(hexToRgb('b27954')).toEqual([178, 121, 84]);
  });
  it('labToRgbHex inverts hexToLab within quantisation', () => {
    expect(labToRgbHex(hexToLab('#b27954'))).toBe('#b27954');
  });
  it('labToRgbHex zero-pads low channels', () => {
    expect(labToRgbHex(rgbToLab(0, 0, 10))).toMatch(/^#00000[0-9a-f]$/);
  });
  it('labToHexColor packs the same triple labToRgb returns', () => {
    const lab = rgbToLab(178, 121, 84);
    const [r, g, b] = labToRgb(lab);
    expect(labToHexColor(lab)).toBe((r << 16) | (g << 8) | b);
  });
});
