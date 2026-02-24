/**
 * Tests for src/gen/color-blocks.ts — RGB-to-Minecraft-block palette mapping,
 * HSL conversion, pixel filters, and hue-bucketed dominant color extraction.
 */

import { describe, it, expect } from 'vitest';
import {
  rgbToHsl, isGrass, isSkyOrWater, isShadow, isGlare, isNonBuilding,
  rgbToWallBlock, rgbToRoofOverride, rgbToTrimBlock, dominantColor,
  WALL_PALETTE, ROOF_PALETTE, TRIM_PALETTE,
} from '../src/gen/color-blocks.js';

// ─── rgbToHsl ────────────────────────────────────────────────────────

describe('rgbToHsl', () => {
  it('converts pure red to H=0, S=1, L=0.5', () => {
    const [h, s, l] = rgbToHsl(255, 0, 0);
    expect(h).toBeCloseTo(0, 0);
    expect(s).toBeCloseTo(1, 2);
    expect(l).toBeCloseTo(0.5, 2);
  });

  it('converts pure green to H=120, S=1, L=0.5', () => {
    const [h, s, l] = rgbToHsl(0, 255, 0);
    expect(h).toBeCloseTo(120, 0);
    expect(s).toBeCloseTo(1, 2);
    expect(l).toBeCloseTo(0.5, 2);
  });

  it('converts pure blue to H=240, S=1, L=0.5', () => {
    const [h, s, l] = rgbToHsl(0, 0, 255);
    expect(h).toBeCloseTo(240, 0);
    expect(s).toBeCloseTo(1, 2);
    expect(l).toBeCloseTo(0.5, 2);
  });

  it('converts white to L=1, S=0', () => {
    const [h, s, l] = rgbToHsl(255, 255, 255);
    expect(s).toBe(0);
    expect(l).toBeCloseTo(1, 2);
  });

  it('converts black to L=0, S=0', () => {
    const [h, s, l] = rgbToHsl(0, 0, 0);
    expect(s).toBe(0);
    expect(l).toBe(0);
  });

  it('converts gray to S=0', () => {
    const [, s, l] = rgbToHsl(128, 128, 128);
    expect(s).toBe(0);
    expect(l).toBeCloseTo(0.502, 1);
  });

  it('handles brick-red tone', () => {
    const [h, s, l] = rgbToHsl(150, 97, 83);
    // Warm hue (reddish), moderate saturation, mid lightness
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(40);
    expect(s).toBeGreaterThan(0.1);
    expect(l).toBeGreaterThan(0.2);
    expect(l).toBeLessThan(0.6);
  });
});

// ─── Pixel Filters ──────────────────────────────────────────────────

describe('isGrass', () => {
  it('detects green vegetation', () => {
    const [h, s, l] = rgbToHsl(60, 140, 50);
    expect(isGrass(h, s, l)).toBe(true);
  });

  it('rejects blue sky', () => {
    const [h, s, l] = rgbToHsl(100, 150, 230);
    expect(isGrass(h, s, l)).toBe(false);
  });

  it('rejects very dark green (shadows)', () => {
    const [h, s, l] = rgbToHsl(5, 15, 5);
    expect(isGrass(h, s, l)).toBe(false);
  });
});

describe('isSkyOrWater', () => {
  it('detects clear blue sky', () => {
    const [h, s, l] = rgbToHsl(100, 170, 240);
    expect(isSkyOrWater(h, s, l)).toBe(true);
  });

  it('rejects green pixels', () => {
    const [h, s, l] = rgbToHsl(60, 160, 40);
    expect(isSkyOrWater(h, s, l)).toBe(false);
  });

  it('rejects very dark blue', () => {
    const [h, s, l] = rgbToHsl(5, 5, 30);
    expect(isSkyOrWater(h, s, l)).toBe(false);
  });
});

describe('isShadow', () => {
  it('detects very dark pixels', () => {
    expect(isShadow(0.05)).toBe(true);
    expect(isShadow(0.14)).toBe(true);
  });

  it('rejects mid-tone pixels', () => {
    expect(isShadow(0.3)).toBe(false);
    expect(isShadow(0.5)).toBe(false);
  });
});

describe('isGlare', () => {
  it('detects very bright pixels', () => {
    expect(isGlare(0.95)).toBe(true);
  });

  it('rejects normal brightness', () => {
    expect(isGlare(0.8)).toBe(false);
    expect(isGlare(0.5)).toBe(false);
  });
});

