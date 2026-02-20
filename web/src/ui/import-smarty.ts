/**
 * Smarty browser-side wrapper — manages embedded key for the US Address
 * Enrichment API. The default embedded key is origin-restricted to
 * tribixbite.github.io and the owner's home IP.
 *
 * Users can override with their own key via localStorage.
 * Free tier: 250 lookups/month, no credit card.
 * Signup: https://www.smarty.com/account/create
 */

import type { BlockState } from '@craft/types/index.js';

export {
  type SmartyPropertyData,
  SMARTY_SIGNUP_URL,
  mapSmartyExteriorToWall,
} from '@craft/gen/api/smarty.js';
import { type SmartyPropertyData } from '@craft/gen/api/smarty.js';

/** Default embedded key — origin-restricted, safe to ship in client code */
const EMBEDDED_KEY = '262434684197927523';
const STORAGE_KEY = 'craftmatic_smarty_key';
const API_BASE = 'https://us-enrichment.api.smarty.com';

// ─── Key Management ─────────────────────────────────────────────────────────

/** Get the active Smarty key (user override or built-in embedded key) */
export function getSmartyKey(): string {
  return localStorage.getItem(STORAGE_KEY) || EMBEDDED_KEY;
}

/** Store a user-provided Smarty key override (empty string resets to embedded) */
export function setSmartyKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed && trimmed !== EMBEDDED_KEY) {
    localStorage.setItem(STORAGE_KEY, trimmed);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Always true — embedded key is always available */
export function hasSmartyKey(): boolean {
  return true;
}

/** Check if user has overridden the default embedded key */
export function hasCustomSmartyKey(): boolean {
  return !!localStorage.getItem(STORAGE_KEY);
}

// ─── Browser API Client ─────────────────────────────────────────────────────

/**
 * Search Smarty US Address Enrichment API for property data.
 * Uses embedded key auth (?key=...) for browser-side calls.
 * Returns null if request fails or no data found.
 */
export async function searchSmartyProperty(
  rawAddress: string,
): Promise<SmartyPropertyData | null> {
  const address = rawAddress.trim();
  if (!address) return null;

  const key = getSmartyKey();
  const url = `${API_BASE}/lookup/search/property?key=${encodeURIComponent(key)}&freeform=${encodeURIComponent(address)}`;

  try {
    const resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
        console.warn(`Smarty API: auth error HTTP ${resp.status}`);
      }
      return null;
    }

    const data: Array<{ attributes?: Record<string, unknown> }> = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const attrs = data[0].attributes;
    if (!attrs) return null;

    return mapBrowserAttributes(attrs);
  } catch (err) {
    console.warn('Smarty API request failed:', err);
    return null;
  }
}

// ─── Attribute Mapping (duplicated from Node client to avoid import issues) ──

/** Map raw Smarty attributes to SmartyPropertyData */
function mapBrowserAttributes(a: Record<string, unknown>): SmartyPropertyData {
  const str = (key: string) => String(a[key] ?? '');
  const num = (key: string) => Number(a[key]) || 0;
  const bool = (key: string) => {
    const v = a[key];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'no' || s === 'false' || s === '0' || s === 'none' || s === 'n') return false;
      return s === 'yes' || s === 'true' || s.length > 0;
    }
    return !!v;
  };

  return {
    exteriorWalls: str('exterior_walls'),
    roofCover: str('roof_cover'),
    roofFrame: str('roof_frame'),
    constructionType: str('construction_type'),
    foundation: str('foundation'),
    structureStyle: str('structure_style'),
    storiesNumber: num('stories_number'),
    buildingSqft: num('building_sqft'),
    lotSqft: num('lot_sqft'),
    acres: num('acres'),
    bedrooms: num('bedrooms'),
    bathroomsTotal: num('bathrooms_total'),
    rooms: num('rooms'),
    yearBuilt: num('year_built'),
    hasGarage: num('garage_sqft') > 0 || bool('garage'),
    garageSqft: num('garage_sqft'),
    hasPool: bool('pool'),
    hasFireplace: bool('fireplace') || num('fireplace_number') > 0,
    fireplaceCount: num('fireplace_number'),
    hasFence: bool('fence'),
    drivewayType: str('driveway_type'),
    hasPorch: bool('porch') || num('porch_area') > 0,
    hasDeck: bool('deck') || num('deck_area') > 0,
    airConditioner: str('air_conditioner'),
    heat: str('heat'),
    heatFuelType: str('heat_fuel_type'),
    assessedValue: num('assessed_value'),
    totalMarketValue: num('total_market_value'),
    latitude: num('latitude'),
    longitude: num('longitude'),
  };
}
