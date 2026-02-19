/**
 * Import tab — address-to-structure generation.
 * Takes a real estate address, geocodes it, fetches property data via Parcl Labs API,
 * shows satellite imagery with seasonal weather overlay, accepts property details,
 * and generates a Minecraft structure.
 */

import type { StructureType, StyleName, RoomType, BlockState, RoofShape, FeatureFlags, FloorPlanShape } from '@craft/types/index.js';
import type { GenerationOptions } from '@craft/types/index.js';
import { generateStructure } from '@craft/gen/generator.js';
import { BlockGrid } from '@craft/schem/types.js';
import { geocodeAddress, type GeocodingResult } from '@ui/import-geocoder.js';
import { composeSatelliteView, type SeasonalWeather } from '@ui/import-satellite.js';
import { analyzeFloorPlan, type FloorPlanAnalysis } from '@ui/import-floorplan.js';
import {
  searchParclProperty, getParclApiKey, setParclApiKey, hasParclApiKey,
  mapParclPropertyType, type ParclPropertyData,
} from '@ui/import-parcl.js';
import {
  searchRentCastProperty, getRentCastApiKey, setRentCastApiKey, hasRentCastApiKey,
  mapExteriorToWall, type RentCastPropertyData,
} from '@ui/import-rentcast.js';
import { extractBuildingColor, mapColorToWall, detectPool } from '@ui/import-color.js';
import {
  searchOSMBuilding, mapOSMMaterialToWall, mapOSMRoofShape,
  analyzePolygonShape, type OSMBuildingData,
} from '@ui/import-osm.js';
import {
  getStreetViewApiKey, setStreetViewApiKey, hasStreetViewApiKey,
  getStreetViewUrl, checkStreetViewAvailability, STREETVIEW_SIGNUP_URL,
} from '@ui/import-streetview.js';
import {
  getMapboxToken, setMapboxToken, hasMapboxToken,
  createMapboxTileFetcher, MAPBOX_SIGNUP_URL,
} from '@ui/import-mapbox.js';

// ─── Storage Keys ───────────────────────────────────────────────────────────

const SESSION_PREFIX = 'craftmatic_import_';

/** Save a form value to sessionStorage */
function saveField(key: string, value: string): void {
  try { sessionStorage.setItem(SESSION_PREFIX + key, value); } catch { /* quota */ }
}

/** Load a form value from sessionStorage */
function loadField(key: string): string {
  try { return sessionStorage.getItem(SESSION_PREFIX + key) ?? ''; } catch { return ''; }
}

// ─── Types & Constants ──────────────────────────────────────────────────────

/** Property data collected from the form */
export interface PropertyData {
  address: string;
  stories: number;
  sqft: number;
  bedrooms: number;
  bathrooms: number;
  yearBuilt: number;
  propertyType: string;
  style: StyleName | 'auto';
  floorPlan?: FloorPlanAnalysis;
  geocoding?: GeocodingResult;
  season?: SeasonalWeather;
  newConstruction?: boolean;
  /** Lot size in sqft (from RentCast) */
  lotSize?: number;
  /** Exterior material description (from RentCast) */
  exteriorType?: string;
  /** Wall block override derived from exterior type or satellite color */
  wallOverride?: BlockState;
  /** Roof material description (from RentCast) */
  roofType?: string;
  /** Architecture style description (from RentCast) */
  architectureType?: string;
  /** Detected building color RGB from satellite imagery */
  detectedColor?: { r: number; g: number; b: number };
  /** Building footprint width from OSM (in blocks, 1 block ≈ 1m) */
  osmWidth?: number;
  /** Building footprint length from OSM (in blocks) */
  osmLength?: number;
  /** OSM building levels if available */
  osmLevels?: number;
  /** OSM building material */
  osmMaterial?: string;
  /** OSM roof shape (normalized label) */
  osmRoofShape?: string;
  /** OSM roof material tag (e.g. 'tile', 'slate', 'metal') */
  osmRoofMaterial?: string;
  /** OSM roof colour as hex string */
  osmRoofColour?: string;
  /** OSM building colour as hex string */
  osmBuildingColour?: string;
  /** OSM building:architecture tag (e.g. 'victorian', 'colonial', 'art_deco') */
  osmArchitecture?: string;
  /** Whether property has a garage (from RentCast or inference) */
  hasGarage?: boolean;
  /** Swimming pool detected in satellite imagery */
  hasPool?: boolean;
  /** Floor plan shape derived from OSM polygon analysis */
  floorPlanShape?: FloorPlanShape;
  /** Street View image URL */
  streetViewUrl?: string;
  /** County name (from Parcl Labs) — used for regional style hints */
  county?: string;
  /** State abbreviation (from Parcl Labs) — used for climate-aware features */
  stateAbbreviation?: string;
  /** City name (from Parcl Labs) — used for city-level style hints and display */
  city?: string;
  /** ZIP code (from Parcl Labs) — used for density inference and display */
  zipCode?: string;
  /** Owner-occupied flag (from Parcl Labs) — modifies feature density */
  ownerOccupied?: boolean;
  /** Currently on market (from Parcl Labs) — on-market homes generate neater/staged */
  onMarket?: boolean;
  /** Parcl property ID — contributes to deterministic seed */
  parclPropertyId?: number;
}

/** Style presets with colors — "Auto" infers from year built */
const STYLE_PRESETS: { value: StyleName | 'auto'; label: string; color: string }[] = [
  { value: 'auto', label: 'Auto', color: '#8888a8' },
  { value: 'fantasy', label: 'Fantasy', color: '#b19cd9' },
  { value: 'medieval', label: 'Medieval', color: '#c9a96e' },
  { value: 'modern', label: 'Modern', color: '#87ceeb' },
  { value: 'gothic', label: 'Gothic', color: '#cc4444' },
  { value: 'rustic', label: 'Rustic', color: '#8b7355' },
  { value: 'steampunk', label: 'Steampunk', color: '#cd7f32' },
  { value: 'elven', label: 'Elven', color: '#7cbb5f' },
  { value: 'desert', label: 'Desert', color: '#deb887' },
  { value: 'underwater', label: 'Underwater', color: '#5f9ea0' },
];

/** Season display labels with emoji-free descriptors */
const SEASON_LABELS: Record<SeasonalWeather, string> = {
  snow: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  fall: 'Autumn',
};

// ─── Core Logic ─────────────────────────────────────────────────────────────

/** FNV-1a hash for deterministic seed from address string */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 999999;
}

/** Infer architectural style from year built + new construction flag */
function inferStyle(year: number, newConstruction = false): StyleName {
  if (newConstruction || year >= 2010) return 'modern';
  if (year < 1700) return 'medieval';
  if (year < 1850) return 'gothic';
  if (year < 1920) return 'rustic';
  if (year < 1970) return 'fantasy';
  return 'modern';
}

/**
 * Map OSM building:architecture or RentCast architectureType to StyleName.
 * Returns undefined if no mapping is found (will fall back to year-based inference).
 */
function mapArchitectureToStyle(arch: string | undefined): StyleName | undefined {
  if (!arch) return undefined;
  const a = arch.trim().toLowerCase();
  const MAP: [RegExp, StyleName][] = [
    [/\bvictorian|queen\s*anne|second\s*empire/i, 'gothic'],
    [/\bcraftsman|arts?\s*&?\s*crafts|bungalow/i, 'rustic'],
    [/\bcolonial|georgian|federal|cape\s*cod/i, 'fantasy'],
    [/\bmodern|contemporary|mid.?century|minimalist|international/i, 'modern'],
    [/\bmediterranean|spanish|mission|pueblo/i, 'desert'],
    [/\btudor|half.?timber|english/i, 'medieval'],
    [/\bart\s*deco|art\s*nouveau|beaux.?arts/i, 'steampunk'],
    [/\bjapanese|asian|zen/i, 'elven'],
    [/\bgothic|romanesque|revival/i, 'gothic'],
    [/\bfarmhouse|ranch|country/i, 'rustic'],
    [/\bcastle|chateau|palatial|manor/i, 'fantasy'],
  ];
  for (const [pattern, style] of MAP) {
    if (pattern.test(a)) return style;
  }
  return undefined;
}

