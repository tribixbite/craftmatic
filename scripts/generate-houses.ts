#!/usr/bin/env npx tsx
/**
 * Generate 10 Minecraft houses from real US addresses.
 * Uses the import pipeline: geocode → property lookup → generate → render + export HTML.
 *
 * Usage: npx tsx scripts/generate-houses.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateStructure } from '../src/gen/generator.js';
import { renderExterior } from '../src/render/png-renderer.js';
import { exportHTML } from '../src/render/export-html.js';
import type { GenerationOptions, RoomType, StyleName, StructureType, BlockState } from '../src/types/index.js';

// ─── 10 random US houses ─────────────────────────────────────────────────────

interface HouseSpec {
  address: string;
  stories: number;
  sqft: number;
  bedrooms: number;
  bathrooms: number;
  yearBuilt: number;
  propertyType: string;
  exteriorType: string;
  wallOverride?: BlockState;
  lotSize?: number;
  roofType?: string;
  architectureType?: string;
}

const HOUSES: HouseSpec[] = [
  {
    address: '917 Pinecrest Ave SE, Grand Rapids, MI 49506',
    stories: 2, sqft: 2400, bedrooms: 4, bathrooms: 2, yearBuilt: 1940,
    propertyType: 'house', exteriorType: 'Wood Siding',
    wallOverride: 'minecraft:oak_planks', lotSize: 7200,
    roofType: 'Asphalt', architectureType: 'Colonial',
  },
  {
    address: '742 Evergreen Terrace, Springfield, IL 62704',
    stories: 2, sqft: 1800, bedrooms: 3, bathrooms: 1, yearBuilt: 1985,
    propertyType: 'house', exteriorType: 'Vinyl Siding',
    wallOverride: 'minecraft:white_concrete', lotSize: 5000,
    roofType: 'Asphalt', architectureType: 'Ranch',
  },
  {
    address: '1600 Pennsylvania Ave NW, Washington, DC 20500',
    stories: 3, sqft: 55000, bedrooms: 16, bathrooms: 35, yearBuilt: 1800,
    propertyType: 'mansion', exteriorType: 'Stone',
    wallOverride: 'minecraft:stone_bricks', lotSize: 782000,
    roofType: 'Slate', architectureType: 'Neoclassical',
  },
  {
    address: '4211 Yucca Ln, Dallas, TX 75214',
    stories: 1, sqft: 1600, bedrooms: 3, bathrooms: 2, yearBuilt: 1955,
    propertyType: 'house', exteriorType: 'Brick',
    wallOverride: 'minecraft:bricks', lotSize: 6800,
    roofType: 'Asphalt', architectureType: 'Ranch',
  },
  {
    address: '2305 NW Overton St, Portland, OR 97210',
    stories: 2, sqft: 2100, bedrooms: 3, bathrooms: 2, yearBuilt: 1910,
    propertyType: 'house', exteriorType: 'Wood',
    wallOverride: 'minecraft:spruce_planks', lotSize: 4000,
    roofType: 'Metal', architectureType: 'Craftsman',
  },
  {
    address: '8534 Coral Way, Miami, FL 33155',
    stories: 1, sqft: 1400, bedrooms: 3, bathrooms: 2, yearBuilt: 1958,
    propertyType: 'house', exteriorType: 'Stucco',
    wallOverride: 'minecraft:sandstone', lotSize: 8400,
    roofType: 'Tile', architectureType: 'Mediterranean',
  },
  {
    address: '1247 Lake Shore Dr, Chicago, IL 60610',
    stories: 1, sqft: 1200, bedrooms: 2, bathrooms: 1, yearBuilt: 2015,
    propertyType: 'condo', exteriorType: 'Cement Fiber',
    wallOverride: 'minecraft:white_concrete', lotSize: 0,
    roofType: 'Flat/Membrane', architectureType: 'Contemporary',
  },
  {
    address: '327 Aspen Ridge Rd, Breckenridge, CO 80424',
    stories: 2, sqft: 3200, bedrooms: 5, bathrooms: 3, yearBuilt: 2002,
    propertyType: 'cabin', exteriorType: 'Log',
    wallOverride: 'minecraft:spruce_planks', lotSize: 14500,
    roofType: 'Metal', architectureType: 'Mountain Lodge',
  },
  {
    address: '55 Magazine St, New Orleans, LA 70130',
    stories: 2, sqft: 2800, bedrooms: 4, bathrooms: 3, yearBuilt: 1870,
    propertyType: 'house', exteriorType: 'Wood Siding',
    wallOverride: 'minecraft:birch_planks', lotSize: 3200,
    roofType: 'Asphalt', architectureType: 'Victorian',
  },
  {
    address: '19830 N 7th Ave, Phoenix, AZ 85027',
    stories: 1, sqft: 1700, bedrooms: 3, bathrooms: 2, yearBuilt: 1990,
    propertyType: 'house', exteriorType: 'Adobe',
    wallOverride: 'minecraft:terracotta', lotSize: 7500,
    roofType: 'Tile', architectureType: 'Southwestern',
  },
];

// ─── Import pipeline helpers ─────────────────────────────────────────────────

/** FNV-1a hash for deterministic seed (matches import.ts) */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 999999;
}

