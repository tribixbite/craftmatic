#!/usr/bin/env bun
/**
 * Render v65 voxelized buildings as semi-transparent overlays on satellite imagery.
 * Uses OSM polygon masking + height filtering to isolate the target building
 * from surrounding terrain (roads, sidewalks, neighboring structures).
 *
 * Outputs per building:
 *   1. block-{name}.jpg  — Actual block colors at 50% opacity on satellite
 *   2. outline-{name}.jpg — Cyan perimeter + height-colored fill on satellite
 *
 * Usage:
 *   bun scripts/render-v65-overlay.ts [--name=noe] [--force] [--no-osm]
 */
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderFootprintOverlay, rasterizePolygonToGridMask } from '../src/render/png-renderer.js';
import { searchOSMBuilding } from '../src/gen/api/osm.js';
import { getBlockColor } from '../src/blocks/colors.js';
import type { RGB } from '../src/types/index.js';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const outDir = join(tilesDir, 'overlay-v65');
await mkdir(outDir, { recursive: true });

const dotenv = await Bun.file(join(projectRoot, '.env')).text();
const apiKey = dotenv.match(/GOOGLE_MAPS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) { console.error('No GOOGLE_MAPS_API_KEY in .env'); process.exit(1); }

interface Building {
  name: string;
  schem: string;
  lat: number;
  lng: number;
  zoom: number;
  satFile?: string;
}

const BUILDINGS: Building[] = [
  { name: 'noe',       schem: 'noe-v65',       lat: 37.7604, lng: -122.4314, zoom: 21, satFile: 'noe-450-satellite' },
  { name: 'green',     schem: 'green-v65',     lat: 37.7954, lng: -122.4332, zoom: 20, satFile: 'green-2390-satellite' },
  { name: 'francisco', schem: 'francisco-v65', lat: 37.8005, lng: -122.4382, zoom: 20, satFile: 'francisco-2340-satellite' },
  { name: 'beach',     schem: 'beach-v65',     lat: 37.8031, lng: -122.4397, zoom: 20, satFile: 'beach-2130-satellite' },
  { name: 'chestnut',  schem: 'chestnut-v65',  lat: 37.8007, lng: -122.4378, zoom: 20, satFile: 'chestnut-2001-satellite' },
  { name: 'dakota',    schem: 'dakota-v65',    lat: 40.7766, lng: -73.9762,  zoom: 20, satFile: 'dakota-satellite' },
  // Sentinel Building = Columbus Tower at Columbus Ave / Kearny St
  { name: 'sentinel',  schem: 'sentinel-v65',  lat: 37.7978, lng: -122.4068, zoom: 20 },
];

const nameArg = process.argv.find(a => a.startsWith('--name='));
const filterName = nameArg ? nameArg.split('=')[1] : null;
const forceArg = process.argv.includes('--force');
const noOsmArg = process.argv.includes('--no-osm');
const freshSatArg = process.argv.includes('--fresh-sat');

function clamp(v: number): number { return Math.max(0, Math.min(255, Math.round(v))); }

/**
 * Render building block colors semi-transparently on satellite image.
 * Uses height filtering + optional OSM polygon to isolate the target building.
 * Draws filled rectangles per grid cell (not single pixels) for correct coverage.
 */
