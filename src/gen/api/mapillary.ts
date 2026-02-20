/**
 * Mapillary API v4 client — searches for street-level images and map features
 * near a given coordinate. Free, no billing (CC BY-SA 4.0).
 *
 * Images provide an exterior photo alternative to Google Street View.
 * Map features detect driveways, fences, and other objects near the property.
 *
 * Node/Bun-compatible — no browser APIs needed.
 * API docs: https://www.mapillary.com/developer/api-documentation
 */

const API_BASE = 'https://graph.mapillary.com';
const MAX_RETRIES = 3;

/** Signup link for obtaining a free Mapillary client token */
export const MAPILLARY_SIGNUP_URL = 'https://www.mapillary.com/dashboard/developers';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Street-level image near a property */
export interface MapillaryImageData {
  /** Mapillary image ID */
  id: string;
  /** Capture timestamp (Unix ms) */
  capturedAt: number;
  /** Camera compass heading: 0=north, 90=east, 180=south, 270=west */
  compassAngle: number;
  /** Image center latitude */
  lat: number;
  /** Image center longitude */
  lng: number;
  /** True if this is a 360-degree panoramic image */
  isPano: boolean;
  /** 1024px thumbnail URL (has TTL — must re-fetch periodically) */
  thumbUrl: string;
  /** Image pixel width */
  width: number;
  /** Image pixel height */
  height: number;
}

/** Map feature (real-world object) detected near a property */
export interface MapillaryFeatureData {
  id: string;
  /** Object class, e.g. 'object--fire-hydrant', 'construction--flat--driveway' */
  type: string;
  lat: number;
  lng: number;
}

// ─── Raw API response types ──────────────────────────────────────────────────

interface MapillaryImageResponse {
  data?: Array<{
    id?: string;
    captured_at?: number;
    compass_angle?: number;
    geometry?: { type: string; coordinates: [number, number] };
    is_pano?: boolean;
    thumb_1024_url?: string;
    width?: number;
    height?: number;
  }>;
}

interface MapillaryFeatureResponse {
  data?: Array<{
    id?: string;
    object_value?: string;
    geometry?: { type: string; coordinates: [number, number] };
  }>;
}

// ─── API Key Management ──────────────────────────────────────────────────────

/** Get Mapillary access token from environment variable */
export function getMapillaryApiKey(): string {
  return (typeof process !== 'undefined' ? process.env?.MAPILLARY_ACCESS_TOKEN : '') ?? '';
}

/** Check if a Mapillary access token is configured */
export function hasMapillaryApiKey(): boolean {
  return getMapillaryApiKey().length > 0;
}

// ─── Image Search ────────────────────────────────────────────────────────────

/**
 * Search for street-level images near a coordinate.
 * Returns up to 20 images sorted by distance from target, or null on failure.
 *
 * @param lat Target latitude
 * @param lng Target longitude
 * @param apiKey Mapillary client token (MLY|...)
 * @param radiusDeg Search radius in degrees (~0.002 = ~200m). Max 0.005.
 */
export async function searchMapillaryImages(
  lat: number,
  lng: number,
  apiKey: string,
  radiusDeg = 0.002,
): Promise<MapillaryImageData[] | null> {
  if (!apiKey) return null;

  const r = Math.min(radiusDeg, 0.005);
  const bbox = `${lng - r},${lat - r},${lng + r},${lat + r}`;
  const fields = 'id,captured_at,compass_angle,geometry,is_pano,thumb_1024_url,width,height';
  const url = `${API_BASE}/images?fields=${fields}&bbox=${bbox}&limit=20`;

  const data = await fetchWithRetry<MapillaryImageResponse>(url, apiKey);
  if (!data?.data || !Array.isArray(data.data)) return null;

  const images: MapillaryImageData[] = [];
  for (const item of data.data) {
    if (!item.id || !item.geometry?.coordinates) continue;
    images.push({
      id: item.id,
      capturedAt: item.captured_at ?? 0,
      compassAngle: item.compass_angle ?? 0,
      lat: item.geometry.coordinates[1],
      lng: item.geometry.coordinates[0],
      isPano: item.is_pano ?? false,
      thumbUrl: item.thumb_1024_url ?? '',
      width: item.width ?? 0,
      height: item.height ?? 0,
    });
  }

  if (images.length === 0) return null;

  // Sort by distance from target
  images.sort((a, b) => {
    const dA = (a.lat - lat) ** 2 + (a.lng - lng) ** 2;
    const dB = (b.lat - lat) ** 2 + (b.lng - lng) ** 2;
    return dA - dB;
  });

  return images;
}

