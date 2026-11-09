/**
 * The packer: covers the filled cells of a lattice with vocabulary elements.
 *
 * Greedy, scan order (plate layer, then z, then x). At the lowest free cell it
 * tries every eligible variant whose FIRST body cell is that cell, and takes the
 * best by (tier, cells covered), minus a penalty for every seam it would line
 * up with a seam in the layer directly below. That penalty is the running bond:
 * a vertical joint between two elements never repeats in the next course, so
 * courses interlock, and the elements' stud joins make the model one piece.
 *
 * Cell states in `owner`: `FREE` (filled, not yet covered), `EMPTY` (the
 * lattice cell is empty, or was hollowed out), `OPENING` (a window or arch void
 * left empty on purpose) and otherwise the id of the covering placement.
 */
import type { IntentLabel, IntentLattice } from '../types.js';
import { rankVariants, type Ranked, type Variant } from './variants.js';

export const FREE = -1;
export const EMPTY = -2;
export const OPENING = -3;

/** Penalty per face unit of a seam lined up with the course below. Larger than a 2-cell length difference at brick height. */
export const ALIGN_PENALTY = 10;
/** Penalty for a seam on a face the repair pass has forbidden. */
const FORBID_PENALTY = 1000;
/** Tie-break: prefer the orientation that alternates with the course number. Under one cell so it only breaks ties. */
const ORIENT_BONUS = 0.25;

/** One element placed on the lattice. */
export interface Placement {
  variant: Variant;
  at: readonly [number, number, number];
  /** Index into the lattice labels (0-based). */
  label: number;
  /** Lattice indices of the body cells. */
  cells: number[];
  removed: boolean;
}

/** The mutable cover of a lattice. */
export class Grid {
  readonly W: number;
  readonly H: number;
  readonly D: number;
  readonly lab: Uint16Array;
  readonly labels: readonly IntentLabel[];
  readonly owner: Int32Array;
  placements: Placement[] = [];

  constructor(lattice: IntentLattice) {
    [this.W, this.H, this.D] = lattice.dims;
    this.lab = lattice.cells;
    this.labels = lattice.labels;
    this.owner = new Int32Array(lattice.cells.length);
    for (let i = 0; i < this.owner.length; i++) this.owner[i] = lattice.cells[i] === 0 ? EMPTY : FREE;
  }

  idx(x: number, p: number, z: number): number { return (p * this.D + z) * this.W + x; }
  /** Decode a lattice index into `[x, p, z]`. */
  cellOf(i: number): [number, number, number] {
    const x = i % this.W;
    const r = (i - x) / this.W;
    const z = r % this.D;
    return [x, (r - z) / this.D, z];
  }
  /** A filled lattice cell that has not been hollowed out or left open. */
  solid(i: number): boolean { return this.owner[i] !== EMPTY && this.owner[i] !== OPENING; }

  /**
   * Remove the interior of every `hollowOk` run: a cell with two cells of its own label on each side of it along every axis. That
   * leaves a skin two studs thick at the sides and two plates thick at the top and bottom. Two, not one: a
   * single plate layer is cut into loose plates side by side and only a second layer bonds them, and a one-stud wall is
   * all 1xN bricks (more parts than the solid block it replaced). Judged on the lattice, not on the evolving cover, so
   * removing one cell never exposes the next. Returns the number of cells removed.
   */
  hollowOut(): number {
    const { W, H, D, lab, labels } = this;
    const doomed: number[] = [];
    const L = W * D;
    for (let p = 2; p < H - 2; p++) for (let z = 2; z < D - 2; z++) for (let x = 2; x < W - 2; x++) {
      const i = this.idx(x, p, z);
      const l = lab[i]!;
      if (l === 0 || !labels[l - 1]!.hollowOk) continue;
      // The skin is judged against cells of the SAME label: a roof sitting on a ceiling keeps its bottom two plates.
      if (lab[i - 1] === l && lab[i + 1] === l && lab[i - 2] === l && lab[i + 2] === l && lab[i - W] === l && lab[i + W] === l
        && lab[i - 2 * W] === l && lab[i + 2 * W] === l && lab[i - L] === l && lab[i + L] === l && lab[i - 2 * L] === l && lab[i + 2 * L] === l) doomed.push(i);
    }
    for (const i of doomed) this.owner[i] = EMPTY;
    return doomed.length;
  }
}

