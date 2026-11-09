/**
 * Default buildable palette for the mesh front end: 40 common solid LDraw
 * colours, plus a CIE-Lab nearest-colour snapper.
 *
 * TODO(X-08): swap `createNearest` for X-08's `nearestLdrawColour` (CIEDE2000)
 * once `web/src/brickgen/colour.ts` merges; callers inject it via `nearest`.
 */

import { LDRAW_COLOR_RGB } from '../ldraw-colors.js';
import { rgbToLab } from '../color-utils.js';
import type { RGB } from '@craft/types/index.js';

/** The 40 LDraw codes offered by default: the colours most often produced in solid ABS. */
export const DEFAULT_PALETTE_CODES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 17, 18, 19, 20, 22,
  25, 26, 27, 28, 29, 70, 71, 72, 73, 85, 86, 92, 272, 288, 308, 320, 321, 378, 379, 484,
];

/** A buildable colour: LDraw code and its sRGB value (0-255). */
export interface PaletteColour { code: number; rgb: RGB }

/** Parse '#RRGGBB' from the shared LDraw table. */
function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Resolve LDraw codes to colours; throws on a code the shared table lacks. */
export function paletteFromCodes(codes: readonly number[]): PaletteColour[] {
  return codes.map((code) => {
    const hex = LDRAW_COLOR_RGB[code];
    if (!hex) throw new Error(`legolize palette: no RGB for LDraw colour ${code}`);
    return { code, rgb: hexToRgb(hex) };
  });
}

/** The default 40-colour palette. */
export const DEFAULT_PALETTE: readonly PaletteColour[] = paletteFromCodes(DEFAULT_PALETTE_CODES);

/** Maps an sRGB colour (0-255) to the LDraw code to build it in. */
export type NearestColour = (rgb: RGB) => number;

/**
 * Build a nearest-colour function over `palette` by Euclidean distance in
 * CIE-Lab. Ties go to the earlier palette entry, so results are deterministic.
 */
export function createNearest(palette: readonly PaletteColour[] = DEFAULT_PALETTE): NearestColour {
  if (palette.length === 0) throw new Error('legolize palette: empty palette');
  const labs = palette.map((c) => rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));
  return (rgb) => {
    const [l, a, b] = rgbToLab(rgb[0], rgb[1], rgb[2]);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < labs.length; i++) {
      const d = (labs[i]![0] - l) ** 2 + (labs[i]![1] - a) ** 2 + (labs[i]![2] - b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return palette[best]!.code;
  };
}
