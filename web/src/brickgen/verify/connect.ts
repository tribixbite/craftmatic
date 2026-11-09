/**
 * Stud / anti-stud connectivity: two elements are joined when one's stud cell
 * is the other's anti-stud cell in the layer directly above. Components are
 * union-find classes over those joins; the target is exactly one.
 *
 * Side connections (`connections.side`: clip, bar, pin) are NOT read yet.
 * TODO(X-09): model SNOT / side joins; until then a bracket's side stud adds
 * no edge, so a model that depends on one reports an extra component.
 */
import { cellKey, type WorldElement } from './world.js';

/** `lower` carries the stud, `upper` rests on it (its anti-stud is on that stud). Positions in the `world` array. */
export interface Join { lower: number; upper: number }

export interface Connectivity {
  joins: Join[];
  /** Component label per `world` position (0 = the largest component). */
  label: number[];
  /** Element count of each component, descending. */
  sizes: number[];
}

/** Compute the stud joins and the connected components of resolved elements. */
export function connectivity(world: readonly WorldElement[]): Connectivity {
  const antiAt = new Map<number, number[]>(); // anti-stud cell -> world positions
  world.forEach((e, i) => {
    for (const [x, y, z] of e.antis) {
      const k = cellKey(x, y, z);
      const list = antiAt.get(k);
      if (list) list.push(i); else antiAt.set(k, [i]);
    }
  });
  const seen = new Set<number>();
  const joins: Join[] = [];
  world.forEach((e, i) => {
    for (const [x, y, z] of e.studs) {
      for (const j of antiAt.get(cellKey(x, y, z)) ?? []) {
        if (j === i) continue;
        const pair = i * world.length + j;
        if (seen.has(pair)) continue;
        seen.add(pair);
        joins.push({ lower: i, upper: j });
      }
    }
  });
  const parent = world.map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; }
    return a;
  };
  for (const { lower, upper } of joins) parent[find(lower)] = find(upper);
  const members = new Map<number, number[]>();
  world.forEach((_, i) => {
    const r = find(i);
    const l = members.get(r);
    if (l) l.push(i); else members.set(r, [i]);
  });
  const classes = [...members.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  const label = new Array<number>(world.length).fill(0);
  classes.forEach((c, n) => c.forEach(i => { label[i] = n; }));
  return { joins, label, sizes: classes.map(c => c.length) };
}
