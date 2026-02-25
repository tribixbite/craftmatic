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

import { ROOF_PALETTE, rgbToTrimBlock as rgbToTrimBlockShared } from './color-blocks.js';

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
  /** Architecture style label from vision analysis */
  svArchitectureLabel?: string;
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

/** Infer architectural style from year built + new construction flag */
export function inferStyle(year: number, newConstruction = false): StyleName {
  if (newConstruction || year >= 2010) return 'modern';
  if (year < 1700) return 'medieval';
  if (year < 1850) return 'gothic';
  if (year < 1890) return 'rustic';   // Victorian-era wood-frame (pre-Colonial Revival)
  if (year < 1970) return 'fantasy';  // Colonial Revival, Foursquare, mid-century — formal trim
  return 'modern';
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
    [/\bcolonial|georgian|federal|cape\s*cod/i, 'colonial'],
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
  propertyType: string, year: number
): StyleName | undefined {
  const pt = propertyType.toLowerCase();

  // Multi-family apartments: boxy, flat/low-pitch roofs, stucco or brick
  if (/multi_family|apartment/.test(pt)) {
    if (year >= 1970) return 'modern';     // Modern apartment buildings
    if (year >= 1920) return 'desert';      // Pre-war low-rise (stucco, flat roof like SF Marina)
    return 'gothic';                         // Pre-1920 tenement/brownstone
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
 * Priority: user selection > OSM architecture > Smarty architecture > propertyType > city > county > year
 */
export function resolveStyle(prop: PropertyData): StyleName {
  if (prop.style !== 'auto') return prop.style;
  // When year is uncertain, use actual yearBuilt for upstream signals but
  // fall back to 'rustic' instead of year-based inference — most US homes
  // with missing dates are pre-war wood-frame construction
  const year = prop.yearBuilt;
  const archStyle = mapArchitectureToStyle(prop.osmArchitecture)
    ?? mapArchitectureToStyle(prop.architectureType)
    ?? mapArchitectureToStyle(prop.svArchitectureLabel);
  const propTypeStyle = inferStyleFromPropertyType(prop.propertyType, year);
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
    const formalRoad = /\b(st|ave|blvd|dr|ct|pl|sq|way)\b/i.test(prop.address);
    // Large NE estates (>= 6000 sqft) with uncertain year are likely Victorian/Queen Anne,
    // not Colonial — Colonials are typically under 5000 sqft
    if (ne && prop.sqft >= 6000) return 'fantasy';
    if (ne && formalRoad) return 'colonial'; // White clapboard Colonial/Federal
    if (density === 'suburban' && prop.sqft >= 6000) return 'fantasy';
    if (density === 'suburban' && formalRoad) return 'colonial';
    return 'rustic';
  };
  const fallback = prop.yearUncertain ? uncertainFallback() : inferStyle(year, prop.newConstruction);
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
  if (segments <= 1 && (pitch == null || pitch < 15)) return 'flat';
  if (segments === 2) return 'gable';
  if (segments >= 3 && segments <= 5) return 'hip';
  if (segments >= 6) return 'gambrel'; // complex multi-segment → gambrel approximation
  return undefined;
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
  if (/\bwood|timber|log/i.test(m)) return 'minecraft:oak_planks';
  if (/\bconcrete|cement/i.test(m)) return 'minecraft:smooth_stone';
  if (/\bglass|curtain/i.test(m)) return 'minecraft:light_blue_stained_glass';
  if (/\bstucco|plaster|render/i.test(m)) return 'minecraft:smooth_quartz';
  if (/\bmetal|steel|aluminum/i.test(m)) return 'minecraft:iron_block';
  if (/\bcob|adobe/i.test(m)) return 'minecraft:mud_bricks';
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
 * Delegates to shared palette in color-blocks.ts.
 */
function hexToTrimBlock(hex: string): BlockState | undefined {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return undefined;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return rgbToTrimBlockShared(r, g, b);
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

  // ── Smarty assessor overrides (highest confidence — from county records) ──
  if (prop.smartyHasPool) flags.pool = true;
  if (prop.smartyHasFence) flags.fence = true;
  if (prop.smartyHasPorch) flags.porch = true;
  if (prop.drivewayType) flags.driveway = true;
  if (prop.hasFireplace) flags.chimney = true;
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
    // Colonial homes always have porches; fantasy pre-1950 also typically do
    if (effectiveStyle === 'colonial') {
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

  // ── Floor clamping ───────────────────────────────────────────────
  // Clamp floors to realistic per-type limits to prevent inflated story counts
  const effectiveMultiUnit = isMultiUnit(prop.propertyType) || isMapboxMultiUnit;
  const maxFloors = effectiveMultiUnit ? 8
    : prop.sqft > 10000 ? 5   // large mansions (e.g. Winchester)
    : 4;                        // standard single-family
  // Minimum floors for large single-family — a 5000+ sqft house is always 2+ stories,
  // and 6000+ sqft is virtually always 3 stories (Victorian estates, colonials, etc.)
  const minFloors = !effectiveMultiUnit && prop.sqft >= 6000 ? 3
    : !effectiveMultiUnit && prop.sqft >= 3000 ? 2
    : 1;
  const floors = Math.max(minFloors, Math.min(maxFloors, prop.stories));

  // ── Dimensions ────────────────────────────────────────────────────
  // Priority: OSM footprint (real) > sqft estimate
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
  } else {
    // Priority 3: Estimate from sqft + floor count
    const areaPerFloor = prop.sqft / floors / 10.76;
    const aspectRatio = prop.floorPlan?.aspectRatio ?? 1.3;
    width = Math.round(Math.sqrt(areaPerFloor * aspectRatio));
    length = Math.round(Math.sqrt(areaPerFloor / aspectRatio));
  }

  // Type-aware dimension limits — larger allowance for mansions/estates
  const limits = getDimensionLimits(prop.propertyType, prop.sqft);
  width = Math.max(limits.minW, Math.min(limits.maxW, width));
  length = Math.max(limits.minL, Math.min(limits.maxL, length));

  // Clamp aspect ratio to max 2:1 to avoid elongated "longhouse" shapes.
  // Real residential buildings rarely exceed 2:1 aspect ratio.
  const ratio = width / length;
  if (ratio > 2) {
    width = Math.round(length * 2);
  } else if (ratio < 0.5) {
    length = Math.round(width * 2);
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
  // Priority: OSM roof:shape > Smarty roofFrame > Solar segments > style-default > gable
  let roofShape: RoofShape = mapOSMRoofToShape(prop.osmRoofShape)
    ?? inferRoofFromSmartyFrame(prop.roofFrame)
    ?? inferRoofFromSolar(prop.solarRoofSegments, prop.solarRoofPitch)
    ?? (style === 'modern' ? 'flat' : style === 'gothic' ? 'mansard' : 'gable');

  // Multi-unit buildings are overwhelmingly flat-roofed
  if (effectiveMultiUnit && !prop.osmRoofShape) {
    roofShape = 'flat';
  }

  // ── Roof material override ────────────────────────────────────────
  // Priority: OSM roof material/colour > Smarty roofType > SV color > style default
  const roofOverride = mapRoofMaterialToBlocks(prop.osmRoofMaterial, prop.osmRoofColour)
    ?? mapSmartyRoofTypeToBlocks(prop.roofType)
    ?? prop.svRoofOverride;

  // ── Wall override ───────────────────────────────────────────────
  // Priority: Smarty exteriorType / satellite > OSM material > construction type > SV color > SV texture > style
  // prop.wallOverride is already set by the satellite/Smarty chain in CLI
  const rawWall = prop.wallOverride
    ?? mapOSMMaterialToWall(prop.osmMaterial)
    ?? mapConstructionTypeToWall(prop.constructionType)
    ?? prop.svWallOverride
    ?? prop.svTextureBlock;
  // Apply year-based material aging (pre-1920 → weathered, post-2000 → modern)
  const wallOverride = applyYearBasedWallAging(rawWall, prop.yearBuilt);

  // ── Door override ─────────────────────────────────────────────────
  // Priority: architecture-type inference > SV vision > style/era
  const doorOverride = inferDoorType(
    prop.osmArchitecture ?? prop.architectureType ?? prop.svArchitectureLabel,
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
  // Priority: Solar API pitch > SV pitch analysis > style default
  let roofHeightOverride: number | undefined;
  if (prop.solarRoofPitch != null && prop.solarRoofPitch > 0) {
    if (prop.solarRoofPitch < 15) roofHeightOverride = 4;       // nearly flat
    else if (prop.solarRoofPitch < 30) roofHeightOverride = 8;  // moderate pitch
    else if (prop.solarRoofPitch < 45) roofHeightOverride = 12; // steep
    else roofHeightOverride = 14;                                // very steep
  } else if (prop.svRoofHeightOverride != null) {
    // SV pitch analysis gives a ratio (0.3/0.5/0.8) — convert to block count
    roofHeightOverride = Math.round(prop.svRoofHeightOverride * 14);
  }

  // ── Window spacing from SV fenestration ─────────────────────────
  const windowSpacing = prop.svWindowSpacing;

  // ── Floor plan shape ────────────────────────────────────────────
  // Priority: OSM polygon > SV symmetry > undefined (generator default)
  const floorPlanShape = prop.floorPlanShape ?? prop.svPlanShape;

  // ── Architecture style integration ──────────────────────────────
  // If SV vision gave us an architecture label, feed it into the existing style chain
  // (already handled above via doorOverride — svArchitectureLabel used in resolveStyle)

  // TODO: Street View heading → facade orientation (Phase 1.6)
  // prop.streetViewHeading (0-360°) tells us which direction the camera faces toward
  // the building. Mapping heading → cardinal direction for door placement requires
  // generator support for orientation (currently door is always south-facing).

  return {
    type,
    floors,
    style,
    rooms,
    width,
    length,
    // Include parclPropertyId in seed for better per-property reproducibility
    seed: fnv1aHash(prop.address + (prop.parclPropertyId ? `#${prop.parclPropertyId}` : '')),
    wallOverride,
    trimOverride,
    doorOverride,
    roofShape,
    roofOverride,
    features,
    floorPlanShape,
    roofHeightOverride,
    windowSpacing,
    season: prop.season,
  };
}
