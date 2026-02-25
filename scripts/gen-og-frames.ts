#!/usr/bin/env bun
/**
 * Generate diverse structure renders for the OG preview animated WebP.
 * Produces isometric exterior + cutaway PNGs for: ship, wizard tower,
 * village, marketplace, cathedral, plus clean house exteriors/cutaways.
 *
 * Usage: bun scripts/gen-og-frames.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateStructure } from '../src/gen/generator.js';
import { renderExterior, renderCutawayIso } from '../src/render/png-renderer.js';
import type { StructureType, StyleName, FloorPlanShape, RoofShape } from '../src/types/index.js';

interface FrameSpec {
  type: StructureType;
  style: StyleName;
  floors: number;
  seed: number;
  label: string;
  mode: 'exterior' | 'cutaway';
  cutawayStory?: number;
  roofShape?: RoofShape;
  planShape?: FloorPlanShape;
}

// Diverse structures for showcase — user requested ship, wizard tower,
// village, marketplace, cutaway views. Clean houses only (no Byron/LA/SF).
const FRAMES: FrameSpec[] = [
  // Wizard Tower — exterior
  { type: 'tower', style: 'fantasy', floors: 5, seed: 700, label: 'wizard-tower', mode: 'exterior' },
  // Ship — exterior
  { type: 'ship', style: 'rustic', floors: 2, seed: 500, label: 'rustic-ship', mode: 'exterior' },
  // Medieval Village — exterior
  { type: 'village', style: 'medieval', floors: 1, seed: 42, label: 'medieval-village', mode: 'exterior' },
  // Desert Marketplace — exterior
  { type: 'marketplace', style: 'desert', floors: 1, seed: 55, label: 'desert-bazaar', mode: 'exterior' },
  // Gothic Cathedral — exterior
  { type: 'cathedral', style: 'gothic', floors: 1, seed: 7, label: 'gothic-cathedral', mode: 'exterior' },
  // Fantasy Galleon — exterior
  { type: 'ship', style: 'fantasy', floors: 2, seed: 1100, label: 'fantasy-galleon', mode: 'exterior' },
  // Dark Fortress — exterior
  { type: 'castle', style: 'gothic', floors: 3, seed: 800, label: 'dark-fortress', mode: 'exterior' },
  // Wizard Tower — cutaway (inside view)
  { type: 'tower', style: 'fantasy', floors: 5, seed: 700, label: 'wizard-tower-inside', mode: 'cutaway', cutawayStory: 1 },
  // Medieval Castle — cutaway
  { type: 'castle', style: 'medieval', floors: 2, seed: 200, label: 'medieval-castle-inside', mode: 'cutaway', cutawayStory: 0 },
  // Fantasy Cottage — cutaway
  { type: 'house', style: 'fantasy', floors: 2, seed: 42, label: 'fantasy-cottage-inside', mode: 'cutaway', cutawayStory: 0 },
];

const outDir = resolve(import.meta.dir, '../output/og-frames');

async function main() {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  for (const frame of FRAMES) {
    console.log(`Generating ${frame.label} (${frame.type}/${frame.style}, ${frame.mode})...`);

    const grid = generateStructure({
      type: frame.type,
      floors: frame.floors,
      style: frame.style,
      seed: frame.seed,
      ...(frame.roofShape ? { roofShape: frame.roofShape } : {}),
      ...(frame.planShape ? { floorPlanShape: frame.planShape } : {}),
    });

    let png: Buffer;
    if (frame.mode === 'cutaway') {
      png = await renderCutawayIso(grid, frame.cutawayStory ?? 0, { tile: 12 });
    } else {
      png = await renderExterior(grid, { tile: 10 });
    }

    const path = resolve(outDir, `${frame.label}.png`);
    writeFileSync(path, png);
    console.log(`  → ${path} (${png.length} bytes)`);
  }

  console.log(`\nDone! ${FRAMES.length} frames in ${outDir}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
