/**
 * An existing plan (typically an imported LDraw model, `verify/ldraw-import.ts`) read back as an `IntentLattice`, so
 * a real model can be re-bricked: one `solid` label per distinct colour, one cell per body cell of every element.
 * Exact where the importer is exact (the vocabulary's own occupancy), with no voxelising error.
 */
import type { BrickPlan, IntentLabel, IntentLattice } from '../types.js';
import { placeAll, VOCABULARY_LOOKUP, type PartLookup } from '../verify/world.js';

/** Lattice of a plan's body cells. Elements outside `lookup` are skipped and counted in `skipped`. */
export function latticeFromPlan(plan: BrickPlan, lookup: PartLookup = VOCABULARY_LOOKUP, role: IntentLabel['role'] = 'solid'): { lattice: IntentLattice; skipped: number } {
  const { world, unknown } = placeAll(plan.elements, lookup);
  if (world.length === 0) throw new RangeError('latticeFromPlan: no element of the plan is a known part');
  let W = 0, H = 0, D = 0, minX = Infinity, minP = Infinity, minZ = Infinity;
  for (const w of world) for (const [x, p, z] of w.body) {
    minX = Math.min(minX, x); minP = Math.min(minP, p); minZ = Math.min(minZ, z);
    W = Math.max(W, x + 1); H = Math.max(H, p + 1); D = Math.max(D, z + 1);
  }
  W -= minX; H -= minP; D -= minZ;
  const labels: IntentLabel[] = [];
  const labelOf = new Map<number, number>();
  const cells = new Uint16Array(W * H * D);
  for (const w of world) {
    let k = labelOf.get(w.placed.colour);
    if (k === undefined) { k = labels.length; labelOf.set(w.placed.colour, k); labels.push({ role, colour: w.placed.colour }); }
    for (const [x, p, z] of w.body) cells[((p - minP) * D + (z - minZ)) * W + (x - minX)] = k + 1;
  }
  return { lattice: { dims: [W, H, D], cells, labels }, skipped: unknown.length };
}