// ─── Map Feature Search ──────────────────────────────────────────────────────

/** Object types relevant to property feature inference */
const PROPERTY_FEATURES = [
  'construction--flat--driveway',
  'construction--barrier--fence',
  'construction--barrier--wall',
  'object--fire-hydrant',
  'object--street-light',
  'object--trash-can',
  'object--mailbox',
].join(',');

/**
 * Search for map features (fences, driveways, etc.) near a coordinate.
 * Returns array of features, or null on failure.
 *
 * @param lat Target latitude
 * @param lng Target longitude
 * @param apiKey Mapillary client token
 * @param radiusDeg Search radius in degrees (~0.002 = ~200m)
 */
export async function searchMapillaryFeatures(
  lat: number,
  lng: number,
  apiKey: string,
  radiusDeg = 0.002,
): Promise<MapillaryFeatureData[] | null> {
  if (!apiKey) return null;

  const r = Math.min(radiusDeg, 0.005);
  const bbox = `${lng - r},${lat - r},${lng + r},${lat + r}`;
  const fields = 'id,object_value,geometry';
  const url = `${API_BASE}/map_features?fields=${fields}&bbox=${bbox}&object_values=${PROPERTY_FEATURES}&limit=100`;

  const data = await fetchWithRetry<MapillaryFeatureResponse>(url, apiKey);
  if (!data?.data || !Array.isArray(data.data)) return null;

  const features: MapillaryFeatureData[] = [];
  for (const item of data.data) {
    if (!item.id || !item.geometry?.coordinates) continue;
    features.push({
      id: item.id,
      type: item.object_value ?? '',
      lat: item.geometry.coordinates[1],
      lng: item.geometry.coordinates[0],
    });
  }

  return features;
}

// ─── Image Selection ─────────────────────────────────────────────────────────

/**
 * Pick the best image for displaying a building exterior.
 * Prefers: non-panoramic, closest to target, most recent.
 * Returns null if no suitable image found.
 */
export function pickBestImage(
  images: MapillaryImageData[],
  targetLat: number,
  targetLng: number,
): MapillaryImageData | null {
  if (images.length === 0) return null;

  // Score each image: lower = better
  const scored = images.map(img => {
    const dist = Math.sqrt((img.lat - targetLat) ** 2 + (img.lng - targetLng) ** 2);
    // Penalize panoramic (flat photos show buildings better at small sizes)
    const panoPenalty = img.isPano ? 0.001 : 0;
    // Slight bonus for newer images (capturedAt in ms, normalize to ~0-1 range)
    const agePenalty = img.capturedAt > 0 ? -img.capturedAt / 1e15 : 0;
    return { img, score: dist + panoPenalty + agePenalty };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored[0].img;
}

// ─── Feature Analysis ────────────────────────────────────────────────────────

/**
 * Analyze map features to infer property characteristics.
 * Returns booleans for driveway and fence presence.
 */
export function analyzeFeatures(
  features: MapillaryFeatureData[],
): { hasDriveway: boolean; hasFence: boolean } {
  let hasDriveway = false;
  let hasFence = false;

  for (const f of features) {
    if (f.type.includes('driveway')) hasDriveway = true;
    if (f.type.includes('fence') || f.type.includes('wall')) hasFence = true;
  }

  return { hasDriveway, hasFence };
}

// ─── Internal: Fetch with retry ──────────────────────────────────────────────

async function fetchWithRetry<T>(url: string, apiKey: string): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `OAuth ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });

      // Retry on rate limit or gateway timeout
      if (resp.status === 429 || resp.status === 504) {
        if (attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 2000;
          console.warn(`Mapillary API: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`Mapillary API: HTTP ${resp.status} after ${MAX_RETRIES} retries`);
        return null;
      }

      // Auth errors — don't retry
      if (resp.status === 401 || resp.status === 403) {
        console.warn('Mapillary API: invalid or expired token');
        return null;
      }

      if (!resp.ok) return null;

      return await resp.json() as T;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 2000;
        console.warn(`Mapillary API: error, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn('Mapillary API request failed:', err);
      return null;
    }
  }
  return null;
}
