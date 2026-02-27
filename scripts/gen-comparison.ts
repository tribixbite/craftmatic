#!/usr/bin/env bun
/**
 * Regenerate comparison images using ALL available API sources.
 * Outputs per-address JSON with full API data tracking + rendered images.
 * Generates 3 tiers per address: noapi / someapis (Parcl+OSM+Mapillary) / allapis.
 *
 * Usage: bun scripts/gen-comparison.ts
 */

// Load .env file
import { readFileSync } from 'fs';
import { resolve } from 'path';
try {
  const envPath = resolve(import.meta.dir, '../.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      process.env[trimmed.substring(0, eq)] = trimmed.substring(eq + 1);
    }
  }
} catch { /* .env optional */ }

import { analyzeStreetView, type StreetViewAnalysis } from '../src/gen/api/streetview-analysis.js';
import { generateStructure } from '../src/gen/generator.js';
import {
  convertToGenerationOptions, estimateStoriesFromFootprint,
  type PropertyData,
} from '../src/gen/address-pipeline.js';
import { geocodeAddress } from '../src/gen/api/geocoder.js';
import { searchParclProperty, mapParclPropertyType, hasParclApiKey } from '../src/gen/api/parcl.js';
import { searchOSMBuilding, type OSMBuildingData } from '../src/gen/api/osm.js';
import { queryStreetViewMetadata, hasGoogleStreetViewKey, type StreetViewMetadata } from '../src/gen/api/google-streetview.js';
import { queryMapboxBuilding, hasMapboxApiKey, type MapboxBuildingData } from '../src/gen/api/mapbox.js';
import { querySolarBuildingInsights, hasGoogleApiKey, type SolarBuildingData } from '../src/gen/api/google-solar.js';
import {
  searchMapillaryImages, searchMapillaryFeatures, pickBestImage, analyzeFeatures,
  hasMapillaryApiKey, getMapillaryApiKey,
  type MapillaryImageData,
} from '../src/gen/api/mapillary.js';
import { renderFloorDetail, renderCutawayIso, renderExterior } from '../src/render/png-renderer.js';
// Phase 5 P1 modules — browser-compatible pure-fetch modules imported from web/src/ui
import { queryNlcdCanopy } from '../web/src/ui/import-nlcd.js';
import { queryHardinessZone } from '../web/src/ui/import-hardiness.js';
import { searchOSMTrees } from '../web/src/ui/import-osm-trees.js';
import { queryOvertureBuilding } from '../web/src/ui/import-overture.js';
import { searchWaterFeatures } from '../web/src/ui/import-water.js';
import { queryCanopyHeight } from '../web/src/ui/import-canopy-height.js';
import { queryLandCover } from '../web/src/ui/import-landcover.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import type { GenerationOptions } from '../src/types/index.js';

// Use import.meta.dir to resolve paths relative to the project root,
// not bun's tmp working directory
const PROJECT_ROOT = resolve(import.meta.dir, '..');
const OUT_DIR = join(PROJECT_ROOT, 'output/comparison');
const WEB_DIR = join(PROJECT_ROOT, 'web/public/comparison');

/** Skip image rendering (--json-only flag) — useful on memory-constrained devices */
const JSON_ONLY = process.argv.includes('--json-only');

/** Only process specific addresses (--only=key1,key2) — useful for incremental runs */
const ONLY_KEYS = (() => {
  const arg = process.argv.find(a => a.startsWith('--only='));
  return arg ? arg.slice(7).split(',') : null;
})();

// ─── All 14 comparison addresses ─────────────────────────────────────────────

const ADDRESSES = [
  { key: 'sf', address: '2340 Francisco St, San Francisco, CA 94123' },
  { key: 'newton', address: '240 Highland St, Newton, MA 02465' },
  { key: 'sanjose', address: '525 S Winchester Blvd, San Jose, CA 95128' },
  { key: 'walpole', address: '13 Union St, Walpole, NH 03608' },
  { key: 'byron', address: '2431 72nd St SW, Byron Center, MI 49315' },
  { key: 'vinalhaven', address: '216 Zekes Point Rd, Vinalhaven, ME 04863' },
  { key: 'suttonsbay', address: '5835 S Bridget Rose Ln, Suttons Bay, MI 49682' },
  { key: 'losangeles', address: '2607 Glendower Ave, Los Angeles, CA 90027' },
  { key: 'seattle', address: '4810 SW Ledroit Pl, Seattle, WA 98136' },
  // ── 5 new addresses (batch 2) ──
  { key: 'austin', address: '8504 Long Canyon Dr, Austin, TX 78730' },
  { key: 'denver', address: '433 S Xavier St, Denver, CO 80219' },
  { key: 'minneapolis', address: '2730 Ulysses St NE, Minneapolis, MN 55418' },
  { key: 'charleston', address: '41 Legare St, Charleston, SC 29401' },
  { key: 'tucson', address: '2615 E Adams St, Tucson, AZ 85716' },
];

