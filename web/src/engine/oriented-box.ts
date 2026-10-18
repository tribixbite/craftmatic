/**
 * A turned cuboid as a PARALLELEPIPED, and its exact intersection with an
 * axis-aligned box. Shared by the collider grid (a turned part's colliders are
 * laid from where its cuboids are, `buildColliderGrid`) and the simulator's
 * drawn-geometry checks (a turned cube's corner box is not where it is drawn).
 * Pure math, no pack or engine imports.
 */

/** A point or vector, three components. */
export type Vec3 = [number, number, number];

/**
 * A parallelepiped `o + a·e0 + b·e1 + c·e2` for a, b, c in [0, 1], with the
 * inverse of the edge matrix (columns e0 e1 e2, row-major) that takes a point
 * to its (a, b, c). A cuboid under any rotation and an axis scale (the
 * collider grid's frame may scale y apart from x/z) is one.
 */
export interface Parallelepiped { o: Vec3; e: readonly [Vec3, Vec3, Vec3]; inv: readonly number[] }

/** Numerical slack of the clipping tests, in the box's units and in the parallelepiped's unit parameters. */
const CLIP_EPS = 1e-7;

/** A parallelepiped from its origin corner and three edges, or null when it is degenerate (no volume). */
export function parallelepiped(o: Vec3, e: readonly [Vec3, Vec3, Vec3]): Parallelepiped | null {
  // Columns e0 e1 e2: m = [[e0x e1x e2x], [e0y e1y e2y], [e0z e1z e2z]].
  const m = [e[0][0], e[1][0], e[2][0], e[0][1], e[1][1], e[2][1], e[0][2], e[1][2], e[2][2]];
  const c00 = m[4]! * m[8]! - m[5]! * m[7]!, c01 = m[5]! * m[6]! - m[3]! * m[8]!, c02 = m[3]! * m[7]! - m[4]! * m[6]!;
  const det = m[0]! * c00 + m[1]! * c01 + m[2]! * c02;
  const scale = Math.hypot(...e[0]) * Math.hypot(...e[1]) * Math.hypot(...e[2]);
  if (!(scale > 0) || Math.abs(det) <= 1e-9 * scale) return null;
  const inv = [
    c00 / det, (m[2]! * m[7]! - m[1]! * m[8]!) / det, (m[1]! * m[5]! - m[2]! * m[4]!) / det,
    c01 / det, (m[0]! * m[8]! - m[2]! * m[6]!) / det, (m[2]! * m[3]! - m[0]! * m[5]!) / det,
    c02 / det, (m[1]! * m[6]! - m[0]! * m[7]!) / det, (m[0]! * m[4]! - m[1]! * m[3]!) / det,
  ];
  return { o, e, inv };
}

/**
 * A parallelepiped from a cube's eight corners in `cubeCorners` order (bit 0
 * of the index is +x, bit 1 +y, bit 2 +z of the cube's own axes).
 */
export function parallelepipedFromCorners(k: readonly (readonly number[])[]): Parallelepiped | null {
  const o: Vec3 = [k[0]![0]!, k[0]![1]!, k[0]![2]!];
  const edge = (i: number): Vec3 => [k[i]![0]! - o[0], k[i]![1]! - o[1], k[i]![2]! - o[2]];
  return parallelepiped(o, [edge(1), edge(2), edge(4)]);
}

/** Whether a parallelepiped's edges all lie along the axes (it IS its corner box). */
export function isAxisAligned(p: Parallelepiped, eps = 1e-6): boolean {
  return p.e.every(v => {
    const n = Math.hypot(...v);
    return v.filter(c => Math.abs(c) > eps * Math.max(1, n)).length <= 1;
  });
}

/**
 * The axis-aligned bounds of (parallelepiped ∩ box `lo..hi`), exactly, or null
 * when they do not meet. Both are convex, so every vertex of the intersection
 * is one of: a parallelepiped corner inside the box, a box corner inside the
 * parallelepiped, a parallelepiped edge crossing a box face, or a box edge
 * crossing a parallelepiped face. The bounds of those points are the bounds
 * of the intersection.
 */
