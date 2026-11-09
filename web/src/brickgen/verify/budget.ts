/**
 * Budget estimate: how many cuboids the Bedrock compiler will spend on a plan,
 * known BEFORE a pack is built so the bricker can stay under the shell budget.
 *
 * Measured against the real compile on goldens (test/brickgen-verify.test.ts):
 *  - body: each element is a box (a slope or arch: a few boxes covering its
 *    mask), then the compiler's own same-colour merge (`mergeAlignedCuboids`)
 *    and hidden-cuboid cull are replayed at stud x plate resolution;
 *  - studs: every EXPOSED stud fans into `studFacets` cuboids (default 4),
 *    counted apart because the compiler budgets them separately
 *    (`maxStudCubes`). A stud is hidden when the cell above it lies inside
 *    another element's bounding box.
 * Not modelled: the finer lattice a slanted face is cut into (a slope costs
 * more than its mask cover), so slope-heavy plans read low.
 */
import { cellKey, type WorldElement } from './world.js';

/** Cuboids the compiler fans per exposed stud by default (`LEGO_ENTITY_QUALITY.*.studFacets`). */
export const DEFAULT_STUD_FACETS = 4;

export interface BudgetOptions {
  /** Cuboids per exposed stud; 4 is the compiler's default round stud, 1 a square peg. */
  studFacets?: number;
}

export interface BudgetEstimate {
  /** Body cuboids after same-colour neighbours merge. */
  bodyCuboids: number;
  /** Exposed studs times `studFacets` (a stud with an element on top of it is hidden and not counted). */
  studCuboids: number;
  /** `bodyCuboids + studCuboids`. */
  cuboidsEstimate: number;
}

/** An axis-aligned box of lattice cells, half open: `min` inclusive, `max` exclusive, as [x, plate, z]. */
interface Box { min: [number, number, number]; max: [number, number, number]; colour: number }

/**
 * Greedy box cover of one element's occupancy mask (cells `body`): scan in
 * plate, z, x order and grow every new box along x, then z, then up. A cuboid
 * element is one box; a slope or arch is a few.
 */
function elementBoxes(e: WorldElement): Box[] {
  if (!e.part.element.occupancy) {
    const xs = e.body.map(c => c[0]), zs = e.body.map(c => c[2]);
    return [{ min: [Math.min(...xs), e.y0, Math.min(...zs)], max: [Math.max(...xs) + 1, e.y0 + e.h, Math.max(...zs) + 1], colour: e.placed.colour }];
  }
  const cells = new Set(e.body.map(([x, y, z]) => cellKey(x, y, z)));
  const free = (x: number, y: number, z: number): boolean => cells.has(cellKey(x, y, z));
  const used = new Set<number>();
  const open = (x: number, y: number, z: number): boolean => free(x, y, z) && !used.has(cellKey(x, y, z));
  const boxes: Box[] = [];
  for (const [x, y, z] of [...e.body].sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0])) {
    if (!open(x, y, z)) continue;
    let w = 1;
    while (open(x + w, y, z)) w++;
    const rowOpen = (yy: number, zz: number): boolean => { for (let k = 0; k < w; k++) if (!open(x + k, yy, zz)) return false; return true; };
    let d = 1;
    while (rowOpen(y, z + d)) d++;
    let h = 1;
    const sliceOpen = (yy: number): boolean => { for (let q = 0; q < d; q++) if (!rowOpen(yy, z + q)) return false; return true; };
    while (sliceOpen(y + h)) h++;
    for (let a = 0; a < h; a++) for (let b = 0; b < d; b++) for (let c = 0; c < w; c++) used.add(cellKey(x + c, y + a, z + b));
    boxes.push({ min: [x, y, z], max: [x + w, y + h, z + d], colour: e.placed.colour });
  }
  return boxes;
}

/**
 * The compiler's `mergeAlignedCuboids`, on lattice boxes: same colour boxes with
 * the same cross-section that touch along an axis become one; repeated per axis
 * until nothing merges.
 */