function renderBlockColorOverlay(
  grid: { width: number; height: number; length: number; to3DArray(): string[][][] },
  satRgb: Buffer, satW: number, satH: number,
  opts: {
    resolution: number; lat: number; lng: number; zoom: number;
    opacity?: number;
    osmPolygon?: { lat: number; lon: number }[];
  },
): Buffer {
  const { resolution, lat, lng, zoom } = opts;
  const opacity = opts.opacity ?? 0.5;
  const { width: w, height: h, length: l } = grid;
  const blocks = grid.to3DArray();

  const DEG2RAD = Math.PI / 180;
  const metersPerPx = 156543.03392 * Math.cos(lat * DEG2RAD) / Math.pow(2, zoom);
  const blocksPerSatPx = metersPerPx * resolution;
  const blockSizePx = 1 / blocksPerSatPx;

  // Build heightmap
  let maxH = 0;
  const heightmap = new Int16Array(w * l);
  heightmap.fill(-1);
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      for (let y = h - 1; y >= 0; y--) {
        if (blocks[y][z][x] !== 'minecraft:air') {
          heightmap[z * w + x] = y;
          if (y > maxH) maxH = y;
          break;
        }
      }
    }
  }

  // Centroid of tall blocks (>50% max height) — anchors on the building, not terrain
  const tallThresh = maxH * 0.5;
  let sumX = 0, sumZ = 0, cnt = 0;
  let sumXAll = 0, sumZAll = 0, cntAll = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      const hy = heightmap[z * w + x];
      if (hy >= 0) {
        sumXAll += x; sumZAll += z; cntAll++;
        if (hy >= tallThresh) { sumX += x; sumZ += z; cnt++; }
      }
    }
  }
  const gcx = cnt > 0 ? sumX / cnt : (cntAll > 0 ? sumXAll / cntAll : w / 2);
  const gcz = cnt > 0 ? sumZ / cnt : (cntAll > 0 ? sumZAll / cntAll : l / 2);
  const scx = satW / 2;
  const scy = satH / 2;

  // OSM polygon mask (isolate target building from surroundings)
  let polyMask: Uint8Array | null = null;
  if (opts.osmPolygon && opts.osmPolygon.length >= 3) {
    polyMask = rasterizePolygonToGridMask(
      opts.osmPolygon, lat, lng, gcx, gcz, resolution, w, l,
    );
    const polyCount = polyMask.reduce((s, v) => s + v, 0);
    console.log(`  OSM mask: ${polyCount}/${w * l} cells (${(100 * polyCount / (w * l)).toFixed(1)}%)`);
  }

  // Height filtering — find ground plane via histogram
  const hist = new Int32Array(maxH + 1);
  for (let i = 0; i < w * l; i++) {
    const hy = heightmap[i];
    if (hy >= 0) hist[hy]++;
  }
  const groundSearchMax = Math.max(3, Math.ceil(maxH * 0.3));
  let groundPeak = 0, groundPeakCount = 0;
  for (let y = 0; y <= groundSearchMax; y++) {
    if (hist[y] > groundPeakCount) { groundPeakCount = hist[y]; groundPeak = y; }
  }
  const groundFloor = groundPeak + Math.ceil(resolution * 0.5);
  const staticFloor = maxH * 0.15;
  const minHeight = Math.max(groundFloor, staticFloor);

  // Combined building mask: height + polygon
  const isBuilding = new Uint8Array(w * l);
  let buildingCount = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (heightmap[i] < minHeight) continue;
      if (polyMask && !polyMask[i]) continue;
      isBuilding[i] = 1;
      buildingCount++;
    }
  }
  // Fallback: if OSM mask yielded 0 cells, use height-only
  if (buildingCount === 0 && polyMask) {
    console.log(`  OSM mask yielded 0 — falling back to height-only`);
    for (let i = 0; i < w * l; i++) {
      if (heightmap[i] >= minHeight) { isBuilding[i] = 1; buildingCount++; }
    }
  }
  console.log(`  Building: ${buildingCount}/${w * l} cells, ground=Y${groundPeak}, minH=Y${minHeight.toFixed(0)}`);
  console.log(`  Scale: ${blockSizePx.toFixed(1)} sat-px/block`);

  // Copy satellite as RGBA base
  const pixels = Buffer.alloc(satW * satH * 4);
  for (let y = 0; y < satH; y++) {
    for (let x = 0; x < satW; x++) {
      const si = (y * satW + x) * 3;
      const di = (y * satW + x) * 4;
      pixels[di] = satRgb[si];
      pixels[di + 1] = satRgb[si + 1];
      pixels[di + 2] = satRgb[si + 2];
      pixels[di + 3] = 255;
    }
  }

  // Block color cache
  const colorCache = new Map<string, RGB | null>();
  function cached(bs: string): RGB | null {
    let c = colorCache.get(bs);
    if (c !== undefined) return c;
    c = getBlockColor(bs);
    colorCache.set(bs, c);
    return c;
  }

  // Overlay building blocks — filled rectangles per grid cell
  let drawn = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      if (!isBuilding[z * w + x]) continue;
      const hy = heightmap[z * w + x];
      const topBlock = blocks[hy][z][x];
      const color = cached(topBlock);
      if (!color) continue;

      // Map grid cell corners to satellite pixel rectangle
      const sx0 = Math.round(scx + (x - 0.5 - gcx) / blocksPerSatPx);
      const sy0 = Math.round(scy + (z - 0.5 - gcz) / blocksPerSatPx);
      const sx1 = Math.round(scx + (x + 0.5 - gcx) / blocksPerSatPx);
      const sy1 = Math.round(scy + (z + 0.5 - gcz) / blocksPerSatPx);

      // Tint block colors slightly green so gray blocks are distinguishable from gray roofs
      const tintR = clamp(color[0] * 0.6);
      const tintG = clamp(Math.min(255, color[1] * 0.8 + 60));
      const tintB = clamp(color[2] * 0.5);

      for (let py = Math.max(0, sy0); py <= Math.min(satH - 1, sy1); py++) {
        for (let px = Math.max(0, sx0); px <= Math.min(satW - 1, sx1); px++) {
          const di = (py * satW + px) * 4;
          pixels[di] = clamp(pixels[di] * (1 - opacity) + tintR * opacity);
          pixels[di + 1] = clamp(pixels[di + 1] * (1 - opacity) + tintG * opacity);
          pixels[di + 2] = clamp(pixels[di + 2] * (1 - opacity) + tintB * opacity);
          drawn++;
        }
      }
    }
  }
  console.log(`  Block overlay: ${drawn} sat-pixels, ${colorCache.size} unique blocks`);
  return pixels;
}

