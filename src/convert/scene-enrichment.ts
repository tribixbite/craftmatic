/**
 * Scene enrichment — aggregates data from multiple APIs for populating
 * the environment around a voxelized building. Combines OSM infrastructure
 * (roads, paths, fences, water), climate-inferred tree palettes, and
 * property flags into a unified SceneEnrichment structure.
 *
 * Used by environment-builder.ts to populate BlockGrid with real-world
 * context (trees, roads, sidewalks, fences, pools, driveways).
 */

import type { TreeType } from '../gen/structures.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A geographic point (WGS84 decimal degrees) */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** A road way from OSM with geometry and classification */
export interface RoadWay {
  /** Ordered list of road centerline nodes */
  nodes: GeoPoint[];
  /** Road width in meters (derived from highway classification) */
  width: number;
  /** Road surface material (asphalt, gravel, concrete, etc.) */
  surface: string;
}

/** A footpath from OSM with geometry */
export interface PathWay {
  /** Ordered list of path centerline nodes */
  nodes: GeoPoint[];
  /** Path width in meters */
  width: number;
}

/** A fence line from OSM with geometry and material */
export interface FenceWay {
  /** Ordered list of fence nodes */
  nodes: GeoPoint[];
  /** Fence material tag (wood, metal, chain_link, etc.) */
  material: string;
}

/** A water feature near the building */
export interface WaterFeature {
  /** Type of water feature */
  type: 'pool' | 'pond' | 'river';
  /** Center latitude */
  lat: number;
  /** Center longitude */
  lng: number;
  /** Approximate radius in meters */
  radiusM: number;
}

/** A tree to place in the scene */
export interface SceneTree {
  /** Tree center latitude */
  lat: number;
  /** Tree center longitude */
  lng: number;
  /** Minecraft tree species */
  species: TreeType;
  /** Tree height in blocks (trunk height passed to placeTree) */
  height: number;
}

/**
 * Aggregated real-world data for scene construction around a building.
 * Produced by enrichForScene(), consumed by buildEnvironment().
 */
export interface SceneEnrichment {
  /** Tree positions with species and height, in lat/lng */
  trees: SceneTree[];
  /** Ground cover classification */
  groundCover: 'grass' | 'forest' | 'desert' | 'urban';
  /** Available tree species for this climate zone */
  treePalette: TreeType[];
  /** Road way geometries from OSM */
  roads: RoadWay[];
  /** Footpath geometries from OSM */
  paths: PathWay[];
  /** Fence geometries from OSM */
  fences: FenceWay[];
  /** Water features */
  waterFeatures: WaterFeature[];
  /** Whether property has a swimming pool */
  hasPool: boolean;
  /** Whether property has a driveway */
  hasDriveway: boolean;
  /** Whether property has a fence */
  hasFence: boolean;
  /** Terrain slope in meters across plot */
  terrainSlope: number;
}

// ─── Overpass API ───────────────────────────────────────────────────────────

/** Round-robin Overpass servers (same set as osm.ts for reliability) */
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

/** Raw Overpass element from JSON response */
interface OverpassWayElement {
  type: string;
  id: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

/**
 * Query OSM Overpass for infrastructure around a point: roads, footpaths,
 * fences, and water features within the given radius.
 *
 * Uses a single combined query for efficiency (one HTTP request instead of four).
 * Retries with exponential backoff on 429/504, rotating servers.
 *
 * @param lat    Center latitude
 * @param lng    Center longitude
 * @param radiusM  Search radius in meters
 * @returns Parsed infrastructure data, or empty defaults on failure
 */
export async function queryPlotInfrastructure(
  lat: number,
  lng: number,
  radiusM: number,
): Promise<{
  roads: RoadWay[];
  paths: PathWay[];
  fences: FenceWay[];
  waterFeatures: WaterFeature[];
}> {
  // Combined Overpass query for roads, paths, fences, and water
  // Each category is a separate union block so we can identify them by tags
  const query = `[out:json][timeout:15];(
    way[highway~"^(residential|tertiary|secondary|primary|unclassified|service)$"](around:${radiusM},${lat},${lng});
    way[highway~"^(footway|path|pedestrian|cycleway|steps)$"](around:${radiusM},${lat},${lng});
    way[barrier~"^(fence|wall|hedge|guard_rail|retaining_wall)$"](around:${radiusM},${lat},${lng});
    way[natural=water](around:${radiusM},${lat},${lng});
    way[waterway](around:${radiusM},${lat},${lng});
    way[leisure=swimming_pool](around:${radiusM},${lat},${lng});
  );out geom;`;

  const body = `data=${encodeURIComponent(query)}`;
  const MAX_RETRIES = 3;

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
          const delay = (attempt + 1) * 3000;
          console.warn(`Scene enrichment Overpass: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`Scene enrichment Overpass: HTTP ${resp.status} after ${MAX_RETRIES} retries`);
        return emptyInfrastructure();
      }

      if (!resp.ok) {
        console.warn(`Scene enrichment Overpass: HTTP ${resp.status}`);
        return emptyInfrastructure();
      }

      const data = await resp.json() as { elements?: OverpassWayElement[] };
      const elements = data.elements;
      if (!Array.isArray(elements) || elements.length === 0) {
        return emptyInfrastructure();
      }

      return parseInfrastructure(elements);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 3000;
        console.warn(`Scene enrichment Overpass: error, retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn('Scene enrichment Overpass request failed:', err);
      return emptyInfrastructure();
    }
  }

