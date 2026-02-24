#!/usr/bin/env bun
/**
 * Regenerate comparison images with SV analysis active.
 * Bypasses CLI argument parsing issues by calling pipeline functions directly.
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

import { analyzeStreetView } from '../src/gen/api/streetview-analysis.js';
import { generateStructure } from '../src/gen/generator.js';
import {
  convertToGenerationOptions, estimateStoriesFromFootprint,
  type PropertyData,
} from '../src/gen/address-pipeline.js';
import { searchParclProperty, mapParclPropertyType, hasParclApiKey } from '../src/gen/api/parcl.js';
import { searchOSMBuilding, parseClosestBuilding } from '../src/gen/api/osm.js';
import { queryStreetViewMetadata, hasGoogleStreetViewKey } from '../src/gen/api/google-streetview.js';
import { renderFloorDetail, renderCutawayIso, renderExterior } from '../src/render/png-renderer.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';

const OUT_DIR = 'output/comparison';

// Addresses to regenerate
const ADDRESSES = [
  { key: 'sf', address: '2340 Francisco St, San Francisco, CA 94123' },
  { key: 'newton', address: '240 Highland St, Newton, MA 02465' },
  { key: 'sanjose', address: '525 S Winchester Blvd, San Jose, CA 95128' },
];

if (!hasParclApiKey()) {
  console.error('ERROR: PARCL_API_KEY not set');
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });

/** Convert PNG Buffer to JPEG for smaller file sizes */
async function toJpeg(pngBuf: Buffer): Promise<Buffer> {
  return sharp(pngBuf).jpeg({ quality: 85 }).toBuffer();
}

for (const { key, address } of ADDRESSES) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${key}: ${address}`);
  console.log(`${'='.repeat(60)}`);

  // Step 1: Parcl lookup
  const parcl = await searchParclProperty(address);
  if (!parcl) {
    console.log('  Parcl: not found, skipping');
    continue;
  }
  console.log(`  Parcl: ${parcl.squareFootage} sqft, ${parcl.bedrooms}bd/${parcl.bathrooms}ba, yr=${parcl.yearBuilt}`);

  const lat = parcl.latitude;
  const lng = parcl.longitude;

  // Step 2: OSM lookup
  let osmData: ReturnType<typeof parseClosestBuilding> | null = null;
  if (lat && lng) {
    try {
      const osmResult = await searchOSMBuilding(lat, lng);
      osmData = parseClosestBuilding(osmResult, lat, lng);
    } catch { /* ignore */ }
  }
  if (osmData) {
    console.log(`  OSM: ${osmData.widthMeters?.toFixed(1)}×${osmData.lengthMeters?.toFixed(1)}m, levels=${osmData.levels || '?'}`);
  }

  // Step 3: Street View metadata
  let svImageUrl: string | undefined;
  if (lat && lng && hasGoogleStreetViewKey()) {
    try {
      const svMeta = await queryStreetViewMetadata(lat, lng, osmData?.polygon);
      if (svMeta) {
        svImageUrl = svMeta.imageUrl;
        console.log(`  SV: heading=${svMeta.heading.toFixed(0)}° date=${svMeta.date || '?'}`);
      }
    } catch { /* ignore */ }
  }

  // Build PropertyData
  const sqft = parcl.squareFootage || 2500;
  const yearBuilt = parcl.yearBuilt || 2000;
  const yearUncertain = !parcl.yearBuilt;
  let stories = 2;
  if (osmData?.levels) {
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
    osmWidth: osmData?.widthMeters ? Math.round(osmData.widthMeters) : undefined,
    osmLength: osmData?.lengthMeters ? Math.round(osmData.lengthMeters) : undefined,
    osmLevels: osmData?.levels,
    osmArchitecture: osmData?.tags?.['building:architecture'] ?? osmData?.tags?.['architect'] ?? undefined,
    osmRoofShape: osmData?.tags?.['roof:shape'] ?? undefined,
    osmRoofMaterial: osmData?.tags?.['roof:material'] ?? undefined,
    osmRoofColour: osmData?.tags?.['roof:colour'] ?? undefined,
    osmBuildingColour: osmData?.tags?.['building:colour'] ?? undefined,
    osmMaterial: osmData?.tags?.['building:material'] ?? undefined,
  };

  // Step 4: SV Image Analysis (the new part!)
  if (svImageUrl) {
    console.log('  Analyzing SV image...');
    const svAnalysis = await analyzeStreetView(svImageUrl, true); // skipVision for now

    if (svAnalysis.isIndoor) {
      console.log('  SV: INDOOR PANORAMA — analysis skipped');
    } else {
      if (svAnalysis.colors) {
        property.svWallOverride = svAnalysis.colors.wallBlock;
        property.svRoofOverride = svAnalysis.colors.roofOverride;
        property.svTrimOverride = svAnalysis.colors.trimBlock;
        const c = svAnalysis.colors;
        console.log(`  SV Colors: wall=${c.wallBlock.replace('minecraft:', '')} roof=${c.roofOverride.cap.replace('minecraft:', '')} trim=${c.trimBlock.replace('minecraft:', '')}`);
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
        console.log(`  SV Structure: ${s.stories.storyCount} stories | ${s.texture.textureClass} | ${s.roofPitch.roofType} pitch (${s.roofPitch.pitchDegrees.toFixed(0)}°) | ${s.symmetry.isSymmetric ? 'sym' : 'asym'} | ${s.fenestration.windowsPerFloor} win/floor`);
        if (s.setback.lawnDepthRatio > 0.05 || s.setback.hasVisibleDriveway) {
          console.log(`  SV Setback: lawn=${(s.setback.lawnDepthRatio * 100).toFixed(0)}% driveway=${s.setback.hasVisibleDriveway} path=${s.setback.hasVisiblePath}`);
        }
      }
    }
  }

  // Step 5: Convert and generate
  const opts = convertToGenerationOptions(property);
  console.log(`  Gen: ${opts.style} ${opts.floors}f ${opts.width || '?'}×${opts.length || '?'}`);
  console.log(`    wall=${opts.wallOverride || 'default'} trim=${opts.trimOverride || 'default'} roof=${opts.roofOverride?.cap || 'default'} door=${opts.doorOverride || 'default'}`);
  console.log(`    shape=${opts.floorPlanShape || 'rect'} roofShape=${opts.roofShape || 'gable'} windowSpacing=${opts.windowSpacing || 3}`);

  const grid = generateStructure(opts);
  console.log(`  Grid: ${grid.width}×${grid.height}×${grid.depth}, ${grid.countNonAir()} blocks`);

  // Step 6: Render images
  console.log('  Rendering...');

  const extBuf = await renderExterior(grid, { tile: 8 });
  const extPath = join(OUT_DIR, `${key}-api_exterior.jpg`);
  await writeFile(extPath, await toJpeg(extBuf));

  for (let f = 0; f < Math.min(opts.floors, 9); f++) {
    const cutBuf = await renderCutawayIso(grid, f, { tile: 8 });
    const cutPath = join(OUT_DIR, `${key}-api_cutaway_${f}.jpg`);
    await writeFile(cutPath, await toJpeg(cutBuf));

    const floorBuf = await renderFloorDetail(grid, f, { scale: 16 });
    const floorPath = join(OUT_DIR, `${key}-api_floor_${f}.jpg`);
    await writeFile(floorPath, await toJpeg(floorBuf));
  }

  console.log(`  ✓ ${1 + opts.floors * 2} images saved to ${OUT_DIR}/${key}-api_*`);
}

console.log('\n✓ Comparison regeneration complete');
