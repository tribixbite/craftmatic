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
  /** Timeout in ms before aborting (default: 30000) */
  timeout?: number;
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
  const { onProgress, timeout = 30000 } = options ?? {};

  // Wait for tiles to finish downloading and parsing
  await waitForTilesLoaded(tiles, timeout, onProgress);

  onProgress?.('Extracting meshes...');

  // Collect all meshes within the capture sphere
  const captureSphere = new THREE.Sphere(center, radiusMeters);
  const group = new THREE.Group();
  let meshCount = 0;

  tiles.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (!child.geometry) return;

    // Compute world bounding sphere for this mesh
    const geo = child.geometry as THREE.BufferGeometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const worldSphere = geo.boundingSphere!.clone();
    worldSphere.applyMatrix4(child.matrixWorld);

    // Check intersection with capture sphere
    if (!captureSphere.intersectsSphere(worldSphere)) return;

    // Clone mesh with world transform applied
    const cloned = child.clone();
    // Apply the world matrix so the cloned mesh is in world space
    cloned.applyMatrix4(child.matrixWorld);
    // Reset the matrix since we've baked the transform
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    cloned.updateMatrix();

    group.add(cloned);
    meshCount++;
  });

  onProgress?.(`Captured ${meshCount} meshes`);
  return group;
}

/**
 * Wait until TilesRenderer has no pending downloads or parses.
 * Polls using requestAnimationFrame. Rejects on timeout.
 */
function waitForTilesLoaded(
  tiles: TilesRenderer,
  timeoutMs: number,
  onProgress?: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let stableFrames = 0;
    // Need many stable frames — TilesRenderer pauses between LOD levels
    // as it processes tiles in batches. Too low = premature "loaded" signal.
    const STABLE_THRESHOLD = 30;

    const check = () => {
      const elapsed = Date.now() - startTime;
      if (elapsed > timeoutMs) {
        // Resolve anyway with whatever is loaded — partial capture is better than nothing
        onProgress?.('Timeout reached, using partial tiles');
        resolve();
        return;
      }

      const stats = tiles.stats;
      const downloading = stats.downloading ?? 0;
      const parsing = stats.parsing ?? 0;
      const failed = (stats as Record<string, number>).failed ?? 0;
      const loaded = (stats as Record<string, number>).loaded ?? 0;

      if (failed > 0 && downloading === 0 && parsing === 0) {
        // All remaining tiles failed — no point waiting
        onProgress?.(`Tiles loaded with ${failed} failures (${loaded} loaded)`);
        resolve();
        return;
      }

      if (downloading === 0 && parsing === 0) {
        stableFrames++;
        if (stableFrames >= STABLE_THRESHOLD) {
          onProgress?.('Tiles loaded');
          resolve();
          return;
        }
      } else {
        stableFrames = 0;
      }

      onProgress?.(`Loading tiles... (${downloading} downloading, ${parsing} parsing${failed > 0 ? `, ${failed} failed` : ''})`);
      // Use setTimeout instead of requestAnimationFrame — mobile browsers
      // throttle/pause rAF when elements are small or tab is backgrounded
      setTimeout(check, 200);
    };

    setTimeout(check, 200);
  });
}
