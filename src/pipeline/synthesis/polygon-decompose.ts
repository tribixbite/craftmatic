/**
 * Polygon decomposition via narrow-waist detection.
 *
 * For compound buildings whose OSM polygon spans multiple distinct
 * sub-buildings (twin towers, courtyard buildings, H/L/T plans) without
 * `building:part` tags, this module locates the narrow chord(s) where
 * the polygon pinches and splits along them. Each sub-polygon becomes
 * a separate prism in the synthesizer's bandedSilhouettes path —
 * recovering the compound silhouette without OSM tag support.
 *
 * Algorithm (single iteration):
 *   1. Enumerate vertex pairs (i, j) with at least 2 edges between them
 *      in either direction (no triangle-collapse chords).
 *   2. Reject pairs whose midpoint falls OUTSIDE the polygon — those
 *      cut across exterior space rather than through a real waist.
 *   3. Score each candidate by chord length relative to perimeter, and
 *      keep ones below `maxChordM` (default 8m).
 *   4. Pick the SHORTEST passing chord (the narrowest waist).
 *   5. Split polygon at that chord into two sub-polygons.
 *   6. Recurse on each child until no waist is found.
 *
 * The output is N >= 1 sub-polygons. When no waist exists (Flatiron's
 * wedge, an L-shape with no pinch), the input polygon is returned
 * unchanged in a single-element array.
 */

export interface LatLonPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface DecomposeOptions {
  /** Chord length cap in metres — chords shorter than this are waist candidates. Default 8m. */
  readonly maxChordM?: number;
  /** Minimum sub-polygon area to keep, in m². Drops slivers from over-split. Default 50m². */
  readonly minChildAreaSqm?: number;
  /** Max recursion depth (safety). Default 4 = up to 16 sub-polygons. */
  readonly maxDepth?: number;
}

/** Returns one or more sub-polygons. Each ring is open (no duplicate closing vertex). */
export function decomposePolygonByWaists(
  polygon: ReadonlyArray<LatLonPoint>,
  opts: DecomposeOptions = {},
): LatLonPoint[][] {
  const maxChordM = opts.maxChordM ?? 8;
  const minArea = opts.minChildAreaSqm ?? 50;
  const maxDepth = opts.maxDepth ?? 4;

  // Normalise: drop closing duplicate
  let ring = [...polygon];
  if (ring.length >= 2) {
    const f = ring[0], l = ring[ring.length - 1];
    if (Math.abs(f.lat - l.lat) < 1e-9 && Math.abs(f.lon - l.lon) < 1e-9) {
      ring = ring.slice(0, -1);
    }
  }
  return decomposeRecursive(ring, maxChordM, minArea, maxDepth, 0);
}

function decomposeRecursive(
  ring: ReadonlyArray<LatLonPoint>,
  maxChordM: number,
  minArea: number,
  maxDepth: number,
  depth: number,
): LatLonPoint[][] {
  if (depth >= maxDepth || ring.length < 6) {
    // Single-polygon fast path: don't try to split fewer than 6 verts
    // (a quad can't have a real waist).
    return [[...ring]];
  }
  const waist = findShortestWaist(ring, maxChordM);
  if (!waist) return [[...ring]];
  const [a, b] = splitAtChord(ring, waist.i, waist.j);
  if (polygonAreaAbsSqm(a) < minArea || polygonAreaAbsSqm(b) < minArea) {
    return [[...ring]];
  }
  return [
    ...decomposeRecursive(a, maxChordM, minArea, maxDepth, depth + 1),
    ...decomposeRecursive(b, maxChordM, minArea, maxDepth, depth + 1),
  ];
}

interface WaistChord {
  readonly i: number;
  readonly j: number;
  readonly lenM: number;
}

/**
 * Find the shortest chord inside the polygon whose endpoints are
 * non-adjacent vertices and whose midpoint is inside the polygon.
 * Returns null if no chord is shorter than `maxChordM`.
 */
function findShortestWaist(
  ring: ReadonlyArray<LatLonPoint>,
  maxChordM: number,
): WaistChord | null {
  const n = ring.length;
  let best: WaistChord | null = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      // Skip adjacent (i→j) and wrap-around adjacent (j→i+n)
      const dForward = j - i;
      const dBackward = n - dForward;
      if (dForward < 2 || dBackward < 2) continue;
      const lenM = haversineM(ring[i], ring[j]);
      if (lenM >= maxChordM) continue;
      const mid = midpoint(ring[i], ring[j]);
      if (!pointInPolygon(mid.lat, mid.lon, ring)) continue;
      if (!best || lenM < best.lenM) {
        best = { i, j, lenM };
      }
    }
  }
  return best;
}

/**
 * Split a polygon at the chord between vertices i and j.
 * Returns two sub-polygons (each an open ring) tiling the original.
 */
function splitAtChord(
  ring: ReadonlyArray<LatLonPoint>,
  i: number,
  j: number,
): [LatLonPoint[], LatLonPoint[]] {
  const n = ring.length;
  const a: LatLonPoint[] = [];
  for (let k = i; ; k = (k + 1) % n) {
    a.push(ring[k]);
    if (k === j) break;
  }
  const b: LatLonPoint[] = [];
  for (let k = j; ; k = (k + 1) % n) {
    b.push(ring[k]);
    if (k === i) break;
  }
  return [a, b];
}

function midpoint(a: LatLonPoint, b: LatLonPoint): LatLonPoint {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

const R_EARTH = 6371000;
function haversineM(a: LatLonPoint, b: LatLonPoint): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

function pointInPolygon(lat: number, lon: number, ring: ReadonlyArray<LatLonPoint>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon, yi = ring[i].lat;
    const xj = ring[j].lon, yj = ring[j].lat;
    const intersect = ((yi > lat) !== (yj > lat))
      && (lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonAreaAbsSqm(ring: ReadonlyArray<LatLonPoint>): number {
  // Equirectangular approximation for small polygons (good to ~1% at building
  // scale; we're using this for relative ordering not survey accuracy).
  if (ring.length < 3) return 0;
  const latRef = ring[0].lat * Math.PI / 180;
  const mPerDegLat = 111111;
  const mPerDegLon = 111111 * Math.cos(latRef);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon * mPerDegLon, yi = ring[i].lat * mPerDegLat;
    const xj = ring[j].lon * mPerDegLon, yj = ring[j].lat * mPerDegLat;
    a += (xj + xi) * (yi - yj);
  }
  return Math.abs(a) * 0.5;
}
