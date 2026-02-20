/**
 * Smarty US Property Data API client — fetches detailed construction and
 * amenity data from county assessor records via the US Address Enrichment API.
 *
 * Free tier: 250 lookups/month, no credit card required.
 * 350+ fields including exterior walls, roof cover, construction type,
 * foundation, pool, fireplace, fence, driveway, assessed value.
 *
 * Node/Bun-compatible — uses auth-id/auth-token query params for server-side.
 * Browser clients use embedded key via import-smarty.ts wrapper.
 *
 * API docs: https://www.smarty.com/docs/cloud/us-address-enrichment-api
 */

import type { BlockState } from '../../types/index.js';

const API_BASE = 'https://us-enrichment.api.smarty.com';
const MAX_RETRIES = 3;

/** Signup link for obtaining a free Smarty account */
export const SMARTY_SIGNUP_URL = 'https://www.smarty.com/account/create';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Property data returned from Smarty US Address Enrichment API */
export interface SmartyPropertyData {
  // Construction
  /** Exterior wall material: "Brick", "Wood Siding", "Stucco", "Vinyl", etc. */
  exteriorWalls: string;
  /** Roof covering material: "Asphalt/Composition", "Metal", "Tile", etc. */
  roofCover: string;
  /** Roof frame type: "Gable", "Hip", "Flat", etc. */
  roofFrame: string;
  /** Construction type: "Frame", "Masonry", "Concrete", etc. */
  constructionType: string;
  /** Foundation type: "Slab", "Crawl Space", "Basement", etc. */
  foundation: string;
  /** Architecture style: "Ranch", "Colonial", "Contemporary", etc. */
  structureStyle: string;
  // Size
  storiesNumber: number;
  buildingSqft: number;
  lotSqft: number;
  acres: number;
  bedrooms: number;
  bathroomsTotal: number;
  rooms: number;
  yearBuilt: number;
  // Amenities — direct from assessor records (more reliable than inference)
  hasGarage: boolean;
  garageSqft: number;
  hasPool: boolean;
  hasFireplace: boolean;
  fireplaceCount: number;
  hasFence: boolean;
  drivewayType: string;
  hasPorch: boolean;
  hasDeck: boolean;
  // HVAC
  airConditioner: string;
  heat: string;
  heatFuelType: string;
  // Valuation
  assessedValue: number;
  totalMarketValue: number;
  // Location
  latitude: number;
  longitude: number;
}

// ─── Raw API response ─────────────────────────────────────────────────────────

interface SmartyResponseItem {
  smarty_key?: string;
  data_set_name?: string;
  attributes?: Record<string, unknown>;
}

// ─── API Auth Management ──────────────────────────────────────────────────────

/** Get Smarty auth-id from environment (server-side only) */
export function getSmartyAuthId(): string {
  return (typeof process !== 'undefined' ? process.env?.SMARTY_AUTH_ID : '') ?? '';
}

/** Get Smarty auth-token from environment (server-side only) */
export function getSmartyAuthToken(): string {
  return (typeof process !== 'undefined' ? process.env?.SMARTY_AUTH_TOKEN : '') ?? '';
}

/** Check if server-side Smarty auth is configured */
export function hasSmartyAuth(): boolean {
  return getSmartyAuthId().length > 0 && getSmartyAuthToken().length > 0;
}

// ─── Property Search ──────────────────────────────────────────────────────────

/**
 * Search Smarty US Address Enrichment API for property data by freeform address.
 * Server-side: uses auth-id/auth-token query params.
 * Returns null if auth is missing, request fails, or no data found.
 */
export async function searchSmartyProperty(
  rawAddress: string,
  /** Optional embedded key for browser-side auth (overrides env vars) */
  embeddedKey?: string,
): Promise<SmartyPropertyData | null> {
  const address = rawAddress.trim();
  if (!address) return null;

  // Build auth query params
  let authParams: string;
  if (embeddedKey) {
    authParams = `key=${encodeURIComponent(embeddedKey)}`;
  } else {
    const authId = getSmartyAuthId();
    const authToken = getSmartyAuthToken();
    if (!authId || !authToken) return null;
    authParams = `auth-id=${encodeURIComponent(authId)}&auth-token=${encodeURIComponent(authToken)}`;
  }

  const url = `${API_BASE}/lookup/search/property?${authParams}&freeform=${encodeURIComponent(address)}`;

  const data = await fetchWithRetry<SmartyResponseItem[]>(url);
  if (!data || !Array.isArray(data) || data.length === 0) return null;

  const attrs = data[0].attributes;
  if (!attrs) return null;

  return mapAttributes(attrs);
}