  return emptyInfrastructure();
}

/** Return empty infrastructure result (used as fallback on API failure) */
function emptyInfrastructure(): {
  roads: RoadWay[];
  paths: PathWay[];
  fences: FenceWay[];
  waterFeatures: WaterFeature[];
} {
  return { roads: [], paths: [], fences: [], waterFeatures: [] };
}

/**
 * Map OSM highway classification to approximate road width in meters.
 * Used for rendering roads at proportional widths in the BlockGrid.
 */
function roadWidthFromHighway(highway: string): number {
  switch (highway) {
    case 'primary': return 7;
    case 'secondary': return 6;
    case 'tertiary': return 5;
    case 'residential': return 4;
    case 'unclassified': return 4;
    case 'service': return 3;
    default: return 4;
  }
}

/**
 * Map OSM highway classification to approximate path width in meters.
 */
function pathWidthFromHighway(highway: string): number {
  switch (highway) {
    case 'footway': return 1.5;
    case 'path': return 1;
    case 'pedestrian': return 2;
    case 'cycleway': return 2;
    case 'steps': return 1.5;
    default: return 1;
  }
}

/** Road highway types (vehicular traffic) */
const ROAD_HIGHWAYS = new Set([
  'residential', 'tertiary', 'secondary', 'primary', 'unclassified', 'service',
]);

/** Path/footway highway types (pedestrian/cycle) */
const PATH_HIGHWAYS = new Set([
  'footway', 'path', 'pedestrian', 'cycleway', 'steps',
]);

/**
 * Parse Overpass way elements into categorized infrastructure.
 * Classifies each way by its tags into roads, paths, fences, or water.
 */
function parseInfrastructure(elements: OverpassWayElement[]): {
  roads: RoadWay[];
  paths: PathWay[];
  fences: FenceWay[];
  waterFeatures: WaterFeature[];
} {
  const roads: RoadWay[] = [];
  const paths: PathWay[] = [];
  const fences: FenceWay[] = [];
  const waterFeatures: WaterFeature[] = [];

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags ?? {};
    const nodes: GeoPoint[] = el.geometry.map(pt => ({ lat: pt.lat, lng: pt.lon }));

    // Classify by tags — check most specific first
    const highway = tags['highway'];
    const barrier = tags['barrier'];

    if (highway && ROAD_HIGHWAYS.has(highway)) {
      roads.push({
        nodes,
        width: roadWidthFromHighway(highway),
        surface: tags['surface'] ?? 'asphalt',
      });
    } else if (highway && PATH_HIGHWAYS.has(highway)) {
      paths.push({
        nodes,
        width: pathWidthFromHighway(highway),
      });
    } else if (barrier) {
      fences.push({
        nodes,
        material: tags['fence_type'] ?? tags['material'] ?? barrier,
      });
    } else if (tags['leisure'] === 'swimming_pool') {
      // Swimming pool — compute centroid and approximate radius
      const centroid = computeCentroid(nodes);
      const radius = estimateRadius(nodes, centroid);
      waterFeatures.push({
        type: 'pool',
        lat: centroid.lat,
        lng: centroid.lng,
        radiusM: radius,
      });
    } else if (tags['natural'] === 'water' || tags['waterway']) {
      const centroid = computeCentroid(nodes);
      const radius = estimateRadius(nodes, centroid);
      const type = tags['waterway'] === 'river' || tags['waterway'] === 'stream' ? 'river' : 'pond';
      waterFeatures.push({
        type,
        lat: centroid.lat,
        lng: centroid.lng,
        radiusM: radius,
      });
    }
  }

  return { roads, paths, fences, waterFeatures };
}

/**
 * Compute the geographic centroid of a set of points.
 */
