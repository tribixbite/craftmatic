/**
 * Fast generalised winding number of a triangle soup (V-01).
 *
 * The winding number w(p) = sum over triangles of (solid angle seen from p) / 4 pi is 1 inside a closed,
 * outward-oriented shell, 0 outside, and varies smoothly across a hole in an OPEN shell (about 0.5 right in
 * the opening, falling away from it), so thresholding it at 0.5 gives an inside test that is not fooled by
 * open meshes the way an even-odd ray count is (Jacobson, Kavan, Sorkine-Hornung 2013). It also stays
 * consistent where bodies overlap inside ONE mesh (w = 2 there, where parity cancels to "outside").
 *
 * Cost control follows Barill et al. 2018: a bounding-volume tree whose nodes store the area-weighted normal
 * sum (a dipole) of their triangles; a node far enough from the query point (distance > BETA x its radius)
 * contributes its dipole, a near one is descended, and a leaf is summed exactly (Van Oosterom & Strakosz
 * solid angle). Order 0 with BETA 2.5 keeps the error of a far cluster to a few percent of ITS own share,
 * far inside the 0.5 decision margin that this module's callers use.
 *
 * Assumes consistent triangle orientation across the soup. The caller decides how to treat the sign
 * (the voxeliser uses |w|, so an inside-out mesh works too).
 */

/** A far-field node contributes its dipole when distance > BETA x radius. Larger = slower and more exact. */
const BETA = 2.5;
/** Triangles per leaf. */
const LEAF_SIZE = 4;
const INV_4PI = 1 / (4 * Math.PI);

/** The decision threshold: a point is inside when |w| exceeds this. */
export const WINDING_INSIDE_THRESHOLD = 0.5;

/**
 * A winding-number evaluator over fixed triangles.
 *
 * @example
 * const field = new WindingField(positions); // 9 floats per triangle, any consistent frame
 * const inside = Math.abs(field.winding(x, y, z)) > WINDING_INSIDE_THRESHOLD;
 */
export class WindingField {
  /** 9 floats per triangle, reordered so every node covers a contiguous range. */
  private readonly tris: Float32Array;
  private readonly triCount: number;
  // Per node (struct-of-arrays): triangle range, children, dipole, centre and radius.
  private readonly start: Int32Array;
  private readonly count: Int32Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  /** Area-weighted normal sum, xyz per node. */
  private readonly dipole: Float64Array;
  /** Area-weighted centroid, xyz per node. */
  private readonly centre: Float64Array;
  private readonly radius: Float64Array;
  private nodeCount = 0;
  private readonly stack = new Int32Array(128);

  /** @param positions 9 floats per triangle (x0 y0 z0 x1 y1 z1 x2 y2 z2). Not modified. */
  constructor(positions: ArrayLike<number>) {
    if (positions.length % 9 !== 0) throw new RangeError(`WindingField: ${positions.length} floats is not a whole number of triangles`);
    const n = positions.length / 9;
    this.triCount = n;
    this.tris = new Float32Array(positions);
    const maxNodes = Math.max(1, 2 * n);
    this.start = new Int32Array(maxNodes);
    this.count = new Int32Array(maxNodes);
    this.left = new Int32Array(maxNodes).fill(-1);
    this.right = new Int32Array(maxNodes).fill(-1);
    this.dipole = new Float64Array(maxNodes * 3);
    this.centre = new Float64Array(maxNodes * 3);
    this.radius = new Float64Array(maxNodes);
    if (n > 0) this.build();
  }

  /** Number of triangles. */
  get size(): number { return this.triCount; }