function mergeBoxes(input: Box[]): Box[] {
  let current = input;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const axis of [0, 1, 2] as const) {
      const o1 = (axis + 1) % 3, o2 = (axis + 2) % 3;
      const groups = new Map<string, Box[]>();
      for (const b of current) {
        const k = `${b.colour}|${b.min[o1]}|${b.max[o1]}|${b.min[o2]}|${b.max[o2]}`;
        const g = groups.get(k);
        if (g) g.push(b); else groups.set(k, [b]);
      }
      const next: Box[] = [];
      for (const g of groups.values()) {
        g.sort((p, q) => p.min[axis] - q.min[axis]);
        let acc: Box = { ...g[0]!, min: [...g[0]!.min], max: [...g[0]!.max] };
        for (let i = 1; i < g.length; i++) {
          const c = g[i]!;
          if (c.min[axis] === acc.max[axis]) { acc.max[axis] = c.max[axis]; changed = true; }
          else if (c.min[axis] < acc.max[axis] && c.max[axis] <= acc.max[axis]) changed = true; // duplicate inside the accumulated box
          else { next.push(acc); acc = { ...c, min: [...c.min], max: [...c.max] }; }
        }
        next.push(acc);
      }
      current = next;
    }
    if (!changed) break;
  }
  return current;
}

/** The compiler's hidden-cuboid cull at lattice resolution: a box whose whole one-cell ring is occupied draws nothing. */
function cullHidden(boxes: readonly Box[]): Box[] {
  const occ = new Set<number>();
  for (const b of boxes) for (let x = b.min[0]; x < b.max[0]; x++) for (let y = b.min[1]; y < b.max[1]; y++) for (let z = b.min[2]; z < b.max[2]; z++) occ.add(cellKey(x, y, z));
  return boxes.filter(b => {
    for (let x = b.min[0] - 1; x <= b.max[0]; x++) for (let y = b.min[1] - 1; y <= b.max[1]; y++) for (let z = b.min[2] - 1; z <= b.max[2]; z++) {
      const inside = x >= b.min[0] && x < b.max[0] && y >= b.min[1] && y < b.max[1] && z >= b.min[2] && z < b.max[2];
      if (!inside && !occ.has(cellKey(x, y, z))) return true;
    }
    return false;
  });
}

/**
 * Estimate the compiled cuboid count of resolved elements.
 *
 * A stud is exposed unless the cell above it lies inside ANOTHER element's
 * bounding box: the compiler probes a point just over the stud against the
 * other parts' world boxes (not their occupancy), so a stud under a slope's
 * empty low end is hidden too.
 */
export function estimateBudget(world: readonly WorldElement[], options: BudgetOptions = {}): BudgetEstimate {
  const facets = options.studFacets ?? DEFAULT_STUD_FACETS;
  const boxes = cullHidden(mergeBoxes(world.flatMap(elementBoxes)));
  const boxCells = new Map<number, Set<number>>(); // cell -> world positions whose bounding box holds it
  world.forEach((e, i) => {
    const xs = e.body.map(c => c[0]), zs = e.body.map(c => c[2]);
    // The bounding box of the whole footprint, not just the occupied cells.
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    for (let x = x0; x <= x1; x++) for (let y = e.y0; y < e.y0 + e.h; y++) for (let z = z0; z <= z1; z++) {
      const k = cellKey(x, y, z);
      const set = boxCells.get(k);
      if (set) set.add(i); else boxCells.set(k, new Set([i]));
    }
  });
  let studs = 0;
  world.forEach((e, i) => {
    for (const [x, y, z] of e.studs) {
      const holders = boxCells.get(cellKey(x, y, z));
      if (!holders || (holders.size === 1 && holders.has(i))) studs++;
    }
  });
  return { bodyCuboids: boxes.length, studCuboids: studs * facets, cuboidsEstimate: boxes.length + studs * facets };
}
