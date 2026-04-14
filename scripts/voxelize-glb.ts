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
import { filterMeshesByHeight, trimSparseBottomLayers, smoothRareBlocks, modeFilter3D, constrainPalette, fillInteriorGaps, scanlineInteriorFill, clearOpenAirFill, removeSmallComponents, removeArtifactComponents, cropToCenter, cropToRect, cropToAABB, analyzeGrid, placeEntryPath, removeGroundPlane, removeGroundPlaneAdaptive, maskToFootprint, stripVegetation, glazeDarkWindows, injectSyntheticWindows, smoothSurface, flattenFacades, morphClose3D, consolidateBlockPalette, isolateTallestStructure, enforceFootprintPolygon, addPeakedRoof, homogenizeFacadesByFace, straightenFootprintEdges, isolatePrimaryBuilding, alignOSMToFootprint, maskToFootprintAligned, severByHeightGradient, watershedIsolate, extractEnvironmentPositions, replaceWithCleanFeatures, detectAndRegularizeWindows, removeThinPillars, smoothDarkBlocks, smoothFacadeColors, smoothRoofPlane, clusterFacadePalette, glazeReflectiveWindows, morphCloseFacadeAligned, detectCornices, flattenFacadesSetbackAware, fillFacadeHoles, removeIsolatedVoxels, fillFacadeVoids2D, fillFacadePlaneHoles, fillFacadeVoidsIterative, fillFacadeStripes, regularizeFlatRoof, boostPhotogrammetrySaturation, snapshotGridBlocks, restoreGridBlocks, detectCourtyardVoids } from '../src/convert/mesh-filter.js';
import type { ExtractedEnvironment, AnalysisResult, GridSnapshot } from '../src/convert/mesh-filter.js';
import { searchOSMBuilding, fetchOSMById } from '../src/gen/api/osm.js';
import { computeBuildingAlignment, type BuildingAlignment } from '../src/convert/building-alignment.js';
import { rgbToWallBlock, WALL_CLUSTERS } from '../src/gen/color-blocks.js';
import { enrichScene, expandGrid } from '../src/convert/scene-pipeline.js';
import { resolveSemanticPalette, applySemanticPalette } from '../src/convert/semantic-palette.js';
import type { SemanticPalette } from '../src/convert/semantic-palette.js';
import { BlockGrid } from '../src/schem/types.js';
import { writeSchematic } from '../src/schem/write.js';
import { queryMultiHeadingSV } from '../src/gen/api/google-streetview.js';
import { extractMultiAngleColors, classifyTexture } from '../src/gen/api/streetview-analysis.js';
import { existsSync, statSync } from 'node:fs';
import { basename, extname, join, dirname, resolve } from 'node:path';
import sharp from 'sharp';

// Extracted CLI helpers
import { parseArgs } from '../src/cli/parse-args.js';
import { loadGLB } from '../src/cli/glb-loader.js';
import { reorientToENU, HEADLESS_NORTH_ALIGN } from '../src/cli/enu-orient.js';
import { sampleSatelliteRoof } from '../src/cli/satellite-color.js';
import { analyzeMeshes, analyzeOne } from '../src/cli/mesh-analysis.js';
import { trySafeMask } from '../src/cli/safe-mask.js';

/**
 * Try to apply OSM footprint mask with auto-alignment fallback.
 * Shared between non-generic and generic pipeline branches (M5 dedup).
 */