  /** Signed winding number at (x, y, z): +1 inside an outward-oriented closed shell. */
  winding(x: number, y: number, z: number): number {
    if (this.triCount === 0) return 0;
    const { tris, start, count, left, right, dipole, centre, radius, stack } = this;
    let w = 0;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp]!;
      const dx = centre[node * 3]! - x;
      const dy = centre[node * 3 + 1]! - y;
      const dz = centre[node * 3 + 2]! - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const r = radius[node]!;
      if (left[node]! >= 0 && d2 > BETA * BETA * r * r) {
        // Far cluster: one dipole, N . (c - p) / (4 pi |c - p|^3).
        const d = Math.sqrt(d2);
        w += (dipole[node * 3]! * dx + dipole[node * 3 + 1]! * dy + dipole[node * 3 + 2]! * dz) * INV_4PI / (d2 * d);
      } else if (left[node]! >= 0) {
        stack[sp++] = left[node]!;
        stack[sp++] = right[node]!;
      } else {
        const s = start[node]!;
        for (let t = s; t < s + count[node]!; t++) w += triangleSolidAngle(tris, t * 9, x, y, z);
      }
    }
    return w * INV_4PI;
  }

  /** Median-split BVH over triangle centroids, built iteratively (no recursion limit on deep inputs). */
  private build(): void {
    const n = this.triCount;
    const { tris } = this;
    // Sort an index permutation, then copy the triangles into that order.
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const cent = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) cent[i * 3 + k] = (tris[i * 9 + k]! + tris[i * 9 + 3 + k]! + tris[i * 9 + 6 + k]!) / 3;
    }
    const nodeRange: Array<[number, number, number]> = []; // [node, start, end)
    this.nodeCount = 1;
    nodeRange.push([0, 0, n]);
    const created: Array<[number, number]> = [];
    while (nodeRange.length > 0) {
      const [node, s, e] = nodeRange.pop()!;
      this.start[node] = s;
      this.count[node] = e - s;
      if (e - s <= LEAF_SIZE) { created.push([node, 0]); continue; }
      // Split on the widest centroid axis at the median.
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = s; i < e; i++) {
        const o = order[i]!;
        for (let k = 0; k < 3; k++) {
          const v = cent[o * 3 + k]!;
          if (v < lo[k]!) lo[k] = v;
          if (v > hi[k]!) hi[k] = v;
        }
      }
      let axis = 0;
      if (hi[1]! - lo[1]! > hi[axis]! - lo[axis]!) axis = 1;
      if (hi[2]! - lo[2]! > hi[axis]! - lo[axis]!) axis = 2;
      const sub = Array.from(order.subarray(s, e)).sort((a, b) => cent[a * 3 + axis]! - cent[b * 3 + axis]!);
      order.set(sub, s);
      const mid = (s + e) >> 1;
      const l = this.nodeCount++;
      const r = this.nodeCount++;
      this.left[node] = l;
      this.right[node] = r;
      nodeRange.push([l, s, mid], [r, mid, e]);
    }
    // Reorder the triangles so each node's range is contiguous in `tris`.
    const sorted = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) sorted.set(tris.subarray(order[i]! * 9, order[i]! * 9 + 9), i * 9);
    tris.set(sorted);
    // Dipole, centroid and radius per node: leaves from triangles, inner nodes from their range directly
    // (a range scan per node is O(n log n) in total and avoids merging weighted centroids).
    for (let node = 0; node < this.nodeCount; node++) this.fillNode(node);
  }

  /** Area-weighted normal sum, area-weighted centroid and enclosing radius of node's triangle range. */
  private fillNode(node: number): void {
    const { tris } = this;
    const s = this.start[node]!;
    const e = s + this.count[node]!;
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, area = 0;
    for (let t = s; t < e; t++) {
      const o = t * 9;
      const e1x = tris[o + 3]! - tris[o]!, e1y = tris[o + 4]! - tris[o + 1]!, e1z = tris[o + 5]! - tris[o + 2]!;
      const e2x = tris[o + 6]! - tris[o]!, e2y = tris[o + 7]! - tris[o + 1]!, e2z = tris[o + 8]! - tris[o + 2]!;
      // Half the cross product = area x unit normal.
      const ax = 0.5 * (e1y * e2z - e1z * e2y);
      const ay = 0.5 * (e1z * e2x - e1x * e2z);
      const az = 0.5 * (e1x * e2y - e1y * e2x);
      const a = Math.hypot(ax, ay, az);
      nx += ax; ny += ay; nz += az;
      cx += a * (tris[o]! + tris[o + 3]! + tris[o + 6]!) / 3;
      cy += a * (tris[o + 1]! + tris[o + 4]! + tris[o + 7]!) / 3;
      cz += a * (tris[o + 2]! + tris[o + 5]! + tris[o + 8]!) / 3;
      area += a;
    }
    // Zero-area ranges (all degenerate) fall back to the plain vertex mean so the radius stays meaningful.
    if (area > 0) { cx /= area; cy /= area; cz /= area; }
    else {
      const m = (e - s) * 3;
      cx = cy = cz = 0;
      for (let t = s; t < e; t++) for (let v = 0; v < 3; v++) { cx += tris[t * 9 + v * 3]!; cy += tris[t * 9 + v * 3 + 1]!; cz += tris[t * 9 + v * 3 + 2]!; }
      cx /= m; cy /= m; cz /= m;
    }
    let r2 = 0;
    for (let t = s; t < e; t++) {
      for (let v = 0; v < 3; v++) {
        const dx = tris[t * 9 + v * 3]! - cx, dy = tris[t * 9 + v * 3 + 1]! - cy, dz = tris[t * 9 + v * 3 + 2]! - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) r2 = d2;
      }
    }
    this.dipole[node * 3] = nx; this.dipole[node * 3 + 1] = ny; this.dipole[node * 3 + 2] = nz;
    this.centre[node * 3] = cx; this.centre[node * 3 + 1] = cy; this.centre[node * 3 + 2] = cz;
    this.radius[node] = Math.sqrt(r2);
  }
}

