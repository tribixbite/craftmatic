/**
 * Overlaps: no two elements may occupy the same lattice cell. Occupancy is the
 * element's own mask (a slope or arch leaves its empty cells free), studs are
 * not part of the body, so a stud under a plate is not an overlap.
 */
import { cellKey, type WorldElement } from './world.js';

export interface OverlapPair {
  /** Plan indices of the two elements. */
  a: number;
  b: number;
  /** Cells they share. */
  cells: number;
}

/** Every pair of elements that share at least one body cell, with the shared cell count. */
export function findOverlaps(world: readonly WorldElement[]): OverlapPair[] {
  const owner = new Map<number, number>(); // cell -> first world position
  const shared = new Map<number, OverlapPair>(); // a*N+b -> pair
  world.forEach((e, i) => {
    for (const [x, y, z] of e.body) {
      const k = cellKey(x, y, z);
      const first = owner.get(k);
      if (first === undefined) { owner.set(k, i); continue; }
      const a = world[first]!.index;
      const b = e.index;
      const id = a * 4194304 + b;
      const pair = shared.get(id);
      if (pair) pair.cells++; else shared.set(id, { a, b, cells: 1 });
    }
  });
  return [...shared.values()].sort((p, q) => p.a - q.a || p.b - q.b);
}
