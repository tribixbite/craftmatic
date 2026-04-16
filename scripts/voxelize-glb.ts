/**
 * CLI standalone GLB → .schem voxelizer.
 *
 * Reads a previously-saved GLB file (from the browser tiles pipeline),
 * runs the voxelizer with configurable params, and writes a .schem file.
 * No API calls — iterate on parameters until the output is clean.
 *
 * Usage:
 *   bun scripts/voxelize-glb.ts <input.glb> [options]
 *
 * Options:
 *   --resolution, -r   Blocks per meter (default: 1)
 *   --mode, -m         solid | surface (default: surface)
 *   --min-height       Min mesh height above ground to keep, meters (default: 2)
 *   --trim             Bottom-layer trim fill threshold, 0-1 (default: 0.05)
 *   --output, -o       Output .schem path (default: <input-stem>.schem)
 *   --info             Print mesh stats and exit (no voxelize)
 */

// Polyfill browser APIs that Three.js FileLoader expects in headless Bun
if (typeof globalThis.ProgressEvent === 'undefined') {
  (globalThis as Record<string, unknown>).ProgressEvent = class ProgressEvent extends Event {
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(type: string, init?: { lengthComputable?: boolean; loaded?: number; total?: number }) {
      super(type);
      this.lengthComputable = init?.lengthComputable ?? false;
      this.loaded = init?.loaded ?? 0;
      this.total = init?.total ?? 0;
    }
  };
}

import * as THREE from 'three';
import { threeToGrid, createDataTextureSampler } from '../src/convert/voxelizer.js';
import { filterMeshesByHeight, trimSparseBottomLayers, analyzeGrid } from '../src/convert/mesh-filter.js';
import type { ExtractedEnvironment, AnalysisResult } from '../src/convert/mesh-filter.js';
import { searchOSMBuilding, fetchOSMById } from '../src/gen/api/osm.js';
import { computeBuildingAlignment, type BuildingAlignment } from '../src/convert/building-alignment.js';
import { enrichScene, expandGrid } from '../src/convert/scene-pipeline.js';
import { resolveSemanticPalette, parseOSMColour } from '../src/convert/semantic-palette.js';
import type { SemanticPalette } from '../src/convert/semantic-palette.js';
import { rgbToWallBlock } from '../src/gen/color-blocks.js';
import { runPipeline } from '../src/convert/pipeline.js';
import { BlockGrid } from '../src/schem/types.js';
import { writeSchematic } from '../src/schem/write.js';
import { queryMultiHeadingSV } from '../src/gen/api/google-streetview.js';
import { extractMultiAngleColors, classifyTexture } from '../src/gen/api/streetview-analysis.js';
import { initCheckpoints, saveCheckpoint, loadCheckpoint } from '../src/convert/grid-checkpoint.js';
import { getCacheInfo, getCachedTile, cacheTile } from '../src/cli/tile-cache.js';
import { existsSync, statSync } from 'node:fs';
import { basename, extname, join, dirname, resolve } from 'node:path';
import sharp from 'sharp';

// Extracted CLI helpers
import { parseArgs } from '../src/cli/parse-args.js';
import { loadGLB } from '../src/cli/glb-loader.js';
import { reorientToENU, HEADLESS_NORTH_ALIGN } from '../src/cli/enu-orient.js';
import { sampleSatelliteRoof } from '../src/cli/satellite-color.js';
import { analyzeMeshes, analyzeOne } from '../src/cli/mesh-analysis.js';

/**
 * Pre-resolve semantic palette from APIs (SV multi-heading, satellite roof, OSM tags).
 * Extracted from inline pipeline code — all API calls happen before runPipeline().
 */
