/**
 * OSM Overpass building footprint client — queries OpenStreetMap for real building
 * geometry near a lat/lng point. No authentication required, free to use.
 *
 * Returns polygon vertices, bounding box dimensions in meters and Minecraft blocks
 * (1 block ≈ 1 meter), plus OSM building tags like material, levels, roof shape.
 *
 * Node/Bun-compatible — no browser APIs needed.
 */

import type { BlockState, FloorPlanShape } from '../../types/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OSMBuildingData {
  /** Building polygon vertices as {lat, lon}[] (outer ring for multipolygons) */
  polygon: { lat: number; lon: number }[];
  /** Inner ring polygons for multipolygon buildings (courtyards, through-holes) */
  innerPolygons?: { lat: number; lon: number }[][];
  /** Width in meters (from bounding box — shorter axis) */
  widthMeters: number;
  /** Length in meters (from bounding box — longer axis) */
  lengthMeters: number;
  /** Width in Minecraft blocks (1 block ≈ 1m) */
  widthBlocks: number;
  /** Length in Minecraft blocks */
  lengthBlocks: number;
  /** OSM building:levels tag (or undefined) */
  levels?: number;
  /** OSM building:material tag */
  material?: string;
  /** OSM roof:shape tag (gable, hip, flat, etc.) */
  roofShape?: string;
  /** OSM roof:material tag */
  roofMaterial?: string;
  /** OSM building:colour as hex RGB */
  buildingColour?: string;
  /** OSM roof:colour as hex RGB */
  roofColour?: string;
  /** Actual polygon area in square meters (shoelace formula) */
  footprintAreaSqm: number;
  /** Raw OSM tags object */
  tags: Record<string, string>;
}

// ─── Overpass API Client ────────────────────────────────────────────────────

// Arnis pattern: round-robin across multiple Overpass servers for reliability
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

/**
 * Search OSM Overpass for the nearest building polygon to a lat/lng point.
 * Queries ways tagged [building] within the given radius (default 50m).
 * Picks the building whose centroid is closest to the query point.
 *
 * @returns Building data with polygon and tags, or null if none found
 */
export async function searchOSMBuilding(
  lat: number,
  lng: number,
  radius = 50,
): Promise<OSMBuildingData | null> {
  // Fetch both ways and relations tagged [building] — relations capture multipolygon
  // buildings with inner/outer rings (courtyards, through-block buildings).
  const query = `[out:json][timeout:15];(way[building](around:${radius},${lat},${lng});relation[building](around:${radius},${lat},${lng}););out geom;`;
  const body = `data=${encodeURIComponent(query)}`;

  // Retry with exponential backoff for 429 (rate limit) and 504 (gateway timeout).
  // Rotate through servers on each retry (arnis pattern: 3 servers for reliability).
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const serverUrl = pickOverpassUrl();
    try {
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000),
      });

      if (resp.status === 429 || resp.status === 504) {
        if (attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 3000; // 3s, 6s, 9s, 12s, 15s
          console.warn(`OSM Overpass: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`OSM Overpass: HTTP ${resp.status} after ${MAX_RETRIES} retries`);
        return null;
      }

      if (!resp.ok) {
        console.warn(`OSM Overpass: HTTP ${resp.status}`);
        return null;
      }

      const data = await resp.json() as { elements?: OverpassElement[] };
      const elements = data.elements;
      if (!Array.isArray(elements) || elements.length === 0) return null;

      return parseClosestBuilding(elements, lat, lng);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 3000;
        console.warn(`OSM Overpass: error, retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn('OSM Overpass request failed:', err);
      return null;
    }
  }
  return null;
}

/**
 * Parse Overpass JSON elements and return the building closest to the query point.
 * Exported for testing with mock responses.
 */
