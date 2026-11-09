/**
 * Planar polygon helpers for massing (A05, BIZ-05).
 *
 * Every function works in the site's metre frame: `[x, z]` with x east and z SOUTH (the stud lattice's own
 * x/z, so a footprint drawn here lands on the lattice without a flip). Rings are OPEN lists of vertices (the
 * closing edge from the last vertex to the first is implied, no repeated first point).
 *
 * Orientation convention: `signedArea` is the plain shoelace sum over `[x, z]`, so a ring is "positive" when it
 * runs x -> z counter-clockwise in the maths sense. Outer rings are normalised positive, holes negative
 * (`orientRing`). That is a convention for deterministic output only; nothing downstream relies on a handedness
 * beyond "outer and hole differ".
 */
import type { Vec2m } from '../types.js';

/** A ring vertex that remembers which vertex of the ORIGINAL (unsimplified) ring it came from. */
export interface TrackedPoint {
  x: number;
  z: number;
  /** Index of the original-ring vertex this point started as (the start of the edge it begins). */
  src: number;
}

/** Shoelace area of an open ring; positive for counter-clockwise (x -> z). */
export function signedArea(ring: ReadonlyArray<Vec2m>): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i]!;
    const [x1, z1] = ring[(i + 1) % ring.length]!;
    sum += x0 * z1 - x1 * z0;
  }
  return sum / 2;
}

/** Unsigned area of a ring. */
export function ringArea(ring: ReadonlyArray<Vec2m>): number {
  return Math.abs(signedArea(ring));
}

/** Area of an outer ring minus its holes. */
export function areaWithHoles(outer: ReadonlyArray<Vec2m>, holes: ReadonlyArray<ReadonlyArray<Vec2m>>): number {
  return ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0);
}

/** Returns the ring with the requested orientation, reversing it only when needed. */
export function orientRing<T extends Vec2m | TrackedPoint>(ring: T[], positive: boolean): T[] {
  const area = signedArea(ring.map(p => (Array.isArray(p) ? (p as Vec2m) : [(p as TrackedPoint).x, (p as TrackedPoint).z] as Vec2m)));
  return (area >= 0) === positive ? ring : [...ring].reverse();
}

/** Even-odd point-in-ring test. */
export function pointInRing(x: number, z: number, ring: ReadonlyArray<Vec2m>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point is inside the outer ring and outside every hole. */
export function pointInPolygon(
  x: number, z: number, outer: ReadonlyArray<Vec2m>, holes: ReadonlyArray<ReadonlyArray<Vec2m>>,
): boolean {
  return pointInRing(x, z, outer) && !holes.some(h => pointInRing(x, z, h));
}

/** Axis-aligned bounds of a ring set: `[minX, minZ, maxX, maxZ]`. */
export function ringBounds(rings: ReadonlyArray<ReadonlyArray<Vec2m>>): [number, number, number, number] {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const ring of rings) {
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return [minX, minZ, maxX, maxZ];
}

/** Perpendicular distance from `p` to the segment `a`-`b` (distance to the nearer end beyond it). */
export function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Rotates a point about the origin by `deg` (positive turns +x toward +z). */
export function rotatePoint(p: Vec2m, deg: number): Vec2m {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/**
 * The dominant wall direction of a set of rings, in degrees within `(-45, 45]`: the length-weighted circular mean
 * of every edge angle taken modulo 90 degrees. Rotating the site by the NEGATIVE of this angle makes the
 * building's own walls axis-aligned, which is what lets the stud grid represent them exactly.
 *
 * Returns 0 for an empty input. Folding mod 90 (angle * 4 on the unit circle) is the standard trick for
 * orientations with 4-fold symmetry, so a wall and its perpendicular vote for the same answer.
 */
export function dominantAxisDeg(rings: ReadonlyArray<ReadonlyArray<Vec2m>>): number {
  let sx = 0, sz = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i]!;
      const [x1, z1] = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len === 0) continue;
      const theta = Math.atan2(z1 - z0, x1 - x0) * 4;
      sx += len * Math.cos(theta);
      sz += len * Math.sin(theta);
    }
  }
  if (sx === 0 && sz === 0) return 0;
  const deg = (Math.atan2(sz, sx) * 180) / Math.PI / 4;
  // atan2 / 4 lands in (-45, 45]; normalise the -45 edge so the range is half-open on the same side.
  return deg <= -45 ? deg + 90 : deg;
}

