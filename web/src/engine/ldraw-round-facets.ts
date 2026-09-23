/**
 * Rotated-facet representation for parts that are a solid of revolution.
 *
 * Bedrock has only cuboids, so a cylinder voxelised on an axis-aligned lattice
 * reads as a square up close and no grain fixes it: on 10303 uniform 4 LDU is
 * 50.9k cuboids at silhouette IoU 0.949, 2 LDU is 142k at 0.967 and 1 LDU is
 * 316k at 0.977 — 2.2x the cuboids for +0.010. The residual IS the
 * round-vs-square error.
 *
 * `studCuboids` in the entity compiler already answers this for studs: emit
 * `facets` equal boxes fanned about the axis, each spanning the disc's
 * diameter, giving a 4*facets-sided outline from `facets` cuboids. Measured
 * against the real prototypes (`scripts/_round_facet_probe.ts`):
 *
 *   3062b Brick 1x1 Round    44 cuboids @ 0.931  ->  4 @ 0.947
 *   3941  Brick 2x2 Round    97 cuboids @ 0.950  ->  6 @ 0.949
 *   3957  Antenna 4H         14 cuboids @ 0.911  ->  4 @ 0.600
 *   24869 Wheels Coaster    100 cuboids @ 0.866  ->  4 @ 0.629
 *
 * So it wins hugely on a GENUINE single cylinder and fails on a compound part
 * — the antenna has a base flange, the wheel is two rims on an axle. This
 * module therefore does two things and never guesses: it fits a profile only
 * when every slice along the axis really is the same disc, and it reports the
 * measured IoU so a caller can refuse the candidate when the lattice wins.
 */
import type { LdrawPartMesh, LdrawTriangle, Vec3 } from './ldraw-part-geometry.js';
import { fillInterior, rasterizeSurface, silhouetteReference } from './ldraw-part-prototype.js';

/** A part that is one disc swept along `axis`, centred on its own bounding box. */
export interface RoundProfile {
  /** 0 = X, 1 = Y, 2 = Z, in part-local LDU. */
  axis: 0 | 1 | 2;
  radiusLdu: number;
  /** Extent along `axis`. */
  loLdu: number;
  hiLdu: number;
  centre: Vec3;
  /** Share of slice cells that agreed with the ideal disc (1 = every slice exact). */
  discAgreement: number;
}

/** A profile is only worth fanning if the disc is a real circle, not a 1-cell nub. */
const MIN_RADIUS_LDU = 5;
/** Angular sectors the boundary must reach in, so a partial arc cannot pass as a disc. */
const SECTORS = 16;

/**
 * Fit a solid of revolution, or return null.
 *
 * The test is deliberately strict and per SLICE: a part passes only when every
 * cross-section perpendicular to the axis is the same disc. A flange, a second
 * rim, a bar through the middle or a notch all break at least one slice, which
 * is what keeps the antenna and the coaster wheel out — both of which the
 * measurement shows the lattice represents far better.
 */
