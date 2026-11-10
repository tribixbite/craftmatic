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