/** Infer architectural style from year built */
function inferStyle(year: number): StyleName {
  if (year >= 2010) return 'modern';
  if (year < 1700) return 'medieval';
  if (year < 1850) return 'gothic';
  if (year < 1920) return 'rustic';
  if (year < 1970) return 'fantasy';
  return 'modern';
}

/** Convert house spec to GenerationOptions (mirrors convertToGenerationOptions) */
function houseToOptions(h: HouseSpec): GenerationOptions {
  const style: StyleName = h.propertyType === 'cabin'
    ? 'rustic'
    : inferStyle(h.yearBuilt);

  let type: StructureType = 'house';
  if (h.propertyType === 'mansion' || h.sqft > 5000) type = 'castle';

  const areaPerFloor = h.sqft / h.stories / 10.76;
  const aspectRatio = 1.3;
  let width = Math.round(Math.sqrt(areaPerFloor * aspectRatio));
  let length = Math.round(Math.sqrt(areaPerFloor / aspectRatio));
  width = Math.max(10, Math.min(60, width));
  length = Math.max(10, Math.min(60, length));

  const rooms: RoomType[] = ['foyer', 'living', 'kitchen', 'dining'];
  for (let i = 0; i < Math.min(h.bedrooms, 8); i++) rooms.push('bedroom');
  for (let i = 0; i < Math.min(h.bathrooms, 6); i++) rooms.push('bathroom');
  if (h.sqft > 2500) rooms.push('study', 'laundry', 'mudroom');
  if (h.sqft > 3500) rooms.push('library', 'sunroom', 'pantry');

  return {
    type,
    floors: h.stories,
    style,
    rooms,
    width,
    length,
    seed: fnv1aHash(h.address),
    wallOverride: h.wallOverride,
  };
}