/**
 * Infer architectural style from county name for pre-1980 homes.
 * Maps historically distinctive regions to likely architectural styles.
 * Returns undefined for unknown counties (falls through to year-based inference).
 */
function inferStyleFromCounty(county: string | undefined, year: number): StyleName | undefined {
  if (!county || year >= 1980) return undefined; // Only for older homes
  const c = county.toLowerCase();
  // Victorian/Gothic prevalence areas
  if (/\bsan\s*francisco|alameda|marin/.test(c)) return 'gothic';
  // Mediterranean/Desert style regions
  if (/\bmiami.?dade|palm\s*beach|broward/.test(c)) return 'desert';
  // Tudor/Medieval style areas
  if (/\bwestchester|dutchess|suffolk/.test(c) && year < 1940) return 'medieval';
  // Art Deco / Steampunk — industrial-era cities
  if (/\bcook|wayne|allegheny/.test(c) && year >= 1900 && year < 1940) return 'steampunk';
  // Colonial/Fantasy — East Coast historic
  if (/\bfairfax|arlington|montgomery/.test(c) && year < 1900) return 'fantasy';
  // Spanish Colonial / Desert — Southwest
  if (/\bmaricopa|pima|bernalillo|clark/.test(c)) return 'desert';
  // Prairie/Rustic — Midwest
  if (/\bhennepin|ramsey|dane|milwaukee/.test(c) && year < 1950) return 'rustic';
  return undefined;
}

/**
 * Infer architectural style from city name for pre-1980 homes.
 * More specific than county — targets cities with extremely distinctive architecture.
 * Returns undefined for unknown cities (falls through to county > year-based).
 */
function inferStyleFromCity(city: string | undefined, year: number): StyleName | undefined {
  if (!city || year >= 1980) return undefined;
  const c = city.toLowerCase().trim();
  // Santa Fe — adobe/pueblo style
  if (/^santa\s*fe$/i.test(c)) return 'desert';
  // New Orleans — French/Creole ironwork (maps to gothic for ornamental detail)
  if (/^new\s*orleans$/i.test(c) && year < 1940) return 'gothic';
  // Savannah — antebellum/colonial
  if (/^savannah$/i.test(c) && year < 1900) return 'fantasy';
  // Charleston — Georgian/Federal
  if (/^charleston$/i.test(c) && year < 1900) return 'fantasy';
  // Key West — Caribbean/tropical timber
  if (/^key\s*west$/i.test(c)) return 'rustic';
  // Portland/Seattle — craftsman prevalence
  if (/^portland|^seattle$/i.test(c) && year < 1950) return 'rustic';
  return undefined;
}

/**
 * Infer neighborhood density from ZIP code.
 * Urban core ZIP codes (low ranges, dense areas) get smaller lots and less yard.
 * Returns 'urban' | 'suburban' | 'rural' — used for feature flag tuning.
 */
function inferDensityFromZip(zip: string | undefined): 'urban' | 'suburban' | 'rural' {
  if (!zip || zip.length !== 5) return 'suburban';
  // First 3 digits = sectional center facility (SCF) — rough density proxy
  const scf = parseInt(zip.substring(0, 3));
  if (isNaN(scf)) return 'suburban';
  // Dense urban cores: Manhattan (100-102), Chicago loop (606), SF (941), Boston (021)
  // These ZIP prefixes correlate with walkable, high-density neighborhoods
  const URBAN_SCFS = [100, 101, 102, 103, 104, 111, 112, 606, 941, 21, 22, 200, 201, 900, 901];
  if (URBAN_SCFS.includes(scf)) return 'urban';
  // Very low population density indicators — rural western states
  const RURAL_SCFS = [590, 591, 592, 593, 820, 821, 822, 823, 824, 830, 831, 832, 833, 838, 840];
  if (RURAL_SCFS.includes(scf)) return 'rural';
  return 'suburban';
}

/**
 * Infer climate zone from state abbreviation.
 * Returns a simplified climate hint used for feature flag tuning.
 */
function inferClimateZone(state: string | undefined): 'cold' | 'hot' | 'temperate' {
  if (!state) return 'temperate';
  const s = state.toUpperCase();
  // Cold-climate states — more chimney likelihood, steeper roofs
  if (['MN', 'WI', 'MI', 'ND', 'SD', 'MT', 'VT', 'NH', 'ME', 'AK', 'WY'].includes(s)) return 'cold';
  // Hot-climate states — pool more likely, flat roofs, less chimney
  if (['FL', 'AZ', 'NV', 'HI', 'TX', 'NM', 'LA', 'MS', 'AL'].includes(s)) return 'hot';
  return 'temperate';
}

/**
 * Map OSM roof:shape tag to generator RoofShape.
 * Normalizes the various OSM values to one of our 5 supported roof shapes.
 */
function mapOSMRoofToShape(osmRoofShape: string | undefined): RoofShape | undefined {
  if (!osmRoofShape) return undefined;
  const s = osmRoofShape.trim().toLowerCase();
  const MAP: Record<string, RoofShape> = {
    gabled: 'gable', gable: 'gable', saltbox: 'gable', sawtooth: 'gable',
    hipped: 'hip', hip: 'hip', half_hipped: 'hip', 'half-hipped': 'hip', pyramidal: 'hip',
    flat: 'flat', skillion: 'flat',
    gambrel: 'gambrel',
    mansard: 'mansard',
  };
  return MAP[s];
}

/**
 * Map OSM roof:material to Minecraft stair/slab blocks for roof overrides.
 * Returns {north, south, cap} override or undefined if unmapped.
 */
function mapRoofMaterialToBlocks(
  material: string | undefined, colour: string | undefined
): { north: BlockState; south: BlockState; cap: BlockState } | undefined {
  if (!material && !colour) return undefined;

  // Material-based mapping (priority 1)
  if (material) {
    const m = material.trim().toLowerCase();
    const ROOF_MAP: [RegExp, { base: string; slab: string }][] = [
      [/\bslate/i, { base: 'minecraft:deepslate_tile', slab: 'minecraft:deepslate_tile_slab' }],
      [/\btile|clay|terracotta/i, { base: 'minecraft:brick', slab: 'minecraft:brick_slab' }],
      [/\bmetal|steel|tin|copper/i, { base: 'minecraft:cut_copper', slab: 'minecraft:cut_copper_slab' }],
      [/\bwood|shingle|shake/i, { base: 'minecraft:spruce', slab: 'minecraft:spruce_slab' }],
      [/\basphalt|tar|bitumen/i, { base: 'minecraft:blackstone', slab: 'minecraft:blackstone_slab' }],
      [/\bconcrete|cement/i, { base: 'minecraft:smooth_stone', slab: 'minecraft:smooth_stone_slab' }],
      [/\bthatch|reed|straw/i, { base: 'minecraft:oak', slab: 'minecraft:oak_slab' }],
    ];
    for (const [pattern, { base, slab }] of ROOF_MAP) {
      if (pattern.test(m)) {
        return {
          north: `${base}_stairs[facing=north]`,
          south: `${base}_stairs[facing=south]`,
          cap: `${slab}[type=bottom]`,
        };
      }
    }
  }

  // Colour-based mapping fallback (priority 2) — match hex to nearest terracotta
  if (colour) {
    const roofBlock = hexToRoofBlock(colour);
    if (roofBlock) {
      return {
        north: `minecraft:${roofBlock}_stairs[facing=north]`,
        south: `minecraft:${roofBlock}_stairs[facing=south]`,
        cap: `minecraft:${roofBlock}_slab[type=bottom]`,
      };
    }
  }

  return undefined;
}

