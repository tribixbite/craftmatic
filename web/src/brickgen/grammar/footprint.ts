/**
 * A volume's footprint on the stud grid, and the distance fields the roof grammars read (A07, BIZ-05).
 *
 * `rasterise` is the same sampling the plain massing uses (a stud cell is inside when its centre is inside the ring
 * and outside every hole), kept here so the grammar does not depend on the plain stand-in it replaces.
 * TODO(MQ): import the raster from `massing/` once it exports one instead of this copy.
 */
import { pointInRing } from '../massing/geometry.js';
import type { MassVolume } from '../types.js';

/** A rasterised footprint: cell `(i, j)` of the mask is lattice cell `(x0 + i, z0 + j)`. */
export interface Mask {
  x0: number;
  z0: number;
  w: number;
  d: number;
  inside: Uint8Array;
}

/** Rasterise one volume's footprint at `spm` studs per metre; undefined when it is under one stud in either axis. */
export function rasterise(v: Pick<MassVolume, 'outer' | 'holes'>, spm: number): Mask | undefined {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of v.outer) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const i0 = Math.floor(x0 * spm + 1e-6), j0 = Math.floor(z0 * spm + 1e-6);
  const w = Math.ceil(x1 * spm - 1e-6) - i0, d = Math.ceil(z1 * spm - 1e-6) - j0;
  if (w < 1 || d < 1) return undefined;
  const inside = new Uint8Array(w * d);
  for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) {
    const x = (i0 + i + 0.5) / spm, z = (j0 + j + 0.5) / spm;
    if (pointInRing(x, z, v.outer) && !v.holes.some(h => pointInRing(x, z, h))) inside[i + w * j] = 1;
  }
  return { x0: i0, z0: j0, w, d, inside };
}

/** Is mask cell `(i, j)` inside the footprint (false outside the mask's box)? */
export function maskHas(m: Mask, i: number, j: number): boolean {
  return i >= 0 && j >= 0 && i < m.w && j < m.d && m.inside[i + m.w * j] === 1;
}

/** Four-neighbour steps in the bricker's descent-direction order: 0 +x, 1 -x, 2 +z, 3 -z. */
export const STEPS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Boundary cells of the footprint (an inside cell with a four-neighbour outside): the wall ring. */
export function isBoundary(m: Mask, i: number, j: number): boolean {
  return STEPS.some(([di, dj]) => !maskHas(m, i + di, j + dj));
}

/** One-dimensional squared Euclidean distance transform (Felzenszwalb and Huttenlocher) of `f[0..n)` into `out`. */
function edt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  const cut = (q: number, p: number): number => ((f[q]! + q * q) - (f[p]! + p * p)) / (2 * q - 2 * p);
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = cut(q, v[k]!);
    while (s <= z[k]!) { k--; s = cut(q, v[k]!); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    out[q] = (q - p) * (q - p) + f[p]!;
  }
}

/**
 * Euclidean distance, in studs, from each inside cell's centre to the nearest OUTSIDE cell's centre (1 for a
 * boundary cell); 0 outside. Linear time, so it is safe on the 500-stud footprints of a palace.
 */
export function distanceToOutside(m: Mask): Float32Array {
  // Pad by one outside cell so the footprint's own border counts as next to the outside.
  const W = m.w + 2, D = m.d + 2;
  const INF = 1e12;
  const g = new Float64Array(W * D);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) g[i + W * j] = maskHas(m, i - 1, j - 1) ? INF : 0;
  const n = Math.max(W, D);
  const f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < D; j++) f[j] = g[i + W * j]!;
    edt1d(f, D, out, v, z);
    for (let j = 0; j < D; j++) g[i + W * j] = out[j]!;
  }
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < W; i++) f[i] = g[i + W * j]!;
    edt1d(f, W, out, v, z);
    for (let i = 0; i < W; i++) g[i + W * j] = out[i]!;
  }
  const dist = new Float32Array(m.w * m.d);
  for (let j = 0; j < m.d; j++) for (let i = 0; i < m.w; i++) if (m.inside[i + m.w * j]) dist[i + m.w * j] = Math.sqrt(g[i + 1 + W * (j + 1)]!);
  return dist;
}

/** Number of consecutive inside cells strictly before / after `(i, j)` along an axis (`axis` 0 = x, 1 = z). */
export function runAround(m: Mask, i: number, j: number, axis: 0 | 1): { before: number; after: number } {
  const di = axis === 0 ? 1 : 0, dj = axis === 1 ? 1 : 0;
  let before = 0, after = 0;
  while (maskHas(m, i - di * (before + 1), j - dj * (before + 1))) before++;
  while (maskHas(m, i + di * (after + 1), j + dj * (after + 1))) after++;
  return { before, after };
}