function computeCentroid(points: GeoPoint[]): GeoPoint {
  let latSum = 0, lngSum = 0;
  for (const p of points) {
    latSum += p.lat;
    lngSum += p.lng;
  }
  return { lat: latSum / points.length, lng: lngSum / points.length };
}

/**
 * Estimate the radius in meters of a polygon from its centroid.
 * Uses the average distance from centroid to each vertex.
 */
function estimateRadius(points: GeoPoint[], centroid: GeoPoint): number {
  const R = 6371000; // Earth radius in meters
  let totalDist = 0;
  for (const p of points) {
    const dLat = (p.lat - centroid.lat) * Math.PI / 180;
    const dLng = (p.lng - centroid.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(centroid.lat * Math.PI / 180) * Math.cos(p.lat * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    totalDist += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return totalDist / points.length;
}

// ─── Deterministic Random ───────────────────────────────────────────────────

/**
 * Simple hash of lat+lng for deterministic tree placement.
 * Produces a positive integer seed from the coordinate string.
 */
function simpleHash(lat: number, lng: number): number {
  let h = 0;
  const s = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Create a simple seeded pseudo-random number generator.
 * Uses a linear congruential generator for fast deterministic output.
 *
 * @param seed  Integer seed value
 * @returns Function that returns pseudo-random float in [0, 1)
 */
function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    // LCG parameters (Numerical Recipes)
    state = (state * 1664525 + 1013904223) & 0x7FFFFFFF;
    return state / 0x7FFFFFFF;
  };
}

// ─── Hardiness Zone Inference ───────────────────────────────────────────────

/**
 * Infer USDA hardiness zone from latitude as a rough heuristic.
 * The real API module (web/src/ui/import-hardiness.ts) requires browser
 * APIs, so we use this simplified latitude-based approximation for CLI use.
 *
 * Accuracy: within 1-2 zones for the continental US. Does not account
 * for altitude, coastal effects, or urban heat islands.
 *
 * @param lat Latitude in decimal degrees
 * @returns Estimated hardiness zone number (1-13)
 */
function inferHardinessZoneFromLat(lat: number): number {
  const absLat = Math.abs(lat);
  // Rough mapping from latitude to US hardiness zone:
  // Zone 3-4: >45 degrees (Minnesota, Montana, northern Maine)
  // Zone 5-6: 40-45 degrees (New York, Michigan, Oregon)
  // Zone 7:   35-40 degrees (Virginia, Tennessee, Oklahoma)
  // Zone 8-9: 25-35 degrees (Texas, Georgia, N California)
  // Zone 10+: <25 degrees (S Florida, Hawaii, tropics)
  if (absLat > 48) return 3;
  if (absLat > 45) return 4;
  if (absLat > 42) return 5;
  if (absLat > 39) return 6;
  if (absLat > 35) return 7;
  if (absLat > 30) return 8;
  if (absLat > 25) return 9;
  return 10;
}

// ─── Tree Palette ───────────────────────────────────────────────────────────

/**
 * Map USDA hardiness zone number to Minecraft tree type palette.
 * Pure function — mirrors src/gen/address-pipeline.ts hardinessToTreePalette()
 * for use in the convert module without cross-boundary web imports.
 *
 * @param zoneNum  Hardiness zone number (1-13)
 * @returns Array of TreeType species appropriate for this climate
 */
function hardinessToTreePalette(zoneNum: number): TreeType[] {
  if (zoneNum <= 3) return ['spruce', 'birch'];                // very cold: boreal
  if (zoneNum <= 5) return ['oak', 'birch', 'spruce'];        // cold: mixed
  if (zoneNum <= 7) return ['oak', 'birch', 'dark_oak'];      // moderate: deciduous
  if (zoneNum <= 9) return ['oak', 'dark_oak', 'jungle'];     // warm: subtropical
  return ['jungle', 'acacia'];                                 // tropical: zone 10+
}

// ─── Ground Cover Inference ─────────────────────────────────────────────────

/** US states where desert ground cover is typical */
const DESERT_STATES = new Set(['AZ', 'NM', 'NV', 'UT']);

/** US states where forested ground cover is typical */
const FOREST_STATES = new Set(['OR', 'WA', 'ME', 'VT', 'NH', 'WV', 'ID', 'MT']);

/**
 * Determine ground cover classification from latitude and state abbreviation.
 * Used when no ESA WorldCover or NLCD data is available.
 *
 * @param lat    Latitude in decimal degrees
 * @param state  US state abbreviation (optional)
 * @returns Ground cover classification
 */
function inferGroundCover(
  lat: number,
  state?: string,
): 'grass' | 'forest' | 'desert' | 'urban' {
  const stateUpper = state?.toUpperCase();
  if (stateUpper && DESERT_STATES.has(stateUpper)) return 'desert';
  if (stateUpper && FOREST_STATES.has(stateUpper)) return 'forest';
  // Low latitude arid regions (below 33N in western US)
  if (lat < 33 && lat > 25) return 'desert';
  return 'grass';
}

// ─── Main Enrichment Function ───────────────────────────────────────────────

/**
 * Gather real-world data for scene construction around a building.
 * Calls multiple APIs in parallel (OSM, hardiness zone inference, etc.)
 * and combines results into a unified SceneEnrichment.
 *
 * All API calls are wrapped in try/catch with reasonable defaults on failure,
 * so this function always returns a valid SceneEnrichment.
 *
 * @param lat        Building center latitude
 * @param lng        Building center longitude
 * @param radiusM    Plot radius in meters (typically 30-50)
 * @param options    Optional overrides from PropertyData
 * @returns Aggregated scene enrichment data
 */
export async function enrichForScene(
  lat: number,
  lng: number,
  radiusM: number,
  options?: {
    /** Whether property has a pool (from assessor data) */
    hasPool?: boolean;
    /** Whether property has a driveway (from aerial/assessor data) */
    hasDriveway?: boolean;
    /** Whether property has a fence (from aerial/assessor data) */
    hasFence?: boolean;
    /** Known hardiness zone number (skips latitude inference) */
    hardinessZone?: number;
    /** US state abbreviation for ground cover inference */
    stateAbbreviation?: string;
  },
): Promise<SceneEnrichment> {
  // 1. Query OSM infrastructure in parallel with local computations
  const infraPromise = queryPlotInfrastructure(lat, lng, radiusM);

  // 2. Determine hardiness zone — use override or infer from latitude
  const zoneNum = options?.hardinessZone ?? inferHardinessZoneFromLat(lat);

  // 3. Map hardiness zone to tree palette
  const treePalette = hardinessToTreePalette(zoneNum);

  // 4. Determine ground cover
  const groundCover = inferGroundCover(lat, options?.stateAbbreviation);

  // 5. Generate deterministic tree positions around building perimeter
  const seed = simpleHash(lat, lng);
  const rng = seededRng(seed);

  // Scale tree count: colder climates have more coniferous cover,
  // desert has fewer trees, temperate/forest have moderate density
  const baseTreeCount = groundCover === 'desert' ? 2
    : groundCover === 'forest' ? 7
    : groundCover === 'urban' ? 3
    : 5;
  const treeCount = Math.max(3, Math.min(8, baseTreeCount + Math.floor(rng() * 3) - 1));

  // Tree height: colder zones have taller conifers, tropical are mid-height
  const baseHeight = zoneNum <= 4 ? 6 : zoneNum <= 7 ? 5 : 4;

  const trees: SceneTree[] = [];
  for (let i = 0; i < treeCount; i++) {
    // Scatter trees at random angles around building perimeter
    const angle = rng() * Math.PI * 2;
    // Distance between 30% and 90% of plot radius — keeps trees outside
    // the building footprint but within the scene area
    const dist = radiusM * (0.3 + rng() * 0.6);

    // Convert polar offset to lat/lng delta
    const dLatM = Math.cos(angle) * dist;
    const dLngM = Math.sin(angle) * dist;
    const treeLat = lat + dLatM / 111320;
    const treeLng = lng + dLngM / (111320 * Math.cos(lat * Math.PI / 180));

    // Select species from palette (deterministic rotation)
    const species = treePalette[i % treePalette.length];

    // Vary height +/- 1 block from base
    const height = Math.max(3, Math.min(8, baseHeight + Math.floor(rng() * 3) - 1));

    trees.push({ lat: treeLat, lng: treeLng, species, height });
  }

  // 6. Await OSM infrastructure results
  const infra = await infraPromise;

  // 7. Determine property flags — use options if provided, otherwise
  // infer from OSM data or use reasonable defaults
  const hasPool = options?.hasPool ??
    infra.waterFeatures.some(w => w.type === 'pool');
  const hasDriveway = options?.hasDriveway ?? true; // most US houses have driveways
  const hasFence = options?.hasFence ??
    infra.fences.length > 0;

  // 8. Terrain slope: not available without elevation API, default to flat
  // TODO: integrate elevation.ts for real slope data when available
  const terrainSlope = 0;

  return {
    trees,
    groundCover,
    treePalette,
    roads: infra.roads,
    paths: infra.paths,
    fences: infra.fences,
    waterFeatures: infra.waterFeatures,
    hasPool,
    hasDriveway,
    hasFence,
    terrainSlope,
  };
}