export function fitRoundProfile(mesh: LdrawPartMesh, cellLdu = 2): RoundProfile | null {
  if (!mesh.triangles.length) return null;
  const { min, max } = mesh.bounds;
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

  const lat = rasterizeSurface(mesh.triangles, min, max, cellLdu);
  fillInterior(lat, false);
  const dims = [lat.nx, lat.ny, lat.nz];
  // Same index order as `rasterizeSurface`/`fillInterior`: (y * nz + z) * nx + x.
  const at = (x: number, y: number, z: number): number => lat.solid[(y * lat.nz + z) * lat.nx + x] ?? 0;

  for (const axis of [0, 1, 2] as const) {
    const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    // A disc needs the two cross-axis extents to match; a 2x4 brick never will.
    const si = size[i]!, sj = size[j]!;
    if (si < MIN_RADIUS_LDU * 2 || Math.abs(si - sj) > Math.max(1, cellLdu)) continue;
    const radius = Math.min(si, sj) / 2;
    if (radius < MIN_RADIUS_LDU) continue;

    // Cell centre in LDU, relative to the bbox centre, on the two cross axes.
    const centreI = (min[i]! + max[i]!) / 2, centreJ = (min[j]! + max[j]!) / 2;
    const coord = (n: number, axisIndex: number): number => min[axisIndex]! + (n + 0.5) * cellLdu;

    // `rasterizeSurface` is CONSERVATIVE: it marks every cell the surface
    // passes through, so a disc is dilated outward by up to a cell. Testing
    // "solid iff the cell centre is inside the circle" therefore disagrees on
    // the entire boundary ring and rejects a perfect cylinder (measured: a 1x1
    // round brick scored 0.76-0.88 that way). The test is instead a band:
    //   - nothing solid beyond radius + cell, which is what rejects a square
    //     (its corners sit at r*sqrt(2)) and a flange (a wider section), and
    //   - the boundary must REACH radius - cell in every angular sector, which
    //     is what rejects a narrower section such as an antenna's shaft or the
    //     axle between a wheel's two rims.
    // Interior cells are not examined at all, so a hollow brick or an anti-stud
    // tube passes: the silhouette only sees the outer boundary.
    const outer = radius + cellLdu, inner = radius - cellLdu;
    let solidSlices = 0, reach = 0, reachable = 0, failed = false;

    for (let a = 0; a < dims[axis]! && !failed; a++) {
      const sector = new Uint8Array(SECTORS);
      let sliceSolid = 0;
      for (let p = 0; p < dims[i]! && !failed; p++) {
        for (let q = 0; q < dims[j]!; q++) {
          const idx: number[] = [];
          idx[axis] = a; idx[i] = p; idx[j] = q;
          if (at(idx[0]!, idx[1]!, idx[2]!) !== 1) continue;
          sliceSolid++;
          const di = coord(p, i) - centreI, dj = coord(q, j) - centreJ;
          const d = Math.hypot(di, dj);
          if (d > outer) { failed = true; break; }
          if (d >= inner) {
            const s = Math.floor(((Math.atan2(dj, di) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * SECTORS);
            sector[Math.min(SECTORS - 1, s)] = 1;
          }
        }
      }
      // An empty slice (past either end of the part) is not evidence.
      if (!sliceSolid || failed) continue;
      solidSlices++;
      let filled = 0;
      for (let s = 0; s < SECTORS; s++) filled += sector[s]!;
      if (filled < SECTORS) { failed = true; break; }
      reach += filled; reachable += SECTORS;
    }
    if (failed || !solidSlices || !reachable) continue;

    return {
      axis, radiusLdu: radius,
      loLdu: min[axis]!, hiLdu: max[axis]!,
      centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      discAgreement: Math.round((reach / reachable) * 10000) / 10000,
    };
  }
  return null;
}

/** One fanned box: an axis-aligned extent plus the angle it is turned about `axis`. */
export interface FacetBox {
  min: Vec3;
  max: Vec3;
  /** Degrees about the profile's axis, around `pivot`. 0 for the first box. */
  rotationDeg: number;
  pivot: Vec3;
}

/**
 * How far past "corners on the circle" the fan is grown, per facet count.
 *
 * `studCuboids` puts the corners exactly on the circle, which inscribes a
 * 4*facets-gon and therefore loses area to it. Against a CONSERVATIVELY
 * rasterised reference the best silhouette IoU comes from growing it slightly:
 * scanned 0.98..1.16 over four round moulds (3062b, 3941, 4073, 85861), the
 * optimum was 1.05-1.08 at four facets and 1.01-1.03 at six, worth up to
 * +0.05 IoU (3062b: 0.901 at 1.00 against 0.954 at 1.05).
 *
 * Measured on four moulds, so treat it as a tuned default rather than a law —
 * `roundFacetIoU` measures the result per part and the caller's gate refuses
 * the candidate whenever the lattice still wins, so a bad scale costs fidelity
 * on no part, only the chance to save cuboids on one.
 */
export function facetScale(facets: number): number {
  if (facets <= 3) return 1.08;
  if (facets === 4) return 1.06;
  if (facets <= 6) return 1.02;
  return 1.0;
}

/**
 * `facets` boxes fanned about the profile's axis — the same construction
 * `studCuboids` uses, so the outline has 4*facets sides — grown by
 * `facetScale`.
 */
export function roundFacetBoxes(profile: RoundProfile, facets: number, scale = facetScale(facets)): FacetBox[] {
  const { axis, radiusLdu: r0, centre } = profile;
  const r = r0 * scale;
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const hl = r * Math.cos(Math.PI / (2 * facets));
  const hw = r * Math.sin(Math.PI / (2 * facets));
  const out: FacetBox[] = [];
  for (let k = 0; k < facets; k++) {
    const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
    min[axis] = profile.loLdu; max[axis] = profile.hiLdu;
    min[i] = centre[i]! - hl; max[i] = centre[i]! + hl;
    min[j] = centre[j]! - hw; max[j] = centre[j]! + hw;
    out.push({ min, max, rotationDeg: k * 180 / facets, pivot: [...centre] as Vec3 });
  }
  return out;
}

/** Rotate a point about `axis` by `deg` around `pivot`. */
function rotateAbout(p: Vec3, axis: 0 | 1 | 2, deg: number, pivot: Vec3): Vec3 {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const d: Vec3 = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]];
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const out: Vec3 = [...d] as Vec3;
  out[i] = d[i]! * c - d[j]! * s;
  out[j] = d[i]! * s + d[j]! * c;
  return [out[0] + pivot[0], out[1] + pivot[1], out[2] + pivot[2]];
}

/** The 12 triangles of a facet box, in part-local LDU. */
export function facetBoxTriangles(facetBox: FacetBox, axis: 0 | 1 | 2): LdrawTriangle[] {
  const { min, max, rotationDeg, pivot } = facetBox;
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = (x: number, y: number, z: number): Vec3 => rotateAbout([x, y, z], axis, rotationDeg, pivot);
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): LdrawTriangle[] =>
    [{ a, b, c, color: 16 }, { a, b: c, c: d, color: 16 }];
  return [
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)),
    ...quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1)),
    ...quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0)),
    ...quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)),
    ...quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)),
    ...quad(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0)),
  ];
}

/**
 * Six-view silhouette IoU of the fanned representation against the part's own
 * triangles, rasterised through `silhouetteReference` so it is the SAME
 * measure the grain planner uses. The fan spans the full diameter, so it
 * shares the part's bounding box and therefore its raster resolution.
 */
export function roundFacetIoU(mesh: LdrawPartMesh, profile: RoundProfile, facets: number): number {
  const ref = silhouetteReference(mesh);
  const triangles = roundFacetBoxes(profile, facets).flatMap(fb => facetBoxTriangles(fb, profile.axis));
  const candidate = silhouetteReference({
    partId: mesh.partId, resolvedAs: mesh.resolvedAs, triangles, studs: [], unresolvedRefs: [],
    description: '', bounds: { min: [...mesh.bounds.min], max: [...mesh.bounds.max] },
  });
  if (ref.px !== candidate.px) return 0;
  let sum = 0;
  for (let v = 0; v < ref.bitmaps.length; v++) {
    const a = ref.bitmaps[v]!, b = candidate.bitmaps[v]!;
    let inter = 0, union = 0;
    for (let n = 0; n < a.length; n++) { if (a[n]! && b[n]!) inter++; if (a[n]! || b[n]!) union++; }
    sum += union ? inter / union : 1;
  }
  return sum / ref.bitmaps.length;
}
