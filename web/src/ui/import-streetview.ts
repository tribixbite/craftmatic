/**
 * Google Street View Static API client — generates image URLs for exterior
 * property photos. Requires a Google API key with Street View Static API enabled.
 * Key is stored in localStorage for persistence across sessions.
 *
 * Images are loaded via <img> tag (no CORS issues).
 * Free tier: $7/1000 requests (up to $200/month free credit).
 */

const STORAGE_KEY = 'craftmatic_google_streetview_key';
const SV_BASE = 'https://maps.googleapis.com/maps/api/streetview';
const SV_META = 'https://maps.googleapis.com/maps/api/streetview/metadata';

/** Sign-up link for enabling the Street View Static API */
export const STREETVIEW_SIGNUP_URL =
  'https://console.cloud.google.com/apis/library/street-view-image-backend.googleapis.com';

// ─── API Key Management ─────────────────────────────────────────────────────

/** Get stored Google Street View API key from localStorage */
export function getStreetViewApiKey(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}

/** Store Google Street View API key in localStorage */
export function setStreetViewApiKey(key: string): void {
  if (key.trim()) {
    localStorage.setItem(STORAGE_KEY, key.trim());
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Check if a Google Street View API key is configured */
export function hasStreetViewApiKey(): boolean {
  return getStreetViewApiKey().length > 0;
}

// ─── URL Generation ─────────────────────────────────────────────────────────

/**
 * Generate a Street View Static API image URL for the given coordinates.
 * Returns a URL that can be used as an <img src> directly.
 *
 * @param lat   Latitude
 * @param lng   Longitude
 * @param apiKey  Google API key
 * @param size  Image dimensions (default 600x400 — fits free tier)
 */
export function getStreetViewUrl(
  lat: number,
  lng: number,
  apiKey: string,
  size = '600x400',
): string {
  return `${SV_BASE}?size=${size}&location=${lat},${lng}&key=${apiKey}`;
}

// ─── Availability Check ─────────────────────────────────────────────────────

/**
 * Check whether Street View imagery exists at the given coordinates.
 * Uses the metadata endpoint which doesn't count against image request quota.
 * Returns true if imagery is available (status === 'OK').
 */
export async function checkStreetViewAvailability(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<boolean> {
  try {
    const url = `${SV_META}?location=${lat},${lng}&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return false;

    const data = await resp.json();
    return data.status === 'OK';
  } catch {
    return false;
  }
}
