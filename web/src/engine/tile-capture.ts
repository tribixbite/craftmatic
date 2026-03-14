/**
 * Tile mesh extraction helper for 3D Tiles → Schematic pipeline.
 *
 * Waits for TilesRenderer to finish loading, then extracts all meshes
 * within a given radius around a center point. Returns a cloned Group
 * with world transforms applied, ready for voxelization.
 */

import * as THREE from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';
import { filterMeshesByHeight } from '@craft/convert/mesh-filter.js';

/** Options for tile mesh capture */
export interface CaptureOptions {
  /** Progress callback for status updates */
  onProgress?: (msg: string) => void;
  /** Timeout in ms before aborting (default: 60000) */
  timeout?: number;
  /** Minimum vertical extent (meters) above ground for a mesh to be kept (default: 2).
   *  Filters out flat terrain, roads, sidewalks that add noise to voxelization. */
  minHeight?: number;
  /** When true, extract a 2D terrain heightmap from ground-level meshes before filtering.
   *  The heightmap is used to drape procedural environment elements on terrain. */
  extractHeightmap?: boolean;
  /** Resolution in blocks per meter for heightmap rasterization (default: 1) */
  heightmapResolution?: number;
}

/** Result from enhanced tile mesh capture */
export interface CaptureResult {
  /** Filtered building meshes with world transforms applied */
  buildingGroup: THREE.Group;
  /** 2D terrain heightmap — Y values per XZ cell, indexed as z * width + x.
   *  Relative to groundY (so flat terrain = all zeros). Only present when extractHeightmap=true. */
  terrainHeightmap?: Float32Array;
  /** Width of heightmap grid in cells */
  heightmapWidth: number;
  /** Length (depth) of heightmap grid in cells */
  heightmapLength: number;
  /** Estimated ground Y level in world coordinates */
  groundY: number;
  /** Capture statistics */
  stats: { tested: number; captured: number; rejected: number; heightFiltered: number };
}

/**
 * Wait for 3D tiles to finish loading, then extract meshes within a radius.
 * Optionally extracts a terrain heightmap from ground-level meshes before filtering them.
 *
 * @param tiles      Active TilesRenderer instance (already added to scene)
 * @param center     Center point in scene coordinates (after ReorientationPlugin)
 * @param radiusMeters  Capture radius in meters (scene units)
 * @param options    Optional progress callback and timeout
 * @returns CaptureResult with building meshes, optional heightmap, and stats
 */
export async function captureTileMeshes(
  tiles: TilesRenderer,
  center: THREE.Vector3,
  radiusMeters: number,
  options?: CaptureOptions,
): Promise<CaptureResult> {
  const {
    onProgress, timeout = 60000, minHeight = 2,
    extractHeightmap = false, heightmapResolution = 1,
  } = options ?? {};

  // Wait for tiles to finish downloading and parsing
  await waitForTilesLoaded(tiles, timeout, onProgress);

  onProgress?.('Extracting meshes...');

  // First pass: collect candidate meshes within XZ radius (cylindrical filter).
  // A sphere rejects meshes above the radius height, clipping tall buildings.
  // XZ-only distance preserves all vertical geometry (towers, spires, antennas).
  const centerXZ = new THREE.Vector2(center.x, center.z);
  const candidates: { child: THREE.Mesh; worldBox: THREE.Box3 }[] = [];
  let tested = 0;
  let rejected = 0;
  let noGeometry = 0;

  tiles.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (!child.geometry) { noGeometry++; return; }

    tested++;

    // Compute world bounding sphere for this mesh
    const geo = child.geometry as THREE.BufferGeometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const worldSphere = geo.boundingSphere!.clone();
    worldSphere.applyMatrix4(child.matrixWorld);

    // Cylindrical XZ-only filter — accepts meshes at any height within XZ radius
    const meshCenterXZ = new THREE.Vector2(worldSphere.center.x, worldSphere.center.z);
    const xzDist = centerXZ.distanceTo(meshCenterXZ) - worldSphere.radius;
    if (xzDist > radiusMeters) {
      rejected++;
      return;
    }

    // Compute world-space AABB for ground estimation
    const worldBox = new THREE.Box3().setFromObject(child);
    candidates.push({ child, worldBox });
  });

  // Estimate ground level before filtering — needed for heightmap
  const yMins = candidates.map(c => c.worldBox.min.y).sort((a, b) => a - b);
  const groundY = yMins.length > 0 ? yMins[Math.floor(yMins.length / 2)] : 0;

  // Extract terrain heightmap from ground-level meshes before stripping them
  let terrainHeightmap: Float32Array | undefined;
  const hmDiameter = radiusMeters * 2;
  const hmWidth = Math.ceil(hmDiameter * heightmapResolution);
  const hmLength = hmWidth;

  if (extractHeightmap && candidates.length > 0) {
    onProgress?.('Extracting terrain heightmap...');
    terrainHeightmap = extractTerrainHeightmap(
      candidates, center, groundY, radiusMeters,
      hmWidth, hmLength, heightmapResolution,
    );
    const nonZero = terrainHeightmap.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
    onProgress?.(`Heightmap: ${hmWidth}x${hmLength}, ${nonZero} terrain samples`);
  }

  // Filter by vertical extent above estimated ground level
  const { kept, heightFiltered } = filterMeshesByHeight(candidates, minHeight);
  if (candidates.length > 0) {
    onProgress?.(`Ground level estimated at Y=${groundY.toFixed(1)}, filtering meshes...`);
  }

  // Clone surviving meshes with world transform baked in
  const group = new THREE.Group();
  let meshCount = 0;

  for (const { child } of kept) {
    const cloned = child.clone();
    cloned.applyMatrix4(child.matrixWorld);
    // Reset the matrix since we've baked the transform
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    cloned.updateMatrix();

    group.add(cloned);
    meshCount++;
  }

  onProgress?.(`Captured ${meshCount}/${tested} meshes (${rejected} outside radius, ${heightFiltered} below ${minHeight}m height, ${noGeometry} no geometry)`);
  console.log(`[tile-capture] tested=${tested} captured=${meshCount} rejected=${rejected} heightFiltered=${heightFiltered} noGeo=${noGeometry} radius=${radiusMeters} groundY=${groundY.toFixed(1)}`);

  return {
    buildingGroup: group,
    terrainHeightmap,
    heightmapWidth: hmWidth,
    heightmapLength: hmLength,
    groundY,
    stats: { tested, captured: meshCount, rejected, heightFiltered },
  };
}

