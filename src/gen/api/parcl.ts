/**
 * Parcl Labs API client — fetch real property data from address.
 * Requires PARCL_API_KEY environment variable (free tier at https://app.parcllabs.com).
 *
 * Node/Bun-compatible — uses process.env instead of localStorage.
 */

const API_BASE = 'https://api.parcllabs.com';

/** Property data returned from Parcl Labs */
export interface ParclPropertyData {
  parclPropertyId: number;
  address: string;
  city: string;
  stateAbbreviation: string;
  zipCode: string;
  county: string;
  latitude: number;
  longitude: number;
  propertyType: string;
  bedrooms: number;
  bathrooms: number;
  squareFootage: number;
  yearBuilt: number;
  newConstruction: boolean;
  ownerOccupied: boolean;
  onMarket: boolean;
}

/** Get Parcl API key from PARCL_API_KEY environment variable */
export function getParclApiKey(): string {
  return process.env.PARCL_API_KEY ?? '';
}

/** Check if a Parcl API key is configured */
export function hasParclApiKey(): boolean {
  return getParclApiKey().length > 0;
}

/**
 * Parse a freeform address string into structured components.
 * Handles formats like "917 Pinecrest Ave SE, Grand Rapids, MI 49506"
 * or "917 Pinecrest Ave SE 49506".
 */
export function parseAddress(raw: string): {
  address: string;
  city: string;
  stateAbbreviation: string;
  zipCode: string;
} {
  const trimmed = raw.trim();

  // Try comma-separated: "street, city, state zip"
  const parts = trimmed.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    const street = parts[0];
    const cityPart = parts.length >= 3 ? parts[1] : '';
    const stateZipPart = parts[parts.length - 1];

    // Parse "MI 49506" or "MI" from last segment
    const stateZipMatch = stateZipPart.match(/^([A-Z]{2})\s*(\d{5})?$/i);
    if (stateZipMatch) {
      return {
        address: street,
        city: cityPart || '',
        stateAbbreviation: stateZipMatch[1].toUpperCase(),
        zipCode: stateZipMatch[2] || '',
      };
    }

    // "City, State ZIP" as last two parts
    if (parts.length >= 3) {
      const lastMatch = stateZipPart.match(/([A-Z]{2})\s+(\d{5})/i);
      if (lastMatch) {
        return {
          address: street,
          city: parts[1],
          stateAbbreviation: lastMatch[1].toUpperCase(),
          zipCode: lastMatch[2],
        };
      }
    }
  }

  // Fallback: extract zip from end, guess state before it
  const zipMatch = trimmed.match(/(\d{5})(?:\s*$)/);
  const zip = zipMatch?.[1] || '';
  const withoutZip = trimmed.replace(/\d{5}\s*$/, '').trim();

  // Try to find 2-letter state abbreviation
  const stateMatch = withoutZip.match(/\b([A-Z]{2})\s*$/i);
  const state = stateMatch?.[1]?.toUpperCase() || '';
  const withoutState = withoutZip.replace(/\b[A-Z]{2}\s*$/i, '').trim();

  // Remaining is either "street, city" or just "street"
  const commaIdx = withoutState.indexOf(',');
  if (commaIdx >= 0) {
    return {
      address: withoutState.slice(0, commaIdx).trim(),
      city: withoutState.slice(commaIdx + 1).trim(),
      stateAbbreviation: state,
      zipCode: zip,
    };
  }

  return {
    address: withoutState,
    city: '',
    stateAbbreviation: state,
    zipCode: zip,
  };
}

/**
 * Search Parcl Labs API for property data by address.
 * Returns null if API key is missing or request fails gracefully.
 */
export async function searchParclProperty(
  rawAddress: string,
): Promise<ParclPropertyData | null> {
  const apiKey = getParclApiKey();
  if (!apiKey) return null;

  const parsed = parseAddress(rawAddress);
  if (!parsed.address) return null;

  try {
    const resp = await fetch(`${API_BASE}/v1/property/search_address`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'Authorization': apiKey,
      },
      body: JSON.stringify([{
        address: parsed.address,
        city: parsed.city || undefined,
        state_abbreviation: parsed.stateAbbreviation || undefined,
        zip_code: parsed.zipCode || undefined,
      }]),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.warn('Parcl API: invalid or expired key');
      }
      return null;
    }

    const data: any = await resp.json();
    const items = data?.items;
    if (!Array.isArray(items) || items.length === 0) return null;

    const item = items[0];
    return {
      parclPropertyId: item.parcl_property_id ?? 0,
      address: item.address ?? '',
      city: item.city ?? '',
      stateAbbreviation: item.state_abbreviation ?? '',
      zipCode: item.zip_code ?? '',
      county: item.county ?? '',
      latitude: item.latitude ?? 0,
      longitude: item.longitude ?? 0,
      propertyType: item.property_type ?? '',
      bedrooms: item.bedrooms ?? 0,
      bathrooms: item.bathrooms ?? 0,
      squareFootage: item.square_footage ?? 0,
      yearBuilt: item.year_built ?? 0,
      newConstruction: item.current_new_construction_flag === 1,
      ownerOccupied: item.current_owner_occupied_flag === 1,
      onMarket: item.current_on_market_flag === 1,
    };
  } catch (err) {
    console.warn('Parcl API request failed:', err);
    return null;
  }
}

/**
 * Map Parcl property_type string to our property types.
 * Parcl returns: "SINGLE_FAMILY", "CONDO", "TOWNHOUSE", "MULTI_FAMILY", etc.
 */
export function mapParclPropertyType(parclType: string): string {
  const normalized = (parclType || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (normalized.includes('CONDO')) return 'condo';
  if (normalized.includes('TOWN')) return 'townhouse';
  if (normalized.includes('MULTI')) return 'condo'; // Multi-family → condo for generation
  return 'house';
}