/**
 * Signed solid angle (steradians) of the triangle at `tris[o..o+9]` seen from (px, py, pz)
 * (Van Oosterom & Strakosz 1983): tan(omega / 2) = a.(b x c) / (|a||b||c| + (a.b)|c| + (a.c)|b| + (b.c)|a|).
 */
function triangleSolidAngle(tris: Float32Array, o: number, px: number, py: number, pz: number): number {
  const ax = tris[o]! - px, ay = tris[o + 1]! - py, az = tris[o + 2]! - pz;
  const bx = tris[o + 3]! - px, by = tris[o + 4]! - py, bz = tris[o + 5]! - pz;
  const cx = tris[o + 6]! - px, cy = tris[o + 7]! - py, cz = tris[o + 8]! - pz;
  const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
  const num = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  const den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
  return 2 * Math.atan2(num, den);
}

/**
 * Splits a triangle soup into its connected pieces, each consistently wound and facing outward.
 *
 * The winding number needs consistent orientation, and real inputs do not have it: an LDraw part list carries
 * per-file BFC flags that the merged triangle list loses (the lattice-IoU fixtures read 0.0 - 0.5 without this),
 * and scanned / exported OBJ meshes are often inside-out in parts.
 *
 * 1. Vertices are welded by position (grid of `weld`), so triangles that merely share coordinates connect.
 * 2. Within each piece, connected through edges used by EXACTLY two triangles, every triangle is flipped as needed
 *    so the shared edge runs in opposite directions (a consistent orientation). Edges with 3+ triangles (touching
 *    bodies, T-junctions) do not propagate, so such pieces are oriented separately.
 * 3. Each piece is then flipped as a whole when its area-weighted normals at its six axis-extreme vertices point
 *    inward. At an extreme vertex of a closed surface the outward normal sum points along that axis; for open
 *    shells that is still true unless the extreme vertex sits on the hole, and the six votes outweigh that.
 *
 * Degenerate triangles (zero area after welding) are dropped: they add nothing to a winding number.
 * The pieces stay separate on purpose: a point is "inside the model" when it is inside ANY piece, which is the
 * per-body semantics a brick list has (a hollow brick's cavity is air even when another brick closes it over),
 * and which keeps one badly-oriented piece from cancelling its neighbours.
 *
 * @param positions 9 floats per triangle. Not modified.
 * @param weld Weld tolerance in position units; default 1e-6 of the bounding-box diagonal.
 * @returns one position array (9 floats per triangle) per piece, in order of first triangle.
 */
