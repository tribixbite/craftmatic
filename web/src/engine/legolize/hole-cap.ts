/**
 * Planar hole capping for the even-odd solid fill (BIZ-33, X-12 follow-up to X-11).
 *
 * Why: the shared voxeliser's 'solid' mode decides "inside" by counting the shell crossings of an axis
 * ray; that is only meaningful for a CLOSED shell. LDraw studs are cylinders open at the bottom (a side
 * wall and a top disc) standing on a brick's top face, so a ray through one crosses the part an odd
 * number of times and every cell above a stud read as inside. Measured on library part 3001: an
 * off-axis ray up a stud hits y = -4 (roof underside), 0 (top face), 4 (stud top): three crossings.
 *
 * What: find the boundary edges (an undirected edge used by exactly one triangle, vertices welded by
 * position), chain them into simple loops, and close every loop that is planar and convex with a fan of
 * triangles about its centroid. A stud's rim then gets a floor lying on the brick's top face: four
 * crossings, even, and the column above is outside again.
 *
 * Limits (also TODO below): non-planar or non-convex loops are left open (a fan over a concave loop
 * would cross itself and corrupt the parity worse than the hole did); a mesh that is open on purpose
 * across a planar rim (a bowl) is closed there, which is what an inside/outside fill needs anyway.
 */

/** Position-weld resolution: vertices closer than 1/WELD of a unit are one vertex. */
const WELD = 1e4;
/** A loop is planar when every vertex is within this distance (cells) of its best-fit plane. */
const PLANAR_TOLERANCE = 1e-3;

type V3 = [number, number, number];

/** Result of {@link capPlanarHoles}. */
export interface HoleCaps {
  /** Triangle vertex positions (9 floats each) that close the loops. */
  positions: Float32Array;
  /** Loops closed. */
  closed: number;
  /** Loops found but left open (non-planar, non-convex or not a simple cycle). */
  skipped: number;
}

/**
 * Cap the planar boundary loops of a triangle soup.
 *
 * @param positions xyz per vertex, three vertices per triangle when `index` is absent.
 * @param index optional triangle index buffer.
 * @returns the cap triangles, or `null` when the shell has no boundary loop to close.
 */
export function capPlanarHoles(positions: ArrayLike<number>, index?: ArrayLike<number>): HoleCaps | null {
  const vertexCount = Math.floor(positions.length / 3);
  const triCount = index ? Math.floor(index.length / 3) : Math.floor(vertexCount / 3);
  if (triCount === 0) return null;

  // Weld vertices by quantised position: raw triangle soups share no indices.
  const weldIds = new Map<string, number>();
  const welded: V3[] = [];
  const idOf = new Int32Array(vertexCount).fill(-1);
  const weld = (v: number): number => {
    let id = idOf[v]!;
    if (id >= 0) return id;
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    const key = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`;
    const known = weldIds.get(key);
    if (known !== undefined) id = known;
    else { id = welded.length; weldIds.set(key, id); welded.push([x, y, z]); }
    idOf[v] = id;
    return id;
  };

  // Undirected edge -> number of triangles using it.
  const edgeUse = new Map<number, number>();
  const stride = 0x400000; // > any realistic welded vertex count in a part; keys stay exact below 2^53
  const edgeKey = (a: number, b: number): number => (a < b ? a * stride + b : b * stride + a);
  let degenerate = false;
  for (let t = 0; t < triCount; t++) {
    const v = [0, 1, 2].map((k) => weld(index ? index[t * 3 + k]! : t * 3 + k)) as [number, number, number];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) { degenerate = true; continue; }
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(v[k]!, v[(k + 1) % 3]!);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  void degenerate; // collapsed triangles carry no boundary

  // Boundary graph: vertex -> boundary neighbours.
  const next = new Map<number, number[]>();
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    const a = Math.floor(key / stride), b = key % stride;
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    (next.get(b) ?? next.set(b, []).get(b)!).push(a);
  }
  if (next.size === 0) return null;

  const out: number[] = [];
  let closed = 0, skipped = 0;
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    // Walk the component; a simple loop has exactly two boundary neighbours at every vertex.
    const loop: number[] = [];
    let simple = true;
    let prev = -1, cur = start;
    for (;;) {
      seen.add(cur);
      loop.push(cur);
      const nb = next.get(cur)!;
      if (nb.length !== 2) simple = false;
      const nxt = nb.find((n) => n !== prev && !(loop.length === 1 && false)) ?? nb[0]!;
      if (nb.length < 1) { simple = false; break; }
      prev = cur; cur = nxt;
      if (cur === start) break;
      if (seen.has(cur)) { simple = false; break; }
    }
    if (!simple || loop.length < 3 || !isPlanarConvex(loop.map((i) => welded[i]!))) { skipped++; continue; }
    const pts = loop.map((i) => welded[i]!);
    const c: V3 = [0, 0, 0];
    for (const p of pts) { c[0] += p[0] / pts.length; c[1] += p[1] / pts.length; c[2] += p[2] / pts.length; }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      out.push(c[0], c[1], c[2], a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    closed++;
  }
  // TODO(X-12): ear-clip concave planar loops; they are left open here.
  if (closed === 0 && skipped === 0) return null;
  return { positions: Float32Array.from(out), closed, skipped };
}

/** Newell normal of a polygon (not normalised). */
function newell(pts: readonly V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** True when every vertex lies on one plane and every turn bends the same way (a convex polygon). */
function isPlanarConvex(pts: readonly V3[]): boolean {
  const n = newell(pts);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-12) return false; // zero area
  const u: V3 = [n[0] / len, n[1] / len, n[2] / len];
  const o = pts[0]!;
  for (const p of pts) {
    if (Math.abs((p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1] + (p[2] - o[2]) * u[2]) > PLANAR_TOLERANCE) return false;
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!, c = pts[(i + 2) % pts.length]!;
    const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2: V3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const cr: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (cr[0] * u[0] + cr[1] * u[1] + cr[2] * u[2] < -1e-9) return false;
  }
  return true;
}
