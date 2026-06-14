/**
 * Compute building orientation from an OSM polygon using
 * Minimum Area Bounding Rectangle (MBR).
 *
 * Pure geometry — no pipeline dependencies. Projects lat/lon vertices
 * to a local meter-scale coordinate system, computes the convex hull,
 * then finds the bounding rectangle with the smallest area by testing
 * each hull edge as a potential alignment axis.
 *
 * Coordinate convention: X = east (positive), Z = south (positive).
 * Edge angle computed as atan2(dx, -dz) which directly yields
 * compass bearing (clockwise from true north).
 *
 * Consumed downstream by:
 *  - reorientToENU() (exact mesh rotation)
 *  - positionCameraForAngle() (camera alignment)
 *  - maskToFootprint() (translation-only search)
 *  - ensureSatRef() (satellite rotation)
 *  - renderFrontElevation() (face selection)
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** Degrees-to-radians conversion factor */
const DEG2RAD = Math.PI / 180;

/** Radians-to-degrees conversion factor */
const RAD2DEG = 180 / Math.PI;

/** Meters per degree of latitude (constant at all latitudes) */
const METERS_PER_DEG_LAT = 111320;

// ─── Types ──────────────────────────────────────────────────────────────────

/** A WGS84 coordinate pair */
export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Result of computing the Minimum Area Bounding Rectangle for an OSM polygon.
 *
 * All angles measured clockwise from true north.
 * Widths and depths in meters.
 */
export interface BuildingAlignment {
  /** Rotation of the MBR long axis, clockwise from true north (degrees) */
  rotationDeg: number;
  /** Same rotation in radians */
  rotationRad: number;
  /** MBR long axis length (meters) — the wider dimension */
  mbrWidth: number;
  /** MBR short axis length (meters) — the narrower dimension */
  mbrDepth: number;
  /** Compass bearing of the main facade normal (degrees, 0-360) */
  primaryFaceAzimuth: number;
  /** Original OSM polygon vertices passed in */
  osmPolygon: LatLon[];
  /** Geographic center used for projection */
  center: LatLon;
}

// ─── Local Projection ───────────────────────────────────────────────────────

/** 2D point in local meter-scale coordinates (X=east, Z=south) */
interface Point2D {
  x: number;
  z: number;
}

/**
 * Project lat/lon to local meters using equirectangular approximation.
 *
 * X = east (positive), Z = south (positive, so north is negative Z).
 * Accurate within ~1m for distances < 500m from center.
 *
 * @param vertices  Polygon vertices in WGS84
 * @param centerLat Center latitude for cos-correction of longitude
 * @param centerLon Center longitude
 * @returns Array of 2D points in meters, origin at (centerLat, centerLon)
 */
function projectToMeters(
  vertices: LatLon[],
  centerLat: number,
  centerLon: number,
): Point2D[] {
  const cosLat = Math.cos(centerLat * DEG2RAD);
  return vertices.map((v) => ({
    x: (v.lon - centerLon) * METERS_PER_DEG_LAT * cosLat,
    z: (centerLat - v.lat) * METERS_PER_DEG_LAT,
  }));
}

// ─── Convex Hull ────────────────────────────────────────────────────────────

/**
 * 2D cross product of vectors OA and OB in XZ space.
 * Positive = counter-clockwise turn, negative = clockwise, zero = collinear.
 */
