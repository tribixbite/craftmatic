#!/usr/bin/env bun
/**
 * Regenerate comparison images using ALL available API sources.
 * Outputs per-address JSON with full API data tracking + rendered images.
 * The companion index.html reads this JSON to show detailed API tables.
 *
 * Usage: grun ~/.bun/bin/buno scripts/gen-comparison.ts
 */

// Load .env file since grun strips environment variables
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
import { searchParclProperty, mapParclPropertyType, hasParclApiKey } from '../src/gen/api/parcl.js';
import { searchOSMBuilding, type OSMBuildingData } from '../src/gen/api/osm.js';
import { queryStreetViewMetadata, hasGoogleStreetViewKey, type StreetViewMetadata } from '../src/gen/api/google-streetview.js';
import { queryMapboxBuilding, hasMapboxApiKey, type MapboxBuildingData } from '../src/gen/api/mapbox.js';
import { querySolarBuildingInsights, hasGoogleApiKey, type SolarBuildingData } from '../src/gen/api/google-solar.js';
import {
  searchMapillaryImages, searchMapillaryFeatures, pickBestImage, analyzeFeatures,
  hasMapillaryApiKey, getMapillaryApiKey,
  type MapillaryImageData, type MapillaryFeatureData,
} from '../src/gen/api/mapillary.js';
import { renderFloorDetail, renderCutawayIso, renderExterior } from '../src/render/png-renderer.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import type { GenerationOptions } from '../src/types/index.js';

const OUT_DIR = 'output/comparison';

// Addresses to regenerate — same set as the comparison viewer
const ADDRESSES = [
  { key: 'sf', address: '2340 Francisco St, San Francisco, CA 94123' },
  { key: 'newton', address: '240 Highland St, Newton, MA 02465' },
  { key: 'sanjose', address: '525 S Winchester Blvd, San Jose, CA 95128' },
];

/** Per-API tracking record — what each API returned and how it impacts generation */
interface ApiRecord {
  name: string;
  available: boolean;
  status: 'ok' | 'error' | 'skipped' | 'unavailable';
  error?: string;
  /** Raw data returned by the API (serializable subset) */
  data: Record<string, unknown>;
  /** Which PropertyData fields this API populated */
  fieldsSet: string[];
  /** Which GenerationOptions fields this API ultimately affected */
  impactedGenFields: string[];
}

/** Full per-address result for the comparison viewer */
interface ComparisonResult {
  key: string;
  address: string;
  apis: ApiRecord[];
  property: Partial<PropertyData>;
  genOptions: Partial<GenerationOptions>;
  grid: { width: number; height: number; depth: number; blocks: number };
  views: {
    exterior: { api: string };
    cutaway: string[];
    floor: string[];
  };
}

// ─── Check available APIs ─────────────────────────────────────────────────────

if (!hasParclApiKey()) {
  console.error('ERROR: PARCL_API_KEY not set');
  process.exit(1);
}