// ── Main ──

for (const b of BUILDINGS) {
  if (filterName && !b.name.includes(filterName)) continue;

  const schemPath = join(tilesDir, `${b.schem}.schem`);
  if (!existsSync(schemPath)) {
    console.log(`  ${b.name}: SKIP (no schem)`);
    continue;
  }

  console.log(`\n=== ${b.name} ===`);
  const grid = await parseToGrid(schemPath);
  console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length}`);

  // Fetch OSM polygon for building isolation
  let osmPolygon: { lat: number; lon: number }[] | undefined;
  if (!noOsmArg) {
    try {
      const osmData = await searchOSMBuilding(b.lat, b.lng, 100);
      if (osmData?.polygon && osmData.polygon.length >= 3) {
        osmPolygon = osmData.polygon;
        console.log(`  OSM: ${osmPolygon.length} verts, ${osmData.widthMeters.toFixed(0)}x${osmData.lengthMeters.toFixed(0)}m`);
      } else {
        console.log(`  OSM: no polygon found`);
      }
    } catch (e) {
      console.log(`  OSM: query failed (${(e as Error).message})`);
    }
  }

  // Load or fetch satellite image
  let satRgb: Buffer, satW: number, satH: number;
  const localSat = (!freshSatArg && b.satFile) ? join(tilesDir, `${b.satFile}.jpg`) : '';
  if (localSat && existsSync(localSat)) {
    const meta = await sharp(localSat).metadata();
    satRgb = await sharp(localSat).removeAlpha().raw().toBuffer();
    satW = meta.width!; satH = meta.height!;
    console.log(`  Satellite: ${satW}x${satH} (local)`);
  } else {
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${b.lat},${b.lng}&zoom=${b.zoom}&size=640x640&maptype=satellite&key=${apiKey}`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const meta = await sharp(buf).metadata();
    satRgb = await sharp(buf).removeAlpha().raw().toBuffer();
    satW = meta.width!; satH = meta.height!;
    console.log(`  Satellite: ${satW}x${satH} (fetched)`);
  }

  // 1. Block-color overlay (60% opacity, building-only)
  const blockPx = renderBlockColorOverlay(grid, satRgb, satW, satH, {
    resolution: 1, lat: b.lat, lng: b.lng, zoom: b.zoom,
    opacity: 0.6, osmPolygon,
  });
  const blockJpg = await sharp(blockPx, { raw: { width: satW, height: satH, channels: 4 } })
    .jpeg({ quality: 90 }).toBuffer();
  await writeFile(join(outDir, `block-${b.name}.jpg`), blockJpg);
  console.log(`  → block overlay: ${(blockJpg.length / 1024).toFixed(0)}KB`);

  // 2. Outline overlay (cyan perimeter + height fill)
  const DEG2RAD = Math.PI / 180;
  const mpp = 156543.03392 * Math.cos(b.lat * DEG2RAD) / Math.pow(2, b.zoom);
  const blockPxSize = 1 / (mpp * 1);
  const outlineW = Math.max(3, Math.ceil(blockPxSize * 0.4));
  const outlinePng = await renderFootprintOverlay(grid, satRgb, satW, satH, {
    resolution: 1, lat: b.lat, lng: b.lng, zoom: b.zoom,
    osmPolygon, fillOpacity: 0.35, outlineWidth: outlineW,
  });
  const outlineJpg = await sharp(outlinePng).jpeg({ quality: 90 }).toBuffer();
  await writeFile(join(outDir, `outline-${b.name}.jpg`), outlineJpg);
  console.log(`  → outline overlay: ${(outlineJpg.length / 1024).toFixed(0)}KB`);

  // 3. Grade composite: satellite (left) | outline overlay (right)
  // Both at same size for direct 1:1 comparison — center cropped to building area
  const targetH = 640;
  const gap = 4; // pixel gap between panels
  const satJpg = await sharp(Buffer.from(satRgb), { raw: { width: satW, height: satH, channels: 3 } })
    .resize({ width: targetH, height: targetH, fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
  const ovResized = await sharp(outlinePng)
    .resize({ width: targetH, height: targetH, fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
  const totalW = targetH * 2 + gap;

  const composite = await sharp({
    create: { width: totalW, height: targetH, channels: 3, background: { r: 20, g: 20, b: 20 } }
  })
    .composite([
      { input: satJpg, left: 0, top: 0 },
      { input: ovResized, left: targetH + gap, top: 0 },
    ])
    .jpeg({ quality: 90 }).toBuffer();
  await writeFile(join(outDir, `grade-${b.name}.jpg`), composite);
  console.log(`  → grade composite: ${totalW}x${targetH} ${(composite.length / 1024).toFixed(0)}KB`);

  if (typeof Bun !== 'undefined') Bun.gc(true);
}

console.log('\nDone! Check output/tiles/overlay-v65/');
