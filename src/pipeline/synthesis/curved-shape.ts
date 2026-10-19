/**
 * Curved-shape detection for buildings whose footprint is round / oval /
 * spiral (Guggenheim Museum, Marina City, Vessel NYC, dome cathedrals).
 *
 * Detection signals (any one triggers `isCurved=true`):
 *   • OSM tag `building:shape=round` / `circular` / `oval`
 *   • OSM tag `roof:shape=dome`
 *   • Polygon is approximately circular by isoperimetric ratio:
 *       4π·A / P² > threshold (0.7 ≈ very round, 1.0 = perfect circle)
 *
 * Used by `sliced-tiles.ts` to disable the rigid OSM-polygon mask on
 * curved buildings — photogrammetry slices then keep their natural
 * per-band radii instead of all being clamped to the single OSM
 * polygon shape. This is what lets Guggenheim's inverted-cone spiral
 * survive into the voxel output instead of collapsing to a uniform
 * cylinder.
 */

import type { LatLon } from '../context/types.js';

export interface CurvedShapeResult {
  readonly isCurved: boolean;
  /** Reason that triggered the detection — for logging. */
  readonly reason: string;
  /** Isoperimetric circularity (4πA/P²). 1.0 = perfect circle, 0.0 = degenerate. */
  readonly circularity: number;
}

export function detectCurvedShape(
  polygon: readonly LatLon[] | null,
  tags: Record<string, string> | null,
): CurvedShapeResult {
  // Tag-based signals
  const tg = tags ?? {};
  const buildingShape = (tg['building:shape'] ?? '').toLowerCase();
  if (['round', 'circular', 'oval', 'curved', 'cylinder'].includes(buildingShape)) {
    return { isCurved: true, reason: `building:shape=${buildingShape}`, circularity: 1.0 };
  }
  const roofShape = (tg['roof:shape'] ?? '').toLowerCase();
  if (['dome', 'onion', 'round'].includes(roofShape)) {
    return { isCurved: true, reason: `roof:shape=${roofShape}`, circularity: 1.0 };
  }

  // Geometric signal: isoperimetric circularity, but only when the
  // polygon has enough vertices to plausibly describe a curve.
  // A square scores ~0.785 with just 4 verts — to avoid mis-flagging
  // boxes as "round" we require ≥16 verts AND circularity > 0.65.
  // Guggenheim (41 verts, 0.69) passes; rectangular buildings (4 verts)
  // fail on the vertex count alone.
  if (!polygon || polygon.length < 16) {
    return {
      isCurved: false,
      reason: polygon ? `verts=${polygon.length}<16` : 'no-polygon',
      circularity: polygon && polygon.length >= 3 ? computeCircularity(polygon) : 0,
    };
  }
  const circularity = computeCircularity(polygon);
  if (circularity > 0.65) {
    return { isCurved: true, reason: `circularity=${circularity.toFixed(2)}`, circularity };
  }
  return { isCurved: false, reason: `circularity=${circularity.toFixed(2)}`, circularity };
}

/**
 * Isoperimetric quotient = 4π·area / perimeter². For a circle this is
 * exactly 1; rectangles trend toward 0.78; long thin shapes drop below
 * 0.3. Threshold of 0.7 catches near-circular polygons while excluding
 * even square rotations.
 *
 * Uses equirectangular approximation for area+perimeter (~1% accurate
 * at building scale). Lat/lon→metres conversion centred on the
 * polygon's average latitude.
 */
function computeCircularity(polygon: readonly LatLon[]): number {
  if (polygon.length < 3) return 0;
  let avgLat = 0;
  for (const p of polygon) avgLat += p.lat;
  avgLat /= polygon.length;
  const mPerDegLat = 111111;
  const mPerDegLon = 111111 * Math.cos(avgLat * Math.PI / 180);
  // Drop closing duplicate if present
  let ring = polygon;
  if (ring.length >= 2) {
    const f = ring[0], l = ring[ring.length - 1];
    if (Math.abs(f.lat - l.lat) < 1e-9 && Math.abs(f.lon - l.lon) < 1e-9) {
      ring = ring.slice(0, -1);
    }
  }
  // Perimeter
  let perim = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = (b.lon - a.lon) * mPerDegLon;
    const dy = (b.lat - a.lat) * mPerDegLat;
    perim += Math.hypot(dx, dy);
  }
  if (perim < 1e-3) return 0;
  // Area (shoelace, equirectangular)
  let area2 = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon * mPerDegLon, yi = ring[i].lat * mPerDegLat;
    const xj = ring[j].lon * mPerDegLon, yj = ring[j].lat * mPerDegLat;
    area2 += (xj + xi) * (yi - yj);
  }
  const area = Math.abs(area2) * 0.5;
  return (4 * Math.PI * area) / (perim * perim);
}