const apiStatus = {
  parcl: hasParclApiKey(),
  osm: true, // always available (free, no key)
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

/** Convert PNG Buffer to JPEG for smaller file sizes */
async function toJpeg(pngBuf: Buffer): Promise<Buffer> {
  return sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
}

/** Strip 'minecraft:' prefix for display */
function mc(block: string): string {
  return block?.replace('minecraft:', '') ?? '';
}

const allResults: ComparisonResult[] = [];

for (const { key, address } of ADDRESSES) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${key}: ${address}`);
  console.log(`${'='.repeat(60)}`);

  const apis: ApiRecord[] = [];

  // ────────────────────────────────────────────────────────────────────────
  // Step 1: Parcl (property records — sqft, beds, baths, year, location)
  // ────────────────────────────────────────────────────────────────────────
  const parclRec: ApiRecord = {
    name: 'Parcl Labs', available: true, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  const parcl = await searchParclProperty(address);
  if (!parcl) {
    parclRec.status = 'error';
    parclRec.error = 'Address not found';
    apis.push(parclRec);
    console.log('  Parcl: not found, skipping');
    continue;
  }
  parclRec.status = 'ok';
  parclRec.data = {
    sqft: parcl.squareFootage, bedrooms: parcl.bedrooms, bathrooms: parcl.bathrooms,
    yearBuilt: parcl.yearBuilt, propertyType: parcl.propertyType,
    lat: parcl.latitude, lng: parcl.longitude,
    city: parcl.city, state: parcl.stateAbbreviation,
  };
  parclRec.fieldsSet = ['sqft', 'bedrooms', 'bathrooms', 'yearBuilt', 'propertyType', 'city', 'stateAbbreviation', 'county', 'zipCode'];
  parclRec.impactedGenFields = ['floors', 'rooms', 'width', 'length', 'style', 'seed'];
  apis.push(parclRec);
  console.log(`  Parcl: ${parcl.squareFootage} sqft, ${parcl.bedrooms}bd/${parcl.bathrooms}ba, yr=${parcl.yearBuilt}, type=${parcl.propertyType}`);

  const lat = parcl.latitude;
  const lng = parcl.longitude;

  // ────────────────────────────────────────────────────────────────────────
  // Step 2: OSM (building footprint — polygon, width/length, levels, tags)
  // Wait patiently for rate-limited Overpass API
  // ────────────────────────────────────────────────────────────────────────
  const osmRec: ApiRecord = {
    name: 'OpenStreetMap', available: true, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let osmData: OSMBuildingData | null = null;
  if (lat && lng) {
    try {
      console.log('  OSM: querying Overpass...');
      osmData = await searchOSMBuilding(lat, lng);
    } catch (err) {
      osmRec.status = 'error';
      osmRec.error = String(err);
      console.log(`  OSM: error — ${err}`);
    }
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
    console.log(`  OSM: ${osmData.widthMeters?.toFixed(1)}x${osmData.lengthMeters?.toFixed(1)}m, levels=${osmData.levels || '?'}, material=${osmData.material || '?'}, roof=${osmData.roofShape || '?'}`);
  } else if (osmRec.status !== 'error') {
    osmRec.status = 'skipped';
    osmRec.error = 'No building found at coordinates';
    console.log('  OSM: no building found');
  }
  apis.push(osmRec);

  // Add delay between OSM and next API to be polite to Overpass
  await new Promise(r => setTimeout(r, 1000));

  // ────────────────────────────────────────────────────────────────────────
  // Step 3: Mapbox (3D building height from LiDAR/vector tiles)
  // ────────────────────────────────────────────────────────────────────────
  const mapboxRec: ApiRecord = {
    name: 'Mapbox', available: apiStatus.mapbox, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let mapboxData: MapboxBuildingData | null = null;
  if (apiStatus.mapbox && lat && lng) {
    try {
      console.log('  Mapbox: querying building height...');
      mapboxData = await queryMapboxBuilding(lat, lng);
    } catch (err) {
      mapboxRec.status = 'error';
      mapboxRec.error = String(err);
      console.log(`  Mapbox: error — ${err}`);
    }
  } else if (!apiStatus.mapbox) {
    mapboxRec.status = 'unavailable';
    mapboxRec.error = 'MAPBOX_API_KEY not set';
  }
  if (mapboxData) {
    mapboxRec.status = 'ok';
    mapboxRec.data = {
      height: mapboxData.height + 'm',
      minHeight: mapboxData.minHeight + 'm',
      buildingType: mapboxData.buildingType,
      extrude: mapboxData.extrude,
      distance: mapboxData.distance?.toFixed(1) + 'm',
    };
    mapboxRec.fieldsSet = ['mapboxHeight', 'mapboxBuildingType'];
    // Mapbox height is highest priority for floor count (height ÷ 3m/floor)
    mapboxRec.impactedGenFields = ['floors'];
    console.log(`  Mapbox: height=${mapboxData.height}m, type=${mapboxData.buildingType || '?'}, dist=${mapboxData.distance?.toFixed(1)}m`);
  } else if (mapboxRec.status !== 'error' && mapboxRec.status !== 'unavailable') {
    mapboxRec.status = 'skipped';
    mapboxRec.error = 'No building at coordinates';
    console.log('  Mapbox: no building found');
  }
  apis.push(mapboxRec);

  // ────────────────────────────────────────────────────────────────────────
  // Step 4: Google Solar (roof geometry from aerial ML)
  // ────────────────────────────────────────────────────────────────────────
  const solarRec: ApiRecord = {
    name: 'Google Solar', available: apiStatus.solar, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let solarData: SolarBuildingData | null = null;
  if (apiStatus.solar && lat && lng) {
    try {
      console.log('  Solar: querying building insights...');
      solarData = await querySolarBuildingInsights(lat, lng);
    } catch (err) {
      solarRec.status = 'error';
      solarRec.error = String(err);
      console.log(`  Solar: error — ${err}`);
    }
  } else if (!apiStatus.solar) {
    solarRec.status = 'unavailable';
    solarRec.error = 'GOOGLE_MAPS_API_KEY not set';
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
    // Solar pitch overrides SV pitch; segments impact roof shape
    solarRec.impactedGenFields = ['roofShape', 'roofHeightOverride'];
    console.log(`  Solar: pitch=${solarData.primaryPitchDegrees?.toFixed(1)}° segments=${solarData.roofSegmentCount} area=${solarData.buildingFootprintAreaSqm?.toFixed(0)}sqm quality=${solarData.imageryQuality}`);
  } else if (solarRec.status !== 'error' && solarRec.status !== 'unavailable') {
    solarRec.status = 'skipped';
    solarRec.error = 'No solar data for location';
    console.log('  Solar: no data');
  }
  apis.push(solarRec);

  // ────────────────────────────────────────────────────────────────────────
  // Step 5: Mapillary (street imagery + map features: driveway, fence)
  // ────────────────────────────────────────────────────────────────────────
  const mapillaryRec: ApiRecord = {
    name: 'Mapillary', available: apiStatus.mapillary, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let bestImage: MapillaryImageData | null = null;
  let mapillaryFeatureResult: { hasDriveway: boolean; hasFence: boolean } | null = null;
  if (apiStatus.mapillary && lat && lng) {
    try {
      console.log('  Mapillary: searching images + features...');
      const apiKey = getMapillaryApiKey();
      const [images, features] = await Promise.all([
        searchMapillaryImages(lat, lng, apiKey),
        searchMapillaryFeatures(lat, lng, apiKey),
      ]);
      if (images && images.length > 0) {
        bestImage = pickBestImage(images, lat, lng);
      }
      if (features && features.length > 0) {
        mapillaryFeatureResult = analyzeFeatures(features);
      }
      mapillaryRec.status = 'ok';
      mapillaryRec.data = {
        imagesFound: images?.length ?? 0,
        bestImageId: bestImage?.id,
        bestImageDate: bestImage ? new Date(bestImage.capturedAt).toISOString().slice(0, 10) : null,
        bestImageHeading: bestImage?.compassAngle?.toFixed(0) + '°',
        isPano: bestImage?.isPano,
        featuresFound: features?.length ?? 0,
        hasDriveway: mapillaryFeatureResult?.hasDriveway,
        hasFence: mapillaryFeatureResult?.hasFence,
      };
      mapillaryRec.fieldsSet = [];
      if (bestImage) mapillaryRec.fieldsSet.push('mapillaryImageUrl', 'mapillaryHeading', 'mapillaryCaptureDate');
      if (mapillaryFeatureResult?.hasDriveway) mapillaryRec.fieldsSet.push('mapillaryHasDriveway');
      if (mapillaryFeatureResult?.hasFence) mapillaryRec.fieldsSet.push('mapillaryHasFence');
      mapillaryRec.impactedGenFields = [];
      if (mapillaryFeatureResult?.hasDriveway) mapillaryRec.impactedGenFields.push('features.driveway');
      if (mapillaryFeatureResult?.hasFence) mapillaryRec.impactedGenFields.push('features.fence');
      console.log(`  Mapillary: ${images?.length ?? 0} images, ${features?.length ?? 0} features, driveway=${mapillaryFeatureResult?.hasDriveway ?? '?'}, fence=${mapillaryFeatureResult?.hasFence ?? '?'}`);
    } catch (err) {
      mapillaryRec.status = 'error';
      mapillaryRec.error = String(err);
      console.log(`  Mapillary: error — ${err}`);
    }
  } else if (!apiStatus.mapillary) {
    mapillaryRec.status = 'unavailable';
    mapillaryRec.error = 'MAPILLARY_ACCESS_TOKEN not set';
  }
  apis.push(mapillaryRec);

  // ────────────────────────────────────────────────────────────────────────
  // Step 6: Google Street View metadata (heading, date, image URL)
  // ────────────────────────────────────────────────────────────────────────
  const svMetaRec: ApiRecord = {
    name: 'Google Street View', available: apiStatus.streetview, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let svMeta: StreetViewMetadata | null = null;
  if (apiStatus.streetview && lat && lng) {
    try {
      svMeta = await queryStreetViewMetadata(lat, lng);
    } catch (err) {
      svMetaRec.status = 'error';
      svMetaRec.error = String(err);
      console.log(`  SV Meta: error — ${err}`);
    }
  } else if (!apiStatus.streetview) {
    svMetaRec.status = 'unavailable';
    svMetaRec.error = 'GOOGLE_MAPS_API_KEY not set';
  }
  if (svMeta) {
    svMetaRec.status = 'ok';
    svMetaRec.data = {
      panoId: svMeta.panoId,
      date: svMeta.date,
      heading: svMeta.heading?.toFixed(0) + '°',
      panoLat: svMeta.lat?.toFixed(5),
      panoLng: svMeta.lng?.toFixed(5),
    };
    svMetaRec.fieldsSet = ['streetViewUrl', 'streetViewDate', 'streetViewHeading'];
    svMetaRec.impactedGenFields = []; // metadata alone doesn't change gen — the image analysis does
    console.log(`  SV: heading=${svMeta.heading?.toFixed(0)}° date=${svMeta.date || '?'}`);
  } else if (svMetaRec.status !== 'error' && svMetaRec.status !== 'unavailable') {
    svMetaRec.status = 'skipped';
    svMetaRec.error = 'No SV coverage at coordinates';
    console.log('  SV: no coverage');
  }
  apis.push(svMetaRec);

  // ────────────────────────────────────────────────────────────────────────
  // Step 7: SV Image Analysis (color extraction + structural heuristics)
  // ────────────────────────────────────────────────────────────────────────
  const svAnalysisRec: ApiRecord = {
    name: 'SV Image Analysis', available: !!svMeta?.imageUrl, status: 'skipped',
    data: {}, fieldsSet: [], impactedGenFields: [],
  };
  let svAnalysis: StreetViewAnalysis | null = null;
  if (svMeta?.imageUrl) {
    try {
      console.log('  SV Analysis: downloading + analyzing image...');
      svAnalysis = await analyzeStreetView(svMeta.imageUrl, true); // skipVision=true (no Anthropic key)
    } catch (err) {
      svAnalysisRec.status = 'error';
      svAnalysisRec.error = String(err);
      console.log(`  SV Analysis: error — ${err}`);
    }
  }
  if (svAnalysis) {
    if (svAnalysis.isIndoor) {
      svAnalysisRec.status = 'skipped';
      svAnalysisRec.error = 'Indoor panorama detected';
      svAnalysisRec.data = { isIndoor: true };
      console.log('  SV Analysis: INDOOR PANORAMA — skipped');
    } else {
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
        console.log(`  SV Colors: wall=${mc(c.wallBlock)} roof=${mc(c.roofOverride.cap)} trim=${mc(c.trimBlock)}`);
      }
      if (svAnalysis.structure) {
        const s = svAnalysis.structure;
        d.storyCount = s.stories.storyCount;
        d.storyConfidence = s.stories.confidence?.toFixed(2);
        d.textureClass = s.texture.textureClass;
        d.textureBlock = mc(s.texture.suggestedBlock);
        d.textureEntropy = s.texture.entropy?.toFixed(0);
        d.roofPitch = s.roofPitch.roofType;
        d.roofPitchDegrees = s.roofPitch.pitchDegrees?.toFixed(0) + '°';
        d.roofHeightOverride = s.roofPitch.roofHeightOverride;
        d.symmetryScore = s.symmetry.symmetryScore?.toFixed(2);
        d.isSymmetric = s.symmetry.isSymmetric;
        d.planShape = s.symmetry.suggestedPlanShape;
        d.windowsPerFloor = s.fenestration.windowsPerFloor;
        d.windowSpacing = s.fenestration.suggestedSpacing;
        d.windowWallRatio = s.fenestration.windowWallRatio?.toFixed(3);
        d.lawnDepth = (s.setback.lawnDepthRatio * 100).toFixed(0) + '%';
        d.hasDriveway = s.setback.hasVisibleDriveway;
        d.hasPath = s.setback.hasVisiblePath;
        svAnalysisRec.fieldsSet.push(
          'svStoryCount', 'svTextureClass', 'svTextureBlock',
          'svRoofPitch', 'svRoofHeightOverride', 'svSymmetric', 'svPlanShape',
          'svWindowsPerFloor', 'svWindowSpacing', 'svSetbackFeatures',
        );
        svAnalysisRec.impactedGenFields.push(
          'floors', 'wallOverride', 'roofHeightOverride',
          'floorPlanShape', 'windowSpacing', 'features',
        );
        console.log(`  SV Structure: ${s.stories.storyCount} stories | ${s.texture.textureClass} | ${s.roofPitch.roofType} pitch (${s.roofPitch.pitchDegrees?.toFixed(0)}°) | ${s.symmetry.isSymmetric ? 'sym' : 'asym'} | ${s.fenestration.windowsPerFloor} win/floor`);
        if (s.setback.lawnDepthRatio > 0.05 || s.setback.hasVisibleDriveway) {
          console.log(`  SV Setback: lawn=${(s.setback.lawnDepthRatio * 100).toFixed(0)}% driveway=${s.setback.hasVisibleDriveway} path=${s.setback.hasVisiblePath}`);
        }
      }
      svAnalysisRec.data = d;
    }
  }
  apis.push(svAnalysisRec);

  // ────────────────────────────────────────────────────────────────────────
  // Build PropertyData from all API sources
  // ────────────────────────────────────────────────────────────────────────
  const sqft = parcl.squareFootage || 2500;
  const yearBuilt = parcl.yearBuilt || 2000;
  const yearUncertain = !parcl.yearBuilt;
  let stories = 2;

  // Floor count priority: Mapbox height > OSM levels > footprint estimate
  if (mapboxData?.height) {
    stories = Math.max(1, Math.min(8, Math.round(mapboxData.height / 3)));
  } else if (osmData?.levels) {
    stories = osmData.levels;
  } else if (osmData?.widthMeters && osmData?.lengthMeters && sqft > 0) {
    stories = estimateStoriesFromFootprint(sqft, osmData.widthMeters, osmData.lengthMeters);
  }

  const property: PropertyData = {
    address,
    stories,
    sqft,
    bedrooms: parcl.bedrooms || 3,
    bathrooms: parcl.bathrooms || 2,
    yearBuilt: yearUncertain ? 2000 : yearBuilt,
    propertyType: mapParclPropertyType(parcl.propertyType || ''),
    style: 'auto' as const,
    city: parcl.city,
    stateAbbreviation: parcl.stateAbbreviation,
    zipCode: parcl.zipCode,
    county: parcl.county,
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
    // Mapbox data
    mapboxHeight: mapboxData?.height,
    mapboxBuildingType: mapboxData?.buildingType,
    // Solar data
    solarRoofPitch: solarData?.primaryPitchDegrees,
    solarRoofSegments: solarData?.roofSegmentCount,
    solarBuildingArea: solarData?.buildingFootprintAreaSqm,
    solarRoofArea: solarData?.totalRoofAreaSqm,
    // Street View metadata
    streetViewUrl: svMeta?.imageUrl,
    streetViewDate: svMeta?.date,
    streetViewHeading: svMeta?.heading,
    // Mapillary data
    mapillaryImageUrl: bestImage?.thumbUrl,
    mapillaryHeading: bestImage?.compassAngle,
    mapillaryCaptureDate: bestImage ? new Date(bestImage.capturedAt).toISOString().slice(0, 10) : undefined,
    mapillaryHasDriveway: mapillaryFeatureResult?.hasDriveway,
    mapillaryHasFence: mapillaryFeatureResult?.hasFence,
  };

  // SV Image Analysis fields
  if (svAnalysis && !svAnalysis.isIndoor) {
    if (svAnalysis.colors) {
      property.svWallOverride = svAnalysis.colors.wallBlock;
      property.svRoofOverride = svAnalysis.colors.roofOverride;
      property.svTrimOverride = svAnalysis.colors.trimBlock;
    }
    if (svAnalysis.structure) {
      const s = svAnalysis.structure;
      property.svStoryCount = s.stories.storyCount;
      property.svTextureClass = s.texture.textureClass;
      property.svTextureBlock = s.texture.suggestedBlock;
      property.svRoofPitch = s.roofPitch.roofType;
      property.svRoofHeightOverride = s.roofPitch.roofHeightOverride;
      property.svSymmetric = s.symmetry.isSymmetric;
      property.svPlanShape = s.symmetry.suggestedPlanShape === 'rectangle' ? 'rect' : s.symmetry.suggestedPlanShape as 'L' | 'T';
      property.svWindowsPerFloor = s.fenestration.windowsPerFloor;
      property.svWindowSpacing = s.fenestration.suggestedSpacing;
      property.svSetbackFeatures = s.setback.suggestedFeatures;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Convert to generation options and generate
  // ────────────────────────────────────────────────────────────────────────
  const opts = convertToGenerationOptions(property);
  console.log(`  Gen: ${opts.style} ${opts.floors}f ${opts.width || '?'}x${opts.length || '?'}`);
  console.log(`    wall=${opts.wallOverride || 'default'} trim=${opts.trimOverride || 'default'} roof=${opts.roofOverride?.cap ? mc(opts.roofOverride.cap) : 'default'} door=${opts.doorOverride || 'default'}`);
  console.log(`    shape=${opts.floorPlanShape || 'rect'} roofShape=${opts.roofShape || 'gable'} windowSpacing=${opts.windowSpacing || 3} roofHeight=${opts.roofHeightOverride ?? 'default'}`);

  const grid = generateStructure(opts);
  const blockCount = grid.countNonAir();
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.depth}, ${blockCount.toLocaleString()} blocks`);

  // ────────────────────────────────────────────────────────────────────────
  // Render images
  // ────────────────────────────────────────────────────────────────────────
  console.log('  Rendering...');

  const extBuf = await renderExterior(grid, { tile: 8 });
  const extPath = join(OUT_DIR, `${key}-api_exterior.jpg`);
  await writeFile(extPath, await toJpeg(extBuf));

  const cutawayPaths: string[] = [];
  const floorPaths: string[] = [];
  for (let f = 0; f < Math.min(opts.floors, 9); f++) {
    const cutBuf = await renderCutawayIso(grid, f, { tile: 8 });
    const cutFile = `${key}-api_cutaway_${f}.jpg`;
    await writeFile(join(OUT_DIR, cutFile), await toJpeg(cutBuf));
    cutawayPaths.push(cutFile);

    const floorBuf = await renderFloorDetail(grid, f, { scale: 16 });
    const floorFile = `${key}-api_floor_${f}.jpg`;
    await writeFile(join(OUT_DIR, floorFile), await toJpeg(floorBuf));
    floorPaths.push(floorFile);
  }

  console.log(`  + ${1 + opts.floors * 2} images saved`);

  // ────────────────────────────────────────────────────────────────────────
  // Collect result
  // ────────────────────────────────────────────────────────────────────────
  allResults.push({
    key,
    address,
    apis,
    property: {
      sqft: property.sqft,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      yearBuilt: property.yearBuilt,
      propertyType: property.propertyType,
      stories: property.stories,
      yearUncertain: property.yearUncertain,
    },
    genOptions: {
      style: opts.style,
      floors: opts.floors,
      width: opts.width,
      length: opts.length,
      wallOverride: opts.wallOverride,
      trimOverride: opts.trimOverride,
      doorOverride: opts.doorOverride,
      roofShape: opts.roofShape,
      roofOverride: opts.roofOverride,
      floorPlanShape: opts.floorPlanShape,
      windowSpacing: opts.windowSpacing,
      roofHeightOverride: opts.roofHeightOverride,
      features: opts.features,
    },
    grid: {
      width: grid.width,
      height: grid.height,
      depth: grid.depth,
      blocks: blockCount,
    },
    views: {
      exterior: { api: `${key}-api_exterior.jpg` },
      cutaway: cutawayPaths,
      floor: floorPaths,
    },
  });
}

// ─── Write combined JSON for the viewer ─────────────────────────────────────

const jsonPath = join(OUT_DIR, 'comparison-data.json');
await writeFile(jsonPath, JSON.stringify(allResults, null, 2));
console.log(`\n+ Wrote ${jsonPath}`);

// ─── Copy to web/public/comparison/ for SPA build ──────────────────────────

const WEB_DIR = 'web/public/comparison';
await mkdir(WEB_DIR, { recursive: true });

// Copy JSON
await writeFile(join(WEB_DIR, 'comparison-data.json'), JSON.stringify(allResults, null, 2));

// Copy all api images
const { readdir, copyFile } = await import('fs/promises');
const outFiles = await readdir(OUT_DIR);
for (const f of outFiles) {
  if (f.endsWith('.jpg') && f.includes('-api_')) {
    await copyFile(join(OUT_DIR, f), join(WEB_DIR, f));
  }
}
console.log(`+ Synced to ${WEB_DIR}/`);
console.log('+ Comparison regeneration complete');
