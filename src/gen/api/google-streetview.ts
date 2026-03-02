/**
 * Google Street View Static API client — queries for street-level imagery
 * metadata and constructs image URLs for building exterior reference.
 *
 * Metadata endpoint is FREE (unlimited). Image requests cost 1 quota each
 * (10,000 free/month). Better US coverage than Mapillary (~95% vs ~40%),
 * controllable heading/pitch, and consistent professional-grade imagery.
 *
 * Node/Bun-compatible — no browser APIs needed.
 * API docs: https://developers.google.com/maps/documentation/streetview/overview
 */

const SV_META_BASE = 'https://maps.googleapis.com/maps/api/streetview/metadata';
const SV_IMAGE_BASE = 'https://maps.googleapis.com/maps/api/streetview';
const MAX_RETRIES = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Processed Street View metadata + constructed image URL */
export interface StreetViewMetadata {
  /** Google panorama ID */
  panoId: string;
  /** Capture date in "YYYY-MM" format */
  date: string;
  /** Panorama center latitude */
  lat: number;
  /** Panorama center longitude */
  lng: number;
  /** Constructed image URL (640x480, heading toward target, +10° pitch) */
  imageUrl: string;
  /** Camera heading from panorama location toward target building (0-360°) */
  heading: number;
}

// ─── Raw API response type ──────────────────────────────────────────────────

interface SvMetadataResponse {
  status: 'OK' | 'ZERO_RESULTS' | 'NOT_FOUND' | 'OVER_QUERY_LIMIT' | 'REQUEST_DENIED' | 'INVALID_REQUEST' | 'UNKNOWN_ERROR';
  pano_id?: string;
  date?: string;
  location?: {
    lat: number;
    lng: number;
  };
  copyright?: string;
}

// ─── API Key Management ──────────────────────────────────────────────────────

/** Get Google Maps API key from environment variable (shared with Solar API) */
export function getGoogleStreetViewKey(): string {
  return (typeof process !== 'undefined' ? process.env?.GOOGLE_MAPS_API_KEY : '') ?? '';
}

/** Check if a Google Maps API key is configured */
export function hasGoogleStreetViewKey(): boolean {
  return getGoogleStreetViewKey().length > 0;
}

// ─── Metadata Query ─────────────────────────────────────────────────────────

/**
 * Query Google Street View metadata for a location. This endpoint is FREE
 * and does not consume quota. Returns null if no Street View coverage exists.
 *
 * Prefers outdoor panoramas via `source=outdoor` parameter, falling back
 * to any source if outdoor-only yields no results. This avoids indoor
 * panoramas from businesses, lobbies, and Google 360 photo uploads.
 *
 * @param lat Target building latitude
 * @param lng Target building longitude
 * @param apiKey Google Maps API key
 */
export async function queryStreetViewMetadata(
  lat: number,
  lng: number,
  apiKey?: string,
): Promise<StreetViewMetadata | null> {
  const key = apiKey ?? getGoogleStreetViewKey();
  if (!key) return null;

  // Try outdoor-only first to avoid indoor panoramas (metadata calls are free)
  let data = await fetchWithRetry<SvMetadataResponse>(
    `${SV_META_BASE}?location=${lat},${lng}&source=outdoor&key=${key}`,
  );

  // Fall back to any source if outdoor-only returns no results
  if (!data || data.status !== 'OK' || !data.pano_id || !data.location) {
    data = await fetchWithRetry<SvMetadataResponse>(
      `${SV_META_BASE}?location=${lat},${lng}&key=${key}`,
    );
    if (!data || data.status !== 'OK' || !data.pano_id || !data.location) return null;
  }

  return buildMetadata(data, lat, lng, key);
}

/**
 * Re-query Street View metadata at a wider radius to find a different
 * panorama. Used as fallback when the initial image is flagged as indoor.
 * Metadata calls are free — no quota cost for retries.
 */
export async function queryStreetViewFallback(
  lat: number,
  lng: number,
  excludePanoId: string,
  apiKey?: string,
): Promise<StreetViewMetadata | null> {
  const key = apiKey ?? getGoogleStreetViewKey();
  if (!key) return null;

  // Try increasing radii to find a different outdoor panorama
  for (const radius of [100, 250, 500]) {
    const data = await fetchWithRetry<SvMetadataResponse>(
      `${SV_META_BASE}?location=${lat},${lng}&radius=${radius}&source=outdoor&key=${key}`,
    );
    if (data?.status === 'OK' && data.pano_id && data.location &&
        data.pano_id !== excludePanoId) {
      return buildMetadata(data, lat, lng, key);
    }
  }
  return null;
}

/** Construct StreetViewMetadata from raw API response */
function buildMetadata(
  data: SvMetadataResponse, targetLat: number, targetLng: number, key: string,
): StreetViewMetadata {
  const heading = computeHeading(
    data.location!.lat, data.location!.lng,
    targetLat, targetLng,
  );

  const imageUrl = `${SV_IMAGE_BASE}?size=640x480&pano=${data.pano_id!}&heading=${heading.toFixed(1)}&pitch=10&fov=90&key=${key}`;

  return {
    panoId: data.pano_id!,
    date: data.date ?? '',
    lat: data.location!.lat,
    lng: data.location!.lng,
    imageUrl,
    heading,
  };
}

// ─── Heading Calculation ────────────────────────────────────────────────────

/**
 * Compute compass heading from one point to another using the forward azimuth
 * formula. Returns degrees 0-360 (0=north, 90=east, 180=south, 270=west).
 */
function computeHeading(
  fromLat: number, fromLng: number,
  toLat: number, toLng: number,
): number {
  const toRad = Math.PI / 180;
  const dLng = (toLng - fromLng) * toRad;
  const lat1 = fromLat * toRad;
  const lat2 = toLat * toRad;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
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
          console.warn(`StreetView API: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`StreetView API: HTTP ${resp.status} after ${MAX_RETRIES} retries`);
        return null;
      }

      // Auth errors — don't retry
      if (resp.status === 401 || resp.status === 403) {
        console.warn('StreetView API: invalid or expired API key');
        return null;
      }

      if (!resp.ok) return null;

      return await resp.json() as T;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 2000;
        console.warn(`StreetView API: error, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn('StreetView API request failed:', err);
      return null;
    }
  }
  return null;
}