export function parseClosestBuilding(
  elements: OverpassElement[],
  queryLat: number,
  queryLng: number,
): OSMBuildingData | null {
  let bestElement: OverpassElement | null = null;
  let bestDist = Infinity;

  for (const el of elements) {
    // Extract centroid geometry from either way or relation
    let geom: { lat: number; lon: number }[] | undefined;
    if (el.type === 'way' && el.geometry && el.geometry.length >= 3) {
      geom = el.geometry;
    } else if (el.type === 'relation' && el.members) {
      // For relations, use the first outer member's geometry as the centroid source
      const outerMember = el.members.find(m => m.role === 'outer' && m.geometry && m.geometry.length >= 3);
      geom = outerMember?.geometry;
    }
    if (!geom) continue;

    // Compute centroid of polygon
    let cLat = 0;
    let cLon = 0;
    for (const pt of geom) {
      cLat += pt.lat;
      cLon += pt.lon;
    }
    cLat /= geom.length;
    cLon /= geom.length;

    const dist = haversineDistance(queryLat, queryLng, cLat, cLon);
    if (dist < bestDist) {
      bestDist = dist;
      bestElement = el;
    }
  }

  if (!bestElement) return null;

  // Extract outer polygon and inner rings based on element type
  let polygon: { lat: number; lon: number }[];
  let innerPolygons: { lat: number; lon: number }[][] | undefined;

  if (bestElement.type === 'relation' && bestElement.members) {
    // Multipolygon relation: outer = building perimeter, inner = courtyards
    const outerMember = bestElement.members.find(m => m.role === 'outer' && m.geometry && m.geometry.length >= 3);
    if (!outerMember?.geometry) return null;
    polygon = outerMember.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon }));

    // Collect inner rings (courtyards, through-holes)
    const inners = bestElement.members
      .filter(m => m.role === 'inner' && m.geometry && m.geometry.length >= 3)
      .map(m => m.geometry!.map(pt => ({ lat: pt.lat, lon: pt.lon })));
    if (inners.length > 0) innerPolygons = inners;
  } else if (bestElement.geometry) {
    polygon = bestElement.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon }));
  } else {
    return null;
  }

  const { widthMeters, lengthMeters } = polygonBoundingDimensions(polygon);
  let footprintAreaSqm = polygonArea(polygon);

  // Subtract inner ring areas from total footprint
  if (innerPolygons) {
    for (const inner of innerPolygons) {
      footprintAreaSqm -= polygonArea(inner);
    }
    footprintAreaSqm = Math.max(0, footprintAreaSqm);
  }

  const tags = bestElement.tags ?? {};

  // For non-rectangular shapes, derive block dimensions from actual area
  // instead of bounding box to avoid inflating L/T/U buildings
  const bboxArea = widthMeters * lengthMeters;
  const fillRatio = bboxArea > 0 ? footprintAreaSqm / bboxArea : 1;
  const aspectRatio = lengthMeters > 0 ? widthMeters / lengthMeters : 1;

  // Scale bbox dimensions down to match actual area: area = w * l, w/l = aspectRatio
  // So: w = sqrt(area * aspectRatio), l = sqrt(area / aspectRatio)
  let effectiveWidth = widthMeters;
  let effectiveLength = lengthMeters;
  if (fillRatio < 0.88 && footprintAreaSqm > 0) {
    effectiveWidth = Math.sqrt(footprintAreaSqm * aspectRatio);
    effectiveLength = Math.sqrt(footprintAreaSqm / aspectRatio);
  }

  // Parse levels — OSM uses "building:levels" as a string
  const levelsRaw = tags['building:levels'];
  const levels = levelsRaw ? parseInt(levelsRaw, 10) : undefined;

  return {
    polygon,
    innerPolygons,
    widthMeters: Math.round(effectiveWidth * 10) / 10,
    lengthMeters: Math.round(effectiveLength * 10) / 10,
    widthBlocks: Math.max(6, Math.min(60, Math.round(effectiveWidth))),
    lengthBlocks: Math.max(6, Math.min(60, Math.round(effectiveLength))),
    footprintAreaSqm: Math.round(footprintAreaSqm * 10) / 10,
    levels: levels && !isNaN(levels) ? levels : undefined,
    material: tags['building:material'] || undefined,
    roofShape: tags['roof:shape'] || undefined,
    roofMaterial: tags['roof:material'] || undefined,
    buildingColour: normalizeOSMColour(tags['building:colour']),
    roofColour: normalizeOSMColour(tags['roof:colour']),
    tags,
  };
}