const TIERS = ['noapi', 'someapis', 'allapis', 'enriched'] as const;
type Tier = typeof TIERS[number];

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApiRecord {
  name: string;
  available: boolean;
  status: 'ok' | 'error' | 'skipped' | 'unavailable';
  error?: string;
  data: Record<string, unknown>;
  fieldsSet: string[];
  impactedGenFields: string[];
}

interface TierResult {
  tier: Tier;
  property: Partial<PropertyData>;
  genOptions: Partial<GenerationOptions>;
  grid: { width: number; height: number; depth: number; blocks: number };
  views: { exterior: string; cutaway: string[]; floor: string[] };
}

interface ComparisonResult {
  key: string;
  address: string;
  apis: ApiRecord[];
  tiers: TierResult[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function toJpeg(pngBuf: Buffer): Promise<Buffer> {
  return sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
}

function mc(block: string): string {
  return block?.replace('minecraft:', '') ?? '';
}

/** Delay helper for API rate limiting */
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Check available APIs ────────────────────────────────────────────────────

const apiStatus = {
  parcl: hasParclApiKey(),
  osm: true,
  streetview: hasGoogleStreetViewKey(),
  solar: hasGoogleApiKey(),
  mapbox: hasMapboxApiKey(),
  mapillary: hasMapillaryApiKey(),
};

console.log('API availability:');
for (const [name, ok] of Object.entries(apiStatus)) {
  console.log(`  ${ok ? '+' : '-'} ${name}`);
}

await mkdir(OUT_DIR, { recursive: true });
await mkdir(WEB_DIR, { recursive: true });

const allResults: ComparisonResult[] = [];

const addressesToProcess = ONLY_KEYS
  ? ADDRESSES.filter(a => ONLY_KEYS.includes(a.key))
  : ADDRESSES;

if (ONLY_KEYS) console.log(`\nFiltering to: ${addressesToProcess.map(a => a.key).join(', ')}`);

for (const { key, address } of addressesToProcess) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${key}: ${address}`);
  console.log(`${'='.repeat(60)}`);

  const apis: ApiRecord[] = [];

  // ── Step 0: Geocode ──────────────────────────────────────────────────────
  let lat = 0, lng = 0;

  // Step 1: Parcl (also provides geocoding + property data)
  const parclRec: ApiRecord = {
    name: 'Parcl Labs', available: apiStatus.parcl, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  const parcl = apiStatus.parcl ? await searchParclProperty(address) : null;
  if (parcl) {
    parclRec.status = 'ok';
    parclRec.data = {
      sqft: parcl.squareFootage, bedrooms: parcl.bedrooms, bathrooms: parcl.bathrooms,
      yearBuilt: parcl.yearBuilt, propertyType: parcl.propertyType,
      lat: parcl.latitude, lng: parcl.longitude,
      city: parcl.city, state: parcl.stateAbbreviation,
    };
    parclRec.fieldsSet = ['sqft', 'bedrooms', 'bathrooms', 'yearBuilt', 'propertyType', 'city', 'stateAbbreviation', 'county', 'zipCode'];
    parclRec.impactedGenFields = ['floors', 'rooms', 'width', 'length', 'style', 'seed'];
    lat = parcl.latitude;
    lng = parcl.longitude;
    console.log(`  Parcl: ${parcl.squareFootage} sqft, ${parcl.bedrooms}bd/${parcl.bathrooms}ba, yr=${parcl.yearBuilt}`);
  } else {
    parclRec.status = apiStatus.parcl ? 'error' : 'unavailable';
    parclRec.error = apiStatus.parcl ? 'Address not found' : 'PARCL_API_KEY not set';
    console.log(`  Parcl: ${parclRec.error}`);
    // Fallback geocoding via Census Bureau
    try {
      const geo = await geocodeAddress(address);
      lat = geo.lat;
      lng = geo.lng;
      console.log(`  Geocode fallback: ${lat.toFixed(5)}, ${lng.toFixed(5)} (${geo.source})`);
    } catch (err) {
      console.log(`  Cannot geocode "${address}", skipping`);
      apis.push(parclRec);
      continue;
    }
  }
  apis.push(parclRec);

  // ── Step 2: OSM ──────────────────────────────────────────────────────────
  const osmRec: ApiRecord = {
    name: 'OpenStreetMap', available: true, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let osmData: OSMBuildingData | null = null;
  try {
    console.log('  OSM: querying Overpass...');
    osmData = await searchOSMBuilding(lat, lng);
  } catch (err) {
    osmRec.status = 'error';
    osmRec.error = String(err);
    console.log(`  OSM: error — ${err}`);
  }
  if (osmData) {
    osmRec.status = 'ok';
    osmRec.data = {
      width: osmData.widthMeters?.toFixed(1) + 'm',
      length: osmData.lengthMeters?.toFixed(1) + 'm',
      footprint: osmData.footprintAreaSqm?.toFixed(0) + ' sqm',
      levels: osmData.levels,
      material: osmData.material,
      roofShape: osmData.roofShape,
      roofMaterial: osmData.roofMaterial,
      roofColour: osmData.roofColour,
      buildingColour: osmData.buildingColour,
      polygonVertices: osmData.polygon?.length,
    };
    osmRec.fieldsSet = ['osmWidth', 'osmLength', 'osmLevels', 'osmMaterial', 'osmRoofShape', 'osmRoofMaterial', 'osmRoofColour', 'osmBuildingColour', 'osmArchitecture'];
    osmRec.impactedGenFields = ['width', 'length', 'floors', 'wallOverride', 'roofShape', 'roofOverride', 'trimOverride', 'floorPlanShape', 'style'];
    console.log(`  OSM: ${osmData.widthMeters?.toFixed(1)}x${osmData.lengthMeters?.toFixed(1)}m, levels=${osmData.levels || '?'}`);
  } else if (osmRec.status !== 'error') {
    osmRec.status = 'skipped';
    osmRec.error = 'No building found';
  }
  apis.push(osmRec);
  await delay(1000);

  // ── Step 3: Mapbox ───────────────────────────────────────────────────────
  const mapboxRec: ApiRecord = {
    name: 'Mapbox', available: apiStatus.mapbox, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let mapboxData: MapboxBuildingData | null = null;
  if (apiStatus.mapbox) {
    try {
      console.log('  Mapbox: querying building height...');
      mapboxData = await queryMapboxBuilding(lat, lng);
    } catch (err) {
      mapboxRec.status = 'error';
      mapboxRec.error = String(err);
    }
  } else {
    mapboxRec.status = 'unavailable';
    mapboxRec.error = 'MAPBOX_API_KEY not set';
  }
  if (mapboxData) {
    mapboxRec.status = 'ok';
    mapboxRec.data = {
      height: mapboxData.height + 'm', minHeight: mapboxData.minHeight + 'm',
      buildingType: mapboxData.buildingType, extrude: mapboxData.extrude,
      distance: mapboxData.distance?.toFixed(1) + 'm',
    };
    mapboxRec.fieldsSet = ['mapboxHeight', 'mapboxBuildingType'];
    mapboxRec.impactedGenFields = ['floors'];
    console.log(`  Mapbox: height=${mapboxData.height}m, type=${mapboxData.buildingType || '?'}`);
  } else if (mapboxRec.status === 'skipped') {
    mapboxRec.error = 'No building at coordinates';
  }
  apis.push(mapboxRec);

  // ── Step 4: Solar ────────────────────────────────────────────────────────
  const solarRec: ApiRecord = {
    name: 'Google Solar', available: apiStatus.solar, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let solarData: SolarBuildingData | null = null;
  if (apiStatus.solar) {
    try {
      console.log('  Solar: querying building insights...');
      solarData = await querySolarBuildingInsights(lat, lng);
    } catch (err) {
      solarRec.status = 'error';
      solarRec.error = String(err);
    }
  } else {
    solarRec.status = 'unavailable';
  }
  if (solarData) {
    solarRec.status = 'ok';
    solarRec.data = {
      roofPitch: solarData.primaryPitchDegrees?.toFixed(1) + '°',
      roofAzimuth: solarData.primaryAzimuthDegrees?.toFixed(0) + '°',
      roofSegments: solarData.roofSegmentCount,
      roofArea: solarData.totalRoofAreaSqm?.toFixed(0) + ' sqm',
      footprintArea: solarData.buildingFootprintAreaSqm?.toFixed(0) + ' sqm',
      planeHeight: solarData.primaryPlaneHeight?.toFixed(1) + 'm',
      imageryQuality: solarData.imageryQuality,
    };
    solarRec.fieldsSet = ['solarRoofPitch', 'solarRoofSegments', 'solarBuildingArea', 'solarRoofArea'];
    solarRec.impactedGenFields = ['roofShape', 'roofHeightOverride'];
    console.log(`  Solar: pitch=${solarData.primaryPitchDegrees?.toFixed(1)}° segments=${solarData.roofSegmentCount}`);
  }
  apis.push(solarRec);

  // ── Step 5: Mapillary ────────────────────────────────────────────────────
  const mapillaryRec: ApiRecord = {
    name: 'Mapillary', available: apiStatus.mapillary, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let bestImage: MapillaryImageData | null = null;
  let mapillaryFeatureResult: { hasDriveway: boolean; hasFence: boolean } | null = null;
  if (apiStatus.mapillary) {
    try {
      console.log('  Mapillary: searching...');
      const apiKey = getMapillaryApiKey();
      const [images, features] = await Promise.all([
        searchMapillaryImages(lat, lng, apiKey),
        searchMapillaryFeatures(lat, lng, apiKey),
      ]);
      if (images && images.length > 0) bestImage = pickBestImage(images, lat, lng);
      if (features && features.length > 0) mapillaryFeatureResult = analyzeFeatures(features);
      mapillaryRec.status = 'ok';
      mapillaryRec.data = {
        imagesFound: images?.length ?? 0,
        bestImageId: bestImage?.id,
        bestImageDate: bestImage ? new Date(bestImage.capturedAt).toISOString().slice(0, 10) : null,
        bestImageHeading: bestImage?.compassAngle?.toFixed(0) + '°',
        featuresFound: features?.length ?? 0,
        hasDriveway: mapillaryFeatureResult?.hasDriveway,
        hasFence: mapillaryFeatureResult?.hasFence,
      };
      if (bestImage) mapillaryRec.fieldsSet.push('mapillaryImageUrl', 'mapillaryHeading', 'mapillaryCaptureDate');
      if (mapillaryFeatureResult?.hasDriveway) {
        mapillaryRec.fieldsSet.push('mapillaryHasDriveway');
        mapillaryRec.impactedGenFields.push('features.driveway');
      }
      if (mapillaryFeatureResult?.hasFence) {
        mapillaryRec.fieldsSet.push('mapillaryHasFence');
        mapillaryRec.impactedGenFields.push('features.fence');
      }
      console.log(`  Mapillary: ${images?.length ?? 0} images, driveway=${mapillaryFeatureResult?.hasDriveway ?? '?'}`);
    } catch (err) {
      mapillaryRec.status = 'error';
      mapillaryRec.error = String(err);
    }
  } else {
    mapillaryRec.status = 'unavailable';
  }
  apis.push(mapillaryRec);

  // ── Step 6: Street View metadata ─────────────────────────────────────────
  const svMetaRec: ApiRecord = {
    name: 'Google Street View', available: apiStatus.streetview, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let svMeta: StreetViewMetadata | null = null;
  if (apiStatus.streetview) {
    try {
      svMeta = await queryStreetViewMetadata(lat, lng);
    } catch (err) {
      svMetaRec.status = 'error';
      svMetaRec.error = String(err);
    }
  } else {
    svMetaRec.status = 'unavailable';
  }
  if (svMeta) {
    svMetaRec.status = 'ok';
    svMetaRec.data = {
      panoId: svMeta.panoId, date: svMeta.date,
      heading: svMeta.heading?.toFixed(0) + '°',
      panoLat: svMeta.lat?.toFixed(5), panoLng: svMeta.lng?.toFixed(5),
    };
    svMetaRec.fieldsSet = ['streetViewUrl', 'streetViewDate', 'streetViewHeading'];
    console.log(`  SV: heading=${svMeta.heading?.toFixed(0)}° date=${svMeta.date || '?'}`);
  }
  apis.push(svMetaRec);

  // ── Step 7: SV Image Analysis ────────────────────────────────────────────
  const svAnalysisRec: ApiRecord = {
    name: 'SV Image Analysis', available: !!svMeta?.imageUrl, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let svAnalysis: StreetViewAnalysis | null = null;
  if (svMeta?.imageUrl) {
    try {
      console.log('  SV Analysis: analyzing image...');
      svAnalysis = await analyzeStreetView(svMeta.imageUrl, true);
    } catch (err) {
      svAnalysisRec.status = 'error';
      svAnalysisRec.error = String(err);
    }
  }
  if (svAnalysis && !svAnalysis.isIndoor) {
    svAnalysisRec.status = 'ok';
    const d: Record<string, unknown> = {};
    if (svAnalysis.colors) {
      const c = svAnalysis.colors;
      d.wallColor = `rgb(${c.wallColor.r},${c.wallColor.g},${c.wallColor.b})`;
      d.wallBlock = mc(c.wallBlock);
      d.roofColor = `rgb(${c.roofColor.r},${c.roofColor.g},${c.roofColor.b})`;
      d.roofBlock = mc(c.roofOverride.cap);
      d.trimColor = `rgb(${c.trimColor.r},${c.trimColor.g},${c.trimColor.b})`;
      d.trimBlock = mc(c.trimBlock);
      svAnalysisRec.fieldsSet.push('svWallOverride', 'svRoofOverride', 'svTrimOverride');
      svAnalysisRec.impactedGenFields.push('wallOverride', 'roofOverride', 'trimOverride');
    }
    if (svAnalysis.structure) {
      const s = svAnalysis.structure;
      d.storyCount = s.stories.storyCount;
      d.storyConfidence = s.stories.confidence?.toFixed(2);
      d.textureClass = s.texture.textureClass;
      d.textureBlock = mc(s.texture.suggestedBlock);
      d.roofPitch = s.roofPitch.roofType;
      d.roofPitchDegrees = s.roofPitch.pitchDegrees?.toFixed(0) + '°';
      d.roofHeightOverride = s.roofPitch.roofHeightOverride;
      d.symmetryScore = s.symmetry.symmetryScore?.toFixed(2);
      d.isSymmetric = s.symmetry.isSymmetric;
      d.planShape = s.symmetry.suggestedPlanShape;
      d.windowsPerFloor = s.fenestration.windowsPerFloor;
      d.windowSpacing = s.fenestration.suggestedSpacing;
      d.lawnDepth = (s.setback.lawnDepthRatio * 100).toFixed(0) + '%';
      d.hasDriveway = s.setback.hasVisibleDriveway;
      d.hasPath = s.setback.hasVisiblePath;
      svAnalysisRec.fieldsSet.push('svStoryCount', 'svTextureClass', 'svRoofPitch', 'svPlanShape', 'svWindowSpacing', 'svSetbackFeatures');
      svAnalysisRec.impactedGenFields.push('floors', 'wallOverride', 'roofHeightOverride', 'floorPlanShape', 'windowSpacing', 'features');
    }
    svAnalysisRec.data = d;
  } else if (svAnalysis?.isIndoor) {
    svAnalysisRec.status = 'skipped';
    svAnalysisRec.error = 'Indoor panorama detected';
  }
  apis.push(svAnalysisRec);

  // ────────────────────────────────────────────────────────────────────────
  // Build 3 tiers of PropertyData with different API subsets
  // ────────────────────────────────────────────────────────────────────────

  const sqft = parcl?.squareFootage || 2500;
  const yearBuilt = parcl?.yearBuilt || 2000;
  const yearUncertain = !parcl?.yearBuilt;

  /** Tier 1: No API data — pure defaults */
  const noApiProp: PropertyData = {
    address,
    stories: 2,
    sqft: 2500,
    bedrooms: 3,
    bathrooms: 2,
    yearBuilt: 2000,
    propertyType: 'house',
    style: 'auto' as const,
  };

  /** Tier 2: Basic APIs — Parcl + OSM + Mapillary */
  let stories2 = 2;
  if (osmData?.levels) stories2 = osmData.levels;
  else if (osmData?.widthMeters && osmData?.lengthMeters && sqft > 0) {
    stories2 = estimateStoriesFromFootprint(sqft, osmData.widthMeters, osmData.lengthMeters);
  }
  const someApiProp: PropertyData = {
    address,
    stories: stories2,
    sqft,
    bedrooms: parcl?.bedrooms || 3,
    bathrooms: parcl?.bathrooms || 2,
    yearBuilt: yearUncertain ? 2000 : yearBuilt,
    propertyType: mapParclPropertyType(parcl?.propertyType || ''),
    style: 'auto' as const,
    city: parcl?.city,
    stateAbbreviation: parcl?.stateAbbreviation,
    zipCode: parcl?.zipCode,
    county: parcl?.county,
    yearUncertain,
    // OSM data
    osmWidth: osmData?.widthMeters ? Math.round(osmData.widthMeters) : undefined,
    osmLength: osmData?.lengthMeters ? Math.round(osmData.lengthMeters) : undefined,
    osmLevels: osmData?.levels,
    osmArchitecture: osmData?.tags?.['building:architecture'] ?? osmData?.tags?.['architect'] ?? undefined,
    osmRoofShape: osmData?.roofShape,
    osmRoofMaterial: osmData?.roofMaterial,
    osmRoofColour: osmData?.roofColour,
    osmBuildingColour: osmData?.buildingColour,
    osmMaterial: osmData?.material,
    osmPolygon: osmData?.polygon,
    osmInnerPolygons: osmData?.innerPolygons,
    // Mapillary data
    mapillaryImageUrl: bestImage?.thumbUrl,
    mapillaryHeading: bestImage?.compassAngle,
    mapillaryCaptureDate: bestImage ? new Date(bestImage.capturedAt).toISOString().slice(0, 10) : undefined,
    mapillaryHasDriveway: mapillaryFeatureResult?.hasDriveway,
    mapillaryHasFence: mapillaryFeatureResult?.hasFence,
  };

  /** Tier 3: All APIs — adds Mapbox + Solar + StreetView */
  let stories3 = stories2;
  if (mapboxData?.height && mapboxData.height > 0) {
    const mapboxStories = Math.max(1, Math.round(mapboxData.height / 3.5));
    // When OSM footprint is available, the sqft/footprint ratio is more accurate
    // than Mapbox height (which includes terrain slope on hillsides). Only use
    // Mapbox when no footprint estimate or when it agrees within 1 floor.
    if (osmData?.widthMeters && osmData.widthMeters > 0 && sqft > 0) {
      const footprintStories = estimateStoriesFromFootprint(sqft, osmData.widthMeters, osmData.lengthMeters);
      stories3 = (Math.abs(mapboxStories - footprintStories) <= 1) ? mapboxStories : footprintStories;
    } else {
      stories3 = mapboxStories;
    }
  }
  const allApiProp: PropertyData = {
    ...someApiProp,
    stories: stories3,
    // Mapbox data
    mapboxHeight: mapboxData?.height,
    mapboxBuildingType: mapboxData?.buildingType,
    // Solar data
    solarRoofPitch: solarData?.primaryPitchDegrees,
    solarRoofSegments: solarData?.roofSegmentCount,
    solarBuildingArea: solarData?.buildingFootprintAreaSqm,
    solarRoofArea: solarData?.totalRoofAreaSqm,
    solarAzimuthDegrees: solarData?.primaryAzimuthDegrees || undefined,
    // Street View metadata
    streetViewUrl: svMeta?.imageUrl,
    streetViewDate: svMeta?.date,
    streetViewHeading: svMeta?.heading,
  };
  // SV Image Analysis fields
  if (svAnalysis && !svAnalysis.isIndoor) {
    if (svAnalysis.colors) {
      allApiProp.svWallOverride = svAnalysis.colors.wallBlock;
      allApiProp.svRoofOverride = svAnalysis.colors.roofOverride;
      allApiProp.svTrimOverride = svAnalysis.colors.trimBlock;
    }
    if (svAnalysis.structure) {
      const s = svAnalysis.structure;
      allApiProp.svStoryCount = s.stories.storyCount;
      allApiProp.svTextureClass = s.texture.textureClass;
      allApiProp.svTextureBlock = s.texture.suggestedBlock;
      allApiProp.svRoofPitch = s.roofPitch.roofType;
      allApiProp.svRoofHeightOverride = s.roofPitch.roofHeightOverride;
      allApiProp.svSymmetric = s.symmetry.isSymmetric;
      allApiProp.svPlanShape = s.symmetry.suggestedPlanShape === 'rectangle' ? 'rect' : s.symmetry.suggestedPlanShape as 'L' | 'T';
      allApiProp.svWindowsPerFloor = s.fenestration.windowsPerFloor;
      allApiProp.svWindowSpacing = s.fenestration.suggestedSpacing;
      allApiProp.svSetbackFeatures = s.setback.suggestedFeatures;
    }
  }

  // ── Phase 5: Environmental data sources (for enriched tier) ────────────

  const enrichApis: ApiRecord[] = [];
  const enrichedProp: PropertyData = { ...allApiProp };

  // NLCD tree canopy cover
  const nlcdRec: ApiRecord = { name: 'NLCD', available: true, status: 'skipped', data: {}, fieldsSet: [], impactedGenFields: [] };
  try {
    const nlcd = await queryNlcdCanopy(lat, lng);
    if (nlcd?.canopyCoverPct != null) {
      nlcdRec.status = 'ok';
      nlcdRec.data = { canopyCoverPct: nlcd.canopyCoverPct };
      nlcdRec.fieldsSet = ['canopyCoverPct'];
      nlcdRec.impactedGenFields = ['features.trees'];
      enrichedProp.canopyCoverPct = nlcd.canopyCoverPct;
      console.log(`  NLCD: canopy ${nlcd.canopyCoverPct}%`);
    }
  } catch (err) { nlcdRec.status = 'error'; nlcdRec.error = String(err); }
  enrichApis.push(nlcdRec);

  // USDA Hardiness Zone (needs zipCode from Parcl)
  const hardRec: ApiRecord = { name: 'Hardiness', available: !!parcl?.zipCode, status: 'skipped', data: {}, fieldsSet: [], impactedGenFields: [] };
  if (parcl?.zipCode) {
    try {
      const hz = await queryHardinessZone(parcl.zipCode);
      if (hz?.zone) {
        hardRec.status = 'ok';
        hardRec.data = { zone: hz.zone };
        hardRec.fieldsSet = ['hardinessZone'];
        hardRec.impactedGenFields = ['features.treePalette'];
        enrichedProp.hardinessZone = hz.zone;
        console.log(`  Hardiness: zone ${hz.zone}`);
      }
    } catch (err) { hardRec.status = 'error'; hardRec.error = String(err); }
  }
  enrichApis.push(hardRec);

  // OSM Trees
  const treesRec: ApiRecord = { name: 'OSM Trees', available: true, status: 'skipped', data: {}, fieldsSet: [], impactedGenFields: [] };
  try {
    const trees = await searchOSMTrees(lat, lng, 150);
    if (trees.length > 0) {
      treesRec.status = 'ok';
      treesRec.data = { count: trees.length };
      treesRec.fieldsSet = ['nearbyTrees'];
      treesRec.impactedGenFields = ['features.trees'];
      enrichedProp.nearbyTrees = trees;
      console.log(`  OSM Trees: ${trees.length} nearby`);
    }
  } catch (err) { treesRec.status = 'error'; treesRec.error = String(err); }
  enrichApis.push(treesRec);
  await delay(1000); // rate limit OSM Overpass

  // Overture Maps building
  const overtureRec: ApiRecord = { name: 'Overture', available: true, status: 'skipped', data: {}, fieldsSet: [], impactedGenFields: [] };
  try {
    const ov = await queryOvertureBuilding(lat, lng);
    if (ov) {
      overtureRec.status = 'ok';
      overtureRec.data = { height: ov.height, floors: ov.numFloors, roofShape: ov.roofShape };
      overtureRec.fieldsSet = ['overtureHeight', 'overtureFloors', 'overtureRoofShape'];
      overtureRec.impactedGenFields = ['floors', 'roofShape'];
      enrichedProp.overtureHeight = ov.height;
      enrichedProp.overtureFloors = ov.numFloors;
      enrichedProp.overtureRoofShape = ov.roofShape;
      console.log(`  Overture: h=${ov.height ?? '?'}m fl=${ov.numFloors ?? '?'} roof=${ov.roofShape ?? '?'}`);
    }
  } catch (err) { overtureRec.status = 'error'; overtureRec.error = String(err); }
  enrichApis.push(overtureRec);

  // Water features
  const waterRec: ApiRecord = { name: 'Water', available: true, status: 'skipped', data: {}, fieldsSet: [], impactedGenFields: [] };
  try {
    const water = await searchWaterFeatures(lat, lng, 500);
    if (water.length > 0) {
      waterRec.status = 'ok';
      waterRec.data = { count: water.length, features: water.slice(0, 3).map(w => w.name || w.type).join(', ') };
      waterRec.fieldsSet = ['nearbyWater'];
      waterRec.impactedGenFields = ['features.water'];
      enrichedProp.nearbyWater = water.map(w => ({ type: w.type, name: w.name, distanceMeters: w.distanceMeters }));
      console.log(`  Water: ${water.length} features`);
    }
  } catch (err) { waterRec.status = 'error'; waterRec.error = String(err); }
  enrichApis.push(waterRec);
  await delay(1000); // rate limit OSM Overpass

  // Meta/WRI canopy height
  const canopyHtRec: ApiRecord = { name: 'Canopy Height', available: true, status: 'skipped', data: {}, fieldsSet: [], impactedGenFields: [] };
  try {
    const ch = await queryCanopyHeight(lat, lng);
    if (ch?.heightMeters != null) {
      canopyHtRec.status = 'ok';
      canopyHtRec.data = { heightMeters: ch.heightMeters };
      canopyHtRec.fieldsSet = ['canopyHeightMeters'];
      canopyHtRec.impactedGenFields = ['features.treePalette'];
      enrichedProp.canopyHeightMeters = ch.heightMeters;
      console.log(`  Canopy Height: ${ch.heightMeters.toFixed(1)}m`);
    }
  } catch (err) { canopyHtRec.status = 'error'; canopyHtRec.error = String(err); }
  enrichApis.push(canopyHtRec);

  // ESA WorldCover land cover
  const landRec: ApiRecord = { name: 'Land Cover', available: true, status: 'skipped', data: {}, fieldsSet: [], impactedGenFields: [] };
  try {
    const lc = await queryLandCover(lat, lng);
    if (lc?.classValue != null) {
      landRec.status = 'ok';
      landRec.data = { classValue: lc.classValue, label: lc.label };
      landRec.fieldsSet = ['landCoverClass', 'landCoverLabel'];
      landRec.impactedGenFields = ['features.landscape'];
      enrichedProp.landCoverClass = lc.classValue;
      enrichedProp.landCoverLabel = lc.label ?? undefined;
      console.log(`  Land Cover: ${lc.label ?? lc.classValue}`);
    }
  } catch (err) { landRec.status = 'error'; landRec.error = String(err); }
  enrichApis.push(landRec);

  // Merge enrichment APIs into the main api list
  apis.push(...enrichApis);

  // ────────────────────────────────────────────────────────────────────────
  // Generate & render for each tier
  // ────────────────────────────────────────────────────────────────────────

  const tierProps: Record<Tier, PropertyData> = {
    noapi: noApiProp,
    someapis: someApiProp,
    allapis: allApiProp,
    enriched: enrichedProp,
  };

  const tierResults: TierResult[] = [];

  for (const tier of TIERS) {
    const prop = tierProps[tier];
    const opts = convertToGenerationOptions(prop);
    const ls = opts.landscape;
    const lsStr = ls ? ` trees=${ls.treeCount}×${ls.treePalette.join('/')} h=${ls.treeHeight} water=${ls.hasWater} ground=${ls.groundCover} path=${ls.pathBlock?.replace('minecraft:', '')} fence=${ls.fenceBlock?.replace('minecraft:', '')}` : '';
    console.log(`\n  [${tier}] ${opts.style} ${opts.floors}f ${opts.width || '?'}x${opts.length || '?'} shape=${opts.floorPlanShape || 'rect'}${lsStr}`);

    const grid = generateStructure(opts);
    const blockCount = grid.countNonAir();
    console.log(`    Grid: ${grid.width}x${grid.height}x${grid.length}, ${blockCount.toLocaleString()} blocks`);

    // Render images (skip with --json-only)
    let extFile = `${key}-${tier}_exterior.jpg`;
    const cutawayPaths: string[] = [];
    const floorPaths: string[] = [];

    if (!JSON_ONLY) {
      const extBuf = await renderExterior(grid, { tile: 8 });
      await writeFile(join(OUT_DIR, extFile), await toJpeg(extBuf));

      for (let f = 0; f < Math.min(opts.floors, 9); f++) {
        const cutBuf = await renderCutawayIso(grid, f, { tile: 8 });
        const cutFile = `${key}-${tier}_cutaway_${f}.jpg`;
        await writeFile(join(OUT_DIR, cutFile), await toJpeg(cutBuf));
        cutawayPaths.push(cutFile);

        const floorBuf = await renderFloorDetail(grid, f, { scale: 16 });
        const floorFile = `${key}-${tier}_floor_${f}.jpg`;
        await writeFile(join(OUT_DIR, floorFile), await toJpeg(floorBuf));
        floorPaths.push(floorFile);
      }
      console.log(`    + ${1 + opts.floors * 2} images`);
    } else {
      // Preserve existing image paths
      for (let f = 0; f < Math.min(opts.floors, 9); f++) {
        cutawayPaths.push(`${key}-${tier}_cutaway_${f}.jpg`);
        floorPaths.push(`${key}-${tier}_floor_${f}.jpg`);
      }
    }

    tierResults.push({
      tier,
      property: {
        sqft: prop.sqft, bedrooms: prop.bedrooms, bathrooms: prop.bathrooms,
        yearBuilt: prop.yearBuilt, propertyType: prop.propertyType,
        stories: prop.stories, yearUncertain: prop.yearUncertain,
      },
      genOptions: {
        style: opts.style, floors: opts.floors, width: opts.width, length: opts.length,
        seed: opts.seed,
        wallOverride: opts.wallOverride, trimOverride: opts.trimOverride,
        doorOverride: opts.doorOverride, roofShape: opts.roofShape,
        roofOverride: opts.roofOverride, floorPlanShape: opts.floorPlanShape,
        windowSpacing: opts.windowSpacing, roofHeightOverride: opts.roofHeightOverride,
        features: opts.features, landscape: opts.landscape,
      },
      grid: { width: grid.width, height: grid.height, depth: grid.length, blocks: blockCount },
      views: { exterior: extFile, cutaway: cutawayPaths, floor: floorPaths },
    });
  }

  allResults.push({ key, address, apis, tiers: tierResults });
}

// ─── Write JSON + sync to web ────────────────────────────────────────────────

// When using --only, merge new results into existing JSON
let finalResults = allResults;
const jsonPath = join(OUT_DIR, 'comparison-data.json');
if (ONLY_KEYS) {
  try {
    const existing: ComparisonResult[] = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const newKeys = new Set(allResults.map(r => r.key));
    finalResults = [
      ...existing.filter(r => !newKeys.has(r.key)),
      ...allResults,
    ];
    console.log(`\n+ Merged ${allResults.length} new + ${finalResults.length - allResults.length} existing = ${finalResults.length} total`);
  } catch { /* no existing file, use allResults as-is */ }
}

await writeFile(jsonPath, JSON.stringify(finalResults, null, 2));
console.log(`+ Wrote ${jsonPath}`);

// Copy JSON + all images to web/public/comparison/
await writeFile(join(WEB_DIR, 'comparison-data.json'), JSON.stringify(finalResults, null, 2));
const { readdir, copyFile } = await import('fs/promises');
const outFiles = await readdir(OUT_DIR);
for (const f of outFiles) {
  if (f.endsWith('.jpg') && (f.includes('-noapi_') || f.includes('-someapis_') || f.includes('-allapis_') || f.includes('-enriched_'))) {
    await copyFile(join(OUT_DIR, f), join(WEB_DIR, f));
  }
}
console.log(`+ Synced to ${WEB_DIR}/`);
console.log('+ Comparison regeneration complete');
