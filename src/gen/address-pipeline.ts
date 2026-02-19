/**
 * Address-to-structure pipeline — pure logic for converting property data into
 * GenerationOptions. Shared by both the web app (import tab) and CLI (--address).
 *
 * Contains PropertyData interface, style/dimension/stories inference, feature flags,
 * and the core convertToGenerationOptions function. No DOM or localStorage dependencies.
 *
 * Extracted from web/src/ui/import.ts for reusability.
 */

import type {
  StructureType, StyleName, RoomType, BlockState,
  RoofShape, FeatureFlags, FloorPlanShape, GenerationOptions,
} from '../types/index.js';

// ─── Inline type fragments (avoid cross-boundary web imports) ───────────────

/** Minimal floor plan analysis — only aspectRatio is used by the pipeline */
export interface FloorPlanHint {
  aspectRatio: number;
}

/** Geocoding result — lat/lng + source */
export interface GeocodingResult {
  lat: number;
  lng: number;
  matchedAddress: string;
  source: 'census' | 'nominatim';
}

/** Seasonal weather hint */
export type SeasonalWeather = 'snow' | 'spring' | 'summer' | 'fall';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Property data collected from the import pipeline or CLI address lookup */
export interface PropertyData {
  address: string;
  stories: number;
  sqft: number;
  bedrooms: number;
  bathrooms: number;
  yearBuilt: number;
  propertyType: string;
  style: StyleName | 'auto';
  floorPlan?: FloorPlanHint;
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
  /** True when yearBuilt could not be determined from any data source */
  yearUncertain?: boolean;
  /** True when bedrooms=0 might mean missing data rather than studio */
  bedroomsUncertain?: boolean;
}

// ─── Hash ───────────────────────────────────────────────────────────────────

/** FNV-1a hash for deterministic seed from address string */
export function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 999999;
}

// ─── Style Resolution ───────────────────────────────────────────────────────

