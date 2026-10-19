/**
 * Stage 2 classifiers: size, shape, SV-difficulty, archType.
 *
 * All functions are pure, synchronous, and take pre-fetched data. Nothing here
 * fetches; nothing here mutates. Used by `resolveContext()` to classify a
 * `ContextDraft` into a complete `BuildingContext`.
 *
 * Shape refinement (post-Stage 3) lives at the bottom of this file as
 * `refineContextWithTiles()`. That is the ONE allowed mutation to a
 * `BuildingContext` — it returns a branded `RefinedBuildingContext`.
 */

import type {
  ArchType,
  BuildingContext,
  BuildingShape,
  BuildingSize,
  LatLon,
  RefinedBuildingContext,
  SvDifficulty,
} from './types.js';
import type { OSMBuildingData } from '../../gen/api/osm.js';

// ─── Size ───────────────────────────────────────────────────────────────────

/**
 * Bucket by the larger MBR dimension. `campus` is decided outside this function
 * (it's driven by `siblingBuildings`, not by size) and always wins.
 */
export function classifySize(widthM: number, depthM: number, isCampus: boolean): BuildingSize {
  if (isCampus) return 'campus';
  const maxDim = Math.max(widthM, depthM);
  if (maxDim < 15) return 'tiny';
  if (maxDim < 50) return 'small';
  if (maxDim < 150) return 'medium';
  if (maxDim < 300) return 'large';
  return 'skyscraper';
}

// ─── Shape ──────────────────────────────────────────────────────────────────

/** Compute polygon area via the shoelace formula (signed). */
export function signedPolygonArea(poly: readonly LatLon[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.lat * q.lon - q.lat * p.lon;
  }
  return a / 2;
}

/** Douglas-Peucker polyline simplification. `epsilon` in same units as input. */
export function douglasPeucker(
  points: readonly LatLon[],
  epsilon: number,
): readonly LatLon[] {
  if (points.length <= 2) return points;
  // Find point with max perpendicular distance from line first→last
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist <= epsilon) return [first, last];
  const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
  const right = douglasPeucker(points.slice(maxIdx), epsilon);
  return [...left.slice(0, -1), ...right];
}

function perpendicularDistance(p: LatLon, a: LatLon, b: LatLon): number {
  const dx = b.lat - a.lat;
  const dy = b.lon - a.lon;
  const denom = Math.hypot(dx, dy);
  if (denom === 0) return Math.hypot(p.lat - a.lat, p.lon - a.lon);
  const num = Math.abs(dy * p.lat - dx * p.lon + b.lat * a.lon - b.lon * a.lat);
  return num / denom;
}

/**
 * Count concavity vertices — ones where the interior angle exceeds 180°.
 * Uses the cross product sign relative to the polygon's overall winding.
 */
function countConcavities(poly: readonly LatLon[]): number {
  if (poly.length < 4) return 0;
  const winding = signedPolygonArea(poly) >= 0 ? 1 : -1;
  let concave = 0;
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[(i - 1 + poly.length) % poly.length];
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    const cross = (p1.lat - p0.lat) * (p2.lon - p1.lon) - (p1.lon - p0.lon) * (p2.lat - p1.lat);
    if (cross * winding < 0) concave++;
  }
  return concave;
}

/**
 * Rough smooth-curvature check — applies to polygons with many vertices
 * whose angles change gradually. Returns true if >70% of vertex turns are < 30°.
 */
function isSmoothCurved(poly: readonly LatLon[]): boolean {
  if (poly.length < 8) return false;
  let smoothTurns = 0;
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[(i - 1 + poly.length) % poly.length];
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    const a1 = Math.atan2(p1.lon - p0.lon, p1.lat - p0.lat);
    const a2 = Math.atan2(p2.lon - p1.lon, p2.lat - p1.lat);
    let delta = Math.abs(a2 - a1);
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    if (delta < Math.PI / 6) smoothTurns++; // < 30°
  }
  return smoothTurns / poly.length > 0.7;
}

export interface ShapeClassificationInput {
  /** Outer ring. May have many vertices. */
  readonly polygon: readonly LatLon[];
  /** Optional inner rings (courtyards). */
  readonly innerRings?: readonly (readonly LatLon[])[];
  /** Epsilon for Douglas-Peucker simplification, in degrees. ~0.00002 ≈ 2m. */
  readonly simplifyEpsilon?: number;
}

/** Shape classification from polygon geometry only (pre-Stage 3). */
export function classifyShape(input: ShapeClassificationInput): BuildingShape {
  const { polygon, innerRings = [], simplifyEpsilon = 0.00002 } = input;
  const simplified = douglasPeucker(polygon, simplifyEpsilon);
  const n = simplified.length - 1; // closing vertex duplicates the first

  // Inner rings = explicit courtyard
  if (innerRings.length > 0) return 'courtyard';

  // Triangle-like
  if (n === 3) return 'wedge';

  // Near-rect: 4 vertices after simplification
  if (n <= 4) return 'rect';

  // Curved: many vertices, smooth turns
  if (polygon.length >= 12 && isSmoothCurved(polygon)) return 'curved';

  // Concavity-based classes. A U-shape has two concavities (the notch corners);
  // an L-shape has one. Both are treated as 'U' for pipeline purposes — the
  // parametric synthesis uses the same extrude-footprint path for both.
  const concave = countConcavities(simplified);
  if (concave === 0 && n <= 6) return 'rect'; // allow slight complexity
  if (concave >= 1 && concave <= 2) return 'U';
  if (concave >= 3) return 'multi-wing';

  return 'irregular';
}