export function orientedComponents(positions: ArrayLike<number>, weld?: number): Float32Array[] {
  const n = Math.floor(positions.length / 9);
  if (n === 0) return [];

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k]!;
      if (v < lo[k]!) lo[k] = v;
      if (v > hi[k]!) hi[k] = v;
    }
  }
  const diag = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  const cell = weld ?? Math.max(diag * 1e-6, 1e-12);

  // Weld: corner -> vertex id.
  const ids = new Int32Array(n * 3);
  const byKey = new Map<string, number>();
  for (let i = 0; i < n * 3; i++) {
    const key = `${Math.round(positions[i * 3]! / cell)},${Math.round(positions[i * 3 + 1]! / cell)},${Math.round(positions[i * 3 + 2]! / cell)}`;
    let id = byKey.get(key);
    if (id === undefined) { id = byKey.size; byKey.set(key, id); }
    ids[i] = id;
  }
  const nv = byKey.size;

  // Triangle validity (non-degenerate after welding) and edge -> triangles (up to 3 stored; 3 = "many").
  const valid = new Uint8Array(n);
  const edgeTris = new Map<number, number[]>();
  const edgeKey = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a);
  for (let t = 0; t < n; t++) {
    const a = ids[t * 3]!, b = ids[t * 3 + 1]!, c = ids[t * 3 + 2]!;
    if (a === b || b === c || a === c) continue;
    valid[t] = 1;
    for (const k of [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)]) {
      const list = edgeTris.get(k);
      if (list) list.push(t); else edgeTris.set(k, [t]);
    }
  }

  // flip[t]: 1 when the triangle's corners 1 and 2 are swapped in the output. Corner order of a triangle as oriented.
  const flip = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const corner = (t: number, j: number): number => ids[t * 3 + (flip[t] ? (j === 0 ? 0 : 3 - j) : j)]!;
  const components: number[][] = [];
  for (let seed = 0; seed < n; seed++) {
    if (!valid[seed] || comp[seed] >= 0) continue;
    const members: number[] = [seed];
    comp[seed] = components.length;
    for (let head = 0; head < members.length; head++) {
      const t = members[head]!;
      for (let j = 0; j < 3; j++) {
        const a = corner(t, j), b = corner(t, (j + 1) % 3);
        const list = edgeTris.get(edgeKey(a, b))!;
        if (list.length !== 2) continue;
        const u = list[0] === t ? list[1]! : list[0]!;
        if (comp[u] >= 0) continue;
        comp[u] = components.length;
        // Consistent = u runs this edge as b -> a. If it runs a -> b, flip it.
        let runsAB = false;
        for (let m = 0; m < 3; m++) if (corner(u, m) === a && corner(u, (m + 1) % 3) === b) runsAB = true;
        if (runsAB) flip[u] = 1;
        members.push(u);
      }
    }
    components.push(members);
  }

  // Per-piece outward test from the six axis-extreme vertex fans.
  const px = (t: number, j: number, k: number): number => positions[t * 9 + (flip[t] ? (j === 0 ? 0 : 3 - j) : j) * 3 + k]!;
  const tol = diag * 1e-5;
  for (const members of components) {
    let votes = 0;
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [1, -1]) {
        let best = -Infinity;
        for (const t of members) for (let j = 0; j < 3; j++) best = Math.max(best, sign * px(t, j, axis));
        let sum = 0;
        for (const t of members) {
          let touches = false;
          for (let j = 0; j < 3; j++) if (sign * px(t, j, axis) >= best - tol) touches = true;
          if (!touches) continue;
          // Component `axis` of the area-weighted normal = half the cross product's.
          const e1 = [px(t, 1, 0) - px(t, 0, 0), px(t, 1, 1) - px(t, 0, 1), px(t, 1, 2) - px(t, 0, 2)];
          const e2 = [px(t, 2, 0) - px(t, 0, 0), px(t, 2, 1) - px(t, 0, 1), px(t, 2, 2) - px(t, 0, 2)];
          const nrm = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
          sum += nrm[axis]!;
        }
        votes += Math.sign(sign * sum);
      }
    }
    if (votes < 0) for (const t of members) flip[t] ^= 1;
  }

  // Write each piece: a flipped triangle swaps its corners 1 and 2.
  return components.map((members) => {
    const piece = new Float32Array(members.length * 9);
    members.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        piece[i * 9 + k] = positions[t * 9 + k]!;
        piece[i * 9 + 3 + k] = positions[t * 9 + (flip[t] ? 6 : 3) + k]!;
        piece[i * 9 + 6 + k] = positions[t * 9 + (flip[t] ? 3 : 6) + k]!;
      }
    });
    return piece;
  });
}
