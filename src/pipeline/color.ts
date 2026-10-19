/**
 * Canonical sRGB ↔ CIE-Lab conversions (D65 white point) for the whole
 * pipeline. Six modules previously carried private copies of this math and
 * they had already drifted: the synthesis copies used 4-decimal XYZ matrices
 * while the recolor copy used the standard 7-decimal ones, and parametric.ts
 * round-tripped Lab→hex-string→RGB to get what `labToRgb` returns directly.
 * The colour chain has a history of silent corruption bugs — one shared,
 * tested implementation is the guard against the next one.
 *
 * Pure leaf module: no imports beyond the Lab type alias.
 */

import type { Lab } from './context/types.js';

export type { Lab };

/** sRGB channel (0-255) → linear-light. */
function srgbToLinear(c: number): number {
  const cn = c / 255;
  return cn > 0.04045 ? Math.pow((cn + 0.055) / 1.055, 2.4) : cn / 12.92;
}

/** Linear-light → sRGB channel (0-1, pre-quantisation). */
function linearToSrgb(c: number): number {
  return c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
}

/** Convert 8-bit sRGB to CIE-Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const X = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const Y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
  const Z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;
  const xn = X / 0.95047, yn = Y / 1.0, zn = Z / 1.08883;
  const f = (t: number): number => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(xn), fy = f(yn), fz = f(zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Convert CIE-Lab (D65) to 8-bit sRGB, gamut-clamped and rounded. */
export function labToRgb(lab: Lab): readonly [number, number, number] {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const fInv = (t: number): number => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const X = fInv(fx) * 0.95047, Y = fInv(fy), Z = fInv(fz) * 1.08883;
  const lr = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
  const lg = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560;
  const lb = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
  const q = (c: number): number => Math.max(0, Math.min(255, Math.round(linearToSrgb(c) * 255)));
  return [q(lr), q(lg), q(lb)];
}

/** Parse `#rrggbb` (leading `#` optional) into an 8-bit RGB triple. */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Parse `#rrggbb` into CIE-Lab (D65). */
export function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

/** Format a Lab colour as a `#rrggbb` string. */
export function labToRgbHex(lab: Lab): string {
  const [r, g, b] = labToRgb(lab);
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Pack a Lab colour into a 0xRRGGBB integer (Three.js material tint). */
export function labToHexColor(lab: Lab): number {
  const [r, g, b] = labToRgb(lab);
  return (r << 16) | (g << 8) | b;
}