/** Overpass JSON element shape (subset used by this module) */
export interface OverpassElement {
  type: string;
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
  /** Relation members — present when type === 'relation' */
  members?: {
    type: string;
    ref: number;
    role: string;
    geometry?: { lat: number; lon: number }[];
  }[];
}

// ─── Geometry Utilities ─────────────────────────────────────────────────────

/** Earth radius in meters */
const R = 6371000;

/**
 * Haversine distance between two lat/lng points in meters.
 * Used to pick the closest building and compute polygon dimensions.
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compute width and length from a polygon's axis-aligned bounding box.
 * Returns the shorter dimension as width and longer as length.
 */
export function polygonBoundingDimensions(
  polygon: { lat: number; lon: number }[],
): { widthMeters: number; lengthMeters: number } {
  if (polygon.length < 2) return { widthMeters: 0, lengthMeters: 0 };

  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const pt of polygon) {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lon < minLon) minLon = pt.lon;
    if (pt.lon > maxLon) maxLon = pt.lon;
  }

  // Lat extent → meters (north-south)
  const nsMeters = haversineDistance(minLat, minLon, maxLat, minLon);
  // Lon extent → meters (east-west, at midpoint latitude)
  const midLat = (minLat + maxLat) / 2;
  const ewMeters = haversineDistance(midLat, minLon, midLat, maxLon);

  // Width = shorter axis, length = longer axis
  const a = Math.min(nsMeters, ewMeters);
  const b = Math.max(nsMeters, ewMeters);
  return { widthMeters: a, lengthMeters: b };
}

/**
 * Compute actual polygon area in square meters using the shoelace formula.
 * Projects lat/lng to meters before calculating.
 */
export function polygonArea(polygon: { lat: number; lon: number }[]): number {
  if (polygon.length < 3) return 0;

  const centerLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
  const latScale = 111320; // meters per degree latitude
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180);

  // Project to meters
  const projected = polygon.map(p => ({
    x: (p.lon - polygon[0].lon) * lonScale,
    y: (p.lat - polygon[0].lat) * latScale,
  }));

  // Shoelace formula
  let area = 0;
  for (let i = 0; i < projected.length; i++) {
    const j = (i + 1) % projected.length;
    area += projected[i].x * projected[j].y;
    area -= projected[j].x * projected[i].y;
  }
  return Math.abs(area) / 2;
}

// ─── Polygon Shape Analysis ─────────────────────────────────────────────────

/**
 * Analyze an OSM building polygon to determine if it's rectangular, L-shaped,
 * T-shaped, or U-shaped. Uses the polygon's axis-aligned bounding box fill ratio
 * and vertex count as heuristics.
 *
 * Method: compute polygon area vs bounding box area. A rectangle fills ~95%+.
 * Non-rectangular shapes (L, T, U) fill 50-80%. Vertex count helps distinguish:
 * - L-shape: 6-8 vertices (one notch)
 * - T-shape: 8-10 vertices (one protrusion)
 * - U-shape: 10-12 vertices (two protrusions)
 *
 * @param polygon OSM building polygon vertices
 * @returns Detected floor plan shape
 */
export function analyzePolygonShape(
  polygon: { lat: number; lon: number }[]
): FloorPlanShape {
  if (polygon.length < 5) return 'rect';

  // Compute polygon area using shoelace formula (in projected meters)
  const centerLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
  const latScale = 111320; // meters per degree latitude
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180); // meters per degree longitude

  // Project to meters
  const projected = polygon.map(p => ({
    x: (p.lon - polygon[0].lon) * lonScale,
    y: (p.lat - polygon[0].lat) * latScale,
  }));

  // Shoelace polygon area
  let polyArea = 0;
  for (let i = 0; i < projected.length; i++) {
    const j = (i + 1) % projected.length;
    polyArea += projected[i].x * projected[j].y;
    polyArea -= projected[j].x * projected[i].y;
  }
  polyArea = Math.abs(polyArea) / 2;

  // Bounding box area
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of projected) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const bboxArea = (maxX - minX) * (maxY - minY);
  if (bboxArea <= 0) return 'rect';

  const fillRatio = polyArea / bboxArea;

  // Deduplicate closing vertex (OSM polygons repeat first vertex as last)
  const uniqueVerts = polygon.length > 3 &&
    polygon[0].lat === polygon[polygon.length - 1].lat &&
    polygon[0].lon === polygon[polygon.length - 1].lon
    ? polygon.length - 1
    : polygon.length;

  // Classification heuristics
  if (fillRatio > 0.88) return 'rect'; // Nearly rectangular

  if (uniqueVerts <= 8) return 'L';     // Simple notch = L
  if (uniqueVerts <= 10) return 'T';    // One protrusion = T
  return 'U';                            // Two protrusions or complex = U
}