async function resolveSemanticPaletteFromAPIs(
  coords: { lat: number; lng: number },
  osmTags: Record<string, string>,
  buildingAlignment: BuildingAlignment | null | undefined,
  outputDir: string,
  resolution: number,
  grid: BlockGrid,
  noSatelliteRoof = false,
  roofColourOverride = '',
): Promise<SemanticPalette | undefined> {
  // Estimate building height from grid
  let maxSolidY = 0;
  for (let y = grid.height - 1; y >= 0; y--) {
    let hasBlock = false;
    for (let z = 0; z < grid.length && !hasBlock; z++) {
      for (let x = 0; x < grid.width && !hasBlock; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') hasBlock = true;
      }
    }
    if (hasBlock) { maxSolidY = y; break; }
  }
  const heightM = maxSolidY / resolution;

  // Phase A: Resolve base palette from OSM tags
  let palette = resolveSemanticPalette(osmTags, heightM);
  if (palette) {
    console.log(`  Semantic palette: ${palette.source}`);
    console.log(`  Wall blocks: ${palette.wallBlocks.map(b => b.replace('minecraft:', '')).join(', ')}`);
  } else {
    console.log('  Semantic palette: no OSM material/colour data available');
  }

  // Phase B: SV multi-heading facade color (only when OSM didn't provide wall color)
  if (!palette?.wallColor) {
    try {
      const svCacheKey = `sv-${coords.lat.toFixed(6)}-${coords.lng.toFixed(6)}`;
      const svCachePath = join(outputDir, `.cache-${svCacheKey}.json`);
      const SV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
      const svExtentM = buildingAlignment
        ? Math.max(buildingAlignment.mbrWidth, buildingAlignment.mbrDepth)
        : undefined;

      type CachedSvMulti = { svImages: Awaited<ReturnType<typeof queryMultiHeadingSV>>; ts: number };
      let svImages: Awaited<ReturnType<typeof queryMultiHeadingSV>> = [];
      let cacheHit = false;
      if (existsSync(svCachePath)) {
        const cacheAge = Date.now() - statSync(svCachePath).mtimeMs;
        if (cacheAge < SV_CACHE_TTL_MS) {
          try {
            const cached: CachedSvMulti = JSON.parse(await Bun.file(svCachePath).text());
            if (cached.svImages?.length > 0) {
              svImages = cached.svImages;
              cacheHit = true;
              console.log(`  SV multi-heading: loaded from cache (${(cacheAge / 3600000).toFixed(1)}h old, ${svImages.length} facades)`);
            }
          } catch { /* cache parse error — re-fetch */ }
        }
      }

      if (!cacheHit) {
        svImages = await queryMultiHeadingSV(coords.lat, coords.lng, svExtentM);
        if (svImages.length > 0) {
          await Bun.write(svCachePath, JSON.stringify({ svImages, ts: Date.now() } as CachedSvMulti));
        }
      }

      if (svImages.length > 0) {
        const multiResult = await extractMultiAngleColors(
          svImages.map(img => ({ faceName: img.faceName, heading: img.heading, imageUrl: img.imageUrl })),
        );
        if (multiResult) {
          const { r, g, b } = multiResult.wallColor;
          const svMax = Math.max(r, g, b);
          const svMin = Math.min(r, g, b);
          const svSat = svMax > 0 ? (svMax - svMin) / svMax : 0;
          // In force-recolor mode, accept near-neutral SV colors (white buildings like Transamerica).
          // Normal mode skips <10% sat (avoids gray-washing colorful buildings).
          const svSatThreshold = args.forceRecolor ? 0.02 : 0.10;
          if (svSat < svSatThreshold) {
            console.log(`  SV multi-angle wall: rgb(${r},${g},${b}) sat=${(svSat * 100).toFixed(0)}% — SKIPPED (too gray)`);
          } else {
            console.log(`  SV multi-angle wall: rgb(${r},${g},${b}) sat=${(svSat * 100).toFixed(0)}% → ${multiResult.wallBlock.replace('minecraft:', '')}`);
            if (palette) {
              palette.wallColor = { r, g, b };
              palette.wallBlocks = [multiResult.wallBlock];
              palette.source += ' + SV multi-angle';
            } else {
              palette = { wallBlocks: [multiResult.wallBlock], wallColor: { r, g, b }, source: 'SV multi-angle' };
            }
          }
        }
      } else {
        console.log('  SV: no street view imagery available');
      }
    } catch (e) {
      console.log(`  SV: ${(e as Error).message}`);
    }
  }

  // Phase B.5: SV texture classification fallback
  if (!palette) {
    try {
      const svTexCacheKey = `sv-${coords.lat.toFixed(6)}-${coords.lng.toFixed(6)}`;
      const svTexCachePath = join(outputDir, `.cache-${svTexCacheKey}.json`);
      type CachedSvTex = { svImages: Awaited<ReturnType<typeof queryMultiHeadingSV>>; ts: number };
      let texSvImages: Awaited<ReturnType<typeof queryMultiHeadingSV>> = [];
      if (existsSync(svTexCachePath)) {
        const cached: CachedSvTex = JSON.parse(await Bun.file(svTexCachePath).text());
        if (cached.svImages?.length > 0) texSvImages = cached.svImages;
      }
      if (texSvImages.length > 0) {
        const frontImage = texSvImages.find(img => img.faceName === 'front') ?? texSvImages[0];
        const resp = await fetch(frontImage.imageUrl, { signal: AbortSignal.timeout(15000) });
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          const { data: rawData, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          const pixels = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
          const texResult = classifyTexture(pixels, info.width, info.height);
          console.log(`  SV texture: ${texResult.textureClass} (entropy=${texResult.entropy.toFixed(0)}, conf=${texResult.confidence.toFixed(2)})`);
          if (texResult.confidence >= 0.4) {
            palette = resolveSemanticPalette(osmTags, heightM, texResult.textureClass);
            if (palette) {
              console.log(`  Semantic palette (SV texture): ${palette.source}`);
            }
          }
        }
      }
    } catch (e) {
      console.log(`  SV texture: ${(e as Error).message}`);
    }
  }

  // Phase C: Satellite roof color (skip if --no-satellite-roof or --roof-colour override)
  if (noSatelliteRoof) {
    console.log('  Satellite roof: SKIPPED (--no-satellite-roof)');
  } else if (roofColourOverride) {
    // Inject into osmTags (for pipeline metadata) and directly update palette.
    // osmTags mutation is AFTER Phase A ran, so we also set roofBlocks/roofColor directly.
    osmTags['roof:colour'] = roofColourOverride;
    const roofRgb = parseOSMColour(roofColourOverride);
    if (roofRgb) {
      const roofBlock = rgbToWallBlock(roofRgb.r, roofRgb.g, roofRgb.b);
      if (palette) {
        palette.roofBlocks = [roofBlock];
        palette.roofColor = roofRgb;
        palette.source += ` + roof-colour:${roofColourOverride}`;
      } else {
        palette = {
          wallBlocks: [],
          roofBlocks: [roofBlock],
          roofColor: roofRgb,
          source: `roof-colour:${roofColourOverride}`,
        };
      }
    }
    console.log(`  Satellite roof: OVERRIDDEN by --roof-colour ${roofColourOverride} → ${roofRgb ? 'rgb(' + roofRgb.r + ',' + roofRgb.g + ',' + roofRgb.b + ')' : 'unrecognised colour name'}`);
  } else {
    const satCacheKey = `sat-${coords.lat.toFixed(6)}-${coords.lng.toFixed(6)}`;
    const satCachePath = join(outputDir, `.cache-${satCacheKey}.json`);
    const SAT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    let satRoof: Awaited<ReturnType<typeof sampleSatelliteRoof>> = null;
    if (existsSync(satCachePath)) {
      const cacheAge = Date.now() - statSync(satCachePath).mtimeMs;
      if (cacheAge < SAT_CACHE_TTL_MS) {
        satRoof = JSON.parse(await Bun.file(satCachePath).text());
        console.log(`  Satellite roof: loaded from cache (${(cacheAge / 3600000).toFixed(1)}h old)`);
      }
    }
    if (!satRoof) {
      const satExtentM = buildingAlignment
        ? Math.max(buildingAlignment.mbrWidth, buildingAlignment.mbrDepth)
        : Math.max(grid.width, grid.length) / resolution;
      satRoof = await sampleSatelliteRoof(coords.lat, coords.lng, satExtentM);
      if (satRoof) {
        await Bun.write(satCachePath, JSON.stringify(satRoof));
      }
    }
    if (satRoof && palette) {
      palette.roofBlocks = [satRoof.roofBlock];
      palette.roofColor = { r: satRoof.roofRgb[0], g: satRoof.roofRgb[1], b: satRoof.roofRgb[2] };
      palette.source += ' + satellite roof';
    } else if (satRoof && !palette) {
      palette = {
        wallBlocks: [],
        roofBlocks: [satRoof.roofBlock],
        roofColor: { r: satRoof.roofRgb[0], g: satRoof.roofRgb[1], b: satRoof.roofRgb[2] },
        source: 'satellite roof only',
      };
    }
  }

  return palette ?? undefined;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t0 = performance.now();
  let enuHorizontalAngle = 0; // Rotation applied by reorientToENU, used for OSM polygon alignment

  // Initialize checkpoint system when --checkpoint or --restore is active
  if (args.checkpoint) {
    initCheckpoints(dirname(args.outputPath));
  }

  // Helper: query OSM building — uses explicit ID when provided, else proximity search.
  // Caches the Promise to avoid redundant Overpass API hits (same building queried
  // at up to 5 pipeline stages). Promise-level cache also handles concurrent calls.
  const osmCache = new Map<string, Promise<Awaited<ReturnType<typeof searchOSMBuilding>>>>();
  function queryOSM(lat: number, lng: number, radius = 150) {
    const key = args.osmId ? `${args.osmId.type}-${args.osmId.id}` : `${lat},${lng},${radius}`;
    if (!osmCache.has(key)) {
      osmCache.set(key, args.osmId
        ? fetchOSMById(args.osmId.type, args.osmId.id)
        : searchOSMBuilding(lat, lng, radius));
    }
    return osmCache.get(key)!;
  }

  // ── --cache-info: print tile cache status and exit ──
  if (args.cacheInfo) {
    console.log(getCacheInfo());
    return;
  }

  // ── Tile cache: check for cached GLB before loading ──
  // When coords are available, look up a previously cached GLB to ensure
  // reproducible results across runs. --no-cache bypasses this.
  let glbLoadPath = args.inputPath;
  let tileCacheHit = false;
  if (args.coords && !args.noCache) {
    // Use a default capture radius for cache key (100m is standard capture radius)
    const cacheRadius = 100;
    const cached = getCachedTile(args.coords.lat, args.coords.lng, cacheRadius);
    if (cached) {
      const ageMs = Date.now() - new Date(cached.capturedAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      console.log(`Tile cache: HIT (cached ${ageDays.toFixed(1)} days ago, ${(cached.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`);
      glbLoadPath = cached.glbPath;
      tileCacheHit = true;
    } else {
      console.log('Tile cache: MISS (will cache after voxelization)');
    }
  }

  // ── Batch mode: analyze multiple GLBs, output summary table ──
  if (args.batch) {
    const allPaths = [args.inputPath, ...args.batchPaths];
    console.log(`Batch analysis: ${allPaths.length} GLBs\n`);

    type Row = NonNullable<Awaited<ReturnType<typeof analyzeOne>>>;
    const rows: Row[] = [];

    for (const path of allPaths) {
      process.stdout.write(`  Analyzing: ${basename(path)}...`);
      const row = await analyzeOne(path, args.resolution, args.minHeight, args.trimThreshold, args.gamma, args.kernel, args.desaturate);
      if (row) {
        rows.push(row);
        console.log(` ${row.type} ${row.conf.toFixed(1)}`);
      } else {
        console.log(' FAILED');
      }
    }

    // Print summary table
    console.log(`\n${'Name'.padEnd(32)} ${'Dims'.padEnd(14)} ${'Blocks'.padStart(8)} ${'Type'.padEnd(8)} ${'Conf'.padStart(4)} ${'Front'.padEnd(5)} ${'Entry'.padEnd(22)} ${'Footprint'.padStart(9)}`);
    console.log('─'.repeat(110));
    for (const r of rows) {
      console.log(`${r.name.padEnd(32)} ${r.dims.padEnd(14)} ${r.blocks.toLocaleString().padStart(8)} ${r.type.padEnd(8)} ${r.conf.toFixed(1).padStart(4)} ${r.front.padEnd(5)} ${r.entry.padEnd(22)} ${r.footprint.toString().padStart(9)}`);
    }
    console.log(`\nTotal: ${rows.length}/${allPaths.length} analyzed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  console.log(`Loading: ${glbLoadPath}`);
  const scene = await loadGLB(glbLoadPath);

  const stats = analyzeMeshes(scene);
  const size = new THREE.Vector3();
  stats.boundingBox.getSize(size);

  console.log(`Meshes: ${stats.meshCount} | Vertices: ${stats.vertexCount.toLocaleString()} | Triangles: ${stats.triangleCount.toLocaleString()}`);
  console.log(`Textures: ${stats.hasTextures ? 'yes' : 'no'}`);
  console.log(`Bounding box: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} meters`);
  console.log(`Grid estimate: ${Math.ceil(size.x * args.resolution)} x ${Math.ceil(size.y * args.resolution)} x ${Math.ceil(size.z * args.resolution)} blocks @ ${args.resolution} block/m`);

  if (args.infoOnly) {
    // Quality assessment — predict voxelization quality from mesh stats
    reorientToENU(scene);
    const enuBox = new THREE.Box3().setFromObject(scene);
    const enuSize = new THREE.Vector3();
    enuBox.getSize(enuSize);
    console.log(`ENU dimensions: ${enuSize.x.toFixed(1)} x ${enuSize.y.toFixed(1)} x ${enuSize.z.toFixed(1)} m`);

    // Vertex density — higher = more surface detail
    const volume = enuSize.x * enuSize.y * enuSize.z;
    const surfaceArea = 2 * (enuSize.x * enuSize.y + enuSize.y * enuSize.z + enuSize.x * enuSize.z);
    const vertDensity = stats.vertexCount / Math.max(surfaceArea, 1);
    console.log(`Vertex density: ${vertDensity.toFixed(1)} verts/m² surface`);

    // Aspect ratio — tall/narrow buildings work better
    const footprint = Math.max(enuSize.x, enuSize.z);
    const aspect = enuSize.y / Math.max(footprint, 1);
    console.log(`Aspect ratio: ${aspect.toFixed(2)} (height/footprint)`);

    // Texture info — count textured meshes and total resolution
    let texturedMeshes = 0;
    let totalTexPixels = 0;
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        if (mat?.map) {
          texturedMeshes++;
          const img = mat.map.image;
          if (img && img.width) totalTexPixels += img.width * img.height;
        }
      }
    });
    console.log(`Textured meshes: ${texturedMeshes}/${stats.meshCount} | Total texture: ${(totalTexPixels / 1e6).toFixed(1)} Mpx`);

    // Height-filter analysis — how much geometry survives filtering?
    const candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        child.updateWorldMatrix(true, false);
        const worldBox = new THREE.Box3().setFromObject(child);
        candidates.push({ child, worldBox });
      }
    });
    const { kept, groundY, heightFiltered } = filterMeshesByHeight(candidates, args.minHeight);
    const keptVertices = kept.reduce((sum, k) => {
      const geo = k.child.geometry as THREE.BufferGeometry;
      return sum + (geo.attributes.position?.count || 0);
    }, 0);
    const vertexSurvival = stats.vertexCount > 0 ? keptVertices / stats.vertexCount : 0;
    console.log(`Height filter: ${kept.length}/${candidates.length} meshes kept (${(vertexSurvival * 100).toFixed(0)}% vertices survive)`);

    // Kept meshes bounding box — the actual building extent
    if (kept.length > 0) {
      const keptBox = new THREE.Box3();
      for (const k of kept) keptBox.union(k.worldBox);
      const keptSize = new THREE.Vector3();
      keptBox.getSize(keptSize);
      const buildingH = keptSize.y;
      const buildingW = Math.max(keptSize.x, keptSize.z);
      console.log(`Building extent: ${keptSize.x.toFixed(1)} x ${keptSize.y.toFixed(1)} x ${keptSize.z.toFixed(1)} m`);
      console.log(`Building height: ${buildingH.toFixed(1)}m | Width: ${buildingW.toFixed(1)}m | H/W: ${(buildingH / Math.max(buildingW, 1)).toFixed(2)}`);
    }

    // Quality prediction
    console.log(`\n--- Quality Assessment ---`);
    const issues: string[] = [];
    const strengths: string[] = [];

    if (!stats.hasTextures) issues.push('No textures — will produce monochrome output');
    else if (texturedMeshes === stats.meshCount) strengths.push('All meshes textured');

    // Vertex survival after height filter — high = building dominates, low = mostly terrain
    if (vertexSurvival < 0.5) issues.push(`Only ${(vertexSurvival * 100).toFixed(0)}% verts above ground — mostly terrain/ground`);
    else if (vertexSurvival > 0.8) strengths.push(`${(vertexSurvival * 100).toFixed(0)}% verts above ground — building dominates`);

    if (aspect < 0.3) issues.push('Very wide/flat — may merge multiple structures');
    else if (aspect > 0.6) strengths.push(`Tall profile (aspect ${aspect.toFixed(2)})`);

    if (footprint > 45) issues.push(`Large footprint (${footprint.toFixed(0)}m) — likely captures neighbors`);
    else if (footprint < 25) strengths.push('Compact footprint — likely single building');

    if (stats.meshCount > 15) issues.push(`Many meshes (${stats.meshCount}) — complex scene`);

    // Triangles per vertex — higher = more complex surfaces (trees/foliage vs flat walls)
    const triPerVert = stats.triangleCount / Math.max(stats.vertexCount, 1);
    if (triPerVert > 1.2) issues.push(`High tri/vert ratio (${triPerVert.toFixed(2)}) — complex geometry (trees?)`);
    else if (triPerVert < 0.8) strengths.push('Simple geometry (flat surfaces)');

    if (strengths.length > 0) console.log(`+ ${strengths.join('\n+ ')}`);
    if (issues.length > 0) console.log(`- ${issues.join('\n- ')}`);

    const score = strengths.length - issues.length;
    const verdict = score >= 2 ? 'GOOD — proceed with default pipeline'
                  : score >= 0 ? 'FAIR — try --generic or adjust capture radius'
                  : 'POOR — recapture with tighter radius or different address';
    console.log(`\nVerdict: ${verdict}`);

    console.log(`\nLoaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // Reorient ECEF-tilted meshes to local ENU (Y-up) before voxelization.
  // Google 3D Tiles use ECEF coordinates — "up" is radially outward from
  // Earth's center, not along any fixed axis. The ReorientationPlugin handles
  // this in the browser, but the exported GLB may retain ECEF orientation.
  // --no-enu: skip for headless GLBs that are already ENU-oriented
  // (tiles-headless.ts uses ReorientationPlugin → meshes already have Y-up).
  // v300: BuildingAlignment for precise mesh rotation (declared early, populated if OSM available)
  let buildingAlignment: BuildingAlignment | undefined;

  if (args.noEnu) {
    console.log('ENU reorientation: SKIPPED (--no-enu, pre-oriented headless GLB)');
    // Still center the scene at origin for consistent grid coordinates
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const shift = new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z);
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        child.geometry.applyMatrix4(shift);
      }
    });
    console.log(`Centered: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} m`);

    // v302: North-align headless GLBs by correcting OBJECT_FRAME convention.
    // ReorientationPlugin produces +X=West, +Z=North. Rotate 180° around Y
    // to get +X=East, +Z=South — matching satellite north-up convention.
    const yFlip = new THREE.Matrix4().makeRotationY(HEADLESS_NORTH_ALIGN);
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        child.geometry.applyMatrix4(yFlip);
      }
    });
    // Re-center after rotation
    const nb = new THREE.Box3().setFromObject(scene);
    const nc = new THREE.Vector3();
    nb.getCenter(nc);
    const reshift = new THREE.Matrix4().makeTranslation(-nc.x, -nb.min.y, -nc.z);
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.geometry) {
        child.geometry.applyMatrix4(reshift);
      }
    });
    const ns = new THREE.Vector3();
    nb.getSize(ns);
    // enuHorizontalAngle stays 0: after 180° rotation, mesh frame is X=East, Z=South
    // which matches the OSM polygon projection convention directly — no additional rotation needed.
    console.log(`North-aligned (180° Y-flip): ${ns.x.toFixed(1)} x ${ns.y.toFixed(1)} x ${ns.z.toFixed(1)} m`);

    // Still query OSM for building alignment (used by satellite zoom, masking, etc.)
    if (args.coords && !args.noOsm) {
      try {
        const osmData = await queryOSM(args.coords.lat, args.coords.lng, 150);
        if (osmData?.polygon?.length >= 3) {
          const polygon = osmData.polygon.map((p: { lat: number; lon: number }) => ({ lat: p.lat, lon: p.lon }));
          buildingAlignment = computeBuildingAlignment(polygon, args.coords.lat, args.coords.lng);
          console.log(`Building alignment: ${buildingAlignment.rotationDeg.toFixed(1)}° MBR ${buildingAlignment.mbrWidth.toFixed(0)}×${buildingAlignment.mbrDepth.toFixed(0)}m`);

          // v302: Pre-clip meshes to OSM building bounds + buffer.
          // Fixed capture produces GLBs with ALL meshes in capture radius (~100-160m diameter).
          // Without clipping, the voxel grid is dominated by surrounding context and OSM mask
          // can't match (IoU near zero). Clip to building dimensions to get a building-sized grid.
          // Compute axis-aligned clip bounds from the rotated MBR.
          // rotationDeg = compass bearing of MBR long axis (CW from north).
          // Grid after 180° Y-rotation: +X=East, +Z=South.
          // MBR long axis direction in grid: X=sin(θ), Z=cos(θ)
          const theta = buildingAlignment.rotationDeg * Math.PI / 180;
          const sinT = Math.abs(Math.sin(theta));
          const cosT = Math.abs(Math.cos(theta));
          const halfW = buildingAlignment.mbrWidth / 2;   // long axis half-length
          const halfD = buildingAlignment.mbrDepth / 2;    // short axis half-length
          // AABB of the rotated MBR + 15m buffer
          const clipHalfX = halfW * sinT + halfD * cosT + 15;
          const clipHalfZ = halfW * cosT + halfD * sinT + 15;
          // The capture center (building) maps to grid origin after centering + rotation + re-centering.
          // Clip meshes whose bounding boxes are entirely outside the clip box.
          let clippedCount = 0;
          const meshesToRemove: THREE.Object3D[] = [];
          scene.traverse((child) => {
            if (!(child instanceof THREE.Mesh) || !child.geometry) return;
            const geo = child.geometry as THREE.BufferGeometry;
            if (!geo.boundingBox) geo.computeBoundingBox();
            const bb = geo.boundingBox!;
            // Check if mesh is entirely outside clip box in XZ
            if (bb.max.x < -clipHalfX || bb.min.x > clipHalfX ||
                bb.max.z < -clipHalfZ || bb.min.z > clipHalfZ) {
              meshesToRemove.push(child);
              clippedCount++;
            }
          });
          for (const m of meshesToRemove) m.removeFromParent();

          if (clippedCount > 0) {
            // Re-center after clipping
            const cb = new THREE.Box3().setFromObject(scene);
            const cc = new THREE.Vector3();
            cb.getCenter(cc);
            const cbs = new THREE.Vector3();
            cb.getSize(cbs);
            const clipShift = new THREE.Matrix4().makeTranslation(-cc.x, -cb.min.y, -cc.z);
            scene.traverse((child) => {
              if (child instanceof THREE.Mesh && child.geometry) {
                child.geometry.applyMatrix4(clipShift);
              }
            });
            console.log(`Pre-clip: removed ${clippedCount} meshes outside building bounds (±${clipHalfX.toFixed(0)}×${clipHalfZ.toFixed(0)}m), grid now ${cbs.x.toFixed(0)}×${cbs.y.toFixed(0)}×${cbs.z.toFixed(0)}m`);
          }
        }
      } catch (e) {
        console.warn('OSM alignment query failed:', (e as Error).message);
      }
    }
  } else {
    // v300: Compute BuildingAlignment from OSM for precise mesh rotation.
    // Must run before reorientToENU — the main OSM query happens later (post-voxelization).
    // This early query is lightweight (same endpoint, same coords) and only used for alignment.
    if (args.coords && !args.noOsm) {
      try {
        const osmData = await queryOSM(args.coords.lat, args.coords.lng, 150);
        if (osmData?.polygon?.length >= 3) {
          // OSM returns {lat, lon} — same as computeBuildingAlignment expects
          const polygon = osmData.polygon.map((p: { lat: number; lon: number }) => ({ lat: p.lat, lon: p.lon }));
          buildingAlignment = computeBuildingAlignment(polygon, args.coords.lat, args.coords.lng);
          console.log(`Building alignment: ${buildingAlignment.rotationDeg.toFixed(1)}° MBR ${buildingAlignment.mbrWidth.toFixed(0)}×${buildingAlignment.mbrDepth.toFixed(0)}m`);
        }
      } catch (e) {
        console.warn('Early OSM query for alignment failed, using angular sweep fallback:', (e as Error).message);
      }
    }
    enuHorizontalAngle = reorientToENU(scene, false, args.noEnuSnap, buildingAlignment);
  }

  // Height filter: collect candidate meshes and filter by vertical extent
  console.log(`\nHeight filter: min ${args.minHeight}m above ground`);
  const candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
  scene.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.updateWorldMatrix(true, false);
      const worldBox = new THREE.Box3().setFromObject(child);
      candidates.push({ child, worldBox });
    }
  });

  const { kept, groundY, heightFiltered } = filterMeshesByHeight(candidates, args.minHeight);
  console.log(`Ground Y: ${groundY.toFixed(1)} | Kept: ${kept.length}/${candidates.length} meshes (${heightFiltered} filtered)`);

  if (kept.length === 0) {
    console.error('No meshes survived height filter — try lowering --min-height');
    process.exit(1);
  }

  // Dynamic resolution scaling based on building dimensions.
  // Goal: fit building within reasonable MC block counts while preserving detail.
  if (!args.explicitResolution && args.auto) {
    const keptBox = new THREE.Box3();
    for (const k of kept) keptBox.union(k.worldBox);
    const keptSize = new THREE.Vector3();
    keptBox.getSize(keptSize);
    const buildingH = keptSize.y;
    const buildingW = Math.max(keptSize.x, keptSize.z);
    if (buildingH > 100) {
      // Tall building (ESB 443m, Willis 442m, Chrysler 319m): cap at 1 block/m
      // to fit within 350 MC blocks height. Higher res would exceed practical limits.
      args.resolution = 1;
      console.log(`Auto resolution=1: tall building ${buildingH.toFixed(0)}m (cap at 1 block/m)`);
    } else if (buildingH < 40 && buildingW < 40) {
      // Small building (Guggenheim 28m, Geisel 39m): higher res for curve fidelity.
      // 3 blocks/m gives 84-117 blocks — enough to resolve curves and details.
      args.resolution = Math.min(3, Math.ceil(40 / buildingW));
      console.log(`Auto resolution=${args.resolution}: small building ${buildingW.toFixed(0)}×${buildingH.toFixed(0)}m`);
    } else if (buildingW > 0 && buildingW < 25) {
      // v80: medium-small buildings — 2x for curve approximation
      args.resolution = 2;
      console.log(`Auto 2x resolution: building width ${buildingW.toFixed(0)}m < 25m threshold`);
    }
  }

  // Dynamic kernel scaling: resolution-aware + building-size-aware.
  // Base kernel 12 (24px diameter) smooths photogrammetry noise, but at higher resolutions
  // 12px covers fewer meters (1x=1.4m, 2x=0.7m). Scale inversely with resolution.
  // Towers need smaller kernels to preserve facade detail (windows, cornices, material bands).
  // Large buildings need slightly larger kernels — more noise, coarser textures.
  if (args.auto && !args.explicitKernel) {
    const kBox = new THREE.Box3();
    for (const k of kept) kBox.union(k.worldBox);
    const kSize = new THREE.Vector3();
    kBox.getSize(kSize);
    const buildingWidth = Math.max(kSize.x, kSize.z);
    const aspectRatio = kSize.y / Math.max(buildingWidth, 1);
    // Scale factors: resolution (2x→0.5), tower aspect (>1.5→0.5), building size
    const resScale = 1 / args.resolution;         // 2x→0.5, 1x→1.0, 3x→0.33
    const towerScale = aspectRatio > 1.5 ? 0.5 : 1.0;
    const sizeScale = buildingWidth > 80 ? 1.3 : buildingWidth < 25 ? 0.7 : 1.0;
    // At resolution >=5, kernel bottoms out at 1 (point sampling — each voxel is 0.1-0.2m,
    // texture detail is already at voxel scale). Min kernel 1 prevents 0-kernel crash.
    const minKernel = args.resolution >= 5 ? 1 : 4;
    args.kernel = Math.max(minKernel, Math.min(16, Math.round(12 * resScale * towerScale * sizeScale)));
    console.log(`Auto kernel=${args.kernel}: res=${args.resolution} (×${resScale.toFixed(2)}), aspect=${aspectRatio.toFixed(2)} (×${towerScale}), width=${buildingWidth.toFixed(0)}m (×${sizeScale})`);
  }

  // Build a new group from kept meshes (clone with baked world transform)
  const filteredGroup = new THREE.Group();
  for (const { child } of kept) {
    const cloned = child.clone();
    cloned.applyMatrix4(child.matrixWorld);
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    cloned.updateMatrix();
    filteredGroup.add(cloned);
  }

  // Voxelize
  // At high resolutions (>=5), estimate grid dimensions and warn about memory/time
  const estBox = new THREE.Box3().setFromObject(filteredGroup);
  const estSize = new THREE.Vector3();
  estBox.getSize(estSize);
  const estW = Math.ceil(estSize.x * args.resolution);
  const estH = Math.ceil(estSize.y * args.resolution);
  const estL = Math.ceil(estSize.z * args.resolution);
  const estVoxels = estW * estH * estL;
  const estMemMB = (estVoxels * 2) / (1024 * 1024); // Uint16Array = 2 bytes/voxel
  // --restore: skip voxelization entirely — grid will be loaded from checkpoint below
  let grid: BlockGrid;
  if (args.restore) {
    console.log(`\nSkipping voxelization (restoring from checkpoint '${args.restore}')`);
    grid = new BlockGrid(1, 1, 1); // Placeholder — replaced by restoredGrid in trim step
  } else {
    console.log(`\nVoxelizing: ${args.mode} mode, ${args.resolution} block/m, gamma ${args.gamma}, kernel ${args.kernel}, desat ${args.desaturate}`);
    console.log(`  Estimated grid: ${estW}x${estH}x${estL} = ${estVoxels.toLocaleString()} voxels (${estMemMB.toFixed(0)} MB)`);
    if (estVoxels > 50_000_000) {
      console.log(`  ⚠ Large grid — narrow-band voxelization will skip empty space`);
    }
    const sampler = createDataTextureSampler(args.gamma, args.kernel, args.desaturate);
    const tVox = performance.now();
    grid = threeToGrid(filteredGroup, args.resolution, {
      textureSampler: sampler,
      mode: args.mode,
      // Don't filter vegetation during voxelization — trees act as solid walls during
      // fillInteriorGaps, preventing holes behind canopy. Strip vegetation in post-processing.
      filterVegetation: false,
      onProgress: (p) => {
        if (p.message) {
          process.stdout.write(`\r  ${p.message}`);
        } else {
          process.stdout.write(`\r  Layer ${p.currentY}/${p.totalY} (${Math.round(p.progress * 100)}%)`);
        }
      },
    });
    process.stdout.write('\n');
    console.log(`Voxelized in ${((performance.now() - tVox) / 1000).toFixed(1)}s`);
  }

  // Preview mode — output raw voxelization with only trim, no post-processing.
  // Use this to visually assess GLB quality before committing to full pipeline.
  if (args.preview) {
    const trimmed = trimSparseBottomLayers(grid, args.trimThreshold);
    const nonAir = trimmed.countNonAir();
    console.log(`\n[PREVIEW] Raw surface voxelization (no post-processing)`);
    console.log(`Grid: ${trimmed.width}x${trimmed.height}x${trimmed.length} | Blocks: ${nonAir.toLocaleString()} | Palette: ${trimmed.palette.size}`);
    writeSchematic(trimmed, args.outputPath);
    const fileSize = Bun.file(args.outputPath).size;
    console.log(`Wrote: ${args.outputPath} (${fileSize.toLocaleString()} bytes)`);
    console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`\nView: copy to web/public/ and open ?tab=upload&file=<name>.schem`);
    return;
  }

  // Auto-info mode: quick voxelize + full analysis report, no pipeline processing.
  // Produces a preview .schem AND a detailed analysis with recommended CLI command.
  if (args.autoInfo) {
    const trimmed = trimSparseBottomLayers(grid, args.trimThreshold);
    const nonAir = trimmed.countNonAir();
    console.log(`\nGrid: ${trimmed.width}x${trimmed.height}x${trimmed.length} | Blocks: ${nonAir.toLocaleString()} | Palette: ${trimmed.palette.size}`);

    console.log(`\n--- Auto-Detection Analysis ---`);
    const tAuto = performance.now();
    const analysis = analyzeGrid(trimmed);
    const rec = analysis.recommended;

    console.log(`  Terrain: slope ${analysis.slopeAngle.toFixed(1)}° ${analysis.isFlat ? '(flat)' : '(sloped)'}, ground Y=${analysis.groundPlaneY}`);
    console.log(`  Components: ${analysis.componentCount} (central: ${analysis.centralAABB.maxX - analysis.centralAABB.minX + 1}x${analysis.centralAABB.maxY - analysis.centralAABB.minY + 1}x${analysis.centralAABB.maxZ - analysis.centralAABB.minZ + 1} blocks)`);
    console.log(`  Partial capture: ${analysis.isPartialCapture ? `YES — building extends beyond grid (${analysis.edgeTouchPct.toFixed(1)}% edge touch)` : `no (${analysis.edgeTouchPct.toFixed(1)}%)`}`);
    console.log(`  Typology: ${analysis.typology} | Rectangular: ${analysis.isRectangular} | Aspect: ${analysis.aspectRatio.toFixed(2)}`);
    console.log(`  Roof: ${analysis.isFlatRoof ? 'flat' : 'pitched/varied'} | Front face: ${analysis.frontFace}`);
    console.log(`  Facade: ${analysis.dominantBlock.replace('minecraft:', '')} (${analysis.dominantPct.toFixed(0)}%) + ${analysis.secondaryBlock.replace('minecraft:', '')}`);
    console.log(`  Noise: ${analysis.noisePct.toFixed(1)}%`);
    console.log(`  Entry: ${analysis.entryPosition ? `(${analysis.entryPosition.x}, ${analysis.entryPosition.z}) face=${analysis.entryFace} width=${analysis.entryWidth} path=${analysis.entryPath.length} blocks` : 'none detected'}`);
    console.log(`  Footprint: ${analysis.footprintArea} blocks area, ${analysis.perimeterLength} perimeter, compactness=${(analysis.compactness * 100).toFixed(0)}%`);
    console.log(`  Building: ~${analysis.estimatedWidthM}x${analysis.estimatedHeightM}x${analysis.estimatedDepthM}m, ~${analysis.estimatedFloors} floors`);
    console.log(`  Confidence: ${analysis.confidence.toFixed(1)}/10 (${analysis.dataQuality})`);
    console.log(`  Analysis: ${((performance.now() - tAuto) / 1000).toFixed(1)}s`);

    // Print recommended CLI
    const parts: string[] = ['bun scripts/voxelize-glb.ts', args.inputPath];
    if (rec.generic) parts.push('--generic');
    if (rec.fill) parts.push('--fill');
    if (rec.noPalette) parts.push('--no-palette');
    if (rec.noCornice) parts.push('--no-cornice');
    if (rec.noFireEscape) parts.push('--no-fire-escape');
    parts.push(`--smooth-pct ${rec.smoothPct}`);
    parts.push(`--mode-passes ${rec.modePasses}`);
    if (rec.cropRadius > 0) parts.push(`--crop ${rec.cropRadius}`);
    if (rec.cleanMinSize > 0) parts.push(`--clean ${rec.cleanMinSize}`);
    for (const [from, to] of rec.remaps) {
      parts.push(`--remap ${from.replace('minecraft:', '')}=${to.replace('minecraft:', '')}`);
    }
    console.log(`\n  Recommended CLI:\n  ${parts.join(' \\\n    ')}`);

    // Also write preview .schem for visual check
    writeSchematic(trimmed, args.outputPath);
    const fileSize = Bun.file(args.outputPath).size;
    console.log(`\nPreview: ${args.outputPath} (${fileSize.toLocaleString()} bytes)`);
    console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // ─── Checkpoint Restore ──────────────────────────────────────────────────
  // --restore NAME: load grid from checkpoint and skip stages before it.
  // Valid checkpoint names: post-voxelize, post-trim, post-mask, post-fill, post-filter, post-recolor
  const CHECKPOINT_ORDER = ['post-voxelize', 'post-trim', 'post-mask', 'post-fill', 'post-filter', 'post-recolor'] as const;
  type CheckpointName = typeof CHECKPOINT_ORDER[number];
  /** Set of checkpoint stages to skip (all stages before the restore point) */
  const skipBefore = new Set<CheckpointName>();
  let restoredGrid: BlockGrid | null = null;

  if (args.restore) {
    const restoreIdx = CHECKPOINT_ORDER.indexOf(args.restore as CheckpointName);
    if (restoreIdx < 0) {
      console.error(`Invalid checkpoint name: '${args.restore}'. Valid names: ${CHECKPOINT_ORDER.join(', ')}`);
      process.exit(1);
    }
    console.log(`\nRestoring from checkpoint: '${args.restore}'`);
    restoredGrid = await loadCheckpoint(args.restore);
    // Mark all stages up to and including the restore point as skippable
    for (let i = 0; i <= restoreIdx; i++) {
      skipBefore.add(CHECKPOINT_ORDER[i]);
    }
  }

  /** Helper: save checkpoint if --checkpoint is active */
  async function maybeCheckpoint(trimmed: BlockGrid, name: CheckpointName): Promise<void> {
    if (args.checkpoint) {
      await saveCheckpoint(trimmed, name);
    }
  }

  // Trim sparse bottom layers
  let trimmed = restoredGrid ?? trimSparseBottomLayers(grid, args.trimThreshold);
  if (!restoredGrid && trimmed !== grid) {
    const removed = grid.height - trimmed.height;
    console.log(`Trimmed ${removed} sparse bottom layers (${grid.height} → ${trimmed.height})`);
  }

  // Checkpoint: post-voxelize (after initial voxelization + trim, before any processing)
  if (!skipBefore.has('post-voxelize')) {
    await maybeCheckpoint(trimmed, 'post-voxelize');
  }

  // ── Auto-detection: analyze grid and override pipeline params ──
  let analysis: AnalysisResult | null = null;
  if (args.auto) {
    console.log(`\n--- Auto-Detection Analysis ---`);
    const tAuto = performance.now();
    analysis = analyzeGrid(trimmed);

    console.log(`  Terrain: slope ${analysis.slopeAngle.toFixed(1)}° ${analysis.isFlat ? '(flat)' : '(sloped)'}, ground Y=${analysis.groundPlaneY}`);
    const aabb = analysis.centralAABB;
    const cW = aabb.maxX - aabb.minX + 1, cH = aabb.maxY - aabb.minY + 1, cL = aabb.maxZ - aabb.minZ + 1;
    console.log(`  Components: ${analysis.componentCount} (central: ${cW}x${cH}x${cL} blocks)`);
    console.log(`  Partial capture: ${analysis.isPartialCapture ? `YES (${analysis.edgeTouchPct.toFixed(1)}% edge touch)` : `no (${analysis.edgeTouchPct.toFixed(1)}%)`}`);
    console.log(`  Typology: ${analysis.typology} | Aspect: ${analysis.aspectRatio.toFixed(2)} | Footprint fill: ${(analysis.footprintFill * 100).toFixed(0)}% | Rectangular: ${analysis.isRectangular}`);
    console.log(`  Shape: OBB rectangularity=${(analysis.rectangularity * 100).toFixed(0)}% | Setbacks: ${analysis.hasSetbacks} | Profile: ${analysis.heightProfile}`);
    console.log(`  Roof: ${analysis.isFlatRoof ? 'flat' : 'pitched'} (variance ${analysis.roofVariance.toFixed(1)})`);
    console.log(`  Facade: dominant=${analysis.dominantBlock.replace('minecraft:', '')} (${analysis.dominantPct.toFixed(0)}%) secondary=${analysis.secondaryBlock.replace('minecraft:', '')}`);
    console.log(`  Noise: ${analysis.noisePct.toFixed(1)}% protrusions (${analysis.protrusion1vCount} single-voxel)`);
    console.log(`  Front face: ${analysis.frontFace}`);
    console.log(`  Entry: ${analysis.entryPosition ? `(${analysis.entryPosition.x}, ${analysis.entryPosition.z}) face=${analysis.entryFace} width=${analysis.entryWidth} path=${analysis.entryPath.length} blocks` : 'none detected'}`);
    console.log(`  Footprint: area=${analysis.footprintArea} perimeter=${analysis.perimeterLength} compactness=${(analysis.compactness * 100).toFixed(0)}%`);
    console.log(`  Building: ~${analysis.estimatedWidthM}x${analysis.estimatedHeightM}x${analysis.estimatedDepthM}m, ~${analysis.estimatedFloors} floors`);
    console.log(`  Confidence: ${analysis.confidence.toFixed(1)}/10 (${analysis.dataQuality})`);

    // Apply auto recommendations (only override non-explicitly-set params)
    const rec = analysis.recommended;
    // Compact recommendation summary
    const recFlags: string[] = [rec.generic ? '--generic' : 'building-mode'];
    if (rec.fill) recFlags.push('--fill');
    if (!rec.noPalette) recFlags.push('shadow-palette');
    if (rec.cropRadius > 0) recFlags.push(`--crop ${rec.cropRadius}`);
    if (rec.cleanMinSize > 0) recFlags.push(`--clean ${rec.cleanMinSize}`);
    if (rec.remaps.size > 0) {
      const remapStr = [...rec.remaps.entries()].map(([f, t]) =>
        `${f.replace('minecraft:', '')}→${t.replace('minecraft:', '')}`).join(', ');
      recFlags.push(`remap: ${remapStr}`);
    }
    console.log(`  Pipeline: ${recFlags.join(' | ')}`);

    // Print reproducible CLI command for manual fine-tuning
    const parts: string[] = ['bun scripts/voxelize-glb.ts', args.inputPath];
    if (rec.generic) parts.push('--generic');
    if (rec.fill) parts.push('--fill');
    if (rec.noPalette) parts.push('--no-palette');
    if (rec.noCornice) parts.push('--no-cornice');
    if (rec.noFireEscape) parts.push('--no-fire-escape');
    parts.push(`--smooth-pct ${rec.smoothPct}`);
    parts.push(`--mode-passes ${rec.modePasses}`);
    if (rec.cropRadius > 0) parts.push(`--crop ${rec.cropRadius}`);
    if (rec.cleanMinSize > 0) parts.push(`--clean ${rec.cleanMinSize}`);
    for (const [from, to] of rec.remaps) {
      parts.push(`--remap ${from.replace('minecraft:', '')}=${to.replace('minecraft:', '')}`);
    }
    if (args.outputPath) parts.push(`-o ${args.outputPath}`);
    console.log(`\n  Equivalent CLI:\n  ${parts.join(' \\\n    ')}\n`);

    // Override args with auto recommendations.
    // Respect explicit CLI flags: --generic overrides auto-detect's generic=false.
    // If confidence is >= 3.5, force building mode — photogrammetry grids have inherent noise
    // that tanks confidence, but the building data is still usable
    if (analysis.confidence >= 3.5 && rec.generic) {
      console.log(`  Override: confidence ${analysis.confidence.toFixed(1)} >= 3.5, forcing building mode (was generic)`);
      rec.generic = false;
    }
    if (!args.explicitGeneric) args.generic = rec.generic;
    if (!args.explicitFill) args.fill = rec.fill;
    args.noPalette = rec.noPalette;
    args.noCornice = rec.noCornice;
    args.noFireEscape = rec.noFireEscape;
    args.smoothPct = rec.smoothPct;
    if (!args.explicitModePasses) args.modePasses = rec.modePasses;
    // Only apply auto-crop if the detected component is non-trivial (>100 blocks)
    const centralVol = (aabb.maxX - aabb.minX + 1) * (aabb.maxY - aabb.minY + 1) * (aabb.maxZ - aabb.minZ + 1);
    if (args.cropRadius === 0 && rec.cropRadius > 0 && centralVol > 100) {
      args.cropRadius = rec.cropRadius;
    }
    if (args.cleanMinSize === 0 && rec.cleanMinSize > 0) args.cleanMinSize = rec.cleanMinSize;
    // Merge auto remaps with explicit --remap (explicit wins)
    for (const [from, to] of rec.remaps) {
      if (!args.remaps.has(from)) args.remaps.set(from, to);
    }

    // AABB crop deferred to pipeline's resolveConfig() (avoids double-crop)
  }

  // Environment data extracted from photogrammetry before vegetation strip (--scene)
  let envPositions: ExtractedEnvironment | undefined;

  // Block-level distance clip — remove blocks outside MBR bounds.
  // Mesh-level pre-clip (above) can't help when individual tile meshes span the boundary.
  // This block-level clip uses the building MBR dimensions to remove voxels that are
  // clearly outside the target building, complementing the downstream OSM polygon mask.
  // Runs before generic/non-generic branch so it applies to all pipeline modes.
  if (buildingAlignment && buildingAlignment.mbrWidth > 0 && buildingAlignment.mbrDepth > 0) {
    const theta = buildingAlignment.rotationDeg * Math.PI / 180;
    const sinT = Math.abs(Math.sin(theta));
    const cosT = Math.abs(Math.cos(theta));
    const halfW = buildingAlignment.mbrWidth / 2;
    const halfD = buildingAlignment.mbrDepth / 2;
    // Axis-aligned clip bounds in meters, then convert to blocks
    const bufferM = 10; // keep 10m buffer around MBR
    const clipRadiusX = Math.ceil((halfW * sinT + halfD * cosT + bufferM) * args.resolution);
    const clipRadiusZ = Math.ceil((halfW * cosT + halfD * sinT + bufferM) * args.resolution);
    const cx = Math.floor(trimmed.width / 2);
    const cz = Math.floor(trimmed.length / 2);
    let distClipped = 0;
    for (let y = 0; y < trimmed.height; y++) {
      for (let z = 0; z < trimmed.length; z++) {
        for (let x = 0; x < trimmed.width; x++) {
          if (trimmed.get(x, y, z) === 'minecraft:air') continue;
          if (Math.abs(x - cx) > clipRadiusX || Math.abs(z - cz) > clipRadiusZ) {
            trimmed.set(x, y, z, 'minecraft:air');
            distClipped++;
          }
        }
      }
    }
    if (distClipped > 0) {
      console.log(`Block distance clip: ${distClipped} blocks removed outside MBR bounds (±${clipRadiusX}×${clipRadiusZ} blocks from center)`);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // Shared Pipeline (pipeline.ts — unified CLI + browser post-processing)
  // Replaces ~1500 lines of inline post-processing with a single pipeline call.
  // All API data pre-fetched above; pipeline is pure computation.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Pre-fetch external data for pipeline ──
  let preOsmPolygon: Array<{ lat: number; lon: number }> | null = null;
  let preOsmTags: Record<string, string> = {};
  if (args.coords && !args.noOsm) {
    console.log(`\nOSM footprint query at ${args.coords.lat},${args.coords.lng}...`);
    const osmData = await queryOSM(args.coords.lat, args.coords.lng, 150);
    if (osmData && osmData.polygon.length >= 3) {
      preOsmPolygon = osmData.polygon;
      preOsmTags = osmData.tags ?? {};
      console.log(`OSM: ${osmData.polygon.length} vertices, ${Object.keys(preOsmTags).length} tags`);
    } else {
      console.log('OSM: no building found at coordinates');
    }
  }

  // Inject --building-colour override into OSM tags BEFORE palette resolution.
  // This bypasses height heuristics for buildings with known wall colors (e.g. Transamerica).
  if (args.buildingColour) {
    preOsmTags = { ...preOsmTags, 'building:colour': args.buildingColour };
    console.log(`  Injecting building:colour=${args.buildingColour} (CLI override)`);
  }

  // Resolve semantic palette from APIs (SV multi-heading, satellite roof, OSM)
  let preSemanticPalette: SemanticPalette | undefined;
  if (args.recolor && args.coords) {
    console.log('\n--- Semantic Palette Resolution ---');
    preSemanticPalette = await resolveSemanticPaletteFromAPIs(
      args.coords, preOsmTags, buildingAlignment,
      dirname(args.outputPath), args.resolution, trimmed,
      args.noSatelliteRoof, args.roofColour,
    );
  }

  // Zone normalization is deprecated — all v300+ scores achieved without it
  if (args.zoneNormalize) {
    console.warn('\nWARNING: --zone-normalize is deprecated (v300+). Ignored — using modern pipeline.');
  }

  // ── Run shared pipeline ──
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Running shared pipeline (pipeline.ts)');
  console.log('══════════════════════════════════════════════════════');
  const pipelineT0 = performance.now();

  const pipelineResult = await runPipeline(trimmed, {
    resolution: args.resolution,
    mode: args.mode,
    generic: args.generic,
    fill: args.fill,
    recolor: !!args.recolor,
    forceRecolor: !!args.forceRecolor,
    scene: args.scene,
    noGlaze: args.noGlaze,
    noOsm: args.noOsm,
    noPostMask: args.noPostMask,
    noIsolate: args.noIsolate,
    peakedRoof: args.peakedRoof,
    heightCorrect: args.heightCorrect,
    smoothPct: args.smoothPct,
    modePasses: args.modePasses,
    cropRadius: args.cropRadius,
    cleanMinSize: args.cleanMinSize,
    maskDilate: args.maskDilate,
    enuHorizontalAngle,
    coords: args.coords,
    osmPolygon: preOsmPolygon ?? undefined,
    osmTags: preOsmTags,
    buildingAlignment: buildingAlignment ? {
      rotationDeg: buildingAlignment.rotationDeg,
      mbrWidth: buildingAlignment.mbrWidth,
      mbrDepth: buildingAlignment.mbrDepth,
    } : undefined,
    osmId: args.osmId,
    semanticPalette: preSemanticPalette,
    knownHeightM: args.heightOverride > 0 ? args.heightOverride : undefined,
    precomputedAnalysis: analysis ?? undefined,
    remaps: args.remaps,
  }, {
    onLog: (msg) => console.log(msg),
    onPhaseStart: (phase, state) => {
      console.log(`\n--- ${phase} (${state.phaseIndex + 1}/${state.totalPhases}) ---`);
    },
    onPhaseEnd: (phase, changed, state) => {
      const stats = state.phaseStats.get(phase);
      if (stats) console.log(`  [${stats.elapsedMs.toFixed(0)}ms, ${changed} blocks changed]`);
    },
  });

  // Extract results from pipeline state
  analysis = pipelineResult.analysis;
  envPositions = pipelineResult.envPositions;

  const pipelineElapsed = (performance.now() - pipelineT0) / 1000;
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  Pipeline complete: ${pipelineResult.phaseStats.size} phases in ${pipelineElapsed.toFixed(1)}s`);
  console.log('══════════════════════════════════════════════════════');

  // ─── Plot Context Expansion ─────────────────────────────────────────────────
  // --scene + --plot-radius: expand grid XZ to include surrounding plot context
  if (args.scene && args.coords) {
    const maxDim = Math.max(trimmed.width, trimmed.length);
    // Plot = building + padding (8m per side at given resolution)
    const padding = 8 * args.resolution;
    const newDim = args.plotRadius > 0
      ? Math.ceil(args.plotRadius * args.resolution * 2)
      : maxDim + padding * 2;
    if (newDim > trimmed.width || newDim > trimmed.length) {
      console.log(`\n--- Plot Expansion ---`);
      console.log(`  Building: ${trimmed.width}x${trimmed.length} → Plot: ${newDim}x${newDim}`);
      trimmed = expandGrid(trimmed, newDim, newDim);
    }
  }

  // ─── Scene Enrichment ──────────────────────────────────────────────────────
  // --enrich / --scene: classify voxels, query OSM infrastructure, populate environment
  if (args.enrich && args.coords) {
    console.log('\n--- Scene Enrichment ---');
    const enrichResult = await enrichScene({
      grid: trimmed,
      coords: args.coords,
      resolution: args.resolution,
      plotRadius: Math.max(trimmed.width, trimmed.length) / (2 * args.resolution),
      capturedEnvironment: envPositions,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
    const es = enrichResult.meta.envStats;
    console.log(`  Environment: trees=${es.treesPlaced}, roads=${es.roadsPlaced}, fences=${es.fencesPlaced}, ground=${es.groundFilled}`);
  } else if (args.enrich && !args.coords) {
    console.log('\nWARNING: --enrich requires --coords LAT,LNG — skipping enrichment');
  }

  // Write output
  const nonAir = trimmed.countNonAir();
  console.log(`\nGrid: ${trimmed.width}x${trimmed.height}x${trimmed.length} | Blocks: ${nonAir.toLocaleString()} | Palette: ${trimmed.palette.size}`);
  console.log(`Palette: ${[...trimmed.palette].join(', ')}`);

  writeSchematic(trimmed, args.outputPath);
  const fileSize = Bun.file(args.outputPath).size;
  console.log(`\nWrote: ${args.outputPath} (${fileSize.toLocaleString()} bytes)`);

  // ── Tile cache: store GLB for future runs ──
  // Cache the source GLB (not the .schem) so subsequent runs with same coords
  // get identical input geometry. Only cache on miss (avoid redundant copies).
  if (args.coords && !args.noCache && !tileCacheHit) {
    try {
      const cacheRadius = 100;
      const cachedPath = await cacheTile(args.coords.lat, args.coords.lng, cacheRadius, args.inputPath);
      const cachedSize = Bun.file(cachedPath).size;
      console.log(`Tile cache: stored ${(cachedSize / (1024 * 1024)).toFixed(1)} MB → ${cachedPath}`);
    } catch (e) {
      console.warn(`Tile cache: store failed — ${(e as Error).message}`);
    }
  }

  console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
