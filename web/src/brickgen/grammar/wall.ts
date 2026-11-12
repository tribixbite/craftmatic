/**
 * Wall grammar (A08, BIZ-05): the shell of one massing volume on the canvas.
 *
 * Per volume, lowest top first so a taller volume cuts through a shorter one:
 *  - a floor of two plate layers over the footprint (one layer would be loose plates side by side; the second bonds
 *    them), skipped where the volume stands on the base plate;
 *  - a one-stud wall ring from the floor to the ceiling, hollow inside;
 *  - a ceiling cap of two plate layers (what the roof stands on). A volume under five plates high is a solid slab;
 *  - optional string courses (`trim` rings flush with the wall) at the heights the style rule names.
 * A taller volume clears the interior of what it cuts through, so overlapping volumes merge into one shell.
 */
import type { Canvas } from './canvas.js';
import { isBoundary, type Mask } from './footprint.js';

/** Cell values (from `Canvas.label`) the shell is built from. */
export interface ShellLabels { floor: number; wall: number; cap: number; trim: number; terrain: number }

export interface ShellSpec {
  /** First plate of the volume (above the base plate) and the plate its walls end at (exclusive, the cap's top). */
  baseP: number;
  topP: number;
  /** True when the volume stands on the base plate: it needs no floor of its own. */
  grounded: boolean;
  /** `terrain` volumes are solid. */
  solid?: boolean;
  /** Plate offsets above `baseP` of string courses, each one plate high. */
  stringCourses?: readonly number[];
}

/** Draw the floor, walls and cap of a volume. Returns the plate its roof starts on (`topP`). */
export function buildShell(canvas: Canvas, mask: Mask, labels: ShellLabels, spec: ShellSpec): number {
  const { baseP, topP, grounded } = spec;
  const slab = topP - baseP <= 4 && !grounded;
  const courses = new Set((spec.stringCourses ?? []).map(c => baseP + c));
  for (let j = 0; j < mask.d; j++) for (let i = 0; i < mask.w; i++) {
    if (!mask.inside[i + mask.w * j]) continue;
    const x = mask.x0 + i, z = mask.z0 + j;
    if (spec.solid) { canvas.column(x, z, baseP, topP, labels.terrain); continue; }
    if (slab) { canvas.column(x, z, baseP, topP, labels.cap); continue; }
    const edge = isBoundary(mask, i, j);
    if (!grounded) { canvas.column(x, z, baseP, baseP + 2, labels.floor); }
    const wallFrom = grounded ? baseP : baseP + 2;
    for (let p = wallFrom; p <= topP - 3; p++) canvas.set(x, p, z, edge ? (courses.has(p) ? labels.trim : labels.wall) : 0);
    canvas.column(x, z, topP - 2, topP, labels.cap);
  }
  return topP;
}
