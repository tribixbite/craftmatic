/**
 * Stage B — sliced footprint extraction.
 *
 * Takes a photogrammetry mesh (positions + indices) and a vertical sampling
 * delta, returns a list of vertical bands. Each band is a height range with
 * the polygon(s) representing the building's horizontal silhouette in that
 * range.
 *
 * The single-polygon-prism extrusion that cleaned-tiles previously produced
 * cannot encode buildings whose horizontal silhouette changes with height —
 * twin towers (Pennzoil), setbacks (Empire State), cantilevers (Geisel),
 * spirals (Guggenheim). Sliced extraction generalises to all of these.
 *
 * Slicing primitive: for a horizontal plane y = y₀, enumerate triangles. For
 * each triangle, classify each vertex as above/below/on the plane. Triangles
 * fully above or fully below contribute nothing. Triangles straddling the
 * plane contribute a line segment whose endpoints are the plane-edge
 * intersections. Segments are then chained head-to-tail into closed
 * polygons.
 *
 * Band detection: consecutive slices fold into the same band when (a) the
 * polygon counts match, (b) each polygon pair has centroid distance < δ,
 * and (c) each polygon pair has area within 5% — this collapses the
 * (height/δ) raw slices into a small number of meaningful bands.
 */

export interface MeshSliceInput {
  /** Vertex positions, xyz interleaved. Mesh-local coordinates (Y is up after the Z↔Y swap from `extractMeshInputs`). */
  readonly positions: Float32Array;
  /** Triangle indices into `positions / 3`. */
  readonly indices: Uint32Array;
}

export interface Point2D {
  readonly x: number;
  readonly z: number;
}

export interface Polygon2D {
  /** Counter-clockwise points (open ring; last point != first). */
  readonly points: ReadonlyArray<Point2D>;
  /** Signed area (positive = CCW). |area| in m². */
  readonly area: number;
  readonly centroid: Point2D;
}

export interface SliceBand {
  /** Inclusive lower bound of the band, in mesh-local y. */
  readonly y0: number;
  /** Exclusive upper bound (so successive bands tile). */
  readonly y1: number;
  /** Disjoint polygons making up the silhouette in this band. */
  readonly polygons: ReadonlyArray<Polygon2D>;
}

// ─── Triangle/plane intersection ────────────────────────────────────────────

interface Segment {
  readonly ax: number; readonly az: number;
  readonly bx: number; readonly bz: number;
}

/**
 * Compute the intersection of plane y = y₀ with all triangles of `mesh`.
 * Returns the segments where the plane cuts through.
 *
 * Edge case handling: vertices exactly on the plane are nudged ε above to
 * keep the classification deterministic (at-plane vertices otherwise produce
 * degenerate zero-length segments and break chaining).
 */
function intersectPlane(mesh: MeshSliceInput, y0: number): Segment[] {
  const out: Segment[] = [];
  const pos = mesh.positions;
  const idx = mesh.indices;
  const EPS = 1e-7;

  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];

    // Nudge on-plane vertices up
    const yA = Math.abs(ay - y0) < EPS ? y0 + EPS : ay;
    const yB = Math.abs(by - y0) < EPS ? y0 + EPS : by;
    const yC = Math.abs(cy - y0) < EPS ? y0 + EPS : cy;

    const sA = yA > y0 ? 1 : -1;
    const sB = yB > y0 ? 1 : -1;
    const sC = yC > y0 ? 1 : -1;

    if (sA === sB && sB === sC) continue;

    // Two of the three edges cross the plane.
    const cuts: Array<{ x: number; z: number }> = [];
    const tryEdge = (
      px: number, py: number, pz: number,
      qx: number, qy: number, qz: number,
    ): void => {
      if ((py > y0) === (qy > y0)) return; // same side, no crossing
      const t = (y0 - py) / (qy - py);
      cuts.push({ x: px + (qx - px) * t, z: pz + (qz - pz) * t });
    };
    tryEdge(ax, yA, az, bx, yB, bz);
    tryEdge(bx, yB, bz, cx, yC, cz);
    tryEdge(cx, yC, cz, ax, yA, az);

    if (cuts.length === 2) {
      out.push({
        ax: cuts[0].x, az: cuts[0].z,
        bx: cuts[1].x, bz: cuts[1].z,
      });
    }
    // length 0/1/3 — degenerate; ignore (rare with the EPS nudge)
  }
  return out;
}

// ─── Segment chaining ───────────────────────────────────────────────────────