/**
 * Extract a 2D terrain heightmap from ground-level mesh candidates.
 * Rasterizes the Y values of low-lying meshes (verticalExtent < 1m) onto a grid.
 * Uses raycasting downward at each cell center to sample the actual mesh surface.
 */
function extractTerrainHeightmap(
  candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }>,
  center: THREE.Vector3,
  groundY: number,
  radiusMeters: number,
  width: number,
  length: number,
  resolution: number,
): Float32Array {
  const heightmap = new Float32Array(width * length);

  // Collect only ground-level meshes (vertical extent < 1.5m above ground)
  const groundMeshes: THREE.Mesh[] = [];
  for (const { child, worldBox } of candidates) {
    const verticalExtent = worldBox.max.y - groundY;
    if (verticalExtent < 1.5) {
      const cloned = child.clone();
      cloned.applyMatrix4(child.matrixWorld);
      cloned.position.set(0, 0, 0);
      cloned.rotation.set(0, 0, 0);
      cloned.scale.set(1, 1, 1);
      cloned.updateMatrix();
      groundMeshes.push(cloned);
    }
  }

  if (groundMeshes.length === 0) return heightmap;

  // Build a temporary scene with just ground meshes for raycasting
  const raycaster = new THREE.Raycaster();
  const downDir = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();

  // Grid covers [-radius, +radius] centered on capture center
  const halfW = radiusMeters;
  const halfL = radiusMeters;

  for (let gz = 0; gz < length; gz++) {
    for (let gx = 0; gx < width; gx++) {
      // Convert grid cell to world XZ coordinates
      const worldX = center.x + (gx / resolution - halfW);
      const worldZ = center.z + (gz / resolution - halfL);

      // Raycast downward from high above
      origin.set(worldX, groundY + 50, worldZ);
      raycaster.set(origin, downDir);

      let closestY = 0; // relative to groundY
      for (const mesh of groundMeshes) {
        const hits = raycaster.intersectObject(mesh, false);
        if (hits.length > 0) {
          const hitY = hits[0].point.y - groundY;
          // Take the highest ground hit (closest to surface)
          if (Math.abs(hitY) < 10) { // sanity check: within 10m of ground
            closestY = Math.max(closestY, hitY);
          }
        }
      }

      heightmap[gz * width + gx] = closestY;
    }
  }

  return heightmap;
}

/**
 * Wait until TilesRenderer has no pending downloads or parses.
 * Uses setTimeout polling (not requestAnimationFrame) to avoid
 * mobile browser throttling when canvas is small/hidden.
 */
function waitForTilesLoaded(
  tiles: TilesRenderer,
  timeoutMs: number,
  onProgress?: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stableFrames = 0;
    // Google 3D Tiles pauses between LOD batches as it processes each depth level.
    // Need many stable frames to confirm all levels have been traversed.
    const STABLE_THRESHOLD = 50;
    // Require some tiles actually loaded before accepting stability —
    // prevents false "complete" when nothing has started downloading yet
    const MIN_LOADED = 5;

    const check = () => {
      try {
        const elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
          const loaded = (tiles.stats as Record<string, number>).loaded ?? 0;
          onProgress?.(`Timeout reached (${loaded} tiles loaded), using partial data`);
          resolve();
          return;
        }

        const stats = tiles.stats;
        if (!stats) {
          onProgress?.('Error: tiles.stats is null');
          resolve();
          return;
        }
        const downloading = (stats as Record<string, number>).downloading ?? 0;
        const parsing = (stats as Record<string, number>).parsing ?? 0;
        const failed = (stats as Record<string, number>).failed ?? 0;
        const loaded = (stats as Record<string, number>).loaded ?? 0;

        if (failed > 0 && downloading === 0 && parsing === 0) {
          onProgress?.(`Tiles loaded with ${failed} failures (${loaded} loaded)`);
          resolve();
          return;
        }

        if (downloading === 0 && parsing === 0 && loaded >= MIN_LOADED) {
          stableFrames++;
          if (stableFrames >= STABLE_THRESHOLD) {
            onProgress?.(`Tiles loaded (${loaded} tiles)`);
            resolve();
            return;
          }
        } else {
          stableFrames = 0;
        }

        onProgress?.(`Waiting for tiles... d:${downloading} p:${parsing} ok:${loaded} fail:${failed} [${Math.round(elapsed / 1000)}s]`);
        setTimeout(check, 200);
      } catch (err) {
        onProgress?.(`waitForTilesLoaded error: ${err instanceof Error ? err.message : String(err)}`);
        resolve();
      }
    };

    setTimeout(check, 200);
  });
}