async function tryOSMMask(
  grid: BlockGrid,
  coords: { lat: number; lng: number },
  queryOSM: (lat: number, lng: number, radius?: number) => Promise<any>,
  resolution: number,
  maskDilate: number,
  enuHorizontalAngle: number,
  buildingAlignment: BuildingAlignment | null | undefined,
): Promise<{
  success: boolean;
  polygon: { lat: number; lon: number }[] | null;
  tags: Record<string, string>;
}> {
  console.log(`OSM footprint query (pre-fill) at ${coords.lat},${coords.lng}...`);
  const osmData = await queryOSM(coords.lat, coords.lng, 150);
  if (!osmData || osmData.polygon.length < 3) {
    console.log('OSM footprint (pre-fill): no building found at coordinates');
    return { success: false, polygon: null, tags: {} };
  }

  const dilateBlocks = Math.round(maskDilate * resolution);
  const snapshot = snapshotGridBlocks(grid);
  try {
    const masked = maskToFootprint(
      grid, osmData.polygon,
      coords.lat, coords.lng, dilateBlocks, resolution, enuHorizontalAngle,
    );
    const remaining = grid.countNonAir();

    if (remaining < snapshot.count * 0.1 && snapshot.count > 0) {
      // Direct mask removed too much — try auto-alignment
      restoreGridBlocks(grid, snapshot);
      const alignment = alignOSMToFootprint(
        grid, osmData.polygon,
        coords.lat, coords.lng,
        resolution, enuHorizontalAngle,
        40, 0.15, // v116: lowered from 0.25
        !!buildingAlignment, // v300: tighter search when MBR alignment available
      );
      if (alignment) {
        const aligned = maskToFootprintAligned(
          grid, osmData.polygon,
          coords.lat, coords.lng,
          dilateBlocks, resolution, enuHorizontalAngle,
          alignment.dx, alignment.dz,
        );
        const alignRemaining = grid.countNonAir();
        if (alignRemaining >= snapshot.count * 0.1) {
          console.log(`OSM mask (auto-aligned dx=${alignment.dx} dz=${alignment.dz} IoU=${alignment.iou.toFixed(2)}): ${aligned} blocks removed, ${alignRemaining} remaining`);
          return { success: true, polygon: osmData.polygon, tags: osmData.tags ?? {} };
        } else {
          restoreGridBlocks(grid, snapshot);
          console.log(`OSM mask: direct + auto-align both failed (IoU=${alignment.iou.toFixed(2)}), using geometry isolation`);
          return { success: false, polygon: null, tags: {} };
        }
      } else {
        console.log(`OSM mask: polygon misaligned, no alignment found (IoU<0.15), using geometry isolation`);
        return { success: false, polygon: null, tags: {} };
      }
    } else {
      console.log(`OSM mask (pre-fill): ${masked} blocks removed, ${remaining} remaining`);
      return { success: true, polygon: osmData.polygon, tags: osmData.tags ?? {} };
    }
  } catch (err) {
    console.warn(`OSM mask failed: ${(err as Error).message}`);
    restoreGridBlocks(grid, snapshot);
    return { success: false, polygon: null, tags: {} };
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const t0 = performance.now();
  let enuHorizontalAngle = 0; // Rotation applied by reorientToENU, used for OSM polygon alignment

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
  console.log(`\nVoxelizing: ${args.mode} mode, ${args.resolution} block/m, gamma ${args.gamma}, kernel ${args.kernel}, desat ${args.desaturate}`);
  console.log(`  Estimated grid: ${estW}x${estH}x${estL} = ${estVoxels.toLocaleString()} voxels (${estMemMB.toFixed(0)} MB)`);
  if (estVoxels > 50_000_000) {
    console.log(`  ⚠ Large grid — narrow-band voxelization will skip empty space`);
  }
  const sampler = createDataTextureSampler(args.gamma, args.kernel, args.desaturate);
  const tVox = performance.now();
  const grid = threeToGrid(filteredGroup, args.resolution, {
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

  // Trim sparse bottom layers
  let trimmed = trimSparseBottomLayers(grid, args.trimThreshold);
  if (trimmed !== grid) {
    const removed = grid.height - trimmed.height;
    console.log(`Trimmed ${removed} sparse bottom layers (${grid.height} → ${trimmed.height})`);
  }

  // ── Auto-detection: analyze grid and override pipeline params ──
  let analysis: AnalysisResult | null = null;
  let osmMaskDone = false; // Track if OSM mask ran in pre-fill path
  let osmPolygon: Array<{ lat: number; lon: number }> | null = null; // Save for post-processing re-mask
  let osmTags: Record<string, string> = {}; // v314: OSM tags for semantic palette
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

    // Apply AABB crop if recommended (shape-preserving alternative to circular crop)
    if (rec.useAABBCrop) {
      const aabb = analysis.centralAABB;
      const cropped = cropToAABB(trimmed, aabb.minX, aabb.maxX, aabb.minZ, aabb.maxZ, 2);
      if (cropped > 0) {
        console.log(`AABB crop: ${cropped} blocks removed (keeping [${aabb.minX}-${aabb.maxX}] x [${aabb.minZ}-${aabb.maxZ}] + 2 margin)`);
      }
    }
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

  if (!args.generic) {
    // === Shape processing (tuned for isolated single-building captures) ===
    // Pipeline order: ground removal → OSM mask → component cleanup → fill → vegetation.
    // OSM mask MUST run before fill — otherwise capture boundary walls create sealed
    // perimeter and fill floods the entire "core sample" solid.

    // Step 1: Ground plane removal — strip terrain that seals building bottom
    if (args.mode === 'surface') {
      const { removed: groundRemoved, groundY } = removeGroundPlane(trimmed, 1);
      if (groundRemoved > 0) {
        console.log(`Ground plane (pre-fill): ${groundRemoved} terrain blocks removed (groundY=${groundY})`);
      }
    }

    // Adaptive ground removal — handles thick/sloped terrain that basic removeGroundPlane misses.
    // Per-column detection adapts to local terrain height variation.
    const adaptiveGround = removeGroundPlaneAdaptive(trimmed);
    if (adaptiveGround > 0) {
      console.log(`Ground plane (adaptive): ${adaptiveGround} blocks removed`);
    }

    // Step 2: OSM footprint mask — carve away everything outside building polygon.
    // For buildings smaller than capture radius, this removes sidewalk/road/neighbors.
    // For buildings larger than capture, mask removes 0 (all blocks inside polygon).
    if (args.coords && !osmMaskDone && !args.noOsm) {
      const osmResult = await tryOSMMask(
        trimmed, args.coords, queryOSM,
        args.resolution, args.maskDilate ?? 3,
        enuHorizontalAngle, buildingAlignment,
      );
      if (osmResult.success) {
        osmMaskDone = true;
        osmPolygon = osmResult.polygon;
        osmTags = osmResult.tags;
      }
    }

    // Step 3a: Tower isolation — for skyscrapers with surrounding buildings
    // fused into the same mesh, sample footprint at 75% height (above neighbors)
    // and strip everything outside the expanded tower footprint.
    // Expansion 15 blocks allows for typical skyscraper setbacks (base 2-3x tower width).
    // SKIP for setback buildings — 75% height sampling shears off stepped base (ESB, Capitol).
    // The 3D CC isolation in step 3c preserves setbacks because base+tower are connected.
    if (!analysis?.hasSetbacks) {
      const towerIsolated = isolateTallestStructure(trimmed, 0.75, 5);
      if (towerIsolated > 0) {
        console.log(`Tower isolation: ${towerIsolated} blocks removed (75% height footprint)`);
      }
    } else {
      console.log(`Tower isolation: SKIPPED (building has setbacks — using 3D CC instead)`);
    }

    // Step 3b: Component cleanup — remove noise/debris.
    // Resolution-aware: 500 voxels at 1x = 500m³. At 2x, 500 voxels = 62.5m³ — too aggressive.
    // Scale by resolution³ to maintain same physical volume threshold.
    const compMinSize = Math.round(500 * Math.pow(args.resolution, 3));
    const preFillCleaned = removeSmallComponents(trimmed, compMinSize);
    if (preFillCleaned > 0) {
      console.log(`Pre-fill cleanup: ${preFillCleaned} blocks removed (< ${compMinSize} voxels, res=${args.resolution})`);
    }
    // Density + distance artifact cleanup — removes sparse needles and distant debris
    const artifactCleaned = removeArtifactComponents(trimmed, 0.1, 1.5);
    if (artifactCleaned > 0) console.log(`Artifact cleanup: ${artifactCleaned} blocks removed (sparse/distant)`);


    // Step 3c: 3-tier building isolation when OSM mask failed or was skipped.
    // v95: 1) Connected component isolation, 2) Height gradient severing, 3) Watershed
    if (!osmMaskDone && !args.noIsolate) {
      // Tier 1: Connected component isolation (works when buildings have air gaps)
      const isolated = isolatePrimaryBuilding(trimmed);
      if (isolated > 0) {
        console.log(`Isolation tier 1 (components): ${isolated} blocks removed`);
      }

      // Tier 2: Height gradient severing (works when buildings have different heights)
      const severed = severByHeightGradient(trimmed, 3, 200);
      if (severed > 0) {
        console.log(`Isolation tier 2 (height gradient): ${severed} blocks severed`);
      }

      // Tier 3: Watershed (works for same-height fused buildings with dumbbell footprint)
      // Revert if watershed removes >50% of remaining blocks (carved up a single building)
      trySafeMask(
        trimmed,
        () => { watershedIsolate(trimmed, 4); },
        'Isolation tier 3 (watershed)',
        0.50,
      );
    }

    // Step 4: Interior fill — 3D masked dilation flood-fill.
    // Gate by 3D fill ratio: photogrammetry shells have high XZ density (93%+ columns
    // occupied) but low 3D fill (35%) — they're hollow. Use 3D ratio to decide:
    // >60% 3D fill = genuinely solid (skip), <60% = hollow shell (fill needed).
    if (args.fill) {
      const totalCells = trimmed.width * trimmed.height * trimmed.length;
      const nonAirCount = trimmed.countNonAir();
      const fill3D = nonAirCount / totalCells;
      if (fill3D > 0.60) {
        console.log(`Skipping fill (3D density ${(fill3D * 100).toFixed(0)}% > 60% — already solid)`);
      } else {
        // Density-adaptive dilation: target physical gap size (in meters), then scale by resolution.
        // Sparse shells (<30% fill) have large gaps needing ~4m dilation.
        // Dense shells (>50%) only need ~2m — over-dilating seals intentional openings.
        // v301: resolution-aware — at 2x, dilation=4 closes only 2m; at 1x, 4m.
        const targetMeters = fill3D < 0.30 ? 4 : fill3D < 0.50 ? 3 : 2;
        const dilation = Math.max(1, Math.round(targetMeters * args.resolution));
        // Track filled voxels so clearOpenAirFill only clears fill, not original geometry
        const filledSet = new Set<number>();
        const interiorFilled = fillInteriorGaps(trimmed, dilation, args.resolution, filledSet);
        console.log(`Interior fill (dilation=${dilation}): ${interiorFilled} voxels filled (3D density ${(fill3D * 100).toFixed(0)}%)`);
        // Step 4b: Sky exposure — remove fill in open-air spaces (courtyards, setbacks)
        // Scale minClearance by resolution so ~5m vertical clearance is always required
        const openAirCleared = clearOpenAirFill(trimmed, 'minecraft:smooth_stone', Math.round(5 * args.resolution), filledSet);
        if (openAirCleared > 0) console.log(`Open-air fill cleared: ${openAirCleared} fill blocks removed (no solid roof above)`);
        // Scanline interior fill — catches thin gaps that dilation+flood missed.
        // Sky-visibility check inherently prevents courtyard filling.
        const scanFilled = scanlineInteriorFill(trimmed, filledSet);
        if (scanFilled > 0) console.log(`Scanline interior fill: ${scanFilled} voxels`);

        // Step 4d: Courtyard void detection — undo fills in intentional architectural voids
        // (courtyards, atriums, light wells). These are air columns with sky access,
        // empty at ground level, and surrounded by solid walls on 2+ sides.
        const courtyardVoids = detectCourtyardVoids(trimmed);
        if (courtyardVoids.size > 0) {
          let courtyardCleared = 0;
          for (const key of courtyardVoids) {
            const comma = key.indexOf(',');
            const cx = parseInt(key.substring(0, comma), 10);
            const cz = parseInt(key.substring(comma + 1), 10);
            for (let y = 0; y < trimmed.height; y++) {
              const idx = (y * trimmed.length + cz) * trimmed.width + cx;
              if (filledSet.has(idx) && trimmed.get(cx, y, cz) !== 'minecraft:air') {
                trimmed.set(cx, y, cz, 'minecraft:air');
                filledSet.delete(idx);
                courtyardCleared++;
              }
            }
          }
          if (courtyardCleared > 0) {
            console.log(`Courtyard detection: ${courtyardVoids.size} void columns, ${courtyardCleared} fill blocks preserved`);
          }
        }
      }
    }

    // Step 4c: Extract environment positions BEFORE vegetation strip (--scene)
    if (args.scene && args.coords) {
      envPositions = extractEnvironmentPositions(trimmed, analysis?.groundPlaneY ?? 0);
      console.log(`Environment extraction: ${envPositions.trees.length} trees, ${envPositions.roads.cells.size} road cells, ${envPositions.vehicles.length} vehicles`);
    }

    // Step 5: Vegetation strip
    if (args.mode === 'surface') {
      const vegStripped = stripVegetation(trimmed);
      if (vegStripped > 0) console.log(`Vegetation strip: ${vegStripped} tree/bush blocks removed`);
    }

    // SolidifyCore REMOVED (v54): AABB per Y-layer fill was destroying non-rectangular
    // shapes. Dakota's U-shaped courtyard got filled, Sentinel's triangle became a rectangle.
    // Gemini: Sentinel 8→1, Dakota 5→2 due to solidifyCore. fillInteriorGaps (step 4)
    // already handles hollow shell filling without altering the building footprint.
  } else {
    console.log(`Generic mode: skipping rectify (preserving raw geometry)`);
    if (args.fill) {
      // For generic captures (multi-structure scenes with terrain), fill must run
      // AFTER terrain isolation. Otherwise, terrain creates a sealed perimeter and
      // flood-fill classifies the entire capture volume as "interior" — producing
      // massive nonsensical cubes instead of recognizable buildings.

      // Step 1: Strip ground plane first — removes flat terrain layer that seals perimeter
      if (args.mode === 'surface') {
        const { removed: groundRemoved, groundY } = removeGroundPlane(trimmed, 1);
        if (groundRemoved > 0) {
          console.log(`Ground plane (pre-fill): ${groundRemoved} terrain blocks removed (groundY=${groundY})`);
        }
      }

      // Step 2: OSM footprint mask BEFORE fill — isolate building polygon so fill
      // only fills the building interior, not surrounding terrain/roads/neighbors.
      if (args.coords && !args.noOsm) {
        const osmResult = await tryOSMMask(
          trimmed, args.coords, queryOSM,
          args.resolution, args.maskDilate ?? 3,
          enuHorizontalAngle, buildingAlignment,
        );
        if (osmResult.success) {
          osmMaskDone = true;
          osmPolygon = osmResult.polygon;
          osmTags = osmResult.tags;
        }
      }

      // Step 3a: Tower isolation — strip surrounding buildings for skyscrapers
      // SKIP for setback buildings — 75% height sampling shears off stepped base.
      if (!analysis?.hasSetbacks) {
        const towerIsolated2 = isolateTallestStructure(trimmed, 0.75, 5);
        if (towerIsolated2 > 0) {
          console.log(`Tower isolation: ${towerIsolated2} blocks removed (75% height footprint)`);
        }
      } else {
        console.log(`Tower isolation: SKIPPED (building has setbacks)`);
      }

      // Step 3b: Remove noise/debris — resolution-aware threshold.
      // Base 500 voxels at 1x = 500m³. Scale by resolution³ for consistent physical volume.
      // Preserves legitimate building wings (Pentagon, Capitol) while removing noise.
      const compMinSize2 = Math.round(500 * Math.pow(args.resolution, 3));
      const preFillCleaned = removeSmallComponents(trimmed, compMinSize2);
      if (preFillCleaned > 0) {
        console.log(`Pre-fill cleanup: ${preFillCleaned} blocks removed (components < ${compMinSize2} voxels, res=${args.resolution})`);
      }

      // Step 3c: 3-tier building isolation when OSM mask failed or was skipped.
      // v95: 1) Connected component isolation, 2) Height gradient severing, 3) Watershed
      if (!osmMaskDone && !args.noIsolate) {
        // Tier 1: Connected component isolation (works when buildings have air gaps)
        const isolated = isolatePrimaryBuilding(trimmed);
        if (isolated > 0) {
          console.log(`Isolation tier 1 (components): ${isolated} blocks removed`);
        }

        // Tier 2: Height gradient severing (works when buildings have different heights)
        const severed = severByHeightGradient(trimmed, 3, 200);
        if (severed > 0) {
          console.log(`Isolation tier 2 (height gradient): ${severed} blocks severed`);
        }

        // Tier 3: Watershed (works for same-height fused buildings with dumbbell footprint)
        // Revert if watershed removes >50% of remaining blocks (carved up a single building)
        trySafeMask(
          trimmed,
          () => { watershedIsolate(trimmed, 4); },
          'Isolation tier 3 (watershed)',
          0.50,
        );
      }

      // Step 4: 3D masked dilation fill — building is now isolated.
      // dilation=1 fills 1-voxel gaps in the facade shell before flood-filling interior.
      // Tested dilation=2: citigroup merged with adjacent structures, scores regressed.
      // Track filled voxels so clearOpenAirFill only clears fill, not original geometry
      const filledSet2 = new Set<number>();
      const interiorFilled = fillInteriorGaps(trimmed, 1, 1, filledSet2);
      console.log(`Interior fill (3D masked, dilation=1): ${interiorFilled} interior voxels filled`);
      // Step 4b: Sky exposure — remove fill in open-air spaces
      const openAirCleared = clearOpenAirFill(trimmed, 'minecraft:smooth_stone', 5, filledSet2);
      if (openAirCleared > 0) console.log(`Open-air fill cleared: ${openAirCleared} blocks (no solid roof above)`);

      // Step 4d: Courtyard void detection — undo fills in intentional architectural voids
      const courtyardVoids2 = detectCourtyardVoids(trimmed);
      if (courtyardVoids2.size > 0) {
        let courtyardCleared2 = 0;
        for (const key of courtyardVoids2) {
          const comma = key.indexOf(',');
          const cx = parseInt(key.substring(0, comma), 10);
          const cz = parseInt(key.substring(comma + 1), 10);
          for (let y = 0; y < trimmed.height; y++) {
            const idx = (y * trimmed.length + cz) * trimmed.width + cx;
            if (filledSet2.has(idx) && trimmed.get(cx, y, cz) !== 'minecraft:air') {
              trimmed.set(cx, y, cz, 'minecraft:air');
              filledSet2.delete(idx);
              courtyardCleared2++;
            }
          }
        }
        if (courtyardCleared2 > 0) {
          console.log(`Courtyard detection: ${courtyardVoids2.size} void columns, ${courtyardCleared2} fill blocks preserved`);
        }
      }

      // Step 4c: Extract environment positions BEFORE vegetation strip (--scene, generic mode)
      if (args.scene && args.coords && !envPositions) {
        envPositions = extractEnvironmentPositions(trimmed, 0);
        console.log(`Environment extraction: ${envPositions.trees.length} trees, ${envPositions.roads.cells.size} road cells, ${envPositions.vehicles.length} vehicles`);
      }

      // Step 5: Strip vegetation — trees acted as solid walls during fill,
      // revealing the building interior behind canopy instead of leaving holes.
      if (args.mode === 'surface') {
        const vegStripped = stripVegetation(trimmed);
        if (vegStripped > 0) console.log(`Vegetation strip: ${vegStripped} tree/bush blocks removed (post-fill)`);
      }
    }
  }

  // Center crop — remove blocks beyond XZ radius to isolate central building.
  // Runs after fill/solidify so each building is solid before we crop peripheral ones.
  // Skip for partial captures where the building extends beyond the capture boundary —
  // cropping would shear off geometry that's already truncated.
  if (args.cropRadius > 0 && !analysis?.isPartialCapture) {
    // Dry-run: count blocks that would survive crop before mutating grid.
    // Sprawling campuses (Getty, Apple Park) have geometry offset from grid center,
    // so center-based rect crop would destroy the entire building.
    const cx = Math.floor(trimmed.width / 2);
    const cz = Math.floor(trimmed.length / 2);
    const r = args.cropRadius;
    let insideCrop = 0, outsideCrop = 0;
    for (let y = 0; y < trimmed.height; y++) {
      for (let z = 0; z < trimmed.length; z++) {
        for (let x = 0; x < trimmed.width; x++) {
          if (trimmed.get(x, y, z) === 'minecraft:air') continue;
          if (Math.abs(x - cx) > r || Math.abs(z - cz) > r) outsideCrop++;
          else insideCrop++;
        }
      }
    }
    if (insideCrop < (insideCrop + outsideCrop) * 0.05 && (insideCrop + outsideCrop) > 500) {
      console.log(`Skipping rect crop (would keep only ${insideCrop}/${insideCrop + outsideCrop} blocks — building offset from grid center)`);
    } else {
      const cropped = cropToRect(trimmed, args.cropRadius);
      if (cropped > 0) {
        console.log(`Rect crop: ${cropped} blocks removed (half-width ${args.cropRadius})`);
      }
    }
  } else if (args.cropRadius > 0 && analysis?.isPartialCapture) {
    console.log(`Skipping rect crop (partial capture — building extends beyond boundary)`);
  }

  // Ground plane subtraction — remove terrain layer below the building.
  // Skip if already done: non-generic path does it in step 1, generic+fill path does it pre-fill.
  if (args.mode === 'surface' && args.generic && !args.fill) {
    const { removed: groundRemoved, groundY } = removeGroundPlane(trimmed, 1);
    if (groundRemoved > 0) {
      console.log(`Ground plane: ${groundRemoved} terrain blocks removed (groundY=${groundY})`);
    }
  }

  // OSM footprint masking — remove all blocks outside the building polygon.
  // Skip if already done in the generic pre-fill path above.
  if (args.coords && !osmMaskDone && !args.noOsm) {
    console.log(`OSM footprint query at ${args.coords.lat},${args.coords.lng}...`);
    const osmData = await queryOSM(args.coords.lat, args.coords.lng, 150);
    if (osmData && osmData.polygon.length >= 3) {
      const { reverted } = trySafeMask(
        trimmed,
        () => maskToFootprint(
          trimmed, osmData.polygon,
          args.coords!.lat, args.coords!.lng, Math.round((args.maskDilate ?? 3) * args.resolution), args.resolution, enuHorizontalAngle,
        ),
        `OSM footprint mask (${osmData.polygon.length} vertices)`,
        0.10,
      );
      if (!reverted) {
        osmTags = osmData.tags ?? {};
      }
    } else {
      console.log('OSM footprint: no building found at coordinates');
    }
  }

  // Smooth rare/noisy blocks — replace blocks below threshold frequency with neighbors.
  if (args.smoothPct > 0) {
    const smoothed = smoothRareBlocks(trimmed, args.smoothPct);
    if (smoothed > 0) {
      console.log(`Smoothed ${smoothed} rare blocks (threshold ${(args.smoothPct * 100).toFixed(1)}%)`);
    }
  } else {
    console.log('Skipping rare-block smoothing (--smooth-pct 0)');
  }

  // v71: Save 2D footprint bitmap BEFORE morphClose — captures the building outline
  // after fill/clear/vegetation but before any smoothing that could expand it.
  // Used after processing to clip columns added by morphClose dilation.
  let savedFootprint: Uint8Array | null = null;
  {
    const { width: gw, height: gh, length: gl } = trimmed;
    savedFootprint = new Uint8Array(gw * gl);
    for (let z = 0; z < gl; z++) {
      for (let x = 0; x < gw; x++) {
        for (let y = 0; y < gh; y++) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') {
            savedFootprint[z * gw + x] = 1;
            break;
          }
        }
      }
    }
  }

  // Determine if building has complex geometry (non-rectangular footprint or setbacks)
  // that should be protected from destructive post-processing filters.
  const isComplexShape = (analysis?.rectangularity ?? 1) < 0.85 || (analysis?.hasSetbacks ?? false);
  if (isComplexShape) {
    console.log(`Complex shape detected: rectangularity=${(analysis?.rectangularity ?? 1).toFixed(2)}, setbacks=${analysis?.hasSetbacks}, profile=${analysis?.heightProfile}`);
  }

  // Morph close — spackle pockmarks/holes in photogrammetry surfaces.
  // v71: r=3→r=2. v106: r=2→r=1. r=1 fills 1-voxel gaps without adding blobby mass.
  // v301: Profile-aware height limit for complex shapes. Tapered buildings (Transamerica)
  // need tip protected, domed need dome protected, stepped need step edges preserved.
  // The fraction controls how much of the building (from bottom) gets morph-close treatment.
  {
    if (isComplexShape) {
      // Profile-aware: protect more of the distinctive geometry at top
      const profile = analysis?.heightProfile ?? 'uniform';
      const closeFraction: Record<string, number> = {
        tapered: 0.35,  // v307: protect 65% — raised from 0.20 to compensate for skipped post-filter morphClose
        stepped: 0.40,  // protect 60% — step edges are real architecture
        domed: 0.30,    // protect 70% — dome curvature is critical
        uniform: 0.50,  // protect 50% — standard complex shape
      };
      const fraction = closeFraction[profile] ?? 0.30;
      const maxY = Math.max(10, Math.round(trimmed.height * fraction));
      const closed = morphClose3D(trimmed, 1, maxY);
      if (closed > 0) {
        console.log(`Morph close (r=1, maxY=${maxY}, profile=${profile}): ${closed} holes filled (complex shape — bottom ${Math.round(fraction * 100)}%)`);
      }
    } else {
      const closed = morphClose3D(trimmed, 1);
      if (closed > 0) {
        console.log(`Morph close (r=1): ${closed} holes filled`);
      }
    }
  }

  // Phase 2c: Facade-aligned morph close — radius-2 gap filling along facade normals.
  // Closes facade pockmarks without adding unwanted depth.
  {
    const r = 2;
    const facadeClosed = morphCloseFacadeAligned(trimmed, r);
    if (facadeClosed > 0) {
      console.log(`Facade morph close (r=${r}): ${facadeClosed} facade gaps filled (normal-aligned)`);
    }
  }

  // v311: Fill single-block facade holes — air voxels surrounded by solid neighbors.
  // Complex shapes: minSolid=3 (overhangs/setbacks create 3-neighbor gaps), 1 pass.
  // Regular shapes: minSolid=4 (conservative — avoids closing walkways), 1 pass.
  // Note: 3-pass was too aggressive for boston-cityhall (changed proportions → height_truncated).
  {
    const ms = isComplexShape ? 3 : 4;
    const mp = 1;
    const holeFilled = fillFacadeHoles(trimmed, ms, mp);
    if (holeFilled > 0) {
      console.log(`Facade hole fill: ${holeFilled} voids patched (${ms}+ solid neighbors, ${mp} passes)`);
    }
  }

  // Facade stripe repair — fill venetian-blind artifacts from oblique capture
  const stripesFilled = fillFacadeStripes(trimmed);
  if (stripesFilled > 0) console.log(`Facade stripes: ${stripesFilled} filled`);

  // Iterative facade void fill — close large holes on facade planes
  const voidsFilled = fillFacadeVoidsIterative(trimmed, 5);
  if (voidsFilled > 0) console.log(`Facade voids (iterative): ${voidsFilled} filled`);

  // v74: Edge straightening — median filter on XZ silhouette traces to remove
  // stair-step jaggies. Run after morphClose (shape healed) but before zone assignment
  // and facade smoothing. maxShift=2 limits correction to avoid distorting real setbacks.
  // Skip for complex shapes — setbacks and tapers are NOT staircase noise.
  if (!isComplexShape) {
    const straightened = straightenFootprintEdges(trimmed, 2, 2);
    if (straightened > 0) {
      console.log(`Edge straightening: ${straightened} blocks adjusted (median filter, maxShift=2)`);
    }
  } else {
    console.log(`Edge straightening: SKIPPED (complex shape — setbacks are real geometry)`);
  }

  // Geometric smoothing — remove 1-voxel protrusions from photogrammetry noise.
  // v73: Protect top 40% of rectangular buildings. v301: profile-aware for complex shapes.
  // Tapered buildings need nearly all height protected (tip IS the building).
  // Stepped/domed need moderate protection. Rectangular gets standard treatment.
  {
    let roofCutoff: number;
    if (isComplexShape) {
      const profile = analysis?.heightProfile ?? 'uniform';
      const smoothFraction: Record<string, number> = {
        tapered: 0.15,  // protect 85% — aggressive smoothing would erode taper
        stepped: 0.50,  // protect 50% — steps define silhouette above midpoint
        domed: 0.25,    // protect 75% — dome curvature starts early
        uniform: 0.40,  // protect 60% — standard complex shape
      };
      roofCutoff = Math.round(trimmed.height * (smoothFraction[profile] ?? 0.30));
    } else {
      roofCutoff = Math.round(trimmed.height * 0.60); // Rectangular: protect top 40%
    }
    // v73: preserveBoundary=true locks silhouette edges (tips, corners) from erosion
    const surfaceSmoothed = smoothSurface(trimmed, roofCutoff, true);
    if (surfaceSmoothed > 0) {
      console.log(`Surface smoothing: ${surfaceSmoothed} 1-block protrusions removed (below Y=${roofCutoff}${isComplexShape ? `, profile=${analysis?.heightProfile ?? 'uniform'}` : ''})`);
    }
    // For rectangular buildings (OBB ≥0.85 AND no setbacks), snap noisy walls to dominant flat planes.
    // v70: tolerance reduced from 2 to 1 — tolerance=2 was destroying bay windows.
    // Skip entirely for non-rectangular or setback buildings — their walls ARE the shape.
    if (!isComplexShape && analysis?.isRectangular) {
      // Phase 5b+5c: Detect cornices then apply setback-aware flattening
      const corniceYs = detectCornices(trimmed, 2, true);
      if (corniceYs.size > 0) {
        console.log(`Cornice detection: ${corniceYs.size} Y levels preserved as architectural features`);
        const snapped = flattenFacadesSetbackAware(trimmed, corniceYs, 1, args.resolution);
        if (snapped > 0) {
          console.log(`Setback-aware facade flattening: ${snapped} voxels snapped (${corniceYs.size} cornice levels excluded)`);
        }
      } else {
        // Fallback: standard flattening when no cornices detected
        // v95: Pass roofCutoff to skip roof layer
        const snapped = flattenFacades(trimmed, 1, roofCutoff);
        if (snapped > 0) {
          console.log(`Facade flattening: ${snapped} voxels snapped to dominant planes (below Y=${roofCutoff})`);
        }
      }
    } else if (isComplexShape) {
      console.log(`Facade flattening: SKIPPED (complex shape — walls define building identity)`);
    }
  }

  // v312: Seal multi-block facade holes using 2D flood-fill projection.
  // After flattenFacades, facades are on clean planes. Project each facade to 2D,
  // flood-fill exterior from edges, and fill enclosed voids (holes in the surface).
  // Courtyard-safe: courtyards connect to exterior air in the 2D projection.
  {
    const sealed = fillFacadeVoids2D(trimmed);
    if (sealed > 0) {
      console.log(`Facade void sealing (scanline): ${sealed} enclosed voids filled`);
    }
    // Second fillFacadeHoles pass — scanline fill creates new anchor points
    // that enable previously unfillable holes to be filled.
    if (sealed > 0) {
      const holeFilled2 = fillFacadeHoles(trimmed, 4);
      if (holeFilled2 > 0) {
        console.log(`Facade hole fill pass 2: ${holeFilled2} voids patched (post-scanline)`);
      }
    }
  }

  // v314: Targeted facade-plane hole fill — 2D flood-fill on each facade plane
  // to find and fill bounded interior air pockets ≤ 25 blocks. Runs after
  // fillFacadeVoids2D which handles scanline gaps. This catches medium holes
  // (3-5 blocks) that need 2D connectivity analysis to distinguish from courtyards.
  {
    const planeFilled = fillFacadePlaneHoles(trimmed, 25);
    if (planeFilled > 0) {
      console.log(`Facade plane holes: ${planeFilled} bounded air pockets filled (2D flood-fill)`);
    }
  }

  // Glaze dark exterior blocks as windows BEFORE zone simplification.
  // Zone simplification collapses all blocks to roof/wall dominant types,
  // destroying the dark blocks that indicate windows. By glazing first,
  // gray_stained_glass enters the SPECIAL_BLOCKS set and survives simplification.
  // v73: --no-glaze disables this — scattered glass reads as "noisy/porous" surface to VLMs
  let glazed = 0;
  if (args.mode === 'surface' && !args.noGlaze) {
    glazed = glazeDarkWindows(trimmed, args.resolution, true); // photogrammetryMode for tiles captures
    if (glazed > 0) {
      console.log(`Window glazing: ${glazed} dark exterior blocks → gray_stained_glass (photogrammetry mode)`);
    }
    // Phase 5a: Sky-reflecting window detection — catches blue/grey specular blocks
    const reflective = glazeReflectiveWindows(trimmed, args.resolution);
    if (reflective > 0) {
      console.log(`Reflective windows: ${reflective} blue/grey facade blocks → glass`);
    }
    glazed += reflective;
    // Synthetic windows for bright facades that lack dark blocks to glaze.
    // injectSyntheticWindows only fires when existing glazing < 0.5% of non-air
    // and building is ≥ 8 blocks tall, so safe to call unconditionally.
    const injected = injectSyntheticWindows(trimmed, glazed, args.resolution);
    if (injected > 0) {
      console.log(`Synthetic windows: ${injected} blocks (bright facade, glazed=${glazed})`);
    }
  }

  // Zone accent blocks to protect from mode filter (populated by zone simplification)
  let zoneProtected: Set<string> | undefined;
  // Dominant materials — hoisted from zone scope for use by enforceFootprintPolygon + palette cleanup
  let roofDom = 'minecraft:smooth_stone';
  let wallDom = 'minecraft:smooth_stone';
  let groundDom = 'minecraft:sandstone';

  // Multi-zone facade simplification (v67): 5 distinct material zones for visual depth.
  //
  // v65-v66 collapsed all voxels to 2 blocks (roof + wall), producing monochrome
  // buildings that score ~1-3/10. v67 derives accent variants from base colors to
  // create architectural banding without fabricating fake data:
  //   1. Roof (topmost block per column) — satellite color
  //   2. Upper wall (top 20% of wall height) — lighter accent
  //   3. Main wall (middle 60%) — primary wall material
  //   4. Ground floor (bottom 20%) — darker/contrasting base
  //   5. Corner trim (edge columns) — structural accent
  // Glass windows (SPECIAL_BLOCKS) survive all zone assignment.
  //
  // v300: gated behind --zone-normalize flag. Default off — raw CIELAB wall colors
  // produce richer textures than any derived 5-zone scheme on photogrammetric meshes.
  if (args.zoneNormalize) {
    const SPECIAL_BLOCKS = new Set([
      'minecraft:air',
      'minecraft:gray_stained_glass',
      'minecraft:green_concrete',
      'minecraft:birch_planks',
    ]);

    // Neutral grays from baked photogrammetric lighting — no material signal.
    // All grays collapse to wallDom. Gray variety preservation (v106 attempt) caused
    // regressions — wallDom is typically smooth_stone (light gray), so dark grays
    // survived as scattered noise on Nashville (10→3.3), Dakota (9→6.4).
    const GRAY_BLOCKS = new Set([
      'minecraft:smooth_stone',       // rgb 162,162,162
      'minecraft:light_gray_concrete', // rgb 125,125,115
      'minecraft:andesite',           // rgb 136,136,136
      'minecraft:polished_andesite',  // rgb 132,135,134
      'minecraft:gray_concrete',      // rgb 55,58,62
      'minecraft:polished_deepslate', // rgb 55,58,62
    ]);

    // Count blocks per zone: roof = topmost per column, wall = everything below
    const roofCounts = new Map<string, number>();
    const wallCounts = new Map<string, number>();
    for (let x = 0; x < trimmed.width; x++) {
      for (let z = 0; z < trimmed.length; z++) {
        let topY = -1;
        for (let y = trimmed.height - 1; y >= 0; y--) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
        }
        if (topY < 0) continue;
        for (let y = 0; y <= topY; y++) {
          const b = trimmed.get(x, y, z);
          if (SPECIAL_BLOCKS.has(b)) continue;
          if (y === topY) {
            roofCounts.set(b, (roofCounts.get(b) || 0) + 1);
          } else {
            wallCounts.set(b, (wallCounts.get(b) || 0) + 1);
          }
        }
      }
    }

    // Find dominant in each zone (assigns outer-scoped vars for enforceFootprintPolygon)
    let roofMax = 0;
    for (const [b, c] of roofCounts) { if (c > roofMax) { roofDom = b; roofMax = c; } }
    let wallMax = 0;
    for (const [b, c] of wallCounts) { if (c > wallMax) { wallDom = b; wallMax = c; } }

    // Diagnostic: block distribution before zone override
    const sortedWall = [...wallCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const sortedRoof = [...roofCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  Roof blocks: ${sortedRoof.map(([b, c]) => `${b.replace('minecraft:', '')}(${c})`).join(' ')}`);
    console.log(`  Wall blocks: ${sortedWall.map(([b, c]) => `${b.replace('minecraft:', '')}(${c})`).join(' ')}`);

    // ── Determine base materials ─────────────────────────────────────────────
    // Satellite for roof, photogrammetric secondary for walls (same as v66)
    if (args.coords) {
      const extColors = await sampleSatelliteRoof(args.coords.lat, args.coords.lng);
      if (extColors) roofDom = extColors.roofBlock;

      const sorted = [...wallCounts.entries()]
        .filter(([b]) => !SPECIAL_BLOCKS.has(b))
        .sort((a, b) => b[1] - a[1]);
      const totalWall = sorted.reduce((s, [, c]) => s + c, 0);

      // Find first non-gray secondary with ≥5% of total wall blocks
      const nonGraySecondary = sorted.find(([b, c]) =>
        !GRAY_BLOCKS.has(b) && c >= totalWall * 0.05
      );
      if (nonGraySecondary) {
        wallDom = nonGraySecondary[0];
        console.log(`  Wall: photogrammetric secondary ${wallDom.replace('minecraft:', '')} (${nonGraySecondary[1]} blocks, ${(100 * nonGraySecondary[1] / totalWall).toFixed(0)}%)`);
      } else {
        wallDom = sorted[0]?.[0] ?? wallDom;
      }
      // v96: Always de-bake wall color — photogrammetry textures are baked with
      // ambient occlusion + shadow, making everything ~30-50% darker than reality.
      // Boost brightness 1.5x to better match real-world facade appearance.
      const wallCluster = WALL_CLUSTERS.find(c => c.options.includes(wallDom));
      if (wallCluster) {
        const [wr, wg, wb] = wallCluster.rgb;
        const boosted = rgbToWallBlock(
          Math.min(255, Math.round(wr * 1.5)),
          Math.min(255, Math.round(wg * 1.5)),
          Math.min(255, Math.round(wb * 1.5)),
        );
        if (boosted !== wallDom) {
          console.log(`  Wall de-bake: ${wallDom.replace('minecraft:', '')} → ${boosted.replace('minecraft:', '')} (1.5x brightness boost)`);
          wallDom = boosted;
        }
      }

      // Ensure roof ≠ wall (identical block check)
      if (wallDom === roofDom) {
        const sorted2 = [...wallCounts.entries()]
          .filter(([b]) => !SPECIAL_BLOCKS.has(b))
          .sort((a, b) => b[1] - a[1]);
        const nonGrayFallback = sorted2.find(([b]) =>
          b !== roofDom && !SPECIAL_BLOCKS.has(b) && !GRAY_BLOCKS.has(b)
        );
        if (nonGrayFallback) wallDom = nonGrayFallback[0];
        else {
          const wc = WALL_CLUSTERS.find(c => c.options.includes(roofDom));
          if (wc) {
            const [wr, wg, wb] = wc.rgb;
            const d = rgbToWallBlock(Math.min(255, Math.round(wr * 1.3)), Math.min(255, Math.round(wg * 1.3)), Math.min(255, Math.round(wb * 1.3)));
            if (d !== roofDom) wallDom = d;
          }
        }
        console.log(`  Wall fallback: ${wallDom.replace('minecraft:', '')} (avoided roof duplicate)`);
      }

      // ── v96 contrast enforcement ──────────────────────────────────────────────
      // Preserve satellite-derived colors — only adjust when roof==wall (no contrast).
      // Previous versions forced dark roofs + medium walls ("Beach formula"), but
      // gemini-2.5-pro penalizes color inaccuracy more than contrast deficit.
      const blockLum = (block: string): number => {
        const c = WALL_CLUSTERS.find(cl => cl.options.includes(block));
        if (!c) return 128;
        return (c.rgb[0] + c.rgb[1] + c.rgb[2]) / 3;
      };
      const roofLum = blockLum(roofDom);
      const wallLumV = blockLum(wallDom);

      // Only enforce contrast when roof and wall are literally the same block
      if (wallDom === roofDom) {
        // Pick a complementary wall with visible luminance contrast
        if (roofLum < 100) {
          wallDom = 'minecraft:stone_bricks'; // lum ~124, textured
        } else if (roofLum < 160) {
          wallDom = 'minecraft:smooth_quartz'; // lum ~220, bright
        } else {
          wallDom = 'minecraft:stone_bricks'; // dark against bright roof
        }
        console.log(`  Wall contrast: ${wallDom.replace('minecraft:', '')} (lum ${blockLum(wallDom).toFixed(0)}) [was identical to roof]`);
      }
      console.log(`  Roof lum: ${roofLum.toFixed(0)}, Wall lum: ${blockLum(wallDom).toFixed(0)}, gap: ${Math.abs(blockLum(roofDom) - blockLum(wallDom)).toFixed(0)}`);
    }

    // ── Derive accent materials using complementary color contrast ──────────
    // Brightness-shifting gray blocks produces more gray blocks. Instead, use
    // complementary hue/tone shifts to guarantee VISIBLE contrast:
    //   Cool gray wall → warm accent (sandstone, birch_planks)
    //   Warm wall (brick, terracotta) → cool accent (stone_bricks, polished_andesite)
    //   White wall → medium accent (stone_bricks, andesite)
    //   Dark wall → light accent (smooth_quartz, white_concrete)
    const wallCluster = WALL_CLUSTERS.find(c => c.options.includes(wallDom));
    const wallRgb = wallCluster?.rgb ?? [162, 162, 162];
    const wallLum = (wallRgb[0] + wallRgb[1] + wallRgb[2]) / 3;
    const wallWarmth = wallRgb[0] - wallRgb[2]; // positive = warm, negative = cool

    // Complementary accent lookup: warm vs cool vs neutral
    // Each entry: [groundFloor, bandLine, cornerTrim]
    // Ground: heavier base material. Band: thin floor-divider. Trim: vertical pilaster.
    let groundBlock: string;
    let bandBlock: string;
    let trimBlock: string;

    if (wallLum > 180) {
      // White/cream walls → medium stone accents
      groundBlock = 'minecraft:stone_bricks';
      bandBlock = 'minecraft:smooth_stone_slab';
      trimBlock = 'minecraft:polished_andesite';
    } else if (wallLum < 80) {
      // Dark walls → light accents
      groundBlock = 'minecraft:smooth_quartz';
      bandBlock = 'minecraft:smooth_stone_slab';
      trimBlock = 'minecraft:white_concrete';
    } else if (wallWarmth > 15) {
      // Warm walls (brick, terracotta, sandstone) → cool accents
      groundBlock = 'minecraft:stone_bricks';
      bandBlock = 'minecraft:smooth_stone_slab';
      trimBlock = 'minecraft:polished_andesite';
    } else if (wallWarmth < -5) {
      // Cool walls (blue, cyan) → warm accents
      groundBlock = 'minecraft:sandstone';
      bandBlock = 'minecraft:birch_planks';
      trimBlock = 'minecraft:smooth_sandstone';
    } else {
      // Neutral gray walls → warm accents for contrast
      groundBlock = 'minecraft:sandstone';
      bandBlock = 'minecraft:smooth_stone_slab';
      trimBlock = 'minecraft:birch_planks';
    }

    // Avoid matching roof or wall blocks — fallback chain
    const used = new Set([roofDom, wallDom]);
    const ensureUnique = (block: string, fallbacks: string[]): string => {
      if (!used.has(block)) { used.add(block); return block; }
      for (const fb of fallbacks) { if (!used.has(fb)) { used.add(fb); return fb; } }
      return block; // last resort: allow duplicate
    };
    groundBlock = ensureUnique(groundBlock, ['minecraft:stone_bricks', 'minecraft:polished_granite', 'minecraft:andesite']);
    bandBlock = ensureUnique(bandBlock, ['minecraft:smooth_stone_slab', 'minecraft:stone_brick_slab', 'minecraft:birch_slab']);
    trimBlock = ensureUnique(trimBlock, ['minecraft:polished_andesite', 'minecraft:stone_bricks', 'minecraft:birch_planks', 'minecraft:smooth_sandstone']);

    console.log(`  Zones: roof=${roofDom.replace('minecraft:', '')} wall=${wallDom.replace('minecraft:', '')} ground=${groundBlock.replace('minecraft:', '')} band=${bandBlock.replace('minecraft:', '')} trim=${trimBlock.replace('minecraft:', '')}`);

    // ── Apply multi-zone remaps ──────────────────────────────────────────────
    // Zone assignment per voxel:
    //   - Roof: topmost non-air per column
    //   - Corner trim: edge columns (1 block from AABB border)
    //   - Floor bands: every 3rd block from bottom (thin horizontal slab lines)
    //   - Ground floor: bottom 2 blocks of wall
    //   - Main wall: everything else
    let simplified = 0;
    const { width, height: gh, length: gl } = trimmed;

    // Find grid AABB (non-air extent) for corner/edge detection
    let minGx = width, maxGx = 0, minGz = gl, maxGz = 0;
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < gl; z++) {
        for (let y = 0; y < gh; y++) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') {
            minGx = Math.min(minGx, x); maxGx = Math.max(maxGx, x);
            minGz = Math.min(minGz, z); maxGz = Math.max(maxGz, z);
          }
        }
      }
    }

    for (let x = 0; x < width; x++) {
      for (let z = 0; z < gl; z++) {
        // Find column extent
        let topY = -1, bottomY = gh;
        for (let y = gh - 1; y >= 0; y--) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') {
            if (topY < 0) topY = y;
            bottomY = Math.min(bottomY, y);
          }
        }
        if (topY < 0) continue;

        // Resolution-aware zone thresholds (meters → blocks)
        // At 1 block/m: cornerW=1, groundH=2, corniceH=1, bandInterval=4, minBand=6
        // At 3.28 block/ft: cornerW=3, groundH=7, corniceH=3, bandInterval=13, minBand=20
        const res = args.resolution;
        const cornerW = Math.max(1, Math.round(1 * res));  // ~1m corner pilasters
        const groundH = Math.max(2, Math.round(2 * res));  // ~2m ground floor
        const corniceH = Math.max(1, Math.round(1 * res)); // ~1m cornice band
        const bandInterval = Math.max(4, Math.round(4 * res)); // ~4m floor spacing
        const minBandH = Math.max(6, Math.round(6 * res)); // ~6m min for bands
        const minCornerH = Math.max(5, Math.round(5 * res)); // ~5m min for corners

        // Edge/corner detection for trim pilasters
        const onXEdge = (x <= minGx + cornerW - 1 || x >= maxGx - cornerW + 1);
        const onZEdge = (z <= minGz + cornerW - 1 || z >= maxGz - cornerW + 1);
        const isCorner = onXEdge && onZEdge;

        const wallH = topY - bottomY;

        for (let y = bottomY; y <= topY; y++) {
          const b = trimmed.get(x, y, z);
          if (SPECIAL_BLOCKS.has(b)) continue;

          let target: string;
          const hAbove = y - bottomY; // height above ground

          if (y === topY) {
            // Roof zone — always satellite-derived
            target = roofDom;
          } else if (y >= topY - corniceH && y < topY && wallH >= minCornerH && !isCorner) {
            // Cornice band — blocks just below roof, defines wall-roof transition
            target = bandBlock;
          } else if (isCorner && wallH >= minCornerH) {
            // Corner pilasters — vertical trim accent
            target = trimBlock;
          } else if (hAbove < groundH && wallH >= Math.round(4 * res)) {
            // Ground floor — heavier base material
            target = groundBlock;
          } else if (wallH >= minBandH && hAbove > groundH && hAbove % bandInterval === 0) {
            // Floor band lines — ~4m intervals, thin horizontal divider
            target = bandBlock;
          } else {
            // Main wall body — preserve distinctive (non-gray) colors from photogrammetry.
            // Gray blocks are baked-lighting artifacts; replace with wallDom.
            // Non-gray blocks carry real material signal (brick, copper, terracotta); keep them.
            target = GRAY_BLOCKS.has(b) ? wallDom : b;
          }
          if (b !== target) { trimmed.set(x, y, z, target); simplified++; }
        }
      }
    }
    console.log(`Zone facade: ${simplified} blocks | roof=${roofDom.replace('minecraft:', '')} wall=${wallDom.replace('minecraft:', '')} ground=${groundBlock.replace('minecraft:', '')} band=${bandBlock.replace('minecraft:', '')} trim=${trimBlock.replace('minecraft:', '')}`);

    // ── Roof parapet — 1-block accent border on flat roof edges ─────────────
    // Creates a visible roofline boundary (common in real architecture).
    // Uses MODE roof height (most common topY) instead of global max — handles
    // buildings with towers/spires that exceed the main roof plane.
    {
      // Build height histogram to find the dominant (mode) roof height
      const heightHist = new Map<number, number>();
      let totalOccupied = 0;
      for (let x = 0; x < width; x++) {
        for (let z = 0; z < gl; z++) {
          let topY = -1;
          for (let y = gh - 1; y >= 0; y--) {
            if (trimmed.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
          }
          if (topY >= 0) {
            totalOccupied++;
            heightHist.set(topY, (heightHist.get(topY) ?? 0) + 1);
          }
        }
      }

      // Find mode roof height and check if it's dominant (>40% of columns)
      let modeH = 0, modeCount = 0;
      for (const [h, c] of heightHist) {
        if (c > modeCount) { modeH = h; modeCount = c; }
      }
      // Count columns within ±1 of mode height (flat section)
      const atMode = (heightHist.get(modeH - 1) ?? 0) + modeCount + (heightHist.get(modeH + 1) ?? 0);
      // 25% threshold — catches buildings with towers above a dominant flat section
      // (Dakota has Y=42 at 27%). Lower threshold is safe because parapet only
      // touches columns at the mode height, not the whole building.
      const flatRoof = totalOccupied > 0 && (atMode / totalOccupied) > 0.25;

      if (flatRoof) {
        let parapetCount = 0;
        const parapetBlock = trimBlock; // Use trim accent material
        for (let x = 0; x < width; x++) {
          for (let z = 0; z < gl; z++) {
            let topY = -1;
            for (let y = gh - 1; y >= 0; y--) {
              if (trimmed.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
            }
            // Only apply parapet to columns at or near the mode roof height
            if (topY < 0 || Math.abs(topY - modeH) > 1) continue;
            // Check if this column is on the roof perimeter (adjacent air or shorter neighbor)
            let isEdge = false;
            for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
              const nx = x + dx, nz = z + dz;
              if (nx < 0 || nx >= width || nz < 0 || nz >= gl) { isEdge = true; break; }
              let nTopY = -1;
              for (let ny = gh - 1; ny >= 0; ny--) {
                if (trimmed.get(nx, ny, nz) !== 'minecraft:air') { nTopY = ny; break; }
              }
              if (nTopY < topY - 2) { isEdge = true; break; }
            }
            if (isEdge) {
              // Replace the roof block at topY with parapet material
              trimmed.set(x, topY, z, parapetBlock);
              parapetCount++;
            }
          }
        }
        if (parapetCount > 0) console.log(`Roof parapet: ${parapetCount} blocks at mode height ${modeH} (${parapetBlock.replace('minecraft:', '')})`);
      }
    }

    // Hoist ground block for later palette cleanup
    groundDom = groundBlock;

    // Protect zone accent blocks from mode filter erasure.
    // Thin features (1-block trim columns, 1-block floor bands) get outvoted
    // by surrounding wall blocks without protection.
    // v95: Added roofDom — without protection, modeFilter3D outvotes roof blocks
    // with wall blocks at roof edges, creating swiss-cheese holes in top-down views.
    zoneProtected = new Set([groundBlock, bandBlock, trimBlock, roofDom]);
  } else {
    // v300 hybrid: preserve raw photogrammetric CIELAB colors on walls.
    // Only apply ground foundation band for clean bottom edge — photogrammetric
    // tiles often have noisy bottom voxels from incomplete ground scan coverage.
    const groundH = Math.round(2 * args.resolution);
    for (let y = 0; y < Math.min(groundH, trimmed.height); y++) {
      for (let x = 0; x < trimmed.width; x++) {
        for (let z = 0; z < trimmed.length; z++) {
          const block = trimmed.get(x, y, z);
          if (block !== 'minecraft:air') {
            trimmed.set(x, y, z, 'minecraft:sandstone');
          }
        }
      }
    }
  }

  // v300: Smooth dark shadow artifacts — photogrammetry bakes shadow into texture,
  // mapping shadow pixels to very dark blocks (polished_deepslate, nether_bricks, etc.)
  // that create visual noise obscuring building form. Replace with neighborhood mode.
  // v313: Moved BEFORE modeFilter3D — dark artifacts in shadow bands (2×2+ clusters)
  // would survive majority voting and get propagated. Cleaning first starves mode filter.
  if (!args.zoneNormalize) {
    const darkSmoothed = smoothDarkBlocks(trimmed);
    if (darkSmoothed > 0) {
      console.log(`Dark block smoothing: ${darkSmoothed} shadow-artifact blocks replaced (floor + contrast)`);
    }

    // Boost photogrammetry desaturation — push gray blocks toward colorful alternatives.
    // Photogrammetry bakes ambient lighting into textures, desaturating real facade colors.
    const satBoosted = boostPhotogrammetrySaturation(trimmed);
    if (satBoosted > 0) console.log(`Saturation boost: ${satBoosted} blocks recolored`);
  }

  // 3D mode filter — smooth spatial noise while preserving multi-zone materials.
  // v67: reduced from 12 to 4 passes. Zone accent blocks (ground/band/trim) are
  // protected so thin architectural features survive smoothing.
  // v300: 1 pass when not zone-normalizing — avoids confetti noise on raw CIELAB surfaces.
  // Skip when --recolor is active: semantic recolor overwrites gray blocks anyway,
  // so modeFilter/facadeSmooth/clusterPalette/roofSmooth do wasted work that can
  // fight the recolor output. smoothDarkBlocks still runs (handles shadow artifacts).
  if (!args.recolor) {
    {
      // v106: Capped to 2 passes. v300: CIELAB mode hardcoded 1 pass (confetti avoidance).
      // v303: CIELAB default raised to 2 — v301 expanded glass/dark block protection
      // handles confetti without needing single-pass restriction. Explicit --mode-passes
      // overrides all caps (allows 3+ for testing surface quality improvement).
      const basePasses = args.explicitModePasses
        ? args.modePasses
        : Math.max(args.modePasses, 2); // floor at 2 passes regardless of zoneNormalize
      const passes = args.explicitModePasses ? basePasses : Math.min(3, basePasses);
      const modeSmoothed = modeFilter3D(trimmed, passes, 1, zoneProtected);
      if (modeSmoothed > 0) {
        console.log(`Mode filter 3x3x3: ${modeSmoothed} blocks homogenized (${passes} pass)`);
      }
    }

    // Post-filter morphClose — heal surface pockmarks created by mode filter.
    // r=1 is gentle — only fills single-voxel holes without altering shape.
    // v307: Skip for complex shapes — their 1-voxel gaps between geometric features
    // (sail separations, facet transitions) are real architecture, not pockmarks.
    // With modePasses=1, mode filter creates few pockmarks anyway.
    if (!isComplexShape) {
      const closed2 = morphClose3D(trimmed, 1);
      if (closed2 > 0) {
        console.log(`Morph close post-filter (r=1): ${closed2} surface pockmarks healed`);
      }
    } else {
      console.log(`Morph close post-filter: SKIPPED (complex shape — gaps are real geometry)`);
    }

    // Phase 4c: Facade color coherence — 5×5×1 Lab-weighted average on facade planes.
    // Snaps noisy outliers (delta-E > 15) to local majority color.
    if (!args.zoneNormalize) {
      const facadeSmoothed = smoothFacadeColors(trimmed);
      if (facadeSmoothed > 0) {
        console.log(`Facade color smoothing: ${facadeSmoothed} outlier blocks replaced (delta-E > 15)`);
      }
    }

    // Phase 4d: K-means facade palette — cluster each facade to k=4 coherent materials.
    // Reduces noisy 15-20 unique blocks to 3-5 per facade for cleaner visual appearance.
    if (!args.zoneNormalize) {
      const paletteReplaced = clusterFacadePalette(trimmed, 4);
      if (paletteReplaced > 0) {
        console.log(`Facade palette clustering: ${paletteReplaced} blocks reassigned (K-means k=4)`);
      }
    }

    // Phase 4e: Roof plane smoothing — aggressive 5×5 horizontal majority-vote on top 20%.
    // Roofs in photogrammetry are noisy (HVAC equipment, shadows, varied materials).
    if (!args.zoneNormalize) {
      const roofSmoothed = smoothRoofPlane(trimmed);
      if (roofSmoothed > 0) {
        console.log(`Roof plane smoothing: ${roofSmoothed} roof blocks replaced (5x5 majority vote)`);
      }
    }
  } else {
    console.log(`Color smoothing passes: SKIPPED (--recolor active — semantic recolor will handle colors)`);
  }

  // v311: Remove isolated single voxels — scattered 1-block artifacts (0-1 face neighbors).
  // These are the "noise dots" visible in topdown and facade views from photogrammetry fragments.
  // Runs after all color smoothing so it only catches truly disconnected remnants.
  {
    const isolated = removeIsolatedVoxels(trimmed, 1);
    if (isolated > 0) {
      console.log(`Isolated voxel removal: ${isolated} single-block artifacts removed (≤1 neighbor)`);
    }
  }

  // ─── v314: Semantic Palette + SV/Satellite Recoloring ──────────────────────
  // When --recolor is active (requires --coords), resolve a semantic material palette
  // from OSM tags, then optionally override with Street View wall color and satellite
  // roof color. Only replaces gray-family blocks — preserves existing colorful materials.
  if (args.recolor && args.coords && !args.zoneNormalize) {
    console.log('\n--- Semantic Recoloring (v314) ---');

    // Estimate building height from grid
    let maxSolidY = 0;
    for (let y = trimmed.height - 1; y >= 0; y--) {
      let hasBlock = false;
      for (let z = 0; z < trimmed.length && !hasBlock; z++) {
        for (let x = 0; x < trimmed.width && !hasBlock; x++) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') hasBlock = true;
        }
      }
      if (hasBlock) { maxSolidY = y; break; }
    }
    const heightM = maxSolidY / args.resolution;

    // Fetch OSM tags if not already captured from masking pipeline
    if (Object.keys(osmTags).length === 0) {
      const osmData = await queryOSM(args.coords.lat, args.coords.lng, 150);
      if (osmData) osmTags = osmData.tags ?? {};
    }

    // Phase B: Resolve semantic palette from OSM metadata
    let palette = resolveSemanticPalette(osmTags, heightM);
    if (palette) {
      console.log(`  Semantic palette: ${palette.source}`);
      console.log(`  Wall blocks: ${palette.wallBlocks.map(b => b.replace('minecraft:', '')).join(', ')}`);
    } else {
      console.log('  Semantic palette: no OSM material/colour data available');
    }

    // Phase C: SV multi-heading facade color — only when OSM didn't provide building:colour.
    // Captures 4 facade-aligned images from a single pano (free: 1 metadata call + 4 image URLs
    // sharing one pano lookup). Weighted merge of wall colors across all visible facades gives
    // much better material detection than a single heading.
    if (!palette?.wallColor) {
      try {
        // File-based cache for multi-heading SV (avoids redundant API calls during iteration)
        const svCacheKey = `sv-${args.coords.lat.toFixed(6)}-${args.coords.lng.toFixed(6)}`;
        const svCacheDir = dirname(args.outputPath);
        const svCachePath = join(svCacheDir, `.cache-${svCacheKey}.json`);
        const SV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

        // Determine building extent for FOV adjustment
        const svExtentM = buildingAlignment
          ? Math.max(buildingAlignment.mbrWidth, buildingAlignment.mbrDepth)
          : undefined;

        // Try to load cached multi-angle result
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
          svImages = await queryMultiHeadingSV(
            args.coords.lat, args.coords.lng,
            svExtentM,
          );
          if (svImages.length > 0) {
            const cacheData: CachedSvMulti = { svImages, ts: Date.now() };
            await Bun.write(svCachePath, JSON.stringify(cacheData));
          }
        }

        if (svImages.length > 0) {
          // Extract and merge colors from all facade images
          const multiResult = await extractMultiAngleColors(
            svImages.map(img => ({ faceName: img.faceName, heading: img.heading, imageUrl: img.imageUrl })),
          );
          if (multiResult) {
            const { r, g, b } = multiResult.wallColor;
            const svMax = Math.max(r, g, b);
            const svMin = Math.min(r, g, b);
            const svSat = svMax > 0 ? (svMax - svMin) / svMax : 0;
            if (svSat < 0.10) {
              console.log(`  SV multi-angle wall: rgb(${r},${g},${b}) sat=${(svSat * 100).toFixed(0)}% conf=${multiResult.confidence.toFixed(2)} — SKIPPED (too gray)`);
            } else {
              console.log(`  SV multi-angle wall: rgb(${r},${g},${b}) sat=${(svSat * 100).toFixed(0)}% conf=${multiResult.confidence.toFixed(2)} → ${multiResult.wallBlock.replace('minecraft:', '')}`);
              if (palette) {
                palette.wallColor = { r, g, b };
                palette.wallBlocks = [multiResult.wallBlock];
                palette.source += ' + SV multi-angle';
              } else {
                palette = {
                  wallBlocks: [multiResult.wallBlock],
                  wallColor: { r, g, b },
                  source: 'SV multi-angle',
                };
              }
            }
          } else {
            console.log('  SV multi-angle: color extraction failed');
          }
        } else {
          console.log('  SV: no street view imagery available');
        }
      } catch (e) {
        console.log(`  SV: ${(e as Error).message}`);
      }
    } else {
      console.log(`  SV: skipped (OSM building:colour already provides wall color)`);
    }

    // Phase C.5: SV texture classification — when palette is still null after Phase C,
    // fall back to classifyTexture() on the front facade to detect wall material from
    // edge entropy. This covers ~70-90% of buildings that lack OSM colour/material tags.
    if (!palette) {
      try {
        // Reload cached SV images to access facade URLs outside Phase C scope
        const svTexCacheKey = `sv-${args.coords.lat.toFixed(6)}-${args.coords.lng.toFixed(6)}`;
        const svTexCachePath = join(dirname(args.outputPath), `.cache-${svTexCacheKey}.json`);
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
                console.log(`  Wall blocks: ${palette.wallBlocks.map(b => b.replace('minecraft:', '')).join(', ')}`);
              }
            }
          }
        }
      } catch (e) {
        console.log(`  SV texture classification: ${(e as Error).message}`);
      }
    }

    // Phase D: Satellite roof color override (with file-based cache)
    const satCacheKey = `sat-${args.coords.lat.toFixed(6)}-${args.coords.lng.toFixed(6)}`;
    const satCacheDir = dirname(args.outputPath);
    const satCachePath = join(satCacheDir, `.cache-${satCacheKey}.json`);
    const SAT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    let satRoof: Awaited<ReturnType<typeof sampleSatelliteRoof>> = null;
    if (existsSync(satCachePath)) {
      const cacheAge = Date.now() - statSync(satCachePath).mtimeMs;
      if (cacheAge < SAT_CACHE_TTL_MS) {
        satRoof = JSON.parse(await Bun.file(satCachePath).text());
        console.log(`  Satellite roof: loaded from cache (${(cacheAge / 3600000).toFixed(1)}h old)`);
      }
    }
    if (!satRoof) {
      // Compute building extent for dynamic zoom — uses MBR dimensions when available,
      // falls back to voxel grid dimensions converted from blocks to meters
      const satExtentM = buildingAlignment
        ? Math.max(buildingAlignment.mbrWidth, buildingAlignment.mbrDepth)
        : Math.max(trimmed.width, trimmed.length) / args.resolution;
      satRoof = await sampleSatelliteRoof(args.coords.lat, args.coords.lng, satExtentM);
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

    // Apply palette to grid
    if (palette && (palette.wallBlocks.length > 0 || palette.wallColor || palette.roofBlocks)) {
      const recolored = applySemanticPalette(trimmed, palette);
      console.log(`  Applied: ${recolored} gray blocks recolored (${palette.source})`);
    }
  } else if (args.recolor && !args.coords) {
    console.log('\nWARNING: --recolor requires --coords LAT,LNG — skipping recoloring');
  }

  // v74/v92/v93: Facade homogenization — per-face minority block collapse.
  // v93: glass RE-PROTECTED. Removing all glass made builds monochrome (C=1 universal).
  // glazeWindows adds glass for material variety — keeping it gives C=3 "3+ material zones".
  // Homogenize still collapses other stray block types (non-glass, non-zone-accent).
  // v300: only applies when zone-normalizing — raw CIELAB mode preserves photogrammetric
  // surface diversity that homogenization would incorrectly treat as noise.
  if (args.zoneNormalize) {
    // v95: Reduced from 2 passes at 8% to 1 pass at 10%. Two passes created a
    // feedback loop — first pass created homogeneity, second locked it in,
    // destroying all material variety and producing monotone gray facades.
    const facadeProtected = new Set([
      'minecraft:gray_stained_glass', 'minecraft:glass', 'minecraft:glass_pane',
      'minecraft:light_gray_stained_glass', 'minecraft:black_stained_glass',
      ...(zoneProtected ?? []),
    ]);
    // v106: Raised from 10% to 15%. Blocks at 10-15% of a face are likely real
    // architectural accents (copper trim, stone bands), not noise.
    const homogenized = homogenizeFacadesByFace(trimmed, 0.15, 6, facadeProtected);
    if (homogenized > 0) {
      console.log(`Facade homogenization: ${homogenized} minority blocks collapsed (1 pass, 15% threshold)`);
    }
  }

  // v95: Softened palette cleanup — preserve secondary materials that appear ≥3% of
  // their zone. Previous nuclear cleanup replaced ALL non-dominant blocks with the
  // single zone dominant, destroying material variety (sandstone trim on stone walls,
  // brick accents, etc.) and producing monotone gray facades.
  // v300: skipped when not zone-normalizing — raw CIELAB blocks are the palette.
  if (args.zoneNormalize && roofDom && wallDom) {
    // roofDom/wallDom/groundDom already have 'minecraft:' prefix
    const zoneBlocks = new Set([roofDom, wallDom, groundDom, 'minecraft:air']);
    if (zoneProtected) for (const b of zoneProtected) zoneBlocks.add(b);
    // Protect glass blocks — windows add critical material variety for VLM C score
    for (const g of ['minecraft:gray_stained_glass', 'minecraft:glass', 'minecraft:glass_pane',
      'minecraft:light_gray_stained_glass', 'minecraft:black_stained_glass']) {
      zoneBlocks.add(g);
    }

    const { width: gw, height: gh, length: gl } = trimmed;
    const roofCutoffY = Math.round(gh * 0.60);
    const groundCutoffY = Math.min(3, Math.round(gh * 0.10));

    // v95: Build frequency maps per zone and protect blocks ≥3% of their zone total.
    // This preserves secondary wall materials instead of forcing everything to the dominant.
    const wallFreq = new Map<string, number>();
    const roofFreq = new Map<string, number>();
    let wallTotal = 0, roofTotal = 0;
    for (let y = 0; y < gh; y++) {
      for (let z = 0; z < gl; z++) {
        for (let x = 0; x < gw; x++) {
          const b = trimmed.get(x, y, z);
          if (b === 'minecraft:air') continue;
          if (y >= roofCutoffY) {
            roofFreq.set(b, (roofFreq.get(b) || 0) + 1);
            roofTotal++;
          } else {
            wallFreq.set(b, (wallFreq.get(b) || 0) + 1);
            wallTotal++;
          }
        }
      }
    }
    for (const [b, c] of wallFreq) { if (c >= wallTotal * 0.03) zoneBlocks.add(b); }
    for (const [b, c] of roofFreq) { if (c >= roofTotal * 0.03) zoneBlocks.add(b); }

    let cleaned = 0;
    for (let y = 0; y < gh; y++) {
      // Determine which zone dominant to use based on height
      const zoneFallback = y >= roofCutoffY ? roofDom
        : y <= groundCutoffY ? groundDom
        : wallDom;
      for (let z = 0; z < gl; z++) {
        for (let x = 0; x < gw; x++) {
          const b = trimmed.get(x, y, z);
          if (b === 'minecraft:air') continue;
          if (zoneBlocks.has(b)) continue;
          trimmed.set(x, y, z, zoneFallback);
          cleaned++;
        }
      }
    }
    if (cleaned > 0) {
      console.log(`Palette cleanup: ${cleaned} stray blocks → zone dominants (${zoneBlocks.size - 1} protected types)`);
    }
  }

  // v80: Post-processing re-mask — re-sharpen edges blurred by morphClose/modeFilter.
  // After all processing (zone assignment, contrast, homogenize), run maskToFootprint
  // again with same dilation as pre-fill to clip morphClose/modeFilter expansion.
  // Safety: snapshot grid before mask, revert if >40% removed (polygon alignment issue).
  let postMaskApplied = false;
  if (osmPolygon && args.coords && !args.noOsm && !args.noPostMask) {
    const postMaskDilate = args.maskDilate ?? 3; // same dilation as pre-fill mask
    const { reverted } = trySafeMask(
      trimmed,
      () => maskToFootprint(
        trimmed, osmPolygon!,
        args.coords!.lat, args.coords!.lng,
        Math.round(postMaskDilate * args.resolution), args.resolution, enuHorizontalAngle,
      ),
      'Post-morph re-mask',
      0.60, // revert if <60% of blocks remain (>40% removed)
    );
    postMaskApplied = !reverted;
  }

  // v71: Footprint freeze — prevent morphClose/modeFilter from expanding the
  // building outline beyond its pre-processing shape. Save 2D footprint before
  // morphClose, then after all processing clip any columns that weren't in
  // the original footprint. This preserves interior fill while preventing
  // outline expansion from dilation.
  // Skip when OSM post-mask was applied — the polygon is more authoritative than
  // the pre-morphClose bitmap, and the two conflict when morphClose fills valid
  // gaps within the OSM polygon that the bitmap doesn't know about.
  if (savedFootprint && !postMaskApplied) {
    let footprintClipped = 0;
    const { width: gw, height: gh, length: gl } = trimmed;
    for (let z = 0; z < gl; z++) {
      for (let x = 0; x < gw; x++) {
        if (savedFootprint[z * gw + x]) continue; // Column was in original footprint — keep
        // Column was empty before morphClose — clear any blocks added by processing
        for (let y = 0; y < gh; y++) {
          if (trimmed.get(x, y, z) !== 'minecraft:air') {
            trimmed.set(x, y, z, 'minecraft:air');
            footprintClipped++;
          }
        }
      }
    }
    if (footprintClipped > 0) {
      console.log(`Footprint freeze: ${footprintClipped} blocks clipped (new columns from morphClose/filter)`);
    }
  }

  // Sky contamination remap — Google 3D Tiles bake ambient skylight (blue/cyan)
  // into upward-facing surfaces. These are artifacts, never real materials.
  // v68: Always apply after zone simplification. Zone assignment already replaced
  // wall/roof/ground with correct materials, so any remaining blue/cyan blocks
  // are contamination from unassigned voxels (holes, interior leaks).
  {
    const skyReplacements = new Map<string, string>([
      ['minecraft:light_blue_terracotta', 'minecraft:light_gray_concrete'],
      ['minecraft:cyan_terracotta', 'minecraft:stone'],
      ['minecraft:light_blue_concrete', 'minecraft:light_gray_concrete'],
      ['minecraft:cyan_concrete', 'minecraft:stone'],
    ]);
    const constrained = constrainPalette(trimmed, skyReplacements);
    if (constrained > 0) {
      console.log(`Sky palette: ${constrained} blue/cyan sky-contaminated blocks remapped`);
    }
  }

  // v71: OSM footprint polygon fill — plug empty interior columns.
  // Clipping is disabled (pre-fill OSM mask already removed neighbors;
  // post-processing clip destroyed wing connectors in v71 testing).
  // Only fills empty columns within the core polygon + proximity gate.
  if (osmPolygon && args.coords && !args.noOsm) {
    const { filled: fpFill } = enforceFootprintPolygon(
      trimmed,
      osmPolygon,
      args.coords.lat, args.coords.lng,
      args.resolution, enuHorizontalAngle,
      wallDom, roofDom,
    );
    if (fpFill > 0) {
      console.log(`Footprint fill: ${fpFill} voxels added to empty interior columns`);
    }
  }

  // v73: Synthetic peaked/hip roof — stacks progressively inset footprints to create
  // a sloped roof from any footprint shape. Use --peaked-roof flag.
  if (args.peakedRoof) {
    const roofAdded = addPeakedRoof(trimmed, roofDom);
    if (roofAdded > 0) {
      console.log(`Peaked roof: ${roofAdded} blocks added (${roofDom.replace('minecraft:', '')})`);
    }
  }

  // Connected-component cleanup — remove floating debris and disconnected clusters.
  // Resolution-aware: scale base threshold by resolution³ for consistent physical volume.
  const baseCompThreshold = args.mode === 'surface' ? 500 : args.cleanMinSize;
  const componentThreshold = Math.round(baseCompThreshold * Math.pow(args.resolution, 3));
  if (componentThreshold > 0) {
    const cleaned = removeSmallComponents(trimmed, componentThreshold);
    if (cleaned > 0) {
      console.log(`Component cleanup: ${cleaned} blocks removed (components < ${componentThreshold} voxels, res=${args.resolution})`);
    }
  }

  // v300: Remove thin pillar columns (street light poles, traffic signals, etc.)
  // that survived CCL because they're connected to the building at ground level.
  // Scans every XZ column — removes those with small cross-section that extend
  // above the building median height. Run after all processing to catch poles
  // that survived footprint freeze, post-mask, and component cleanup.
  {
    const pillarsRemoved = removeThinPillars(trimmed);
    if (pillarsRemoved > 0) {
      console.log(`Pillar removal: ${pillarsRemoved} blocks removed (thin vertical columns)`);
    }
  }

  // Flat roof regularization — level bumps, fill holes, uniform material.
  // Runs after all geometry and color processing to catch roof irregularities
  // introduced by mode filter, morph close, and facade smoothing.
  const roofFixed = regularizeFlatRoof(trimmed);
  if (roofFixed > 0) console.log(`Roof regularization: ${roofFixed} blocks fixed`);

  // Custom block remaps — final override, applied after all other processing
  if (args.remaps.size > 0) {
    const remapped = constrainPalette(trimmed, args.remaps);
    console.log(`Custom remap: ${remapped} blocks remapped (${args.remaps.size} rules)`);
  }

  // Entry path disabled for tiles pipeline (v70): the diagonal walkway from
  // grid edge to building entrance confuses VLM grading ("strange appendage").
  // Keep placeEntryPath available for generated buildings but skip it here.
  // if (analysis?.entryPosition && analysis.entryPath.length > 0) {
  //   const pathPlaced = placeEntryPath(trimmed, analysis);
  //   if (pathPlaced > 0) {
  //     console.log(`Entry path: ${pathPlaced} blocks placed (smooth_stone_slab, face=${analysis.entryFace})`);
  //   }
  // }

  // ─── Clean Feature Replacement ─────────────────────────────────────────────
  // --scene: replace noisy photogrammetry features with clean MC equivalents
  if (args.scene && envPositions) {
    console.log('\n--- Clean Feature Replacement ---');
    // Use default tree palette for replacement (hardiness-based selection happens in enrichment)
    const treePalette: import('../src/gen/structures.js').TreeType[] = ['oak', 'birch', 'dark_oak'];
    const replaced = replaceWithCleanFeatures(
      trimmed, envPositions, treePalette, 'grass', analysis?.groundPlaneY ?? 0,
    );
    console.log(`  Replaced: ${replaced.trees} trees, ${replaced.roads} road cells, ${replaced.vehicles} vehicles`);
  }

  // --scene: regularize windows + place doors
  if (args.scene) {
    console.log('\n--- Window & Door Enhancement ---');
    const winResult = detectAndRegularizeWindows(trimmed, analysis?.groundPlaneY ?? 0);
    console.log(`  Windows regularized: ${winResult.windowsRegularized}, doors placed: ${winResult.doorsPlaced}`);
  }

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

  // ─── Height Truncation Correction ────────────────────────────────────────────
  // Google 3D Tiles LOD truncates tall buildings at 20-40% of actual height.
  // When --height-correct is active, detect truncation by comparing voxel height
  // to known real height (from OSM tags or --height override) and extrude upward.
  // WARNING: Flat cross-section extrusion works well for rectangular skyscrapers
  // but produces poor results for tapered/stepped/domed buildings.
  if (args.heightCorrect) {
    // Determine known building height: --height override > OSM building:height > OSM levels × 3.5m
    let knownHeightM = args.heightOverride;
    if (knownHeightM <= 0 && Object.keys(osmTags).length > 0) {
      // Try OSM height tag first (meters, most authoritative)
      const osmHeightStr = osmTags['height'] || osmTags['building:height'];
      if (osmHeightStr) {
        const parsed = parseFloat(osmHeightStr);
        if (!isNaN(parsed) && parsed > 0) knownHeightM = parsed;
      }
      // Fallback: OSM levels × 3.5m per floor (standard commercial floor height)
      if (knownHeightM <= 0) {
        const levelsStr = osmTags['building:levels'];
        if (levelsStr) {
          const levels = parseInt(levelsStr, 10);
          if (!isNaN(levels) && levels > 0) knownHeightM = levels * 3.5;
        }
      }
    }

    if (knownHeightM > 0) {
      // Measure actual voxel height (highest occupied layer)
      let maxVoxelY = 0;
      for (let y = trimmed.height - 1; y >= 0; y--) {
        let found = false;
        for (let z = 0; z < trimmed.length && !found; z++) {
          for (let x = 0; x < trimmed.width && !found; x++) {
            if (trimmed.get(x, y, z) !== 'minecraft:air') {
              maxVoxelY = y;
              found = true;
            }
          }
        }
        if (found) break;
      }
      const voxelHeightM = (maxVoxelY + 1) / args.resolution;
      const heightRatio = voxelHeightM / knownHeightM;

      if (heightRatio < 0.6) {
        // Building is significantly shorter than expected -- likely LOD truncated
        const targetHeightBlocks = Math.round(knownHeightM * args.resolution);
        const heightCorrectionLayers = targetHeightBlocks - (maxVoxelY + 1);

        console.log(`\n--- Height Truncation Correction ---`);
        console.log(`  Voxel height: ${voxelHeightM.toFixed(0)}m (${maxVoxelY + 1} layers)`);
        console.log(`  Known height: ${knownHeightM.toFixed(0)}m (${(heightRatio * 100).toFixed(0)}% captured)`);
        console.log(`  Target: ${targetHeightBlocks} layers (+${heightCorrectionLayers})`);

        // Warn for non-rectangular profiles where extrusion produces poor results
        const profile = analysis?.heightProfile ?? 'uniform';
        if (profile !== 'uniform') {
          console.log(`  WARNING: building profile is "${profile}" -- flat extrusion may look incorrect`);
        }
        if (analysis && !analysis.isRectangular) {
          console.log(`  WARNING: non-rectangular footprint -- extruded cross-section may not match real building`);
        }

        extrudeBuilding(trimmed, heightCorrectionLayers);
      } else {
        console.log(`Height correction: not needed (${voxelHeightM.toFixed(0)}m / ${knownHeightM.toFixed(0)}m = ${(heightRatio * 100).toFixed(0)}%)`);
      }
    } else {
      console.log('Height correction: no height data available (use --height N to provide manually)');
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