/**
 * Quantise a 2D point to a snap grid so floating-point near-equal endpoints
 * collapse to the same chain key. Photogrammetry vertices touching the same
 * edge can differ by ~1e-5 between adjacent triangles; we snap to 1mm.
 */
function snapKey(x: number, z: number, snap: number): string {
  const sx = Math.round(x / snap);
  const sz = Math.round(z / snap);
  return `${sx},${sz}`;
}

function chainSegmentsToRings(segs: ReadonlyArray<Segment>, snap: number): Point2D[][] {
  if (segs.length === 0) return [];

  // Build adjacency: endpoint key → indices of segments incident to it
  const adj = new Map<string, number[]>();
  const segKeys: Array<[string, string]> = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ka = snapKey(s.ax, s.az, snap);
    const kb = snapKey(s.bx, s.bz, snap);
    if (ka === kb) { segKeys.push([ka, kb]); continue; } // zero-length
    segKeys.push([ka, kb]);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push(i);
    adj.get(kb)!.push(i);
  }

  const used = new Uint8Array(segs.length);
  const rings: Point2D[][] = [];

  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    const [k0, k1] = segKeys[start];
    if (k0 === k1) { used[start] = 1; continue; }

    used[start] = 1;
    const points: Point2D[] = [
      { x: segs[start].ax, z: segs[start].az },
      { x: segs[start].bx, z: segs[start].bz },
    ];
    let currentKey = k1;

    while (true) {
      const cands = adj.get(currentKey) ?? [];
      let next = -1;
      for (const ci of cands) {
        if (used[ci]) continue;
        next = ci;
        break;
      }
      if (next < 0) break;

      used[next] = 1;
      const [na, nb] = segKeys[next];
      const seg = segs[next];
      if (na === currentKey) {
        points.push({ x: seg.bx, z: seg.bz });
        currentKey = nb;
      } else {
        points.push({ x: seg.ax, z: seg.az });
        currentKey = na;
      }
      // Closed?
      if (currentKey === k0) break;
    }

    if (points.length >= 3) rings.push(points);
  }

  return rings;
}

// ─── Polygon utilities ──────────────────────────────────────────────────────

function signedArea(points: ReadonlyArray<Point2D>): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j].x + points[i].x) * (points[i].z - points[j].z);
  }
  return a * 0.5;
}

/**
 * True polygon centroid (Σ (x_i + x_{i+1}) (x_i·z_{i+1} − x_{i+1}·z_i) / 6A).
 * The naive vertex-mean centroid drifts toward edges with denser
 * tessellation — e.g. a slice through a box mesh whose top face is split
 * into two triangles produces a ring with 4 corners + 1 mid-edge collinear
 * point, and the mean centroid lands ~0.55m off origin instead of 0.
 */
function centroidOf(points: ReadonlyArray<Point2D>): Point2D {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const cross = points[j].x * points[i].z - points[i].x * points[j].z;
    cx += (points[j].x + points[i].x) * cross;
    cz += (points[j].z + points[i].z) * cross;
    a += cross;
  }
  if (Math.abs(a) < 1e-9) {
    let mx = 0, mz = 0;
    for (const p of points) { mx += p.x; mz += p.z; }
    return { x: mx / points.length, z: mz / points.length };
  }
  const factor = 1 / (3 * a);
  return { x: cx * factor, z: cz * factor };
}

function makePolygon(rawPoints: ReadonlyArray<Point2D>): Polygon2D {
  const a = signedArea(rawPoints);
  // Force CCW (positive signed area in our convention)
  const points = a < 0 ? [...rawPoints].reverse() : [...rawPoints];
  return {
    points,
    area: Math.abs(a),
    centroid: centroidOf(points),
  };
}

// ─── Public: slice at one Y plane ───────────────────────────────────────────

export function sliceMeshAtY(
  meshes: ReadonlyArray<MeshSliceInput>,
  yPlane: number,
  options: { snap?: number; minArea?: number } = {},
): Polygon2D[] {
  const snap = options.snap ?? 0.05; // 5cm
  const minArea = options.minArea ?? 0.5; // m² — reject specks
  const allSegs: Segment[] = [];
  for (const m of meshes) {
    const segs = intersectPlane(m, yPlane);
    for (const s of segs) allSegs.push(s);
  }
  const rings = chainSegmentsToRings(allSegs, snap);
  const polys: Polygon2D[] = [];
  for (const r of rings) {
    const p = makePolygon(r);
    if (p.area >= minArea) polys.push(p);
  }
  return polys;
}

// ─── Band detection ─────────────────────────────────────────────────────────

