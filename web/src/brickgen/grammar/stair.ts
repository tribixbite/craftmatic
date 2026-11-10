/**
 * The stair profile of a roof (A07, BIZ-05): how a roof surface is split into columns the X-10 bricker can cover with
 * REAL slope parts.
 *
 * The bricker takes a slope part where cells with the right `slope` label match the part's own occupancy and nothing
 * is built on top of it. Read from the vocabulary (`bun scripts/_a07_dump.ts`):
 *  - the 45 degree family (3040b, 3039, 3038, 3037) is two columns deep in the descent direction, 2 plates high at the
 *    low column and 3 at the high one (depths `[2, 3]`);
 *  - the 33 degree family (4286, 3298, 3297) is three columns deep, depths `[1, 2, 3]`.
 * A roof is therefore a run of GROUPS along the descent direction. A group has a base plate `b`; its column `j` is
 * filled from `b` up to `b + depths[j]` (those cells carry the slope label) and everything under `b` is roof fill.
 * Successive groups rise by at least one plate (the next group's low column must sit beside, never on top of, the last
 * group's high column), and a rise bigger than the family's own gives a stepped, steeper roof whose every step still
 * carries a slope part. The alignment is chosen so the LAST ring of a run is a high column: two opposing slopes then
 * meet at a ridge instead of leaving a lone low column on it.
 */

/** The cell depths of one slope family, low column first, and the bricker's steepness class for its label. */
export interface StairPattern {
  depths: readonly number[];
  rise: 1 | 2 | 3;
}

/** 45 degree parts, pairs of columns. Steeper roofs and anything above ~1.2 plates per stud. */
export const STEEP: StairPattern = { depths: [2, 3], rise: 3 };
/** 33 degree parts, triples of columns: a continuous ramp of one plate per stud. */
export const SHALLOW: StairPattern = { depths: [1, 2, 3], rise: 2 };

/** Plates per stud above which the 45 degree family is used. */
export const SHALLOW_MAX_PLATES_PER_STUD = 1.2;

/** The pattern for a roof rising `platesPerStud` over its run. */
export function patternFor(platesPerStud: number): StairPattern {
  return platesPerStud <= SHALLOW_MAX_PLATES_PER_STUD ? SHALLOW : STEEP;
}

/** One ring (column along the descent direction) of a roof run. */
export interface RingSurface {
  /** Plates of roof fill under the surface cells. */
  base: number;
  /** Plates from the roof's base to the top of the column (`base + depth`). */
  height: number;
  /** Position within the group (0 = low column). */
  j: number;
  /** Group index, 0 at the eave. */
  group: number;
}

/** The rings of one run for a given alignment `shift` (see `stairRings`). */
function ringsWithShift(ringMax: number, pattern: StairPattern, target: (ring: number) => number, limit: number | undefined, shift: number): RingSurface[] {
  const len = pattern.depths.length;
  const groups = Math.floor((ringMax + shift) / len) + 1;
  const meanDepth = pattern.depths.reduce((a, b) => a + b, 0) / len;
  const bases: number[] = [0];
  for (let g = 1; g < groups; g++) {
    const first = g * len - shift;
    let sum = 0;
    for (let j = 0; j < len; j++) sum += target(Math.min(ringMax, Math.max(0, first + j)));
    let b = Math.max(bases[g - 1]! + 1, Math.round(sum / len - meanDepth + 1e-6));
    if (limit !== undefined) b = Math.max(bases[g - 1]! + 1, Math.min(b, limit - pattern.depths[len - 1]!));
    bases.push(b);
  }
  const out: RingSurface[] = [];
  for (let r = 0; r <= ringMax; r++) {
    const idx = r + shift, g = Math.floor(idx / len), j = idx % len;
    out.push({ base: bases[g]!, height: bases[g]! + pattern.depths[j]!, j, group: g });
  }
  return out;
}

/**
 * Surface of every ring `0..ringMax` of one run.
 * @param ringMax index of the innermost ring (the ridge, or the apex ring)
 * @param target target surface height in plates at a ring index (the centre of that stud column)
 * @param limit cap on any column's height, plates (the lattice's room); undefined = none
 *
 * The alignment puts a high column at the last ring. When that leaves the apex more than a brick short of the target
 * (a steep roof over only two rings is one pair: 3 plates), the other alignments are tried and the closest wins.
 */
export function stairRings(ringMax: number, pattern: StairPattern, target: (ring: number) => number, limit?: number): RingSurface[] {
  const len = pattern.depths.length;
  const preferred = (((len - (ringMax + 1)) % len) + len) % len;
  let best = ringsWithShift(ringMax, pattern, target, limit, preferred);
  const aim = limit === undefined ? target(ringMax) : Math.min(limit, target(ringMax));
  const error = (r: RingSurface[]): number => Math.abs(r[ringMax]!.height - aim);
  if (error(best) > 3) {
    for (let shift = 0; shift < len; shift++) {
      if (shift === preferred) continue;
      const alt = ringsWithShift(ringMax, pattern, target, limit, shift);
      if (error(alt) < error(best)) best = alt;
    }
  }
  return best;
}
