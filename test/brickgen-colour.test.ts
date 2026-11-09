/** X-08 (BIZ-05): nearest-LDraw-colour mapping (CIEDE2000 over the production palette). */
import { describe, expect, it } from 'vitest';
import { LDCONFIG_RGB } from '../web/src/engine/ldconfig-colors.generated.js';
import {
  deltaE2000, hexToRgb, isTransparentColour, nearestLdrawColour, PRODUCTION_PALETTE, rgbToLab, TRANSPARENT_PALETTE,
} from '../web/src/brickgen/colour.js';

describe('brickgen-colour', () => {
  it('pure white maps to LDraw 15 and a sandstone tan maps to 19', () => {
    expect(nearestLdrawColour([255, 255, 255])).toBe(15);
    // Sandstone tan (#E4CD9E, the classic "tan") is nearest LDraw tan (19, #D7BA8C) in the production palette.
    expect(nearestLdrawColour([228, 205, 158])).toBe(19);
  });

  it('every production colour maps to itself', () => {
    for (const code of PRODUCTION_PALETTE) {
      expect(LDCONFIG_RGB[code], `code ${code} exists in LDConfig`).toBeDefined();
      expect(nearestLdrawColour(hexToRgb(LDCONFIG_RGB[code]!)), `code ${code}`).toBe(code);
    }
    expect(new Set(PRODUCTION_PALETTE.map(c => LDCONFIG_RGB[c])).size).toBe(PRODUCTION_PALETTE.length);
  });

  it('a transparent is returned only when asked', () => {
    const transRed = hexToRgb(LDCONFIG_RGB[36]!);
    expect(isTransparentColour(nearestLdrawColour(transRed))).toBe(false);
    expect(nearestLdrawColour(transRed, PRODUCTION_PALETTE, { transparent: true })).toBe(36);
    for (const code of PRODUCTION_PALETTE) expect(isTransparentColour(code), `${code}`).toBe(false);
    for (const code of TRANSPARENT_PALETTE) expect(isTransparentColour(code), `${code}`).toBe(true);
  });

  it('ties resolve to the lowest code, whatever the palette order', () => {
    const grey = hexToRgb(LDCONFIG_RGB[71]!);
    expect(nearestLdrawColour(grey, [72, 71, 71])).toBe(71);
    expect(nearestLdrawColour(grey, [71, 72])).toBe(71);
  });

  it('CIEDE2000 matches the published reference pairs (Sharma et al. 2005)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, 3.1571, -77.2803], [50, 0, -82.7485])).toBeCloseTo(2.8615, 3);
    expect(deltaE2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 3);
    expect(deltaE2000(rgbToLab([10, 20, 30]), rgbToLab([10, 20, 30]))).toBe(0);
  });

  it('is deterministic', () => {
    expect(nearestLdrawColour([123, 45, 67])).toBe(nearestLdrawColour([123, 45, 67]));
  });
});
