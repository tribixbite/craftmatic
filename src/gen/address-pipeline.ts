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
  RoofShape, FeatureFlags, FloorPlanShape, GenerationOptions, LandscapeData,
} from '../types/index.js';
import type { TreeType } from './structures.js';

import { ROOF_PALETTE, rgbToTrimBlock as rgbToTrimBlockShared, rgbToWallBlock } from './color-blocks.js';
import { polygonToBitmap, classifyBitmapShape, subtractInnerRings } from './coordinate-bitmap.js';
import { inferCategory, resolvePalette } from './material-resolver.js';

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
  /** Lot size in sqft (from Smarty) */
  lotSize?: number;
  /** Exterior wall material description (from Smarty) */
  exteriorType?: string;
  /** Wall block override derived from exterior type or satellite color */
  wallOverride?: BlockState;
  /** Roof covering material (from Smarty) */
  roofType?: string;
  /** Architecture style description (from Smarty) */
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
  /** Whether property has a garage (from Smarty assessor data) */
  hasGarage?: boolean;
  /** Swimming pool detected in satellite imagery */
  hasPool?: boolean;
  /** Floor plan shape derived from OSM polygon analysis */
  floorPlanShape?: FloorPlanShape;
  /** Raw OSM building polygon vertices — used for bitmap rasterization */
  osmPolygon?: { lat: number; lon: number }[];
  /** Inner ring polygons for courtyard/multipolygon buildings */
  osmInnerPolygons?: { lat: number; lon: number }[][];
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
  /** Construction type from assessor: "Frame", "Masonry", "Concrete" (Smarty) */
  constructionType?: string;
  /** Foundation type: "Slab", "Crawl Space", "Basement" (Smarty) */
  foundation?: string;
  /** Roof frame shape: "Gable", "Hip", "Flat" (Smarty) */
  roofFrame?: string;
  /** Fireplace detected in assessor records (Smarty) */
  hasFireplace?: boolean;
  /** Deck detected in assessor records (Smarty) */
  hasDeck?: boolean;
  /** Porch detected in assessor records — overrides inference (Smarty) */
  smartyHasPorch?: boolean;
  /** Pool detected in assessor records — overrides inference (Smarty) */
  smartyHasPool?: boolean;
  /** Fence detected in assessor records (Smarty) */
  smartyHasFence?: boolean;
  /** Driveway type: "Asphalt", "Concrete", "Gravel" (Smarty) */
  drivewayType?: string;
  /** County assessed property value (Smarty) */
  assessedValue?: number;
  /** Mapillary street-level image URL (free alternative to Google Street View) */
  mapillaryImageUrl?: string;
  /** Mapillary image compass heading (0=north, 90=east, 180=south, 270=west) */
  mapillaryHeading?: number;
  /** Mapillary capture date as ISO string */
  mapillaryCaptureDate?: string;
  /** Driveway detected via Mapillary map features */
  mapillaryHasDriveway?: boolean;
  /** Fence detected via Mapillary map features */
  mapillaryHasFence?: boolean;
  /** Building height from Mapbox Tilequery in meters — used for floor count inference */
  mapboxHeight?: number;
  /** Building type from Mapbox vector tiles: 'house', 'apartments', 'detached', etc. */
  mapboxBuildingType?: string;
  /** Terrain slope across building footprint (meters) — from AWS Terrarium elevation tiles */
  terrainSlope?: number;

  // ─── Satellite Footprint Extraction ───────────────────────────────────────
  /** Building footprint width from satellite image analysis (meters) */
  satFootprintWidth?: number;
  /** Building footprint length from satellite image analysis (meters) */
  satFootprintLength?: number;
  /** Satellite footprint extraction confidence (0-1) */
  satFootprintConfidence?: number;
  /** Primary roof pitch from Google Solar in degrees (0=flat, 45=steep) */
  solarRoofPitch?: number;
  /** Number of roof segments from Google Solar — 2=gable, 4=hip, 1+flat=flat */
  solarRoofSegments?: number;
  /** Compass azimuth of dominant roof segment (0=N, 90=E, 180=S, 270=W) from Solar API */
  solarAzimuthDegrees?: number;
  /** Building footprint area from Google Solar in sqm */
  solarBuildingArea?: number;
  /** Total roof surface area from Google Solar in sqm */
  solarRoofArea?: number;
  /** Google Street View capture date (e.g. "2023-05") */
  streetViewDate?: string;
  /** Street View camera heading toward building (0-360°) */
  streetViewHeading?: number;

  // ─── SV Image Analysis (Tier 1: Colors) ────────────────────────────────────
  /** Wall block override from SV color extraction */
  svWallOverride?: BlockState;
  /** Roof block override from SV color extraction */
  svRoofOverride?: { north: BlockState; south: BlockState; cap: BlockState };
  /** Trim block override from SV color extraction */
  svTrimOverride?: BlockState;

  // ─── SV Image Analysis (Tier 2: Structural Heuristics) ─────────────────────
  /** Story count from horizontal projection analysis */
  svStoryCount?: number;
  /** Confidence for svStoryCount (0-1). Below 0.5 is unreliable — prefer height data. */
  svStoryConfidence?: number;
  /** Wall texture class from Sobel entropy analysis */
  svTextureClass?: string;
  /** Suggested wall block from texture classification */
  svTextureBlock?: BlockState;
  /** Roof pitch category from diagonal edge detection */
  svRoofPitch?: 'flat' | 'moderate' | 'steep';
  /** Roof height override from pitch analysis (0.3 flat, 0.5 moderate, 0.8 steep) */
  svRoofHeightOverride?: number;
  /** Whether facade appears symmetric */
  svSymmetric?: boolean;
  /** Suggested plan shape from symmetry analysis */
  svPlanShape?: 'rect' | 'L' | 'T';
  /** Windows per floor from fenestration density analysis */
  svWindowsPerFloor?: number;
  /** Window spacing in blocks (2=dense, 3=normal, 5=sparse) */
  svWindowSpacing?: number;
  /** Feature flags inferred from setback/lawn analysis */
  svSetbackFeatures?: Partial<import('../types/index.js').FeatureFlags>;

  // ─── SV Image Analysis (Tier 3: Vision, opt-in) ────────────────────────────
  /** Door wood type from vision analysis */
  svDoorOverride?: string;
  /** Feature flags from vision analysis */
  svFeatures?: Partial<import('../types/index.js').FeatureFlags>;
  /** Architecture style label from vision analysis (freeform) */
  svArchitectureLabel?: string;
  /** Constrained architectural style from VLM taxonomy (e.g. "Colonial", "Mediterranean") */
  svArchitectureStyle?: string;
  /** Wall material from VLM (e.g. "brick", "stucco", "wood_siding") */
  svWallMaterial?: string;
  /** Roof material from VLM (e.g. "asphalt_shingle", "clay_tile") */
  svRoofMaterial?: string;
  /** Human-readable wall color from VLM (e.g. "white stucco") */
  svWallColorDescription?: string;
  /** Human-readable roof color from VLM (e.g. "dark gray") */
  svRoofColorDescription?: string;
  /** Roof shape from VLM visual classification (e.g. "hip", "gable") */
  svVlmRoofShape?: string;

  // ─── Phase 5 P0: Vegetation & Landscape ───────────────────────────────────
  /** Tree canopy cover percentage (0–99) from NLCD (US) or WorldCover (global) */
  canopyCoverPct?: number;
  /** USDA Plant Hardiness Zone (e.g. "7b") — determines tree species palette */
  hardinessZone?: string;
  /** Individual trees near the property from OSM natural=tree nodes */
  nearbyTrees?: { lat: number; lon: number; species?: string; height?: number }[];

  // ─── Phase 5 P0: Enhanced Building Data ────────────────────────────────────
  /** Building height from Overture Maps (meters) */
  overtureHeight?: number;
  /** Number of floors from Overture Maps */
  overtureFloors?: number;
  /** Roof shape from Overture Maps (e.g. "gable", "hip", "flat") */
  overtureRoofShape?: string;
  /** Building height from Cesium OSM Buildings batch table (meters) */
  cesiumHeight?: number;
  /** Building levels from Cesium OSM Buildings */
  cesiumLevels?: number;
  /** Building material from Cesium OSM Buildings */
  cesiumMaterial?: string;
  /** Roof shape from Cesium OSM Buildings */
  cesiumRoofShape?: string;

  // ─── Phase 5 P0: Browser ML Analysis (deferred to P1) ──────────────────────
  /** Architectural style label from CLIP zero-shot classification */
  clipStyle?: string;
  /** Wall material label from CLIP zero-shot classification */
  clipMaterial?: string;
  /** Building height in meters from Depth Anything V3 metric depth */
  depthBuildingHeight?: number;

  // ─── Phase 5 P1: Smarty Untapped Fields ───────────────────────────────────
  /** Garage size in sqft from assessor records */
  garageSqft?: number;
  /** Number of fireplaces from assessor records */
  fireplaceCount?: number;
  /** Estimated total market value of property */
  totalMarketValue?: number;
  /** Air conditioning type: "Central", "Window", etc. */
  airConditioningType?: string;
  /** Primary heating system: "Forced Air", "Radiator", etc. */
  heatingSystemType?: string;
  /** Heating fuel: "Natural Gas", "Electric", "Oil", etc. */
  heatingFuelType?: string;
  /** Total room count from assessor */
  totalRooms?: number;

  // ─── Phase 5 P1: Water & Land Cover ───────────────────────────────────────
  /** Nearby water features from OSM (rivers, streams, lakes, ponds) */
  nearbyWater?: { type: string; name?: string; distanceMeters: number }[];
  /** Tree canopy height at point in meters (Meta/WRI 1m COG) */
  canopyHeightMeters?: number;
  /** ESA WorldCover land cover class value (10=tree, 50=built-up, 80=water, etc.) */
  landCoverClass?: number;
  /** ESA WorldCover land cover label */
  landCoverLabel?: string;
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