describe('isNonBuilding', () => {
  it('rejects grass pixels', () => {
    expect(isNonBuilding(60, 140, 50)).toBe(true);
  });

  it('rejects sky pixels', () => {
    expect(isNonBuilding(100, 170, 240)).toBe(true);
  });

  it('rejects shadow pixels', () => {
    expect(isNonBuilding(10, 10, 10)).toBe(true);
  });

  it('rejects glare pixels', () => {
    expect(isNonBuilding(245, 245, 245)).toBe(true);
  });

  it('accepts brick-colored pixels', () => {
    expect(isNonBuilding(150, 97, 83)).toBe(false);
  });

  it('accepts white siding pixels', () => {
    expect(isNonBuilding(207, 213, 214)).toBe(false);
  });
});

// ─── Wall Block Mapping ─────────────────────────────────────────────

describe('rgbToWallBlock', () => {
  it('maps white to white_concrete', () => {
    expect(rgbToWallBlock(207, 213, 214)).toBe('minecraft:white_concrete');
  });

  it('maps brick red to bricks', () => {
    expect(rgbToWallBlock(155, 100, 85)).toBe('minecraft:bricks');
  });

  it('maps medium gray to stone or stone_bricks', () => {
    const result = rgbToWallBlock(125, 125, 125);
    expect(result).toMatch(/minecraft:(stone|stone_bricks)/);
  });

  it('maps dark brown to dark_oak_planks', () => {
    expect(rgbToWallBlock(67, 43, 20)).toBe('minecraft:dark_oak_planks');
  });

  it('maps sandy tan to sandstone', () => {
    expect(rgbToWallBlock(216, 203, 155)).toBe('minecraft:sandstone');
  });

  it('always returns a valid palette entry for any input', () => {
    const validBlocks = WALL_PALETTE.map(e => e.block);
    for (let i = 0; i < 30; i++) {
      const r = (i * 47) % 256;
      const g = (i * 89) % 256;
      const b = (i * 131) % 256;
      expect(validBlocks).toContain(rgbToWallBlock(r, g, b));
    }
  });
});

// ─── Roof Override Mapping ──────────────────────────────────────────

describe('rgbToRoofOverride', () => {
  it('returns north/south stairs and cap slab', () => {
    const result = rgbToRoofOverride(60, 42, 22);
    expect(result.north).toContain('stairs[facing=north]');
    expect(result.south).toContain('stairs[facing=south]');
    expect(result.cap).toContain('slab[type=bottom]');
  });

  it('maps dark brown to dark_oak roof', () => {
    const result = rgbToRoofOverride(60, 42, 22);
    expect(result.north).toContain('dark_oak');
  });

  it('maps gray to stone_brick or cobblestone roof', () => {
    const result = rgbToRoofOverride(100, 100, 100);
    expect(result.cap).toMatch(/cobblestone|stone_brick/);
  });

  it('maps warm brown to spruce or oak roof', () => {
    const result = rgbToRoofOverride(115, 85, 49);
    expect(result.north).toMatch(/spruce|oak/);
  });

  it('always returns valid stair/slab blocks', () => {
    for (const entry of ROOF_PALETTE) {
      const result = rgbToRoofOverride(...entry.rgb);
      expect(result.north).toContain('minecraft:');
      expect(result.south).toContain('minecraft:');
      expect(result.cap).toContain('minecraft:');
    }
  });
});

// ─── Trim Block Mapping ─────────────────────────────────────────────

describe('rgbToTrimBlock', () => {
  it('maps white to white_concrete', () => {
    expect(rgbToTrimBlock(255, 255, 255)).toBe('minecraft:white_concrete');
  });

  it('maps dark wood to dark_oak_log', () => {
    expect(rgbToTrimBlock(60, 42, 22)).toBe('minecraft:dark_oak_log');
  });

  it('always returns a valid palette entry', () => {
    const validBlocks = TRIM_PALETTE.map(e => e.block);
    for (let i = 0; i < 20; i++) {
      const r = (i * 53) % 256;
      const g = (i * 97) % 256;
      const b = (i * 139) % 256;
      expect(validBlocks).toContain(rgbToTrimBlock(r, g, b));
    }
  });
});

// ─── Palette Coverage ───────────────────────────────────────────────

