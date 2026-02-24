/**
 * Mapbox Tilequery API client — queries Mapbox vector tiles for building
 * height data near a lat/lng point. Building heights are derived from
 * LiDAR/3DEP aerial data, significantly more accurate than OSM estimates.
 *
 * Returns building height (meters), building type, and extrusion flag.
 * Height directly converts to floor count: Math.round(height / 3.5).
 *
 * Free tier: 100,000 requests/month.
 * Node/Bun-compatible — no browser APIs needed.
 * API docs: https://docs.mapbox.com/api/maps/tilequery/
 */

const API_BASE = 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery';
const MAX_RETRIES = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Building data from Mapbox vector tiles */
export interface MapboxBuildingData {
  /** Building height in meters (from LiDAR/3DEP, rounded to nearest int) */
  height: number;
  /** Height of building base above ground in meters (for podium levels) */
  minHeight: number;
  /** Building type classification: 'house', 'apartments', 'detached', 'garage', etc. */
  buildingType?: string;
  /** Whether the building should be 3D extruded (has reliable height data) */
  extrude: boolean;
  /** Distance from query point to building centroid in meters */
  distance: number;
}

// ─── Raw API response type ──────────────────────────────────────────────────

interface TilequeryResponse {
  type: 'FeatureCollection';
  features?: Array<{
    type: 'Feature';
    geometry?: { type: string; coordinates: [number, number] };
    properties?: {
      height?: number;
      min_height?: number;
      type?: string;
      extrude?: string; // "true" | "false"
      tilequery?: {
        distance: number;
        geometry: string;
        layer: string;
      };
    };
  }>;
}

// ─── API Key Management ──────────────────────────────────────────────────────

/** Get Mapbox API key from environment variable */
export function getMapboxApiKey(): string {
  return (typeof process !== 'undefined' ? process.env?.MAPBOX_API_KEY : '') ?? '';
}

/** Check if a Mapbox API key is configured */
export function hasMapboxApiKey(): boolean {
  return getMapboxApiKey().length > 0;
}

// ─── Building Query ─────────────────────────────────────────────────────────

/**
 * Query Mapbox vector tiles for building height data near a coordinate.
 * Returns the closest building with height data, or null on failure.
 *
 * @param lat Target latitude
 * @param lng Target longitude
 * @param apiKey Mapbox access token (pk.eyJ1I...)
 * @param radiusMeters Search radius (default 30m, max 100m)
 */
export async function queryMapboxBuilding(
  lat: number,
  lng: number,
  apiKey?: string,
  radiusMeters = 30,
): Promise<MapboxBuildingData | null> {
  const key = apiKey ?? getMapboxApiKey();
  if (!key) return null;

  const radius = Math.min(radiusMeters, 100);
  const url = `${API_BASE}/${lng},${lat}.json?radius=${radius}&layers=building&limit=10&access_token=${key}`;

  const data = await fetchWithRetry<TilequeryResponse>(url);
  if (!data?.features || !Array.isArray(data.features)) return null;

  // Filter to features with height data, sorted by distance from query point
  const buildings: MapboxBuildingData[] = [];
  for (const feat of data.features) {
    const props = feat.properties;
    if (!props || !props.height || props.height <= 0) continue;

    buildings.push({
      height: props.height,
      minHeight: props.min_height ?? 0,
      buildingType: props.type || undefined,
      extrude: props.extrude === 'true',
      distance: props.tilequery?.distance ?? 999,
    });
  }

  if (buildings.length === 0) return null;

  // Return the closest building with height data
  buildings.sort((a, b) => a.distance - b.distance);
  return buildings[0];
}

// ─── Internal: Fetch with retry ──────────────────────────────────────────────

async function fetchWithRetry<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });

      // Retry on rate limit or gateway timeout
      if (resp.status === 429 || resp.status === 504) {
        if (attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 2000;
          console.warn(`Mapbox API: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`Mapbox API: HTTP ${resp.status} after ${MAX_RETRIES} retries`);
        return null;
      }

      // Auth errors — don't retry
      if (resp.status === 401 || resp.status === 403) {
        console.warn('Mapbox API: invalid or expired access token');
        return null;
      }

      if (!resp.ok) return null;

      return await resp.json() as T;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 2000;
        console.warn(`Mapbox API: error, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn('Mapbox API request failed:', err);
      return null;
    }
  }
  return null;
}
