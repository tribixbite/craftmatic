/**
 * LDraw colour mapping for the brick core.
 *
 * `nearestLdrawColour` snaps an sRGB colour to the closest LDraw colour code of
 * a palette using CIEDE2000 in CIELAB (D65), so a mesh's texture colours or a
 * design's wall colour become buildable parts. Deterministic: equal distances
 * resolve to the lowest colour code.
 */
import { LDCONFIG_ALPHA, LDCONFIG_RGB } from '../engine/ldconfig-colors.generated.js';

export type Rgb = readonly [r: number, g: number, b: number];
export type Lab = readonly [L: number, a: number, b: number];

/**
 * The default buildable palette: solid, common colours only (LDraw codes).
 * Every code exists in `LDCONFIG_RGB`, none is translucent, and no two share an
 * RGB value, so each maps to itself.
 */
export const PRODUCTION_PALETTE: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 22, 25, 26, 27, 28, 29, 30, 31,
  68, 69, 70, 71, 72, 73, 74, 77, 78, 84, 85, 86, 89, 92, 100, 110, 112, 115, 118, 120, 125, 191, 212, 216,
  226, 232, 272, 288, 308, 320, 321, 322, 323, 326, 335, 351, 366, 373, 378, 379, 450, 462, 484, 503,
];

/** Translucent LDraw colours offered only when the caller asks for them. */
export const TRANSPARENT_PALETTE: readonly number[] = [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47];

/** `#RRGGBB` to an RGB triple. */
export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The RGB of an LDraw colour code, or `undefined` for a code LDConfig does not define. */
export function ldrawRgb(code: number): Rgb | undefined {
  const hex = LDCONFIG_RGB[code];
  return hex === undefined ? undefined : hexToRgb(hex);
}

/** True when LDConfig makes the code translucent. */
export function isTransparentColour(code: number): boolean {
  return LDCONFIG_ALPHA[code] !== undefined && LDCONFIG_ALPHA[code]! < 255 && TRANSPARENT_PALETTE.includes(code);
}

const linear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** sRGB (0-255) to CIELAB, D65 white. */
export function rgbToLab(rgb: Rgb): Lab {
  const r = linear(rgb[0]), g = linear(rgb[1]), b = linear(rgb[2]);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

/** CIEDE2000 colour difference (Sharma, Wu, Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(l1: Lab, l2: Lab): number {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number): number => (b === 0 && a === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export interface NearestOptions {
  /** Also consider `TRANSPARENT_PALETTE`. Default false: a solid is always returned otherwise. */
  transparent?: boolean;
}

/**
 * The LDraw colour code of `palette` closest to `rgb` (CIEDE2000). Translucent
 * colours are candidates only with `{ transparent: true }`. Ties go to the
 * lowest code. Codes missing from LDConfig are skipped; throws if none remain.
 */
export function nearestLdrawColour(rgb: Rgb, palette: readonly number[] = PRODUCTION_PALETTE, options: NearestOptions = {}): number {
  const candidates = options.transparent ? [...palette, ...TRANSPARENT_PALETTE] : palette.filter(c => !isTransparentColour(c));
  const target = rgbToLab(rgb);
  let best = -1;
  let bestD = Infinity;
  for (const code of [...new Set(candidates)].sort((a, b) => a - b)) {
    const c = ldrawRgb(code);
    if (!c) continue;
    const d = deltaE2000(target, rgbToLab(c));
    if (d < bestD) { bestD = d; best = code; }
  }
  if (best < 0) throw new Error('nearestLdrawColour: empty palette');
  return best;
}