// ─── Attribute Mapping ────────────────────────────────────────────────────────

/** Map raw Smarty attributes (snake_case) to SmartyPropertyData (camelCase) */
function mapAttributes(a: Record<string, unknown>): SmartyPropertyData {
  const str = (key: string) => String(a[key] ?? '');
  const num = (key: string) => Number(a[key]) || 0;
  const bool = (key: string) => {
    const v = a[key];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.toLowerCase() === 'yes' || v.toLowerCase() === 'true' || v.length > 0;
    return !!v;
  };

  return {
    // Construction
    exteriorWalls: str('exterior_walls'),
    roofCover: str('roof_cover'),
    roofFrame: str('roof_frame'),
    constructionType: str('construction_type'),
    foundation: str('foundation'),
    structureStyle: str('structure_style'),
    // Size
    storiesNumber: num('stories_number'),
    buildingSqft: num('building_sqft'),
    lotSqft: num('lot_sqft'),
    acres: num('acres'),
    bedrooms: num('bedrooms'),
    bathroomsTotal: num('bathrooms_total'),
    rooms: num('rooms'),
    yearBuilt: num('year_built'),
    // Amenities
    hasGarage: num('garage_sqft') > 0 || bool('garage'),
    garageSqft: num('garage_sqft'),
    hasPool: bool('pool'),
    hasFireplace: bool('fireplace') || num('fireplace_number') > 0,
    fireplaceCount: num('fireplace_number'),
    hasFence: bool('fence'),
    drivewayType: str('driveway_type'),
    hasPorch: bool('porch') || num('porch_area') > 0,
    hasDeck: bool('deck') || num('deck_area') > 0,
    // HVAC
    airConditioner: str('air_conditioner'),
    heat: str('heat'),
    heatFuelType: str('heat_fuel_type'),
    // Valuation
    assessedValue: num('assessed_value'),
    totalMarketValue: num('total_market_value'),
    // Location
    latitude: num('latitude'),
    longitude: num('longitude'),
  };
}

// ─── Exterior Material → Wall Block Mapping ──────────────────────────────────

/** Normalized exterior type keywords and their Minecraft block equivalents */
const EXTERIOR_MAP: { pattern: RegExp; block: BlockState }[] = [
  { pattern: /\bbrick/i, block: 'minecraft:bricks' },
  { pattern: /\bstone/i, block: 'minecraft:stone_bricks' },
  { pattern: /\bstucco/i, block: 'minecraft:white_concrete' },
  { pattern: /\bvinyl/i, block: 'minecraft:white_concrete' },
  { pattern: /\bcement|concrete|fiber/i, block: 'minecraft:white_concrete' },
  { pattern: /\bmetal|aluminum|steel/i, block: 'minecraft:iron_block' },
  { pattern: /\blog\b/i, block: 'minecraft:spruce_planks' },
  { pattern: /\bwood|siding/i, block: 'minecraft:oak_planks' },
  { pattern: /\badobe/i, block: 'minecraft:terracotta' },
  { pattern: /\bmasonry/i, block: 'minecraft:stone_bricks' },
];

/**
 * Map a Smarty exterior_walls string to a Minecraft wall block.
 * Returns undefined if the type is unknown or empty,
 * allowing the caller to fall through to satellite color detection.
 */
export function mapSmartyExteriorToWall(exteriorWalls: string): BlockState | undefined {
  if (!exteriorWalls) return undefined;

  for (const { pattern, block } of EXTERIOR_MAP) {
    if (pattern.test(exteriorWalls)) return block;
  }

  return undefined;
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
          console.warn(`Smarty API: HTTP ${resp.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.warn(`Smarty API: HTTP ${resp.status} after ${MAX_RETRIES} retries`);
        return null;
      }

      // Auth errors — don't retry
      if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
        console.warn(`Smarty API: auth error HTTP ${resp.status}`);
        return null;
      }

      if (!resp.ok) return null;

      return await resp.json() as T;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = (attempt + 1) * 2000;
        console.warn(`Smarty API: error, retry ${attempt + 1}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.warn('Smarty API request failed:', err);
      return null;
    }
  }
  return null;
}
