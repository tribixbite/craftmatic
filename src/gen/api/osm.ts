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
import { pickOverpassUrl } from '../../shared/overpass-query.js';

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
  /** OSM element ref ("way/123", "relation/456") — forensics for
   *  wrong-building selection; persisted into the verification report. */
  osmId?: string;
  /** Raw OSM tags object */
  tags: Record<string, string>;
}

// ─── Overpass API Client ────────────────────────────────────────────────────

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
  /** House number from the query address (see parseClosestBuilding). */
  houseNumber?: string | null,
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
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass API returns 406 to requests without a User-Agent
          // (anti-bot policy as of ~2026-04). Without this, every OSM
          // lookup silently falls back to Solar bbox, dropping real
          // polygon shape and dragging downstream IoU.
          'User-Agent': 'craftmatic/1.0 (https://github.com/tribixbite/craftmatic)',
        },
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

      return parseClosestBuilding(elements, lat, lng, houseNumber);
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

// ─── building:part for compound buildings ──────────────────────────────────

export interface OSMBuildingPart {
  /** Outer polygon vertices, closed (last = first). */
  polygon: { lat: number; lon: number }[];
  /** building:levels or null. */
  levels: number | null;
  /** Explicit height tag (metres) or null. */
  heightM: number | null;
  /** Building colour as hex RGB or null. */
  buildingColour: string | null;
  /** Roof colour as hex RGB or null. */
  roofColour: string | null;
  /** roof:shape tag or null. */
  roofShape: string | null;
  /** Raw tags. */
  tags: Record<string, string>;
}

/**
 * Query OSM `building:part` ways within a radius of a point. Compound
 * buildings (Pennzoil Place, Empire State, Petronas Towers etc.) often
 * have a containing `building` polygon plus per-tower `building:part`
 * polygons with their own height/roof/colour tags. Returning multiple
 * parts lets the synthesizer build each tower as its own prism stack
 * with correct individual heights.
 *
 * Returns empty array when no parts found, or on API failure (caller
 * falls back to single-polygon synthesis).
 */
export async function searchOSMBuildingParts(
  lat: number,
  lng: number,
  radiusM = 100,
): Promise<OSMBuildingPart[]> {
  const query = `[out:json][timeout:15];(way["building:part"](around:${radiusM},${lat},${lng}););out geom;`;
  const body = `data=${encodeURIComponent(query)}`;
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const serverUrl = pickOverpassUrl();
    try {
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'craftmatic/1.0 (https://github.com/tribixbite/craftmatic)',
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 429 || resp.status === 504) {
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
        return [];
      }
      if (!resp.ok) return [];
      const data = await resp.json() as { elements?: OverpassElement[] };
      const elements = data.elements ?? [];
      const parts: OSMBuildingPart[] = [];
      for (const e of elements) {
        if (e.type !== 'way' || !e.geometry || e.geometry.length < 4) continue;
        const tags = e.tags ?? {};
        if (tags['building:part'] === undefined || tags['building:part'] === 'no') continue;
        const polygon = e.geometry.map(g => ({ lat: g.lat, lon: g.lon }));
        const levelsRaw = tags['building:levels'];
        const heightRaw = tags['height'] ?? tags['building:height'];
        const roofHeightRaw = tags['roof:height'];
        const baseHeight = heightRaw ? parseFloat(heightRaw) : null;
        const roofHeight = roofHeightRaw ? parseFloat(roofHeightRaw) : 0;
        const totalHeight = baseHeight !== null && Number.isFinite(baseHeight)
          ? baseHeight + (Number.isFinite(roofHeight) ? roofHeight : 0)
          : null;
        parts.push({
          polygon,
          levels: levelsRaw ? parseInt(levelsRaw, 10) || null : null,
          heightM: totalHeight,
          buildingColour: tags['building:colour'] ?? null,
          roofColour: tags['roof:colour'] ?? null,
          roofShape: tags['roof:shape'] ?? null,
          tags,
        });
      }
      return parts;
    } catch {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        continue;
      }
      return [];
    }
  }
  return [];
}

/**
 * Fetch a specific OSM building by way or relation ID.
 * Bypasses proximity search — useful when the nearest polygon covers a campus/complex
 * and a specific sub-building way exists (e.g. NGA East Building within full NGA complex).
 *
 * @param osmType 'way' or 'relation'
 * @param osmId Numeric OSM element ID
 * @returns Building data with polygon and tags, or null if not found
 */
