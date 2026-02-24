/**
 * Google Solar API client — queries building insights for roof geometry
 * derived from ML analysis of aerial/satellite imagery.
 *
 * Returns per-roof-segment pitch, azimuth, and area. Segment count
 * reveals roof shape: 2 = gable, 4 = hip, 1 + low pitch = flat.
 * Pitch degrees translate to Minecraft roof height (stair block density).
 *
 * Free tier: 10,000 requests/month (buildingInsights).
 * Node/Bun-compatible — no browser APIs needed.
 * API docs: https://developers.google.com/maps/documentation/solar/building-insights
 */

const API_BASE = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';
const MAX_RETRIES = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Processed building insights from Google Solar API */
export interface SolarBuildingData {
  /** Pitch of the dominant (largest area) roof segment in degrees */
  primaryPitchDegrees: number;
  /** Compass azimuth of the dominant roof segment (0=N, 90=E, 180=S, 270=W) */
  primaryAzimuthDegrees: number;
  /** Total number of distinct roof faces/segments */
  roofSegmentCount: number;
  /** Total roof surface area in sqm (accounting for tilt) */
  totalRoofAreaSqm: number;
  /** Building footprint area in sqm (ground projection) */
  buildingFootprintAreaSqm: number;
  /** Height of the primary roof plane center above sea level (meters) */
  primaryPlaneHeight: number;
  /** Imagery quality level: 'HIGH', 'MEDIUM', or 'LOW' */
  imageryQuality: string;
}

// ─── Raw API response types ─────────────────────────────────────────────────

interface SolarRoofSegment {
  pitchDegrees?: number;
  azimuthDegrees?: number;
  stats?: {
    areaMeters2?: number;
    groundAreaMeters2?: number;
  };
  center?: { latitude: number; longitude: number };
  boundingBox?: { sw: { latitude: number; longitude: number }; ne: { latitude: number; longitude: number } };
  planeHeightAtCenterMeters?: number;
}

interface SolarApiResponse {
  name?: string;
  center?: { latitude: number; longitude: number };
  boundingBox?: { sw: { latitude: number; longitude: number }; ne: { latitude: number; longitude: number } };
  imageryQuality?: string;
  solarPotential?: {
    roofSegmentStats?: SolarRoofSegment[];
    wholeRoofStats?: { areaMeters2?: number; groundAreaMeters2?: number };
    buildingStats?: { areaMeters2?: number };
  };
  error?: { code: number; message: string; status: string };
}

// ─── API Key Management ──────────────────────────────────────────────────────

/** Get Google Maps API key from environment variable */
export function getGoogleApiKey(): string {
  return (typeof process !== 'undefined' ? process.env?.GOOGLE_MAPS_API_KEY : '') ?? '';
}

/** Check if a Google Maps API key is configured */
export function hasGoogleApiKey(): boolean {
  return getGoogleApiKey().length > 0;
}

// ─── Building Insights Query ────────────────────────────────────────────────

/**
 * Query Google Solar API for building roof geometry and insights.
 * Tries HIGH quality first, falls back to MEDIUM if not available.
 * Returns null if no data found for the location.
 *
 * @param lat Target latitude
 * @param lng Target longitude
 * @param apiKey Google Maps API key
 */
export async function querySolarBuildingInsights(
  lat: number,
  lng: number,
  apiKey?: string,
): Promise<SolarBuildingData | null> {
  const key = apiKey ?? getGoogleApiKey();
  if (!key) return null;

  // Try HIGH quality first (best data, ~70-80% US suburban coverage)
  let data = await fetchSolarData(lat, lng, key, 'HIGH');

  // Fall back to MEDIUM if HIGH not available
  if (!data) {
    data = await fetchSolarData(lat, lng, key, 'MEDIUM');
  }

  if (!data?.solarPotential?.roofSegmentStats?.length) return null;

  const segments = data.solarPotential.roofSegmentStats;

  // Find the dominant (largest area) roof segment
  let primarySegment = segments[0];
  let maxArea = 0;
  for (const seg of segments) {
    const area = seg.stats?.areaMeters2 ?? 0;
    if (area > maxArea) {
      maxArea = area;
      primarySegment = seg;
    }
  }

  // Sum total roof area
  const totalRoofArea = segments.reduce(
    (sum, seg) => sum + (seg.stats?.areaMeters2 ?? 0), 0,
  );

  return {
    primaryPitchDegrees: primarySegment.pitchDegrees ?? 0,
    primaryAzimuthDegrees: primarySegment.azimuthDegrees ?? 0,
    roofSegmentCount: segments.length,
    totalRoofAreaSqm: totalRoofArea,
    buildingFootprintAreaSqm: data.solarPotential?.buildingStats?.areaMeters2 ?? 0,
    primaryPlaneHeight: primarySegment.planeHeightAtCenterMeters ?? 0,
    imageryQuality: data.imageryQuality ?? 'UNKNOWN',
  };
}

// ─── Internal: Fetch solar data with quality level ──────────────────────────

async function fetchSolarData(
  lat: number,
  lng: number,
  apiKey: string,
  quality: 'HIGH' | 'MEDIUM',
): Promise<SolarApiResponse | null> {
  const url = `${API_BASE}?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=${quality}&key=${apiKey}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      });

      // 404 = no data for this quality level at this location
      if (resp.status === 404) return null;

      // Retry on rate limit or gateway timeout
      if (resp.status === 429 || resp.status === 504) {
        if (attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 2000;
          console.warn(`Solar API: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`Solar API: HTTP ${resp.status} after ${MAX_RETRIES} retries`);
        return null;
      }

      // Auth errors — don't retry
      if (resp.status === 401 || resp.status === 403) {
        console.warn('Solar API: invalid or expired API key (ensure Solar API is enabled in GCP console)');
        return null;
      }

      if (!resp.ok) return null;

      const result = await resp.json() as SolarApiResponse;
      // Check for API-level error response
      if (result.error) {
        console.warn(`Solar API error: ${result.error.message}`);
        return null;
      }

      return result;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 2000;
        console.warn(`Solar API: error, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn('Solar API request failed:', err);
      return null;
    }
  }
  return null;
}
