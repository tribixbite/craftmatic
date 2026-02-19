/**
 * Geocoding module — resolves US addresses to lat/lng coordinates.
 * Primary: US Census Bureau Geocoder (free, no key, CORS-friendly).
 * Fallback: Nominatim OSM (free, 1 req/sec, needs User-Agent).
 *
 * Node/Bun-compatible — no browser APIs needed.
 */

export interface GeocodingResult {
  lat: number;
  lng: number;
  matchedAddress: string;
  source: 'census' | 'nominatim';
}

/**
 * Geocode a US address to lat/lng coordinates.
 * Tries Census Bureau first, falls back to Nominatim OSM.
 */
export async function geocodeAddress(address: string): Promise<GeocodingResult> {
  const trimmed = address.trim();
  if (!trimmed) throw new Error('Address is empty');

  // Primary: US Census Bureau Geocoder
  try {
    const result = await geocodeCensus(trimmed);
    if (result) return result;
  } catch (err) {
    console.warn('Census geocoder failed, trying Nominatim:', err);
  }

  // Fallback: Nominatim OSM
  try {
    const result = await geocodeNominatim(trimmed);
    if (result) return result;
  } catch (err) {
    console.warn('Nominatim geocoder failed:', err);
  }

  throw new Error('Could not geocode address. Check the address and try again.');
}

/** US Census Bureau geocoder — free, no API key, CORS-friendly */
async function geocodeCensus(address: string): Promise<GeocodingResult | null> {
  const enc = encodeURIComponent(address);
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${enc}&benchmark=Public_AR_Current&format=json`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) return null;

  const data: any = await resp.json();
  const matches = data?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length === 0) return null;

  const match = matches[0];
  const coords = match.coordinates;
  if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') return null;

  return {
    lat: coords.y,
    lng: coords.x,
    matchedAddress: match.matchedAddress || address,
    source: 'census',
  };
}

/** Nominatim OSM geocoder — free, 1 req/sec rate limit */
async function geocodeNominatim(address: string): Promise<GeocodingResult | null> {
  const enc = encodeURIComponent(address);
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${enc}&limit=1`;

  const resp = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Craftmatic/1.0 (minecraft-schematic-generator)' },
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const result = data[0];
  const lat = parseFloat(result.lat);
  const lng = parseFloat(result.lon);
  if (isNaN(lat) || isNaN(lng)) return null;

  return {
    lat,
    lng,
    matchedAddress: result.display_name || address,
    source: 'nominatim',
  };
}