// ─── Property Type Helpers ───────────────────────────────────────────────────

/** Returns true for property types that represent multi-unit buildings (apartments, condos, townhouses) */
export function isMultiUnit(propertyType: string): boolean {
  return /^(condo|multi_family|townhouse)$/i.test(propertyType);
}

// ─── Style Resolution ───────────────────────────────────────────────────────

/** Infer architectural style from year built, with optional region disambiguation.
 *  The 1920-1944 era had distinct regional styles — Spanish Revival in the Southwest,
 *  Colonial Revival/Tudor in the Northeast and Midwest, Craftsman in the Pacific NW. */
export function inferStyle(year: number, newConstruction = false, state?: string): StyleName {
  if (newConstruction || year >= 2010) return 'modern';
  if (year < 1700) return 'medieval';
  if (year < 1850) return 'gothic';
  if (year < 1890) return 'rustic';     // Victorian-era wood-frame (pre-Colonial Revival)
  if (year < 1920) return 'colonial';   // Colonial Revival, Foursquare, Prairie — formal with symmetry
  if (year < 1945) {
    // Region-aware: 1920-1944 was NOT universally Spanish Revival
    const st = state?.toUpperCase() ?? '';
    const southwest = ['CA', 'AZ', 'NM', 'NV', 'FL', 'TX'].includes(st);
    if (southwest) return 'desert';     // Spanish Revival, Mission, Mediterranean
    const pnw = ['WA', 'OR'].includes(st);
    if (pnw) return 'rustic';           // Craftsman, bungalow
    return 'colonial';                  // Colonial Revival, Tudor, Foursquare (NE, Midwest, SE)
  }
  if (year < 1970) return 'rustic';     // Ranch, Mid-century modern, split-level — low-slung natural
  return 'modern';                       // 1970+ contemporary/modern
}

/**
 * Map OSM building:architecture or Smarty architectureType to StyleName.
 * Returns undefined if no mapping is found (will fall back to year-based inference).
 */