// ─── SV Difficulty ──────────────────────────────────────────────────────────

export interface SvDifficultyInput {
  /** Building centre coordinates. */
  readonly center: { readonly lat: number; readonly lng: number };
  /** OSM data for the building (tags inform land-use). */
  readonly osm: OSMBuildingData | null;
  /** True if we already know the address has zero SV coverage in a 100m radius. */
  readonly knownNoCoverage?: boolean;
}

export function classifySvDifficulty(input: SvDifficultyInput): SvDifficulty {
  if (input.knownNoCoverage) return 'no-coverage';
  const tags = input.osm?.tags ?? {};

  // Urban density cues: building=commercial/retail/office near other tall buildings,
  // or OSM landuse implies CBD. We key off tags available on the primary building.
  const building = tags['building'];
  const landuse = tags['landuse'];

  if (building === 'commercial' || building === 'office' || building === 'retail'
    || landuse === 'commercial' || landuse === 'retail') {
    return 'dense-urban';
  }

  // Residential with potential tree cover
  if (building === 'house' || building === 'detached' || building === 'residential'
    || landuse === 'residential') {
    // Rural-occluded if far from city; simple heuristic: if OSM says `rural`
    if (landuse === 'farmland' || landuse === 'forest' || landuse === 'meadow') {
      return 'rural-occluded';
    }
    return 'suburban';
  }

  // Default when we can't tell
  return 'suburban';
}

// ─── Arch Type ──────────────────────────────────────────────────────────────

export function classifyArchType(osm: OSMBuildingData | null): ArchType {
  const tags = osm?.tags ?? {};
  if (tags['historic'] || tags['heritage']) return 'historic';
  if (tags['amenity'] === 'place_of_worship' || tags['building'] === 'church'
    || tags['building'] === 'cathedral' || tags['building'] === 'mosque'
    || tags['building'] === 'synagogue' || tags['building'] === 'temple') {
    return 'religious';
  }
  const civic = new Set([
    'townhall', 'courthouse', 'library', 'school', 'university', 'college',
    'hospital', 'fire_station', 'police', 'post_office',
  ]);
  if (civic.has(tags['amenity'] ?? '') || civic.has(tags['building'] ?? '')) return 'civic';
  if (tags['building'] === 'industrial' || tags['landuse'] === 'industrial'
    || tags['industrial'] === 'yes') return 'industrial';
  if (tags['building'] === 'commercial' || tags['building'] === 'office'
    || tags['building'] === 'retail' || tags['building'] === 'supermarket'
    || tags['shop']) return 'commercial';
  // Default: residential (covers detached, house, apartments, terrace, dormitory…)
  return 'residential';
}

// ─── Campus detection ───────────────────────────────────────────────────────

export function isCampusCluster(
  siblings: readonly { readonly tags: Record<string, string>; readonly distanceM: number }[],
): boolean {
  if (siblings.length < 2) return false;
  const nearby = siblings.filter(s => s.distanceM <= 30);
  if (nearby.length < 2) return false;
  return nearby.some(s => s.tags['building:part'] != null);
}

// ─── Post-Stage-3 refinement ────────────────────────────────────────────────

export interface TileRefinementInput {
  /** Heightmap from Stage 3 (1m per cell, min-Y at each XZ cell). */
  readonly heightmap: Float32Array;
  readonly heightmapWidth: number;
  readonly heightmapLength: number;
}

/**
 * Post-Stage-3 shape refinement. Today: detect `tower-podium` via a tall-centre
 * + short-surround pattern. Returns a branded `RefinedBuildingContext`.
 *
 * This function is the ONE allowed post-Stage-2 mutation of a BuildingContext.
 * All other stages read the refined context; none produce a modified one.
 */
export function refineContextWithTiles(
  ctx: BuildingContext,
  tiles: TileRefinementInput,
): RefinedBuildingContext {
  const refined = { ...ctx, shape: detectTowerPodium(ctx.shape, tiles) };
  // Brand without actually adding a runtime property — the type assertion is
  // the whole point of the brand.
  return refined as unknown as RefinedBuildingContext;
}

function detectTowerPodium(
  initial: BuildingShape,
  tiles: TileRefinementInput,
): BuildingShape {
  const { heightmap, heightmapWidth: W, heightmapLength: L } = tiles;
  if (W < 4 || L < 4) return initial;

  // Centre region: inner 30% of footprint.
  const cx0 = Math.floor(W * 0.35), cx1 = Math.floor(W * 0.65);
  const cz0 = Math.floor(L * 0.35), cz1 = Math.floor(L * 0.65);

  let centreMax = 0;
  for (let z = cz0; z < cz1; z++) {
    for (let x = cx0; x < cx1; x++) {
      const y = heightmap[z * W + x];
      if (y > centreMax) centreMax = y;
    }
  }

  // Surround region: outside inner 60% (i.e. the outer ring).
  let surroundSum = 0, surroundCount = 0;
  for (let z = 0; z < L; z++) {
    for (let x = 0; x < W; x++) {
      if (x >= cx0 && x < cx1 && z >= cz0 && z < cz1) continue;
      const y = heightmap[z * W + x];
      if (y > 0) { surroundSum += y; surroundCount++; }
    }
  }
  const surroundAvg = surroundCount ? surroundSum / surroundCount : 0;

  // Tower-podium: tall centre (>30m), surround avg <= 50% of centre max.
  if (centreMax > 30 && surroundAvg > 0 && surroundAvg < centreMax * 0.5) {
    return 'tower-podium';
  }
  return initial;
}
