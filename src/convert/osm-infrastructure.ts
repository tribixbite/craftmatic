/**
 * OSM Overpass infrastructure queries for plot-level features around a building.
 *
 * Queries roads, paths, fences, parking, water, and gardens within a given radius
 * and provides helpers to project and rasterize them onto a BlockGrid.
 *
 * Uses the same Overpass round-robin + retry pattern as src/gen/api/osm.ts
 * for reliability against rate limits and server timeouts.
 *
 * Node/Bun-compatible — no browser APIs needed.
 */

import type { GeoProjection } from './geo-projection.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single OSM way with resolved node coordinates and tags */
export interface OSMWay {
  /** OSM element ID */
  id: number;
  /** Resolved node coordinates in WGS84 */
  nodes: { lat: number; lng: number }[];
  /** OSM key-value tags on this way */
  tags: Record<string, string>;
}

/** Categorized infrastructure features around a building */
export interface PlotInfrastructure {
  /** Roads: highway=residential/tertiary/secondary/primary/trunk */
  roads: OSMWay[];
  /** Pedestrian paths: highway=footway/path/cycleway/pedestrian/steps */
  paths: OSMWay[];
  /** Barriers: barrier=fence/wall/hedge/retaining_wall/gate */
  fences: OSMWay[];
  /** Parking areas: amenity=parking/parking_space */
  parking: OSMWay[];
  /** Water features: natural=water, leisure=swimming_pool, waterway=stream/river */
  water: OSMWay[];
  /** Gardens and green spaces: leisure=garden/park, landuse=grass */
  gardens: OSMWay[];
}

// ─── Overpass API Client ────────────────────────────────────────────────────

// Round-robin across multiple Overpass servers for reliability (matches osm.ts)
const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];
let nextServerIdx = 0;

/** Pick next Overpass server in round-robin order */
function pickOverpassUrl(): string {
  const url = OVERPASS_SERVERS[nextServerIdx % OVERPASS_SERVERS.length];
  nextServerIdx++;
  return url;
}

