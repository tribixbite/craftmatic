#!/usr/bin/env bun
/**
 * Test script for SV analysis pipeline — bypasses CLI argument parsing.
 * Run with: grun ~/.bun/bin/buno scripts/gen-sv-test.ts
 *
 * Downloads a SV image for a known address and runs the 3-tier analysis,
 * printing results to stdout. Does NOT generate a schematic — only tests
 * the image analysis pipeline.
 */

import { analyzeStreetView } from '../src/gen/api/streetview-analysis.js';

const API_KEY = 'AIzaSyBPniMxwbDkguqjiEUzZ1eeQNfjOCaPUY4';

// Test addresses with known SV coverage
const TESTS = [
  {
    label: 'Grand Rapids (industrial)',
    lat: 42.973766, lon: -85.679793, heading: 180,
  },
  {
    label: 'SF Francisco St (residential)',
    lat: 37.80108, lon: -122.43855, heading: 340,
  },
  {
    label: 'Newton Highland St (Victorian)',
    lat: 42.33002, lon: -71.20726, heading: 100,
  },
];

for (const test of TESTS) {
  const url = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${test.lat},${test.lon}&heading=${test.heading}&pitch=10&fov=90&key=${API_KEY}`;

  console.log(`\n=== ${test.label} ===`);
  console.log(`URL: ${url.substring(0, 80)}...`);

  const result = await analyzeStreetView(url, true); // skipVision=true (no API key needed)

  if (result.isIndoor) {
    console.log('  INDOOR PANORAMA — skipped');
    continue;
  }

  if (result.colors) {
    const c = result.colors;
    console.log(`  Colors:`);
    console.log(`    Wall: rgb(${c.wallColor.r}, ${c.wallColor.g}, ${c.wallColor.b}) → ${c.wallBlock}`);
    console.log(`    Roof: rgb(${c.roofColor.r}, ${c.roofColor.g}, ${c.roofColor.b}) → ${c.roofOverride.cap}`);
    console.log(`    Trim: rgb(${c.trimColor.r}, ${c.trimColor.g}, ${c.trimColor.b}) → ${c.trimBlock}`);
  } else {
    console.log('  Colors: null (no valid building pixels)');
  }

  if (result.structure) {
    const s = result.structure;
    console.log(`  Structure:`);
    console.log(`    Stories: ${s.stories.storyCount} (confidence ${s.stories.confidence.toFixed(2)})`);
    console.log(`    Texture: ${s.texture.textureClass} (entropy ${s.texture.entropy.toFixed(0)}) → ${s.texture.suggestedBlock}`);
    console.log(`    Roof: ${s.roofPitch.roofType} (${s.roofPitch.pitchDegrees.toFixed(0)}°, override ${s.roofPitch.roofHeightOverride})`);
    console.log(`    Symmetry: ${s.symmetry.symmetryScore.toFixed(2)} → ${s.symmetry.isSymmetric ? 'symmetric' : 'asymmetric'} → ${s.symmetry.suggestedPlanShape}`);
    console.log(`    Setback: lawn ${(s.setback.lawnDepthRatio * 100).toFixed(0)}% | driveway=${s.setback.hasVisibleDriveway} | path=${s.setback.hasVisiblePath}`);
    console.log(`    Features: ${JSON.stringify(s.setback.suggestedFeatures)}`);
    console.log(`    Windows: ${s.fenestration.windowCount} total, ${s.fenestration.windowsPerFloor}/floor, ratio ${s.fenestration.windowWallRatio.toFixed(3)} → spacing ${s.fenestration.suggestedSpacing}`);
  } else {
    console.log('  Structure: null');
  }

  console.log(`  Vision: ${result.vision ? JSON.stringify(result.vision) : 'skipped'}`);
}

console.log('\n✓ SV analysis pipeline test complete');