/**
 * Douglas-Peucker on a CLOSED ring. The usual open-polyline version has no good place to cut a ring, so the ring
 * is split at vertex 0 and its farthest vertex, and each half is simplified as a polyline; both split vertices are
 * always kept. Original indices ride along in `src`.
 */
export function simplifyClosedRing(ring: ReadonlyArray<TrackedPoint>, toleranceM: number): TrackedPoint[] {
  const n = ring.length;
  if (n <= 3) return [...ring];
  let far = 1, farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i]!.x - ring[0]!.x, ring[i]!.z - ring[0]!.z);
    if (d > farD) { farD = d; far = i; }
  }
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[far] = true;
  const walk = (lo: number, hi: number): void => {
    // Iterative Douglas-Peucker over ring indices lo..hi (hi may wrap to n, which is vertex 0 again).
    const stack: Array<[number, number]> = [[lo, hi]];
    while (stack.length > 0) {
      const [a, b] = stack.pop()!;
      const pa = ring[a % n]!, pb = ring[b % n]!;
      let worst = -1, worstD = toleranceM;
      for (let i = a + 1; i < b; i++) {
        const p = ring[i % n]!;
        const d = distanceToSegment(p.x, p.z, pa.x, pa.z, pb.x, pb.z);
        if (d > worstD) { worstD = d; worst = i; }
      }
      if (worst >= 0) {
        keep[worst % n] = true;
        stack.push([a, worst], [worst, b]);
      }
    }
  };
  walk(0, far);
  walk(far, n);
  return ring.filter((_, i) => keep[i]);
}

/** Removes consecutive duplicate vertices and vertices lying on the straight line between their neighbours. */
export function dropCollinear(ring: ReadonlyArray<TrackedPoint>, epsilon = 1e-9): TrackedPoint[] {
  let pts = [...ring];
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    const next: TrackedPoint[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length]!;
      const cur = pts[i]!;
      const nxt = pts[(i + 1) % pts.length]!;
      const same = Math.abs(cur.x - prev.x) < epsilon && Math.abs(cur.z - prev.z) < epsilon;
      const cross = (cur.x - prev.x) * (nxt.z - cur.z) - (cur.z - prev.z) * (nxt.x - cur.x);
      const line = distanceToSegment(cur.x, cur.z, prev.x, prev.z, nxt.x, nxt.z);
      if (same || (Math.abs(cross) < epsilon && line < epsilon)) { changed = true; continue; }
      next.push(cur);
    }
    pts = next;
  }
  return pts;
}

/** True when two segments properly cross (shared endpoints and touching do not count). */
function segmentsCross(a: Vec2m, b: Vec2m, c: Vec2m, d: Vec2m): boolean {
  const o = (p: Vec2m, q: Vec2m, r: Vec2m): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when no two non-adjacent edges of the ring properly cross. O(n^2), fine for simplified rings. */
export function isSimpleRing(ring: ReadonlyArray<Vec2m>): boolean {
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(ring[i]!, ring[(i + 1) % n]!, ring[j]!, ring[(j + 1) % n]!)) return false;
    }
  }
  return true;
}

/**
 * Fraction of the polygon (outer minus holes) covered by a union of other polygons, by sampling a regular grid
 * of `stepM` over the polygon's bounds. A boolean union of 100 polygons is not needed for "is this outline
 * already replaced by its parts"; a 1 m grid answers it within a few percent.
 */
export function coverageFraction(
  outer: ReadonlyArray<Vec2m>,
  holes: ReadonlyArray<ReadonlyArray<Vec2m>>,
  covers: ReadonlyArray<{ outer: ReadonlyArray<Vec2m>; holes: ReadonlyArray<ReadonlyArray<Vec2m>> }>,
  stepM = 1,
): number {
  const [minX, minZ, maxX, maxZ] = ringBounds([outer]);
  let inside = 0, covered = 0;
  for (let x = minX + stepM / 2; x < maxX; x += stepM) {
    for (let z = minZ + stepM / 2; z < maxZ; z += stepM) {
      if (!pointInPolygon(x, z, outer, holes)) continue;
      inside++;
      if (covers.some(c => pointInPolygon(x, z, c.outer, c.holes))) covered++;
    }
  }
  return inside === 0 ? 0 : covered / inside;
}