describe('palette coverage', () => {
  it('WALL_PALETTE has at least 15 entries', () => {
    expect(WALL_PALETTE.length).toBeGreaterThanOrEqual(15);
  });

  it('ROOF_PALETTE has at least 10 entries', () => {
    expect(ROOF_PALETTE.length).toBeGreaterThanOrEqual(10);
  });

  it('TRIM_PALETTE has at least 8 entries', () => {
    expect(TRIM_PALETTE.length).toBeGreaterThanOrEqual(8);
  });

  it('all wall palette entries have minecraft: namespace', () => {
    for (const e of WALL_PALETTE) {
      expect(e.block).toMatch(/^minecraft:/);
    }
  });

  it('all palette RGB values are in 0-255 range', () => {
    for (const palette of [WALL_PALETTE, TRIM_PALETTE]) {
      for (const e of palette) {
        for (const v of e.rgb) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
      }
    }
    for (const e of ROOF_PALETTE) {
      for (const v of e.rgb) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });
});

// ─── Dominant Color (Hue Bucketing) ─────────────────────────────────

describe('dominantColor', () => {
  /** Create a flat RGBA pixel buffer of a single color */
  function solidColorBuffer(r: number, g: number, b: number, w: number, h: number): Uint8Array {
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      pixels[i * 4] = r;
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = b;
      pixels[i * 4 + 3] = 255;
    }
    return pixels;
  }

  it('returns the color of a solid brick-colored image', () => {
    const pixels = solidColorBuffer(150, 97, 83, 100, 100);
    const result = dominantColor(pixels, 0, 100, 100);
    expect(result).not.toBeNull();
    expect(result!.r).toBeCloseTo(150, 0);
    expect(result!.g).toBeCloseTo(97, 0);
    expect(result!.b).toBeCloseTo(83, 0);
  });

  it('returns null for all-sky pixels', () => {
    // Blue sky gets filtered out by isSkyOrWater
    const pixels = solidColorBuffer(100, 170, 240, 100, 100);
    const result = dominantColor(pixels, 0, 100, 100);
    expect(result).toBeNull();
  });

  it('returns null for all-grass pixels', () => {
    const pixels = solidColorBuffer(60, 140, 50, 100, 100);
    const result = dominantColor(pixels, 0, 100, 100);
    expect(result).toBeNull();
  });

  it('returns null for too few valid pixels (< 50)', () => {
    // 5×5 = 25 pixels total — less than the 50 minimum
    const pixels = solidColorBuffer(150, 97, 83, 5, 5);
    const result = dominantColor(pixels, 0, 5, 5);
    expect(result).toBeNull();
  });

  it('extracts building color from mixed pixels', () => {
    // 200×100 buffer: top 50 rows sky blue, bottom 50 rows brick
    const w = 200, h = 100;
    const pixels = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (y < 50) {
          // Sky blue — will be filtered
          pixels[idx] = 100; pixels[idx + 1] = 170; pixels[idx + 2] = 240;
        } else {
          // Brick — will be kept
          pixels[idx] = 150; pixels[idx + 1] = 97; pixels[idx + 2] = 83;
        }
        pixels[idx + 3] = 255;
      }
    }
    // Sample the full image — sky should be filtered, brick should dominate
    const result = dominantColor(pixels, 0, h, w);
    expect(result).not.toBeNull();
    expect(result!.r).toBeCloseTo(150, 0);
    expect(result!.g).toBeCloseTo(97, 0);
  });

  it('respects column bounds (colStart, colEnd)', () => {
    // 100×100 buffer: left half brick, right half green (grass)
    const w = 100, h = 100;
    const pixels = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (x < 50) {
          pixels[idx] = 150; pixels[idx + 1] = 97; pixels[idx + 2] = 83; // brick
        } else {
          pixels[idx] = 60; pixels[idx + 1] = 140; pixels[idx + 2] = 50; // grass
        }
        pixels[idx + 3] = 255;
      }
    }
    // Sample only left half — should get brick
    const result = dominantColor(pixels, 0, h, w, 0, 50);
    expect(result).not.toBeNull();
    expect(result!.r).toBeCloseTo(150, 0);
  });

  it('handles desaturated (gray) pixels in gray bucket', () => {
    // Medium gray — should land in the desaturated "gray bucket"
    const pixels = solidColorBuffer(128, 128, 128, 100, 100);
    const result = dominantColor(pixels, 0, 100, 100);
    expect(result).not.toBeNull();
    expect(result!.r).toBeCloseTo(128, 0);
    expect(result!.g).toBeCloseTo(128, 0);
    expect(result!.b).toBeCloseTo(128, 0);
  });
});
