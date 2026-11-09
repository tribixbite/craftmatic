/**
 * Footprint simplification + stud snapping (A05, BIZ-05).
 *
 * Works in STUD units (the caller multiplies metres by studs-per-metre), so "on the grid" means "integer".
 * Pipeline per ring: Douglas-Peucker (closed ring) -> classify each edge as axis-aligned or not -> give every
 * axis-aligned edge ONE snapped line coordinate -> rebuild each vertex from its two edges -> snap the rest to
 * integers -> drop duplicate/collinear vertices -> reject the result if snapping made it self-intersect.
 *
 * Edges within `axisToleranceDeg` of an axis become exactly axis-aligned (the site is rotated to its dominant
 * wall direction first, `dominantAxisDeg`). Edges at other angles keep their diagonal between snapped endpoints and
 * are COUNTED (`nonOrthogonalEdges`): v1 does not step them or turn sub-models.
 * TODO(non-orthogonal): approximate diagonal walls with stepped walls or a turntable-rotated sub-model.
 */
import { dropCollinear, isSimpleRing, simplifyClosedRing, type TrackedPoint } from './geometry.js';
import type { Vec2m } from '../types.js';

export interface SimplifyOptions {
  /** Douglas-Peucker tolerance in studs (default 0.5: half a stud). */
  toleranceStuds?: number;
  /** An edge within this many degrees of an axis is made axis-aligned (default 10). */
  axisToleranceDeg?: number;
}

export interface SimplifiedRing {
  /** Integer stud coordinates; `src` is the original-ring vertex each edge starts at. */
  points: TrackedPoint[];
  /** Edges that are neither horizontal nor vertical (`TODO(non-orthogonal)`). */
  nonOrthogonalEdges: number;
  /** How the ring was produced: `snapped` is the normal path; the others are reported fallbacks. */
  mode: 'snapped' | 'rounded' | 'unsnapped' | 'min-feature';
}

type Axis = 'h' | 'v' | null;

const toVec = (pts: ReadonlyArray<TrackedPoint>): Vec2m[] => pts.map(p => [p.x, p.z] as Vec2m);

function classify(a: TrackedPoint, b: TrackedPoint, tolDeg: number): Axis {
  const dx = Math.abs(b.x - a.x), dz = Math.abs(b.z - a.z);
  const t = Math.tan((tolDeg * Math.PI) / 180);
  if (dz <= dx * t) return 'h';
  if (dx <= dz * t) return 'v';
  return null;
}

/** Plain rounding of every vertex; the fallback when regularisation self-intersects. */
function roundRing(pts: ReadonlyArray<TrackedPoint>): TrackedPoint[] {
  return dropCollinear(pts.map(p => ({ x: Math.round(p.x), z: Math.round(p.z), src: p.src })));
}

/** Simplifies and snaps one ring given in stud units (open ring, any orientation). */
export function simplifyRingStuds(ring: ReadonlyArray<Vec2m>, opts: SimplifyOptions = {}): SimplifiedRing {
  const tol = opts.toleranceStuds ?? 0.5;
  const axisTol = opts.axisToleranceDeg ?? 10;
  const tracked: TrackedPoint[] = ring.map(([x, z], i) => ({ x, z, src: i }));
  const simp = dropCollinear(simplifyClosedRing(tracked, tol), 1e-9);
  const n = simp.length;
  if (n < 3) return { points: simp, nonOrthogonalEdges: 0, mode: 'unsnapped' };

  const axes: Axis[] = simp.map((p, i) => classify(p, simp[(i + 1) % n]!, axisTol));
  // One snapped line coordinate per axis-aligned edge: h edges fix z, v edges fix x. Consecutive edges on the
  // same axis share a coordinate (length-weighted mean) so a small jog collapses instead of leaving a stub.
  const lineRaw: number[] = simp.map((p, i) => {
    const q = simp[(i + 1) % n]!;
    return axes[i] === 'h' ? (p.z + q.z) / 2 : axes[i] === 'v' ? (p.x + q.x) / 2 : 0;
  });
  const lenOf = (i: number): number => Math.hypot(simp[(i + 1) % n]!.x - simp[i]!.x, simp[(i + 1) % n]!.z - simp[i]!.z);
  const line = [...lineRaw];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (axes[i] !== null && axes[i] === axes[j]) {
      const li = lenOf(i), lj = lenOf(j);
      const m = (lineRaw[i]! * li + lineRaw[j]! * lj) / (li + lj || 1);
      line[i] = m;
      line[j] = m;
    }
  }
  const snapped = line.map(Math.round);

  const out: TrackedPoint[] = simp.map((p, i) => {
    const prev = (i - 1 + n) % n;
    const aIn = axes[prev], aOut = axes[i];
    let x = Math.round(p.x), z = Math.round(p.z);
    // A vertex takes its x from an adjacent vertical edge and its z from an adjacent horizontal edge.
    if (aIn === 'v') x = snapped[prev]!; else if (aOut === 'v') x = snapped[i]!;
    if (aIn === 'h') z = snapped[prev]!; else if (aOut === 'h') z = snapped[i]!;
    return { x, z, src: p.src };
  });
  const clean = dropCollinear(out);
  if (clean.length >= 3 && isSimpleRing(toVec(clean))) {
    const nonOrth = clean.filter((p, i) => {
      const q = clean[(i + 1) % clean.length]!;
      return p.x !== q.x && p.z !== q.z;
    }).length;
    return { points: clean, nonOrthogonalEdges: nonOrth, mode: 'snapped' };
  }
  const rounded = roundRing(simp);
  if (rounded.length >= 3 && isSimpleRing(toVec(rounded))) {
    const nonOrth = rounded.filter((p, i) => {
      const q = rounded[(i + 1) % rounded.length]!;
      return p.x !== q.x && p.z !== q.z;
    }).length;
    return { points: rounded, nonOrthogonalEdges: nonOrth, mode: 'rounded' };
  }
  return { points: simp, nonOrthogonalEdges: simp.length, mode: 'unsnapped' };
}

/**
 * A feature smaller than a stud (a 0.8 m pinnacle at 1 stud per metre) cannot keep its shape; it becomes the
 * smallest square the grid can hold, at least 1 x 1 stud, centred on its bounding box. Returns null when the ring
 * is so small (< `minAreaStuds2`) that it is dropped instead.
 */
export function minFeatureSquare(ring: ReadonlyArray<Vec2m>, minAreaStuds2 = 0.2): SimplifiedRing | null {
  let area = 0;
  ring.forEach(([x0, z0], i) => { const [x1, z1] = ring[(i + 1) % ring.length]!; area += x0 * z1 - x1 * z0; });
  if (Math.abs(area) / 2 < minAreaStuds2) return null;
  const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
  const w = Math.max(1, Math.round(Math.max(...xs) - Math.min(...xs)));
  const h = Math.max(1, Math.round(Math.max(...zs) - Math.min(...zs)));
  const x0 = Math.round((Math.max(...xs) + Math.min(...xs)) / 2 - w / 2);
  const z0 = Math.round((Math.max(...zs) + Math.min(...zs)) / 2 - h / 2);
  const pts: TrackedPoint[] = [[x0, z0], [x0 + w, z0], [x0 + w, z0 + h], [x0, z0 + h]].map(([x, z], i) => ({ x: x!, z: z!, src: i }));
  return { points: pts, nonOrthogonalEdges: 0, mode: 'min-feature' };
}
