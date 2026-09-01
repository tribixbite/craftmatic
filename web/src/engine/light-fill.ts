/**
 * Interior light fill — "add light sources to enclosed dark interiors".
 *
 * A voxelized LEGO set (or any uploaded schematic) is a solid shell with sealed
 * air pockets inside it. Placed in Minecraft those rooms are pitch black and
 * mob-spawnable. This pass finds the pockets and drops a sparse lattice of
 * light-emitting blocks on their floors.
 *
 * Algorithm (deliberately simple, offline-testable, deterministic):
 *   1. 6-connected flood fill of AIR inward from every boundary cell → the
 *      cells reachable from outside ("exterior air"). An open porch, a doorway,
 *      a window — anything with a path to the outside — is exterior and is
 *      never lit.
 *   2. Every remaining air cell belongs to an ENCLOSED pocket. Label each
 *      pocket by a second flood fill.
 *   3. Pockets smaller than `minPocketCells` are skipped (a one-voxel bubble
 *      between two bricks is not a room).
 *   4. In a qualifying pocket, candidate cells are FLOOR cells (y === 0 or the
 *      cell below is solid). They're bucketed by `floor(coord / spacing)` and
 *      the first candidate per bucket wins, so lights land roughly every
 *      `spacing` blocks along the floor instead of carpeting it.
 *
 * OFF is the default everywhere: nothing calls this unless the user ticks the
 * export setting, and with the flag off the exported bytes are unchanged (the
 * S3 byte-identity gate depends on that).
 *
 * Memory note: the two marker arrays are Uint8Array(cells) and the BFS stack is
 * a growable Int32Array, so a pocket spanning the whole grid is the worst case.
 * At the 30M-cell export cap that is ~30 MB + up to ~120 MB transient — the
 * reason this is opt-in rather than always-on.
 */

import type { BlockGrid } from '@craft/schem/types.js';

export interface LightFillOptions {
  /** Block placed in the pockets. Default `minecraft:glowstone`. */
  lightBlock?: string;
  /** Pockets with fewer cells than this are left dark. Default 8. */
  minPocketCells?: number;
  /** Approximate spacing (in cells) between lights along a pocket floor. Default 6. */
  spacing?: number;
}

export interface LightFillResult {
  /** Enclosed pockets that qualified (>= minPocketCells) and were lit. */
  pockets: number;
  /** Light blocks actually placed. */
  lights: number;
  /** Enclosed pockets skipped for being too small. */
  skippedSmall: number;
}

/** Growable int stack — the flood-fill frontier. */
class IntStack {
  private buf = new Int32Array(1024);
  private sp = 0;
  push(v: number): void {
    if (this.sp === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.sp++] = v;
  }
  pop(): number { return this.buf[--this.sp]!; }
  get empty(): boolean { return this.sp === 0; }
}

/**
 * Place light blocks in the grid's enclosed air pockets. Mutates `grid`.
 * Returns what it did (0 pockets = nothing was enclosed).
 */
export function addInteriorLights(grid: BlockGrid, opts: LightFillOptions = {}): LightFillResult {
  const lightBlock = opts.lightBlock ?? 'minecraft:glowstone';
  const minPocketCells = Math.max(1, opts.minPocketCells ?? 8);
  const spacing = Math.max(1, Math.floor(opts.spacing ?? 6));

  const { width, height, length } = grid;
  const result: LightFillResult = { pockets: 0, lights: 0, skippedSmall: 0 };
  const size = width * height * length;
  if (size <= 0) return result;

  const data = grid.rawData;
  // Flat index = (y * length + z) * width + x  (BlockGrid's own layout).
  const zStride = width;
  const yStride = width * length;

  // 0 = untouched, 1 = exterior air, 2 = pocket air (visited)
  const state = new Uint8Array(size);
  const stack = new IntStack();

  const pushIfAir = (i: number, mark: number): void => {
    if (data[i] === 0 && state[i] === 0) { state[i] = mark; stack.push(i); }
  };

  // ── 1. Flood from the boundary ────────────────────────────────────────────
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      const rowBase = y * yStride + z * zStride;
      const onZEdge = z === 0 || z === length - 1;
      const onYEdge = y === 0 || y === height - 1;
      if (onZEdge || onYEdge) {
        for (let x = 0; x < width; x++) pushIfAir(rowBase + x, 1);
      } else {
        pushIfAir(rowBase, 1);
        pushIfAir(rowBase + width - 1, 1);
      }
    }
  }
  floodFrom(stack, state, data, 1, width, length, height, zStride, yStride);

  // ── 2..4. Enclosed pockets ────────────────────────────────────────────────
  // Bucketed floor candidates for the pocket currently being scanned.
  const buckets = new Map<number, number>();
  const bucketsX = Math.ceil(width / spacing) || 1;
  const bucketsZ = Math.ceil(length / spacing) || 1;

  for (let seed = 0; seed < size; seed++) {
    if (data[seed] !== 0 || state[seed] !== 0) continue;

    // Collect the component: count cells and bucket floor candidates as we go.
    buckets.clear();
    let cells = 0;
    state[seed] = 2;
    stack.push(seed);
    while (!stack.empty) {
      const i = stack.pop();
      cells++;
      // Floor candidate: bottom of the grid, or a solid cell directly below.
      const below = i - yStride;
      if (i < yStride || data[below] !== 0) {
        const y = (i / yStride) | 0;
        const rem = i - y * yStride;
        const z = (rem / zStride) | 0;
        const x = rem - z * zStride;
        const key =
          ((x / spacing) | 0) +
          ((z / spacing) | 0) * bucketsX +
          ((y / spacing) | 0) * bucketsX * bucketsZ;
        // First candidate per bucket wins (flood order is deterministic).
        if (!buckets.has(key)) buckets.set(key, i);
      }
      // 6-neighbourhood, guarded at the grid faces.
      const y = (i / yStride) | 0;
      const rem = i - y * yStride;
      const z = (rem / zStride) | 0;
      const x = rem - z * zStride;
      if (x > 0) pushIfAir(i - 1, 2);
      if (x < width - 1) pushIfAir(i + 1, 2);
      if (z > 0) pushIfAir(i - zStride, 2);
      if (z < length - 1) pushIfAir(i + zStride, 2);
      if (y > 0) pushIfAir(i - yStride, 2);
      if (y < height - 1) pushIfAir(i + yStride, 2);
    }

    if (cells < minPocketCells) { result.skippedSmall++; continue; }
    if (buckets.size === 0) continue; // no floor at all — nothing sensible to light
    result.pockets++;
    const lightId = grid.paletteIndexOf(lightBlock);
    for (const i of buckets.values()) { data[i] = lightId; result.lights++; }
  }

  return result;
}

/** 6-connected flood over air cells already seeded in `stack`. */
function floodFrom(
  stack: IntStack,
  state: Uint8Array,
  data: Uint16Array,
  mark: number,
  width: number,
  length: number,
  height: number,
  zStride: number,
  yStride: number,
): void {
  while (!stack.empty) {
    const i = stack.pop();
    const y = (i / yStride) | 0;
    const rem = i - y * yStride;
    const z = (rem / zStride) | 0;
    const x = rem - z * zStride;
    const visit = (j: number) => {
      if (data[j] === 0 && state[j] === 0) { state[j] = mark; stack.push(j); }
    };
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (z > 0) visit(i - zStride);
    if (z < length - 1) visit(i + zStride);
    if (y > 0) visit(i - yStride);
    if (y < height - 1) visit(i + yStride);
  }
}
