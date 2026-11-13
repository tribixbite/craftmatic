/**
 * Spire detection and profile (A07, BIZ-05).
 *
 * A spire is a pyramid or cone too steep and slender to read as a roof: the massing gives it a pitch above
 * `SPIRE_MIN_PITCH_DEG`, or A9 marked a `spire` feature on its volume. Its profile is a straight taper
 * (`stairRings` turns it into a stack of steps, each capped by a 45 degree slope pair, because a height field of a
 * 6-stud needle has only three rings to taper over).
 * TODO(spire-taper): a finer taper needs cone parts (`feature: 'cone'`) stacked in a core; the bricker's cone
 * occupancy has to be matched cell for cell, which a stepped shaft does not give.
 */
import type { FeatureSpec } from '../types.js';
import { elementFor, occupancyIndex } from '../vocab/index.js';
import type { Canvas } from './canvas.js';
import type { Mask } from './footprint.js';

export const SPIRE_MIN_PITCH_DEG = 70;

/** Is the roof of volume `id` a spire (a pitch above the threshold, shape `spire`, or a `spire` feature)? */
export function isSpire(shape: string, pitchDeg: number | undefined, features: ReadonlyArray<FeatureSpec>, id: string): boolean {
  if (shape === 'spire') return true;
  // Only a pyramid, cone or hip can be a spire: a gable or a shed at a steep pitch is a wall, not a needle.
  const pointed = shape === 'pyramidal' || shape === 'conical' || shape === 'hipped';
  return pointed && ((pitchDeg ?? 0) >= SPIRE_MIN_PITCH_DEG || features.some(f => f.kind === 'spire' && f.volume === id));
}

/** A straight taper to `apex` plates over `rings` rings; the last ring reaches the apex (a needle has no flat top). */
export function spireTarget(rings: number, apex: number): (ring: number) => number {
  return ring => apex * Math.min(1, (ring + 1) / rings);
}

/**
 * Height in plates of the spire column whose cell centre is `dist` studs from the outside (1 on the boundary), on a
 * straight taper to `apex` plates over a footprint whose innermost cell is `maxDist` out. A boundary column rises to
 * the height where the profile's half width is its own distance from the axis; the innermost columns reach `apex`.
 */
export function spireHeight(dist: number, maxDist: number, apex: number): number {
  const u = maxDist <= 0.5 ? 1 : Math.min(1, Math.max(0, (dist - 0.5) / (maxDist - 0.5)));
  return Math.max(1, Math.round(apex * u));
}

/** The cone part for a square apex of `side` studs (1, 2 or 4). */
const CONE_PARTS: Readonly<Record<number, string>> = { 1: '4589.dat', 2: '3942c.dat', 4: '272.dat' };

/** The cone that caps a spire: where its footprint is, and the part's own height and occupancy. */
export interface SpireTip {
  /** Mask indices of the apex cells. */
  cells: ReadonlySet<number>;
  /** Lattice cell of the apex square's corner. */
  x0: number;
  z0: number;
  side: number;
  heightPlates: number;
  part: string;
}

/**
 * The apex of a spire as a cone, when its innermost ring is a filled square of 1, 2 or 4 studs (`apex` flags those
 * cells by mask index). An apex of another shape is capped flat: the bricker matches a cone cell for cell.
 */
export function spireTip(mask: Mask, apex: ArrayLike<number>): SpireTip | undefined {
  const cells = new Set<number>();
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for (let j = 0; j < mask.d; j++) for (let i = 0; i < mask.w; i++) {
    if (!apex[i + mask.w * j]) continue;
    cells.add(i + mask.w * j);
    i0 = Math.min(i0, i); j0 = Math.min(j0, j); i1 = Math.max(i1, i); j1 = Math.max(j1, j);
  }
  const side = i1 - i0 + 1;
  if (cells.size === 0 || side !== j1 - j0 + 1 || cells.size !== side * side || !CONE_PARTS[side]) return undefined;
  const part = CONE_PARTS[side]!;
  const element = elementFor(part);
  if (!element) return undefined;
  return { cells, x0: mask.x0 + i0, z0: mask.z0 + j0, side, heightPlates: element.heightPlates, part };
}

/** Write the cone's body cells above the apex column `(x, z)` from plate `p0`; returns the cells written. */
export function placeCone(canvas: Canvas, x: number, z: number, tip: SpireTip, p0: number, label: number): number {
  const element = elementFor(tip.part)!;
  const [fx, fz] = element.footprint;
  let n = 0;
  for (let layer = 0; layer < element.heightPlates; layer++) {
    if (element.occupancy && element.occupancy[occupancyIndex(fx, fz, x - tip.x0, z - tip.z0, layer)] === 0) continue;
    canvas.set(x, p0 + layer, z, label); n++;
  }
  return n;
}
