/**
 * The canonical mould id of a placed part.
 *
 * Every detector in the engine — ride cars, figures, doors, chairs, vehicles,
 * the voxelizer's skip lists — decides what a brick IS by matching its part id
 * against a set of canonical LDraw mould ids. That comparison only works on a
 * normalised id, and normalising it takes THREE steps, not the obvious two:
 *
 *   1. drop any directory (`parts/3001.dat`, `s\3001s01.dat`),
 *   2. drop the `.dat` extension,
 *   3. drop an embedded SET PREFIX.
 *
 * Step 3 is the one that is easy to miss. A Studio/OMR `.mpd` embeds the parts
 * it cannot assume the library has as sections named `<set> - <mould>.dat`
 * (`10261 - 26021.dat`) and references them by that full name, so once the
 * parser has flattened the document the placed brick's id still carries the set
 * number. Without step 3 every canonical-id match silently fails on those
 * sources — and fails OPEN, detecting nothing rather than erroring: 10261's
 * `.mpd` yielded zero ride cars and zero minifigs (a fabricated grey cart and
 * no figures at all) while the same set's `.ldr` yielded six of each, because
 * `10261 - 26021` is not `26021` and `10261 - 3816` is not `3816`.
 *
 * The prefix is the set number the document belongs to and is never part of a
 * mould id, so stripping it is safe: no LDraw mould id contains a space, and
 * the pattern requires the ` - ` separator.
 */

/** `10261 - 26021.dat` → the `10261 - ` that names the document's set, not the mould. */
const EMBEDDED_SET_PREFIX = /^\d{3,7}(?:-\d{1,2})?\s*-\s*/;

/**
 * Normalise a placed part's id to the canonical LDraw mould id used for matching.
 *
 * @param part - the id as placed (`parts/3001.dat`, `10261 - 26021.dat`)
 * @returns the lower-case mould id, with no directory, extension or set prefix
 */
export function partStem(part: string): string {
  const name = part.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase().replace(EMBEDDED_SET_PREFIX, '') ?? '';
  return name.endsWith('.dat') ? name.slice(0, -4) : name;
}