export async function fetchOSMById(
  osmType: 'way' | 'relation',
  osmId: number,
): Promise<OSMBuildingData | null> {
  const query = `[out:json][timeout:15];${osmType}(${osmId});out geom;`;
  const body = `data=${encodeURIComponent(query)}`;

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const serverUrl = pickOverpassUrl();
    try {
      const resp = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass API returns 406 to requests without a User-Agent
          // (anti-bot policy as of ~2026-04). Without this, every OSM
          // lookup silently falls back to Solar bbox, dropping real
          // polygon shape and dragging downstream IoU.
          'User-Agent': 'craftmatic/1.0 (https://github.com/tribixbite/craftmatic)',
        },
        body,
        signal: AbortSignal.timeout(20000),
      });

      if (resp.status === 429 || resp.status === 504) {
        if (attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 3000;
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
      if (!Array.isArray(elements) || elements.length === 0) {
        console.warn(`OSM Overpass: ${osmType}/${osmId} not found`);
        return null;
      }

      const el = elements[0];
      // Extract polygon from the element
      let polygon: { lat: number; lon: number }[];
      let innerPolygons: { lat: number; lon: number }[][] | undefined;

      if (el.type === 'relation' && el.members) {
        const outerMember = el.members.find(m => m.role === 'outer' && m.geometry && m.geometry.length >= 3);
        if (!outerMember?.geometry) {
          console.warn(`OSM: relation/${osmId} has no outer geometry`);
          return null;
        }
        polygon = outerMember.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon }));
        const inners = el.members
          .filter(m => m.role === 'inner' && m.geometry && m.geometry.length >= 3)
          .map(m => m.geometry!.map(pt => ({ lat: pt.lat, lon: pt.lon })));
        if (inners.length > 0) innerPolygons = inners;
      } else if (el.geometry && el.geometry.length >= 3) {
        polygon = el.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon }));
      } else {
        console.warn(`OSM: ${osmType}/${osmId} has no usable geometry`);
        return null;
      }

      const { widthMeters, lengthMeters } = polygonBoundingDimensions(polygon);
      let footprintAreaSqm = polygonArea(polygon);
      if (innerPolygons) {
        for (const inner of innerPolygons) {
          footprintAreaSqm -= polygonArea(inner);
        }
        footprintAreaSqm = Math.max(0, footprintAreaSqm);
      }

      const tags = el.tags ?? {};
      const bboxArea = widthMeters * lengthMeters;
      const fillRatio = bboxArea > 0 ? footprintAreaSqm / bboxArea : 1;
      const aspectRatio = lengthMeters > 0 ? widthMeters / lengthMeters : 1;
      let effectiveWidth = widthMeters;
      let effectiveLength = lengthMeters;
      if (fillRatio < 0.88 && footprintAreaSqm > 0) {
        effectiveWidth = Math.sqrt(footprintAreaSqm * aspectRatio);
        effectiveLength = Math.sqrt(footprintAreaSqm / aspectRatio);
      }
      const levelsRaw = tags['building:levels'];
      const levels = levelsRaw ? parseInt(levelsRaw, 10) : undefined;

      console.log(`OSM: fetched ${osmType}/${osmId} — ${tags.name || 'unnamed'} (${Math.round(effectiveWidth)}×${Math.round(effectiveLength)}m)`);

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
  // All Overpass retries exhausted — fall back to main OSM API.
  // Supports way and relation (relation requires /full to get outer member nodes).
  console.warn(`OSM Overpass: all retries failed — falling back to api.openstreetmap.org`);
  return fetchOSMByIdFallback(osmType, osmId);
}

/**
 * Fallback fetcher using the main OpenStreetMap API when Overpass is unavailable.
 * Supports way and relation. Geometry is built from referenced node coordinates.
 */
