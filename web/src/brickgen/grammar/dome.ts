/**
 * Dome and onion profiles (A07, BIZ-05): the target surface height at a ring of a round roof.
 *
 * Both are functions of `u = (ring + 0.5) / rings` (0 at the eave, 1 at the apex) scaled to `apex` plates, handed to
 * `stairRings` as its target. A dome is a quarter circle (steep at the foot, level at the crown); an onion bulges to
 * three quarters of its height at the middle of the run and then draws out to a point (an ogee tip).
 * TODO(onion-overhang): a true onion overhangs its drum; a height field cannot, so the bulb stops at the drum's width.
 */

/** Quarter-circle dome: `apex * sqrt(1 - (1 - u)^2)`. */
export function domeTarget(rings: number, apex: number): (ring: number) => number {
  return ring => {
    const u = Math.min(1, (ring + 0.5) / rings);
    return apex * Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
  };
}

/** Onion profile: a dome to 0.75 of the height over the first three quarters of the run, then an ogee tip. */
export function onionTarget(rings: number, apex: number): (ring: number) => number {
  const bulb = 0.75;
  return ring => {
    const u = Math.min(1, (ring + 0.5) / rings);
    if (u <= bulb) {
      const v = u / bulb;
      return bulb * apex * Math.sqrt(Math.max(0, 1 - (1 - v) * (1 - v)));
    }
    const t = (u - bulb) / (1 - bulb);
    return apex * (bulb + (1 - bulb) * Math.pow(t, 1.5));
  };
}