/** Shared packer state: ranked variants per label, built once. */
export class PackContext {
  private readonly ranks = new Map<number, Ranked[]>();
  /**
   * `mode`: 'full' = every eligible variant; 'plates' = single-layer plates only (a stack of plates has no course to line up);
   * 'generic' = bricks, plates and tiles only (no slopes, arches, frames), used to replace a special element that cannot be joined.
   */
  constructor(readonly variants: readonly Variant[], readonly labels: readonly IntentLabel[], readonly mode: 'full' | 'plates' | 'generic' = 'full') {}

  /** Eligible variants for a 0-based label index. */
  ranked(label: number): Ranked[] {
    let r = this.ranks.get(label);
    if (!r) {
      r = rankVariants(this.variants, this.labels[label]!);
      if (this.mode === 'plates') r = r.filter(x => x.variant.use === 'generic' && x.variant.h === 1 && x.variant.kind === 'plate');
      else if (this.mode === 'generic') r = r.filter(x => x.variant.use === 'generic');
      this.ranks.set(label, r);
    }
    return r;
  }
}

/** Options of one packing pass. */
export interface PackOptions {
  /** Only these lattice indices (sorted ascending) are scanned and used; default: the whole lattice. */
  region?: readonly number[];
  /** Face keys (`faceKey`) a seam must not fall on. */
  forbid?: ReadonlySet<number>;
}

/** Key of the vertical face between lattice cell `i` and its +x (`axis` 0) or +z (`axis` 1) neighbour. */
export function faceKey(i: number, axis: 0 | 1): number { return i * 2 + axis; }

/** Is `(dx, dy, dz)` one of the variant's body cells? Linear in the body, which is at most a few dozen cells. */
function inBody(v: Variant, dx: number, dy: number, dz: number): boolean {
  if (v.cells === v.w * v.d * v.h) return dx >= 0 && dx < v.w && dz >= 0 && dz < v.d && dy >= 0 && dy < v.h;
  const b = v.body;
  for (let k = 0; k < b.length; k += 3) if (b[k] === dx && b[k + 1] === dy && b[k + 2] === dz) return true;
  return false;
}

const NBR: ReadonlyArray<readonly [number, number, 0 | 1, 0 | 1]> = [[1, 0, 0, 0], [-1, 0, 0, 1], [0, 1, 1, 0], [0, -1, 1, 1]];

interface Best { ranked: Ranked; score: number; ax: number; ap: number; az: number }