/** Map a hex colour to the nearest Minecraft block with stair/slab variants for roofs */
function hexToRoofBlock(hex: string): string | undefined {
  // Parse hex to RGB
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return undefined;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);

  // Candidate roof blocks with representative RGB values
  const CANDIDATES: [string, number, number, number][] = [
    ['dark_oak', 60, 42, 22],       // dark brown
    ['spruce', 115, 85, 49],        // warm brown
    ['brick', 150, 74, 58],         // red/terracotta
    ['stone_brick', 128, 128, 128], // gray
    ['sandstone', 216, 200, 157],   // cream/tan
    ['cobblestone', 100, 100, 100], // dark gray
    ['deepslate_tile', 54, 54, 62], // charcoal
    ['blackstone', 34, 28, 32],     // near-black
    ['prismarine', 76, 127, 115],   // blue-green
    ['nether_brick', 44, 21, 26],   // dark red
  ];

  let bestBlock = 'dark_oak';
  let bestDist = Infinity;
  for (const [block, cr, cg, cb] of CANDIDATES) {
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestBlock = block;
    }
  }
  return bestBlock;
}

/**
 * Infer door wood type from architecture style or era.
 * Returns a Minecraft wood type string for doorOverride.
 */
function inferDoorType(
  archType: string | undefined, style: StyleName, year: number
): string | undefined {
  // Architecture-specific door overrides
  if (archType) {
    const a = archType.toLowerCase();
    if (/modern|contemporary|minimalist/.test(a)) return 'iron';
    if (/tudor|english|medieval/.test(a)) return 'dark_oak';
    if (/craftsman|arts.*crafts|rustic/.test(a)) return 'spruce';
    if (/victorian|colonial|georgian/.test(a)) return 'dark_oak';
    if (/farmhouse|ranch|country/.test(a)) return 'oak';
    if (/mediterranean|spanish|mission/.test(a)) return 'acacia';
  }

  // Style fallbacks
  const STYLE_DOORS: Partial<Record<StyleName, string>> = {
    modern: 'iron',
    gothic: 'dark_oak',
    rustic: 'spruce',
    medieval: 'oak',
    desert: 'acacia',
    elven: 'birch',
    steampunk: 'iron',
  };
  if (STYLE_DOORS[style]) return STYLE_DOORS[style];

  // Era-based fallback
  if (year >= 2000) return 'iron';
  if (year < 1900) return 'dark_oak';
  return undefined;
}

/**
 * Map a building colour hex to a Minecraft trim/accent block.
 * Used for trimOverride when OSM building:colour is available.
 */
function hexToTrimBlock(hex: string): BlockState | undefined {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return undefined;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);

  // Map to accent blocks (pillars, timber, trim)
  const CANDIDATES: [BlockState, number, number, number][] = [
    ['minecraft:white_concrete', 255, 255, 255],
    ['minecraft:light_gray_concrete', 160, 160, 160],
    ['minecraft:dark_oak_log', 60, 42, 22],
    ['minecraft:spruce_log', 115, 85, 49],
    ['minecraft:oak_log', 170, 136, 78],
    ['minecraft:birch_log', 196, 187, 153],
    ['minecraft:quartz_pillar', 235, 229, 222],
    ['minecraft:sandstone', 216, 200, 157],
    ['minecraft:stone_bricks', 128, 128, 128],
    ['minecraft:deepslate_bricks', 54, 54, 62],
  ];

  let bestBlock: BlockState = 'minecraft:dark_oak_log';
  let bestDist = Infinity;
  for (const [block, cr, cg, cb] of CANDIDATES) {
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestBlock = block;
    }
  }
  return bestBlock;
}

/**
 * Infer feature flags from property data.
 * Uses lot size, sqft, property type, and year to determine which
 * exterior features should be generated.
 */
function inferFeatures(prop: PropertyData): FeatureFlags {
  const lotSize = prop.lotSize ?? 0;
  const sqft = prop.sqft;
  const year = prop.yearBuilt;
  const climate = inferClimateZone(prop.stateAbbreviation);
  const density = inferDensityFromZip(prop.zipCode);
  // Owner-occupied homes tend to have more residential features (gardens, porches)
  const residential = prop.ownerOccupied !== false; // Default to true if unknown
  // On-market homes are staged/maintained — boost garden and landscaping
  const staged = prop.onMarket === true;

  return {
    // Chimney: common in older houses, cold climates boost likelihood
    chimney: (year < 1990 || sqft > 3000) && climate !== 'hot',
    // Porch: most owner-occupied homes; urban condos less likely
    porch: residential && density !== 'urban',
    // Backyard: needs lot size > 4000 sqft (or assume true if no lot data); urban skips
    backyard: density !== 'urban' && (lotSize === 0 || lotSize > 4000),
    // Driveway: suburban/rural — urban properties typically don't have driveways
    driveway: density !== 'urban',
    // Fence: larger properties or older neighborhoods
    fence: lotSize > 3000 || sqft > 2500,
    // Trees: suburban lots with space; on-market homes get extra landscaping
    trees: (lotSize === 0 || lotSize > 3000) || staged,
    // Garden: owner-occupied or staged homes on larger lots or older houses
    garden: (residential || staged) && (lotSize > 5000 || (year < 1960 && sqft > 2000) || staged),
    // Pool: satellite detection; hot climates lower threshold for lot-size inference
    pool: prop.hasPool ?? (climate === 'hot' && lotSize > 6000),
  };
}

/** Convert property data into GenerationOptions for the core generator */
export function convertToGenerationOptions(prop: PropertyData): GenerationOptions {
  // ── Style resolution ──────────────────────────────────────────────
  // Priority: user selection > OSM architecture > RentCast architecture > city hint > county hint > year-based
  let style: StyleName;
  if (prop.style !== 'auto') {
    style = prop.style;
  } else {
    const archStyle = mapArchitectureToStyle(prop.osmArchitecture)
      ?? mapArchitectureToStyle(prop.architectureType);
    const cityStyle = inferStyleFromCity(prop.city, prop.yearBuilt);
    const countyStyle = inferStyleFromCounty(prop.county, prop.yearBuilt);
    style = archStyle ?? cityStyle ?? countyStyle ?? inferStyle(prop.yearBuilt, prop.newConstruction);
  }

  // Force rustic for cabin property type
  if (prop.propertyType === 'cabin') style = 'rustic';

  // ── Structure type ────────────────────────────────────────────────
  let type: StructureType = 'house';
  if (prop.propertyType === 'mansion' || prop.sqft > 5000) {
    type = 'castle';
  }

  // ── Dimensions ────────────────────────────────────────────────────
  // Priority: OSM footprint (real) > sqft estimate
  let width: number;
  let length: number;

  if (prop.osmWidth && prop.osmLength) {
    width = prop.osmWidth;
    length = prop.osmLength;
  } else {
    const areaPerFloor = prop.sqft / prop.stories / 10.76;
    const aspectRatio = prop.floorPlan?.aspectRatio ?? 1.3;
    width = Math.round(Math.sqrt(areaPerFloor * aspectRatio));
    length = Math.round(Math.sqrt(areaPerFloor / aspectRatio));
  }
  width = Math.max(10, Math.min(60, width));
  length = Math.max(10, Math.min(60, length));

  // ── Rooms ─────────────────────────────────────────────────────────
  const rooms: RoomType[] = ['foyer', 'living', 'kitchen', 'dining'];
  for (let i = 0; i < Math.min(prop.bedrooms, 8); i++) rooms.push('bedroom');
  for (let i = 0; i < Math.min(prop.bathrooms, 6); i++) rooms.push('bathroom');

  if (prop.sqft > 2500) rooms.push('study', 'laundry', 'mudroom');
  if (prop.sqft > 3500) rooms.push('library', 'sunroom', 'pantry');

  // Auto-add garage if property data indicates one
  if (prop.hasGarage) rooms.push('garage');

  // ── Roof shape ────────────────────────────────────────────────────
  // Priority: OSM roof:shape > style-default > gable
  const roofShape: RoofShape = mapOSMRoofToShape(prop.osmRoofShape)
    ?? (style === 'modern' ? 'flat' : style === 'gothic' ? 'mansard' : 'gable');

  // ── Roof material override ────────────────────────────────────────
  const roofOverride = mapRoofMaterialToBlocks(prop.osmRoofMaterial, prop.osmRoofColour);

  // ── Door override ─────────────────────────────────────────────────
  const doorOverride = inferDoorType(
    prop.osmArchitecture ?? prop.architectureType,
    style,
    prop.yearBuilt
  );

  // ── Trim override ─────────────────────────────────────────────────
  // Priority: OSM building:colour > none (use style default)
  const trimOverride = prop.osmBuildingColour
    ? hexToTrimBlock(prop.osmBuildingColour)
    : undefined;

  // ── Feature flags ─────────────────────────────────────────────────
  const features = inferFeatures(prop);

  return {
    type,
    floors: prop.stories,
    style,
    rooms,
    width,
    length,
    // Include parclPropertyId in seed for better per-property reproducibility
    seed: fnv1aHash(prop.address + (prop.parclPropertyId ? `#${prop.parclPropertyId}` : '')),
    wallOverride: prop.wallOverride,
    trimOverride,
    doorOverride,
    roofShape,
    roofOverride,
    features,
    floorPlanShape: prop.floorPlanShape,
  };
}

