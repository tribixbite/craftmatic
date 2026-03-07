/**
 * Tile mesh extraction helper for 3D Tiles → Schematic pipeline.
 *
 * Waits for TilesRenderer to finish loading, then extracts all meshes
 * within a given radius around a center point. Returns a cloned Group
 * with world transforms applied, ready for voxelization.
 */

import * as THREE from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';

/** Options for tile mesh capture */
export interface CaptureOptions {
  /** Progress callback for status updates */
  onProgress?: (msg: string) => void;
  /** Timeout in ms before aborting (default: 60000) */
  timeout?: number;
  /** Minimum vertical extent (meters) above ground for a mesh to be kept (default: 2).
   *  Filters out flat terrain, roads, sidewalks that add noise to voxelization. */
  minHeight?: number;
}

/**
 * Wait for 3D tiles to finish loading, then extract meshes within a radius.
 *
 * @param tiles      Active TilesRenderer instance (already added to scene)
 * @param center     Center point in scene coordinates (after ReorientationPlugin)
 * @param radiusMeters  Capture radius in meters (scene units)
 * @param options    Optional progress callback and timeout
 * @returns Group containing cloned meshes with world transforms applied
 */
export async function captureTileMeshes(
  tiles: TilesRenderer,
  center: THREE.Vector3,
  radiusMeters: number,
  options?: CaptureOptions,
): Promise<THREE.Group> {
  const { onProgress, timeout = 60000, minHeight = 2 } = options ?? {};

  // Wait for tiles to finish downloading and parsing
  await waitForTilesLoaded(tiles, timeout, onProgress);

  onProgress?.('Extracting meshes...');

  // First pass: collect candidate meshes within radius and compute their world AABBs
  const captureSphere = new THREE.Sphere(center, radiusMeters);
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

    // Check intersection with capture sphere
    if (!captureSphere.intersectsSphere(worldSphere)) {
      rejected++;
      return;
    }

    // Compute world-space AABB for ground estimation
    const worldBox = new THREE.Box3().setFromObject(child);
    candidates.push({ child, worldBox });
  });

  // Estimate ground level as the median of mesh bounding box minimums (Y axis).
  // Terrain/road meshes sit near the ground; the median is robust against
  // outlier meshes (e.g. low underground fragments).
  let groundY = 0;
  let heightFiltered = 0;
  if (candidates.length > 0) {
    const yMins = candidates.map(c => c.worldBox.min.y).sort((a, b) => a - b);
    groundY = yMins[Math.floor(yMins.length / 2)];
    onProgress?.(`Ground level estimated at Y=${groundY.toFixed(1)}, filtering meshes...`);
  }

  // Second pass: filter by vertical extent above ground and clone survivors
  const group = new THREE.Group();
  let meshCount = 0;

  for (const { child, worldBox } of candidates) {
    const verticalExtent = worldBox.max.y - groundY;

    // Skip meshes that don't rise meaningfully above ground — these are
    // terrain, roads, sidewalks that bloat the voxelized output
    if (verticalExtent < minHeight) {
      heightFiltered++;
      continue;
    }

    // Clone mesh with world transform applied
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

  return group;
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