export function clipParallelepiped(p: Parallelepiped, lo: readonly number[], hi: readonly number[]): { min: Vec3; max: Vec3 } | null {
  const mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, z: number): void => {
    if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x;
    if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y;
    if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
  };
  const inBox = (q: Vec3, skip = -1): boolean => {
    for (let k = 0; k < 3; k++) if (k !== skip && (q[k]! < lo[k]! - CLIP_EPS || q[k]! > hi[k]! + CLIP_EPS)) return false;
    return true;
  };
  const { o, e, inv } = p;
  // Parallelepiped corners, and its 12 edges against the box's 6 faces.
  for (let c = 0; c < 8; c++) {
    const a = c & 1, b = (c >> 1) & 1, g = (c >> 2) & 1;
    const q: Vec3 = [o[0] + a * e[0][0] + b * e[1][0] + g * e[2][0], o[1] + a * e[0][1] + b * e[1][1] + g * e[2][1], o[2] + a * e[0][2] + b * e[1][2] + g * e[2][2]];
    if (inBox(q)) add(q[0], q[1], q[2]);
    // The edges leaving this corner along each axis the corner sits at 0 on (12 edges in all).
    for (let k = 0; k < 3; k++) {
      if (((c >> k) & 1) === 1) continue;
      const d = e[k]!;
      for (let j = 0; j < 3; j++) {
        if (Math.abs(d[j]!) < 1e-12) continue;
        for (let side = 0; side < 2; side++) {
          const s = side ? hi[j]! : lo[j]!;
          const u = (s - q[j]!) / d[j]!;
          if (u < -CLIP_EPS || u > 1 + CLIP_EPS) continue;
          const r: Vec3 = [q[0] + u * d[0], q[1] + u * d[1], q[2] + u * d[2]];
          r[j] = s;
          if (inBox(r, j)) add(r[0], r[1], r[2]);
        }
      }
    }
  }
  // Box corners inside the parallelepiped, and the box's 12 edges against its 6 faces (in its parameters).
  const param = (q: Vec3): Vec3 => {
    const d0 = q[0] - o[0], d1 = q[1] - o[1], d2 = q[2] - o[2];
    return [inv[0]! * d0 + inv[1]! * d1 + inv[2]! * d2, inv[3]! * d0 + inv[4]! * d1 + inv[5]! * d2, inv[6]! * d0 + inv[7]! * d1 + inv[8]! * d2];
  };
  const inUnit = (a: Vec3, skip = -1): boolean => {
    for (let k = 0; k < 3; k++) if (k !== skip && (a[k]! < -CLIP_EPS || a[k]! > 1 + CLIP_EPS)) return false;
    return true;
  };
  for (let c = 0; c < 8; c++) {
    const q: Vec3 = [(c & 1) ? hi[0]! : lo[0]!, ((c >> 1) & 1) ? hi[1]! : lo[1]!, ((c >> 2) & 1) ? hi[2]! : lo[2]!];
    const a = param(q);
    if (inUnit(a)) add(q[0], q[1], q[2]);
    for (let j = 0; j < 3; j++) {
      if (((c >> j) & 1) === 1) continue;
      const len = hi[j]! - lo[j]!;
      if (!(len > 0)) continue;
      // Moving along box axis j changes the parameters by column j of `inv`, times the distance.
      const da: Vec3 = [inv[j]! * len, inv[3 + j]! * len, inv[6 + j]! * len];
      for (let k = 0; k < 3; k++) {
        if (Math.abs(da[k]!) < 1e-12) continue;
        for (let f = 0; f < 2; f++) {
          const u = (f - a[k]!) / da[k]!;
          if (u < -CLIP_EPS || u > 1 + CLIP_EPS) continue;
          const b: Vec3 = [a[0] + u * da[0], a[1] + u * da[1], a[2] + u * da[2]];
          if (!inUnit(b, k)) continue;
          const r: Vec3 = [q[0], q[1], q[2]];
          r[j] = q[j]! + Math.min(1, Math.max(0, u)) * len;
          add(r[0], r[1], r[2]);
        }
      }
    }
  }
  if (!(mn[0] <= mx[0])) return null;
  // Clamp to the box: a point accepted within the slack may sit a hair outside it.
  for (let k = 0; k < 3; k++) { mn[k] = Math.max(mn[k]!, lo[k]!); mx[k] = Math.min(mx[k]!, hi[k]!); }
  return { min: mn, max: mx };
}
