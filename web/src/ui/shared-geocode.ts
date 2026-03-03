/**
 * Shared Google Geocoding API utility for Map and Tiles tabs.
 * Extracts the common geocoding logic so both tabs can reuse it.
 */

const GEOCODE_API = 'https://maps.googleapis.com/maps/api/geocode/json';

export interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

/**
 * Geocode an address string using Google Maps Geocoding API.
 * Returns null if the address can't be resolved.
 */
export async function geocodeAddress(
  address: string,
  apiKey: string,
): Promise<GeocodeResult | null> {
  if (!apiKey) return null;
  const url = `${GEOCODE_API}?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results?.length) return null;
  const loc = data.results[0].geometry.location;
  return {
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress: data.results[0].formatted_address,
  };
}