/** Infer architectural style from year built + new construction flag */
export function inferStyle(year: number, newConstruction = false): StyleName {
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
export function mapArchitectureToStyle(arch: string | undefined): StyleName | undefined {
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
export function inferStyleFromCounty(county: string | undefined, year: number): StyleName | undefined {
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
export function inferStyleFromCity(city: string | undefined, year: number): StyleName | undefined {
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
 * Resolve the effective style for a property, applying the full priority chain.
 * Used by both convertToGenerationOptions and inferFeatures.
 *
 * Priority: user selection > OSM architecture > RentCast architecture > city > county > year
 */
export function resolveStyle(prop: PropertyData): StyleName {
  if (prop.style !== 'auto') return prop.style;
  // When year is uncertain, skip year-based inference — rely on other signals
  const year = prop.yearUncertain ? 1970 : prop.yearBuilt; // 1970 → 'modern' as neutral default
  const archStyle = mapArchitectureToStyle(prop.osmArchitecture)
    ?? mapArchitectureToStyle(prop.architectureType);
  const cityStyle = inferStyleFromCity(prop.city, year);
  const countyStyle = inferStyleFromCounty(prop.county, year);
  return archStyle ?? cityStyle ?? countyStyle ?? inferStyle(year, prop.newConstruction);
}

// ─── Density & Climate ──────────────────────────────────────────────────────

/**
 * Infer neighborhood density from ZIP code.
 * Urban core ZIP codes (low ranges, dense areas) get smaller lots and less yard.
 */
export function inferDensityFromZip(zip: string | undefined): 'urban' | 'suburban' | 'rural' {
  if (!zip || zip.length !== 5) return 'suburban';
  // First 3 digits = sectional center facility (SCF) — rough density proxy
  const scf = parseInt(zip.substring(0, 3));
  if (isNaN(scf)) return 'suburban';
  // Dense urban cores: Manhattan (100-102), Chicago loop (606), SF (941), Boston (021)
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
export function inferClimateZone(state: string | undefined): 'cold' | 'hot' | 'temperate' {
  if (!state) return 'temperate';
  const s = state.toUpperCase();
  // Cold-climate states — more chimney likelihood, steeper roofs
  if (['MN', 'WI', 'MI', 'ND', 'SD', 'MT', 'VT', 'NH', 'ME', 'AK', 'WY'].includes(s)) return 'cold';
  // Hot-climate states — pool more likely, flat roofs, less chimney
  if (['FL', 'AZ', 'NV', 'HI', 'TX', 'NM', 'LA', 'MS', 'AL'].includes(s)) return 'hot';
  return 'temperate';
}

// ─── Stories Estimation ─────────────────────────────────────────────────────

/**
 * Estimate number of stories from total sqft and real OSM footprint area.
 * More accurate than sqft-only heuristic because it uses the actual building
 * ground-floor dimensions rather than guessing from sqrt(sqft).
 *
 * @param sqft Total square footage (all floors combined, from Parcl)
 * @param footprintWidthM OSM footprint width in meters
 * @param footprintLengthM OSM footprint length in meters
 * @returns Estimated story count, clamped to [1, 8]
 */
export function estimateStoriesFromFootprint(
  sqft: number,
  footprintWidthM: number,
  footprintLengthM: number,
): number {
  const footprintSqm = footprintWidthM * footprintLengthM;
  if (footprintSqm <= 0) return 2; // fallback
  const totalSqm = sqft / 10.76; // sqft to sqm
  const rawFloors = totalSqm / footprintSqm;
  return Math.max(1, Math.min(8, Math.round(rawFloors)));
}

// ─── Roof Mapping ───────────────────────────────────────────────────────────

/**
 * Map OSM roof:shape tag to generator RoofShape.
 * Normalizes the various OSM values to one of our 5 supported roof shapes.
 */
export function mapOSMRoofToShape(osmRoofShape: string | undefined): RoofShape | undefined {
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
export function mapRoofMaterialToBlocks(
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

  // Colour-based mapping fallback (priority 2)
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
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return undefined;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);

  const CANDIDATES: [string, number, number, number][] = [
    ['dark_oak', 60, 42, 22],
    ['spruce', 115, 85, 49],
    ['brick', 150, 74, 58],
    ['stone_brick', 128, 128, 128],
    ['sandstone', 216, 200, 157],
    ['cobblestone', 100, 100, 100],
    ['deepslate_tile', 54, 54, 62],
    ['blackstone', 34, 28, 32],
    ['prismarine', 76, 127, 115],
    ['nether_brick', 44, 21, 26],
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

// ─── Door & Trim Mapping ────────────────────────────────────────────────────

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

// ─── Feature Flags ──────────────────────────────────────────────────────────

/**
 * Infer feature flags from property data.
 * Uses lot size, sqft, property type, year, climate, density, and ownership
 * to determine which exterior features should be generated.
 */
export function inferFeatures(prop: PropertyData): FeatureFlags {
  const lotSize = prop.lotSize ?? 0;
  const sqft = prop.sqft;
  const year = prop.yearBuilt;
  const climate = inferClimateZone(prop.stateAbbreviation);
  const density = inferDensityFromZip(prop.zipCode);
  const residential = prop.ownerOccupied !== false; // Default to true if unknown
  const staged = prop.onMarket === true;

  const flags: FeatureFlags = {
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

  // ── Style-aware overrides ──
  // Victorian/Gothic and Craftsman/Rustic homes always have porches, even in urban areas
  // Only applies to owner-occupied (residential) properties
  if (residential) {
    const effectiveStyle = resolveStyle(prop);
    if (effectiveStyle === 'gothic' || effectiveStyle === 'rustic') {
      flags.porch = true;
    }
    // Colonial/Fantasy homes pre-1950 also typically have porches
    if (effectiveStyle === 'fantasy' && year > 0 && year < 1950) {
      flags.porch = true;
    }
  }

  return flags;
}

// ─── Core Conversion ────────────────────────────────────────────────────────

/** Convert property data into GenerationOptions for the core generator */
export function convertToGenerationOptions(prop: PropertyData): GenerationOptions {
  // ── Style resolution ──────────────────────────────────────────────
  let style = resolveStyle(prop);

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