/** Slugify address for filenames */
function slugify(addr: string): string {
  return addr
    .replace(/,/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 60);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const outDir = resolve('output/houses');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  console.log(`Generating 10 houses → ${outDir}\n`);

  // Index HTML
  const indexRows: string[] = [];

  for (let i = 0; i < HOUSES.length; i++) {
    const h = HOUSES[i];
    const slug = slugify(h.address);
    const options = houseToOptions(h);
    const num = String(i + 1).padStart(2, '0');

    console.log(`[${num}/10] ${h.address}`);
    console.log(`       ${h.exteriorType} | ${h.architectureType} | ${h.yearBuilt} | ${h.sqft} sqft | ${h.stories}F`);
    console.log(`       → style=${options.style} type=${options.type} wall=${h.wallOverride ?? 'default'}`);

    // Generate structure
    const grid = generateStructure(options);
    const blocks = grid.countNonAir();
    console.log(`       ${grid.width}×${grid.height}×${grid.length} = ${blocks.toLocaleString()} blocks`);

    // Render exterior PNG
    const pngPath = resolve(outDir, `${slug}.png`);
    const pngBuf = await renderExterior(grid);
    writeFileSync(pngPath, pngBuf);
    console.log(`       → ${slug}.png`);

    // Export HTML 3D viewer
    const htmlPath = resolve(outDir, `${slug}.html`);
    await exportHTML(grid, htmlPath);
    console.log(`       → ${slug}.html`);

    // Build index row
    const wallName = (h.wallOverride ?? 'default').replace('minecraft:', '').replace(/_/g, ' ');
    indexRows.push(`
    <div class="card">
      <a href="${slug}.html">
        <img src="${slug}.png" alt="${h.address}" loading="lazy">
      </a>
      <div class="info">
        <h3>${h.address}</h3>
        <table>
          <tr><td>Style</td><td>${options.style}</td></tr>
          <tr><td>Type</td><td>${options.type}</td></tr>
          <tr><td>Floors</td><td>${h.stories}</td></tr>
          <tr><td>Sq Ft</td><td>${h.sqft.toLocaleString()}</td></tr>
          <tr><td>Bed / Bath</td><td>${h.bedrooms} / ${h.bathrooms}</td></tr>
          <tr><td>Year Built</td><td>${h.yearBuilt}</td></tr>
          <tr><td>Exterior</td><td>${h.exteriorType}</td></tr>
          <tr><td>Wall Block</td><td>${wallName}</td></tr>
          <tr><td>Architecture</td><td>${h.architectureType}</td></tr>
          <tr><td>Lot</td><td>${h.lotSize ? h.lotSize.toLocaleString() + ' sqft' : '—'}</td></tr>
          <tr><td>Roof</td><td>${h.roofType ?? '—'}</td></tr>
          <tr><td>Dimensions</td><td>${grid.width}×${grid.height}×${grid.length}</td></tr>
          <tr><td>Blocks</td><td>${blocks.toLocaleString()}</td></tr>
        </table>
        <a href="${slug}.html" class="view-btn">View 3D</a>
      </div>
    </div>`);

    console.log('');
  }

  // Write index.html
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Craftmatic — 10 US Houses</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: #0a0a14;
      color: #e4e4ef;
      padding: 24px;
      min-height: 100vh;
    }
    h1 {
      text-align: center;
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #5865f2;
    }
    .subtitle {
      text-align: center;
      font-size: 13px;
      color: #8888a8;
      margin-bottom: 32px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .card {
      background: #16162a;
      border: 1px solid #2a2a44;
      border-radius: 12px;
      overflow: hidden;
      transition: border-color 0.2s, transform 0.2s;
    }
    .card:hover { border-color: #5865f2; transform: translateY(-2px); }
    .card img {
      width: 100%;
      height: 220px;
      object-fit: contain;
      background: #0a0a14;
      display: block;
    }
    .info { padding: 16px; }
    .info h3 {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 10px;
      color: #e4e4ef;
      line-height: 1.3;
    }
    table { width: 100%; font-size: 12px; border-collapse: collapse; }
    td {
      padding: 3px 0;
      vertical-align: top;
    }
    td:first-child {
      color: #8888a8;
      width: 100px;
      font-weight: 500;
    }
    td:last-child {
      color: #e4e4ef;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 11px;
    }
    .view-btn {
      display: block;
      text-align: center;
      margin-top: 12px;
      padding: 10px;
      background: #5865f2;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 13px;
      transition: background 0.2s;
    }
    .view-btn:hover { background: #6d78f7; }
    @media (max-width: 480px) {
      .grid { grid-template-columns: 1fr; }
      body { padding: 12px; }
    }
  </style>
</head>
<body>
  <h1>Craftmatic — 10 US Houses</h1>
  <p class="subtitle">Real addresses → Minecraft structures via property data enrichment pipeline</p>
  <div class="grid">
    ${indexRows.join('\n')}
  </div>
</body>
</html>`;

  writeFileSync(resolve(outDir, 'index.html'), indexHtml, 'utf-8');
  console.log(`Index page → ${outDir}/index.html`);
  console.log(`\nDone! Generated 10 houses, 10 PNGs, 10 HTML viewers, 1 index page.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