function cross(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

/**
 * Andrew's monotone chain convex hull algorithm.
 * Returns vertices in counter-clockwise order (in XZ plane where Z=south),
 * without the repeated closing vertex.
 * O(n log n) time.
 *
 * @param points Input 2D points (at least 1 required)
 * @returns Convex hull vertices in winding order
 */
function convexHull(points: Point2D[]): Point2D[] {
  const n = points.length;
  if (n <= 1) return [...points];

  // Sort by x, then by z
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);

  // Remove duplicates
  const unique: Point2D[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x !== sorted[i - 1].x || sorted[i].z !== sorted[i - 1].z) {
      unique.push(sorted[i]);
    }
  }

  if (unique.length <= 2) return unique;

  // Lower hull
  const lower: Point2D[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  // Upper hull
  const upper: Point2D[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Remove last point of each half because it's repeated at the junction
  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

// ─── MBR Computation ────────────────────────────────────────────────────────

/**
 * Normalize an angle to the range [0, 360).
 */
function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Compute the Minimum Area Bounding Rectangle from an OSM polygon.
 *
 * Algorithm:
 * 1. Project polygon to local XZ meter coordinates (X=east, Z=south)
 * 2. Compute convex hull
 * 3. For each hull edge, compute edge compass bearing via atan2(dx, -dz)
 *    and rotate all hull points so that edge is axis-aligned
 * 4. Compute the AABB of the rotated points
 * 5. The edge that produces the smallest AABB area is the MBR orientation
 *
 * The compass bearing formula atan2(dx, -dz) works because:
 *   - dx > 0 means moving east, dz < 0 means moving north
 *   - atan2(east, north) = bearing from north, clockwise
 *
 * @param polygon  OSM polygon vertices (at least 2 for graceful degradation)
 * @param centerLat  Reference latitude for projection (typically building center)
 * @param centerLon  Reference longitude for projection
 * @returns BuildingAlignment with rotation, dimensions, and azimuth
 */
export function computeBuildingAlignment(
  polygon: LatLon[],
  centerLat: number,
  centerLon: number,
): BuildingAlignment {
  const result: BuildingAlignment = {
    rotationDeg: 0,
    rotationRad: 0,
    mbrWidth: 0,
    mbrDepth: 0,
    primaryFaceAzimuth: 0,
    osmPolygon: polygon,
    center: { lat: centerLat, lon: centerLon },
  };

  // Degenerate: fewer than 2 points — return zero-area defaults
  if (polygon.length < 2) {
    return result;
  }

  // Project to local XZ meter coordinates (X=east, Z=south)
  const projected = projectToMeters(polygon, centerLat, centerLon);

  // Degenerate: exactly 2 points — line segment, compute bearing from it
  if (polygon.length === 2) {
    const dx = projected[1].x - projected[0].x;
    const dz = projected[1].z - projected[0].z;
    const length = Math.hypot(dx, dz);
    // atan2(east_diff, north_diff) = atan2(dx, -dz) gives CW-from-north compass bearing
    const angleDeg = normalizeDeg(Math.atan2(dx, -dz) * RAD2DEG);
    result.rotationDeg = angleDeg;
    result.rotationRad = angleDeg * DEG2RAD;
    result.mbrWidth = length;
    result.mbrDepth = 0;
    result.primaryFaceAzimuth = normalizeDeg(angleDeg + 90);
    return result;
  }

  // Compute convex hull
  const hull = convexHull(projected);

  // Edge case: all points collinear → hull has < 3 points
  if (hull.length < 3) {
    const dx = hull.length === 2 ? hull[1].x - hull[0].x : 0;
    const dz = hull.length === 2 ? hull[1].z - hull[0].z : 0;
    const length = Math.hypot(dx, dz);
    const angleDeg = normalizeDeg(Math.atan2(dx, -dz) * RAD2DEG);
    result.rotationDeg = angleDeg;
    result.rotationRad = angleDeg * DEG2RAD;
    result.mbrWidth = length;
    result.mbrDepth = 0;
    result.primaryFaceAzimuth = normalizeDeg(angleDeg + 90);
    return result;
  }

  // Test each hull edge as a candidate alignment axis
  let bestArea = Infinity;
  let bestAngle = 0;  // compass bearing in radians of best edge
  let bestW = 0;      // extent along edge direction
  let bestD = 0;      // extent perpendicular to edge

  const hullLen = hull.length;
  for (let i = 0; i < hullLen; i++) {
    const j = (i + 1) % hullLen;
    const edgeDx = hull[j].x - hull[i].x;
    const edgeDz = hull[j].z - hull[i].z;

    // Compass bearing of edge: atan2(east_diff, north_diff) = atan2(dx, -dz)
    const edgeAngle = Math.atan2(edgeDx, -edgeDz);

    // Rotate all hull points so this edge aligns with +X axis
    // (rotate by -edgeAngle in standard math terms)
    const cos = Math.cos(-edgeAngle);
    const sin = Math.sin(-edgeAngle);

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of hull) {
      const rx = p.x * cos - p.z * sin;
      const rz = p.x * sin + p.z * cos;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (rz < minZ) minZ = rz;
      if (rz > maxZ) maxZ = rz;
    }

    const w = maxX - minX;
    const d = maxZ - minZ;
    const area = w * d;

    if (area < bestArea) {
      bestArea = area;
      bestAngle = edgeAngle;
      bestW = Math.max(w, d);
      bestD = Math.min(w, d);
    }
  }

  // bestAngle is the compass bearing (radians) of the MBR edge with minimum area
  const rotDeg = normalizeDeg(bestAngle * RAD2DEG);
  result.rotationDeg = rotDeg;
  result.rotationRad = bestAngle;
  result.mbrWidth = bestW;
  result.mbrDepth = bestD;
  // Primary face azimuth: normal to the long axis, perpendicular (+90°)
  result.primaryFaceAzimuth = normalizeDeg(rotDeg + 90);

  return result;
}