function polygonsMatch(
  a: ReadonlyArray<Polygon2D>,
  b: ReadonlyArray<Polygon2D>,
  tol: { centroid: number; areaRatio: number },
): boolean {
  if (a.length !== b.length) return false;
  // Greedy match: for each a, find nearest b by centroid that hasn't been used.
  const used = new Uint8Array(b.length);
  for (let i = 0; i < a.length; i++) {
    let bestJ = -1, bestD = Infinity;
    for (let j = 0; j < b.length; j++) {
      if (used[j]) continue;
      const dx = a[i].centroid.x - b[j].centroid.x;
      const dz = a[i].centroid.z - b[j].centroid.z;
      const d = Math.hypot(dx, dz);
      if (d < bestD) { bestD = d; bestJ = j; }
    }
    if (bestJ < 0 || bestD > tol.centroid) return false;
    const ratio = a[i].area / Math.max(b[bestJ].area, 1e-6);
    if (ratio < 1 - tol.areaRatio || ratio > 1 + tol.areaRatio) return false;
    used[bestJ] = 1;
  }
  return true;
}

export interface ExtractBandsOptions {
  /** Vertical step in mesh-local Y. Defaults to 1/voxelResolution. */
  readonly deltaY?: number;
  readonly snap?: number;
  readonly minArea?: number;
  /** Centroid distance tolerance for band-matching (m). */
  readonly centroidTolM?: number;
  /** Area-ratio tolerance for band-matching (0.05 = ±5%). */
  readonly areaRatioTol?: number;
  /**
   * Optional XZ crop centred on origin — polygons whose centroid falls
   * outside `[-halfX, halfX] × [-halfZ, halfZ]` are discarded. Used to
   * drop surrounding-tile noise included in photogrammetry captures.
   */
  readonly cropXZ?: { halfX: number; halfZ: number };
  /**
   * When set, keep at most this many polygons per slice — the ones with
   * centroids closest to origin. Drops far-off neighbour buildings while
   * preserving twin-tower pairs (set to 2 for Pennzoil-style compounds).
   */
  readonly maxPolysPerSlice?: number;
}

export function extractBands(
  meshes: ReadonlyArray<MeshSliceInput>,
  bbox: { readonly minY: number; readonly maxY: number },
  options: ExtractBandsOptions = {},
): SliceBand[] {
  const deltaY = options.deltaY ?? 1 / 6;
  const tol = {
    centroid: options.centroidTolM ?? 1.0,
    areaRatio: options.areaRatioTol ?? 0.05,
  };

  // Sample slices at deltaY. Skip the very bottom (ground intersection noise)
  // and very top (truncated photogrammetry roof tip).
  const yLo = bbox.minY + deltaY * 0.5;
  const yHi = bbox.maxY - deltaY * 0.5;
  if (yHi <= yLo) return [];

  const bands: SliceBand[] = [];
  let curBand: { y0: number; y1: number; polys: Polygon2D[] } | null = null;
  const crop = options.cropXZ;

  const inCrop = (p: Polygon2D): boolean => {
    if (!crop) return true;
    return Math.abs(p.centroid.x) <= crop.halfX
        && Math.abs(p.centroid.z) <= crop.halfZ;
  };

  const maxPolys = options.maxPolysPerSlice ?? Infinity;
  for (let y = yLo; y < yHi; y += deltaY) {
    const rawPolys = sliceMeshAtY(meshes, y, { snap: options.snap, minArea: options.minArea });
    const cropped = rawPolys.filter(inCrop);
    // Sort by centroid distance to origin and keep the nearest `maxPolys`.
    // For single buildings (maxPolys=1) this isolates the target. For
    // twin-tower compounds (maxPolys=2) it keeps both towers but drops
    // adjacent unrelated structures.
    const polys = cropped
      .slice()
      .sort((a, b) => {
        const da = Math.hypot(a.centroid.x, a.centroid.z);
        const db = Math.hypot(b.centroid.x, b.centroid.z);
        return da - db;
      })
      .slice(0, isFinite(maxPolys) ? maxPolys : cropped.length);
    if (polys.length === 0) {
      if (curBand) { bands.push({ ...curBand, polygons: curBand.polys }); curBand = null; }
      continue;
    }
    if (curBand && polygonsMatch(curBand.polys, polys, tol)) {
      curBand.y1 = y + deltaY;
    } else {
      if (curBand) bands.push({ ...curBand, polygons: curBand.polys });
      curBand = { y0: y, y1: y + deltaY, polys };
    }
  }
  if (curBand) bands.push({ ...curBand, polygons: curBand.polys });
  return bands;
}