// ─── UI ─────────────────────────────────────────────────────────────────────

/** Initialize the import tab UI */
export function initImport(
  controls: HTMLElement,
  viewer: HTMLElement,
  onGenerate: (grid: BlockGrid, property: PropertyData) => void,
): void {
  let selectedStyle: StyleName | 'auto' = (loadField('style') as StyleName | 'auto') || 'auto';
  let currentFloorPlan: FloorPlanAnalysis | null = null;
  let currentGeocoding: GeocodingResult | null = null;
  let currentSeason: SeasonalWeather | undefined;
  /** Wall override from RentCast exterior type, OSM material, or satellite color */
  let currentWallOverride: BlockState | undefined;
  /** Detected satellite building color RGB */
  let currentDetectedColor: { r: number; g: number; b: number } | undefined;
  /** RentCast enrichment data */
  let currentRentCast: RentCastPropertyData | null = null;
  /** OSM building footprint data */
  let currentOSM: OSMBuildingData | null = null;
  /** Whether a pool was detected from satellite imagery */
  let currentPoolDetected = false;
  /** Street View image URL (if available) */
  let currentStreetViewUrl: string | null = null;
  /** Parcl Labs property data — stored for generation-time access */
  let currentParcl: ParclPropertyData | null = null;

  // Restore API key display state
  const savedParclKey = getParclApiKey();
  const parclKeyMasked = savedParclKey ? '••••' + savedParclKey.slice(-4) : '';
  const savedRentCastKey = getRentCastApiKey();
  const rentCastKeyMasked = savedRentCastKey ? '••••' + savedRentCastKey.slice(-4) : '';
  const savedStreetViewKey = getStreetViewApiKey();
  const svKeyMasked = savedStreetViewKey ? '••••' + savedStreetViewKey.slice(-4) : '';
  const savedMapboxToken = getMapboxToken();
  const mbTokenMasked = savedMapboxToken ? '••••' + savedMapboxToken.slice(-4) : '';

  controls.innerHTML = `
    <div class="section-title">Import from Address</div>

    <!-- API keys (collapsible, defaults closed — expand via button) -->
    <details class="customize-section" id="import-api-section">
      <summary class="customize-summary">API Keys
        <span class="import-api-badge" id="import-api-badge">${
          [savedParclKey, savedRentCastKey, savedStreetViewKey, savedMapboxToken].filter(Boolean).length
        }/4</span>
      </summary>
      <div class="customize-body import-api-list">
        <!-- Parcl Labs key -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>Parcl Labs</strong>
            <span class="import-api-desc">beds, baths, sqft, year</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-parcl-key" type="password" class="form-input import-api-key-input"
              placeholder="Paste API key" value="${escapeAttr(savedParclKey)}">
            <button id="import-parcl-save" class="btn btn-secondary btn-sm">${savedParclKey ? 'Saved' : 'Save'}</button>
            <a href="https://app.parcllabs.com" target="_blank" rel="noopener"
              class="import-api-link" title="Get free key">Get key</a>
          </div>
          <div id="import-parcl-status" class="import-api-status">
            ${parclKeyMasked ? `Key stored: ${parclKeyMasked}` : 'No key — manual entry only'}
          </div>
        </div>
        <!-- RentCast key -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>RentCast</strong>
            <span class="import-api-desc">floors, lot size, exterior, roof</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-rentcast-key" type="password" class="form-input import-api-key-input"
              placeholder="Paste API key" value="${escapeAttr(savedRentCastKey)}">
            <button id="import-rentcast-save" class="btn btn-secondary btn-sm">${savedRentCastKey ? 'Saved' : 'Save'}</button>
            <a href="https://app.rentcast.io" target="_blank" rel="noopener"
              class="import-api-link" title="Get free key">Get key</a>
          </div>
          <div id="import-rentcast-status" class="import-api-status">
            ${rentCastKeyMasked ? `Key stored: ${rentCastKeyMasked}` : 'No key — satellite color used instead'}
          </div>
        </div>
        <!-- Google Street View key -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>Street View</strong>
            <span class="import-api-desc">exterior property photo</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-sv-key" type="password" class="form-input import-api-key-input"
              placeholder="Paste API key" value="${escapeAttr(savedStreetViewKey)}">
            <button id="import-sv-save" class="btn btn-secondary btn-sm">${savedStreetViewKey ? 'Saved' : 'Save'}</button>
            <a href="${STREETVIEW_SIGNUP_URL}" target="_blank" rel="noopener"
              class="import-api-link" title="Get free key">Get key</a>
          </div>
          <div id="import-sv-status" class="import-api-status">
            ${svKeyMasked ? `Key stored: ${svKeyMasked}` : 'No key — no exterior photo'}
          </div>
        </div>
        <!-- Mapbox token -->
        <div class="import-api-row">
          <div class="import-api-label">
            <strong>Mapbox</strong>
            <span class="import-api-desc">high-res satellite (30cm)</span>
          </div>
          <div class="import-api-input-row">
            <input id="import-mb-token" type="password" class="form-input import-api-key-input"
              placeholder="Paste access token" value="${escapeAttr(savedMapboxToken)}">
            <button id="import-mb-save" class="btn btn-secondary btn-sm">${savedMapboxToken ? 'Saved' : 'Save'}</button>
            <a href="${MAPBOX_SIGNUP_URL}" target="_blank" rel="noopener"
              class="import-api-link" title="Get free token">Get token</a>
          </div>
          <div id="import-mb-status" class="import-api-status">
            ${mbTokenMasked ? `Token stored: ${mbTokenMasked}` : 'No token — using ESRI satellite'}
          </div>
        </div>
      </div>
    </details>

    <!-- Address lookup -->
    <div class="form-group">
      <label class="form-label">Property Address</label>
      <div class="import-address-row">
        <input id="import-address" type="text" class="form-input"
          placeholder="123 Main St, City, State ZIP"
          value="${escapeAttr(loadField('address'))}">
        <button id="import-lookup" class="btn btn-secondary btn-sm">Lookup</button>
      </div>
      <div id="import-status" class="import-status" hidden></div>
    </div>

    <!-- Property details form -->
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Stories</label>
        <input id="import-stories" type="number" class="form-input"
          value="${loadField('stories') || '2'}" min="1" max="8">
      </div>
      <div class="form-group">
        <label class="form-label">Sq. Ft.</label>
        <input id="import-sqft" type="number" class="form-input"
          value="${loadField('sqft') || '2000'}" min="400" max="50000">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Bedrooms</label>
        <input id="import-beds" type="number" class="form-input"
          value="${loadField('beds') || '3'}" min="0" max="20">
      </div>
      <div class="form-group">
        <label class="form-label">Bathrooms</label>
        <input id="import-baths" type="number" class="form-input"
          value="${loadField('baths') || '2'}" min="0" max="15">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Year Built</label>
        <input id="import-year" type="number" class="form-input"
          value="${loadField('year') || '2000'}" min="1600" max="2030">
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select id="import-proptype" class="form-select">
          <option value="house" ${loadField('proptype') === 'house' ? 'selected' : ''}>House</option>
          <option value="townhouse" ${loadField('proptype') === 'townhouse' ? 'selected' : ''}>Townhouse</option>
          <option value="condo" ${loadField('proptype') === 'condo' ? 'selected' : ''}>Condo</option>
          <option value="cabin" ${loadField('proptype') === 'cabin' ? 'selected' : ''}>Cabin</option>
          <option value="mansion" ${loadField('proptype') === 'mansion' ? 'selected' : ''}>Mansion</option>
        </select>
      </div>
    </div>

    <!-- Style chips -->
    <div class="form-group">
      <label class="form-label">Style</label>
      <div id="import-style-chips" style="display:flex;gap:6px;flex-wrap:wrap;">
        ${STYLE_PRESETS.map(s => `
          <button class="style-chip ${s.value === selectedStyle ? 'active' : ''}" data-style="${s.value}"
                  style="--chip-color:${s.color};">
            ${s.label}
          </button>
        `).join('')}
      </div>
    </div>

    <!-- Floor plan upload (collapsible) -->
    <details class="customize-section" id="import-floorplan-section">
      <summary class="customize-summary">Floor Plan (Optional)</summary>
      <div class="customize-body">
        <div id="import-floorplan-drop" class="import-floorplan-drop">
          <p style="color:var(--text-muted);font-size:12px;">Drop or paste floor plan image, or click to browse</p>
          <input type="file" id="import-floorplan-input" accept="image/*" hidden>
        </div>
        <div id="import-floorplan-info" style="font-size:11px;color:var(--text-secondary);" hidden></div>
      </div>
    </details>

    <!-- Action buttons -->
    <div class="gen-actions">
      <div class="divider"></div>
      <button id="import-generate" class="btn btn-primary btn-full">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        Import &amp; Generate
      </button>
      <div id="import-info" class="info-panel" hidden></div>
    </div>
  `;

  // ── DOM refs ──────────────────────────────────────────────────────────
  const addressInput = controls.querySelector('#import-address') as HTMLInputElement;
  const lookupBtn = controls.querySelector('#import-lookup') as HTMLButtonElement;
  const statusEl = controls.querySelector('#import-status') as HTMLElement;
  const generateBtn = controls.querySelector('#import-generate') as HTMLButtonElement;
  const infoPanel = controls.querySelector('#import-info') as HTMLElement;
  const floorPlanDrop = controls.querySelector('#import-floorplan-drop') as HTMLElement;
  const floorPlanInput = controls.querySelector('#import-floorplan-input') as HTMLInputElement;
  const floorPlanInfo = controls.querySelector('#import-floorplan-info') as HTMLElement;
  const parclKeyInput = controls.querySelector('#import-parcl-key') as HTMLInputElement;
  const parclSaveBtn = controls.querySelector('#import-parcl-save') as HTMLButtonElement;
  const parclStatus = controls.querySelector('#import-parcl-status') as HTMLElement;
  const rentCastKeyInput = controls.querySelector('#import-rentcast-key') as HTMLInputElement;
  const rentCastSaveBtn = controls.querySelector('#import-rentcast-save') as HTMLButtonElement;
  const rentCastStatus = controls.querySelector('#import-rentcast-status') as HTMLElement;
  const svKeyInput = controls.querySelector('#import-sv-key') as HTMLInputElement;
  const svSaveBtn = controls.querySelector('#import-sv-save') as HTMLButtonElement;
  const svStatus = controls.querySelector('#import-sv-status') as HTMLElement;
  const mbTokenInput = controls.querySelector('#import-mb-token') as HTMLInputElement;
  const mbSaveBtn = controls.querySelector('#import-mb-save') as HTMLButtonElement;
  const mbStatus = controls.querySelector('#import-mb-status') as HTMLElement;
  const apiSection = controls.querySelector('#import-api-section') as HTMLDetailsElement;

  // Form field refs for persistence
  const fieldIds = ['import-stories', 'import-sqft', 'import-beds', 'import-baths', 'import-year'] as const;
  const fieldKeys = ['stories', 'sqft', 'beds', 'baths', 'year'] as const;

  // ── API Key management ────────────────────────────────────────────────
  const apiBadge = controls.querySelector('#import-api-badge') as HTMLElement;

  /** Update the N/4 badge count after any key save */
  function updateApiBadge(): void {
    const count = [hasParclApiKey(), hasRentCastApiKey(), hasStreetViewApiKey(), hasMapboxToken()]
      .filter(Boolean).length;
    apiBadge.textContent = `${count}/4`;
  }

  // Parcl Labs key
  parclSaveBtn.addEventListener('click', () => {
    const key = parclKeyInput.value.trim();
    setParclApiKey(key);
    if (key) {
      parclSaveBtn.textContent = 'Saved';
      parclStatus.textContent = `Key stored: ••••${key.slice(-4)}`;
    } else {
      parclSaveBtn.textContent = 'Save';
      parclStatus.textContent = 'No key — manual entry only';
    }
    updateApiBadge();
  });
  parclKeyInput.addEventListener('input', () => { parclSaveBtn.textContent = 'Save'; });

  // RentCast key
  rentCastSaveBtn.addEventListener('click', () => {
    const key = rentCastKeyInput.value.trim();
    setRentCastApiKey(key);
    if (key) {
      rentCastSaveBtn.textContent = 'Saved';
      rentCastStatus.textContent = `Key stored: ••••${key.slice(-4)}`;
    } else {
      rentCastSaveBtn.textContent = 'Save';
      rentCastStatus.textContent = 'No key — satellite color used instead';
    }
    updateApiBadge();
  });
  rentCastKeyInput.addEventListener('input', () => { rentCastSaveBtn.textContent = 'Save'; });

  // Google Street View key
  svSaveBtn.addEventListener('click', () => {
    const key = svKeyInput.value.trim();
    setStreetViewApiKey(key);
    if (key) {
      svSaveBtn.textContent = 'Saved';
      svStatus.textContent = `Key stored: ••••${key.slice(-4)}`;
    } else {
      svSaveBtn.textContent = 'Save';
      svStatus.textContent = 'No key — no exterior photo';
    }
    updateApiBadge();
  });
  svKeyInput.addEventListener('input', () => { svSaveBtn.textContent = 'Save'; });

  // Mapbox token
  mbSaveBtn.addEventListener('click', () => {
    const token = mbTokenInput.value.trim();
    setMapboxToken(token);
    if (token) {
      mbSaveBtn.textContent = 'Saved';
      mbStatus.textContent = `Token stored: ••••${token.slice(-4)}`;
    } else {
      mbSaveBtn.textContent = 'Save';
      mbStatus.textContent = 'No token — using ESRI satellite';
    }
    updateApiBadge();
  });
  mbTokenInput.addEventListener('input', () => { mbSaveBtn.textContent = 'Save'; });

  // ── Session persistence for all form fields ───────────────────────────
  // Address field
  addressInput.addEventListener('input', () => saveField('address', addressInput.value));

  // Numeric fields
  for (let i = 0; i < fieldIds.length; i++) {
    const el = controls.querySelector(`#${fieldIds[i]}`) as HTMLInputElement;
    el.addEventListener('input', () => saveField(fieldKeys[i], el.value));
  }

  // Property type select
  const propTypeEl = controls.querySelector('#import-proptype') as HTMLSelectElement;
  propTypeEl.addEventListener('change', () => saveField('proptype', propTypeEl.value));

  // ── Style chips ───────────────────────────────────────────────────────
  const chips = controls.querySelectorAll('.style-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectedStyle = (chip as HTMLElement).dataset['style'] as StyleName | 'auto';
      saveField('style', selectedStyle);
    });
  });

  // ── Address lookup ────────────────────────────────────────────────────
  lookupBtn.addEventListener('click', doLookup);
  addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLookup();
  });

  async function doLookup(): Promise<void> {
    const address = addressInput.value.trim();
    if (!address) {
      showStatus('Enter an address to look up', 'error');
      return;
    }

    lookupBtn.disabled = true;

    // Run geocoding, Parcl API, and RentCast lookup in parallel
    showStatus('Looking up property...', 'loading');

    // Reset enrichment state for new lookup
    currentWallOverride = undefined;
    currentDetectedColor = undefined;
    currentRentCast = null;
    currentOSM = null;
    currentPoolDetected = false;
    currentStreetViewUrl = null;
    currentParcl = null;

    const [geoResult, parclResult, rentCastResult] = await Promise.allSettled([
      geocodeAddress(address),
      hasParclApiKey() ? searchParclProperty(address) : Promise.resolve(null),
      hasRentCastApiKey() ? searchRentCastProperty(address) : Promise.resolve(null),
    ]);

    // Handle geocoding result — fall back to Parcl lat/lng if geocoders fail
    let parclGeoFallback = false;
    if (geoResult.status !== 'fulfilled' || !geoResult.value) {
      // Check if Parcl returned valid coordinates as geocoding fallback
      const parclData = parclResult.status === 'fulfilled' ? parclResult.value : null;
      if (parclData && parclData.latitude !== 0 && parclData.longitude !== 0) {
        currentGeocoding = {
          lat: parclData.latitude,
          lng: parclData.longitude,
          matchedAddress: parclData.address || address,
          source: 'nominatim', // closest match — Parcl uses address matching
        };
        parclGeoFallback = true;
      }
    } else {
      currentGeocoding = geoResult.value;
    }

    if (currentGeocoding) {
      const geo = currentGeocoding;

      // Fire OSM + Street View checks in parallel (don't block satellite)
      const [osmResult, svResult] = await Promise.allSettled([
        searchOSMBuilding(geo.lat, geo.lng),
        hasStreetViewApiKey()
          ? checkStreetViewAvailability(geo.lat, geo.lng, getStreetViewApiKey())
          : Promise.resolve(false),
      ]);

      // Process OSM result
      if (osmResult.status === 'fulfilled' && osmResult.value) {
        currentOSM = osmResult.value;
      }

      // Process Street View result
      if (svResult.status === 'fulfilled' && svResult.value === true) {
        currentStreetViewUrl = getStreetViewUrl(geo.lat, geo.lng, getStreetViewApiKey());
      }

      // Build Mapbox tile fetcher if token is configured
      const tileFetcher = hasMapboxToken()
        ? createMapboxTileFetcher(getMapboxToken())
        : undefined;

      // Show satellite view (async, don't block) — also extract building color
      showSatelliteLoading(viewer);
      composeSatelliteView(geo.lat, geo.lng, 18, tileFetcher).then(canvas => {
        currentSeason = (canvas.dataset['season'] as SeasonalWeather) ?? undefined;

        // Extract building color from satellite canvas around crosshair
        const { pixelX, pixelY } = getCrosshairPosition(geo.lat, geo.lng);
        const color = extractBuildingColor(canvas, pixelX, pixelY);
        if (color) {
          currentDetectedColor = color;
          // Only use satellite color as wallOverride if higher-priority sources didn't set it
          if (!currentWallOverride) {
            currentWallOverride = mapColorToWall(color);
          }
        }

        // Pool detection — scan ring around building for cyan/blue pixels
        currentPoolDetected = detectPool(canvas, pixelX, pixelY);

        // Draw OSM building polygon overlay on satellite canvas
        if (currentOSM && currentOSM.polygon.length >= 3) {
          drawBuildingOutline(canvas, geo, currentOSM.polygon);
        }

        showSatelliteCanvas(viewer, canvas, geo, currentSeason, currentDetectedColor);

        // Append Street View image below satellite if available
        if (currentStreetViewUrl) {
          appendStreetViewImage(viewer, currentStreetViewUrl);
        }
      }).catch(() => {
        showSatelliteError(viewer);
      });
    } else {
      // No geocoding and no Parcl fallback — abort
      currentGeocoding = null;
      const msg = geoResult.status === 'rejected'
        ? (geoResult.reason instanceof Error ? geoResult.reason.message : 'Geocoding failed')
        : 'No geocoding result';
      showStatus(msg, 'error');
      lookupBtn.disabled = false;
      return;
    }

    // Handle RentCast API result — enriches with floor count, exterior, lot size
    // Process RentCast first so wallOverride from exterior type takes priority (priority 1)
    if (rentCastResult.status === 'fulfilled' && rentCastResult.value) {
      currentRentCast = rentCastResult.value;
      populateFromRentCast(rentCastResult.value);
    }

    // Handle OSM enrichment — wallOverride priority 2 (below RentCast, above satellite color)
    if (currentOSM) {
      populateFromOSM(currentOSM);
    }

    // Handle Parcl API result — auto-fill form fields
    const geoSource = parclGeoFallback ? 'parcl' : currentGeocoding!.source;
    const statusParts: string[] = [currentGeocoding!.matchedAddress, `(${geoSource})`];
    if (parclResult.status === 'fulfilled' && parclResult.value) {
      currentParcl = parclResult.value;
      populateFromParcl(parclResult.value);
      statusParts.push('— property data loaded');
    }
    if (currentRentCast) {
      statusParts.push(currentRentCast.exteriorType ? `| ${currentRentCast.exteriorType}` : '');
    }
    if (currentOSM) {
      statusParts.push(`| ${currentOSM.widthMeters}m × ${currentOSM.lengthMeters}m (OSM)`);
    }
    showStatus(statusParts.filter(Boolean).join(' '), 'success');

    lookupBtn.disabled = false;
  }

  /** Populate form fields from Parcl Labs property data */
  function populateFromParcl(parcl: ParclPropertyData): void {
    const fieldMap: [string, string, number][] = [
      ['import-sqft', 'sqft', parcl.squareFootage],
      ['import-beds', 'beds', parcl.bedrooms],
      ['import-baths', 'baths', parcl.bathrooms],
      ['import-year', 'year', parcl.yearBuilt],
    ];

    for (const [id, key, value] of fieldMap) {
      if (value && value > 0) {
        const el = controls.querySelector(`#${id}`) as HTMLInputElement;
        el.value = String(value);
        saveField(key, String(value));
        // Brief highlight animation to show auto-filled fields
        el.classList.add('import-field-filled');
        setTimeout(() => el.classList.remove('import-field-filled'), 1500);
      }
    }

    // Stories: estimate from sqft + bedrooms + property type
    // Parcl doesn't provide stories directly — use heuristics:
    //   - Condos/townhouses often multi-story regardless of sqft
    //   - Large single-family homes (>2500sqft with >3 beds) likely 2+
    //   - Very large (>4000sqft) likely 3+
    const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
    const pType = (parcl.propertyType || '').toUpperCase();
    if (pType.includes('TOWN') || (parcl.squareFootage > 2500 && parcl.bedrooms > 3)) {
      const estimatedStories = parcl.squareFootage > 4000 ? 3 : 2;
      storiesEl.value = String(estimatedStories);
      saveField('stories', String(estimatedStories));
    }

    // Property type mapping
    if (parcl.propertyType) {
      const mapped = mapParclPropertyType(parcl.propertyType);
      propTypeEl.value = mapped;
      saveField('proptype', mapped);
    }
  }

  /** Populate form fields and wallOverride from RentCast property data */
  function populateFromRentCast(rc: RentCastPropertyData): void {
    // Floor count → stories field (most reliable source for this)
    if (rc.floorCount && rc.floorCount > 0) {
      const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
      storiesEl.value = String(rc.floorCount);
      saveField('stories', String(rc.floorCount));
      storiesEl.classList.add('import-field-filled');
      setTimeout(() => storiesEl.classList.remove('import-field-filled'), 1500);
    }

    // Exterior type → wall material override (highest priority for wallOverride)
    if (rc.exteriorType) {
      const mapped = mapExteriorToWall(rc.exteriorType);
      if (mapped) {
        currentWallOverride = mapped;
      }
    }

    // If RentCast also provides beds/baths/sqft/year and Parcl didn't, backfill
    const backfillMap: [string, string, number][] = [
      ['import-sqft', 'sqft', rc.squareFootage],
      ['import-beds', 'beds', rc.bedrooms],
      ['import-baths', 'baths', rc.bathrooms],
      ['import-year', 'year', rc.yearBuilt],
    ];
    for (const [id, key, value] of backfillMap) {
      if (value && value > 0) {
        const el = controls.querySelector(`#${id}`) as HTMLInputElement;
        // Only backfill if current value is the default
        const current = parseInt(el.value) || 0;
        if (current === 0 || el.value === loadField(key)) continue;
      }
    }
  }

  /** Populate form fields and wallOverride from OSM building data */
  function populateFromOSM(osm: OSMBuildingData): void {
    // Stories from OSM building:levels — only use if RentCast didn't provide floorCount
    if (osm.levels && osm.levels > 0 && !currentRentCast?.floorCount) {
      const storiesEl = controls.querySelector('#import-stories') as HTMLInputElement;
      storiesEl.value = String(osm.levels);
      saveField('stories', String(osm.levels));
      storiesEl.classList.add('import-field-filled');
      setTimeout(() => storiesEl.classList.remove('import-field-filled'), 1500);
    }

    // Wall material from OSM — priority 2 (below RentCast exteriorType, above satellite color)
    if (osm.material && !currentWallOverride) {
      const mapped = mapOSMMaterialToWall(osm.material);
      if (mapped) {
        currentWallOverride = mapped;
      }
    }
  }

  /**
   * Draw the OSM building polygon outline on the satellite canvas.
   * Converts lat/lng polygon vertices to canvas pixel coordinates.
   */
  function drawBuildingOutline(
    canvas: HTMLCanvasElement,
    geo: GeocodingResult,
    polygon: { lat: number; lon: number }[],
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx || polygon.length < 3) return;

    const zoom = 18;
    const n = Math.pow(2, zoom);
    const { tileX, tileY } = getTileCoords(geo.lat, geo.lng, zoom);

    ctx.save();
    ctx.strokeStyle = 'rgba(88, 101, 242, 0.8)';
    ctx.fillStyle = 'rgba(88, 101, 242, 0.12)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    ctx.beginPath();
    for (let i = 0; i < polygon.length; i++) {
      const pt = polygon[i];
      const latRad = (pt.lat * Math.PI) / 180;
      const xFrac = ((pt.lon + 180) / 360) * n;
      const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
      // Canvas position: offset from center tile origin (tile at index 1,1 in the 3x3 grid)
      const px = (xFrac - tileX + 1) * 256;
      const py = (yFrac - tileY + 1) * 256;

      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Helper to get tile coordinates without pixel offset */
  function getTileCoords(lat: number, lng: number, zoom: number): { tileX: number; tileY: number } {
    const n = Math.pow(2, zoom);
    const latRad = (lat * Math.PI) / 180;
    const xFrac = ((lng + 180) / 360) * n;
    const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    return { tileX: Math.floor(xFrac), tileY: Math.floor(yFrac) };
  }

  /** Append a Street View image below the satellite canvas in the viewer */
  function appendStreetViewImage(container: HTMLElement, url: string): void {
    const wrapper = container.querySelector('.import-satellite-wrapper');
    if (!wrapper) return;

    const svContainer = document.createElement('div');
    svContainer.className = 'import-streetview-container';

    const label = document.createElement('div');
    label.className = 'import-satellite-overlay';
    label.style.top = '12px';
    label.style.bottom = 'auto';
    label.textContent = 'Street View';

    const img = document.createElement('img');
    img.className = 'import-streetview-img';
    img.src = url;
    img.alt = 'Street View';
    img.loading = 'lazy';

    svContainer.appendChild(label);
    svContainer.appendChild(img);

    // Insert after the satellite wrapper
    wrapper.parentElement?.appendChild(svContainer);
  }

  /** Get crosshair pixel position on the 768x768 satellite canvas */
  function getCrosshairPosition(lat: number, lng: number): { pixelX: number; pixelY: number } {
    // Re-derive from latLngToTile at zoom 18 (same as composeSatelliteView)
    const zoom = 18;
    const n = Math.pow(2, zoom);
    const latRad = (lat * Math.PI) / 180;
    const xFrac = ((lng + 180) / 360) * n;
    const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const tileX = Math.floor(xFrac);
    const tileY = Math.floor(yFrac);
    // Pixel offset within the center tile + 256 (center tile starts at 256,256)
    const pixelX = 256 + Math.floor((xFrac - tileX) * 256);
    const pixelY = 256 + Math.floor((yFrac - tileY) * 256);
    return { pixelX, pixelY };
  }

  function showStatus(message: string, type: 'success' | 'error' | 'loading'): void {
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.className = `import-status import-status-${type}`;
  }

  // ── Satellite view display ────────────────────────────────────────────
  function showSatelliteLoading(container: HTMLElement): void {
    container.innerHTML = `
      <div class="viewer-placeholder">
        <div class="spinner"></div>
        <p>Loading satellite view...</p>
      </div>
    `;
  }

  function showSatelliteError(container: HTMLElement): void {
    container.innerHTML = `
      <div class="viewer-placeholder">
        <p style="color:var(--text-muted);">Satellite imagery unavailable</p>
      </div>
    `;
  }

  function showSatelliteCanvas(
    container: HTMLElement,
    canvas: HTMLCanvasElement,
    geo: GeocodingResult,
    season?: SeasonalWeather,
    detectedColor?: { r: number; g: number; b: number },
  ): void {
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'import-satellite-wrapper';

    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.objectFit = 'contain';
    wrapper.appendChild(canvas);

    // Lat/lng + season + detected color overlay
    const overlay = document.createElement('div');
    overlay.className = 'import-satellite-overlay';
    const seasonLabel = season ? ` | ${SEASON_LABELS[season]}` : '';
    let colorHtml = '';
    if (detectedColor) {
      const hex = `rgb(${detectedColor.r},${detectedColor.g},${detectedColor.b})`;
      colorHtml = ` | <span class="import-color-swatch" style="background:${hex};"></span>`;
    }
    overlay.innerHTML = `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}${seasonLabel}${colorHtml}`;
    wrapper.appendChild(overlay);

    container.appendChild(wrapper);
  }

  // ── Floor plan: drag, drop, click, and clipboard paste ────────────────
  floorPlanDrop.addEventListener('click', () => floorPlanInput.click());

  floorPlanDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    floorPlanDrop.classList.add('dragover');
  });

  floorPlanDrop.addEventListener('dragleave', () => {
    floorPlanDrop.classList.remove('dragover');
  });

  floorPlanDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    floorPlanDrop.classList.remove('dragover');
    const file = e.dataTransfer?.files[0];
    if (file && file.type.startsWith('image/')) {
      handleFloorPlanFile(file);
    }
  });

  floorPlanInput.addEventListener('change', () => {
    const file = floorPlanInput.files?.[0];
    if (file) handleFloorPlanFile(file);
    floorPlanInput.value = '';
  });

  // Clipboard paste support — works when floor plan section is open
  document.addEventListener('paste', (e) => {
    // Only handle if import tab is active and floor plan section is open
    const importTab = controls.closest('.tab-content');
    if (!importTab?.classList.contains('active')) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          // Auto-open floor plan section if closed
          const section = controls.querySelector('#import-floorplan-section') as HTMLDetailsElement;
          section.open = true;
          handleFloorPlanFile(file);
        }
        break;
      }
    }
  });

  function handleFloorPlanFile(file: File): void {
    if (file.size > 10 * 1024 * 1024) {
      floorPlanInfo.hidden = false;
      floorPlanInfo.textContent = 'File too large (max 10MB)';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const analysis = analyzeFloorPlan(img);
        currentFloorPlan = analysis;

        floorPlanInfo.hidden = false;
        floorPlanInfo.textContent = `Detected ${analysis.rooms.length} room${analysis.rooms.length !== 1 ? 's' : ''} | Aspect ratio: ${analysis.aspectRatio.toFixed(2)}:1 | ${analysis.imageWidth}x${analysis.imageHeight}px`;

        // Show loaded state with filename (or "pasted image")
        const name = file.name || 'Pasted image';
        floorPlanDrop.innerHTML = `<p style="color:var(--success);font-size:12px;">Floor plan loaded: ${escapeHtml(name)}</p>`;
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  // ── Generate ──────────────────────────────────────────────────────────
  generateBtn.addEventListener('click', doGenerate);

  function doGenerate(): void {
    const yearVal = parseInt((controls.querySelector('#import-year') as HTMLInputElement).value) || 2000;

    const property: PropertyData = {
      address: addressInput.value.trim() || 'Unknown Address',
      stories: parseInt((controls.querySelector('#import-stories') as HTMLInputElement).value) || 2,
      sqft: parseInt((controls.querySelector('#import-sqft') as HTMLInputElement).value) || 2000,
      bedrooms: parseInt((controls.querySelector('#import-beds') as HTMLInputElement).value) || 3,
      bathrooms: parseInt((controls.querySelector('#import-baths') as HTMLInputElement).value) || 2,
      yearBuilt: yearVal,
      propertyType: propTypeEl.value,
      style: selectedStyle,
      floorPlan: currentFloorPlan ?? undefined,
      geocoding: currentGeocoding ?? undefined,
      season: currentSeason,
      newConstruction: currentParcl?.newConstruction ?? yearVal >= 2020,
      lotSize: currentRentCast?.lotSize,
      exteriorType: currentRentCast?.exteriorType,
      wallOverride: currentWallOverride,
      roofType: currentRentCast?.roofType,
      architectureType: currentRentCast?.architectureType,
      detectedColor: currentDetectedColor,
      osmWidth: currentOSM?.widthBlocks,
      osmLength: currentOSM?.lengthBlocks,
      osmLevels: currentOSM?.levels,
      osmMaterial: currentOSM?.material,
      osmRoofShape: currentOSM?.roofShape ? mapOSMRoofShape(currentOSM.roofShape) : undefined,
      osmRoofMaterial: currentOSM?.roofMaterial,
      osmRoofColour: currentOSM?.roofColour,
      osmBuildingColour: currentOSM?.buildingColour,
      osmArchitecture: currentOSM?.tags?.['building:architecture'],
      hasGarage: currentRentCast?.garageSpaces != null && currentRentCast.garageSpaces > 0,
      hasPool: currentPoolDetected,
      floorPlanShape: currentOSM?.polygon
        ? analyzePolygonShape(currentOSM.polygon) : undefined,
      streetViewUrl: currentStreetViewUrl ?? undefined,
      county: currentParcl?.county,
      stateAbbreviation: currentParcl?.stateAbbreviation,
      city: currentParcl?.city,
      zipCode: currentParcl?.zipCode,
      ownerOccupied: currentParcl?.ownerOccupied,
      onMarket: currentParcl?.onMarket,
      parclPropertyId: currentParcl?.parclPropertyId,
    };

    const options = convertToGenerationOptions(property);
    const grid = generateStructure(options);

    // Show info panel with enrichment data
    const nonAir = grid.countNonAir();
    const seasonStr = property.season ? ` | ${SEASON_LABELS[property.season]}` : '';
    const constructionStr = property.newConstruction ? ' (new)' : '';

    // Build optional enrichment rows
    let enrichmentRows = '';
    if (property.lotSize && property.lotSize > 0) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Lot Size</span><span class="info-value">${property.lotSize.toLocaleString()} sqft</span></div>`;
    }
    if (property.exteriorType) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Exterior</span><span class="info-value">${escapeHtml(property.exteriorType)}</span></div>`;
    }
    if (property.detectedColor) {
      const c = property.detectedColor;
      const hex = `rgb(${c.r},${c.g},${c.b})`;
      enrichmentRows += `<div class="info-row"><span class="info-label">Detected Color</span><span class="info-value"><span class="import-color-swatch" style="background:${hex};"></span> ${c.r},${c.g},${c.b}</span></div>`;
    }
    if (property.wallOverride) {
      // Show the mapped wall block name (strip minecraft: prefix)
      const wallName = property.wallOverride.replace('minecraft:', '').replace(/_/g, ' ');
      enrichmentRows += `<div class="info-row"><span class="info-label">Wall Material</span><span class="info-value">${wallName}</span></div>`;
    }
    if (property.roofType) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Roof</span><span class="info-value">${escapeHtml(property.roofType)}</span></div>`;
    }
    if (property.architectureType) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Architecture</span><span class="info-value">${escapeHtml(property.architectureType)}</span></div>`;
    }
    if (property.osmWidth && property.osmLength) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Footprint</span><span class="info-value">${currentOSM?.widthMeters}m × ${currentOSM?.lengthMeters}m (OSM)</span></div>`;
    }
    if (property.osmMaterial) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Material</span><span class="info-value">${escapeHtml(property.osmMaterial)} (OSM)</span></div>`;
    }
    if (property.osmRoofShape) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Roof Shape</span><span class="info-value">${escapeHtml(property.osmRoofShape)} (OSM)</span></div>`;
    }

    // Parcl enrichment rows — all 17 fields consumed
    if (property.city) {
      const loc = property.city + (property.stateAbbreviation ? `, ${property.stateAbbreviation}` : '')
        + (property.zipCode ? ` ${property.zipCode}` : '');
      enrichmentRows += `<div class="info-row"><span class="info-label">Location</span><span class="info-value">${escapeHtml(loc)}</span></div>`;
    }
    if (property.county) {
      enrichmentRows += `<div class="info-row"><span class="info-label">County</span><span class="info-value">${escapeHtml(property.county)}</span></div>`;
    }
    if (property.ownerOccupied != null) {
      const occupancy = property.ownerOccupied ? 'Owner-occupied' : 'Rental/Investment';
      const marketStatus = property.onMarket === true ? ' (on market)' : '';
      enrichmentRows += `<div class="info-row"><span class="info-label">Occupancy</span><span class="info-value">${occupancy}${marketStatus}</span></div>`;
    }
    if (property.stateAbbreviation) {
      const climate = inferClimateZone(property.stateAbbreviation);
      const density = inferDensityFromZip(property.zipCode);
      const parts: string[] = [];
      if (climate !== 'temperate') parts.push(`${climate === 'cold' ? 'Cold' : 'Hot'} zone`);
      if (density !== 'suburban') parts.push(density);
      if (parts.length > 0) {
        enrichmentRows += `<div class="info-row"><span class="info-label">Climate/Density</span><span class="info-value">${parts.join(' | ')}</span></div>`;
      }
    }

    // Show inferred generation options
    if (options.roofShape && options.roofShape !== 'gable') {
      enrichmentRows += `<div class="info-row"><span class="info-label">Roof Type</span><span class="info-value">${options.roofShape}</span></div>`;
    }
    if (options.doorOverride) {
      enrichmentRows += `<div class="info-row"><span class="info-label">Door</span><span class="info-value">${options.doorOverride}</span></div>`;
    }
    if (options.features) {
      const feats = Object.entries(options.features)
        .filter(([_, v]) => v === true)
        .map(([k]) => k);
      if (feats.length > 0 && feats.length < 7) {
        enrichmentRows += `<div class="info-row"><span class="info-label">Features</span><span class="info-value">${feats.join(', ')}</span></div>`;
      }
    }

    infoPanel.hidden = false;
    infoPanel.innerHTML = `
      <div class="info-row"><span class="info-label">Address</span><span class="info-value" style="font-family:var(--font);font-size:11px;">${escapeHtml(property.address)}</span></div>
      <div class="info-row"><span class="info-label">Dimensions</span><span class="info-value">${grid.width} x ${grid.height} x ${grid.length}</span></div>
      <div class="info-row"><span class="info-label">Blocks</span><span class="info-value">${nonAir.toLocaleString()}</span></div>
      <div class="info-row"><span class="info-label">Style</span><span class="info-value">${options.style}${constructionStr}${seasonStr}</span></div>
      <div class="info-row"><span class="info-label">Rooms</span><span class="info-value">${options.rooms?.length ?? 0}</span></div>
      ${enrichmentRows}
    `;

    onGenerate(grid, property);
  }
}

/** Escape HTML to prevent XSS in address display */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape for HTML attribute values */
function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