// ─── Material Mapping ───────────────────────────────────────────────────────

/** Map OSM building:material values to Minecraft wall blocks */
const OSM_MATERIAL_MAP: { pattern: RegExp; block: BlockState }[] = [
  { pattern: /\bbrick/i, block: 'minecraft:bricks' },
  { pattern: /\bstone/i, block: 'minecraft:stone_bricks' },
  { pattern: /\bconcrete/i, block: 'minecraft:white_concrete' },
  { pattern: /\bcement/i, block: 'minecraft:white_concrete' },
  { pattern: /\bplaster|stucco|render/i, block: 'minecraft:white_concrete' },
  { pattern: /\bglass/i, block: 'minecraft:white_stained_glass' },
  { pattern: /\bmetal|steel|aluminium|aluminum/i, block: 'minecraft:iron_block' },
  { pattern: /\bwood|timber/i, block: 'minecraft:oak_planks' },
  { pattern: /\blog/i, block: 'minecraft:spruce_planks' },
  { pattern: /\bsandstone/i, block: 'minecraft:sandstone' },
  { pattern: /\badobe|mud/i, block: 'minecraft:terracotta' },
  { pattern: /\bvinyl|siding/i, block: 'minecraft:white_concrete' },
];

/**
 * Map an OSM building:material tag value to a Minecraft wall block.
 * Returns undefined if the material is unrecognized.
 */
export function mapOSMMaterialToWall(material: string): BlockState | undefined {
  if (!material) return undefined;
  for (const { pattern, block } of OSM_MATERIAL_MAP) {
    if (pattern.test(material)) return block;
  }
  return undefined;
}

// ─── Roof Shape Normalization ───────────────────────────────────────────────

const ROOF_SHAPE_LABELS: Record<string, string> = {
  gabled: 'Gable',
  gable: 'Gable',
  hipped: 'Hip',
  hip: 'Hip',
  flat: 'Flat',
  pyramidal: 'Pyramid',
  skillion: 'Skillion',
  gambrel: 'Gambrel',
  mansard: 'Mansard',
  dome: 'Dome',
  round: 'Round',
  saltbox: 'Saltbox',
  half_hipped: 'Half-Hip',
  'half-hipped': 'Half-Hip',
  sawtooth: 'Sawtooth',
};

/** Normalize an OSM roof:shape tag to a human-readable display label */
export function mapOSMRoofShape(shape: string): string {
  if (!shape) return '';
  const normalized = shape.trim().toLowerCase();
  return ROOF_SHAPE_LABELS[normalized] ?? shape.charAt(0).toUpperCase() + shape.slice(1);
}

// ─── OSM Colour Normalization ───────────────────────────────────────────────

/** Named colours used in OSM (subset of CSS/W3C named colours) */
const OSM_NAMED_COLOURS: Record<string, string> = {
  white: '#FFFFFF',
  black: '#000000',
  red: '#FF0000',
  green: '#008000',
  blue: '#0000FF',
  yellow: '#FFFF00',
  brown: '#8B4513',
  grey: '#808080',
  gray: '#808080',
  beige: '#F5F5DC',
  cream: '#FFFDD0',
  tan: '#D2B48C',
  maroon: '#800000',
  orange: '#FFA500',
};

/**
 * Normalize an OSM colour tag to a #RRGGBB hex string.
 * Handles: hex (#abc, #aabbcc), named colours (brown, red), or returns undefined.
 */
function normalizeOSMColour(colour: string | undefined): string | undefined {
  if (!colour) return undefined;
  const c = colour.trim().toLowerCase();

  // Already hex
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) {
    // Expand #abc → #AABBCC
    return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toUpperCase();
  }

  // Named colour
  return OSM_NAMED_COLOURS[c];
}