/** Cover every free cell (of the region) with elements. Returns the placements made (also appended to `grid.placements`). */
export function packGrid(grid: Grid, ctx: PackContext, options: PackOptions = {}): Placement[] {
  const { W, H, D, lab, owner } = grid;
  const region = options.region;
  const scope = region ? new Set<number>(region) : undefined;
  const forbid = options.forbid && options.forbid.size ? options.forbid : undefined;
  const made: Placement[] = [];

  /** Is lattice cell `i` usable by the current pass? */
  const inScope = (i: number): boolean => (scope ? scope.has(i) : true);

  const evaluate = (r: Ranked, label: number, cx: number, cp: number, cz: number): Best | undefined => {
    const v = r.variant;
    const b = v.body;
    const ax = cx - b[0]!, ap = cp - b[1]!, az = cz - b[2]!;
    if (ax < 0 || ap < 0 || az < 0 || ax + v.w > W || ap + v.h > H || az + v.d > D) return undefined;
    for (let k = 0; k < b.length; k += 3) {
      const i = ((ap + b[k + 1]!) * D + az + b[k + 2]!) * W + ax + b[k]!;
      if (owner[i] !== FREE || lab[i] !== label + 1 || !inScope(i)) return undefined;
    }
    // Openings of an arch or window must be empty, or opening cells of the same label.
    for (let k = 0; k < v.voids.length; k += 3) {
      const x = ax + v.voids[k]!, p = ap + v.voids[k + 1]!, z = az + v.voids[k + 2]!;
      if (x >= W || p >= H || z >= D) return undefined;
      const i = (p * D + z) * W + x;
      if (!(lab[i] === 0 || (lab[i] === label + 1 && (owner[i] === FREE || owner[i] === OPENING)))) return undefined;
    }
    if (v.use === 'slope' || v.use === 'cone' || v.use === 'dome') {
      // A sloped surface has few studs: whatever stands on it is not joined to it. Only an exposed roof surface is a slope.
      for (let k = 0; k < b.length; k += 3) {
        const dx = b[k]!, dy = b[k + 1]! + 1, dz = b[k + 2]!;
        if (inBody(v, dx, dy, dz)) continue;
        const p = ap + dy;
        if (p < H && grid.solid((p * D + az + dz) * W + ax + dx) && lab[(p * D + az + dz) * W + ax + dx]) return undefined;
      }
    }
    if (r.topExposedOnly) {
      // A tile has no studs: nothing may stand on it.
      for (let k = 0; k < b.length; k += 3) {
        if (b[k + 1] !== v.h - 1) continue;
        const p = ap + v.h;
        if (p < H && lab[(p * D + az + b[k + 2]!) * W + ax + b[k]!]) return undefined;
      }
    }
    let score = r.tier * 1e6 + v.cells;
    // Seams against the course below (the bottom layer), and forbidden faces anywhere.
    const bottom = b[1]!;
    for (let k = 0; k < b.length; k += 3) {
      const layer = b[k + 1]!;
      if (layer !== bottom && !forbid) break; // body is in layer order: past the bottom layer only forbidden faces matter
      const x = ax + b[k]!, z = az + b[k + 2]!, p = ap + layer;
      for (const [dx, dz, axis, neg] of NBR) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) continue;
        if (inBody(v, nx - ax, layer, nz - az)) continue; // the element's own cell, not a seam
        const n = (p * D + nz) * W + nx;
        if (!grid.solid(n) || !lab[n]) continue;
        // `n` will belong to another element: a seam on this face.
        const lo = neg ? n : (p * D + z) * W + x;
        if (forbid && forbid.has(faceKey(lo, axis))) score -= FORBID_PENALTY;
        if (layer === bottom && ap > 0) {
          const ob = owner[((ap - 1) * D + z) * W + x]!, on = owner[((ap - 1) * D + nz) * W + nx]!;
          if (ob >= 0 && on >= 0 && ob !== on) score -= ALIGN_PENALTY;
        }
      }
    }
    if ((v.turn & 1) === (Math.floor(ap / 3) & 1)) score += ORIENT_BONUS;
    return { ranked: r, score, ax, ap, az };
  };

  const place = (best: Best, label: number): Placement => {
    const v = best.ranked.variant;
    const cells: number[] = [];
    for (let k = 0; k < v.body.length; k += 3) {
      const i = ((best.ap + v.body[k + 1]!) * D + best.az + v.body[k + 2]!) * W + best.ax + v.body[k]!;
      cells.push(i);
    }
    const id = grid.placements.length;
    for (const i of cells) owner[i] = id;
    for (let k = 0; k < v.voids.length; k += 3) {
      const i = ((best.ap + v.voids[k + 1]!) * D + best.az + v.voids[k + 2]!) * W + best.ax + v.voids[k]!;
      if (lab[i] === label + 1) owner[i] = OPENING;
    }
    const pl: Placement = { variant: v, at: [best.ax, best.ap, best.az], label, cells, removed: false };
    grid.placements.push(pl);
    made.push(pl);
    return pl;
  };

  const order = region ?? null;
  const total = region ? region.length : owner.length;
  for (let n = 0; n < total; n++) {
    const i = order ? order[n]! : n;
    if (owner[i] !== FREE) continue;
    const label = lab[i]! - 1;
    const [cx, cp, cz] = grid.cellOf(i);
    let best: Best | undefined;
    for (const r of ctx.ranked(label)) {
      // Ranked best-first by (tier, cells): once the best found beats the optimistic score, stop.
      if (best && r.tier * 1e6 + r.variant.cells + ORIENT_BONUS <= best.score) break;
      const c = evaluate(r, label, cx, cp, cz);
      if (c && (!best || c.score > best.score)) best = c;
    }
    if (best) place(best, label);
    else owner[i] = OPENING; // a label nothing can build (a window with no frame): an open hole
  }
  return made;
}
