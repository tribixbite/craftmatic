/**
 * Running-bond audit of a finished plan, read through the verifier's own
 * placement so it shares no code with the packer's bookkeeping.
 *
 * A vertical joint between two elements is a SEAM. It is ALIGNED when the same
 * face is a course boundary in two stacked layers: both cells below the face
 * belong to different elements too, and neither of those is the element above
 * it (so a pair of tall bricks that simply continue up is one seam, not many).
 */
import type { BrickPlan } from '../types.js';
import { placeAll, VOCABULARY_LOOKUP, type PartLookup } from '../verify/world.js';

/** Number of aligned seam faces (one per face unit, one plate layer high). */
export function findAlignedSeams(plan: BrickPlan, lookup: PartLookup = VOCABULARY_LOOKUP): number {
  const { world } = placeAll(plan.elements, lookup);
  const owner = new Map<string, number>();
  for (const w of world) for (const [x, p, z] of w.body) owner.set(`${x},${p},${z}`, w.index);
  const at = (x: number, p: number, z: number): number | undefined => owner.get(`${x},${p},${z}`);
  let n = 0;
  for (const key of owner.keys()) {
    const [x, p, z] = key.split(',').map(Number) as [number, number, number];
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      const a = at(x, p, z), b = at(x + dx, p, z + dz), a0 = at(x, p - 1, z), b0 = at(x + dx, p - 1, z + dz);
      if (a === undefined || b === undefined || a0 === undefined || b0 === undefined) continue;
      if (a !== b && a0 !== b0 && a0 !== a && b0 !== b) n++;
    }
  }
  return n;
}