export function mapArchitectureToStyle(arch: string | undefined): StyleName | undefined {
  if (!arch) return undefined;
  const a = arch.trim().toLowerCase();
  const MAP: [RegExp, StyleName][] = [
    [/\bvictorian|queen\s*anne|second\s*empire/i, 'gothic'],
    [/\bcraftsman|arts?\s*&?\s*crafts|bungalow/i, 'rustic'],
    [/\bcolonial|georgian|federal|cape\s*cod|foursquare/i, 'colonial'],
    [/\bmodern|contemporary|mid.?century|minimalist|international|bauhaus/i, 'modern'],
    [/\bmediterranean|spanish|mission|pueblo|stucco/i, 'desert'],
    [/\btudor|half.?timber|english/i, 'medieval'],
    [/\bart\s*deco|art\s*nouveau|beaux.?arts/i, 'steampunk'],
    [/\bjapanese|asian|zen/i, 'elven'],
    [/\bgothic|romanesque/i, 'gothic'],
    [/\bfarmhouse|country|log\s*cabin/i, 'rustic'],
    [/\branch|split.?level|raised\s*ranch/i, 'rustic'],
    [/\bcastle|chateau|palatial|manor/i, 'fantasy'],
    // Frank Lloyd Wright and related styles — concrete/geometric → modern
    [/\bmayan|aztec|prairie|wright|organic|textile.?block/i, 'modern'],
    // Revival styles map to the era they revive
    [/\bcolonial\s*revival|dutch\s*colonial|saltbox/i, 'colonial'],
    [/\bgreek\s*revival|neoclassical|palladian/i, 'colonial'],
    [/\bgothic\s*revival|carpenter\s*gothic/i, 'gothic'],
    // Regional American styles
    [/\badobe|southwest|territorial/i, 'desert'],
    [/\bbrown\s*stone|row\s*house|townhouse/i, 'gothic'],
    [/\bcottage|cabin|rustic/i, 'rustic'],
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
  // SF Bay Area: Victorian era (pre-1910) → gothic, Mediterranean/Mission (1910-1960) → colonial
  // Colonial better matches white stucco + balconies + symmetry than desert (acacia/sandstone)
  if (/\bsan\s*francisco|alameda|marin/.test(c)) return year < 1910 ? 'gothic' : 'colonial';
  // Mediterranean/Desert style regions
  if (/\bmiami.?dade|palm\s*beach|broward/.test(c)) return 'desert';
  // Tudor/Medieval style areas
  if (/\bwestchester|dutchess|suffolk/.test(c) && year < 1940) return 'medieval';
  // Art Deco / Steampunk — industrial-era cities
  if (/\bcook|wayne|allegheny/.test(c) && year >= 1900 && year < 1940) return 'steampunk';
  // Colonial — East Coast historic
  if (/\bfairfax|arlington|montgomery/.test(c) && year < 1900) return 'colonial';
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
  if (/^savannah$/i.test(c) && year < 1900) return 'colonial';
  // Charleston — Georgian/Federal
  if (/^charleston$/i.test(c) && year < 1900) return 'colonial';
  // Key West — Caribbean/tropical timber
  if (/^key\s*west$/i.test(c)) return 'rustic';
  // SoCal / Southwest — Spanish Revival, Mission, Mediterranean dominance pre-1960
  if (/^los\s*angeles|^san\s*diego|^pasadena|^santa\s*barbara|^santa\s*monica/i.test(c) && year < 1960) return 'desert';
  if (/^phoenix|^tucson|^scottsdale|^albuquerque|^santa\s*fe/i.test(c)) return 'desert';
  // South Florida — Mediterranean Revival pre-1960
  if (/^miami|^palm\s*beach|^coral\s*gables|^fort\s*lauderdale/i.test(c) && year < 1960) return 'desert';
  // Portland/Seattle — craftsman prevalence
  if (/^portland|^seattle$/i.test(c) && year < 1950) return 'rustic';
  return undefined;
}

/**
 * Infer architectural style from property type for multi-unit buildings.
 * Apartments and condos have fundamentally different aesthetics than single-family homes.
 * Returns undefined for types that should fall through to location/year-based inference.
 */
export function inferStyleFromPropertyType(
  propertyType: string, year: number, bedrooms?: number, bathrooms?: number
): StyleName | undefined {
  const pt = propertyType.toLowerCase();

  // Multi-family apartments: boxy, flat/low-pitch roofs, stucco or brick
  // Pre-1920 tenements/brownstones map to gothic; modern to modern.
  // 1920-1969 varies by region — fall through to city/county/year inference.
  if (/multi_family|apartment/.test(pt)) {
    if (year >= 1970) return 'modern';
    if (year < 1920) return 'gothic';       // Pre-war tenement/brownstone
    return undefined;                        // 1920-1969: region-dependent (colonial, desert, rustic)
  }

  // Heuristic: propertyType="OTHER" with many bedrooms is likely misclassified multi-unit
  if (pt === 'other' && (bedrooms ?? 0) >= 6 && (bathrooms ?? 0) >= 6) {
    if (year >= 1970) return 'modern';
    if (year < 1920) return 'gothic';
    return undefined;                        // 1920-1969: let location-based inference decide
  }

  // Heuristic: single-family "house" with 8+ beds AND 8+ baths is almost certainly
  // a misclassified multi-unit (MLS/Parcl often lists entire multi-unit buildings as "house").
  // Require both high beds AND baths — large estates can have 8+ beds with fewer baths.
  if (pt === 'house' && (bedrooms ?? 0) >= 8 && (bathrooms ?? 0) >= 8) {
    if (year >= 1970) return 'modern';
    if (year < 1920) return 'gothic';
    return undefined;                        // 1920-1969: region-dependent
  }

  // Individual condo units: usually in modern buildings
  if (pt === 'condo') {
    return year >= 1970 ? 'modern' : undefined; // Older condos fall through
  }

  return undefined; // single-family, townhouse, etc. fall through to existing logic
}

/**
 * Resolve the effective style for a property, applying the full priority chain.
 * Used by both convertToGenerationOptions and inferFeatures.
 *
 * Priority: user selection > OSM architecture > Smarty architecture > VLM style > SV label > propertyType > city > county > year
 */
export function resolveStyle(prop: PropertyData): StyleName {
  if (prop.style !== 'auto') return prop.style;
  // When year is uncertain, use actual yearBuilt for upstream signals but
  // fall back to 'rustic' instead of year-based inference — most US homes
  // with missing dates are pre-war wood-frame construction
  const year = prop.yearBuilt;
  // VLM constrained taxonomy is higher signal than freeform label
  const archStyle = mapArchitectureToStyle(prop.osmArchitecture)
    ?? mapArchitectureToStyle(prop.architectureType)
    ?? mapArchitectureToStyle(prop.svArchitectureStyle)
    ?? mapArchitectureToStyle(prop.svArchitectureLabel);
  const propTypeStyle = inferStyleFromPropertyType(prop.propertyType, year, prop.bedrooms, prop.bathrooms);
  const cityStyle = inferStyleFromCity(prop.city, year);
  const countyStyle = inferStyleFromCounty(prop.county, year);
  // When year is uncertain, use density + region to pick a reasonable default:
  // - Rural/coastal → 'rustic' (wood-frame, natural materials)
  // - Village/suburban → 'fantasy' (colonial/traditional — white clapboard, formal trim)
  // - Urban → 'gothic' (brownstone, brick rowhouse)
  const uncertainFallback = (): StyleName => {
    const density = inferDensityFromZip(prop.zipCode);
    if (density === 'urban') return 'gothic';
    // New England village homes (NH, VT, MA, CT, ME, RI) with formal road types
    // are overwhelmingly white colonial/Federal, not rustic lodges
    const ne = ['NH', 'VT', 'MA', 'CT', 'ME', 'RI'].includes(prop.stateAbbreviation?.toUpperCase() ?? '');
    const formalRoad = /\b(st|ave|blvd|dr|ct|pl|sq|way|cir)\b/i.test(prop.address);
    // Grand NE estates (>= 10000 sqft) with uncertain year are likely Victorian/Queen Anne.
    // Colonials are typically under 10000 sqft; 6000-9999 are large colonials, not mansions.
    if (ne && prop.sqft >= 10000) return 'fantasy';
    if (ne && formalRoad) return 'colonial'; // White clapboard Colonial/Federal
    // California and Southwest homes with uncertain year are overwhelmingly
    // Mediterranean/Spanish Revival or Ranch — colonial is rare outside the East Coast
    const sw = ['CA', 'AZ', 'NM', 'NV', 'TX', 'FL'].includes(prop.stateAbbreviation?.toUpperCase() ?? '');
    if (sw) return 'desert';
    if (density === 'suburban' && prop.sqft >= 6000) return 'fantasy';
    if (density === 'suburban' && formalRoad) return 'colonial';
    return 'rustic';
  };
  const fallback = prop.yearUncertain ? uncertainFallback() : inferStyle(year, prop.newConstruction, prop.stateAbbreviation);
  return archStyle ?? propTypeStyle ?? cityStyle ?? countyStyle ?? fallback;
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
export function inferClimateZone(
  state: string | undefined,
  hardinessZone?: string,
): 'cold' | 'hot' | 'temperate' {
  // Hardiness zone gives precise climate: zones 1-4 = cold, 5-7 = temperate, 8+ = hot
  if (hardinessZone) {
    const num = parseInt(hardinessZone.replace(/[ab]/i, ''));
    if (!isNaN(num)) {
      if (num <= 4) return 'cold';
      if (num >= 9) return 'hot';
      // Zones 5-8 fall through to state-based refinement
    }
  }
  if (!state) return 'temperate';
  const s = state.toUpperCase();
  // Cold-climate states — more chimney likelihood, steeper roofs
  if (['MN', 'WI', 'MI', 'ND', 'SD', 'MT', 'VT', 'NH', 'ME', 'AK', 'WY'].includes(s)) return 'cold';
  // Hot-climate states — pool more likely, flat roofs, less chimney
  if (['FL', 'AZ', 'NV', 'HI', 'TX', 'NM', 'LA', 'MS', 'AL'].includes(s)) return 'hot';
  return 'temperate';
}

/**
 * Map USDA hardiness zone → Minecraft tree type palette.
 * Pure function — mirrors web/src/ui/import-hardiness.ts for CLI compatibility.
 */
function hardinessToTreePalette(zone: string | null | undefined): TreeType[] {
  if (!zone) return ['oak', 'birch']; // default temperate
  const num = parseInt(zone, 10);
  if (isNaN(num)) return ['oak', 'birch'];
  if (num <= 3) return ['spruce', 'birch'];                  // very cold: boreal
  if (num <= 5) return ['oak', 'birch', 'spruce'];           // cold: mixed
  if (num <= 7) return ['oak', 'birch', 'dark_oak'];         // moderate: deciduous
  if (num <= 9) return ['oak', 'dark_oak', 'jungle'];        // warm: subtropical
  return ['jungle', 'acacia'];                                // tropical: zone 10+
}

/**
 * Map ESA WorldCover land cover class value → ground material hint.
 * See https://worldcover2021.esa.int for class definitions.
 */
function landCoverToGround(lcClass: number | undefined): LandscapeData['groundCover'] {
  if (lcClass === 10) return 'forest';
  if (lcClass === 30) return 'grass';
  if (lcClass === 40) return 'crop';
  if (lcClass === 50) return 'built';
  if (lcClass === 80) return 'water';
  if (lcClass === 60 || lcClass === 90) return 'bare';
  return 'default';
}

/**
 * Build LandscapeData from PropertyData Phase 5 environmental fields.
 * Returns undefined when no environmental data is present (fantasy mode).
 */
export function buildLandscape(prop: PropertyData): LandscapeData | undefined {
  // Only produce landscape when at least one env field is populated
  const hasEnvData = prop.hardinessZone || prop.canopyCoverPct != null
    || prop.canopyHeightMeters != null || prop.nearbyWater?.length
    || prop.landCoverClass != null;
  if (!hasEnvData) return undefined;

  const treePalette = hardinessToTreePalette(prop.hardinessZone);
  const canopyPct = prop.canopyCoverPct ?? 0;
  // Scale tree count: 0%→2 (minimum), 30%→4, 60%→6, 90%→8
  const treeCount = Math.max(2, Math.min(8, Math.round(2 + (canopyPct / 100) * 6)));
  // Canopy height → trunk height: 5m→3 blocks, 10m→5, 20m→7, cap at 8
  const rawHeight = prop.canopyHeightMeters ?? 5;
  const treeHeight = Math.max(3, Math.min(8, Math.round(rawHeight * 0.4)));
  const hasWater = (prop.nearbyWater?.length ?? 0) > 0;
  const groundCover = landCoverToGround(prop.landCoverClass);

  // Path and fence blocks keyed by land cover — gives each climate a distinct feel
  const pathBlock = groundCover === 'forest' ? 'minecraft:mossy_cobblestone'
    : groundCover === 'crop' ? 'minecraft:dirt_path'
    : groundCover === 'built' ? 'minecraft:stone_bricks'
    : groundCover === 'water' ? 'minecraft:prismarine_bricks'
    : groundCover === 'bare' ? 'minecraft:smooth_sandstone'
    : 'minecraft:cobblestone'; // grass + default
  const fenceBlock = groundCover === 'forest' ? 'minecraft:spruce_fence'
    : groundCover === 'crop' ? 'minecraft:oak_fence'
    : groundCover === 'built' ? 'minecraft:stone_brick_wall'
    : groundCover === 'water' ? 'minecraft:dark_oak_fence'
    : groundCover === 'bare' ? 'minecraft:acacia_fence'
    : 'minecraft:oak_fence'; // grass + default

  return { treePalette, treeCount, treeHeight, hasWater, groundCover, pathBlock, fenceBlock };
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
 * @returns Estimated story count, clamped to [1, 100]
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
  // When the footprint is small (< 200 sqm) but sqft is large, the listing
  // likely includes finished basement/attic in the total. Parcl sqft commonly
  // counts all "finished" area. Cap the raw estimate to avoid inflated floors.
  // For larger footprints, use ceil since OSM bounding boxes overestimate
  // area vs actual buildable area (wings, setbacks, irregular shapes).
  if (footprintSqm < 200 && rawFloors > 3) {
    // Small footprint: clamp to 3 floors max — extra sqft is likely basement/attic
    return 3;
  }
  const rounding = sqft >= 5000 ? Math.ceil : Math.round;
  return Math.max(1, Math.min(100, rounding(rawFloors)));
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
 * Infer roof shape from Smarty assessor roofFrame field.
 * This field is already stored in PropertyData but was previously unused.
 */
export function inferRoofFromSmartyFrame(frame: string | undefined): RoofShape | undefined {
  if (!frame) return undefined;
  const f = frame.toLowerCase();
  if (f.includes('gable')) return 'gable';
  if (f.includes('hip')) return 'hip';
  if (f.includes('flat')) return 'flat';
  if (f.includes('gambrel')) return 'gambrel';
  if (f.includes('mansard')) return 'mansard';
  return undefined;
}

/**
 * Infer roof shape from Google Solar roof segment count and pitch.
 * Segment count reveals shape: 1+low pitch = flat, 2 = gable, 4 = hip.
 * More than 6 segments suggests a complex roof (approximated as gambrel).
 */
export function inferRoofFromSolar(
  segments: number | undefined, pitch: number | undefined,
): RoofShape | undefined {
  if (segments == null) return undefined;
  // Single flat segment with low/no pitch → flat roof
  if (segments <= 1 && (pitch == null || pitch < 15)) return 'flat';
  // Google Solar segments count individual roof planes (dormers, extensions, etc.),
  // NOT "how many sides the roof has." A gable with dormers has 6+ segments.
  // Use pitch angle as primary discriminator, segment count as secondary.
  if (pitch != null) {
    if (pitch < 5) return 'flat';
    if (pitch < 25) return segments === 2 ? 'gable' : 'hip';
    // Steep pitch (≥25°) — most commonly gable for residential
    return 'gable';
  }
  // Pitch unavailable — use segment count cautiously
  if (segments === 2) return 'gable';
  if (segments >= 3 && segments <= 5) return 'hip';
  // Many segments without pitch data → default to hip (safer than gambrel)
  return 'hip';
}

/**
 * Infer roof shape from Street View pitch analysis.
 * Maps 'flat', 'moderate', 'steep' to corresponding shapes.
 * Lowest priority in roof shape chain — only used when OSM, Smarty, and Solar
 * don't provide shape info.
 */
export function inferRoofFromSVPitch(pitch: 'flat' | 'moderate' | 'steep' | undefined): RoofShape | undefined {
  if (!pitch) return undefined;
  if (pitch === 'flat') return 'flat';
  // Both moderate and steep imply a pitched roof; gable is the most common
  // residential roof shape and safest default when exact shape is unknown
  return 'gable';
}

/**
 * Last-resort roof shape inference from solar pitch angle alone.
 * Used when segment count is unavailable but pitch data exists (e.g. single-segment Solar result).
 * <5° → flat, 5-25° → hip (most common low-pitch), ≥25° → gable (steep).
 */
export function inferRoofFromPitchOnly(pitch: number | undefined): RoofShape | undefined {
  if (pitch == null) return undefined;
  if (pitch < 5) return 'flat';
  if (pitch < 25) return 'hip';
  return 'gable';
}

/**
 * Map VLM roof shape classification to our RoofShape type.
 * VLM returns "gable"|"hip"|"flat"|"gambrel"|"mansard"|"shed"|null.
 * "shed" maps to "gable" (closest supported approximation).
 */
export function mapVlmRoofShape(vlmShape: string | undefined): RoofShape | undefined {
  if (!vlmShape) return undefined;
  const normalized = vlmShape.toLowerCase().trim();
  if (normalized === 'shed') return 'gable';
  const valid: RoofShape[] = ['gable', 'hip', 'flat', 'gambrel', 'mansard'];
  return valid.includes(normalized as RoofShape) ? (normalized as RoofShape) : undefined;
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

/** Map a hex colour to the nearest roof material base name using shared palette */
function hexToRoofBlock(hex: string): string | undefined {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return undefined;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);

  let bestBase = ROOF_PALETTE[0].base;
  let bestDist = Infinity;
  for (const { base, rgb } of ROOF_PALETTE) {
    const dist = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestBase = base;
    }
  }
  return bestBase;
}

// ─── Smarty Roof Type → Roof Material ────────────────────────────────────────

/**
 * Map Smarty assessor roofCover/roofType to Minecraft roof block override.
 * Assessor records have roof cover info (tile, slate, metal, asphalt, shake, etc.)
 * that's more specific than OSM roof:material for most US properties.
 */
export function mapSmartyRoofTypeToBlocks(
  roofType: string | undefined,
): { north: BlockState; south: BlockState; cap: BlockState } | undefined {
  if (!roofType) return undefined;
  const rt = roofType.toLowerCase();
  const MAP: [RegExp, { stair: string; slab: string }][] = [
    [/\btile|clay/i, { stair: 'minecraft:brick_stairs', slab: 'minecraft:brick_slab' }],
    [/\bslate/i, { stair: 'minecraft:deepslate_tile_stairs', slab: 'minecraft:deepslate_tile_slab' }],
    [/\bmetal|standing.*seam/i, { stair: 'minecraft:cut_copper_stairs', slab: 'minecraft:cut_copper_slab' }],
    [/\bshake|wood/i, { stair: 'minecraft:spruce_stairs', slab: 'minecraft:spruce_slab' }],
    [/\basphalt|comp/i, { stair: 'minecraft:blackstone_stairs', slab: 'minecraft:blackstone_slab' }],
    [/\bconcrete|built.*up|flat/i, { stair: 'minecraft:smooth_stone_stairs', slab: 'minecraft:smooth_stone_slab' }],
    [/\brubber|membrane/i, { stair: 'minecraft:smooth_stone_stairs', slab: 'minecraft:smooth_stone_slab' }],
  ];
  for (const [pattern, { stair, slab }] of MAP) {
    if (pattern.test(rt)) {
      return {
        north: `${stair}[facing=north]`,
        south: `${stair}[facing=south]`,
        cap: `${slab}[type=bottom]`,
      };
    }
  }
  return undefined;
}

// ─── OSM Material & Construction Type → Wall ─────────────────────────────────

/**
 * Map OSM building:material tag to Minecraft wall block.
 * OSM tags like brick, stone, wood, concrete → appropriate block.
 */
export function mapOSMMaterialToWall(material: string | undefined): BlockState | undefined {
  if (!material) return undefined;
  const m = material.toLowerCase();
  if (/\bbrick/i.test(m)) return 'minecraft:bricks';
  if (/\bstone|limestone|granite|marble/i.test(m)) return 'minecraft:stone_bricks';
  if (/\bsandstone/i.test(m)) return 'minecraft:sandstone';
  if (/\bwood|timber|log|clapboard/i.test(m)) return 'minecraft:oak_planks';
  if (/\bconcrete|cement/i.test(m)) return 'minecraft:smooth_stone';
  if (/\bglass|curtain/i.test(m)) return 'minecraft:light_blue_stained_glass';
  if (/\bstucco|plaster|render/i.test(m)) return 'minecraft:smooth_quartz';
  if (/\bmetal|steel|aluminum/i.test(m)) return 'minecraft:iron_block';
  if (/\bcob|adobe/i.test(m)) return 'minecraft:mud_bricks';
  // VLM-specific material labels
  if (/\bvinyl|siding/i.test(m)) return 'minecraft:white_concrete';
  if (/\bshingle/i.test(m)) return 'minecraft:spruce_planks';
  return undefined;
}

/**
 * Map Smarty constructionType to Minecraft wall block.
 * Assessor records categorize buildings as Frame, Masonry, Concrete, Steel, etc.
 * Lower priority than OSM material or Smarty exteriorType.
 */
export function mapConstructionTypeToWall(constructionType: string | undefined): BlockState | undefined {
  if (!constructionType) return undefined;
  const ct = constructionType.toLowerCase();
  if (/\bmasonry|brick/i.test(ct)) return 'minecraft:bricks';
  if (/\bconcrete|cmu/i.test(ct)) return 'minecraft:smooth_stone';
  if (/\bsteel|metal/i.test(ct)) return 'minecraft:iron_block';
  if (/\bframe|wood/i.test(ct)) return 'minecraft:oak_planks';
  if (/\bstone/i.test(ct)) return 'minecraft:stone_bricks';
  if (/\blog/i.test(ct)) return 'minecraft:stripped_oak_log';
  return undefined;
}

/**
 * Apply year-based material aging to wall override.
 * Pre-1920: weathered/mossy materials. Post-2000: smooth/modern.
 */
function applyYearBasedWallAging(wall: BlockState | undefined, yearBuilt: number): BlockState | undefined {
  if (!wall) return undefined;
  if (yearBuilt > 0 && yearBuilt < 1920) {
    // Age stone bricks → cracked variant for pre-1920 buildings
    if (wall === 'minecraft:stone_bricks') return 'minecraft:cracked_stone_bricks';
    if (wall === 'minecraft:bricks') return 'minecraft:bricks'; // real brick ages well, keep it
  }
  if (yearBuilt >= 2000) {
    // Modern buildings → polished/smooth materials
    if (wall === 'minecraft:stone_bricks') return 'minecraft:polished_andesite';
    if (wall === 'minecraft:oak_planks') return 'minecraft:smooth_quartz';
  }
  return wall;
}

/**
 * Apply climate-specific material adjustments.
 * Hot/dry climates → lighter, sun-reflecting materials.
 * Cold/wet climates → darker, heavier materials and steeper roofs.
 * Only applies when no more-specific override is present.
 */
function applyClimateMaterials(
  wall: BlockState | undefined,
  climate: 'cold' | 'hot' | 'temperate',
): BlockState | undefined {
  if (!wall) return undefined;
  if (climate === 'hot') {
    // Hot climates: lighten heavy dark materials
    if (wall === 'minecraft:dark_oak_planks') return 'minecraft:birch_planks';
    if (wall === 'minecraft:stone_bricks') return 'minecraft:sandstone';
    if (wall === 'minecraft:deepslate_bricks') return 'minecraft:smooth_sandstone';
  } else if (climate === 'cold') {
    // Cold climates: favor sturdy, insulated-looking materials
    if (wall === 'minecraft:sandstone') return 'minecraft:stone_bricks';
    if (wall === 'minecraft:smooth_sandstone') return 'minecraft:bricks';
    if (wall === 'minecraft:birch_planks') return 'minecraft:spruce_planks';
  }
  return wall;
}

/**
 * Apply assessed-value-based material quality tiers.
 * Low value: basic/plain materials. High value: polished/ornate.
 * Mid-range values pass through unchanged.
 */
function applyValueTierMaterials(
  wall: BlockState | undefined,
  assessedValue: number | undefined,
): BlockState | undefined {
  if (!wall || !assessedValue || assessedValue <= 0) return wall;
  if (assessedValue > 800000) {
    // High value: upgrade to polished/premium variants
    if (wall === 'minecraft:stone_bricks') return 'minecraft:polished_deepslate';
    if (wall === 'minecraft:oak_planks') return 'minecraft:dark_oak_planks';
    if (wall === 'minecraft:bricks') return 'minecraft:polished_granite';
    if (wall === 'minecraft:smooth_stone') return 'minecraft:quartz_block';
  } else if (assessedValue < 150000) {
    // Low value: downgrade to simpler/weathered variants
    if (wall === 'minecraft:polished_andesite') return 'minecraft:andesite';
    if (wall === 'minecraft:quartz_block') return 'minecraft:smooth_stone';
    if (wall === 'minecraft:dark_oak_planks') return 'minecraft:oak_planks';
  }
  return wall;
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

/** Parse hex (#RGB or #RRGGBB) → [r, g, b] or undefined */
function hexToRgb(hex: string): [number, number, number] | undefined {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  if (clean.length !== 6) return undefined;
  return [
    parseInt(clean.substring(0, 2), 16),
    parseInt(clean.substring(2, 4), 16),
    parseInt(clean.substring(4, 6), 16),
  ];
}

/**
 * Map a building colour hex to a Minecraft trim/accent block.
 * Delegates to shared palette in color-blocks.ts.
 */
function hexToTrimBlock(hex: string): BlockState | undefined {
  const rgb = hexToRgb(hex);
  if (!rgb) return undefined;
  return rgbToTrimBlockShared(rgb[0], rgb[1], rgb[2]);
}

/**
 * Map a building colour hex to a Minecraft wall block.
 * OSM building:colour represents the facade color — maps to wall via CIE-Lab.
 */
function hexToWallBlock(hex: string): BlockState | undefined {
  const rgb = hexToRgb(hex);
  if (!rgb) return undefined;
  return rgbToWallBlock(rgb[0], rgb[1], rgb[2]);
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
  const climate = inferClimateZone(prop.stateAbbreviation, prop.hardinessZone);
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

  // ── Small building awareness ──
  // Tiny footprint buildings (<120 sqm) look disproportionate with large feature sets.
  // Reduce features to keep visual focus on the building itself.
  if (prop.osmWidth && prop.osmLength && prop.osmWidth * prop.osmLength < 120) {
    flags.backyard = false;
    flags.garden = false;
    flags.pool = false;
  }
  // ── Lot context awareness (Phase 3.7) ──
  // Small lots: tight setbacks, skip garden and trees (no room)
  if (lotSize > 0 && lotSize < 2500) {
    flags.trees = false;
    flags.garden = false;
    flags.backyard = false;
  }
  // Large lots: always include full landscaping suite
  if (lotSize > 10000) {
    flags.trees = true;
    flags.garden = true;
    flags.backyard = true;
    flags.fence = true;
  }

  // ── Year-based aging (Phase 2.9) ──
  // Pre-1920 buildings virtually always had chimneys; force it
  if (year > 0 && year < 1920) flags.chimney = true;

  // ── Foundation type from Smarty assessor ──
  if (prop.foundation) {
    const ft = prop.foundation.toLowerCase();
    if (ft.includes('crawl')) flags.foundationType = 'crawlspace';
    else if (ft.includes('basement') || ft.includes('cellar')) flags.foundationType = 'basement';
    else if (ft.includes('pier') || ft.includes('piling') || ft.includes('post')) flags.foundationType = 'pier';
    else flags.foundationType = 'slab';
  }

  // ── Terrain slope → foundation inference (from Elevation API) ──
  // When assessor data is unavailable, terrain slope hints at foundation type:
  //   >2m slope across footprint → raised/pier foundation (hillside building)
  //   >1m slope → crawlspace (slight grade, needs ventilation gap)
  //   ≤1m → slab (flat terrain, standard foundation)
  if (!flags.foundationType && prop.terrainSlope != null && prop.terrainSlope > 0) {
    if (prop.terrainSlope > 2) flags.foundationType = 'pier';
    else if (prop.terrainSlope > 1) flags.foundationType = 'crawlspace';
    // ≤1m: leave undefined → generator uses default slab
  }

  // ── Smarty assessor overrides (highest confidence — from county records) ──
  if (prop.smartyHasPool) flags.pool = true;
  if (prop.smartyHasFence) flags.fence = true;
  if (prop.smartyHasPorch) flags.porch = true;
  if (prop.drivewayType) flags.driveway = true;
  if (prop.hasFireplace) flags.chimney = true;
  // Heating fuel = gas/oil/propane → chimney likely (flue exhaust)
  if (prop.heatingFuelType && /gas|oil|propane|wood/i.test(prop.heatingFuelType)) {
    flags.chimney = true;
  }
  if (prop.hasDeck) flags.deck = true;

  // ── Mapillary feature overrides (crowd-sourced street-level detection) ──
  if (prop.mapillaryHasDriveway) flags.driveway = true;
  if (prop.mapillaryHasFence) flags.fence = true;

  // ── Style-aware overrides ──
  // Victorian/Gothic and Craftsman/Rustic homes always have porches, even in urban areas
  // Only applies to owner-occupied (residential) properties
  if (residential) {
    const effectiveStyle = resolveStyle(prop);
    if (effectiveStyle === 'gothic' || effectiveStyle === 'rustic') {
      flags.porch = true;
    }
    // Colonial, desert (Spanish Revival 1920-1945), and steampunk homes have covered entries
    if (effectiveStyle === 'colonial' || effectiveStyle === 'desert' || effectiveStyle === 'steampunk') {
      flags.porch = true;
    }
    if (effectiveStyle === 'fantasy' && year > 0 && year < 1950) {
      flags.porch = true;
    }
  }

  return flags;
}

// ─── Dimension Limits ────────────────────────────────────────────────────────

interface DimensionLimits { minW: number; maxW: number; minL: number; maxL: number }

/**
 * Get realistic dimension limits based on property type and size.
 * Prevents absurd builds while allowing genuine large properties (e.g. Winchester House)
 * to use their full OSM footprint.
 */
function getDimensionLimits(propertyType: string, sqft: number): DimensionLimits {
  const pt = propertyType.toLowerCase();
  if (/multi_family/.test(pt))  return { minW: 12, maxW: 50, minL: 12, maxL: 60 };
  if (pt === 'condo')           return { minW: 10, maxW: 50, minL: 10, maxL: 60 };
  if (pt === 'townhouse')       return { minW: 8,  maxW: 20, minL: 10, maxL: 50 };
  if (sqft > 10000)             return { minW: 15, maxW: 80, minL: 15, maxL: 80 }; // Mansions/estates
  if (sqft > 5000)              return { minW: 12, maxW: 55, minL: 12, maxL: 55 }; // Large homes
  return                                { minW: 10, maxW: 45, minL: 10, maxL: 45 }; // Standard residential
}

// ─── Core Conversion ────────────────────────────────────────────────────────

/** Convert property data into GenerationOptions for the core generator */
export function convertToGenerationOptions(prop: PropertyData): GenerationOptions {
  // ── Style resolution ──────────────────────────────────────────────
  let style = resolveStyle(prop);

  // Force rustic for cabin property type
  if (prop.propertyType === 'cabin') style = 'rustic';

  // ── Structure type ────────────────────────────────────────────────
  // Only use castle for actual castles/fortresses identified by architecture tags.
  // Large residential buildings (mansions, apartments) use 'house' — scale comes
  // from dimensions and floor count, not medieval fortress generation.
  let type: StructureType = 'house';
  const archStr = (prop.osmArchitecture ?? prop.architectureType ?? '').toLowerCase();
  if (/\bcastle|chateau|fortress|keep\b/.test(archStr)) {
    type = 'castle';
  }

  // Mapbox building type can reveal apartments/commercial when Parcl data is missing
  const mbType = prop.mapboxBuildingType?.toLowerCase() ?? '';
  const isMapboxMultiUnit = /apartment|dormitor|hotel|commercial/.test(mbType);

  // Heuristic multi-unit detection: high bedroom/bathroom count on non-multi-family
  // listings is almost certainly a misclassified apartment building.
  // Parcl Labs often returns "OTHER" for apartments, and "house" for multi-unit buildings.
  const pt = prop.propertyType?.toUpperCase() ?? '';
  const isHeuristicMultiUnit = (pt === 'OTHER' && prop.bedrooms >= 6 && prop.bathrooms >= 6)
    || (pt === 'HOUSE' && prop.bedrooms >= 8 && prop.bathrooms >= 8);  // 8+ bed+bath "house" is multi-unit

  // ── Floor clamping ───────────────────────────────────────────────
  // Clamp floors to realistic per-type limits to prevent inflated story counts
  const effectiveMultiUnit = isMultiUnit(prop.propertyType) || isMapboxMultiUnit || isHeuristicMultiUnit;
  let maxFloors = effectiveMultiUnit ? 8
    : prop.sqft > 10000 ? 5   // large mansions (e.g. Winchester)
    : 4;                        // standard single-family
  // Minimum floors for large single-family — a 5000+ sqft house is always 2+ stories,
  // and 6000+ sqft is virtually always 3 stories (Victorian estates, colonials, etc.)
  // Exception: when OSM footprint can accommodate the sqft in fewer floors (sprawling
  // estates, ranch-style homes), trust the footprint geometry over the sqft heuristic.
  let minFloors = 1;
  if (!effectiveMultiUnit) {
    if (prop.sqft >= 6000) minFloors = 3;
    else if (prop.sqft >= 3000) minFloors = 2;
    // Large footprint override: if the building footprint can hold the sqft in
    // fewer floors, don't force extra stories (catches sprawling estates, ranches).
    // Uses OSM footprint (best), Solar footprint (measured from aerial imagery),
    // or satellite footprint as evidence of a sprawling single-floor layout.
    const footprintSqm = (prop.osmWidth && prop.osmLength && prop.osmWidth > 0 && prop.osmLength > 0)
      ? prop.osmWidth * prop.osmLength
      : prop.solarBuildingArea ?? undefined;
    if (footprintSqm && footprintSqm > 0) {
      const totalSqm = prop.sqft / 10.76;
      const neededFloors = Math.max(1, Math.ceil(totalSqm / footprintSqm));
      minFloors = Math.min(minFloors, Math.max(1, neededFloors));
    }
    // When tax assessor explicitly reports stories, cap minFloors — the sqft figure
    // often includes garage, covered porch, or non-stacking space that the assessor
    // correctly reports as single-story. This fixes Austin ranch (3444sqft but 1-story).
    if (prop.stories && prop.stories < minFloors) {
      minFloors = prop.stories;
    }
  }
  // Small-footprint floor cap: buildings with tiny OSM footprints (<150 sqm)
  // are likely ranch/bungalow-style even if sqft or Mapbox height suggest more floors.
  // A 10x10m (100 sqm) building at 3+ floors looks like a tower, not a house.
  if (prop.osmWidth && prop.osmLength) {
    const footprintSqm = prop.osmWidth * prop.osmLength;
    if (footprintSqm < 150 && !effectiveMultiUnit) {
      maxFloors = Math.min(maxFloors, 2);
    }
  }

  // Stories estimation — priority chain with confidence gating.
  // 1. OSM building:levels — ground-truth from community mapping (highest confidence)
  // 2. Overture num_floors — aggregates OSM + ML sources (high confidence)
  // 3. Measured height — Mapbox/Overture height ÷ 3.5m per floor (reliable when available)
  // 4. prop.stories — Smarty/Parcl property records from tax assessor (reliable)
  // 5. SV story count — automated image analysis, only trusted above 0.5 confidence
  const heightForFloors = prop.mapboxHeight ?? prop.overtureHeight;
  let heightDerivedFloors = (heightForFloors && heightForFloors > 0)
    ? Math.max(1, Math.round(heightForFloors / 3.5))
    : undefined;
  // Mapbox/Overture height includes roof peak. When Solar pitch is available,
  // subtract estimated roof height to get wall-only height for floor count.
  // A 1-story ranch with 35° pitch and 15m span has ~5m of roof in the height.
  if (heightDerivedFloors && heightDerivedFloors > 1 && heightForFloors
      && prop.solarRoofPitch != null && prop.solarRoofPitch > 10) {
    // Estimate roof peak height from pitch and building half-span (use sqft as proxy)
    const estSpan = prop.osmWidth ?? prop.osmLength
      ?? (prop.sqft ? Math.sqrt(prop.sqft / 10.76) : undefined);
    if (estSpan) {
      const roofPeakM = Math.tan(prop.solarRoofPitch * Math.PI / 180) * (estSpan / 2);
      const wallHeight = heightForFloors - roofPeakM;
      if (wallHeight > 0) {
        heightDerivedFloors = Math.max(1, Math.round(wallHeight / 3.5));
      }
    }
  }
  // Cross-reference: when property records (tax assessor) disagree with
  // height-derived floors, cap based on confidence in tax data. Height data
  // includes roof peak and terrain slope artifacts that inflate the estimate.
  // For single-family homes with stories=1, trust the assessor exactly —
  // the height likely includes steep roof, attic, or vaulted ceilings.
  if (heightDerivedFloors && prop.stories && heightDerivedFloors > prop.stories) {
    const isSingleFamily = prop.propertyType === 'SINGLE_FAMILY'
      || prop.propertyType === 'house'
      || prop.propertyType === 'CONDO';
    const storiesCap = (isSingleFamily && prop.stories <= 2)
      ? prop.stories        // Trust assessor exactly for 1-2 story single-family
      : prop.stories + 1;   // Allow +1 tolerance for taller/complex buildings
    if (heightDerivedFloors > storiesCap) {
      heightDerivedFloors = storiesCap;
    }
  }
  // Only trust SV story count when confidence exceeds threshold
  const svStoriesIfConfident = (prop.svStoryConfidence ?? 0) > 0.5
    ? prop.svStoryCount : undefined;
  let effectiveStories = prop.osmLevels
    ?? prop.overtureFloors
    ?? heightDerivedFloors
    ?? prop.stories
    ?? svStoriesIfConfident;
  // Safety check: when height is available and significantly disagrees with the
  // chosen floor count, prefer height (catches sqft-derived outliers for landmarks)
  if (heightDerivedFloors && prop.osmWidth && prop.osmLength) {
    const footprintSqm = prop.osmWidth * prop.osmLength;
    const impliedSqm = prop.sqft / 10.76;
    if (footprintSqm > impliedSqm * 5 && heightDerivedFloors > effectiveStories) {
      effectiveStories = heightDerivedFloors;
    }
  }
  const floors = Math.max(minFloors, Math.min(maxFloors, effectiveStories));

  // ── Dimensions ────────────────────────────────────────────────────
  // Priority: OSM footprint (real) > satellite footprint > Solar area > sqft estimate
  let width: number;
  let length: number;

  if (prop.osmWidth && prop.osmLength) {
    // Priority 1: OSM polygon (real building footprint from OpenStreetMap)
    width = prop.osmWidth;
    length = prop.osmLength;
  } else if (
    prop.satFootprintWidth && prop.satFootprintLength &&
    (prop.satFootprintConfidence ?? 0) >= 0.6
  ) {
    // Priority 2: Satellite image footprint extraction (meters → blocks ≈ 1:1)
    width = Math.round(prop.satFootprintWidth);
    length = Math.round(prop.satFootprintLength);
  } else if (prop.solarBuildingArea && prop.solarBuildingArea > 0) {
    // Priority 3: Google Solar footprint area (sqm → blocks, 1 block ≈ 1m)
    // Solar API provides accurate footprint area from aerial imagery but no shape,
    // so we derive width/length using the aspect ratio hint
    const aspectRatio = prop.floorPlan?.aspectRatio ?? 1.3;
    width = Math.round(Math.sqrt(prop.solarBuildingArea * aspectRatio));
    length = Math.round(Math.sqrt(prop.solarBuildingArea / aspectRatio));
  } else {
    // Priority 4: Estimate from sqft + floor count
    const areaPerFloor = prop.sqft / floors / 10.76;
    const aspectRatio = prop.floorPlan?.aspectRatio ?? 1.3;
    width = Math.round(Math.sqrt(areaPerFloor * aspectRatio));
    length = Math.round(Math.sqrt(areaPerFloor / aspectRatio));
  }

  // Type-aware dimension limits — larger allowance for mansions/estates
  const limits = getDimensionLimits(prop.propertyType, prop.sqft);
  width = Math.max(limits.minW, Math.min(limits.maxW, width));
  length = Math.max(limits.minL, Math.min(limits.maxL, length));

  // Clamp aspect ratio — wider limit when OSM provides measured footprint,
  // since real buildings like Charleston "single houses" reach 3:1 ratios.
  const maxAspect = (prop.osmWidth && prop.osmLength) ? 3 : 2;
  const ratio = width / length;
  if (ratio > maxAspect) {
    width = Math.round(length * maxAspect);
  } else if (ratio < 1 / maxAspect) {
    length = Math.round(width * maxAspect);
  }

  // ── Rooms ─────────────────────────────────────────────────────────
  const rooms: RoomType[] = ['foyer', 'living', 'kitchen', 'dining'];
  for (let i = 0; i < Math.min(prop.bedrooms, 8); i++) rooms.push('bedroom');
  for (let i = 0; i < Math.min(prop.bathrooms, 6); i++) rooms.push('bathroom');

  if (prop.sqft > 2500) rooms.push('study', 'laundry', 'mudroom');
  if (prop.sqft > 3500) rooms.push('library', 'sunroom', 'pantry');

  // Auto-add garage if property data indicates one
  if (prop.hasGarage) rooms.push('garage');

  // ── Roof shape ────────────────────────────────────────────────────
  // Priority: OSM > Overture > Smarty > VLM visual > Solar segments > SV pitch > Solar pitch
  // When no data source provides a roof shape, leave undefined so gen-house.ts
  // uses style.defaultRoofShape (which is tuned per style) instead of a hard 'gable' fallback.
  const vlmRoofShape = mapVlmRoofShape(prop.svVlmRoofShape);
  let roofShape: RoofShape | undefined = mapOSMRoofToShape(prop.osmRoofShape)
    ?? mapOSMRoofToShape(prop.overtureRoofShape)
    ?? inferRoofFromSmartyFrame(prop.roofFrame)
    ?? vlmRoofShape
    ?? inferRoofFromSolar(prop.solarRoofSegments, prop.solarRoofPitch)
    ?? inferRoofFromSVPitch(prop.svRoofPitch)
    ?? inferRoofFromPitchOnly(prop.solarRoofPitch);

  // Multi-unit buildings are overwhelmingly flat-roofed — but only override
  // when no strong pitch evidence contradicts it (e.g. Solar pitch > 15° is
  // clearly a pitched roof, even on a "multi-unit" heuristic classification)
  if (effectiveMultiUnit && !prop.osmRoofShape) {
    const hasPitchedEvidence = (prop.solarRoofPitch != null && prop.solarRoofPitch > 15);
    if (!hasPitchedEvidence) {
      roofShape = 'flat';
    }
  }

  // ── Roof material override ────────────────────────────────────────
  // Priority: OSM roof material/colour > Smarty roofType > VLM roof material > SV color > style default
  const roofOverride = mapRoofMaterialToBlocks(prop.osmRoofMaterial, prop.osmRoofColour)
    ?? mapSmartyRoofTypeToBlocks(prop.roofType)
    ?? mapSmartyRoofTypeToBlocks(prop.svRoofMaterial)  // VLM roof material (reuses Smarty mapper)
    ?? prop.svRoofOverride;

  // ── Wall override ───────────────────────────────────────────────
  // Priority chain (first non-null wins):
  //   1. Smarty exterior / pre-resolved override (assessor data)
  //   2. OSM building:colour (explicit hex color → CIE-Lab nearest block)
  //   3. OSM building:material tag (community-mapped material name)
  //   4. Smarty construction type (assessor secondary)
  //   5. Street View color analysis
  //   6. Street View texture classification
  //   7. Satellite imagery detected color (automatic, lowest confidence)
  const rawWall = prop.wallOverride
    ?? hexToWallBlock(prop.osmBuildingColour ?? '')
    ?? mapOSMMaterialToWall(prop.osmMaterial)
    ?? mapConstructionTypeToWall(prop.constructionType)
    ?? prop.svWallOverride
    ?? mapOSMMaterialToWall(prop.svWallMaterial)  // VLM wall material (reuses OSM mapper)
    ?? prop.svTextureBlock
    ?? (prop.detectedColor
      ? rgbToWallBlock(prop.detectedColor.r, prop.detectedColor.g, prop.detectedColor.b)
      : undefined);
  // Apply year-based material aging (pre-1920 → weathered, post-2000 → modern)
  const agedWall = applyYearBasedWallAging(rawWall, prop.yearBuilt);
  // Apply climate-specific adjustments (hot → lighter, cold → darker/sturdier)
  const climate = inferClimateZone(prop.stateAbbreviation, prop.hardinessZone);
  const climaticWall = applyClimateMaterials(agedWall, climate);
  // Apply assessed value tier (high → polished, low → basic)
  const wallOverride = applyValueTierMaterials(climaticWall, prop.assessedValue);

  // ── Door override ─────────────────────────────────────────────────
  // Priority: architecture-type inference > SV vision > style/era
  const doorOverride = inferDoorType(
    prop.osmArchitecture ?? prop.architectureType ?? prop.svArchitectureStyle ?? prop.svArchitectureLabel,
    style,
    prop.yearBuilt
  ) ?? prop.svDoorOverride;

  // ── Trim override ─────────────────────────────────────────────────
  // Priority: OSM building:colour > SV color > style default
  const trimOverride = prop.osmBuildingColour
    ? hexToTrimBlock(prop.osmBuildingColour)
    : prop.svTrimOverride;

  // ── Feature flags ─────────────────────────────────────────────────
  // Priority: inferFeatures (Smarty/Mapillary) > SV vision > SV setback > defaults
  const features = inferFeatures(prop);
  // Boolean-only feature keys for safe merging (excludes foundationType, etc.)
  const boolKeys: (keyof FeatureFlags)[] = [
    'chimney', 'porch', 'backyard', 'driveway', 'fence', 'trees', 'garden', 'pool', 'deck',
  ];
  // Merge SV setback-derived features (lower priority — don't override existing)
  if (prop.svSetbackFeatures) {
    for (const k of boolKeys) {
      if (features[k] === undefined && prop.svSetbackFeatures[k]) {
        (features as Record<string, unknown>)[k] = prop.svSetbackFeatures[k];
      }
    }
  }
  // Merge SV vision features (lower priority than Smarty/Mapillary but higher than setback)
  if (prop.svFeatures) {
    for (const k of boolKeys) {
      if (features[k] === undefined && prop.svFeatures[k]) {
        (features as Record<string, unknown>)[k] = prop.svFeatures[k];
      }
    }
  }

  // ── Roof height override ────────────────────────────────────────
  // Priority: Solar API pitch > Solar area-derived pitch > SV pitch > style default
  let roofHeightOverride: number | undefined;
  let solarPitch = prop.solarRoofPitch;

  // If pitch is unknown, estimate from roof area vs footprint area.
  // cos(angle) = footprintArea / roofSurfaceArea for a simple sloped roof.
  if (solarPitch == null && prop.solarRoofArea && prop.solarBuildingArea
    && prop.solarRoofArea > prop.solarBuildingArea) {
    const ratio = prop.solarBuildingArea / prop.solarRoofArea;
    const pitchRadians = Math.acos(Math.min(1, ratio));
    solarPitch = pitchRadians * 180 / Math.PI;
  }

  if (solarPitch != null && solarPitch > 0) {
    // Use tangent of pitch angle × half building width for realistic peak height
    const halfSpan = Math.min(width, length) / 2;
    const pitchRad = solarPitch * Math.PI / 180;
    const tangentHeight = Math.round(Math.tan(pitchRad) * halfSpan);
    // Cap with proportional limit (Arnis: ln(area × 0.15 + 3)) and absolute max
    const proportionalCap = Math.round(Math.log(width * length * 0.15 + 3));
    roofHeightOverride = Math.max(2, Math.min(tangentHeight, proportionalCap, 14));
  } else if (prop.svRoofHeightOverride != null) {
    // SV pitch analysis gives a ratio (0.3/0.5/0.8) — convert to block count
    roofHeightOverride = Math.round(prop.svRoofHeightOverride * 14);
  }

  // ── Window spacing from SV fenestration ─────────────────────────
  // Priority: direct svWindowSpacing > derived from svWindowsPerFloor + width
  let windowSpacing = prop.svWindowSpacing;
  if (windowSpacing === undefined && prop.svWindowsPerFloor && prop.svWindowsPerFloor > 0) {
    // Estimate spacing from window count and facade width — add 1 to windows
    // to account for spacing at both ends of the facade
    const calculatedSpacing = Math.floor(width / (prop.svWindowsPerFloor + 1));
    // Clamp to expected range (2=dense, 5=sparse)
    windowSpacing = Math.max(2, Math.min(5, calculatedSpacing));
  }

  // ── Floor plan shape + footprint bitmap ─────────────────────────
  // Priority: bitmap classification > OSM polygon heuristic > SV plan shape > SV symmetry hint
  // A symmetric facade strongly suggests a simple rectangular floor plan
  let floorPlanShape = prop.floorPlanShape ?? prop.svPlanShape ?? (prop.svSymmetric ? 'rect' as const : undefined);

  // Rasterize OSM polygon into a block-level bitmap for pixel-perfect footprints.
  // For multipolygon buildings, subtract inner rings (courtyards) from the outer ring.
  let footprintBitmap: import('../gen/coordinate-bitmap.js').CoordinateBitmap | undefined;
  if (prop.osmPolygon && prop.osmPolygon.length >= 4) {
    footprintBitmap = polygonToBitmap(prop.osmPolygon) ?? undefined;
    if (footprintBitmap && prop.osmInnerPolygons && prop.osmInnerPolygons.length > 0) {
      subtractInnerRings(footprintBitmap, prop.osmInnerPolygons);
    }
    // Bitmap-based shape classification is more accurate than vertex-count heuristics
    if (footprintBitmap) {
      floorPlanShape = classifyBitmapShape(footprintBitmap);
    }
  }

  // Enforce rect for very small footprints — L/T shapes on tiny buildings look awkward
  // (e.g. a 10x10 L produces a disjointed tower). The generator can't fit meaningful
  // wing proportions below ~120 blocks² regardless of the data source.
  if (floorPlanShape && floorPlanShape !== 'rect' && width * length < 120) {
    floorPlanShape = 'rect';
  }

  // ── Architecture style integration ──────────────────────────────
  // If SV vision gave us an architecture label, feed it into the existing style chain
  // (already handled above via doorOverride — svArchitectureLabel used in resolveStyle)

  // ── Facade orientation from Street View heading / Solar azimuth ────
  // Snap heading to nearest 90° for grid rotation. Default 0 = front faces south.
  // SV heading = compass direction FROM camera TO building, which equals the direction
  // the building's front face points away from (toward the street/camera).
  // heading ~0° (N) → front faces south → 0°; ~90° (E) → front faces west → 90° CW; etc.
  let orientation: 0 | 90 | 180 | 270 = 0;
  const rawHeading = prop.streetViewHeading ?? prop.solarAzimuthDegrees;
  if (rawHeading != null) {
    const snapped = Math.round(rawHeading / 90) % 4;
    orientation = (snapped * 90) as 0 | 90 | 180 | 270;
  }

  // ── Data-driven palette resolution ──────────────────────────────
  // When style is 'auto' (real address), use the material resolver to produce
  // a full palette from observed data (SV colors, OSM tags, assessor records).
  // This bypasses the fantasy preset system — materials come from reality.
  const addressSeed = fnv1aHash(prop.address + (prop.parclPropertyId ? `#${prop.parclPropertyId}` : ''));
  let resolvedPalette: import('./styles.js').StylePalette | undefined;

  if (prop.style === 'auto') {
    const category = inferCategory(prop.propertyType);
    resolvedPalette = resolvePalette(prop, category, addressSeed);

    // Apply roof shape to palette structural profile
    if (roofShape) resolvedPalette.defaultRoofShape = roofShape;
    if (roofHeightOverride) resolvedPalette.roofHeight = roofHeightOverride;
    if (floorPlanShape) resolvedPalette.defaultPlanShape = floorPlanShape;

    // Season-aware overrides
    if (prop.season === 'snow') resolvedPalette.roofCap = 'minecraft:snow_block';
  }

  // ── Environmental landscape data ─────────────────────────────────
  // Build landscape from Phase 5 APIs (hardiness zone, canopy, water, land cover)
  const landscape = buildLandscape(prop);

  return {
    type,
    floors,
    style,
    rooms,
    width,
    length,
    seed: addressSeed,
    // When resolvedPalette is set, these overrides are redundant (already baked in)
    // but we keep them for the legacy path (user-selected fantasy preset)
    wallOverride: resolvedPalette ? undefined : wallOverride,
    trimOverride: resolvedPalette ? undefined : trimOverride,
    doorOverride: resolvedPalette ? undefined : doorOverride,
    roofShape,
    roofOverride: resolvedPalette ? undefined : roofOverride,
    features,
    floorPlanShape,
    roofHeightOverride,
    windowSpacing,
    season: prop.season,
    footprintBitmap,
    orientation,
    resolvedPalette,
    landscape,
  };
}
