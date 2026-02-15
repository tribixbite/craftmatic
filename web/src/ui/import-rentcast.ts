/**
 * RentCast API integration — fetch detailed property data including
 * floor count, lot size, exterior material, roof type, and architecture.
 * Requires X-Api-Key header (free tier: 50 calls/month).
 * Key is stored in localStorage for persistence across sessions.
 *
 * RentCast provides county assessor data which is more detailed than
 * Parcl Labs for physical building attributes.
 */

import type { BlockState } from '@craft/types/index.js';

const STORAGE_KEY = 'craftmatic_rentcast_api_key';
const API_BASE = 'https://api.rentcast.io/v1';

/** Property data returned from RentCast API */
export interface RentCastPropertyData {
  floorCount: number;
  lotSize: number;            // sqft
  squareFootage: number;
  exteriorType: string;       // "Brick", "Wood", "Stucco", "Vinyl Siding", etc.
  roofType: string;           // "Asphalt", "Metal", "Tile", etc.
  architectureType: string;   // "Contemporary", "Ranch", "Colonial", etc.
  bedrooms: number;
  bathrooms: number;
  yearBuilt: number;
  propertyType: string;
}

// ─── API Key Management ──────────────────────────────────────────────────────

/** Get stored RentCast API key from localStorage */
export function getRentCastApiKey(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}

/** Store RentCast API key in localStorage */
export function setRentCastApiKey(key: string): void {
  if (key.trim()) {
    localStorage.setItem(STORAGE_KEY, key.trim());
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Check if a RentCast API key is configured */
export function hasRentCastApiKey(): boolean {
  return getRentCastApiKey().length > 0;
}

// ─── API Client ──────────────────────────────────────────────────────────────

/**
 * Search RentCast API for property data by address.
 * Uses GET /v1/properties?address=... with X-Api-Key header.
 * Returns null if API key is missing, request fails, or CORS blocks the call.
 */
export async function searchRentCastProperty(
  rawAddress: string,
): Promise<RentCastPropertyData | null> {
  const apiKey = getRentCastApiKey();
  if (!apiKey) return null;

  const address = rawAddress.trim();
  if (!address) return null;

  try {
    const url = `${API_BASE}/properties?address=${encodeURIComponent(address)}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'X-Api-Key': apiKey,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.warn('RentCast API: invalid or expired key');
      }
      return null;
    }

    const data = await resp.json();

    // RentCast returns an array of matching properties
    const items = Array.isArray(data) ? data : [data];
    if (items.length === 0) return null;

    const item = items[0];
    const features = item.features ?? {};

    return {
      floorCount: features.floorCount ?? item.floorCount ?? 0,
      lotSize: item.lotSize ?? 0,
      squareFootage: item.squareFootage ?? 0,
      exteriorType: features.exteriorType ?? '',
      roofType: features.roofType ?? '',
      architectureType: features.architectureType ?? '',
      bedrooms: item.bedrooms ?? 0,
      bathrooms: item.bathrooms ?? 0,
      yearBuilt: item.yearBuilt ?? 0,
      propertyType: item.propertyType ?? '',
    };
  } catch (err) {
    // CORS, network, or timeout — fall back to manual entry silently
    console.warn('RentCast API request failed:', err);
    return null;
  }
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
];

/**
 * Map a RentCast exterior type string to a Minecraft wall block.
 * Returns undefined if the exterior type is unknown or empty,
 * allowing the caller to fall through to satellite color detection.
 */
export function mapExteriorToWall(exteriorType: string): BlockState | undefined {
  if (!exteriorType) return undefined;

  for (const { pattern, block } of EXTERIOR_MAP) {
    if (pattern.test(exteriorType)) return block;
  }

  return undefined;
}
