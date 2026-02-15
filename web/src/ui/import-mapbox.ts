/**
 * Mapbox satellite tile fetcher — provides high-resolution (30cm) aerial
 * tiles as an alternative to ESRI. Requires a Mapbox access token.
 * Token is stored in localStorage for persistence across sessions.
 *
 * CORS-enabled (canvas-readable for color extraction).
 * Free tier: 200,000 tile requests/month.
 */

const STORAGE_KEY = 'craftmatic_mapbox_token';

/** Sign-up link for creating a Mapbox account */
export const MAPBOX_SIGNUP_URL = 'https://account.mapbox.com/auth/signup/';

// ─── Token Management ───────────────────────────────────────────────────────

/** Get stored Mapbox access token from localStorage */
export function getMapboxToken(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}

/** Store Mapbox access token in localStorage */
export function setMapboxToken(token: string): void {
  if (token.trim()) {
    localStorage.setItem(STORAGE_KEY, token.trim());
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Check if a Mapbox access token is configured */
export function hasMapboxToken(): boolean {
  return getMapboxToken().length > 0;
}

// ─── Tile Fetching ──────────────────────────────────────────────────────────

/**
 * Fetch a single Mapbox satellite tile as an HTMLImageElement.
 * Uses @2x suffix for 512px tiles (higher res than ESRI's 256px).
 * Returns a CORS-enabled image suitable for canvas color extraction.
 *
 * @param x     Tile X coordinate
 * @param y     Tile Y coordinate
 * @param z     Zoom level
 * @param token Mapbox access token
 */
export function fetchMapboxTile(
  x: number,
  y: number,
  z: number,
  token: string,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Mapbox tile ${z}/${x}/${y} failed`));
    img.src = `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.png?access_token=${token}`;
  });
}

/**
 * Create a TileFetcher function bound to the current Mapbox token.
 * Used to pass into composeSatelliteView() as an alternative tile source.
 */
export function createMapboxTileFetcher(
  token: string,
): (x: number, y: number, z: number) => Promise<HTMLImageElement> {
  return (x, y, z) => fetchMapboxTile(x, y, z, token);
}
