/**
 * Shared Google Geocoding API utility for Map and Tiles tabs.
 * Extracts the common geocoding logic so both tabs can reuse it.
 */

const GEOCODE_API = 'https://maps.googleapis.com/maps/api/geocode/json';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  /** Stable Google Place ID — bridge to Solar, Places, and other Google APIs */
  placeId: string;
  /** Geocode precision: ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE */
  locationType: string;
  /** Recommended display viewport (always present) */
  viewport: { ne: LatLng; sw: LatLng } | null;
  /** Actual geographic bounds of the result (optional — often absent for single addresses) */
  bounds: { ne: LatLng; sw: LatLng } | null;
}

/** Parse a Google Maps viewport/bounds object into our LatLng pair format */
function parseBounds(raw: { northeast?: { lat: number; lng: number }; southwest?: { lat: number; lng: number } } | undefined): { ne: LatLng; sw: LatLng } | null {
  if (!raw?.northeast || !raw?.southwest) return null;
  return {
    ne: { lat: raw.northeast.lat, lng: raw.northeast.lng },
    sw: { lat: raw.southwest.lat, lng: raw.southwest.lng },
  };
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
  const result = data.results[0];
  const loc = result.geometry.location;
  return {
    lat: loc.lat,
    lng: loc.lng,
    formattedAddress: result.formatted_address,
    placeId: result.place_id ?? '',
    locationType: result.geometry.location_type ?? 'APPROXIMATE',
    viewport: parseBounds(result.geometry.viewport),
    bounds: parseBounds(result.geometry.bounds),
  };
}