async function fetchOSMByIdFallback(
  osmType: 'way' | 'relation',
  osmId: number,
): Promise<OSMBuildingData | null> {
  try {
    // /full returns the element plus all referenced nodes (and relations for relations).
    const url = `https://api.openstreetmap.org/api/0.6/${osmType}/${osmId}/full.json`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) {
      console.warn(`OSM fallback: HTTP ${resp.status} from api.openstreetmap.org`);
      return null;
    }
    const data = await resp.json() as { elements?: Array<{ id: number; type: string; lat?: number; lon?: number; nodes?: number[]; members?: Array<{ type: string; ref: number; role: string }>; geometry?: Array<{ lat: number; lon: number }>; tags?: Record<string, string> }> };
    const elements = data.elements ?? [];

    // Build node coordinate lookup
    const nodeCoords = new Map<number, { lat: number; lon: number }>();
    for (const el of elements) {
      if (el.type === 'node' && el.id != null && el.lat != null && el.lon != null) {
        nodeCoords.set(el.id, { lat: el.lat, lon: el.lon });
      }
    }

    let polygon: { lat: number; lon: number }[] | null = null;
    let tags: Record<string, string> = {};

    if (osmType === 'way') {
      const way = elements.find(e => e.type === 'way' && e.id === osmId);
      if (!way?.nodes) {
        console.warn(`OSM fallback: way/${osmId} not found`);
        return null;
      }
      tags = way.tags ?? {};
      polygon = way.nodes
        .map(nid => nodeCoords.get(nid))
        .filter((pt): pt is { lat: number; lon: number } => pt != null);
    } else {
      // relation: find outer ring members → collect their way nodes
      const relation = elements.find(e => e.type === 'relation' && e.id === osmId);
      if (!relation?.members) {
        console.warn(`OSM fallback: relation/${osmId} not found`);
        return null;
      }
      tags = relation.tags ?? {};
      // Find a way that is the outer member and reconstruct its node coords
      const outerRef = relation.members.find(m => m.role === 'outer' && m.type === 'way');
      if (!outerRef) {
        console.warn(`OSM fallback: relation/${osmId} has no outer way member`);
        return null;
      }
      const outerWay = elements.find(e => e.type === 'way' && e.id === outerRef.ref);
      if (!outerWay?.nodes) {
        console.warn(`OSM fallback: outer way ${outerRef.ref} not found in response`);
        return null;
      }
      polygon = outerWay.nodes
        .map(nid => nodeCoords.get(nid))
        .filter((pt): pt is { lat: number; lon: number } => pt != null);
    }

    if (!polygon || polygon.length < 3) {
      console.warn(`OSM fallback: ${osmType}/${osmId} — insufficient polygon points`);
      return null;
    }

    const { widthMeters, lengthMeters } = polygonBoundingDimensions(polygon);
    const footprintAreaSqm = polygonArea(polygon);
    const bboxArea = widthMeters * lengthMeters;
    const fillRatio = bboxArea > 0 ? footprintAreaSqm / bboxArea : 1;
    const aspectRatio = lengthMeters > 0 ? widthMeters / lengthMeters : 1;
    let effectiveWidth = widthMeters;
    let effectiveLength = lengthMeters;
    if (fillRatio < 0.88 && footprintAreaSqm > 0) {
      effectiveWidth = Math.sqrt(footprintAreaSqm * aspectRatio);
      effectiveLength = Math.sqrt(footprintAreaSqm / aspectRatio);
    }
    const levelsRaw = tags['building:levels'];
    const levels = levelsRaw ? parseInt(levelsRaw, 10) : undefined;

    console.log(`OSM fallback: fetched ${osmType}/${osmId} via api.openstreetmap.org — ${tags['name'] || 'unnamed'} (${Math.round(effectiveWidth)}×${Math.round(effectiveLength)}m)`);

    return {
      polygon,
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
  } catch (err) {
    console.warn('OSM fallback request failed:', err);
    return null;
  }
}

