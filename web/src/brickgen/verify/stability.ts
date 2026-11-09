/**
 * Stability: every element needs a load path to the ground through stud joins,
 * and no element may overhang its anchors by more than its class allows.
 *
 * - GROUND: an element whose body starts on plate `groundPlate` (default 0).
 * - LOAD PATH: reachable from a ground element over the join graph (either
 *   direction, because a stud join is a clutch, not only a rest). Elements that
 *   are reachable but have no chain of `rests on` joins up from the ground
 *   (they hang from above) are listed in `hanging`; they hold, but only by
 *   clutch, so a caller may want to treat them as weaker.
 * - CANTILEVER (elements off the ground only; ground carries its own footprint): an element's anchors are the cells where it is joined to an
 *   element below or above. Its overhang is the largest Chebyshev distance, in
 *   studs, from any body cell to the nearest anchor, compared with the class
 *   limit. Slopes, arches, windows and the like count as supported by their own
 *   occupancy (no limit); round, fence and bracket parts get a short limit.
 *   "4 studs per plate layer" is read as 4 studs for the single-layer base case
 *   and is NOT scaled up for thicker elements (conservative).
 */
import type { Connectivity } from './connect.js';
import { cellKey, type ElementKind, type WorldElement } from './world.js';

/** Allowed overhang in studs per class; `Infinity` = supported by its own occupancy. */
export const DEFAULT_CANTILEVER_LIMITS: Readonly<Record<ElementKind, number>> = {
  brick: 4, plate: 4, tile: 4,
  slope: Infinity, 'slope-inverted': Infinity, 'slope-curved': Infinity, arch: Infinity,
  window: Infinity, 'door-frame': Infinity, dome: Infinity, cone: Infinity,
  round: 2, bracket: 2, fence: 2,
};

export interface StabilityOptions {
  /** Plate layer that counts as ground. Default 0. */
  groundPlate?: number;
  limits?: Readonly<Record<ElementKind, number>>;
}

export interface CantileverFinding { index: number; part: string; group: string; studs: number; limit: number }

export interface StabilityResult {
  /** Plan indices with no join path to a ground element. */
  unsupported: number[];
  /** Plan indices reachable from the ground only through clutch from above. */
  hanging: number[];
  cantilevers: CantileverFinding[];
}

/** Chebyshev overhang of an element against its anchor cells; 0 when it has none to measure from. */
export function overhang(e: WorldElement, anchors: ReadonlyArray<readonly [number, number]>): number {
  if (anchors.length === 0) return 0;
  let worst = 0;
  for (const [x, , z] of e.body) {
    let best = Infinity;
    for (const [ax, az] of anchors) best = Math.min(best, Math.max(Math.abs(x - ax), Math.abs(z - az)));
    worst = Math.max(worst, best);
  }
  return worst;
}

/** Load paths and cantilevers over resolved elements and their joins. */
export function stability(world: readonly WorldElement[], conn: Connectivity, options: StabilityOptions = {}): StabilityResult {
  const ground = options.groundPlate ?? 0;
  const limits = options.limits ?? DEFAULT_CANTILEVER_LIMITS;
  const n = world.length;
  const up: number[][] = world.map(() => []);   // for a lower element: the uppers resting on it
  const down: number[][] = world.map(() => []); // for an upper element: the lowers it rests on
  for (const { lower, upper } of conn.joins) { up[lower]!.push(upper); down[upper]!.push(lower); }

  const reach = (starts: number[], next: (i: number) => number[]): boolean[] => {
    const seen = new Array<boolean>(n).fill(false);
    const stack = [...starts];
    for (const s of starts) seen[s] = true;
    while (stack.length) for (const j of next(stack.pop()!)) if (!seen[j]) { seen[j] = true; stack.push(j); }
    return seen;
  };
  const grounded = world.flatMap((e, i) => (e.y0 === ground ? [i] : []));
  const connected = reach(grounded, i => [...up[i]!, ...down[i]!]);
  const resting = reach(grounded, i => up[i]!);

  const unsupported: number[] = [];
  const hanging: number[] = [];
  world.forEach((e, i) => {
    if (!connected[i]) unsupported.push(e.index);
    else if (!resting[i]) hanging.push(e.index);
  });

  // Anchor cells per element: the (x, z) of every stud it is joined at.
  const anchors: Array<Array<[number, number]>> = world.map(() => []);
  for (const { lower, upper } of conn.joins) {
    const studs = new Set(world[lower]!.studs.map(([x, y, z]) => cellKey(x, y, z)));
    for (const [x, y, z] of world[upper]!.antis) {
      if (!studs.has(cellKey(x, y, z))) continue;
      anchors[upper]!.push([x, z]);
      anchors[lower]!.push([x, z]);
    }
  }
  const cantilevers: CantileverFinding[] = [];
  world.forEach((e, i) => {
    const limit = limits[e.part.kind];
    // An element standing on the ground is carried by it over its whole footprint.
    if (!connected[i] || limit === Infinity || e.y0 === ground) return;
    const studs = overhang(e, anchors[i]!);
    if (studs > limit) cantilevers.push({ index: e.index, part: e.placed.part, group: e.placed.group, studs, limit });
  });
  return { unsupported, hanging, cantilevers };
}