/** Overpass JSON element shape (way with resolved geometry) */
interface OverpassWayElement {
  type: 'way';
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/** Overpass JSON response shape */
interface OverpassResponse {
  elements?: OverpassWayElement[];
}

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * Query all infrastructure features within radiusM meters of a lat/lng point.
 *
 * Sends a single Overpass query that fetches roads, paths, fences, parking,
 * water, and gardens in one request, then classifies each way by its tags.
 *
 * @param lat     Center latitude in decimal degrees
 * @param lng     Center longitude in decimal degrees
 * @param radiusM Search radius in meters (typically 50-200m)
 * @returns Categorized infrastructure features; empty arrays on failure
 */
export async function queryPlotInfrastructure(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<PlotInfrastructure> {
  const empty: PlotInfrastructure = {
    roads: [], paths: [], fences: [], parking: [], water: [], gardens: [],
  };

  // Single Overpass query fetching all feature types via union.
  // Each line selects ways matching a different infrastructure category.
  // `out geom` includes resolved node coordinates so no extra lookups needed.
  const query = `[out:json][timeout:10];(` +
    `way[highway~"^(residential|tertiary|secondary|primary|trunk|service)$"](around:${radiusM},${lat},${lng});` +
    `way[highway~"^(footway|path|cycleway|pedestrian|steps)$"](around:${radiusM},${lat},${lng});` +
    `way[barrier~"^(fence|wall|hedge|retaining_wall|gate)$"](around:${radiusM},${lat},${lng});` +
    `way[amenity~"^(parking|parking_space)$"](around:${radiusM},${lat},${lng});` +
    `way[natural=water](around:${radiusM},${lat},${lng});` +
    `way[leisure=swimming_pool](around:${radiusM},${lat},${lng});` +
    `way[waterway~"^(stream|river|ditch|drain)$"](around:${radiusM},${lat},${lng});` +
    `way[leisure~"^(garden|park)$"](around:${radiusM},${lat},${lng});` +
    `way[landuse=grass](around:${radiusM},${lat},${lng});` +
    `);out geom;`;

  const body = `data=${encodeURIComponent(query)}`;

  // Retry with exponential backoff for 429 (rate limit) and 504 (gateway timeout).
  // Rotate through servers on each retry (same pattern as osm.ts).
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const serverUrl = pickOverpassUrl();
    try {
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
      });

      if (resp.status === 429 || resp.status === 504) {
        if (attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 3000; // 3s, 6s, 9s, 12s, 15s
          console.warn(`OSM Infrastructure: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`OSM Infrastructure: HTTP ${resp.status} after ${MAX_RETRIES} retries`);
        return empty;
      }

      if (!resp.ok) {
        console.warn(`OSM Infrastructure: HTTP ${resp.status}`);
        return empty;
      }

      const data = await resp.json() as OverpassResponse;
      const elements = data.elements;
      if (!Array.isArray(elements) || elements.length === 0) return empty;

      return classifyElements(elements);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 3000;
        console.warn(`OSM Infrastructure: error, retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn('OSM Infrastructure request failed:', err);
      return empty;
    }
  }
  return empty;
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Classify Overpass way elements into infrastructure categories by their tags.
 * A single way may match multiple categories (e.g. a garden path).
 */
function classifyElements(elements: OverpassWayElement[]): PlotInfrastructure {
  const result: PlotInfrastructure = {
    roads: [], paths: [], fences: [], parking: [], water: [], gardens: [],
  };

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;

    const tags = el.tags ?? {};
    const way: OSMWay = {
      id: el.id,
      // Overpass uses `lon`, our interface uses `lng` — normalize here
      nodes: el.geometry.map(n => ({ lat: n.lat, lng: n.lon })),
      tags,
    };

    const highway = tags['highway'] ?? '';
    const barrier = tags['barrier'] ?? '';
    const amenity = tags['amenity'] ?? '';
    const natural = tags['natural'] ?? '';
    const leisure = tags['leisure'] ?? '';
    const waterway = tags['waterway'] ?? '';
    const landuse = tags['landuse'] ?? '';

    // Classify into categories — a way may appear in multiple
    if (/^(residential|tertiary|secondary|primary|trunk|service)$/.test(highway)) {
      result.roads.push(way);
    }
    if (/^(footway|path|cycleway|pedestrian|steps)$/.test(highway)) {
      result.paths.push(way);
    }
    if (/^(fence|wall|hedge|retaining_wall|gate)$/.test(barrier)) {
      result.fences.push(way);
    }
    if (/^(parking|parking_space)$/.test(amenity)) {
      result.parking.push(way);
    }
    if (natural === 'water' || leisure === 'swimming_pool' || /^(stream|river|ditch|drain)$/.test(waterway)) {
      result.water.push(way);
    }
    if (/^(garden|park)$/.test(leisure) || landuse === 'grass') {
      result.gardens.push(way);
    }
  }

  return result;
}

// ─── Projection Helper ──────────────────────────────────────────────────────

/**
 * Project an OSM way's node coordinates to grid XZ via a GeoProjection.
 *
 * Each node is projected through the GeoProjection, which handles the
 * equirectangular approximation and calibration offset from alignOSMToFootprint.
 *
 * @param way        OSM way with lat/lng node coordinates
 * @param projection GeoProjection instance configured for the target grid
 * @returns Array of grid { x, z } coordinates, one per node
 */
export function projectWayToGrid(
  way: OSMWay,
  projection: GeoProjection,
): { x: number; z: number }[] {
  return way.nodes.map(n => projection.toGridXZ(n.lat, n.lng));
}

// ─── Rasterization ──────────────────────────────────────────────────────────

/**
 * Rasterize a projected way as a line of blocks with a given width.
 *
 * Uses Bresenham's line algorithm between consecutive points, then dilates
 * each line pixel to the specified width (centered on the line).
 * Results are clamped to the grid bounds [0, gridWidth) x [0, gridLength).
 *
 * @param points     Projected grid coordinates from projectWayToGrid
 * @param width      Line width in blocks (1 = single block line, 3 = road width)
 * @param gridWidth  Grid extent in X (for bounds clamping)
 * @param gridLength Grid extent in Z (for bounds clamping)
 * @returns Deduplicated array of grid cells { x, z } that the way covers
 */
export function rasterizeWay(
  points: { x: number; z: number }[],
  width: number,
  gridWidth: number,
  gridLength: number,
): { x: number; z: number }[] {
  if (points.length < 2) return [];

  const cells = new Set<string>();
  const halfW = Math.floor(width / 2);

  // Rasterize each segment between consecutive points
  for (let i = 0; i < points.length - 1; i++) {
    const linePixels = bresenham(points[i].x, points[i].z, points[i + 1].x, points[i + 1].z);

    // Dilate each pixel to the specified width
    for (const { x: cx, z: cz } of linePixels) {
      for (let dx = -halfW; dx <= halfW; dx++) {
        for (let dz = -halfW; dz <= halfW; dz++) {
          const x = cx + dx;
          const z = cz + dz;
          // Clamp to grid bounds
          if (x >= 0 && x < gridWidth && z >= 0 && z < gridLength) {
            cells.add(`${x},${z}`);
          }
        }
      }
    }
  }

  // Convert set back to coordinate array
  const result: { x: number; z: number }[] = [];
  for (const key of cells) {
    const [x, z] = key.split(',').map(Number);
    result.push({ x, z });
  }
  return result;
}

/**
 * Bresenham's line algorithm — rasterize a straight line between two grid points.
 * Returns all integer grid cells along the line including both endpoints.
 *
 * @param x0 Start X
 * @param z0 Start Z
 * @param x1 End X
 * @param z1 End Z
 * @returns Array of { x, z } grid cells along the line
 */
function bresenham(
  x0: number, z0: number,
  x1: number, z1: number,
): { x: number; z: number }[] {
  const result: { x: number; z: number }[] = [];

  let dx = Math.abs(x1 - x0);
  let dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;

  let x = x0;
  let z = z0;

  // Loop until we reach the endpoint
  for (;;) {
    result.push({ x, z });
    if (x === x1 && z === z1) break;

    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      z += sz;
    }
  }

  return result;
}