/** Ray-casting point-in-polygon test for lat/lng coordinates */
function pointInPolygon(
  lat: number, lng: number,
  polygon: { lat: number; lon: number }[],
): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = polygon[i].lat, xi = polygon[i].lon;
    const yj = polygon[j].lat, xj = polygon[j].lon;
    if ((yi > lat) !== (yj > lat) &&
        lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Score penalty (metres-equivalent) for auxiliary structures — garages,
 *  sheds, toilets etc. They stay selectable when nothing else is near, but a
 *  principal building within this margin always beats them. */
const AUX_STRUCTURE_PENALTY_M = 60;
/** Bonus when a candidate's addr:housenumber exactly matches the query's. */
const HOUSENUMBER_MATCH_BONUS_M = 80;
/** Smaller bonus for merely carrying an address (it's SOMEBODY's building). */
const ADDRESSED_BUILDING_BONUS_M = 10;

/** building=/amenity= values that mark a structure as auxiliary — not the
 *  addressed building a user asked to reconstruct. */
const AUX_BUILDING_VALUES = new Set([
  'garage', 'garages', 'shed', 'carport', 'roof', 'service', 'hut',
  'greenhouse', 'kiosk', 'toilets', 'shelter', 'gazebo', 'boathouse',
]);
const AUX_AMENITY_VALUES = new Set([
  'toilets', 'shelter', 'parking', 'bicycle_parking', 'bench', 'fountain',
]);

/** True when the way's tags mark an auxiliary structure. */
export function isAuxiliaryStructure(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  const b = tags['building'];
  const a = tags['amenity'];
  return (b != null && AUX_BUILDING_VALUES.has(b))
    || (a != null && AUX_AMENITY_VALUES.has(a));
}

/**
 * Parse Overpass JSON elements and return the best building match.
 * Priority: (1) containing PRINCIPAL polygon with largest area, (2) lowest
 * plausibility-adjusted score (distance + auxiliary penalty − address bonus).
 * Exported for testing with mock responses.
 */
export function parseClosestBuilding(
  elements: OverpassElement[],
  queryLat: number,
  queryLng: number,
  /** House number from the query address — exact addr:housenumber match
   *  strongly pulls that candidate in. */
  houseNumber?: string | null,
): OSMBuildingData | null {
  // Extract geometry for each element
  interface Candidate {
    el: OverpassElement;
    geom: { lat: number; lon: number }[];
    centroidDist: number;
    area: number;
    containsQuery: boolean;
  }
  const candidates: Candidate[] = [];

  for (const el of elements) {
    let geom: { lat: number; lon: number }[] | undefined;
    if (el.type === 'way' && el.geometry && el.geometry.length >= 3) {
      geom = el.geometry;
    } else if (el.type === 'relation' && el.members) {
      const outerMember = el.members.find(m => m.role === 'outer' && m.geometry && m.geometry.length >= 3);
      geom = outerMember?.geometry;
    }
    if (!geom) continue;

    let cLat = 0, cLon = 0;
    for (const pt of geom) { cLat += pt.lat; cLon += pt.lon; }
    cLat /= geom.length;
    cLon /= geom.length;

    candidates.push({
      el,
      geom,
      centroidDist: haversineDistance(queryLat, queryLng, cLat, cLon),
      area: polygonArea(geom),
      containsQuery: pointInPolygon(queryLat, queryLng, geom),
    });
  }

  if (candidates.length === 0) return null;

  // Prefer: (1) PRINCIPAL buildings that contain the query point, sorted by
  // area descending; (2) otherwise lowest plausibility-adjusted score.
  //
  // Raw closest-centroid is not enough: an interpolated geocode pin can sit
  // closer to an auxiliary structure than to the addressed building (a
  // RANGE_INTERPOLATED pin for "1123 Maple Ave, Berwyn" reconstructed the
  // park TOILET BLOCK 53m away instead of the house at 59m). Auxiliary
  // structures are score-penalised (still usable as a last resort), and a
  // matching addr:housenumber strongly pulls its candidate in.
  const containing = candidates
    .filter(c => c.containsQuery && !isAuxiliaryStructure(c.el.tags))
    .sort((a, b) => b.area - a.area);

  let bestElement: OverpassElement;
  if (containing.length > 0) {
    bestElement = containing[0].el;
  } else {
    const score = (c: Candidate): number => {
      let s = c.centroidDist;
      if (isAuxiliaryStructure(c.el.tags)) s += AUX_STRUCTURE_PENALTY_M;
      const num = c.el.tags?.['addr:housenumber'];
      if (num != null) {
        s -= houseNumber != null && num.trim() === houseNumber.trim()
          ? HOUSENUMBER_MATCH_BONUS_M
          : ADDRESSED_BUILDING_BONUS_M;
      }
      return s;
    };
    candidates.sort((a, b) => score(a) - score(b));
    bestElement = candidates[0].el;
  }

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
    osmId: `${bestElement.type}/${bestElement.id}`,
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
