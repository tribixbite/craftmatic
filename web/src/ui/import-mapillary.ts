/**
 * Mapillary browser-side wrapper — localStorage key management for the
 * Mapillary client access token. Re-exports the shared API client functions.
 *
 * Free street-level imagery alternative to Google Street View.
 * Token signup: https://www.mapillary.com/dashboard/developers
 */

export {
  searchMapillaryImages, searchMapillaryFeatures,
  pickBestImage, analyzeFeatures,
  MAPILLARY_SIGNUP_URL,
  type MapillaryImageData, type MapillaryFeatureData,
} from '@craft/gen/api/mapillary.js';

const STORAGE_KEY = 'craftmatic_mapillary_token';

// ─── API Key Management ──────────────────────────────────────────────────────

/** Get stored Mapillary access token from localStorage */
export function getMapillaryMlyToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}

/** Store Mapillary access token in localStorage */
export function setMapillaryMlyToken(token: string): void {
  if (token.trim()) {
    localStorage.setItem(STORAGE_KEY, token.trim());
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Check if a Mapillary access token is configured in localStorage */
export function hasMapillaryMlyToken(): boolean {
  return getMapillaryMlyToken().length > 0;
}
